/**
 * Gap-mode planning for simulate-recent-activity.mjs.
 *
 * The main simulation appends to the END of history: it starts from each
 * product's current stock_on_hand, walks forward, and the figure it lands on
 * becomes the new stock_on_hand. Nothing downstream exists to disturb.
 *
 * Gap mode inserts into the MIDDLE. Seed sales stop on 30 Sep 2026 at 17:50
 * Manila and the simulated month opens on 8 Oct, leaving a window that holds
 * only six hand-entered test sales - visible on the Gross & Net chart as a
 * short October, and read by the forecasting models as a real demand dip.
 *
 * Filling it has one hard constraint that shapes everything else:
 *
 *   products.stock_on_hand must not change.
 *
 * stock_on_hand is the END of each product's ledger chain, and the rows after
 * the window already run from it. So the rows this script ADDS have to net to
 * exactly zero per product: whatever the new sales take out, the new
 * deliveries must put back.
 *
 * Note it is the added rows that must net to zero, not the window. The window
 * already has a net change of its own - the six test sales inside it - and
 * stock_on_hand already reflects it. Covering those two units with a delivery
 * too would RAISE the closing balance, which is the same bug in the other
 * direction. Get this right and every balance_after after the window is
 * already correct and needs no rewrite; get it wrong by one unit and every
 * later row for that product is off by one.
 *
 * Within the window the balances DO have to be recomputed, because the new
 * rows interleave with the test sales' own movements.
 *
 * Pure functions over plain objects - no database, no clock. Checked by
 * web/scripts/backfillPlan.check.mjs (`npm run check:backfill`).
 */

/**
 * Each product's ledger split around the window.
 *
 * @param movements all of one product's movements, any order, each with
 *   { movement_id, movement_ts (ms), quantity, balance_after }.
 * @returns { before, inside, after, openingBalance } with the three groups in
 *   time order. openingBalance is the balance the window starts from: the
 *   last balance_after before it, or - if the window precedes the product's
 *   whole history - the balance the first movement implies before itself.
 */
export function splitAroundWindow(movements, windowStart, windowEnd) {
  const sorted = [...movements].sort(
    (a, b) => a.movement_ts - b.movement_ts || a.movement_id - b.movement_id
  );
  const before = sorted.filter((m) => m.movement_ts < windowStart);
  const inside = sorted.filter((m) => m.movement_ts >= windowStart && m.movement_ts < windowEnd);
  const after = sorted.filter((m) => m.movement_ts >= windowEnd);

  let openingBalance;
  if (before.length > 0) {
    openingBalance = before[before.length - 1].balance_after;
  } else if (sorted.length > 0) {
    // Same derivation lib/ledger.js uses for a period's beginning balance:
    // the balance the first movement landed on, minus the change it made.
    openingBalance = sorted[0].balance_after - sorted[0].quantity;
  } else {
    openingBalance = null; // caller substitutes stock_on_hand
  }
  return { before, inside, after, openingBalance };
}

/**
 * Deliveries that let `demand` happen without the balance ever going
 * negative, and that total EXACTLY the units demanded - so the rows added
 * net to zero and the chain after the window is untouched.
 *
 * @param opening the balance the window starts from.
 * @param demand the NEW decrements in time order: [{ ts, qty }], qty
 *   positive. Existing in-window decrements are deliberately NOT included -
 *   stock_on_hand already accounts for them.
 * @param deliveryTs (ts) -> ts, where to place a delivery that must land at
 *   or before `ts`. The caller decides the hour; this decides the day and
 *   the amount.
 * @param openingTs where a leftover top-up goes if the just-in-time
 *   deliveries do not add up to the total on their own.
 *
 * Just-in-time: a delivery is placed only when the running balance would
 * otherwise go below zero, sized to cover the shortfall plus whatever is
 * still owed later, capped so the total never exceeds what is sold. Any
 * remainder is added to a top-up at `openingTs` - adding units EARLIER can
 * only raise later balances, so it cannot break the non-negative property.
 *
 * Always feasible: in the worst case everything arrives at openingTs, which
 * leaves the running balance at or above `opening` throughout.
 */
