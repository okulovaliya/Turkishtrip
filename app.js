/* ===========================================================
   Turkey Challenge — mobile fitness prep app for 3 friends
   =========================================================== */

// ---------- CONFIG ----------
const TRIP_DATE = new Date('2026-08-28T00:00:00');
const DAILY_STEP_GOAL = 8000;

// Fallback copy of users.json in case fetch fails (e.g. opened via file://)
// No passwords are stored anywhere — Firebase Authentication owns those.
const FALLBACK_USERS = [
  { login: "tanya",  email: "tanya@turkeytrip.app",  name: "Танюшка",     avatar: "🌴", color: "#FF7A59" },
  { login: "lilu",   email: "lilu@turkeytrip.app",   name: "Лилу",        avatar: "🍹", color: "#2FD9C4" },
  { login: "nastya", email: "nastya@turkeytrip.app", name: "Анастасися",  avatar: "☀️", color: "#FFC93C" }
];

const MOTIVATION_STEPS = [
  "Ещё немного, и на пляже ты будешь порхать как бабочка! 🦋",
  "Загранпаспорт готов, ноги — тоже! 💪",
  "Турция уже слышит твои шаги 👣✈️",
  "Каждый шаг — это на шаг ближе к морю 🌊",
  "Ты сегодня буквально шла к отпуску!",
  "Шагами к шезлонгу! 🏖️",
  "Так держать — купальник уже нервничает 😄",
  "Прогресс не купишь, зато можно нашагать!"
];

const MOTIVATION_WORKOUT = [
  "Тело говорит спасибо, отпуск говорит «жду тебя»! 🙌",
  "Ещё одна тренировка — ещё одна причина гордиться собой 💥",
  "Турецкий загар оценит эту тренировку по достоинству ☀️",
  "Мышцы качаются, чемодан почти собран 🧳",
  "Ты сильнее вчерашней себя!",
  "Пляжный волейбол вот-вот скажет тебе спасибо 🏐",
  "Отличная работа! Заслужила мороженое (по желанию 😉)"
];

const MOTIVATION_DAILY = [
  { emoji: "🍺", text: "Вы на один день ближе к холодному пиву в Турции" },
  { emoji: "🍹", text: "Каждый шаг приближает вас к all inclusive" },
  { emoji: "🏖️", text: "Турция уже готовит для вас лежак" },
  { emoji: "🧳", text: "Ещё чуть-чуть — и чемодан можно закрывать" },
  { emoji: "😎", text: "Загар ждёт, а вы уже в форме" },
  { emoji: "💪", text: "Команда красавицы — отпуск заслужен на 100%" },
  { emoji: "🌊", text: "До моря ближе, чем кажется" },
  { emoji: "🍸", text: "Сегодняшняя тренировка — это завтрашний коктейль у бассейна" },
  { emoji: "👣", text: "Вы буквально идёте к отпуску ногами" },
  { emoji: "🌴", text: "Ещё немного — и будильники на паузе" }
];

const ACHIEVEMENTS = [
  { id: "first_step", emoji: "👣", name: "Первый шаг", desc: "Добавь первую активность",
    check: (c) => c.totals.entryCount >= 1 },
  { id: "streak3", emoji: "🔥", name: "Разгон", desc: "3 дня подряд с активностью",
    check: (c) => c.streak.best >= 3 },
  { id: "streak7", emoji: "🚀", name: "Неделя силы", desc: "7 дней подряд с активностью",
    check: (c) => c.streak.best >= 7 },
  { id: "club10k", emoji: "🏅", name: "Клуб 10 000", desc: "10 000+ шагов за день",
    check: (c) => c.totals.maxDaySteps >= 10000 },
  { id: "marathoner", emoji: "🏋️", name: "Марафонец", desc: "300+ минут тренировок всего",
    check: (c) => c.totals.totalWorkoutMinutes >= 300 },
  { id: "club100k", emoji: "💯", name: "100K клуб", desc: "100 000 шагов с начала челленджа",
    check: (c) => c.totals.totalSteps >= 100000 },
  { id: "team_spirit", emoji: "🤝", name: "Командный дух", desc: "300 000 шагов всей командой",
    check: (c) => c.teamTotals.totalSteps >= 300000 },
  { id: "almost_there", emoji: "🛫", name: "Почти там!", desc: "7 дней до поездки или меньше",
    check: (c) => c.daysLeft <= 7 && c.daysLeft >= 0 }
];

// ---------- STATE ----------
let USERS = [];
let currentUser = null;
let activities = {}; // login -> { entryId: {id, date, type, steps?, workoutType?, workoutMinutes?, points, ts} }
let comments = {}; // activityId -> { commentId: {login, name, text, ts} }
let reactions = {}; // activityId -> { emoji: { login: true } }
let weekChartInstance = null;
let teamChartInstance = null;
let toastTimer = null;
let editingEntryId = null;
let currentTab = "home";
let useCloud = false;
let db = null;
let chartMetric = "workouts"; // home chart: steps already shown by the ring above, so default to workouts
let chartPeriod = "day";
let teamChartMetric = "steps";
let teamChartPeriod = "day";

