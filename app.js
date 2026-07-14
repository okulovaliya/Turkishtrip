/* ===========================================================
   Squad Challenge — mobile fitness prep app for friend groups,
   multi-team, multi-goal (not tied to any one trip or vacation)
   =========================================================== */

/* ---------- FIREBASE DATA MODEL (multi-team, phase 2) ---------------------
   All team-owned data lives under teams/{teamId}/... — each team's data is
   fully isolated under its own node.

   teams/{teamId}/
     meta/
       name         — display name of the team/challenge
       destination  — freeform text shown as "До {destination}" on Home
       tripDate     — ISO date string, this team's trip/goal date
       status       — "active" (default/missing) | "completed" — flips to
                       "completed" automatically once the trip date is in
                       the past (see checkGoalClosure/closeActiveGoal)
       closedAt     — ms timestamp of closure, cleared when a new goal starts
       inviteCode   — short code other people use to join this team
       createdAt    — ms timestamp this *cycle* started (reset when a new
                       goal begins, not just when the team was first created)
       migrated     — true once the one-time migration from the old flat
                       root paths has run (see migrateLegacyDataIfNeeded) —
                       brand-new teams are just created with this already true
     members/{login}/
       role         — "owner" | "member" — only "owner" can start a new goal
       joinedAt     — ms timestamp
     history/{cycleId}   — frozen snapshot written once per closed goal:
       name, destination, tripDate, startedAt, closedAt,
       summary/{login} — { name, totalSteps, totalWorkouts, totalWorkoutMinutes,
                          points, bestStreak, maxDaySteps, entryCount } at the
                          moment the goal closed (all-time totals — activities
                          themselves are never reset/archived). Same shape is
                          used by users/{uid}/completedGoals — see below.
     activities/{login}/{entryId}   — unchanged shape from before, except:
       if the account belongs to more than one team, every entry is also
       written as a full independent copy into every OTHER team's own
       activities/{theirLogin}/{entryId} — same id everywhere, so a later
       edit/delete can find and update every copy (see CROSS-TEAM ACTIVITY
       SYNC below / mirrorEntryToOtherTeams / removeEntryFromOtherTeams).
       Each team still just sums whatever is in its own activities node,
       so a mirrored entry counts toward that team's goal exactly like one
       logged there directly — nothing else needed to change.
     comments/{activityId}/{commentId}
     reactions/{activityId}/{emoji}/{login}: ms timestamp (was a bare `true`
       before the notifications bell — every reader only checks truthiness
       or Object.keys(), so this was a safe change)
     profiles/{login}                — name/avatar/dailyGoal overrides
     notifSeen/{login}: ms timestamp — when this person last opened the
       notifications bell in *this* team; a teammate's comment/reaction on
       their own activity, or a teammate logging new activity at all, newer
       than this lights up the yellow dot (see
       hasUnreadNotifications/markNotificationsSeen)

   Global (not team-scoped) — added this phase for real registration:
     users/{uid}/memberships/{teamId}: { login }
       — which teams a Firebase Auth account belongs to (can be more than
         one — see joinAnotherTeam/switchToTeam/leaveTeam), and what its
         per-team "login" key is in each one. `login` only needs to be
         unique *within* a team (see slugifyName/uniqueLoginForTeam), so
         nothing about the existing per-team code needed to change.
     users/{uid}/lastActiveTeamId: teamId
       — which of (possibly several) memberships to open by default; kept
         up to date by activateTeam every time a team is entered/switched to.
     users/{uid}/completedGoals/{cycleId}
       — this account's own permanent copy of every goal it's seen close,
         regardless of which team it happened in or whether this account is
         still a member of that team. Same shape as a teams/{teamId}/history
         entry, plus teamId + myLogin. Populated by
         archiveTeamHistoryToPersonalRecord (kept live while a member) and
         leaveTeam (one last catch-up pass on the way out). "Завершённые
         цели" in Profile renders from this, not from the active team's
         history, so it doesn't change when switching teams. Only covers
         teams no longer actively joined (or whose goal already closed) —
         for teams still actively joined, computeLifetimeStats reads live
         totals instead (see otherTeamsLiveStats/refreshOtherTeamsLiveStats),
         since there's no snapshot yet for an ongoing membership.
     inviteCodes/{code}: teamId
       — short-code lookup used by the "join a team" screen.
     users/{uid}/profile — { name, avatar, avatarGradient, dailyGoal }
       — mirror of whatever this account last saved in ANY team's profiles/
         node (see saveProfile). Used as a seed for teams/{teamId}/profiles/
         {login} when creating/joining a *new* team (see seedTeamProfile),
         so a returning person doesn't start a fresh team with a blank
         name/avatar. If this is still empty/incomplete (e.g. saveProfile
         was never called since this mirror was introduced), seedTeamProfile
         falls back to whatever's currently on screen instead (see
         currentUserFallbackProfile) and backfillAccountProfileUpdates fills
         this node in at the same time, so the gap only ever needs papering
         over once per account.
     recipes/{recipeId} — { name, category, ingredients, calories, protein,
       fat, carbs, comment, authorUid, authorName, createdAt, noMacros }
       — a single shared "cookbook" for the whole app, deliberately NOT
         nested under teams/{teamId}/... — same list regardless of which
         team is active, survives switching/leaving teams entirely (see
         subscribeToRecipes). Keyed by authorUid (the Firebase Auth uid, not
         a per-team login, since logins aren't globally unique) so "Мои
         рецепты" and the edit/delete gate work the same no matter which
         team the author happens to be in when they wrote it. noMacros:
         true means calories/protein/fat/carbs are null (the "Без КБЖУ"
         checkbox was ticked — skips macro validation and rendering).

   `activeTeamId` is now a runtime variable (not a constant): it's set once
   login resolves which team the signed-in person belongs to (see
   resolveActiveTeam), or once they create/join/switch to one.
   --------------------------------------------------------------------- */
let activeTeamId = "turkey-2026"; // default until login resolves the real one
function teamPath(subpath) { return `teams/${activeTeamId}/${subpath}`; }

// ---------- CONFIG ----------
const TRIP_DATE = new Date('2026-08-28T00:00:00');
let activeTripDate = TRIP_DATE; // overwritten from teams/{activeTeamId}/meta/tripDate once known
const DAILY_STEP_GOAL = 8000;
// WHO guideline: 150 min/week of moderate activity, or 75 min/week of vigorous activity,
// or an equivalent combination (vigorous minutes count double toward this target).
const WEEKLY_ACTIVITY_GOAL_MIN = 150;

// Fallback copy of users.json in case fetch fails (e.g. opened via file://)
// No passwords are stored anywhere — Firebase Authentication owns those.
// Vivid colors for the "Команда" trend chart lines — kept separate from each
// person's `color` field (used elsewhere for avatars/etc.) so this chart reads
// clearly. Assigned by *position* in the team roster (not by name), so it
// works for any number/composition of members, not just the original three.
const TEAM_CHART_PALETTE = ["#FF9F40", "#4EA8FF", "#FFD54F", "#B7E14D", "#FF6B9D", "#8B7FFF", "#4EE0C4", "#FF7A59"];
function teamColorFor(login) {
  const idx = USERS.findIndex((u) => u.login === login);
  return TEAM_CHART_PALETTE[(idx >= 0 ? idx : 0) % TEAM_CHART_PALETTE.length];
}

const FALLBACK_USERS = [
  { login: "tanya",  email: "tanya@turkeytrip.app",  name: "Танюшка",     avatar: "face3", color: "#FF7A59", avatarGradient: "sunset" },
  { login: "lilu",   email: "lilu@turkeytrip.app",   name: "Лилу",        avatar: "face2", color: "#2FD9C4", avatarGradient: "mint" },
  { login: "nastya", email: "nastya@turkeytrip.app", name: "Анастасися",  avatar: "face4", color: "#FFC93C", avatarGradient: "gold" }
];

// Avatar keys -> custom PNG sticker (stored in /avatars). Replaces the earlier emoji/SVG-icon avatars.
const AVATAR_ICON_KEYS = ["face1", "face2", "face3", "face4", "face5", "face6", "face7", "face8", "face9", "face10", "face11", "face12"];
function avatarSrc(key) {
  const safe = AVATAR_ICON_KEYS.includes(key) ? key : "face1";
  return `avatars/${safe}.png`;
}

// Selectable avatar background gradients (key -> CSS var defined in style.css)
const AVATAR_GRADIENTS = {
  sunset: "var(--grad-sunset)",
  gold:   "var(--grad-gold)",
  ocean:  "var(--grad-ocean)",
  citrus: "var(--grad-citrus)",
  berry:  "var(--grad-berry)",
  coral:  "var(--grad-coral)",
  mint:   "var(--grad-mint)",
  dusk:   "var(--grad-dusk)",
};
const DEFAULT_AVATAR_GRADIENT = "sunset";
function gradCss(key) {
  return AVATAR_GRADIENTS[key] || AVATAR_GRADIENTS[DEFAULT_AVATAR_GRADIENT];
}

const MOTIVATION_STEPS = [
  "Ещё немного — и сегодняшняя цель ваша! 💪",
  "Каждый шаг приближает вас к результату 👣",
  "Отличный темп, продолжайте! 🚶",
  "Так держать — прогресс уже заметен 😄",
  "Сегодня вы двигаетесь в правильную сторону",
  "Хороший шаг вперёд! 🎯",
  "Дисциплина в действии! 🔥",
  "Прогресс не купишь, зато можно нашагать!"
];

const MOTIVATION_WORKOUT = [
  "Тело говорит спасибо за эту тренировку! 🙌",
  "Ещё одна тренировка — ещё одна причина гордиться собой 💥",
  "Отличная работа над собой ☀️",
  "Каждая тренировка приближает к цели 🎯",
  "Вы сильнее, чем вчера!",
  "Дисциплина строит результат 🏋️",
  "Отличная работа! Заслужили передышку (по желанию 😉)"
];

// Gender-neutral (uses "вы") and not tied to any specific trip/destination —
// the same phrases work for any team's goal, whatever it is.
const MOTIVATION_DAILY = [
  { emoji: "🎯", text: "До цели на один день меньше" },
  { emoji: "✅", text: "Каждый день челленджа имеет значение" },
  { emoji: "💪", text: "Сегодня вы стали сильнее, чем вчера" },
  { emoji: "🔥", text: "Лень сегодня проиграла" },
  { emoji: "🔥", text: "Серия продолжается. Не останавливайтесь" },
  { emoji: "✔️", text: "Еще одна галочка в копилку дисциплины" },
  { emoji: "👣", text: "Каждый шаг приближает к результату" },
  { emoji: "🙏", text: "Ваше будущее «спасибо себе» уже в пути" },
  { emoji: "⏳", text: "Осталось совсем немного" },
  { emoji: "🎯", text: "Цель становится ближе" },
  { emoji: "👍", text: "Сегодня вы сделали правильный выбор" },
  { emoji: "💯", text: "Еще один день без оправданий" },
  { emoji: "🧠", text: "Организм начинает понимать, что происходит" },
  { emoji: "📈", text: "Прогресс любит постоянство" },
  { emoji: "🔁", text: "Главное — не скорость, а регулярность" },
  { emoji: "💪", text: "Каждая тренировка окупится результатом" },
  { emoji: "🏆", text: "Сегодня вы победили себя" },
  { emoji: "📊", text: "Каждый день складывается в результат" },
  { emoji: "🌅", text: "Ещё один день позади — и это плюс" },
  { emoji: "⚡", text: "Сегодня — плюс к энергии" },
  { emoji: "🌤️", text: "Завтра будет легче" },
  { emoji: "✨", text: "Каждое усилие имеет смысл" },
  { emoji: "🌱", text: "Все начинается с одного дня" },
  { emoji: "🔁", text: "И продолжается следующим" },
  { emoji: "🎯", text: "Вы уже в игре" },
  { emoji: "⛓️", text: "Не разрывайте серию" },
  { emoji: "🔒", text: "Ваш прогресс невозможно отменить" },
  { emoji: "🧭", text: "Дисциплина работает лучше мотивации" },
  { emoji: "🌟", text: "Сегодня отличный день стать лучше" },
  { emoji: "🙌", text: "Вы уже сделали больше, чем многие" },
  { emoji: "👏", text: "Продолжайте в том же духе" },
  { emoji: "⏰", text: "Ещё один день — ещё один шаг к цели" },
  { emoji: "🗺️", text: "Еще один день пройден" },
  { emoji: "💫", text: "Сегодняшние усилия станут завтрашней уверенностью" },
  { emoji: "🎯", text: "Каждая отметка приближает цель" },
  { emoji: "🏃", text: "Сегодня вы выбрали движение" },
  { emoji: "🏆", text: "И это уже победа" },
  { emoji: "🏅", text: "Каждый день — маленькая победа" },
  { emoji: "💪", text: "Ваше тело замечает каждую тренировку" },
  { emoji: "⏳", text: "Результат любит терпеливых" },
  { emoji: "💎", text: "Сегодня вы инвестировали в себя" },
  { emoji: "😊", text: "Завтра вы будете рады, что не пропустили" },
  { emoji: "👣", text: "Маленькие шаги приводят далеко" },
  { emoji: "✨", text: "Серия становится все красивее" },
  { emoji: "👏", text: "Отличная работа!" },
  { emoji: "🙌", text: "Вы молодцы" },
  { emoji: "🏁", text: "Не сдавайтесь за шаг до цели" },
  { emoji: "✅", text: "Сегодня было не зря" },
  { emoji: "🧭", text: "Продолжайте — вы на верном пути" },
  { emoji: "😌", text: "Еще одна причина собой гордиться" },
  { emoji: "🔗", text: "Каждый день укрепляет привычку" },
  { emoji: "🌟", text: "Это уже становится образом жизни" },
  { emoji: "⏳", text: "Осталось меньше, чем кажется" },
  { emoji: "▶️", text: "Не останавливайтесь сейчас" },
  { emoji: "💛", text: "Сегодня вы выбрали себя" },
  { emoji: "👍", text: "И это правильный выбор" },
  { emoji: "💪", text: "Каждая тренировка имеет значение" },
  { emoji: "➕", text: "Еще один день — еще один плюс" },
  { emoji: "👏", text: "Так держать!" },
  { emoji: "🏃", text: "Отличный темп" },
  { emoji: "💪", text: "Вы справляетесь" },
  { emoji: "▶️", text: "Главное — не останавливаться" },
  { emoji: "🙌", text: "Все получится" },
  { emoji: "👣", text: "Сегодня вы сделали шаг вперед" },
  { emoji: "➡️", text: "Даже маленький шаг — это движение" },
  { emoji: "🔥", text: "Серия впечатляет" },
  { emoji: "💪", text: "Каждый день делает вас сильнее" },
  { emoji: "⏳", text: "Осталось совсем чуть-чуть" },
  { emoji: "🏆", text: "Сегодня — еще одна победа" },
  { emoji: "🔁", text: "Завтра продолжим" },
  { emoji: "🎯", text: "Вы ближе к цели, чем вчера" },
  { emoji: "🌿", text: "Хороший день для хороших привычек" },
  { emoji: "🏅", text: "Продолжайте собирать победы" },
  { emoji: "✨", text: "Ваша лучшая версия уже совсем рядом" },
  { emoji: "🎉", text: "До завершения цели все ближе!" }
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
let pendingAuth = null; // { uid, email, displayName } while waiting on the create/join-team screen
let authMode = "login"; // "login" | "register" — which tab is active on the login screen
let tripModalMode = "edit"; // "edit" | "new" — which flow opened editTripModal (see wireEvents)
let teamGateMode = "login"; // "login" | "addTeam" — whether #teamGateBackBtn should log out or just return to the app
let activeTeamMeta = {}; // { name, destination, tripDate, status, inviteCode, ... } for the active team
let teamHistory = {}; // cycleId -> frozen summary of a closed goal, for the CURRENTLY ACTIVE team only
let personalGoals = {}; // cycleId -> same shape, but this account's own copy across every team it's ever been in (see archiveTeamHistoryToPersonalRecord) — this is what "Завершённые цели" in Profile actually renders from, so it survives leaving/switching teams
let closingGoal = false; // guards against double-writing a history entry from the same client
let activities = {}; // login -> { entryId: {id, date, type, steps?, workoutType?, workoutMinutes?, points, ts} }
let comments = {}; // activityId -> { commentId: {login, name, text, ts} }
let reactions = {}; // activityId -> { emoji: { login: true } }
let profiles = {}; // login -> { name?, avatar?, dailyGoal? } — user-editable overrides
let weekChartInstance = null;
let teamChartInstance = null;
let toastTimer = null;
let editingEntryId = null;
let currentTab = "home";
let currentTheme = "dark"; // "dark" | "light" — device display preference, not account data (see applyTheme)
let useCloud = false;
let db = null;
let chartMetric = "workouts"; // home chart: steps already shown by the ring above, so default to workouts
let chartPeriod = "day";
let teamChartMetric = "steps";
let teamChartPeriod = "day";
let notifSeenAt = 0; // ms timestamp — comments/reactions on my own activity older than this don't light up the bell
let notifSeenListenerLogin = null; // which login's notifSeen node is currently listened to, for detachTeamListeners
let otherTeamsLiveStats = {}; // teamId -> summarizeActivityEntries() result, for every OTHER team this account is still an active member of (see refreshOtherTeamsLiveStats) — feeds computeLifetimeStats/computeAchievements so they don't drop back to zero just because a different team happens to be open right now
let recipes = {}; // recipeId -> recipe — GLOBAL, not team-scoped (see subscribeToRecipes); same for every team/account
let recipeSearchQuery = "";
let recipeCategoryFilter = "all"; // "all" | "breakfast" | "lunch" | "dinner" — Журнал tab filter
let recipeMineOnly = false; // "Мои рецепты" chip on the journal
let recipeFormCategory = "breakfast"; // selected category inside the create/edit form
let editingRecipeId = null; // set while the form modal is editing an existing recipe, null while creating a new one
let viewingRecipeId = null; // which recipe the detail modal is currently showing

// ---------- UTIL ----------
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, "0");
// Standard Russian plural-form picker (1 ингредиент / 2 ингредиента / 5 ингредиентов).
function pluralRu(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

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
  const trip = startOfDay(activeTripDate);
  return Math.ceil((trip - today) / 86400000);
}
function pointsForSteps(steps) { return Math.round(steps / 100); }
// Points per minute by workout type, roughly proportional to intensity (MET).
const WORKOUT_POINT_RATES = {
  "Кардио": 3,
  "Плавание": 3,
  "Велосипед": 3,
  "Силовая": 2.5,
  "Танцы": 2,
  "Прогулка": 1.5,
  "Йога": 1.5
};
function pointsForWorkout(min, type) {
  const rate = WORKOUT_POINT_RATES[type] ?? 2;
  return Math.round(min * rate);
}

