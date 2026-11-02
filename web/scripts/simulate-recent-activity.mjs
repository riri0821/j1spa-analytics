#!/usr/bin/env node
/**
 * Fill the gap between the last seed sale and today with simulated parts
 * sales and services.
 *
 *   node scripts/simulate-recent-activity.mjs            # dry run (default)
 *   node scripts/simulate-recent-activity.mjs --apply    # actually write
 *
 * Parts sales are generated to match the seed data's own shape - sales per
 * weekday, lines per sale, quantities, which SKUs move, and who recorded
 * them - and each one has the same effect confirm_sale() would: a sales row,
 * sale_items rows, products.stock_on_hand decremented, and a sale_decrement
 * movement with the right balance_after. Stock is replenished when a product
 * reaches its reorder point, so the ledger shows deliveries as well as sales.
 *
 * Services are labour only. record_service() touches no stock, so neither
 * does this: no stock_movements, no stock_on_hand change.
 *
 * Tagging: sales.note = 'simulated' and stock_movements.note = 'simulated'.
 * The services table has no note column, so the inserted service_id range is
 * written to scripts/simulated-ids.json instead.
 *
 * MUST run after scripts/backfill-ledger.mjs --apply: that script anchors
 * every product's ledger on products.stock_on_hand, and this one changes
 * stock_on_hand. Running them the other way round would leave the backfill
 * reconstructing history against a stock level this script had already
 * moved.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createServiceClient,
  insertBatched,
  pageAll,
  probePageSize,
  progressDone,
  progressLine,
  WEB_DIR,
} from "./lib/db.mjs";
import { stockCeiling } from "./lib/ledgerPlan.mjs";
import {
  addDaysMs,
  deliveryReceipt,
  fmtInt,
  fmtPeso,
  makeRand,
  manilaDateString,
  manilaMidnight,
  manilaParts,
  manilaStamp,
  parseArgs,
  randInt,
  randomStoreHour,
  section,
  seedFor,
  STORE_CLOSE_HOUR,
  STORE_OPEN_HOUR,
  table,
  toManilaIso,
  weightedIndex,
} from "./lib/seedlib.mjs";

const SIMULATED_NOTE = "simulated";
const BACKFILL_NOTE = "seed-backfill";
const IDS_FILE = resolve(WEB_DIR, "scripts", "simulated-ids.json");

// Services only exist from October 2026 - the feature launched then, so
// there is nothing earlier to simulate.
const SERVICES_EPOCH = manilaMidnight("2026-10-06");

// total_amount is drawn inside the range and rounded to the nearest 10 pesos.
// Weights favour the cheap, common jobs.
const SERVICE_TYPES = [
  { type: "Change oil (labor)", min: 150, max: 300, weight: 10 },
  { type: "CVT cleaning", min: 300, max: 500, weight: 8 },
  { type: "Brake service", min: 200, max: 400, weight: 7 },
  { type: "Tire change (labor)", min: 100, max: 200, weight: 5 },
  { type: "Throttle body cleaning", min: 300, max: 500, weight: 4 },
  { type: "Engine tune-up", min: 500, max: 1200, weight: 3 },
  { type: "Electrical troubleshooting", min: 300, max: 800, weight: 3 },
  { type: "Fuel injector cleaning", min: 500, max: 800, weight: 2 },
  { type: "Valve clearance adjustment", min: 400, max: 700, weight: 2 },
  { type: "Bearing replacement (labor)", min: 300, max: 600, weight: 2 },
];

const BASE_BRANDS = [
  { brand: "Yamaha", weight: 10 },
  { brand: "Honda", weight: 9 },
  { brand: "Suzuki", weight: 3 },
  { brand: "Kawasaki", weight: 2 },
];

const args = parseArgs(process.argv.slice(2));

async function main() {
  const sb = createServiceClient();
  const pageSize = await probePageSize(sb);

  section("Simulate recent activity" + (args.apply ? " -- APPLY" : " -- DRY RUN (no writes)"));
  console.log(`  PostgREST page size in use: ${fmtInt(pageSize)}`);

  // ------------------------------------------------- precondition check
  const { count: backfilled, error: countError } = await sb
    .from("stock_movements")
    .select("*", { count: "exact", head: true })
    .eq("note", BACKFILL_NOTE);
  if (countError) throw new Error(`could not check for the backfill: ${countError.message}`);

  const backfillApplied = (backfilled ?? 0) > 0;
  if (!backfillApplied) {
    section("PRECONDITION NOT MET - the ledger backfill has not been applied");
    console.log(
      `  stock_movements holds 0 rows tagged '${BACKFILL_NOTE}'.\n\n` +
        `  Run this first:\n` +
        `      node scripts/backfill-ledger.mjs --apply\n\n` +
        `  Order matters: backfill-ledger anchors every product's ledger on\n` +
        `  products.stock_on_hand, and this script changes stock_on_hand. Run\n` +
        `  them the other way round and the backfill would rebuild six years of\n` +
        `  history against a stock level this script had already moved.`
    );
    if (args.apply) {
      console.log(`\n  --apply REFUSED. Nothing was written.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n  Continuing the DRY RUN anyway (it writes nothing) so the plan can be`);
    console.log(`  reviewed. --apply would refuse until the backfill is in place.`);
  }

  // ---------------------------------------------------------------- load
  progressLine("loading products...");
  const products = await pageAll(
    () =>
      sb
        .from("products")
        .select("product_id, sku, name, supplier, unit_cost, unit_price, reorder_point, stock_on_hand, is_active")
        .eq("is_active", true)
        .order("product_id"),
    { pageSize, label: "products" }
  );
  progressDone(`active products: ${fmtInt(products.length)}`);

  const lastSale = await latestTs(sb, "sales", "sale_ts");
  const lastMovement = await latestTs(sb, "stock_movements", "movement_ts");
  const lastService = await latestTs(sb, "services", "service_ts");

  // Start after the latest of the three. Starting merely after the last
  // SALE would interleave simulated movements with the existing Oct 6
  // movements, and then a product's balances would not chain.
  const anchor = Math.max(lastSale ?? 0, lastMovement ?? 0, lastService ?? 0);
  const now = Date.now();
  const startTs = anchor + 60000;
  const startDate = manilaDateString(startTs);
  const endDate = manilaDateString(now);

  console.log(`  latest sale_ts      : ${lastSale ? manilaStamp(lastSale) : "-"}`);
  console.log(`  latest movement_ts  : ${lastMovement ? manilaStamp(lastMovement) : "-"}`);
  console.log(`  latest service_ts   : ${lastService ? manilaStamp(lastService) : "-"}`);
  console.log(`  simulating          : ${startDate} .. ${endDate} (Manila)`);

  if (manilaMidnight(startDate) > manilaMidnight(endDate)) {
    section("Nothing to do");
    console.log("  The data already reaches today.");
    return;
  }

  // ----------------------------------------------------- learn patterns
  const yearAgo = addDaysMs(now, -365);
  progressLine("loading the last 12 months of sales...");
  const recentSales = await pageAll(
    () =>
      sb
        .from("sales")
        .select("sale_id, sale_ts, user_id, user_role, total_amount")
        .eq("status", "confirmed")
        .gte("sale_ts", new Date(yearAgo).toISOString())
        .order("sale_id"),
    { pageSize, label: "recent sales" }
  );
  progressDone(`sales in the last 12 months: ${fmtInt(recentSales.length)}`);

  const ninetyAgo = addDaysMs(now, -90);
  const recentIds = new Set(recentSales.filter((s) => Date.parse(s.sale_ts) >= ninetyAgo).map((s) => s.sale_id));

  progressLine("loading the last 90 days of sale_items...");
  const recentItems = await pageAll(
    () =>
      sb
        .from("sale_items")
        .select("sale_id, product_id, quantity")
        .gte("sale_id", [...recentIds].reduce((lo, id) => (lo == null || id < lo ? id : lo), null) ?? 0)
        .order("sale_item_id"),
    { pageSize, label: "recent sale_items" }
  );
  const items90 = recentItems.filter((i) => recentIds.has(i.sale_id));
  progressDone(`sale_items in the last 90 days: ${fmtInt(items90.length)}`);

  const patterns = learnPatterns({ recentSales, items90, recentIds, now });

  // Service types and vehicle brands already present in the data.
  const existingServices = await pageAll(
    () => sb.from("services").select("service_id, service_type, customer_vehicle_brand, total_amount").order("service_id"),
    { pageSize, label: "services" }
  );
  const brandRows = await pageAll(
    () =>
      sb
        .from("sales")
        .select("customer_vehicle_brand")
        .not("customer_vehicle_brand", "is", null)
        .gte("sale_ts", new Date(yearAgo).toISOString())
        .order("sale_id"),
    { pageSize, label: "brands" }
  );

  const serviceTypes = mergeServiceTypes(existingServices);
  const brands = mergeBrands(existingServices, brandRows);

  printPatterns(patterns, serviceTypes, brands, existingServices);

  // --------------------------------------------------------- simulate
  const plan = simulate({ products, patterns, serviceTypes, brands, startTs, now });

  // ---------------------------------------------------------- reports
  printPlan({ plan, products, startTs, now, existingServices });

  if (!args.apply) {
    section("Dry run complete - nothing was written");
    console.log("  Re-run with --apply to write these rows" + (backfillApplied ? "." : " (refused until the backfill is applied)."));
    console.log(`  On --apply, the inserted id ranges are written to scripts/simulated-ids.json.`);
    return;
  }

  await applyPlan(sb, plan);
}

// ---------------------------------------------------------------- helpers

async function latestTs(sb, table_, column) {
  const { data, error } = await sb.from(table_).select(column).order(column, { ascending: false }).limit(1);
  if (error) throw new Error(`reading the latest ${column} failed: ${error.message}`);
  return data?.[0] ? Date.parse(data[0][column]) : null;
}

function learnPatterns({ recentSales, items90, recentIds, now }) {
  // Sales per weekday: total sales on that weekday divided by how many of
  // that weekday actually occurred in the window, so a partial year does
  // not understate it.
  const perWeekday = Array.from({ length: 7 }, () => ({ sales: 0, days: new Set() }));
  for (const s of recentSales) {
    const ts = Date.parse(s.sale_ts);
    const p = manilaParts(ts);
    perWeekday[p.weekday].sales += 1;
    perWeekday[p.weekday].days.add(manilaDateString(ts));
  }
  const salesPerWeekday = perWeekday.map((w) => (w.days.size > 0 ? w.sales / w.days.size : 0));

  // Lines per sale, and quantity per line, as histograms sampled directly
  // rather than fitted - the real shape is what matters.
  const linesBySale = new Map();
  const qtyHist = new Map();
  for (const it of items90) {
    linesBySale.set(it.sale_id, (linesBySale.get(it.sale_id) ?? 0) + 1);
    qtyHist.set(it.quantity, (qtyHist.get(it.quantity) ?? 0) + 1);
  }
  const lineHist = new Map();
  for (const id of recentIds) {
    const n = linesBySale.get(id) ?? 0;
    if (n > 0) lineHist.set(n, (lineHist.get(n) ?? 0) + 1);
  }

  // Which SKUs move, weighted by units sold in the last 90 days.
  const unitsByProduct = new Map();
  for (const it of items90) {
    unitsByProduct.set(it.product_id, (unitsByProduct.get(it.product_id) ?? 0) + it.quantity);
  }

  // Who recorded them, in the same proportions.
  const userHist = new Map();
  for (const s of recentSales) {
    if (Date.parse(s.sale_ts) < addDaysMs(now, -90)) continue;
    const key = `${s.user_id ?? ""}|${s.user_role}`;
    userHist.set(key, (userHist.get(key) ?? 0) + 1);
  }

  return {
    salesPerWeekday,
    lineHist: toWeighted(lineHist),
    qtyHist: toWeighted(qtyHist),
    unitsByProduct,
    users: toWeighted(userHist),
    sampleSize: recentSales.length,
    items90: items90.length,
  };
}

function toWeighted(map) {
  const keys = [...map.keys()];
  return { keys, weights: keys.map((k) => map.get(k)) };
}

function pickWeighted(dist, rand, fallback) {
  if (dist.keys.length === 0) return fallback;
  return dist.keys[weightedIndex(dist.weights, rand)];
}

function mergeServiceTypes(existingServices) {
  const list = SERVICE_TYPES.map((t) => ({ ...t }));
  for (const s of existingServices) {
    const name = (s.service_type ?? "").trim();
    if (!name || list.some((t) => t.type.toLowerCase() === name.toLowerCase())) continue;
    // A type already in the data that is not on the agreed list: keep it,
    // priced around what it was actually charged at.
    const amount = Number(s.total_amount) || 200;
    list.push({ type: name, min: Math.max(50, Math.round(amount * 0.8)), max: Math.round(amount * 1.2), weight: 2 });
  }
  return list;
}

function mergeBrands(existingServices, brandRows) {
  const list = BASE_BRANDS.map((b) => ({ ...b }));
  const seen = new Set(list.map((b) => b.brand.toLowerCase()));
  for (const row of [...existingServices, ...brandRows]) {
    const brand = (row.customer_vehicle_brand ?? "").trim();
    if (!brand || seen.has(brand.toLowerCase())) continue;
    seen.add(brand.toLowerCase());
    list.push({ brand, weight: 2 });
  }
  return list;
}

// ------------------------------------------------------------- simulation

function simulate({ products, patterns, serviceTypes, brands, startTs, now }) {
  const byId = new Map(products.map((p) => [p.product_id, p]));
  const balance = new Map(products.map((p) => [p.product_id, p.stock_on_hand]));
  const openingTotal = products.reduce((s, p) => s + p.stock_on_hand, 0);

  // Sellable SKUs, weighted by recent demand.
  const sellable = products.filter((p) => (patterns.unitsByProduct.get(p.product_id) ?? 0) > 0);
  const weights = sellable.map((p) => patterns.unitsByProduct.get(p.product_id));

  const ceilingFor = new Map();
  for (const p of products) {
    const monthly = ((patterns.unitsByProduct.get(p.product_id) ?? 0) / 90) * 30;
    ceilingFor.set(p.product_id, stockCeiling(p, monthly));
  }

  const sales = [];
  const movements = [];
  const services = [];
  const restocksPending = new Map(); // dateString -> [{ productId, qty }]
  const shortfalls = new Map();
  let restockCount = 0;

  const rand = makeRand(seedFor("simulate", 1));

  const firstDay = manilaMidnight(manilaDateString(startTs));
  const lastDay = manilaMidnight(manilaDateString(now));

  for (let day = firstDay; day <= lastDay; day = addDaysMs(day, 1)) {
    const dateKey = manilaDateString(day);
    const weekday = manilaParts(day).weekday;
    const dayEvents = [];

    // Deliveries that fall due today.
    for (const due of restocksPending.get(dateKey) ?? []) {
      dayEvents.push({ type: "restock", ts: randomStoreHour(day, rand), ...due });
    }
    restocksPending.delete(dateKey);

    // Today's sales, at the rate this weekday actually runs at.
    const mean = patterns.salesPerWeekday[weekday] ?? 0;
    const count = Math.max(0, Math.round(mean * (0.75 + 0.5 * rand())));
    for (let i = 0; i < count; i++) {
      dayEvents.push({ type: "sale", ts: randomStoreHour(day, rand) });
    }

    // Today's services: 4-8 on an open day, fewer on Sundays. Only from the
    // October 2026 launch onwards.
    if (day >= SERVICES_EPOCH) {
      const serviceCount = weekday === 0 ? randInt(rand, 1, 3) : randInt(rand, 4, 8);
      for (let i = 0; i < serviceCount; i++) {
        dayEvents.push({ type: "service", ts: randomStoreHour(day, rand) });
      }
    }

    // In time order, so each product's balances chain the way the ledger
    // will read them.
    dayEvents.sort((a, b) => a.ts - b.ts);

    for (const ev of dayEvents) {
      if (ev.ts < startTs || ev.ts > now) continue;

      if (ev.type === "restock") {
        const product = byId.get(ev.productId);
        const next = (balance.get(ev.productId) ?? 0) + ev.qty;
        balance.set(ev.productId, next);
        movements.push({
          product_id: product.product_id,
          sku: product.sku,
          movement_type: "stock_in",
          quantity: ev.qty,
          balance_after: next,
          user_id: null,
          reference: deliveryReceipt(ev.ts),
          note: SIMULATED_NOTE,
          movement_ts: toManilaIso(ev.ts),
          supplier: product.supplier ?? null,
          unit_cost: product.unit_cost ?? null,
          __ts: ev.ts,
        });
        restockCount += 1;
        continue;
      }

      if (ev.type === "service") {
        const pick = serviceTypes[weightedIndex(serviceTypes.map((t) => t.weight), rand)];
        const raw = pick.min + rand() * (pick.max - pick.min);
        const amount = Math.max(10, Math.round(raw / 10) * 10); // nearest 10 pesos
        const brand = brands[weightedIndex(brands.map((b) => b.weight), rand)].brand;
        const [userId, userRole] = splitUser(pickWeighted(patterns.users, rand, "|staff"));
        services.push({
          service_ts: toManilaIso(ev.ts),
          user_id: userId,
          user_role: userRole,
          service_type: pick.type,
          total_amount: amount,
          status: "confirmed",
          // No invented personal data: only the vehicle brand is set.
          customer_name: null,
          customer_contact: null,
          customer_address: null,
          customer_vehicle_brand: brand,
          __ts: ev.ts,
        });
        continue;
      }

      // ------------------------------------------------------- a sale
      const nLines = Math.min(6, Math.max(1, pickWeighted(patterns.lineHist, rand, 1)));
      const chosen = new Set();
      const lines = [];
      let revenue = 0;
      let cost = 0;

      for (let attempt = 0; attempt < nLines * 4 && lines.length < nLines; attempt++) {
        if (sellable.length === 0) break;
        const product = sellable[weightedIndex(weights, rand)];
        if (chosen.has(product.product_id)) continue;

        const have = balance.get(product.product_id) ?? 0;
        if (have <= 0) {
          scheduleRestock({ product, balance, ceilingFor, restocksPending, ts: ev.ts, rand });
          bump(shortfalls, product.sku);
          continue;
        }
        chosen.add(product.product_id);

        const wanted = Math.max(1, pickWeighted(patterns.qtyHist, rand, 1));
        const qty = Math.min(wanted, have); // never sell more than is on hand
        if (qty < wanted) bump(shortfalls, product.sku);

        const next = have - qty;
        balance.set(product.product_id, next);

        const unitPrice = Number(product.unit_price) || 0;
        const unitCost = Number(product.unit_cost) || 0;
        const lineRevenue = round2(qty * unitPrice);
        const lineCost = round2(qty * unitCost);
        revenue = round2(revenue + lineRevenue);
        cost = round2(cost + lineCost);

        lines.push({
          product_id: product.product_id,
          sku: product.sku,
          quantity: qty,
          unit_price: unitPrice,
          unit_cost: unitCost,
          line_revenue: lineRevenue,
          line_cost: lineCost,
          __balanceAfter: next,
        });

        if (next <= (product.reorder_point ?? 0)) {
          scheduleRestock({ product, balance, ceilingFor, restocksPending, ts: ev.ts, rand });
        }
      }

      if (lines.length === 0) continue;

      const [userId, userRole] = splitUser(pickWeighted(patterns.users, rand, "|staff"));
      sales.push({
        sale: {
          sale_ts: toManilaIso(ev.ts),
          user_id: userId,
          user_role: userRole,
          total_amount: revenue,
          total_cost: cost,
          status: "confirmed",
          note: SIMULATED_NOTE,
          source_type: "Direct Sales Entry",
        },
        lines,
        __ts: ev.ts,
      });
    }
  }

  // Restocks scheduled past the end of the window simply never arrive.
  let unfilled = 0;
  for (const list of restocksPending.values()) unfilled += list.length;

  const closingTotal = [...balance.values()].reduce((s, v) => s + v, 0);

  return {
    sales,
    movements,
    services,
    restockCount,
    unfilled,
    shortfalls,
    openingTotal,
    closingTotal,
    balance,
    byId,
    unitsSold: sales.reduce((s, x) => s + x.lines.reduce((t, l) => t + l.quantity, 0), 0),
    unitsIn: movements.reduce((s, m) => s + m.quantity, 0),
    salesRevenue: sales.reduce((s, x) => round2(s + x.sale.total_amount), 0),
    salesCost: sales.reduce((s, x) => round2(s + x.sale.total_cost), 0),
    servicesRevenue: services.reduce((s, x) => round2(s + x.total_amount), 0),
  };
}

function scheduleRestock({ product, balance, ceilingFor, restocksPending, ts, rand }) {
  const when = manilaDateString(addDaysMs(ts, randInt(rand, 2, 5)));
  const queued = restocksPending.get(when) ?? [];
  // One pending delivery per product at a time, as a real order would be.
  for (const list of restocksPending.values()) {
    if (list.some((r) => r.productId === product.product_id)) return;
  }
  const ceiling = ceilingFor.get(product.product_id) ?? 10;
  const qty = Math.max(1, ceiling - (balance.get(product.product_id) ?? 0));
  queued.push({ productId: product.product_id, qty });
  restocksPending.set(when, queued);
}

function splitUser(key) {
  const [id, role] = String(key).split("|");
  return [id || null, role === "owner" ? "owner" : "staff"];
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ----------------------------------------------------------------- output

function printPatterns(patterns, serviceTypes, brands, existingServices) {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  section("Patterns learned from the seed data");
  console.log(`  Sales sampled: ${fmtInt(patterns.sampleSize)} over the last 12 months`);
  console.log(`  Sale lines sampled: ${fmtInt(patterns.items90)} over the last 90 days\n`);
  table(
    patterns.salesPerWeekday.map((v, i) => ({ d: DAYS[i], v })),
    [
      { label: "Weekday", get: (r) => r.d },
      { label: "Sales per day", right: true, get: (r) => r.v.toFixed(1) },
    ]
  );
  console.log("\n  Lines per sale:");
  table(
    patterns.lineHist.keys
      .map((k, i) => ({ k, w: patterns.lineHist.weights[i] }))
      .sort((a, b) => a.k - b.k),
    [
      { label: "Lines", right: true, get: (r) => r.k },
      { label: "Sales", right: true, get: (r) => fmtInt(r.w) },
    ]
  );
  console.log("\n  Quantity per line (top 8):");
  table(
    patterns.qtyHist.keys
      .map((k, i) => ({ k, w: patterns.qtyHist.weights[i] }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 8),
    [
      { label: "Qty", right: true, get: (r) => r.k },
      { label: "Lines", right: true, get: (r) => fmtInt(r.w) },
    ]
  );
  console.log(`\n  SKUs with demand in the last 90 days: ${fmtInt(patterns.unitsByProduct.size)}`);
  console.log("\n  Who recorded the sale (simulated rows use these same proportions):");
  table(
    patterns.users.keys.map((k, i) => ({ k, w: patterns.users.weights[i] })).sort((a, b) => b.w - a.w),
    [
      { label: "user_id|role", get: (r) => r.k.replace(/^([0-9a-f]{8})[^|]*/, "$1...") },
      { label: "Sales", right: true, get: (r) => fmtInt(r.w) },
    ]
  );
  console.log(`\n  Service types in use: ${fmtInt(serviceTypes.length)} (${SERVICE_TYPES.length} from the agreed list)`);
  const extra = serviceTypes.slice(SERVICE_TYPES.length).map((t) => t.type);
  console.log(
    `  Existing services rows: ${fmtInt(existingServices.length)}` +
      (existingServices.length ? ` -> ${existingServices.map((s) => s.service_type).join(", ")}` : "")
  );
  if (extra.length) console.log(`  Added from existing data: ${extra.join(", ")}`);
  const added = brands.slice(BASE_BRANDS.length).map((b) => b.brand);
  console.log(`  Vehicle brands: ${brands.map((b) => b.brand).join(", ")}`);
  if (added.length) {
    console.log(
      `  ${added.length} brand(s) came from existing rows rather than the agreed list:` +
        ` ${added.join(", ")}.\n  They keep the lowest weight. Edit BASE_BRANDS / mergeBrands to drop any that` +
        `\n  are test data rather than real vehicle brands.`
    );
  }
}

