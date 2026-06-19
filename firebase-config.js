// ────────────────────────────────────────────────────────────────────
// Firebase config for FCM (Cloud Messaging) — DailyWater.
//
// Push is DISABLED until you create a Firebase project for DailyWater and
// paste its web config below. These empty values are safe: the page does not
// load the Firebase SDK unless push is enabled, so nothing throws.
//
// To enable push later:
//   1. Create a Firebase project, add a Web app, copy its config here.
//   2. Generate a Web Push (VAPID) key pair → paste the public key as vapidKey.
//   3. The server-side service-account JSON stays a Supabase Edge Function
//      secret — never put it in this file.
// ────────────────────────────────────────────────────────────────────
self.FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: 'dailywater',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
  measurementId: '',
  vapidKey: ''
};