// Classifies each workout type as WHO-style "moderate" or "vigorous" intensity,
// used to turn logged minutes into WHO-equivalent weekly activity minutes.
const WORKOUT_INTENSITY = {
  "Кардио": "vigorous",
  "Плавание": "vigorous",
  "Велосипед": "vigorous",
  "Силовая": "moderate",
  "Танцы": "moderate",
  "Прогулка": "moderate",
  "Йога": "moderate"
};
// Monday of the week containing d (WHO's 150/75-min targets are weekly).
function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 = Sunday .. 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}
// Sums this week's (Mon -> today) workout minutes into WHO-equivalent moderate minutes:
// vigorous-intensity minutes count double, matching the WHO "150 moderate OR 75 vigorous
// OR an equivalent combination" guideline.
function weeklyActivityMinutes(login) {
  const agg = dailyAggregates(login);
  const monday = startOfWeek(new Date());
  const today = startOfDay(new Date());
  let total = 0;
  for (let d = new Date(monday); d <= today; d.setDate(d.getDate() + 1)) {
    const day = agg[formatDate(d)];
    if (!day || !day.workouts) continue;
    day.workouts.forEach((w) => {
      const intensity = WORKOUT_INTENSITY[w.type] || "moderate";
      total += intensity === "vigorous" ? w.minutes * 2 : w.minutes;
    });
  }
  return total;
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

// One-time migration: moves data that was previously stored at the old flat
// root paths (activities/, comments/, reactions/, profiles/) into
// teams/turkey-2026/... (the original team), and makes sure its meta/
// members nodes exist. Safe to call for any team — it checks meta/migrated
// first and does nothing once that's set (brand-new teams are created with
// it already true). Runs before the live listeners in subscribeToActiveTeam()
// attach, so nobody reads a half-migrated team node.
async function migrateLegacyDataIfNeeded() {
  const migratedSnap = await db.ref(teamPath("meta/migrated")).once("value");
  if (migratedSnap.val()) {
    await backfillLegacyTeamFields();
    return;
  }

  const [actSnap, comSnap, reactSnap, profSnap] = await Promise.all([
    db.ref("activities").once("value"),
    db.ref("comments").once("value"),
    db.ref("reactions").once("value"),
    db.ref("profiles").once("value")
  ]);

  const updates = {};
  if (actSnap.exists()) updates[teamPath("activities")] = actSnap.val();
  if (comSnap.exists()) updates[teamPath("comments")] = comSnap.val();
  if (reactSnap.exists()) updates[teamPath("reactions")] = reactSnap.val();
  if (profSnap.exists()) updates[teamPath("profiles")] = profSnap.val();

  const inviteCode = randomCode(6);
  updates[teamPath("meta/name")] = "Turkey Challenge";
  updates[teamPath("meta/destination")] = "Турции";
  updates[teamPath("meta/tripDate")] = TRIP_DATE.toISOString();
  updates[teamPath("meta/status")] = "active";
  updates[teamPath("meta/inviteCode")] = inviteCode;
  updates[teamPath("meta/createdAt")] = Date.now();
  updates[teamPath("meta/migrated")] = true;
  updates[`inviteCodes/${inviteCode}`] = "turkey-2026";
  // lilu is the designated team owner (only she can edit the trip/start a new
  // goal); the other original members carry over as regular team members.
  USERS.forEach((u) => {
    updates[teamPath(`members/${u.login}`)] = { role: u.login === "lilu" ? "owner" : "member", joinedAt: Date.now() };
  });

  await db.ref().update(updates);
}

// Covers a team whose meta/migrated was already set to true by an earlier
// version of migrateLegacyDataIfNeeded — one that ran before destination/
// status/inviteCode/member-roles existed as concepts, so it left that team
// meta half-filled (e.g. just name/tripDate/createdAt/migrated, nothing
// else). Safe to call every time: only fills in fields that are still
// missing, never touches anything already set, so it can't clobber a
// destination or role someone has since changed by hand.
async function backfillLegacyTeamFields() {
  const [metaSnap, membersSnap] = await Promise.all([
    db.ref(teamPath("meta")).once("value"),
    db.ref(teamPath("members")).once("value")
  ]);
  const meta = metaSnap.val() || {};
  const members = membersSnap.val() || {};
  const updates = {};

  if (!meta.status) updates[teamPath("meta/status")] = "active";
  if (!meta.destination) updates[teamPath("meta/destination")] = "Турции";
  if (!meta.inviteCode) {
    const inviteCode = randomCode(6);
    updates[teamPath("meta/inviteCode")] = inviteCode;
    updates[`inviteCodes/${inviteCode}`] = activeTeamId;
  }
  // lilu is the designated owner from the original 3; anyone else without a
  // role yet (shouldn't normally happen for this team) becomes a member.
  Object.entries(members).forEach(([login, m]) => {
    if (m && m.role) return;
    updates[teamPath(`members/${login}/role`)] = login === "lilu" ? "owner" : "member";
  });

  if (Object.keys(updates).length) await db.ref().update(updates);
}

// ---------- TEAMS: create / join / resolve ----------
function randomCode(len) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — avoids mix-ups when typed by hand
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const CYRILLIC_TO_LATIN = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya"
};
// Turns a chosen display name into a short, key-safe "login" — this only
// needs to be unique *within one team* (that's the only scope it's used at:
// teams/{teamId}/members/{login}, .../activities/{login}/...), so a simple
// transliterated slug plus a numeric suffix on collision is enough.
function slugifyName(name) {
  const lower = String(name || "").trim().toLowerCase();
  const translit = lower.split("").map((ch) => (ch in CYRILLIC_TO_LATIN ? CYRILLIC_TO_LATIN[ch] : ch)).join("");
  const slug = translit.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "friend";
}
async function uniqueLoginForTeam(teamId, name) {
  const base = slugifyName(name);
  const snap = await db.ref(`teams/${teamId}/members`).once("value");
  const existing = snap.val() || {};
  if (!existing[base]) return base;
  let i = 2;
  while (existing[`${base}-${i}`]) i += 1;
  return `${base}-${i}`;
}

// Builds the initial profiles/{login} value for a person joining/creating a
// team: starts from whatever they've already saved at the account level
// (users/{uid}/profile — avatar, gradient, daily goal, name), so a returning
// person's next team doesn't start them off blank, but still lets the name
// typed/carried into *this* join/create action win if there's one to use.
// fallbackProfile is whatever profile they're CURRENTLY showing (their old
// team's own profiles/{login}, via currentUser at the call site) — used to
// fill in avatar/gradient/dailyGoal when users/{uid}/profile is still empty
// or incomplete, which happens for anyone who joined a second team before
// ever explicitly re-saving their profile through "Изменить профиль" after
// that account-level mirror was introduced. Without this fallback their
// avatar/gradient would silently reset to the app default in the new team.
function seedTeamProfile(accountProfile, displayName, fallbackProfile) {
  const merged = { ...(fallbackProfile || {}), ...(accountProfile || {}) };
  const name = displayName || merged.name || "Без имени";
  return Object.keys(merged).length ? { ...merged, name } : { name };
}

// Whatever profile is on screen right now (the team someone's switching
// AWAY from, if any) — the fallback source seedTeamProfile falls back to
// when users/{uid}/profile is still empty/incomplete. null for a genuinely
// first-ever team, where there's nothing to inherit anyway.
function currentUserFallbackProfile() {
  if (!currentUser) return null;
  return { name: currentUser.name, avatar: currentUser.avatar, avatarGradient: currentUser.avatarGradient, dailyGoal: currentUser.dailyGoal };
}

// If users/{uid}/profile was missing avatar/gradient/dailyGoal (the gap
// seedTeamProfile's fallback just papered over), backfill it from what we
// just seeded so the NEXT team join doesn't need the fallback again. Only
// fills in what's missing — never overwrites anything already saved there.
function backfillAccountProfileUpdates(uid, accountProfile, seededProfile) {
  if (accountProfile && accountProfile.avatar) return {};
  const updates = {};
  updates[`users/${uid}/profile`] = {
    ...(accountProfile || {}),
    avatar: seededProfile.avatar,
    avatarGradient: seededProfile.avatarGradient,
    dailyGoal: seededProfile.dailyGoal
  };
  return updates;
}

// Creates a brand-new team, makes uid its first member/owner, and returns
// { teamId, login }. tripDateStr is a plain "YYYY-MM-DD" from a date input.
async function createTeam(uid, teamName, tripDateStr, displayName, destination) {
  const teamId = `${slugifyName(teamName)}-${randomCode(4).toLowerCase()}`;
  const login = await uniqueLoginForTeam(teamId, displayName);
  const inviteCode = randomCode(6);
  const accountProfile = (await db.ref(`users/${uid}/profile`).once("value")).val();
  const seededProfile = seedTeamProfile(accountProfile, displayName, currentUserFallbackProfile());
  const updates = { ...backfillAccountProfileUpdates(uid, accountProfile, seededProfile) };
  updates[`teams/${teamId}/meta`] = {
    name: teamName,
    destination: destination || "цели",
    tripDate: tripDateStr,
    status: "active",
    inviteCode,
    createdAt: Date.now(),
    migrated: true // brand-new team — nothing legacy to migrate
  };
  updates[`teams/${teamId}/members/${login}`] = { role: "owner", joinedAt: Date.now() };
  updates[`teams/${teamId}/profiles/${login}`] = seededProfile;
  updates[`inviteCodes/${inviteCode}`] = teamId;
  updates[`users/${uid}/memberships/${teamId}`] = { login };
  await db.ref().update(updates);
  return { teamId, login };
}

// Joins an existing team via its invite code. Returns { teamId, login }, or
// { error } if the code doesn't resolve to a team.
async function joinTeamByCode(uid, codeRaw, displayName) {
  const code = codeRaw.trim().toUpperCase();
  const teamIdSnap = await db.ref(`inviteCodes/${code}`).once("value");
  const teamId = teamIdSnap.val();
  if (!teamId) return { error: "Такой код не найден. Проверьте и попробуйте ещё раз." };
  const login = await uniqueLoginForTeam(teamId, displayName);
  const accountProfile = (await db.ref(`users/${uid}/profile`).once("value")).val();
  const seededProfile = seedTeamProfile(accountProfile, displayName, currentUserFallbackProfile());
  const updates = { ...backfillAccountProfileUpdates(uid, accountProfile, seededProfile) };
  updates[`teams/${teamId}/members/${login}`] = { role: "member", joinedAt: Date.now() };
  updates[`teams/${teamId}/profiles/${login}`] = seededProfile;
  updates[`users/${uid}/memberships/${teamId}`] = { login };
  await db.ref().update(updates);
  return { teamId, login };
}

// If this Firebase Auth email matches one of the original 3 friends the app
// launched with, link this uid to the legacy team automatically — no
// signup/create-team flow needed for the people it already worked for.
// Runs the phase-1 migration first (it's a no-op once already done) so this
// works correctly even on the very first login after deploying this update,
// before teams/turkey-2026/members has ever been populated.
async function linkLegacyAccountIfMatches(uid, email) {
  const legacy = FALLBACK_USERS.find((u) => u.email && u.email.toLowerCase() === String(email || "").toLowerCase());
  if (!legacy) return null;
  const teamId = "turkey-2026";
  const savedActiveTeamId = activeTeamId;
  activeTeamId = teamId; // teamPath() inside the migration must resolve to the legacy team
  await migrateLegacyDataIfNeeded();
  activeTeamId = savedActiveTeamId;
  const memberSnap = await db.ref(`teams/${teamId}/members/${legacy.login}`).once("value");
  if (!memberSnap.exists()) return null;
  await db.ref(`users/${uid}/memberships/${teamId}`).set({ login: legacy.login });
  return { teamId, login: legacy.login };
}

