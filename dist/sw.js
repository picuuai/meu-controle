const cacheName = 'meu-controle-v2';
const files = ['./','./index.html','./style.css','./app.mjs','./ledger.mjs','./sync.mjs','./manifest.webmanifest','./icon-192.png','./icon-512.png','./pdf.mjs','./pdf.worker.mjs'];
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('meu-controle-') && key !== cacheName).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  if (event.request.method === 'GET' && new URL(event.request.url).origin === self.location.origin) {
    event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
  }
});
