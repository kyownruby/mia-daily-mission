// ============================================================
// Firebase 設定ファイル
//
// Firebase コンソール（https://console.firebase.google.com/）で
// プロジェクトを作成し、
// 「プロジェクトの設定 > マイアプリ > SDK の設定と構成」に表示される
// firebaseConfig の値を、以下にそのまま貼り付けてください。
//
// ※ APIキーはフロントエンドに含まれる前提の公開値です。
//    データ保護は Firestore セキュリティルール（firestore.rules）で行います。
// ============================================================

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
