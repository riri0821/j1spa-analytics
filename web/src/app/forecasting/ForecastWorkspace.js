"use client";

import { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { theme, CATEGORICAL, STATUS } from "../dashboard/theme";

const MODELS = ["MA", "WMA", "Linear Regression", "ARIMA", "Holt-Winters"];
const HORIZONS = [7, 14, 30, 60, 90];

export default function ForecastWorkspace({ products, initialSku = "" }) {
  // Pre-filled when the page is opened from a product's stock ledger
  // (/forecasting?sku=...). The comparison still waits for the button; only
  // the background prefetch below reacts to the SKU being set.
  const [skuInput, setSkuInput] = useState(initialSku);
  const [horizon, setHorizon] = useState(30);
  const [selectedModels, setSelectedModels] = useState(new Set(MODELS));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const productBySku = useMemo(() => new Map(products.map((p) => [p.sku, p])), [products]);

  function resolveSku(value) {
    const sku = value.split(" — ")[0].trim();
    return productBySku.has(sku) ? sku : null;
  }

  function toggleModel(m) {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        if (next.size > 1) next.delete(m); // always keep at least one selected
      } else {
        next.add(m);
      }
      return next;
    });
  }

  async function runComparison() {
    const sku = resolveSku(skuInput);
    if (!sku) {
      setError("Pick a valid SKU from the list.");
      return;
    }
    setError("");
    setLoading(true);
    setResult(null);

    const params = new URLSearchParams({ horizon: String(horizon), models: [...selectedModels].join(",") });
    const res = await fetch(`/api/forecast/${encodeURIComponent(sku)}?${params}`);
    const body = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(body.error || body.detail || "Forecast request failed.");
      return;
    }
    setResult(body);
  }

  const chartData = useMemo(() => {
    if (!result) return [];
    const hist = (result.history ?? []).map((h) => ({ label: h.label, historical: h.units, forecast: null }));
    const fc = (result.forecast_monthly ?? []).map((f) => ({ label: f.label, historical: null, forecast: f.units }));
    if (hist.length && fc.length) {
      hist[hist.length - 1].forecast = hist[hist.length - 1].historical; // connects the dashed segment to the solid line
    }
    return [...hist, ...fc];
  }, [result]);

  return (
    <div className="flex flex-col gap-4">
      {/* controls */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
        style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}
      >
        <input
          list="sku-options"
          value={skuInput}
          onChange={(e) => setSkuInput(e.target.value)}
          placeholder="Search SKU or name..."
          className="w-64 rounded border px-3 py-1.5 text-sm"
          style={{ backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary }}
        />
        <datalist id="sku-options">
          {products.map((p) => (
            <option key={p.sku} value={`${p.sku} — ${p.name}`} />
          ))}
        </datalist>

        <select
          value={horizon}
          onChange={(e) => setHorizon(Number(e.target.value))}
          className="rounded border px-3 py-1.5 text-sm"
          style={{ backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary }}
        >
          {HORIZONS.map((h) => (
            <option key={h} value={h}>
              {h}-day forecast horizon
            </option>
          ))}
        </select>

        <span className="text-sm" style={{ color: theme.textMuted }}>
          Model comparison:
        </span>
        {MODELS.map((m) => {
          const active = selectedModels.has(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => toggleModel(m)}
              className="rounded-full border px-3 py-1 text-xs font-medium"
              style={
                active
                  ? { borderColor: CATEGORICAL[0], color: CATEGORICAL[0], backgroundColor: `${CATEGORICAL[0]}18` }
                  : { borderColor: theme.border, color: theme.textMuted }
              }
            >
              {m}
            </button>
          );
        })}

        <button
          type="button"
          onClick={runComparison}
          disabled={loading}
          className="ml-auto rounded px-4 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ backgroundColor: theme.accent, color: "#05230f" }}
        >
          {loading ? "Running..." : "Run comparison"}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {result && !result.insufficient_history && (
        <>
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="rounded-lg border p-4" style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}>
              <h2 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
                Historical Sales vs. Forecast
              </h2>
              <p className="mb-3 text-xs" style={{ color: theme.textMuted }}>
                {result.sku} &middot; {result.horizon}-day horizon &middot; Best fit: {result.best_fit_short} &middot; as of{" "}
                {result.as_of}
              </p>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={theme.border} />
                  <XAxis dataKey="label" tick={{ fill: theme.textMuted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.border }} minTickGap={24} />
                  <YAxis tick={{ fill: theme.textMuted, fontSize: 11 }} tickLine={false} axisLine={false} width={30} />
                  <Tooltip
                    contentStyle={{ background: theme.cardBg, border: `1px solid ${theme.border}`, borderRadius: 6, fontSize: 12, color: theme.textPrimary }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: theme.textSecondary }} formatter={(v) => (v === "historical" ? "Historical" : `Forecast: ${result.best_fit_short}`)} />
                  <Line type="monotone" dataKey="historical" stroke={theme.textSecondary} strokeWidth={2} dot={false} connectNulls={false} />
                  <Line type="monotone" dataKey="forecast" stroke={CATEGORICAL[0]} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <DepletionCard result={result} />
          </div>

          <ModelTable models={result.models} />

          <p className="text-xs" style={{ color: theme.textMuted }}>
            {result.observations_used} underlying historical observations &middot; {result.months_history} months. Primary
            metric MSE; the lowest-MSE model is selected per item.
          </p>
        </>
      )}

      {result && result.insufficient_history && (
        <p className="text-sm" style={{ color: theme.textMuted }}>
          {result.reason || "Not enough history yet for a full model comparison."}
        </p>
      )}
    </div>
  );
}

