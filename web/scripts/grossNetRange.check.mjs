// Unit checks for src/lib/grossNetRange.js. Plain node, no test runner and
// no dependencies - the period maths is pure functions over date strings:
//
//   npm run check:gross-net
//
// Lives outside src/ so Next never bundles it.
import {
  EARLIEST_DATA_YEAR,
  addDays,
  addMonths,
  bucketLabel,
  canGoForward,
  dayOfWeek,
  daysInMonth,
  defaultStart,
  firstOfMonth,
  isFuturePeriod,
  isValidDate,
  lastOfMonth,
  manilaInstant,
  monthGrid,
  periodFor,
  periodLabel,
  sameMonth,
  shiftStart,
  snapToPeriod,
  startOfWeek,
  startOfYear,
  todayInManila,
  yearOptions,
} from "../src/lib/grossNetRange.js";

let passed = 0;
const failures = [];

function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

function ok(label, condition) {
  if (condition) passed += 1;
  else failures.push(label);
}

const period = (g, s) => {
  const p = periodFor(g, s);
  return [p.startDate, p.endDate, p.bucket];
};

// Tuesday 2026-11-03, in the week Mon Nov 2 - Sun Nov 8.
const TODAY = "2026-11-03";

// ------------------------------------------------------- month-end maths

is("addMonths clamps Jan 31 to Feb 28 (common year)", addMonths("2026-01-31", 1), "2026-02-28");
is("addMonths clamps Jan 31 to Feb 29 (leap year)", addMonths("2028-01-31", 1), "2028-02-29");
is("addMonths clamps Mar 31 to Feb 28 going back", addMonths("2026-03-31", -1), "2026-02-28");
is("addMonths keeps a safe day", addMonths("2026-01-15", 1), "2026-02-15");
is("addMonths rolls Dec -> Jan", addMonths("2026-12-15", 1), "2027-01-15");
is("addMonths rolls Jan -> Dec backwards", addMonths("2026-01-15", -1), "2025-12-15");
is("addMonths +12 is the next year", addMonths("2026-10-05", 12), "2027-10-05");
is("addMonths Feb 29 -> Feb 28 a year later", addMonths("2028-02-29", 12), "2029-02-28");

is("daysInMonth Feb 2026", daysInMonth(2026, 2), 28);
is("daysInMonth Feb 2028 (leap)", daysInMonth(2028, 2), 29);
is("daysInMonth Feb 2100 (not leap)", daysInMonth(2100, 2), 28);
is("daysInMonth Feb 2000 (leap)", daysInMonth(2000, 2), 29);
is("daysInMonth Dec", daysInMonth(2026, 12), 31);

is("addDays across a month end", addDays("2026-01-31", 1), "2026-02-01");
is("addDays across a year end", addDays("2026-12-31", 1), "2027-01-01");
is("addDays backwards across a year end", addDays("2027-01-01", -1), "2026-12-31");
is("addDays across leap day", addDays("2028-02-28", 1), "2028-02-29");

is("firstOfMonth", firstOfMonth(TODAY), "2026-11-01");
is("lastOfMonth, 30-day month", lastOfMonth(TODAY), "2026-11-30");
is("lastOfMonth, 31-day month", lastOfMonth("2026-10-05"), "2026-10-31");
is("lastOfMonth, February", lastOfMonth("2026-02-10"), "2026-02-28");
is("lastOfMonth, February in a leap year", lastOfMonth("2028-02-10"), "2028-02-29");
is("sameMonth", [sameMonth("2026-11-01", "2026-11-30"), sameMonth("2026-11-30", "2026-12-01")], [true, false]);

// ---------------------------------------------------------- weeks (Mon-Sun)

// 0 = Monday through 6 = Sunday, whatever zone the machine runs in.
is("dayOfWeek Monday", dayOfWeek("2026-11-02"), 0);
is("dayOfWeek Tuesday", dayOfWeek("2026-11-03"), 1);
is("dayOfWeek Sunday", dayOfWeek("2026-11-08"), 6);

is("week containing a midweek date", startOfWeek(TODAY), "2026-11-02");
is("week containing its own Monday is itself", startOfWeek("2026-11-02"), "2026-11-02");
// The one that catches a Sunday-first week: Sunday closes the week it is in,
// it does not open a new one.
is("week containing a Sunday is the week before it", startOfWeek("2026-11-08"), "2026-11-02");
is("week containing Sunday Nov 1 reaches back into October", startOfWeek("2026-11-01"), "2026-10-26");

