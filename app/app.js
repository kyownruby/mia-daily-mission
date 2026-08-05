// ============================================================
// デイリーミッション型タスク管理アプリ（Firebase対応版）
// - 認証: Firebase Authentication（Google + Email/Password）
// - 保存: Cloud Firestore（users/{uid} + tasks サブコレクション）
// - 同期: onSnapshot によるリアルタイム同期 + オフライン永続化
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  doc,
  collection,
  query,
  orderBy,
  onSnapshot,
  runTransaction,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ============================================================
// 定数（仕様書 5.2 / 調整可能）
// ============================================================

const DEFAULT_CONFIG = {
  dailyPtCap: 100,   // DAILY_PT_CAP: 1日のPt上限
  ptStep: 5,         // PT_STEP: タスクPtの設定単位
  expPerStep: 10,    // EXP_PER_STEP: 25Ptごとの獲得EXP
  stepPt: 25,        // STEP_PT: EXP付与のPt区切り
  dailyBonusExp: 20, // DAILY_BONUS_EXP: 100Pt達成ボーナスEXP
};

// 経験値テーブル：LEVEL_TABLE[i] = レベル(i+1) → (i+2) に必要なEXP
// テーブルの最後以降は、最終値を繰り返す（上限レベルなし）
const LEVEL_TABLE = [50, 80, 120, 170, 230, 300, 380, 470, 570, 680];

// 日次リセットの基準タイムゾーン（仕様書 4.4）
const BASE_TIMEZONE = "Asia/Tokyo";

// 並び順（order）の採番間隔。間に挿入するときは前後の中間値を使う
const ORDER_STEP = 1000;

// フォームの報酬Pt初期値（タイプ切り替え時にセット）
const COUNTER_DEFAULT_PT = 25; // カウンター式の初期Pt
const SIMPLE_DEFAULT_PT = 25;  // 1回完了式の初期Pt（カウンター式と25で統一）

// ============================================================
// 純粋ロジック（Pt → EXP → レベル）
// ============================================================

// 基準TZでの今日の日付を "YYYY-MM-DD" で返す
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BASE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// 本日のPtから「本日獲得すべきEXP」を算出する（仕様書 9.1 / 9.2 の中核）
// しきい値（25/50/75/100）の到達数 × EXP_PER_STEP ＋ 上限達成ボーナス
function calcExpForPt(pt, config) {
  const maxSteps = Math.floor(config.dailyPtCap / config.stepPt);
  const steps = Math.min(Math.floor(pt / config.stepPt), maxSteps);
  let exp = steps * config.expPerStep;
  if (pt >= config.dailyPtCap) exp += config.dailyBonusExp;
  return exp;
}

// 累積EXPから現在レベル・レベル内EXP・次レベルまでの必要EXPを算出
// （EXPが減ればレベルも下がる＝レベルダウン対応）
function levelFromExp(totalExp) {
  let level = 1;
  let cum = 0;
  let i = 0;
  while (true) {
    const req = LEVEL_TABLE[Math.min(i, LEVEL_TABLE.length - 1)];
    if (totalExp >= cum + req) {
      cum += req;
      level++;
      i++;
    } else {
      return { level, expIntoLevel: totalExp - cum, expForNext: req };
    }
  }
}

// 新規ユーザーの初期データ
function initialUserData(today) {
  return {
    account: { level: 1, totalExp: 0 },
    daily: {
      date: today,
      todayPt: 0,
      earnedExpToday: 0,
      dailyBonusClaimed: false,
      completedTaskIds: [],
      appliedPt: {}, // タスクごとの「実際に加算されたPt」（上限切り捨て後）。取り消しの正確な復元に使う
      counters: {},  // カウンター式ミッションの現在カウント { taskId: n }。daily側に持つので日次で自動リセット
      subDone: {},   // サブタスクの完了状態 { taskId: { subId: true } }。daily側なので日次で自動リセット
    },
    config: { ...DEFAULT_CONFIG },
  };
}

// 日付が変わっていたら daily をリセットした状態を返す（tasks / account は維持）
function normalizedDaily(data, today) {
  if (data.daily && data.daily.date === today) {
    return { appliedPt: {}, counters: {}, subDone: {}, ...data.daily };
  }
  return {
    date: today,
    todayPt: 0,
    earnedExpToday: 0,
    dailyBonusClaimed: false,
    completedTaskIds: [],
    appliedPt: {},
    counters: {},
    subDone: {},
  };
}

// "YYYY-MM-DD" に日数を加算して "YYYY-MM-DD" で返す（タイムゾーン非依存の純粋計算）
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

// メインミッションの累積Ptから「メイン由来のEXP」を算出する（仕様書 4.2）
// 25Ptごとに10EXP。デイリーの100Pt達成ボーナスは適用しない・上限なし
function mainExpForPt(pt, config) {
  return Math.floor(pt / config.stepPt) * config.expPerStep;
}

// タスクのサブタスク配列（simpleのみ。無ければ空配列）
function taskSubtasks(task) {
  return task.type !== "counter" && Array.isArray(task.subtasks) ? task.subtasks : [];
}

// プリセットのサブタスク配列（simpleのみ。無ければ空配列）
function presetSubtasks(preset) {
  return preset.type !== "counter" && Array.isArray(preset.subtasks) ? preset.subtasks : [];
}

// ============================================================
// 並び順（order）
// ============================================================

// createdAt順で渡された配列を order 順に並べ替える。
// order を持たない旧データは -Infinity 扱いで、createdAt順のまま先頭側に残す
// （並び替え操作をした時点で全件に order が振られ、以降は order だけで決まる）
function sortByOrder(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ao = typeof a.item.order === "number" ? a.item.order : -Infinity;
      const bo = typeof b.item.order === "number" ? b.item.order : -Infinity;
      if (ao !== bo) return ao - bo;
      return a.index - b.index; // 同値・旧データ同士は createdAt 順を維持
    })
    .map((x) => x.item);
}

// 末尾に追加するときの order（既存の最大値 + ORDER_STEP）
function nextOrder(items) {
  const orders = items.map((i) => i.order).filter((o) => typeof o === "number");
  return (orders.length ? Math.max(...orders) : 0) + ORDER_STEP;
}

// 並び替え後の order を計算する。
// 移動先の前後の中間値を返す。全件に order が無い／間隔が詰まりすぎた場合は null
// （呼び出し側で全件振り直しにフォールバックする）
function orderForPosition(items, toIndex) {
  const all = items.every((i) => typeof i.order === "number");
  if (!all) return null;

  const prev = toIndex > 0 ? items[toIndex - 1].order : null;
  const next = toIndex < items.length ? items[toIndex].order : null;

  if (prev === null && next === null) return ORDER_STEP;
  if (prev === null) return next - ORDER_STEP;
  if (next === null) return prev + ORDER_STEP;

  const mid = (prev + next) / 2;
  // 間隔が詰まって整数で表現できなくなったら振り直しへ
  if (mid <= prev || mid >= next) return null;
  return mid;
}

// 期限が早い順（期限なしは末尾）に収まる位置の order を返す。
// メインミッションの追加・移動・期限変更のときだけ使う（ドラッグでの手動並びは維持する）
// items は現在の並び（order順）。excludeId を渡すとその要素を除いて位置を決める
function orderForDueDate(items, dueDate, excludeId = null) {
  const list = excludeId ? items.filter((i) => i.id !== excludeId) : items;
  const key = (d) => d || "9999-12-31"; // 期限なしは一番後ろ扱い
  const k = key(dueDate);

  let index = list.length;
  for (let i = 0; i < list.length; i++) {
    if (key(list[i].dueDate) > k) { index = i; break; }
  }

  const order = orderForPosition(list, index);
  // 中間値が作れない稀なケースは末尾へ（並びが壊れるより安全）
  return order === null ? nextOrder(list) : order;
}

// ============================================================
// Firebase 初期化
// ============================================================

// ============================================================
// アイコン（インラインSVG）
// ============================================================

const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4"/><path d="M3 8h13"/><path d="m17 12 4 4-4 4"/><path d="M21 16H8"/></svg>',
};

// アイコンボタンを作る（aria-label / title 付き）
function iconButton(iconName, label, className) {
  const btn = document.createElement("button");
  btn.className = className;
  btn.innerHTML = ICONS[iconName];
  btn.setAttribute("aria-label", label);
  btn.title = label;
  return btn;
}

const configured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");

const $ = (id) => document.getElementById(id);

if (!configured) {
  $("setup-notice").classList.remove("hidden");
  throw new Error("firebase-config.js が未設定です。app/README.md を参照してください。");
}

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache(), // オフライン永続化（仕様書 8）
});

// ============================================================
// 画面状態
// ============================================================

let currentUser = null;
let userData = null;   // users/{uid} ドキュメントの内容
let tasks = [];        // tasks サブコレクションの内容
let mainTasks = [];    // mainTasks サブコレクションの内容（メインミッション）
let presets = [];      // presets サブコレクションの内容
let lastLevel = null;  // レベルアップ演出用
let editingTaskId = null;
let editingMainId = null;
let editingPresetId = null;
let expandedTasks = new Set(); // サブタスクを開いているタスクID（デフォルトは閉じ）
let activeTab = "daily"; // "daily" | "main" | "preset"
let authMode = "login"; // "login" | "signup"
let unsubUserDoc = null;
let unsubTasks = null;
let unsubMain = null;
let unsubPresets = null;

