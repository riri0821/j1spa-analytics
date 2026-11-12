#!/usr/bin/env node
/**
 * Post-reduction verification and the headline figures.
 *
 *   node scripts/verify-reduction.mjs
 *
 * Read-only apart from one thing: the Decision Support section calls
 * evaluateDecisionSupport(), which records an `alerts` batch when the advice
 * has changed. That is what loading the page itself does, and the chip counts
 * cannot be read without it.
 *
 * The chain check reuses verifyPlan() from lib/ledgerPlan.mjs - the same
 * assertion backfill-ledger.mjs plans against, now run over what is actually
 * in the table: every balance_after is the previous one plus the row's
 * quantity, none is negative, and the last equals products.stock_on_hand.
 */

import { countRows, createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { verifyPlan } from "./lib/ledgerPlan.mjs";
import { fmtInt, manilaStamp, section, table } from "./lib/seedlib.mjs";
import { enableBundlerResolve } from "./lib/bundlerResolve.mjs";

// src/lib/decisionSupport.js imports "./analytics" with no extension, which
// only a bundler resolves - so the hook goes on before the dynamic import.
enableBundlerResolve();
const { evaluateDecisionSupport } = await import("../src/lib/decisionSupport.js");

const peso = (n) => "P" + Math.round(Number(n)).toLocaleString("en-US");
const MIN_MONTHS_HISTORY = 24; // forecast-service/config.py

const sb = createServiceClient();
const pageSize = await probePageSize(sb);

// ---------------------------------------------------------------- counts
section("Headline figures");
const confirmedSales = await countRows(sb, "sales", (q) => q.eq("status", "confirmed"));
const saleItems = await countRows(sb, "sale_items");
const svc = await countRows(sb, "services", (q) => q.eq("status", "confirmed"));
const movements = await countRows(sb, "stock_movements");

const { data: firstSale } = await sb.from("sales").select("sale_ts").eq("status", "confirmed").order("sale_ts").limit(1);
const { data: lastSale } = await sb.from("sales").select("sale_ts").eq("status", "confirmed").order("sale_ts", { ascending: false }).limit(1);

progressLine("loading products...");
const products = await pageAll(
  () => sb.from("products").select("product_id, sku, name, stock_on_hand, is_active").order("product_id"),
  { pageSize, label: "products" }
);
progressDone("");
const active = products.filter((p) => p.is_active);
const totalUnits = active.reduce((s, p) => s + p.stock_on_hand, 0);

table(
  [
    { k: "confirmed sales", v: fmtInt(confirmedSales) },
    { k: "sale_items", v: fmtInt(saleItems) },
    { k: "confirmed services", v: fmtInt(svc) },
    { k: "stock_movements", v: fmtInt(movements) },
    { k: "active products", v: fmtInt(active.length) },
    { k: "total units in stock", v: fmtInt(totalUnits) },
    { k: "first confirmed sale (Manila)", v: firstSale?.[0] ? manilaStamp(Date.parse(firstSale[0].sale_ts)) : "-" },
    { k: "last confirmed sale (Manila)", v: lastSale?.[0] ? manilaStamp(Date.parse(lastSale[0].sale_ts)) : "-" },
  ],
  [{ label: "Measure", get: (r) => r.k }, { label: "Value", right: true, get: (r) => r.v }]
);

// --------------------------------------------------------- ledger chains
section("Ledger chains (verifyPlan over the live rows)");
progressLine("loading stock_movements...");
const allMovements = await pageAll(
  () =>
    sb
      .from("stock_movements")
      .select("movement_id, movement_ts, product_id, movement_type, quantity, balance_after")
      .order("product_id")
      .order("movement_ts")
      .order("movement_id"),
  { pageSize, label: "stock_movements", onProgress: (n) => progressLine(`loading stock_movements... ${fmtInt(n)}`) }
);
progressDone(`stock_movements: ${fmtInt(allMovements.length)}`);

const byProduct = new Map();
for (const m of allMovements) {
  if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
  byProduct.get(m.product_id).push(m);
}

let consistent = 0;
const broken = [];
let negatives = 0;
for (const p of active) {
  const rows = (byProduct.get(p.product_id) ?? []).sort(
    (a, b) => Date.parse(a.movement_ts) - Date.parse(b.movement_ts) || a.movement_id - b.movement_id
  );
  negatives += rows.filter((r) => r.balance_after < 0).length;
  const problems = verifyPlan(rows, p.stock_on_hand);
  if (problems.length === 0) consistent += 1;
  else broken.push({ sku: p.sku, n: problems.length, first: problems[0] });
}
console.log(`  chains consistent: ${fmtInt(consistent)} / ${fmtInt(active.length)} active products`);
console.log(`  rows with balance_after < 0: ${fmtInt(negatives)}`);
console.log(`  products with no movements at all: ${fmtInt(active.filter((p) => !byProduct.has(p.product_id)).length)}`);
if (broken.length > 0) {
  table(broken.slice(0, 20), [
    { label: "SKU", get: (r) => r.sku },
    { label: "Problems", right: true, get: (r) => fmtInt(r.n) },
    { label: "First", get: (r) => r.first },
  ]);
}

// ---------------------------------------------------- 90-day margin tile
section("Dashboard: trailing 90-day margin");
const { data: kpi, error: kpiErr } = await sb.rpc("sales_kpi_summary");
if (kpiErr) console.log(`  sales_kpi_summary failed: ${kpiErr.message}`);
else {
  const k = Array.isArray(kpi) ? kpi[0] : kpi;
  const marginOf = (rev, cost) => (Number(rev) > 0 ? ((Number(rev) - Number(cost)) / Number(rev)) * 100 : 0);
  const cur = marginOf(k.current_revenue, k.current_cost);
  const prev = marginOf(k.previous_revenue, k.previous_cost);
  table(
    [
      { k: "current 90d revenue", v: peso(k.current_revenue) },
      { k: "current 90d cost", v: peso(k.current_cost) },
      { k: "current 90d margin", v: `${cur.toFixed(1)}%` },
      { k: "previous 90d revenue", v: peso(k.previous_revenue) },
      { k: "previous 90d margin", v: `${prev.toFixed(1)}%` },
      { k: "change", v: `${cur - prev >= 0 ? "+" : ""}${(cur - prev).toFixed(1)} pts` },
    ],
    [{ label: "Measure", get: (r) => r.k }, { label: "Value", right: true, get: (r) => r.v }]
  );
}

// ------------------------------------------------------ forecast history
section(`Forecast eligibility (span < ${MIN_MONTHS_HISTORY} months => Simple Moving Average only)`);
// monthly_series() in the forecast service reindexes first->last month and
// fills gaps with zero, so what gates the five-model comparison is the SPAN,
// not the number of months that have demand. Both are reported.
const { data: monthly, error: mdErr } = await sb.rpc("monthly_demand_all");
if (mdErr) console.log(`  monthly_demand_all failed: ${mdErr.message}`);
else {
  const bySku = new Map();
  for (const r of monthly ?? []) {
    const idx = r.year * 12 + r.month;
    let e = bySku.get(r.sku);
    if (!e) { e = { lo: idx, hi: idx, nonZero: 0 }; bySku.set(r.sku, e); }
    if (idx < e.lo) e.lo = idx;
    if (idx > e.hi) e.hi = idx;
    if (Number(r.units) > 0) e.nonZero += 1;
  }
  const dropped = [];
  let underNonZero = 0;
  for (const p of active) {
    const e = bySku.get(p.sku);
    const span = e ? e.hi - e.lo + 1 : 0;
    if ((e?.nonZero ?? 0) < MIN_MONTHS_HISTORY) underNonZero += 1;
    if (span < MIN_MONTHS_HISTORY) dropped.push({ sku: p.sku, name: p.name, span, nonZero: e?.nonZero ?? 0 });
  }
  console.log(`  items with fewer than ${MIN_MONTHS_HISTORY} non-zero demand months: ${fmtInt(underNonZero)}`);
  console.log(`  items dropping out of the five-model comparison (span < ${MIN_MONTHS_HISTORY}): ${fmtInt(dropped.length)}\n`);
  if (dropped.length > 0) {
    table(dropped.sort((a, b) => a.span - b.span || a.sku.localeCompare(b.sku)), [
      { label: "SKU", get: (r) => r.sku },
      { label: "Item", get: (r) => (r.name.length > 44 ? `${r.name.slice(0, 43)}~` : r.name) },
      { label: "Span (months)", right: true, get: (r) => fmtInt(r.span) },
      { label: "Non-zero months", right: true, get: (r) => fmtInt(r.nonZero) },
    ]);
  }
}

// ------------------------------------------------------ decision support
section("Decision Support chip counts");
// owner_product_performance() refuses anyone whose current_user_role() is not
// 'owner', and the service key has no profile, so auth.uid() is null and the
// guard fires. The shim runs that function's own body - vw_product_velocity
// left-joined to active products - which is the only call the service key
// cannot make; every other read below is the real one.
const shim = {
  ...sb,
  from: sb.from.bind(sb),
  rpc: async (name, args) => {
    if (name !== "owner_product_performance") return sb.rpc(name, args);
    const rows = await pageAll(
      () => sb.from("products").select("sku, stock_on_hand, reorder_point, is_active").eq("is_active", true).order("sku"),
      { pageSize, label: "products" }
    );
    const vel = await pageAll(() => sb.from("vw_product_velocity").select("sku, units_90d").order("sku"), {
      pageSize,
      label: "vw_product_velocity",
    });
    const velBySku = new Map(vel.map((v) => [v.sku, v.units_90d]));
    return { data: rows.map((r) => ({ sku: r.sku, units_90d: Number(velBySku.get(r.sku) ?? 0) })), error: null };
  },
};

const dss = await evaluateDecisionSupport(shim);
const LABELS = { low_stock: "Low stock", demand_spike: "Demand spike", overstock: "Overstock" };
const rows = Object.entries(LABELS).map(([k, label]) => ({ label, n: dss.byType[k] ?? 0, units: dss.unitsByType[k] ?? 0 }));
rows.push({ label: "No action needed", n: dss.noAction.length, units: dss.noActionUnits });
table(rows, [
  { label: "Chip", get: (r) => r.label },
  { label: "Items", right: true, get: (r) => fmtInt(r.n) },
  { label: "Units", right: true, get: (r) => fmtInt(r.units) },
]);
const chipSum = rows.reduce((s, r) => s + r.n, 0);
const unitSum = rows.reduce((s, r) => s + r.units, 0);
console.log(`\n  chips total ${fmtInt(chipSum)} vs ${fmtInt(dss.activeProductCount)} active products: ${chipSum === dss.activeProductCount ? "OK" : "MISMATCH"}`);
console.log(`  chip units total ${fmtInt(unitSum)} vs ${fmtInt(dss.totalUnits)} units in stock: ${unitSum === dss.totalUnits ? "OK" : "MISMATCH"}`);
console.log(`  alerts batch recorded this run: ${dss.recorded ? `yes (${dss.batchId})` : "no - advice unchanged"}`);

// -------------------------------------------------------------- summary
section("Summary");
const ok = consistent === active.length && negatives === 0 && chipSum === dss.activeProductCount && unitSum === dss.totalUnits;
console.log(`  ${ok ? "ALL CHECKS PASSED" : "SOMETHING FAILED - see above"}`);
process.exit(ok ? 0 : 1);
