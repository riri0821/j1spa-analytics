// Unit checks for src/lib/alertsBatch.js - the test that decides whether a
// Decision Support run is worth writing to `alerts`. Plain node, no test
// runner and no dependencies:
//
//   npm run check:alerts
//
// The property that matters: two runs give the same fingerprint exactly when
// they give the same ADVICE. Everything else about a run - stock counts,
// forecasts, row order, which spelling of the field names it happens to be
// holding - must not register as a change, because re-recording on every
// run is what grew the table to ~149,000 near-identical rows.
//
// Lives outside src/ so Next never bundles it.
import {
  ALERT_INSERT_CHUNK,
  advisoryFingerprint,
  chunkRows,
  sameAdvisorySet,
} from "../src/lib/alertsBatch.js";

let passed = 0;
const failures = [];

function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

// An advisory as evaluateDecisionSupport() builds it: only three of these
// fields take part in the fingerprint, the rest are along for the ride.
const adv = (productId, type, severity, extra = {}) => ({
  productId,
  sku: `SKU-${productId}`,
  name: `Product ${productId}`,
  type,
  severity,
  onHand: 10,
  reorderPoint: 5,
  forecast30d: 12,
  daysToDepletion: 25,
  ...extra,
});

// The same advice as it comes back out of `alerts`.
const row = (product_id, alert_type, severity, extra = {}) => ({
  product_id,
  alert_type,
  severity,
  sku: `SKU-${product_id}`,
  stock_on_hand: 10,
  ...extra,
});

const BASE = [
  adv(1, "low_stock", "critical"),
  adv(2, "demand_spike", "warning"),
  adv(3, "overstock", "warning"),
];

// ------------------------------------------------------------ same advice

is("a set equals itself", sameAdvisorySet(BASE, BASE), true);

// Order is not advice. The engine walks products in product_id order and a
// batch is read back in alert_id order, which need not agree.
is("the same set in a different order is equal",
  sameAdvisorySet(BASE, [BASE[2], BASE[0], BASE[1]]), true);
is("reversed is equal", sameAdvisorySet(BASE, [...BASE].reverse()), true);

// The two field spellings must meet in the middle, or every run would look
// different from the batch it is compared against.
is("fresh advisories equal the same advice read back out of alerts",
  sameAdvisorySet(BASE, [
    row(3, "overstock", "warning"),
    row(1, "low_stock", "critical"),
    row(2, "demand_spike", "warning"),
  ]),
  true);
// product_id arrives from PostgREST as a number; a string id must still match.
is("a string product_id matches the same numeric one",
  sameAdvisorySet([adv(1, "low_stock", "critical")], [row("1", "low_stock", "critical")]), true);

// The whole point: stock moves constantly without the advice changing.
is("a changed stock count alone is equal",
  sameAdvisorySet(BASE, [
    adv(1, "low_stock", "critical", { onHand: 0 }),
    adv(2, "demand_spike", "warning", { onHand: 998 }),
    adv(3, "overstock", "warning", { onHand: 1 }),
  ]),
  true);
is("changed forecasts and days-to-depletion alone are equal",
  sameAdvisorySet(BASE, [
    adv(1, "low_stock", "critical", { forecast30d: 0, daysToDepletion: null }),
    adv(2, "demand_spike", "warning", { forecast30d: 4000, daysToDepletion: 0.5 }),
    adv(3, "overstock", "warning", { forecast30d: 1, daysToDepletion: 9999 }),
  ]),
  true);
// Every other field a row carries is equally irrelevant.
is("a renamed product or a rewritten recommendation is equal",
  sameAdvisorySet(BASE, [
    adv(1, "low_stock", "critical", { name: "Renamed", recommendation: "Reorder now please" }),
    adv(2, "demand_spike", "warning", { reorderPoint: 999 }),
    adv(3, "overstock", "warning", { sku: "MOVED-3" }),
  ]),
  true);

// ----------------------------------------------------------- real changes

is("a changed alert_type differs",
  sameAdvisorySet(BASE, [adv(1, "low_stock", "critical"), adv(2, "overstock", "warning"), adv(3, "overstock", "warning")]),
  false);
is("a changed severity differs",
  sameAdvisorySet(BASE, [adv(1, "low_stock", "warning"), adv(2, "demand_spike", "warning"), adv(3, "overstock", "warning")]),
  false);
is("an added product differs", sameAdvisorySet(BASE, [...BASE, adv(4, "low_stock", "critical")]), false);
is("a removed product differs", sameAdvisorySet(BASE, BASE.slice(0, 2)), false);
// Same three products, same three types, but on different products.
is("the same advice moved between products differs",
  sameAdvisorySet(BASE, [adv(1, "demand_spike", "warning"), adv(2, "low_stock", "critical"), adv(3, "overstock", "warning")]),
  false);
is("an emptied set differs from a non-empty one", sameAdvisorySet(BASE, []), false);
is("two empty sets are equal", sameAdvisorySet([], []), true);
// loadLatestBatch returns null for an empty table; the caller treats that as
// "no previous batch" rather than passing it in, but the helper must not
// throw if it ever is.
is("a missing set reads as empty", advisoryFingerprint(undefined), "");
is("a null set reads as empty", advisoryFingerprint(null), "");

// --------------------------------------------------- the fingerprint itself

is("one advisory's fingerprint", advisoryFingerprint([adv(7, "low_stock", "critical")]), "7|low_stock|critical");
is("fingerprints are sorted, one triple per line",
  advisoryFingerprint([adv(2, "overstock", "warning"), adv(1, "low_stock", "critical")]),
  "1|low_stock|critical\n2|overstock|warning");
// Sorted as strings, so not numeric order - it only has to be the SAME order
// every time, which is what these two assertions together pin down.
is("string sort order is stable, whichever way the input came",
  advisoryFingerprint([adv(10, "low_stock", "critical"), adv(9, "low_stock", "critical")]),
  advisoryFingerprint([adv(9, "low_stock", "critical"), adv(10, "low_stock", "critical")]));
// A duplicate triple is not collapsed: a product cannot hold two advisories
// (one finalType or none), so a repeat would itself be a real difference.
is("a duplicated triple is not collapsed",
  advisoryFingerprint([adv(1, "low_stock", "critical"), adv(1, "low_stock", "critical")]),
  "1|low_stock|critical\n1|low_stock|critical");

// ------------------------------------------------------------- chunking

is("the insert chunk is PostgREST's page size", ALERT_INSERT_CHUNK, 1000);
is("a batch under the chunk size is one chunk", chunkRows(new Array(360).fill(0)).length, 1);
is("an empty batch is no chunks", chunkRows([]).length, 0);
is("exactly one chunk's worth is one chunk", chunkRows(new Array(1000).fill(0)).length, 1);
is("one row over is two chunks", chunkRows(new Array(1001).fill(0)).map((c) => c.length), [1000, 1]);
is("a big batch chunks evenly", chunkRows(new Array(2500).fill(0)).map((c) => c.length), [1000, 1000, 500]);
// The chunks must put every row through exactly once, in order.
{
  const rows = Array.from({ length: 2500 }, (_, i) => i);
  is("chunks rejoin to the original batch", chunkRows(rows).flat(), rows);
  is("a smaller chunk size still tiles the batch", chunkRows(rows, 7).flat(), rows);
}

// ------------------------------------------------------------------ done

if (failures.length === 0) {
  console.log(`alertsBatch.js: ${passed} checks passed`);
} else {
  console.log(`alertsBatch.js: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
}
