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
 * The no-profile group is different: it is about migration 033, not 034, so
 * it must pass in BOTH modes once 033 is applied. Before that it reports the
 * owner_* functions as missing and both undo RPCs as FAIL, which is accurate
 * - that is the bypass 033 closes.
 *
 * Three groups belong to migration 035 and likewise hold in both modes:
 * that edit_sale refuses staff while undo_sale and undo_service do not,
 * that data_origin is not readable by staff (and that taking it away left
 * the rest of those tables readable), and that profile_names() hands staff a
 * colleague's display name and nothing else about the account. They report
 * SKIP until 035 is applied.
 *
 * THE OWNER SIDE is checked too, and for a different kind of bug. Two
 * owner_* functions shipped with a declared return type that did not match
 * what their query returns - units_90d declared numeric arriving as bigint,
 * recorded_by declared text arriving as varchar(128) - and a plpgsql
 * `return query` only notices that when it returns a row. The owner
 * dashboard and the Stock-In Tracker were empty in production while every
 * staff check here passed, because nothing here had ever asked for an
 * owner's rows. So the owner groups call all seven owner_* functions and the
 * reads the owner screens do directly, and a group is only satisfied by ROWS
 * COMING BACK. See sql/migrations/036_fix_owner_function_types.sql.
 *
 * That needs an owner, and there is exactly one real one. It is never
 * touched: a second temporary user is created and promoted with the
 * service-role client, the set of real owners is read before and after and
 * compared, and the temporary owner is deleted in the same finally block as
 * the rest - with its absence confirmed, not assumed.
 *
 * Writes nothing except the temporary users, and one `role` update on a
 * profile row this script created seconds earlier. Exits 1 if any check
 * fails.
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

// One real SKU, used for the ledger read and owner_stockin_by_supplier. It
// has a long movement history, which is the point - a short one would not
// show the per-row RLS cost migration 037 is about.
const TIMED_SKU = "J1-0306";

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

/**
 * edit_sale is owner-only from migration 035. Probed with an id that cannot
 * exist, so nothing is written whatever the answer - and that is also what
 * makes the answer readable: "Sale not found." means the caller got PAST the
 * role guard, which is a FAIL. Anything about the owner, or about a missing
 * profile, is a guard doing its job.
 */
function recordEditSaleRefusal(group, label, error) {
  const message = error?.message ?? "";
  const guarded = /only the owner|no profile found|not signed in|permission/i.test(message);
  const gotPastTheGuard = /not found/i.test(message) && !guarded;
  const absent = /could not find the function|does not exist/i.test(message);
  if (absent) {
    record(group, label, "SKIP", "edit_sale does not exist yet");
    return;
  }
  record(
    group,
    label,
    guarded ? "PASS" : "FAIL",
    message
      ? `"${message.slice(0, 70)}"${gotPastTheGuard ? "  <- past the role guard: 035 is not applied" : ""}`
      : "no error at all, which a missing sale id should have produced"
  );
}

/**
 * probe(), with the wall-clock time of the call recorded alongside.
 *
 * The timings are the reason migration 037 exists: an RLS policy that calls
 * current_user_role() or auth.uid() per row is re-evaluated per row, and a
 * staff read of stock_movements was timing out on 279k of them. `(select
 * current_user_role())` is evaluated once instead. These numbers are one
 * sample from one machine over the public internet, not a benchmark - they
 * are here to show the shape of the change, and to notice if it ever goes
 * back.
 */
const timings = [];
async function timedProbe(group, label, want, fn) {
  const started = Date.now();
  await probe(group, label, want, fn);
  const ms = Date.now() - started;
  timings.push({ label, ms });
  const r = results[results.length - 1];
  r.detail = `${r.detail}, ${fmtInt(ms)} ms`;
}

