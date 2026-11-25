const cacheName = 'meu-controle-v26';
const files = ['./','./index.html','./style.css?v=26','./app.mjs?v=26','./ledger.mjs','./ledger.mjs?v=21','./sync.mjs?v=13','./dashboard.mjs?v=21','./sms.mjs?v=24','./pairing.mjs?v=24','./qrcode.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./pdf.mjs','./pdf.worker.mjs',
  './ocr.mjs?v=8','./ocr/tesseract.mjs','./ocr/worker.min.js','./ocr/tesseract-core-lstm.wasm.js','./ocr/por.traineddata.gz'];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(cacheName);
  await Promise.all(files.map(async path => {
    const key = new URL(path, self.location);
    const fresh = new URL(key);
    fresh.searchParams.set('cache', cacheName);
    const response = await fetch(fresh, {cache: 'reload'});
    if (!response.ok) throw new Error('Falha ao armazenar ' + key.pathname);
    await cache.put(key, response);
  }));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('meu-controle-') && key !== cacheName).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  if (event.request.method === 'GET' && new URL(event.request.url).origin === self.location.origin) {
    event.respondWith(caches.open(cacheName).then(cache => cache.match(event.request)).then(response => response || fetch(event.request)));
  }
});