function printPlan({ plan, products, startTs, now, existingServices }) {
  const saleItemCount = plan.sales.reduce((s, x) => s + x.lines.length, 0);
  const touched = new Set();
  for (const s of plan.sales) for (const l of s.lines) touched.add(l.product_id);
  for (const m of plan.movements) touched.add(m.product_id);

  section("Rows that would be written");
  table(
    [
      { t: "sales (insert)", n: plan.sales.length },
      { t: "sale_items (insert)", n: saleItemCount },
      { t: "services (insert)", n: plan.services.length },
      { t: "stock_movements (insert) - sale_decrement", n: saleItemCount },
      { t: "stock_movements (insert) - stock_in restocks", n: plan.movements.length },
      { t: "stock_movements (insert) - TOTAL", n: saleItemCount + plan.movements.length },
      { t: "products (update stock_on_hand)", n: touched.size },
    ],
    [
      { label: "Table / operation", get: (r) => r.t },
      { label: "Rows", right: true, get: (r) => fmtInt(r.n) },
    ]
  );
  console.log(`\n  Date range covered: ${manilaStamp(startTs)}  ->  ${manilaStamp(now)} (Manila)`);
  console.log(`  Synthetic restocks: ${fmtInt(plan.restockCount)}` + (plan.unfilled ? ` (${fmtInt(plan.unfilled)} scheduled past the window, not inserted)` : ""));
  console.log(`  Services are labour only: no stock_movements, no stock change.`);

  section("Before / after");
  table(
    [
      { k: "Total units in stock (active products)", b: fmtInt(plan.openingTotal), a: fmtInt(plan.closingTotal) },
      { k: "  units sold by simulated sales", b: "-", a: `-${fmtInt(plan.unitsSold)}` },
      { k: "  units received by simulated restocks", b: "-", a: `+${fmtInt(plan.unitsIn)}` },
      { k: "Products touched", b: "-", a: fmtInt(touched.size) },
      { k: "Products never touched", b: "-", a: fmtInt(products.length - touched.size) },
    ],
    [
      { label: "Measure", get: (r) => r.k },
      { label: "Before", right: true, get: (r) => r.b },
      { label: "After", right: true, get: (r) => r.a },
    ]
  );
  const expected = plan.openingTotal - plan.unitsSold + plan.unitsIn;
  console.log(
    `\n  ${expected === plan.closingTotal ? "OK" : "MISMATCH"}: ` +
      `${fmtInt(plan.openingTotal)} - ${fmtInt(plan.unitsSold)} + ${fmtInt(plan.unitsIn)} = ${fmtInt(expected)}` +
      ` (expected new total units in stock)`
  );
  const ratio = plan.openingTotal > 0 ? plan.closingTotal / plan.openingTotal : 1;
  if (ratio > 1.25 || ratio < 0.75) {
    console.log(
      `\n  NOTE: total stock changes by ${((ratio - 1) * 100).toFixed(0)}%. Most products currently sit at\n` +
        `  or below their reorder point, so almost every one triggers a delivery, and\n` +
        `  a delivery tops a product up to max(reorder_point x 3, monthly demand x 2, 10)\n` +
        `  - the same rule backfill-ledger uses. The dashboard's "Total units in stock"\n` +
        `  will move accordingly. Lower the ceiling in lib/ledgerPlan.mjs if that is too\n` +
        `  much restocking for the demonstration.`
    );
  }

  section("Revenue for the simulated window");
  table(
    [
      { k: "Parts sales revenue (gross)", v: fmtPeso(plan.salesRevenue) },
      { k: "Parts sales cost", v: fmtPeso(plan.salesCost) },
      { k: "Parts sales net", v: fmtPeso(round2(plan.salesRevenue - plan.salesCost)) },
      { k: "Services revenue (gross = net, no cost)", v: fmtPeso(plan.servicesRevenue) },
      { k: "Combined gross", v: fmtPeso(round2(plan.salesRevenue + plan.servicesRevenue)) },
    ],
    [
      { label: "Measure", get: (r) => r.k },
      { label: "Amount", right: true, get: (r) => r.v },
    ]
  );

  section("Products where constraints could not be met");
  if (plan.shortfalls.size === 0) {
    console.log("  None - every simulated line was fully satisfied from stock on hand.");
  } else {
    console.log(
      `  ${fmtInt(plan.shortfalls.size)} product(s) ran out mid-window. A line was either\n` +
        `  trimmed to the units actually on hand or skipped, and a delivery was\n` +
        `  scheduled - stock is never allowed to go negative.\n`
    );
    table(
      [...plan.shortfalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([sku, n]) => ({ sku, n })),
      [
        { label: "SKU", get: (r) => r.sku },
        { label: "Times short", right: true, get: (r) => fmtInt(r.n) },
      ]
    );
    if (plan.shortfalls.size > 20) console.log(`  ... and ${fmtInt(plan.shortfalls.size - 20)} more`);
  }

  section("Simulated id ranges (written to scripts/simulated-ids.json on --apply)");
  console.log(
    `  sales    : ${fmtInt(plan.sales.length)} rows, note = 'simulated' (also identifiable by note)\n` +
      `  services : ${fmtInt(plan.services.length)} rows - the table has no note column, so the\n` +
      `             service_id range is the only handle. Existing services today:` +
      ` ${existingServices.map((s) => s.service_id).join(", ") || "none"}\n` +
      `  Real ids are only known once the rows are inserted, so the file is\n` +
      `  written by --apply, not by this dry run.`
  );

  printSampleLedgers(plan);
  printSampleServices(plan);
}