const admin = createServiceClient();
const stamp = Date.now();
const email = `staff-check-${stamp}@example.invalid`;
const password = `Sc-${stamp}-${Math.random().toString(36).slice(2, 10)}`;
// Every temporary user this run creates, so the finally block can remove all
// of them however it exits.
const createdUsers = [];
let userId = null;

/**
 * The same, promoted to owner with the service-role client and signed in.
 *
 * `update profiles set role = 'owner'` is refused for `authenticated` by the
 * policy from migration 030 - it is the escalation that migration closed -
 * so this goes through the service key, which is what /settings does for its
 * own writes. The id is the one createUser just handed back, never a lookup
 * by role or name, so there is no path from here to the real owner's row.
 */
async function makeTempOwner(label) {
  const user = await makeTempUser(label);
  const { error: promoteError } = await admin
    .from("profiles")
    .update({ role: "owner" })
    .eq("id", user.id);
  if (promoteError) throw new Error(`could not promote the ${label} user: ${promoteError.message}`);

  const { data: check, error: readError } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (readError) throw new Error(`could not re-read the ${label} profile: ${readError.message}`);
  if (check.role !== "owner") throw new Error(`the ${label} user is '${check.role}', not owner`);

  const client = createAnonClient();
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (signInError) throw new Error(`could not sign in as the ${label} owner: ${signInError.message}`);
  return { ...user, client };
}

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
    const label = `${tbl} (${fmtInt(count)} rows exist)`;
    // stock_movements is asked for by name rather than through probe(),
    // which scores ANY error as a denial. On a table this size the staff
    // read used to come back "canceling statement due to statement timeout"
    // - which is not a denial, it is the policy scanning 279k rows and
    // running out of time, and it would have scored PASS while proving
    // nothing. Only a permission error or zero rows counts here.
    if (tbl === "stock_movements" && AFTER) {
      const { data, error } = await staff.from(tbl).select(columns).limit(1);
      const message = error?.message ?? "";
      const denied = /permission denied/i.test(message);
      const emptied = !error && Array.isArray(data) && data.length === 0;
      record(
        "Owner-only tables",
        label,
        denied || emptied ? "PASS" : "FAIL",
        denied
          ? `"${message.slice(0, 60)}"`
          : emptied
            ? "no rows (an RLS policy, not a privilege)"
            : error
              ? `not a denial: "${message.slice(0, 60)}"`
              : `${fmtInt(data?.length ?? 0)} row(s) came back`
      );
      continue;
    }
    await probe("Owner-only tables", label, ownerTableWant, () =>
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
        // undo_sale and undo_service read `v_role <> 'owner'`, which is NULL
        // for this caller, so before 033 the IF was skipped and the staff
        // restriction never applied: they could undo anyone's record from
        // any date. 033 adds the null-role guard the other five write RPCs
        // already had, so both must now refuse with "No profile found for
        // this account."
        //
        // Probed with an id that cannot exist, so nothing is written either
        // way - and that is also what makes the result readable. "Sale not
        // found." is a FAIL: reaching the row lookup at all means the guard
        // did not fire. Anything mentioning a missing profile is the guard
        // working.
        // edit_sale is owner-only from 035, and guarded twice over for this
        // caller: the null-role guard from 033 raises first, and
        // `is distinct from 'owner'` would refuse them even without it.
        {
          const { error } = await ghostClient.rpc("edit_sale", {
            p_sale_id: -1,
            items: [{ product_id: 1, qty: 1 }],
            p_note: "staff access check",
          });
          recordEditSaleRefusal(
            "No-profile caller",
            "edit_sale() refuses a caller with no profile",
            error
          );
        }

        for (const [label, call] of [
          ["undo_sale() refuses a caller with no profile", () => ghostClient.rpc("undo_sale", { p_sale_id: -1 })],
          ["undo_service() refuses a caller with no profile", () => ghostClient.rpc("undo_service", { p_service_id: -1 })],
        ]) {
          const { error } = await call();
          const message = error?.message ?? "";
          const guarded = /no profile found|not signed in/i.test(message);
          const gotPastTheGuard = /not found/i.test(message) && !guarded;
          record(
            "No-profile caller",
            label,
            guarded ? "PASS" : "FAIL",
            message
              ? `"${message.slice(0, 70)}"${gotPastTheGuard ? "  <- past the role logic: 033 is not applied" : ""}`
              : "no error at all, which a missing id should have produced"
          );
        }
      }
    }
  }

  // ----------------------------------------------------- editing a sale
  //
  // Staff could edit their own sales on any date. That is not a correction
  // to one row: edit_sale hands back the stock every old line took, deletes
  // and re-inserts the lines, re-decrements stock for the new ones and
  // writes two movements per product - a staff-initiated rewrite of the
  // ledger and of products.stock_on_hand. 035 makes it owner-only.
  //
  // Both modes: the guard is in 035, not 034. SKIP reads as "035 is not
  // applied" because a staff caller is then told "Sale not found.", which
  // means the function ran their request as far as the row lookup.
  {
    const { error } = await staff.rpc("edit_sale", {
      p_sale_id: -1,
      items: [{ product_id: 1, qty: 1 }],
      p_note: "staff access check",
    });
    recordEditSaleRefusal("Editing a sale", "edit_sale() refuses staff", error);
  }

  // The read behind the edit panel stays open, and should: it is sale_items
  // for one sale, which the Sales Tracker's expanded detail shows anyway.
  // Only the write is owner-only, so the screen hides the panel rather than
  // the data.
  await probe("Editing a sale", "sale_items for one sale is still readable", "allowed", () =>
    staff.from("sale_items").select("product_id, sku, quantity, products(name, unit_price)").limit(1)
  );

  // Undo is NOT taken away, and a check that only proved the refusal would
  // miss the whole point: staff still undo their own records from the
  // current Manila day. Probed with an id that cannot exist - "Sale not
  // found." is the PASS here, because reaching the row lookup means the role
  // logic let them through.
  for (const [label, call] of [
    ["undo_sale() is still reachable by staff", () => staff.rpc("undo_sale", { p_sale_id: -1 })],
    ["undo_service() is still reachable by staff", () => staff.rpc("undo_service", { p_service_id: -1 })],
  ]) {
    const { error } = await call();
    const message = error?.message ?? "";
    const reachedTheLookup = /not found/i.test(message);
    const refusedForAccess = /only the owner|not allowed|permission|no profile/i.test(message);
    record(
      "Editing a sale",
      label,
      reachedTheLookup && !refusedForAccess ? "PASS" : "FAIL",
      message ? `"${message.slice(0, 70)}"` : "no error at all, which a missing id should have produced"
    );
  }

  // -------------------------------------------------- the provenance tag
  //
  // data_origin says a row came from the seed or the simulation. It is not
  // cost, but it is the same kind of thing: something the screens were never
  // meant to say. It used to sit in `note`, where staff read it on the Sales
  // screen and in both CSV exports. Migration 035 moved it and took the
  // grant away, so this is denied in BOTH modes - it has nothing to do with
  // 034. Reported as SKIP until 035 is applied, when the column is absent.
  for (const [tbl, col] of [
    ["sales", "sale_id"],
    ["services", "service_id"],
    ["stock_movements", "movement_id"],
  ]) {
    const { error } = await staff.from(tbl).select(`${col}, data_origin`).limit(1);
    const message = error?.message ?? "";
    const absent = /data_origin/.test(message) && /does not exist|could not find/i.test(message);
    const { data: exists } = await admin.from(tbl).select("data_origin").limit(1);
    if (absent && exists == null) {
      record("Provenance tag", `${tbl}.data_origin`, "SKIP", "the column does not exist yet (035 is not applied)");
      continue;
    }
    record(
      "Provenance tag",
      `${tbl}.data_origin`,
      error ? "PASS" : "FAIL",
      error ? `"${message.slice(0, 70)}"` : "readable by staff, which is what 035 was for"
    );
  }

  // ...and the rest of each table is still readable, which is the half a
  // grant conversion could silently break: 035 replaces the table-wide
  // grants with per-column lists to leave one column out, so this says the
  // lists are complete.
  await probe("Provenance tag", "sales without it, as the screens ask", "allowed", () =>
    staff
      .from("sales")
      .select("sale_id, sale_ts, total_amount, note, user_id, customer_name, customer_vehicle_brand")
      .limit(1)
  );
  await probe("Provenance tag", "services without it, as the screens ask", "allowed", () =>
    staff
      .from("services")
      .select("service_id, service_ts, service_type, total_amount, user_id, customer_name")
      .limit(1)
  );

  // ------------------------------------------------------- colleagues' names
  //
  // The Cashier column needs a name for a sale somebody else recorded. The
  // profiles policy hides other people's rows from staff, so the embedded
  // profiles(full_name) came back empty and every such sale read "Former
  // staff". profile_names() (035) returns only (id, full_name).
  //
  // Two things to settle, and the second matters as much as the first: that
  // staff can call it at all, and that it hands back nothing else - no
  // username (they are email addresses), no role, no is_active.
  {
    const { data, error } = await staff.rpc("profile_names");
    if (error && /could not find the function|does not exist/i.test(error.message)) {
      record("Colleagues' names", "profile_names()", "SKIP", "the function does not exist yet (035 is not applied)");
    } else if (error) {
      record("Colleagues' names", "profile_names() is callable by staff", "FAIL", `"${error.message.slice(0, 70)}"`);
    } else {
      const rows = data ?? [];
      record(
        "Colleagues' names",
        "profile_names() is callable by staff",
        rows.length > 0 ? "PASS" : "FAIL",
        `${fmtInt(rows.length)} name${rows.length === 1 ? "" : "s"}`
      );

      // Every key on every row, not just the first: one row carrying an
      // extra field is the whole leak.
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
      const extra = keys.filter((k) => k !== "id" && k !== "full_name");
      record(
        "Colleagues' names",
        "it returns id and full_name, and nothing else",
        extra.length === 0 && keys.length === 2 ? "PASS" : "FAIL",
        extra.length ? `also returned: ${extra.join(", ")}` : `keys: ${keys.join(", ") || "(none)"}`
      );

      // Named explicitly, because these are the columns that would matter.
      const leaked = keys.filter((k) => /username|email|role|is_active|password/i.test(k));
      record(
        "Colleagues' names",
        "no username, email, role or is_active",
        leaked.length === 0 ? "PASS" : "FAIL",
        leaked.length ? `leaked: ${leaked.join(", ")}` : "none of them are in the result"
      );

      // The point of the whole thing: a colleague's name, not just their own.
      const others = rows.filter((r) => r.id !== userId);
      record(
        "Colleagues' names",
        "it includes somebody other than the caller",
        others.length > 0 ? "PASS" : "FAIL",
        `${fmtInt(others.length)} other account${others.length === 1 ? "" : "s"}`
      );

      // And the direct read it replaces is still shut, which is what makes
      // the function worth having rather than a widened policy.
      const { data: direct } = await staff.from("profiles").select("id, full_name").neq("id", userId);
      record(
        "Colleagues' names",
        "profiles itself still hides other rows",
        (direct ?? []).length === 0 ? "PASS" : "FAIL",
        `${fmtInt((direct ?? []).length)} row${(direct ?? []).length === 1 ? "" : "s"} read directly`
      );
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
    staff.from("sales").select("sale_id, sale_ts, total_amount, user_id, customer_name").limit(5)
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

  // =====================================================================
  //  THE OWNER SIDE
  //
  //  Everything above asks what staff cannot reach. None of it would notice
  //  an owner screen that is simply broken - which is what happened: two
  //  owner_* functions errored on their declared return types and the
  //  dashboard and Stock-In Tracker came back empty, with every check here
  //  green. Rows coming back is the bar.
  // =====================================================================
  {
    // Read first, compared after: the real owner must be untouched by any of
    // this. Sorted so the comparison does not depend on row order.
    const { data: ownersBefore, error: ownersError } = await admin
      .from("profiles")
      .select("id, username")
      .eq("role", "owner");
    if (ownersError) throw new Error(`could not read the owner list: ${ownersError.message}`);
    const before = (ownersBefore ?? []).map((o) => o.id).sort();
    console.log("");
    console.log(`  real owners before the owner checks: ${fmtInt(before.length)}`);

    const owner = await makeTempOwner("owner");
    console.log(`  temporary owner: ${owner.email}`);
    console.log(`  id             : ${owner.id}  (promoted with the service key)`);

    // ------------------------------------------- the seven owner functions
    //
    // Allowed AND non-empty. probe() scores an empty array as a denial, so
    // "allowed" here already means rows came back - which is the half that
    // was missing: both type bugs returned an error, but a function that
    // silently returned nothing would have been just as broken on screen.
    const october = { p_start: "2026-10-01", p_end: "2026-10-31", p_bucket: "day" };
    await probe("Owner functions", "owner_product_catalog()", "allowed", () =>
      owner.client.rpc("owner_product_catalog", { p_search: null, p_category: null, p_limit: 50 })
    );
    await probe("Owner functions", "owner_product_performance() (units_90d::numeric)", "allowed", () =>
      owner.client.rpc("owner_product_performance")
    );
    await probe("Owner functions", "owner_sales_kpi_summary()", "allowed", () =>
      owner.client.rpc("owner_sales_kpi_summary")
    );
    await probe("Owner functions", "owner_margin_trend()", "allowed", () =>
      owner.client.rpc("owner_margin_trend")
    );
    await probe("Owner functions", "owner_gross_net_range()", "allowed", () =>
      owner.client.rpc("owner_gross_net_range", october)
    );
    await probe("Owner functions", "owner_stockin_log() (recorded_by::text)", "allowed", () =>
      owner.client.rpc("owner_stockin_log", {
        p_start: "2026-10-01T00:00:00+08:00",
        p_end: "2026-11-04T00:00:00+08:00",
      })
    );
    await probe("Owner functions", "owner_stockin_by_supplier()", "allowed", () =>
      owner.client.rpc("owner_stockin_by_supplier", { p_sku: TIMED_SKU })
    );

    // The two that were broken returned the wrong TYPE, not the wrong
    // value, so the columns are checked by name as well: a renamed or
    // dropped column is the next version of the same failure.
    const { data: perf } = await owner.client.rpc("owner_product_performance");
    const perfKeys = perf?.length ? Object.keys(perf[0]).sort() : [];
    record(
      "Owner functions",
      "owner_product_performance() returns the columns the dashboard reads",
      ["category", "gross_profit_90d", "name", "reorder_point", "revenue_90d", "sku", "stock_on_hand", "units_90d"]
        .every((k) => perfKeys.includes(k))
        ? "PASS"
        : "FAIL",
      perfKeys.length ? perfKeys.join(", ") : "no rows, so no columns to check"
    );
    const { data: log } = await owner.client.rpc("owner_stockin_log", {
      p_start: "2026-10-01T00:00:00+08:00",
      p_end: "2026-11-04T00:00:00+08:00",
    });
    const logKeys = log?.length ? Object.keys(log[0]).sort() : [];
    record(
      "Owner functions",
      "owner_stockin_log() returns the columns the tracker reads",
      ["balance_after", "movement_id", "movement_ts", "product_name", "quantity", "recorded_by", "reference", "sku", "spent", "supplier", "unit_cost"]
        .every((k) => logKeys.includes(k))
        ? "PASS"
        : "FAIL",
      logKeys.length ? logKeys.join(", ") : "no rows, so no columns to check"
    );

    // ----------------------------------- the reads the owner screens do
    //
    // Not every owner screen goes through a function. These three are the
    // direct table reads, and they are where the per-row RLS cost is paid -
    // so the two the user asked to be measured are timed.
    const { data: product } = await admin
      .from("products")
      .select("product_id, sku")
      .eq("sku", TIMED_SKU)
      .maybeSingle();
    if (!product) {
      record("Owner screens", `ledger for ${TIMED_SKU}`, "SKIP", `no product with sku ${TIMED_SKU}`);
    } else {
      // The stock ledger page, one SKU, exactly the columns it selects.
      await timedProbe("Owner screens", `ledger: stock_movements for ${TIMED_SKU}`, "allowed", () =>
        owner.client
          .from("stock_movements")
          .select("movement_id, movement_ts, movement_type, quantity, balance_after, reference, note, supplier, user_id")
          .eq("product_id", product.product_id)
          .order("movement_ts", { ascending: true })
          .order("movement_id", { ascending: true })
          .range(0, 999)
      );

      // products/delete's three counts, which decide deactivate vs delete.
      for (const [tbl, col] of [
        ["sale_items", "sale_item_id"],
        ["stock_movements", "movement_id"],
        ["alerts", "alert_id"],
      ]) {
        const { count, error } = await owner.client
          .from(tbl)
          .select(col, { count: "exact", head: true })
          .eq("product_id", product.product_id);
        record(
          "Owner screens",
          `products/delete count: ${tbl}`,
          error ? "FAIL" : "PASS",
          error ? `"${error.message.slice(0, 60)}"` : `${fmtInt(count ?? 0)} rows`
        );
      }
    }

    // Decision Support: the newest alert batch, then that batch's rows.
    // This is the read that runs on every Decision Support page load.
    await timedProbe("Owner screens", "decision support: newest alert batch", "allowed", () =>
      owner.client
        .from("alerts")
        .select("batch_id, generated_ts")
        .order("generated_ts", { ascending: false })
        .order("alert_id", { ascending: false })
        .limit(1)
    );
    const { data: newest } = await owner.client
      .from("alerts")
      .select("batch_id")
      .order("generated_ts", { ascending: false })
      .order("alert_id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!newest) {
      record("Owner screens", "decision support: that batch's rows", "SKIP", "no alert batches exist");
    } else {
      await timedProbe("Owner screens", "decision support: that batch's rows", "allowed", () =>
        owner.client
          .from("alerts")
          .select("product_id, alert_type, severity")
          .eq("batch_id", newest.batch_id)
          .order("alert_id")
          .range(0, 999)
      );
    }

    // The owner still reaches the cost columns the functions exist to
    // mediate - through the functions, never through the table. 034 revoked
    // them from `authenticated`, and the owner is `authenticated` too, so
    // this is expected to be DENIED and says so.
    await probe("Owner screens", "products.unit_cost directly (owner is `authenticated` too)", AFTER ? "denied" : "allowed", () =>
      owner.client.from("products").select("sku, unit_cost").limit(1)
    );

    // ----------------------------------------- the real owner, untouched
    const { data: ownersAfter, error: afterError } = await admin
      .from("profiles")
      .select("id, username")
      .eq("role", "owner");
    const after = (ownersAfter ?? []).map((o) => o.id).sort();
    const stillThere = after.filter((id) => id !== owner.id).sort();
    record(
      "The real owner",
      "the real owner list is unchanged",
      !afterError && JSON.stringify(stillThere) === JSON.stringify(before) ? "PASS" : "FAIL",
      afterError
        ? `"${afterError.message.slice(0, 60)}"`
        : `${fmtInt(before.length)} before, ${fmtInt(stillThere.length)} after (the temporary one excluded)`
    );
    record(
      "The real owner",
      "the temporary owner was the only one added",
      after.length === before.length + 1 ? "PASS" : "FAIL",
      `${fmtInt(after.length)} owner row${after.length === 1 ? "" : "s"} while the checks ran`
    );
  }

  // ------------------------------------------------------------- report
  const groups = [...new Set(results.map((r) => r.group))];
  for (const group of groups) {
    section(group);
    const beforeOrAfter = AFTER ? "must be DENIED" : "expected to succeed, documenting the hole";
    const want =
      {
        "Cost columns": beforeOrAfter,
        "Profit views and RPCs": beforeOrAfter,
        "Owner-only tables": beforeOrAfter,
        "Owner-only functions": "must be DENIED in both modes - the check is inside the function",
        "No-profile caller":
          "current_user_role() is NULL here: every owner_* function, and both undo RPCs, must DENY",
        "Owner functions":
          "all seven must be ALLOWED and must RETURN ROWS - an empty owner screen is the bug",
        "Owner screens":
          "the owner's direct reads must work; the cost columns must not be among them",
        "The real owner":
          "nothing here may touch the one real owner account",
        "Editing a sale":
          "edit_sale must be DENIED in both modes (035, not 034) - and undo must NOT be",
        "Provenance tag":
          "data_origin must be DENIED in both modes (035, not 034); everything beside it must still read",
        "Colleagues' names":
          "the names must be ALLOWED, and nothing else about an account may come with them",
      }[group] ?? "must be ALLOWED in both modes";
    console.log(`  ${want}\n`);
    for (const r of results.filter((x) => x.group === group)) {
      console.log(`  ${r.outcome.padEnd(4)}  ${r.label.padEnd(58)} ${r.detail}`);
    }
  }

  if (timings.length > 0) {
    section("Timings");
    console.log("  One sample each, as an owner, over the public internet. Useful for the");
    console.log("  shape of a change, not as a benchmark.\n");
    for (const t of timings) console.log(`  ${String(fmtInt(t.ms)).padStart(7)} ms  ${t.label}`);
  }

  const failed = results.filter((r) => r.outcome === "FAIL");
  const skipped = results.filter((r) => r.outcome === "SKIP");
  section(failed.length === 0 ? "All checks passed" : `${failed.length} CHECK(S) FAILED`);
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} skipped, nothing to conclude from:`);
    // The group matters here: the same seven functions are probed twice,
    // once as staff and once as a caller with no profile row.
    for (const r of skipped) console.log(`    ${r.group.padEnd(22)} ${r.label.padEnd(30)} ${r.detail}`);
    console.log("");
  }
  for (const r of failed) console.log(`  FAIL  ${r.label}: ${r.detail}`);
  if (!AFTER) {
    const only033 = failed.length > 0 && failed.every((r) => r.group === "No-profile caller");
    const only035 =
      failed.length > 0 &&
      failed.every((r) => r.group === "Editing a sale" || r.group === "Provenance tag" || r.group === "Colleagues' names");
    console.log("  This is the BEFORE picture. The cost reads succeeding is the hole that");
    console.log("  migration 034 closes; re-run with --expect=after once it is applied.");
    if (only033) {
      console.log("");
      console.log("  The failures above are all in the no-profile group, which is about");
      console.log("  migration 033 rather than 034. They are expected to fail until 033 is");
      console.log("  run, and are the reason it needs running: a signed-in caller with no");
      console.log("  profile row currently passes straight through undo_sale's role check.");
    }
    if (only035) {
      console.log("");
      console.log("  The failures above are all in groups that belong to migration 035, not");
      console.log("  034. They fail until 035 is run, and are the reason it needs running -");
      console.log("  most of all edit_sale, which a staff caller currently gets as far as the");
      console.log("  row lookup: today they can rewrite their own sale, and the ledger with");
      console.log("  it. Run 035 and re-run this.");
    }
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