const userRef = (uid) => doc(db, "users", uid);
const tasksRef = (uid) => collection(db, "users", uid, "tasks");
const mainTasksRef = (uid) => collection(db, "users", uid, "mainTasks");
const presetsRef = (uid) => collection(db, "users", uid, "presets");

// ============================================================
// 認証
// ============================================================

const AUTH_ERROR_MESSAGES = {
  "auth/invalid-email": "メールアドレスの形式が正しくないよ",
  "auth/user-not-found": "このメールアドレスのアカウントが見つからないよ",
  "auth/wrong-password": "パスワードが違うみたい",
  "auth/invalid-credential": "メールアドレスかパスワードが違うみたい",
  "auth/email-already-in-use": "このメールアドレスはすでに登録されているよ",
  "auth/weak-password": "パスワードは6文字以上にしてね",
  "auth/too-many-requests": "試行回数が多すぎるよ。少し時間をおいてね",
  "auth/popup-closed-by-user": "ログインがキャンセルされたよ",
  "auth/network-request-failed": "ネットワークエラーだよ。接続を確認してね",
};

function showAuthError(err) {
  const msg = AUTH_ERROR_MESSAGES[err.code] || `エラーが発生したよ（${err.code || err.message}）`;
  $("auth-error").textContent = msg;
  $("auth-error").classList.remove("hidden");
  $("auth-info").classList.add("hidden");
}

function showAuthInfo(msg) {
  $("auth-info").textContent = msg;
  $("auth-info").classList.remove("hidden");
  $("auth-error").classList.add("hidden");
}

function clearAuthMessages() {
  $("auth-error").classList.add("hidden");
  $("auth-info").classList.add("hidden");
}

$("google-login-btn").addEventListener("click", async () => {
  clearAuthMessages();
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    showAuthError(err);
  }
});

$("email-submit-btn").addEventListener("click", async () => {
  clearAuthMessages();
  const email = $("email-input").value.trim();
  const password = $("password-input").value;
  if (!email || !password) {
    showAuthError({ code: "", message: "メールアドレスとパスワードを入力してね" });
    return;
  }
  try {
    if (authMode === "signup") {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    showAuthError(err);
  }
});

$("auth-switch-link").addEventListener("click", (e) => {
  e.preventDefault();
  clearAuthMessages();
  authMode = authMode === "login" ? "signup" : "login";
  const isLogin = authMode === "login";
  $("email-submit-btn").textContent = isLogin ? "ログイン" : "新規登録";
  $("auth-switch-label").textContent = isLogin
    ? "アカウントをお持ちでない方は"
    : "すでにアカウントをお持ちの方は";
  $("auth-switch-link").textContent = isLogin ? "新規登録" : "ログイン";
});

$("password-reset-link").addEventListener("click", async (e) => {
  e.preventDefault();
  clearAuthMessages();
  const email = $("email-input").value.trim();
  if (!email) {
    showAuthError({ code: "", message: "先にメールアドレスを入力してね" });
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    showAuthInfo("パスワード再設定メールを送ったよ。受信箱を確認してね📮");
  } catch (err) {
    showAuthError(err);
  }
});

$("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    $("auth-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("user-label").textContent = user.displayName || user.email || "";
    lastLevel = null;
    await ensureUserDocAndDailyReset(user.uid);
    subscribeUserData(user.uid);
  } else {
    unsubscribeAll();
    userData = null;
    tasks = [];
    mainTasks = [];
    presets = [];
    lastLevel = null;
    expandedTasks = new Set();
    cancelEdit();
    cancelMainEdit();
    cancelPresetEdit();
    setActiveTab("daily");
    $("app-view").classList.add("hidden");
    $("auth-view").classList.remove("hidden");
  }
});

function unsubscribeAll() {
  if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
  if (unsubMain) { unsubMain(); unsubMain = null; }
  if (unsubPresets) { unsubPresets(); unsubPresets = null; }
}

// ============================================================
// タブ切り替え（ステータスエリアは共通で常に表示）
// ============================================================

function setActiveTab(tab) {
  activeTab = tab;
  for (const name of ["daily", "main", "preset"]) {
    $(`tab-${name}`).classList.toggle("hidden", name !== tab);
    $(`tab-btn-${name}`).classList.toggle("active", name === tab);
  }
}
for (const name of ["daily", "main", "preset"]) {
  $(`tab-btn-${name}`).addEventListener("click", () => setActiveTab(name));
}

// ============================================================
// Firestore：初期化・日次リセット・購読
// ============================================================

// 初回ログイン時のドキュメント作成＋日次リセット（仕様書 9.3）
async function ensureUserDocAndDailyReset(uid) {
  const today = todayStr();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(userRef(uid));
      if (!snap.exists()) {
        tx.set(userRef(uid), initialUserData(today));
        return;
      }
      const data = snap.data();
      if (!data.daily || data.daily.date !== today) {
        tx.update(userRef(uid), { daily: normalizedDaily(data, today) });
      }
    });
  } catch (err) {
    console.error("日次リセット処理に失敗:", err);
    showToast("データの読み込みに失敗したよ…再読み込みしてみてね");
  }
}

function subscribeUserData(uid) {
  unsubscribeAll();

  unsubUserDoc = onSnapshot(
    userRef(uid),
    { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) return;
      userData = snap.data();
      updateSyncStatus(snap.metadata.hasPendingWrites);
      render();
    },
    (err) => console.error("ユーザーデータの購読エラー:", err)
  );

  // クエリは createdAt 順のまま（order 未設定の旧データも必ず取得されるように）、
  // 表示順は sortByOrder でクライアント側に決めさせる
  unsubTasks = onSnapshot(
    query(tasksRef(uid), orderBy("createdAt", "asc")),
    (snap) => {
      tasks = sortByOrder(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      render();
    },
    (err) => console.error("タスクの購読エラー:", err)
  );

  unsubMain = onSnapshot(
    query(mainTasksRef(uid), orderBy("createdAt", "asc")),
    (snap) => {
      mainTasks = sortByOrder(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      renderMainSafe();
    },
    (err) => console.error("メインミッションの購読エラー:", err)
  );

  unsubPresets = onSnapshot(
    query(presetsRef(uid), orderBy("createdAt", "asc")),
    (snap) => {
      presets = sortByOrder(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      renderPresets();
    },
    (err) => console.error("プリセットの購読エラー:", err)
  );
}

// ============================================================
// 同期状態インジケーター
// ============================================================

function updateSyncStatus(pendingWrites) {
  const el = $("sync-status");
  if (!navigator.onLine) {
    el.textContent = "オフライン";
    el.className = "sync-status offline";
  } else if (pendingWrites) {
    el.textContent = "同期中…";
    el.className = "sync-status syncing";
  } else {
    el.textContent = "保存済み ✓";
    el.className = "sync-status saved";
  }
}

window.addEventListener("online", () => updateSyncStatus(false));
window.addEventListener("offline", () => updateSyncStatus(false));

// ============================================================
// タスク完了・取り消し（仕様書 9.1 / 9.2：トランザクションで整合性を保つ）
// ============================================================

async function completeTask(task) {
  const { id: taskId, rewardPt } = task;
  const uid = currentUser.uid;
  const today = todayStr();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(userRef(uid));
      if (!snap.exists()) throw new Error("ユーザーデータがありません");
      const data = snap.data();
      const config = { ...DEFAULT_CONFIG, ...data.config };
      const daily = normalizedDaily(data, today); // 日付が変わっていたらリセット後の状態で計算

      if (daily.completedTaskIds.includes(taskId)) return; // 二重完了ガード
      // カウンター式は目標達成まで完了不可（UIの無効化だけに頼らない）
      if (task.type === "counter" && (daily.counters[taskId] || 0) < task.targetCount) return;
      // サブタスク持ちは全チェックまで完了不可
      const subs = taskSubtasks(task);
      if (subs.length > 0) {
        const doneMap = daily.subDone[taskId] || {};
        if (!subs.every((s) => doneMap[s.id])) return;
      }

      // 1. Pt加算（上限で頭打ち・超過切り捨て）
      const newPt = Math.min(config.dailyPtCap, daily.todayPt + rewardPt);
      // 2-4. 本日獲得すべきEXPを再計算
      const targetExp = calcExpForPt(newPt, config);
      // 5. 差分を累積EXPに反映
      const newTotalExp = Math.max(0, data.account.totalExp + (targetExp - daily.earnedExpToday));
      // 6. レベル再計算
      const { level } = levelFromExp(newTotalExp);

      tx.update(userRef(uid), {
        // account はスプレッドで保持（mainTotalPt など他のフィールドを消さないため）
        account: { ...data.account, level, totalExp: newTotalExp },
        daily: {
          ...daily,
          todayPt: newPt,
          earnedExpToday: targetExp,
          dailyBonusClaimed: newPt >= config.dailyPtCap,
          completedTaskIds: [...daily.completedTaskIds, taskId],
          // 実際に加算されたPt（切り捨て後）を記録 → 取り消し時に正確に巻き戻せる
          appliedPt: { ...daily.appliedPt, [taskId]: newPt - daily.todayPt },
        },
      });
    });
  } catch (err) {
    console.error("タスク完了処理に失敗:", err);
    showToast("完了の保存に失敗したよ…もう一度試してね");
  }
}