// Figures out which team a signed-in uid should land in. A person can now
// belong to more than one team (see joinAnotherTeam flow) — which one comes
// up is whichever teamId is saved at users/{uid}/lastActiveTeamId (kept in
// sync by activateTeam every time a team is entered/switched to). Falls back
// to "first membership found" if that field is missing or points at a team
// they're no longer in. Returns null if they have no team yet at all (brand
// new person who hasn't created or joined one).
async function resolveActiveTeam(uid, email) {
  const snap = await db.ref(`users/${uid}/memberships`).once("value");
  let memberships = snap.val() || {};
  if (Object.keys(memberships).length === 0) {
    const linked = await linkLegacyAccountIfMatches(uid, email);
    if (linked) memberships = { [linked.teamId]: { login: linked.login } };
  }
  const teamIds = Object.keys(memberships);
  if (teamIds.length === 0) return null;
  const lastSnap = await db.ref(`users/${uid}/lastActiveTeamId`).once("value");
  const last = lastSnap.val();
  const teamId = (last && memberships[last]) ? last : teamIds[0];
  return { teamId, login: memberships[teamId].login };
}

// Loads the member roster for a team into USERS. The original 3 keep their
// existing cosmetics (color/avatar/gradient defaults) from FALLBACK_USERS;
// brand-new members get sensible defaults, editable any time in Профиль.
// Real per-team display names come from profiles/{login}.name via the
// existing applyProfileOverrides(), same as before.
async function loadTeamMembers(teamId) {
  const snap = await db.ref(`teams/${teamId}/members`).once("value");
  const members = snap.val() || {};
  const logins = Object.keys(members);
  USERS = logins.map((login, i) => {
    const role = (members[login] && members[login].role) || "member";
    const legacy = FALLBACK_USERS.find((u) => u.login === login);
    if (legacy) return { ...legacy, role };
    return {
      login,
      email: null,
      name: login,
      avatar: "face1",
      color: TEAM_CHART_PALETTE[i % TEAM_CHART_PALETTE.length],
      avatarGradient: DEFAULT_AVATAR_GRADIENT,
      role
    };
  });
}

// Cloud (Firebase) sync with automatic fallback to local-only storage
// if firebase-config.js hasn't been filled in yet.
// Sets up the Firebase app connection itself — no team-specific reads here,
// since which team to read isn't known until login resolves it (see
// enterTeam/activateTeam). In local (non-cloud) demo mode there's only ever
// the one legacy team, so it's safe to load that right away.
function initFirebaseApp() {
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

  if (!useCloud) {
    applyProfileOverrides(); // make sure every user has a dailyGoal right away
    loadLocalFallback();
  }
}

// Attaches the live listeners for the now-known activeTeamId, and pulls in
// that team's trip date. Called once per login/team-switch — see
// activateTeam — never at boot.
async function subscribeToActiveTeam() {
  await migrateLegacyDataIfNeeded(); // no-op for any team except the original one
  applyProfileOverrides();

  db.ref(teamPath("activities")).on("value", (snap) => {
    activities = snap.val() || {};
    ensureUserBuckets();
    rerenderCurrentTab();
  });
  db.ref(teamPath("comments")).on("value", (snap) => {
    comments = snap.val() || {};
    rerenderCurrentTab();
  });
  db.ref(teamPath("reactions")).on("value", (snap) => {
    reactions = snap.val() || {};
    rerenderCurrentTab();
  });
  db.ref(teamPath("profiles")).on("value", (snap) => {
    profiles = snap.val() || {};
    applyProfileOverrides();
    rerenderCurrentTab();
  });
  // Keeps USERS live as people join/leave the team — without this, a
  // teammate who joins later wouldn't show up for anyone already in the app
  // until they reloaded.
  db.ref(teamPath("members")).on("value", () => {
    loadTeamMembers(activeTeamId).then(() => {
      applyProfileOverrides();
      if (currentUser) currentUser = USERS.find((u) => u.login === currentUser.login) || currentUser;
      rerenderCurrentTab();
    });
  });

  db.ref(teamPath("history")).on("value", (snap) => {
    teamHistory = snap.val() || {};
    archiveTeamHistoryToPersonalRecord();
    rerenderCurrentTab();
  });

  // My own "last seen notifications" marker for this team — live-synced so
  // tapping the bell on one device also clears the badge if the same
  // account happens to be open elsewhere.
  notifSeenListenerLogin = currentUser.login;
  db.ref(teamPath(`notifSeen/${currentUser.login}`)).on("value", (snap) => {
    notifSeenAt = snap.val() || 0;
    updateNotifBadge();
  });

  const metaSnap = await db.ref(teamPath("meta")).once("value");
  activeTeamMeta = metaSnap.val() || {};
  activeTripDate = activeTeamMeta.tripDate ? new Date(activeTeamMeta.tripDate) : TRIP_DATE;
  checkGoalClosure();

  db.ref(teamPath("meta")).on("value", (snap) => {
    activeTeamMeta = snap.val() || {};
    activeTripDate = activeTeamMeta.tripDate ? new Date(activeTeamMeta.tripDate) : TRIP_DATE;
    checkGoalClosure();
    rerenderCurrentTab();
  });
}

function ensureUserBuckets() {
  USERS.forEach((u) => {
    if (!activities[u.login]) activities[u.login] = {};
  });
}

// Merges saved name/avatar/dailyGoal overrides onto the in-memory USERS
// objects, so every other render just reads user.name/.avatar/.dailyGoal
// like normal — no extra lookup needed anywhere else in the app.
function applyProfileOverrides() {
  USERS.forEach((u) => {
    const o = profiles[u.login];
    if (o) {
      if (o.name) u.name = o.name;
      if (o.avatar) u.avatar = o.avatar;
      if (o.avatarGradient) u.avatarGradient = o.avatarGradient;
      u.dailyGoal = o.dailyGoal || DAILY_STEP_GOAL;
    } else {
      u.dailyGoal = u.dailyGoal || DAILY_STEP_GOAL;
    }
    u.avatarGradient = u.avatarGradient || DEFAULT_AVATAR_GRADIENT;
  });
}

function loadLocalFallback() {
  try { activities = JSON.parse(localStorage.getItem("tc_activities") || "{}"); } catch (e) { activities = {}; }
  try { comments = JSON.parse(localStorage.getItem("tc_comments") || "{}"); } catch (e) { comments = {}; }
  try { reactions = JSON.parse(localStorage.getItem("tc_reactions") || "{}"); } catch (e) { reactions = {}; }
  try { profiles = JSON.parse(localStorage.getItem("tc_profiles") || "{}"); } catch (e) { profiles = {}; }
  try { activeTeamMeta = JSON.parse(localStorage.getItem("tc_teamMeta") || "{}"); } catch (e) { activeTeamMeta = {}; }
  // Recipes aren't team-scoped even in local demo mode — one shared bucket.
  try { recipes = JSON.parse(localStorage.getItem("tc_recipes") || "{}"); } catch (e) { recipes = {}; }
  if (activeTeamMeta.tripDate) activeTripDate = new Date(activeTeamMeta.tripDate);
  ensureUserBuckets();
  applyProfileOverrides();
}

// Only used in local (non-cloud) fallback mode — cloud writes persist per-call.
function persistLocal() {
  if (useCloud) return;
  localStorage.setItem("tc_activities", JSON.stringify(activities));
  localStorage.setItem("tc_comments", JSON.stringify(comments));
  localStorage.setItem("tc_reactions", JSON.stringify(reactions));
  localStorage.setItem("tc_profiles", JSON.stringify(profiles));
  localStorage.setItem("tc_teamMeta", JSON.stringify(activeTeamMeta));
  localStorage.setItem("tc_recipes", JSON.stringify(recipes));
}

function saveProfile(login, patch) {
  if (!profiles[login]) profiles[login] = {};
  Object.assign(profiles[login], patch);
  applyProfileOverrides();
  if (useCloud) {
    db.ref(teamPath(`profiles/${login}`)).update(patch);
    // Also mirror onto the account itself (users/{uid}/profile), not just
    // this one team's roster — so name/avatar/gradient/daily goal follow the
    // person into whatever team they create or join next, instead of every
    // new team starting them off blank again. Only when editing your own
    // profile (the only case saveProfile is actually called with today).
    if (currentUser && login === currentUser.login && firebase.auth().currentUser) {
      db.ref(`users/${firebase.auth().currentUser.uid}/profile`).update(patch);
    }
  } else {
    persistLocal();
  }
}

// Lets any team member fix a typo'd trip name/date after team creation.
// Updates the in-memory meta immediately for instant UI feedback; in cloud
// mode the live meta listener (see subscribeToActiveTeam) will also receive
// the same values shortly after and re-render, which is harmless/idempotent.
function saveTripMeta(patch) {
  Object.assign(activeTeamMeta, patch);
  if (patch.tripDate) activeTripDate = new Date(patch.tripDate);
  if (useCloud) db.ref(teamPath("meta")).update(patch);
  else persistLocal();
}

function rerenderCurrentTab() {
  if (!currentUser) return;
  updateNotifBadge(); // the bell lives on the home tab, but data can change while viewing any tab
  if (currentTab === "home") renderHome();
  else if (currentTab === "feed") renderFeed();
  else if (currentTab === "team") renderTeam();
  else if (currentTab === "recipes") renderRecipes();
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
      labels.push(`${pad(start.getDate())}.${pad(start.getMonth() + 1)}–${pad(end.getDate())}.${pad(end.getMonth() + 1)}`);
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

// Achievements are lifetime/account-level too (same reasoning as
// computeLifetimeStats, which this is built from) — team_spirit and
// almost_there are the two exceptions, since "300k steps as a team" and
// "days until the trip" are inherently about the currently active team,
// not a personal lifetime figure.
function computeAchievements(login) {
  const lifetime = computeLifetimeStats(login);
  const totals = { totalSteps: lifetime.totalSteps, totalWorkouts: lifetime.totalWorkouts, totalWorkoutMinutes: lifetime.totalWorkoutMinutes, points: lifetime.points, maxDaySteps: lifetime.maxDaySteps, entryCount: lifetime.entryCount };
  const streak = { best: lifetime.bestStreak };
  const teamTotals = computeTeamTotals();
  const daysLeft = computeDaysLeft();
  const ctx = { totals, streak, teamTotals, daysLeft };
  return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: a.check(ctx) }));
}

// Same totals/best-streak math as computeTotals/computeStreak, but takes a
// raw activities-for-one-login object as a plain argument instead of
// reading it off the module-level `activities` cache — needed by leaveTeam,
// which can act on a team that isn't the one currently loaded into that
// cache (see summary at its call site).
function summarizeActivityEntries(entriesObj) {
  const list = Object.values(entriesObj || {});
  let totalSteps = 0, totalWorkouts = 0, totalWorkoutMinutes = 0, points = 0;
  const byDate = {};
  const stepsByDate = {};
  list.forEach((e) => {
    points += e.points || 0;
    if (e.type === "steps") { totalSteps += e.steps; stepsByDate[e.date] = (stepsByDate[e.date] || 0) + e.steps; }
    if (e.type === "workout") { totalWorkouts += 1; totalWorkoutMinutes += e.workoutMinutes; }
    const add = (e.type === "steps" ? e.steps : 0) + (e.type === "workout" ? e.workoutMinutes : 0);
    byDate[e.date] = (byDate[e.date] || 0) + add;
  });
  const maxDaySteps = Object.values(stepsByDate).reduce((m, v) => Math.max(m, v), 0);
  const activeDates = Object.keys(byDate).filter((d) => byDate[d] > 0).sort();
  let best = 0, run = 0, prev = null;
  activeDates.forEach((ds) => {
    const d = new Date(ds + "T00:00:00");
    if (prev && (d - prev) / 86400000 === 1) run += 1; else run = 1;
    if (run > best) best = run;
    prev = d;
  });
  return { totalSteps, totalWorkouts, totalWorkoutMinutes, points, bestStreak: best, entryCount: list.length, maxDaySteps };
}

// ---------- GOAL LIFECYCLE (close current goal → history → start new one) ----------

// All-time per-member snapshot frozen into history when a goal closes.
// Deliberately not scoped to "just this cycle" — activities are never
// reset/tagged per-cycle (that would risk losing data and would break the
// lifetime achievements like "100K клуб"), so this is simply "where everyone
// stood at the moment this goal wrapped up".
function computeGoalSummary() {
  const summary = {};
  USERS.forEach((u) => {
    const totals = computeTotals(u.login);
    const streak = computeStreak(u.login);
    summary[u.login] = {
      name: u.name,
      totalSteps: totals.totalSteps,
      totalWorkouts: totals.totalWorkouts,
      totalWorkoutMinutes: totals.totalWorkoutMinutes,
      points: totals.points,
      bestStreak: streak.best,
      maxDaySteps: totals.maxDaySteps,
      entryCount: totals.entryCount
    };
  });
  return summary;
}

// "Профиль" (and the Награды achievements computed from it — see
// computeAchievements) shows steps/workouts/points/streak as belonging to
// the PERSON, not to whichever team happens to be open right now —
// switching teams, joining an additional one, or having left one must
// never make these drop back to zero. Combines three sources:
//   1. the currently active team's live totals (computeTotals/computeStreak
//      already reflect that team's *entire* history, since activities are
//      never reset — see computeGoalSummary's comment above)
//   2. every OTHER team this account is STILL an active member of, from
//      otherTeamsLiveStats (refreshOtherTeamsLiveStats) — this is what
//      keeps things like streak/awards from looking reset right after
//      joining a second team while the first one is still ongoing
//   3. the latest known snapshot of every team this account HAS LEFT (or
//      whose goal closed), from personalGoals — snapshots are "cumulative
//      total at that moment", not per-cycle deltas, so only the single
//      most recent one per team is used (adding every snapshot for the
//      same team would double-count), and any team already covered by #2
//      is skipped here (its live totals are a superset of any snapshot).
function computeLifetimeStats(login) {
  const live = computeTotals(login);
  const liveStreak = computeStreak(login);
  const stillActiveTeamIds = new Set(Object.keys(otherTeamsLiveStats));

  const latestByTeam = {};
  Object.values(personalGoals || {}).forEach((h) => {
    if (h.teamId === activeTeamId) return; // superseded by the live totals above
    if (stillActiveTeamIds.has(h.teamId)) return; // superseded by otherTeamsLiveStats below
    const s = h.summary && h.summary[h.myLogin];
    if (!s) return;
    const existing = latestByTeam[h.teamId];
    if (!existing || (h.closedAt || 0) > existing.closedAt) {
      latestByTeam[h.teamId] = { ...s, closedAt: h.closedAt || 0 };
    }
  });

  let totalSteps = live.totalSteps;
  let totalWorkouts = live.totalWorkouts;
  let totalWorkoutMinutes = live.totalWorkoutMinutes;
  let points = live.points;
  let bestStreak = liveStreak.best;
  let maxDaySteps = live.maxDaySteps;
  let entryCount = live.entryCount;

  const addSource = (s) => {
    totalSteps += s.totalSteps || 0;
    totalWorkouts += s.totalWorkouts || 0; // 0 for entries frozen before this field existed
    totalWorkoutMinutes += s.totalWorkoutMinutes || 0;
    points += s.points || 0;
    if ((s.bestStreak || 0) > bestStreak) bestStreak = s.bestStreak;
    if ((s.maxDaySteps || 0) > maxDaySteps) maxDaySteps = s.maxDaySteps || 0;
    entryCount += s.entryCount || 0; // 0 for snapshots frozen before this field existed
  };
  Object.values(latestByTeam).forEach(addSource);
  Object.values(otherTeamsLiveStats).forEach(addSource);

  return { totalSteps, totalWorkouts, totalWorkoutMinutes, points, bestStreak, maxDaySteps, entryCount };
}

