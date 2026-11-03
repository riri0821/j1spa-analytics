"use client";

import { useMemo, useState } from "react";
import { theme, STATUS, CATEGORICAL } from "./theme";
import Card from "./Card";
import PaginationControls from "@/components/PaginationControls";
import RowSizeSelect from "@/components/RowSizeSelect";
import { usePageSize } from "@/lib/pageSize";

export default function TrackingTable({ rows }) {
  const [category, setCategory] = useState("all");
  const [movement, setMovement] = useState("all");
  const [status, setStatus] = useState("all");

  const categories = useMemo(() => [...new Set(rows.map((r) => r.category))].sort(), [rows]);

  const filtered = rows.filter(
    (r) =>
      (category === "all" || r.category === category) &&
      (movement === "all" || r.movement === movement) &&
      (status === "all" || r.status === status)
  );

  const {
    rowSize,
    setRowSize,
    page: currentPage,
    setPage,
    totalPages,
    start,
    end,
    rangeStart,
    rangeEnd,
    extended,
  } = usePageSize(filtered.length, "tracking");

  const paginated = filtered.slice(start, end);

  function updateFilter(setter) {
    return (value) => {
      setter(value);
      setPage(1);
    };
  }

  const paginationArrows = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <RowSizeSelect value={rowSize} onChange={setRowSize} />
      <PaginationControls
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        total={filtered.length}
        page={currentPage}
        totalPages={totalPages}
        onPageChange={setPage}
        showEdges={extended}
        showPageIndicator={extended}
        showJump={extended}
      />
    </div>
  );

  return (
    <Card title="Tracking" subtitle="Click a SKU to view its stock ledger" actions={paginationArrows}>
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Select
          value={category}
          onChange={updateFilter(setCategory)}
          options={["all", ...categories]}
          labelAll="All Categories"
        />
        <Select
          value={movement}
          onChange={updateFilter(setMovement)}
          options={["all", "Fast-moving", "Slow-moving", "No recent sales"]}
          labelAll="All Movement"
        />
        <Select
          value={status}
          onChange={updateFilter(setStatus)}
          options={["all", "Low stock", "Overstocked", "Stable"]}
          labelAll="All Statuses"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: theme.border }}>
        <table className="w-full text-left text-sm">
          <thead>
            <tr style={{ color: theme.textMuted }}>
              <th className="px-3 py-2 font-normal">SKU</th>
              <th className="px-3 py-2 font-normal">Item name</th>
              <th className="px-3 py-2 font-normal">Category</th>
              <th className="w-36 px-3 py-2 font-normal">Movement</th>
              {/* "Balance" rather than "Stock level" so it reads as the same
                  figure as the Balance column in the ledger this SKU opens. */}
              <th className="w-32 px-3 py-2 text-center font-normal">Balance</th>
              <th className="w-36 py-2 pl-8 pr-3 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((r) => (
              <tr key={r.sku} className="border-t" style={{ borderColor: theme.border }}>
                <td className="px-3 py-2 font-mono">
                  <a href={`/ledger/${encodeURIComponent(r.sku)}`} style={{ color: CATEGORICAL[0] }}>
                    {r.sku}
                  </a>
                </td>
                <td className="px-3 py-2" style={{ color: theme.textPrimary }}>
                  {r.name}
                </td>
                <td className="px-3 py-2" style={{ color: theme.textSecondary }}>
                  {r.category}
                </td>
                <td className="px-3 py-2" style={{ color: theme.textSecondary }}>
                  {r.movement}
                </td>
                <td className="px-3 py-2 text-center tabular-nums" style={{ color: theme.textSecondary }}>
                  {r.stockOnHand}
                </td>
                <td className="py-2 pl-8 pr-3">
                  <span
                    className="rounded px-2 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: `${STATUS[r.status]}22`, color: STATUS[r.status] }}
                  >
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center" style={{ color: theme.textMuted }}>
                  No products match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
    </Card>
  );
}

function Select({ value, onChange, options, labelAll }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border px-2 py-1.5 text-xs"
      style={{ backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.textSecondary }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o === "all" ? labelAll : o}
        </option>
      ))}
    </select>
  );
}