// ---------- UTIL ----------
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, "0");

function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function getTodayStr() {
  return formatDate(new Date());
}
function getLastNDates(n) {
  const out = [];
  const today = startOfDay(new Date());
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(formatDate(d));
  }
  return out;
}
function dayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("ru-RU", { weekday: "short" }).replace(".", "");
}
function computeDaysLeft() {
  const today = startOfDay(new Date());
  const trip = startOfDay(TRIP_DATE);
  return Math.ceil((trip - today) / 86400000);
}
function pointsForSteps(steps) { return Math.round(steps / 100); }
// Points per minute by workout type, roughly proportional to intensity (MET).
const WORKOUT_POINT_RATES = {
  "Кардио": 3,
  "Плавание": 3,
  "Силовая": 2.5,
  "Танцы": 2,
  "Прогулка": 1.5,
  "Йога": 1.5
};
function pointsForWorkout(min, type) {
  const rate = WORKOUT_POINT_RATES[type] ?? 2;
  return Math.round(min * rate);
}
function randomId() { return Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function nf(n) { return Number(n || 0).toLocaleString("ru-RU"); }
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function relativeTime(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин назад`;
  const hrs = Math.floor(diffMin / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн назад`;
  return `${Math.floor(days / 7)} нед назад`;
}

// ---------- DATA LOADING ----------
async function loadUsersData() {
  try {
    const res = await fetch("users.json", { cache: "no-store" });
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    USERS = Array.isArray(data) && data.length ? data : FALLBACK_USERS;
  } catch (e) {
    USERS = FALLBACK_USERS;
  }
}

// Cloud (Firebase) sync with automatic fallback to local-only storage
// if firebase-config.js hasn't been filled in yet.
function initStorage() {
  try {
    if (
      typeof firebaseConfig !== "undefined" &&
      firebaseConfig &&
      firebaseConfig.apiKey &&
      !String(firebaseConfig.apiKey).includes("ВАШ") &&
      typeof firebase !== "undefined"
    ) {
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      useCloud = true;
    }
  } catch (e) {
    console.warn("Firebase недоступен, работаем в локальном режиме:", e);
    useCloud = false;
  }

  if (useCloud) {
    db.ref("activities").on("value", (snap) => {
      activities = snap.val() || {};
      ensureUserBuckets();
      rerenderCurrentTab();
    });
    db.ref("comments").on("value", (snap) => {
      comments = snap.val() || {};
      rerenderCurrentTab();
    });
    db.ref("reactions").on("value", (snap) => {
      reactions = snap.val() || {};
      rerenderCurrentTab();
    });
  } else {
    loadLocalFallback();
  }
}

function ensureUserBuckets() {
  USERS.forEach((u) => {
    if (!activities[u.login]) activities[u.login] = {};
  });
}

function loadLocalFallback() {
  try { activities = JSON.parse(localStorage.getItem("tc_activities") || "{}"); } catch (e) { activities = {}; }
  try { comments = JSON.parse(localStorage.getItem("tc_comments") || "{}"); } catch (e) { comments = {}; }
  try { reactions = JSON.parse(localStorage.getItem("tc_reactions") || "{}"); } catch (e) { reactions = {}; }
  ensureUserBuckets();
}

// Only used in local (non-cloud) fallback mode — cloud writes persist per-call.
function persistLocal() {
  if (useCloud) return;
  localStorage.setItem("tc_activities", JSON.stringify(activities));
  localStorage.setItem("tc_comments", JSON.stringify(comments));
  localStorage.setItem("tc_reactions", JSON.stringify(reactions));
}

function rerenderCurrentTab() {
  if (!currentUser) return;
  if (currentTab === "home") renderHome();
  else if (currentTab === "feed") renderFeed();
  else if (currentTab === "team") renderTeam();
  else if (currentTab === "ach") renderAchievements();
  else if (currentTab === "profile") renderProfile();
}

// ---------- COMPUTATIONS ----------
function dailyAggregates(login) {
  const map = {};
  Object.values(activities[login] || {}).forEach((e) => {
    if (!map[e.date]) map[e.date] = { steps: 0, workoutMinutes: 0, points: 0, workouts: [] };
    if (e.type === "steps") map[e.date].steps += e.steps;
    if (e.type === "workout") {
      map[e.date].workoutMinutes += e.workoutMinutes;
      map[e.date].workouts.push({ type: e.workoutType, minutes: e.workoutMinutes });
    }
    map[e.date].points += e.points || 0;
  });
  return map;
}

// Builds chart-ready {labels, values} buckets for a metric ("steps" | "workouts" | "points")
// over a period granularity ("day" -> last 7 days, "week" -> last 8 weeks, "month" -> last 6 months).
function buildBuckets(login, period, metric) {
  const agg = dailyAggregates(login);
  const metricKey = metric === "steps" ? "steps" : metric === "workouts" ? "workoutMinutes" : "points";

  if (period === "week") {
    const labels = [], values = [];
    const today = startOfDay(new Date());
    for (let w = 7; w >= 0; w--) {
      const end = new Date(today);
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
    const today = new Date();
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

  // day (default): last 7 individual days
  const dates = getLastNDates(7);
  return {
    labels: dates.map(dayLabel),
    values: dates.map((d) => (agg[d] ? agg[d][metricKey] : 0))
  };
}

function metricLabel(metric) {
  if (metric === "steps") return "Шаги";
  if (metric === "workouts") return "Минуты тренировок";
  return "Очки";
}

function computeTotals(login) {
  const list = Object.values(activities[login] || {});
  const agg = dailyAggregates(login);
  let totalSteps = 0, totalWorkouts = 0, totalWorkoutMinutes = 0, points = 0, maxDaySteps = 0;
  list.forEach((e) => {
    points += e.points || 0;
    if (e.type === "steps") totalSteps += e.steps;
    if (e.type === "workout") { totalWorkouts += 1; totalWorkoutMinutes += e.workoutMinutes; }
  });
  Object.values(agg).forEach((d) => { if (d.steps > maxDaySteps) maxDaySteps = d.steps; });
  return { totalSteps, totalWorkouts, totalWorkoutMinutes, points, maxDaySteps, entryCount: list.length, agg };
}

function computeStreak(login) {
  const agg = dailyAggregates(login);
  const activeDates = new Set(Object.keys(agg).filter((d) => agg[d].steps > 0 || agg[d].workoutMinutes > 0));
  // current streak: walk back from today
  let current = 0;
  let cursor = startOfDay(new Date());
  // allow streak to still count "today" as pending — start check from today, if missing today, try from yesterday
  if (!activeDates.has(formatDate(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (activeDates.has(formatDate(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  // best streak across all history
  const sortedDates = Array.from(activeDates).sort();
  let best = 0, run = 0, prev = null;
  sortedDates.forEach((ds) => {
    const d = new Date(ds + "T00:00:00");
    if (prev && (d - prev) / 86400000 === 1) run += 1; else run = 1;
    if (run > best) best = run;
    prev = d;
  });
  return { current, best: Math.max(best, current) };
}

function computeTeamTotals() {
  let totalSteps = 0, totalPoints = 0, totalWorkouts = 0;
  const today = getTodayStr();
  let todaySteps = 0;
  USERS.forEach((u) => {
    const t = computeTotals(u.login);
    totalSteps += t.totalSteps;
    totalPoints += t.points;
    totalWorkouts += t.totalWorkouts;
    const agg = dailyAggregates(u.login);
    if (agg[today]) todaySteps += agg[today].steps;
  });
  return { totalSteps, totalPoints, totalWorkouts, todaySteps };
}

function computeAchievements(login) {
  const totals = computeTotals(login);
  const streak = computeStreak(login);
  const teamTotals = computeTeamTotals();
  const daysLeft = computeDaysLeft();
  const ctx = { totals, streak, teamTotals, daysLeft };
  return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: a.check(ctx) }));
}

// ---------- AUTH ----------
// No passwords are ever stored in a file. When Firebase is configured, real
// authentication happens through Firebase Authentication: the first time
// someone logs in with a given name, that password is registered for her
// (Firebase hashes and stores it securely); every login after that verifies
// against Firebase, never against anything we control.
function firebaseAuthErrorText(err) {
  const map = {
    "auth/weak-password": "Пароль должен быть не короче 6 символов.",
    "auth/invalid-email": "Некорректный логин.",
    "auth/too-many-requests": "Слишком много попыток входа, попробуйте чуть позже.",
    "auth/network-request-failed": "Нет соединения с сервером.",
    "auth/user-disabled": "Этот аккаунт отключён."
  };
  return (err && map[err.code]) || "Не удалось войти. Попробуйте ещё раз.";
}

async function attemptLogin(loginRaw, password) {
  const clean = loginRaw.trim().toLowerCase();
  const user = USERS.find((u) => u.login.toLowerCase() === clean);
  if (!user) return { ok: false, error: "Такой участницы нет в списке." };

  if (!useCloud) {
    // Local demo mode (Firebase not configured yet) — no password is stored
    // anywhere, so anyone can sign in as any known name on this one device.
    currentUser = user;
    return { ok: true };
  }

  const email = user.email || `${user.login}@turkeytrip.app`;

  try {
    try {
      await firebase.auth().signInWithEmailAndPassword(email, password);
      currentUser = user;
      return { ok: true };
    } catch (signInErr) {
      // Not registered yet (or signIn failed for another reason) — try to
      // register. If registration says the email is already in use, the
      // account exists and the original failure really was a wrong password.
      try {
        await firebase.auth().createUserWithEmailAndPassword(email, password);
        currentUser = user;
        return { ok: true };
      } catch (signUpErr) {
        if (signUpErr.code === "auth/email-already-in-use") {
          return { ok: false, error: "Неверный пароль." };
        }
        return { ok: false, error: firebaseAuthErrorText(signUpErr) };
      }
    }
  } catch (fatalErr) {
    // firebase.auth() itself threw (e.g. SDK blocked/failed to load) — never
    // leave the login button stuck, surface a clear message instead.
    console.warn("Firebase Auth недоступен:", fatalErr);
    return { ok: false, error: "Не удалось связаться с сервером входа. Проверьте соединение и попробуйте ещё раз." };
  }
}

function logout() {
  if (useCloud && firebase.auth().currentUser) firebase.auth().signOut();
  currentUser = null;
  localStorage.removeItem("tc_session");
  $("#appScreen").hidden = true;
  $("#loginScreen").hidden = false;
  $("#loginForm").reset();
}

// ---------- RENDER: HOME ----------
function renderHome() {
  if (!currentUser) return;
  $("#homeAvatar").textContent = currentUser.avatar;
  $("#homeGreeting").textContent = `Привет, ${currentUser.name}!`;

  const streak = computeStreak(currentUser.login);
  $("#homeStreak").textContent = streak.current > 0
    ? `🔥 ${streak.current} ${daysWord(streak.current)} подряд`
    : "Начни серию сегодня!";

  const daysLeft = computeDaysLeft();
  $("#countdownNum").textContent = daysLeft > 0 ? daysLeft : (daysLeft === 0 ? "Сегодня!" : "🎉");
  $("#countdownChip").querySelector(".countdown-label").textContent =
    daysLeft > 0 ? "дней до Турции" : (daysLeft === 0 ? "уже летим!" : "с моря — привет!");

  const motivation = pick(MOTIVATION_DAILY);
  $("#motivationEmoji").textContent = motivation.emoji;
  $("#motivationText").textContent = motivation.text;

  const agg = dailyAggregates(currentUser.login);
  const todaySteps = (agg[getTodayStr()] && agg[getTodayStr()].steps) || 0;
  const frac = Math.max(0, Math.min(1, todaySteps / DAILY_STEP_GOAL));
  const circumference = 540;
  $("#ringProgress").style.strokeDashoffset = String(circumference * (1 - frac));
  $("#ringValue").textContent = nf(todaySteps);
  $("#ringGoal").textContent = `цель: ${nf(DAILY_STEP_GOAL)}`;

  const teamGoal = DAILY_STEP_GOAL * USERS.length;
  const team = computeTeamTotals();
  const teamFrac = Math.max(0, Math.min(1, team.todaySteps / teamGoal));
  $("#teamBarFill").style.width = (teamFrac * 100) + "%";
  $("#teamBarCaption").textContent = `${nf(team.todaySteps)} из ${nf(teamGoal)} шагов`;

  const miniWrap = $("#miniFriends");
  miniWrap.innerHTML = "";
  USERS.forEach((u) => {
    const uAgg = dailyAggregates(u.login);
    const steps = (uAgg[getTodayStr()] && uAgg[getTodayStr()].steps) || 0;
    const el = document.createElement("div");
    el.className = "mini-friend";
    el.innerHTML = `
      <div class="avatar" style="background:${u.color}22;border:1px solid ${u.color}55">${u.avatar}</div>
      <div class="mf-name">${u.name}</div>
      <div class="mf-val">${nf(steps)}</div>`;
    miniWrap.appendChild(el);
  });

  renderHistory();
  renderWeekChart();
}

function daysWord(n) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "день";
  if ([2, 3, 4].includes(n10) && ![12, 13, 14].includes(n100)) return "дня";
  return "дней";
}

function renderHistory() {
  const list = Object.values(activities[currentUser.login] || {}).sort((a, b) => b.ts - a.ts).slice(0, 6);
  const el = $("#historyList");
  el.innerHTML = "";
  if (!list.length) {
    el.innerHTML = `<li class="hi-empty">Пока пусто — добавь первую активность 👆</li>`;
    return;
  }
  list.forEach((e) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const mainHtml = e.type === "steps"
      ? `<span class="hi-emoji">🚶</span><span class="hi-main">${nf(e.steps)} шагов <span class="hi-date">· ${e.date}</span></span>`
      : `<span class="hi-emoji">🏋️</span><span class="hi-main">${e.workoutType}, ${e.workoutMinutes} мин${e.workoutCalories ? `, ${nf(e.workoutCalories)} ккал` : ""} <span class="hi-date">· ${e.date}</span></span>`;
    li.innerHTML = `${mainHtml}<span class="hi-points">+${e.points}</span>
      <span class="hi-actions">
        <button class="hi-edit" data-id="${e.id}" title="Изменить">✏️</button>
        <button class="hi-delete" data-id="${e.id}" title="Удалить">🗑</button>
      </span>`;
    el.appendChild(li);
  });
}

function openEditModalForEntry(entry) {
  editingEntryId = entry.id;
  if (entry.type === "steps") {
    $("#stepsInput").value = entry.steps;
    $("#stepsDate").max = getTodayStr();
    $("#stepsDate").value = entry.date;
    $("#stepsModalTitle").textContent = "Изменить шаги ✏️";
    $("#saveStepsBtn").textContent = "Сохранить изменения";
    openModal("stepsModal");
  } else {
    $("#workoutType").value = entry.workoutType;
    $("#workoutMinutes").value = entry.workoutMinutes;
    $("#workoutCalories").value = entry.workoutCalories || "";
    $("#workoutDate").max = getTodayStr();
    $("#workoutDate").value = entry.date;
    $("#workoutModalTitle").textContent = "Изменить тренировку ✏️";
    $("#saveWorkoutBtn").textContent = "Сохранить изменения";
    openModal("workoutModal");
  }
}

function updateStepsEntry(id, steps, date) {
  const entry = activities[currentUser.login] && activities[currentUser.login][id];
  if (!entry) return;
  entry.steps = steps;
  entry.points = pointsForSteps(steps);
  entry.date = date || entry.date;
  if (useCloud) db.ref(`activities/${currentUser.login}/${id}`).update({ steps: entry.steps, points: entry.points, date: entry.date });
  else persistLocal();
  showToast("✏️", "Запись обновлена!");
  renderHome();
}

function updateWorkoutEntry(id, type, minutes, calories, date) {
  const entry = activities[currentUser.login] && activities[currentUser.login][id];
  if (!entry) return;
  entry.workoutType = type;
  entry.workoutMinutes = minutes;
  entry.workoutCalories = calories || null;
  entry.points = pointsForWorkout(minutes, type);
  entry.date = date || entry.date;
  if (useCloud) {
    db.ref(`activities/${currentUser.login}/${id}`).update({
      workoutType: entry.workoutType,
      workoutMinutes: entry.workoutMinutes,
      workoutCalories: entry.workoutCalories,
      points: entry.points,
      date: entry.date
    });
  } else {
    persistLocal();
  }
  showToast("✏️", "Запись обновлена!");
  renderHome();
}

function deleteEntry(id) {
  if (!confirm("Удалить эту запись из истории?")) return;
  if (activities[currentUser.login]) delete activities[currentUser.login][id];
  if (comments[id]) delete comments[id];
  if (reactions[id]) delete reactions[id];
  if (useCloud) {
    db.ref(`activities/${currentUser.login}/${id}`).remove();
    db.ref(`comments/${id}`).remove();
    db.ref(`reactions/${id}`).remove();
  } else {
    persistLocal();
  }
  showToast("🗑", "Запись удалена");
  renderHome();
}

function renderWeekChart() {
  const canvas = $("#weekChart");
  if (!canvas || typeof Chart === "undefined") return;
  const { labels, values } = buildBuckets(currentUser.login, chartPeriod, chartMetric);
  if (weekChartInstance) weekChartInstance.destroy();
  weekChartInstance = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: metricLabel(chartMetric),
        data: values,
        backgroundColor: currentUser.color || "#2FD9C4",
        borderRadius: 8,
        maxBarThickness: 26
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#9AA0B2" } },
        y: { grid: { color: "#232838" }, ticks: { color: "#9AA0B2" } }
      }
    }
  });
}

