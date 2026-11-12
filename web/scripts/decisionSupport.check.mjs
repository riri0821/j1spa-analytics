#!/usr/bin/env node
/**
 * Unit checks for the advisory rule engine, with no database.
 *
 *   node scripts/decisionSupport.check.mjs
 *
 * Lives outside src/ so Next never bundles it, same as the other .check
 * scripts. The rules are not exported individually - they are evaluated
 * inside evaluateDecisionSupport - so this drives the real function through
 * a stub Supabase client instead of reimplementing them, which is the point:
 * a copy of the rules here could agree with itself and still be wrong.
 *
 * R-06 (the MIN_SPIKE_UNITS floor) is what prompted this. Before it, any
 * item whose 3-month forecast beat its earlier average by 30% was a Demand
 * spike, so a product selling 2 units a month qualified on one extra unit -
 * 153 of 576 products flagged on the live catalog.
 */

import { enableBundlerResolve } from "./lib/bundlerResolve.mjs";

enableBundlerResolve();
const { evaluateDecisionSupport } = await import("../src/lib/decisionSupport.js");

let passed = 0;
const failures = [];

function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

function ok(label, cond) {
  is(label, !!cond, true);
}

/**
 * A Supabase stand-in holding exactly the four reads the engine makes.
 *
 * `monthly` is per-SKU unit history, oldest first, and is turned into the
 * year/month rows monthly_demand_all() returns. forecastAndAvg() reads the
 * last 3 months as fc30 and the 3 before the final one as avg12, so a
 * [...past, spike] series drives R-04/R-05/R-06 directly.
 */
