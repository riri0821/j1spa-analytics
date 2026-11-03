/**
 * Builds the per-product stock ledger (stock card) shown on /ledger/[sku]:
 * opening balance, one row per stock movement, and the closing totals.
 * Read-only - everything here is derived from rows already written by
 * confirm_sale / undo_sale / edit_sale / record_stock_movements, plus the
 * opening row api/products/save writes for a new product. Also paginates
 * those rows into ledger-card pages (see LEDGER_PAGE_SIZE below).
 *
 * Checked by web/scripts/ledger.check.mjs (`npm run check:ledger`).
 */

// The Philippines is UTC+8 all year (no DST since 1978), so a calendar date
// from the filter inputs becomes an instant by pinning that offset. Letting
// the server's own timezone decide (UTC on Vercel) would shift every day
// boundary by eight hours and file the first 8 hours of each Philippine day
// under the day before.
const MANILA_OFFSET = "+08:00";

const MANILA_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "2-digit",
  year: "numeric",
});
const MANILA_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  hour: "numeric",
  minute: "2-digit",
});

// Start of a YYYY-MM-DD Manila day, as an instant PostgREST/Date both accept.
export function manilaDayStart(date) {
  return `${date}T00:00:00${MANILA_OFFSET}`;
}

function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// "Oct 08, 2026 2:15 PM" - the two formatters are joined by hand because
// en-US would otherwise put a comma between the date and the time.
export function formatManilaDateTime(ts) {
  const d = new Date(ts);
  return `${MANILA_DATE.format(d)} ${MANILA_TIME.format(d)}`;
}

export function formatManilaDate(ts) {
  return MANILA_DATE.format(new Date(ts));
}

