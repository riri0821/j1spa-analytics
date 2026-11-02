// Unit checks for src/lib/ledger.js. Plain node, no test runner and no
// dependencies - the ledger is pure functions over rows, so it can be
// checked without a database or a browser:
//
//   npm run check:ledger
//
// Lives outside src/ so Next never bundles it.
import { buildLedger, deriveOpeningBalance, describeMovement } from "../src/lib/ledger.js";

let passed = 0;
const failures = [];

function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

const NAMES = new Map([["u1", "Tamara"]]);
const mv = (o) => ({ movement_id: 1, movement_ts: "2026-10-01T02:00:00Z", user_id: "u1", ...o });

// ---------------------------------------------------------------- particulars

is("stock_in with a reference", describeMovement(mv({ movement_type: "stock_in", reference: "DR-1001" })),
  "Replenished stock – DR-1001");
is("stock_in with no reference", describeMovement(mv({ movement_type: "stock_in", reference: null })),
  "Replenished stock");

// api/products/save writes the opening row as an 'adjustment' carrying
// reference 'opening' AND note 'opening stock'. The note must not win here,
// or the first line of every new product's ledger reads "Stock correction".
is("opening stock row", describeMovement(mv({ movement_type: "adjustment", reference: "opening", note: "opening stock" })),
  "Opening stock");
is("opening stock row, note absent", describeMovement(mv({ movement_type: "adjustment", reference: "opening", note: null })),
  "Opening stock");
// ...and an ordinary correction still reads as one.
is("adjustment with a note", describeMovement(mv({ movement_type: "adjustment", reference: null, note: "recount" })),
  "Stock correction – recount");
is("adjustment with a reference only", describeMovement(mv({ movement_type: "adjustment", reference: "spoilage", note: null })),
  "Stock correction – spoilage");
is("bare adjustment", describeMovement(mv({ movement_type: "adjustment", reference: null, note: null })),
  "Stock correction");

is("sale", describeMovement(mv({ movement_type: "sale_decrement", reference: "sale:77" })),
  "Sold – Sale #77");
is("sale edited, re-recorded", describeMovement(mv({ movement_type: "sale_decrement", reference: "edit:78" })),
  "Sale #78 edited – re-recorded");
is("sale voided", describeMovement(mv({ movement_type: "void_increment", reference: "undo:77" })),
  "Sale #77 voided – returned to stock");
is("sale edited, previous qty returned", describeMovement(mv({ movement_type: "void_increment", reference: "edit:78" })),
  "Sale #78 edited – previous qty returned");

// Never blank, whatever turns up.
is("unrecognised reference", describeMovement(mv({ movement_type: "sale_decrement", reference: "weird:9" })),
  "sale_decrement – weird:9");
is("unrecognised type", describeMovement(mv({ movement_type: "transfer", reference: null })), "transfer");

// ------------------------------------------------------------ opening balance

// Case 1: created on the Products screen with opening stock 40. The
// 'opening' movement is what puts the stock on the shelf, so the product
// genuinely started at 0.
const createdOnScreen = [
  mv({ movement_id: 1, movement_type: "adjustment", reference: "opening", note: "opening stock",
       quantity: 40, balance_after: 40 }),
  mv({ movement_id: 2, movement_ts: "2026-10-05T02:00:00Z", movement_type: "sale_decrement",
       reference: "sale:5", quantity: -6, balance_after: 34 }),
];
is("opening balance, product created with opening stock",
  deriveOpeningBalance({ stock_on_hand: 34 }, createdOnScreen), 0);

// Case 2: imported product - stock_on_hand was set directly, no movement
// row records it, so the opening figure comes out of the first real event.
const imported = [
  mv({ movement_id: 1, movement_type: "sale_decrement", reference: "sale:1", quantity: -4, balance_after: 96 }),
  mv({ movement_id: 2, movement_ts: "2026-10-05T02:00:00Z", movement_type: "stock_in",
       reference: "DR-7", supplier: "Acme", quantity: 10, balance_after: 106 }),
];
is("opening balance, imported product", deriveOpeningBalance({ stock_on_hand: 106 }, imported), 100);

// Case 3: nothing has ever happened to it.
is("opening balance, no movements", deriveOpeningBalance({ stock_on_hand: 14 }, []), 14);

// -------------------------------------------------------------- built ledgers

