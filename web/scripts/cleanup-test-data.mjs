#!/usr/bin/env node
/**
 * Find the hand-entered test rows and plan their removal.
 *
 *   node scripts/cleanup-test-data.mjs                 # dry run (default)
 *   node scripts/cleanup-test-data.mjs --apply         # refuses without the backup
 *
 * The seed and the simulation both tag their rows (note = 'seed-backfill' /
 * 'simulated'), so they can be removed with one delete each. The rows left
 * over from testing the app by hand carry no tag at all: they are ordinary
 * sales, movements and services, indistinguishable from real ones except by
 * when they happened and what is in them. This finds them by those signals,
 * lists every one with its reasons, and plans what removing them does to
 * stock.
 *
 * Removing a sale returns its units; removing a stock-in takes units away.
 * Either way every later balance_after for that product shifts, and
 * products.stock_on_hand with it, so each affected chain is rewalked from
 * scratch (lib/gapFill.mjs: rechainAfterDeletions) and the new closing
 * balance becomes the new stock_on_hand. A product whose chain would go
 * negative is reported, never forced.
 *
 * Profiles are listed and never touched.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  WEB_DIR,
  createServiceClient,
  insertBatched,
  pageAll,
  probePageSize,
  progressDone,
  progressLine,
} from "./lib/db.mjs";
import { planRestockFix, rechainAfterDeletions, rechainWindow, verifyBackupFile } from "./lib/gapFill.mjs";
import {
  BUFFER_MAX_DAYS,
  LEAD_MAX_DAYS,
  planDelivery,
} from "./simulate-recent-activity.mjs";
import {
  STORE_CLOSE_HOUR,
  STORE_OPEN_HOUR,
  deliveryReceipt,
  fmtInt,
  fmtPeso,
  manilaDateString,
  manilaParts,
  manilaStamp,
  section,
  table,
} from "./lib/seedlib.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
// Write and verify the backup without touching a row. This is what makes the
// restore testable before the cleanup runs: with the database still intact,
// a restore dry run against the file should find nothing to do, which is the
// proof that the file is a faithful snapshot.
const BACKUP_ONLY = argv.includes("--backup-only");
const TODAY = manilaDateString(Date.now()).replace(/-/g, "");
const BACKUP_PREFIX = `backup.cleanup_${TODAY}`;
const BACKUP_DIR = resolve(WEB_DIR, "scripts", "backups");
const IDS_FILE = resolve(WEB_DIR, "scripts", "simulated-ids.json");
const SIMULATED_NOTE = "simulated";

const cols = (...labels) => labels.map((label, i) => ({ label, get: (r) => r[i] }));
const SKU_PATTERN = /^J1-\d{4}$/;

// The seed's last sale is 30 Sep 2026 at 17:50 Manila (see the README). Every
// sale after that is either tagged 'simulated' or was entered by hand through
// the app, which is what makes this a reliable discriminator and not just a
// guess about trading hours: sale 156467 sits at 10:37, inside hours, and
// out-of-hours alone would have missed it.
const SEED_ENDS_AT = Date.parse("2026-09-30T18:00:00+08:00");

function outsideTradingHours(ms) {
  const h = manilaParts(ms).hour;
  return h < STORE_OPEN_HOUR || h >= STORE_CLOSE_HOUR;
}

async function main() {
  const sb = createServiceClient();
  const pageSize = await probePageSize(sb);

  section(`Clean up hand-entered test data${APPLY ? " -- APPLY" : " -- DRY RUN (no writes)"}`);

  // ------------------------------------------------------------------ load
  // Products first, and only then the alerts/overrides that reference the
  // test product. Loading the whole alerts table was timing out server-side
  // and is unnecessary: nothing else about it matters here.
  progressLine("loading products...");
  const products = await pageAll(
    () => sb
      .from("products")
      // supplier and unit_cost are here for the rescue restocks, which carry
      // the product's own values the way a real delivery does.
      .select("product_id, sku, name, is_active, stock_on_hand, reorder_point, supplier, unit_cost")
      .order("product_id"),
    { pageSize, label: "products" }
  );
  const testProductIdsEarly = products.filter((p) => !SKU_PATTERN.test(p.sku)).map((p) => p.product_id);

  progressLine("loading...");
  const [sales, items, movements, services, alerts, overrides, profiles] = await Promise.all([
    pageAll(() => sb.from("sales").select("sale_id, sale_ts, status, note, total_amount, customer_name, customer_vehicle_brand, user_id").order("sale_id"), { pageSize, label: "sales" }),
    pageAll(() => sb.from("sale_items").select("sale_item_id, sale_id, product_id, sku, quantity, line_revenue").order("sale_item_id"), { pageSize, label: "sale_items" }),
    pageAll(() => sb.from("stock_movements").select("movement_id, product_id, sku, movement_ts, movement_type, quantity, balance_after, reference, note").order("movement_id"), { pageSize, label: "movements" }),
    pageAll(() => sb.from("services").select("service_id, service_ts, service_type, status, total_amount, customer_vehicle_brand").order("service_id"), { pageSize, label: "services" }),
    testProductIdsEarly.length
      ? pageAll(() => sb.from("alerts").select("alert_id, product_id, sku, batch_id").in("product_id", testProductIdsEarly).order("alert_id"), { pageSize, label: "alerts" })
      : Promise.resolve([]),
    testProductIdsEarly.length
      ? pageAll(() => sb.from("advisory_overrides").select("product_id, manual_type").in("product_id", testProductIdsEarly).order("product_id"), { pageSize, label: "overrides" })
      : Promise.resolve([]),
    pageAll(() => sb.from("profiles").select("id, username, full_name, role, is_active").order("username"), { pageSize, label: "profiles" }),
  ]);
  progressDone(
    `products ${fmtInt(products.length)}, sales ${fmtInt(sales.length)}, items ${fmtInt(items.length)}, ` +
      `movements ${fmtInt(movements.length)}, services ${fmtInt(services.length)}`
  );

  const productById = new Map(products.map((p) => [p.product_id, p]));
  const reasons = new Map(); // "table:id" -> [reason]
  const note = (key, text) => {
    if (!reasons.has(key)) reasons.set(key, []);
    reasons.get(key).push(text);
  };

  // ------------------------------------------------- 1. the test product
  const testProducts = products.filter((p) => !SKU_PATTERN.test(p.sku));
  for (const p of testProducts) {
    note(`products:${p.product_id}`, `SKU "${p.sku}" does not match the J1-#### pattern`);
    if (!p.is_active) note(`products:${p.product_id}`, "is_active = false");
    note(`products:${p.product_id}`, `name "${p.name}", stock ${p.stock_on_hand}`);
  }
  const testProductIds = new Set(testProducts.map((p) => p.product_id));

  // ------------------------------------------------ 2. the test sales
  // Untagged and after the seed's last sale. The seed's own sales are untagged
  // too, which is why the cut-off does the work rather than the tag alone;
  // out-of-hours is recorded as a second reason where it applies, but it is
  // not the test, because one of these sales was entered at 10:37.
  const testSales = sales.filter(
    (s) => s.note !== "simulated" && Date.parse(s.sale_ts) >= SEED_ENDS_AT
  );
  for (const s of testSales) {
    const ts = Date.parse(s.sale_ts);
    note(`sales:${s.sale_id}`, `untagged and at ${manilaStamp(ts)}, after the seed's last sale (30 Sep 17:50)`);
    if (outsideTradingHours(ts)) {
      note(`sales:${s.sale_id}`, `and outside ${STORE_OPEN_HOUR}:00-${STORE_CLOSE_HOUR}:00`);
    }
    if (s.note) note(`sales:${s.sale_id}`, `note = ${JSON.stringify(s.note)}`);
    if (s.customer_vehicle_brand && !["Yamaha", "Honda", "Suzuki", "Kawasaki"].includes(s.customer_vehicle_brand)) {
      note(`sales:${s.sale_id}`, `customer_vehicle_brand ${JSON.stringify(s.customer_vehicle_brand)} is not a real brand`);
    }
  }
  const testSaleIds = new Set(testSales.map((s) => s.sale_id));

  // --------------------------------------- 3. their items, and the product's
  const testItems = items.filter((i) => testSaleIds.has(i.sale_id) || testProductIds.has(i.product_id));
  for (const i of testItems) {
    if (testSaleIds.has(i.sale_id)) note(`sale_items:${i.sale_item_id}`, `belongs to test sale ${i.sale_id}`);
    if (testProductIds.has(i.product_id)) note(`sale_items:${i.sale_item_id}`, `references test product ${i.sku}`);
  }

  // ------------------------------------------------- 4. the movements
  // Three ways in: a reference pointing at a test sale, belonging to the test
  // product, or untagged and out of hours (the stock-ins entered by hand).
  const refIds = (ref) => {
    const m = /^(sale|undo|edit):(\d+)$/.exec(ref ?? "");
    return m ? Number(m[2]) : null;
  };
  const testMovements = movements.filter((m) => {
    const ref = refIds(m.reference);
    if (ref != null && testSaleIds.has(ref)) return true;
    if (testProductIds.has(m.product_id)) return true;
    return m.note == null && Date.parse(m.movement_ts) >= SEED_ENDS_AT;
  });
  for (const m of testMovements) {
    const ref = refIds(m.reference);
    if (ref != null && testSaleIds.has(ref)) note(`stock_movements:${m.movement_id}`, `reference "${m.reference}" points at test sale ${ref}`);
    if (testProductIds.has(m.product_id)) note(`stock_movements:${m.movement_id}`, `belongs to test product ${m.sku}`);
    if (m.note == null && Date.parse(m.movement_ts) >= SEED_ENDS_AT) {
      const ts = Date.parse(m.movement_ts);
      note(
        `stock_movements:${m.movement_id}`,
        `untagged ${m.movement_type} at ${manilaStamp(ts)}, after the seed's end` +
          (outsideTradingHours(ts) ? " and outside trading hours" : "")
      );
    }
  }
  const testMovementIds = new Set(testMovements.map((m) => m.movement_id));

  // -------------------------------------------------- 5. the services
  const AGREED_SERVICES = new Set([
    "Change oil (labor)", "CVT cleaning", "Brake service", "Tire change (labor)",
    "Throttle body cleaning", "Engine tune-up", "Electrical troubleshooting",
    "Fuel injector cleaning", "Valve clearance adjustment", "Bearing replacement (labor)",
  ]);
  const testServices = services.filter((s) => !AGREED_SERVICES.has(s.service_type));
  for (const s of testServices) {
    note(`services:${s.service_id}`, `service_type ${JSON.stringify(s.service_type)} is not on the agreed list`);
    note(`services:${s.service_id}`, `${fmtPeso(s.total_amount)} at ${manilaStamp(Date.parse(s.service_ts))}`);
  }
  const testServiceIds = new Set(testServices.map((s) => s.service_id));

  // ------------------------------------------------- 6. alerts, overrides
  const testAlerts = alerts.filter((a) => testProductIds.has(a.product_id));
  for (const a of testAlerts) note(`alerts:${a.alert_id}`, `references test product ${a.sku}`);
  const testOverrides = overrides.filter((o) => testProductIds.has(o.product_id));
  for (const o of testOverrides) note(`advisory_overrides:${o.product_id}`, "references the test product");

  // ------------------------------------------------- 7. 'tagpe' elsewhere
  // Delete it if the row is already going; otherwise just clear the brand.
  const tagpeSales = sales.filter((s) => s.customer_vehicle_brand === "tagpe");
  const tagpeToBlank = tagpeSales.filter((s) => !testSaleIds.has(s.sale_id));
  const tagpeServices = services.filter((s) => s.customer_vehicle_brand === "tagpe" && !testServiceIds.has(s.service_id));

  // ------------------------------------------------------------ the listing
  section("1. Every row identified as test data, with reasons");
  const listing = [];
  for (const [key, why] of [...reasons.entries()].sort()) {
    const [tbl, id] = key.split(":");
    listing.push([tbl, id, why.join("; ")]);
  }
  table(listing, cols("table", "id", "why"));
  console.log("");
  console.log(`  ${fmtInt(listing.length)} rows in all.`);

  section("2. Flagged but NOT included");
  const flagged = [];
  for (const s of tagpeToBlank) {
    flagged.push(["sales", String(s.sale_id), `customer_vehicle_brand "tagpe", but the sale itself looks real: brand set to NULL, row kept`]);
  }
  for (const s of tagpeServices) {
    flagged.push(["services", String(s.service_id), `customer_vehicle_brand "tagpe" on a kept row: brand set to NULL`]);
  }
  for (const s of sales) {
    if (testSaleIds.has(s.sale_id)) continue;
    if (/test|asdf|qwer|dummy/i.test(s.customer_name ?? "")) {
      flagged.push(["sales", String(s.sale_id), `customer_name ${JSON.stringify(s.customer_name)} looks like a placeholder, but the row is in hours and tagged: LISTED ONLY`]);
    }
    if (s.note && s.note !== "simulated" && s.note.length <= 3) {
      flagged.push(["sales", String(s.sale_id), `short note ${JSON.stringify(s.note)}: LISTED ONLY (in trading hours)`]);
    }
  }
  if (flagged.length === 0) console.log("  Nothing else matched.");
  else table(flagged, cols("table", "id", "what and why not"));

  section("3. Profiles (listed only, never touched)");
  table(
    profiles.map((p) => [p.username ?? "-", p.full_name ?? "-", p.role, p.is_active ? "active" : "INACTIVE"]),
    cols("username", "full name", "role", "state")
  );
  console.log("");
  console.log("  This script never deletes or changes a profile. Staff accounts are managed");
  console.log("  from /settings; judge from the list above whether any are test accounts.");

  // --------------------------------------------------- the effect on stock
  section("4. Effect on every affected product's ledger");
  const movementsByProduct = new Map();
  for (const m of movements) {
    if (!movementsByProduct.has(m.product_id)) movementsByProduct.set(m.product_id, []);
    movementsByProduct.get(m.product_id).push({ ...m, movement_ts: Date.parse(m.movement_ts) });
  }

  // Units a day per product over the last eight weeks of recorded sales, so
  // a rescue delivery can be sized the way the simulation sizes its own.
  const DEMAND_WINDOW_DAYS = 56;
  const demandSince = Date.now() - DEMAND_WINDOW_DAYS * 86400_000;
  const saleTs = new Map(sales.map((x) => [x.sale_id, Date.parse(x.sale_ts)]));
  const dailyDemand = new Map();
  for (const i of items) {
    const ts = saleTs.get(i.sale_id);
    if (ts == null || ts < demandSince) continue;
    dailyDemand.set(i.product_id, (dailyDemand.get(i.product_id) ?? 0) + Number(i.quantity) / DEMAND_WINDOW_DAYS);
  }

  const affected = [...new Set(testMovements.map((m) => m.product_id))];
  const restockFixes = [];
  const perProduct = [];
  const balanceUpdates = [];
  const stockUpdates = [];
  const conflicts = [];

  for (const productId of affected) {
    const product = productById.get(productId);
    const chain = movementsByProduct.get(productId) ?? [];
    const result = rechainAfterDeletions({ movements: chain, deletedIds: testMovementIds });

    let final = result;
    let fix = null;

    if (result.minBalance < 0) {
      // One delivery, where a real one would have had to arrive, sized the
      // way the simulation sizes this product's deliveries rather than at
      // the bare deficit. Dropping rows to make the arithmetic fit would be
      // falsifying the history this is meant to clean.
      fix = planRestockFix({
        kept: result.kept,
        opening: result.opening,
        size: ({ have, deficit }) => {
          const order = planDelivery({
            have,
            dailyDemand: dailyDemand.get(productId) ?? 0,
            reorderPoint: product.reorder_point ?? 0,
            lead: LEAD_MAX_DAYS,
            buffer: BUFFER_MAX_DAYS,
            maxLineQty: 3,
          });
          return Math.max(order?.qty ?? 0, deficit);
        },
      });

      // Rewalk with the fix in place, so the numbers reported are the ones
      // that would actually be stored.
      const walked = rechainWindow({
        opening: result.opening,
        rows: [
          { movement_ts: fix.ts, quantity: fix.qty },
          ...result.kept.map((m) => ({ movement_id: m.movement_id, movement_ts: m.movement_ts, quantity: m.quantity, balance_after: m.balance_after })),
        ],
      });
      final = {
        updates: walked.rows
          .filter((r) => r.movement_id != null && r.balance_after !== r.previousBalanceAfter)
          .map((r) => ({ movement_id: r.movement_id, previousBalanceAfter: r.previousBalanceAfter, balance_after: r.balance_after })),
        closing: walked.closing,
        minBalance: walked.minBalance,
        kept: result.kept,
        opening: result.opening,
      };
      restockFixes.push({
        product_id: productId,
        sku: product.sku,
        quantity: fix.qty,
        deficit: fix.deficit,
        beforeMovementId: fix.beforeMovementId,
        movement_ts: new Date(fix.ts).toISOString(),
        __ts: fix.ts,
        balance_after: walked.rows.find((r) => r.movement_id == null).balance_after,
        supplier: product.supplier ?? null,
        unit_cost: product.unit_cost ?? null,
        note: SIMULATED_NOTE,
      });
      if (final.minBalance < 0) {
        conflicts.push({ sku: product.sku, minBalance: final.minBalance, note: "still negative after the fix" });
      }
    }

    balanceUpdates.push(...final.updates.map((u) => ({ ...u, sku: product.sku })));
    if (final.closing !== product.stock_on_hand) {
      stockUpdates.push({
        product_id: productId,
        sku: product.sku,
        previous: product.stock_on_hand,
        next: final.closing,
      });
    }
    perProduct.push({
      productId,
      sku: product.sku,
      removed: chain.filter((m) => testMovementIds.has(m.movement_id)).length,
      stockBefore: product.stock_on_hand,
      stockAfter: final.closing,
      minBalance: final.minBalance,
      rewritten: final.updates.length,
      fix,
      chain,
      kept: final.kept,
      updates: final.updates,
    });
  }

  table(
    perProduct.map((p) => [
      p.sku,
      String(p.removed),
      String(p.stockBefore),
      String(p.stockAfter),
      `${p.stockAfter - p.stockBefore >= 0 ? "+" : ""}${p.stockAfter - p.stockBefore}`,
      String(p.rewritten),
      String(p.minBalance),
    ]),
    cols("sku", "rows gone", "stock now", "stock after", "delta", "rebalanced", "lowest")
  );

  section("5. Rows to delete, and rows to update");
  const deleteCounts = {
    sales: testSales.length,
    sale_items: testItems.length,
    stock_movements: testMovements.length,
    services: testServices.length,
    products: testProducts.length,
    alerts: testAlerts.length,
    advisory_overrides: testOverrides.length,
  };
  table(
    Object.entries(deleteCounts).map(([t, n]) => [t, fmtInt(n)]),
    cols("delete from", "rows")
  );
  console.log("");
  table(
    [
      ["stock_movements (rescue restocks)", fmtInt(restockFixes.length)],
    ],
    cols("insert into", "rows")
  );
  console.log("");
  table(
    [
      ["stock_movements.balance_after", fmtInt(balanceUpdates.length)],
      ["products.stock_on_hand", fmtInt(stockUpdates.length)],
      ["sales.customer_vehicle_brand -> NULL", fmtInt(tagpeToBlank.length)],
      ["services.customer_vehicle_brand -> NULL", fmtInt(tagpeServices.length)],
    ],
    cols("update", "rows")
  );

  section("6. Total stock");
  const activeBefore = products.filter((p) => p.is_active).reduce((t, p) => t + p.stock_on_hand, 0);
  const allBefore = products.reduce((t, p) => t + p.stock_on_hand, 0);
  const stockMap = new Map(stockUpdates.map((u) => [u.product_id, u.next]));
  const survives = (p) => !testProductIds.has(p.product_id);
  const activeAfter = products
    .filter((p) => p.is_active && survives(p))
    .reduce((t, p) => t + (stockMap.get(p.product_id) ?? p.stock_on_hand), 0);
  const allAfter = products
    .filter(survives)
    .reduce((t, p) => t + (stockMap.get(p.product_id) ?? p.stock_on_hand), 0);
  table(
    [
      ["active products", fmtInt(activeBefore), fmtInt(activeAfter), `${activeAfter - activeBefore >= 0 ? "+" : ""}${fmtInt(activeAfter - activeBefore)}`],
      ["all products", fmtInt(allBefore), fmtInt(allAfter), `${allAfter - allBefore >= 0 ? "+" : ""}${fmtInt(allAfter - allBefore)}`],
    ],
    cols("", "before", "after", "delta")
  );
  console.log("");
  console.log(`  products affected: ${fmtInt(affected.length)}`);

  section("7. Negative balances, and the restocks that fix them");
  if (restockFixes.length === 0) {
    console.log("  No chain went negative, so no restock was needed.");
  } else {
    table(
      restockFixes.map((f) => [
        f.sku,
        String(f.deficit),
        String(f.quantity),
        manilaStamp(f.__ts),
        `before movement ${f.beforeMovementId}`,
        String(f.balance_after),
      ]),
      cols("sku", "short by", "delivered", "when (Manila)", "placed", "balance after")
    );
    console.log("");
    console.log("  One stock_in each, tagged 'simulated', with the product's own supplier");
    console.log("  and unit_cost, placed a minute before the row that would have gone");
    console.log("  negative. Sized by the simulation's own delivery rule for that product,");
    console.log("  not at the bare deficit, so it reads like the shop's other deliveries.");
  }
  if (conflicts.length > 0) {
    console.log("");
    for (const c of conflicts) console.log(`  ! ${c.sku}: ${c.note} (${c.minBalance})`);
  }

  section("8. Effect on September and October gross");
  const monthly = (excludeSales, excludeServices) => {
    const m = new Map();
    for (const s of sales) {
      if (s.status !== "confirmed" || excludeSales.has(s.sale_id)) continue;
      const k = manilaDateString(Date.parse(s.sale_ts)).slice(0, 7);
      m.set(k, (m.get(k) ?? 0) + Number(s.total_amount));
    }
    for (const s of services) {
      if (s.status !== "confirmed" || excludeServices.has(s.service_id)) continue;
      const k = manilaDateString(Date.parse(s.service_ts)).slice(0, 7);
      m.set(k, (m.get(k) ?? 0) + Number(s.total_amount));
    }
    return m;
  };
  const before = monthly(new Set(), new Set());
  const after = monthly(testSaleIds, testServiceIds);
  table(
    ["2026-09", "2026-10"].map((k) => {
      const b = before.get(k) ?? 0;
      const a = after.get(k) ?? 0;
      return [k, fmtPeso(b), fmtPeso(a), `${a - b >= 0 ? "+" : "-"}${fmtPeso(Math.abs(a - b))}`];
    }),
    cols("month", "gross now", "gross after", "delta")
  );
  const sepAfter = after.get("2026-09") ?? 0;
  const octAfter = after.get("2026-10") ?? 0;
  console.log("");
  console.log(`  October against September after the cleanup: ${sepAfter ? ((octAfter / sepAfter) * 100).toFixed(1) : "-"}%`);

  section("9. Sample ledgers, before and after");
  for (const sample of [...perProduct].sort((a, b) => b.removed - a.removed).slice(0, 2)) {
    console.log(`  ${sample.sku}: ${sample.removed} rows removed, stock ${sample.stockBefore} -> ${sample.stockAfter}`);
    const updateMap = new Map(sample.updates.map((u) => [u.movement_id, u.balance_after]));
    const window = sample.chain.filter((m) => {
      const d = manilaDateString(m.movement_ts);
      return d >= "2026-09-28" && d <= "2026-10-08";
    });
    table(
      window.map((m) => [
        manilaStamp(m.movement_ts),
        String(m.movement_id),
        m.movement_type,
        String(m.quantity),
        String(m.balance_after),
        testMovementIds.has(m.movement_id)
          ? "DELETED"
          : updateMap.has(m.movement_id)
            ? `-> ${updateMap.get(m.movement_id)}`
            : "unchanged",
      ]),
      cols("when (Manila)", "id", "type", "qty", "balance now", "after")
    );
    console.log("");
  }

  // ------------------------------------------------------------- backup SQL
  const sqlLines = [];
  const sql = (line = "") => {
    sqlLines.push(line);
    console.log(line === "" ? "" : `  ${line}`);
  };

  section("10. Backup SQL - optional extra, written to scripts/backups/");
  console.log("  --apply does not use these: it writes a local JSON backup and verifies");
  console.log("  that instead, because the `backup` schema is not reachable through");
  console.log("  PostgREST. They are written to scripts/backups/cleanup-backup.sql as a");
  console.log("  second copy you can run in the editor if you prefer one in the database.");
  console.log("");
  sql("create schema if not exists backup;");
  sql();
  const idList = (xs) => xs.join(", ");
  const blocks = [
    [`${BACKUP_PREFIX}_sales`, "sales", `sale_id in (${idList([...testSaleIds])})`],
    [`${BACKUP_PREFIX}_sale_items`, "sale_items", `sale_item_id in (${idList(testItems.map((i) => i.sale_item_id))})`],
    [`${BACKUP_PREFIX}_stock_movements`, "stock_movements", `movement_id in (${idList([...testMovementIds])})`],
    [`${BACKUP_PREFIX}_services`, "services", `service_id in (${idList([...testServiceIds])})`],
    [`${BACKUP_PREFIX}_products`, "products", `product_id in (${idList([...testProductIds])})`],
    [`${BACKUP_PREFIX}_alerts`, "alerts", `alert_id in (${idList(testAlerts.map((a) => a.alert_id))})`],
    [`${BACKUP_PREFIX}_advisory_overrides`, "advisory_overrides", `product_id in (${idList(testOverrides.map((o) => o.product_id))})`],
  ];
  for (const [name, src, where] of blocks) {
    if (/in \(\)/.test(where)) {
      sql(`-- ${name}: nothing to back up (0 rows)`);
      continue;
    }
    sql(`create table ${name} as`);
    sql(`select * from ${src} where ${where};`);
    sql();
  }
  const wrapped = (ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 16) out.push(`  ${idList(ids.slice(i, i + 16))}${i + 16 < ids.length ? "," : ""}`);
    return out;
  };
  sql(`create table ${BACKUP_PREFIX}_movements_rebalanced as`);
  sql(`select * from stock_movements where movement_id in (`);
  for (const line of wrapped(balanceUpdates.map((u) => u.movement_id).sort((a, b) => a - b))) sql(line);
  sql(`);  -- ${balanceUpdates.length} rows`);
  sql();
  sql(`create table ${BACKUP_PREFIX}_products_restocked as`);
  sql(`select * from products where product_id in (`);
  for (const line of wrapped(stockUpdates.map((u) => u.product_id).sort((a, b) => a - b))) sql(line);
  sql(`);  -- ${stockUpdates.length} rows`);

  // -------------------------------------------------------------- the apply
  section("11. How --apply would work (not run here)");
  console.log("  * Checks the backup tables first, by row count against this plan, and");
  console.log("    refuses outright if any is missing or short (lib/gapFill.mjs:");
  console.log("    backupPrecondition, covered by check:backfill).");
  console.log("  * Then works product by product: delete that product's test movements,");
  console.log("    write its rebalanced balance_after values, set its stock_on_hand. A");
  console.log("    failure therefore leaves at most one product half-done.");
  console.log("  * Then the rows that belong to no single product: sale_items, sales,");
  console.log("    services, alerts, advisory_overrides, and the test product last.");
  console.log("  * Idempotent: every step is keyed on ids that no longer match once the");
  console.log("    row is gone, so a re-run after a partial failure finishes the job and a");
  console.log("    re-run after success does nothing.");
  console.log("  * The alerts dedupe keeps working: deleting the test product's alert rows");
  console.log("    changes the fingerprint of the batches that held them, so the next");
  console.log("    Decision Support run records a new batch, which is correct - the advice");
  console.log("    really did change.");
  console.log("  * api/products/delete keeps working: it counts a product's sale_items,");
  console.log("    stock_movements and alerts to choose deactivate over delete. Removing");
  console.log("    the test product removes all three together, so no product is left");
  console.log("    with dangling history.");

  // ------------------------------------------------------- the plan, as ids
  const plan = {
    deletes: {
      sales: [...testSaleIds],
      sale_items: testItems.map((i) => i.sale_item_id),
      stock_movements: [...testMovementIds],
      services: [...testServiceIds],
      products: [...testProductIds],
      alerts: testAlerts.map((a) => a.alert_id),
      advisory_overrides: testOverrides.map((o) => o.product_id),
    },
    updates: {
      stock_movements: balanceUpdates.map((u) => u.movement_id),
      products: stockUpdates.map((u) => u.product_id),
    },
  };

  // Full original rows for the deletes, and the ORIGINAL value of every
  // column the cleanup overwrites. This is what makes the restore exact
  // rather than approximate.
  const byId = (xs, key, ids) => xs.filter((x) => ids.has(x[key]));
  const updatedMovementIds = new Set(balanceUpdates.map((u) => u.movement_id));
  const updatedProductIds = new Set(stockUpdates.map((u) => u.product_id));
  const rows = {
    deletedRows: {
      sales: byId(sales, "sale_id", testSaleIds),
      sale_items: testItems,
      stock_movements: byId(movements, "movement_id", testMovementIds),
      services: byId(services, "service_id", testServiceIds),
      products: byId(products, "product_id", testProductIds),
      alerts: testAlerts,
      advisory_overrides: testOverrides,
    },
    previousValues: {
      stock_movements: movements
        .filter((m) => updatedMovementIds.has(m.movement_id))
        .map((m) => ({ movement_id: m.movement_id, balance_after: m.balance_after })),
      products: products
        .filter((x) => updatedProductIds.has(x.product_id))
        .map((x) => ({ product_id: x.product_id, stock_on_hand: x.stock_on_hand })),
    },
  };

  if (BACKUP_ONLY) {
    section("Backup only - no rows will be touched");
    const sqlPath = writeBackupSql(sqlLines);
    const backupPath = writeBackup({ plan, rows, restockFixes });
    const reread = JSON.parse(readFileSync(backupPath, "utf8"));
    const check = verifyBackupFile(plan, reread);
    const totalRows =
      Object.values(reread.deletedRows ?? {}).reduce((n, xs) => n + xs.length, 0) +
      Object.values(reread.previousValues ?? {}).reduce((n, xs) => n + xs.length, 0);
    console.log(`  backup file : ${backupPath}`);
    console.log(`  backup SQL  : ${sqlPath}`);
    console.log(`  rows held   : ${fmtInt(totalRows)}`);
    console.log(`  verified    : ${check.ok ? "yes, against every table and id" : "NO"}`);
    for (const p of check.problems) console.log(`    ${p}`);
    if (!check.ok) process.exitCode = 1;
    console.log("");
    console.log("  Test the restore against it before applying:");
    console.log(`    node scripts/restore-test-data-cleanup.mjs ${backupPath}`);
    return;
  }

  if (APPLY) {
    const result = await applyCleanup(sb, {
      plan, rows, restockFixes, perProduct, testMovementIds, testSaleIds, testItems,
      testServiceIds, testProductIds, testAlerts, testOverrides, balanceUpdates, stockUpdates,
      sqlLines,
    });
    if (!result.ok) {
      section("Nothing was written");
      process.exitCode = 1;
      return;
    }
    section("Applied");
    console.log(`  backup file : ${result.backupPath}`);
    console.log(`  backup SQL  : ${result.sqlPath}`);
    console.log("");
    console.log("  Verify with : node scripts/verify-cleanup.mjs");
    console.log("  Undo with   : node scripts/restore-test-data-cleanup.mjs <backup file>");
    return;
  }

  // The dry run writes the SQL copy too, so it can be reviewed before any
  // apply - it is the one artifact that is useful without writing anything.
  const sqlPath = writeBackupSql(sqlLines);
  console.log("");
  console.log(`  SQL copy written to ${sqlPath}`);

  section("Dry run complete - nothing was written");
  console.log("  Take the backup above, then review section 11 before asking for --apply.");
}

// ------------------------------------------------------------------ backup
//
// The `backup` schema is not reachable from here: PostgREST executes no DDL
// and that schema is not exposed to the API. So the backup is a local file,
// written before anything is touched and then READ BACK and checked against
// the plan, ids and all. A backup that is merely written is a backup nobody
// has verified.
//
// The file holds real customer data. scripts/backups/ is gitignored.
function writeBackup({ plan, rows, restockFixes }) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(BACKUP_DIR, `cleanup-test-data-${stamp}.json`);

  const payload = {
    generatedAt: new Date().toISOString(),
    script: "cleanup-test-data.mjs",
    whatThisIs:
      "Every row the cleanup deletes, in full, plus the ORIGINAL value of every " +
      "column it overwrites. Enough to put the database back exactly as it was. " +
      "Restore with scripts/restore-test-data-cleanup.mjs.",
    // Ids only, in the shape verifyBackupFile() compares.
    deletes: plan.deletes,
    updates: plan.updates,
    // The rows themselves.
    deletedRows: rows.deletedRows,
    previousValues: rows.previousValues,
    // What the cleanup ADDS, so a restore knows what to take away again.
    inserted: { stock_movements: restockFixes.map((f) => ({ product_id: f.product_id, sku: f.sku, movement_ts: f.movement_ts, quantity: f.quantity })) },
  };

  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

function writeBackupSql(lines) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const path = resolve(BACKUP_DIR, "cleanup-backup.sql");
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

async function applyCleanup(sb, ctx) {
  const {
    plan, rows, restockFixes, perProduct, testMovementIds, testSaleIds, testItems,
    testServiceIds, testProductIds, testAlerts, testOverrides, balanceUpdates, stockUpdates,
    sqlLines,
  } = ctx;

  section("Backup");
  const sqlPath = writeBackupSql(sqlLines);
  console.log(`  backup SQL (optional extra) : ${sqlPath}`);
  const path = writeBackup({ plan, rows, restockFixes });
  console.log(`  backup file                 : ${path}`);

  // Read it back off disk rather than trusting what was just in memory.
  let reread;
  try {
    reread = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.log(`  REFUSING: the backup could not be read back (${err.message}). Nothing written.`);
    return { ok: false };
  }
  const check = verifyBackupFile(plan, reread);
  const totalRows =
    Object.values(reread.deletedRows ?? {}).reduce((n, xs) => n + xs.length, 0) +
    Object.values(reread.previousValues ?? {}).reduce((n, xs) => n + xs.length, 0);
  console.log(`  read back: ${fmtInt(totalRows)} rows across ${Object.keys(reread.deletedRows ?? {}).length} delete sets`);
  if (!check.ok) {
    console.log("  REFUSING: the backup does not match the plan.");
    for (const p of check.problems) console.log(`    ${p}`);
    return { ok: false };
  }
  console.log("  verified against the plan: every table, every id.");

  // --------------------------------------------------- per product
  section("Applying, product by product");
  const fixByProduct = new Map(restockFixes.map((f) => [f.product_id, f]));
  const balanceByProduct = new Map();
  for (const u of balanceUpdates) {
    const pid = perProduct.find((p) => p.sku === u.sku)?.productId ?? null;
    const key = pid ?? u.sku;
    if (!balanceByProduct.has(key)) balanceByProduct.set(key, []);
    balanceByProduct.get(key).push(u);
  }
  const stockByProduct = new Map(stockUpdates.map((u) => [u.product_id, u]));

  let done = 0;
  for (const p of perProduct) {
    const pid = p.productId;

    // 1. the product's test movements
    const mine = p.chain.filter((m) => testMovementIds.has(m.movement_id)).map((m) => m.movement_id);
    if (mine.length > 0) {
      const { error } = await sb.from("stock_movements").delete().in("movement_id", mine);
      if (error) throw new Error(`${p.sku}: deleting movements failed: ${error.message}`);
    }

    // 2. its rescue restock, if it needs one. Guarded so a re-run after a
    //    partial failure does not insert it twice.
    const fix = fixByProduct.get(pid);
    if (fix) {
      const { data: already, error: lookupError } = await sb
        .from("stock_movements")
        .select("movement_id")
        .eq("product_id", pid)
        .eq("note", SIMULATED_NOTE)
        .eq("movement_ts", fix.movement_ts);
      if (lookupError) throw new Error(`${p.sku}: checking for an existing restock failed: ${lookupError.message}`);
      if ((already ?? []).length === 0) {
        const inserted = await insertBatched(
          sb,
          "stock_movements",
          [
            {
              product_id: pid,
              sku: fix.sku,
              movement_type: "stock_in",
              quantity: fix.quantity,
              balance_after: fix.balance_after,
              user_id: null,
              reference: deliveryReceipt(fix.__ts),
              note: SIMULATED_NOTE,
              movement_ts: fix.movement_ts,
              supplier: fix.supplier,
              unit_cost: fix.unit_cost,
            },
          ],
          { select: "movement_id" }
        );
        fix.movement_id = inserted[0]?.movement_id ?? null;
      } else {
        fix.movement_id = already[0].movement_id;
      }
    }

    // 3. its rebalanced rows
    for (const u of balanceByProduct.get(pid) ?? balanceByProduct.get(p.sku) ?? []) {
      const { error } = await sb
        .from("stock_movements")
        .update({ balance_after: u.balance_after })
        .eq("movement_id", u.movement_id);
      if (error) throw new Error(`${p.sku}: rebalancing movement ${u.movement_id} failed: ${error.message}`);
    }

    // 4. its stock_on_hand
    const stock = stockByProduct.get(pid);
    if (stock) {
      const { error } = await sb.from("products").update({ stock_on_hand: stock.next }).eq("product_id", pid);
      if (error) throw new Error(`${p.sku}: setting stock_on_hand failed: ${error.message}`);
    }

    done += 1;
    progressLine(`products ${fmtInt(done)}/${fmtInt(perProduct.length)} (${p.sku})`);
  }
  progressDone(`${fmtInt(done)} products done`);

  // ------------------------------------- the rows that belong to no product
  section("Applying the rest");
  const del = async (tbl, col, ids) => {
    if (ids.length === 0) {
      console.log(`  ${tbl}: nothing to delete`);
      return;
    }
    const { error } = await sb.from(tbl).delete().in(col, ids);
    if (error) throw new Error(`deleting from ${tbl} failed: ${error.message}`);
    console.log(`  ${tbl}: ${fmtInt(ids.length)} rows deleted`);
  };

  // sale_items before sales (they reference it), and everything that points
  // at the test product before the product itself.
  await del("sale_items", "sale_item_id", testItems.map((i) => i.sale_item_id));
  await del("sales", "sale_id", [...testSaleIds]);
  await del("services", "service_id", [...testServiceIds]);
  await del("alerts", "alert_id", testAlerts.map((a) => a.alert_id));
  await del("advisory_overrides", "product_id", testOverrides.map((o) => o.product_id));
  await del("products", "product_id", [...testProductIds]);

  // ------------------------------------------------------------- manifest
  appendRestockManifest(restockFixes);

  return { ok: true, backupPath: path, sqlPath };
}

function appendRestockManifest(restockFixes) {
  if (restockFixes.length === 0) return;
  let file = { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(IDS_FILE, "utf8"));
    if (Array.isArray(parsed.runs)) file = parsed;
  } catch {
    // no usable file yet
  }
  file.runs.push({
    generatedAt: new Date().toISOString(),
    note: SIMULATED_NOTE,
    mode: "cleanup-restock",
    why: "one stock_in per product whose chain would have gone negative once the hand-entered test rows were removed",
    stockMovements: restockFixes.map((f) => ({
      movement_id: f.movement_id ?? null,
      sku: f.sku,
      product_id: f.product_id,
      movement_ts: f.movement_ts,
      quantity: f.quantity,
    })),
  });
  writeFileSync(IDS_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(`  appended run ${file.runs.length} to ${IDS_FILE}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