function stubClient({ products, monthly, velocity = {}, overrides = [] }) {
  const monthlyRows = [];
  for (const [sku, units] of Object.entries(monthly)) {
    // Dates only have to be consecutive and ascending; the engine gap-fills
    // on its own and never looks at the absolute month.
    let y = 2024, m = 1;
    for (const u of units) {
      monthlyRows.push({ sku, year: y, month: m, units: u });
      if (++m > 12) { m = 1; y += 1; }
    }
  }
  const table = (rows) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: () => Promise.resolve({ data: null, error: null }),
      then: (res) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return builder;
  };
  return {
    from: (name) => {
      if (name === "products") return table(products);
      if (name === "advisory_overrides") return table(overrides);
      return table([]); // alerts: empty, so every run records and nothing reads back
    },
    rpc: (name) => {
      if (name === "owner_product_performance") {
        return Promise.resolve({
          data: products.map((p) => ({ sku: p.sku, units_90d: velocity[p.sku] ?? 0 })),
          error: null,
        });
      }
      if (name === "monthly_demand_all") return Promise.resolve({ data: monthlyRows, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

/** One product, far above its reorder point so R-01 cannot fire first. */
function product(sku, { onHand = 100, rop = 1 } = {}) {
  return { product_id: Number(sku.slice(1)), sku, name: `Item ${sku}`, stock_on_hand: onHand, reorder_point: rop };
}

const typeOf = (result, sku) => result.advisories.find((a) => a.sku === sku)?.type ?? null;
const traceOf = (result, sku) => result.advisories.find((a) => a.sku === sku)?.rules ?? [];

// ---------------------------------------------------------------- R-06
// avg12 reads months -4..-2, fc30 the last 3, so [n,n,n,3n] gives avg12 n and
// fc30 5n/3 - a +66.7% deviation at any n. Scaling n moves the volume without
// touching the deviation, so these three cases differ only in R-06.
{
  // onHand within ROPx3 so R-07 cannot fire and the fall-through is visible
  // as "no advisory" rather than as Overstock (which is covered separately).
  const low = await evaluateDecisionSupport(
    stubClient({ products: [product("P1", { onHand: 20, rop: 10 })], monthly: { P1: [2, 2, 2, 6] } })
  );
  // fc30 = (2+2+6)/3 = 3.33, avg12 = 2, deviation +66.7% -> R-04 and R-05 true
  is("R-06 blocks a spike below MIN_SPIKE_UNITS (fc30 3.33)", typeOf(low, "P1"), null);

  const high = await evaluateDecisionSupport(
    stubClient({ products: [product("P1")], monthly: { P1: [6, 6, 6, 18] } })
  );
  // fc30 = (6+6+18)/3 = 10, avg12 = 6, deviation +66.7% -> all three true
  is("R-06 allows a spike at volume (fc30 10)", typeOf(high, "P1"), "demand_spike");

  // fc30 exactly 5 must pass: the rule is >=, not >.
  const edge = await evaluateDecisionSupport(
    stubClient({ products: [product("P1")], monthly: { P1: [3, 3, 3, 9] } })
  );
  is("R-06 is inclusive at MIN_SPIKE_UNITS (fc30 5)", typeOf(edge, "P1"), "demand_spike");
}

// ------------------------------------------------- R-06 in the trace
{
  const r = await evaluateDecisionSupport(
    stubClient({ products: [product("P1")], monthly: { P1: [6, 6, 6, 18] } })
  );
  const trace = traceOf(r, "P1");
  is("Demand spike trace lists R-04, R-05, R-06 in order", trace.map((t) => t.id), ["R-04", "R-05", "R-06"]);
  ok("R-06 expr names the forecast and the floor", /forecast_30d \(10\).*min_spike_units \(5\)/.test(trace[2].expr));
  is("R-06 result is a real boolean", typeof trace[2].result, "boolean");
}

// ------------------------- R-06 is computed even when it is FALSE
// A manual override shows the engine's own trace, so R-06 has to be
// evaluated for every product, not only inside the branch that fires.
{
  const r = await evaluateDecisionSupport(
    stubClient({
      products: [product("P1", { onHand: 20, rop: 10 })],
      monthly: { P1: [2, 2, 2, 6] }, // fc30 3.33: R-06 false
      overrides: [{ product_id: 1, manual_type: "demand_spike" }],
    })
  );
  is("manual override still yields a demand_spike advisory", typeOf(r, "P1"), "demand_spike");
  const trace = traceOf(r, "P1");
  is("overridden trace still carries R-06", trace.map((t) => t.id), ["R-04", "R-05", "R-06"]);
  is("and reports it as FALSE rather than omitting it", trace[2].result, false);
  is("naturalType shows the rules would not have fired", r.advisories[0].naturalType, null);
}

// ------------------------------------------------------- check order
// Low stock, then Demand spike, then Overstock, then No action needed.
{
  // R-01 true and a spike present: Low stock must win.
  const lowFirst = await evaluateDecisionSupport(
    stubClient({ products: [product("P1", { onHand: 1, rop: 10 })], monthly: { P1: [6, 6, 6, 18] } })
  );
  is("Low stock outranks Demand spike", typeOf(lowFirst, "P1"), "low_stock");

  // A qualifying spike on a product that would also read as overstock.
  const spikeFirst = await evaluateDecisionSupport(
    stubClient({ products: [product("P1", { onHand: 1000, rop: 10 })], monthly: { P1: [6, 6, 6, 18] }, velocity: { P1: 0 } })
  );
  is("Demand spike outranks Overstock", typeOf(spikeFirst, "P1"), "demand_spike");

  // Same product, but the spike is too small for R-06 - it should now fall
  // through to Overstock rather than to No action needed.
  const fallsThrough = await evaluateDecisionSupport(
    stubClient({ products: [product("P1", { onHand: 1000, rop: 10 })], monthly: { P1: [2, 2, 2, 6] }, velocity: { P1: 0 } })
  );
  is("a sub-volume spike falls through to Overstock", typeOf(fallsThrough, "P1"), "overstock");
}

// --------------------------------------- the other rules are untouched
{
  const r = await evaluateDecisionSupport(
    stubClient({ products: [product("P1", { onHand: 1, rop: 10 })], monthly: { P1: [6, 6, 6, 18] } })
  );
  is("Low stock trace is still R-01..R-03", traceOf(r, "P1").map((t) => t.id), ["R-01", "R-02", "R-03"]);

  const o = await evaluateDecisionSupport(
    stubClient({ products: [product("P1", { onHand: 1000, rop: 10 })], monthly: { P1: [1, 1, 1, 1] }, velocity: { P1: 0 } })
  );
  is("Overstock trace is still R-07..R-09", traceOf(o, "P1").map((t) => t.id), ["R-07", "R-08", "R-09"]);
}

// ------------------------------------------------- totals still add up
{
  const products = [
    product("P1", { onHand: 1, rop: 10 }),      // low stock
    product("P2", { onHand: 100, rop: 1 }),     // demand spike
    product("P3", { onHand: 1000, rop: 10 }),   // overstock
    product("P4", { onHand: 7, rop: 1 }),       // no action
  ];
  const r = await evaluateDecisionSupport(
    stubClient({
      products,
      monthly: { P1: [6, 6, 6, 18], P2: [6, 6, 6, 18], P3: [1, 1, 1, 1], P4: [3, 3, 3, 3] },
      velocity: { P3: 0, P4: 999 },
    })
  );
  is("every product lands in exactly one category", r.advisories.length + r.noAction.length, products.length);
  is("units add up to total stock", r.unitsByType.low_stock + r.unitsByType.demand_spike + r.unitsByType.overstock + r.noActionUnits, r.totalUnits);
}

if (failures.length > 0) {
  console.error(`decisionSupport.js: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(`decisionSupport.js: ${passed} checks passed`);
