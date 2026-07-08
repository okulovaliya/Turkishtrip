// Standalone test of pure date/streak/points logic copied from app.js
const pad = (n) => String(n).padStart(2, "0");
function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
const TRIP_DATE = new Date('2026-08-28T00:00:00');
function computeDaysLeft(todayOverride) {
  const today = startOfDay(todayOverride || new Date());
  const trip = startOfDay(TRIP_DATE);
  return Math.ceil((trip - today) / 86400000);
}
function pointsForSteps(steps) { return Math.round(steps / 100); }
function pointsForWorkout(min) { return min * 2; }

function computeStreakFromDates(activeDatesArr, todayOverride) {
  const activeDates = new Set(activeDatesArr);
  let current = 0;
  let cursor = startOfDay(todayOverride || new Date());
  if (!activeDates.has(formatDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (activeDates.has(formatDate(cursor))) { current += 1; cursor.setDate(cursor.getDate() - 1); }
  const sorted = Array.from(activeDates).sort();
  let best = 0, run = 0, prev = null;
  sorted.forEach((ds) => {
    const d = new Date(ds + "T00:00:00");
    if (prev && (d - prev) / 86400000 === 1) run += 1; else run = 1;
    if (run > best) best = run;
    prev = d;
  });
  return { current, best: Math.max(best, current) };
}

// --- Tests ---
let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? "PASS" : "FAIL") + " - " + label + " -> got " + JSON.stringify(actual) + (ok ? "" : ", expected " + JSON.stringify(expected)));
  ok ? pass++ : fail++;
}

// days left: today = 2026-07-08, trip = 2026-08-28 -> 51 days
assertEq(computeDaysLeft(new Date('2026-07-08T10:00:00')), 51, "days left from 2026-07-08");
// exact trip day
assertEq(computeDaysLeft(new Date('2026-08-28T09:00:00')), 0, "days left on trip day");
// after trip
assertEq(computeDaysLeft(new Date('2026-08-30T09:00:00')) < 0, true, "days left negative after trip");

// points
assertEq(pointsForSteps(6543), 65, "points for 6543 steps");
assertEq(pointsForWorkout(30), 60, "points for 30 min workout");

// streak: 3 consecutive days ending today
const today = new Date('2026-07-08T12:00:00');
assertEq(computeStreakFromDates(["2026-07-06","2026-07-07","2026-07-08"], today), { current: 3, best: 3 }, "3-day streak ending today");

// streak broken (missing yesterday)
assertEq(computeStreakFromDates(["2026-07-05","2026-07-08"], today), { current: 1, best: 1 }, "broken streak, only today active");

// streak counts yesterday if today not yet logged
assertEq(computeStreakFromDates(["2026-07-05","2026-07-06","2026-07-07"], today), { current: 3, best: 3 }, "streak continues from yesterday if today empty");

// best streak higher than current
assertEq(computeStreakFromDates(["2026-06-01","2026-06-02","2026-06-03","2026-06-04","2026-07-08"], today), { current: 1, best: 4 }, "best streak preserved from earlier run");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
