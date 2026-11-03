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
import { createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { backupPrecondition, rechainAfterDeletions } from "./lib/gapFill.mjs";
import {
  STORE_CLOSE_HOUR,
  STORE_OPEN_HOUR,
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
const TODAY = manilaDateString(Date.now()).replace(/-/g, "");
const BACKUP_PREFIX = `backup.cleanup_${TODAY}`;

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
  progressLine("loading...");
  const [products, sales, items, movements, services, alerts, overrides, profiles] = await Promise.all([
    pageAll(() => sb.from("products").select("product_id, sku, name, is_active, stock_on_hand, reorder_point").order("product_id"), { pageSize, label: "products" }),
    pageAll(() => sb.from("sales").select("sale_id, sale_ts, status, note, total_amount, customer_name, customer_vehicle_brand, user_id").order("sale_id"), { pageSize, label: "sales" }),
    pageAll(() => sb.from("sale_items").select("sale_item_id, sale_id, product_id, sku, quantity, line_revenue").order("sale_item_id"), { pageSize, label: "sale_items" }),
    pageAll(() => sb.from("stock_movements").select("movement_id, product_id, sku, movement_ts, movement_type, quantity, balance_after, reference, note").order("movement_id"), { pageSize, label: "movements" }),
    pageAll(() => sb.from("services").select("service_id, service_ts, service_type, status, total_amount, customer_vehicle_brand").order("service_id"), { pageSize, label: "services" }),
    pageAll(() => sb.from("alerts").select("alert_id, product_id, sku, batch_id").order("alert_id"), { pageSize, label: "alerts" }),
    pageAll(() => sb.from("advisory_overrides").select("product_id, manual_type").order("product_id"), { pageSize, label: "overrides" }),
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

  const affected = [...new Set(testMovements.map((m) => m.product_id))];
  const perProduct = [];
  const balanceUpdates = [];
  const stockUpdates = [];
  const conflicts = [];

  for (const productId of affected) {
    const product = productById.get(productId);
    const chain = movementsByProduct.get(productId) ?? [];
    const result = rechainAfterDeletions({ movements: chain, deletedIds: testMovementIds });

    if (result.minBalance < 0) {
      // The smallest honest fix, rather than dropping rows to force it.
      const shortfall = -result.minBalance;
      conflicts.push({
        sku: product.sku,
        minBalance: result.minBalance,
        shortfall,
        proposal:
          `insert one simulated stock_in of ${shortfall} for ${product.sku} just before the first ` +
          `row that goes negative, then rewalk. Do not drop rows to make it fit.`,
      });
    }

    balanceUpdates.push(...result.updates.map((u) => ({ ...u, sku: product.sku })));
    if (result.closing !== product.stock_on_hand) {
      stockUpdates.push({
        product_id: productId,
        sku: product.sku,
        previous: product.stock_on_hand,
        next: result.closing,
      });
    }
    perProduct.push({
      sku: product.sku,
      removed: chain.filter((m) => testMovementIds.has(m.movement_id)).length,
      stockBefore: product.stock_on_hand,
      stockAfter: result.closing,
      minBalance: result.minBalance,
      rewritten: result.updates.length,
      chain,
      kept: result.kept,
      updates: result.updates,
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

  section("7. Negative-balance conflicts");
  if (conflicts.length === 0) {
    console.log("  None. Every affected chain stays at or above zero throughout.");
  } else {
    for (const c of conflicts) {
      console.log(`  ${c.sku}: lowest balance would be ${c.minBalance} (short by ${c.shortfall})`);
      console.log(`    proposal: ${c.proposal}`);
    }
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
  section("10. Backup SQL - run this in the Supabase editor FIRST");
  console.log("  --apply refuses unless every one of these tables exists and its row count");
  console.log("  matches the plan above exactly. A short backup is worse than none.");
  console.log("");
  console.log("    create schema if not exists backup;");
  console.log("");
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
      console.log(`    -- ${name}: nothing to back up (0 rows)`);
      continue;
    }
    console.log(`    create table ${name} as`);
    console.log(`    select * from ${src} where ${where};`);
    console.log("");
  }
  console.log("");
  console.log("  The rows this would UPDATE rather than delete need covering too, because");
  console.log("  their balance_after and stock_on_hand are rewritten in place. Printed in");
  console.log("  full, not truncated: an id list with an ellipsis in it is not runnable.");
  console.log("");
  // Wrapped at a readable width rather than one id per line or one long line.
  const wrapped = (ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 16) out.push(`      ${idList(ids.slice(i, i + 16))}${i + 16 < ids.length ? "," : ""}`);
    return out;
  };
  console.log(`    create table ${BACKUP_PREFIX}_movements_rebalanced as`);
  console.log(`    select * from stock_movements where movement_id in (`);
  for (const line of wrapped(balanceUpdates.map((u) => u.movement_id).sort((a, b) => a - b))) console.log(line);
  console.log(`    );  -- ${fmtInt(balanceUpdates.length)} rows`);
  console.log("");
  console.log(`    create table ${BACKUP_PREFIX}_products_restocked as`);
  console.log(`    select * from products where product_id in (`);
  for (const line of wrapped(stockUpdates.map((u) => u.product_id).sort((a, b) => a - b))) console.log(line);
  console.log(`    );  -- ${fmtInt(stockUpdates.length)} rows`);

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

  if (APPLY) {
    section("--apply REFUSED");
    const expected = {
      [`cleanup_${TODAY}_sales`]: testSales.length,
      [`cleanup_${TODAY}_sale_items`]: testItems.length,
      [`cleanup_${TODAY}_stock_movements`]: testMovements.length,
      [`cleanup_${TODAY}_services`]: testServices.length,
      [`cleanup_${TODAY}_products`]: testProducts.length,
    };
    // The backup schema is not exposed to the API, so the counts cannot be
    // read from here - which is itself the reason this refuses.
    const { ok, problems } = backupPrecondition(expected, {});
    console.log("  The backup tables cannot be read through PostgREST: the `backup` schema");
    console.log("  is not exposed to the API, so this script cannot confirm they exist.");
    console.log("  Until that check can run, --apply refuses rather than writing blind.");
    console.log("");
    for (const p of problems.slice(0, 8)) console.log(`    ${p}`);
    console.log("");
    console.log(`  ok = ${ok}. Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  section("Dry run complete - nothing was written");
  console.log("  Take the backup above, then review section 11 before asking for --apply.");
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