// Called after every meta load/update — cheap no-op unless the trip date has
// actually passed and nobody's closed it yet. There's no server/cron here,
// so this only fires when someone has the app open on/after the date; that's
// an accepted limitation of a client-only Firebase app.
function checkGoalClosure() {
  if (!useCloud || !activeTeamMeta) return;
  if (activeTeamMeta.status === "completed") return;
  if (!activeTeamMeta.tripDate) return;
  if (computeDaysLeft() < 0) closeActiveGoal();
}

// Freezes a summary into teams/{teamId}/history and flips meta to
// "completed". Two people can easily have the app open at the same moment
// right after the trip date — a plain read-then-write here would race and
// both could push a duplicate history entry. Using a transaction on
// meta/status makes the "who gets to close it" decision atomic: Firebase
// retries the updater against the latest server value, so only the client
// that actually flips status from non-"completed" to "completed" gets
// result.committed === true and goes on to write the history entry; every
// other simultaneous caller sees the already-"completed" value, aborts
// (returns undefined) and does nothing further.
async function closeActiveGoal() {
  if (closingGoal) return;
  closingGoal = true;
  try {
    const closedAt = Date.now();
    const result = await db.ref(teamPath("meta/status")).transaction((current) => {
      if (current === "completed") return; // abort — already closed, don't touch it
      return "completed";
    });
    if (!result.committed) return; // someone else won the race to close this goal
    const historyEntry = {
      name: activeTeamMeta.name || "",
      destination: activeTeamMeta.destination || "",
      tripDate: activeTeamMeta.tripDate || "",
      startedAt: activeTeamMeta.createdAt || null,
      closedAt,
      summary: computeGoalSummary()
    };
    await db.ref(teamPath("history")).push().set(historyEntry);
    await db.ref(teamPath("meta/closedAt")).set(closedAt);
  } finally {
    closingGoal = false;
  }
}

// Only team owners can edit the active trip or start a new goal (per-team
// role, not global). Starting a new goal reuses the same meta node as the
// original team — roster, invite code and the activity feed all carry over
// untouched; only the name/destination/date cycle resets and status flips
// back to "active" (closedAt cleared).
function isTeamOwner() {
  return !!currentUser && currentUser.role === "owner";
}

// ---------- AUTH ----------
// No passwords are ever stored in a file. When Firebase is configured, real
// authentication happens through Firebase Authentication: the first time
// someone signs in with a given email, that password is registered for them
// (Firebase hashes and stores it securely); every login after that verifies
// against Firebase, never against anything we control. Which name goes with
// that account, and which team(s) they're in, is separate — see
// resolveActiveTeam/createTeam/joinTeamByCode.
function firebaseAuthErrorText(err) {
  const map = {
    "auth/weak-password": "Пароль должен быть не короче 6 символов.",
    "auth/invalid-email": "Некорректный email.",
    "auth/too-many-requests": "Слишком много попыток входа, попробуйте чуть позже.",
    "auth/network-request-failed": "Нет соединения с сервером.",
    "auth/user-disabled": "Этот аккаунт отключён."
  };
  return (err && map[err.code]) || "Не удалось войти. Попробуйте ещё раз.";
}

// Local (non-cloud) demo mode never had real accounts — it's a fallback for
// trying the app before Firebase is configured, so it still only supports
// the 3 names the app launched with, matched by email prefix, on one device.
//
// mode is "login" or "register" — set explicitly by the Войти/Регистрация
// toggle on the login screen, rather than guessed by trying one then falling
// back to the other. That fallback used to mean a mistyped email on the
// "Войти" button would silently create a brand-new account instead of
// showing an error — this way "Войти" only ever signs in, and "Регистрация"
// only ever creates a new account.
async function attemptLogin(emailRaw, password, mode) {
  const email = emailRaw.trim().toLowerCase();

  if (!useCloud) {
    const login = email.split("@")[0];
    const user = USERS.find((u) => u.login.toLowerCase() === login);
    if (!user) return { ok: false, error: "В демо-режиме без Firebase доступны только исходные участницы (tanya/lilu/nastya@turkeytrip.app)." };
    currentUser = user;
    return { ok: true, isNew: false };
  }

  try {
    if (mode === "register") {
      try {
        const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
        return { ok: true, uid: cred.user.uid, email: cred.user.email, isNew: true };
      } catch (signUpErr) {
        if (signUpErr.code === "auth/email-already-in-use") {
          return { ok: false, error: "Такой email уже зарегистрирован — переключитесь на «Войти»." };
        }
        return { ok: false, error: firebaseAuthErrorText(signUpErr) };
      }
    }

    try {
      const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
      return { ok: true, uid: cred.user.uid, email: cred.user.email, isNew: false };
    } catch (signInErr) {
      const notRegistered = ["auth/user-not-found", "auth/invalid-credential", "auth/wrong-password"].includes(signInErr.code);
      if (notRegistered) {
        return { ok: false, error: "Не нашли аккаунт с таким email и паролем. Если вы ещё не регистрировались — переключитесь на «Регистрация»." };
      }
      return { ok: false, error: firebaseAuthErrorText(signInErr) };
    }
  } catch (fatalErr) {
    // firebase.auth() itself threw (e.g. SDK blocked/failed to load) — never
    // leave the login button stuck, surface a clear message instead.
    console.warn("Firebase Auth недоступен:", fatalErr);
    return { ok: false, error: "Не удалось связаться с сервером входа. Проверьте соединение и попробуйте ещё раз." };
  }
}

// Detaches the live listeners for whichever team was previously active —
// needed now that different logins on the same page can mean different
// teams, so a stale listener from a previous session can't leak data across.
function detachTeamListeners() {
  if (!useCloud || !db) return;
  ["activities", "comments", "reactions", "profiles", "meta", "members", "history"].forEach((node) => {
    db.ref(teamPath(node)).off();
  });
  if (notifSeenListenerLogin) {
    db.ref(teamPath(`notifSeen/${notifSeenListenerLogin}`)).off();
    notifSeenListenerLogin = null;
  }
  notifSeenAt = 0; // next team's "seen" state hasn't loaded yet — don't carry the old one over
}

function showTeamGate() {
  $("#loginScreen").hidden = true;
  $("#appScreen").hidden = true;
  $("#teamGateScreen").hidden = false;
}

// users/{uid}/completedGoals is NOT team-scoped — attached once per login
// session (from enterTeam), not per team, so it keeps working across
// switchToTeam() calls and survives leaving the team a goal was closed in.
function subscribeToPersonalGoals(uid) {
  if (!useCloud || !db) return;
  db.ref(`users/${uid}/completedGoals`).on("value", (snap) => {
    const raw = snap.val() || {};
    // Self-heals an earlier bug where joining a team whose goal was already
    // closed could archive *every* one of that team's past goals to the new
    // member too — including ones from before they'd even joined, which
    // they never appear in the frozen summary for. Quietly deletes any
    // personal record that doesn't actually include this account's own
    // login in its summary, right as it loads, so nothing wrong stays
    // visible even for entries written before this fix existed.
    Object.entries(raw).forEach(([cycleId, h]) => {
      if (!h.summary || !h.myLogin || !h.summary[h.myLogin]) {
        delete raw[cycleId];
        db.ref(`users/${uid}/completedGoals/${cycleId}`).set(null);
      }
    });
    personalGoals = raw;
    rerenderCurrentTab();
  });
}
function unsubscribePersonalGoals(uid) {
  if (!useCloud || !db || !uid) return;
  db.ref(`users/${uid}/completedGoals`).off();
}

// Copies any of the active team's closed goals this account doesn't
// already have a personal copy of into users/{uid}/completedGoals. Runs
// every time teamHistory changes (including the very first time it's
// fetched after entering a team), so a person only needs to have opened
// the app at least once while still a member for it to end up in their own
// permanent record — see leaveTeam() for the one extra safety pass right
// before someone actually leaves.
function archiveTeamHistoryToPersonalRecord() {
  if (!useCloud || !firebase.auth().currentUser || !currentUser) return;
  const uid = firebase.auth().currentUser.uid;
  Object.entries(teamHistory || {}).forEach(([cycleId, h]) => {
    if (personalGoals[cycleId]) return;
    // Only claim a closed goal as "mine" if I actually appear in its frozen
    // summary — someone who joins the team *after* a goal already closed
    // (or was still on the team-gate screen at the time) wasn't part of
    // that run and shouldn't see it in their own "Завершённые цели".
    if (!h.summary || !h.summary[currentUser.login]) return;
    db.ref(`users/${uid}/completedGoals/${cycleId}`).set({ ...h, teamId: activeTeamId, myLogin: currentUser.login });
  });
}

// Runs right after a successful Firebase sign-in: figures out which team
// this uid belongs to and boots straight into the app — or, for a brand-new
// person with no team yet, shows the create/join screen instead.
async function enterTeam(uid, email, displayName) {
  pendingAuth = { uid, email, displayName };
  teamGateMode = "login";
  subscribeToPersonalGoals(uid); // once per login session, not per team — see the function comment
  subscribeToRecipes(); // global, not team-scoped either — see the function comment
  const resolved = await resolveActiveTeam(uid, email);
  if (!resolved) {
    showTeamGate();
    return;
  }
  await activateTeam(resolved.teamId, resolved.login);
}

// Switches the app into a specific team once teamId + this person's
// per-team login are known (from resolveActiveTeam, createTeam,
// joinTeamByCode, or the team switcher). Used both at login time and
// mid-session (switching teams / just joined an additional one) — so it
// doesn't assume pendingAuth is set, and records lastActiveTeamId off the
// live Firebase Auth session so the *next* login (or app reload) comes back
// to whichever team was active most recently, not just the first one found.
async function activateTeam(teamId, login) {
  detachTeamListeners(); // in case a previous team's listeners were still attached
  activeTeamId = teamId;
  await loadTeamMembers(teamId);
  currentUser = USERS.find((u) => u.login === login) || null;
  if (!currentUser) {
    if (pendingAuth) {
      $("#loginError").textContent = "Не удалось загрузить команду. Попробуйте войти ещё раз.";
      $("#loginError").hidden = false;
    } else {
      showToast("⚠️", "Не удалось загрузить команду.");
    }
    return;
  }
  if (useCloud && firebase.auth().currentUser) {
    db.ref(`users/${firebase.auth().currentUser.uid}/lastActiveTeamId`).set(teamId);
  }
  await subscribeToActiveTeam();
  pendingAuth = null;
  showApp();
  // Fire-and-forget: picks up live totals for every OTHER team this
  // account is still in (see refreshOtherTeamsLiveStats), then re-renders
  // Профиль if that's what's on screen once the fetch resolves — avoids
  // blocking the team switch itself on this.
  refreshOtherTeamsLiveStats().then(() => { if (currentTab === "profile") renderProfile(); });
}

// Jumps to a team the account already belongs to (team switcher). Looks up
// this account's per-team login from the memberships reverse-index, then
// reuses activateTeam exactly like login does.
async function switchToTeam(teamId) {
  if (!useCloud || !firebase.auth().currentUser) return;
  const uid = firebase.auth().currentUser.uid;
  const snap = await db.ref(`users/${uid}/memberships/${teamId}`).once("value");
  const membership = snap.val();
  if (!membership) return;
  await activateTeam(teamId, membership.login);
  switchTab("home");
}