is("week crossing a month boundary", period("week", "2026-11-01"), ["2026-10-26", "2026-11-01", "day"]);
is("week crossing a month boundary forwards", period("week", "2026-12-02"), ["2026-11-30", "2026-12-06", "day"]);
is("week crossing a year boundary", period("week", "2027-01-01"), ["2026-12-28", "2027-01-03", "day"]);
is("week crossing a leap day", period("week", "2028-02-29"), ["2028-02-28", "2028-03-05", "day"]);

// --------------------------------------------------------------- periods

is("day period is one date, hourly", period("day", "2026-10-05"), ["2026-10-05", "2026-10-05", "hour"]);
is("week period is Mon-Sun", period("week", TODAY), ["2026-11-02", "2026-11-08", "day"]);

// A month period is the whole calendar month, whichever date names it.
is("month period from mid-month", period("month", "2026-10-05"), ["2026-10-01", "2026-10-31", "day"]);
is("month period from the 1st", period("month", "2026-10-01"), ["2026-10-01", "2026-10-31", "day"]);
is("month period from the last day", period("month", "2026-10-31"), ["2026-10-01", "2026-10-31", "day"]);
is("month period, 30-day month", period("month", TODAY), ["2026-11-01", "2026-11-30", "day"]);
is("month period, February", period("month", "2026-02-14"), ["2026-02-01", "2026-02-28", "day"]);
is("month period, February in a leap year", period("month", "2028-02-14"), ["2028-02-01", "2028-02-29", "day"]);
is("month period, December", period("month", "2026-12-15"), ["2026-12-01", "2026-12-31", "day"]);

// A year period is Jan 1 to Dec 31, monthly buckets.
is("year period from mid-year", period("year", "2026-10-05"), ["2026-01-01", "2026-12-31", "month"]);
is("year period from Jan 1", period("year", "2026-01-01"), ["2026-01-01", "2026-12-31", "month"]);
is("year period from Dec 31", period("year", "2026-12-31"), ["2026-01-01", "2026-12-31", "month"]);
is("year period containing a leap day", period("year", "2028-06-01"), ["2028-01-01", "2028-12-31", "month"]);

// A year period must stay inside the SQL function's 400-day guard.
for (const start of ["2026-01-01", "2028-01-01"]) {
  const p = periodFor("year", start);
  const days = Math.round((Date.parse(p.endInstantExclusive) - Date.parse(p.startInstant)) / 86400000);
  ok(`year period from ${start} spans ${days} days, over the SQL 400-day guard`, days <= 400);
}
is("a leap year really is 366 days", Math.round(
  (Date.parse(periodFor("year", "2028-01-01").endInstantExclusive) -
    Date.parse(periodFor("year", "2028-01-01").startInstant)) / 86400000), 366);

// ---------------------------------------------------- bucket counts match

function bucketCount(g, s) {
  const p = periodFor(g, s);
  const days = Math.round((Date.parse(p.endInstantExclusive) - Date.parse(p.startInstant)) / 86400000);
  if (p.bucket === "hour") return days * 24;
  if (p.bucket === "day") return days;
  return 12;
}
is("day = 24 hourly buckets", bucketCount("day", "2026-10-05"), 24);
is("week = 7 daily buckets", bucketCount("week", TODAY), 7);
is("February = 28 daily buckets", bucketCount("month", "2026-02-14"), 28);
is("February in a leap year = 29 daily buckets", bucketCount("month", "2028-02-14"), 29);
is("November = 30 daily buckets", bucketCount("month", TODAY), 30);
is("October = 31 daily buckets", bucketCount("month", "2026-10-05"), 31);
is("year = 12 monthly buckets", bucketCount("year", "2026-10-05"), 12);

// ------------------------------------------------------- Manila instants

is("manilaInstant pins +08:00", manilaInstant("2026-10-05"), "2026-10-05T00:00:00+08:00");
// Manila midnight is 16:00 the previous day in UTC. A period built on the
// browser's zone would start eight hours off.
is("Manila midnight in UTC", new Date(manilaInstant("2026-10-05")).toISOString(), "2026-10-04T16:00:00.000Z");
is(
  "week period bounds as instants",
  [periodFor("week", TODAY).startInstant, periodFor("week", TODAY).endInstantExclusive],
  ["2026-11-02T00:00:00+08:00", "2026-11-09T00:00:00+08:00"]
);
is(
  "month period bounds as instants",
  [periodFor("month", TODAY).startInstant, periodFor("month", TODAY).endInstantExclusive],
  ["2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00"]
);
is(
  "year period bounds as instants",
  [periodFor("year", TODAY).startInstant, periodFor("year", TODAY).endInstantExclusive],
  ["2026-01-01T00:00:00+08:00", "2027-01-01T00:00:00+08:00"]
);

