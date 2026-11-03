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
let userId = null;

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
            : "must be ALLOWED in both modes";
    console.log(`  ${want}\n`);
    for (const r of results.filter((x) => x.group === group)) {
      console.log(`  ${r.outcome.padEnd(4)}  ${r.label.padEnd(58)} ${r.detail}`);
    }
  }

  const failed = results.filter((r) => r.outcome === "FAIL");
  const skipped = results.filter((r) => r.outcome === "SKIP");
  section(failed.length === 0 ? "All checks passed" : `${failed.length} CHECK(S) FAILED`);
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} skipped, nothing to conclude from:`);
    for (const r of skipped) console.log(`    ${r.label.padEnd(40)} ${r.detail}`);
    console.log("");
  }
  for (const r of failed) console.log(`  FAIL  ${r.label}: ${r.detail}`);
  if (!AFTER && failed.length === 0) {
    console.log("  This is the BEFORE picture. The cost reads succeeding is the hole that");
    console.log("  migration 034 closes; re-run with --expect=after once it is applied.");
  }
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    console.log(
      error
        ? `\n  WARNING: the temporary user ${email} could not be deleted: ${error.message}\n  Delete it by hand in Supabase -> Authentication -> Users.`
        : `\n  temporary user deleted (${email})`
    );
    // profiles.id cascades from auth.users, so the profile row goes with it.
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("id", userId);
    console.log(`  profile rows left for it: ${count ?? "unknown"}`);
  }
}
