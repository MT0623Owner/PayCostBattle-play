// オンライン対戦（Firebase匿名認証＋Firestore）の接続設定。
// これはブラウザアプリ用の公開設定（秘密鍵ではない）。制約ワードウルフと同じFirebaseプロジェクトを使い、
// 部屋のデータは別の名前空間（appId）に保存する。Firestoreルールは appId に依らず「ログイン済みなら読み書き可」。
window.PCB_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDyOd1pvEYeKqzjInbXgDYAk-7Db89Buo8",
  authDomain: "constrained-werewolf-5bdf6.firebaseapp.com",
  projectId: "constrained-werewolf-5bdf6",
  storageBucket: "constrained-werewolf-5bdf6.firebasestorage.app",
  messagingSenderId: "501963975437",
  appId: "1:501963975437:web:7dcfdb871f7a26c8861e44"
};
window.PCB_APP_ID = "paycostbattle";
