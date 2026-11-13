#!/usr/bin/env node
/**
 * Snapshot the two supplier columns before the names are assigned.
 *
 *   node scripts/backup-supplier-columns.mjs
 *
 * READ-ONLY against the database. The supplier assignment itself is SQL the
 * owner runs in the Supabase SQL editor (sql/migrations/039_assign_suppliers.sql),
 * which takes its own in-database backup into the `backup` schema; this is
 * the second copy, on disk, in the same shape the history reduction's backups
 * take - so the previous value of every row is recoverable even if the
 * backup schema is dropped.
 *
 * Two columns, nothing else:
 *   products.supplier        one row per product
 *   stock_movements.supplier stock_in rows only, which are the only rows
 *                            that carry the snapshot (every other movement
 *                            type stores null there)
 *
 * Written, then read back and checked against what was read from the
 * database - a backup nobody has verified is not a backup.
 *
 * Credentials come from web/.env.local through scripts/lib/db.mjs, which
 * never logs them. scripts/backups/ is gitignored; do not commit the file.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEB_DIR, createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { fmtInt, section, table } from "./lib/seedlib.mjs";

const BACKUP_DIR = resolve(WEB_DIR, "scripts", "backups");

const sb = createServiceClient();
const pageSize = await probePageSize(sb);

section("Reading the current supplier columns");

progressLine("products...");
const products = await pageAll(
  () => sb.from("products").select("product_id, sku, category, supplier").order("product_id"),
  { pageSize, label: "products" }
);
progressDone(`products: ${fmtInt(products.length)}`);

progressLine("stock_movements (stock_in)...");
const movements = await pageAll(
  () =>
    sb
      .from("stock_movements")
      .select("movement_id, product_id, sku, supplier")
      .eq("movement_type", "stock_in")
      .order("movement_id"),
  { pageSize, label: "stock_movements", onProgress: (n) => progressLine(`stock_movements... ${fmtInt(n)}`) }
);
progressDone(`stock_in movements: ${fmtInt(movements.length)}`);

// What is in there now, so the file says what it is a snapshot OF.
const valueCounts = (rows) => {
  const counts = new Map();
  for (const r of rows) counts.set(r.supplier, (counts.get(r.supplier) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

table(
  [
    ...valueCounts(products).map(([v, n]) => ({ k: `products.supplier = ${JSON.stringify(v)}`, v: fmtInt(n) })),
    ...valueCounts(movements).map(([v, n]) => ({
      k: `stock_movements.supplier = ${JSON.stringify(v)} (stock_in)`,
      v: fmtInt(n),
    })),
  ],
  [
    { label: "Current value", get: (r) => r.k },
    { label: "Rows", right: true, get: (r) => r.v },
  ]
);

section("Writing the backup");
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = resolve(BACKUP_DIR, `supplier-columns-${stamp}.json`);

const payload = {
  generatedAt: new Date().toISOString(),
  script: "backup-supplier-columns.mjs",
  whatThisIs:
    "products.supplier and stock_movements.supplier (stock_in rows only) as they " +
    "were before sql/migrations/039_assign_suppliers.sql assigned Supplier 1/2/3. " +
    "Restore by setting each column back to previousSupplier for the id given. " +
    "No other column is included and none was read.",
  products: products.map((p) => ({
    product_id: p.product_id,
    sku: p.sku,
    category: p.category,
    previousSupplier: p.supplier,
  })),
  stockInMovements: movements.map((m) => ({
    movement_id: m.movement_id,
    product_id: m.product_id,
    sku: m.sku,
    previousSupplier: m.supplier,
  })),
};
writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

// Read back and compare, ids and values.
const back = JSON.parse(readFileSync(path, "utf8"));
const sameProducts =
  back.products.length === products.length &&
  products.every((p, i) => back.products[i].product_id === p.product_id && back.products[i].previousSupplier === p.supplier);
const sameMovements =
  back.stockInMovements.length === movements.length &&
  movements.every(
    (m, i) =>
      back.stockInMovements[i].movement_id === m.movement_id &&
      back.stockInMovements[i].previousSupplier === m.supplier
  );

console.log(`  ${fmtInt(back.products.length)} product rows      ${sameProducts ? "verified" : "MISMATCH"}`);
console.log(`  ${fmtInt(back.stockInMovements.length)} stock_in rows    ${sameMovements ? "verified" : "MISMATCH"}`);
console.log(`  ${path}`);
console.log("  scripts/backups/ is gitignored - do not commit it.");

if (!sameProducts || !sameMovements) {
  console.error("\n  The file does not match what was read. Do not run the assignment.");
  process.exitCode = 1;
}
