"use client";

import { useState } from "react";
import { theme } from "../dashboard/theme";
import AdvisoryCard from "./AdvisoryCard";
import PaginationControls from "@/components/PaginationControls";

const PAGE_SIZE = 20;

const TYPE_LABEL = {
  low_stock: "Low stock",
  demand_spike: "Demand spike",
  overstock: "Overstock",
};

const CHIPS = [
  { type: "low_stock", label: "Low stock", severity: "critical" },
  { type: "demand_spike", label: "Demand spike", severity: "warning" },
  { type: "overstock", label: "Overstock", severity: "warning" },
];

export default function AdvisoryList({ advisories, byType, severityColor }) {
  const [typeFilter, setTypeFilter] = useState(null);
  const [page, setPage] = useState(1);

  const filtered = typeFilter ? advisories.filter((a) => a.type === typeFilter) : advisories;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, filtered.length);

  function toggleFilter(type) {
    setTypeFilter((t) => (t === type ? null : type));
    setPage(1);
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex gap-3">
          {CHIPS.map((c) => (
            <SummaryChip
              key={c.type}
              label={c.label}
              count={byType[c.type] ?? 0}
              color={severityColor[c.severity]}
              active={typeFilter === c.type}
              onClick={() => toggleFilter(c.type)}
            />
          ))}
        </div>
        <PaginationControls
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={filtered.length}
          page={currentPage}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: theme.textMuted }}>
          {typeFilter ? "No advisories match this filter." : "No advisories right now - nothing needs attention."}
        </p>
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

function SummaryChip({ label, count, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg border px-4 py-2"
      style={{
        backgroundColor: active ? `${color}22` : theme.cardBg,
        borderColor: active ? color : theme.border,
      }}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-lg font-semibold tabular-nums" style={{ color: theme.textPrimary }}>
        {count}
      </span>
      <span className="text-xs" style={{ color: theme.textSecondary }}>
        {label}
      </span>
    </button>
  );
}
