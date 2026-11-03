// Unit checks for src/lib/ledger.js. Plain node, no test runner and no
// dependencies - the ledger is pure functions over rows, so it can be
// checked without a database or a browser:
//
//   npm run check:ledger
//
// Lives outside src/ so Next never bundles it.
import {
  LEDGER_PAGE_SIZE,
  buildLedger,
  clampLedgerPage,
  deriveOpeningBalance,
  describeMovement,
  ledgerPageCount,
  paginateLedger,
} from "../src/lib/ledger.js";

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

// -------------------------------------------------------------------- paging

is("ledger pages hold ten movement rows", LEDGER_PAGE_SIZE, 10);

// A product that starts at 2000 and is sold one unit an hour, so row i's
// balance_after is 2000 - (i + 1) and any page boundary can be read by eye.
function seriesLedger(n) {
  const movements = [];
  for (let i = 0; i < n; i += 1) {
    movements.push(mv({
      movement_id: i + 1,
      movement_ts: new Date(Date.UTC(2026, 0, 1, 2) + i * 3600_000).toISOString(),
      movement_type: "sale_decrement",
      reference: `sale:${i + 1}`,
      quantity: -1,
      balance_after: 2000 - (i + 1),
    }));
  }
  return buildLedger({
    product: { stock_on_hand: 2000 - n, created_at: "2025-12-01T03:00:00Z" },
    movements, from: null, to: null, names: NAMES,
  });
}

const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---- page counts
is("page count: an empty period is still one page", ledgerPageCount(0), 1);
is("page count: exactly ten rows fit on one", ledgerPageCount(10), 1);
is("page count: eleven rows need two", ledgerPageCount(11), 2);
is("page count: 1,165 rows need 117", ledgerPageCount(1165), 117);

// ---- clamping. Anything that is not a whole number falls back to the
// default view (the last page); a real number out of range is pulled to the
// nearer end rather than rendering an empty table.
is("clamp: no ?page at all opens the last page", clampLedgerPage(undefined, 1165), 117);
is("clamp: a blank ?page= is the same as none", clampLedgerPage("", 1165), 117);
is("clamp: non-numeric", clampLedgerPage("abc", 1165), 117);
is("clamp: fractional", clampLedgerPage("2.5", 1165), 117);
is("clamp: a repeated ?page= arriving as an array", clampLedgerPage(["3"], 1165), 117);
is("clamp: zero is pulled up to the first page", clampLedgerPage("0", 1165), 1);
is("clamp: a negative is pulled up to the first page", clampLedgerPage("-4", 1165), 1);
is("clamp: past the last page is pulled back to it", clampLedgerPage("9999", 1165), 117);
is("clamp: a page in range is left alone", clampLedgerPage("42", 1165), 42);
is("clamp: an empty period only ever has page 1",
  [clampLedgerPage("7", 0), clampLedgerPage(undefined, 0)], [1, 1]);

// ---- 0 rows: the empty-period view still has to render a card
const zero = paginateLedger(seriesLedger(0), undefined);
is("0 rows: one page, nothing on it", [zero.page, zero.totalPages, zero.rows.length], [1, 1, 0]);
is("0 rows: the row count reads 0-0 of 0", [zero.rangeStart, zero.rangeEnd, zero.total], [0, 0, 0]);
// First and last at once, so the page keeps both the beginning-balance row
// and the totals row - exactly what it showed before paging existed.
is("0 rows: it is both the first and the last page", [zero.isFirstPage, zero.isLastPage], [true, true]);
is("0 rows: no carry lines", [zero.broughtForward, zero.carriedForward], [null, null]);

// ---- exactly 10 rows: the boundary that must not spill into a second page
const ten = seriesLedger(10);
const tenView = paginateLedger(ten, undefined);
is("10 rows: a single page", [tenView.page, tenView.totalPages], [1, 1]);
is("10 rows: the whole set is on it",
  [tenView.rows.length, tenView.rangeStart, tenView.rangeEnd], [10, 1, 10]);
is("10 rows: a one-page card needs no carry lines",
  [tenView.broughtForward, tenView.carriedForward], [null, null]);

