"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { theme, CATEGORICAL, STATUS } from "../dashboard/theme";

const STATUS_OPTIONS = [
  { value: "", label: "Auto (system-decided)" },
  { value: "low_stock", label: "Low stock" },
  { value: "demand_spike", label: "Demand spike" },
  { value: "overstock", label: "Overstock" },
];

const TYPE_LABEL = {
  low_stock: "Low stock",
  demand_spike: "Demand spike",
  overstock: "Overstock",
};

export default function AdvisoryCard({ advisory: a, typeLabel, accentColor }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rop, setRop] = useState(String(a.reorderPoint));
  const [status, setStatus] = useState(a.isManualType ? a.type : "");
  const [savingRop, setSavingRop] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [ropError, setRopError] = useState("");
  const [statusError, setStatusError] = useState("");

  // Advisories are computed live off products/advisory_overrides on every
  // page load (lib/decisionSupport.js) - nothing to patch in local state,
  // just re-run the server component so this card reflects whatever the
  // new ROP/status actually produces (it may change type or drop off the
  // list entirely).
  function refresh() {
    router.refresh();
  }

  async function handleSaveRop() {
    const value = Number(rop);
    if (!Number.isInteger(value) || value < 0) {
      setRopError("Enter a whole number, 0 or greater.");
      return;
    }
    setSavingRop(true);
    setRopError("");
    const res = await fetch("/api/products/reorder-point", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: a.productId, reorder_point: value }),
    });
    const json = await res.json();
    setSavingRop(false);
    if (!res.ok) {
      setRopError(json.error ?? "Couldn't save.");
      return;
    }
    refresh();
  }

  async function handleSaveStatus(nextStatus) {
    setSavingStatus(true);
    setStatusError("");
    const res = await fetch("/api/decision-support/advisory-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: a.productId, manual_type: nextStatus }),
    });
    const json = await res.json();
    setSavingStatus(false);
    if (!res.ok) {
      setStatusError(json.error ?? "Couldn't save.");
      return;
    }
    refresh();
  }

  return (
    <div className="rounded-lg border p-4" style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="rounded px-2 py-0.5 text-xs font-medium"
            style={{ backgroundColor: `${accentColor}22`, color: accentColor }}
          >
            {typeLabel}
          </span>
          {a.isManualType && (
            <span
              className="rounded px-2 py-0.5 text-xs font-medium"
              style={{ backgroundColor: `${theme.accent}22`, color: theme.accent }}
              title="The owner set this status manually - the automatic rules below may disagree."
            >
              Manually set
            </span>
          )}
          <span className="font-mono text-sm" style={{ color: theme.textSecondary }}>
            {a.sku}
          </span>
          <span className="text-sm" style={{ color: theme.textPrimary }}>
            {a.name}
          </span>
        </div>
        <span className="text-xs font-medium" style={{ color: theme.textSecondary }}>
          {a.recommendation}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-end">
        <button
          onClick={() => {
            setEditing((v) => !v);
            setRopError("");
            setStatusError("");
            setRop(String(a.reorderPoint));
            setStatus(a.isManualType ? a.type : "");
          }}
          className="shrink-0 text-xs font-medium hover:underline"
          style={{ color: theme.textSecondary }}
        >
          {editing ? "Cancel edit" : "Edit advisory"}
        </button>
      </div>

      {editing && (
        <div
          className="mt-2 flex flex-col gap-3 rounded border p-2"
          style={{ borderColor: theme.border, backgroundColor: theme.cardBgAlt }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs" style={{ color: theme.textSecondary }}>
              Reorder point for {a.sku} (currently {a.reorderPoint}; on hand {a.onHand})
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={rop}
              onChange={(e) => setRop(e.target.value)}
              className="w-24 rounded border px-2 py-1 text-sm"
              style={{ backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.textPrimary }}
            />
            <button
              onClick={handleSaveRop}
              disabled={savingRop}
              className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
              style={{ backgroundColor: theme.accent, color: "#05230f" }}
            >
              {savingRop ? "Saving..." : "Save"}
            </button>
            {ropError && (
              <span className="text-xs" style={{ color: STATUS["Low stock"] }}>
                {ropError}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs" style={{ color: theme.textSecondary }}>
              Advisory status for {a.sku} (system would currently show:{" "}
              {a.naturalType ? TYPE_LABEL[a.naturalType] : "nothing - stable"})
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
              style={{ backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.textPrimary }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => handleSaveStatus(status)}
              disabled={savingStatus}
              className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
              style={{ backgroundColor: theme.accent, color: "#05230f" }}
            >
              {savingStatus ? "Saving..." : "Save"}
            </button>
            {statusError && (
              <span className="text-xs" style={{ color: STATUS["Low stock"] }}>
                {statusError}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mt-2 flex items-start justify-between gap-4">
        <p className="text-sm" style={{ color: theme.textSecondary }}>
          {a.message}
        </p>
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-xs font-medium hover:underline"
          style={{ color: CATEGORICAL[0] }}
        >
          Why? {open ? "▲" : "▼"}
        </button>
      </div>

      {open && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: theme.textMuted }}>
          {a.rules.map((r) => (
            <li key={r.id}>
              <span style={{ color: r.result ? accentColor : theme.textMuted }}>{r.id}</span> {r.expr} →{" "}
              {r.result ? "TRUE" : "FALSE"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
