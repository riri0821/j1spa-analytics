"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { createClient } from "@/lib/supabase/client";
import { theme, CATEGORICAL } from "./theme";
import DateWindowPicker, { useDateWindow } from "@/components/DateWindowPicker";
import { bucketLabel } from "@/lib/grossNetRange";

// The migration that adds dashboard_gross_net_range may not have been run
// yet; PostgREST answers an unknown function with its own code rather than a
// SQL error, so both are treated as "not installed" and the chart says what
// to run instead of showing a failed request.
const MISSING_FUNCTION = "Run sql/migrations/028_add_gross_net_range.sql in Supabase";

function isMissingFunction(error) {
  return (
    error?.code === "PGRST202" ||
    error?.code === "42883" ||
    /could not find the function|does not exist/i.test(error?.message ?? "")
  );
}

function fmt(n) {
  return `₱${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const gross = payload.find((p) => p.dataKey === "gross")?.value ?? 0;
  const net = payload.find((p) => p.dataKey === "net")?.value ?? 0;
  return (
    <div
      style={{
        background: theme.cardBg,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        fontSize: 12,
        color: theme.textPrimary,
        padding: "6px 10px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
      }}
    >
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ color: CATEGORICAL[0] }}>Gross: {fmt(gross)}</div>
      <div style={{ color: CATEGORICAL[1] }}>Net: {fmt(net)}</div>
    </div>
  );
}

// Combined sales + services over a window the user picks from a calendar.
// Gross/Net read better as grouped bars than as colour intensity (dataviz
// skill: pick the form before the colour).
export default function GrossNetChart() {
  const supabase = createClient();
  const { granularity, start, window: win, setWindow } = useDateWindow("gn");

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const { startDate, endDate, bucket } = win;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const { data, error: rpcError } = await supabase.rpc("dashboard_gross_net_range", {
      p_start: startDate,
      p_end: endDate,
      p_bucket: bucket,
    });
    setLoading(false);
    if (rpcError) {
      setRows([]);
      setError(isMissingFunction(rpcError) ? MISSING_FUNCTION : rpcError.message);
      return;
    }
    setRows(data ?? []);
  }, [supabase, startDate, endDate, bucket]);

  useEffect(() => {
    // Fetch-on-change: load()'s setState calls land before its first await,
    // the established pattern on these screens rather than a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // The function returns one row per bucket including empty ones, so these
  // totals cover exactly the window shown and the x-axis keeps its full set
  // of bars.
  const totalGross = rows.reduce((s, r) => s + Number(r.gross), 0);
  const totalNet = rows.reduce((s, r) => s + Number(r.net), 0);
  const chartData = rows.map((r) => ({
    period: bucketLabel(r.period_start, bucket),
    gross: Number(r.gross),
    net: Number(r.net),
  }));

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-xs leading-tight">
          <p style={{ color: CATEGORICAL[0] }}>
            Gross: <span className="font-semibold tabular-nums">{fmt(totalGross)}</span>
          </p>
          <p style={{ color: CATEGORICAL[1] }}>
            Net: <span className="font-semibold tabular-nums">{fmt(totalNet)}</span>
          </p>
        </div>
        <DateWindowPicker granularity={granularity} start={start} onChange={setWindow} />
      </div>

      {error ? (
        <p className="text-xs" style={{ color: error === MISSING_FUNCTION ? theme.textMuted : "#f87171" }}>
          {error}
        </p>
      ) : !loading && chartData.length === 0 ? (
        <p className="text-sm" style={{ color: theme.textMuted }}>
          No sales or services in this period.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height="100%" minHeight={160}>
          <BarChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barGap={2}>
            <XAxis
              dataKey="period"
              tick={{ fill: theme.textMuted, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis hide />
            <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={<CustomTooltip />} />
            <Bar dataKey="gross" fill={CATEGORICAL[0]} radius={[4, 4, 0, 0]} maxBarSize={18} />
            <Bar dataKey="net" fill={CATEGORICAL[1]} radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      )}

      <div className="flex items-center gap-3 text-xs" style={{ color: theme.textSecondary }}>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CATEGORICAL[0] }} />
          Gross
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CATEGORICAL[1] }} />
          Net
        </span>
      </div>
    </div>
  );
}