// ---- 11 rows: the smallest card that carries a balance across a break
const eleven = seriesLedger(11);
const e1 = paginateLedger(eleven, 1);
const e2 = paginateLedger(eleven, 2);
is("11 rows: default opens on the last page", paginateLedger(eleven, undefined).page, 2);
is("11 rows: page 1 holds ten rows and is not the last",
  [e1.rows.length, e1.rangeStart, e1.rangeEnd, e1.isLastPage], [10, 1, 10, false]);
is("11 rows: page 2 holds the eleventh on its own",
  [e2.rows.length, e2.rangeStart, e2.rangeEnd], [1, 11, 11]);
is("11 rows: page 1 carries forward its own last balance", e1.carriedForward, e1.rows[9].balance);
is("11 rows: page 2 brings forward page 1's last balance", e2.broughtForward, e1.rows[9].balance);
is("11 rows: the first page has no brought-forward and the last no carried-forward",
  [e1.broughtForward, e2.carriedForward], [null, null]);

// ---- 1,165 rows: a long-lived product, past the 1000-row PostgREST cap
const long = seriesLedger(1165);
const totalsBeforePaging = [long.totalIn, long.totalOut, long.endingBalance];

const lastView = paginateLedger(long, undefined);
is("1,165 rows: 117 pages, default opens on the last", [lastView.page, lastView.totalPages], [117, 117]);
is("1,165 rows: the last page holds the five left over",
  [lastView.rows.length, lastView.rangeStart, lastView.rangeEnd], [5, 1161, 1165]);
is("1,165 rows: the last page takes the totals, not a carried-forward",
  [lastView.isLastPage, lastView.carriedForward], [true, null]);
is("1,165 rows: the last page brings forward row 1,160's balance",
  lastView.broughtForward, long.rows[1159].balance);
is("1,165 rows: out-of-range pages clamp to the ends",
  [paginateLedger(long, "9999").page, paginateLedger(long, "-1").page], [117, 1]);

const mid = paginateLedger(long, "58");
is("1,165 rows: a middle page is a full slice",
  [mid.rows.length, mid.rangeStart, mid.rangeEnd], [10, 571, 580]);
is("1,165 rows: a middle page stays oldest-first", mid.rows.map((r) => r.movementId), ids(571, 580));
is("1,165 rows: a middle page carries a balance in and out",
  [mid.broughtForward, mid.carriedForward], [long.rows[569].balance, long.rows[579].balance]);
is("1,165 rows: a middle page is neither first nor last",
  [mid.isFirstPage, mid.isLastPage], [false, false]);

// Walked end to end, the pages tile the period exactly once and the balance
// chain is unbroken: every page opens on the figure the one before it closed
// on, so the running balance still reads top to bottom across the whole card.
const pages = Array.from({ length: 117 }, (_, i) => paginateLedger(long, i + 1));
is("1,165 rows: the pages tile the full row set, in order",
  pages.flatMap((p) => p.rows.map((r) => r.movementId)), long.rows.map((r) => r.movementId));
is("1,165 rows: every brought-forward is the page before's carried-forward",
  pages.slice(1).filter((p, i) => p.broughtForward !== pages[i].carriedForward).length, 0);
is("1,165 rows: only the first page lacks a brought-forward",
  pages.filter((p) => p.broughtForward === null).map((p) => p.page), [1]);
is("1,165 rows: only the last page lacks a carried-forward",
  pages.filter((p) => p.carriedForward === null).map((p) => p.page), [117]);

// ---- totals are period-wide, whatever page is on screen
is("paging leaves the built ledger's rows in place", long.rows.length, 1165);
is("paging leaves the totals untouched", [long.totalIn, long.totalOut, long.endingBalance], totalsBeforePaging);
is("the totals cover the whole period", [long.totalIn, long.totalOut, long.endingBalance], [0, 1165, 835]);
// ...and that really is more than the page itself accounts for: ten units
// left on this page against 1,165 over the period.
is("a page's own movements are only a slice of the period total",
  mid.rows.reduce((n, r) => n + (r.quantityOut ?? 0), 0), 10);
is("the beginning balance is still the period's own", long.beginningBalance, 2000);

// ------------------------------------------------------------------- report

if (failures.length === 0) {
  console.log(`ledger.js: ${passed} checks passed`);
} else {
  console.log(`ledger.js: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
}
