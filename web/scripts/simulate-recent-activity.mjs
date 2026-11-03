#!/usr/bin/env node
/**
 * Top up the database with simulated parts sales and services, from the last
 * recorded event to now.
 *
 *   node scripts/simulate-recent-activity.mjs            # dry run (default)
 *   node scripts/simulate-recent-activity.mjs --apply    # actually write
 *
 * GAP MODE fills a window that sits BEFORE existing history instead of
 * topping up after it:
 *
 *   node scripts/simulate-recent-activity.mjs --from 2026-10-01 --to 2026-10-07
 *
 * The seed stops on 30 Sep 2026 at 17:50 Manila and the simulated month opens
 * on 8 Oct, so 1-6 Oct holds nothing but six hand-entered test sales - a
 * visibly short October on the Gross & Net chart, and a demand dip the
 * forecasting models read as real. Gap mode inserts into the middle of the
 * ledger, which makes products.stock_on_hand the binding constraint: it must
 * not move, so the rows added have to net to zero per product. See
 * lib/gapFill.mjs. --to is EXCLUSIVE.
 *
 * Re-runnable: each run fills the gap between the latest sale/service and
 * now, never writes a future timestamp, and appends its inserted id ranges
 * to scripts/simulated-ids.json. Running it again the morning of a demo adds
 * only the days since the last run.
 *
 * The point is that the seam is invisible. Volume, weekday shape, hour of
 * day, lines per sale, quantities, which SKUs move and who recorded them all
 * come from the seed data's own most recent 8 weeks, adjusted by the seed's
 * own Oct-Nov vs Aug-Sep seasonality. Each simulated sale has the same effect
 * confirm_sale() would: a sales row, sale_items rows, products.stock_on_hand
 * decremented, and a sale_decrement movement with the right balance_after.
 *
 * Stock is ordered PROACTIVELY - when a product's projected stock would fall
 * below its reorder point within the delivery lead time, the delivery is
 * placed so it lands before the shelf empties. A stockout is the thing to
 * avoid: it removes demand from the record, and the forecasting models would
 * read the dip as real.
 *
 * Services are labour only. record_service() touches no stock, so neither
 * does this: no stock_movements, no stock_on_hand change.
 *
 * MUST run after scripts/backfill-ledger.mjs --apply: that script anchors
 * every product's ledger on products.stock_on_hand, and this one changes
 * stock_on_hand.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  countRewrittenRows,
  planProductWindow,
  planWindowDeliveries,
  rechainAfterWindow,
  splitAroundWindow,
} from "./lib/gapFill.mjs";
import {
  createServiceClient,
  insertBatched,
  pageAll,
  probePageSize,
  progressDone,
  progressLine,
  WEB_DIR,
} from "./lib/db.mjs";
import {
  addDaysMs,
  deliveryReceipt,
  fmtInt,
  fmtPeso,
  makeRand,
  manilaDateString,
  manilaMidnight,
  manilaParts,
  manilaSameDayAt,
  manilaStamp,
  parseArgs,
  randInt,
  section,
  seedFor,
  table,
  toManilaIso,
  weightedIndex,
} from "./lib/seedlib.mjs";

const SIMULATED_NOTE = "simulated";
const BACKFILL_NOTE = "seed-backfill";
const IDS_FILE = resolve(WEB_DIR, "scripts", "simulated-ids.json");

// Services launched in October 2026 - there is nothing earlier to simulate.
const SERVICES_EPOCH = manilaMidnight("2026-10-06");

// Sale ids at or above this were entered by hand through the app, not
// seeded. They sit outside store hours (00:30-02:09 Manila) and must not be
// allowed to shape the simulation's patterns.
const REAL_APP_SALES_FROM = 156467;

export const BASE_WEEKS = 8; // the window volume and mix are learned from
export const LEAD_MIN_DAYS = 2;
export const LEAD_MAX_DAYS = 5;
export const BUFFER_MIN_DAYS = 3; // stock a delivery carries beyond the lead
export const BUFFER_MAX_DAYS = 5;
// Demand is lumpy - a product selling 0.3/day on average still takes a
// 3-unit order now and then - so the reorder trigger looks further ahead
// than the bare lead time. Without this the projection is right on average
// and late in practice.
export const SAFETY_DAYS = 2;

// Deliveries arrive when the shop opens, not spread through the trading day
// like sales. That is both how it works and what stops a delivery dated
// 4 PM from leaving the morning's sales short of the stock that arrived.
export const DELIVERY_HOUR_MIN = 8;
export const DELIVERY_HOUR_MAX = 10;

// total_amount is drawn inside the range and rounded to the nearest 10 pesos.
// Weights favour the cheap, common jobs. This list is closed: service types
// already in the data that are not on it ("wash", "brake") are test rows and
// are deliberately not reused.
export const SERVICE_TYPES = [
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

// Closed list as well - "tagpe" in the existing data is a test value.
export const BRANDS = [
  { brand: "Yamaha", weight: 10 },
  { brand: "Honda", weight: 9 },
  { brand: "Suzuki", weight: 3 },
  { brand: "Kawasaki", weight: 2 },
];

const args = parseArgs(process.argv.slice(2));

/** --from / --to as Manila midnights. --to is exclusive. */
function gapWindowArgs(argv) {
  const pick = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const from = pick("--from");
  const to = pick("--to");
  if (!from && !to) return null;
  if (!from || !to) throw new Error("gap mode needs both --from and --to (YYYY-MM-DD, --to exclusive)");
  for (const [name, v] of [["--from", from], ["--to", to]]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name} must be YYYY-MM-DD, got "${v}"`);
  }
  const windowStart = manilaMidnight(from);
  const windowEnd = manilaMidnight(to);
  if (windowEnd <= windowStart) throw new Error(`--to (${to}) must be after --from (${from})`);
  return { from, to, windowStart, windowEnd };
}

const gap = gapWindowArgs(process.argv.slice(2));

async function main() {
  const sb = createServiceClient();
  const pageSize = await probePageSize(sb);

  section("Simulate recent activity" + (args.apply ? " -- APPLY" : " -- DRY RUN (no writes)"));
  console.log(`  PostgREST page size in use: ${fmtInt(pageSize)}`);

  const { count: backfilled, error: countError } = await sb
    .from("stock_movements")
    .select("*", { count: "exact", head: true })
    .eq("note", BACKFILL_NOTE);
  if (countError) throw new Error(`could not check for the backfill: ${countError.message}`);
  const backfillApplied = (backfilled ?? 0) > 0;

  // --apply stops here. A dry run prints the whole plan first and only then
  // exits 1, so the plan can be reviewed before the backfill is applied.
  if (!backfillApplied && args.apply) {
    section("PRECONDITION NOT MET - the ledger backfill has not been applied");
    printPreconditionHelp();
    console.log(`\n  --apply REFUSED. Nothing was written.`);
    process.exitCode = 1;
    return;
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

  // Start after the latest of the three: starting merely after the last SALE
  // would interleave simulated movements with existing ones and break the
  // per-product balance chain.
  const anchor = Math.max(lastSale ?? 0, lastMovement ?? 0, lastService ?? 0);
  const now = Date.now();
  const startTs = gap ? gap.windowStart : anchor + 60000;

  console.log(`  latest sale_ts      : ${lastSale ? manilaStamp(lastSale) : "-"}`);
  console.log(`  latest movement_ts  : ${lastMovement ? manilaStamp(lastMovement) : "-"}`);
  console.log(`  latest service_ts   : ${lastService ? manilaStamp(lastService) : "-"}`);
  if (gap) {
    console.log(`  GAP MODE            : ${manilaStamp(gap.windowStart)} .. ${manilaStamp(gap.windowEnd)} (Manila, --to exclusive)`);
  } else {
    console.log(`  simulating          : ${manilaStamp(startTs)} .. ${manilaStamp(now)} (Manila)`);
  }

  if (!gap && startTs > now) {
    section("Nothing to do");
    console.log("  The data already reaches now.");
    return;
  }

  // -------------------------------------------- the 8-week learning base
  progressLine("loading sales...");
  const allSales = await pageAll(
    () =>
      sb
        .from("sales")
        .select("sale_id, sale_ts, user_id, user_role, total_amount, total_cost, note")
        .eq("status", "confirmed")
        .order("sale_id"),
    { pageSize, label: "sales" }
  );
  // The seed, excluding the by-hand app sales and anything a previous run of
  // this script added.
  const seedSales = allSales.filter((s) => s.sale_id < REAL_APP_SALES_FROM && s.note !== SIMULATED_NOTE);
  progressDone(`seed sales: ${fmtInt(seedSales.length)} of ${fmtInt(allSales.length)} confirmed`);

  let lastSeedTs = null;
  for (const s of seedSales) {
    const t = Date.parse(s.sale_ts);
    if (lastSeedTs == null || t > lastSeedTs) lastSeedTs = t;
  }
  if (lastSeedTs == null) throw new Error("no seed sales found to learn from");

  // The base window ends at the last seed sale, NOT today: anchoring it to
  // today would average in the empty gap this script exists to fill and
  // roughly halve the simulated volume.
  const baseEnd = lastSeedTs;
  const baseStart = addDaysMs(baseEnd, -BASE_WEEKS * 7);
  const baseSales = seedSales.filter((s) => {
    const t = Date.parse(s.sale_ts);
    return t >= baseStart && t <= baseEnd;
  });
  if (baseSales.length === 0) throw new Error("the 8-week base window holds no sales");

  const baseIds = new Set(baseSales.map((s) => s.sale_id));
  const lo = baseSales[0].sale_id;
  progressLine("loading the base window's sale_items...");
  const baseItemsRaw = await pageAll(
    () =>
      sb
        .from("sale_items")
        .select("sale_id, product_id, quantity, unit_price, unit_cost")
        .gte("sale_id", lo)
        .order("sale_item_id"),
    { pageSize, label: "sale_items" }
  );
  const baseItems = baseItemsRaw.filter((i) => baseIds.has(i.sale_id));
  progressDone(`base-window sale lines: ${fmtInt(baseItems.length)}`);

  const patterns = learnPatterns({ seedSales, baseSales, baseItems, baseStart, baseEnd });

  // --------------------------------------------------- test-data review
  const existingServices = await pageAll(
    () =>
      sb
        .from("services")
        .select("service_id, service_ts, service_type, customer_vehicle_brand, total_amount")
        .order("service_id"),
    { pageSize, label: "services" }
  );
  const brandedSales = await pageAll(
    () => sb.from("sales").select("sale_id, customer_vehicle_brand").not("customer_vehicle_brand", "is", null).order("sale_id"),
    { pageSize, label: "brands" }
  );
  const allProducts = await pageAll(
    () => sb.from("products").select("product_id, sku, name, is_active, stock_on_hand").order("product_id"),
    { pageSize, label: "all products" }
  );

  printPatterns(patterns);
  printTestData({ existingServices, brandedSales, allProducts, allSales });

  // ------------------------------------------------------------ simulate
  if (gap) {
    // Already-done check first: gap mode has to be re-runnable, and the
    // marker is a simulated sale inside the window.
    const already = allSales.filter(
      (x) => x.note === SIMULATED_NOTE &&
        Date.parse(x.sale_ts) >= gap.windowStart && Date.parse(x.sale_ts) < gap.windowEnd
    );
    if (already.length > 0) {
      section("Already filled - nothing to do");
      console.log(`  ${fmtInt(already.length)} simulated sales already sit inside`);
      console.log(`  ${manilaStamp(gap.windowStart)} .. ${manilaStamp(gap.windowEnd)}.`);
      console.log(`  Gap mode is idempotent: it inserts nothing on a second run.`);
      return;
    }

    progressLine("loading every movement (the chain has to be walked end to end)...");
    const allMovements = await pageAll(
      () =>
        sb
          .from("stock_movements")
          .select("movement_id, product_id, sku, movement_ts, movement_type, quantity, balance_after, note")
          .order("movement_id"),
      { pageSize, label: "movements" }
    );
    progressDone(`movements: ${fmtInt(allMovements.length)}`);

    const movementsByProduct = new Map();
    for (const m of allMovements) {
      if (!movementsByProduct.has(m.product_id)) movementsByProduct.set(m.product_id, []);
      movementsByProduct.get(m.product_id).push({ ...m, movement_ts: Date.parse(m.movement_ts) });
    }

    const gapPlan = planGapFill({
      products,
      patterns,
      movementsByProduct,
      windowStart: gap.windowStart,
      windowEnd: gap.windowEnd,
    });

    printGapPlan({ plan: gapPlan, gap, allSales, allMovements, products, existingServices });

    if (!args.apply) {
      section("Dry run complete - nothing was written");
      console.log("  Re-run with the same --from/--to plus --apply to write these rows.");
      console.log("  --apply re-proves the zero-rewrite precondition against a freshly");
      console.log("  loaded ledger first, and refuses if it no longer holds.");
      return;
    }
    const result = await applyGapPlan(sb, gapPlan, gap, pageSize);
    if (!result.ok) {
      section("Nothing was written");
      process.exitCode = 1;
      return;
    }
    section("Applied");
    console.log(`  sales            : ${fmtInt(result.insertedSales.length)}`);
    console.log(`  sale_items       : ${fmtInt(result.itemsDone)}`);
    console.log(`  sale movements   : ${fmtInt(result.saleMovesDone)}`);
    console.log(`  stock_in         : ${fmtInt(result.restockDone)}`);
    console.log(`  services         : ${fmtInt(result.insertedServices.length)}`);
    console.log("");
    console.log("  Verify with: node scripts/verify-gapfill.mjs");
    return;
  }

  const plan = simulate({ products, patterns, startTs, now });

  printPlan({ plan, patterns, startTs, now, existingServices });

  if (!args.apply) {
    section("Dry run complete - nothing was written");
    if (!backfillApplied) {
      printPreconditionHelp();
      console.log(`\n  Exiting 1: the plan above is valid, but --apply would refuse until the`);
      console.log(`  backfill is in place.`);
      process.exitCode = 1;
      return;
    }
    console.log("  Re-run with --apply to write these rows.");
    console.log("  On --apply the inserted id ranges are appended to scripts/simulated-ids.json.");
    return;
  }

  await applyPlan(sb, plan);
}

function printPreconditionHelp() {
  section("PRECONDITION NOT MET - the ledger backfill has not been applied");
  console.log(
    `  stock_movements holds 0 rows tagged '${BACKFILL_NOTE}'.\n\n` +
      `  Run this first:\n` +
      `      node scripts/backfill-ledger.mjs --apply\n\n` +
      `  Order matters: backfill-ledger anchors every product's ledger on\n` +
      `  products.stock_on_hand, and this script changes stock_on_hand. Run them\n` +
      `  the other way round and the backfill would rebuild six years of history\n` +
      `  against a stock level this script had already moved.`
  );
}

