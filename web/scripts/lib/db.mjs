// Supabase access for the seed-data scripts, with the service-role key.
//
// The key is read from web/.env.local and never logged, written back, or
// passed anywhere but the Supabase client. These scripts are the only place
// in the repo that reads that file directly - the app gets its env from
// Next.js.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = resolve(HERE, "..", "..");

/** Minimal .env parser - only the two keys these scripts need. */
function readEnvLocal() {
  const path = resolve(WEB_DIR, ".env.local");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read ${path}. These scripts need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`);
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}

/**
 * A browser-shaped client on the PUBLISHABLE anon key, with no session.
 * Used only by scripts/check-staff-access.mjs, which signs in as a
 * temporary staff user to prove what that session can and cannot reach.
 * Everything else in scripts/ is a trusted backend and uses the service key.
 */
export function createAnonClient() {
  const env = readEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set in web/.env.local");
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set in web/.env.local");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function createServiceClient() {
  const env = readEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  // Report which name is missing, never the value of either.
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set in web/.env.local");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set in web/.env.local");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Page a select to exhaustion. `build` is a thunk because a Supabase query
 * builder is single-use. Always give the query a stable .order(): without a
 * sort, separate range requests can return overlapping pages.
 *
 * pageSize is probed once per process - this project's Supabase may have had
 * its API "Max Rows" raised above the 1000 default (monthly_demand_all needs
 * that), and using the real ceiling turns 500 round trips into far fewer.
 */
let probedPageSize = null;

export async function probePageSize(sb) {
  if (probedPageSize != null) return probedPageSize;
  const { data, error } = await sb.from("sales").select("sale_id").order("sale_id").range(0, 49999);
  probedPageSize = error ? 1000 : Math.max(1000, data?.length ?? 1000);
  return probedPageSize;
}

export async function pageAll(build, { pageSize = 1000, onProgress = null, label = "" } = {}) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await build().range(offset, offset + pageSize - 1);
    if (error) throw new Error(`${label || "paged read"} failed at offset ${offset}: ${error.message}`);
    // Appended one at a time rather than spread: this project's Supabase
    // returns up to 50,000 rows per page, and `push(...page)` passes every
    // row as an argument, which overflows the call stack.
    for (const row of data ?? []) rows.push(row);
    if (onProgress) onProgress(rows.length);
    if (!data || data.length < pageSize) return rows;
  }
}

/** A single count(*) without pulling any rows. */
export async function countRows(sb, table, shape = (q) => q) {
  const { count, error } = await shape(sb.from(table).select("*", { count: "exact", head: true }));
  if (error) throw new Error(`count on ${table} failed: ${error.message}`);
  return count ?? 0;
}

export const INSERT_BATCH = 1000;

/** Insert in batches, preserving order so identity ids follow it. */
export async function insertBatched(sb, table, rows, { select = null, onProgress = null } = {}) {
  const inserted = [];
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    let q = sb.from(table).insert(chunk);
    if (select) q = q.select(select);
    const { data, error } = await q;
    if (error) throw new Error(`insert into ${table} failed at row ${i}: ${error.message}`);
    if (data) inserted.push(...data);
    if (onProgress) onProgress(Math.min(i + INSERT_BATCH, rows.length), rows.length);
  }
  return inserted;
}

export function progressLine(text) {
  if (process.stdout.isTTY) process.stdout.write(`\r  ${text}`.padEnd(72));
}

export function progressDone(text) {
  if (process.stdout.isTTY) process.stdout.write("\r".padEnd(74) + "\r");
  if (text) console.log(`  ${text}`);
}
