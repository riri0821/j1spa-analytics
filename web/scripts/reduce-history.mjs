#!/usr/bin/env node
/**
 * Cut the generated sales history down to a realistic micro-retail volume.
 *
 *   node scripts/reduce-history.mjs --backup     # dump + verify, no writes
 *   node scripts/reduce-history.mjs --plan       # calibrate + write the plan
 *   node scripts/reduce-history.mjs --apply      # tag, then delete
 *   node scripts/reduce-history.mjs --retag      # restore the simulated tag
 *
 * The seeded history ran at ~100 sales and P168,000 a day in its last year,
 * which is a mid-size distributor, not the shop this system is for. This
 * removes whole sales - never line items, never quantities, never prices -
 * so every surviving sale is one a cashier could have rung up.
 *
 * WHY A VALUE TAPER AND NOT A FLAT SAMPLE
 *
 * The two targets (25 sales/day, P20,000/day) imply an average basket of
 * P800. Removing sales at a flat rate scales count and revenue by the same
 * factor, so a flat sample can hit one target or the other, never both: at
 * 25 sales/day a flat sample leaves P41,000/day. The basket distribution
 * says why, and says what to do about it - the median basket was already
 * P747, but the mean was P1,643, dragged up by a tail running to P41,621.
 * The tail is the unrealistic part, so the keep probability falls with
 * basket value:
 *
 *   keep(sale) = draw(sale_id) < min(1, K / (1 + total_amount / V0))
 *
 * K and V0 are solved against the live data in --plan (two unknowns, two
 * targets) and frozen into the plan file, so --apply is a replay of a
 * decision that was already reviewed rather than a fresh calculation each run.
 *
 * The draw is seeded off sale_id alone, so the selection is reproducible,
 * and it does NOT depend on the date. That is what preserves the seasonal
 * shape: every month and every weekday is thinned by the same factor, which
 * is per-month scaling with equal factors. Measured drift in the monthly
 * index is <=0.03.
 *
 * WHAT IS GENERATED
 *
 * The seed sales predate the data_origin column (migration 035), so 155,562
 * of them carry no tag at all - they are identified by
 * source_type='Historical Migration', and --apply tags them 'seed' before it
 * deletes anything. Exactly one untagged sale is real (a voided P432 test
 * entry) and it is a 'Direct Sales Entry', so the predicate cannot reach it.
 *
 * products.stock_on_hand is never written here, and neither is any price or
 * cost. The ledger is rebuilt afterwards by backfill-ledger.mjs, which walks
 * each chain backwards from stock_on_hand so it ends exactly on it.
 */

import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { WEB_DIR, countRows, createServiceClient, pageAll, probePageSize, progressDone, progressLine } from "./lib/db.mjs";
import { fmtInt, makeRand, manilaDateString, section, seedFor, table } from "./lib/seedlib.mjs";

const argv = process.argv.slice(2);
const MODE = argv.includes("--apply") ? "apply"
  : argv.includes("--retag") ? "retag"
  : argv.includes("--plan") ? "plan"
  : argv.includes("--backup") ? "backup"
  : null;

const BACKUP_DIR = resolve(WEB_DIR, "scripts", "backups");
const PLAN_PATH = resolve(BACKUP_DIR, "reduce-history.plan.json");

// 2020-06-13 00:00 Manila - the shop's founding date. Generated history
// before it is removed outright.
const FOUNDING_MS = Date.parse("2020-06-13T00:00:00+08:00");
// The window the simulated runs cover; everything earlier is seed history.
const SIMULATED_FROM_MS = Date.parse("2026-10-01T00:00:00+08:00");
// Targets are read off the last 12 months, which is what the dashboard shows.
const RECENT_FROM_MS = Date.parse("2025-11-13T00:00:00+08:00");
const TARGET_PER_DAY = 25;
const TARGET_GROSS_PER_DAY = 20000;

// DELETE goes out as ?id=in.(...) in the URL, so the batch size is bounded
// by URL length, not by Postgres.
const DELETE_BATCH = 400;
const TAG_BATCH = 5000;

const TABLES = {
  sales: "sale_id",
  sale_items: "sale_item_id",
  stock_movements: "movement_id",
  services: "service_id",
  products: "product_id",
};

const peso = (n) => "P" + Math.round(n).toLocaleString("en-US");
const isGenerated = (s) => s.data_origin === "seed" || s.data_origin === "simulated" || s.source_type === "Historical Migration";

