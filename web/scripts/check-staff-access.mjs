#!/usr/bin/env node
/**
 * Prove what a real staff session can and cannot read.
 *
 *   node scripts/check-staff-access.mjs --expect=before   # before 034: the hole is open
 *   node scripts/check-staff-access.mjs --expect=after    # after 034: it must be shut
 *
 * Owner and staff both authenticate as the Postgres role `authenticated`,
 * and RLS is row-level, so "staff cannot see cost" is a claim about the
 * database that only a real session can settle. Reading the migrations does
 * not settle it, and neither does reading the UI, which is where the claim
 * used to live.
 *
 * So this creates a TEMPORARY staff user through the admin API, signs in as
 * that user with the publishable anon key - exactly what a browser holds -
 * and tries every cost column, view and function in turn. Then it checks the
 * other half, which matters just as much: that staff can still do their job.
 *
 * The temporary user is deleted in a finally block, so it goes even if a
 * check throws. profiles.id cascades from auth.users, so its profile row
 * goes with it.
 *
 * --expect=before documents the hole rather than asserting it is fixed: the
 * cost reads are expected to SUCCEED, and a failure there means something
 * else is wrong. --expect=after is the real gate.
 *
 * Writes nothing except the temporary user. Exits 1 if any check fails.
 */
import { createAnonClient, createServiceClient } from "./lib/db.mjs";
import { fmtInt, section } from "./lib/seedlib.mjs";

const argv = process.argv.slice(2);
const expectArg = argv.find((a) => a.startsWith("--expect="))?.slice("--expect=".length);
if (expectArg !== "before" && expectArg !== "after") {
  console.error("usage: node scripts/check-staff-access.mjs --expect=before|after");
  process.exitCode = 1;
  process.exit();
}
const AFTER = expectArg === "after";

const results = [];
function record(group, label, outcome, detail = "") {
  results.push({ group, label, outcome, detail });
}

/**
 * Run one probe and classify the outcome.
 *
 * `want` is "allowed" or "denied". A PostgREST permission error and an
 * empty result are both denials, but they are different denials and the
 * report says which: a column privilege errors, an RLS policy returns
 * nothing.
 */
async function probe(group, label, want, fn) {
  let outcome;
  let detail;
  try {
    const { data, error } = await fn();
    if (error) {
      outcome = "denied";
      detail = `error: ${error.message.slice(0, 90)}`;
      if (/could not find the function|does not exist/i.test(error.message)) {
        outcome = "missing";
        detail = "the function does not exist yet";
      }
    } else if (Array.isArray(data) && data.length === 0) {
      outcome = "empty";
      detail = "no rows (an RLS policy, not a privilege)";
    } else if (data == null) {
      outcome = "empty";
      detail = "no data";
    } else {
      outcome = "allowed";
      const n = Array.isArray(data) ? data.length : 1;
      detail = `${fmtInt(n)} row${n === 1 ? "" : "s"}`;
    }
  } catch (err) {
    outcome = "denied";
    detail = `threw: ${String(err.message).slice(0, 90)}`;
  }

  const denied = outcome === "denied" || outcome === "empty";
  const pass = want === "allowed" ? outcome === "allowed" : denied;
  record(group, label, outcome === "missing" ? "SKIP" : pass ? "PASS" : "FAIL", detail);
}

const admin = createServiceClient();
const stamp = Date.now();
const email = `staff-check-${stamp}@example.invalid`;
const password = `Sc-${stamp}-${Math.random().toString(36).slice(2, 10)}`;
// Every temporary user this run creates, so the finally block can remove all
// of them however it exits.
const createdUsers = [];
let userId = null;

async function makeTempUser(label) {
  const addr = `staff-check-${stamp}-${label}@example.invalid`;
  const pw = `Sc-${stamp}-${Math.random().toString(36).slice(2, 12)}`;
  const { data, error } = await admin.auth.admin.createUser({
    email: addr,
    password: pw,
    email_confirm: true,
    user_metadata: { full_name: `Staff Access Check (${label})` },
  });
  if (error) throw new Error(`could not create the ${label} user: ${error.message}`);
  createdUsers.push({ id: data.user.id, email: addr });
  return { id: data.user.id, email: addr, password: pw };
}