async function latestTs(sb, table_, column) {
  const { data, error } = await sb.from(table_).select(column).order(column, { ascending: false }).limit(1);
  if (error) throw new Error(`reading the latest ${column} failed: ${error.message}`);
  return data?.[0] ? Date.parse(data[0][column]) : null;
}

// ------------------------------------------------------------- patterns

export function learnPatterns({ seedSales, baseSales, baseItems, baseStart, baseEnd }) {
  const perWeekday = Array.from({ length: 7 }, () => ({ sales: 0, days: new Set() }));
  const hourHist = new Array(24).fill(0);
  for (const s of baseSales) {
    const ts = Date.parse(s.sale_ts);
    const p = manilaParts(ts);
    perWeekday[p.weekday].sales += 1;
    perWeekday[p.weekday].days.add(manilaDateString(ts));
    hourHist[p.hour] += 1;
  }
  const salesPerWeekday = perWeekday.map((w) => (w.days.size > 0 ? w.sales / w.days.size : 0));

  const baseDays = new Set(baseSales.map((s) => manilaDateString(Date.parse(s.sale_ts))));
  const baseDailyAvg = baseDays.size > 0 ? baseSales.length / baseDays.size : 0;

  const linesBySale = new Map();
  const qtyHist = new Map();
  const unitsByProduct = new Map();
  let baseRevenue = 0;
  let baseCost = 0;
  for (const it of baseItems) {
    linesBySale.set(it.sale_id, (linesBySale.get(it.sale_id) ?? 0) + 1);
    qtyHist.set(it.quantity, (qtyHist.get(it.quantity) ?? 0) + 1);
    unitsByProduct.set(it.product_id, (unitsByProduct.get(it.product_id) ?? 0) + it.quantity);
    baseRevenue += Number(it.unit_price) * it.quantity;
    baseCost += Number(it.unit_cost) * it.quantity;
  }
  const lineHist = new Map();
  for (const n of linesBySale.values()) lineHist.set(n, (lineHist.get(n) ?? 0) + 1);

  const userHist = new Map();
  for (const s of baseSales) {
    const key = `${s.user_id ?? ""}|${s.user_role}`;
    userHist.set(key, (userHist.get(key) ?? 0) + 1);
  }

  // Daily demand per product over the base window - what proactive ordering
  // projects against.
  const baseSpanDays = Math.max(1, Math.round((baseEnd - baseStart) / 86400000));
  const dailyDemand = new Map();
  for (const [productId, units] of unitsByProduct) dailyDemand.set(productId, units / baseSpanDays);

  // Seasonality from the seed's own history: Oct-Nov against Aug-Sep, per
  // year. The early years are dominated by the shop's growth rather than the
  // season, so only the most recent complete years are averaged.
  const perDay = new Map();
  for (const s of seedSales) {
    const d = manilaDateString(Date.parse(s.sale_ts));
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const years = new Set();
  for (const d of perDay.keys()) years.add(Number(d.slice(0, 4)));
  const seasonRows = [];
  for (const y of [...years].sort()) {
    const rate = (months) => {
      let n = 0;
      let days = 0;
      for (const [d, c] of perDay) {
        const [yy, mm] = d.split("-").map(Number);
        if (yy === y && months.includes(mm)) {
          n += c;
          days += 1;
        }
      }
      return days >= 40 ? n / days : null; // need most of both months
    };
    const augSep = rate([8, 9]);
    const octNov = rate([10, 11]);
    if (augSep && octNov) seasonRows.push({ year: y, augSep, octNov, ratio: octNov / augSep });
  }
  const recent = seasonRows.slice(-3);
  const seasonality = recent.length ? recent.reduce((a, r) => a + r.ratio, 0) / recent.length : 1;

  return {
    salesPerWeekday,
    hourHist,
    lineHist: toWeighted(lineHist),
    qtyHist: toWeighted(qtyHist),
    unitsByProduct,
    dailyDemand,
    users: toWeighted(userHist),
    baseDailyAvg,
    baseDays: baseDays.size,
    baseSales: baseSales.length,
    baseItems: baseItems.length,
    baseStart,
    baseEnd,
    baseMargin: baseRevenue > 0 ? ((baseRevenue - baseCost) / baseRevenue) * 100 : 0,
    baseRevenue,
    seasonality,
    seasonRows,
    seasonYears: recent.map((r) => r.year),
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

/** A time of day drawn from the seed's own Manila hour distribution. */
export function seedHourTs(dayMs, hourHist, rand) {
  const hour = weightedIndex(hourHist, rand);
  return manilaSameDayAt(dayMs, hour, Math.floor(rand() * 60), Math.floor(rand() * 60));
}

/**
 * Should a delivery be ordered today, and how big?
 *
 * Proactive: the question is not "is stock low now" but "will it be below
 * the reorder point by the time a delivery could arrive". Sizing from the
 * product's own demand rate rather than topping up to a fixed ceiling is
 * what keeps total stock near where it started - a ceiling with a floor of
 * ten units would roughly double a catalog whose average product holds six.
 */
export function planDelivery({
  have,
  dailyDemand,
  reorderPoint,
  lead,
  buffer,
  safetyDays = SAFETY_DAYS,
  maxLineQty = 1,
}) {
  if (dailyDemand <= 0) return null;

  // The trigger is deliberately conservative in two ways the mean demand
  // alone does not capture. It assumes the SLOWEST lead time, because the
  // actual one is not known when the order goes in; and it keeps at least
  // one largest-possible sale line in hand on top, because demand arrives
  // in lumps of 1-3 units, not in smooth fractions. Triggering on the mean
  // is right on average and late in practice - that was most of the
  // residual stockouts.
  const cover = dailyDemand * (LEAD_MAX_DAYS + safetyDays);
  const threshold = reorderPoint + Math.max(cover, maxLineQty);
  if (have > threshold) return null;

  // Order small and often rather than in bulk: the trigger above is what
  // prevents the stockout, so the delivery only has to carry the shop to
  // the next one. A big buffer here would just park inventory.
  let qty = Math.max(1, Math.round(dailyDemand * (lead + buffer)));
  const floorQty = Math.ceil(threshold + 1 - have);
  if (floorQty > qty) qty = floorQty;
  return { qty, threshold };
}

// ----------------------------------------------------------- simulation

export function simulate({ products, patterns, startTs, now }) {
  const byId = new Map(products.map((p) => [p.product_id, p]));
  const balance = new Map(products.map((p) => [p.product_id, p.stock_on_hand]));
  const openingTotal = products.reduce((s, p) => s + p.stock_on_hand, 0);
  const openingLowStock = products.filter((p) => p.stock_on_hand <= (p.reorder_point ?? 0)).length;

  const sellable = products.filter((p) => (patterns.dailyDemand.get(p.product_id) ?? 0) > 0);
  const weights = sellable.map((p) => patterns.unitsByProduct.get(p.product_id));
  // The largest quantity a single sale line ever asks for, from the seed's
  // own histogram - the lumpiness the reorder trigger has to absorb.
  const maxLineQty = patterns.qtyHist.keys.length ? Math.max(...patterns.qtyHist.keys) : 1;

  const sales = [];
  const movements = [];
  const services = [];
  const pendingArrival = new Set(); // products with a delivery already on order
  const arrivals = new Map(); // dateString -> [{ productId, qty }]
  const shortfalls = new Map();
  const shortByDay = new Map();
  // Three different outcomes, deliberately counted apart:
  //   trimmed      - the line happened but for fewer units than wanted
  //   lost         - the sale ended with fewer lines than it meant to have
  //   substituted  - an out-of-stock SKU was passed over and another taken,
  //                  so the line and its units survive on a different SKU
  // Only trimmed and lost remove demand from the record; a substitution
  // moves it. Counting substitutions as lost lines overstated the damage.
  let trimmedLines = 0;
  let lostLines = 0;
  let substitutions = 0;
  let restockCount = 0;

  const rand = makeRand(seedFor("simulate", 3));

  const firstDay = manilaMidnight(manilaDateString(startTs));
  const lastDay = manilaMidnight(manilaDateString(now));

  for (let day = firstDay; day <= lastDay; day = addDaysMs(day, 1)) {
    const dateKey = manilaDateString(day);
    const weekday = manilaParts(day).weekday;

    // --------------------------------------------- proactive ordering
    const openingWave = day === firstDay;
    for (const product of sellable) {
      if (pendingArrival.has(product.product_id)) continue;
      // 133 products stand at zero stock at the seam. Making them wait a
      // full lead time would open the window with a wave of stockouts that
      // never happened - in reality the shop already has those orders in
      // flight. The first day's deliveries therefore land in 1-2 days.
      const lead = openingWave
        ? randInt(rand, 1, 2)
        : randInt(rand, LEAD_MIN_DAYS, LEAD_MAX_DAYS);
      const order = planDelivery({
        have: balance.get(product.product_id) ?? 0,
        dailyDemand: patterns.dailyDemand.get(product.product_id) ?? 0,
        reorderPoint: product.reorder_point ?? 0,
        lead,
        buffer: randInt(rand, BUFFER_MIN_DAYS, BUFFER_MAX_DAYS),
        maxLineQty,
      });
      if (!order) continue;

      // Clamped to the last day rather than dropped. Refusing to deliver in
      // the final few days produced a cliff of stockouts right at "now" that
      // was an artifact of the window ending, not of the shop running dry.
      const arrivalDay = Math.min(addDaysMs(day, lead), lastDay);
      const key = manilaDateString(arrivalDay);
      if (!arrivals.has(key)) arrivals.set(key, []);
      arrivals.get(key).push({ productId: product.product_id, qty: order.qty, opening: openingWave });
      pendingArrival.add(product.product_id);
    }

    const dayEvents = [];

    for (const due of arrivals.get(dateKey) ?? []) {
      // The opening wave lands exactly at opening time, ahead of that day's
      // first sale: those products start the window empty, and letting a
      // 10 AM delivery trail the 8 AM sales would invent a stockout.
      const ts = due.opening
        ? manilaSameDayAt(day, DELIVERY_HOUR_MIN, 0, 0)
        : manilaSameDayAt(day, randInt(rand, DELIVERY_HOUR_MIN, DELIVERY_HOUR_MAX), Math.floor(rand() * 60), 0);
      dayEvents.push({ type: "restock", ts, ...due });
      pendingArrival.delete(due.productId);
    }
    arrivals.delete(dateKey);

    // Volume: the base window's rate for this weekday, nudged by the seed's
    // own Oct-Nov seasonality, with a little day-to-day noise.
    const mean = (patterns.salesPerWeekday[weekday] ?? 0) * patterns.seasonality;
    const count = Math.max(0, Math.round(mean * (0.9 + 0.2 * rand())));
    for (let i = 0; i < count; i++) {
      dayEvents.push({ type: "sale", ts: seedHourTs(day, patterns.hourHist, rand) });
    }

    if (day >= SERVICES_EPOCH) {
      const serviceCount = weekday === 0 ? randInt(rand, 1, 3) : randInt(rand, 4, 8);
      for (let i = 0; i < serviceCount; i++) {
        dayEvents.push({ type: "service", ts: seedHourTs(day, patterns.hourHist, rand) });
      }
    }

    // Time order, so every product's balances chain the way the ledger reads
    // them. Anything outside the window is dropped - never a future row.
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
        const pick = SERVICE_TYPES[weightedIndex(SERVICE_TYPES.map((t) => t.weight), rand)];
        const amount = Math.max(10, Math.round((pick.min + rand() * (pick.max - pick.min)) / 10) * 10);
        const brand = BRANDS[weightedIndex(BRANDS.map((b) => b.weight), rand)].brand;
        const [userId, userRole] = splitUser(pickWeighted(patterns.users, rand, "|staff"));
        services.push({
          service_ts: toManilaIso(ev.ts),
          user_id: userId,
          user_role: userRole,
          service_type: pick.type,
          total_amount: amount,
          status: "confirmed",
          // No invented personal data - only the vehicle brand is set.
          customer_name: null,
          customer_contact: null,
          customer_address: null,
          customer_vehicle_brand: brand,
          __ts: ev.ts,
        });
        continue;
      }

      // ---------------------------------------------------------- sale
      const nLines = Math.min(6, Math.max(1, pickWeighted(patterns.lineHist, rand, 1)));
      const chosen = new Set();
      const lines = [];
      let revenue = 0;
      let cost = 0;

      for (let attempt = 0; attempt < nLines * 5 && lines.length < nLines; attempt++) {
        if (sellable.length === 0) break;
        const product = sellable[weightedIndex(weights, rand)];
        if (chosen.has(product.product_id)) continue;

        const have = balance.get(product.product_id) ?? 0;
        if (have <= 0) {
          // Out of stock: the line cannot happen. Counted, and another SKU
          // is tried so the sale itself still goes through.
          bump(shortfalls, product.sku);
          bump(shortByDay, dateKey);
          substitutions += 1;
          continue;
        }
        chosen.add(product.product_id);

        const wanted = Math.max(1, pickWeighted(patterns.qtyHist, rand, 1));
        const qty = Math.min(wanted, have);
        if (qty < wanted) {
          bump(shortfalls, product.sku);
          bump(shortByDay, dateKey);
          trimmedLines += 1;
        }

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
      }

      lostLines += Math.max(0, nLines - lines.length);
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

  const closingTotal = [...balance.values()].reduce((s, v) => s + v, 0);
  const closingLowStock = products.filter((p) => (balance.get(p.product_id) ?? 0) <= (p.reorder_point ?? 0)).length;
  const saleLines = sales.reduce((n, s) => n + s.lines.length, 0);

  return {
    sales,
    movements,
    services,
    restockCount,
    shortfalls,
    shortByDay,
    trimmedLines,
    lostLines,
    substitutions,
    saleLines,
    openingTotal,
    closingTotal,
    openingLowStock,
    closingLowStock,
    productCount: products.length,
    balance,
    byId,
    unitsSold: sales.reduce((s, x) => s + x.lines.reduce((t, l) => t + l.quantity, 0), 0),
    unitsIn: movements.reduce((s, m) => s + m.quantity, 0),
    salesRevenue: sales.reduce((s, x) => round2(s + x.sale.total_amount), 0),
    salesCost: sales.reduce((s, x) => round2(s + x.sale.total_cost), 0),
    servicesRevenue: services.reduce((s, x) => round2(s + x.total_amount), 0),
    days: new Set(sales.map((s) => manilaDateString(s.__ts))).size,
  };
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

// --------------------------------------------------------------- output

function printPatterns(p) {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  section(`Patterns learned from the seed's last ${BASE_WEEKS} weeks`);
  console.log(
    `  Base window : ${manilaDateString(p.baseStart)} .. ${manilaDateString(p.baseEnd)}` +
      ` (ends at the last seed sale, not today)\n` +
      `  Sales       : ${fmtInt(p.baseSales)} over ${fmtInt(p.baseDays)} trading days = ${p.baseDailyAvg.toFixed(1)}/day\n` +
      `  Sale lines  : ${fmtInt(p.baseItems)}\n` +
      `  Gross margin: ${p.baseMargin.toFixed(2)}% (from the base window's own sale_items prices)`
  );

  console.log("\n  Sales per weekday:");
  table(
    p.salesPerWeekday.map((v, i) => ({ d: DAYS[i], v, adj: v * p.seasonality })),
    [
      { label: "Weekday", get: (r) => r.d },
      { label: "Seed /day", right: true, get: (r) => r.v.toFixed(1) },
      { label: "x seasonality", right: true, get: (r) => r.adj.toFixed(1) },
    ]
  );

  console.log(`\n  Seasonality (Oct-Nov vs Aug-Sep, from the seed's own history):`);
  table(p.seasonRows, [
    { label: "Year", get: (r) => r.year },
    { label: "Aug-Sep /day", right: true, get: (r) => r.augSep.toFixed(1) },
    { label: "Oct-Nov /day", right: true, get: (r) => r.octNov.toFixed(1) },
    { label: "Ratio", right: true, get: (r) => r.ratio.toFixed(3) },
  ]);
  console.log(
    `  Factor applied: ${p.seasonality.toFixed(3)} (mean of ${p.seasonYears.join(", ")}; earlier\n` +
      `  years are dominated by the shop's growth rather than the season)`
  );

  console.log("\n  Hour of day (Manila) the simulation draws from:");
  const total = p.hourHist.reduce((a, b) => a + b, 0) || 1;
  let max = 0;
  for (const v of p.hourHist) if (v > max) max = v;
  for (let h = 0; h < 24; h++) {
    if (p.hourHist[h] === 0) continue;
    console.log(
      `    ${String(h).padStart(2, "0")}:00  ${String(p.hourHist[h]).padStart(5)}  ` +
        `${((p.hourHist[h] / total) * 100).toFixed(1).padStart(5)}%  ${"#".repeat(Math.round((p.hourHist[h] / max) * 30))}`
    );
  }

  console.log("\n  Lines per sale:");
  table(
    p.lineHist.keys.map((k, i) => ({ k, w: p.lineHist.weights[i] })).sort((a, b) => a.k - b.k),
    [
      { label: "Lines", right: true, get: (r) => r.k },
      { label: "Sales", right: true, get: (r) => fmtInt(r.w) },
    ]
  );
  console.log(`\n  SKUs with demand in the base window: ${fmtInt(p.unitsByProduct.size)}`);
  console.log("  Recorder mix (simulated rows use the same proportions):");
  table(
    p.users.keys.map((k, i) => ({ k, w: p.users.weights[i] })).sort((a, b) => b.w - a.w),
    [
      { label: "user_id|role", get: (r) => r.k.replace(/^([0-9a-f]{8})[^|]*/, "$1...") },
      { label: "Sales", right: true, get: (r) => fmtInt(r.w) },
    ]
  );
}

function printTestData({ existingServices, brandedSales, allProducts, allSales }) {
  section("Existing rows that look like test data (reported only - nothing is changed)");
  const approvedTypes = new Set(SERVICE_TYPES.map((t) => t.type.toLowerCase()));
  const approvedBrands = new Set(BRANDS.map((b) => b.brand.toLowerCase()));

  const rows = [];
  for (const p of allProducts) {
    if (!/^J1-\d{4}$/i.test(p.sku)) {
      rows.push({
        what: "products",
        id: `product_id ${p.product_id}`,
        detail: `SKU "${p.sku}" (${p.name}) - not the J1-#### pattern; is_active=${p.is_active}, stock ${p.stock_on_hand}`,
      });
    }
  }
  for (const s of existingServices) {
    if (!approvedTypes.has((s.service_type ?? "").toLowerCase())) {
      rows.push({
        what: "services",
        id: `service_id ${s.service_id}`,
        detail: `service_type "${s.service_type}" at ${fmtPeso(s.total_amount)} - not on the agreed list`,
      });
    }
    if (s.customer_vehicle_brand && !approvedBrands.has(s.customer_vehicle_brand.toLowerCase())) {
      rows.push({
        what: "services",
        id: `service_id ${s.service_id}`,
        detail: `customer_vehicle_brand "${s.customer_vehicle_brand}" - not a real vehicle brand`,
      });
    }
  }
  const badBrandSales = brandedSales.filter(
    (s) => s.customer_vehicle_brand && !approvedBrands.has(s.customer_vehicle_brand.toLowerCase())
  );
  for (const s of badBrandSales.slice(0, 10)) {
    rows.push({
      what: "sales",
      id: `sale_id ${s.sale_id}`,
      detail: `customer_vehicle_brand "${s.customer_vehicle_brand}" - not a real vehicle brand`,
    });
  }
  const handMade = allSales.filter((s) => s.sale_id >= REAL_APP_SALES_FROM && s.note !== SIMULATED_NOTE);
  if (handMade.length) {
    rows.push({
      what: "sales",
      id: `sale_id ${handMade[0].sale_id}..${handMade.at(-1).sale_id}`,
      detail: `${handMade.length} sales entered by hand through the app, outside store hours - excluded from the patterns above`,
    });
  }

  if (rows.length === 0) {
    console.log("  None found.");
  } else {
    table(rows, [
      { label: "Table", get: (r) => r.what },
      { label: "Row", get: (r) => r.id },
      { label: "Why it looks like test data", get: (r) => r.detail },
    ]);
    if (badBrandSales.length > 10) {
      console.log(`  ... and ${fmtInt(badBrandSales.length - 10)} more sales with an unrecognised brand`);
    }
    console.log(
      `\n  None of these are reused by the simulation: brands come from a closed list\n` +
        `  (${BRANDS.map((b) => b.brand).join(", ")}) and service types from the agreed list only.\n` +
        `  Nothing here is changed or deleted - they are yours to clean up or keep.`
    );
  }
}

function printPlan({ plan, patterns, startTs, now, existingServices }) {
  const touched = new Set();
  for (const s of plan.sales) for (const l of s.lines) touched.add(l.product_id);
  for (const m of plan.movements) touched.add(m.product_id);

  section("Rows that would be written");
  table(
    [
      { t: "sales (insert)", n: plan.sales.length },
      { t: "sale_items (insert)", n: plan.saleLines },
      { t: "services (insert)", n: plan.services.length },
      { t: "stock_movements (insert) - sale_decrement", n: plan.saleLines },
      { t: "stock_movements (insert) - stock_in deliveries", n: plan.movements.length },
      { t: "stock_movements (insert) - TOTAL", n: plan.saleLines + plan.movements.length },
      { t: "products (update stock_on_hand)", n: touched.size },
    ],
    [
      { label: "Table / operation", get: (r) => r.t },
      { label: "Rows", right: true, get: (r) => fmtInt(r.n) },
    ]
  );
  console.log(`\n  Date range covered: ${manilaStamp(startTs)}  ->  ${manilaStamp(now)} (Manila)`);
  console.log(`  Simulated deliveries: ${fmtInt(plan.restockCount)}`);
  console.log(
    `  Substitutions: ${fmtInt(plan.substitutions)} - an out-of-stock SKU was passed over and
` +
      `  another taken, so the line and its units survive on a different SKU. Not
` +
      `  counted as a stockout, but it does move demand between SKUs.`
  );
  console.log(`  Services are labour only: no stock_movements, no stock change.`);

  // ------------------------------------------------------------ goals
  section("Goals");
  const simDaily = plan.days > 0 ? plan.sales.length / plan.days : 0;
  const dailyGap = patterns.baseDailyAvg > 0 ? ((simDaily - patterns.baseDailyAvg) / patterns.baseDailyAvg) * 100 : 0;
  const intended = plan.saleLines + plan.lostLines;
  const stockoutRate = intended > 0 ? ((plan.trimmedLines + plan.lostLines) / intended) * 100 : 0;
  const stockGap = plan.openingTotal > 0 ? ((plan.closingTotal - plan.openingTotal) / plan.openingTotal) * 100 : 0;
  const openShare = (plan.openingLowStock / plan.productCount) * 100;
  const closeShare = (plan.closingLowStock / plan.productCount) * 100;
  const simMargin = plan.salesRevenue > 0 ? ((plan.salesRevenue - plan.salesCost) / plan.salesRevenue) * 100 : 0;
  const marginGap = simMargin - patterns.baseMargin;

  const goals = [
    {
      g: "Daily sales within ~10% of the seed's last 8 weeks",
      got: `${simDaily.toFixed(1)}/day vs ${patterns.baseDailyAvg.toFixed(1)}/day (${dailyGap >= 0 ? "+" : ""}${dailyGap.toFixed(1)}%)`,
      ok: Math.abs(dailyGap) <= 10,
    },
    {
      g: "Stockout-trimmed or lost lines below 2%",
      got: `${stockoutRate.toFixed(2)}% (${fmtInt(plan.trimmedLines)} trimmed + ${fmtInt(plan.lostLines)} lost of ${fmtInt(intended)} intended)`,
      ok: stockoutRate < 2,
    },
    {
      g: "Ending total units within +/-10% of today",
      got: `${fmtInt(plan.closingTotal)} vs ${fmtInt(plan.openingTotal)} (${stockGap >= 0 ? "+" : ""}${stockGap.toFixed(1)}%)`,
      ok: Math.abs(stockGap) <= 10,
    },
    {
      g: "Share at/below reorder point within +/-10pp",
      got: `${closeShare.toFixed(1)}% vs ${openShare.toFixed(1)}% (${closeShare - openShare >= 0 ? "+" : ""}${(closeShare - openShare).toFixed(1)}pp)`,
      ok: Math.abs(closeShare - openShare) <= 10,
    },
    {
      g: "Gross margin within 2pp of the seed's last 8 weeks",
      got: `${simMargin.toFixed(2)}% vs ${patterns.baseMargin.toFixed(2)}% (${marginGap >= 0 ? "+" : ""}${marginGap.toFixed(2)}pp)`,
      ok: Math.abs(marginGap) <= 2,
    },
  ];
  table(goals, [
    { label: "", get: (r) => (r.ok ? "OK  " : "MISS") },
    { label: "Goal", get: (r) => r.g },
    { label: "Result", get: (r) => r.got },
  ]);

  if (Math.abs(marginGap) > 2) {
    console.log(
      `\n  Margin gap explained: simulated lines are priced from the CURRENT\n` +
        `  products.unit_price / unit_cost, while the seed figure above comes from the\n` +
        `  unit_price / unit_cost captured on its own sale_items rows. This script never\n` +
        `  changes prices or costs, so a gap here means the catalog has moved since\n` +
        `  those sales were recorded.`
    );
  }
  const missed = goals.filter((g) => !g.ok);
  if (missed.length > 0) {
    console.log(
      `\n  ${missed.length} goal(s) missed. The low stockout rate is prioritised, as\n` +
        `  instructed: a stockout removes demand from the record and the forecasting\n` +
        `  models would read the dip as real. Stock level and low-stock share are what\n` +
        `  give way, because keeping shelves stocked necessarily holds more inventory\n` +
        `  than today's near-empty state.`
    );
  }

  section("Before / after");
  table(
    [
      { k: "Total units in stock (active)", b: fmtInt(plan.openingTotal), a: fmtInt(plan.closingTotal) },
      { k: "  units sold by simulated sales", b: "-", a: `-${fmtInt(plan.unitsSold)}` },
      { k: "  units received by simulated deliveries", b: "-", a: `+${fmtInt(plan.unitsIn)}` },
      {
        k: "Products at/below reorder point",
        b: `${fmtInt(plan.openingLowStock)} (${openShare.toFixed(1)}%)`,
        a: `${fmtInt(plan.closingLowStock)} (${closeShare.toFixed(1)}%)`,
      },
      { k: "Products touched", b: "-", a: fmtInt(touched.size) },
    ],
    [
      { label: "Measure", get: (r) => r.k },
      { label: "Before", right: true, get: (r) => r.b },
      { label: "After", right: true, get: (r) => r.a },
    ]
  );
  const expected = plan.openingTotal - plan.unitsSold + plan.unitsIn;
  console.log(
    `\n  ${expected === plan.closingTotal ? "OK" : "MISMATCH"}: ${fmtInt(plan.openingTotal)} - ` +
      `${fmtInt(plan.unitsSold)} + ${fmtInt(plan.unitsIn)} = ${fmtInt(expected)}`
  );

  section("Revenue for the simulated window");
  table(
    [
      { k: "Parts sales revenue (gross)", v: fmtPeso(plan.salesRevenue) },
      { k: "Parts sales cost", v: fmtPeso(plan.salesCost) },
      { k: "Parts sales net", v: fmtPeso(round2(plan.salesRevenue - plan.salesCost)) },
      { k: "Services revenue (gross = net, no cost)", v: fmtPeso(plan.servicesRevenue) },
      { k: "Combined gross", v: fmtPeso(round2(plan.salesRevenue + plan.servicesRevenue)) },
      { k: "Seed daily gross (base window)", v: fmtPeso(round2(patterns.baseRevenue / Math.max(1, patterns.baseDays))) },
      { k: "Simulated daily gross", v: fmtPeso(round2(plan.salesRevenue / Math.max(1, plan.days))) },
    ],
    [
      { label: "Measure", get: (r) => r.k },
      { label: "Amount", right: true, get: (r) => r.v },
    ]
  );

  section("Products that still ran short");
  if (plan.shortfalls.size === 0) {
    console.log("  None - every simulated line was filled from stock on hand.");
  } else {
    console.log(
      `  ${fmtInt(plan.shortfalls.size)} product(s). A line was trimmed to the units actually\n` +
        `  on hand, or skipped and another SKU tried; stock never goes negative.\n`
    );
    table(
      [...plan.shortfalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([sku, n]) => ({ sku, n })),
      [
        { label: "SKU", get: (r) => r.sku },
        { label: "Times short", right: true, get: (r) => fmtInt(r.n) },
      ]
    );
    if (plan.shortfalls.size > 15) console.log(`  ... and ${fmtInt(plan.shortfalls.size - 15)} more`);
  }

  section("Simulated id ranges");
  console.log(
    `  sales    : ${fmtInt(plan.sales.length)} rows, note = 'simulated'\n` +
      `  services : ${fmtInt(plan.services.length)} rows - no note column, so the service_id\n` +
      `             range is the only handle. Existing services: ${existingServices.map((s) => s.service_id).join(", ") || "none"}\n` +
      `  Real ids are only known once inserted, so --apply appends them to\n` +
      `  scripts/simulated-ids.json as a new entry in its "runs" array.`
  );

  printSampleLedgers(plan);
  printSampleServices(plan);
}

function printSampleLedgers(plan) {
  const perProduct = new Map();
  const push = (pid, row) => {
    if (!perProduct.has(pid)) perProduct.set(pid, []);
    perProduct.get(pid).push(row);
  };
  for (const s of plan.sales) {
    for (const l of s.lines) {
      push(l.product_id, { ts: s.__ts, quantity: -l.quantity, balance_after: l.__balanceAfter, what: "Sold - simulated sale" });
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

  const fast = ranked[0];
  const slow = ranked[ranked.length - 1];
  const shown = new Set([fast?.pid, slow?.pid]);
  const delivered = ranked.find((r) => !shown.has(r.pid) && r.rows.some((x) => x.quantity > 0));
  const picks = [
    ["Fast-moving", fast],
    ["Slow-moving", slow],
    ["With a simulated delivery", delivered],
  ].filter(([, r]) => r);

  for (const [label, entry] of picks) {
    const product = plan.byId.get(entry.pid);
    section(`Sample simulated ledger - ${label}: ${product.sku}`);
    let lowest = Infinity;
    for (const r of entry.rows) if (r.balance_after < lowest) lowest = r.balance_after;
    console.log(
      `  ${product.name}\n  stock ${fmtInt(product.stock_on_hand)} -> ${fmtInt(plan.balance.get(entry.pid))}` +
        ` | reorder point ${fmtInt(product.reorder_point)} | lowest balance ${fmtInt(lowest)}` +
        ` | ${fmtInt(entry.rows.length)} new rows`
    );
    const render = (list) =>
      table(list, [
        { label: "When (Manila)", get: (r) => manilaStamp(r.ts) },
        { label: "Particulars", get: (r) => r.what },
        { label: "IN", right: true, get: (r) => (r.quantity > 0 ? fmtInt(r.quantity) : "") },
        { label: "OUT", right: true, get: (r) => (r.quantity < 0 ? fmtInt(-r.quantity) : "") },
        { label: "Balance", right: true, get: (r) => fmtInt(r.balance_after) },
      ]);
    console.log("\n  First 5:");
    render(entry.rows.slice(0, 5));
    if (entry.rows.length > 15) console.log(`\n  ... ${fmtInt(entry.rows.length - 15)} rows omitted ...`);
    console.log(`\n  Last ${Math.min(10, Math.max(0, entry.rows.length - 5))}:`);
    render(entry.rows.slice(Math.max(5, entry.rows.length - 10)));
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

// ------------------------------------------------------------- gap mode
//
// --from / --to turn this into a BACKFILL of a window that sits before
// existing history, rather than a top-up after it. See lib/gapFill.mjs for
// why the rows it adds must net to zero per product.

export function planGapFill({ products, patterns, movementsByProduct, windowStart, windowEnd }) {
  const byId = new Map(products.map((p) => [p.product_id, p]));
  const sellable = products.filter((p) => (patterns.dailyDemand.get(p.product_id) ?? 0) > 0);
  const weights = sellable.map((p) => patterns.unitsByProduct.get(p.product_id));

  // Each product's ledger split around the window, and the balance the
  // window opens on.
  const split = new Map();
  for (const p of products) {
    const mine = movementsByProduct.get(p.product_id) ?? [];
    const s = splitAroundWindow(mine, windowStart, windowEnd);
    if (s.openingBalance == null) s.openingBalance = p.stock_on_hand;
    split.set(p.product_id, s);
  }

  // ---------------------------------------------------------- phase 1
  // The sales and services the window should hold, from the same learned
  // patterns the main simulation uses. Stock is NOT a constraint here:
  // phase 2 derives deliveries from whatever this sells, so there is
  // nothing to run out of. That is the point of the window - the dip it
  // currently shows is an artifact, not a shortage.
  const rand = makeRand(seedFor("gapfill", 7));
  const sales = [];
  const services = [];
  const firstDay = manilaMidnight(manilaDateString(windowStart));
  const lastDay = manilaMidnight(manilaDateString(windowEnd - 1));

  for (let day = firstDay; day <= lastDay; day = addDaysMs(day, 1)) {
    const weekday = manilaParts(day).weekday;
    const events = [];

    const mean = (patterns.salesPerWeekday[weekday] ?? 0) * patterns.seasonality;
    const count = Math.max(0, Math.round(mean * (0.9 + 0.2 * rand())));
    for (let i = 0; i < count; i++) {
      events.push({ type: "sale", ts: seedHourTs(day, patterns.hourHist, rand) });
    }
    // Services only from the date the services table itself begins - before
    // that the shop has no service records at all, and inventing them here
    // would put rows before the first real one.
    if (day >= SERVICES_EPOCH) {
      const serviceCount = weekday === 0 ? randInt(rand, 1, 3) : randInt(rand, 4, 8);
      for (let i = 0; i < serviceCount; i++) {
        events.push({ type: "service", ts: seedHourTs(day, patterns.hourHist, rand) });
      }
    }
    events.sort((a, b) => a.ts - b.ts);

    for (const ev of events) {
      if (ev.ts < windowStart || ev.ts >= windowEnd) continue;

      if (ev.type === "service") {
        const pick = SERVICE_TYPES[weightedIndex(SERVICE_TYPES.map((t) => t.weight), rand)];
        const amount = Math.max(10, Math.round((pick.min + rand() * (pick.max - pick.min)) / 10) * 10);
        const brand = BRANDS[weightedIndex(BRANDS.map((b) => b.weight), rand)].brand;
        const [userId, userRole] = splitUser(pickWeighted(patterns.users, rand, "|staff"));
        services.push({
          service_ts: toManilaIso(ev.ts),
          user_id: userId,
          user_role: userRole,
          service_type: pick.type,
          total_amount: amount,
          status: "confirmed",
          customer_name: null,
          customer_contact: null,
          customer_address: null,
          customer_vehicle_brand: brand,
          __ts: ev.ts,
        });
        continue;
      }

      const nLines = Math.min(6, Math.max(1, pickWeighted(patterns.lineHist, rand, 1)));
      const chosen = new Set();
      const lines = [];
      let revenue = 0;
      let cost = 0;

      for (let attempt = 0; attempt < nLines * 5 && lines.length < nLines; attempt++) {
        if (sellable.length === 0) break;
        const product = sellable[weightedIndex(weights, rand)];
        if (chosen.has(product.product_id)) continue;
        chosen.add(product.product_id);

        const qty = Math.max(1, pickWeighted(patterns.qtyHist, rand, 1));
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
        });
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

  // ---------------------------------------------------------- phase 2
  // Deliveries per product, derived from what phase 1 sells, so the added
  // rows cancel out exactly.
  const demandByProduct = new Map();
  for (const s of sales) {
    for (const l of s.lines) {
      if (!demandByProduct.has(l.product_id)) demandByProduct.set(l.product_id, []);
      demandByProduct.get(l.product_id).push({ ts: s.__ts, qty: l.quantity });
    }
  }

  const restocks = [];
  for (const [productId, demand] of demandByProduct) {
    const product = byId.get(productId);
    const s = split.get(productId);
    demand.sort((a, b) => a.ts - b.ts);

    // A delivery lands at opening time on the day it is needed, ahead of
    // that day's first sale - a 10 AM delivery trailing an 8 AM sale would
    // invent a stockout that the chain then has to absorb.
    const deliveries = planWindowDeliveries({
      opening: s.openingBalance,
      demand,
      deliveryTs: (ts) => manilaSameDayAt(manilaMidnight(manilaDateString(ts)), DELIVERY_HOUR_MIN, 0, 0),
      openingTs: manilaSameDayAt(firstDay, DELIVERY_HOUR_MIN, 0, 0),
    });

    for (const d of deliveries) {
      const row = {
        product_id: productId,
        sku: product.sku,
        movement_type: "stock_in",
        quantity: d.qty,
        balance_after: null, // filled in by the rechain below
        user_id: null,
        reference: deliveryReceipt(d.ts),
        note: SIMULATED_NOTE,
        movement_ts: toManilaIso(d.ts),
        supplier: product.supplier ?? null,
        unit_cost: product.unit_cost ?? null,
        __ts: d.ts,
      };
      // The row carries a reference to itself, so the rechain writes the
      // balance back by identity. Matching on (ts, quantity) instead left
      // same-instant rows indistinguishable, and one of them kept a null
      // balance_after all the way to the NOT NULL column.
      row.__target = row;
      restocks.push(row);
    }
  }

  // ---------------------------------------------------------- phase 3
  // Rechain every touched product's in-window rows, and check the two
  // invariants per product before anything is reported as appliable.
  const saleMovements = [];
  for (const s of sales) {
    for (const l of s.lines) {
      saleMovements.push({
        product_id: l.product_id,
        sku: l.sku,
        movement_type: "sale_decrement",
        quantity: -l.quantity,
        user_id: s.sale.user_id,
        note: SIMULATED_NOTE,
        movement_ts: s.sale.sale_ts,
        supplier: null,
        unit_cost: null,
        __ts: s.__ts,
        // The line the balance belongs on; applyGapPlan reads it from there.
        __line: l,
      });
    }
  }

  const newByProduct = new Map();
  for (const m of [...restocks, ...saleMovements]) {
    if (!newByProduct.has(m.product_id)) newByProduct.set(m.product_id, []);
    newByProduct.get(m.product_id).push(m);
  }

  const updates = [];        // existing rows whose balance_after changes
  const afterUpdates = [];   // rows after the window - must stay empty
  const problems = [];
  let minBalanceSeen = Infinity;
  const perProduct = [];

  for (const [productId, newRows] of newByProduct) {
    const s = split.get(productId);
    const rows = newRows.map((m) => ({ ...m, movement_ts: m.__ts }));
    const existingInside = s.inside.map((m) => ({ ...m }));

    const plan = planProductWindow({ opening: s.openingBalance, existingInside, newRows: rows });
    if (!plan.ok) problems.push(`${byId.get(productId).sku}: ${plan.problems.join("; ")}`);
    minBalanceSeen = Math.min(minBalanceSeen, plan.minBalance);

    // Carry the recomputed balances back onto the rows that will be written,
    // by identity rather than by value.
    for (const r of plan.rows) {
      if (r.movement_id == null) {
        if (r.__line) r.__line.__balanceAfter = r.balance_after;
        else if (r.__target) r.__target.balance_after = r.balance_after;
        else throw new Error(`a new row for ${byId.get(productId).sku} has nowhere to put its balance`);
      } else if (r.balance_after !== r.previousBalanceAfter) {
        updates.push({
          movement_id: r.movement_id,
          sku: byId.get(productId).sku,
          movement_ts: r.movement_ts,
          quantity: r.quantity,
          previousBalanceAfter: r.previousBalanceAfter,
          balance_after: r.balance_after,
        });
      }
    }

    const openingOfAfter = s.inside.length
      ? s.inside[s.inside.length - 1].balance_after
      : s.openingBalance;
    afterUpdates.push(...rechainAfterWindow({ closing: plan.closing, openingOfAfter, after: s.after }));

    perProduct.push({
      productId,
      sku: byId.get(productId).sku,
      opening: s.openingBalance,
      closing: plan.closing,
      minBalance: plan.minBalance,
      drift: plan.drift,
      sold: (demandByProduct.get(productId) ?? []).reduce((t, d) => t + d.qty, 0),
      delivered: restocks.filter((r) => r.product_id === productId).reduce((t, r) => t + r.quantity, 0),
      rows: plan.rows,
    });
  }

  if (afterUpdates.length > 0) {
    problems.push(`${afterUpdates.length} rows AFTER the window would need rewriting - the added rows do not cancel out`);
  }

  return {
    mode: "gap",
    windowStart,
    windowEnd,
    sales,
    services,
    movements: restocks,
    saleMovements,
    updates,
    afterUpdates,
    perProduct,
    problems,
    minBalanceSeen: minBalanceSeen === Infinity ? null : minBalanceSeen,
    productsTouched: newByProduct.size,
    restockCount: restocks.length,
    saleLines: sales.reduce((n, s) => n + s.lines.length, 0),
    unitsSold: sales.reduce((n, s) => n + s.lines.reduce((t, l) => t + l.quantity, 0), 0),
    unitsIn: restocks.reduce((n, r) => n + r.quantity, 0),
    salesRevenue: sales.reduce((n, s) => round2(n + s.sale.total_amount), 0),
    salesCost: sales.reduce((n, s) => round2(n + s.sale.total_cost), 0),
    servicesRevenue: services.reduce((n, s) => round2(n + s.total_amount), 0),
  };
}

function printGapPlan({ plan, gap, allSales, allMovements, products, existingServices }) {
  const { windowStart, windowEnd } = plan;
  // table() wants { label, get } columns; these rows are plain arrays.
  const cols = (...labels) => labels.map((label, i) => ({ label, get: (r) => r[i] }));

  // ------------------------------------------------------ what goes in
  section("Rows that would be INSERTED");
  table(
    [
      ["sales", fmtInt(plan.sales.length)],
      ["sale_items", fmtInt(plan.saleLines)],
      ["stock_movements (sale_decrement)", fmtInt(plan.saleMovements.length)],
      ["stock_movements (stock_in)", fmtInt(plan.movements.length)],
      ["services", fmtInt(plan.services.length)],
    ],
    cols("table", "rows")
  );
  console.log(`  products touched    : ${fmtInt(plan.productsTouched)} of ${fmtInt(products.length)} active`);
  console.log(`  units sold / in     : ${fmtInt(plan.unitsSold)} / ${fmtInt(plan.unitsIn)} (equal by construction)`);
  console.log(`  revenue             : ${fmtPeso(plan.salesRevenue)} sales + ${fmtPeso(plan.servicesRevenue)} services`);

  // --------------------------------------------- rows that get rewritten
  section("Existing rows whose balance_after would CHANGE");
  const insideTotal = plan.perProduct.reduce((n, p) => n + p.rows.filter((r) => r.movement_id != null).length, 0);
  console.log(`  existing rows inside the window, on products this plan touches : ${fmtInt(insideTotal)}`);
  console.log(`  of those, rows whose balance_after would change               : ${fmtInt(plan.updates.length)}`);
  console.log(`  rows AFTER the window needing a rewrite                       : ${fmtInt(plan.afterUpdates.length)}  <- must be 0`);
  if (plan.updates.length === 0) {
    console.log("");
    console.log("  None - and that is a result, not an oversight. Every existing row inside");
    console.log("  this window sits OUTSIDE 08:00-18:00: the six test sales ran 00:30-02:09");
    console.log("  and the hand-entered stock-ins 19:48-20:27, while every row this plan adds");
    console.log("  falls inside trading hours. So each existing row has either all of its");
    console.log("  product's added rows before it - and those net to zero across the window -");
    console.log("  or none at all. Spot-checked row by row on J1-0002: opening 15, a +9");
    console.log("  delivery on 1 Oct and nine units sold by 5 Oct, so the 6 Oct test sales");
    console.log("  still read 14 / 13 / 12 exactly as they do now.");
    console.log("");
    console.log("  It is deterministic, not luck: the plan is seeded, so an --apply would");
    console.log("  touch the same products. But it IS specific to this window - a different");
    console.log("  --from/--to, or a test sale during trading hours, would produce real");
    console.log("  rewrites here, which is why the backup step below is not optional.");
  }
  if (plan.updates.length > 0) {
    console.log("");
    table(
      plan.updates.slice(0, 3).map((u) => [
        String(u.movement_id),
        u.sku,
        manilaStamp(u.movement_ts),
        String(u.quantity),
        `${u.previousBalanceAfter} -> ${u.balance_after}`,
      ]),
      cols("movement_id", "sku", "when (Manila)", "qty", "balance_after")
    );
    if (plan.updates.length > 3) console.log(`  ... and ${fmtInt(plan.updates.length - 3)} more`);
    console.log("");
    console.log("  These are the six hand-entered test sales' own movements. Their rows are");
    console.log("  NOT otherwise touched - only balance_after is recomputed, because the");
    console.log("  inserted rows interleave with them.");
  }

  // ------------------------------------------------------- the invariants
  section("Invariants");
  const stockTotal = products.reduce((t, p) => t + p.stock_on_hand, 0);
  const driftRows = plan.perProduct.filter((p) => p.drift !== 0);
  const negRows = plan.perProduct.filter((p) => p.minBalance < 0);
  table(
    [
      ["products.stock_on_hand", `${fmtInt(stockTotal)} -> ${fmtInt(stockTotal)} (untouched)`],
      ["added rows net per product", driftRows.length === 0 ? "0 for all - PASS" : `NON-ZERO for ${driftRows.length} - FAIL`],
      ["lowest in-window balance", `${plan.minBalanceSeen} ${plan.minBalanceSeen >= 0 ? "- PASS" : "- FAIL"}`],
      ["products with a negative balance", negRows.length === 0 ? "0 - PASS" : `${negRows.length} - FAIL`],
      ["rows after the window to rewrite", plan.afterUpdates.length === 0 ? "0 - PASS" : `${plan.afterUpdates.length} - FAIL`],
    ],
    cols("check", "result")
  );
  if (plan.problems.length > 0) {
    console.log("");
    for (const p of plan.problems.slice(0, 10)) console.log(`  ! ${p}`);
    if (plan.problems.length > 10) console.log(`  ... and ${plan.problems.length - 10} more`);
  }

  // --------------------------------------------- the dip, before / after
  section("Daily sales revenue, 23 Sep - 13 Oct (the dip)");
  const before = new Map();
  for (const x of allSales) {
    if (x.status && x.status !== "confirmed") continue;
    before.set(manilaDateString(Date.parse(x.sale_ts)), (before.get(manilaDateString(Date.parse(x.sale_ts))) ?? 0) + Number(x.total_amount));
  }
  const added = new Map();
  for (const x of plan.sales) {
    const k = manilaDateString(x.__ts);
    added.set(k, (added.get(k) ?? 0) + x.sale.total_amount);
  }
  const rows = [];
  for (let d = manilaMidnight("2026-09-23"); d <= manilaMidnight("2026-10-13"); d = addDaysMs(d, 1)) {
    const k = manilaDateString(d);
    const b = before.get(k) ?? 0;
    const a = b + (added.get(k) ?? 0);
    const inWindow = d >= windowStart && d < windowEnd;
    rows.push([
      k,
      inWindow ? "<- gap" : "",
      b === 0 ? "-" : fmtPeso(b),
      a === 0 ? "-" : fmtPeso(a),
      added.has(k) ? `+${fmtPeso(added.get(k))}` : "",
    ]);
  }
  table(rows, cols("date (Manila)", "in gap", "gross now", "gross after", "added"));

  // ---------------------------------------------- monthly, Aug / Sep / Oct
  section("Monthly gross: August, September, October");
  const monthly = new Map();
  for (const x of allSales) {
    const k = manilaDateString(Date.parse(x.sale_ts)).slice(0, 7);
    monthly.set(k, (monthly.get(k) ?? 0) + Number(x.total_amount));
  }
  for (const x of existingServices) {
    const k = manilaDateString(Date.parse(x.service_ts)).slice(0, 7);
    monthly.set(k, (monthly.get(k) ?? 0) + Number(x.total_amount));
  }
  const addedMonthly = new Map();
  for (const x of plan.sales) {
    const k = manilaDateString(x.__ts).slice(0, 7);
    addedMonthly.set(k, (addedMonthly.get(k) ?? 0) + x.sale.total_amount);
  }
  for (const x of plan.services) {
    const k = manilaDateString(x.__ts).slice(0, 7);
    addedMonthly.set(k, (addedMonthly.get(k) ?? 0) + x.total_amount);
  }
  const monthRows = ["2026-08", "2026-09", "2026-10"].map((k) => {
    const b = monthly.get(k) ?? 0;
    const a = b + (addedMonthly.get(k) ?? 0);
    const vsSep = (v) => {
      const sep = monthly.get("2026-09") ?? 0;
      return sep ? `${((v / sep) * 100).toFixed(1)}% of Sep` : "-";
    };
    return [k, fmtPeso(b), fmtPeso(a), vsSep(b), vsSep(a)];
  });
  table(monthRows, cols("month", "gross now", "gross after", "now vs Sep", "after vs Sep"));

  // ------------------------------------------------------- stockout rate
  section("Stockouts in the window");
  console.log(`  trimmed lines       : 0`);
  console.log(`  lost lines          : 0`);
  console.log(`  substitutions       : 0`);
  console.log("");
  console.log("  Zero by construction, and that is the design rather than a lucky result:");
  console.log("  deliveries are derived from what the window sells, so nothing can run");
  console.log("  short. The main simulation reports real stockouts because it walks forward");
  console.log("  from live stock and cannot see its own future demand; here the demand is");
  console.log("  known first and the deliveries are fitted to it. The dip being filled is an");
  console.log("  artifact of when the seed stopped, not a period the shop actually ran dry.");

  // ------------------------------------------------------ sample ledgers
  const samples = [...plan.perProduct].sort((a, b) => b.rows.length - a.rows.length).slice(0, 2);
  for (const sample of samples) {
    section(`Sample ledger around the window: ${sample.sku}`);
    console.log(`  window opens on     : ${sample.opening}`);
    console.log(`  window closes on    : ${sample.closing}  (added rows net ${sample.drift})`);
    console.log(`  sold / delivered    : ${sample.sold} / ${sample.delivered}`);
    console.log(`  lowest balance      : ${sample.minBalance}`);
    console.log("");
    table(
      sample.rows.slice(0, 14).map((r) => [
        manilaStamp(r.movement_ts),
        r.movement_id == null ? "NEW" : String(r.movement_id),
        r.movement_type,
        String(r.quantity),
        String(r.balance_after),
        r.movement_id == null ? "" : `was ${r.previousBalanceAfter}`,
      ]),
      cols("when (Manila)", "id", "type", "qty", "balance_after", "note")
    );
    if (sample.rows.length > 14) console.log(`  ... ${fmtInt(sample.rows.length - 14)} more rows in the window`);
  }

  // ------------------------------------------------------------- backup
  section("Backup, and what --apply will and will not touch");
  console.log("  The backup cannot be taken by this script. `create table ... as select` is");
  console.log("  DDL, and PostgREST does not execute DDL; the `backup` schema is also not");
  console.log("  exposed to the API, so the service-role key cannot even insert into it.");
  console.log("  Run this in the Supabase SQL editor BEFORE any apply:");
  console.log("");
  console.log("    create schema if not exists backup;");
  console.log("    create table backup.stock_movements_pre_gapfill as");
  console.log("    select * from stock_movements");
  if (plan.updates.length > 0) {
    const ids = plan.updates.map((u) => u.movement_id);
    console.log(`     where movement_id in (${ids.slice(0, 40).join(", ")}${ids.length > 40 ? ", ..." : ""});`);
    console.log(`    -- ${fmtInt(ids.length)} rows`);
  } else {
    console.log(`     where movement_ts >= '${toManilaIso(windowStart)}'`);
    console.log(`       and movement_ts <  '${toManilaIso(windowEnd)}';`);
    console.log("    -- this plan would rewrite none of them, but take the window anyway:");
    console.log("    -- it is the cheap way to be able to undo the whole thing.");
  }
  console.log("");
  console.log("  Undo is then: restore those balance_after values from the backup, delete");
  console.log("  the inserted sales/sale_items/stock_movements by note = 'simulated' inside");
  console.log("  the window, and the services by the id range recorded in simulated-ids.json.");
  console.log("");
  console.log("  --apply writes only inserts, never updates. It re-proves the zero-rewrite");
  console.log("  precondition against a freshly loaded ledger immediately before writing and");
  console.log("  refuses if it no longer holds, because at that point a backup is required");
  console.log("  and this path cannot take one.");
}

/**
 * Gap-mode --apply.
 *
 * The precondition is the whole safety story. The dry run proved that this
 * window's plan rewrites NO existing stock_movements row, so there is nothing
 * to back up and nothing recorded can be lost. That is re-proved here against
 * a freshly loaded ledger, immediately before writing: if even one existing
 * row would need a new balance_after, this refuses, because at that point a
 * backup is required and this path does not take one (PostgREST executes no
 * DDL, and the `backup` schema is not exposed to the API).
 *
 * Writes are grouped per SALE, not per product. A sale spans up to six
 * products, so a per-product grouping would have to tear each sale's items
 * apart and could leave a sales row with some of its lines missing, which is
 * worse than what it protects against. Per sale, a failure leaves at most one
 * sale incomplete; the restocks, which are genuinely per product, are grouped
 * that way. Recovery is the backfill's rule either way: everything written
 * here is tagged 'simulated' and sits inside the window, so deleting exactly
 * that and re-running finishes the job.
 */
async function applyGapPlan(sb, plan, gap, pageSize) {
  section("Applying the gap fill");

  // ------------------------------------------------- re-prove the precondition
  progressLine("re-loading every movement to re-check the precondition...");
  const freshMovements = await pageAll(
    () =>
      sb
        .from("stock_movements")
        .select("movement_id, product_id, sku, movement_ts, movement_type, quantity, balance_after, note")
        .order("movement_id"),
    { pageSize, label: "movements" }
  );
  progressDone(`movements now: ${fmtInt(freshMovements.length)}`);

  const freshByProduct = new Map();
  for (const m of freshMovements) {
    if (!freshByProduct.has(m.product_id)) freshByProduct.set(m.product_id, []);
    freshByProduct.get(m.product_id).push({ ...m, movement_ts: Date.parse(m.movement_ts) });
  }

  let wouldRewrite = 0;
  for (const pp of plan.perProduct) {
    const split = splitAroundWindow(freshByProduct.get(pp.productId) ?? [], plan.windowStart, plan.windowEnd);
    const opening = split.openingBalance == null ? pp.opening : split.openingBalance;
    const newRows = pp.rows.filter((r) => r.movement_id == null).map((r) => ({ ...r, balance_after: undefined }));
    const check = planProductWindow({ opening, existingInside: split.inside, newRows });
    if (!check.ok) {
      console.log(`  REFUSING: ${pp.sku} - ${check.problems.join("; ")}`);
      return { ok: false };
    }
    wouldRewrite += countRewrittenRows(check.rows);
  }

  console.log(`  existing rows that would need a new balance_after: ${fmtInt(wouldRewrite)}`);
  if (wouldRewrite !== 0) {
    console.log("");
    console.log("  REFUSING to write. The dry run showed zero, so the data has moved since");
    console.log("  then. Rewriting recorded rows needs the backup first, and this path does");
    console.log("  not take one: PostgREST executes no DDL and the `backup` schema is not");
    console.log("  exposed to the API. Take it in the SQL editor, then ask for an apply");
    console.log("  path that updates as well as inserts.");
    return { ok: false };
  }
  console.log("  precondition holds: nothing recorded will be touched.");

  // ---------------------------------------------------------------- restocks
  // Per product, which is what these actually are.
  const restocksByProduct = new Map();
  for (const m of plan.movements) {
    if (!restocksByProduct.has(m.product_id)) restocksByProduct.set(m.product_id, []);
    restocksByProduct.get(m.product_id).push(m);
  }
  const unfilled = [
    ...plan.movements.filter((m) => m.balance_after == null),
    ...plan.sales.flatMap((s) => s.lines.filter((l) => l.__balanceAfter == null)),
  ];
  if (unfilled.length > 0) {
    console.log(`  REFUSING: ${fmtInt(unfilled.length)} planned rows have no balance_after.`);
    console.log("  That is a bug in the planner, not a data problem. Nothing was written.");
    return { ok: false };
  }

  let restockDone = 0;
  for (const [, rows] of restocksByProduct) {
    await insertBatched(
      sb,
      "stock_movements",
      rows.map((m) => ({
        product_id: m.product_id,
        sku: m.sku,
        movement_type: m.movement_type,
        quantity: m.quantity,
        balance_after: m.balance_after,
        user_id: m.user_id,
        reference: m.reference,
        note: m.note,
        movement_ts: m.movement_ts,
        supplier: m.supplier,
        unit_cost: m.unit_cost,
      }))
    );
    restockDone += rows.length;
    progressLine(`inserting restocks ${fmtInt(restockDone)}/${fmtInt(plan.movements.length)}`);
  }
  progressDone(`inserted ${fmtInt(restockDone)} stock_in movements`);

  // ------------------------------------------------------------------- sales
  // One chunk of sales at a time, each chunk's items and movements written
  // before the next chunk starts, so a failure leaves at most the sales in
  // one chunk without their lines.
  const SALE_CHUNK = 50;
  const insertedSales = [];
  let itemsDone = 0;
  let saleMovesDone = 0;

  for (let i = 0; i < plan.sales.length; i += SALE_CHUNK) {
    const chunk = plan.sales.slice(i, i + SALE_CHUNK);
    const ids = await insertBatched(sb, "sales", chunk.map((s) => s.sale), { select: "sale_id" });
    if (ids.length !== chunk.length) {
      throw new Error(`expected ${chunk.length} sale ids back, got ${ids.length}`);
    }
    insertedSales.push(...ids);

    const items = [];
    const moves = [];
    chunk.forEach((s, k) => {
      const saleId = ids[k].sale_id;
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
        moves.push({
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
        });
      }
    });
    await insertBatched(sb, "sale_items", items);
    await insertBatched(sb, "stock_movements", moves);
    itemsDone += items.length;
    saleMovesDone += moves.length;
    progressLine(`sales ${fmtInt(insertedSales.length)}/${fmtInt(plan.sales.length)}, lines ${fmtInt(itemsDone)}`);
  }
  progressDone(
    `inserted ${fmtInt(insertedSales.length)} sales, ${fmtInt(itemsDone)} sale_items, ${fmtInt(saleMovesDone)} sale movements`
  );

  // ---------------------------------------------------------------- services
  const insertedServices = plan.services.length
    ? await insertBatched(
        sb,
        "services",
        plan.services.map((s) => {
          const row = { ...s };
          delete row.__ts;
          return row;
        }),
        { select: "service_id" }
      )
    : [];
  progressDone(`inserted ${fmtInt(insertedServices.length)} services`);

  // products.stock_on_hand is deliberately NOT written: the added rows net to
  // zero per product, so the figure the ledger ends on is the one already
  // stored. Writing it would be a no-op at best and a drift at worst.
  console.log("  products.stock_on_hand: not written (the added rows net to zero)");

  appendGapManifest({ insertedSales, insertedServices, plan, gap });

  return { ok: true, insertedSales, insertedServices, itemsDone, saleMovesDone, restockDone };
}

function appendGapManifest({ insertedSales, insertedServices, plan, gap }) {
  const saleIds = insertedSales.map((r) => r.sale_id);
  const serviceIds = insertedServices.map((r) => r.service_id);

  let file = { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(IDS_FILE, "utf8"));
    if (Array.isArray(parsed.runs)) file = parsed;
  } catch {
    // no usable file yet - start a fresh one
  }

  file.runs.push({
    generatedAt: new Date().toISOString(),
    note: SIMULATED_NOTE,
    mode: "gap",
    window: { from: toManilaIso(plan.windowStart), to: toManilaIso(plan.windowEnd) },
    sales: { first: saleIds[0] ?? null, last: saleIds.at(-1) ?? null, count: saleIds.length },
    services: { first: serviceIds[0] ?? null, last: serviceIds.at(-1) ?? null, count: serviceIds.length },
    stockMovements: { count: plan.movements.length + plan.saleMovements.length },
  });
  file.howToRemove = [
    "Simulated sales and stock_movements carry note = 'simulated'.",
    "Services have no note column, so use the service_id ranges in runs[].",
    "delete from stock_movements where note = 'simulated';",
    "delete from sale_items where sale_id in (select sale_id from sales where note = 'simulated');",
    "delete from sales where note = 'simulated';",
    "delete from services where service_id between <runs[].services.first> and <runs[].services.last>;",
    "-- then recompute products.stock_on_hand, or restore it from the backup schema",
    "-- a run with mode = 'gap' nets to zero per product, so stock_on_hand needs no",
    "-- restoring for that one: deleting its rows leaves the figure where it was.",
  ];

  writeFileSync(IDS_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(`  appended run ${file.runs.length} to ${IDS_FILE}`);
}

// ---------------------------------------------------------------- apply

async function applyPlan(sb, plan) {
  section("Applying");

  const insertedSales = await insertBatched(sb, "sales", plan.sales.map((s) => s.sale), {
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

  // Stock last: a failure part-way then leaves stock matching the ledger
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

  appendManifest({ insertedSales, insertedServices, plan });
}

function appendManifest({ insertedSales, insertedServices, plan }) {
  const saleIds = insertedSales.map((r) => r.sale_id);
  const serviceIds = insertedServices.map((r) => r.service_id);

  let file = { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(IDS_FILE, "utf8"));
    if (Array.isArray(parsed.runs)) file = parsed;
  } catch {
    // no usable file yet - start a fresh one
  }

  file.runs.push({
    generatedAt: new Date().toISOString(),
    note: SIMULATED_NOTE,
    window: { from: plan.sales[0]?.sale.sale_ts ?? null, to: plan.sales.at(-1)?.sale.sale_ts ?? null },
    sales: { first: saleIds[0] ?? null, last: saleIds.at(-1) ?? null, count: saleIds.length },
    services: { first: serviceIds[0] ?? null, last: serviceIds.at(-1) ?? null, count: serviceIds.length },
  });
  file.howToRemove = [
    "Simulated sales and stock_movements carry note = 'simulated'.",
    "Services have no note column, so use the service_id ranges in runs[].",
    "delete from stock_movements where note = 'simulated';",
    "delete from sale_items where sale_id in (select sale_id from sales where note = 'simulated');",
    "delete from sales where note = 'simulated';",
    "delete from services where service_id between <runs[].services.first> and <runs[].services.last>;",
    "-- then recompute products.stock_on_hand, or restore it from the backup schema",
  ];

  writeFileSync(IDS_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(`  appended run ${file.runs.length} to ${IDS_FILE}`);
  console.log(`  sales    sale_id range:    ${saleIds[0]} .. ${saleIds.at(-1)}`);
  console.log(`  services service_id range: ${serviceIds[0]} .. ${serviceIds.at(-1)}`);
}

// Only run when invoked directly, so the check script can import the pure
// pieces without hitting the database.
if (process.argv[1] && process.argv[1].endsWith("simulate-recent-activity.mjs")) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
