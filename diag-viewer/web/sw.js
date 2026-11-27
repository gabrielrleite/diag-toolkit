'use strict';
// Service worker da Central diag: guarda a interface (HTML, CSS, JS, ícones) para abrir a página sem o servidor.
// Só funciona em HTTPS ou localhost (exigência dos navegadores). Os dados (api/) não passam por aqui: o
// offline.js guarda a cópia e a fila de alterações.
const CACHE = 'central-diag-v3';
const BASE = ['./', 'index.html', 'style.css', 'report.css', 'icones.svg', 'tema.js', 'app.js', 'offline.js', 'instalar.js', 'saude.js', 'receb-ocr.js',
  'receb-textos.js', 'recebimentos.js', 'receb-cadastro.js', 'receb-manual.js', 'monitor.js', 'laudos.js', 'assinatura.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-180.png', 'icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// rede primeiro (sempre a versão nova quando o servidor responde); sem servidor, a cópia guardada
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith((async () => {
    try {
      const r = await fetch(req, { signal: AbortSignal.timeout(6000) });
      if (r.ok && r.type === 'basic') { const c = await caches.open(CACHE); c.put(req, r.clone()).catch(() => {}); }
      return r;
    } catch {
      const c = await caches.match(req, { ignoreSearch: true });
      if (c) return c;
      if (req.mode === 'navigate') { const i = await caches.match('index.html'); if (i) return i; }
      return new Response('Sem conexão com o servidor.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
