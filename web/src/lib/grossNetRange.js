/**
 * Date-window maths for the Day/Week/Month/Year pickers on the Gross & Net
 * chart, the Sales Tracker and the Stock-In Tracker. Pure functions over
 * "YYYY-MM-DD" strings - no Date-in-local-time anywhere, because the
 * browser's zone and the server's (UTC on Vercel) would each put the day
 * boundary somewhere other than Manila midnight.
 *
 * Checked by web/scripts/grossNetRange.check.mjs (`npm run check:gross-net`).
 */

// The Philippines is UTC+8 all year (no DST since 1978), so a calendar date
// becomes an instant by pinning that offset.
const MANILA_OFFSET = "+08:00";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The start date each granularity opens on, chosen so the default window
 * always ENDS today.
 */
export function defaultStart(granularity, today = todayInManila()) {
  if (granularity === "day") return today;
  if (granularity === "week") return addDays(today, -6);
  // Same date last month + 1 day: the month window runs [start, start+1mo)
  // so this lands its last day on today.
  if (granularity === "month") return addDays(addMonths(today, -1), 1);
  return firstOfMonth(addMonths(today, -11)); // year: 12 calendar months ending this one
}

/**
 * The window a (granularity, start) pair describes.
 *   startDate / endDate  inclusive calendar dates
 *   bucket               'hour' | 'day' | 'month', for dashboard_gross_net_range
 *   startInstant         Manila midnight at startDate
 *   endInstantExclusive  Manila midnight the day AFTER endDate
 */
export function windowFor(granularity, start) {
  let startDate = start;
  let endDate;
  let bucket;

  if (granularity === "day") {
    endDate = startDate;
    bucket = "hour";
  } else if (granularity === "week") {
    endDate = addDays(startDate, 6);
    bucket = "day";
  } else if (granularity === "month") {
    // Through the day before the same date next month.
    endDate = addDays(addMonths(startDate, 1), -1);
    bucket = "day";
  } else {
    // Year buckets by calendar month, so the window snaps to month starts.
    startDate = firstOfMonth(startDate);
    endDate = addDays(addMonths(startDate, 12), -1);
    bucket = "month";
  }

  return {
    granularity,
    startDate,
    endDate,
    bucket,
    startInstant: manilaInstant(startDate),
    endInstantExclusive: manilaInstant(addDays(endDate, 1)),
    label: rangeLabel(granularity, startDate, endDate),
  };
}

/** Manila midnight on `date`, as an instant PostgREST and Date both read. */
export function manilaInstant(date) {
  return `${date}T00:00:00${MANILA_OFFSET}`;
}

/** Move the window back (-1) or forward (+1) by exactly one window length. */
export function shiftStart(granularity, start, direction) {
  if (granularity === "day") return addDays(start, direction);
  if (granularity === "week") return addDays(start, 7 * direction);
  if (granularity === "month") return addMonths(start, direction);
  return addMonths(firstOfMonth(start), 12 * direction);
}

/**
 * Whether stepping forward is allowed: the next window must not begin after
 * today, so the user cannot page into empty future periods.
 */
export function canGoForward(granularity, start, today = todayInManila()) {
  return compareDates(shiftStart(granularity, start, 1), today) <= 0;
}

/** "Oct 5 - Oct 11, 2026", with an en dash. */
export function rangeLabel(granularity, startDate, endDate) {
  const [sy, sm, sd] = parts(startDate);
  const [ey, em, ed] = parts(endDate);

  if (granularity === "day") return `${MONTHS[sm - 1]} ${sd}, ${sy}`;
  // Year buckets are whole months, so naming days would overstate precision.
  if (granularity === "year") return `${MONTHS[sm - 1]} ${sy} – ${MONTHS[em - 1]} ${ey}`;
  if (sy !== ey) return `${MONTHS[sm - 1]} ${sd}, ${sy} – ${MONTHS[em - 1]} ${ed}, ${ey}`;
  return `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}, ${sy}`;
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
  if (bucket === "month") return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  if (bucket === "hour") {
    const hour = Number(timePart.slice(0, 2));
    const suffix = hour < 12 ? "AM" : "PM";
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}${suffix}`;
  }
  return `${MONTHS[m - 1]} ${d}`;
}
