"use client";

import { theme } from "@/app/dashboard/theme";
import { ROW_SIZE_OPTIONS } from "@/lib/pageSize";

// How many rows a list shows per page. Styled as the filter selects on these
// screens are, just a notch shorter so it sits level with the pagination
// buttons it stands next to. Goes beside PaginationControls rather than
// inside it, because that control renders nothing for an empty list and the
// size should still be changeable there.
export default function RowSizeSelect({ value, onChange }) {
  return (
    <label className="flex items-center gap-1 text-xs whitespace-nowrap" style={{ color: theme.textMuted }}>
      Rows
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border px-2 py-1 text-xs"
        style={{ backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.textSecondary }}
      >
        {ROW_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
