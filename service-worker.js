// 캐시 버전은 배포 때마다 올려줘
const CACHE_NAME = 'island-chat-v1.2.0';

// 배포 산출물만 프리캐시(상대경로: GitHub Pages 하위경로 호환)
const PRECACHE = [
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'rules.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// 즉시 활성화 설정
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    ).then(() => self.clients.claim())
  );
});

// 요청별 전략:
// - HTML(Document): 네트워크우선 → 실패 시 캐시 index.html (오프라인 폴백)
// - JS/CSS: 네트워크우선(업데이트 잘 반영) → 실패 시 캐시
// - rules.json: 네트워크우선(항상 최신 규칙 반영) → 실패 시 캐시
// - 아이콘/이미지: 캐시우선(오프라인 성능)
// - 그 외: 캐시매치 없으면 네트워크
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // 같은 오리진만 SW가 적극 처리(외부 CDN은 통과; CORS 이슈 회피)
  const sameOrigin = url.origin === location.origin;

  if (req.mode === 'navigate') {
    // SPA 라우팅/새로고침 지원 + 오프라인 폴백
    e.respondWith(
      fetch(req).catch(() => caches.match('index.html'))
    );
    return;
  }

  // 규칙파일: 항상 최신 시도
  if (sameOrigin && url.pathname.endsWith('/rules.json') || url.pathname.endsWith('rules.json')) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // JS/CSS: 네트워크우선
  if (sameOrigin && (req.destination === 'script' || req.destination === 'style')) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 이미지/아이콘: 캐시우선
  if (sameOrigin && (req.destination === 'image' || req.destination === 'font')) {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // 기본: 캐시 매치 → 네트워크
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
