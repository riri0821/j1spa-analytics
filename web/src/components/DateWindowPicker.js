"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { theme } from "@/app/dashboard/theme";
import {
  GRANULARITIES,
  MONTH_ABBR,
  MONTH_NAMES,
  WEEKDAY_ABBR,
  addDays,
  addMonths,
  canGoForward,
  compareDates,
  defaultStart,
  firstOfMonth,
  isFuturePeriod,
  isValidDate,
  monthGrid,
  periodFor,
  sameMonth,
  shiftStart,
  snapToPeriod,
  startOfWeek,
  startOfYear,
  todayInManila,
  yearOptions,
} from "@/lib/grossNetRange";

// What the jump-to-current button says for each granularity. "Today" is
// wrong for the other three - pressing it in Month mode selects the whole
// month, not the day.
const CURRENT_PERIOD_LABEL = {
  day: "Today",
  week: "This week",
  month: "This month",
  year: "This year",
};

// Shared Day/Week/Month/Year period picker, used by the dashboard's Gross &
// Net chart, the Sales Tracker and the Stock-In Tracker so all three pick
// dates the same way. All the date maths lives in lib/grossNetRange.js; this
// is the controls and the popover.
//
// The popover is built here rather than with native inputs: <input
// type="month"> is unsupported in Firefox and Safari, there is no native year
// input at all, and a native date input cannot highlight a whole week row on
// hover the way Week mode needs.

/**
 * Keeps the selected period in the URL so a view is shareable and survives a
 * refresh.
 *
 * @param prefix query-param prefix - `gn` reads ?gn= and ?gnStart=. Each
 *   screen uses its own so two pickers on one route cannot collide, and so
 *   neither disturbs params the page already owns (e.g. ?tab=).
 */
export function useDateWindow(prefix) {
  const searchParams = useSearchParams();

  const granularityParam = searchParams.get(prefix);
  const startParam = searchParams.get(`${prefix}Start`);

  const granularity = GRANULARITIES.some((g) => g.value === granularityParam) ? granularityParam : "month";
  // Snapped rather than merely validated: a ?gnStart= written by the old
  // rolling-window picker points at an arbitrary date, and should open the
  // period containing that date instead of being discarded.
  const start = snapToPeriod(granularity, isValidDate(startParam) ? startParam : defaultStart(granularity));

  const setWindow = useCallback(
    (nextGranularity, nextStart) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(prefix, nextGranularity);
      params.set(`${prefix}Start`, snapToPeriod(nextGranularity, nextStart));
      // history.replaceState, not router.replace. The App Router keeps
      // useSearchParams in sync with the native History API, so this
      // re-renders only the client components that read these params.
      // router.replace treats a new query string as a navigation and re-runs
      // the whole server page - on /dashboard that is auth plus three
      // analytics queries, with no Suspense boundary - and until that lands
      // the picker is still rendering the previous value, which is what made
      // choosing a date fight back. replaceState rather than pushState so
      // stepping through periods does not fill the back button.
      window.history.replaceState(null, "", `?${params.toString()}`);
    },
    [searchParams, prefix]
  );

  const period = useMemo(() => periodFor(granularity, start), [granularity, start]);

  // Still called `window` by the three screens that read it.
  return { granularity, start, window: period, setWindow };
}

export default function DateWindowPicker({ granularity, start, onChange }) {
  const today = todayInManila();
  const period = periodFor(granularity, start);
  const forward = canGoForward(granularity, start, today);

  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);

  // Clicking anywhere else closes the popover. mousedown, not click, so the
  // popover is gone before the click lands on whatever is underneath.
  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  function closeAndRefocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  // Switching granularity keeps the same point in time where it can: Day
  // Nov 3 -> the week containing Nov 3 -> November 2026 -> 2026.
  function changeGranularity(value) {
    setOpen(false);
    onChange(value, snapToPeriod(value, start));
  }

  function step(direction) {
    onChange(granularity, shiftStart(granularity, start, direction));
  }

  // Only ever called with a complete choice - there is no half-picked state
  // to commit, which is the other half of the old picker's problem.
  function pick(date) {
    closeAndRefocus();
    onChange(granularity, snapToPeriod(granularity, date));
  }

  const btn = "rounded border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40";
  const btnStyle = { borderColor: theme.border, color: theme.textSecondary };

  return (
    <div
      ref={rootRef}
      // The popover is positioned against this whole row, not against the
      // trigger: on a phone the row wraps to the left edge, where anchoring
      // left keeps the popover on screen; from sm up the row ends where the
      // trigger does, so anchoring right does the same there.
      className="relative flex flex-wrap items-center gap-2 gap-x-3"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          closeAndRefocus();
        }
      }}
    >
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

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs"
        style={{ backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary }}
      >
        <CalendarDays className="h-3.5 w-3.5 shrink-0" style={{ color: theme.textMuted }} />
        <span className="whitespace-nowrap tabular-nums">{period.label}</span>
      </button>

      {open && (
        // period.startDate, not the raw start: the popover compares cells
        // against it directly, so it must already be a period start.
        <PeriodPopover granularity={granularity} start={period.startDate} today={today} onPick={pick} />
      )}

      <div className="flex items-center gap-1">
        <button type="button" onClick={() => step(-1)} aria-label="Previous period" className={btn} style={btnStyle}>
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
          onClick={() => onChange(granularity, defaultStart(granularity, today))}
          className={btn}
          style={btnStyle}
        >
          {/* All four labels occupy the same grid cell, so the button is as
              wide as the longest of them and keeps that width when the
              granularity changes - the arrows beside it would otherwise
              shift sideways on every toggle. Only the active label is
              visible, and visibility:hidden keeps the rest out of the
              accessibility tree too. */}
          <span className="grid">
            {GRANULARITIES.map((g) => (
              <span
                key={g.value}
                className="col-start-1 row-start-1 text-center"
                style={{ visibility: g.value === granularity ? "visible" : "hidden" }}
              >
                {CURRENT_PERIOD_LABEL[g.value]}
              </span>
            ))}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * The popover itself. One of three grids depending on the granularity, but
 * all three work the same way: every cell stands for a whole period, a cell
 * whose period has not started yet is inert, and arrow keys move a single
 * focused cell (which is also what Enter and Space activate, since the cells
 * are buttons).
 */
