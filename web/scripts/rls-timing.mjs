#!/usr/bin/env node
/**
 * Time the reads whose cost is decided by an RLS policy.
 *
 *   node scripts/rls-timing.mjs
 *
 * Migration 037 wrapped every policy's current_user_role() / auth.uid() /
 * auth.role() call in a scalar subquery, so it is evaluated once per
 * statement instead of once per row. This is how that was measured, and how
 * to measure it again - run it before and after, or after any policy change,
 * and compare the medians.
 *
 * Three runs each, median reported. One machine over the public internet, so
 * the absolute numbers mean little; the ratio between before and after is
 * the point, and so is whether the staff stock_movements read comes back at
 * all. Before 037 it did not:
 *
 *   OWNER ledger: stock_movements J1-0306      523 ms
 *   OWNER ds: newest alert batch               142 ms
 *   OWNER ds: that batch's rows                141 ms
 *   STAFF stock_movements (must be refused)  8,195 ms -> statement timeout
 *
 * Needs an owner and a staff session, so it creates one temporary user of
 * each - the owner promoted with the service-role client, same as
 * check-staff-access.mjs - and deletes both in a finally block. The real
 * owner account is never touched: the only id written to is the one
 * createUser just returned.
 *
 * Writes nothing else. Read-only against every table it times.
 */
import { createAnonClient, createServiceClient } from "./lib/db.mjs";
const admin = createServiceClient();
const stamp = Date.now();
const made = [];

async function temp(label, role) {
  const email = `rlsperf-${stamp}-${label}@example.invalid`;
  const password = `Rp-${stamp}-${Math.random().toString(36).slice(2, 12)}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: `RLS perf (${label})` },
  });
  if (error) throw new Error(error.message);
  made.push(data.user.id);
  if (role === "owner") {
    const { error: e } = await admin.from("profiles").update({ role: "owner" }).eq("id", data.user.id);
    if (e) throw new Error(e.message);
  }
  const c = createAnonClient();
  const { error: e2 } = await c.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(e2.message);
  return c;
}

async function time(label, n, fn) {
  const runs = [];
  let note = "";
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    const { data, error } = await fn();
    runs.push(Date.now() - t);
    if (error) note = `  [${error.message.slice(0, 60)}]`;
    else if (i === 0) note = `  [${Array.isArray(data) ? data.length : data == null ? 0 : 1} rows]`;
  }
  const sorted = [...runs].sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(44)} ${runs.map((r) => String(r).padStart(6)).join(" ")}   median ${String(sorted[Math.floor(n / 2)]).padStart(6)} ms${note}`
  );
}

try {
  const owner = await temp("owner", "owner");
  const staff = await temp("staff", "staff");
  const { data: p } = await admin.from("products").select("product_id").eq("sku", "J1-0306").single();

  console.log("\n  three runs each, then the median\n");
  await time("OWNER ledger: stock_movements J1-0306", 3, () =>
    owner
      .from("stock_movements")
      .select("movement_id, movement_ts, movement_type, quantity, balance_after, reference, note, supplier, user_id")
      .eq("product_id", p.product_id)
      .order("movement_ts", { ascending: true })
      .order("movement_id", { ascending: true })
      .range(0, 999)
  );
  await time("OWNER ds: newest alert batch", 3, () =>
    owner.from("alerts").select("batch_id, generated_ts")
      .order("generated_ts", { ascending: false }).order("alert_id", { ascending: false }).limit(1)
  );
  const { data: newest } = await owner.from("alerts").select("batch_id")
    .order("generated_ts", { ascending: false }).order("alert_id", { ascending: false }).limit(1).maybeSingle();
  await time("OWNER ds: that batch's rows", 3, () =>
    owner.from("alerts").select("product_id, alert_type, severity").eq("batch_id", newest.batch_id).order("alert_id").range(0, 999)
  );
  await time("STAFF stock_movements (must be refused)", 3, () =>
    staff.from("stock_movements").select("movement_id, sku, quantity").limit(1)
  );
  await time("STAFF sales, tracker columns", 3, () =>
    staff.from("sales").select("sale_id, sale_ts, total_amount, user_id, customer_name").limit(5)
  );
  await time("STAFF products, sales-entry columns", 3, () =>
    staff.from("products").select("product_id, sku, name, category, brand, unit_price, stock_on_hand").eq("is_active", true).limit(5)
  );
} finally {
  for (const id of made) await admin.auth.admin.deleteUser(id);
  const { data } = await admin.from("profiles").select("id").eq("role", "owner");
  console.log(`\n  cleaned up ${made.length} temporary users; owner rows now: ${data?.length ?? "?"}`);
}
