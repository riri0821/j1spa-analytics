// The backward balance walk, as pure functions over plain objects so it can
// be unit-tested without a database (see scripts/backfillPlan.check.mjs).
//
// Why backwards: products.stock_on_hand is the one figure that is certainly
// correct and must not change, and the ledger's integrity check compares the
// final balance against it. Walking forwards from a guessed opening balance
// would land somewhere else and need fudging at the end; walking backwards
// from stock_on_hand makes the final balance exact by construction and
// pushes all the uncertainty into the opening balance, where it belongs.

import { addDaysMs, deliveryReceipt, manilaSameDayAt, randInt, STORE_CLOSE_HOUR, STORE_OPEN_HOUR } from "./seedlib.mjs";

/**
 * Highest balance a product is allowed to reach going backwards before a
 * restock is inserted to absorb the excess. Without a ceiling the backward
 * walk would accumulate every unit the product ever sold (six years of it)
 * into one absurd opening balance.
 */
export function stockCeiling(product, typicalMonthlyUnits = 0) {
  const rp = Math.max(0, Number(product.reorder_point) || 0);
  return Math.max(rp * 3, Math.round(typicalMonthlyUnits * 2), 10);
}

/** Where a restock leaves the shelf when read forwards: around the reorder
 *  point, which is what a reorder point is for. */
export function restockLowPoint(product, rand) {
  const rp = Math.max(0, Number(product.reorder_point) || 0);
  if (rp > 0) return Math.max(0, Math.round(rp * (0.6 + 0.5 * rand())));
  return randInt(rand, 0, 2);
}

/**
 * A plausible instant for a restock that has to sit strictly between two
 * events: a few days before the sales it covers, inside store hours.
 */
export function pickRestockTs(prevTs, evTs, rand) {
  const earliest = prevTs == null ? evTs - 30 * 86400000 : prevTs + 1000;
  const latest = evTs - 1000;
  if (latest <= earliest) return null; // no room between the two events

  let target = addDaysMs(evTs, -randInt(rand, 2, 5));
  if (target < earliest || target > latest) target = Math.floor((earliest + latest) / 2);

  // Snap into store hours on that Manila date, then fall back to the raw
  // target if the snap lands outside the gap.
  const hour = STORE_OPEN_HOUR + Math.floor(rand() * (STORE_CLOSE_HOUR - STORE_OPEN_HOUR));
  const snapped = manilaSameDayAt(target, hour, Math.floor(rand() * 60), Math.floor(rand() * 60));
  if (snapped > earliest && snapped < latest) return snapped;
  return target;
}

/**
 * Recompute one product's whole ledger.
 *
 * @param product            { product_id, sku, reorder_point, stock_on_hand, supplier, unit_cost }
 * @param events             ascending by (ts, order); each
 *                           { kind: 'existing' | 'sale', ts, quantity, movement_type,
 *                             reference, user_id, movement_id?, balance_after? }
 * @param typicalMonthlyUnits used for the ceiling
 * @param rand               seeded PRNG
 *
 * Returns the full ascending row list with balance_after assigned, the
 * synthetic restocks, the opening movement, and any constraint violations.
 */
