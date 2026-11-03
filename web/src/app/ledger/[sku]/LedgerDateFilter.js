"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { theme } from "../../dashboard/theme";

// The range lives in the URL so an owner can hand a colleague the exact view
// they are looking at. Local state mirrors it only so the picker updates
// immediately instead of waiting for the server round trip.
export default function LedgerDateFilter({ sku, from, to }) {
  const router = useRouter();
  const [range, setRange] = useState({ from: from ?? "", to: to ?? "" });

  function apply(next) {
    setRange(next);
    // Built from scratch, which deliberately drops any ?page= - a new range
    // has a different number of pages, so an old page number means nothing
    // in it. Leaving it out returns the ledger to its default view, the last
    // page. Do not carry the existing params over here.
    const params = new URLSearchParams();
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    const query = params.toString();
    router.push(`/ledger/${encodeURIComponent(sku)}${query ? `?${query}` : ""}`);
  }

  const inputStyle = {
    backgroundColor: theme.cardBgAlt,
    borderColor: theme.border,
    color: theme.textPrimary,
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: theme.textMuted }}>
      <label className="flex items-center gap-1.5">
        From
        <input
          type="date"
          value={range.from}
          max={range.to || undefined}
          onChange={(e) => apply({ ...range, from: e.target.value })}
          className="rounded border px-2 py-1"
          style={inputStyle}
        />
      </label>
      <label className="flex items-center gap-1.5">
        To
        <input
          type="date"
          value={range.to}
          min={range.from || undefined}
          onChange={(e) => apply({ ...range, to: e.target.value })}
          className="rounded border px-2 py-1"
          style={inputStyle}
        />
      </label>
      {(range.from || range.to) && (
        <button
          type="button"
          onClick={() => apply({ from: "", to: "" })}
          className="rounded border px-2 py-1 font-medium"
          style={{ borderColor: theme.border, color: theme.textSecondary }}
        >
          All time
        </button>
      )}
    </div>
  );
}