try {
  section(`Staff access check, --expect=${expectArg}`);
  console.log(`  temporary user: ${email}`);

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Staff Access Check" },
  });
  if (createError) throw new Error(`could not create the temporary user: ${createError.message}`);
  userId = created.user.id;
  createdUsers.push({ id: userId, email });
  console.log(`  id            : ${userId}`);

  // handle_new_user() writes the profile. Confirm it really is staff before
  // trusting a single result below.
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("role, is_active")
    .eq("id", userId)
    .single();
  if (profileError) throw new Error(`no profile row for the temporary user: ${profileError.message}`);
  if (profile.role !== "staff") {
    throw new Error(`the temporary user is '${profile.role}', not staff - every result below would be meaningless`);
  }
  console.log(`  profile       : role=${profile.role}, is_active=${profile.is_active}`);

  const staff = createAnonClient();
  const { error: signInError } = await staff.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign in as the temporary user: ${signInError.message}`);
  console.log("  signed in with the publishable anon key, as a browser would");

  const costWant = AFTER ? "denied" : "allowed";

  // ------------------------------------------------------ cost columns
  await probe("Cost columns", "products.unit_cost", costWant, () =>
    staff.from("products").select("sku, unit_cost").limit(1)
  );
  await probe("Cost columns", "sales.total_cost", costWant, () =>
    staff.from("sales").select("sale_id, total_cost").limit(1)
  );
  await probe("Cost columns", "sale_items.unit_cost", costWant, () =>
    staff.from("sale_items").select("sale_item_id, unit_cost").limit(1)
  );
  await probe("Cost columns", "sale_items.line_cost", costWant, () =>
    staff.from("sale_items").select("sale_item_id, line_cost").limit(1)
  );
  await probe("Cost columns", "stock_movements.unit_cost", costWant, () =>
    staff.from("stock_movements").select("movement_id, unit_cost").limit(1)
  );
  // The star is worth its own probe: it is how a careless query asks for
  // every column, cost included.
  await probe("Cost columns", 'products select("*")', costWant, () => staff.from("products").select("*").limit(1));

  // ------------------------------------------------- profit views and RPCs
  await probe("Profit views and RPCs", "vw_product_velocity.gross_profit_90d", costWant, () =>
    staff.from("vw_product_velocity").select("sku, gross_profit_90d").limit(1)
  );
  await probe("Profit views and RPCs", "sales_kpi_summary()", costWant, () => staff.rpc("sales_kpi_summary"));
  await probe("Profit views and RPCs", "dashboard_margin_trend()", costWant, () => staff.rpc("dashboard_margin_trend"));
  await probe("Profit views and RPCs", "dashboard_gross_net_range()", costWant, () =>
    staff.rpc("dashboard_gross_net_range", { p_start: "2026-10-01", p_end: "2026-10-07", p_bucket: "day" })
  );

  // ------------------------------------------------------ owner-only tables
  //
  // These are denied by an RLS policy, which returns no rows rather than an
  // error - so an empty result only means "denied" if the table has rows to
  // begin with. Checked with the service-role client first: a table that is
  // empty for everyone cannot tell us anything either way, and saying so is
  // better than scoring it.
  const ownerTableWant = AFTER ? "denied" : "allowed";
  for (const [tbl, columns] of [
    ["stock_movements", "movement_id, sku, quantity"],
    ["alerts", "alert_id, sku"],
    ["advisory_overrides", "product_id, manual_type"],
  ]) {
    const { count } = await admin.from(tbl).select(columns.split(",")[0].trim(), { count: "exact", head: true });
    if (!count) {
      record("Owner-only tables", tbl, "SKIP", "the table is empty, so an empty result proves nothing");
      continue;
    }
    await probe("Owner-only tables", `${tbl} (${fmtInt(count)} rows exist)`, ownerTableWant, () =>
      staff.from(tbl).select(columns).limit(1)
    );
  }

  // ----------------------------------------- the owner functions themselves
  // Always denied: the role check lives in 033, so this holds in both modes
  // once 033 is applied. Reported as SKIP until then.
  for (const [label, call] of [
    ["owner_product_catalog()", () => staff.rpc("owner_product_catalog", { p_search: null, p_category: null, p_limit: 1 })],
    ["owner_product_performance()", () => staff.rpc("owner_product_performance")],
    ["owner_sales_kpi_summary()", () => staff.rpc("owner_sales_kpi_summary")],
    ["owner_margin_trend()", () => staff.rpc("owner_margin_trend")],
    ["owner_gross_net_range()", () => staff.rpc("owner_gross_net_range", { p_start: "2026-10-01", p_end: "2026-10-07", p_bucket: "day" })],
    ["owner_stockin_log()", () => staff.rpc("owner_stockin_log", { p_start: "2026-10-01T00:00:00+08:00", p_end: "2026-10-07T00:00:00+08:00" })],
    ["owner_stockin_by_supplier()", () => staff.rpc("owner_stockin_by_supplier", { p_sku: "J1-0001" })],
  ]) {
    await probe("Owner-only functions", label, "denied", call);
  }

  // ----------------------------------------- an authenticated user with NO
  // profile row.
  //
  // current_user_role() is `select role from profiles where id = auth.uid()`,
  // which returns NULL when there is no row. `NULL <> 'owner'` is NULL, and
  // a plpgsql IF treats NULL as false, so a guard written `if
  // current_user_role() <> 'owner' then raise` is SKIPPED for this caller and
  // the function returns its cost data. 033 uses `is distinct from` instead,
  // which is NULL-safe; this is what proves it.
  //
  // Safe to set up: the profile row is deleted with the service-role client
  // from a user created seconds earlier that owns no sales, services or
  // movements, and the auth user itself is removed in the finally block,
  // which takes any profile row with it (profiles.id cascades from
  // auth.users).
  {
    const ghost = await makeTempUser("noprofile");
    const { error: delError } = await admin.from("profiles").delete().eq("id", ghost.id);
    if (delError) {
      record("No-profile caller", "set-up", "SKIP", `could not remove the profile row: ${delError.message}`);
    } else {
      const { count: left } = await admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("id", ghost.id);
      const ghostClient = createAnonClient();
      const { error: ghostSignIn } = await ghostClient.auth.signInWithPassword({
        email: ghost.email,
        password: ghost.password,
      });
      if (ghostSignIn) {
        record("No-profile caller", "sign in", "SKIP", `could not sign in: ${ghostSignIn.message}`);
      } else {
        record("No-profile caller", "set-up: authenticated, no profile row", "PASS", `profile rows: ${left ?? 0}`);
        for (const [label, call] of [
          ["owner_product_catalog()", () => ghostClient.rpc("owner_product_catalog", { p_search: null, p_category: null, p_limit: 1 })],
          ["owner_product_performance()", () => ghostClient.rpc("owner_product_performance")],
          ["owner_sales_kpi_summary()", () => ghostClient.rpc("owner_sales_kpi_summary")],
          ["owner_margin_trend()", () => ghostClient.rpc("owner_margin_trend")],
          ["owner_gross_net_range()", () => ghostClient.rpc("owner_gross_net_range", { p_start: "2026-10-01", p_end: "2026-10-07", p_bucket: "day" })],
          ["owner_stockin_log()", () => ghostClient.rpc("owner_stockin_log", { p_start: "2026-10-01T00:00:00+08:00", p_end: "2026-10-07T00:00:00+08:00" })],
          ["owner_stockin_by_supplier()", () => ghostClient.rpc("owner_stockin_by_supplier", { p_sku: "J1-0001" })],
        ]) {
          await probe("No-profile caller", label, "denied", call);
        }
        // The write RPCs that guard on v_role have the same shape. undo_sale
        // and undo_service are reported here because they read `v_role <>
        // 'owner'` with no preceding null check, so a caller in this state
        // skips the staff restriction entirely. Probed with an id that does
        // not exist, so nothing can be written either way: "Sale not found."
        // means it got past the role logic, which is the finding.
        for (const [label, call] of [
          ["undo_sale() reaches the role check", () => ghostClient.rpc("undo_sale", { p_sale_id: -1 })],
          ["undo_service() reaches the role check", () => ghostClient.rpc("undo_service", { p_service_id: -1 })],
        ]) {
          const { error } = await call();
          const message = error?.message ?? "";
          const stoppedEarly = /not signed in|no profile found/i.test(message);
          record(
            "No-profile caller",
            label,
            stoppedEarly ? "PASS" : "NOTE",
            message ? `"${message.slice(0, 70)}"` : "no error"
          );
        }
      }
    }
  }

  // ------------------------------------------------- staff can still work
  await probe("Staff can still work", "products, the columns Sales Entry needs", "allowed", () =>
    staff.from("products").select("product_id, sku, name, category, brand, unit_price, stock_on_hand").eq("is_active", true).limit(5)
  );
  await probe("Staff can still work", "product categories", "allowed", () =>
    staff.from("products").select("category").limit(5)
  );
  await probe("Staff can still work", "sales, the columns the tracker shows", "allowed", () =>
    staff.from("sales").select("sale_id, sale_ts, total_amount, customer_name, profiles(full_name)").limit(5)
  );
  await probe("Staff can still work", "sale_items, non-cost", "allowed", () =>
    staff.from("sale_items").select("sale_id, sku, quantity, unit_price, line_revenue, products(name)").limit(5)
  );
  await probe("Staff can still work", "services", "allowed", () =>
    staff.from("services").select("service_id, service_ts, service_type, total_amount").limit(5)
  );
  await probe("Staff can still work", "their own profile", "allowed", () =>
    staff.from("profiles").select("id, username, role").eq("id", userId)
  );
  await probe("Staff can still work", "monthly_demand_all() (quantities, no money)", "allowed", () =>
    staff.rpc("monthly_demand_all")
  );

  // confirm_sale: the point is that it is reachable. An empty cart must be
  // refused for the CART, not for permissions - "No items to record." means
  // the function ran as staff and got past every check before that one.
  {
    const { error } = await staff.rpc("confirm_sale", { items: [], note: "staff access check" });
    const message = error?.message ?? "";
    const refusedForTheCart = /no items to record/i.test(message);
    const refusedForAccess = /permission|denied|not allowed|owner/i.test(message);
    record(
      "Staff can still work",
      "confirm_sale() is reachable (empty cart must be refused for the cart)",
      refusedForTheCart && !refusedForAccess ? "PASS" : "FAIL",
      message ? `"${message.slice(0, 70)}"` : "no error at all, which an empty cart should have produced"
    );
  }

  // ------------------------------------------------------------- report
  const groups = [...new Set(results.map((r) => r.group))];
  for (const group of groups) {
    section(group);
    const want =
      group === "Cost columns" || group === "Profit views and RPCs"
        ? AFTER ? "must be DENIED" : "expected to succeed, documenting the hole"
        : group === "Owner-only tables"
          ? AFTER ? "must be DENIED" : "expected to succeed, documenting the hole"
          : group === "Owner-only functions"
            ? "must be DENIED in both modes - the check is inside the function"
            : group === "No-profile caller"
              ? "current_user_role() is NULL here: every owner_* function must still DENY"
              : "must be ALLOWED in both modes";
    console.log(`  ${want}\n`);
    for (const r of results.filter((x) => x.group === group)) {
      console.log(`  ${r.outcome.padEnd(4)}  ${r.label.padEnd(58)} ${r.detail}`);
    }
  }

  const failed = results.filter((r) => r.outcome === "FAIL");
  const skipped = results.filter((r) => r.outcome === "SKIP");
  const notes = results.filter((r) => r.outcome === "NOTE");
  section(failed.length === 0 ? "All checks passed" : `${failed.length} CHECK(S) FAILED`);
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} skipped, nothing to conclude from:`);
    // The group matters here: the same seven functions are probed twice,
    // once as staff and once as a caller with no profile row.
    for (const r of skipped) console.log(`    ${r.group.padEnd(22)} ${r.label.padEnd(30)} ${r.detail}`);
    console.log("");
  }
  for (const r of failed) console.log(`  FAIL  ${r.label}: ${r.detail}`);
  if (notes.length > 0) {
    console.log(`  ${notes.length} noted, not scored - a finding about code this branch does not change:`);
    for (const r of notes) console.log(`    ${r.label}  ${r.detail}`);
    console.log("    undo_sale and undo_service compare `v_role <> 'owner'` with no null");
    console.log("    check first, so a caller with no profile row skips the staff");
    console.log("    restriction. Fix: add `if v_role is null then raise` as the other");
    console.log("    write RPCs do, or use `is distinct from`.");
  }
  if (!AFTER && failed.length === 0) {
    console.log("  This is the BEFORE picture. The cost reads succeeding is the hole that");
    console.log("  migration 034 closes; re-run with --expect=after once it is applied.");
  }
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  // Every user this run created, however it got here.
  console.log("");
  for (const u of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) {
      console.log(`  WARNING: ${u.email} could not be deleted: ${error.message}`);
      console.log("    Delete it by hand in Supabase -> Authentication -> Users.");
      continue;
    }
    // profiles.id cascades from auth.users, so any profile row goes with it.
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("id", u.id);
    console.log(`  deleted ${u.email}  (profile rows left: ${count ?? "unknown"})`);
  }
  if (createdUsers.length === 0) console.log("  no temporary users were created");
}
