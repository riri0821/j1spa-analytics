"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { theme } from "@/app/dashboard/theme";
import {
  GRANULARITIES,
  canGoForward,
  defaultStart,
  isValidDate,
  shiftStart,
  todayInManila,
  windowFor,
} from "@/lib/grossNetRange";

// Shared Day/Week/Month/Year + start-date controls, used by the dashboard's
// Gross & Net chart, the Sales Tracker and the Stock-In Tracker so all three
// pick dates the same way. All the date maths lives in lib/grossNetRange.js;
// this is only the controls.

/**
 * Keeps a window in the URL so a view is shareable and survives a refresh.
 *
 * @param prefix query-param prefix - `gn` reads ?gn= and ?gnStart=. Each
 *   screen uses its own so two pickers on one route cannot collide, and so
 *   neither disturbs params the page already owns (e.g. ?tab=).
 */
export function useDateWindow(prefix) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const granularityParam = searchParams.get(prefix);
  const startParam = searchParams.get(`${prefix}Start`);

  const granularity = GRANULARITIES.some((g) => g.value === granularityParam) ? granularityParam : "month";
  // An absent or hand-mangled date falls back to the default for the
  // granularity rather than rendering an empty window.
  const start = isValidDate(startParam) ? startParam : defaultStart(granularity);

  const setWindow = useCallback(
    (nextGranularity, nextStart) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(prefix, nextGranularity);
      params.set(`${prefix}Start`, nextStart);
      // replace, not push: stepping through windows should not fill the back
      // button with every intermediate view.
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams, prefix]
  );

  const window = useMemo(() => windowFor(granularity, start), [granularity, start]);

  return { granularity, start, window, setWindow };
}

export default function DateWindowPicker({ granularity, start, onChange, label, compact = false }) {
  const today = todayInManila();
  const forward = canGoForward(granularity, start, today);

  // Switching granularity re-defaults the start date instead of carrying the
  // old one over: a start picked for a week window is rarely the one wanted
  // for a year, and the default always ends today.
  const changeGranularity = (value) => onChange(value, defaultStart(value, today));
  const step = (direction) => onChange(granularity, shiftStart(granularity, start, direction));

  const btn = "rounded border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40";
  const btnStyle = { borderColor: theme.border, color: theme.textSecondary };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : "gap-x-3"}`}>
      <div className="flex gap-1 rounded border p-1" style={{ borderColor: theme.border }}>
        {GRANULARITIES.map((g) => (
          <button
            key={g.value}
            type="button"
            onClick={() => changeGranularity(g.value)}
            className="rounded px-2 py-0.5 text-xs font-medium"
            style={
              granularity === g.value
                ? { backgroundColor: theme.accent, color: "#05230f" }
                : { color: theme.textSecondary }
            }
          >
            {g.label}
          </button>
        ))}
      </div>

      <input
        type="date"
        value={start}
        max={today}
        onChange={(e) => {
          if (isValidDate(e.target.value)) onChange(granularity, e.target.value);
        }}
        aria-label="Window start date"
        className="rounded border px-2 py-1 text-xs"
        // color-scheme: dark is what makes the native calendar pop-up and
        // its icon render dark; without it the browser draws a light widget
        // on this dark card.
        style={{
          backgroundColor: theme.cardBgAlt,
          borderColor: theme.border,
          color: theme.textPrimary,
          colorScheme: "dark",
        }}
      />

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Previous period"
          className={btn}
          style={btnStyle}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={!forward}
          aria-label="Next period"
          title={forward ? undefined : "Already at the latest period"}
          className={btn}
          style={btnStyle}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => changeGranularity(granularity)}
          className={btn}
          style={btnStyle}
        >
          Today
        </button>
      </div>

      {label && (
        <span className="text-xs tabular-nums" style={{ color: theme.textMuted }}>
          {label}
        </span>
      )}
    </div>
  );
}
