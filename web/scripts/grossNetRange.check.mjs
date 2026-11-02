// Unit checks for src/lib/grossNetRange.js. Plain node, no test runner and
// no dependencies - the window maths is pure functions over date strings:
//
//   npm run check:gross-net
//
// Lives outside src/ so Next never bundles it.
import {
  addDays,
  addMonths,
  bucketLabel,
  canGoForward,
  daysInMonth,
  defaultStart,
  firstOfMonth,
  isValidDate,
  manilaInstant,
  rangeLabel,
  shiftStart,
  todayInManila,
  windowFor,
} from "../src/lib/grossNetRange.js";

let passed = 0;
const failures = [];

function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

const win = (g, s) => {
  const w = windowFor(g, s);
  return [w.startDate, w.endDate, w.bucket];
};

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

// --------------------------------------------------------------- windows

is("day window is one date, hourly", win("day", "2026-10-05"), ["2026-10-05", "2026-10-05", "hour"]);
is("week window is 7 days", win("week", "2026-10-05"), ["2026-10-05", "2026-10-11", "day"]);
is("week window across a year end", win("week", "2026-12-28"), ["2026-12-28", "2027-01-03", "day"]);

// Month = picked date through the day before the same date next month.
is("month window, ordinary", win("month", "2026-10-05"), ["2026-10-05", "2026-11-04", "day"]);
is("month window from Jan 31 ends Feb 27", win("month", "2026-01-31"), ["2026-01-31", "2026-02-27", "day"]);
is("month window from Jan 31 in a leap year ends Feb 28", win("month", "2028-01-31"), ["2028-01-31", "2028-02-28", "day"]);
is("month window from Dec 15 rolls into Jan", win("month", "2026-12-15"), ["2026-12-15", "2027-01-14", "day"]);
is("month window from Feb 29 (leap)", win("month", "2028-02-29"), ["2028-02-29", "2028-03-28", "day"]);

// Year snaps to the month start and spans 12 calendar months.
is("year window snaps to the month start", win("year", "2026-10-05"), ["2026-10-01", "2027-09-30", "month"]);
is("year window from December", win("year", "2026-12-15"), ["2026-12-01", "2027-11-30", "month"]);
is("year window covering a leap February", win("year", "2027-03-01"), ["2027-03-01", "2028-02-29", "month"]);

// A year window must stay inside the SQL function's 400-day guard.
for (const start of ["2026-01-01", "2026-03-01", "2027-03-01", "2028-01-01"]) {
  const w = windowFor("year", start);
  const days = Math.round((Date.parse(w.endInstantExclusive) - Date.parse(w.startInstant)) / 86400000);
  if (days > 400) failures.push(`year window from ${start} spans ${days} days, over the SQL 400-day guard`);
  else passed += 1;
}

// ---------------------------------------------------- bucket counts match

function bucketCount(g, s) {
  const w = windowFor(g, s);
  const days = Math.round((Date.parse(w.endInstantExclusive) - Date.parse(w.startInstant)) / 86400000);
  if (w.bucket === "hour") return days * 24;
  if (w.bucket === "day") return days;
  return 12;
}
is("day = 24 hourly buckets", bucketCount("day", "2026-10-05"), 24);
is("week = 7 daily buckets", bucketCount("week", "2026-10-05"), 7);
is("month from Jan 31 = 28 daily buckets", bucketCount("month", "2026-01-31"), 28);
is("month from Oct 5 = 31 daily buckets", bucketCount("month", "2026-10-05"), 31);
is("year = 12 monthly buckets", bucketCount("year", "2026-10-05"), 12);

// ------------------------------------------------------- Manila instants

is("manilaInstant pins +08:00", manilaInstant("2026-10-05"), "2026-10-05T00:00:00+08:00");
// Manila midnight is 16:00 the previous day in UTC. A window built on the
// browser's zone would start eight hours off.
is("Manila midnight in UTC", new Date(manilaInstant("2026-10-05")).toISOString(), "2026-10-04T16:00:00.000Z");
is(
  "week window bounds as instants",
  [windowFor("week", "2026-10-05").startInstant, windowFor("week", "2026-10-05").endInstantExclusive],
  ["2026-10-05T00:00:00+08:00", "2026-10-12T00:00:00+08:00"]
);
// The exclusive end must be the instant after the last day, so a record at
// 23:59 Manila on the final day is still inside the window.
{
  const w = windowFor("day", "2026-10-05");
  const lastMoment = Date.parse("2026-10-05T23:59:59+08:00");
  if (lastMoment >= Date.parse(w.startInstant) && lastMoment < Date.parse(w.endInstantExclusive)) passed += 1;
  else failures.push("23:59 Manila on the last day fell outside the day window");
  // ...and one minute later is outside it.
  const nextDay = Date.parse("2026-10-06T00:00:00+08:00");
  if (nextDay >= Date.parse(w.endInstantExclusive)) passed += 1;
  else failures.push("midnight the next day fell inside the day window");
}