const screenProduct = { stock_on_hand: 34, created_at: "2026-09-28T03:00:00Z" };
const screenLedger = buildLedger({ product: screenProduct, movements: createdOnScreen, from: null, to: null, names: NAMES });
is("created-with-opening: beginning balance is 0", screenLedger.beginningBalance, 0);
is("created-with-opening: first row is the opening stock",
  [screenLedger.rows[0].particulars, screenLedger.rows[0].quantityIn, screenLedger.rows[0].balance],
  ["Opening stock", 40, 40]);
is("created-with-opening: totals", [screenLedger.totalIn, screenLedger.totalOut, screenLedger.endingBalance], [40, 6, 34]);
is("created-with-opening: ending balance matches stock_on_hand",
  screenLedger.endingBalance, screenProduct.stock_on_hand);

const importedLedger = buildLedger({
  product: { stock_on_hand: 106, created_at: "2026-01-02T03:00:00Z" },
  movements: imported, from: null, to: null, names: NAMES,
});
is("imported: beginning balance is the derived opening", importedLedger.beginningBalance, 100);
is("imported: totals", [importedLedger.totalIn, importedLedger.totalOut, importedLedger.endingBalance], [10, 4, 106]);
is("imported: supplier shows on the stock_in row only",
  importedLedger.rows.map((r) => r.supplier), ["", "Acme"]);

// Full history with a void and an edit pair, to check ordering and signs.
const product = { stock_on_hand: 14, created_at: "2026-09-01T03:00:00Z" };
const history = [
  mv({ movement_id: 1, movement_type: "stock_in", reference: "DR-1001", supplier: "Acme", quantity: 5, balance_after: 15 }),
  mv({ movement_id: 2, movement_ts: "2026-10-08T06:15:00Z", movement_type: "sale_decrement", reference: "sale:77", quantity: -3, balance_after: 12 }),
  mv({ movement_id: 3, movement_ts: "2026-10-09T01:00:00Z", movement_type: "void_increment", reference: "undo:77", quantity: 3, balance_after: 15, user_id: null }),
  mv({ movement_id: 4, movement_ts: "2026-10-20T01:00:00Z", movement_type: "void_increment", reference: "edit:78", quantity: 3, balance_after: 18 }),
  mv({ movement_id: 5, movement_ts: "2026-10-20T01:00:01Z", movement_type: "sale_decrement", reference: "edit:78", quantity: -4, balance_after: 14 }),
];

const all = buildLedger({ product, movements: history, from: null, to: null, names: NAMES });
is("all time: opening balance", all.beginningBalance, 10);
is("all time: totals", [all.totalIn, all.totalOut, all.endingBalance], [11, 7, 14]);
is("all time: a null user_id reads as Former staff", all.rows[2].recordedBy, "Former staff");
is("all time: a known user_id reads as their name", all.rows[0].recordedBy, "Tamara");

// Manila, not UTC: 2026-10-08T06:15Z is 2:15 PM on Oct 8 in Manila, and
// 2026-10-09T01:00Z is 9:00 AM on Oct 9 - both inside an Oct 8-9 filter.
const window = buildLedger({ product, movements: history, from: "2026-10-08", to: "2026-10-09", names: NAMES });
is("Manila window: rows in range", window.rows.map((r) => r.dateLabel),
  ["Oct 08, 2026 2:15 PM", "Oct 09, 2026 9:00 AM"]);
is("Manila window: beginning balance is the last balance before From", window.beginningBalance, 15);
is("Manila window: totals", [window.totalIn, window.totalOut, window.endingBalance], [3, 3, 15]);
is("Manila window: as-of label is the To date", window.asOfLabel, "Oct 09, 2026");

// A UTC reading would put movement 3 (01:00Z Oct 9) inside an Oct 8 window.
const oneDay = buildLedger({ product, movements: history, from: "2026-10-08", to: "2026-10-08", names: NAMES });
is("single Manila day excludes the next day's early-UTC row", oneDay.rows.length, 1);

const empty = buildLedger({ product, movements: history, from: "2026-10-10", to: "2026-10-11", names: NAMES });
is("empty window: still carries a beginning balance", empty.beginningBalance, 15);
is("empty window: no rows, balance unchanged", [empty.rows.length, empty.endingBalance], [0, 15]);

const none = buildLedger({ product, movements: [], from: null, to: null, names: NAMES });
is("no movements: beginning equals ending equals stock_on_hand",
  [none.beginningBalance, none.endingBalance], [14, 14]);

// ------------------------------------------------------------------- report

if (failures.length === 0) {
  console.log(`ledger.js: ${passed} checks passed`);
} else {
  console.log(`ledger.js: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
}
