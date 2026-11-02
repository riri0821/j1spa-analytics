"use client";

import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { theme, CATEGORICAL, CATEGORY_OTHER } from "./theme";

// Categorical identity -> fixed hue order, capped at 5 slices + a folded
// tail (dataviz skill: past a handful of series, fold the tail rather than
// keep generating new hues).
const FOLD_AFTER = 5;

// Pinned to en-US rather than the viewer's locale: the hero card's "Total
// units in stock" is formatted on the server and this total in the browser,
// and the whole point of the centre figure is that the two read identically.
const fmt = (n) => Number(n).toLocaleString("en-US");

// Integer percentages that sum to exactly 100 (largest-remainder method):
// rounding each share on its own routinely lands on 99% or 101%, which is
// precisely the "do these add up?" check this chart exists to answer.
// Computed against the category sum, so the displayed shares total 100 even
// if that sum ever drifts from the hero card's total (warned about below).
function percentages(values, total) {
  if (!total) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  let leftover = 100 - out.reduce((s, n) => s + n, 0);
  const byRemainder = exact
    .map((e, i) => ({ i, remainder: e - Math.floor(e) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { i } of byRemainder) {
    if (leftover <= 0) break;
    out[i] += 1;
    leftover -= 1;
  }
  return out;
}

export default function StockByCategoryChart({ data, totalUnits }) {
  const [showAll, setShowAll] = useState(false);

  const categorySum = data.reduce((s, d) => s + d.units, 0);
  // The hero card's figure is the one to show, so a drift between the two is
  // a bug in summarizeDashboard() rather than something to paper over.
  const centreTotal = totalUnits ?? categorySum;

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (totalUnits !== undefined && categorySum !== totalUnits) {
      console.warn(
        `[StockByCategoryChart] category units (${categorySum}) do not add up to ` +
          `totalUnitsInStock (${totalUnits}) - the donut's centre total and the hero ` +
          "card's disagree. Check summarizeDashboard() in src/lib/analytics.js."
      );
    }
  }, [categorySum, totalUnits]);

  if (data.length === 0) {
    return (
      <p className="text-sm" style={{ color: theme.textMuted }}>
        No stock yet.
      </p>
    );
  }

  const tail = data.slice(FOLD_AFTER);
  // `isFold` rather than a name check: "Other Parts" is a real category in
  // this catalog, so matching on the label would colour and caption a
  // genuine category as if it were the folded tail.
  const slices =
    tail.length > 0
      ? [
          ...data.slice(0, FOLD_AFTER),
          {
            category: `Other categories (${tail.length})`,
            units: tail.reduce((s, d) => s + d.units, 0),
            isFold: true,
          },
        ]
      : data.slice(0, FOLD_AFTER);

  const slicePct = percentages(
    slices.map((s) => s.units),
    categorySum
  );
  const allPct = percentages(
    data.map((d) => d.units),
    categorySum
  );

  const colorFor = (slice, i) => (slice.isFold ? CATEGORY_OTHER : CATEGORICAL[i % CATEGORICAL.length]);

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-6">
      <div className="relative w-full sm:w-1/2">
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={slices}
              dataKey="units"
              nameKey="category"
              innerRadius={62}
              outerRadius={100}
              paddingAngle={2}
              stroke={theme.cardBg}
              strokeWidth={2}
            >
              {slices.map((s, i) => (
                <Cell key={s.category} fill={colorFor(s, i)} />
              ))}
            </Pie>
            <Tooltip
              // Pinned to the top-left corner instead of following the
              // cursor. Hovering the ring's inner edge put the default
              // tooltip straight over the centre total, which is the one
              // number on this card that has to stay readable; the corner is
              // outside the ring and well clear of the centre at any width.
              position={{ x: 0, y: 0 }}
              formatter={(value) => fmt(value)}
              contentStyle={{
                background: theme.cardBg,
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                fontSize: 12,
                color: theme.textPrimary,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              }}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: theme.textMuted }}>
            Total units
          </span>
          <span className="text-xl font-semibold tabular-nums" style={{ color: theme.textPrimary }}>
            {fmt(centreTotal)}
          </span>
        </div>
      </div>

      <div className="flex w-full flex-col gap-2 sm:w-1/2">
        <ul className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs">
          {slices.map((s, i) => (
            <li key={s.category} className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(s, i) }} />
              <span className="truncate" style={{ color: theme.textSecondary }}>
                {s.category}
              </span>
              <span className="ml-auto whitespace-nowrap tabular-nums" style={{ color: theme.textPrimary }}>
                {fmt(s.units)} ({slicePct[i]}%)
              </span>
            </li>
          ))}
        </ul>

        {/* Every category's own number, so the list can be checked against
            the centre total rather than taken on trust. */}
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start text-[11px] underline-offset-2 hover:underline"
          style={{ color: theme.textMuted }}
          aria-expanded={showAll}
        >
          {showAll ? "Hide full list" : `Show all categories (${data.length})`}
        </button>

        {showAll && (
          <ul
            className="max-h-40 overflow-y-auto rounded border p-2 text-xs"
            style={{ borderColor: theme.border, backgroundColor: theme.cardBgAlt }}
          >
            {data.map((d, i) => (
              <li key={d.category} className="flex items-center gap-2 py-0.5">
                <span className="truncate" style={{ color: theme.textSecondary }}>
                  {d.category}
                </span>
                <span className="ml-auto whitespace-nowrap tabular-nums" style={{ color: theme.textPrimary }}>
                  {fmt(d.units)} ({allPct[i]}%)
                </span>
              </li>
            ))}
            <li
              className="mt-1 flex items-center gap-2 border-t pt-1 font-medium"
              style={{ borderColor: theme.border }}
            >
              <span style={{ color: theme.textSecondary }}>All {data.length} categories</span>
              <span className="ml-auto whitespace-nowrap tabular-nums" style={{ color: theme.textPrimary }}>
                {fmt(categorySum)} (100%)
              </span>
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