// Formally leaves a team: removes this account's entry from that team's
// roster and from its own memberships reverse-index. Deliberately leaves
// activities/{login}/... and profiles/{login} untouched — same
// never-delete-activity principle as closeActiveGoal — so nothing is lost,
// it just stops counting toward that team's live roster/totals going
// forward. If the leaver was the owner, ownership passes to whoever's been
// in the team the longest afterwards (by joinedAt); if they were the only
// member, the team is simply left without one (no auto-owner to hand off
// to — a known edge case for a team that's been fully abandoned).
async function leaveTeam(teamId) {
  if (!useCloud || !firebase.auth().currentUser) return;
  const uid = firebase.auth().currentUser.uid;
  const membershipSnap = await db.ref(`users/${uid}/memberships/${teamId}`).once("value");
  const membership = membershipSnap.val();
  if (!membership) return;
  const login = membership.login;
  const isActiveTeam = teamId === activeTeamId;

  const membersSnap = await db.ref(`teams/${teamId}/members`).once("value");
  const members = membersSnap.val() || {};
  const wasOwner = members[login] && members[login].role === "owner";
  const others = Object.entries(members).filter(([l]) => l !== login);
  if (wasOwner && others.length) {
    others.sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    await db.ref(`teams/${teamId}/members/${others[0][0]}/role`).set("owner");
  }

  // One last safety pass: make sure every one of this team's closed goals
  // has been copied into this account's own personal record. Normally
  // archiveTeamHistoryToPersonalRecord already keeps that up to date live,
  // but if this device never happened to have that team's history listener
  // attached, this is the last guaranteed moment to grab it before the team
  // either gets deleted outright (see below) or simply becomes unreadable
  // to this account once membership is gone.
  const historySnap = await db.ref(`teams/${teamId}/history`).once("value");
  const history = historySnap.val() || {};
  await Promise.all(Object.entries(history).map(([cycleId, h]) => {
    if (personalGoals[cycleId]) return null;
    if (!h.summary || !h.summary[login]) return null; // wasn't part of this particular closed goal
    return db.ref(`users/${uid}/completedGoals/${cycleId}`).set({ ...h, teamId, myLogin: login });
  }));

  // If the *current*, still-open cycle already has activity from this
  // person, freeze a personal snapshot of it too before they lose access —
  // otherwise leaving mid-challenge would wipe out weeks of steps/streak/
  // points from their own record, purely because the team's goal never
  // officially closed. Marked leftEarly so it renders differently from a
  // real finish line (see renderTripHistory). Reads straight from Firebase
  // rather than the module-level activities cache, since this can be a team
  // other than the one currently loaded there.
  const teamMetaSnap = await db.ref(`teams/${teamId}/meta`).once("value");
  const teamMeta = teamMetaSnap.val() || {};
  if (teamMeta.status !== "completed") {
    const [actSnap, profSnap] = await Promise.all([
      db.ref(`teams/${teamId}/activities/${login}`).once("value"),
      db.ref(`teams/${teamId}/profiles/${login}`).once("value")
    ]);
    const snap = summarizeActivityEntries(actSnap.val());
    if (snap.entryCount > 0) {
      const myName = (profSnap.val() && profSnap.val().name) || login;
      const cycleId = `left-${teamId}-${Date.now()}`;
      await db.ref(`users/${uid}/completedGoals/${cycleId}`).set({
        name: teamMeta.name || "",
        destination: teamMeta.destination || "",
        tripDate: teamMeta.tripDate || "",
        startedAt: teamMeta.createdAt || null,
        closedAt: Date.now(),
        leftEarly: true,
        summary: {
          [login]: {
            name: myName,
            totalSteps: snap.totalSteps,
            totalWorkouts: snap.totalWorkouts,
            totalWorkoutMinutes: snap.totalWorkoutMinutes,
            points: snap.points,
            bestStreak: snap.bestStreak,
            maxDaySteps: snap.maxDaySteps,
            entryCount: snap.entryCount
          }
        },
        teamId,
        myLogin: login
      });
    }
  }

  if (isActiveTeam) detachTeamListeners(); // stop reacting to a team we're about to remove ourselves from (or delete)

  // teams/{teamId}/... writes happen while the membership index still
  // exists — required by the stricter security rule (see README) — so the
  // users/{uid}/memberships/{teamId} removal always comes last.
  await db.ref(`teams/${teamId}/members/${login}`).set(null);

  if (others.length === 0) {
    // Last person out — the team is now a dead, ownerless shell (its
    // history is already safely archived into everyone's personal record
    // above). Delete it entirely, including its invite code, so it doesn't
    // linger forever or leave a code that silently points at nothing.
    const inviteCode = isActiveTeam
      ? activeTeamMeta.inviteCode
      : (await db.ref(`teams/${teamId}/meta/inviteCode`).once("value")).val();
    await db.ref(`teams/${teamId}`).set(null);
    if (inviteCode) await db.ref(`inviteCodes/${inviteCode}`).set(null);
  }

  await db.ref(`users/${uid}/memberships/${teamId}`).set(null);

  if (!isActiveTeam) return; // left a different team than the one currently open — nothing else to do

  const resolved = await resolveActiveTeam(uid, firebase.auth().currentUser.email);
  if (resolved) {
    await activateTeam(resolved.teamId, resolved.login);
  } else {
    // Carry the real display name over to the create/join-team screen —
    // there's no "your name" field there (it only asks for a team name /
    // invite code), so if this were left blank the next team they create or
    // join would end up named "Без имени" even though nothing about them
    // was actually lost. Read before nulling currentUser out below.
    const myName = currentUser ? currentUser.name : "";
    currentUser = null;
    pendingAuth = { uid, email: firebase.auth().currentUser.email, displayName: myName };
    teamGateMode = "login";
    showTeamGate();
  }
}

function logout() {
  detachTeamListeners();
  if (useCloud && firebase.auth().currentUser) {
    unsubscribePersonalGoals(firebase.auth().currentUser.uid);
    unsubscribeRecipes();
    firebase.auth().signOut();
  }
  currentUser = null;
  pendingAuth = null;
  personalGoals = {};
  recipes = {};
  localStorage.removeItem("tc_session");
  $("#appScreen").hidden = true;
  $("#teamGateScreen").hidden = true;
  $("#loginScreen").hidden = false;
  $("#loginForm").reset();
}

// ---------- RENDER: HOME ----------
function renderHome() {
  if (!currentUser) return;
  $("#homeAvatarImg").src = avatarSrc(currentUser.avatar);
  $("#homeAvatar").style.background = gradCss(currentUser.avatarGradient);
  $("#homeGreeting").textContent = `Привет, ${currentUser.name}!`;

  const streak = computeStreak(currentUser.login);
  $("#homeStreak").textContent = streak.current > 0
    ? `🔥 ${streak.current} ${daysWord(streak.current)} подряд`
    : "Начни серию сегодня!";

  const isGoalCompleted = activeTeamMeta.status === "completed";
  $("#editTripBtn").hidden = isGoalCompleted || !isTeamOwner();
  if (isGoalCompleted) {
    $("#countdownNum").textContent = "🎉";
    $("#countdownTitle").textContent = "Цель завершена";
    $("#countdownSub").textContent = activeTripDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  } else {
    const daysLeft = computeDaysLeft();
    $("#countdownNum").textContent = daysLeft > 0 ? daysLeft : (daysLeft === 0 ? "🎉" : "🌊");
    $("#countdownTitle").textContent = `До ${activeTeamMeta.destination || "Турции"}`;
    $("#countdownSub").textContent = activeTripDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  }
  renderGoalCompletedCard(isGoalCompleted);

  const motivation = pick(MOTIVATION_DAILY);
  $("#motivationEmoji").textContent = motivation.emoji;
  $("#motivationText").textContent = motivation.text;

  const myGoal = currentUser.dailyGoal || DAILY_STEP_GOAL;
  const agg = dailyAggregates(currentUser.login);
  const todaySteps = (agg[getTodayStr()] && agg[getTodayStr()].steps) || 0;
  const frac = Math.max(0, Math.min(1, todaySteps / myGoal));
  const circumference = 264;
  $("#ringProgress").style.strokeDashoffset = String(circumference * (1 - frac));
  $("#ringValue").textContent = nf(todaySteps);
  $("#ringGoal").textContent = `цель · ${nf(myGoal)}`;

  const teamGoal = USERS.reduce((sum, u) => sum + (u.dailyGoal || DAILY_STEP_GOAL), 0);
  const team = computeTeamTotals();
  const teamFrac = Math.max(0, Math.min(1, team.todaySteps / teamGoal));
  $("#teamBarFill").style.width = (teamFrac * 100) + "%";
  $("#teamBarCaption").textContent = `${nf(team.todaySteps)} из ${nf(teamGoal)} шагов`;

  const teamActivityGoal = WEEKLY_ACTIVITY_GOAL_MIN * USERS.length;
  const teamActivityMin = USERS.reduce((sum, u) => sum + weeklyActivityMinutes(u.login), 0);
  const teamActivityFrac = Math.max(0, Math.min(1, teamActivityMin / teamActivityGoal));
  $("#teamWorkoutBarFill").style.width = (teamActivityFrac * 100) + "%";
  $("#teamWorkoutBarCaption").textContent = `${nf(teamActivityMin)} из ${nf(teamActivityGoal)} мин`;

  renderFriendStack();

  renderHistory();
  renderWeekChart();
}

// Overlapping avatar cluster shown next to the "Прогресс команды" title.
function renderFriendStack() {
  const wrap = $("#miniFriends");
  if (!wrap) return;
  wrap.innerHTML = USERS.map((u) => `
    <div class="friend-stack-avatar">
      <div class="avatar" style="background:${gradCss(u.avatarGradient)}"><img class="avatar-icon-img" src="${avatarSrc(u.avatar)}" alt=""></div>
    </div>`).join("");
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
        <button class="hi-edit" data-id="${e.id}" title="Изменить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 20l.9-3.9a2 2 0 0 1 .53-.97L15.6 5c.8-.8 2.1-.8 2.9 0l.5.5c.8.8.8 2.1 0 2.9L8.87 18.57a2 2 0 0 1-.97.53L4 20z"/>
            <path d="M14 6.5l3.5 3.5"/>
          </svg>
        </button>
        <button class="hi-delete" data-id="${e.id}" title="Удалить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 7h14"/>
            <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/>
            <path d="M7 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h5.2a1.6 1.6 0 0 0 1.6-1.5L17 7"/>
            <path d="M10.3 11v6M13.7 11v6"/>
          </svg>
        </button>
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
  if (useCloud) { db.ref(teamPath(`activities/${currentUser.login}/${id}`)).update({ steps: entry.steps, points: entry.points, date: entry.date }); mirrorEntryToOtherTeams(id, entry); }
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
    db.ref(teamPath(`activities/${currentUser.login}/${id}`)).update({
      workoutType: entry.workoutType,
      workoutMinutes: entry.workoutMinutes,
      workoutCalories: entry.workoutCalories,
      points: entry.points,
      date: entry.date
    });
    mirrorEntryToOtherTeams(id, entry);
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
    db.ref(teamPath(`activities/${currentUser.login}/${id}`)).remove();
    db.ref(teamPath(`comments/${id}`)).remove();
    db.ref(teamPath(`reactions/${id}`)).remove();
    removeEntryFromOtherTeams(id);
  } else {
    persistLocal();
  }
  showToast("🗑", "Запись удалена");
  renderHome();
}

// ---------- CHART HELPERS: sparkline-style trend charts ----------
function hexToRgba(hex, alpha) {
  if (!hex) return `rgba(47, 217, 196, ${alpha})`;
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToHsl(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.substr(0, 2), 16) / 255;
  const g = parseInt(h.substr(2, 2), 16) / 255;
  const b = parseInt(h.substr(4, 2), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hue, sat, light = (max + min) / 2;
  if (max === min) { hue = sat = 0; }
  else {
    const d = max - min;
    sat = light > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: hue = (g - b) / d + (g < b ? 6 : 0); break;
      case g: hue = (b - r) / d + 2; break;
      default: hue = (r - g) / d + 4;
    }
    hue /= 6;
  }
  return { h: hue * 360, s: sat * 100, l: light * 100 };
}
// Softer, less saturated / brighter version of a hex color for calmer chart lines
function softenColor(hex, satMul = 0.55, lightAdd = 10, alpha = 1) {
  const { h, s, l } = hexToHsl(hex);
  return `hsla(${h.toFixed(1)}, ${(s * satMul).toFixed(1)}%, ${Math.min(80, l + lightAdd).toFixed(1)}%, ${alpha})`;
}

// Adds a soft neon glow behind each dataset's line as it's drawn
const neonGlowPlugin = {
  id: "neonGlow",
  beforeDatasetDraw(chart, args) {
    const ds = chart.data.datasets[args.index];
    const ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = ds.borderColor;
    ctx.shadowBlur = 3.5;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  },
  afterDatasetDraw(chart) {
    chart.ctx.restore();
  }
};

// Compares the sum of a metric over the last 7 days vs the 7 days before that
function weekOverWeekTotals(login, metric) {
  const agg = dailyAggregates(login);
  const metricKey = metric === "steps" ? "steps" : metric === "workouts" ? "workoutMinutes" : "points";
  const today = startOfDay(new Date());
  let thisWeek = 0, lastWeek = 0;
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = formatDate(d);
    const v = agg[ds] ? agg[ds][metricKey] : 0;
    if (i < 7) thisWeek += v; else lastWeek += v;
  }
  return { thisWeek, lastWeek };
}

function renderTrendBadge(elId, pctElId, thisWeek, lastWeek) {
  const wrap = $(elId);
  const pctEl = $(pctElId);
  if (!wrap || !pctEl) return;
  if (!lastWeek) { wrap.hidden = true; return; }
  const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  wrap.hidden = false;
  pctEl.textContent = `${pct >= 0 ? "↑" : "↓"} ${Math.abs(pct)}%`;
  pctEl.classList.toggle("down", pct < 0);
}

// Draws the numeric value above every point that actually has data, so it's always
// clear which days/weeks had activity — no more "random" highlighting of just a couple points.
const valueLabelsPlugin = {
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data.length) return;
    const values = chart.data.datasets[0].data;
    const lastIdx = values.length - 1;
    const { ctx } = chart;
    ctx.save();
    ctx.font = "700 11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    values.forEach((v, i) => {
      if (!v) return; // skip empty days/weeks — nothing to label
      const pt = meta.data[i];
      if (!pt) return;
      const isToday = i === lastIdx;
      ctx.fillStyle = isToday ? "#FFB020" : "#CFE38A";
      ctx.fillText(nf(v), pt.x, Math.max(12, pt.y - 12));
    });
    ctx.restore();
  }
};

function renderWeekChart() {
  const canvas = $("#weekChart");
  if (!canvas || typeof Chart === "undefined") return;
  const { labels, values } = buildBuckets(currentUser.login, chartPeriod, chartMetric);
  if (weekChartInstance) weekChartInstance.destroy();

  const wow = weekOverWeekTotals(currentUser.login, chartMetric);
  renderTrendBadge("#weekChartTrend", "#weekChartTrendPct", wow.thisWeek, wow.lastWeek);

  const ctx = canvas.getContext("2d");
  const accent = "#B7E14D"; // lime-green trend line, in the spirit of the Kalo-style reference
  const fillGrad = ctx.createLinearGradient(0, 0, 0, canvas.height || 160);
  fillGrad.addColorStop(0, hexToRgba(accent, 0.32));
  fillGrad.addColorStop(1, hexToRgba(accent, 0));

  const lastIdx = values.length - 1;
  // Every day/week that actually has data gets a visible dot; "today" (or the current
  // week/month) is always marked, even at zero, so it's clear where "now" is on the line.
  const pointRadius = values.map((v, i) => (i === lastIdx ? 5 : v > 0 ? 3.5 : 0));
  const pointHoverRadius = values.map((v, i) => (i === lastIdx ? 6 : v > 0 ? 5 : 4));
  const pointHitRadius = values.map(() => 14);
  const pointBackgroundColor = values.map((_, i) => (i === lastIdx ? "#FFB020" : accent));
  const unit = metricLabel(chartMetric);

  weekChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: unit,
        data: values,
        borderColor: accent,
        backgroundColor: fillGrad,
        borderWidth: 2.5,
        tension: 0.42,
        fill: true,
        pointRadius,
        pointHoverRadius,
        pointHitRadius,
        pointBackgroundColor,
        // White pops against the dark .chart-card background as a halo
        // ring around each dot; on the light theme that card is white too,
        // so the ring needs to flip dark to still read as a ring at all.
        pointBorderColor: currentTheme === "light" ? "#15331C" : "#fff",
        pointBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(23, 27, 39, 0.95)",
          titleColor: "#F4F5F7",
          bodyColor: "#F4F5F7",
          borderColor: accent,
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (c) => `${unit}: ${nf(c.parsed.y)}`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#6B7086", font: { size: 10.5, weight: "600" } } },
        y: { display: false, grid: { display: false } }
      }
    },
    plugins: [valueLabelsPlugin]
  });
}

