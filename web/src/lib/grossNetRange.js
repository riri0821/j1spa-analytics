/**
 * Calendar period maths for the Day/Week/Month/Year pickers on the Gross &
 * Net chart, the Sales Tracker and the Stock-In Tracker. Pure functions over
 * "YYYY-MM-DD" strings - no Date-in-local-time anywhere, because the
 * browser's zone and the server's (UTC on Vercel) would each put the day
 * boundary somewhere other than Manila midnight.
 *
 * Every period is calendar-aligned and identified by the date it STARTS on:
 * a day, a Monday-Sunday week, a whole calendar month, a whole calendar
 * year. Periods of one granularity tile the calendar exactly, which is what
 * makes "previous" and "next" mean something and what lets the chart label
 * its buckets Mon-Sun or Jan-Dec. (They used to be rolling windows - "the 7
 * days starting on the date you picked" - which never lined up with the
 * calendar the figures are reported against.)
 *
 * Checked by web/scripts/grossNetRange.check.mjs (`npm run check:gross-net`).
 */

// The Philippines is UTC+8 all year (no DST since 1978), so a calendar date
// becomes an instant by pinning that offset.
const MANILA_OFFSET = "+08:00";

export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Monday-first, matching the week the periods are cut on.
export const WEEKDAY_ABBR = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// The earliest sale in the data is from 2020, so the year picker opens on a
// list that starts there rather than scrolling back through empty decades.
export const EARLIEST_DATA_YEAR = 2020;

const MANILA_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const GRANULARITIES = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