const REACTION_EMOJIS = ["🔥", "👏", "💪", "🎉", "😍"];

// ---------- RENDER: FEED ----------
function buildFeed() {
  const items = [];
  USERS.forEach((u) => {
    Object.values(activities[u.login] || {}).forEach((e) => {
      const text = e.type === "steps"
        ? `добавила ${nf(e.steps)} шагов 🚶`
        : `добавила тренировку: ${e.workoutType}, ${e.workoutMinutes} мин${e.workoutCalories ? `, ${nf(e.workoutCalories)} ккал` : ""} 🏋️`;
      items.push({ id: e.id, login: u.login, name: u.name, avatar: u.avatar, color: u.color, text, ts: e.ts });
    });
  });
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, 40);
}

function renderFeed() {
  const wrap = $("#feedList");
  const items = buildFeed();
  wrap.innerHTML = "";
  if (!items.length) {
    wrap.innerHTML = `<div class="hi-empty">Пока новостей нет — добавьте активность 👆</div>`;
    return;
  }
  items.forEach((item) => {
    const itemComments = Object.entries(comments[item.id] || {}).sort((a, b) => a[1].ts - b[1].ts);
    const itemReactions = reactions[item.id] || {};
    const el = document.createElement("div");
    el.className = "feed-item";
    el.dataset.id = item.id;

    const reactionsHtml = REACTION_EMOJIS.map((r) => {
      const logins = Object.keys(itemReactions[r] || {});
      const active = logins.includes(currentUser.login);
      return `<button class="reaction-btn${active ? " active" : ""}" type="button" data-item="${item.id}" data-emoji="${r}">${r}${logins.length ? ` <span class="reaction-count">${logins.length}</span>` : ""}</button>`;
    }).join("");

    const commentsHtml = itemComments.length
      ? `<div class="feed-comments">${itemComments.map(([cid, c]) => `
          <div class="feed-comment">
            <span><b>${escapeHtml(c.name)}:</b> ${escapeHtml(c.text)}</span>
            ${c.login === currentUser.login ? `<button class="feed-comment-del" type="button" data-item="${item.id}" data-cid="${cid}">✕</button>` : ""}
          </div>`).join("")}</div>`
      : "";

    el.innerHTML = `
      <div class="feed-header">
        <div class="avatar" style="background:${item.color}22;border:1px solid ${item.color}55">${item.avatar}</div>
        <div class="feed-header-text">
          <div class="feed-line"><b>${escapeHtml(item.name)}</b> ${item.text}</div>
          <div class="feed-time">${relativeTime(item.ts)}</div>
        </div>
      </div>
      <div class="feed-reactions">${reactionsHtml}</div>
      ${commentsHtml}
      <div class="feed-comment-form">
        <input type="text" class="feed-comment-input" placeholder="Написать комментарий...">
        <button class="feed-comment-btn" type="button">➤</button>
      </div>`;
    wrap.appendChild(el);
  });
}

