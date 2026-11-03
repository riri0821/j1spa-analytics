#!/usr/bin/env node
/**
 * Undo scripts/cleanup-test-data.mjs from its backup file.
 *
 *   node scripts/restore-test-data-cleanup.mjs <backup.json>            # dry run
 *   node scripts/restore-test-data-cleanup.mjs <backup.json> --apply
 *
 * The backup holds every row the cleanup deleted, in full, plus the original
 * value of every column it overwrote. This compares that against the
 * database and puts back whatever is missing or changed.
 *
 * One thing it cannot do itself. Every id column in this schema is
 * `bigint generated always as identity`, and Postgres rejects an explicit
 * value for one unless the insert says `overriding system value` - which
 * PostgREST has no way to express. Re-inserting a deleted row with its
 * ORIGINAL id therefore has to be SQL, which this prints, ready to paste.
 * Restoring with fresh ids instead would be worse than useless: sale_items
 * point at sale_id, and stock_movements.reference carries "sale:<id>", so
 * new ids would reconnect the rows to nothing.
 *
 * What it can do directly is the other half: the overwritten balance_after
 * and stock_on_hand values, and deleting the rescue restocks the cleanup
 * inserted. Those are ordinary columns and ordinary rows.
 *
 * Run as a dry run first. With no cleanup applied yet it should report
 * nothing to do, which is the check that the backup is a faithful snapshot.
 */
