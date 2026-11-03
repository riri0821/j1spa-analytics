"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { theme } from "@/app/dashboard/theme";

// Shared "N-M of T" + prev/next chevrons control, styled to match the
// dashboard Tracking table. Always placed above the list/table it
// paginates, not below - pass it as a Card's `actions` prop, or as a
// sibling placed before the list in a header row of its own.
//
// The last four props are opt-in extras for the stock ledger, which needs a
// fuller control strip than a filtered table does. Every one of them is off
// by default, so Tracking, Products, Sales records and Decision Support keep
// rendering exactly the count-plus-two-chevrons strip they always have:
//
//   unitLabel         names what is being counted: "Rows 11-20 of 1165".
//   showEdges         adds First / Last buttons, and spells out Prev / Next
//                     beside their chevrons - between two word buttons, a
//                     pair of bare arrows reads like a rendering mistake.
//   showPageIndicator adds "Page 3 of 117" between Prev and Next.
//   showJump          adds a page-number box with a Go button, for a history
//                     too long to walk a page at a time.
export default function PaginationControls({
  rangeStart,
  rangeEnd,
  total,
  page,
  totalPages,
  onPageChange,
  unitLabel,
  showEdges = false,
  showPageIndicator = false,
  showJump = false,
}) {
  if (total === 0) return null;

  // Only the extended strip is long enough to need a second line; the plain
  // one is four items wide and must keep laying out exactly as it did.
  const extended = showEdges || showPageIndicator || showJump;

  return (
    <div
      className={`flex items-center gap-2 text-xs ${extended ? "flex-wrap" : ""}`}
      style={{ color: theme.textMuted }}
    >
      <span className="tabular-nums">
        {unitLabel ? `${unitLabel} ${rangeStart}–${rangeEnd} of ${total}` : `${rangeStart}-${rangeEnd} of ${total}`}
      </span>
      <div className="flex items-center gap-0.5">
        {showEdges && (
          <EdgeButton onClick={() => onPageChange(1)} disabled={page === 1}>
            First
          </EdgeButton>
        )}
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
          aria-label="Previous page"
          className={`flex h-6 items-center justify-center gap-0.5 rounded hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${showEdges ? "" : "w-6"}`}
          style={{ color: theme.textSecondary }}
        >
          <ChevronLeft className="h-4 w-4" />
          {showEdges && <span className="pr-1">Prev</span>}
        </button>
        {showPageIndicator && (
          <span className="px-1.5 tabular-nums whitespace-nowrap">
            Page {page} of {totalPages}
          </span>
        )}
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          aria-label="Next page"
          className={`flex h-6 items-center justify-center gap-0.5 rounded hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${showEdges ? "" : "w-6"}`}
          style={{ color: theme.textSecondary }}
        >
          {showEdges && <span className="pl-1">Next</span>}
          <ChevronRight className="h-4 w-4" />
        </button>
        {showEdges && (
          <EdgeButton onClick={() => onPageChange(totalPages)} disabled={page === totalPages}>
            Last
          </EdgeButton>
        )}
      </div>
      {showJump && <JumpToPage totalPages={totalPages} onPageChange={onPageChange} />}
    </div>
  );
}

function EdgeButton({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 items-center rounded px-1.5 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      style={{ color: theme.textSecondary }}
    >
      {children}
    </button>
  );
}

// Deliberately not a <form>: this control is dropped into header rows that
// already contain one (the Products search box), and nesting forms is
// invalid HTML. Enter is wired up by hand instead.
function JumpToPage({ totalPages, onPageChange }) {
  const [value, setValue] = useState("");

  function go() {
    const asked = Number(value);
    // A blank or non-numeric box is a no-op rather than a jump to page 1 -
    // the server clamps too, but there is no reason to navigate at all.
    if (value.trim() !== "" && Number.isInteger(asked) && asked >= 1) {
      onPageChange(Math.min(asked, totalPages));
    }
    setValue("");
  }

  return (
    <span className="flex items-center gap-1">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go();
          }
        }}
        inputMode="numeric"
        aria-label="Go to page"
        placeholder="Page"
        className="w-14 rounded border px-1.5 py-0.5 text-xs tabular-nums"
        style={{ backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary }}
      />
      <button
        onClick={go}
        className="rounded border px-1.5 py-0.5 font-medium"
        style={{ borderColor: theme.border, color: theme.textSecondary }}
      >
        Go
      </button>
    </span>
  );
}
