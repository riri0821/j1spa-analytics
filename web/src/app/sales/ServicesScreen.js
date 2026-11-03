"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { theme } from "../dashboard/theme";
import RecordsTable, { CustomerDetail } from "./RecordsTable";
import { fetchProfileNames, cashierName } from "@/lib/profileNames";
import { formatManilaDateTime } from "@/lib/ledger";

const inputClass = "rounded border px-3 py-1.5 text-sm";
const inputStyle = { backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary };

export default function ServicesScreen({ userId, role }) {
  const supabase = createClient();

  const [serviceType, setServiceType] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerContact, setCustomerContact] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerVehicleBrand, setCustomerVehicleBrand] = useState("");
  const [showCustomerDetails, setShowCustomerDetails] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [recentServices, setRecentServices] = useState([]);

  const loadRecentServices = useCallback(async () => {
    const { data } = await supabase
      .from("services")
      .select(
        "service_id, service_ts, service_type, total_amount, user_id, customer_name, customer_contact, customer_address, customer_vehicle_brand"
      )
      .eq("status", "confirmed")
      // By time, not by id - same reason as the Sales screen: an insert
      // order that is not the event order makes "highest id" the wrong
      // answer. service_id is the tie-break only.
      .order("service_ts", { ascending: false })
      .order("service_id", { ascending: false })
      .limit(200);

    // From profile_names(), not an embedded profiles(full_name) - see
    // src/lib/profileNames.js.
    const { names } = await fetchProfileNames(supabase);

    const today = new Date().toDateString();
    setRecentServices(
      (data ?? []).map((s) => ({
        ...s,
        key: s.service_id,
        cashier: cashierName(names, s.user_id),
        can_undo: role === "owner" || (s.user_id === userId && new Date(s.service_ts).toDateString() === today),
      }))
    );
  }, [supabase, role, userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRecentServices();
  }, [loadRecentServices]);

  async function handleRecord() {
    const amount = Number(totalAmount);
    if (!serviceType.trim() || !Number.isFinite(amount) || amount < 0) return;
    setError("");
    setNotice("");
    setRecording(true);

    const { data, error: rpcError } = await supabase.rpc("record_service", {
      service_type: serviceType.trim(),
      total_amount: amount,
      customer_name: customerName.trim() || null,
      customer_contact: customerContact.trim() || null,
      customer_address: customerAddress.trim() || null,
      customer_vehicle_brand: customerVehicleBrand.trim() || null,
    });

    setRecording(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setNotice(`Service #${data.service_id} recorded - total ${Number(data.total_amount).toFixed(2)}.`);
    setServiceType("");
    setTotalAmount("");
    setCustomerName("");
    setCustomerContact("");
    setCustomerAddress("");
    setCustomerVehicleBrand("");
    setShowCustomerDetails(false);
    loadRecentServices();
  }

  async function handleUndo(row) {
    if (!confirm(`Undo service #${row.service_id}?`)) return;
    setError("");
    const { error: rpcError } = await supabase.rpc("undo_service", { p_service_id: row.service_id });
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNotice(`Service #${row.service_id} undone.`);
    loadRecentServices();
  }

  async function fetchServiceDetail(row) {
    return <CustomerDetail row={row} />;
  }

  return (
    <div className="flex flex-col gap-6" style={{ color: theme.textSecondary }}>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-green-400">{notice}</p>}

      <div className="flex max-w-md flex-col gap-3">
        <h2 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
          Record a service
        </h2>
        <input
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          placeholder="Service type (e.g. Engine tune-up)"
          className={inputClass}
          style={inputStyle}
        />
        <input
          type="number"
          min={0}
          step="0.01"
          value={totalAmount}
          onChange={(e) => setTotalAmount(e.target.value)}
          placeholder="Total"
          className={inputClass}
          style={inputStyle}
        />

        {showCustomerDetails ? (
          <div className="flex flex-col gap-2 rounded border p-3" style={{ borderColor: theme.border }}>
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold" style={{ color: theme.textMuted }}>
                Customer details (optional)
              </h3>
              <button
                type="button"
                onClick={() => setShowCustomerDetails(false)}
                className="text-xs font-medium hover:underline"
                style={{ color: theme.textMuted }}
              >
                Hide
              </button>
            </div>
            <input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Customer name"
              className={inputClass}
              style={inputStyle}
            />
            <input
              value={customerContact}
              onChange={(e) => setCustomerContact(e.target.value)}
              placeholder="Contact number"
              className={inputClass}
              style={inputStyle}
            />
            <input
              value={customerAddress}
              onChange={(e) => setCustomerAddress(e.target.value)}
              placeholder="Address"
              className={inputClass}
              style={inputStyle}
            />
            <input
              value={customerVehicleBrand}
              onChange={(e) => setCustomerVehicleBrand(e.target.value)}
              placeholder="Scooter/motorcycle brand"
              className={inputClass}
              style={inputStyle}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCustomerDetails(true)}
            className="self-start text-sm font-medium hover:underline"
            style={{ color: theme.textSecondary }}
          >
            + Add customer info
          </button>
        )}

        <button
          onClick={handleRecord}
          disabled={!serviceType.trim() || totalAmount === "" || recording}
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ backgroundColor: theme.accent, color: "#05230f" }}
        >
          {recording ? "Recording..." : "Record service"}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
          Recent services
        </h2>
        <RecordsTable
          rows={recentServices}
          renderId={(r) => `#${r.service_id}`}
          columns={[
            { label: "Time", render: (r) => formatManilaDateTime(r.service_ts) },
            { label: "Cashier", render: (r) => r.cashier },
            { label: "Type", render: (r) => r.service_type },
            { label: "Total", align: "right", render: (r) => Number(r.total_amount).toFixed(2) },
          ]}
          fetchDetail={fetchServiceDetail}
          onUndo={handleUndo}
          emptyMessage="No services recorded yet."
        />
      </div>
    </div>
  );
}
