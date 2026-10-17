/* PayCostBattle の Service Worker（PWA用）。
 *  - 素材（assets/・eq/）：初回に保存し、2回目以降は保存分をすぐ返す（読み込みが速くなる）
 *  - ページ本体（battle.html など）：まずネットワークを見る（更新をすぐ取り込む）。圏外のときだけ保存分を使う
 *  - リリースごとに保存先の名前を変える（20261017134224 は tools/build-public.mjs が埋める）。古い保存先は、起動時に消す
 *  - 別のサイト（Firebaseなど）への通信には触らない
 */
const VER = '20261017134224';
const CACHE = 'pcb-' + VER;
const SHELL = ['./battle.html', './engine.js', './firebase-config.js', './manifest.webmanifest', './icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pcb-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/\/(assets|eq)\//.test(url.pathname)) {
    // 素材：保存分があればそれを返す。無ければ取得して保存する
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // ページ本体など：ネットワーク優先。圏外なら保存分（招待URLの ?room=... は無視して battle.html を返す）
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((h) => h || caches.match('./battle.html', { ignoreSearch: true })))
  );
});
