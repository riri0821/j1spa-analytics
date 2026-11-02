#!/usr/bin/env node
/**
 * Put the seed sales into the stock ledger.
 *
 *   node scripts/backfill-ledger.mjs            # dry run (default)
 *   node scripts/backfill-ledger.mjs --apply    # actually write
 *
 * The seed sales were inserted straight into `sales`/`sale_items` rather
 * than through confirm_sale(), so they left no stock_movements rows and
 * /ledger/[sku] shows almost nothing. This reconstructs the missing history:
 * one sale_decrement per seed sale line, synthetic stock_in deliveries where
 * the stock must have been replenished, and one opening adjustment per
 * product.
 *
 * products.stock_on_hand is treated as fixed and correct - it is never
 * written by this script, and every product's ledger is built to end exactly
 * on it (see lib/ledgerPlan.mjs for why the walk runs backwards).
 *
 * Every row this script inserts carries note = 'seed-backfill', so the whole
 * backfill can be found or removed with one predicate.
 */

import {
  countRows,
  createServiceClient,
  insertBatched,
  pageAll,
  probePageSize,
  progressDone,
  progressLine,
} from "./lib/db.mjs";
import { planProductLedger, verifyPlan } from "./lib/ledgerPlan.mjs";
import {
  fmtInt,
  makeRand,
  manilaDateString,
  manilaStamp,
  parseArgs,
  section,
  seedFor,
  table,
  toManilaIso,
} from "./lib/seedlib.mjs";

export const BACKFILL_NOTE = "seed-backfill";

const args = parseArgs(process.argv.slice(2));

