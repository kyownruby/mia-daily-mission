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

// タスクのサブタスク配列（simpleのみ。無ければ空配列）
function taskSubtasks(task) {
  return task.type !== "counter" && Array.isArray(task.subtasks) ? task.subtasks : [];
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
let presets = [];      // presets サブコレクションの内容
let lastLevel = null;  // レベルアップ演出用
let editingTaskId = null;
let editingPresetId = null;
let expandedTasks = new Set(); // サブタスクを開いているタスクID（デフォルトは閉じ）
let authMode = "login"; // "login" | "signup"
let unsubUserDoc = null;
let unsubTasks = null;
let unsubPresets = null;

const userRef = (uid) => doc(db, "users", uid);
const tasksRef = (uid) => collection(db, "users", uid, "tasks");
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
    presets = [];
    lastLevel = null;
    expandedTasks = new Set();
    cancelEdit();
    cancelPresetEdit();
    $("app-view").classList.add("hidden");
    $("auth-view").classList.remove("hidden");
  }
});

function unsubscribeAll() {
  if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
  if (unsubPresets) { unsubPresets(); unsubPresets = null; }
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

  unsubTasks = onSnapshot(
    query(tasksRef(uid), orderBy("createdAt", "asc")),
    (snap) => {
      tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    },
    (err) => console.error("タスクの購読エラー:", err)
  );

  unsubPresets = onSnapshot(
    query(presetsRef(uid), orderBy("createdAt", "asc")),
    (snap) => {
      presets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
        account: { level, totalExp: newTotalExp },
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
        account: { level, totalExp: newTotalExp },
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
bindTypeToggle("preset-type", "preset-target-label", "preset-pt-select", () => editingPresetId !== null);

// サブタスク編集欄は「1回で完了」のときだけ表示
function updateSubtaskEditorVisibility() {
  $("subtask-editor").classList.toggle("hidden", selectedTaskType() !== "simple");
}
for (const radio of document.querySelectorAll('input[name="task-type"]')) {
  radio.addEventListener("change", updateSubtaskEditorVisibility);
}

// ============================================================
// フォーム内のサブタスク編集
// ============================================================

let formSubtasks = []; // { id, name } の配列（保存時にタスクへ反映）

function newSubtaskId() {
  return "sub_" + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
}

function renderFormSubtasks() {
  const ul = $("subtask-edit-list");
  ul.innerHTML = "";
  formSubtasks.forEach((st, index) => {
    const li = document.createElement("li");
    li.className = "subtask-edit-item";

    const input = document.createElement("input");
    input.type = "text";
    input.value = st.name;
    input.maxLength = 50;
    input.addEventListener("input", () => { st.name = input.value; });

    const delBtn = iconButton("x", "サブタスクを削除", "btn btn-small btn-icon btn-sq btn-danger-hover");
    delBtn.addEventListener("click", () => {
      formSubtasks.splice(index, 1);
      renderFormSubtasks(); // ダイアログなしで即削除
    });

    li.append(input, delBtn);
    ul.appendChild(li);
  });
}

$("subtask-add-btn").addEventListener("click", () => {
  const name = $("subtask-name-input").value.trim();
  if (!name) return;
  formSubtasks.push({ id: newSubtaskId(), name });
  $("subtask-name-input").value = "";
  renderFormSubtasks();
});

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
  const subtasks = type === "simple"
    ? formSubtasks.map((s) => ({ id: s.id, name: s.name.trim() })).filter((s) => s.name)
    : [];
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
      await addDoc(tasksRef(currentUser.uid), { ...taskData, createdAt: serverTimestamp() });
      showToast("ミッションを追加したよ！");
      $("task-name-input").value = "";
      formSubtasks = [];
      renderFormSubtasks();
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
  formSubtasks = taskSubtasks(task).map((s) => ({ ...s })); // コピーして編集
  renderFormSubtasks();
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
  formSubtasks = [];
  renderFormSubtasks();
  updateSubtaskEditorVisibility();
  $("task-save-btn").textContent = "追加";
  $("task-cancel-btn").classList.add("hidden");
  $("form-error").classList.add("hidden");
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

  const presetData = { name, rewardPt, type, targetCount: type === "counter" ? targetCount : null };

  try {
    if (editingPresetId) {
      await updateDoc(doc(db, "users", currentUser.uid, "presets", editingPresetId), presetData);
      showToast("プリセットを更新したよ✏️");
      cancelPresetEdit();
    } else {
      await addDoc(presetsRef(currentUser.uid), { ...presetData, createdAt: serverTimestamp() });
      showToast("プリセットを登録したよ⭐");
      $("preset-name-input").value = "";
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
  $("preset-save-btn").textContent = "保存";
  $("preset-cancel-btn").classList.remove("hidden");
  $("preset-name-input").focus();
}

function cancelPresetEdit() {
  editingPresetId = null;
  $("preset-form-title").textContent = "➕ プリセットを登録";
  $("preset-name-input").value = "";
  setPresetFormType("simple");
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
// 重複チェックはしない：同じプリセットを何回でも追加できる
async function addPresetToDaily(preset) {
  try {
    await addDoc(tasksRef(currentUser.uid), {
      name: preset.name,
      rewardPt: preset.rewardPt,
      type: preset.type === "counter" ? "counter" : "simple",
      targetCount: preset.type === "counter" ? preset.targetCount : null,
      createdAt: serverTimestamp(),
    });
    showToast(`「${preset.name}」をデイリーに追加したよ！`);
  } catch (err) {
    console.error("デイリーへの追加に失敗:", err);
    showToast("追加に失敗したよ…もう一度試してね");
  }
}

// ============================================================
// 描画
// ============================================================

function render() {
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

    // サブタスク持ちは開閉トグル（デフォルト閉じ）。行の右端（操作アイコンの隣）に置く
    const expanded = expandedTasks.has(task.id);
    let toggle = null;
    if (hasSubs) {
      toggle = iconButton("chevron", expanded ? "サブタスクを閉じる" : "サブタスクを開く", "subtask-toggle" + (expanded ? " open" : ""));
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.addEventListener("click", () => {
        if (expandedTasks.has(task.id)) expandedTasks.delete(task.id);
        else expandedTasks.add(task.id);
        render();
      });
    }

    const main = document.createElement("div");
    main.className = "task-main";

    // 1行目：ミッション名 → 報酬Pt（名前の直後に続けて表示）
    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";

    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = task.name;
    titleRow.appendChild(name);

    const pt = document.createElement("span");
    pt.className = "task-pt";
    pt.textContent = `+${task.rewardPt} Pt`;
    titleRow.appendChild(pt);

    main.appendChild(titleRow);

    // 閉じたままでも進捗が分かる表示（例：1 / 3）
    if (hasSubs) {
      const progress = document.createElement("span");
      progress.className = "count-label subtask-progress" + (doneCount === subs.length ? " reached" : "");
      progress.textContent = `${doneCount} / ${subs.length}`;
      main.appendChild(progress);
    }

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

    const editBtn = iconButton("pen", "編集", "btn btn-small btn-icon btn-sq");
    editBtn.disabled = completed;
    editBtn.addEventListener("click", () => startEdit(task));

    const delBtn = iconButton("x", "削除", "btn btn-small btn-icon btn-sq btn-danger-hover");
    delBtn.disabled = completed;
    delBtn.addEventListener("click", () => deleteTask(task));

    actions.append(toggleBtn, editBtn, delBtn);
    row.append(main, actions);
    if (toggle) row.appendChild(toggle);
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

    const main = document.createElement("div");
    main.className = "task-main";

    // 1行目：プリセット名 → 報酬Pt
    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";

    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = preset.name;
    titleRow.appendChild(name);

    const pt = document.createElement("span");
    pt.className = "task-pt";
    pt.textContent = `+${preset.rewardPt} Pt`;
    titleRow.appendChild(pt);

    main.appendChild(titleRow);

    const info = document.createElement("span");
    info.className = "preset-info";
    info.textContent = isCounter ? `カウンター式 ×${preset.targetCount}` : "1回で完了";
    main.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-small btn-complete";
    addBtn.textContent = "デイリーに追加";
    addBtn.addEventListener("click", () => addPresetToDaily(preset));

    const editBtn = iconButton("pen", "編集", "btn btn-small btn-icon btn-sq");
    editBtn.addEventListener("click", () => startPresetEdit(preset));

    const delBtn = iconButton("x", "削除", "btn btn-small btn-icon btn-sq btn-danger-hover");
    delBtn.addEventListener("click", () => deletePreset(preset));

    actions.append(addBtn, editBtn, delBtn);
    li.append(main, actions);
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
  for (const id of ["task-pt-select", "preset-pt-select"]) {
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