function addCommentFromItem(itemEl) {
  const id = itemEl.dataset.id;
  const input = itemEl.querySelector(".feed-comment-input");
  const text = input.value.trim();
  if (!text) return;
  const cid = randomId();
  const comment = { login: currentUser.login, name: currentUser.name, text, ts: Date.now() };
  if (!comments[id]) comments[id] = {};
  comments[id][cid] = comment;
  if (useCloud) db.ref(`comments/${id}/${cid}`).set(comment);
  else persistLocal();
  renderFeed();
}

function deleteComment(itemId, cid) {
  if (!comments[itemId] || !comments[itemId][cid]) return;
  delete comments[itemId][cid];
  if (Object.keys(comments[itemId]).length === 0) delete comments[itemId];
  if (useCloud) db.ref(`comments/${itemId}/${cid}`).remove();
  else persistLocal();
  renderFeed();
}

function toggleReaction(itemId, emoji) {
  if (!reactions[itemId]) reactions[itemId] = {};
  if (!reactions[itemId][emoji]) reactions[itemId][emoji] = {};
  const already = !!reactions[itemId][emoji][currentUser.login];
  if (already) {
    delete reactions[itemId][emoji][currentUser.login];
    if (useCloud) db.ref(`reactions/${itemId}/${emoji}/${currentUser.login}`).remove();
  } else {
    reactions[itemId][emoji][currentUser.login] = true;
    if (useCloud) db.ref(`reactions/${itemId}/${emoji}/${currentUser.login}`).set(true);
  }
  if (Object.keys(reactions[itemId][emoji]).length === 0) delete reactions[itemId][emoji];
  if (!useCloud) persistLocal();
  renderFeed();
}

