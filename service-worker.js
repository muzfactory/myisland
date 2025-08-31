const CACHE_NAME = 'island-chat-v1.1.1';
const ASSETS = [
   'index.html',
   'style.css',
   'app.js',
   'manifest.json',
   'rules.json',
   'icons/icon-192.png',
   'icons/icon-512.png'
 ];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null))));
});

self.addEventListener('fetch', (e) => {
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});