async function uncompleteTask(taskId, rewardPt) {
  const uid = currentUser.uid;
  const today = todayStr();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(userRef(uid));
      if (!snap.exists()) throw new Error("ユーザーデータがありません");
      const data = snap.data();
      const config = { ...DEFAULT_CONFIG, ...data.config };
      const daily = normalizedDaily(data, today);

      if (!daily.completedTaskIds.includes(taskId)) return;

      // 1. Pt減算：完了時に「実際に加算されたPt」を引く（上限で切り捨てられていた場合も正確に復元）
      const applied = daily.appliedPt[taskId] ?? rewardPt;
      const newPt = Math.max(0, daily.todayPt - applied);
      // 2. 本日獲得すべきEXPを再計算
      const targetExp = calcExpForPt(newPt, config);
      // 3. 差分を累積EXPに反映（減る）
      const newTotalExp = Math.max(0, data.account.totalExp + (targetExp - daily.earnedExpToday));
      // 4. レベル再計算（レベルダウン対応）
      const { level } = levelFromExp(newTotalExp);

      const nextApplied = { ...daily.appliedPt };
      delete nextApplied[taskId];

      tx.update(userRef(uid), {
        // account はスプレッドで保持（mainTotalPt など他のフィールドを消さないため）
        account: { ...data.account, level, totalExp: newTotalExp },
        daily: {
          ...daily,
          todayPt: newPt,
          earnedExpToday: targetExp,
          dailyBonusClaimed: newPt >= config.dailyPtCap,
          completedTaskIds: daily.completedTaskIds.filter((id) => id !== taskId),
          appliedPt: nextApplied,
        },
      });
    });
  } catch (err) {
    console.error("取り消し処理に失敗:", err);
    showToast("取り消しの保存に失敗したよ…もう一度試してね");
  }
}

// カウンター式ミッションのカウント操作（±1、0未満にはしない）
async function changeCount(taskId, delta) {
  const uid = currentUser.uid;
  const today = todayStr();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(userRef(uid));
      if (!snap.exists()) throw new Error("ユーザーデータがありません");
      const data = snap.data();
      const daily = normalizedDaily(data, today);

      if (daily.completedTaskIds.includes(taskId)) return; // 完了済みはカウント操作不可

      const current = daily.counters[taskId] || 0;
      const next = Math.max(0, current + delta);
      if (next === current) return;

      tx.update(userRef(uid), {
        daily: { ...daily, counters: { ...daily.counters, [taskId]: next } },
      });
    });
  } catch (err) {
    console.error("カウント更新に失敗:", err);
    showToast("カウントの保存に失敗したよ…もう一度試してね");
  }
}

// サブタスクの完了/未完了をトグル
async function toggleSubtask(taskId, subId, checked) {
  const uid = currentUser.uid;
  const today = todayStr();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(userRef(uid));
      if (!snap.exists()) throw new Error("ユーザーデータがありません");
      const data = snap.data();
      const daily = normalizedDaily(data, today);

      if (daily.completedTaskIds.includes(taskId)) return; // 完了済みの親は操作不可

      const taskDone = { ...(daily.subDone[taskId] || {}) };
      if (checked) {
        taskDone[subId] = true;
      } else {
        delete taskDone[subId];
      }
      tx.update(userRef(uid), {
        daily: { ...daily, subDone: { ...daily.subDone, [taskId]: taskDone } },
      });
    });
  } catch (err) {
    console.error("サブタスク更新に失敗:", err);
    showToast("サブタスクの保存に失敗したよ…もう一度試してね");
  }
}

// ============================================================
// タスクCRUD
// ============================================================

function getConfig() {
  return { ...DEFAULT_CONFIG, ...(userData && userData.config) };
}

function isCompleted(taskId) {
  if (!userData || !userData.daily) return false;
  if (userData.daily.date !== todayStr()) return false; // 日付が変わっていれば未完了扱い
  return (userData.daily.completedTaskIds || []).includes(taskId);
}

function showFormError(msg) {
  $("form-error").textContent = msg;
  $("form-error").classList.remove("hidden");
}

function selectedType(radioName) {
  return document.querySelector(`input[name="${radioName}"]:checked`).value;
}
const selectedTaskType = () => selectedType("task-type");
const selectedMainType = () => selectedType("main-type");
const selectedPresetType = () => selectedType("preset-type");

// タイプ切り替え：目標回数入力の表示切り替え＋報酬Pt初期値のセット
// （編集中はユーザーが設定済みのPtを勝手に書き換えない）
function bindTypeToggle(radioName, targetLabelId, ptSelectId, isEditing) {
  for (const radio of document.querySelectorAll(`input[name="${radioName}"]`)) {
    radio.addEventListener("change", () => {
      const type = selectedType(radioName);
      $(targetLabelId).classList.toggle("hidden", type !== "counter");
      if (!isEditing()) {
        $(ptSelectId).value = String(type === "counter" ? COUNTER_DEFAULT_PT : SIMPLE_DEFAULT_PT);
      }
    });
  }
}
bindTypeToggle("task-type", "task-target-label", "task-pt-select", () => editingTaskId !== null);
bindTypeToggle("main-type", "main-target-label", "main-pt-select", () => editingMainId !== null);
bindTypeToggle("preset-type", "preset-target-label", "preset-pt-select", () => editingPresetId !== null);

// サブタスク編集欄は「1回で完了」のときだけ表示
function updateSubtaskEditorVisibility() {
  taskSubtaskEditor.setVisible(selectedTaskType() === "simple");
}
for (const radio of document.querySelectorAll('input[name="task-type"]')) {
  radio.addEventListener("change", updateSubtaskEditorVisibility);
}

function updateMainSubtaskEditorVisibility() {
  mainSubtaskEditor.setVisible(selectedMainType() === "simple");
}
for (const radio of document.querySelectorAll('input[name="main-type"]')) {
  radio.addEventListener("change", updateMainSubtaskEditorVisibility);
}

function updatePresetSubtaskEditorVisibility() {
  presetSubtaskEditor.setVisible(selectedPresetType() === "simple");
}
for (const radio of document.querySelectorAll('input[name="preset-type"]')) {
  radio.addEventListener("change", updatePresetSubtaskEditorVisibility);
}

// 期限入力の表示切り替え（メイン＝日付／プリセット＝日数）
function bindDueModeToggle(radioName, inputLabelId, showValue) {
  for (const radio of document.querySelectorAll(`input[name="${radioName}"]`)) {
    radio.addEventListener("change", () => {
      $(inputLabelId).classList.toggle("hidden", selectedType(radioName) !== showValue);
    });
  }
}
bindDueModeToggle("main-due-mode", "main-due-date-label", "date");
bindDueModeToggle("preset-due-mode", "preset-due-days-label", "days");

function setDueMode(radioName, inputLabelId, mode, showValue) {
  document.querySelector(`input[name="${radioName}"][value="${mode}"]`).checked = true;
  $(inputLabelId).classList.toggle("hidden", mode !== showValue);
}

// ============================================================
// フォーム内のサブタスク編集（ミッション・プリセットで共通）
// ============================================================

function newSubtaskId() {
  return "sub_" + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
}

// prefix から要素ID（${prefix}-editor / -edit-list / -name-input / -add-btn）を組み立てて
// { get, set, clear, setVisible } の編集用インターフェースを返す
function makeSubtaskEditor(prefix) {
  let items = []; // { id, name } の配列

  const editorEl = $(`${prefix}-editor`);
  const listEl = $(`${prefix}-edit-list`);
  const nameInput = $(`${prefix}-name-input`);
  const addBtn = $(`${prefix}-add-btn`);

  function render() {
    listEl.innerHTML = "";
    items.forEach((st, index) => {
      const li = document.createElement("li");
      li.className = "subtask-edit-item";

      const input = document.createElement("input");
      input.type = "text";
      input.value = st.name;
      input.maxLength = 50;
      input.addEventListener("input", () => { st.name = input.value; });

      const delBtn = iconButton("x", "サブタスクを削除", "btn btn-small btn-icon btn-sq btn-danger-hover");
      delBtn.addEventListener("click", () => {
        items.splice(index, 1);
        render(); // ダイアログなしで即削除
      });

      // ハンドルで並び替え（保存されるのはフォームを保存したとき）
      const handle = makeDragHandle(listEl, () => items, (_arr, from, to) => {
        const [moved] = items.splice(from, 1);
        items.splice(Math.max(0, Math.min(to, items.length)), 0, moved);
        render();
      });

      li.append(handle, input, delBtn);
      listEl.appendChild(li);
    });
  }

  addBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) return;
    items.push({ id: newSubtaskId(), name });
    nameInput.value = "";
    render();
  });

  return {
    // id/name 以外のフィールド（メインミッションの done など）は編集中も保持する
    get: () => items.map((s) => ({ ...s, name: s.name.trim() })).filter((s) => s.name),
    set: (arr) => { items = arr.map((s) => ({ ...s })); render(); },
    clear: () => { items = []; render(); },
    setVisible: (visible) => editorEl.classList.toggle("hidden", !visible),
  };
}