export function planProductLedger({ product, events, typicalMonthlyUnits = 0, rand }) {
  const ceiling = stockCeiling(product, typicalMonthlyUnits);
  const onHand = Number(product.stock_on_hand) || 0;
  const violations = [];

  // Work on copies so a caller can re-plan the same input.
  const walk = events.map((e) => ({ ...e }));
  const restocks = [];

  let bal = onHand; // balance_after of the latest event
  for (let i = walk.length - 1; i >= 0; i--) {
    const ev = walk[i];
    ev.balance_after = bal;

    let before = bal - ev.quantity;

    if (before < 0) {
      // Only reachable when an existing stock_in brought in more than was
      // ever consumed after it. The existing rows are fixed, so the honest
      // outcome is to floor the history at zero and say so.
      violations.push({
        sku: product.sku,
        productId: product.product_id,
        reason: `balance would go negative (${before}) before ${ev.movement_type}` +
          `${ev.reference ? ` ${ev.reference}` : ""}; floored at 0`,
        at: ev.ts,
      });
      before = 0;
    }

    bal = before;

    // Too much stock on the shelf going backwards: a delivery belongs here.
    //
    // Two cases are deliberately left alone. At i === 0 there is no earlier
    // event to sit after, and the leftover there IS the opening balance -
    // that is what the opening row below is for. And when the next-earlier
    // event already adds stock (an existing stock_in, or the opening row on
    // a re-run), that real delivery already explains the balance; inserting
    // a synthetic one in front of it would double the stock and drive the
    // balance before it negative.
    const earlierAddsStock = i > 0 && walk[i - 1].quantity > 0;
    if (bal > ceiling && i > 0 && !earlierAddsStock) {
      const low = restockLowPoint(product, rand);
      const qty = bal - low;
      const ts = pickRestockTs(walk[i - 1].ts, ev.ts, rand);
      if (qty > 0 && ts != null) {
        restocks.push({
          kind: "restock",
          ts,
          quantity: qty,
          movement_type: "stock_in",
          reference: deliveryReceipt(ts),
          balance_after: bal,
          supplier: product.supplier ?? null,
          unit_cost: product.unit_cost ?? null,
          user_id: null,
        });
        bal = low;
      } else if (qty > 0 && ts == null) {
        violations.push({
          sku: product.sku,
          productId: product.product_id,
          reason: `needed a ${qty}-unit restock but the surrounding events leave no room in time`,
          at: ev.ts,
        });
      }
    }
  }

  const openingBalance = bal;

  // Whatever is left is what the product started with. Shaped like the row
  // api/products/save writes for a new product's opening stock, so the
  // ledger renders it as "Opening stock" (ledger.js keys that off
  // reference === 'opening', ahead of the note).
  let opening = null;
  if (openingBalance > 0 && walk.length > 0) {
    // walk[0] is the earliest row in the plan - a restock can only be
    // placed after some earlier event, so none can precede it.
    const firstTs = walk[0].ts;
    // On the first event's own Manila date, at store opening - or just
    // before the event if it already happened by then.
    const atOpen = manilaSameDayAt(firstTs, STORE_OPEN_HOUR, 0, 0);
    opening = {
      kind: "opening",
      ts: atOpen < firstTs ? atOpen : firstTs - 60000,
      quantity: openingBalance,
      movement_type: "adjustment",
      reference: "opening",
      balance_after: openingBalance,
      user_id: null,
    };
  }

  const rows = [...(opening ? [opening] : []), ...walk, ...restocks].sort(
    (a, b) => a.ts - b.ts || orderRank(a) - orderRank(b)
  );

  return {
    rows,
    restocks,
    opening,
    openingBalance,
    ceiling,
    violations,
    endingBalance: rows.length > 0 ? rows[rows.length - 1].balance_after : onHand,
  };
}

// Opening first, then a restock, then the event it supplies - the order the
// balances were computed in, which is what insertion order has to reproduce
// because the ledger sorts by (movement_ts, movement_id).
function orderRank(row) {
  if (row.kind === "opening") return 0;
  if (row.kind === "restock") return 1;
  return 2;
}

/**
 * Verify a planned row list is internally consistent: each balance_after is
 * the previous one plus the row's quantity, nothing is negative, and the
 * last balance is the product's current stock.
 */
export function verifyPlan(rows, stockOnHand) {
  const problems = [];
  let previous = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expected = previous + row.quantity;
    if (row.balance_after !== expected) {
      problems.push(`row ${i} (${row.movement_type} ${row.quantity}): balance_after ${row.balance_after}, expected ${expected}`);
    }
    if (row.balance_after < 0) problems.push(`row ${i}: negative balance ${row.balance_after}`);
    previous = row.balance_after;
  }
  if (rows.length > 0 && previous !== stockOnHand) {
    problems.push(`ending balance ${previous} != stock_on_hand ${stockOnHand}`);
  }
  return problems;
}