// ---------- RENDER: TEAM ----------
function renderTeam() {
  const canvas = $("#teamChart");
  if (canvas && typeof Chart !== "undefined") {
    let labels = [];
    const datasets = USERS.map((u) => {
      const bucket = buildBuckets(u.login, teamChartPeriod, teamChartMetric);
      labels = bucket.labels;
      return {
        label: u.name,
        data: bucket.values,
        backgroundColor: u.color,
        borderRadius: 6,
        maxBarThickness: 18
      };
    });
    if (teamChartInstance) teamChartInstance.destroy();
    teamChartInstance = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        plugins: { legend: { position: "bottom", labels: { color: "#F4F5F7", boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: "#9AA0B2" } },
          y: { stacked: true, grid: { color: "#232838" }, ticks: { color: "#9AA0B2" } }
        }
      }
    });
  }

  const wrap = $("#teamList");
  wrap.innerHTML = "";
  USERS.slice().sort((a, b) => computeTotals(b.login).points - computeTotals(a.login).points).forEach((u) => {
    const t = computeTotals(u.login);
    const s = computeStreak(u.login);
    const row = document.createElement("div");
    row.className = "team-row";
    row.innerHTML = `
      <div class="avatar" style="background:${u.color}22;border:1px solid ${u.color}55">${u.avatar}</div>
      <div class="tr-info">
        <div class="tr-name">${u.name}</div>
        <div class="tr-sub">${nf(t.totalSteps)} шагов · ${t.totalWorkouts} тренировок · 🔥${s.current}</div>
      </div>
      <div class="tr-points">${nf(t.points)}</div>`;
    wrap.appendChild(row);
  });
}

