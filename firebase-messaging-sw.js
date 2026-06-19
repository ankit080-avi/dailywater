// ────────────────────────────────────────────────────────────────────
// Firebase Cloud Messaging service worker — receives push messages when
// the web app is closed/backgrounded and shows a system notification.
// Loaded by Push.registerWeb() in app.js via navigator.serviceWorker.register.
// ────────────────────────────────────────────────────────────────────

// Pull in the same config used by the main page
importScripts('firebase-config.js');

// Compat scripts so this works inside a classic service worker (no ES modules)
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

if (self.FIREBASE_CONFIG && self.FIREBASE_CONFIG.apiKey) {
  firebase.initializeApp(self.FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  // Background push → render the system notification
  messaging.onBackgroundMessage((payload) => {
    const n = payload.notification || {};
    const data = payload.data || {};
    self.registration.showNotification(n.title || 'MilkMate', {
      body: n.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: data.tag || 'mm-notif',
      data
    });
  });
}

// Tap a notification → focus the app or open it
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
