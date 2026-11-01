const CACHE = 'yotei-v4-0-2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './assets/icon-192.png', './assets/icon-512.png', './assets/icon-180.png', './assets/icon-maskable-512.png', './assets/icon.svg', './assets/favicon.svg', './assets/favicon-32.png', './src/styles.css', './src/js/main.js', './src/js/wave.js', './src/js/setupplan.js', './src/js/edui.js', './src/js/history.js', './src/js/util.js', './src/js/icons.js', './src/js/about.js', './src/js/templates.js', './src/js/science.js', './src/js/engine.js', './src/js/rhythm.js', './src/js/validate.js', './src/js/storage.js', './src/js/dates.js', './src/js/migrate.js', './src/js/tasks.js', './src/js/inbox.js', './src/js/todo.js', ];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pages: network first so updates arrive, cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('./index.html', copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html') || caches.match('./'))));
    return;
  }

  // Google Fonts and same-origin assets: serve from cache, refresh in the background.
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (fonts || url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })));
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.length ? cs[0].focus() : clients.openWindow('./')));
});