const taskSubtaskEditor = makeSubtaskEditor("subtask");
const mainSubtaskEditor = makeSubtaskEditor("main-subtask");
const presetSubtaskEditor = makeSubtaskEditor("preset-subtask");

// ミッション／プリセット共通の入力チェック。OKなら null、NGならエラーメッセージを返す
function validateMissionInput(name, rewardPt, type, targetCount, config) {
  if (!name) return "タスク名を入力してね";
  if (!(rewardPt >= config.ptStep && rewardPt <= config.dailyPtCap && rewardPt % config.ptStep === 0)) {
    return `報酬Ptは${config.ptStep}Pt単位・最大${config.dailyPtCap}Ptで設定してね`;
  }
  if (type === "counter" && !(Number.isInteger(targetCount) && targetCount >= 1 && targetCount <= 999)) {
    return "目標回数は1〜999の整数で設定してね";
  }
  return null;
}

$("task-save-btn").addEventListener("click", async () => {
  $("form-error").classList.add("hidden");
  const name = $("task-name-input").value.trim();
  const rewardPt = Number($("task-pt-select").value);
  const type = selectedTaskType();
  const targetCount = Number($("task-target-input").value);

  const errMsg = validateMissionInput(name, rewardPt, type, targetCount, getConfig());
  if (errMsg) {
    showFormError(errMsg);
    return;
  }

  // サブタスクは simple のみ。名前が空の行は除外
  const subtasks = type === "simple" ? taskSubtaskEditor.get() : [];
  const taskData = { name, rewardPt, type, targetCount: type === "counter" ? targetCount : null, subtasks };

  try {
    if (editingTaskId) {
      if (isCompleted(editingTaskId)) {
        showFormError("完了済みのタスクは編集できないよ。先に取り消してね");
        return;
      }
      await updateDoc(doc(db, "users", currentUser.uid, "tasks", editingTaskId), taskData);
      showToast("ミッションを更新したよ✏️");
      cancelEdit();
    } else {
      await addDoc(tasksRef(currentUser.uid), { ...taskData, order: nextOrder(tasks), createdAt: serverTimestamp() });
      showToast("ミッションを追加したよ！");
      $("task-name-input").value = "";
      taskSubtaskEditor.clear();
    }
  } catch (err) {
    console.error("タスクの保存に失敗:", err);
    showFormError("保存に失敗したよ…もう一度試してね");
  }
});

$("task-cancel-btn").addEventListener("click", cancelEdit);

function setFormType(type) {
  document.querySelector(`input[name="task-type"][value="${type}"]`).checked = true;
  $("task-target-label").classList.toggle("hidden", type !== "counter");
}

function startEdit(task) {
  editingTaskId = task.id;
  $("form-title").textContent = "✏️ ミッションを編集";
  $("task-name-input").value = task.name;
  $("task-pt-select").value = String(task.rewardPt);
  setFormType(task.type === "counter" ? "counter" : "simple");
  if (task.type === "counter") $("task-target-input").value = String(task.targetCount);
  taskSubtaskEditor.set(taskSubtasks(task));
  updateSubtaskEditorVisibility();
  $("task-save-btn").textContent = "保存";
  $("task-cancel-btn").classList.remove("hidden");
  $("task-name-input").focus();
}

function cancelEdit() {
  editingTaskId = null;
  $("form-title").textContent = "➕ ミッションを追加";
  $("task-name-input").value = "";
  setFormType("simple");
  taskSubtaskEditor.clear();
  updateSubtaskEditorVisibility();
  $("task-save-btn").textContent = "追加";
  $("task-cancel-btn").classList.add("hidden");
  $("form-error").classList.add("hidden");
}

// ============================================================
// 並び替えの保存
// ============================================================

// items[fromIndex] を、取り除いた後の配列の toIndex の位置へ移動して保存する。
// 通常は移動した1件だけを更新（前後の中間値）。
// order 未設定の旧データが混ざっている／間隔が詰まった場合は全件を振り直す。
async function reorderItems(colName, items, fromIndex, toIndex) {
  const rest = items.filter((_, i) => i !== fromIndex);
  const clamped = Math.max(0, Math.min(toIndex, rest.length));
  const moved = items[fromIndex];

  const colRef = (id) => doc(db, "users", currentUser.uid, colName, id);

  try {
    const newOrder = orderForPosition(rest, clamped);
    if (newOrder !== null) {
      await updateDoc(colRef(moved.id), { order: newOrder });
      return;
    }
    // フォールバック：新しい並びで全件に order を振り直す
    const reordered = [...rest.slice(0, clamped), moved, ...rest.slice(clamped)];
    const batch = writeBatch(db);
    reordered.forEach((item, i) => {
      batch.update(colRef(item.id), { order: (i + 1) * ORDER_STEP });
    });
    await batch.commit();
  } catch (err) {
    console.error("並び替えの保存に失敗:", err);
    showToast("並び替えの保存に失敗したよ…もう一度試してね");
  }
}

// サブタスクの並び替えを保存する。
// subtasks 配列の並びがそのまま表示順なので、並べ替えた配列を書き戻すだけでよい
// （done や id は要素ごと動くので、チェック状態もついてくる）
async function reorderSubtasks(colName, taskId, subtasks, fromIndex, toIndex) {
  const arr = [...subtasks];
  const [moved] = arr.splice(fromIndex, 1);
  arr.splice(Math.max(0, Math.min(toIndex, arr.length)), 0, moved);
  try {
    await updateDoc(doc(db, "users", currentUser.uid, colName, taskId), { subtasks: arr });
  } catch (err) {
    console.error("サブタスクの並び替えに失敗:", err);
    showToast("並び替えの保存に失敗したよ…もう一度試してね");
  }
}

async function deleteTask(task) {
  if (isCompleted(task.id)) {
    showToast("完了済みのタスクは削除できないよ。先に取り消してね");
    return;
  }
  // 確認ダイアログなしで即削除（仕様）
  try {
    await deleteDoc(doc(db, "users", currentUser.uid, "tasks", task.id));
    if (editingTaskId === task.id) cancelEdit();
    showToast("ミッションを削除したよ");
  } catch (err) {
    console.error("タスクの削除に失敗:", err);
    showToast("削除に失敗したよ…もう一度試してね");
  }
}

// ============================================================
// メインミッション（長期目標）
// - 進捗（currentCount / subtasks[].done / completed）はタスク文書側に保持
//   → daily に置かないので、日次リセットの影響を自然に受けない
// - Pt はデイリーの100Pt上限とは別枠（account.mainTotalPt に累積）
// - EXP は floor(mainTotalPt / 25) × 10（デイリーボーナスは適用しない）
// ============================================================

const mainTaskRef = (id) => doc(db, "users", currentUser.uid, "mainTasks", id);

// メインミッションの完了：Pt を mainTotalPt に加算し、差分EXPを累積へ反映
async function completeMainTask(task) {
  const uid = currentUser.uid;
  try {
    await runTransaction(db, async (tx) => {
      const taskSnap = await tx.get(mainTaskRef(task.id));
      const userSnap = await tx.get(userRef(uid));
      if (!taskSnap.exists() || !userSnap.exists()) return;
      const t = taskSnap.data();
      const data = userSnap.data();
      const config = { ...DEFAULT_CONFIG, ...data.config };

      if (t.completed) return; // 二重完了ガード
      if (t.type === "counter" && (t.currentCount || 0) < t.targetCount) return;
      const subs = taskSubtasks(t);
      if (subs.length > 0 && !subs.every((s) => s.done)) return;

      const prevMainPt = data.account.mainTotalPt || 0;
      const newMainPt = prevMainPt + t.rewardPt;
      const expDelta = mainExpForPt(newMainPt, config) - mainExpForPt(prevMainPt, config);
      const newTotalExp = Math.max(0, data.account.totalExp + expDelta);
      const { level } = levelFromExp(newTotalExp);

      tx.update(userRef(uid), {
        account: { ...data.account, level, totalExp: newTotalExp, mainTotalPt: newMainPt },
      });
      tx.update(mainTaskRef(task.id), { completed: true });
    });
  } catch (err) {
    console.error("メインミッションの完了に失敗:", err);
    showToast("完了の保存に失敗したよ…もう一度試してね");
  }
}