export function planWindowDeliveries({ opening, demand, deliveryTs, openingTs, chunk = 1 }) {
  const total = demand.reduce((s, d) => s + d.qty, 0);
  if (total === 0) return [];

  const deliveries = [];
  let balance = opening;
  let delivered = 0;

  for (const d of demand) {
    if (balance - d.qty < 0) {
      // Short by this much, and never deliver more than the window sells.
      const need = d.qty - balance;
      const rounded = Math.ceil(need / chunk) * chunk;
      const qty = Math.min(Math.max(rounded, need), total - delivered);
      if (qty > 0) {
        deliveries.push({ ts: deliveryTs(d.ts), qty });
        delivered += qty;
        balance += qty;
      }
    }
    balance -= d.qty;
  }

  const remainder = total - delivered;
  if (remainder > 0) deliveries.push({ ts: openingTs, qty: remainder });

  // Several shortfalls on one day each asked for their own delivery. Merge
  // them: one receipt per instant reads the way a real delivery does, and it
  // keeps two rows from being indistinguishable by (ts, qty).
  const merged = new Map();
  for (const d of deliveries) merged.set(d.ts, (merged.get(d.ts) ?? 0) + d.qty);
  return [...merged.entries()]
    .map(([ts, qty]) => ({ ts, qty }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Rewrite balance_after for one product's in-window rows.
 *
 * @param opening the balance the window starts from.
 * @param rows every in-window movement - existing and new - each with
 *   { movement_ts (ms), quantity, movement_id? }. Sorted here, not by the
 *   caller: an existing row and a new row can share a timestamp, and the
 *   existing one has to keep its place.
 * @returns { rows, closing, minBalance } where rows carry balance_after and,
 *   for existing rows, previousBalanceAfter.
 *
 * Existing rows sort before new ones at the same instant (a new row has no
 * movement_id yet), so inserting never reorders recorded history.
 */
export function rechainWindow({ opening, rows }) {
  const sorted = [...rows].sort(
    (a, b) =>
      a.movement_ts - b.movement_ts ||
      (a.movement_id == null ? 1 : 0) - (b.movement_id == null ? 1 : 0) ||
      (a.movement_id ?? 0) - (b.movement_id ?? 0)
  );

  let balance = opening;
  let minBalance = opening;
  const out = sorted.map((m) => {
    balance += m.quantity;
    if (balance < minBalance) minBalance = balance;
    return {
      ...m,
      previousBalanceAfter: m.balance_after ?? null,
      balance_after: balance,
    };
  });

  return { rows: out, closing: balance, minBalance };
}

/**
 * The whole per-product plan, and the assertions that make it safe to apply.
 *
 * Returns { rows, closing, minBalance, existingNet, netChange, drift, ok,
 * problems } - `ok` only when `drift` is zero (the added rows cancel out)
 * and no balance went negative anywhere in the window.
 */
export function planProductWindow({ opening, existingInside, newRows }) {
  const { rows, closing, minBalance } = rechainWindow({
    opening,
    rows: [...existingInside, ...newRows],
  });

  // What the window already did, which stock_on_hand already reflects...
  const existingNet = existingInside.reduce((s, m) => s + m.quantity, 0);
  // ...what it does now...
  const netChange = closing - opening;
  // ...and the difference, which is what the insertion moved. THIS is the
  // number that has to be zero, not netChange.
  const drift = netChange - existingNet;

  const problems = [];
  if (drift !== 0) problems.push(`added rows net to ${drift}, not zero`);
  if (minBalance < 0) problems.push(`balance reached ${minBalance}`);

  return {
    rows,
    closing,
    minBalance,
    existingNet,
    netChange,
    drift,
    ok: problems.length === 0,
    problems,
  };
}

/**
 * Which rows after the window would need their balance_after rewritten.
 *
 * With a drift of zero this is empty, which is the point - but it is computed
 * rather than assumed, because an off-by-one here silently falsifies every
 * later balance for that product.
 */
export function rechainAfterWindow({ closing, openingOfAfter, after }) {
  const drift = closing - openingOfAfter;
  if (drift === 0) return [];
  return after.map((m) => ({
    movement_id: m.movement_id,
    previousBalanceAfter: m.balance_after,
    balance_after: m.balance_after + drift,
  }));
}

/**
 * How many EXISTING rows a plan would give a new balance_after.
 *
 * This is gap-mode --apply's precondition: it writes inserts only, so it
 * refuses unless this is zero. Rewriting a recorded row needs a backup
 * first, and the apply path cannot take one (PostgREST executes no DDL, and
 * the `backup` schema is not exposed to the API).
 */
export function countRewrittenRows(rows) {
  return rows.filter((r) => r.movement_id != null && r.balance_after !== r.previousBalanceAfter).length;
}

// ------------------------------------------------- removing recorded rows
//
// The mirror image of the gap fill. Deleting a movement from the middle of a
// chain shifts every later balance_after by its quantity, and the product's
// stock_on_hand with it, so both have to be recomputed rather than adjusted.

/**
 * Walk one product's chain with some rows deleted.
 *
 * @param movements every movement for the product, each with
 *   { movement_id, movement_ts (ms), quantity, balance_after }.
 * @param deletedIds Set of movement_id to drop.
 * @returns { updates, closing, minBalance, kept, opening }
 *   updates   rows whose balance_after changes, with both values
 *   closing   the balance the chain now ends on, which becomes stock_on_hand
 *   minBalance the lowest balance reached, which must not be negative
 *
 * The opening balance is derived from the first SURVIVING row's recorded
 * balance minus its own quantity, the same way lib/ledger.js derives a
 * period's beginning balance. Deriving it from the first row of the original
 * chain would be wrong when that row is one of the deleted ones.
 */
export function rechainAfterDeletions({ movements, deletedIds }) {
  const sorted = [...movements].sort(
    (a, b) => a.movement_ts - b.movement_ts || a.movement_id - b.movement_id
  );
  const kept = sorted.filter((m) => !deletedIds.has(m.movement_id));
  if (kept.length === 0) {
    // Everything went. The product is back to whatever it held before its
    // first movement, which the original first row still tells us.
    const opening = sorted.length ? sorted[0].balance_after - sorted[0].quantity : 0;
    return { updates: [], closing: opening, minBalance: opening, kept, opening };
  }

  const opening = kept[0].balance_after - kept[0].quantity;
  let balance = opening;
  let minBalance = opening;
  const updates = [];
  for (const m of kept) {
    balance += m.quantity;
    if (balance < minBalance) minBalance = balance;
    if (balance !== m.balance_after) {
      updates.push({ movement_id: m.movement_id, previousBalanceAfter: m.balance_after, balance_after: balance });
    }
  }
  return { updates, closing: balance, minBalance, kept, opening };
}

/**
 * Whether the backup tables the cleanup needs are present and complete.
 *
 * The apply path refuses unless every table it will touch has a backup whose
 * row count matches the plan exactly. A short backup is worse than none: it
 * looks like cover and is not.
 *
 * @param expected { tableName: rowCount } from the plan.
 * @param actual { tableName: rowCount | null } read from the database, null
 *   meaning the backup table is absent.
 */
export function backupPrecondition(expected, actual) {
  const problems = [];
  for (const [name, count] of Object.entries(expected)) {
    const have = actual[name];
    if (have == null) problems.push(`${name}: backup table missing (expected ${count} rows)`);
    else if (have !== count) problems.push(`${name}: backup holds ${have} rows, plan touches ${count}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Where to put one delivery so a post-deletion chain never goes negative.
 *
 * Placed immediately before the first row that would take the balance below
 * zero, which is where a real delivery would have had to arrive. Sized by the
 * caller's own rule rather than at the bare deficit, so it looks like the
 * shop's other deliveries; whatever that rule returns is raised to at least
 * the deficit, because the lowest point of the chain may come later than the
 * first negative one and the whole tail lifts by the amount delivered.
 *
 * @param kept the surviving rows in time order, each { movement_id,
 *   movement_ts, quantity }.
 * @param opening the balance the chain starts from.
 * @param size ({ have, deficit }) -> qty, the caller's sizing rule.
 * @returns null when nothing is needed, else { ts, qty, deficit, have,
 *   beforeMovementId }.
 */
export function planRestockFix({ kept, opening, size }) {
  let balance = opening;
  let min = opening;
  let firstNegativeIdx = -1;
  let haveBefore = opening;

  kept.forEach((m, i) => {
    const before = balance;
    balance += m.quantity;
    if (balance < min) min = balance;
    if (balance < 0 && firstNegativeIdx === -1) {
      firstNegativeIdx = i;
      haveBefore = before;
    }
  });

  if (min >= 0) return null;

  const deficit = -min;
  const qty = Math.max(size({ have: haveBefore, deficit }), deficit);
  const target = kept[firstNegativeIdx];
  return {
    beforeMovementId: target.movement_id,
    // A minute ahead of the row it rescues: close enough to read as the
    // delivery that made that sale possible, and ordered before it.
    ts: target.movement_ts - 60_000,
    qty,
    deficit,
    have: haveBefore,
  };
}

/**
 * Check a backup read back off disk against the plan that produced it.
 *
 * The point is to catch a backup that is short or stale BEFORE anything is
 * deleted, which means comparing ids rather than counts alone: two sets can
 * be the same size and hold different rows.
 *
 * @param plan { deletes: { table: [ids] }, updates: { table: [ids] } }
 * @param backup the same shape, read back from the file.
 */
export function verifyBackupFile(plan, backup) {
  const problems = [];
  const sameIds = (kind, name, want, got) => {
    if (!got) {
      problems.push(`${kind}.${name}: missing from the backup (expected ${want.length} rows)`);
      return;
    }
    if (got.length !== want.length) {
      problems.push(`${kind}.${name}: backup holds ${got.length} rows, plan has ${want.length}`);
      return;
    }
    const a = [...want].sort((x, y) => x - y).join(",");
    const b = [...got].sort((x, y) => x - y).join(",");
    if (a !== b) problems.push(`${kind}.${name}: the ids differ, so the backup is not of this plan`);
  };

  for (const [name, ids] of Object.entries(plan.deletes ?? {})) {
    sameIds("deletes", name, ids, backup.deletes?.[name]);
  }
  for (const [name, ids] of Object.entries(plan.updates ?? {})) {
    sameIds("updates", name, ids, backup.updates?.[name]);
  }
  for (const name of Object.keys(backup.deletes ?? {})) {
    if (!(name in (plan.deletes ?? {}))) problems.push(`deletes.${name}: in the backup but not in the plan`);
  }

  return { ok: problems.length === 0, problems };
}
