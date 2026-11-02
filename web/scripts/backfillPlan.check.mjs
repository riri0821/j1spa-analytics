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
import { makeRand, manilaParts, STORE_CLOSE_HOUR, STORE_OPEN_HOUR } from "./lib/seedlib.mjs";

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

// ------------------------------------------------------------------- done

if (failures.length === 0) {
  console.log(`ledgerPlan.mjs: ${passed} checks passed`);
} else {
  console.log(`ledgerPlan.mjs: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
}
