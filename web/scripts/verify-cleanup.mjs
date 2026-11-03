#!/usr/bin/env node
/**
 * Read-only verification of the test-data cleanup, against the database.
 *
 *   node scripts/verify-cleanup.mjs <backup.json> [--expect-stock 3867]
 *
 * The backup file says what was supposed to go, which is what makes this a
 * check rather than a restatement: every id it holds must now be absent.
 *
 *   1. all planned rows gone, SKU 123 and everything referencing it with them
 *   2. every product's chain walks end to end and ends at its stock_on_hand
 *   3. no negative balance_after anywhere
 *   4. total active stock_on_hand is the expected figure
 *   5. nothing untagged remains after the seed's last sale
 *   6. no 'tagpe' brand, no 'wash'/'brake' service
 *
 * Writes nothing. Exits 1 if any check fails.
 */
import { readFileSync } from "node:fs";
import { createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { fmtInt, manilaStamp, section, table } from "./lib/seedlib.mjs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const pick = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const EXPECTED_STOCK = pick("--expect-stock", null);
const SEED_ENDS_AT = "2026-09-30T18:00:00+08:00";

const cols = (...labels) => labels.map((label, i) => ({ label, get: (r) => r[i] }));

let failures = 0;
function check(label, passed, detail = "") {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures += 1;
}

if (!file) {
  console.error("usage: node scripts/verify-cleanup.mjs <backup.json> [--expect-stock N]");
  process.exitCode = 1;
} else {
  await main(file);
}

async function main(path) {
  const backup = JSON.parse(readFileSync(path, "utf8"));
  const sb = createServiceClient();
  const pageSize = await probePageSize(sb);

  section(`Verifying the cleanup against ${path}`);
  console.log(`  backup taken: ${backup.generatedAt}`);

  // ----------------------------------------------- 1. everything planned is gone
  section("1. Rows the cleanup was to delete");
  const KEYS = {
    sales: "sale_id",
    sale_items: "sale_item_id",
    stock_movements: "movement_id",
    services: "service_id",
    products: "product_id",
    alerts: "alert_id",
    advisory_overrides: "product_id",
  };
  const rows = [];
  let stillThere = 0;
  for (const [tbl, backedUp] of Object.entries(backup.deletedRows ?? {})) {
    if (backedUp.length === 0) {
      rows.push([tbl, "0", "0"]);
      continue;
    }
    const key = KEYS[tbl];
    const { data, error } = await sb.from(tbl).select(key).in(key, backedUp.map((r) => r[key]));
    if (error) throw new Error(`${tbl}: ${error.message}`);
    const left = (data ?? []).length;
    stillThere += left;
    rows.push([tbl, fmtInt(backedUp.length), fmtInt(left)]);
  }
  table(rows, cols("table", "to delete", "still there"));
  check("every planned row is gone", stillThere === 0, `${stillThere} left`);

  // the test product, by SKU rather than by id
  const { data: sku123 } = await sb.from("products").select("product_id, sku").not("sku", "like", "J1-%");
  check("no product outside the J1-#### pattern remains", (sku123 ?? []).length === 0,
    (sku123 ?? []).map((p) => p.sku).join(", ") || "none");
  for (const [tbl, col] of [["stock_movements", "sku"], ["sale_items", "sku"]]) {
    const { count } = await sb.from(tbl).select("*", { count: "exact", head: true }).eq(col, "123");
    check(`no ${tbl} row references SKU 123`, (count ?? 0) === 0, `${count}`);
  }

  // ------------------------------------------------- 2-3. the chains
  section("2-3. Every product's ledger chain");
  progressLine("loading products and movements...");
  const products = await pageAll(
    () => sb.from("products").select("product_id, sku, stock_on_hand, is_active").order("product_id"),
    { pageSize, label: "products" }
  );
  const movements = await pageAll(
    () => sb.from("stock_movements").select("movement_id, product_id, movement_ts, quantity, balance_after").order("movement_id"),
    { pageSize, label: "movements" }
  );
  progressDone(`products: ${fmtInt(products.length)}, movements: ${fmtInt(movements.length)}`);

  const byProduct = new Map();
  for (const m of movements) {
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
    byProduct.get(m.product_id).push(m);
  }

  let breaks = 0;
  let endMismatch = 0;
  let negatives = 0;
  const examples = [];
  for (const p of products) {
    const mine = (byProduct.get(p.product_id) ?? []).slice().sort(
      (a, b) => Date.parse(a.movement_ts) - Date.parse(b.movement_ts) || a.movement_id - b.movement_id
    );
    if (mine.length === 0) continue;
    let balance = mine[0].balance_after - mine[0].quantity;
    for (const m of mine) {
      balance += m.quantity;
      if (m.balance_after < 0) negatives += 1;
      if (balance !== m.balance_after) {
        breaks += 1;
        if (examples.length < 5) examples.push(`${p.sku} movement ${m.movement_id}: walked ${balance}, stored ${m.balance_after}`);
        balance = m.balance_after;
      }
    }
    if (balance !== p.stock_on_hand) {
      endMismatch += 1;
      if (examples.length < 5) examples.push(`${p.sku}: chain ends at ${balance}, stock_on_hand is ${p.stock_on_hand}`);
    }
  }
  check("every chain walks consistently end to end", breaks === 0, `${breaks} breaks`);
  check("every chain ends at its stock_on_hand", endMismatch === 0, `${endMismatch} mismatches`);
  check("no negative balance_after anywhere", negatives === 0, `${negatives} negatives`);
  for (const e of examples) console.log(`        ${e}`);

  // ------------------------------------------------------- 4. total stock
  section("4. Total stock");
  const active = products.filter((p) => p.is_active).reduce((t, p) => t + p.stock_on_hand, 0);
  const all = products.reduce((t, p) => t + p.stock_on_hand, 0);
  console.log(`  active products : ${fmtInt(active)}`);
  console.log(`  all products    : ${fmtInt(all)}`);
  if (EXPECTED_STOCK != null) {
    check(`active stock is ${fmtInt(Number(EXPECTED_STOCK))}`, active === Number(EXPECTED_STOCK), `${active}`);
  }

  // ---------------------------------------- 5. nothing untagged remains
  section("5. Untagged rows after the seed's last sale (30 Sep 17:50)");
  const { count: untaggedSales } = await sb
    .from("sales").select("*", { count: "exact", head: true })
    .gte("sale_ts", SEED_ENDS_AT).or("note.is.null,note.neq.simulated");
  const { count: untaggedMovements } = await sb
    .from("stock_movements").select("*", { count: "exact", head: true })
    .gte("movement_ts", SEED_ENDS_AT).is("note", null);
  check("no untagged sales remain", (untaggedSales ?? 0) === 0, `${untaggedSales}`);
  check("no untagged movements remain", (untaggedMovements ?? 0) === 0, `${untaggedMovements}`);

  // ----------------------------------------- 6. the specific test values
  section("6. Test values");
  const { count: tagpeSales } = await sb.from("sales").select("*", { count: "exact", head: true }).eq("customer_vehicle_brand", "tagpe");
  const { count: tagpeServices } = await sb.from("services").select("*", { count: "exact", head: true }).eq("customer_vehicle_brand", "tagpe");
  const { data: oddServices } = await sb.from("services").select("service_id, service_type").in("service_type", ["wash", "brake"]);
  check("no sale carries the 'tagpe' brand", (tagpeSales ?? 0) === 0, `${tagpeSales}`);
  check("no service carries the 'tagpe' brand", (tagpeServices ?? 0) === 0, `${tagpeServices}`);
  check("no 'wash' or 'brake' service remains", (oddServices ?? []).length === 0,
    (oddServices ?? []).map((s) => s.service_type).join(", ") || "none");

  // -------------------------------------------- the rescue restocks landed
  section("7. The rescue restocks");
  const inserted = backup.inserted?.stock_movements ?? [];
  const found = [];
  for (const r of inserted) {
    const { data } = await sb
      .from("stock_movements")
      .select("movement_id, sku, quantity, balance_after, supplier, unit_cost, data_origin")
      .eq("product_id", r.product_id)
      .eq("movement_ts", r.movement_ts)
      .eq("data_origin", "simulated");
    for (const m of data ?? []) found.push([m.sku, String(m.quantity), String(m.balance_after), m.supplier ?? "-", String(m.unit_cost ?? "-"), m.data_origin]);
  }
  table(found, cols("sku", "qty", "balance after", "supplier", "unit cost", "data origin"));
  check("both rescue restocks are present", found.length === inserted.length, `${found.length} of ${inserted.length}`);

  section(failures === 0 ? "All checks passed" : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures ? 1 : 0;
}
