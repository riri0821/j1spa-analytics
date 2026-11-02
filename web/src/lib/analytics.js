/**
 * Owner analytics dashboard - server-side data + calculations, adapted from
 * app/analytics.py. No more warehouse/ETL: everything reads straight off
 * the operational tables/views (real-time, no "last sync" concept), and
 * the original's two velocity endpoints (api_velocity, api_velocity_table)
 * are merged into one combined product-performance table here.
 */
function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export async function getKpis(supabase) {
  // sales_kpi_summary() aggregates both 90-day buckets in SQL and always
  // returns exactly one row - summing every confirmed sale from the last
  // 180 days client-side instead would hit PostgREST's default 1000-row
  // page at real sales volume, with no order-by to make that slice
  // meaningful.
  const { data } = await supabase.rpc("sales_kpi_summary").single();
  const curRev = Number(data?.current_revenue ?? 0);
  const curCost = Number(data?.current_cost ?? 0);
  const prevRev = Number(data?.previous_revenue ?? 0);
  const prevCost = Number(data?.previous_cost ?? 0);

  const gpm = curRev ? round(((curRev - curCost) / curRev) * 100, 2) : 0;
  const prevGpm = prevRev ? ((prevRev - prevCost) / prevRev) * 100 : 0;

  return {
    grossProfitMarginPct: gpm,
    grossProfitMarginDeltaPct: round(gpm - prevGpm, 2),
  };
}

// Rolling 90-day margin (net / gross, sales + services combined) sampled at
// the last 11 month-ends plus today, so the final point tracks the headline
// tile. Windows with no revenue are dropped rather than plotted as 0%.
export async function getMarginTrend(supabase) {
  const { data, error } = await supabase.rpc("dashboard_margin_trend");
  if (error) console.error("dashboard_margin_trend failed:", error.message);
  return (data ?? [])
    .filter((r) => Number(r.gross) > 0)
    .map((r) => ({
      period: r.period_start,
      margin: round((Number(r.net) / Number(r.gross)) * 100, 2),
    }));
}

// PostgREST answers with at most 1000 rows per request, so a plain select
// starts silently dropping products once the active catalog passes that
// (~576 today). Every total on the dashboard is summed from these rows, so
// a truncated read would understate the stock figures without erroring.
const PAGE_SIZE = 1000;

/**
 * Pages a query to exhaustion, returning whatever it read plus the first
 * error. `query` is a thunk because a Supabase builder is single-use - each
 * page needs a fresh one. Give the query a stable .order(): without a sort,
 * separate range requests may order rows differently and pages can overlap.
 */
export async function pagedQuery(query) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await query().range(offset, offset + PAGE_SIZE - 1);
    if (error) return { rows, error: error.message, offset };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { rows, error: null };
  }
}

/** pagedQuery for callers that just want the rows and a logged failure. */
export async function fetchAllRows(query) {
  const { rows, error, offset } = await pagedQuery(query);
  if (error) {
    // Degrade like the other readers here rather than 500 the whole
    // dashboard, but say plainly that the totals below are now short.
    console.error(`paged read failed at offset ${offset} - totals will be understated:`, error);
  }
  return rows;
}

export async function getProductPerformance(supabase) {
  const [velocity, products] = await Promise.all([
    fetchAllRows(() =>
      // .order() is what makes the paging stable - without a sort, each
      // range request may order rows differently and pages can overlap.
      supabase.from("vw_product_velocity").select("sku, revenue_90d, units_90d, gross_profit_90d").order("sku")
    ),
    fetchAllRows(() =>
      supabase.from("products").select("sku, name, category, stock_on_hand, reorder_point").eq("is_active", true)
    ),
  ]);

  const velBySku = new Map(velocity.map((v) => [v.sku, v]));

  // top 40% by trailing-90d units are "Fast-moving"
  const unitsDesc = products
    .map((p) => Number(velBySku.get(p.sku)?.units_90d ?? 0))
    .sort((a, b) => b - a);
  const cutoff = unitsDesc.length ? unitsDesc[Math.floor(unitsDesc.length * 0.4)] : 0;

  const rows = products.map((p) => {
    const v = velBySku.get(p.sku);
    const units = Number(v?.units_90d ?? 0);
    const movement = units === 0 ? "No recent sales" : units >= Math.max(cutoff, 1) ? "Fast-moving" : "Slow-moving";

    let status, severity;
    if (p.stock_on_hand <= p.reorder_point) {
      status = "Low stock";
      severity = 0;
    } else if (p.reorder_point > 0 && p.stock_on_hand > 3 * p.reorder_point) {
      status = "Overstocked";
      severity = 1;
    } else {
      status = "Stable";
      severity = 2;
    }

    return {
      sku: p.sku,
      name: p.name,
      category: p.category,
      stockOnHand: p.stock_on_hand,
      reorderPoint: p.reorder_point,
      units90d: Math.round(units),
      revenue90d: round(Number(v?.revenue_90d ?? 0), 2),
      grossProfit90d: round(Number(v?.gross_profit_90d ?? 0), 2),
      movement,
      status,
      severity,
    };
  });

  rows.sort((a, b) => a.severity - b.severity || b.units90d - a.units90d);
  return rows;
}

// Everything here is derived from getProductPerformance()'s rows - no extra
// Supabase round trip needed, just different views of the same data.
export function summarizeDashboard(performanceRows) {
  const totalUnitsInStock = performanceRows.reduce((s, r) => s + r.stockOnHand, 0);
  const restockingCritical = performanceRows.filter((r) => r.status === "Low stock").length;

  const topSelling = [...performanceRows]
    .sort((a, b) => b.units90d - a.units90d)
    .slice(0, 5)
    .map((r) => ({ sku: r.sku, name: r.name, units90d: r.units90d }));

  const stockByCategory = new Map();
  for (const r of performanceRows) {
    stockByCategory.set(r.category, (stockByCategory.get(r.category) ?? 0) + r.stockOnHand);
  }
  const categoryTotals = [...stockByCategory.entries()]
    .map(([category, units]) => ({ category, units }))
    .sort((a, b) => b.units - a.units);

  return { totalUnitsInStock, restockingCritical, topSelling, categoryTotals };
}

