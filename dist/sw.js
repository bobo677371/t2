/* sw.js — Service Worker
 *
 * 策略：**网络优先，失败回退缓存**
 *   - 不做「缓存优先」，因为之前已经被旧文件坑过一次（CSS 覆盖 hidden 那次）
 *   - 联网时永远拿最新；断网时用上次缓存的外壳，至少能打开看到界面
 *
 * 不缓存：东财行情接口（数据必须新鲜，宁可报错也不给旧数据）
 *
 * 改版本号即可让旧缓存失效。
 */
const VERSION = 'v8';
const CACHE = 't2-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './style.css?v=' + VERSION,
  './app.js?v=' + VERSION,
  './chart.js?v=' + VERSION,
  './ui.js?v=' + VERSION,
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const API_HOSTS = ['push2his.eastmoney.com', 'push2.eastmoney.com', 'searchapi.eastmoney.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 行情接口：直连，不缓存
  if (API_HOSTS.includes(url.hostname)) return;

  // 只管同源
  if (url.origin !== self.location.origin) return;

  // symbols.json 体积大且很少变：网络优先，失败回退
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => {
        if (hit) return hit;
        if (req.mode === 'navigate') {
          return caches.match('./index.html').then(h2 =>
            h2 || new Response('<h1>离线</h1><p>没有可用缓存</p>', {
              status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }));
        }
        return new Response('离线，且没有缓存', {
          status: 503, statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }))
  );
});