/** Today's calendar date in Manila, as YYYY-MM-DD. */
export function todayInManila(now = new Date()) {
  const parts = {};
  for (const p of MANILA_PARTS.formatToParts(now)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function parts(date) {
  return date.split("-").map(Number);
}

function iso(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days in a 1-based month. Date.UTC(y, m, 0) is the last day of month m. */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date, n) {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Add calendar months, clamping the day to the target month's length -
 * Jan 31 + 1 month is Feb 28 (or Feb 29 in a leap year), not Mar 3. Day
 * arithmetic would silently slide past the month end.
 */
export function addMonths(date, n) {
  const [y, m, d] = parts(date);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function firstOfMonth(date) {
  const [y, m] = parts(date);
  return iso(y, m, 1);
}

export function lastOfMonth(date) {
  const [y, m] = parts(date);
  return iso(y, m, daysInMonth(y, m));
}

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sameMonth(a, b) {
  return a.slice(0, 7) === b.slice(0, 7);
}

/**
 * Day of the week, 0 = Monday through 6 = Sunday. Read through Date.UTC so
 * the answer cannot depend on the machine's zone; getUTCDay() counts from
 * Sunday, which the shift turns into a Monday-first week.
 */
export function dayOfWeek(date) {
  const [y, m, d] = parts(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The Monday of the week containing `date` (a Sunday belongs to the week before it). */
export function startOfWeek(date) {
  return addDays(date, -dayOfWeek(date));
}

export function startOfYear(date) {
  return iso(parts(date)[0], 1, 1);
}

/**
 * The start of the period of `granularity` that CONTAINS `date`. This is the
 * one place a loose date becomes a period, so it serves three jobs at once:
 * defaults (the period containing today), switching granularity while
 * keeping the same point in time, and reading a ?gnStart= written by the
 * old rolling-window picker - any date whatsoever snaps to the period around
 * it rather than being rejected.
 */
export function snapToPeriod(granularity, date) {
  if (granularity === "day") return date;
  if (granularity === "week") return startOfWeek(date);
  if (granularity === "month") return firstOfMonth(date);
  return startOfYear(date);
}

/**
 * The period a (granularity, start) pair describes. `start` is snapped
 * first, so a date from anywhere inside the period - or from an old URL -
 * names the same period.
 *
 *   startDate / endDate  inclusive calendar dates
 *   bucket               'hour' | 'day' | 'month', for dashboard_gross_net_range
 *   startInstant         Manila midnight at startDate
 *   endInstantExclusive  Manila midnight the day AFTER endDate
 */
export function periodFor(granularity, start) {
  const startDate = snapToPeriod(granularity, start);
  let endDate;
  let bucket;

  if (granularity === "day") {
    // 24 hourly buckets.
    endDate = startDate;
    bucket = "hour";
  } else if (granularity === "week") {
    // 7 daily buckets, Monday through Sunday.
    endDate = addDays(startDate, 6);
    bucket = "day";
  } else if (granularity === "month") {
    // 28-31 daily buckets, the whole calendar month.
    endDate = lastOfMonth(startDate);
    bucket = "day";
  } else {
    // 12 monthly buckets, Jan through Dec.
    endDate = iso(parts(startDate)[0], 12, 31);
    bucket = "month";
  }

  return {
    granularity,
    startDate,
    endDate,
    bucket,
    startInstant: manilaInstant(startDate),
    endInstantExclusive: manilaInstant(addDays(endDate, 1)),
    label: periodLabel(granularity, startDate, endDate),
  };
}

/** Manila midnight on `date`, as an instant PostgREST and Date both read. */
export function manilaInstant(date) {
  return `${date}T00:00:00${MANILA_OFFSET}`;
}

/** Move to the previous (-1) or next (+1) whole period. */
export function shiftStart(granularity, start, direction) {
  const from = snapToPeriod(granularity, start);
  if (granularity === "day") return addDays(from, direction);
  if (granularity === "week") return addDays(from, 7 * direction);
  if (granularity === "month") return addMonths(from, direction);
  return iso(parts(from)[0] + direction, 1, 1);
}

/**
 * Whether stepping forward is allowed: the next period must not BEGIN after
 * today. The current period may well run past today - this week, this month
 * and this year all do - and those buckets simply come back empty.
 */
export function canGoForward(granularity, start, today = todayInManila()) {
  return compareDates(shiftStart(granularity, start, 1), today) <= 0;
}

/** The period containing today - what each granularity opens on. */
export function defaultStart(granularity, today = todayInManila()) {
  return snapToPeriod(granularity, today);
}

/**
 * Whether picking `date` would select a period that has not started yet.
 * One rule for all four granularities, which is what lets the popovers grey
 * out future cells without caring which kind of cell they are: a day in the
 * rest of this week is pickable (it selects this week), Dec 1 is not.
 */
export function isFuturePeriod(granularity, date, today = todayInManila()) {
  return compareDates(snapToPeriod(granularity, date), today) > 0;
}

/** What the picker's trigger button reads. */
export function periodLabel(granularity, startDate, endDate) {
  const [sy, sm, sd] = parts(startDate);
  const [ey, em, ed] = parts(endDate);

  if (granularity === "day") return `${MONTH_ABBR[sm - 1]} ${sd}, ${sy}`;
  if (granularity === "month") return `${MONTH_NAMES[sm - 1]} ${sy}`;
  if (granularity === "year") return String(sy);
  // Week: named by both ends, with the year stated once unless the week
  // straddles New Year.
  if (sy !== ey) return `Week of ${MONTH_ABBR[sm - 1]} ${sd}, ${sy} – ${MONTH_ABBR[em - 1]} ${ed}, ${ey}`;
  return `Week of ${MONTH_ABBR[sm - 1]} ${sd} – ${MONTH_ABBR[em - 1]} ${ed}, ${sy}`;
}

/**
 * Six Monday-Sunday rows of dates covering the month of `date`, including
 * the days either side that share a row with it. Always six rows, so the
 * popover keeps one height as the user pages through months, and whole rows
 * so Week mode can highlight one by hovering any cell in it.
 */
export function monthGrid(date) {
  const gridStart = startOfWeek(firstOfMonth(date));
  const weeks = [];
  for (let w = 0; w < 6; w += 1) {
    const row = [];
    for (let d = 0; d < 7; d += 1) row.push(addDays(gridStart, w * 7 + d));
    weeks.push(row);
  }
  return weeks;
}

/** The years the year picker offers: the earliest data year through this one. */
export function yearOptions(today = todayInManila()) {
  const current = parts(today)[0];
  const years = [];
  for (let y = Math.min(EARLIEST_DATA_YEAR, current); y <= current; y += 1) years.push(y);
  return years;
}

/**
 * Bucket label for a period_start returned by dashboard_gross_net_range.
 * The function returns a naive timestamp already in Manila local time, so
 * it is read field-by-field rather than through Date (which would treat it
 * as UTC or as browser-local and shift it).
 */
export function bucketLabel(periodStart, bucket) {
  const text = String(periodStart);
  const [datePart, timePart = "00:00:00"] = text.split(/[T ]/);
  const [y, m, d] = parts(datePart);
  if (bucket === "month") return `${MONTH_ABBR[m - 1]} ${String(y).slice(2)}`;
  if (bucket === "hour") {
    const hour = Number(timePart.slice(0, 2));
    const suffix = hour < 12 ? "AM" : "PM";
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}${suffix}`;
  }
  return `${MONTH_ABBR[m - 1]} ${d}`;
}
