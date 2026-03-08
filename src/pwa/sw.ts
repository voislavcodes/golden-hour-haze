/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'ghz-shell-v1';

const APP_SHELL: string[] = [
  '/',
  '/index.html',
  '/manifest.json',
];

/**
 * Install: pre-cache the app shell assets.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  // Activate immediately without waiting for open tabs to close
  self.skipWaiting();
});

/**
 * Activate: clean up old caches.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

/**
 * Fetch: network-first strategy.
 * Try the network, fall back to cache if offline.
 * Cache successful network responses for future offline use.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip cross-origin requests
  if (!request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        // Clone before caching since response body can only be consumed once
        const cloned = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, cloned);
        });
        return networkResponse;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // For navigation requests, serve the shell
          if (request.mode === 'navigate') {
            return caches.match('/index.html') as Promise<Response>;
          }
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        }),
      ),
  );
});

export {};
