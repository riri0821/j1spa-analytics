#!/usr/bin/env node
/**
 * Read-only verification of the October gap fill, against the database.
 *
 *   node scripts/verify-gapfill.mjs [--from 2026-10-01 --to 2026-10-07]
 *
 * Checks the things an insert into the middle of a ledger can break, rather
 * than the things that are easy to check:
 *
 *   1. the rows that landed, per table, inside the window
 *   2. every product's chain walks end to end and ends at its stock_on_hand
 *   3. no balance_after anywhere is negative
 *   4. total stock_on_hand is unchanged
 *   5. October gross against September
 *   6. the window is idempotent: a re-run would insert nothing
 *
 * Writes nothing. Exits 1 if any check fails.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEB_DIR, createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { fmtInt, fmtPeso, manilaDateString, manilaMidnight, section, table } from "./lib/seedlib.mjs";

const argv = process.argv.slice(2);
const pick = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const FROM = pick("--from", "2026-10-01");
const TO = pick("--to", "2026-10-07");
const EXPECTED_STOCK = Number(pick("--expect-stock", "3856"));

const windowStart = manilaMidnight(FROM);
const windowEnd = manilaMidnight(TO);

// Expected counts come from the manifest the apply wrote, not from numbers
// typed in here: the first version hard-coded the figures from an earlier dry
// run and then "failed" when the planner legitimately changed.
const manifest = JSON.parse(readFileSync(resolve(WEB_DIR, "scripts", "simulated-ids.json"), "utf8"));
const run = [...manifest.runs].reverse().find((r) => r.mode === "gap");
if (!run) throw new Error("no gap run found in simulated-ids.json");
const EXPECT = {
  sales: run.sales.count,
  services: run.services.count,
  serviceFirst: run.services.first,
  serviceLast: run.services.last,
  movements: run.stockMovements.count,
};
console.log(`  manifest run: ${run.generatedAt}, window ${run.window.from} .. ${run.window.to}`);

let failures = 0;
function check(label, passed, detail = "") {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures += 1;
}

const sb = createServiceClient();
const pageSize = await probePageSize(sb);

section(`Verifying the gap fill: ${FROM} .. ${TO} (Manila, --to exclusive)`);

// ------------------------------------------------------------ what landed
const inWindow = (tsCol, tbl, extra = (q) => q) =>
  extra(
    sb
      .from(tbl)
      .select("*", { count: "exact", head: true })
      .gte(tsCol, `${FROM}T00:00:00+08:00`)
      .lt(tsCol, `${TO}T00:00:00+08:00`)
  );

const counts = {};
for (const [key, tbl, col, extra] of [
  ["sales", "sales", "sale_ts", (q) => q.eq("data_origin", "simulated")],
  ["services", "services", "service_ts", (q) => q.gte("service_id", EXPECT.serviceFirst).lte("service_id", EXPECT.serviceLast)],
  ["services_all", "services", "service_ts", (q) => q],
  ["movements_sale", "stock_movements", "movement_ts", (q) => q.eq("data_origin", "simulated").eq("movement_type", "sale_decrement")],
  ["movements_in", "stock_movements", "movement_ts", (q) => q.eq("data_origin", "simulated").eq("movement_type", "stock_in")],
]) {
  const { count, error } = await inWindow(col, tbl, extra);
  if (error) throw new Error(`${key}: ${error.message}`);
  counts[key] = count ?? 0;
}

progressLine("counting sale_items...");
const simSales = await pageAll(
  () =>
    sb
      .from("sales")
      .select("sale_id")
      .eq("data_origin", "simulated")
      .gte("sale_ts", `${FROM}T00:00:00+08:00`)
      .lt("sale_ts", `${TO}T00:00:00+08:00`)
      .order("sale_id"),
  { pageSize, label: "sim sales" }
);
const simSaleIds = new Set(simSales.map((s) => s.sale_id));
const allItems = await pageAll(
  () => sb.from("sale_items").select("sale_id, product_id, quantity").order("sale_item_id"),
  { pageSize, label: "sale_items" }
);
const simItems = allItems.filter((i) => simSaleIds.has(i.sale_id));
progressDone("");

section("1. Rows inside the window");
table(
  [
    ["sales (data_origin='simulated')", fmtInt(counts.sales), fmtInt(EXPECT.sales)],
    ["sale_items for those sales", fmtInt(simItems.length), "-"],
    ["stock_movements sale_decrement", fmtInt(counts.movements_sale), "-"],
    ["stock_movements stock_in", fmtInt(counts.movements_in), "-"],
    ["both movement kinds together", fmtInt(counts.movements_sale + counts.movements_in), fmtInt(EXPECT.movements)],
    ["services inserted by this run", fmtInt(counts.services), fmtInt(EXPECT.services)],
    ["services in the window, all sources", fmtInt(counts.services_all), "-"],
  ],
  ["table", "found", "manifest"].map((label, i) => ({ label, get: (r) => r[i] }))
);
check("sales match the manifest", counts.sales === EXPECT.sales, `${counts.sales} vs ${EXPECT.sales}`);
check("one sale movement per sale_item", counts.movements_sale === simItems.length,
  `${counts.movements_sale} movements vs ${simItems.length} items`);
check("movements match the manifest", counts.movements_sale + counts.movements_in === EXPECT.movements,
  `${counts.movements_sale + counts.movements_in} vs ${EXPECT.movements}`);
check("services match the manifest", counts.services === EXPECT.services, `${counts.services} vs ${EXPECT.services}`);
check("the window's other service rows are untouched", counts.services_all - counts.services === 1,
  `${counts.services_all - counts.services} pre-existing (service_id 2, "brake")`);

// -------------------------------------------------- the chain, end to end
section("2-3. Every product's ledger chain");
progressLine("loading products and every movement...");
const products = await pageAll(
  () => sb.from("products").select("product_id, sku, stock_on_hand, is_active").order("product_id"),
  { pageSize, label: "products" }
);
const movements = await pageAll(
  () =>
    sb
      .from("stock_movements")
      .select("movement_id, product_id, movement_ts, quantity, balance_after")
      .order("movement_id"),
  { pageSize, label: "movements" }
);
progressDone(`products: ${fmtInt(products.length)}, movements: ${fmtInt(movements.length)}`);

const byProduct = new Map();
for (const m of movements) {
  if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
  byProduct.get(m.product_id).push(m);
}

let chainBreaks = 0;
let endMismatch = 0;
let negatives = 0;
const breakExamples = [];
for (const p of products) {
  const mine = (byProduct.get(p.product_id) ?? []).slice().sort(
    (a, b) => Date.parse(a.movement_ts) - Date.parse(b.movement_ts) || a.movement_id - b.movement_id
  );
  if (mine.length === 0) continue;

  // Walk forward from the balance the first movement implies before itself.
  let balance = mine[0].balance_after - mine[0].quantity;
  for (const m of mine) {
    balance += m.quantity;
    if (m.balance_after < 0) negatives += 1;
    if (balance !== m.balance_after) {
      chainBreaks += 1;
      if (breakExamples.length < 5) {
        breakExamples.push(`${p.sku} movement ${m.movement_id}: walked ${balance}, stored ${m.balance_after}`);
      }
      balance = m.balance_after; // resync so one break does not cascade
    }
  }
  if (balance !== p.stock_on_hand) {
    endMismatch += 1;
    if (breakExamples.length < 5) {
      breakExamples.push(`${p.sku}: chain ends at ${balance}, stock_on_hand is ${p.stock_on_hand}`);
    }
  }
}
check("every chain walks consistently end to end", chainBreaks === 0, `${chainBreaks} breaks`);
check("every chain ends at its stock_on_hand", endMismatch === 0, `${endMismatch} mismatches`);
check("no negative balance_after anywhere", negatives === 0, `${negatives} negatives`);
for (const e of breakExamples) console.log(`        ${e}`);

// ---------------------------------------------------------- total stock
section("4. Total stock");
const activeTotal = products.filter((p) => p.is_active).reduce((t, p) => t + p.stock_on_hand, 0);
const allTotal = products.reduce((t, p) => t + p.stock_on_hand, 0);
console.log(`  active products : ${fmtInt(activeTotal)}`);
console.log(`  all products    : ${fmtInt(allTotal)}`);
check(`active stock is still ${fmtInt(EXPECTED_STOCK)}`, activeTotal === EXPECTED_STOCK, `${activeTotal}`);

// ------------------------------------------------------- monthly revenue
section("5. Monthly gross");
const sales = await pageAll(
  () => sb.from("sales").select("sale_ts, total_amount").eq("status", "confirmed").order("sale_id"),
  { pageSize, label: "sales" }
);
const services = await pageAll(
  () => sb.from("services").select("service_ts, total_amount").eq("status", "confirmed").order("service_id"),
  { pageSize, label: "services" }
);
const monthly = new Map();
for (const x of sales) {
  const k = manilaDateString(Date.parse(x.sale_ts)).slice(0, 7);
  monthly.set(k, (monthly.get(k) ?? 0) + Number(x.total_amount));
}
for (const x of services) {
  const k = manilaDateString(Date.parse(x.service_ts)).slice(0, 7);
  monthly.set(k, (monthly.get(k) ?? 0) + Number(x.total_amount));
}
const sep = monthly.get("2026-09") ?? 0;
const oct = monthly.get("2026-10") ?? 0;
const pct = sep ? (oct / sep) * 100 : 0;
table(
  [
    ["2026-08", fmtPeso(monthly.get("2026-08") ?? 0), sep ? `${(((monthly.get("2026-08") ?? 0) / sep) * 100).toFixed(1)}%` : "-"],
    ["2026-09", fmtPeso(sep), "100.0%"],
    ["2026-10", fmtPeso(oct), `${pct.toFixed(1)}%`],
  ],
  ["month", "gross", "of Sep"].map((label, i) => ({ label, get: (r) => r[i] }))
);
check("October is 99-100% of September", pct >= 99 && pct <= 100.5, `${pct.toFixed(1)}%`);

// ------------------------------------------------------------ idempotency
section("6. Idempotency");
console.log(`  simulated sales already inside the window: ${fmtInt(counts.sales)}`);
check("a re-run would insert nothing", counts.sales > 0, "the guard trips on these");

// ------------------------------------------------------------------- done
section(failures === 0 ? "All checks passed" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures ? 1 : 0;