// todayInManila must follow Manila, not the machine running this.
is("todayInManila at 17:00 UTC is already the next day there", todayInManila(new Date("2026-10-05T17:00:00Z")), "2026-10-06");
is("todayInManila at 15:00 UTC is still the same day", todayInManila(new Date("2026-10-05T15:00:00Z")), "2026-10-05");
is("todayInManila just before Manila midnight", todayInManila(new Date("2026-10-05T15:59:59Z")), "2026-10-05");
is("todayInManila at Manila midnight", todayInManila(new Date("2026-10-05T16:00:00Z")), "2026-10-06");

// --------------------------------------------------------------- defaults

// Defaults are chosen so the window always ends today.
const TODAY = "2026-11-03";
// Day/Week/Month defaults end exactly on today.
for (const g of ["day", "week", "month"]) {
  is(`${g} default window ends today`, windowFor(g, defaultStart(g, TODAY)).endDate, TODAY);
}
// Year is 12 whole calendar months ending with the current one, so its last
// day is the end of this month rather than today itself.
is("year default starts 11 months back", windowFor("year", defaultStart("year", TODAY)).startDate, "2025-12-01");
is("year default ends with this month", windowFor("year", defaultStart("year", TODAY)).endDate, "2026-11-30");
is("firstOfMonth", firstOfMonth(TODAY), "2026-11-01");
is("day default is today", defaultStart("day", TODAY), "2026-11-03");
is("week default is 6 days ago", defaultStart("week", TODAY), "2026-10-28");
is("month default is last month + 1 day", defaultStart("month", TODAY), "2026-10-04");
is("month default window ends today", windowFor("month", defaultStart("month", TODAY)).endDate, TODAY);
// Month default off a month-end date: Mar 31 - 1 month clamps to Feb 28,
// +1 day = Mar 1, so the window still ends on the 31st.
is("month default from Mar 31", defaultStart("month", "2026-03-31"), "2026-03-01");
is("month default from Mar 31 ends on it", windowFor("month", defaultStart("month", "2026-03-31")).endDate, "2026-03-31");

// ---------------------------------------------------------------- paging

is("shift day back", shiftStart("day", "2026-10-05", -1), "2026-10-04");
is("shift week forward", shiftStart("week", "2026-10-05", 1), "2026-10-12");
is("shift week back across a year end", shiftStart("week", "2027-01-01", -1), "2026-12-25");
is("shift month forward", shiftStart("month", "2026-01-31", 1), "2026-02-28");
is("shift month back across a year end", shiftStart("month", "2027-01-15", -1), "2026-12-15");
is("shift year forward", shiftStart("year", "2026-10-05", 1), "2027-10-01");
is("shift year back", shiftStart("year", "2026-10-05", -1), "2025-10-01");

// Successive week windows must tile with no gap and no overlap.
{
  const a = windowFor("week", "2026-10-05");
  const b = windowFor("week", shiftStart("week", "2026-10-05", 1));
  is("consecutive week windows tile exactly", a.endInstantExclusive, b.startInstant);
}
{
  const a = windowFor("month", "2026-01-31");
  const b = windowFor("month", shiftStart("month", "2026-01-31", 1));
  is("consecutive month windows tile exactly", a.endInstantExclusive, b.startInstant);
}

is("cannot page past today", canGoForward("day", TODAY, TODAY), false);
is("can page forward from yesterday", canGoForward("day", "2026-11-02", TODAY), true);
is("cannot page the default week forward", canGoForward("week", defaultStart("week", TODAY), TODAY), false);
is("can page an old week forward", canGoForward("week", "2026-01-05", TODAY), true);

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

is("day label", rangeLabel("day", "2026-10-05", "2026-10-05"), "Oct 5, 2026");
is("week label", rangeLabel("week", "2026-10-05", "2026-10-11"), "Oct 5 – Oct 11, 2026");
is("label across a year end names both years", rangeLabel("week", "2026-12-28", "2027-01-03"), "Dec 28, 2026 – Jan 3, 2027");
is("year label is months only", rangeLabel("year", "2026-10-01", "2027-09-30"), "Oct 2026 – Sep 2027");
is("window carries its own label", windowFor("week", "2026-10-05").label, "Oct 5 – Oct 11, 2026");

// ------------------------------------------------------------------ done

if (failures.length === 0) {
  console.log(`grossNetRange.js: ${passed} checks passed`);
} else {
  console.log(`grossNetRange.js: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
}
