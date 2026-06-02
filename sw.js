// Minimal service worker — required for PWA installability.
// No caching: the Flask backend must be running for the app to work,
// so offline support would be misleading. Registration alone enables
// "Add to Home Screen" on Chrome/Safari when served over localhost.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