async function main() {
  const sb = createServiceClient();
  const pageSize = await probePageSize(sb);

  section("Backfill ledger" + (args.apply ? " -- APPLY" : " -- DRY RUN (no writes)"));
  console.log(`  PostgREST page size in use: ${fmtInt(pageSize)}`);

  // ---------------------------------------------------------------- load
  progressLine("loading products...");
  const products = await pageAll(
    () =>
      sb
        .from("products")
        .select("product_id, sku, name, category, supplier, unit_cost, reorder_point, stock_on_hand, is_active, created_at")
        .order("product_id"),
    { pageSize, label: "products" }
  );
  progressDone(`products: ${fmtInt(products.length)}`);

  progressLine("loading stock_movements...");
  const existingMovements = await pageAll(
    () =>
      sb
        .from("stock_movements")
        .select("movement_id, movement_ts, product_id, sku, movement_type, quantity, balance_after, user_id, reference, note, supplier, unit_cost")
        .order("movement_id"),
    { pageSize, label: "stock_movements" }
  );
  progressDone(`stock_movements: ${fmtInt(existingMovements.length)}`);

  // Already applied? Then there is nothing to do, by definition.
  const alreadyBackfilled = existingMovements.filter((m) => m.note === BACKFILL_NOTE).length;

  progressLine("loading sales...");
  const sales = await pageAll(
    () => sb.from("sales").select("sale_id, sale_ts, user_id, status").order("sale_id"),
    { pageSize, label: "sales", onProgress: (n) => progressLine(`loading sales... ${fmtInt(n)}`) }
  );
  progressDone(`sales: ${fmtInt(sales.length)}`);

  const confirmed = new Map();
  let voided = 0;
  for (const s of sales) {
    if (s.status !== "confirmed") {
      voided += 1;
      continue;
    }
    confirmed.set(s.sale_id, { ts: Date.parse(s.sale_ts), user_id: s.user_id });
  }

  progressLine("loading sale_items...");
  const saleItems = await pageAll(
    () => sb.from("sale_items").select("sale_item_id, sale_id, product_id, sku, quantity").order("sale_item_id"),
    { pageSize, label: "sale_items", onProgress: (n) => progressLine(`loading sale_items... ${fmtInt(n)}`) }
  );
  progressDone(`sale_items: ${fmtInt(saleItems.length)}`);

  // ------------------------------------------------- what already exists
  // A sale line is already in the ledger if any movement references that
  // sale for that product - 'sale:<id>' from confirm_sale, 'edit:<id>' from
  // edit_sale. Never create a second movement for one of those.
  const covered = new Set();
  for (const m of existingMovements) {
    const ref = (m.reference ?? "").trim();
    const match = /^(sale|edit):(\d+)$/.exec(ref);
    if (match) covered.add(`${match[2]}:${m.product_id}`);
  }

  const byProduct = new Map();
  for (const p of products) byProduct.set(p.product_id, { product: p, events: [], unitsSold: 0, firstTs: null, lastTs: null });

  let skippedCovered = 0;
  let skippedVoided = 0;
  let orphanItems = 0;

  for (const item of saleItems) {
    const sale = confirmed.get(item.sale_id);
    if (!sale) {
      skippedVoided += 1; // voided, or a sale row that no longer exists
      continue;
    }
    if (covered.has(`${item.sale_id}:${item.product_id}`)) {
      skippedCovered += 1;
      continue;
    }
    const slot = byProduct.get(item.product_id);
    if (!slot) {
      orphanItems += 1; // sale line for a product row that is gone
      continue;
    }
    slot.events.push({
      kind: "sale",
      ts: sale.ts,
      quantity: -item.quantity,
      movement_type: "sale_decrement",
      reference: `sale:${item.sale_id}`,
      user_id: sale.user_id,
      sale_id: item.sale_id,
    });
    slot.unitsSold += item.quantity;
    slot.firstTs = slot.firstTs == null ? sale.ts : Math.min(slot.firstTs, sale.ts);
    slot.lastTs = slot.lastTs == null ? sale.ts : Math.max(slot.lastTs, sale.ts);
  }

  const pendingSaleEvents = [...byProduct.values()].reduce((n, slot) => n + slot.events.length, 0);

  let lastSaleTs = null;
  for (const v of confirmed.values()) if (lastSaleTs == null || v.ts > lastSaleTs) lastSaleTs = v.ts;
  let lastUncoveredTs = null;
  for (const slot of byProduct.values()) {
    for (const e of slot.events) if (lastUncoveredTs == null || e.ts > lastUncoveredTs) lastUncoveredTs = e.ts;
  }
  let lastMovementTs = null;
  for (const m of existingMovements) {
    const t = Date.parse(m.movement_ts);
    if (lastMovementTs == null || t > lastMovementTs) lastMovementTs = t;
  }

  if (pendingSaleEvents === 0) {
    section("Nothing to do");
    console.log(
      `  Every confirmed sale line already has a stock_movements row.\n` +
        `  ${fmtInt(alreadyBackfilled)} rows are tagged '${BACKFILL_NOTE}', so the backfill has run.\n` +
        `  This script is idempotent: re-running it changes nothing.`
    );
    return;
  }

  // Add the existing movements as fixed events in each product's timeline.
  for (const m of existingMovements) {
    const slot = byProduct.get(m.product_id);
    if (!slot) continue;
    slot.events.push({
      kind: "existing",
      movement_id: m.movement_id,
      ts: Date.parse(m.movement_ts),
      quantity: m.quantity,
      movement_type: m.movement_type,
      reference: m.reference,
      user_id: m.user_id,
      storedBalance: m.balance_after,
    });
  }

  // ---------------------------------------------------------------- plan
  const plans = [];
  const allViolations = [];
  const existingAudit = [];
  let touched = 0;

  for (const slot of byProduct.values()) {
    if (slot.events.length === 0) continue;

    slot.events.sort((a, b) => a.ts - b.ts || rank(a) - rank(b));

    // Typical monthly units, used for the restock ceiling: a product that
    // moves 200 a month should be allowed to hold more than one that moves 2.
    const months =
      slot.firstTs != null && slot.lastTs != null
        ? Math.max(1, (slot.lastTs - slot.firstTs) / (30 * 86400000))
        : 1;
    const typicalMonthlyUnits = slot.unitsSold / months;

    const result = planProductLedger({
      product: slot.product,
      events: slot.events,
      typicalMonthlyUnits,
      rand: makeRand(seedFor("backfill", slot.product.product_id)),
    });

    const problems = verifyPlan(result.rows, slot.product.stock_on_hand);
    const saleRows = result.rows.filter((r) => r.kind === "sale");
    if (saleRows.length === 0) continue;

    touched += 1;
    plans.push({ slot, result, problems, typicalMonthlyUnits });
    allViolations.push(...result.violations);

    for (const row of result.rows) {
      if (row.kind !== "existing") continue;
      existingAudit.push({
        movement_id: row.movement_id,
        sku: slot.product.sku,
        movement_type: row.movement_type,
        reference: row.reference ?? "",
        ts: row.ts,
        from: row.storedBalance,
        to: row.balance_after,
        changed: row.balance_after !== row.storedBalance,
        salesAfter: result.rows.filter((r) => r.kind === "sale" && r.ts > row.ts).length,
        isLast: row === result.rows[result.rows.length - 1],
      });
    }
  }

  const existingChanges = existingAudit.filter((r) => r.changed);

  // ------------------------------------------------------ build the rows
  // Flattened in (product, ts, computed order) so identity movement_ids
  // follow the order the balances were computed in - the ledger sorts by
  // (movement_ts, movement_id), so insertion order is what makes equal
  // timestamps come out right.
  const newRows = [];
  for (const { slot, result } of plans) {
    for (const row of result.rows) {
      if (row.kind === "existing") continue;
      newRows.push({
        product_id: slot.product.product_id,
        sku: slot.product.sku,
        movement_type: row.movement_type,
        quantity: row.quantity,
        balance_after: row.balance_after,
        user_id: row.user_id ?? null,
        reference: row.reference ?? null,
        note: BACKFILL_NOTE,
        movement_ts: toManilaIso(row.ts),
        supplier: row.movement_type === "stock_in" ? (slot.product.supplier ?? null) : null,
        unit_cost: row.movement_type === "stock_in" ? (slot.product.unit_cost ?? null) : null,
        __ts: row.ts,
        __kind: row.kind,
      });
    }
  }

  const counts = {
    sale_decrement: newRows.filter((r) => r.movement_type === "sale_decrement").length,
    stock_in: newRows.filter((r) => r.movement_type === "stock_in").length,
    opening: newRows.filter((r) => r.reference === "opening").length,
  };

  const totalBefore = products.reduce((s, p) => s + p.stock_on_hand, 0);
  const endingSum = plans.reduce((s, p) => s + p.result.endingBalance, 0);
  const plannedStockSum = plans.reduce((s, p) => s + p.slot.product.stock_on_hand, 0);

  // Reduced rather than Math.min(...spread): there are a quarter of a
  // million timestamps and spreading them overflows the call stack.
  let minTs = null;
  let maxTs = null;
  for (const row of newRows) {
    if (minTs == null || row.__ts < minTs) minTs = row.__ts;
    if (maxTs == null || row.__ts > maxTs) maxTs = row.__ts;
  }

  // ------------------------------------------------------------- reports
  section("Rows that would be written");
  table(
    [
      { t: "stock_movements (insert) - sale_decrement", n: counts.sale_decrement },
      { t: "stock_movements (insert) - stock_in restocks", n: counts.stock_in },
      { t: "stock_movements (insert) - opening adjustment", n: counts.opening },
      { t: "stock_movements (insert) - TOTAL", n: newRows.length },
      { t: "stock_movements (update balance_after only)", n: existingChanges.length },
      { t: "products (update)", n: 0 },
      { t: "sales (insert)", n: 0 },
      { t: "sale_items (insert)", n: 0 },
      { t: "services (insert)", n: 0 },
    ],
    [
      { label: "Table / operation", get: (r) => r.t },
      { label: "Rows", right: true, get: (r) => fmtInt(r.n) },
    ]
  );
  console.log(
    `\n  Date range covered: ${minTs ? manilaStamp(minTs) : "-"}  ->  ${maxTs ? manilaStamp(maxTs) : "-"} (Manila)`
  );
  console.log(`  Synthetic restocks: ${fmtInt(counts.stock_in)}`);
  console.log(`  Insert batches of ${fmtInt(1000)}: ${fmtInt(Math.ceil(newRows.length / 1000))}`);

  section("Source data");
  table(
    [
      { k: "products", v: `${fmtInt(products.length)} (${fmtInt(products.filter((p) => p.is_active).length)} active)` },
      { k: "sales", v: `${fmtInt(sales.length)} (${fmtInt(voided)} voided, skipped)` },
      { k: "sale_items", v: fmtInt(saleItems.length) },
      { k: "stock_movements already present", v: fmtInt(existingMovements.length) },
      { k: "  ...tagged seed-backfill", v: fmtInt(alreadyBackfilled) },
      { k: "sale lines already in the ledger (skipped)", v: fmtInt(skippedCovered) },
      { k: "sale lines on voided/missing sales (skipped)", v: fmtInt(skippedVoided) },
      { k: "sale lines for a missing product (skipped)", v: fmtInt(orphanItems) },
      { k: "sale lines to add", v: fmtInt(counts.sale_decrement) },
      { k: "latest confirmed sale_ts overall", v: lastSaleTs ? manilaStamp(lastSaleTs) : "-" },
      { k: "latest sale_ts still needing a movement", v: lastUncoveredTs ? manilaStamp(lastUncoveredTs) : "-" },
      { k: "latest existing movement_ts", v: lastMovementTs ? manilaStamp(lastMovementTs) : "-" },
    ],
    [
      { label: "Item", get: (r) => r.k },
      { label: "Count", right: true, get: (r) => r.v },
    ]
  );

  section("Before / after");
  table(
    [
      { k: "Total units in stock (all products)", before: fmtInt(totalBefore), after: fmtInt(totalBefore) },
      { k: "Total units in stock (products touched)", before: fmtInt(plannedStockSum), after: fmtInt(endingSum) },
      { k: "Products touched", before: "-", after: fmtInt(touched) },
      { k: "Products with no sale history", before: "-", after: fmtInt(products.length - touched) },
    ],
    [
      { label: "Measure", get: (r) => r.k },
      { label: "Before", right: true, get: (r) => r.before },
      { label: "After", right: true, get: (r) => r.after },
    ]
  );
  const stockMatches = endingSum === plannedStockSum;
  console.log(
    `\n  ${stockMatches ? "OK" : "MISMATCH"}: every planned ledger ends on the product's current stock_on_hand` +
      `${stockMatches ? " - current stock does not change" : ` (${fmtInt(endingSum)} vs ${fmtInt(plannedStockSum)})`}`
  );

  const inconsistent = plans.filter((p) => p.problems.length > 0);
  console.log(
    `  ${inconsistent.length === 0 ? "OK" : "WARN"}: ${fmtInt(plans.length - inconsistent.length)} of ${fmtInt(plans.length)} planned ledgers are arithmetically consistent`
  );

  section("Constraints that could not be met");
  if (allViolations.length === 0 && inconsistent.length === 0) {
    console.log("  None - every product's history reconciles to its current stock.");
  } else {
    const bySku = new Map();
    for (const v of allViolations) {
      if (!bySku.has(v.sku)) bySku.set(v.sku, []);
      bySku.get(v.sku).push(v);
    }
    console.log(`  ${fmtInt(bySku.size)} product(s) affected, ${fmtInt(allViolations.length)} issue(s):\n`);
    table(
      [...bySku.entries()].slice(0, 25).map(([sku, list]) => ({ sku, n: list.length, why: list[0].reason })),
      [
        { label: "SKU", get: (r) => r.sku },
        { label: "Issues", right: true, get: (r) => r.n },
        { label: "First reason", get: (r) => r.why },
      ]
    );
    if (bySku.size > 25) console.log(`  ... and ${fmtInt(bySku.size - 25)} more`);
    for (const p of inconsistent.slice(0, 10)) {
      console.log(`  ${p.slot.product.sku}: ${p.problems[0]}`);
    }
  }

  section(
    `The ${fmtInt(existingMovements.length)} existing stock_movements rows ` +
      `- ${fmtInt(existingChanges.length)} would have balance_after changed`
  );
  // Every existing row is listed with both its stored and its recomputed
  // balance, so "nothing changed" is shown rather than asserted. "Seed sales
  // after" counts backfilled sales landing later than the row: a row with
  // none after it is its product's last event, so its stored balance is
  // already stock_on_hand and cannot move.
  table(
    existingAudit.sort((a, b) => a.movement_id - b.movement_id),
    [
      { label: "id", right: true, get: (r) => r.movement_id },
      { label: "SKU", get: (r) => r.sku },
      { label: "Type", get: (r) => r.movement_type },
      { label: "Reference", get: (r) => r.reference },
      { label: "When (Manila)", get: (r) => manilaStamp(r.ts) },
      { label: "Stored", right: true, get: (r) => fmtInt(r.from) },
      { label: "Recomputed", right: true, get: (r) => fmtInt(r.to) },
      { label: "Change", get: (r) => (r.changed ? `${r.from} -> ${r.to}` : "none") },
      { label: "Seed sales after", right: true, get: (r) => fmtInt(r.salesAfter) },
      { label: "Product's last row", get: (r) => (r.isLast ? "yes" : "") },
    ]
  );
  const unaudited = existingMovements.length - existingAudit.length;
  if (unaudited > 0) {
    console.log(`\n  ${fmtInt(unaudited)} existing row(s) belong to products with no backfilled sales - untouched.`);
  }
  console.log("  Ids, types, quantities, references and timestamps are never modified.");

  // ---------------------------------------------------------- samples
  printSamples(plans, existingMovements);

  // ------------------------------------------------------------- apply
  if (!args.apply) {
    section("Dry run complete - nothing was written");
    console.log("  Re-run with --apply to write these rows.");
    return;
  }

  section("Applying");
  const payload = newRows.map(({ __ts, __kind, ...row }) => row);
  await insertBatched(sb, "stock_movements", payload, {
    onProgress: (done, total) => progressLine(`inserting stock_movements ${fmtInt(done)}/${fmtInt(total)}`),
  });
  progressDone(`inserted ${fmtInt(payload.length)} stock_movements rows`);

  for (const change of existingChanges) {
    const { error } = await sb
      .from("stock_movements")
      .update({ balance_after: change.to })
      .eq("movement_id", change.movement_id);
    if (error) throw new Error(`updating movement ${change.movement_id} failed: ${error.message}`);
  }
  console.log(`  updated balance_after on ${fmtInt(existingChanges.length)} existing row(s)`);

  const after = await countRows(sb, "stock_movements");
  console.log(`  stock_movements now holds ${fmtInt(after)} rows`);
  console.log("  products.stock_on_hand was not written by this script.");
}

