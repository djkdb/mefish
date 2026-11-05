// 찌멍 서비스 워커: 화면(HTML)은 항상 새로 받고(실패하면 저장본), three.js·글꼴·아이콘은 저장본 먼저.
// 실시간 연결(/ws)은 건드리지 않아요.
const V = 'jjimeong-v1';
const PRE = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(PRE)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const put = (req, res) => caches.open(V).then(c => c.put(req, res)).catch(() => {});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname === '/ws' || req.headers.get('upgrade') === 'websocket') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { put(req, r.clone()); return r; }).catch(() => caches.match(req).then(r => r || caches.match('./'))));
    return;
  }
  const pinned = url.host === 'cdn.jsdelivr.net' || (url.origin === location.origin && (url.pathname.includes('/icons/') || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('.jpg')));
  if (pinned) e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === 'opaque') put(req, r.clone()); return r; })));
});
