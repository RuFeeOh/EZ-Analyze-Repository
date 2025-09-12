// Basic service worker for offline caching (static assets + index fallback)
const CACHE_NAME = 'ezanalyze-static-v1';
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/manifest.webmanifest'
];
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(CORE_ASSETS);
    })());
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    })());
});
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    event.respondWith((async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
            const net = await fetch(req);
            // Cache opaque & basic GET responses
            if (net.status === 200 && (net.type === 'basic' || net.type === 'cors')) {
                const cache = await caches.open(CACHE_NAME);
                cache.put(req, net.clone());
            }
            return net;
        } catch {
            // Fallback to index for navigation requests
            if (req.mode === 'navigate') {
                return caches.match('/index.html');
            }
            throw new Error('Network error and no cache');
        }
    })());
});