// Shows/populates the "goal completed" card on Home. Reads the frozen
// summary from the most recently closed history entry (not a live
// recompute) so the numbers stay exactly what they were the moment the
// goal closed, even if people keep quietly logging old activity after.
function renderGoalCompletedCard(isCompleted) {
  const card = $("#goalCompletedCard");
  if (!card) return;
  card.hidden = !isCompleted;
  if (!isCompleted) return;

  const entries = Object.values(teamHistory || {});
  const latest = entries.length
    ? entries.reduce((a, b) => (b.closedAt > a.closedAt ? b : a))
    : null;
  const summary = (latest && latest.summary) || computeGoalSummary();
  const name = (latest && latest.name) || activeTeamMeta.name || "Поездка";
  const tripDate = (latest && latest.tripDate) || activeTeamMeta.tripDate;

  $("#goalCompletedSub").textContent = tripDate
    ? `${name} · ${new Date(tripDate).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}`
    : name;

  $("#goalSummaryList").innerHTML = USERS.map((u) => {
    const s = summary[u.login] || { totalSteps: 0, totalWorkoutMinutes: 0, points: 0 };
    return `<li class="goal-summary-row">
      <img class="goal-summary-avatar" src="${avatarSrc(u.avatar)}" alt="">
      <span class="goal-summary-name">${u.name}</span>
      <span class="goal-summary-stat">${nf(s.totalSteps)} шагов · ${nf(s.totalWorkoutMinutes)} мин · ${nf(s.points)} очков</span>
    </li>`;
  }).join("");

  const isOwner = isTeamOwner();
  $("#startNewGoalBtn").hidden = !isOwner;
  $("#goalCompletedHint").hidden = isOwner;
}

const REACTION_EMOJIS = ["🔥", "👏", "💪", "🎉", "😍"];

// ---------- NOTIFICATIONS (comments/reactions on MY activity, or a
// teammate logging new activity of their own) ----------

// Maps every activityId to the login who posted it, so a comment/reaction
// can be traced back to "was this on something I posted".
function buildActivityOwnerMap() {
  const map = {};
  Object.keys(activities).forEach((login) => {
    Object.values(activities[login] || {}).forEach((e) => { map[e.id] = login; });
  });
  return map;
}

// True if, since I last opened the bell/feed, someone *else* has either
// commented on / reacted to one of my own activity entries, or logged a new
// activity entry of their own (steps or a workout).
function hasUnreadNotifications() {
  if (!currentUser) return false;
  const ownerOf = buildActivityOwnerMap();
  for (const activityId in comments) {
    if (ownerOf[activityId] !== currentUser.login) continue;
    const list = Object.values(comments[activityId] || {});
    if (list.some((c) => c.login !== currentUser.login && c.ts > notifSeenAt)) return true;
  }
  for (const activityId in reactions) {
    if (ownerOf[activityId] !== currentUser.login) continue;
    const byEmoji = reactions[activityId] || {};
    for (const emoji in byEmoji) {
      const byLogin = byEmoji[emoji] || {};
      for (const login in byLogin) {
        if (login !== currentUser.login && byLogin[login] > notifSeenAt) return true;
      }
    }
  }
  // A teammate (not me) logging a new activity entry — steps or a workout —
  // also lights up the bell, same as a comment/reaction would.
  for (const login in activities) {
    if (login === currentUser.login) continue;
    const list = Object.values(activities[login] || {});
    if (list.some((e) => e.ts > notifSeenAt)) return true;
  }
  return false;
}

function updateNotifBadge() {
  const dot = $("#notifDot");
  if (dot) dot.hidden = !hasUnreadNotifications();
}

// Called when the person taps the bell — clears the yellow marker and
// remembers the moment, both locally and (in cloud mode) on their own
// per-team record, so it stays cleared across reloads/devices.
function markNotificationsSeen() {
  notifSeenAt = Date.now();
  updateNotifBadge();
  if (useCloud && currentUser) db.ref(teamPath(`notifSeen/${currentUser.login}`)).set(notifSeenAt);
}

// ---------- RECIPES (global — a shared cookbook, not tied to any one team) ----------
// Lives at the DB root as recipes/{recipeId}, alongside teams/ and users/ —
// deliberately NOT under teams/{teamId}/..., so it's the same list no
// matter which team is currently active, and survives switching or leaving
// teams entirely. "Author" is the Firebase Auth uid (not a per-team login,
// which only needs to be unique within one team) — see recipeAuthorId.

const RECIPE_CATEGORIES = {
  breakfast: { label: "Завтрак", pluralLabel: "Завтраки", emoji: "🍳" },
  lunch:     { label: "Обед",    pluralLabel: "Обеды",    emoji: "🍲" },
  dinner:    { label: "Ужин",    pluralLabel: "Ужины",    emoji: "🌙" }
};
const RECIPE_UNITS = ["г", "мл", "шт"];

// Stable per-account identity for "who wrote this recipe", independent of
// which team (and therefore which per-team login) happens to be active.
// Falls back to a fixed key in local demo mode, where there's no real
// multi-account concept anyway.
function recipeAuthorId() {
  return (useCloud && firebase.auth().currentUser) ? firebase.auth().currentUser.uid : "local";
}

function subscribeToRecipes() {
  if (!useCloud || !db) return;
  db.ref("recipes").on("value", (snap) => {
    recipes = snap.val() || {};
    if (currentTab === "recipes") renderRecipes();
  });
}
function unsubscribeRecipes() {
  if (!useCloud || !db) return;
  db.ref("recipes").off();
}

// ---- Ingredient rows (dynamic list inside the create/edit form) ----