// メインミッションの取り消し：Pt・EXP・レベルを巻き戻す
async function uncompleteMainTask(task) {
  const uid = currentUser.uid;
  try {
    await runTransaction(db, async (tx) => {
      const taskSnap = await tx.get(mainTaskRef(task.id));
      const userSnap = await tx.get(userRef(uid));
      if (!taskSnap.exists() || !userSnap.exists()) return;
      const t = taskSnap.data();
      const data = userSnap.data();
      const config = { ...DEFAULT_CONFIG, ...data.config };

      if (!t.completed) return;

      const prevMainPt = data.account.mainTotalPt || 0;
      const newMainPt = Math.max(0, prevMainPt - t.rewardPt);
      const expDelta = mainExpForPt(newMainPt, config) - mainExpForPt(prevMainPt, config);
      const newTotalExp = Math.max(0, data.account.totalExp + expDelta);
      const { level } = levelFromExp(newTotalExp);

      tx.update(userRef(uid), {
        account: { ...data.account, level, totalExp: newTotalExp, mainTotalPt: newMainPt },
      });
      tx.update(mainTaskRef(task.id), { completed: false });
    });
  } catch (err) {
    console.error("メインミッションの取り消しに失敗:", err);
    showToast("取り消しの保存に失敗したよ…もう一度試してね");
  }
}

// メインミッションのカウント操作（±1、0未満にはしない）
async function changeMainCount(taskId, delta) {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(mainTaskRef(taskId));
      if (!snap.exists()) return;
      const t = snap.data();
      if (t.completed) return;
      const next = Math.max(0, (t.currentCount || 0) + delta);
      if (next === (t.currentCount || 0)) return;
      tx.update(mainTaskRef(taskId), { currentCount: next });
    });
  } catch (err) {
    console.error("メインのカウント更新に失敗:", err);
    showToast("カウントの保存に失敗したよ…もう一度試してね");
  }
}

// メインミッションのサブタスク完了トグル（done はタスク文書側に保持）
async function toggleMainSubtask(taskId, subId, checked) {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(mainTaskRef(taskId));
      if (!snap.exists()) return;
      const t = snap.data();
      if (t.completed) return;
      const subtasks = (t.subtasks || []).map((s) => (s.id === subId ? { ...s, done: checked } : s));
      tx.update(mainTaskRef(taskId), { subtasks });
    });
  } catch (err) {
    console.error("メインのサブタスク更新に失敗:", err);
    showToast("サブタスクの保存に失敗したよ…もう一度試してね");
  }
}

async function deleteMainTask(task) {
  if (task.completed) {
    showToast("完了済みのミッションは削除できないよ。先に取り消してね");
    return;
  }
  try {
    await deleteDoc(mainTaskRef(task.id));
    if (editingMainId === task.id) cancelMainEdit();
    showToast("メインミッションを削除したよ");
  } catch (err) {
    console.error("メインミッションの削除に失敗:", err);
    showToast("削除に失敗したよ…もう一度試してね");
  }
}

// ============================================================
// メインミッションの追加・編集フォーム
// ============================================================

function showMainFormError(msg) {
  $("main-form-error").textContent = msg;
  $("main-form-error").classList.remove("hidden");
}

$("main-save-btn").addEventListener("click", async () => {
  $("main-form-error").classList.add("hidden");
  const name = $("main-name-input").value.trim();
  const rewardPt = Number($("main-pt-select").value);
  const type = selectedMainType();
  const targetCount = Number($("main-target-input").value);
  const dueMode = selectedType("main-due-mode");
  const dueDate = dueMode === "date" ? $("main-due-input").value : null;

  const errMsg = validateMissionInput(name, rewardPt, type, targetCount, getConfig());
  if (errMsg) {
    showMainFormError(errMsg);
    return;
  }
  if (dueMode === "date" && !dueDate) {
    showMainFormError("期限の日付を選んでね");
    return;
  }

  // サブタスクは simple のみ。編集中は既存の done を保持し、新規行は false
  const subtasks = type === "simple"
    ? mainSubtaskEditor.get().map((s) => ({ id: s.id, name: s.name, done: s.done || false }))
    : [];
  const taskData = { name, rewardPt, type, targetCount: type === "counter" ? targetCount : null, subtasks, dueDate };

  try {
    if (editingMainId) {
      const editing = mainTasks.find((t) => t.id === editingMainId);
      if (editing && editing.completed) {
        showMainFormError("完了済みのミッションは編集できないよ。先に取り消してね");
        return;
      }
      // 期限を変えたときだけ、期限順の位置に並べ直す（名前だけの編集では動かさない）
      const dueChanged = editing && (editing.dueDate ?? null) !== dueDate;
      const patch = dueChanged
        ? { ...taskData, order: orderForDueDate(mainTasks, dueDate, editingMainId) }
        : taskData;
      await updateDoc(mainTaskRef(editingMainId), patch);
      showToast("メインミッションを更新したよ✏️");
      cancelMainEdit();
    } else {
      await addDoc(mainTasksRef(currentUser.uid), {
        ...taskData,
        currentCount: 0,
        completed: false,
        order: orderForDueDate(mainTasks, dueDate),
        createdAt: serverTimestamp(),
      });
      showToast("メインミッションを追加したよ🏆");
      $("main-name-input").value = "";
      mainSubtaskEditor.clear();
    }
  } catch (err) {
    console.error("メインミッションの保存に失敗:", err);
    showMainFormError("保存に失敗したよ…もう一度試してね");
  }
});

$("main-cancel-btn").addEventListener("click", cancelMainEdit);

function setMainFormType(type) {
  document.querySelector(`input[name="main-type"][value="${type}"]`).checked = true;
  $("main-target-label").classList.toggle("hidden", type !== "counter");
}

function startMainEdit(task) {
  editingMainId = task.id;
  $("main-form-title").textContent = "✏️ メインミッションを編集";
  $("main-name-input").value = task.name;
  $("main-pt-select").value = String(task.rewardPt);
  setMainFormType(task.type === "counter" ? "counter" : "simple");
  if (task.type === "counter") $("main-target-input").value = String(task.targetCount);
  setDueMode("main-due-mode", "main-due-date-label", task.dueDate ? "date" : "none", "date");
  $("main-due-input").value = task.dueDate || "";
  mainSubtaskEditor.set(taskSubtasks(task));
  updateMainSubtaskEditorVisibility();
  $("main-save-btn").textContent = "保存";
  $("main-cancel-btn").classList.remove("hidden");
  $("main-name-input").focus();
}

function cancelMainEdit() {
  editingMainId = null;
  $("main-form-title").textContent = "➕ メインミッションを追加";
  $("main-name-input").value = "";
  setMainFormType("simple");
  setDueMode("main-due-mode", "main-due-date-label", "none", "date");
  $("main-due-input").value = "";
  mainSubtaskEditor.clear();
  updateMainSubtaskEditorVisibility();
  $("main-save-btn").textContent = "追加";
  $("main-cancel-btn").classList.add("hidden");
  $("main-form-error").classList.add("hidden");
}

// ============================================================
// デイリー ⇔ メイン のミッション移動（引っ越し：元からは消える）
// 設定（名前・タイプ・Pt・目標回数・サブタスク構成・期限）は保持し、進捗はリセット
// ============================================================

async function moveTaskToMain(task) {
  if (isCompleted(task.id)) {
    showToast("完了済みのミッションは移動できないよ。先に取り消してね");
    return;
  }
  try {
    const batch = writeBatch(db);
    const newRef = doc(mainTasksRef(currentUser.uid));
    batch.set(newRef, {
      name: task.name,
      rewardPt: task.rewardPt,
      type: task.type === "counter" ? "counter" : "simple",
      targetCount: task.type === "counter" ? task.targetCount : null,
      subtasks: taskSubtasks(task).map((s) => ({ id: s.id, name: s.name, done: false })),
      dueDate: task.dueDate ?? null, // デイリー側で保持していた期限を復元（仕様書 6）
      currentCount: 0,
      completed: false,
      order: orderForDueDate(mainTasks, task.dueDate ?? null), // 期限順の位置に入れる
      createdAt: serverTimestamp(),
    });
    batch.delete(doc(db, "users", currentUser.uid, "tasks", task.id));
    await batch.commit();
    if (editingTaskId === task.id) cancelEdit();
    showToast(`「${task.name}」をメインへ移動したよ🏆`);
  } catch (err) {
    console.error("メインへの移動に失敗:", err);
    showToast("移動に失敗したよ…もう一度試してね");
  }
}

async function moveMainToDaily(task) {
  if (task.completed) {
    showToast("完了済みのミッションは移動できないよ。先に取り消してね");
    return;
  }
  try {
    const batch = writeBatch(db);
    const newRef = doc(tasksRef(currentUser.uid));
    batch.set(newRef, {
      name: task.name,
      rewardPt: task.rewardPt,
      type: task.type === "counter" ? "counter" : "simple",
      targetCount: task.type === "counter" ? task.targetCount : null,
      subtasks: taskSubtasks(task).map((s) => ({ id: s.id, name: s.name })),
      dueDate: task.dueDate ?? null, // デイリーでは非表示だが保持（メインに戻すと復元される）
      order: nextOrder(tasks),
      createdAt: serverTimestamp(),
    });
    batch.delete(mainTaskRef(task.id));
    await batch.commit();
    if (editingMainId === task.id) cancelMainEdit();
    showToast(`「${task.name}」をデイリーへ移動したよ📋`);
  } catch (err) {
    console.error("デイリーへの移動に失敗:", err);
    showToast("移動に失敗したよ…もう一度試してね");
  }
}

// ============================================================
// プリセット（よく使うミッションのひな形）
// ============================================================

function showPresetFormError(msg) {
  $("preset-form-error").textContent = msg;
  $("preset-form-error").classList.remove("hidden");
}