async function main() {
  if (!MODE) {
    console.error("Pick one of --backup, --plan, --apply, --retag.");
    process.exit(2);
  }
  const sb = createServiceClient();
  const pageSize = await probePageSize(sb);
  if (MODE === "backup") return backup(sb, pageSize);
  if (MODE === "plan") return plan(sb, pageSize);
  if (MODE === "apply") return apply(sb, pageSize);
  if (MODE === "retag") return retag(sb);
}

// --------------------------------------------------------------- backup
/**
 * One gzipped NDJSON file per table, then verified by reading each file back
 * and counting its lines against a fresh count(*). A backup that was never
 * read back is a guess, and this is the only copy of six years of history.
 */
async function backup(sb, pageSize) {
  section("Backup");
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const written = [];

  for (const [name, pk] of Object.entries(TABLES)) {
    const live = await countRows(sb, name);
    const path = resolve(BACKUP_DIR, `reduce-history_${stamp}_${name}.ndjson.gz`);
    progressLine(`dumping ${name} (${fmtInt(live)} rows)...`);

    const rows = await pageAll(() => sb.from(name).select("*").order(pk), {
      pageSize,
      label: name,
      onProgress: (n) => progressLine(`dumping ${name}... ${fmtInt(n)}/${fmtInt(live)}`),
    });

    const gzip = createGzip();
    const out = createWriteStream(path);
    const done = pipeline(gzip, out);
    for (const row of rows) {
      if (!gzip.write(JSON.stringify(row) + "\n")) await new Promise((r) => gzip.once("drain", r));
    }
    gzip.end();
    await done;
    progressDone(`${name}: ${fmtInt(rows.length)} rows -> ${path.replace(WEB_DIR, "web")}`);
    written.push({ name, path, dumped: rows.length, live });
  }

  section("Verifying the backup against the live tables");
  let bad = 0;
  const report = [];
  for (const entry of written) {
    const inFile = await countLines(entry.path);
    const live = await countRows(sb, entry.name); // re-counted now, not reused
    const ok = inFile === live && inFile === entry.dumped;
    if (!ok) bad += 1;
    report.push({ t: entry.name, file: inFile, dumped: entry.dumped, live, ok: ok ? "OK" : "MISMATCH" });
  }
  table(report, [
    { label: "Table", get: (r) => r.t },
    { label: "Rows in file", right: true, get: (r) => fmtInt(r.file) },
    { label: "Rows dumped", right: true, get: (r) => fmtInt(r.dumped) },
    { label: "Rows live", right: true, get: (r) => fmtInt(r.live) },
    { label: "Match", get: (r) => r.ok },
  ]);
  writeFileSync(resolve(BACKUP_DIR, `reduce-history_${stamp}_manifest.json`),
    JSON.stringify({ stamp, files: report.map((r) => ({ ...r })) }, null, 2));

  if (bad > 0) {
    console.error(`\n  ${bad} table(s) do not match. Nothing may be deleted until this is clean.`);
    process.exit(1);
  }
  console.log("\n  Every backup file round-trips to the live row count. Safe to proceed.");
}

/** Count newline-delimited records in a .ndjson.gz without holding it in memory. */
async function countLines(path) {
  const { createGunzip } = await import("node:zlib");
  let n = 0;
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n += 1;
  return n;
}

// ----------------------------------------------------------------- plan
async function loadSales(sb, pageSize) {
  progressLine("loading sales...");
  const sales = await pageAll(
    () => sb.from("sales").select("sale_id, sale_ts, status, total_amount, source_type, data_origin").order("sale_id"),
    { pageSize, label: "sales", onProgress: (n) => progressLine(`loading sales... ${fmtInt(n)}`) }
  );
  progressDone(`sales: ${fmtInt(sales.length)}`);
  return sales.map((s) => ({ ...s, ms: Date.parse(s.sale_ts), amount: Number(s.total_amount) || 0, generated: isGenerated(s) }));
}

/**
 * Solve K and V0 so the last 12 months land on both targets, then list the
 * sale_ids to delete. Written to disk so --apply replays an audited decision.
 */