function PeriodPopover({ granularity, start, today, onPick }) {
  const calendar = granularity === "day" || granularity === "week";
  const years = yearOptions(today);

  // What the grid is SHOWING, as distinct from what is selected - paging to
  // another month or year must not move the selection.
  const [view, setView] = useState(start);
  // Arrow keys move one focused cell, which has to be a cell the grid
  // renders: a Year start from before the data begins (an old link, say) has
  // no cell of its own, so focus opens on the nearest year that does.
  const [focus, setFocus] = useState(() =>
    granularity === "year"
      ? `${Math.min(Math.max(Number(start.slice(0, 4)), years[0]), years[years.length - 1])}-01-01`
      : start
  );
  // Week mode highlights the row under the pointer, not the single cell.
  const [hoverWeek, setHoverWeek] = useState(null);

  const gridRef = useRef(null);
  // One cell is the grid's tab stop, and DOM focus follows it - but only when
  // the keyboard moved it. Paging the header has to move the tab stop too
  // (otherwise the grid holds no tabbable cell at all and Tab skips straight
  // past it), and must leave focus on the header button being pressed. True
  // on mount, so opening the popover puts focus on the selected cell.
  const takeFocus = useRef(true);

  useEffect(() => {
    if (!takeFocus.current) return;
    takeFocus.current = false;
    gridRef.current?.querySelector('[data-focused="true"]')?.focus();
  }, [focus, view]);

  const columns = calendar ? 7 : granularity === "month" ? 3 : 4;

  /**
   * Page the grid by whole months (the calendar) or whole years (the month
   * grid). The tab stop moves with it, keeping its day-of-month or its month
   * - addMonths clamps, so paging off the 31st lands on a real date - and
   * stopping at the current period rather than on an inert cell.
   */
  function page(months) {
    takeFocus.current = false;
    setView(calendar ? firstOfMonth(addMonths(view, months)) : startOfYear(addMonths(view, months)));
    const next = calendar ? addMonths(focus, months) : firstOfMonth(addMonths(focus, months));
    setFocus(isFuturePeriod(granularity, next, today) ? snapToPeriod(granularity, today) : next);
  }

  function moveFocus(e) {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[e.key];
    if (delta === undefined) return;
    e.preventDefault();

    let next;
    if (calendar) next = addDays(focus, delta);
    else if (granularity === "month") next = firstOfMonth(addMonths(focus, delta));
    else next = startOfYear(addMonths(focus, delta * 12));

    // An inert cell is not somewhere to be: stay put rather than walking
    // into a period that has not started, which is also what keeps the
    // keyboard from paging the calendar past the month the header stops at.
    if (isFuturePeriod(granularity, next, today)) return;
    // Likewise below the first year the picker offers.
    if (granularity === "year" && Number(next.slice(0, 4)) < years[0]) return;

    takeFocus.current = true;
    setFocus(next);
    setView(next);
  }

  const cell =
    "flex items-center justify-center rounded text-xs tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-white/70";

  function cellStyle({ selected, dimmed, inert, isToday }) {
    if (selected) return { backgroundColor: theme.accent, color: "#05230f" };
    return {
      color: dimmed ? theme.textMuted : theme.textSecondary,
      opacity: inert ? 0.35 : 1,
      // A thin inset ring marks today without competing with the selection.
      boxShadow: isToday ? `inset 0 0 0 1px ${theme.textSecondary}` : undefined,
    };
  }

  return (
    <div
      role="dialog"
      aria-label="Choose a period"
      className="absolute left-0 top-full z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border p-2 sm:left-auto sm:right-0"
      style={{
        backgroundColor: theme.cardBg,
        borderColor: theme.border,
        boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
      }}
    >
      {calendar && (
        <>
          <PopoverHeader
            title={`${MONTH_NAMES[Number(view.slice(5, 7)) - 1]} ${view.slice(0, 4)}`}
            onPrev={() => page(-1)}
            onNext={() => page(1)}
            // Paging past the current month would only show inert cells.
            nextDisabled={compareDates(firstOfMonth(view), firstOfMonth(today)) >= 0}
            prevLabel="Previous month"
            nextLabel="Next month"
          />
          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {WEEKDAY_ABBR.map((d) => (
              <span key={d} className="py-0.5 text-center text-[10px]" style={{ color: theme.textMuted }}>
                {d}
              </span>
            ))}
          </div>
          <div ref={gridRef} onKeyDown={moveFocus} onMouseLeave={() => setHoverWeek(null)}>
            {monthGrid(view).map((week) => {
              const monday = week[0];
              const rowActive =
                granularity === "week" && (hoverWeek === monday || startOfWeek(start) === monday);
              return (
                <div
                  key={monday}
                  className="grid grid-cols-7 gap-0.5 rounded"
                  style={rowActive ? { backgroundColor: "rgba(255,255,255,0.05)" } : undefined}
                >
                  {week.map((date) => {
                    const inert = isFuturePeriod(granularity, date, today);
                    const selected =
                      granularity === "week" ? startOfWeek(date) === startOfWeek(start) : date === start;
                    return (
                      <button
                        key={date}
                        type="button"
                        data-focused={date === focus}
                        tabIndex={date === focus ? 0 : -1}
                        aria-disabled={inert}
                        aria-current={selected ? "date" : undefined}
                        onFocus={() => setFocus(date)}
                        onMouseEnter={() =>
                          granularity === "week" && setHoverWeek(startOfWeek(date))
                        }
                        onClick={() => !inert && onPick(date)}
                        className={`${cell} h-8`}
                        style={cellStyle({
                          selected,
                          dimmed: !sameMonth(date, view),
                          inert,
                          isToday: date === today,
                        })}
                      >
                        {Number(date.slice(8, 10))}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}

      {granularity === "month" && (
        <>
          <PopoverHeader
            title={view.slice(0, 4)}
            onPrev={() => page(-12)}
            onNext={() => page(12)}
            nextDisabled={Number(view.slice(0, 4)) >= Number(today.slice(0, 4))}
            prevLabel="Previous year"
            nextLabel="Next year"
          />
          <div ref={gridRef} onKeyDown={moveFocus} className="grid grid-cols-3 gap-1">
            {MONTH_ABBR.map((name, i) => {
              const date = `${view.slice(0, 4)}-${String(i + 1).padStart(2, "0")}-01`;
              const inert = isFuturePeriod("month", date, today);
              return (
                <button
                  key={name}
                  type="button"
                  data-focused={date === focus}
                  tabIndex={date === focus ? 0 : -1}
                  aria-disabled={inert}
                  aria-current={date === start ? "date" : undefined}
                  onFocus={() => setFocus(date)}
                  onClick={() => !inert && onPick(date)}
                  className={`${cell} h-9`}
                  style={cellStyle({
                    selected: date === start,
                    inert,
                    isToday: sameMonth(date, today),
                  })}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </>
      )}

      {granularity === "year" && (
        <div ref={gridRef} onKeyDown={moveFocus} className="grid grid-cols-4 gap-1">
          {years.map((y) => {
            const date = `${y}-01-01`;
            const inert = isFuturePeriod("year", date, today);
            return (
              <button
                key={y}
                type="button"
                data-focused={date === focus}
                tabIndex={date === focus ? 0 : -1}
                aria-disabled={inert}
                aria-current={date === start ? "date" : undefined}
                onFocus={() => setFocus(date)}
                onClick={() => !inert && onPick(date)}
                className={`${cell} h-9`}
                style={cellStyle({
                  selected: date === start,
                  inert,
                  isToday: String(y) === today.slice(0, 4),
                })}
              >
                {y}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PopoverHeader({ title, onPrev, onNext, nextDisabled, prevLabel, nextLabel }) {
  const arrow =
    "flex h-6 w-6 items-center justify-center rounded hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="mb-1 flex items-center justify-between">
      <button
        type="button"
        onClick={onPrev}
        aria-label={prevLabel}
        className={arrow}
        style={{ color: theme.textSecondary }}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="text-xs font-medium tabular-nums" style={{ color: theme.textPrimary }}>
        {title}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        aria-label={nextLabel}
        className={arrow}
        style={{ color: theme.textSecondary }}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