function rank(e) {
  // Existing rows first at equal timestamps: they already hold lower
  // movement_ids, so the ledger's ordering puts them first regardless.
  return e.kind === "existing" ? 0 : 1;
}

function printSamples(plans, existingMovements) {
  const withExisting = new Set(existingMovements.map((m) => m.product_id));

  const scored = plans.map((p) => ({
    plan: p,
    sku: p.slot.product.sku,
    units: p.slot.unitsSold,
    hasExisting: withExisting.has(p.slot.product.product_id),
  }));

  const fastest = [...scored].sort((a, b) => b.units - a.units)[0];
  const slowest = [...scored].sort((a, b) => a.units - b.units)[0];
  const withMovement = scored.find((s) => s.hasExisting);

  const picks = [
    ["Fast-moving", fastest],
    ["Slow-moving", slowest],
    ["Has one of the existing movements", withMovement],
  ].filter(([, s]) => s);

  for (const [label, s] of picks) {
    const p = s.plan;
    const product = p.slot.product;
    section(`Sample ledger - ${label}: ${product.sku}`);
    console.log(
      `  ${product.name}\n` +
        `  stock_on_hand ${fmtInt(product.stock_on_hand)} | reorder point ${fmtInt(product.reorder_point)} | ` +
        `ceiling ${fmtInt(p.result.ceiling)} | typical monthly units ${p.typicalMonthlyUnits.toFixed(1)}\n` +
        `  rows ${fmtInt(p.result.rows.length)} (${fmtInt(p.result.restocks.length)} restocks) | ` +
        `opening balance ${fmtInt(p.result.openingBalance)} | ends at ${fmtInt(p.result.endingBalance)}`
    );

    const rows = p.result.rows;
    const head = rows.slice(0, 5);
    const tail = rows.slice(Math.max(5, rows.length - 10));
    const render = (list) =>
      table(list, [
        { label: "When (Manila)", get: (r) => manilaStamp(r.ts) },
        { label: "Particulars", get: (r) => particulars(r) },
        { label: "IN", right: true, get: (r) => (r.quantity > 0 ? fmtInt(r.quantity) : "") },
        { label: "OUT", right: true, get: (r) => (r.quantity < 0 ? fmtInt(-r.quantity) : "") },
        { label: "Balance", right: true, get: (r) => fmtInt(r.balance_after) },
        { label: "Source", get: (r) => r.kind },
      ]);

    console.log("\n  First 5:");
    render(head);
    if (rows.length > 15) console.log(`\n  ... ${fmtInt(rows.length - 15)} rows omitted ...`);
    console.log(`\n  Last ${Math.min(10, Math.max(0, rows.length - 5))}:`);
    render(tail);
  }
}

// Mirrors describeMovement() in src/lib/ledger.js, so the sample reads the
// way the page will.
function particulars(row) {
  const ref = (row.reference ?? "").trim();
  if (row.movement_type === "stock_in") return ref ? `Replenished stock - ${ref}` : "Replenished stock";
  if (row.movement_type === "adjustment") return ref === "opening" ? "Opening stock" : `Stock correction - ${ref}`;
  if (row.movement_type === "sale_decrement") {
    const m = /^sale:(\d+)$/.exec(ref);
    if (m) return `Sold - Sale #${m[1]}`;
    const e = /^edit:(\d+)$/.exec(ref);
    if (e) return `Sale #${e[1]} edited - re-recorded`;
  }
  if (row.movement_type === "void_increment") {
    const u = /^undo:(\d+)$/.exec(ref);
    if (u) return `Sale #${u[1]} voided - returned to stock`;
  }
  return `${row.movement_type} ${ref}`.trim();
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});

export { manilaDateString };