import { readFileSync } from "node:fs";
import { createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { fmtInt, manilaStamp, section, table } from "./lib/seedlib.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const file = argv.find((a) => !a.startsWith("--"));

const cols = (...labels) => labels.map((label, i) => ({ label, get: (r) => r[i] }));

if (!file) {
  console.error("usage: node scripts/restore-test-data-cleanup.mjs <backup.json> [--apply]");
  process.exitCode = 1;
} else {
  await main(file);
}

async function main(path) {
  const backup = JSON.parse(readFileSync(path, "utf8"));
  const sb = createServiceClient();
  const pageSize = await probePageSize(sb);

  section(`Restore from ${path}${APPLY ? " -- APPLY" : " -- DRY RUN (no writes)"}`);
  console.log(`  taken      : ${backup.generatedAt}`);
  console.log(`  by         : ${backup.script}`);

  // ------------------------------------------------- what is missing now
  const KEYS = {
    sales: "sale_id",
    sale_items: "sale_item_id",
    stock_movements: "movement_id",
    services: "service_id",
    products: "product_id",
    alerts: "alert_id",
    advisory_overrides: "product_id",
  };

  progressLine("checking which deleted rows are back...");
  const missing = {};
  const present = {};
  for (const [tbl, rows] of Object.entries(backup.deletedRows ?? {})) {
    if (rows.length === 0) {
      missing[tbl] = [];
      present[tbl] = [];
      continue;
    }
    const key = KEYS[tbl];
    const ids = rows.map((r) => r[key]);
    const { data, error } = await sb.from(tbl).select(key).in(key, ids);
    if (error) throw new Error(`${tbl}: ${error.message}`);
    const have = new Set((data ?? []).map((r) => r[key]));
    missing[tbl] = rows.filter((r) => !have.has(r[key]));
    present[tbl] = rows.filter((r) => have.has(r[key]));
  }
  progressDone("");

  section("1. Rows the cleanup deleted");
  table(
    Object.keys(backup.deletedRows ?? {}).map((tbl) => [
      tbl,
      fmtInt((backup.deletedRows[tbl] ?? []).length),
      fmtInt((present[tbl] ?? []).length),
      fmtInt((missing[tbl] ?? []).length),
    ]),
    cols("table", "in backup", "still there", "to put back")
  );

  // ------------------------------------------- what values have changed
  progressLine("checking overwritten values...");
  const toRestore = { stock_movements: [], products: [] };

  const prevMovements = backup.previousValues?.stock_movements ?? [];
  if (prevMovements.length > 0) {
    const ids = prevMovements.map((m) => m.movement_id);
    const live = await pageAll(
      () => sb.from("stock_movements").select("movement_id, balance_after").in("movement_id", ids).order("movement_id"),
      { pageSize, label: "movements" }
    );
    const liveById = new Map(live.map((m) => [m.movement_id, m.balance_after]));
    for (const m of prevMovements) {
      const now = liveById.get(m.movement_id);
      if (now === undefined) continue; // the row itself is gone; the SQL below restores it
      if (now !== m.balance_after) toRestore.stock_movements.push({ ...m, current: now });
    }
  }

  const prevProducts = backup.previousValues?.products ?? [];
  if (prevProducts.length > 0) {
    const ids = prevProducts.map((p) => p.product_id);
    const live = await pageAll(
      () => sb.from("products").select("product_id, stock_on_hand").in("product_id", ids).order("product_id"),
      { pageSize, label: "products" }
    );
    const liveById = new Map(live.map((p) => [p.product_id, p.stock_on_hand]));
    for (const p of prevProducts) {
      const now = liveById.get(p.product_id);
      if (now === undefined) continue;
      if (now !== p.stock_on_hand) toRestore.products.push({ ...p, current: now });
    }
  }
  progressDone("");

  section("2. Values the cleanup overwrote");
  table(
    [
      ["stock_movements.balance_after", fmtInt(prevMovements.length), fmtInt(toRestore.stock_movements.length)],
      ["products.stock_on_hand", fmtInt(prevProducts.length), fmtInt(toRestore.products.length)],
    ],
    cols("column", "in backup", "to restore")
  );
  for (const u of toRestore.stock_movements.slice(0, 3)) {
    console.log(`    movement ${u.movement_id}: ${u.current} -> ${u.balance_after}`);
  }
  for (const u of toRestore.products.slice(0, 3)) {
    console.log(`    product ${u.product_id}: ${u.current} -> ${u.stock_on_hand}`);
  }

  // ------------------------------------------ what the cleanup inserted
  progressLine("checking the rescue restocks...");
  const inserted = backup.inserted?.stock_movements ?? [];
  const toDelete = [];
  for (const row of inserted) {
    const { data, error } = await sb
      .from("stock_movements")
      .select("movement_id, quantity, balance_after")
      .eq("product_id", row.product_id)
      .eq("movement_ts", row.movement_ts)
      .eq("data_origin", "simulated");
    if (error) throw new Error(`restock lookup: ${error.message}`);
    for (const m of data ?? []) toDelete.push({ ...m, sku: row.sku, movement_ts: row.movement_ts });
  }
  progressDone("");

  section("3. Rows the cleanup added");
  if (inserted.length === 0) console.log("  None.");
  else {
    table(
      inserted.map((r) => {
        const live = toDelete.find((d) => d.sku === r.sku && d.movement_ts === r.movement_ts);
        return [r.sku, String(r.quantity), manilaStamp(Date.parse(r.movement_ts)), live ? `present (id ${live.movement_id})` : "already gone"];
      }),
      cols("sku", "qty", "when (Manila)", "state")
    );
  }

  // ------------------------------------------------------------ verdict
  const reinsertCount = Object.values(missing).reduce((n, xs) => n + xs.length, 0);
  const updateCount = toRestore.stock_movements.length + toRestore.products.length;

  section("4. What a restore would do");
  console.log(`  rows to re-insert (needs SQL) : ${fmtInt(reinsertCount)}`);
  console.log(`  values to restore             : ${fmtInt(updateCount)}`);
  console.log(`  rescue restocks to delete     : ${fmtInt(toDelete.length)}`);
  console.log("");
  if (reinsertCount === 0 && updateCount === 0 && toDelete.length === 0) {
    console.log("  Nothing to do: the database already matches this backup exactly. Run");
    console.log("  before the cleanup, that is the check that the backup is faithful - every");
    console.log("  row it claims to hold is present with the values it recorded.");
  } else {
    console.log("  The database differs from the backup, which is expected after a cleanup.");
    console.log("  Applying would put every difference above back.");
  }

  // --------------------------------------------------------- the SQL half
  if (reinsertCount > 0) {
    section("5. SQL for the rows that must be re-inserted with their original ids");
    console.log("  PostgREST cannot write a `generated always as identity` column, so these");
    console.log("  are SQL. Run them in the Supabase editor, in this order (parents first).");
    console.log("");
    const ORDER = ["products", "sales", "sale_items", "stock_movements", "services", "alerts", "advisory_overrides"];
    for (const tbl of ORDER) {
      const rows = missing[tbl] ?? [];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      console.log(`    insert into ${tbl} (${columns.join(", ")}) overriding system value values`);
      rows.forEach((r, i) => {
        const vals = columns.map((c) => literal(r[c])).join(", ");
        console.log(`      (${vals})${i === rows.length - 1 ? ";" : ","}`);
      });
      console.log("");
    }
  }

  if (!APPLY) {
    section("Dry run complete - nothing was written");
    return;
  }

  // --------------------------------------------------------------- apply
  section("Restoring");
  for (const u of toRestore.stock_movements) {
    const { error } = await sb.from("stock_movements").update({ balance_after: u.balance_after }).eq("movement_id", u.movement_id);
    if (error) throw new Error(`movement ${u.movement_id}: ${error.message}`);
  }
  console.log(`  restored ${fmtInt(toRestore.stock_movements.length)} balance_after values`);

  for (const u of toRestore.products) {
    const { error } = await sb.from("products").update({ stock_on_hand: u.stock_on_hand }).eq("product_id", u.product_id);
    if (error) throw new Error(`product ${u.product_id}: ${error.message}`);
  }
  console.log(`  restored ${fmtInt(toRestore.products.length)} stock_on_hand values`);

  if (toDelete.length > 0) {
    const { error } = await sb.from("stock_movements").delete().in("movement_id", toDelete.map((d) => d.movement_id));
    if (error) throw new Error(`deleting the rescue restocks: ${error.message}`);
    console.log(`  deleted ${fmtInt(toDelete.length)} rescue restocks`);
  }

  if (reinsertCount > 0) {
    console.log("");
    console.log(`  ${fmtInt(reinsertCount)} deleted rows still need the SQL above. Until that is run,`);
    console.log("  the restore is incomplete and the ledger chains will not reconcile.");
    process.exitCode = 1;
  }
}

/** A Postgres literal for a value out of the backup's JSON. */
function literal(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replace(/'/g, "''")}'`;
}