async function plan(sb, pageSize) {
  section("Plan");
  const sales = await loadSales(sb, pageSize);
  const confirmed = sales.filter((s) => s.status === "confirmed");
  const generated = confirmed.filter((s) => s.generated);
  const real = confirmed.filter((s) => !s.generated);

  const draw = new Map();
  for (const s of generated) draw.set(s.sale_id, makeRand(seedFor("reduce", s.sale_id))());

  const preFounding = generated.filter((s) => s.ms < FOUNDING_MS);
  const eligible = generated.filter((s) => s.ms >= FOUNDING_MS);

  const recent = eligible.filter((s) => s.ms >= RECENT_FROM_MS);
  const recentDays = new Set(recent.map((s) => manilaDateString(s.ms))).size;
  const keptBy = (k, v0) => recent.filter((s) => draw.get(s.sale_id) < Math.min(1, k / (1 + s.amount / v0)));
  const perDay = (rows) => rows.length / recentDays;
  const grossPerDay = (rows) => rows.reduce((a, s) => a + s.amount, 0) / recentDays;

  // K is bisected for the count target at each V0; V0 is bisected so the
  // gross target lands too. Both are monotone, so this converges.
  const solveK = (v0) => {
    let lo = 0, hi = 1.5;
    for (let i = 0; i < 60; i++) {
      const k = (lo + hi) / 2;
      if (perDay(keptBy(k, v0)) < TARGET_PER_DAY) lo = k; else hi = k;
    }
    return (lo + hi) / 2;
  };
  let lo = 600, hi = 2000;
  for (let i = 0; i < 24; i++) {
    const v0 = (lo + hi) / 2;
    if (grossPerDay(keptBy(solveK(v0), v0)) < TARGET_GROSS_PER_DAY) lo = v0; else hi = v0;
  }
  const V0 = (lo + hi) / 2;
  const K = solveK(V0);

  const keep = (s) => draw.get(s.sale_id) < Math.min(1, K / (1 + s.amount / V0));
  const kept = eligible.filter(keep);
  const taperDeleted = eligible.filter((s) => !keep(s));
  const deleteIds = [...preFounding, ...taperDeleted].map((s) => s.sale_id).sort((a, b) => a - b);

  const untaggedSeed = sales.filter((s) => s.data_origin == null && s.source_type === "Historical Migration").map((s) => s.sale_id);

  console.log(`\n  K  = ${K.toFixed(6)}`);
  console.log(`  V0 = ${V0.toFixed(2)}`);
  console.log(`  keep(sale) = draw(sale_id) < min(1, ${K.toFixed(4)} / (1 + total_amount / ${Math.round(V0)}))`);
  table(
    [
      { k: "confirmed sales", v: fmtInt(confirmed.length) },
      { k: "  generated (deletable)", v: fmtInt(generated.length) },
      { k: "  real (never touched)", v: fmtInt(real.length) },
      { k: "to tag data_origin='seed' first", v: fmtInt(untaggedSeed.length) },
      { k: "delete: before 2020-06-13 Manila", v: fmtInt(preFounding.length) },
      { k: "delete: by the taper", v: fmtInt(taperDeleted.length) },
      { k: "delete: TOTAL", v: fmtInt(deleteIds.length) },
      { k: "sales kept", v: fmtInt(kept.length) },
    ],
    [{ label: "Item", get: (r) => r.k }, { label: "Rows", right: true, get: (r) => r.v }]
  );

  const recentKept = keptBy(K, V0);
  console.log(`\n  last 12 months after: ${perDay(recentKept).toFixed(2)} sales/day   ${peso(grossPerDay(recentKept))}/day`);
  const allDays = new Set(kept.map((s) => manilaDateString(s.ms))).size;
  console.log(`  whole history after : ${(kept.length / allDays).toFixed(2)} sales/day   ${peso(kept.reduce((a, s) => a + s.amount, 0) / allDays)}/day`);

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(PLAN_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    rule: { K, V0, target: { perDay: TARGET_PER_DAY, grossPerDay: TARGET_GROSS_PER_DAY }, foundingMs: FOUNDING_MS },
    counts: {
      confirmed: confirmed.length, generated: generated.length, real: real.length,
      toTag: untaggedSeed.length, preFounding: preFounding.length,
      taperDeleted: taperDeleted.length, deleteTotal: deleteIds.length, kept: kept.length,
    },
    realSaleIds: real.map((s) => s.sale_id),
    deleteSaleIds: deleteIds,
  }));
  console.log(`\n  plan written: ${PLAN_PATH.replace(WEB_DIR, "web")}`);
  console.log("  Re-run with --apply to tag and delete exactly these sale_ids.");
}

