const CACHE_NAME = 'atrium-web-shell-v1';

function cacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return false;
  return !(
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/ws')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add('/'))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!cacheable(request)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});

function appBadge(value) {
  const badge =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : null;
  if (badge === null || !self.navigator) return Promise.resolve();
  if (badge > 0 && typeof self.navigator.setAppBadge === 'function') {
    return self.navigator.setAppBadge(badge).catch(() => {});
  }
  if (badge === 0 && typeof self.navigator.clearAppBadge === 'function') {
    return self.navigator.clearAppBadge().catch(() => {});
  }
  return Promise.resolve();
}

function payloadFromPush(event) {
  try {
    return event.data?.json() ?? {};
  } catch {
    return {};
  }
}

self.addEventListener('push', (event) => {
  const payload = payloadFromPush(event);
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Atrium';
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: typeof payload.body === 'string' ? payload.body : undefined,
        tag: typeof payload.tag === 'string' ? payload.tag : undefined,
        data,
        icon: '/favicon.svg',
      }),
      appBadge(payload.badge),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data =
    event.notification.data && typeof event.notification.data === 'object'
      ? event.notification.data
      : {};
  const message = { type: 'notification-click', ...data };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const existing = clients[0];
      if (existing) {
        await existing.focus();
        existing.postMessage(message);
        return;
      }
      const params = new URLSearchParams();
      if (typeof data.channelId === 'string') params.set('channel', data.channelId);
      if (typeof data.sessionId === 'string') params.set('session', data.sessionId);
      const query = params.toString();
      const url = query ? `/?${query}` : '/';
      const opened = await self.clients.openWindow(url);
      opened?.postMessage(message);
    }),
  );
});
