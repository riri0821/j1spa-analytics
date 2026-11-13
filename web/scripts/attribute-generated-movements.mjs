#!/usr/bin/env node
/**
 * Give the generated stock_movements history a recorder.
 *
 *   node scripts/attribute-generated-movements.mjs            # read-only report
 *   node scripts/attribute-generated-movements.mjs --apply     # write it
 *
 * The seeded and simulated movements were inserted with the service-role key
 * and so have user_id NULL, which the Stock-In Tracker and the stock ledger
 * both render as "Former staff" (src/lib/profileNames.js: a null user_id
 * means the account is gone). That reads as a deleted colleague on every row
 * of the generated history, when in fact only the owner can record stock in.
 *
 * So: user_id, and nothing else. No schema change, no other column, and
 * only rows the generator tagged - data_origin IN ('seed','simulated') AND
 * user_id IS NULL. An untagged row is a real entry somebody made through the
 * app and is never touched, not even if its user_id is null: that null is
 * then a genuine "Former staff", and overwriting it would be a lie about who
 * stood at the counter.
 *
 * Two rules, by what the movement is:
 *
 *   stock_in, adjustment   -> the owner. Deliveries, corrections and opening
 *                             stock. record_stock_in and the adjustment path
 *                             are owner-only, so the owner is the only
 *                             account these could have come from.
 *
 *   reference sale:<id>,    -> that sale's user_id, so the ledger names the
 *   edit:<id>, undo:<id>       same person the sale's Cashier column does.
 *                              These rows are written BY confirm_sale /
 *                              edit_sale / undo_sale as a side effect, so
 *                              their recorder is the cashier, not the owner.
 *
 * Anything matching the filter that fits neither rule is reported and left
 * alone. A sale-linked row whose sale is itself an unattributed generated
 * row resolves to null, which is not an update, and is reported as such
 * rather than quietly forced to the owner.
 *
 * Before any write, every matching row's movement_id and CURRENT user_id go
 * to scripts/backups/ (gitignored) and are read back and checked, so the
 * column can be put back exactly as it was. The ledger chain is verified
 * either side of the write with verifyPlan(), the same assertion
 * backfill-ledger.mjs plans against - user_id is not part of a chain, so
 * "unchanged" is the only acceptable answer.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEB_DIR, countRows, createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { verifyPlan } from "./lib/ledgerPlan.mjs";
import { fmtInt, section, table } from "./lib/seedlib.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const BACKUP_DIR = resolve(WEB_DIR, "scripts", "backups");

// The tags migration 035 moved out of `note`. Only these two are ours.
const GENERATED_ORIGINS = ["seed", "simulated"];
// The owner's two: a delivery and a correction/opening-stock row.
const OWNER_TYPES = ["stock_in", "adjustment"];
// What confirm_sale, edit_sale and undo_sale write into `reference`.
const SALE_REFERENCE = /^(sale|edit|undo):(\d+)$/;
const UPDATE_BATCH = 200;

const MOVEMENT_TYPES = ["stock_in", "adjustment", "sale_decrement", "void_increment"];

const sb = createServiceClient();
const pageSize = await probePageSize(sb);

function fail(message) {
  console.error(`\n  STOP: ${message}\n`);
  process.exitCode = 1;
  process.exit();
}

// ------------------------------------------------------------ the owner
//
// Exactly one active owner, or this script has no business guessing. Two
// owners and "the owner" is ambiguous; none and there is nobody to
// attribute to.
section("The owner");
const { data: owners, error: ownerError } = await sb
  .from("profiles")
  .select("id, username, full_name, role, is_active")
  .eq("role", "owner")
  .eq("is_active", true);
if (ownerError) fail(`could not read profiles: ${ownerError.message}`);

if ((owners ?? []).length !== 1) {
  table(owners ?? [], [
    { label: "id", get: (r) => r.id },
    { label: "username", get: (r) => r.username },
    { label: "full_name", get: (r) => r.full_name },
  ]);
  fail(
    `expected exactly 1 active profile with role 'owner', found ${fmtInt((owners ?? []).length)}. ` +
      "Nothing was read further and nothing was written."
  );
}
const OWNER = owners[0];
console.log(`  ${OWNER.full_name} (@${OWNER.username})`);
console.log(`  profile id: ${OWNER.id}`);

// --------------------------------------------------------- matching rows
section("Rows in scope");
console.log(`  data_origin IN (${GENERATED_ORIGINS.map((o) => `'${o}'`).join(", ")}) AND user_id IS NULL\n`);

progressLine("loading matching stock_movements...");
const matching = await pageAll(
  () =>
    sb
      .from("stock_movements")
      .select("movement_id, product_id, sku, movement_type, reference, user_id, data_origin")
      .in("data_origin", GENERATED_ORIGINS)
      .is("user_id", null)
      .order("movement_id"),
  {
    pageSize,
    label: "stock_movements in scope",
    onProgress: (n) => progressLine(`loading matching stock_movements... ${fmtInt(n)}`),
  }
);
progressDone(`matching rows: ${fmtInt(matching.length)}`);

const totalMovements = await countRows(sb, "stock_movements");
const generatedAll = await countRows(sb, "stock_movements", (q) => q.in("data_origin", GENERATED_ORIGINS));
const untaggedNull = await countRows(sb, "stock_movements", (q) => q.is("data_origin", null).is("user_id", null));

const byType = new Map(MOVEMENT_TYPES.map((t) => [t, []]));
for (const m of matching) {
  if (!byType.has(m.movement_type)) byType.set(m.movement_type, []);
  byType.get(m.movement_type).push(m);
}

table(
  [...byType.entries()].map(([type, rows]) => ({ type, n: rows.length })),
  [
    { label: "movement_type", get: (r) => r.type },
    { label: "Rows in scope", right: true, get: (r) => fmtInt(r.n) },
  ]
);
console.log(`\n  stock_movements in total:                 ${fmtInt(totalMovements)}`);
console.log(`  tagged seed/simulated (any user_id):     ${fmtInt(generatedAll)}`);
console.log(`  untagged with a null user_id (NOT ours): ${fmtInt(untaggedNull)}`);

if (matching.length === 0) {
  console.log("\n  Nothing to do.");
  process.exit();
}

// ------------------------------------------------------------- the plan
//
// Sale-linked rows need their sale's user_id, so collect the referenced
// sale ids and read those sales. .in() goes into the URL, so it is chunked.
section("Plan");

const saleIdFor = new Map(); // movement_id -> referenced sale_id
for (const m of matching) {
  const hit = SALE_REFERENCE.exec(m.reference ?? "");
  if (hit) saleIdFor.set(m.movement_id, Number(hit[2]));
}

const wantedSaleIds = [...new Set(saleIdFor.values())];
const saleUserId = new Map(); // sale_id -> user_id (may be null)
for (let i = 0; i < wantedSaleIds.length; i += UPDATE_BATCH) {
  const chunk = wantedSaleIds.slice(i, i + UPDATE_BATCH);
  const { data, error } = await sb.from("sales").select("sale_id, user_id").in("sale_id", chunk);
  if (error) fail(`could not read sales: ${error.message}`);
  for (const s of data ?? []) saleUserId.set(s.sale_id, s.user_id);
  progressLine(`resolving sales... ${fmtInt(Math.min(i + UPDATE_BATCH, wantedSaleIds.length))}/${fmtInt(wantedSaleIds.length)}`);
}
progressDone(`sales referenced: ${fmtInt(wantedSaleIds.length)}`);

// One decision per row. `target` null means "no update", and `why` says
// which of the two rules (or neither) decided it.
const decisions = matching.map((m) => {
  const sale_id = saleIdFor.get(m.movement_id);

  if (OWNER_TYPES.includes(m.movement_type)) {
    return { m, target: OWNER.id, rule: "owner" };
  }
  if (sale_id != null) {
    if (!saleUserId.has(sale_id)) {
      return { m, target: null, rule: "unresolved", why: `sale ${sale_id} not found` };
    }
    const uid = saleUserId.get(sale_id);
    if (uid == null) {
      return { m, target: null, rule: "unresolved", why: `sale ${sale_id} has no user_id either` };
    }
    return { m, target: uid, rule: "sale", sale_id };
  }
  return { m, target: null, rule: "unmatched", why: `reference ${m.reference == null ? "is null" : `'${m.reference}'`}` };
});

const toOwner = decisions.filter((d) => d.rule === "owner");
const toCashier = decisions.filter((d) => d.rule === "sale");
const skipped = decisions.filter((d) => d.target == null);
const updates = [...toOwner, ...toCashier];

table(
  [
    { k: `-> the owner (${OWNER_TYPES.join(", ")})`, v: toOwner.length },
    { k: "-> the sale's user_id (sale:/edit:/undo:)", v: toCashier.length },
    { k: "left unchanged (fits neither rule)", v: skipped.length },
  ],
  [
    { label: "Rule", get: (r) => r.k },
    { label: "Rows", right: true, get: (r) => fmtInt(r.v) },
  ]
);

// Per-type, per-rule, so the two rules are visibly not fighting over a type.
const breakdown = MOVEMENT_TYPES.map((t) => ({
  type: t,
  owner: toOwner.filter((d) => d.m.movement_type === t).length,
  sale: toCashier.filter((d) => d.m.movement_type === t).length,
  skip: skipped.filter((d) => d.m.movement_type === t).length,
}));
console.log();
table(breakdown, [
  { label: "movement_type", get: (r) => r.type },
  { label: "-> owner", right: true, get: (r) => fmtInt(r.owner) },
  { label: "-> cashier", right: true, get: (r) => fmtInt(r.sale) },
  { label: "unchanged", right: true, get: (r) => fmtInt(r.skip) },
]);

if (skipped.length > 0) {
  console.log("\n  Rows that fit neither rule - reported, not touched:");
  const reasons = new Map();
  for (const d of skipped) {
    const key = `${d.m.movement_type}: ${d.why}`.replace(/\d+/g, (n) => (d.rule === "unmatched" ? n : "<id>"));
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  table(
    [...reasons.entries()].map(([k, n]) => ({ k, n })),
    [
      { label: "Reason", get: (r) => r.k },
      { label: "Rows", right: true, get: (r) => fmtInt(r.n) },
    ]
  );
  console.log(`  first few movement_ids: ${skipped.slice(0, 10).map((d) => d.m.movement_id).join(", ")}`);
}

// Distinct cashiers the sale rule resolved to, as a sanity read: these
// should be real accounts, and the owner being among them is normal.
if (toCashier.length > 0) {
  const perUser = new Map();
  for (const d of toCashier) perUser.set(d.target, (perUser.get(d.target) ?? 0) + 1);
  const { data: names } = await sb
    .from("profiles")
    .select("id, username, full_name")
    .in("id", [...perUser.keys()]);
  const nameFor = new Map((names ?? []).map((p) => [p.id, `${p.full_name} (@${p.username})`]));
  console.log();
  table(
    [...perUser.entries()].map(([id, n]) => ({ id, who: nameFor.get(id) ?? "NOT IN profiles", n })),
    [
      { label: "Cashier", get: (r) => r.who },
      { label: "profile id", get: (r) => r.id },
      { label: "Rows", right: true, get: (r) => fmtInt(r.n) },
    ]
  );
}

// -------------------------------------------------- ledger chain, before
//
// user_id is not part of a ledger chain, so this number must come out
// identical afterwards. Measured, not assumed.
async function chainState(label) {
  progressLine(`${label}: loading products...`);
  const products = await pageAll(
    () => sb.from("products").select("product_id, stock_on_hand, is_active").order("product_id"),
    { pageSize, label: "products" }
  );
  const active = products.filter((p) => p.is_active);

  const movements = await pageAll(
    () =>
      sb
        .from("stock_movements")
        .select("movement_id, movement_ts, product_id, movement_type, quantity, balance_after")
        .order("product_id")
        .order("movement_ts")
        .order("movement_id"),
    { pageSize, label: "stock_movements", onProgress: (n) => progressLine(`${label}: movements ${fmtInt(n)}`) }
  );
  progressDone("");

  const byProduct = new Map();
  for (const m of movements) {
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
    byProduct.get(m.product_id).push(m);
  }

  let consistent = 0;
  let negatives = 0;
  for (const p of active) {
    const rows = (byProduct.get(p.product_id) ?? []).sort(
      (a, b) => Date.parse(a.movement_ts) - Date.parse(b.movement_ts) || a.movement_id - b.movement_id
    );
    negatives += rows.filter((r) => r.balance_after < 0).length;
    if (verifyPlan(rows, p.stock_on_hand).length === 0) consistent += 1;
  }
  return { consistent, active: active.length, negatives, movements: movements.length };
}

section("Ledger chains before");
const before = await chainState("before");
console.log(`  chains consistent: ${fmtInt(before.consistent)} / ${fmtInt(before.active)} active products`);
console.log(`  rows with balance_after < 0: ${fmtInt(before.negatives)}`);

if (!APPLY) {
  section("Dry run");
  console.log(`  ${fmtInt(updates.length)} row(s) would be updated, ${fmtInt(skipped.length)} left unchanged.`);
  console.log("  Nothing was written. Re-run with --apply.");
  process.exit();
}

// ------------------------------------------------------------- backup
//
// movement_id and the CURRENT user_id for every matching row - including
// the ones no rule touches, so the file describes the whole scope and not
// just the part that changed. Written, then READ BACK and compared: a
// backup nobody has verified is not a backup.
section("Backup");
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = resolve(BACKUP_DIR, `attribute-generated-movements-${stamp}.json`);
const backupPayload = {
  generatedAt: new Date().toISOString(),
  script: "attribute-generated-movements.mjs",
  whatThisIs:
    "stock_movements.user_id as it was before attribution, for every row in " +
    "scope (data_origin IN ('seed','simulated') AND user_id IS NULL). Restore " +
    "by setting user_id back to previousUserId for each movement_id. No other " +
    "column was touched.",
  scope: { data_origin: GENERATED_ORIGINS, user_id: null },
  ownerProfileId: OWNER.id,
  rows: matching.map((m) => ({ movement_id: m.movement_id, previousUserId: m.user_id })),
  planned: updates.map((d) => ({ movement_id: d.m.movement_id, newUserId: d.target, rule: d.rule })),
};
writeFileSync(backupPath, `${JSON.stringify(backupPayload, null, 2)}\n`, "utf8");

const readBack = JSON.parse(readFileSync(backupPath, "utf8"));
const backupIds = new Set(readBack.rows.map((r) => r.movement_id));
const allNull = readBack.rows.every((r) => r.previousUserId === null);
if (readBack.rows.length !== matching.length || !matching.every((m) => backupIds.has(m.movement_id)) || !allNull) {
  fail(`the backup at ${backupPath} does not match the rows in scope. Nothing was written.`);
}
console.log(`  ${fmtInt(readBack.rows.length)} row(s) backed up and verified`);
console.log(`  ${backupPath}`);
console.log("  scripts/backups/ is gitignored - do not commit it.");

// -------------------------------------------------------------- apply
//
// Batched by target user_id: every row going to the same account is one
// .in() update, which is far fewer round trips than one call per row and
// still touches exactly the ids listed.
section("Apply");
const idsByTarget = new Map();
for (const d of updates) {
  if (!idsByTarget.has(d.target)) idsByTarget.set(d.target, []);
  idsByTarget.get(d.target).push(d.m.movement_id);
}

let written = 0;
for (const [target, ids] of idsByTarget) {
  for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
    const chunk = ids.slice(i, i + UPDATE_BATCH);
    const { data, error } = await sb
      .from("stock_movements")
      .update({ user_id: target })
      .in("movement_id", chunk)
      .select("movement_id");
    if (error) fail(`update failed after ${fmtInt(written)} row(s): ${error.message}. Backup: ${backupPath}`);
    written += (data ?? []).length;
    progressLine(`updating... ${fmtInt(written)}/${fmtInt(updates.length)}`);
  }
}
progressDone(`updated ${fmtInt(written)} row(s)`);

if (written !== updates.length) {
  fail(`expected to update ${fmtInt(updates.length)} row(s) but the database reported ${fmtInt(written)}.`);
}

// ------------------------------------------------------------- verify
section("Verify");

// 1. No generated stock_in or adjustment row left without a recorder.
const ownerTypesStillNull = await countRows(sb, "stock_movements", (q) =>
  q.in("data_origin", GENERATED_ORIGINS).in("movement_type", OWNER_TYPES).is("user_id", null)
);
console.log(
  `  generated ${OWNER_TYPES.join("/")} rows still user_id NULL: ${fmtInt(ownerTypesStillNull)}` +
    `  ${ownerTypesStillNull === 0 ? "PASS" : "FAIL"}`
);

// 2. Every row we wrote holds the value the plan chose.
let mismatched = 0;
for (const [target, ids] of idsByTarget) {
  for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
    const chunk = ids.slice(i, i + UPDATE_BATCH);
    const { data, error } = await sb.from("stock_movements").select("movement_id, user_id").in("movement_id", chunk);
    if (error) fail(`verification read failed: ${error.message}`);
    mismatched += (data ?? []).filter((r) => r.user_id !== target).length;
  }
}
console.log(`  rows not holding their planned user_id: ${fmtInt(mismatched)}  ${mismatched === 0 ? "PASS" : "FAIL"}`);

// 3. The rows no rule touched are still exactly as they were.
let movedSkipped = 0;
if (skipped.length > 0) {
  const skipIds = skipped.map((d) => d.m.movement_id);
  for (let i = 0; i < skipIds.length; i += UPDATE_BATCH) {
    const chunk = skipIds.slice(i, i + UPDATE_BATCH);
    const { data, error } = await sb.from("stock_movements").select("movement_id, user_id").in("movement_id", chunk);
    if (error) fail(`verification read failed: ${error.message}`);
    movedSkipped += (data ?? []).filter((r) => r.user_id !== null).length;
  }
}
console.log(`  unchanged rows that moved anyway: ${fmtInt(movedSkipped)}  ${movedSkipped === 0 ? "PASS" : "FAIL"}`);

// 4. Untagged rows: the count of real rows with a null user_id must not
//    have moved. This is the "never touch real data" claim, measured.
const untaggedNullAfter = await countRows(sb, "stock_movements", (q) => q.is("data_origin", null).is("user_id", null));
console.log(
  `  untagged rows with a null user_id: ${fmtInt(untaggedNull)} before, ${fmtInt(untaggedNullAfter)} after` +
    `  ${untaggedNull === untaggedNullAfter ? "PASS" : "FAIL"}`
);

// 5. The ledger chains, again.
const after = await chainState("after");
console.log(`  chains consistent: ${fmtInt(after.consistent)} / ${fmtInt(after.active)} active products`);
console.log(`  rows with balance_after < 0: ${fmtInt(after.negatives)}`);
const chainsSame =
  after.consistent === before.consistent &&
  after.active === before.active &&
  after.negatives === before.negatives &&
  after.movements === before.movements;
console.log(`  chains unchanged by this write: ${chainsSame ? "PASS" : "FAIL"}`);

section("Result");
table(breakdown.filter((r) => r.owner + r.sale > 0), [
  { label: "movement_type", get: (r) => r.type },
  { label: "-> owner", right: true, get: (r) => fmtInt(r.owner) },
  { label: "-> cashier", right: true, get: (r) => fmtInt(r.sale) },
  { label: "unchanged", right: true, get: (r) => fmtInt(r.skip) },
]);

const ok =
  ownerTypesStillNull === 0 &&
  mismatched === 0 &&
  movedSkipped === 0 &&
  untaggedNull === untaggedNullAfter &&
  chainsSame &&
  written === updates.length;
console.log(`\n  ${ok ? "All checks passed." : "SOMETHING FAILED - see above. Backup: " + backupPath}`);
if (!ok) process.exitCode = 1;