function printSampleLedgers(plan) {
  // Rebuild per-product movement timelines from the plan, the way the ledger
  // page would read them.
  const perProduct = new Map();
  const push = (pid, row) => {
    if (!perProduct.has(pid)) perProduct.set(pid, []);
    perProduct.get(pid).push(row);
  };
  for (const s of plan.sales) {
    for (const l of s.lines) {
      push(l.product_id, {
        ts: s.__ts,
        quantity: -l.quantity,
        balance_after: l.__balanceAfter,
        what: "Sold - simulated sale",
      });
    }
  }
  for (const m of plan.movements) {
    push(m.product_id, { ts: m.__ts, quantity: m.quantity, balance_after: m.balance_after, what: `Replenished stock - ${m.reference}` });
  }
  for (const list of perProduct.values()) list.sort((a, b) => a.ts - b.ts);

  const ranked = [...perProduct.entries()]
    .map(([pid, rows]) => ({ pid, rows, sold: rows.filter((r) => r.quantity < 0).length }))
    .sort((a, b) => b.sold - a.sold);
  if (ranked.length === 0) return;

  // Three distinct products: the busiest, the quietest, and one that shows a
  // delivery alongside its sales. The busiest often has a delivery too, so
  // the third pick skips anything already shown.
  const fast = ranked[0];
  const slow = ranked[ranked.length - 1];
  const shown = new Set([fast?.pid, slow?.pid]);
  const restocked = ranked.find((r) => !shown.has(r.pid) && r.rows.some((x) => x.quantity > 0));
  const picks = [
    ["Fast-moving", fast],
    ["Slow-moving", slow],
    ["With a simulated restock", restocked],
  ].filter(([, r]) => r);

  for (const [label, entry] of picks) {
    const product = plan.byId.get(entry.pid);
    section(`Sample simulated ledger - ${label}: ${product.sku}`);
    console.log(
      `  ${product.name}\n  stock before ${fmtInt(product.stock_on_hand)} -> after ${fmtInt(plan.balance.get(entry.pid))}` +
        ` | reorder point ${fmtInt(product.reorder_point)} | ${fmtInt(entry.rows.length)} new rows`
    );
    const head = entry.rows.slice(0, 5);
    const tail = entry.rows.slice(Math.max(5, entry.rows.length - 10));
    const render = (list) =>
      table(list, [
        { label: "When (Manila)", get: (r) => manilaStamp(r.ts) },
        { label: "Particulars", get: (r) => r.what },
        { label: "IN", right: true, get: (r) => (r.quantity > 0 ? fmtInt(r.quantity) : "") },
        { label: "OUT", right: true, get: (r) => (r.quantity < 0 ? fmtInt(-r.quantity) : "") },
        { label: "Balance", right: true, get: (r) => fmtInt(r.balance_after) },
      ]);
    console.log("\n  First 5:");
    render(head);
    if (entry.rows.length > 15) console.log(`\n  ... ${fmtInt(entry.rows.length - 15)} rows omitted ...`);
    console.log(`\n  Last ${Math.min(10, Math.max(0, entry.rows.length - 5))}:`);
    render(tail);
  }
}

