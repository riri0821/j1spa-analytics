"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { pagedQuery } from "@/lib/analytics";
import { theme } from "../dashboard/theme";
import RecordsTable, { CustomerDetail } from "./RecordsTable";
import { formatManilaDateTime } from "@/lib/ledger";
import { fetchProfileNames, cashierName } from "@/lib/profileNames";
import DateWindowPicker, { useDateWindow } from "@/components/DateWindowPicker";

// .in() goes into the request URL, so a year of sales would build a query
// string long enough for the server to reject. The ids are sent in chunks.
const ID_CHUNK = 200;

// One count per sale, paged and chunked - a busy window has more than 1000
// line items, and the old single unpaged .in() silently kept only the first
// 1000, under-reporting "N line(s)".
async function countSaleLines(supabase, saleIds) {
  const counts = {};
  for (let i = 0; i < saleIds.length; i += ID_CHUNK) {
    const chunk = saleIds.slice(i, i + ID_CHUNK);
    const { rows, error } = await pagedQuery(() =>
      supabase.from("sale_items").select("sale_id").in("sale_id", chunk).order("sale_item_id")
    );
    if (error) return { counts, error };
    for (const item of rows) counts[item.sale_id] = (counts[item.sale_id] ?? 0) + 1;
  }
  return { counts, error: null };
}

export default function SalesTracker({ role }) {
  const supabase = createClient();
  // Peso amounts (the window total, each record's total, and per-line
  // totals in the expanded detail) are owner-only on this screen, same as
  // unit cost and gross profit elsewhere in Sales.
  const isOwner = role === "owner";
  // Same Day/Week/Month/Year windows as the dashboard's Gross & Net chart,
  // kept in the URL under st=/stStart= so it cannot collide with the Sales
  // page's own ?tab=.
  const { granularity, start, window: win, setWindow } = useDateWindow("st");
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const { startInstant, endInstantExclusive } = win;

  const load = useCallback(
    async () => {
      setLoading(true);
      setError("");

      // Both bounds, as Manila-time instants: the window is closed at the
      // top now, so paging back shows that period alone rather than
      // everything since it.
      const [salesRes, servicesRes] = await Promise.all([
        pagedQuery(() =>
          supabase
            .from("sales")
            .select(
              "sale_id, sale_ts, total_amount, user_id, customer_name, customer_contact, customer_address, customer_vehicle_brand"
            )
            .eq("status", "confirmed")
            .gte("sale_ts", startInstant)
            .lt("sale_ts", endInstantExclusive)
            // By time, not by id - see SalesScreen. sale_id is unique, so it
            // keeps the paging stable as the tie-break.
            .order("sale_ts", { ascending: false })
            .order("sale_id", { ascending: false })
        ),
        pagedQuery(() =>
          supabase
            .from("services")
            .select(
              "service_id, service_ts, service_type, total_amount, user_id, customer_name, customer_contact, customer_address, customer_vehicle_brand"
            )
            .eq("status", "confirmed")
            .gte("service_ts", startInstant)
            .lt("service_ts", endInstantExclusive)
            .order("service_ts", { ascending: false })
            .order("service_id", { ascending: false })
        ),
      ]);

      if (salesRes.error || servicesRes.error) {
        setLoading(false);
        setError(salesRes.error || servicesRes.error);
        return;
      }

      const sales = salesRes.rows;
      const services = servicesRes.rows;

      let lineCounts = {};
      if (sales.length > 0) {
        const { counts, error: countError } = await countSaleLines(
          supabase,
          sales.map((s) => s.sale_id)
        );
        if (countError) {
          setLoading(false);
          setError(countError);
          return;
        }
        lineCounts = counts;
      }

      // From profile_names(), not an embedded profiles(full_name) - see
      // src/lib/profileNames.js for why the embed came back empty for staff.
      const { names } = await fetchProfileNames(supabase);

      const saleRows = sales.map((s) => ({
        ...s,
        key: `sale-${s.sale_id}`,
        kind: "Sale",
        ts: s.sale_ts,
        detail: `${lineCounts[s.sale_id] ?? 0} line(s)`,
        cashier: cashierName(names, s.user_id),
      }));
      const serviceRows = services.map((s) => ({
        ...s,
        key: `service-${s.service_id}`,
        kind: "Service",
        ts: s.service_ts,
        detail: s.service_type,
        cashier: cashierName(names, s.user_id),
      }));

      setRecords([...saleRows, ...serviceRows].sort((a, b) => new Date(b.ts) - new Date(a.ts)));
      setLoading(false);
    },
    [supabase, startInstant, endInstantExclusive]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" style={{ color: theme.textMuted }}>
          View-only record of confirmed sales and services.
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
          renderId={(r) => `#${r.sale_id ?? r.service_id}`}
          columns={[
            { label: "Time", render: (r) => formatManilaDateTime(r.ts) },
            { label: "Type", render: (r) => r.kind },
            { label: "Cashier", render: (r) => r.cashier },
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
