// おトクナビ Service Worker
// アプリ本体はキャッシュ優先（オフラインでも開ける）、キャンペーン情報はネット優先（常に最新を取りに行く）。
// アプリを更新したら VERSION を上げる。
const VERSION = 'v1';
const CACHE = 'otoku-' + VERSION;
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'data/chains.json',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('otoku-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // キャンペーン情報: ネット優先、失敗したらキャッシュ
  if (sameOrigin && url.pathname.endsWith('/data/campaigns.json')) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req)),
    );
    return;
  }
  // アプリ本体・ライブラリ: キャッシュ優先
  if (sameOrigin || url.host === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
  // 地図タイル・お店データ・地名検索はキャッシュせずそのまま通す
});