function printSampleServices(plan) {
  section("Sample simulated services (first 10)");
  table(plan.services.slice(0, 10), [
    { label: "When (Manila)", get: (r) => manilaStamp(r.__ts) },
    { label: "Service", get: (r) => r.service_type },
    { label: "Amount", right: true, get: (r) => fmtPeso(r.total_amount) },
    { label: "Brand", get: (r) => r.customer_vehicle_brand },
    { label: "Role", get: (r) => r.user_role },
  ]);
  const byType = new Map();
  for (const s of plan.services) byType.set(s.service_type, (byType.get(s.service_type) ?? 0) + 1);
  console.log("\n  Service mix:");
  table(
    [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ t, n })),
    [
      { label: "Service", get: (r) => r.t },
      { label: "Count", right: true, get: (r) => fmtInt(r.n) },
    ]
  );
}

// ------------------------------------------------------------------ apply

async function applyPlan(sb, plan) {
  section("Applying");

  // Sales first, so each sale_id is known before its lines and movement.
  const salePayload = plan.sales.map((s) => s.sale);
  const insertedSales = await insertBatched(sb, "sales", salePayload, {
    select: "sale_id",
    onProgress: (d, t) => progressLine(`inserting sales ${fmtInt(d)}/${fmtInt(t)}`),
  });
  progressDone(`inserted ${fmtInt(insertedSales.length)} sales`);
  if (insertedSales.length !== plan.sales.length) {
    throw new Error(`expected ${plan.sales.length} sale ids back, got ${insertedSales.length}`);
  }

  const items = [];
  const saleMovements = [];
  plan.sales.forEach((s, i) => {
    const saleId = insertedSales[i].sale_id;
    for (const l of s.lines) {
      items.push({
        sale_id: saleId,
        product_id: l.product_id,
        sku: l.sku,
        quantity: l.quantity,
        unit_price: l.unit_price,
        unit_cost: l.unit_cost,
        line_revenue: l.line_revenue,
        line_cost: l.line_cost,
      });
      saleMovements.push({
        product_id: l.product_id,
        sku: l.sku,
        movement_type: "sale_decrement",
        quantity: -l.quantity,
        balance_after: l.__balanceAfter,
        user_id: s.sale.user_id,
        reference: `sale:${saleId}`,
        note: SIMULATED_NOTE,
        movement_ts: s.sale.sale_ts,
        supplier: null,
        unit_cost: null,
        __ts: s.__ts,
      });
    }
  });

  await insertBatched(sb, "sale_items", items, {
    onProgress: (d, t) => progressLine(`inserting sale_items ${fmtInt(d)}/${fmtInt(t)}`),
  });
  progressDone(`inserted ${fmtInt(items.length)} sale_items`);

  // All movements in timestamp order, so identity ids follow the ledger's
  // (movement_ts, movement_id) ordering.
  const allMovements = [...saleMovements, ...plan.movements].sort((a, b) => a.__ts - b.__ts);
  await insertBatched(
    sb,
    "stock_movements",
    allMovements.map(({ __ts, ...row }) => row),
    { onProgress: (d, t) => progressLine(`inserting stock_movements ${fmtInt(d)}/${fmtInt(t)}`) }
  );
  progressDone(`inserted ${fmtInt(allMovements.length)} stock_movements`);

  const insertedServices = await insertBatched(
    sb,
    "services",
    plan.services.map(({ __ts, ...row }) => row),
    { select: "service_id", onProgress: (d, t) => progressLine(`inserting services ${fmtInt(d)}/${fmtInt(t)}`) }
  );
  progressDone(`inserted ${fmtInt(insertedServices.length)} services`);

  // Stock last, so a failure part-way leaves stock matching the ledger
  // rather than the other way round.
  let updated = 0;
  for (const [productId, value] of plan.balance.entries()) {
    const product = plan.byId.get(productId);
    if (!product || product.stock_on_hand === value) continue;
    const { error } = await sb.from("products").update({ stock_on_hand: value }).eq("product_id", productId);
    if (error) throw new Error(`updating stock_on_hand for product ${productId} failed: ${error.message}`);
    updated += 1;
  }
  console.log(`  updated stock_on_hand on ${fmtInt(updated)} products`);

  const saleIds = insertedSales.map((r) => r.sale_id);
  const serviceIds = insertedServices.map((r) => r.service_id);
  const manifest = {
    generatedAt: new Date().toISOString(),
    note: SIMULATED_NOTE,
    window: { from: plan.sales[0]?.sale.sale_ts ?? null, to: plan.sales.at(-1)?.sale.sale_ts ?? null },
    sales: { first: saleIds[0] ?? null, last: saleIds.at(-1) ?? null, count: saleIds.length },
    services: { first: serviceIds[0] ?? null, last: serviceIds.at(-1) ?? null, count: serviceIds.length },
    howToRemove: [
      "delete from sale_items where sale_id between <sales.first> and <sales.last>;",
      "delete from stock_movements where note = 'simulated';",
      "delete from sales where note = 'simulated';",
      "delete from services where service_id between <services.first> and <services.last>;",
      "-- then recompute products.stock_on_hand, or restore it from the backup schema",
    ],
  };
  writeFileSync(IDS_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`  wrote ${IDS_FILE}`);
  console.log(`  sales    sale_id range:    ${manifest.sales.first} .. ${manifest.sales.last}`);
  console.log(`  services service_id range: ${manifest.services.first} .. ${manifest.services.last}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});

export { STORE_OPEN_HOUR, STORE_CLOSE_HOUR };