$("preset-save-btn").addEventListener("click", async () => {
  $("preset-form-error").classList.add("hidden");
  const name = $("preset-name-input").value.trim();
  const rewardPt = Number($("preset-pt-select").value);
  const type = selectedPresetType();
  const targetCount = Number($("preset-target-input").value);

  const errMsg = validateMissionInput(name, rewardPt, type, targetCount, getConfig());
  if (errMsg) {
    showPresetFormError(errMsg);
    return;
  }

  // 期限：「追加日から〇日後」方式。無期限は null
  const dueMode = selectedType("preset-due-mode");
  const dueInDays = dueMode === "days" ? Number($("preset-due-days-input").value) : null;
  if (dueMode === "days" && !(Number.isInteger(dueInDays) && dueInDays >= 1 && dueInDays <= 3650)) {
    showPresetFormError("期限の日数は1〜3650の整数で設定してね");
    return;
  }

  // サブタスクは simple のみ。名前が空の行は除外
  const subtasks = type === "simple" ? presetSubtaskEditor.get() : [];
  const presetData = { name, rewardPt, type, targetCount: type === "counter" ? targetCount : null, subtasks, dueInDays };

  try {
    if (editingPresetId) {
      await updateDoc(doc(db, "users", currentUser.uid, "presets", editingPresetId), presetData);
      showToast("プリセットを更新したよ✏️");
      cancelPresetEdit();
    } else {
      await addDoc(presetsRef(currentUser.uid), { ...presetData, order: nextOrder(presets), createdAt: serverTimestamp() });
      showToast("プリセットを登録したよ⭐");
      $("preset-name-input").value = "";
      presetSubtaskEditor.clear();
    }
  } catch (err) {
    console.error("プリセットの保存に失敗:", err);
    showPresetFormError("保存に失敗したよ…もう一度試してね");
  }
});

$("preset-cancel-btn").addEventListener("click", cancelPresetEdit);

function setPresetFormType(type) {
  document.querySelector(`input[name="preset-type"][value="${type}"]`).checked = true;
  $("preset-target-label").classList.toggle("hidden", type !== "counter");
}

function startPresetEdit(preset) {
  editingPresetId = preset.id;
  $("preset-form-title").textContent = "✏️ プリセットを編集";
  $("preset-name-input").value = preset.name;
  $("preset-pt-select").value = String(preset.rewardPt);
  setPresetFormType(preset.type === "counter" ? "counter" : "simple");
  if (preset.type === "counter") $("preset-target-input").value = String(preset.targetCount);
  const hasDue = typeof preset.dueInDays === "number";
  setDueMode("preset-due-mode", "preset-due-days-label", hasDue ? "days" : "none", "days");
  if (hasDue) $("preset-due-days-input").value = String(preset.dueInDays);
  presetSubtaskEditor.set(presetSubtasks(preset));
  updatePresetSubtaskEditorVisibility();
  $("preset-save-btn").textContent = "保存";
  $("preset-cancel-btn").classList.remove("hidden");
  $("preset-name-input").focus();
}

function cancelPresetEdit() {
  editingPresetId = null;
  $("preset-form-title").textContent = "➕ プリセットを登録";
  $("preset-name-input").value = "";
  setPresetFormType("simple");
  setDueMode("preset-due-mode", "preset-due-days-label", "none", "days");
  presetSubtaskEditor.clear();
  updatePresetSubtaskEditorVisibility();
  $("preset-save-btn").textContent = "登録";
  $("preset-cancel-btn").classList.add("hidden");
  $("preset-form-error").classList.add("hidden");
}

async function deletePreset(preset) {
  // 確認ダイアログなしで即削除（仕様）
  try {
    await deleteDoc(doc(db, "users", currentUser.uid, "presets", preset.id));
    if (editingPresetId === preset.id) cancelPresetEdit();
    showToast("プリセットを削除したよ");
  } catch (err) {
    console.error("プリセットの削除に失敗:", err);
    showToast("削除に失敗したよ…もう一度試してね");
  }
}

// プリセット → デイリーへワンタップ追加
// 値をコピーして新規ミッションを作る（参照は持たせない＝独立性の担保）
// サブタスクも構成をコピーする（doneはdaily.subDone側で管理するので常に未完了から）
// 重複チェックはしない：同じプリセットを何回でも追加できる
async function addPresetToDaily(preset) {
  try {
    await addDoc(tasksRef(currentUser.uid), {
      name: preset.name,
      rewardPt: preset.rewardPt,
      type: preset.type === "counter" ? "counter" : "simple",
      targetCount: preset.type === "counter" ? preset.targetCount : null,
      subtasks: presetSubtasks(preset).map((s) => ({ id: newSubtaskId(), name: s.name })),
      order: nextOrder(tasks),
      createdAt: serverTimestamp(),
    });
    showToast(`「${preset.name}」をデイリーに追加したよ！`);
  } catch (err) {
    console.error("デイリーへの追加に失敗:", err);
    showToast("追加に失敗したよ…もう一度試してね");
  }
}

// プリセット → メインへワンタップ追加
// dueInDays があれば「今日 + dueInDays」で期限日を計算してセット（仕様書 2.3 / 6.2）
async function addPresetToMain(preset) {
  try {
    const dueDate = typeof preset.dueInDays === "number" ? addDays(todayStr(), preset.dueInDays) : null;
    await addDoc(mainTasksRef(currentUser.uid), {
      name: preset.name,
      rewardPt: preset.rewardPt,
      type: preset.type === "counter" ? "counter" : "simple",
      targetCount: preset.type === "counter" ? preset.targetCount : null,
      subtasks: presetSubtasks(preset).map((s) => ({ id: newSubtaskId(), name: s.name, done: false })),
      dueDate,
      currentCount: 0,
      completed: false,
      order: orderForDueDate(mainTasks, dueDate), // 期限順の位置に入れる
      createdAt: serverTimestamp(),
    });
    showToast(`「${preset.name}」をメインに追加したよ🏆`);
  } catch (err) {
    console.error("メインへの追加に失敗:", err);
    showToast("追加に失敗したよ…もう一度試してね");
  }
}

// ============================================================
// 描画
// ============================================================

// ドラッグ中は再描画を保留する（掴んでいる要素がDOMごと作り直されるのを防ぐ）
let isDragging = false;
let renderPendingDuringDrag = false;

function render() {
  if (isDragging) { renderPendingDuringDrag = true; return; }
  if (!userData) return;
  const config = getConfig();
  const account = userData.account || { level: 1, totalExp: 0 };
  const daily = normalizedDaily(userData, todayStr());

  // ステータス
  const { level, expIntoLevel, expForNext } = levelFromExp(account.totalExp);
  $("level-value").textContent = level;
  $("exp-text").textContent = `${expIntoLevel} / ${expForNext}（累積 ${account.totalExp} EXP）`;
  $("exp-bar-fill").style.width = `${Math.min(100, (expIntoLevel / expForNext) * 100)}%`;

  $("pt-text").textContent = `${daily.todayPt} / ${config.dailyPtCap} Pt`;
  $("pt-bar-fill").style.width = `${Math.min(100, (daily.todayPt / config.dailyPtCap) * 100)}%`;
  $("daily-bonus-msg").classList.toggle("hidden", !daily.dailyBonusClaimed);

  // レベルアップ演出（初回表示時は出さない）
  if (lastLevel !== null && level > lastLevel) {
    showLevelUp(level);
  } else if (lastLevel !== null && level < lastLevel) {
    showToast(`レベルダウン… Lv.${level} になったよ💦`);
  }
  lastLevel = level;

  renderTasks(daily);
  renderMainTasks();
}

// メイン一覧だけを安全に再描画（ドラッグ中は保留）
function renderMainSafe() {
  if (isDragging) { renderPendingDuringDrag = true; return; }
  renderMainTasks();
}

// ============================================================
// ドラッグ&ドロップ並び替え（ハンドル限定・Pointer Eventsでマウス／タッチ共通）
// ============================================================

