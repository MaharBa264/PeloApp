// Service worker mínimo: hace instalable la app y muestra un aviso sin conexión.
// No guarda respuestas en caché, así que nunca sirve datos ni versiones viejas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="es-AR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexión</title><body style="font-family:system-ui;padding:32px;max-width:480px;margin:auto"><h1>Sin conexión</h1><p>PeloApp necesita internet para registrar consumos y pagos. Volvé a intentar cuando recuperes la conexión.</p><button onclick="location.reload()" style="padding:12px 18px;font-size:16px">Reintentar</button></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
