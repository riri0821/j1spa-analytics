"use client";

import { useEffect, useState } from "react";
import { theme, CATEGORICAL } from "../dashboard/theme";
import AdvisoryCard from "./AdvisoryCard";
import PaginationControls from "@/components/PaginationControls";

const PAGE_SIZE = 20;

const TYPE_LABEL = {
  low_stock: "Low stock",
  demand_spike: "Demand spike",
  overstock: "Overstock",
};

// Not an advisory type - the pseudo-type for the products the rules had
// nothing to say about.
const NO_ACTION = "no_action";

const CHIPS = [
  { type: "low_stock", label: "Low stock", severity: "critical" },
  { type: "demand_spike", label: "Demand spike", severity: "warning" },
  { type: "overstock", label: "Overstock", severity: "warning" },
  { type: NO_ACTION, label: "No action needed", severity: "info" },
];

const fmt = (n) => Number(n).toLocaleString("en-US");

export default function AdvisoryList({
  advisories,
  byType,
  unitsByType,
  noAction,
  noActionUnits,
  activeProductCount,
  totalUnits,
  severityColor,
}) {
  const [typeFilter, setTypeFilter] = useState(null);
  const [page, setPage] = useState(1);

  const countFor = (type) => (type === NO_ACTION ? noAction.length : (byType[type] ?? 0));
  const unitsFor = (type) => (type === NO_ACTION ? noActionUnits : (unitsByType[type] ?? 0));

  const chipProducts = CHIPS.reduce((sum, c) => sum + countFor(c.type), 0);
  const chipUnits = CHIPS.reduce((sum, c) => sum + unitsFor(c.type), 0);

  // Every active product gets at most one advisory, so these two have to
  // reconcile; if they ever stop, the summary line is lying about the
  // catalog and that is worth knowing in development.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (chipProducts !== activeProductCount) {
      console.warn(
        `[AdvisoryList] chip product counts (${chipProducts}) do not add up to the ` +
          `active product count (${activeProductCount}).`
      );
    }
    if (chipUnits !== totalUnits) {
      console.warn(
        `[AdvisoryList] chip unit totals (${chipUnits}) do not add up to total units ` +
          `in stock (${totalUnits}) - this should match the dashboard's hero card.`
      );
    }
  }, [chipProducts, activeProductCount, chipUnits, totalUnits]);

  const showingNoAction = typeFilter === NO_ACTION;
  const items = showingNoAction
    ? noAction
    : typeFilter
      ? advisories.filter((a) => a.type === typeFilter)
      : advisories;

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const rangeStart = items.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, items.length);

  function toggleFilter(type) {
    setTypeFilter((t) => (t === type ? null : type));
    setPage(1);
  }

  return (
    <>
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="flex flex-wrap gap-3">
          {CHIPS.map((c) => (
            <SummaryChip
              key={c.type}
              label={c.label}
              count={countFor(c.type)}
              units={unitsFor(c.type)}
              color={severityColor[c.severity]}
              active={typeFilter === c.type}
              onClick={() => toggleFilter(c.type)}
            />
          ))}
        </div>
        <PaginationControls
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={items.length}
          page={currentPage}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </div>

      {/* The four chips above partition the active catalog, so these are the
          totals they add up to - the units figure is the same one the
          dashboard's hero card shows. */}
      <p className="mb-6 text-xs tabular-nums" style={{ color: theme.textMuted }}>
        {fmt(activeProductCount)} products · {fmt(totalUnits)} units in stock
      </p>

      {items.length === 0 ? (
        <p style={{ color: theme.textMuted }}>
          {typeFilter ? "No products match this filter." : "No advisories right now - nothing needs attention."}
        </p>
      ) : showingNoAction ? (
        <NoActionTable rows={paginated} />
      ) : (
        <div className="flex flex-col gap-3">
          {paginated.map((a) => (
            <AdvisoryCard
              key={`${a.sku}-${a.type}`}
              advisory={a}
              typeLabel={TYPE_LABEL[a.type]}
              severityColor={severityColor[a.severity]}
            />
          ))}
        </div>
      )}
    </>
  );
}

// These products have no advisory card to show, so they get a compact table
// instead - enough to see the balance behind the chip's unit total, and a
// SKU link through to the full ledger.
function NoActionTable({ rows }) {
  return (
    <div className="overflow-x-auto rounded-lg border" style={{ borderColor: theme.border }}>
      <table className="w-full text-left text-sm">
        <thead style={{ backgroundColor: theme.cardBgAlt, color: theme.textMuted }}>
          <tr>
            <th className="px-3 py-2 font-normal">SKU</th>
            <th className="px-3 py-2 font-normal">Item name</th>
            <th className="px-3 py-2 text-right font-normal">Balance</th>
            <th className="px-3 py-2 text-right font-normal">Reorder point</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.productId} className="border-t" style={{ borderColor: theme.border }}>
              <td className="px-3 py-2 font-mono">
                <a href={`/ledger/${encodeURIComponent(p.sku)}`} style={{ color: CATEGORICAL[0] }}>
                  {p.sku}
                </a>
              </td>
              <td className="px-3 py-2" style={{ color: theme.textPrimary }}>
                {p.name}
              </td>
              <td className="px-3 py-2 text-right tabular-nums" style={{ color: theme.textPrimary }}>
                {fmt(p.onHand)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums" style={{ color: theme.textSecondary }}>
                {fmt(p.reorderPoint)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryChip({ label, count, units, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-0.5 rounded-lg border px-4 py-2"
      style={{
        backgroundColor: active ? `${color}22` : theme.cardBg,
        borderColor: active ? color : theme.border,
      }}
    >
      <span className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-lg font-semibold tabular-nums" style={{ color: theme.textPrimary }}>
          {fmt(count)}
        </span>
        <span className="text-xs" style={{ color: theme.textSecondary }}>
          {label}
        </span>
      </span>
      <span className="pl-4 text-[11px] tabular-nums" style={{ color: theme.textMuted }}>
        {fmt(units)} units
      </span>
    </button>
  );
}