// ---------------------------------------------------------------- apply
async function apply(sb, pageSize) {
  if (!existsSync(PLAN_PATH)) {
    console.error(`No plan at ${PLAN_PATH}. Run --plan first.`);
    process.exit(2);
  }
  const saved = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  const deleteIds = saved.deleteSaleIds;

  section("Apply");
  console.log(`  plan from ${saved.generatedAt}`);
  console.log(`  rule: min(1, ${saved.rule.K.toFixed(4)} / (1 + total_amount / ${Math.round(saved.rule.V0)}))`);
  console.log(`  sale_ids to delete: ${fmtInt(deleteIds.length)}`);

  // A backup must exist and must still match the live tables. Checked here
  // rather than trusted from the earlier run, because the earlier run's
  // "OK" says nothing about what happened since.
  const manifests = (await import("node:fs")).readdirSync(BACKUP_DIR).filter((f) => f.endsWith("_manifest.json"));
  if (manifests.length === 0) {
    console.error("\n  No backup manifest in scripts/backups/. Run --backup first.");
    process.exit(1);
  }
  const latest = manifests.sort().pop();
  const manifest = JSON.parse(readFileSync(resolve(BACKUP_DIR, latest), "utf8"));
  console.log(`\n  verifying backup ${latest} against the live tables...`);
  for (const f of manifest.files) {
    const live = await countRows(sb, f.t);
    if (live !== f.live) {
      console.error(`  ${f.t}: backup holds ${fmtInt(f.live)} rows, table now has ${fmtInt(live)}. STOPPING.`);
      process.exit(1);
    }
    console.log(`    ${f.t.padEnd(16)} ${fmtInt(live).padStart(9)} rows - matches the backup`);
  }

  // ---- step 1: tag the untagged seed block --------------------------------
  section("Step 1: tag the Historical Migration sales data_origin='seed'");
  const before = await countRows(sb, "sales", (q) => q.is("data_origin", null).eq("source_type", "Historical Migration"));
  console.log(`  untagged Historical Migration sales: ${fmtInt(before)}`);
  const { data: bounds } = await sb.from("sales").select("sale_id").order("sale_id", { ascending: false }).limit(1);
  const maxId = bounds?.[0]?.sale_id ?? 0;
  let tagged = 0;
  for (let lo = 0; lo <= maxId; lo += TAG_BATCH) {
    const { data, error } = await sb
      .from("sales")
      .update({ data_origin: "seed" })
      .is("data_origin", null)
      .eq("source_type", "Historical Migration")
      .gte("sale_id", lo)
      .lt("sale_id", lo + TAG_BATCH)
      .select("sale_id");
    if (error) throw new Error(`tagging failed at sale_id ${lo}: ${error.message}`);
    tagged += data?.length ?? 0;
    progressLine(`tagging... ${fmtInt(tagged)}/${fmtInt(before)}`);
  }
  progressDone(`tagged ${fmtInt(tagged)} sales data_origin='seed'`);
  const leftUntagged = await countRows(sb, "sales", (q) => q.is("data_origin", null));
  console.log(`  sales still untagged: ${fmtInt(leftUntagged)} (expected 1 - the real voided entry)`);
  if (tagged !== before) throw new Error(`tagged ${tagged} but expected ${before}`);

  // ---- step 2+3: delete the chosen sales ----------------------------------
  // sale_items go with them through the ON DELETE CASCADE on sale_items.sale_id.
  section("Steps 2 and 3: delete the chosen sales (sale_items cascade)");
  const itemsBefore = await countRows(sb, "sale_items");
  let deleted = 0;
  for (let i = 0; i < deleteIds.length; i += DELETE_BATCH) {
    const batch = deleteIds.slice(i, i + DELETE_BATCH);
    // data_origin is re-asserted on every delete: after step 1 every
    // generated row carries it, so this cannot reach an untagged real sale
    // even if the plan file were wrong.
    const { data, error } = await sb
      .from("sales")
      .delete()
      .in("sale_id", batch)
      .in("data_origin", ["seed", "simulated"])
      .select("sale_id");
    if (error) throw new Error(`delete failed at index ${i}: ${error.message}`);
    deleted += data?.length ?? 0;
    progressLine(`deleting sales... ${fmtInt(deleted)}/${fmtInt(deleteIds.length)}`);
  }
  progressDone(`deleted ${fmtInt(deleted)} sales`);
  const itemsAfter = await countRows(sb, "sale_items");
  console.log(`  sale_items cascaded away: ${fmtInt(itemsBefore - itemsAfter)} (${fmtInt(itemsAfter)} remain)`);
  if (deleted !== deleteIds.length) {
    console.warn(`  NOTE: ${fmtInt(deleteIds.length - deleted)} planned id(s) were already gone.`);
  }

  // ---- step 4: drop the whole generated ledger ----------------------------
  // Every generated movement goes, not just the orphans: the surviving rows'
  // balance_after values and synthetic restocks were computed against sales
  // that no longer exist. Deleting the lot makes every surviving sale line
  // "uncovered", which is the condition backfill-ledger.mjs replans on - so
  // the rebuild is a full one for every product rather than a patch.
  section("Step 4: delete the generated stock_movements so the ledger is rebuilt whole");
  const mvBefore = await countRows(sb, "stock_movements");
  const realMv = await countRows(sb, "stock_movements", (q) => q.is("data_origin", null));
  let mvDeleted = 0;
  for (;;) {
    const { data, error } = await sb
      .from("stock_movements")
      .select("movement_id")
      .in("data_origin", ["seed", "simulated"])
      .order("movement_id")
      .limit(20000);
    if (error) throw new Error(`reading movements failed: ${error.message}`);
    if (!data || data.length === 0) break;
    const ids = data.map((m) => m.movement_id);
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const { data: gone, error: delErr } = await sb
        .from("stock_movements")
        .delete()
        .in("movement_id", ids.slice(i, i + DELETE_BATCH))
        .in("data_origin", ["seed", "simulated"])
        .select("movement_id");
      if (delErr) throw new Error(`deleting movements failed: ${delErr.message}`);
      mvDeleted += gone?.length ?? 0;
      progressLine(`deleting generated movements... ${fmtInt(mvDeleted)}`);
    }
  }
  progressDone(`deleted ${fmtInt(mvDeleted)} generated stock_movements`);
  const mvAfter = await countRows(sb, "stock_movements");
  console.log(`  stock_movements: ${fmtInt(mvBefore)} -> ${fmtInt(mvAfter)} (${fmtInt(realMv)} real rows kept)`);

  section("Done - now rebuild the ledger");
  console.log("  node scripts/backfill-ledger.mjs            # dry run, check the plan");
  console.log("  node scripts/backfill-ledger.mjs --apply    # write the chains");
  console.log("  node scripts/reduce-history.mjs --retag     # restore the simulated tag");
}

