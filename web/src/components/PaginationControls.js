"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { theme } from "@/app/dashboard/theme";

// Shared "N-M of T" + prev/next chevrons control, styled to match the
// dashboard Tracking table. Always placed above the list/table it
// paginates, not below - pass it as a Card's `actions` prop, or as a
// sibling placed before the list in a header row of its own.
export default function PaginationControls({ rangeStart, rangeEnd, total, page, totalPages, onPageChange }) {
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: theme.textMuted }}>
      <span className="tabular-nums">
        {rangeStart}-{rangeEnd} of {total}
      </span>
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
          aria-label="Previous page"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          style={{ color: theme.textSecondary }}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          aria-label="Next page"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          style={{ color: theme.textSecondary }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
