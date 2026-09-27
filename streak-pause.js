/* Shared pure logic, used by the browser and regression tests. */
(function (root) {
  const LIMIT = 5;
  const SLOTS = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5'];
  function ordinal(date) { return Date.parse(`${date}T00:00:00Z`) / 86400000; }
  function dates(months) {
    return new Set(Object.values(months || {}).flatMap(month => Object.values(month || {}).map(record => record.date)).filter(Boolean));
  }
  function compute(activeInput, restInput, today) {
    const active = new Set([...activeInput].filter(date => date <= today));
    const rest = new Set([...restInput].filter(date => date <= today));
    const days = [...new Set([...active, ...rest])].sort();
    let best = 0, run = 0, previous = null;
    for (const date of days) {
      const day = ordinal(date);
      if (previous === null || day !== previous + 1) run = 0;
      if (active.has(date)) run++;
      best = Math.max(best, run);
      previous = day;
    }
    const activeOrdinals = new Set([...active].map(ordinal));
    const restOrdinals = new Set([...rest].map(ordinal));
    let cursor = ordinal(today), current = 0;
    if (!activeOrdinals.has(cursor) && !restOrdinals.has(cursor)) cursor--;
    while (activeOrdinals.has(cursor) || restOrdinals.has(cursor)) {
      if (activeOrdinals.has(cursor)) current++;
      cursor--;
    }
    return { current, best };
  }
  function changeMonth(existing, date, remove, expiresAt, createdAt) {
    const month = { ...(existing || {}) };
    const occupied = SLOTS.find(slot => month[slot]?.date === date);
    if (remove) {
      if (occupied) delete month[occupied];
      return month;
    }
    if (occupied) return month; // Idempotent across devices and repeated clicks.
    const free = SLOTS.find(slot => !month[slot]);
    if (!free) return undefined;
    month[free] = { date, expiresAt, createdAt };
    return month;
  }
  const api = { LIMIT, SLOTS, dates, compute, changeMonth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RestStreak = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