// Only YYYY-MM-DD is accepted; anything else (a truncated or hand-edited
// query string) is treated as "no filter" rather than as a broken range.
export function parseDateParam(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function saleIdFrom(reference, prefix) {
  return reference.startsWith(`${prefix}:`) ? reference.slice(prefix.length + 1) : null;
}

/**
 * Human-readable "Particulars" for one movement. Falls back to the raw
 * movement_type and reference so an unrecognised combination still reads as
 * something rather than as a blank cell.
 */
export function describeMovement(movement) {
  const reference = (movement.reference ?? "").trim();
  const note = (movement.note ?? "").trim();

  switch (movement.movement_type) {
    case "stock_in":
      // Stock-in references are free text typed on the Stock In screen.
      return reference ? `Replenished stock – ${reference}` : "Replenished stock";
    case "adjustment": {
      // A product created on the Products screen with a non-zero opening
      // stock gets one of these as its very first row (reference 'opening',
      // note 'opening stock' - see api/products/save). It is the stock
      // arriving, not a correction to something that came before it.
      if (reference === "opening") return "Opening stock";
      const detail = note || reference;
      return detail ? `Stock correction – ${detail}` : "Stock correction";
    }
    case "sale_decrement": {
      const sold = saleIdFrom(reference, "sale");
      if (sold) return `Sold – Sale #${sold}`;
      // edit_sale() voids the old quantities, then re-records the new ones.
      const edited = saleIdFrom(reference, "edit");
      if (edited) return `Sale #${edited} edited – re-recorded`;
      break;
    }
    case "void_increment": {
      const voided = saleIdFrom(reference, "undo");
      if (voided) return `Sale #${voided} voided – returned to stock`;
      const edited = saleIdFrom(reference, "edit");
      if (edited) return `Sale #${edited} edited – previous qty returned`;
      break;
    }
    default:
      break;
  }

  return [movement.movement_type, reference].filter(Boolean).join(" – ");
}

/**
 * The balance the product held before its first recorded movement. One
 * formula covers the two ways a product can start out, because both leave
 * the same trace in the first movement - the balance it landed on, minus
 * the change it made:
 *
 *   - Created on the Products screen with opening stock: api/products/save
 *     writes an 'adjustment' row (reference 'opening') carrying the whole
 *     opening quantity, so this returns 0 - correct, because the product
 *     really did start empty and that row is the stock arriving. It shows
 *     up as the ledger's first IN line.
 *   - Imported, or created with an opening stock of 0: stock_on_hand was
 *     set directly and no movement row records it, so the figure is
 *     recovered from whatever movement came first instead.
 *
 * With no movements at all, nothing has happened since the product was
 * created, so its current stock is also its opening balance.
 */
export function deriveOpeningBalance(product, movements) {
  const first = movements[0];
  if (!first) return product.stock_on_hand;
  return first.balance_after - first.quantity;
}

/**
 * @param movements every movement for the product, oldest first - the rows
 *   before `from` are what give the period its beginning balance, so the
 *   range is applied here rather than in the query.
 * @param names Map of profile id -> full name; a null/unknown user_id reads
 *   as "Former staff", the same convention as the sales and stock-in logs.
 */
export function buildLedger({ product, movements, from, to, names }) {
  const openingBalance = deriveOpeningBalance(product, movements);

  const fromMs = from ? new Date(manilaDayStart(from)).getTime() : null;
  // Exclusive: the "To" day itself is part of the period, so the cut is the
  // start of the following Manila day.
  const toMs = to ? new Date(manilaDayStart(addDays(to, 1))).getTime() : null;

  const before = [];
  const inRange = [];
  for (const m of movements) {
    const ts = new Date(m.movement_ts).getTime();
    if (fromMs !== null && ts < fromMs) {
      before.push(m);
    } else if (toMs === null || ts < toMs) {
      inRange.push(m);
    }
  }

  const last = before[before.length - 1];
  const beginningBalance = last ? last.balance_after : openingBalance;

  let totalIn = 0;
  let totalOut = 0;
  const rows = inRange.map((m) => {
    if (m.quantity > 0) totalIn += m.quantity;
    else totalOut += -m.quantity;

    return {
      movementId: m.movement_id,
      dateLabel: formatManilaDateTime(m.movement_ts),
      particulars: describeMovement(m),
      // Snapshotted on 'stock_in' rows only; null for every other type.
      supplier: m.movement_type === "stock_in" ? (m.supplier ?? "") : "",
      quantityIn: m.quantity > 0 ? m.quantity : null,
      quantityOut: m.quantity < 0 ? -m.quantity : null,
      balance: m.balance_after,
      recordedBy: (m.user_id && names.get(m.user_id)) || "Former staff",
    };
  });

  const endingBalance = inRange.length > 0 ? inRange[inRange.length - 1].balance_after : beginningBalance;

  return {
    openingBalance,
    beginningBalance,
    // No "From" date means the period starts where the product itself did.
    beginningDateLabel: formatManilaDate(from ? manilaDayStart(from) : product.created_at),
    rows,
    totalIn,
    totalOut,
    endingBalance,
    asOfLabel: formatManilaDate(to ? manilaDayStart(to) : new Date()),
  };
}

// ---------------------------------------------------------------------- paging

/**
 * Movement rows per page on /ledger/[sku]. Every balance and total is still
 * computed from the whole period (see buildLedger) - paging only decides how
 * much of `ledger.rows` is rendered at once.
 */
export const LEDGER_PAGE_SIZE = 10;

export function ledgerPageCount(rowCount, pageSize = LEDGER_PAGE_SIZE) {
  // An empty period is still one page: it has a beginning balance and a
  // totals line to show, so there is never a "page 0".
  return Math.max(1, Math.ceil(rowCount / pageSize));
}

function pageNumberFrom(value) {
  if (typeof value === "number") return value;
  // A blank ?page= is "no page asked for", not page 0 - Number("") is 0.
  if (typeof value !== "string" || value.trim() === "") return NaN;
  return Number(value);
}

/**
 * The page to actually render for a `?page=` value.
 *
 * No value, or one that is not a whole number at all ('abc', '2.5', a
 * repeated param arriving as an array), falls back to the default view: the
 * LAST page, so the link lands on the most recent activity. A real number
 * outside the range is clamped to the nearest end - 0 and negatives to the
 * first page, anything past the end to the last one - so a stale bookmark
 * still renders a ledger instead of an empty table.
 */
export function clampLedgerPage(value, rowCount, pageSize = LEDGER_PAGE_SIZE) {
  const totalPages = ledgerPageCount(rowCount, pageSize);
  const asked = pageNumberFrom(value);
  if (!Number.isInteger(asked)) return totalPages;
  return Math.min(Math.max(asked, 1), totalPages);
}

/**
 * Slices one page out of a built ledger and works out the carry lines that
 * make the pages read like a manual stock card:
 *
 *   - `broughtForward` - the balance the previous page ended on, shown at the
 *     top of every page but the first (the first page shows the period's
 *     beginning balance instead).
 *   - `carriedForward` - the balance this page ends on, shown at the bottom of
 *     every page but the last (the last page shows the period totals instead).
 *
 * Both are read off the movement rows themselves, so they are the same
 * balance_after figures the movement lines above and below them show.
 *
 * @param ledger the result of buildLedger - only `rows` is read.
 * @param page the raw `?page=` value; clamped here, never trusted.
 */
export function paginateLedger(ledger, page, pageSize = LEDGER_PAGE_SIZE) {
  const all = ledger.rows;
  const total = all.length;
  const totalPages = ledgerPageCount(total, pageSize);
  const current = clampLedgerPage(page, total, pageSize);

  const start = (current - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const rows = all.slice(start, end);

  const previousRow = start > 0 ? all[start - 1] : null;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
  const isLastPage = current === totalPages;

  return {
    page: current,
    totalPages,
    pageSize,
    rows,
    total,
    // 1-based and inclusive, for "Rows 11-20 of 1,165". An empty period has
    // no rows to number, so it reads 0-0.
    rangeStart: total === 0 ? 0 : start + 1,
    rangeEnd: end,
    isFirstPage: current === 1,
    isLastPage,
    broughtForward: previousRow ? previousRow.balance : null,
    carriedForward: !isLastPage && lastRow ? lastRow.balance : null,
  };
}
