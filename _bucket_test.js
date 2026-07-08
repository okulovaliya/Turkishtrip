const pad = (n) => String(n).padStart(2, "0");
function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

function buildBuckets(agg, period, metricKey, today) {
  if (period === "week") {
    const labels = [], values = [];
    const base = startOfDay(today);
    for (let w = 7; w >= 0; w--) {
      const end = new Date(base);
      end.setDate(end.getDate() - w * 7);
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      let sum = 0;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = formatDate(d);
        if (agg[ds]) sum += agg[ds][metricKey];
      }
      labels.push(`${pad(start.getDate())}.${pad(start.getMonth() + 1)}`);
      values.push(sum);
    }
    return { labels, values };
  }
  if (period === "month") {
    const labels = [], values = [];
    for (let m = 5; m >= 0; m--) {
      const d = new Date(today.getFullYear(), today.getMonth() - m, 1);
      let sum = 0;
      Object.keys(agg).forEach((ds) => {
        const dd = new Date(ds + "T00:00:00");
        if (dd.getFullYear() === d.getFullYear() && dd.getMonth() === d.getMonth()) sum += agg[ds][metricKey];
      });
      labels.push(d.toLocaleDateString("ru-RU", { month: "short" }).replace(".", ""));
      values.push(sum);
    }
    return { labels, values };
  }
}

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? "PASS" : "FAIL") + " - " + label + " -> " + JSON.stringify(actual) + (ok ? "" : " expected " + JSON.stringify(expected)));
  ok ? pass++ : fail++;
}

const today = new Date("2026-07-08T12:00:00");

// week bucket test: last bucket (w=0) should cover 2026-07-02..2026-07-08 (7 days incl today)
const agg = {
  "2026-07-02": { steps: 1000 },
  "2026-07-08": { steps: 2000 },
  "2026-06-25": { steps: 500 }, // should land in previous week bucket (06-25..07-01)
};
const weekRes = buildBuckets(agg, "week", "steps", today);
assertEq(weekRes.labels.length, 8, "week: 8 buckets");
assertEq(weekRes.labels[7], "02.07", "week: last bucket starts 02.07");
assertEq(weekRes.values[7], 3000, "week: last bucket sums both 07-02 and 07-08");
assertEq(weekRes.values[6], 500, "week: previous bucket picks up 06-25");

// month bucket test
const aggM = {
  "2026-07-05": { steps: 100 },
  "2026-06-10": { steps: 200 },
  "2025-07-01": { steps: 999 }, // should NOT count (13 months back, out of 6-month window anyway but also wrong year check)
};
const monthRes = buildBuckets(aggM, "month", "steps", today);
assertEq(monthRes.labels.length, 6, "month: 6 buckets");
assertEq(monthRes.labels[5], "июл", "month: last bucket is июл (current month)");
assertEq(monthRes.values[5], 100, "month: current month sums correctly");
assertEq(monthRes.values[4], 200, "month: previous month (июн) sums correctly");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
