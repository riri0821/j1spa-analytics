// Shared helpers for the seed-data scripts (backfill-ledger.mjs and
// simulate-recent-activity.mjs). No DB access here - see db.mjs for that.

// ---------------------------------------------------------------- Manila

// The Philippines is UTC+8 all year (no DST since 1978), so Manila wall
// clock is a fixed offset from UTC. Every timestamp these scripts generate
// is positioned by Manila local time, never the machine's zone.
export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export const STORE_OPEN_HOUR = 8; // 8 AM
export const STORE_CLOSE_HOUR = 18; // 6 PM (exclusive)

/** Manila calendar fields for an epoch-ms instant. */
export function manilaParts(ms) {
  const d = new Date(ms + MANILA_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

/** YYYY-MM-DD in Manila. */
export function manilaDateString(ms) {
  const p = manilaParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant of a given Manila wall-clock time on the Manila date of `ms`. */
export function manilaSameDayAt(ms, hour, minute = 0, second = 0) {
  const d = new Date(ms + MANILA_OFFSET_MS);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime() - MANILA_OFFSET_MS;
}

/** The instant of Manila midnight for a YYYY-MM-DD string. */
export function manilaMidnight(dateString) {
  return Date.parse(`${dateString}T00:00:00+08:00`);
}

/** A random instant inside store hours on the Manila date of `ms`. */
export function randomStoreHour(ms, rand) {
  const hour = STORE_OPEN_HOUR + Math.floor(rand() * (STORE_CLOSE_HOUR - STORE_OPEN_HOUR));
  return manilaSameDayAt(ms, hour, Math.floor(rand() * 60), Math.floor(rand() * 60));
}

export function addDaysMs(ms, days) {
  return ms + days * 86400000;
}

/** Manila-time ISO string, e.g. 2026-10-06T14:35:12+08:00 - what Postgres
 *  stores unambiguously as a timestamptz. */
export function toManilaIso(ms) {
  const d = new Date(ms + MANILA_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

/** "Oct 06, 2026 2:09 PM" in Manila - matches the ledger page's format. */
export function manilaStamp(ms) {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = manilaParts(ms);
  const suffix = p.hour < 12 ? "AM" : "PM";
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${MONTHS[p.month - 1]} ${String(p.day).padStart(2, "0")}, ${p.year} ${h12}:${String(p.minute).padStart(2, "0")} ${suffix}`;
}

// ------------------------------------------------------------------ PRNG

/**
 * Seeded PRNG (mulberry32). Deterministic on purpose: a dry run and the
 * --apply that follows it must produce the identical plan, and a report is
 * only useful if re-running reproduces it.
 */
export function makeRand(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable per-product seed, so one product's plan never shifts because
 *  another product's data changed. */
export function seedFor(label, productId) {
  let h = 2166136261 >>> 0;
  const text = `${label}:${productId}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Pick an index from a weight array. */
export function weightedIndex(weights, rand) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

export function randInt(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

// -------------------------------------------------------------- reporting

export function fmtInt(n) {
  return Number(n).toLocaleString("en-US");
}

export function fmtPeso(n) {
  return `PHP ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function section(title) {
  console.log(`\n${"=".repeat(74)}\n  ${title}\n${"=".repeat(74)}`);
}

export function table(rows, columns) {
  if (rows.length === 0) return;
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? "").length)));
  const line = (cells) => "  " + cells.map((c, i) => (columns[i].right ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ");
  console.log(line(columns.map((c) => c.label)));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(columns.map((c) => String(c.get(r) ?? ""))));
}

/** Delivery-receipt reference, e.g. DR-2023-0412. */
export function deliveryReceipt(ms) {
  const p = manilaParts(ms);
  return `DR-${p.year}-${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}`;
}

// --------------------------------------------------------------- CLI args

export function parseArgs(argv) {
  const apply = argv.includes("--apply");
  return {
    apply,
    dryRun: !apply,
    limitProducts: numArg(argv, "--limit-products"),
    only: strArg(argv, "--sku"),
  };
}

function numArg(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : null;
}

function strArg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