// ---------------------------------------------------------------- retag
/**
 * backfill-ledger tags everything it writes 'seed'. The October-November 2026
 * window is the simulated activity, so its movements get that tag back -
 * leaving seed = the history to 2026-09-30, simulated = Oct-Nov 2026, null =
 * the one real entry.
 */
async function retag(sb) {
  section("Re-tag the simulated window");
  const target = await countRows(sb, "stock_movements",
    (q) => q.eq("data_origin", "seed").gte("movement_ts", new Date(SIMULATED_FROM_MS).toISOString()));
  console.log(`  movements at/after 2026-10-01 Manila tagged 'seed': ${fmtInt(target)}`);

  let done = 0;
  for (;;) {
    const { data, error } = await sb
      .from("stock_movements")
      .select("movement_id")
      .eq("data_origin", "seed")
      .gte("movement_ts", new Date(SIMULATED_FROM_MS).toISOString())
      .order("movement_id")
      .limit(20000);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (let i = 0; i < data.length; i += DELETE_BATCH) {
      const ids = data.slice(i, i + DELETE_BATCH).map((m) => m.movement_id);
      const { data: upd, error: uErr } = await sb
        .from("stock_movements")
        .update({ data_origin: "simulated" })
        .in("movement_id", ids)
        .eq("data_origin", "seed")
        .select("movement_id");
      if (uErr) throw new Error(uErr.message);
      done += upd?.length ?? 0;
      progressLine(`re-tagging... ${fmtInt(done)}/${fmtInt(target)}`);
    }
  }
  progressDone(`re-tagged ${fmtInt(done)} movements as 'simulated'`);

  section("Final data_origin counts");
  const rows = [];
  for (const t of ["sales", "services", "stock_movements"]) {
    rows.push({
      t,
      seed: fmtInt(await countRows(sb, t, (q) => q.eq("data_origin", "seed"))),
      sim: fmtInt(await countRows(sb, t, (q) => q.eq("data_origin", "simulated"))),
      real: fmtInt(await countRows(sb, t, (q) => q.is("data_origin", null))),
      total: fmtInt(await countRows(sb, t)),
    });
  }
  table(rows, [
    { label: "Table", get: (r) => r.t },
    { label: "seed", right: true, get: (r) => r.seed },
    { label: "simulated", right: true, get: (r) => r.sim },
    { label: "untagged (real)", right: true, get: (r) => r.real },
    { label: "total", right: true, get: (r) => r.total },
  ]);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