// ---------- RENDER: ACHIEVEMENTS ----------
function renderAchievements() {
  const list = computeAchievements(currentUser.login);
  const wrap = $("#badgeGrid");
  wrap.innerHTML = "";
  list.forEach((a) => {
    const el = document.createElement("div");
    el.className = "badge" + (a.unlocked ? " unlocked" : "");
    el.innerHTML = `
      <div class="badge-emoji">${a.emoji}</div>
      <div class="badge-name">${a.name}</div>
      <div class="badge-desc">${a.desc}</div>`;
    wrap.appendChild(el);
  });
}

// ---------- RENDER: PROFILE ----------
function renderProfile() {
  $("#profileAvatar").textContent = currentUser.avatar;
  $("#profileName").textContent = currentUser.name;
  $("#profileLogin").textContent = "@" + currentUser.login;
  const badge = $("#syncBadge");
  badge.textContent = useCloud ? "☁️ синхронизировано со всеми" : "📱 только на этом устройстве";
  badge.classList.toggle("cloud", useCloud);
  const t = computeTotals(currentUser.login);
  const s = computeStreak(currentUser.login);
  $("#statTotalSteps").textContent = nf(t.totalSteps);
  $("#statWorkouts").textContent = t.totalWorkouts;
  $("#statBestStreak").textContent = s.best;
  $("#statPoints").textContent = nf(t.points);
}