// li に付けるドラッグハンドルを作る。
// getItems() は現在の並び（配列）、onReorder(from, to) は確定時のコールバック
function makeDragHandle(listEl, getItems, onReorder) {
  const handle = iconButton("grip", "ドラッグして並び替え", "drag-handle");

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return; // 左クリック／タッチのみ
    const dragEl = handle.closest("li");
    if (!dragEl) return;

    e.preventDefault();

    const fromIndex = [...listEl.children].indexOf(dragEl);
    const pointerId = e.pointerId;
    let startY = e.clientY;
    let started = false;

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const dy = ev.clientY - startY;
      // 少し動かすまではドラッグ開始しない（タップ・スクロールとの誤爆防止）
      if (!started) {
        if (Math.abs(dy) < 5) return;
        started = true;
        isDragging = true;
        dragEl.classList.add("dragging");
        listEl.classList.add("sorting");
      }
      dragEl.style.transform = `translateY(${dy}px)`;

      // 進行方向の端が隣の要素の中心を越えたらDOM上で入れ替える
      // （中心同士で比べると1行ぶん動かすまで反応しないので、端で判定する）
      // 速いドラッグでは1回のイベントで複数行ぶん動くことがあるため、
      // 「もう入れ替える相手がいない」状態になるまで繰り返して追いつかせる
      // （1回だけだと処理が追いつかず、行の間に挟まったまま詰まることがある）
      for (let guard = 0; guard < listEl.children.length; guard++) {
        const rect = dragEl.getBoundingClientRect();
        const prev = dragEl.previousElementSibling;
        const next = dragEl.nextElementSibling;

        let target = null;
        let insertBefore = false;
        if (prev) {
          const r = prev.getBoundingClientRect();
          if (rect.top < r.top + r.height / 2) { target = prev; insertBefore = true; }
        }
        if (!target && next) {
          const r = next.getBoundingClientRect();
          if (rect.bottom > r.top + r.height / 2) { target = next; insertBefore = false; }
        }
        if (!target) break;

        // 入れ替えで基準位置がずれるぶん、見た目が指の下から動かないよう補正する
        const before = rect.top;
        dragEl.style.transform = "";
        if (insertBefore) listEl.insertBefore(dragEl, target);
        else listEl.insertBefore(dragEl, target.nextElementSibling);
        const after = dragEl.getBoundingClientRect().top;
        const newDy = before - after;
        startY = ev.clientY - newDy;
        dragEl.style.transform = `translateY(${newDy}px)`;
      }
    };

    const onUp = (ev) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragEl.style.transform = "";
      dragEl.classList.remove("dragging");
      listEl.classList.remove("sorting");

      if (!started) return;
      isDragging = false;

      const toIndex = [...listEl.children].indexOf(dragEl);
      if (toIndex !== -1 && toIndex !== fromIndex) {
        onReorder(getItems(), fromIndex, toIndex);
      } else if (renderPendingDuringDrag) {
        renderPendingDuringDrag = false;
        render();
      }
    };

    // リスナーは window に付ける。
    // ハンドル側に付けてポインターキャプチャで受ける方式だと、入れ替えの insertBefore
    // （＝内部的には取り外して挿し直し）でキャプチャが解除され、以降のイベントが
    // 届かなくなって行の間に挟まったまま「詰まる」ため
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  return handle;
}

function renderTasks(daily) {
  const list = $("task-list");
  list.innerHTML = "";
  $("task-empty").classList.toggle("hidden", tasks.length > 0);

  const completedIds = daily.completedTaskIds || [];
  const counters = daily.counters || {};

  for (const task of tasks) {
    const completed = completedIds.includes(task.id);
    const isCounter = task.type === "counter";
    const count = counters[task.id] || 0;

    // サブタスク（simpleのみ）
    const subs = taskSubtasks(task);
    const hasSubs = subs.length > 0;
    const doneMap = (daily.subDone || {})[task.id] || {};
    const doneCount = subs.filter((s) => doneMap[s.id]).length;

    // 完了ボタンの有効判定（仕様書 6.1）
    const canComplete = isCounter
      ? count >= task.targetCount
      : (!hasSubs || doneCount === subs.length);

    const li = document.createElement("li");
    li.className = "task-item" + (completed ? " completed" : "");

    const row = document.createElement("div");
    row.className = "task-row";

    row.appendChild(makeDragHandle(list, () => tasks, (items, from, to) => reorderItems("tasks", items, from, to)));

    const main = document.createElement("div");
    main.className = "task-main";

    // 1行目：ミッション名の隣に開閉トグル（サブタスク持ちのときだけ）
    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";

    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = task.name;
    titleRow.appendChild(name);

    const expanded = expandedTasks.has(task.id);
    if (hasSubs) {
      const toggle = iconButton("chevron", expanded ? "サブタスクを閉じる" : "サブタスクを開く", "subtask-toggle" + (expanded ? " open" : ""));
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.addEventListener("click", () => {
        if (expandedTasks.has(task.id)) expandedTasks.delete(task.id);
        else expandedTasks.add(task.id);
        render();
      });
      // 閉じたままでも進捗が分かる表示（例：1 / 3）。名前の右・トグルの左に置く
      const progress = document.createElement("span");
      progress.className = "count-label subtask-progress" + (doneCount === subs.length ? " reached" : "");
      progress.textContent = `${doneCount} / ${subs.length}`;
      titleRow.appendChild(progress);

      titleRow.appendChild(toggle);
    }

    main.appendChild(titleRow);

    // カウンター式：－ / 現在 / 目標 / ＋ とミニ進捗バー
    if (isCounter) {
      const counterBox = document.createElement("div");
      counterBox.className = "counter-box";

      const minusBtn = document.createElement("button");
      minusBtn.className = "btn btn-small btn-count";
      minusBtn.textContent = "－";
      minusBtn.disabled = completed || count <= 0;
      minusBtn.addEventListener("click", () => changeCount(task.id, -1));

      const countLabel = document.createElement("span");
      countLabel.className = "count-label" + (canComplete ? " reached" : "");
      countLabel.textContent = `${count} / ${task.targetCount}`;

      const plusBtn = document.createElement("button");
      plusBtn.className = "btn btn-small btn-count";
      plusBtn.textContent = "＋";
      plusBtn.disabled = completed;
      plusBtn.addEventListener("click", () => changeCount(task.id, 1));

      const miniBar = document.createElement("div");
      miniBar.className = "bar count-bar";
      const miniFill = document.createElement("div");
      miniFill.className = "bar-fill count-fill";
      miniFill.style.width = `${Math.min(100, (count / task.targetCount) * 100)}%`;
      miniBar.appendChild(miniFill);

      counterBox.append(minusBtn, countLabel, plusBtn, miniBar);
      main.appendChild(counterBox);
    }

    const pt = document.createElement("span");
    pt.className = "task-pt";
    pt.textContent = `+${task.rewardPt} Pt`;

    const actions = document.createElement("div");
    actions.className = "task-actions";

    // 操作ボタン（アイコン：完了＝チェック / 取り消し＝戻る矢印 / 編集＝ペン / 削除＝×）
    let toggleBtn;
    if (completed) {
      toggleBtn = iconButton("undo", "取り消し", "btn btn-small btn-undo btn-sq");
      toggleBtn.addEventListener("click", () => uncompleteTask(task.id, task.rewardPt));
    } else {
      toggleBtn = iconButton("check", "完了", "btn btn-small btn-complete btn-sq");
      toggleBtn.disabled = !canComplete;
      if (!canComplete) {
        toggleBtn.title = isCounter
          ? `あと${task.targetCount - count}回で完了できるよ`
          : "サブタスクを全部終わらせると完了できるよ";
      }
      toggleBtn.addEventListener("click", () => completeTask(task));
    }

    const moveBtn = iconButton("move", "メインへ移動", "btn btn-small btn-icon btn-sq");
    moveBtn.disabled = completed;
    moveBtn.addEventListener("click", () => moveTaskToMain(task));

    const editBtn = iconButton("pen", "編集", "btn btn-small btn-icon btn-sq");
    editBtn.disabled = completed;
    editBtn.addEventListener("click", () => startEdit(task));

    const delBtn = iconButton("x", "削除", "btn btn-small btn-icon btn-sq btn-danger-hover");
    delBtn.disabled = completed;
    delBtn.addEventListener("click", () => deleteTask(task));

    actions.append(toggleBtn, moveBtn, editBtn, delBtn);
    row.append(main, pt, actions);
    li.appendChild(row);

    // サブタスク一覧（開いているときだけ表示）
    if (hasSubs && expanded) {
      const subList = document.createElement("ul");
      subList.className = "subtask-list";
      for (const sub of subs) {
        const subLi = document.createElement("li");
        subLi.className = "subtask-item";

        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!doneMap[sub.id];
        checkbox.disabled = completed; // 完了済みの親は操作不可
        checkbox.addEventListener("change", () => toggleSubtask(task.id, sub.id, checkbox.checked));

        const subName = document.createElement("span");
        subName.className = "subtask-name" + (doneMap[sub.id] ? " done" : "");
        subName.textContent = sub.name;

        label.append(checkbox, subName);
        subLi.appendChild(makeDragHandle(subList, () => subs,
          (items, from, to) => reorderSubtasks("tasks", task.id, items, from, to)));
        subLi.appendChild(label);
        subList.appendChild(subLi);
      }
      li.appendChild(subList);
    }

    list.appendChild(li);
  }
}

