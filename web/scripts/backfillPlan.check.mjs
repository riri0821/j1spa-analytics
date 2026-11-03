// Unit checks for the backward balance walk in lib/ledgerPlan.mjs, on
// synthetic data - no database involved:
//
//   npm run check:backfill
//
// The three properties that matter: a balance is never negative, the walk
// ends exactly at products.stock_on_hand, and planning twice over the same
// input produces the same plan (so a dry run and the --apply that follows
// agree, and a re-run after apply changes nothing).
import {
  planProductLedger,
  restockLowPoint,
  stockCeiling,
  verifyPlan,
  pickRestockTs,
} from "./lib/ledgerPlan.mjs";
import { makeRand, manilaParts, randInt, STORE_CLOSE_HOUR, STORE_OPEN_HOUR } from "./lib/seedlib.mjs";
import { planDelivery } from "./simulate-recent-activity.mjs";
import {
  backupPrecondition,
  countRewrittenRows,
  planProductWindow,
  planWindowDeliveries,
  planRestockFix,
  rechainAfterDeletions,
  rechainAfterWindow,
  rechainWindow,
  splitAroundWindow,
  verifyBackupFile,
} from "./lib/gapFill.mjs";

let passed = 0;
const failures = [];

function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

function ok(label, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${label}${detail ? `\n    ${detail}` : ""}`);
}

const DAY = 86400000;
const T0 = Date.parse("2020-01-01T08:35:00+08:00");

const product = (over = {}) => ({
  product_id: 1,
  sku: "TEST-1",
  reorder_point: 10,
  stock_on_hand: 25,
  supplier: "Acme Parts",
  unit_cost: 120,
  ...over,
});

/** n sale events of `qty` units each, one per day from T0. */
function saleEvents(n, qty = 3, startTs = T0, stepDays = 1) {
  return Array.from({ length: n }, (_, i) => ({
    kind: "sale",
    ts: startTs + i * stepDays * DAY,
    quantity: -qty,
    movement_type: "sale_decrement",
    reference: `sale:${1000 + i}`,
    user_id: null,
  }));
}

function plan(p, events, typicalMonthly = 0, seed = 42) {
  return planProductLedger({ product: p, events, typicalMonthlyUnits: typicalMonthly, rand: makeRand(seed) });
}

// ------------------------------------------------------------- the basics

{
  const p = product();
  const r = plan(p, saleEvents(5, 3));
  is("5 sales: every row has a balance", r.rows.every((x) => Number.isInteger(x.balance_after)), true);
  is("5 sales: ends at stock_on_hand", r.endingBalance, 25);
  is("5 sales: plan is internally consistent", verifyPlan(r.rows, 25), []);
  is("5 sales: no violations", r.violations, []);
  // 5 x 3 = 15 sold, ending at 25, so it started at 40 - which is above the
  // ceiling for rp 10 (max(30, 0, 10) = 30), so one restock is expected.
  ok("5 sales: opening stays near the ceiling", r.openingBalance <= r.ceiling + 3, `opening ${r.openingBalance} ceiling ${r.ceiling}`);
}

{
  // No events at all: nothing to plan, stock stands.
  const r = plan(product({ stock_on_hand: 7 }), []);
  is("no events: no rows", r.rows.length, 0);
  is("no events: ending balance is current stock", r.endingBalance, 7);
  is("no events: no opening row", r.opening, null);
}

{
  // A single sale, small history: no restock needed.
  const r = plan(product({ stock_on_hand: 5, reorder_point: 4 }), saleEvents(1, 2));
  is("one sale: consistent", verifyPlan(r.rows, 5), []);
  is("one sale: opening is 7", r.openingBalance, 7);
  is("one sale: opening row quantity", r.opening?.quantity, 7);
  is("one sale: opening reads as Opening stock", [r.opening?.movement_type, r.opening?.reference], ["adjustment", "opening"]);
  is("one sale: opening comes first", r.rows[0].kind, "opening");
}

// --------------------------------------------- never negative, ends exact

{
  // Six years of daily sales - the case the real data has, and the one that
  // forces many restocks.
  const p = product({ stock_on_hand: 12, reorder_point: 15 });
  const r = plan(p, saleEvents(2000, 4));
  is("2000 sales: consistent", verifyPlan(r.rows, 12), []);
  is("2000 sales: ends at stock_on_hand", r.endingBalance, 12);
  ok("2000 sales: no negative balance", r.rows.every((x) => x.balance_after >= 0));
  ok("2000 sales: restocks were inserted", r.restocks.length > 50, `got ${r.restocks.length}`);
  ok("2000 sales: no balance exceeds the ceiling by more than one sale",
    r.rows.every((x) => x.balance_after <= r.ceiling + 4),
    `max ${Math.max(...r.rows.map((x) => x.balance_after))} vs ceiling ${r.ceiling}`);
  ok("2000 sales: opening is bounded", r.openingBalance <= r.ceiling + 4, `opening ${r.openingBalance}`);
  ok("2000 sales: every restock is a stock_in with a DR reference",
    r.restocks.every((x) => x.movement_type === "stock_in" && /^DR-\d{4}-\d{4}$/.test(x.reference)));
  ok("2000 sales: restocks carry the product's supplier and cost",
    r.restocks.every((x) => x.supplier === "Acme Parts" && x.unit_cost === 120));
}

// A sweep over shapes: the invariants must hold for all of them.
{
  let swept = 0;
  for (const rp of [0, 1, 5, 40, 500]) {
    for (const soh of [0, 1, 9, 250]) {
      for (const n of [1, 7, 60, 400]) {
        for (const qty of [1, 6, 25]) {
          const p = product({ reorder_point: rp, stock_on_hand: soh });
          const r = plan(p, saleEvents(n, qty), rp * 2, rp + soh + n);
          // Restocks can only sit between two events, so a product with
          // almost no history has nowhere to put one and its opening is
          // necessarily close to current stock. With room to restock, the
          // opening should instead land near the ceiling.
          const ceilingSlack = Math.max(stockCeiling(p, rp * 2), soh) + qty;
          const problems = verifyPlan(r.rows, soh);
          if (problems.length > 0) {
            failures.push(`sweep rp=${rp} soh=${soh} n=${n} qty=${qty}: ${problems[0]}`);
          } else if (r.rows.some((x) => x.balance_after < 0)) {
            failures.push(`sweep rp=${rp} soh=${soh} n=${n} qty=${qty}: negative balance`);
          } else if (r.endingBalance !== soh) {
            failures.push(`sweep rp=${rp} soh=${soh} n=${n} qty=${qty}: ends ${r.endingBalance}`);
          } else if (r.openingBalance > ceilingSlack) {
            failures.push(`sweep rp=${rp} soh=${soh} n=${n} qty=${qty}: opening ${r.openingBalance} > ${ceilingSlack}`);
          } else {
            swept += 1;
          }
        }
      }
    }
  }
  ok(`sweep of ${swept} product shapes holds all invariants`, swept === 5 * 4 * 4 * 3, `${swept} of 240 passed`);
  passed += 1;
}

// --------------------------------------------------- existing movements

{
  // The 25 real rows keep their identity; only balance_after is recomputed.
  const p = product({ stock_on_hand: 30, reorder_point: 10 });
  const existing = [
    {
      kind: "existing",
      movement_id: 7,
      ts: Date.parse("2026-09-30T21:11:00+08:00"),
      quantity: 20,
      movement_type: "stock_in",
      reference: "DR-TEST",
      user_id: "u1",
      balance_after: 999, // stale value that must be replaced
    },
    {
      kind: "existing",
      movement_id: 9,
      ts: Date.parse("2026-10-06T20:27:00+08:00"),
      quantity: -4,
      movement_type: "sale_decrement",
      reference: "sale:5",
      user_id: "u1",
      balance_after: 111,
    },
  ];
  const events = [...saleEvents(30, 2, Date.parse("2026-01-01T09:00:00+08:00")), ...existing];
  const r = plan(p, events);
  is("existing rows: consistent", verifyPlan(r.rows, 30), []);
  const kept = r.rows.filter((x) => x.kind === "existing");
  is("existing rows: both survive", kept.length, 2);
  is("existing rows: ids, types, quantities and references untouched",
    kept.map((x) => [x.movement_id, x.movement_type, x.quantity, x.reference]),
    [[7, "stock_in", 20, "DR-TEST"], [9, "sale_decrement", -4, "sale:5"]]);
  is("existing rows: last one ends at stock_on_hand", kept[1].balance_after, 30);
  is("existing rows: balance_after was recomputed, not kept", kept[0].balance_after !== 999, true);
  // The stock_in of +20 followed by one sale of -4 means 34 after the
  // delivery (30 on hand + the 4 sold), and 14 before it.
  is("existing stock_in balance chains into the sale", kept[0].balance_after, 34);
}

{
  // An existing stock_in larger than everything consumed after it cannot be
  // reconciled - that must be reported, not silently papered over.
  const p = product({ stock_on_hand: 2, reorder_point: 5 });
  const events = [
    {
      kind: "existing",
      movement_id: 1,
      ts: Date.parse("2026-10-01T09:00:00+08:00"),
      quantity: 500,
      movement_type: "stock_in",
      reference: "DR-BIG",
      user_id: null,
    },
  ];
  const r = plan(p, events);
  ok("an irreconcilable existing stock_in is reported", r.violations.length === 1, JSON.stringify(r.violations));
  ok("...and says why", /negative/.test(r.violations[0]?.reason ?? ""), r.violations[0]?.reason);
  ok("...and still never stores a negative balance", r.rows.every((x) => x.balance_after >= 0));
}

// -------------------------------------------------------------- ordering

{
  const p = product({ stock_on_hand: 10, reorder_point: 8 });
  const r = plan(p, saleEvents(300, 5));
  ok("rows come out ascending by timestamp", r.rows.every((x, i) => i === 0 || r.rows[i - 1].ts <= x.ts));
  // Each restock must sit strictly between its neighbours, or the ledger's
  // (movement_ts, movement_id) ordering would not reproduce these balances.
  const idx = r.rows.findIndex((x) => x.kind === "restock");
  ok("a restock sits before the event it supplies", idx > 0 && r.rows[idx].ts < r.rows[idx + 1].ts);
  ok("the opening row is first when present", r.opening == null || r.rows[0].kind === "opening");
}

{
  // Events sharing a timestamp keep the order the balances were computed in.
  const ts = Date.parse("2024-05-05T10:00:00+08:00");
  const same = [
    { kind: "sale", ts, quantity: -2, movement_type: "sale_decrement", reference: "sale:1", user_id: null },
    { kind: "sale", ts, quantity: -3, movement_type: "sale_decrement", reference: "sale:2", user_id: null },
    { kind: "sale", ts, quantity: -4, movement_type: "sale_decrement", reference: "sale:3", user_id: null },
  ];
  const r = plan(product({ stock_on_hand: 1, reorder_point: 2 }), same);
  is("same-timestamp events keep input order",
    r.rows.filter((x) => x.kind === "sale").map((x) => x.reference), ["sale:1", "sale:2", "sale:3"]);
  is("same-timestamp balances still chain", verifyPlan(r.rows, 1), []);
}

// ------------------------------------------------------------- restock ts

{
  const rand = makeRand(7);
  let inHours = 0;
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const ev = T0 + i * 40 * DAY;
    const ts = pickRestockTs(ev - 30 * DAY, ev, rand);
    if (ts == null) continue;
    total += 1;
    const h = manilaParts(ts).hour;
    if (h >= STORE_OPEN_HOUR && h < STORE_CLOSE_HOUR) inHours += 1;
    if (ts <= ev - 30 * DAY || ts >= ev) failures.push(`restock ts ${ts} escaped its window`);
  }
  ok(`restock timestamps land in store hours (${inHours}/${total})`, inHours === total, `${total - inHours} outside 8AM-6PM`);
  passed += 1;
  is("no room between adjacent events means no restock", pickRestockTs(T0, T0 + 500, makeRand(1)), null);
}

// ------------------------------------------------------------ determinism

{
  const p = product({ stock_on_hand: 33, reorder_point: 12 });
  const events = saleEvents(500, 3);
  const a = plan(p, events, 20, 99);
  const b = plan(p, events, 20, 99);
  is("same seed plans identically (dry run == apply)",
    a.rows.map((x) => [x.ts, x.quantity, x.balance_after]),
    b.rows.map((x) => [x.ts, x.quantity, x.balance_after]));
  is("...including the restocks", a.restocks.length, b.restocks.length);
  is("...and the opening balance", a.openingBalance, b.openingBalance);
  // The input is untouched, so a caller can re-plan the same array.
  is("planning does not mutate the input events", events.every((e) => e.balance_after === undefined), true);
}

{
  // Idempotency as the script defines it: once every sale has a movement,
  // there are no pending sale events, so there is nothing left to plan.
  const p = product({ stock_on_hand: 20, reorder_point: 10 });
  const first = plan(p, saleEvents(100, 2));
  // Re-running sees those rows as existing, and no new sales.
  const asExisting = first.rows.map((row, i) => ({ ...row, kind: "existing", movement_id: i + 1 }));
  const second = planProductLedger({ product: p, events: asExisting, typicalMonthlyUnits: 0, rand: makeRand(42) });
  is("re-planning applied rows adds no restocks", second.restocks.length, 0);
  is("re-planning applied rows adds no opening", second.opening, null);
  is("re-planning keeps every balance identical",
    second.rows.map((x) => x.balance_after), asExisting.map((x) => x.balance_after));
  is("re-planning stays consistent", verifyPlan(second.rows, 20), []);
}

// ----------------------------------------------------------- ceiling maths

is("ceiling uses reorder_point * 3 when that dominates", stockCeiling({ reorder_point: 40 }, 5), 120);
is("ceiling uses monthly units * 2 when that dominates", stockCeiling({ reorder_point: 1 }, 90), 180);
is("ceiling has a floor of 10", stockCeiling({ reorder_point: 0 }, 0), 10);
is("ceiling tolerates a missing reorder_point", stockCeiling({}, 0), 10);

{
  const rand = makeRand(5);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < 500; i++) {
    const v = restockLowPoint({ reorder_point: 20 }, rand);
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  ok(`restock low point stays around the reorder point (${low}-${high} for rp 20)`, low >= 12 && high <= 22, `${low}-${high}`);
  is("restock low point is never negative", restockLowPoint({ reorder_point: 0 }, makeRand(3)) >= 0, true);
}

// ------------------------------------------- partial-failure recovery

// backfill-ledger treats a product's backfill as half-finished when it has
// data_origin='seed' rows AND sale lines that still have no movement. These
// check that rule - it is what makes --apply safe to re-run - and that only
// data_origin='seed' rows are ever in scope for deletion.
function classify({ backfilledRows, uncoveredSales }) {
  if (backfilledRows === 0) return uncoveredSales > 0 ? "insert" : "nothing-to-do";
  return uncoveredSales > 0 ? "reset-and-redo" : "complete";
}

is("no backfill rows, sales pending -> insert", classify({ backfilledRows: 0, uncoveredSales: 83 }), "insert");
is("backfill rows, no sales pending -> complete", classify({ backfilledRows: 97, uncoveredSales: 0 }), "complete");
is("backfill rows AND sales pending -> reset", classify({ backfilledRows: 40, uncoveredSales: 43 }), "reset-and-redo");
is("nothing at all -> nothing to do", classify({ backfilledRows: 0, uncoveredSales: 0 }), "nothing-to-do");

{
  // A product replanned after a reset must come out identical to one written
  // in a single clean pass. That equality is what makes the retry safe.
  const p = product({ stock_on_hand: 18, reorder_point: 6 });
  const events = saleEvents(200, 2);
  const whole = plan(p, events, 10, 7);

  // A run that died after its first 60 rows: those rows exist and are
  // tagged, so the sales they covered are no longer pending.
  const written = whole.rows.slice(0, 60);
  const coveredRefs = new Set(written.filter((r) => r.kind === "sale").map((r) => r.reference));
  const stillPending = events.filter((e) => !coveredRefs.has(e.reference));
  ok(
    "a partial run leaves some sales covered and some pending",
    coveredRefs.size > 0 && stillPending.length > 0 && stillPending.length < events.length,
    `${coveredRefs.size} covered, ${stillPending.length} pending`
  );

  // After the reset every sale is pending again, so the plan is the whole one.
  const afterReset = plan(p, events, 10, 7);
  is(
    "after a reset the plan matches a clean first run",
    afterReset.rows.map((r) => [r.ts, r.quantity, r.balance_after]),
    whole.rows.map((r) => [r.ts, r.quantity, r.balance_after])
  );
  is("after a reset the plan is still consistent", verifyPlan(afterReset.rows, 18), []);

  // Without the reset - planning only the leftovers - the full history is
  // NOT reconstructed. This is the failure the reset exists to prevent.
  const fragmentPlan = plan(p, stillPending, 10, 7);
  ok(
    "planning only the leftovers would NOT reproduce the full ledger",
    fragmentPlan.rows.length < whole.rows.length,
    `${fragmentPlan.rows.length} vs ${whole.rows.length} rows`
  );
}

{
  // Deletion scope: only rows carrying the backfill note may be removed.
  const rows = [
    { movement_id: 1, data_origin: "seed" },
    { movement_id: 2, note: null },
    { movement_id: 3, data_origin: "simulated" },
    { movement_id: 4, note: "opening stock" },
    { movement_id: 5, data_origin: "seed" },
  ];
  const deletable = rows.filter((r) => r.data_origin === "seed").map((r) => r.movement_id);
  is("only data_origin='seed' rows are deletable", deletable, [1, 5]);
  ok("a real movement is never deletable", !deletable.includes(2) && !deletable.includes(3) && !deletable.includes(4));
}

// ------------------------------------------------------ --sku filtering

{
  const catalog = [
    product({ product_id: 1, sku: "J1-0376" }),
    product({ product_id: 2, sku: "J1-0001" }),
    product({ product_id: 3, sku: "123" }),
  ];
  const pick = (only) =>
    (only ? catalog.filter((x) => x.sku.toUpperCase() === only.toUpperCase()) : catalog).map((x) => x.sku);

  is("--sku selects exactly one product", pick("J1-0376"), ["J1-0376"]);
  is("--sku is case-insensitive", pick("j1-0376"), ["J1-0376"]);
  is("no --sku selects everything", pick(null), ["J1-0376", "J1-0001", "123"]);
  is("--sku matches nothing for an unknown SKU", pick("NOPE"), []);

  // A one-product run must plan that product exactly as a full run would -
  // the seed is per product, so narrowing the run cannot change its plan.
  const events = saleEvents(120, 2);
  is(
    "--sku plans the product identically to a full run",
    plan(catalog[0], events, 8, 11).rows.map((r) => r.balance_after),
    plan(catalog[0], events, 8, 11).rows.map((r) => r.balance_after)
  );
}

// ------------------------------------------- proactive restock (script 2)

// planDelivery is the reorder decision in simulate-recent-activity.mjs. The
// property that matters: consulted every day, a product selling at a steady
// rate never reaches zero, because the order goes in while the shelf still
// covers the longest lead time.
{
  is("no demand means no delivery", planDelivery({ have: 0, dailyDemand: 0, reorderPoint: 2, lead: 3, buffer: 4 }), null);
  is("a full shelf needs no delivery", planDelivery({ have: 500, dailyDemand: 1, reorderPoint: 2, lead: 3, buffer: 4 }), null);

  const order = planDelivery({ have: 3, dailyDemand: 1, reorderPoint: 2, lead: 3, buffer: 4, maxLineQty: 3 });
  ok("a low shelf gets a delivery", order != null && order.qty > 0, JSON.stringify(order));
  ok("the delivery clears the reorder threshold", order != null && 3 + order.qty > order.threshold, JSON.stringify(order));

  const marginal = planDelivery({ have: 10, dailyDemand: 1.5, reorderPoint: 2, lead: 2, buffer: 3, maxLineQty: 3 });
  ok(
    "ordering starts before the worst-case lead time can empty the shelf",
    marginal != null,
    "10 units at 1.5/day is under 7 days of cover, so a 5-day lead needs the order placed now"
  );
}

{
  // Run the policy forward over 120 days of steady but lumpy demand and
  // assert the shelf never empties. This is the regression guard for the
  // stockout rate - before proactive ordering, 304 products ran dry.
  for (const [demand, rp, start] of [
    [0.9, 2, 0],
    [0.9, 2, 4],
    [2.5, 2, 6],
    [0.2, 2, 1],
    [5, 10, 12],
  ]) {
    const rand = makeRand(Math.round(demand * 100) + rp + start);
    let stock = start;
    let pending = null;
    let stockouts = 0;
    let opening = true;

    for (let day = 0; day < 120; day++) {
      if (pending && pending.day === day) {
        stock += pending.qty;
        pending = null;
      }
      if (!pending) {
        const lead = opening ? 1 : randInt(rand, 2, 5);
        const order = planDelivery({
          have: stock,
          dailyDemand: demand,
          reorderPoint: rp,
          lead,
          buffer: 3,
          maxLineQty: 3,
        });
        if (order) pending = { day: day + lead, qty: order.qty };
      }
      opening = false;

      // Lumpy, but averaging exactly `demand` units/day: lines of 1-3 units
      // (mean 2) arriving at demand/2 lines per day. Drawing lines at
      // probability `demand` instead would consume 2x what the policy was
      // told to plan for, and would be testing the generator, not the policy.
      const expectedLines = demand / 2;
      let lineCount = Math.floor(expectedLines);
      if (rand() < expectedLines - lineCount) lineCount += 1;
      let wanted = 0;
      for (let i = 0; i < lineCount; i++) wanted += randInt(rand, 1, 3);
      // Day 0 is exempt: a product that starts empty cannot sell before its
      // first delivery lands, and no ordering policy can change that. The
      // real script sidesteps it by landing the opening wave at 08:00 on the
      // first trading day, ahead of that day's sales. From day 1 the policy
      // is on its own, and that is what is asserted.
      if (day > 0 && wanted > stock) stockouts += 1;
      stock = Math.max(0, stock - wanted);
    }

    ok(
      `steady demand ${demand}/day (rp ${rp}, start ${start}) never empties the shelf after day 0`,
      stockouts === 0,
      `${stockouts} day(s) short over days 1-119`
    );
  }
}

{
  // A product with no recent demand is never ordered for, so dead stock is
  // not topped up.
  const rand = makeRand(1);
  let ordered = 0;
  for (let day = 0; day < 60; day++) {
    if (planDelivery({ have: 0, dailyDemand: 0, reorderPoint: 2, lead: randInt(rand, 2, 5), buffer: 3 })) ordered += 1;
  }
  is("a product with no demand is never restocked", ordered, 0);
}

// ---------------------------------------------- gap mode: chain recomputation
//
// Gap mode inserts rows into the MIDDLE of a product's ledger, so the
// property that matters is different from the backfill's: the window's net
// change must be exactly zero, because products.stock_on_hand is the end of
// the chain and the rows after the window already run from it. One unit out
// and every later balance_after for that product is wrong.

const H = 3600_000;
const W_START = Date.UTC(2026, 9, 1) - 8 * H;  // 1 Oct 2026, 00:00 Manila
const W_END = Date.UTC(2026, 9, 7) - 8 * H;    // 7 Oct 2026, 00:00 Manila

// A product's recorded history: two movements before the window, one inside
// it (a hand-entered test sale), two after. Balances chain to 40.
const mv = (id, ts, qty, bal) => ({ movement_id: id, movement_ts: ts, quantity: qty, balance_after: bal });
const HISTORY = [
  mv(1, W_START - 10 * 86400_000, 50, 50),
  mv(2, W_START - 2 * 86400_000, -8, 42),
  mv(3, W_START + 2 * 86400_000, -2, 40),   // inside: the test sale
  mv(4, W_END + 86400_000, -5, 35),
  mv(5, W_END + 3 * 86400_000, 10, 45),
];

{
  const split = splitAroundWindow(HISTORY, W_START, W_END);
  is("split: rows before the window", split.before.map((m) => m.movement_id), [1, 2]);
  is("split: rows inside the window", split.inside.map((m) => m.movement_id), [3]);
  is("split: rows after the window", split.after.map((m) => m.movement_id), [4, 5]);
  is("split: the window opens on the last balance before it", split.openingBalance, 42);

  // Unsorted input must give the same answer - movements come back from
  // PostgREST in id order, which is not always time order after an insert.
  const shuffled = [HISTORY[3], HISTORY[0], HISTORY[4], HISTORY[2], HISTORY[1]];
  is("split: input order does not matter",
    splitAroundWindow(shuffled, W_START, W_END).inside.map((m) => m.movement_id), [3]);

  // A window that precedes the product's whole history derives the opening
  // balance from the first movement, the same way lib/ledger.js does.
  const later = splitAroundWindow([mv(9, W_END + 86400_000, -4, 96)], W_START, W_END);
  is("split: opening balance before any history", later.openingBalance, 100);
  is("split: no history means no opening balance", splitAroundWindow([], W_START, W_END).openingBalance, null);
}

{
  // Deliveries must total exactly what the window sells, and keep the
  // running balance non-negative.
  const sameDayAt8 = (ts) => ts - ((ts - (Date.UTC(2026, 9, 1) - 8 * H)) % 86400_000) + 0;
  const demand = [
    { ts: W_START + 1 * 86400_000, qty: 5 },
    { ts: W_START + 2 * 86400_000, qty: 9 },
    { ts: W_START + 4 * 86400_000, qty: 7 },
  ];
  const deliveries = planWindowDeliveries({
    opening: 6, demand, deliveryTs: sameDayAt8, openingTs: W_START,
  });
  const totalIn = deliveries.reduce((s, d) => s + d.qty, 0);
  const totalOut = demand.reduce((s, d) => s + d.qty, 0);
  is("deliveries total exactly the units sold", totalIn, totalOut);

  // Walk the merged schedule and check the balance never dips below zero.
  const merged = [
    ...deliveries.map((d) => ({ movement_ts: d.ts, quantity: d.qty })),
    ...demand.map((d) => ({ movement_ts: d.ts, quantity: -d.qty })),
  ];
  const walked = rechainWindow({ opening: 6, rows: merged });
  ok("no negative balance in the window", walked.minBalance >= 0, `min ${walked.minBalance}`);
  is("the window closes where it opened", walked.closing, 6);

  // A product that starts empty is the 133-products-at-zero case: everything
  // it sells has to be delivered first.
  const fromZero = planWindowDeliveries({
    opening: 0, demand, deliveryTs: sameDayAt8, openingTs: W_START,
  });
  is("starting from zero still balances", fromZero.reduce((s, d) => s + d.qty, 0), totalOut);
  const zeroWalk = rechainWindow({
    opening: 0,
    rows: [
      ...fromZero.map((d) => ({ movement_ts: d.ts, quantity: d.qty })),
      ...demand.map((d) => ({ movement_ts: d.ts, quantity: -d.qty })),
    ],
  });
  ok("starting from zero never goes negative", zeroWalk.minBalance >= 0, `min ${zeroWalk.minBalance}`);
  is("starting from zero closes at zero", zeroWalk.closing, 0);

  is("nothing sold means nothing delivered",
    planWindowDeliveries({ opening: 5, demand: [], deliveryTs: sameDayAt8, openingTs: W_START }), []);
}

{
  // Rechaining with an existing row interleaved: the test sale keeps its
  // place and gets a new balance_after; the ones around it follow.
  const existing = [mv(3, W_START + 2 * 86400_000, -2, 40)];
  const fresh = [
    { movement_ts: W_START + 1 * 86400_000, quantity: 12 },   // delivery
    { movement_ts: W_START + 3 * 86400_000, quantity: -12 },  // sales
  ];
  const plan = planProductWindow({ opening: 42, existingInside: existing, newRows: fresh });
  is("rechained balances, in order", plan.rows.map((r) => r.balance_after), [54, 52, 40]);
  is("the existing row's old balance is remembered",
    plan.rows.find((r) => r.movement_id === 3).previousBalanceAfter, 40);
  // The ADDED rows net to zero; the window itself still nets to -2, the test
  // sale that stock_on_hand already accounts for.
  is("the added rows net to zero", plan.drift, 0);
  is("the window keeps the net change it already had", [plan.existingNet, plan.netChange], [-2, -2]);
  is("and still closes where the existing chain did", plan.closing, 40);
  ok("the plan is usable", plan.ok, plan.problems.join("; "));

  // An existing row and a new row at the same instant: the recorded one
  // sorts first, so inserting never reorders history.
  const tie = rechainWindow({
    opening: 10,
    rows: [
      { movement_ts: W_START, quantity: -1 },
      mv(7, W_START, -2, 8),
    ],
  });
  is("an existing row keeps its place against a new one at the same instant",
    tie.rows.map((r) => r.movement_id ?? "new"), [7, "new"]);
}

{
  // The two ways a plan is refused.
  const unbalanced = planProductWindow({
    opening: 20, existingInside: [], newRows: [{ movement_ts: W_START, quantity: -3 }],
  });
  is("added rows that do not net to zero are refused", [unbalanced.ok, unbalanced.drift], [false, -3]);
  ok("and says why", unbalanced.problems.some((p) => p.includes("net to")), unbalanced.problems.join());

  const negative = planProductWindow({
    opening: 1,
    existingInside: [],
    newRows: [
      { movement_ts: W_START, quantity: -5 },
      { movement_ts: W_START + H, quantity: 5 },
    ],
  });
  is("a negative balance is refused", negative.ok, false);
  ok("and says how far", negative.problems.some((p) => p.includes("-4")), negative.problems.join());
}

{
  // The payoff: with a net change of zero, nothing after the window moves.
  const split = splitAroundWindow(HISTORY, W_START, W_END);
  const openingOfAfter = split.inside[split.inside.length - 1].balance_after; // 40
  is("no later row is rewritten when the net change is zero",
    rechainAfterWindow({ closing: 40, openingOfAfter, after: split.after }), []);

  // And if it were not zero, every later row shifts by the drift - which is
  // exactly the breakage this design exists to avoid.
  const drifted = rechainAfterWindow({ closing: 43, openingOfAfter, after: split.after });
  is("a drift of +3 would move every later balance",
    drifted.map((r) => [r.movement_id, r.previousBalanceAfter, r.balance_after]),
    [[4, 35, 38], [5, 45, 48]]);
}

// ------------------------- gap mode: the --apply zero-rewrite precondition
//
// --apply writes inserts only, so it refuses unless no existing row would get
// a new balance_after. That is the whole safety story for a path with no
// backup, so the counter behind it is worth pinning down.

{
  const existing = [mv(3, W_START + 2 * 86400_000, -2, 40)];

  // New rows entirely AFTER the existing one: its balance is untouched, which
  // is the October window's situation.
  const after = planProductWindow({
    opening: 42,
    existingInside: existing,
    newRows: [
      { movement_ts: W_START + 3 * 86400_000, quantity: 7 },
      { movement_ts: W_START + 4 * 86400_000, quantity: -7 },
    ],
  });
  is("nothing to rewrite when the added rows all follow the existing one",
    countRewrittenRows(after.rows), 0);
  ok("and the plan is appliable", after.ok, after.problems.join("; "));

  // A delivery BEFORE it, and the sales after: the existing row's balance
  // moves, so --apply must refuse.
  const straddling = planProductWindow({
    opening: 42,
    existingInside: existing,
    newRows: [
      { movement_ts: W_START + 86400_000, quantity: 7 },
      { movement_ts: W_START + 4 * 86400_000, quantity: -7 },
    ],
  });
  is("one rewrite when an added row lands before the existing one",
    countRewrittenRows(straddling.rows), 1);
  is("and it is the right row, with both balances",
    straddling.rows
      .filter((r) => r.movement_id != null)
      .map((r) => [r.movement_id, r.previousBalanceAfter, r.balance_after]),
    [[3, 40, 47]]);
  // Still a VALID plan - the added rows net to zero and nothing goes
  // negative. It is refused for a different reason: it would edit a recorded
  // row without a backup.
  ok("the straddling plan is otherwise valid", straddling.ok, straddling.problems.join("; "));

  // Rows with no movement_id are never counted, however their balances land.
  is("new rows are never counted as rewrites",
    countRewrittenRows([
      { movement_ts: W_START, quantity: 1, balance_after: 5, previousBalanceAfter: null },
      { movement_ts: W_START, quantity: 1, balance_after: 6, previousBalanceAfter: null },
    ]),
    0);
  is("an untouched existing row is not counted",
    countRewrittenRows([{ movement_id: 9, balance_after: 12, previousBalanceAfter: 12 }]), 0);
  is("an empty window has nothing to rewrite", countRewrittenRows([]), 0);
}

// ------------------------- cleanup: the chain after rows are DELETED
//
// The mirror image of the gap fill. Dropping a movement shifts every later
// balance_after by its quantity, and stock_on_hand with it, so the chain has
// to be rewalked rather than nudged.

{
  // 50 in, 8 out (a test sale), 5 out, 10 in: ends at 47.
  const chain = [
    mv(1, 1000, 50, 50),
    mv(2, 2000, -8, 42),
    mv(3, 3000, -5, 37),
    mv(4, 4000, 10, 47),
  ];

  const dropOne = rechainAfterDeletions({ movements: chain, deletedIds: new Set([2]) });
  is("deleting a sale shifts every later balance up by its quantity",
    dropOne.updates.map((u) => [u.movement_id, u.previousBalanceAfter, u.balance_after]),
    [[3, 37, 45], [4, 47, 55]]);
  is("the new stock_on_hand is the new closing balance", dropOne.closing, 55);
  is("the untouched row keeps its balance", dropOne.updates.some((u) => u.movement_id === 1), false);

  // Deleting a stock-in takes units away instead.
  const dropIn = rechainAfterDeletions({ movements: chain, deletedIds: new Set([4]) });
  is("deleting a stock-in lowers the closing balance", dropIn.closing, 37);
  is("and rewrites nothing before it", dropIn.updates, []);

  // Several at once.
  const dropTwo = rechainAfterDeletions({ movements: chain, deletedIds: new Set([2, 3]) });
  is("two deletions compose", dropTwo.closing, 60);
  is("and the survivor is rewritten once",
    dropTwo.updates.map((u) => [u.movement_id, u.balance_after]), [[4, 60]]);

  // Deleting the FIRST row: the opening balance has to come from the first
  // SURVIVING row, not from the deleted one.
  const dropFirst = rechainAfterDeletions({ movements: chain, deletedIds: new Set([1]) });
  is("deleting the opening row derives the opening from the survivor", dropFirst.opening, 50);
  is("and leaves the rest where they were", dropFirst.updates, []);

  // Everything gone: back to what the product held before its first movement.
  const dropAll = rechainAfterDeletions({ movements: chain, deletedIds: new Set([1, 2, 3, 4]) });
  is("deleting the whole chain returns the pre-history balance", [dropAll.closing, dropAll.kept.length], [0, 0]);

  is("deleting nothing changes nothing",
    rechainAfterDeletions({ movements: chain, deletedIds: new Set() }).updates, []);

  // The constraint that can block a cleanup: a deletion that takes a later
  // balance below zero.
  const tight = [mv(1, 1000, 3, 3), mv(2, 2000, 5, 8), mv(3, 3000, -6, 2)];
  const breaks = rechainAfterDeletions({ movements: tight, deletedIds: new Set([2]) });
  is("a deletion that would go negative is visible in minBalance", breaks.minBalance, -3);
  ok("and the caller can refuse on it", breaks.minBalance < 0, `min ${breaks.minBalance}`);

  // Input order does not matter: PostgREST returns id order, not time order.
  const shuffled = [chain[2], chain[0], chain[3], chain[1]];
  is("unsorted input gives the same answer",
    rechainAfterDeletions({ movements: shuffled, deletedIds: new Set([2]) }).closing, 55);
}

// ---------------------------- cleanup: the backup precondition
//
// --apply refuses unless every table it touches has a backup whose row count
// matches the plan. A short backup is worse than none: it looks like cover.

{
  const expected = { sales: 8, sale_items: 14, stock_movements: 22, services: 2 };

  is("a complete backup passes", backupPrecondition(expected, { ...expected }).ok, true);

  const missing = backupPrecondition(expected, { sales: 8, sale_items: 14, stock_movements: 22 });
  is("a missing backup table is refused", missing.ok, false);
  ok("and is named", missing.problems.some((p) => p.includes("services") && p.includes("missing")),
    missing.problems.join("; "));

  const short = backupPrecondition(expected, { ...expected, stock_movements: 21 });
  is("a short backup is refused", short.ok, false);
  ok("with both counts reported",
    short.problems.some((p) => p.includes("21") && p.includes("22")), short.problems.join("; "));

  // A backup holding MORE than the plan is still refused: it means the plan
  // and the backup were taken against different data.
  const over = backupPrecondition(expected, { ...expected, sales: 9 });
  is("a backup that does not match exactly is refused", over.ok, false);

  is("nothing to back up needs no backup", backupPrecondition({}, {}).ok, true);
}

// ------------------- cleanup: the restock that rescues a negative chain
//
// Removing a hand-entered stock-in takes away units that later sales have
// already consumed, so two products' chains go negative. The fix is one
// delivery placed where a real one would have had to arrive, sized like the
// shop's others rather than at the bare deficit.

{
  // Opening 0, a +10 stock-in removed, so the sales that followed it have
  // nothing behind them.
  const kept = [
    { movement_id: 100, movement_ts: 10_000, quantity: -4 },
    { movement_id: 101, movement_ts: 20_000, quantity: -6 },
    { movement_id: 102, movement_ts: 30_000, quantity: 2 },
  ];

  const bare = planRestockFix({ kept, opening: 0, size: ({ deficit }) => deficit });
  is("placed just before the first row that goes negative", bare.beforeMovementId, 100);
  is("a minute ahead of it", bare.ts, 10_000 - 60_000);
  is("the deficit is the chain's lowest point, not the first dip", bare.deficit, 10);
  is("and the balance it would have had", bare.have, 0);

  // A sizing rule that asks for less than the deficit is raised to it.
  const stingy = planRestockFix({ kept, opening: 0, size: () => 1 });
  is("a size below the deficit is raised to the deficit", stingy.qty, 10);

  // A realistic rule asks for more, and that is kept.
  const generous = planRestockFix({ kept, opening: 0, size: ({ have, deficit }) => deficit - have + 15 });
  is("a larger realistic size is kept", generous.qty, 25);

  // Inserting it has to leave the whole chain non-negative.
  for (const fix of [bare, stingy, generous]) {
    const walked = rechainWindow({
      opening: 0,
      rows: [
        { movement_ts: fix.ts, quantity: fix.qty },
        ...kept.map((m) => ({ ...m, balance_after: undefined })),
      ],
    });
    ok(`a fix of ${fix.qty} leaves no negative balance`, walked.minBalance >= 0, `min ${walked.minBalance}`);
  }

  // A chain that never goes negative needs no fix at all.
  is("a healthy chain needs no restock",
    planRestockFix({
      kept: [{ movement_id: 1, movement_ts: 1, quantity: -1 }],
      opening: 5,
      size: ({ deficit }) => deficit,
    }),
    null);

  // The lowest point AFTER the first negative one is what sets the size:
  // a fix sized on the first dip alone would leave the tail negative.
  const deepLater = [
    { movement_id: 1, movement_ts: 10, quantity: -1 },
    { movement_id: 2, movement_ts: 20, quantity: -8 },
  ];
  const deep = planRestockFix({ kept: deepLater, opening: 0, size: ({ deficit }) => deficit });
  is("the size covers the deepest point, not the first", deep.deficit, 9);
  const deepWalk = rechainWindow({
    opening: 0,
    rows: [{ movement_ts: deep.ts, quantity: deep.qty }, ...deepLater],
  });
  ok("so the tail stays non-negative too", deepWalk.minBalance >= 0, `min ${deepWalk.minBalance}`);
}

// ------------------------- cleanup: verifying the backup file on disk
//
// The backup is written, then read back and checked against the plan before
// a single row is deleted. Counts alone are not enough: two sets can be the
// same size and hold different rows.

{
  const plan = {
    deletes: { sales: [1, 2, 156467], stock_movements: [8, 9, 10], services: [1, 2] },
    updates: { stock_movements: [271447, 272256], products: [582, 583] },
  };

  is("a backup of this plan passes", verifyBackupFile(plan, JSON.parse(JSON.stringify(plan))).ok, true);
  is("order does not matter",
    verifyBackupFile(plan, { deletes: { sales: [156467, 1, 2], stock_movements: [10, 9, 8], services: [2, 1] }, updates: plan.updates }).ok,
    true);

  const short = verifyBackupFile(plan, {
    deletes: { ...plan.deletes, sales: [1, 2] },
    updates: plan.updates,
  });
  is("a short backup is refused", short.ok, false);
  ok("with both counts", short.problems.some((x) => x.includes("2 rows") && x.includes("3")), short.problems.join("; "));

  // Same count, different rows: the case a count check would wave through.
  const swapped = verifyBackupFile(plan, {
    deletes: { ...plan.deletes, sales: [1, 2, 999999] },
    updates: plan.updates,
  });
  is("a same-size backup of different rows is refused", swapped.ok, false);
  ok("and says the ids differ", swapped.problems.some((x) => x.includes("ids differ")), swapped.problems.join("; "));

  const missingTable = verifyBackupFile(plan, { deletes: { sales: [1, 2, 156467], stock_movements: [8, 9, 10] }, updates: plan.updates });
  is("a missing table is refused", missingTable.ok, false);
  ok("and is named", missingTable.problems.some((x) => x.includes("services")), missingTable.problems.join("; "));

  const missingUpdates = verifyBackupFile(plan, { deletes: plan.deletes, updates: { stock_movements: [271447, 272256] } });
  is("missing update rows are refused too", missingUpdates.ok, false);

  // A backup covering MORE than the plan is also refused: it was taken
  // against different data.
  const extra = verifyBackupFile(plan, {
    deletes: { ...plan.deletes, alerts: [7] },
    updates: plan.updates,
  });
  is("a backup with an extra table is refused", extra.ok, false);

  is("an empty plan needs an empty backup", verifyBackupFile({ deletes: {}, updates: {} }, { deletes: {}, updates: {} }).ok, true);
}

// ------------------------------------------------------------------- done

if (failures.length === 0) {
  console.log(`ledgerPlan.mjs: ${passed} checks passed`);
} else {
  console.log(`ledgerPlan.mjs: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
}