// ---------- ACTIVITY ADDING ----------
function addStepsEntry(steps, date) {
  const before = new Set(computeAchievements(currentUser.login).filter((a) => a.unlocked).map((a) => a.id));
  const id = randomId();
  const entry = { id, date: date || getTodayStr(), type: "steps", steps, points: pointsForSteps(steps), ts: Date.now() };
  if (!activities[currentUser.login]) activities[currentUser.login] = {};
  activities[currentUser.login][id] = entry;
  if (useCloud) db.ref(`activities/${currentUser.login}/${id}`).set(entry);
  else persistLocal();
  afterAdd("steps", before);
}
function addWorkoutEntry(type, minutes, calories, date) {
  const before = new Set(computeAchievements(currentUser.login).filter((a) => a.unlocked).map((a) => a.id));
  const id = randomId();
  const entry = { id, date: date || getTodayStr(), type: "workout", workoutType: type, workoutMinutes: minutes, workoutCalories: calories || null, points: pointsForWorkout(minutes, type), ts: Date.now() };
  if (!activities[currentUser.login]) activities[currentUser.login] = {};
  activities[currentUser.login][id] = entry;
  if (useCloud) db.ref(`activities/${currentUser.login}/${id}`).set(entry);
  else persistLocal();
  afterAdd("workout", before);
}

function afterAdd(kind, beforeUnlocked) {
  const after = computeAchievements(currentUser.login).filter((a) => a.unlocked);
  const newlyUnlocked = after.find((a) => !beforeUnlocked.has(a.id));
  if (newlyUnlocked) {
    showToast(newlyUnlocked.emoji, `Новое достижение: «${newlyUnlocked.name}»!`);
  } else {
    const msg = kind === "steps" ? pick(MOTIVATION_STEPS) : pick(MOTIVATION_WORKOUT);
    showToast(kind === "steps" ? "🚶" : "🏋️", msg);
  }
  renderHome();
}

function showToast(emoji, text) {
  const t = $("#toast");
  $("#toastEmoji").textContent = emoji;
  $("#toastText").textContent = text;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

// ---------- MODALS ----------
function openModal(id) { $("#" + id).hidden = false; }
function closeModal(id) { $("#" + id).hidden = true; }

// ---------- NAV ----------
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = true));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  $(`#tab-${tab}`).hidden = false;
  document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add("active");
  if (tab === "home") renderHome();
  if (tab === "feed") renderFeed();
  if (tab === "team") renderTeam();
  if (tab === "ach") renderAchievements();
  if (tab === "profile") renderProfile();
}

// ---------- APP BOOT ----------
function showApp() {
  $("#loginScreen").hidden = true;
  $("#appScreen").hidden = false;
  switchTab("home");
}