// The exclusive end must be the instant after the last day, so a record at
// 23:59 Manila on the final day is still inside the period - and one minute
// later is not. This is the bound the trackers filter on (gte/lt).
for (const [g, start, lastDay, nextDay] of [
  ["day", "2026-10-05", "2026-10-05", "2026-10-06"],
  ["week", TODAY, "2026-11-08", "2026-11-09"],
  ["month", TODAY, "2026-11-30", "2026-12-01"],
  ["year", TODAY, "2026-12-31", "2027-01-01"],
]) {
  const p = periodFor(g, start);
  const lastMoment = Date.parse(`${lastDay}T23:59:59+08:00`);
  ok(`23:59 Manila on the last day of a ${g} fell outside it`,
    lastMoment >= Date.parse(p.startInstant) && lastMoment < Date.parse(p.endInstantExclusive));
  ok(`midnight opening ${nextDay} fell inside the ${g} before it`,
    Date.parse(`${nextDay}T00:00:00+08:00`) >= Date.parse(p.endInstantExclusive));
  // ...and the first moment of the period is inside it, not before it.
  ok(`00:00 Manila on the first day of a ${g} fell outside it`,
    Date.parse(`${p.startDate}T00:00:00+08:00`) >= Date.parse(p.startInstant));
}

// todayInManila must follow Manila, not the machine running this.
is("todayInManila at 17:00 UTC is already the next day there", todayInManila(new Date("2026-10-05T17:00:00Z")), "2026-10-06");
is("todayInManila at 15:00 UTC is still the same day", todayInManila(new Date("2026-10-05T15:00:00Z")), "2026-10-05");
is("todayInManila just before Manila midnight", todayInManila(new Date("2026-10-05T15:59:59Z")), "2026-10-05");
is("todayInManila at Manila midnight", todayInManila(new Date("2026-10-05T16:00:00Z")), "2026-10-06");

// --------------------------------------------------------------- defaults

is("day default is today", defaultStart("day", TODAY), "2026-11-03");
is("week default is this Monday", defaultStart("week", TODAY), "2026-11-02");
is("month default is the 1st of this month", defaultStart("month", TODAY), "2026-11-01");
is("year default is Jan 1 of this year", defaultStart("year", TODAY), "2026-01-01");

// Each default is the period CONTAINING today, which is not the same as one
// ending today: this week, month and year all run past it, and those later
// buckets simply come back empty.
for (const g of ["day", "week", "month", "year"]) {
  const p = periodFor(g, defaultStart(g, TODAY));
  ok(`${g} default does not contain today`, p.startDate <= TODAY && TODAY <= p.endDate);
}
is("the default week runs past today", periodFor("week", defaultStart("week", TODAY)).endDate, "2026-11-08");
is("the default month runs past today", periodFor("month", defaultStart("month", TODAY)).endDate, "2026-11-30");
is("the default year runs past today", periodFor("year", defaultStart("year", TODAY)).endDate, "2026-12-31");
// A Sunday's own week started six days earlier, not that morning.
is("week default on a Sunday", defaultStart("week", "2026-11-08"), "2026-11-02");

// ------------------------------------------- switching granularity in place

// Day Nov 3 -> the week containing Nov 3 -> November 2026 -> 2026.
is("day -> week keeps the point in time", snapToPeriod("week", "2026-11-03"), "2026-11-02");
is("week -> month keeps the point in time", snapToPeriod("month", "2026-11-02"), "2026-11-01");
is("month -> year keeps the point in time", snapToPeriod("year", "2026-11-01"), "2026-01-01");
// Coming back down lands on the start of the larger period - the most that
// can be kept once the finer detail has been given up.
is("year -> month lands on January", snapToPeriod("month", "2026-01-01"), "2026-01-01");
is("month -> day lands on the 1st", snapToPeriod("day", "2026-01-01"), "2026-01-01");
is("startOfYear", startOfYear("2026-11-03"), "2026-01-01");

// ---------------------------------------------------- old-URL snapping

