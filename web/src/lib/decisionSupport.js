/**
 * Rule-based decision support (paper 3.6), ported from app/rules/engine.py.
 * Deterministic conditions evaluated against current stock balances.
 * Advisory only - never changes stock/orders itself. It records its result
 * into `alerts`, but only when the advice differs from the last batch
 * recorded (see lib/alertsBatch.js); re-recording an identical set on every
 * page load is what grew that table to ~149,000 near-identical rows.
 *
 * Only needs a 3-month moving average (not ARIMA/Holt-Winters), so this
 * stays in Next.js/Postgres rather than calling the Python forecast
 * service - no heavy stats library needed for this one.
 */
import { fetchAllRows } from "./analytics";
import { ALERT_INSERT_CHUNK, advisoryFingerprint, chunkRows } from "./alertsBatch";

const LEAD_TIME_DAYS = 30; // config.SUPPLIER_LEAD_TIME_DAYS
const SPIKE_THRESHOLD_PCT = 30.0; // config.SPIKE_THRESHOLD_PCT
const OVERSTOCK_DOS_DAYS = 90; // config.OVERSTOCK_DOS_DAYS

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Same gap-fill as getSalesHeatmap/monthly_series: a month with zero sales
// inside the SKU's own historical span is a real 0, not a missing point -
// skipping it would silently inflate the moving averages below.
function gapFilledUnits(rows) {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));
  const map = new Map(sorted.map((r) => [`${r.year}-${r.month}`, Number(r.units)]));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const out = [];
  let y = first.year, m = first.month;
  while (y * 12 + m <= last.year * 12 + last.month) {
    out.push(map.get(`${y}-${m}`) ?? 0);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function forecastAndAvg(units) {
  if (units.length === 0) return { fc30: 0, avg12: 0 };
  const w = Math.min(3, units.length);
  const fc30 = round(units.slice(-w).reduce((s, v) => s + v, 0) / w);
  let avg12;
  if (units.length >= 4) {
    const slice = units.slice(-4, -1);
    avg12 = round(slice.reduce((s, v) => s + v, 0) / slice.length);
  } else {
    const slice = units.slice(0, -1);
    avg12 = slice.length ? round(slice.reduce((s, v) => s + v, 0) / slice.length) : 0;
  }
  return { fc30, avg12 };
}

function fmt(x) {
  return x === Infinity ? "∞" : String(Math.round(x));
}

function makeAdvisory(product, type, severity, title, message, recommendation, fc30, dtd, rules, isManualType) {
  return {
    productId: product.product_id,
    sku: product.sku,
    name: product.name,
    type,
    severity,
    title,
    message,
    recommendation,
    onHand: product.stock_on_hand,
    reorderPoint: product.reorder_point,
    forecast30d: fc30,
    daysToDepletion: dtd === Infinity ? null : dtd,
    rules: rules.map(([id, expr, result]) => ({ id, expr, result })),
    // isManualType means the owner picked this *type* themselves (see
    // sql/migrations/020_add_advisory_overrides.sql) - the rules above are
    // still the engine's own real evaluation, which may disagree with
    // the chosen type; that disagreement is expected and shown as-is,
    // never hidden.
    isManualType: !!isManualType,
  };
}

// Builds the standard advisory for a given type off numbers that are
// already computed for every product regardless of which type naturally
// fires - lets a manually-chosen type (owner override) reuse the exact
// same message/rule-trace shape as a rule-triggered one, just built for
// a type the rules themselves may not have picked.
function buildTypeAdvisory(type, p, ctx, isManualType) {
  const { fc30, avg12, dtd, dev, dos, r01, r02, r03, r04, r05, r07, r08, r09 } = ctx;

  if (type === "low_stock") {
    return makeAdvisory(
      p,
      "low_stock",
      "critical",
      "Low Stock Alert",
      `Current stock (${p.stock_on_hand}), reorder point (${p.reorder_point}). Forecasted 30-day demand: ${Math.round(fc30)} units.`,
      "Reorder immediately",
      fc30,
      dtd,
      [
        ["R-01", `stock (${p.stock_on_hand}) ≤ ROP (${p.reorder_point})`, r01],
        ["R-02", `forecast_30d (${Math.round(fc30)}) > on_hand (${p.stock_on_hand})`, r02],
        ["R-03", `days_to_depletion (${fmt(dtd)}) < lead_time (${LEAD_TIME_DAYS})`, r03],
      ],
      isManualType
    );
  }

  if (type === "demand_spike") {
    return makeAdvisory(
      p,
      "demand_spike",
      "warning",
      "Demand Spike Warning",
      `30-day forecast (${Math.round(fc30)} units), 12-week average (${Math.round(avg12)} units), up ${dev.toFixed(1)}%.`,
      "Monitor demand spike",
      fc30,
      dtd,
      [
        ["R-04", `forecast_30d (${Math.round(fc30)}) > avg_12w (${Math.round(avg12)})`, r04],
        ["R-05", `deviation_pct (${dev.toFixed(1)}%) > threshold (${SPIKE_THRESHOLD_PCT.toFixed(0)}%)`, r05],
      ],
      isManualType
    );
  }

  // overstock
  return makeAdvisory(
    p,
    "overstock",
    "warning",
    "Overstock Advisory",
    `Current balance of ${p.stock_on_hand} units with low recent sales.`,
    "Consider markdown",
    fc30,
    dtd,
    [
      ["R-07", `on_hand (${p.stock_on_hand}) > ROP×3 (${p.reorder_point * 3})`, r07],
      ["R-08", 'velocity_class = "Slow-Moving"', r08],
      ["R-09", `days_of_supply (${fmt(dos)}) > ${OVERSTOCK_DOS_DAYS}`, r09],
    ],
    isManualType
  );
}

/**
 * The most recent recorded batch, as { batchId, generatedAt, rows }, or null
 * if `alerts` is empty. Two queries rather than one group-by: the newest row
 * names the newest batch (ix_alert_gen makes that a cheap lookup even at
 * 149k rows), then that batch's own rows are read.
 *
 * generated_ts defaults to now() per INSERT statement, so a chunked batch
 * carries a few values microseconds apart; the newest of them still belongs
 * to the newest batch, which is all this needs to identify it.
 */
async function loadLatestBatch(supabase) {
  const { data: newest, error } = await supabase
    .from("alerts")
    .select("batch_id, generated_ts")
    .order("generated_ts", { ascending: false })
    .order("alert_id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Treated as "no previous batch", which records this run. Recording a
    // duplicate is the safe way to be wrong here - the alternative is
    // silently dropping a real change in the advice.
    console.error("evaluateDecisionSupport: could not read the last alert batch - recording this run:", error.message);
    return null;
  }
  if (!newest) return null;

  const rows = await fetchAllRows(() =>
    supabase
      .from("alerts")
      .select("product_id, alert_type, severity")
      .eq("batch_id", newest.batch_id)
      .order("alert_id")
  );

  return { batchId: newest.batch_id, generatedAt: newest.generated_ts, rows };
}

export async function evaluateDecisionSupport(supabase) {
  const [velocityRows, products, { data: monthlyRows }, { data: overrideRows }] = await Promise.all([
    // Both paged: a plain select stops at PostgREST's 1000-row default, which
    // would quietly drop products from the evaluation (and from the chip
    // totals below). .order() is what makes the paging stable - without a
    // sort, range requests can return overlapping pages.
    fetchAllRows(() => supabase.from("vw_product_velocity").select("sku, units_90d").order("sku")),
    fetchAllRows(() =>
      supabase
        .from("products")
        .select("product_id, sku, name, stock_on_hand, reorder_point")
        .eq("is_active", true)
        .order("product_id")
    ),
    // one query for every SKU's monthly demand, instead of one round trip
    // per product (576 separate calls against the real catalog - fine for
    // a handful of test products, not fine at real scale). Returns 40,000+
    // rows for the real catalog - requires the Supabase project's API "Max
    // Rows" setting (Settings -> API) to be raised above that, since
    // PostgREST's 1000-row default would otherwise silently truncate it.
    // Deliberately NOT paginated client-side: this view's group-by+order-by
    // re-runs its full join across every sale line item on each call, so
    // fetching it in N pages re-pays that full cost N times (~30s total for
    // 43 pages, worse in parallel - it overloads Postgres and pages start
    // timing out). A single call stays the ~1s it always was.
    supabase.rpc("monthly_demand_all"),
    supabase.from("advisory_overrides").select("product_id, manual_type"),
  ]);

  // overrideRows failing (e.g. the migration that creates this table not
  // having been applied yet) would otherwise silently make every owner
  // override stop applying with no visible sign anything's wrong - log it
  // rather than let evaluateDecisionSupport() continue as if there were
  // simply no overrides.
  if (overrideRows === null) {
    console.error("evaluateDecisionSupport: advisory_overrides query failed - overrides will not apply");
  }

  // manual_type is one of 'low_stock' | 'demand_spike' | 'overstock' - the
  // owner's override of which type shows for that SKU, outranking the
  // rule engine's own result. See sql/migrations/020_add_advisory_overrides.sql.
  const manualTypeMap = new Map((overrideRows ?? []).map((r) => [r.product_id, r.manual_type]));
  const velocityMap = new Map(velocityRows.map((r) => [r.sku, Number(r.units_90d) || 0]));
  const nonZero = [...velocityMap.values()].filter((v) => v > 0);
  const velocityMedian = median(nonZero);

  const rowsBySku = new Map();
  for (const r of monthlyRows ?? []) {
    if (!rowsBySku.has(r.sku)) rowsBySku.set(r.sku, []);
    rowsBySku.get(r.sku).push(r);
  }
  const monthlyBySku = new Map();
  for (const p of products) {
    monthlyBySku.set(p.sku, gapFilledUnits(rowsBySku.get(p.sku) ?? []));
  }

  const advisories = [];
  for (const p of products) {
    const units = monthlyBySku.get(p.sku) ?? [];
    const { fc30, avg12 } = forecastAndAvg(units);
    const perDay = fc30 > 0 ? fc30 / 30 : 0;
    const dtd = perDay > 0 ? round(p.stock_on_hand / perDay, 1) : Infinity;
    const dos = dtd;
    const dev = avg12 > 0 ? round(((fc30 - avg12) / avg12) * 100, 1) : 0;
    const velocity = (velocityMap.get(p.sku) ?? 0) <= velocityMedian ? "Slow-Moving" : "Fast-Moving";

    // Every rule check is computed for every product, not just inside the
    // branch that naturally fires - a manually-chosen type still gets a
    // real (if possibly FALSE) rule trace to show, never a fabricated one.
    const r01 = p.stock_on_hand <= p.reorder_point;
    const r02 = fc30 > p.stock_on_hand;
    const r03 = dtd < LEAD_TIME_DAYS;
    const r04 = fc30 > avg12 && avg12 > 0;
    const r05 = dev > SPIKE_THRESHOLD_PCT;
    const r07 = p.reorder_point > 0 && p.stock_on_hand > p.reorder_point * 3;
    const r08 = velocity === "Slow-Moving";
    const r09 = dos > OVERSTOCK_DOS_DAYS;

    const naturalType = r01 ? "low_stock" : r04 && r05 ? "demand_spike" : r07 && (r08 || r09) ? "overstock" : null;
    const manualType = manualTypeMap.get(p.product_id) ?? null;
    const finalType = manualType || naturalType;
    if (!finalType) continue;

    const adv = buildTypeAdvisory(
      finalType,
      p,
      { fc30, avg12, dtd, dev, dos, r01, r02, r03, r04, r05, r07, r08, r09 },
      !!manualType
    );
    // What the rule engine would show with no override - lets the edit UI
    // say "system would currently show: X" even while a manual_type is
    // already active (null = the rules themselves would show nothing).
    adv.naturalType = naturalType;
    advisories.push(adv);
  }

  // One clock read for both, so the batch id and the timestamp reported for
  // it cannot land on either side of a second boundary.
  const generatedAt = new Date().toISOString();
  const batchId = generatedAt.replace(/\D/g, "").slice(0, 14);

  const previous = await loadLatestBatch(supabase);
  // Only the advice itself counts as a change - see lib/alertsBatch.js.
  const unchanged = previous !== null && advisoryFingerprint(previous.rows) === advisoryFingerprint(advisories);

  let recorded = false;
  // The batch that now matches what is on screen. Null when nothing matches
  // it: either `alerts` is empty, or the set has gone empty and this schema
  // has no way to record a batch of no rows.
  let lastChangedAt = unchanged ? previous.generatedAt : null;

  if (!unchanged && advisories.length > 0) {
    const rows = advisories.map((a) => ({
      batch_id: batchId,
      product_id: a.productId,
      sku: a.sku,
      product_name: a.name,
      alert_type: a.type,
      severity: a.severity,
      stock_on_hand: a.onHand,
      reorder_point: a.reorderPoint,
      forecast_30d: a.forecast30d,
      days_to_depletion: a.daysToDepletion,
      recommendation: a.recommendation,
      rule_trace: (
        (a.isManualType ? "MANUAL OVERRIDE; " : "") +
        a.rules.map((r) => `${r.id} ${r.expr} -> ${r.result ? "TRUE" : "FALSE"}`).join("; ")
      ).slice(0, 255),
    }));

    for (const chunk of chunkRows(rows, ALERT_INSERT_CHUNK)) {
      const { error } = await supabase.from("alerts").insert(chunk);
      if (error) {
        // A half-written batch does not match the current set, so the next
        // run compares against it, sees a difference and records again -
        // wasteful but self-correcting, and never a silent loss.
        console.error("evaluateDecisionSupport: alert batch insert failed:", error.message);
        break;
      }
      recorded = true;
    }
    if (recorded) lastChangedAt = generatedAt;
  }

  // Each product yields at most one advisory (one finalType, or none), so
  // the products with no advisory are exactly the rest of the active
  // catalog - which is what lets the four chip counts add up to the active
  // product count, and the four unit totals to total stock on hand.
  const byType = {};
  const unitsByType = {};
  for (const a of advisories) {
    byType[a.type] = (byType[a.type] ?? 0) + 1;
    unitsByType[a.type] = (unitsByType[a.type] ?? 0) + a.onHand;
  }

  const advised = new Set(advisories.map((a) => a.productId));
  const noAction = products
    .filter((p) => !advised.has(p.product_id))
    .map((p) => ({
      productId: p.product_id,
      sku: p.sku,
      name: p.name,
      onHand: p.stock_on_hand,
      reorderPoint: p.reorder_point,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  return {
    batchId,
    generatedAt,
    // Whether this run wrote a new batch, and when the advice last actually
    // changed - the Decision Support page shows the latter.
    recorded,
    lastChangedAt,
    count: advisories.length,
    byType,
    unitsByType,
    advisories,
    noAction,
    noActionUnits: noAction.reduce((sum, p) => sum + p.onHand, 0),
    activeProductCount: products.length,
    // Same definition as the dashboard's "Total units in stock": stock_on_hand
    // summed over active products.
    totalUnits: products.reduce((sum, p) => sum + p.stock_on_hand, 0),
  };
}
