"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { theme } from "../dashboard/theme";
import RecordsTable, { CustomerDetail } from "./RecordsTable";

const MAX_LOOKBACK_MONTHS = 18;

const RANGES = [
  { value: "day", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
];

function rangeStart(range) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (range === "day") {
    // already at today's midnight
  } else if (range === "week") {
    const dow = (start.getDay() + 6) % 7; // 0 = Monday
    start.setDate(start.getDate() - dow);
  } else if (range === "month") {
    start.setDate(1);
  } else if (range === "year") {
    start.setMonth(0, 1);
  }

  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - MAX_LOOKBACK_MONTHS);

  return start < cutoff ? cutoff : start;
}

export default function SalesTracker({ role }) {
  const supabase = createClient();
  // Peso amounts (the window total, each record's total, and per-line
  // totals in the expanded detail) are owner-only on this screen, same as
  // unit cost and gross profit elsewhere in Sales.
  const isOwner = role === "owner";
  const [range, setRange] = useState("month");
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (r) => {
      setLoading(true);
      setError("");
      const since = rangeStart(r).toISOString();

      const [salesRes, servicesRes] = await Promise.all([
        supabase
          .from("sales")
          .select(
            "sale_id, sale_ts, total_amount, customer_name, customer_contact, customer_address, customer_vehicle_brand, profiles(full_name)"
          )
          .eq("status", "confirmed")
          .gte("sale_ts", since)
          .order("sale_id", { ascending: false })
          .limit(1000),
        supabase
          .from("services")
          .select(
            "service_id, service_ts, service_type, total_amount, customer_name, customer_contact, customer_address, customer_vehicle_brand, profiles(full_name)"
          )
          .eq("status", "confirmed")
          .gte("service_ts", since)
          .order("service_id", { ascending: false })
          .limit(1000),
      ]);

      if (salesRes.error || servicesRes.error) {
        setLoading(false);
        setError(salesRes.error?.message || servicesRes.error?.message);
        return;
      }

      const sales = salesRes.data ?? [];
      const services = servicesRes.data ?? [];

      let lineCounts = {};
      if (sales.length > 0) {
        const { data: items } = await supabase
          .from("sale_items")
          .select("sale_id")
          .in("sale_id", sales.map((s) => s.sale_id));
        (items ?? []).forEach((it) => {
          lineCounts[it.sale_id] = (lineCounts[it.sale_id] ?? 0) + 1;
        });
      }

      const saleRows = sales.map((s) => ({
        ...s,
        key: `sale-${s.sale_id}`,
        kind: "Sale",
        ts: s.sale_ts,
        detail: `${lineCounts[s.sale_id] ?? 0} line(s)`,
      }));
      const serviceRows = services.map((s) => ({
        ...s,
        key: `service-${s.service_id}`,
        kind: "Service",
        ts: s.service_ts,
        detail: s.service_type,
      }));

      setRecords([...saleRows, ...serviceRows].sort((a, b) => new Date(b.ts) - new Date(a.ts)));
      setLoading(false);
    },
    [supabase]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(range);
  }, [range, load]);

  async function fetchDetail(row) {
    if (row.kind === "Service") return <CustomerDetail row={row} />;

    const { data } = await supabase
      .from("sale_items")
      .select("sku, quantity, unit_price, line_revenue, products(name)")
      .eq("sale_id", row.sale_id);
    const items = data ?? [];
    return (
      <>
        <CustomerDetail row={row} />
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr style={{ color: theme.textMuted }}>
              <th className="px-2 py-1 text-left font-normal">SKU</th>
              <th className="px-2 py-1 text-left font-normal">Name</th>
              <th className="px-2 py-1 text-right font-normal">Qty</th>
              <th className="px-2 py-1 text-right font-normal">Unit price</th>
              {isOwner && <th className="px-2 py-1 text-right font-normal">Line total</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td className="px-2 py-1 font-mono">{it.sku}</td>
                <td className="px-2 py-1">{it.products?.name}</td>
                <td className="px-2 py-1 text-right">{it.quantity}</td>
                <td className="px-2 py-1 text-right">{Number(it.unit_price).toFixed(2)}</td>
                {isOwner && (
                  <td className="px-2 py-1 text-right">{Number(it.line_revenue).toFixed(2)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }

  const totalAmount = records.reduce((sum, r) => sum + Number(r.total_amount), 0);

  return (
    <div className="flex flex-col gap-4" style={{ color: theme.textSecondary }}>
      {isOwner && (
        <div>
          <p className="text-xs" style={{ color: theme.textMuted }}>
            Total (sales + services) in this window
          </p>
          <p className="text-2xl font-semibold" style={{ color: theme.textPrimary }}>
            {totalAmount.toFixed(2)}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm" style={{ color: theme.textMuted }}>
          View-only record of confirmed sales and services, capped to the trailing {MAX_LOOKBACK_MONTHS} months.
        </p>
        <div className="flex gap-1 rounded border p-1" style={{ borderColor: theme.border }}>
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className="rounded px-3 py-1 text-xs font-medium"
              style={
                range === r.value
                  ? { backgroundColor: theme.accent, color: "#05230f" }
                  : { color: theme.textSecondary }
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading ? (
        <p className="text-sm" style={{ color: theme.textMuted }}>
          Loading...
        </p>
      ) : (
        <RecordsTable
          rows={records}
          renderId={(r) => `#${r.sale_id ?? r.service_id}`}
          columns={[
            { label: "Time", render: (r) => new Date(r.ts).toLocaleString() },
            { label: "Type", render: (r) => r.kind },
            { label: "Cashier", render: (r) => r.profiles?.full_name ?? "Former staff" },
            { label: "Detail", render: (r) => r.detail },
            ...(isOwner
              ? [{ label: "Total", align: "right", render: (r) => Number(r.total_amount).toFixed(2) }]
              : []),
          ]}
          fetchDetail={fetchDetail}
          emptyMessage="No sales or services in this window."
        />
      )}
    </div>
  );
}