// The rolling-window picker wrote a start date that could sit anywhere
// inside what is now a period. Those links must still open - on the period
// that contains the date they named.
is("old day URL is unchanged", snapToPeriod("day", "2026-11-03"), "2026-11-03");
// Old week default was today - 6 days.
is("old week URL snaps to its Monday", snapToPeriod("week", "2026-10-28"), "2026-10-26");
// Old month default was the same date last month + 1 day.
is("old month URL snaps to the 1st", snapToPeriod("month", "2026-10-04"), "2026-10-01");
// Old year default was the first of the month 11 months back.
is("old year URL snaps to Jan 1", snapToPeriod("year", "2025-12-01"), "2025-01-01");
is("an old month URL opens the whole month", period("month", "2026-10-04"), ["2026-10-01", "2026-10-31", "day"]);
is("an old year URL opens the whole year", period("year", "2025-12-01"), ["2025-01-01", "2025-12-31", "month"]);

// Snapping an already-snapped start changes nothing, so a new URL survives
// being read back any number of times.
for (const g of ["day", "week", "month", "year"]) {
  const once = snapToPeriod(g, "2026-10-04");
  ok(`${g} snapping is not idempotent`, snapToPeriod(g, once) === once);
  ok(`${g} periodFor does not snap its start`, periodFor(g, "2026-10-04").startDate === once);
}

// ---------------------------------------------------------------- paging

is("previous day", shiftStart("day", "2026-10-05", -1), "2026-10-04");
is("next week", shiftStart("week", "2026-11-02", 1), "2026-11-09");
is("previous week", shiftStart("week", "2026-11-02", -1), "2026-10-26");
is("next month", shiftStart("month", "2026-10-01", 1), "2026-11-01");
is("previous month", shiftStart("month", "2026-10-01", -1), "2026-09-01");
is("next month out of a 31-day month stays on the 1st", shiftStart("month", "2026-01-01", 1), "2026-02-01");
is("next year", shiftStart("year", "2026-01-01", 1), "2027-01-01");
is("previous year", shiftStart("year", "2026-01-01", -1), "2025-01-01");

// Dec -> Jan in both directions, for every granularity.
is("next day crosses into January", shiftStart("day", "2026-12-31", 1), "2027-01-01");
is("previous day crosses back into December", shiftStart("day", "2027-01-01", -1), "2026-12-31");
is("next week crosses into January", shiftStart("week", "2026-12-28", 1), "2027-01-04");
is("previous week crosses back into December", shiftStart("week", "2027-01-04", -1), "2026-12-28");
is("next month crosses into January", shiftStart("month", "2026-12-01", 1), "2027-01-01");
is("previous month crosses back into December", shiftStart("month", "2027-01-01", -1), "2026-12-01");
// Stepping off a start that was never snapped (an old URL) still lands on a
// proper period start.
is("stepping an unsnapped month start snaps first", shiftStart("month", "2026-12-15", 1), "2027-01-01");
is("stepping an unsnapped week start snaps first", shiftStart("week", "2026-12-30", 1), "2027-01-04");
is("stepping an unsnapped year start snaps first", shiftStart("year", "2026-06-15", 1), "2027-01-01");

// Successive periods must tile with no gap and no overlap.
for (const [g, start] of [["day", "2026-10-05"], ["week", TODAY], ["month", "2026-01-15"], ["year", "2026-05-01"]]) {
  const a = periodFor(g, start);
  const b = periodFor(g, shiftStart(g, start, 1));
  is(`consecutive ${g} periods tile exactly`, a.endInstantExclusive, b.startInstant);
}

// ----------------------------------------------------- the forward limit

// Forward is barred when the NEXT period has not begun, not when the current
// one runs past today.
is("cannot step past today", canGoForward("day", TODAY, TODAY), false);
is("can step forward from yesterday", canGoForward("day", "2026-11-02", TODAY), true);
is("cannot step out of this week", canGoForward("week", "2026-11-02", TODAY), false);
is("can step out of last week", canGoForward("week", "2026-10-26", TODAY), true);
is("cannot step out of this month", canGoForward("month", "2026-11-01", TODAY), false);
is("can step out of last month", canGoForward("month", "2026-10-01", TODAY), true);
is("cannot step out of this year", canGoForward("year", "2026-01-01", TODAY), false);
is("can step out of last year", canGoForward("year", "2025-01-01", TODAY), true);

// ------------------------------------------------- greying out the popovers

// One rule for all four grids: would picking this cell select a period that
// has not started?
is("today is pickable", isFuturePeriod("day", TODAY, TODAY), false);
is("tomorrow is not", isFuturePeriod("day", "2026-11-04", TODAY), true);
// The rest of THIS week is pickable, because clicking it picks this week.
is("the Sunday of this week is pickable in Week mode", isFuturePeriod("week", "2026-11-08", TODAY), false);
is("next Monday is not", isFuturePeriod("week", "2026-11-09", TODAY), true);
is("the end of this month is pickable in Month mode", isFuturePeriod("month", "2026-11-30", TODAY), false);
is("next month is not", isFuturePeriod("month", "2026-12-01", TODAY), true);
is("December is pickable in Year mode", isFuturePeriod("year", "2026-12-31", TODAY), false);
is("next year is not", isFuturePeriod("year", "2027-01-01", TODAY), true);

