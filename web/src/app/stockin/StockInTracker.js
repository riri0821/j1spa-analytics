"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { pagedQuery } from "@/lib/analytics";
import { theme } from "../dashboard/theme";
import RecordsTable from "../sales/RecordsTable";
import DateWindowPicker, { useDateWindow } from "@/components/DateWindowPicker";

function money(n) {
  return `₱${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function StockInTracker() {
  const supabase = createClient();
  // Same Day/Week/Month/Year windows as the Sales Tracker and the
  // dashboard's Gross & Net chart, kept in the URL under sit=/sitStart= so
  // the two trackers cannot overwrite each other's view.
  const { granularity, start, window: win, setWindow } = useDateWindow("sit");
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const { startInstant, endInstantExclusive } = win;

  const load = useCallback(
    async () => {
      setLoading(true);
      setError("");

      // Both bounds as Manila-time instants, and paged: a busy year holds
      // more than 1000 stock-in rows, which the old single capped request
      // dropped without saying so.
      const { rows, error: queryError } = await pagedQuery(() =>
        supabase
          .from("stock_movements")
          .select(
            "movement_id, movement_ts, sku, quantity, balance_after, supplier, unit_cost, reference, profiles(full_name), products(name)"
          )
          .eq("movement_type", "stock_in")
          .gte("movement_ts", startInstant)
          .lt("movement_ts", endInstantExclusive)
          .order("movement_id", { ascending: false })
      );

      setLoading(false);
      if (queryError) {
        setError(queryError);
        return;
      }

      setRecords(
        rows.map((r) => ({
          ...r,
          key: `movement-${r.movement_id}`,
          name: r.products?.name ?? r.sku,
          spent: r.unit_cost != null ? Number(r.unit_cost) * r.quantity : null,
        }))
      );
    },
    [supabase, startInstant, endInstantExclusive]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // "From what supplier is that item" - every supplier this SKU has ever
  // been received from (not limited to the date range above), with totals,
  // so a single batch's detail view doubles as that SKU's supplier history.
  async function fetchDetail(row) {
    // Paged, and still deliberately unfiltered by date - this is the SKU's
    // whole stock-in history, so it must not stop at the first 1000 rows.
    const { rows: history } = await pagedQuery(() =>
      supabase
        .from("stock_movements")
        .select("supplier, quantity, unit_cost")
        .eq("sku", row.sku)
        .eq("movement_type", "stock_in")
        .order("movement_id")
    );

    const bySupplier = new Map();
    for (const m of history) {
      const key = m.supplier || "Unknown";
      const entry = bySupplier.get(key) ?? { supplier: key, units: 0, spent: 0, batches: 0 };
      entry.units += m.quantity;
      entry.spent += m.unit_cost != null ? Number(m.unit_cost) * m.quantity : 0;
      entry.batches += 1;
      bySupplier.set(key, entry);
    }
    const breakdown = [...bySupplier.values()].sort((a, b) => b.units - a.units);

    return (
      <>
        <p className="mb-2 text-xs" style={{ color: theme.textMuted }}>
          Supplier breakdown for {row.sku} - {row.name}
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: theme.textMuted }}>
              <th className="px-2 py-1 text-left font-normal">Supplier</th>
              <th className="px-2 py-1 text-right font-normal">Batches</th>
              <th className="px-2 py-1 text-right font-normal">Units received</th>
              <th className="px-2 py-1 text-right font-normal">Total spent</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((b) => (
              <tr key={b.supplier} className="border-t" style={{ borderColor: theme.border }}>
                <td className="px-2 py-1">{b.supplier}</td>
                <td className="px-2 py-1 text-right">{b.batches}</td>
                <td className="px-2 py-1 text-right">{b.units}</td>
                <td className="px-2 py-1 text-right">{money(b.spent)}</td>
              </tr>
            ))}
            {breakdown.length === 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-2 text-center" style={{ color: theme.textMuted }}>
                  No stock-in history for this SKU.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </>
    );
  }

  const totalUnits = records.reduce((s, r) => s + r.quantity, 0);
  const totalSpent = records.reduce((s, r) => s + (r.spent ?? 0), 0);

  return (
    <div className="flex flex-col gap-4" style={{ color: theme.textSecondary }}>
      <div>
        <p className="text-xs" style={{ color: theme.textMuted }}>
          Total spent in this window
        </p>
        <p className="text-2xl font-semibold" style={{ color: theme.textPrimary }}>
          {money(totalSpent)}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" style={{ color: theme.textMuted }}>
          View-only record of stock received. {totalUnits} units.
        </p>
        <DateWindowPicker granularity={granularity} start={start} onChange={setWindow} />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading ? (
        <p className="text-sm" style={{ color: theme.textMuted }}>
          Loading...
        </p>
      ) : (
        <RecordsTable
          rows={records}
          renderId={(r) => `#${r.movement_id}`}
          searchFields={["sku", "name", "supplier"]}
          searchPlaceholder="Search by SKU, item, or supplier..."
          columns={[
            { label: "Time", render: (r) => new Date(r.movement_ts).toLocaleString() },
            { label: "SKU", render: (r) => r.sku },
            { label: "Item", render: (r) => r.name },
            { label: "Supplier", render: (r) => r.supplier ?? "-" },
            { label: "Qty added", align: "right", render: (r) => `+${r.quantity}` },
            { label: "Spent", align: "right", render: (r) => (r.spent != null ? money(r.spent) : "-") },
            { label: "Recorded by", render: (r) => r.profiles?.full_name ?? "Former staff" },
          ]}
          fetchDetail={fetchDetail}
          emptyMessage="No stock received in this window."
        />
      )}
    </div>
  );
}