function wireEvents() {
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = $("#loginInput").value;
    const password = $("#passwordInput").value;
    const btn = $("#loginSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Входим...";
    const result = await attemptLogin(login, password);
    btn.disabled = false;
    btn.textContent = "Войти ✈️";
    if (result.ok) {
      $("#loginError").hidden = true;
      if (!useCloud) localStorage.setItem("tc_session", currentUser.login);
      showApp();
    } else {
      $("#loginError").textContent = result.error;
      $("#loginError").hidden = false;
    }
  });

  $("#logoutBtn").addEventListener("click", logout);
  $("#logoutBtn2").addEventListener("click", logout);

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("#openStepsModal").addEventListener("click", () => {
    editingEntryId = null;
    $("#stepsModalTitle").textContent = "Добавить шаги 🚶";
    $("#saveStepsBtn").textContent = "Сохранить";
    $("#stepsInput").value = "";
    $("#stepsDate").max = getTodayStr();
    $("#stepsDate").value = getTodayStr();
    openModal("stepsModal");
  });
  $("#openWorkoutModal").addEventListener("click", () => {
    editingEntryId = null;
    $("#workoutModalTitle").textContent = "Добавить тренировку 🏋️";
    $("#saveWorkoutBtn").textContent = "Сохранить";
    $("#workoutMinutes").value = "";
    $("#workoutCalories").value = "";
    $("#workoutDate").max = getTodayStr();
    $("#workoutDate").value = getTodayStr();
    openModal("workoutModal");
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => { closeModal(btn.dataset.close); editingEntryId = null; });
  });

  $("#saveStepsBtn").addEventListener("click", () => {
    const val = parseInt($("#stepsInput").value, 10);
    if (!val || val <= 0) return;
    const date = $("#stepsDate").value || getTodayStr();
    closeModal("stepsModal");
    if (editingEntryId) {
      updateStepsEntry(editingEntryId, val, date);
      editingEntryId = null;
    } else {
      addStepsEntry(val, date);
    }
  });

  $("#saveWorkoutBtn").addEventListener("click", () => {
    const type = $("#workoutType").value;
    const minutes = parseInt($("#workoutMinutes").value, 10);
    if (!minutes || minutes <= 0) return;
    const caloriesRaw = parseInt($("#workoutCalories").value, 10);
    const calories = caloriesRaw > 0 ? caloriesRaw : null;
    const date = $("#workoutDate").value || getTodayStr();
    closeModal("workoutModal");
    if (editingEntryId) {
      updateWorkoutEntry(editingEntryId, type, minutes, calories, date);
      editingEntryId = null;
    } else {
      addWorkoutEntry(type, minutes, calories, date);
    }
  });

  document.querySelectorAll(".modal-backdrop").forEach((mb) => {
    mb.addEventListener("click", (e) => { if (e.target === mb) { mb.hidden = true; editingEntryId = null; } });
  });

  $("#historyList").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".hi-edit");
    const delBtn = e.target.closest(".hi-delete");
    if (editBtn) {
      const entry = activities[currentUser.login] && activities[currentUser.login][editBtn.dataset.id];
      if (entry) openEditModalForEntry(entry);
      return;
    }
    if (delBtn) deleteEntry(delBtn.dataset.id);
  });

  $("#feedList").addEventListener("click", (e) => {
    const reactBtn = e.target.closest(".reaction-btn");
    if (reactBtn) { toggleReaction(reactBtn.dataset.item, reactBtn.dataset.emoji); return; }

    const commentDel = e.target.closest(".feed-comment-del");
    if (commentDel) { deleteComment(commentDel.dataset.item, commentDel.dataset.cid); return; }

    const btn = e.target.closest(".feed-comment-btn");
    if (btn) addCommentFromItem(btn.closest(".feed-item"));
  });
  $("#feedList").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("feed-comment-input")) {
      e.preventDefault();
      addCommentFromItem(e.target.closest(".feed-item"));
    }
  });

  wireSegmented("#metricSegmented", "metric", (val) => { chartMetric = val; renderWeekChart(); });
  wireSegmented("#periodSegmented", "period", (val) => { chartPeriod = val; renderWeekChart(); });
  wireSegmented("#teamMetricSegmented", "metric", (val) => { teamChartMetric = val; renderTeam(); });
  wireSegmented("#teamPeriodSegmented", "period", (val) => { teamChartPeriod = val; renderTeam(); });

  $("#pointsInfoToggle").addEventListener("click", () => {
    const body = $("#pointsInfoBody");
    const chevron = $("#pointsInfoChevron");
    const willOpen = body.hidden;
    body.hidden = !willOpen;
    chevron.classList.toggle("open", willOpen);
  });
}

function wireSegmented(containerSel, dataAttr, onChange) {
  const container = $(containerSel);
  if (!container) return;
  container.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      onChange(btn.dataset[dataAttr]);
    });
  });
}

async function init() {
  await loadUsersData();
  initStorage();
  wireEvents();

  const hint = $("#loginHint");
  if (hint) {
    hint.textContent = useCloud
      ? "Первый вход — придумайте пароль (от 6 символов), дальше входите с ним же."
      : "⚠️ Firebase не настроен — вход без пароля, только на этом устройстве (демо-режим).";
  }

  if (useCloud && typeof firebase !== "undefined" && firebase.auth) {
    // Firebase persists its own session — restore it automatically if present.
    firebase.auth().onAuthStateChanged((fbUser) => {
      if (fbUser && fbUser.email && !currentUser) {
        const login = fbUser.email.split("@")[0];
        const u = USERS.find((x) => x.login === login);
        if (u) { currentUser = u; showApp(); }
      }
    });
    $("#loginScreen").hidden = false;
    return;
  }

  // Local demo mode: no Firebase, fall back to remembering the last login on this device.
  const savedLogin = localStorage.getItem("tc_session");
  if (savedLogin) {
    const u = USERS.find((x) => x.login === savedLogin);
    if (u) { currentUser = u; showApp(); return; }
  }
  $("#loginScreen").hidden = false;
}

document.addEventListener("DOMContentLoaded", init);