// --------------------------------------------------------- popover grids

{
  const grid = monthGrid("2026-11-15");
  is("month grid is six Mon-Sun rows", [grid.length, grid[0].length], [6, 7]);
  // Six rows always, so the popover keeps one height from month to month.
  is("month grid starts on the Monday of the week holding the 1st", grid[0][0], "2026-10-26");
  is("month grid ends six weeks later", grid[5][6], "2026-12-06");
  ok("a month grid row did not start on a Monday", grid.every((row) => dayOfWeek(row[0]) === 0));
  ok("a month grid row was not seven consecutive days",
    grid.every((row) => row.every((d, i) => d === addDays(row[0], i))));
  const flat = grid.flat();
  ok("the month grid lost a day of November",
    Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`).every((d) => flat.includes(d)));
  // February 2026 starts on a Sunday, the case where the leading row is
  // almost all January.
  is("a month starting on a Sunday", monthGrid("2026-02-01")[0][0], "2026-01-26");
}

is("year options start at the earliest data year", yearOptions(TODAY)[0], EARLIEST_DATA_YEAR);
is("year options end this year", yearOptions(TODAY).at(-1), 2026);
is("year options are every year in between", yearOptions(TODAY), [2020, 2021, 2022, 2023, 2024, 2025, 2026]);
is("year options always include the current year", yearOptions("2019-06-01"), [2019]);

// --------------------------------------------------------------- parsing

is("isValidDate accepts a real date", isValidDate("2026-10-05"), true);
is("isValidDate rejects Feb 30", isValidDate("2026-02-30"), false);
is("isValidDate accepts Feb 29 in a leap year", isValidDate("2028-02-29"), true);
is("isValidDate rejects Feb 29 in a common year", isValidDate("2026-02-29"), false);
is("isValidDate rejects month 13", isValidDate("2026-13-01"), false);
is("isValidDate rejects junk", isValidDate("not-a-date"), false);
is("isValidDate rejects undefined", isValidDate(undefined), false);

// ---------------------------------------------------------- bucket labels

is("hourly label at midnight", bucketLabel("2026-10-05T00:00:00", "hour"), "12AM");
is("hourly label at noon", bucketLabel("2026-10-05T12:00:00", "hour"), "12PM");
is("hourly label in the evening", bucketLabel("2026-10-05T19:00:00", "hour"), "7PM");
is("daily label", bucketLabel("2026-10-05T00:00:00", "day"), "Oct 5");
is("monthly label", bucketLabel("2026-10-01T00:00:00", "month"), "Oct 26");
// Postgres may serialise the timestamp with a space instead of a T.
is("daily label with a space separator", bucketLabel("2026-10-05 00:00:00", "day"), "Oct 5");

// ----------------------------------------------------------------- labels

is("day label", periodLabel("day", "2026-11-03", "2026-11-03"), "Nov 3, 2026");
is("week label", periodLabel("week", "2026-11-02", "2026-11-08"), "Week of Nov 2 – Nov 8, 2026");
is("week label across a month end", periodLabel("week", "2026-11-30", "2026-12-06"), "Week of Nov 30 – Dec 6, 2026");
is("week label across a year end names both years",
  periodLabel("week", "2026-12-28", "2027-01-03"), "Week of Dec 28, 2026 – Jan 3, 2027");
is("month label is the month's full name", periodLabel("month", "2026-11-01", "2026-11-30"), "November 2026");
is("year label is just the year", periodLabel("year", "2026-01-01", "2026-12-31"), "2026");
// What the trigger button reads for each default.
is("the period carries its own label", periodFor("week", TODAY).label, "Week of Nov 2 – Nov 8, 2026");
is("labels for the four defaults",
  ["day", "week", "month", "year"].map((g) => periodFor(g, defaultStart(g, TODAY)).label),
  ["Nov 3, 2026", "Week of Nov 2 – Nov 8, 2026", "November 2026", "2026"]);

// ------------------------------------------------------------------ done

if (failures.length === 0) {
  console.log(`grossNetRange.js: ${passed} checks passed`);
} else {
  console.log(`grossNetRange.js: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
}
