// Upgrade only the old Pan Battle cache worker. Preserve localStorage and unrelated caches.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await caches.delete('panbattle-v1');
    await self.clients.claim();
    const scope = self.registration.scope;
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.filter(client => client.url.startsWith(scope)).map(client => client.navigate(client.url)));
  })());
});