function createIngredientRow(ing) {
  const row = document.createElement("div");
  row.className = "ingredient-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "ingredient-name-input modal-input";
  nameInput.placeholder = "Название";
  nameInput.value = (ing && ing.name) || "";

  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.className = "ingredient-amount-input modal-input";
  amountInput.placeholder = "200";
  amountInput.min = "0";
  amountInput.value = (ing && ing.amount != null) ? ing.amount : "";

  const unitSelect = document.createElement("select");
  unitSelect.className = "ingredient-unit-select modal-input";
  RECIPE_UNITS.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u;
    opt.textContent = u;
    if (ing && ing.unit === u) opt.selected = true;
    unitSelect.appendChild(opt);
  });

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "ingredient-row-del";
  delBtn.title = "Удалить ингредиент";
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 7h14"/>
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/>
      <path d="M7 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h5.2a1.6 1.6 0 0 0 1.6-1.5L17 7"/>
      <path d="M10.3 11v6M13.7 11v6"/>
    </svg>`;
  delBtn.addEventListener("click", () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(amountInput);
  row.appendChild(unitSelect);
  row.appendChild(delBtn);
  return row;
}

function addIngredientRow(ing) {
  $("#ingredientRows").appendChild(createIngredientRow(ing));
}

function readIngredientRows() {
  return Array.from($("#ingredientRows").querySelectorAll(".ingredient-row"))
    .map((row) => ({
      name: row.querySelector(".ingredient-name-input").value.trim(),
      amount: row.querySelector(".ingredient-amount-input").value.trim(),
      unit: row.querySelector(".ingredient-unit-select").value
    }))
    .filter((ing) => ing.name); // silently drop rows nobody filled in
}

// ---- Create / edit form ----

// Toggles the enabled/disabled look of the КБЖУ fields based on the
// "Без КБЖУ" checkbox — shared by both the checkbox's change handler and
// openRecipeForm (to restore the right state when editing/reopening).
function applyRecipeMacrosState(noMacros) {
  $("#recipeMacrosGrid").classList.toggle("disabled", noMacros);
  ["#recipeCaloriesInput", "#recipeProteinInput", "#recipeFatInput", "#recipeCarbsInput"].forEach((sel) => {
    $(sel).disabled = noMacros;
  });
}

// Pass an existing recipe (with its id attached) to edit it in place, or
// call with no argument to open a blank form for a new one.
function openRecipeForm(recipe) {
  editingRecipeId = recipe ? recipe.id : null;
  recipeFormCategory = (recipe && recipe.category) || "breakfast";
  $("#recipeFormTitle").textContent = recipe ? "Изменить рецепт 🍽️" : "Новый рецепт 🍽️";
  $("#recipeNameInput").value = recipe ? recipe.name : "";
  const noMacros = !!(recipe && recipe.noMacros);
  $("#recipeNoMacrosCheckbox").checked = noMacros;
  $("#recipeCaloriesInput").value = recipe && !noMacros ? recipe.calories : "";
  $("#recipeProteinInput").value = recipe && !noMacros ? recipe.protein : "";
  $("#recipeFatInput").value = recipe && !noMacros ? recipe.fat : "";
  $("#recipeCarbsInput").value = recipe && !noMacros ? recipe.carbs : "";
  applyRecipeMacrosState(noMacros);
  $("#recipeCommentInput").value = (recipe && recipe.comment) || "";
  $("#recipeFormError").hidden = true;

  $("#recipeCategoryFormSegmented").querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.category === recipeFormCategory);
  });

  $("#ingredientRows").innerHTML = "";
  const ingredients = (recipe && recipe.ingredients) || [];
  if (ingredients.length) ingredients.forEach((ing) => addIngredientRow(ing));
  else addIngredientRow(); // one blank row to start from, for a brand-new recipe

  openModal("recipeFormModal");
}

function saveRecipeFromForm() {
  const name = $("#recipeNameInput").value.trim();
  const ingredients = readIngredientRows();
  const noMacros = $("#recipeNoMacrosCheckbox").checked;
  const calories = parseInt($("#recipeCaloriesInput").value, 10);
  const protein = parseInt($("#recipeProteinInput").value, 10);
  const fat = parseInt($("#recipeFatInput").value, 10);
  const carbs = parseInt($("#recipeCarbsInput").value, 10);
  const comment = $("#recipeCommentInput").value.trim();

  const macrosValid = noMacros || [calories, protein, fat, carbs].every((n) => Number.isFinite(n) && n >= 0);
  if (!name || !ingredients.length || !macrosValid) {
    $("#recipeFormError").hidden = false;
    return;
  }
  $("#recipeFormError").hidden = true;

  const patch = noMacros
    ? { name, category: recipeFormCategory, ingredients, noMacros: true, calories: null, protein: null, fat: null, carbs: null, comment }
    : { name, category: recipeFormCategory, ingredients, noMacros: false, calories, protein, fat, carbs, comment };

  if (editingRecipeId) {
    // Editing never touches authorUid/authorName/createdAt — only the
    // original author can even reach this path (see openRecipeDetail's
    // isMine gate on the Редактировать button).
    if (useCloud) db.ref(`recipes/${editingRecipeId}`).update(patch);
    else { Object.assign(recipes[editingRecipeId], patch); persistLocal(); renderRecipes(); }
  } else {
    const full = { ...patch, authorUid: recipeAuthorId(), authorName: currentUser.name, createdAt: Date.now() };
    if (useCloud) {
      db.ref("recipes").push(full);
    } else {
      recipes[randomId()] = full;
      persistLocal();
      renderRecipes();
    }
  }

  closeModal("recipeFormModal");
  editingRecipeId = null;
  showToast("🍽️", "Рецепт сохранён!");
}

// ---- Detail view ----

function openRecipeDetail(id) {
  const r = recipes[id];
  if (!r) return;
  viewingRecipeId = id;
  const cat = RECIPE_CATEGORIES[r.category] || { label: r.category, emoji: "🍽️" };
  $("#recipeDetailTitle").textContent = r.name;
  $("#recipeDetailCategory").textContent = `${cat.emoji} ${cat.label}`;
  $("#recipeDetailMacros").textContent = r.noMacros
    ? "Без КБЖУ"
    : `${nf(r.calories)} ккал · Б ${nf(r.protein)} · Ж ${nf(r.fat)} · У ${nf(r.carbs)}`;
  const dateLabel = r.createdAt ? new Date(r.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "";
  $("#recipeDetailMeta").textContent = `👤 Создал: ${r.authorName || "—"} · 📅 ${dateLabel}`;
  $("#recipeDetailIngredients").innerHTML = (r.ingredients || []).map((ing) => `
    <li class="recipe-ingredient-row">
      <span class="recipe-ingredient-name">${escapeHtml(ing.name)}</span>
      <span class="recipe-ingredient-amount">${escapeHtml(String(ing.amount != null ? ing.amount : ""))} ${escapeHtml(ing.unit || "")}</span>
    </li>`).join("");

  const hasComment = !!(r.comment && r.comment.trim());
  $("#recipeDetailCommentSection").hidden = !hasComment;
  if (hasComment) $("#recipeDetailComment").textContent = r.comment;

  const isMine = r.authorUid === recipeAuthorId();
  $("#editRecipeBtn").hidden = !isMine;
  $("#deleteRecipeBtn").hidden = !isMine;

  openModal("recipeDetailModal");
}

function deleteRecipe(id) {
  if (useCloud) db.ref(`recipes/${id}`).remove();
  else { delete recipes[id]; persistLocal(); renderRecipes(); }
}

// ---- List / journal ----

function matchesRecipeFilters(r) {
  if (recipeCategoryFilter !== "all" && r.category !== recipeCategoryFilter) return false;
  if (recipeMineOnly && r.authorUid !== recipeAuthorId()) return false;
  const q = recipeSearchQuery.trim().toLowerCase();
  if (q && !(r.name || "").toLowerCase().includes(q)) return false;
  return true;
}

function renderRecipes() {
  const wrap = $("#recipeList");
  const empty = $("#recipeEmpty");
  if (!wrap) return;
  const entries = Object.entries(recipes || {})
    .filter(([, r]) => matchesRecipeFilters(r))
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!entries.length) {
    wrap.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  wrap.innerHTML = entries.map(([id, r]) => {
    const cat = RECIPE_CATEGORIES[r.category] || { label: r.category, emoji: "🍽️" };
    const dateLabel = r.createdAt ? new Date(r.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "";
    const count = (r.ingredients || []).length;
    return `<li class="recipe-card" data-id="${id}">
      <div class="recipe-card-head">
        <span class="recipe-card-title">${escapeHtml(r.name)}</span>
        <span class="recipe-card-category">${cat.emoji} ${cat.label}</span>
      </div>
      <div class="recipe-card-macros">${r.noMacros ? "Без КБЖУ" : `${nf(r.calories)} ккал · Б ${nf(r.protein)} · Ж ${nf(r.fat)} · У ${nf(r.carbs)}`}</div>
      <div class="recipe-card-meta">👤 ${escapeHtml(r.authorName || "—")} · 📅 ${dateLabel} · ${count} ${pluralRu(count, "ингредиент", "ингредиента", "ингредиентов")}</div>
    </li>`;
  }).join("");
}

// ---------- RENDER: FEED ----------
function buildFeed() {
  const items = [];
  USERS.forEach((u) => {
    Object.values(activities[u.login] || {}).forEach((e) => {
      const text = e.type === "steps"
        ? `добавила ${nf(e.steps)} шагов 🚶`
        : `добавила тренировку: ${e.workoutType}, ${e.workoutMinutes} мин${e.workoutCalories ? `, ${nf(e.workoutCalories)} ккал` : ""} 🏋️`;
      items.push({ id: e.id, login: u.login, name: u.name, avatar: u.avatar, color: u.color, avatarGradient: u.avatarGradient, text, ts: e.ts });
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
        <div class="avatar" style="background:${gradCss(item.avatarGradient)}"><img class="avatar-icon-img" src="${avatarSrc(item.avatar)}" alt=""></div>
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
  if (useCloud) db.ref(teamPath(`comments/${id}/${cid}`)).set(comment);
  else persistLocal();
  renderFeed();
}

function deleteComment(itemId, cid) {
  if (!comments[itemId] || !comments[itemId][cid]) return;
  delete comments[itemId][cid];
  if (Object.keys(comments[itemId]).length === 0) delete comments[itemId];
  if (useCloud) db.ref(teamPath(`comments/${itemId}/${cid}`)).remove();
  else persistLocal();
  renderFeed();
}

function toggleReaction(itemId, emoji) {
  if (!reactions[itemId]) reactions[itemId] = {};
  if (!reactions[itemId][emoji]) reactions[itemId][emoji] = {};
  const already = !!reactions[itemId][emoji][currentUser.login];
  if (already) {
    delete reactions[itemId][emoji][currentUser.login];
    if (useCloud) db.ref(teamPath(`reactions/${itemId}/${emoji}/${currentUser.login}`)).remove();
  } else {
    // Stored as a timestamp rather than a bare `true` — every place that
    // reads this only checks truthiness or takes Object.keys() (unaffected
    // by the value itself), so this is a safe extension. The timestamp is
    // what lets the notifications bell tell a fresh reaction from an old one.
    const ts = Date.now();
    reactions[itemId][emoji][currentUser.login] = ts;
    if (useCloud) db.ref(teamPath(`reactions/${itemId}/${emoji}/${currentUser.login}`)).set(ts);
  }
  if (Object.keys(reactions[itemId][emoji]).length === 0) delete reactions[itemId][emoji];
  if (!useCloud) persistLocal();
  renderFeed();
}

// ---------- RENDER: TEAM ----------
function renderTeam() {
  const canvas = $("#teamChart");
  if (canvas && typeof Chart !== "undefined") {
    const teamWow = USERS.reduce((sum, u) => {
      const w = weekOverWeekTotals(u.login, teamChartMetric);
      sum.thisWeek += w.thisWeek;
      sum.lastWeek += w.lastWeek;
      return sum;
    }, { thisWeek: 0, lastWeek: 0 });
    renderTrendBadge("#teamChartTrend", "#teamChartTrendPct", teamWow.thisWeek, teamWow.lastWeek);

    let labels = [];
    const datasets = USERS.map((u) => {
      const bucket = buildBuckets(u.login, teamChartPeriod, teamChartMetric);
      labels = bucket.labels;
      const lastIdx = bucket.values.length - 1;
      const pointRadius = bucket.values.map((v, i) => (i === lastIdx ? 4 : v > 0 ? 3 : 0));
      const pointHitRadius = bucket.values.map(() => 12);
      const teamColor = teamColorFor(u.login);
      const lineColor = teamColor;
      const dotColor = teamColor;
      return {
        label: u.name,
        data: bucket.values,
        borderColor: lineColor,
        backgroundColor: "transparent",
        borderWidth: 2.2,
        tension: 0.4,
        fill: false,
        pointRadius,
        pointHoverRadius: 5,
        pointHitRadius,
        pointBackgroundColor: dotColor,
        pointBorderColor: "#15331C",
        pointBorderWidth: 1.5
      };
    });
    const teamUnit = metricLabel(teamChartMetric);
    if (teamChartInstance) teamChartInstance.destroy();
    teamChartInstance = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: "#F4F5F7",
              usePointStyle: true,
              pointStyle: "rectRounded",
              boxWidth: 12,
              boxHeight: 12,
              padding: 20,
              font: { size: 11 }
            }
          },
          tooltip: {
            enabled: true,
            backgroundColor: "rgba(23, 27, 39, 0.95)",
            titleColor: "#F4F5F7",
            bodyColor: "#F4F5F7",
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: (c) => `${c.dataset.label}: ${nf(c.parsed.y)} ${teamUnit.toLowerCase()}`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#6B7086", font: { size: 10.5, weight: "600" } } },
          y: { display: false, grid: { display: false } }
        }
      },
      plugins: [neonGlowPlugin]
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
      <div class="avatar" style="background:${gradCss(u.avatarGradient)}"><img class="avatar-icon-img" src="${avatarSrc(u.avatar)}" alt=""></div>
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
  $("#profileAvatarImg").src = avatarSrc(currentUser.avatar);
  $("#profileAvatar").style.background = gradCss(currentUser.avatarGradient);
  $("#profileName").textContent = currentUser.name;
  $("#profileLogin").textContent = "@" + currentUser.login;
  $("#profileGoal").textContent = `цель: ${nf(currentUser.dailyGoal || DAILY_STEP_GOAL)} шагов/день`;
  $("#teamNameLabel").textContent = activeTeamMeta.name || "Команда";
  $("#teamInviteCode").textContent = activeTeamMeta.inviteCode || "——————";
  const badge = $("#syncBadge");
  badge.textContent = useCloud ? "☁️ синхронизировано со всеми" : "📱 только на этом устройстве";
  badge.classList.toggle("cloud", useCloud);
  // Lifetime, not team-scoped — these numbers belong to the person, so they
  // must not drop back to zero just because they switched teams or left one
  // (see computeLifetimeStats).
  const lifetime = computeLifetimeStats(currentUser.login);
  $("#statTotalSteps").textContent = nf(lifetime.totalSteps);
  $("#statWorkouts").textContent = lifetime.totalWorkouts;
  $("#statBestStreak").textContent = lifetime.bestStreak;
  $("#statPoints").textContent = nf(lifetime.points);
  renderAchievements(); // now lives in Профиль as a collapsible card, not its own tab
  renderTripHistory();
}

// Archive of past closed goals — newest first. Each entry is the frozen
// summary written by closeActiveGoal(), so it reflects the team roster and
// numbers exactly as they stood when that goal wrapped up.
// Renders from personalGoals (this account's own permanent archive), not
// teamHistory (the currently active team's) — so it stays the same no
// matter which team is open right now, and keeps showing goals closed in
// teams this person has since left.
function renderTripHistory() {
  const wrap = $("#tripHistoryList");
  const empty = $("#tripHistoryEmpty");
  if (!wrap) return;
  const entries = Object.entries(personalGoals || {}).sort((a, b) => (b[1].closedAt || 0) - (a[1].closedAt || 0));
  if (!entries.length) {
    wrap.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  const medals = ["🥇", "🥈", "🥉"];
  wrap.innerHTML = entries.map(([id, h]) => {
    const dateLabel = h.tripDate
      ? new Date(h.tripDate).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
      : "";
    const members = Object.entries(h.summary || {})
      .map(([login, m]) => ({ ...m, login }))
      .sort((a, b) => (b.totalSteps || 0) - (a.totalSteps || 0))
      .map((m, i) => {
        // "Me" always resolves to my current avatar, even for a goal closed
        // in a team I've since left/switched away from; teammates only
        // resolve if this happens to be the team currently open.
        const u = m.login === h.myLogin ? currentUser : USERS.find((x) => x.login === m.login);
        const medal = medals[i];
        const rankClass = medal ? "trip-history-member-rank" : "trip-history-member-rank trip-history-member-rank-num";
        return `<li class="trip-history-member${i === 0 ? " trip-history-member-top" : ""}">
          <span class="${rankClass}">${medal || (i + 1)}</span>
          <img class="trip-history-member-avatar" src="${avatarSrc(u ? u.avatar : "face1")}" alt="">
          <span class="trip-history-member-name">${m.name || ""}</span>
          <span class="trip-history-member-stat">${nf(m.totalSteps || 0)} шагов · ${nf(m.totalWorkoutMinutes || 0)} мин · ${nf(m.points || 0)} очков</span>
        </li>`;
      })
      .join("");
    return `<li class="trip-history-entry">
      <div class="trip-history-entry-head">
        <span class="trip-history-entry-emoji">${h.leftEarly ? "🚪" : "🏁"}</span>
        <div>
          <div class="trip-history-entry-title">${h.name || "Поездка"}${h.leftEarly ? '<span class="trip-history-entry-tag">покинуто</span>' : ""}</div>
          ${dateLabel ? `<div class="trip-history-entry-date">${dateLabel}</div>` : ""}
        </div>
      </div>
      <ul class="trip-history-member-list">${members}</ul>
    </li>`;
  }).join("");
}

// ---------- ACTIVITY ADDING ----------
function addStepsEntry(steps, date) {
  const before = new Set(computeAchievements(currentUser.login).filter((a) => a.unlocked).map((a) => a.id));
  const id = randomId();
  const entry = { id, date: date || getTodayStr(), type: "steps", steps, points: pointsForSteps(steps), ts: Date.now() };
  if (!activities[currentUser.login]) activities[currentUser.login] = {};
  activities[currentUser.login][id] = entry;
  if (useCloud) { db.ref(teamPath(`activities/${currentUser.login}/${id}`)).set(entry); mirrorEntryToOtherTeams(id, entry); }
  else persistLocal();
  afterAdd("steps", before);
}
function addWorkoutEntry(type, minutes, calories, date) {
  const before = new Set(computeAchievements(currentUser.login).filter((a) => a.unlocked).map((a) => a.id));
  const id = randomId();
  const entry = { id, date: date || getTodayStr(), type: "workout", workoutType: type, workoutMinutes: minutes, workoutCalories: calories || null, points: pointsForWorkout(minutes, type), ts: Date.now() };
  if (!activities[currentUser.login]) activities[currentUser.login] = {};
  activities[currentUser.login][id] = entry;
  if (useCloud) { db.ref(teamPath(`activities/${currentUser.login}/${id}`)).set(entry); mirrorEntryToOtherTeams(id, entry); }
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

// ---------- CROSS-TEAM ACTIVITY SYNC ----------
// If the signed-in account belongs to more than one team, a single steps/
// workout entry logged while one team is active should count toward every
// team's goal, not just the currently open one — so it's mirrored as a
// full independent copy into each OTHER team's activities/{login}/{id}
// node. The entry id (randomId(), timestamp + random suffix) is reused as
// the key everywhere it's mirrored, which is what lets a later edit or
// delete find and update every copy by that same id, keeping all of them
// in sync. Each team still computes its own totals/points/streak the
// normal way (summing whatever is in its own activities node) — nothing
// else needs to change for a mirrored entry to count correctly there.
// Cloud-only: local demo mode has no concept of "other teams".
async function otherTeamMemberships() {
  if (!useCloud || !firebase.auth().currentUser) return [];
  const uid = firebase.auth().currentUser.uid;
  const snap = await db.ref(`users/${uid}/memberships`).once("value");
  const memberships = snap.val() || {};
  return Object.keys(memberships)
    .filter((tid) => tid !== activeTeamId && memberships[tid] && memberships[tid].login)
    .map((tid) => ({ teamId: tid, login: memberships[tid].login }));
}

// Writes the full entry object (as-is) into every other team the account
// belongs to — used for both creating a new entry and saving edits to an
// existing one, since either way every copy should end up identical.
async function mirrorEntryToOtherTeams(id, entry) {
  const others = await otherTeamMemberships();
  if (!others.length) return;
  const updates = {};
  others.forEach(({ teamId, login }) => { updates[`teams/${teamId}/activities/${login}/${id}`] = entry; });
  await db.ref().update(updates);
}

// Removes the entry (and any comments/reactions left on it) from every
// other team's copy, mirroring a delete the same way creates/edits are.
async function removeEntryFromOtherTeams(id) {
  const others = await otherTeamMemberships();
  if (!others.length) return;
  const updates = {};
  others.forEach(({ teamId, login }) => {
    updates[`teams/${teamId}/activities/${login}/${id}`] = null;
    updates[`teams/${teamId}/comments/${id}`] = null;
    updates[`teams/${teamId}/reactions/${id}`] = null;
  });
  await db.ref().update(updates);
}

// Refreshes otherTeamsLiveStats: for every OTHER team this account is
// still an active member of (still-open memberships, not left/closed
// ones — those are covered separately by the personalGoals snapshots),
// does a one-time read of that team's own activities/{login} and summarizes
// it exactly like a live totals computation would. Not a permanent
// listener (that would mean subscribing to every team someone's ever
// joined, all the time) — called after entering/switching teams and when
// opening the Профиль tab, which is frequent enough to stay accurate
// without the overhead. See computeLifetimeStats for how this is combined
// with the active team's own live totals and other teams' closed snapshots.
async function refreshOtherTeamsLiveStats() {
  const others = await otherTeamMemberships();
  if (!others.length) { otherTeamsLiveStats = {}; return; }
  const entries = await Promise.all(others.map(async ({ teamId, login }) => {
    const snap = await db.ref(`teams/${teamId}/activities/${login}`).once("value");
    return [teamId, summarizeActivityEntries(snap.val())];
  }));
  const next = {};
  entries.forEach(([teamId, stats]) => { next[teamId] = stats; });
  otherTeamsLiveStats = next;
}

function showToast(emoji, text) {
  const t = $("#toast");
  $("#toastEmoji").textContent = emoji;
  $("#toastText").textContent = text;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

// ---------- THEME ----------
// Device display preference, not account data — deliberately NOT synced
// through Firebase (each phone/browser keeps its own choice, same as most
// apps' light/dark toggle). Persisted to localStorage under the same key
// the inline <script> in index.html's <head> reads before first paint, so
// a returning person who picked "Светлая" never sees a flash of dark first.
function applyTheme(theme) {
  currentTheme = theme === "light" ? "light" : "dark";
  if (currentTheme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("tc_theme", currentTheme); } catch (e) {}
  document.querySelectorAll("#themeSegmented .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.themeChoice === currentTheme);
  });
}
// Picks up whatever the inline <head> script already applied (or the OS
// default if nothing was saved yet) — called once at boot so currentTheme
// and the segmented control agree with what's actually on screen.
function initTheme() {
  const saved = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  applyTheme(saved);
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
  if (tab === "recipes") renderRecipes();
  if (tab === "profile") {
    renderProfile(); // also renders the Награды card inside it — see renderProfile
    // Refresh other-teams live totals on the way in too (not just on team
    // switch), so numbers stay fresh if activity was logged elsewhere
    // since the last refresh; re-render once resolved.
    refreshOtherTeamsLiveStats().then(() => { if (currentTab === "profile") renderProfile(); });
  }
}

// ---------- APP BOOT ----------
function showApp() {
  $("#loginScreen").hidden = true;
  $("#teamGateScreen").hidden = true;
  $("#appScreen").hidden = false;
  switchTab("home");
}

// Switches the Войти/Регистрация toggle on the login screen — shared by the
// tab buttons themselves and by "Назад" on the team-gate screen, which
// resets back to "Войти" for a clean slate.
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  $("#authModeSegmented").querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#nameField").hidden = !registering;
  $("#nameInput").required = registering;
  $("#loginSubmitBtn").textContent = registering ? "Зарегистрироваться ✈️" : "Войти ✈️";
  $("#loginHint").textContent = registering
    ? "Придумайте пароль от 6 символов — аккаунт создастся автоматически."
    : "Введите email и пароль, которые вы уже использовали.";
  $("#loginError").hidden = true;
}

function wireEvents() {
  $("#authModeSegmented").querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => setAuthMode(btn.dataset.mode));
  });

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#nameInput").value.trim();
    const email = $("#loginInput").value;
    const password = $("#passwordInput").value;
    const btn = $("#loginSubmitBtn");
    const registering = authMode === "register";
    btn.disabled = true;
    btn.textContent = registering ? "Регистрируем..." : "Входим...";
    const result = await attemptLogin(email, password, authMode);
    btn.disabled = false;
    btn.textContent = registering ? "Зарегистрироваться ✈️" : "Войти ✈️";
    if (!result.ok) {
      $("#loginError").textContent = result.error;
      $("#loginError").hidden = false;
      return;
    }
    $("#loginError").hidden = true;
    if (!useCloud) {
      // Local demo mode already resolved currentUser inside attemptLogin.
      localStorage.setItem("tc_session", currentUser.login);
      showApp();
      return;
    }
    await enterTeam(result.uid, result.email, name);
  });

  $("#teamGateSegmented").querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#teamGateSegmented").querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      const mode = btn.dataset.gate;
      $("#createTeamForm").hidden = mode !== "create";
      $("#joinTeamForm").hidden = mode !== "join";
    });
  });

  $("#createTeamForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pendingAuth) return;
    const name = $("#teamNameInput").value.trim();
    const destination = $("#teamDestinationInput").value.trim();
    const tripDate = $("#teamTripDateInput").value;
    if (!name || !destination || !tripDate) return;
    const btn = $("#createTeamBtn");
    btn.disabled = true;
    btn.textContent = "Создаём...";
    try {
      const { teamId, login } = await createTeam(pendingAuth.uid, name, tripDate, pendingAuth.displayName || "Без имени", destination);
      $("#createTeamError").hidden = true;
      await activateTeam(teamId, login);
    } catch (err) {
      console.warn("Не удалось создать команду:", err);
      $("#createTeamError").textContent = "Не удалось создать команду. Проверьте соединение и попробуйте ещё раз.";
      $("#createTeamError").hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Создать команду";
    }
  });

  $("#joinTeamForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pendingAuth) return;
    const code = $("#teamCodeInput").value.trim();
    if (!code) return;
    const btn = $("#joinTeamBtn");
    btn.disabled = true;
    btn.textContent = "Присоединяемся...";
    const result = await joinTeamByCode(pendingAuth.uid, code, pendingAuth.displayName || "Без имени");
    btn.disabled = false;
    btn.textContent = "Присоединиться";
    if (result.error) {
      $("#joinTeamError").textContent = result.error;
      $("#joinTeamError").hidden = false;
      return;
    }
    $("#joinTeamError").hidden = true;
    await activateTeam(result.teamId, result.login);
  });

  $("#teamGateBackBtn").addEventListener("click", () => {
    if (teamGateMode === "addTeam") {
      // Just came from "Вступить ещё в одну команду" mid-session — go back
      // to the app, not log out of it.
      pendingAuth = null;
      $("#teamGateScreen").hidden = true;
      showApp();
      switchTab("profile");
      return;
    }
    logout(); // signs out of the just-created/just-signed-in session and shows the login screen again
    setAuthMode("login");
  });

  // Signing out only lives in Профиль now — the home header's icon is the
  // notifications bell instead (see #notifBtn below).
  $("#logoutBtn2").addEventListener("click", logout);

  $("#notifBtn").addEventListener("click", () => {
    switchTab("feed");
    markNotificationsSeen();
  });

  $("#copyInviteBtn").addEventListener("click", async () => {
    const code = activeTeamMeta.inviteCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast("📋", "Код скопирован!");
    } catch (e) {
      showToast("⚠️", "Не удалось скопировать — выделите код вручную");
    }
  });

  // "Вступить ещё в одну команду" reuses the same create/join screen as
  // login, just mid-session: seeds pendingAuth from the live Firebase Auth
  // session (rather than clearing currentUser) so createTeamForm/joinTeamForm
  // work completely unchanged, and marks the mode as "addTeam" so the
  // "Назад" button returns to the app instead of logging out.
  $("#joinAnotherTeamBtn").addEventListener("click", () => {
    if (!useCloud || !firebase.auth().currentUser || !currentUser) return;
    pendingAuth = { uid: firebase.auth().currentUser.uid, email: firebase.auth().currentUser.email, displayName: currentUser.name };
    teamGateMode = "addTeam";
    showTeamGate();
  });

  $("#switchTeamBtn").addEventListener("click", async () => {
    const list = $("#teamSwitchList");
    if (!list.hidden) { list.hidden = true; return; }
    if (!useCloud || !firebase.auth().currentUser) return;
    list.hidden = false;
    list.innerHTML = `<div class="team-switch-loading">Загружаем...</div>`;
    const uid = firebase.auth().currentUser.uid;
    const snap = await db.ref(`users/${uid}/memberships`).once("value");
    const memberships = snap.val() || {};
    const teamIds = Object.keys(memberships);
    if (teamIds.length <= 1) {
      list.innerHTML = `<div class="team-switch-empty">Вы состоите только в этой команде</div>`;
      return;
    }
    const rows = await Promise.all(teamIds.map(async (teamId) => {
      const metaSnap = await db.ref(`teams/${teamId}/meta/name`).once("value");
      const name = metaSnap.val() || "Команда";
      const isActive = teamId === activeTeamId;
      return `<button type="button" class="team-switch-item${isActive ? " active" : ""}" data-team-id="${teamId}" ${isActive ? "disabled" : ""}>
        <span class="team-switch-item-name">${name}</span>
        <span class="team-switch-item-status">${isActive ? "сейчас здесь" : "перейти →"}</span>
      </button>`;
    }));
    list.innerHTML = rows.join("");
  });

  $("#teamSwitchList").addEventListener("click", async (e) => {
    const btn = e.target.closest(".team-switch-item");
    if (!btn || btn.disabled) return;
    const teamId = btn.dataset.teamId;
    $("#teamSwitchList").hidden = true;
    await switchToTeam(teamId);
    showToast("🔀", "Команда переключена!");
  });

  $("#leaveTeamBtn").addEventListener("click", async () => {
    if (!currentUser) return;
    const teamName = activeTeamMeta.name || "этой команды";
    if (!window.confirm(`Выйти из «${teamName}»? Ваша активность останется в истории команды, но вы перестанете быть участником.`)) return;
    await leaveTeam(activeTeamId);
    showToast("👋", "Вы вышли из команды");
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("#openStepsModal").addEventListener("click", () => {
    editingEntryId = null;
    $("#stepsModalTitle").textContent = "Добавить шаги";
    $("#saveStepsBtn").textContent = "Сохранить";
    $("#stepsInput").value = "";
    $("#stepsDate").max = getTodayStr();
    $("#stepsDate").value = getTodayStr();
    openModal("stepsModal");
  });
  $("#openWorkoutModal").addEventListener("click", () => {
    editingEntryId = null;
    $("#workoutModalTitle").textContent = "Добавить тренировку";
    $("#saveWorkoutBtn").textContent = "Сохранить";
    $("#workoutMinutes").value = "";
    $("#workoutCalories").value = "";
    $("#workoutDate").max = getTodayStr();
    $("#workoutDate").value = getTodayStr();
    openModal("workoutModal");
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => { closeModal(btn.dataset.close); editingEntryId = null; editingRecipeId = null; });
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
    mb.addEventListener("click", (e) => { if (e.target === mb) { mb.hidden = true; editingEntryId = null; editingRecipeId = null; } });
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

  wireSegmented("#themeSegmented", "themeChoice", (val) => { applyTheme(val); rerenderCurrentTab(); }); // re-render so the home chart's point-ring color (see renderWeekChart) updates immediately, not just on the next tab switch
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

  $("#activityInfoToggle").addEventListener("click", () => {
    const body = $("#activityInfoBody");
    body.hidden = !body.hidden;
  });

  $("#tripHistoryToggle").addEventListener("click", () => {
    const body = $("#tripHistoryBody");
    const chevron = $("#tripHistoryChevron");
    const willOpen = body.hidden;
    body.hidden = !willOpen;
    chevron.classList.toggle("open", willOpen);
  });

  $("#teamCardToggle").addEventListener("click", () => {
    const body = $("#teamCardBody");
    const chevron = $("#teamCardChevron");
    const willOpen = body.hidden;
    body.hidden = !willOpen;
    chevron.classList.toggle("open", willOpen);
  });

  $("#achToggle").addEventListener("click", () => {
    const body = $("#achBody");
    const chevron = $("#achChevron");
    const willOpen = body.hidden;
    body.hidden = !willOpen;
    chevron.classList.toggle("open", willOpen);
  });

  // ---- Recipes ----
  $("#addRecipeBtn").addEventListener("click", () => openRecipeForm());

  $("#recipeSearchInput").addEventListener("input", (e) => {
    recipeSearchQuery = e.target.value;
    renderRecipes();
  });

  wireSegmented("#recipeCategorySegmented", "category", (val) => {
    recipeCategoryFilter = val;
    renderRecipes();
  });

  $("#recipeMineChip").addEventListener("click", () => {
    recipeMineOnly = !recipeMineOnly;
    $("#recipeMineChip").classList.toggle("active", recipeMineOnly);
    renderRecipes();
  });

  wireSegmented("#recipeCategoryFormSegmented", "category", (val) => { recipeFormCategory = val; });

  $("#addIngredientBtn").addEventListener("click", () => addIngredientRow());

  $("#recipeNoMacrosCheckbox").addEventListener("change", (e) => applyRecipeMacrosState(e.target.checked));

  $("#saveRecipeBtn").addEventListener("click", saveRecipeFromForm);

  $("#recipeList").addEventListener("click", (e) => {
    const card = e.target.closest(".recipe-card");
    if (!card) return;
    openRecipeDetail(card.dataset.id);
  });

  $("#editRecipeBtn").addEventListener("click", () => {
    const r = recipes[viewingRecipeId];
    if (!r) return;
    closeModal("recipeDetailModal");
    openRecipeForm({ ...r, id: viewingRecipeId });
  });

  $("#deleteRecipeBtn").addEventListener("click", () => {
    if (!viewingRecipeId) return;
    if (!window.confirm("Удалить этот рецепт без возможности восстановления?")) return;
    deleteRecipe(viewingRecipeId);
    closeModal("recipeDetailModal");
    showToast("🗑️", "Рецепт удалён");
  });

  function updateAvatarPreview() {
    const avatar = ($("#avatarGrid .avatar-choice.selected") || {}).dataset?.avatar || currentUser.avatar;
    const gradient = ($("#gradientGrid .gradient-choice.selected") || {}).dataset?.gradient || currentUser.avatarGradient;
    $("#avatarPreviewImg").src = avatarSrc(avatar);
    $("#avatarPreview").style.background = gradCss(gradient);
  }

  $("#editProfileBtn").addEventListener("click", () => {
    $("#profileNameInput").value = currentUser.name;
    document.querySelectorAll("#avatarGrid .avatar-choice").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.avatar === currentUser.avatar);
    });
    document.querySelectorAll("#gradientGrid .gradient-choice").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.gradient === (currentUser.avatarGradient || DEFAULT_AVATAR_GRADIENT));
    });
    updateAvatarPreview();
    openModal("profileModal");
  });

  $("#avatarGrid").addEventListener("click", (e) => {
    const btn = e.target.closest(".avatar-choice");
    if (!btn) return;
    document.querySelectorAll("#avatarGrid .avatar-choice").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    updateAvatarPreview();
  });

  $("#gradientGrid").addEventListener("click", (e) => {
    const btn = e.target.closest(".gradient-choice");
    if (!btn) return;
    document.querySelectorAll("#gradientGrid .gradient-choice").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    updateAvatarPreview();
  });

  $("#saveProfileBtn").addEventListener("click", () => {
    const name = $("#profileNameInput").value.trim();
    if (!name) return;
    const selectedAvatarBtn = $("#avatarGrid .avatar-choice.selected");
    const avatar = selectedAvatarBtn ? selectedAvatarBtn.dataset.avatar : currentUser.avatar;
    const selectedGradientBtn = $("#gradientGrid .gradient-choice.selected");
    const avatarGradient = selectedGradientBtn ? selectedGradientBtn.dataset.gradient : (currentUser.avatarGradient || DEFAULT_AVATAR_GRADIENT);
    closeModal("profileModal");
    saveProfile(currentUser.login, { name, avatar, avatarGradient });
    showToast("✏️", "Профиль обновлён!");
    rerenderCurrentTab();
  });

  $("#editGoalBtn").addEventListener("click", () => {
    $("#stepsGoalInput").value = currentUser.dailyGoal || DAILY_STEP_GOAL;
    openModal("editGoalModal");
  });

  $("#saveGoalBtn").addEventListener("click", () => {
    let goal = parseInt($("#stepsGoalInput").value, 10);
    if (!goal || goal < 1000) goal = DAILY_STEP_GOAL;
    if (goal > 30000) goal = 30000;
    closeModal("editGoalModal");
    saveProfile(currentUser.login, { dailyGoal: goal });
    showToast("👣", "Цель обновлена!");
    rerenderCurrentTab();
  });

  $("#editTripBtn").addEventListener("click", () => {
    tripModalMode = "edit";
    $("#editTripModalTitle").textContent = "Изменить поездку ✈️";
    $("#tripNameInput").value = activeTeamMeta.name || "";
    $("#tripDestinationInput").value = activeTeamMeta.destination || "";
    $("#tripDateInput").value = formatDate(activeTripDate);
    $("#editTripError").hidden = true;
    openModal("editTripModal");
  });

  $("#startNewGoalBtn").addEventListener("click", () => {
    tripModalMode = "new";
    $("#editTripModalTitle").textContent = "Новая цель ✈️";
    $("#tripNameInput").value = "";
    $("#tripDestinationInput").value = "";
    $("#tripDateInput").value = "";
    $("#editTripError").hidden = true;
    openModal("editTripModal");
  });

  $("#saveTripBtn").addEventListener("click", () => {
    if (!isTeamOwner()) { closeModal("editTripModal"); return; } // defense in depth — button is already hidden for non-owners
    const name = $("#tripNameInput").value.trim();
    const destination = $("#tripDestinationInput").value.trim();
    const tripDate = $("#tripDateInput").value;
    if (!name || !destination || !tripDate) {
      $("#editTripError").hidden = false;
      return;
    }
    const patch = { name, destination, tripDate };
    if (tripModalMode === "new") {
      Object.assign(patch, { status: "active", closedAt: null, createdAt: Date.now() });
    }
    closeModal("editTripModal");
    saveTripMeta(patch);
    showToast("✈️", tripModalMode === "new" ? "Новая цель запущена!" : "Данные поездки обновлены!");
    rerenderCurrentTab();
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
  initTheme(); // sync currentTheme/segmented control with what the inline <head> script already applied
  await loadUsersData(); // seeds USERS for local demo mode / before a team loads
  initFirebaseApp();
  wireEvents();

  const hint = $("#loginHint");
  if (hint) {
    hint.textContent = useCloud
      ? "Введите email и пароль, которые вы уже использовали."
      : "⚠️ Firebase не настроен — доступны только исходные участницы, без пароля, только на этом устройстве (демо-режим).";
  }

  if (useCloud && typeof firebase !== "undefined" && firebase.auth) {
    // Firebase persists its own session — restore it automatically if present.
    let restoring = false;
    firebase.auth().onAuthStateChanged(async (fbUser) => {
      if (fbUser && fbUser.email && !currentUser && !restoring) {
        restoring = true;
        await enterTeam(fbUser.uid, fbUser.email, "");
        restoring = false;
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