// メインミッション一覧の描画（進捗はタスク文書側から読む）
function renderMainTasks() {
  const list = $("main-list");
  if (!list) return;
  list.innerHTML = "";
  $("main-empty").classList.toggle("hidden", mainTasks.length > 0);

  const today = todayStr();

  for (const task of mainTasks) {
    const completed = !!task.completed;
    const isCounter = task.type === "counter";
    const count = task.currentCount || 0;

    const subs = taskSubtasks(task);
    const hasSubs = subs.length > 0;
    const doneCount = subs.filter((s) => s.done).length;

    const canComplete = isCounter
      ? count >= task.targetCount
      : (!hasSubs || doneCount === subs.length);

    const li = document.createElement("li");
    li.className = "task-item" + (completed ? " completed" : "");

    const row = document.createElement("div");
    row.className = "task-row";

    row.appendChild(makeDragHandle(list, () => mainTasks, (items, from, to) => reorderItems("mainTasks", items, from, to)));

    const main = document.createElement("div");
    main.className = "task-main";

    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";

    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = task.name;
    titleRow.appendChild(name);

    const expanded = expandedTasks.has(task.id);
    if (hasSubs) {
      const toggle = iconButton("chevron", expanded ? "サブタスクを閉じる" : "サブタスクを開く", "subtask-toggle" + (expanded ? " open" : ""));
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.addEventListener("click", () => {
        if (expandedTasks.has(task.id)) expandedTasks.delete(task.id);
        else expandedTasks.add(task.id);
        renderMainSafe();
      });
      // 進捗（0/2）は名前の右・開閉トグルの左に置く
      const progress = document.createElement("span");
      progress.className = "count-label subtask-progress" + (doneCount === subs.length ? " reached" : "");
      progress.textContent = `${doneCount} / ${subs.length}`;
      titleRow.appendChild(progress);

      titleRow.appendChild(toggle);
    }

    main.appendChild(titleRow);

    // 2行目：期限バッジ
    const metaRow = document.createElement("div");
    metaRow.className = "task-meta-row";

    // 期限バッジ（設定時のみ。期限切れ＝赤、残り3日以内＝黄）
    if (task.dueDate) {
      const due = document.createElement("span");
      let dueClass = "due-badge";
      if (!completed) {
        if (task.dueDate < today) dueClass += " overdue";
        else if (task.dueDate <= addDays(today, 3)) dueClass += " soon";
      }
      due.className = dueClass;
      due.textContent = task.dueDate < today && !completed ? `期限切れ ${task.dueDate}` : `期限 ${task.dueDate}`;
      metaRow.appendChild(due);
    }

    if (metaRow.childElementCount > 0) main.appendChild(metaRow);

    if (isCounter) {
      const counterBox = document.createElement("div");
      counterBox.className = "counter-box";

      const minusBtn = document.createElement("button");
      minusBtn.className = "btn btn-small btn-count";
      minusBtn.textContent = "－";
      minusBtn.disabled = completed || count <= 0;
      minusBtn.addEventListener("click", () => changeMainCount(task.id, -1));

      const countLabel = document.createElement("span");
      countLabel.className = "count-label" + (canComplete ? " reached" : "");
      countLabel.textContent = `${count} / ${task.targetCount}`;

      const plusBtn = document.createElement("button");
      plusBtn.className = "btn btn-small btn-count";
      plusBtn.textContent = "＋";
      plusBtn.disabled = completed;
      plusBtn.addEventListener("click", () => changeMainCount(task.id, 1));

      const miniBar = document.createElement("div");
      miniBar.className = "bar count-bar";
      const miniFill = document.createElement("div");
      miniFill.className = "bar-fill count-fill";
      miniFill.style.width = `${Math.min(100, (count / task.targetCount) * 100)}%`;
      miniBar.appendChild(miniFill);

      counterBox.append(minusBtn, countLabel, plusBtn, miniBar);
      main.appendChild(counterBox);
    }

    const pt = document.createElement("span");
    pt.className = "task-pt";
    pt.textContent = `+${task.rewardPt} Pt`;

    const actions = document.createElement("div");
    actions.className = "task-actions";

    let toggleBtn;
    if (completed) {
      toggleBtn = iconButton("undo", "取り消し", "btn btn-small btn-undo btn-sq");
      toggleBtn.addEventListener("click", () => uncompleteMainTask(task));
    } else {
      toggleBtn = iconButton("check", "完了", "btn btn-small btn-complete btn-sq");
      toggleBtn.disabled = !canComplete;
      if (!canComplete) {
        toggleBtn.title = isCounter
          ? `あと${task.targetCount - count}回で完了できるよ`
          : "サブタスクを全部終わらせると完了できるよ";
      }
      toggleBtn.addEventListener("click", () => completeMainTask(task));
    }

    const moveBtn = iconButton("move", "デイリーへ移動", "btn btn-small btn-icon btn-sq");
    moveBtn.disabled = completed;
    moveBtn.addEventListener("click", () => moveMainToDaily(task));

    const editBtn = iconButton("pen", "編集", "btn btn-small btn-icon btn-sq");
    editBtn.disabled = completed;
    editBtn.addEventListener("click", () => startMainEdit(task));

    const delBtn = iconButton("x", "削除", "btn btn-small btn-icon btn-sq btn-danger-hover");
    delBtn.disabled = completed;
    delBtn.addEventListener("click", () => deleteMainTask(task));

    actions.append(toggleBtn, moveBtn, editBtn, delBtn);
    row.append(main, pt, actions);
    li.appendChild(row);

    // サブタスク一覧（開いているときだけ表示。done は文書側）
    if (hasSubs && expanded) {
      const subList = document.createElement("ul");
      subList.className = "subtask-list";
      for (const sub of subs) {
        const subLi = document.createElement("li");
        subLi.className = "subtask-item";

        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!sub.done;
        checkbox.disabled = completed;
        checkbox.addEventListener("change", () => toggleMainSubtask(task.id, sub.id, checkbox.checked));

        const subName = document.createElement("span");
        subName.className = "subtask-name" + (sub.done ? " done" : "");
        subName.textContent = sub.name;

        label.append(checkbox, subName);
        subLi.appendChild(makeDragHandle(subList, () => subs,
          (items, from, to) => reorderSubtasks("mainTasks", task.id, items, from, to)));
        subLi.appendChild(label);
        subList.appendChild(subLi);
      }
      li.appendChild(subList);
    }

    list.appendChild(li);
  }
}

function renderPresets() {
  const list = $("preset-list");
  list.innerHTML = "";
  $("preset-empty").classList.toggle("hidden", presets.length > 0);

  for (const preset of presets) {
    const isCounter = preset.type === "counter";
    const li = document.createElement("li");
    li.className = "task-item task-row preset-item";

    li.appendChild(makeDragHandle(list, () => presets, (items, from, to) => reorderItems("presets", items, from, to)));

    const main = document.createElement("div");
    main.className = "task-main";

    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = preset.name;
    main.appendChild(name);

    const subs = presetSubtasks(preset);
    const info = document.createElement("span");
    info.className = "preset-info";
    const typeText = isCounter ? `カウンター式 ×${preset.targetCount}` : "1回で完了";
    const dueText = typeof preset.dueInDays === "number" ? `${preset.dueInDays}日後まで` : "無期限";
    const subText = !isCounter && subs.length > 0 ? ` ／ サブタスク ${subs.length}件` : "";
    info.textContent = `${typeText} ／ ${dueText}${subText}`;
    main.appendChild(info);

    const pt = document.createElement("span");
    pt.className = "task-pt";
    pt.textContent = `+${preset.rewardPt} Pt`;

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const dailyBtn = document.createElement("button");
    dailyBtn.className = "btn btn-small btn-complete";
    dailyBtn.textContent = "デイリーへ";
    dailyBtn.title = "その日のデイリーミッションに追加";
    dailyBtn.addEventListener("click", () => addPresetToDaily(preset));

    const mainBtn = document.createElement("button");
    mainBtn.className = "btn btn-small btn-main-add";
    mainBtn.textContent = "メインへ";
    mainBtn.title = "メインミッション（長期目標）に追加";
    mainBtn.addEventListener("click", () => addPresetToMain(preset));

    const editBtn = iconButton("pen", "編集", "btn btn-small btn-icon btn-sq");
    editBtn.addEventListener("click", () => startPresetEdit(preset));

    const delBtn = iconButton("x", "削除", "btn btn-small btn-icon btn-sq btn-danger-hover");
    delBtn.addEventListener("click", () => deletePreset(preset));

    actions.append(dailyBtn, mainBtn, editBtn, delBtn);
    li.append(main, pt, actions);
    list.appendChild(li);
  }
}

// ============================================================
// 演出・トースト
// ============================================================

let levelUpTimer = null;
function showLevelUp(level) {
  $("levelup-value").textContent = level;
  $("levelup-overlay").classList.remove("hidden");
  clearTimeout(levelUpTimer);
  levelUpTimer = setTimeout(() => $("levelup-overlay").classList.add("hidden"), 2200);
}
$("levelup-overlay").addEventListener("click", () => $("levelup-overlay").classList.add("hidden"));

let toastTimer = null;
function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}

// ============================================================
// 初期化（フォームの報酬Pt選択肢を生成）
// ============================================================

function initPtSelect() {
  for (const id of ["task-pt-select", "main-pt-select", "preset-pt-select"]) {
    const select = $(id);
    select.innerHTML = "";
    for (let pt = DEFAULT_CONFIG.ptStep; pt <= DEFAULT_CONFIG.dailyPtCap; pt += DEFAULT_CONFIG.ptStep) {
      const opt = document.createElement("option");
      opt.value = String(pt);
      opt.textContent = `${pt} Pt`;
      select.appendChild(opt);
    }
    select.value = String(SIMPLE_DEFAULT_PT);
  }
}

// 日付が変わった直後の画面を最新化するため、タブ復帰時にリセットチェック
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentUser) {
    ensureUserDocAndDailyReset(currentUser.uid);
  }
});

initPtSelect();
