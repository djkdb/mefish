// 찜멍 서비스 워커
// - HTML: 네트워크 우선 (업데이트가 바로 보이게), 실패하면 저장본
// - three.js(버전 고정)·글꼴·아이콘: 저장본 우선 → 두 번째부터 빠르게, 오프라인에서도 혼자 모드
// - /ws(실시간 연결)와 다른 요청은 건드리지 않아요.
const VER = 'jjimmung-v1';
const PRECACHE = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const PINNED = [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\//, /^https:\/\/cdn\.jsdelivr\.net\/gh\/orioncactus\/pretendard@v1\.3\.9\//];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname === '/ws' || req.headers.get('upgrade') === 'websocket') return;
  const same = url.origin === self.location.origin;
  if (req.mode === 'navigate' || (same && (url.pathname.endsWith('/') || url.pathname.endsWith('.html')))) {
    const key = url.origin + url.pathname; // ?room= 같은 쿼리는 한 칸에
    e.respondWith(fetch(req).then(res => { if (res.ok) { const cp = res.clone(); caches.open(VER).then(c => c.put(key, cp)); } return res; })
      .catch(() => caches.match(key).then(r => r || caches.match(req, { ignoreSearch: true })).then(r => r || caches.match('./'))));
    return;
  }
  if (PINNED.some(r => r.test(req.url)) || (same && /\/icons\/|manifest\.webmanifest$|og\.jpg$/.test(url.pathname))) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const cp = res.clone(); caches.open(VER).then(c => c.put(req, cp)); }
      return res;
    })));
  }
});
