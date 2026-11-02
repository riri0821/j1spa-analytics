"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { theme, CATEGORICAL } from "../dashboard/theme";
import PaginationControls from "@/components/PaginationControls";

const inputClass = "rounded border px-3 py-1.5 text-sm";
const inputStyle = { backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary };
const PAGE_SIZE = 20;

// Generic record list: configurable text search, expandable per-row detail
// (lazily resolved via fetchDetail), pagination, optional Undo. Each row
// needs a unique `key`; `searchFields` says which row properties the search
// box matches against (defaults to customer_name, the original use case).
// Used by Recent sales, Recent services, the merged Sales Tracker, and the
// Stock-In Tracker.
export default function RecordsTable({
  rows,
  renderId,
  columns,
  fetchDetail,
  onUndo,
  onEdit,
  emptyMessage = "No records yet.",
  searchFields = ["customer_name"],
  searchPlaceholder = "Search by customer name...",
}) {
  const [customerSearch, setCustomerSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedKey, setExpandedKey] = useState(null);
  const [detailCache, setDetailCache] = useState({});

  // `rows` gets a new reference whenever the caller actually reloads data
  // (e.g. after an edit or undo) - drop any cached detail so a re-expand
  // refetches instead of showing what a row looked like before the edit.
  // If a row is expanded right now, refetch its detail immediately rather
  // than leaving it stuck on "Loading..." until the user collapses and
  // re-expands it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailCache({});
    if (!expandedKey || !fetchDetail) return;
    const row = rows.find((r) => r.key === expandedKey);
    if (!row) {
      setExpandedKey(null);
      return;
    }
    fetchDetail(row).then((node) => {
      setDetailCache((prev) => ({ ...prev, [expandedKey]: node }));
    });
    // Only `rows` identity should trigger this - expandedKey/fetchDetail
    // changing on their own are handled by toggleDetails instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const filtered = useMemo(() => {
    const term = customerSearch.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => searchFields.some((f) => String(r[f] ?? "").toLowerCase().includes(term)));
  }, [rows, customerSearch, searchFields]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, filtered.length);

  async function toggleDetails(row) {
    if (expandedKey === row.key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(row.key);
    if (!(row.key in detailCache) && fetchDetail) {
      const node = await fetchDetail(row);
      setDetailCache((prev) => ({ ...prev, [row.key]: node }));
    }
  }

  const colCount = columns.length + 2; // id column + undo column

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <input
          value={customerSearch}
          onChange={(e) => {
            setCustomerSearch(e.target.value);
            setPage(1);
          }}
          placeholder={searchPlaceholder}
          className={`max-w-xs ${inputClass}`}
          style={inputStyle}
        />
        <PaginationControls
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={filtered.length}
          page={currentPage}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </div>

      <div className="overflow-x-auto rounded border" style={{ borderColor: theme.border }}>
        <table className="w-full text-left text-sm">
          <thead style={{ backgroundColor: theme.cardBgAlt, color: theme.textMuted }}>
            <tr>
              <th className="px-3 py-2 font-normal">#</th>
              {columns.map((c) => (
                <th key={c.label} className={`px-3 py-2 font-normal ${c.align === "right" ? "text-right" : ""}`}>
                  {c.label}
                </th>
              ))}
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((r) => (
              <Fragment key={r.key}>
                <tr className="border-t" style={{ borderColor: theme.border }}>
                  <td className="px-3 py-2">
                    <button onClick={() => toggleDetails(r)} style={{ color: CATEGORICAL[0] }} className="hover:underline">
                      {renderId(r)}
                    </button>
                  </td>
                  {columns.map((c) => (
                    <td key={c.label} className={`px-3 py-2 ${c.align === "right" ? "text-right" : ""}`}>
                      {c.render(r)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {onEdit && (
                      <button
                        onClick={() => onEdit(r)}
                        className="mr-3 hover:underline"
                        style={{ color: CATEGORICAL[0] }}
                      >
                        Edit
                      </button>
                    )}
                    {onUndo && r.can_undo && (
                      <button onClick={() => onUndo(r)} className="text-red-400 hover:underline">
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
                {expandedKey === r.key && (
                  <tr className="border-t" style={{ borderColor: theme.border, backgroundColor: theme.cardBgAlt }}>
                    <td colSpan={colCount} className="px-3 py-2">
                      {detailCache[r.key] ?? <span style={{ color: theme.textMuted }}>Loading...</span>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-3 py-4 text-center" style={{ color: theme.textMuted }}>
                  {rows.length === 0 ? emptyMessage : "No records match that search."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Shared "Customer: name · contact · address · brand" line for a detail
// row, used by services (which have nothing else to show) and appended
// above the line-items table for sales.
export function CustomerDetail({ row }) {
  const parts = [row.customer_name, row.customer_contact, row.customer_address, row.customer_vehicle_brand].filter(
    Boolean
  );
  if (parts.length === 0) {
    return (
      <p className="text-xs" style={{ color: theme.textMuted }}>
        No customer info recorded.
      </p>
    );
  }
  return (
    <p className="text-xs" style={{ color: theme.textMuted }}>
      Customer: {parts.join(" · ")}
    </p>
  );
}