function DepletionCard({ result }) {
  const gap = result.coverage_gap;
  return (
    <div className="rounded-lg border p-4" style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}>
      <h2 className="mb-3 text-sm font-semibold" style={{ color: theme.textPrimary }}>
        Depletion Estimate
      </h2>
      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Current stock balance" value={`${result.stock_on_hand} units`} />
        <Row label="Forecasted 30-day demand" value={`${result.forecast_30d} units`} />
        <Row label="Projected days to depletion" value={result.days_to_depletion !== null ? `~${result.days_to_depletion} days` : "N/A"} />
        <Row label="Reorder point (ROP)" value={`${result.reorder_point} units`} />
        <Row label="Stock coverage gap" value={`${gap >= 0 ? "+" : ""}${gap} units`} />
      </dl>
      <div
        className="mt-4 rounded px-3 py-2 text-xs font-medium"
        style={
          result.stockout_risk
            ? { backgroundColor: `${STATUS["Low stock"]}22`, color: STATUS["Low stock"] }
            : { backgroundColor: `${STATUS.Stable}22`, color: STATUS.Stable }
        }
      >
        {result.stockout_risk ? "⚠ Stockout risk within the forecast horizon" : "✓ Stock cover is adequate for the horizon"}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <dt style={{ color: theme.textSecondary }}>{label}</dt>
      <dd className="font-semibold tabular-nums" style={{ color: theme.textPrimary }}>
        {value}
      </dd>
    </div>
  );
}

function ModelTable({ models }) {
  const entries = Object.entries(models ?? {});
  if (entries.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border" style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}>
      <table className="w-full text-left text-sm">
        <thead>
          <tr style={{ color: theme.textMuted }}>
            <th className="px-4 py-2 font-normal">Model</th>
            <th className="px-4 py-2 font-normal">MSE</th>
            <th className="px-4 py-2 font-normal">RMSE</th>
            <th className="px-4 py-2 font-normal">MAPE</th>
            <th className="px-4 py-2 font-normal">Next month</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, m]) => (
            <tr
              key={name}
              className="border-t"
              style={{
                borderColor: theme.border,
                backgroundColor: m.chosen ? `${CATEGORICAL[0]}14` : "transparent",
              }}
            >
              <td className="px-4 py-2" style={{ color: m.chosen ? CATEGORICAL[0] : theme.textPrimary }}>
                {m.short} {m.chosen && "★"}
              </td>
              <td className="px-4 py-2 tabular-nums" style={{ color: m.chosen ? CATEGORICAL[0] : theme.textSecondary }}>
                {m.mse}
              </td>
              <td className="px-4 py-2 tabular-nums" style={{ color: m.chosen ? CATEGORICAL[0] : theme.textSecondary }}>
                {m.rmse}
              </td>
              <td className="px-4 py-2 tabular-nums" style={{ color: m.chosen ? CATEGORICAL[0] : theme.textSecondary }}>
                {m.mape}%
              </td>
              <td className="px-4 py-2 tabular-nums" style={{ color: m.chosen ? CATEGORICAL[0] : theme.textSecondary }}>
                {m.next}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
