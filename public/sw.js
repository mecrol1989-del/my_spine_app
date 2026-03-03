// Service Worker for MySpine Chat PWA
const CACHE_NAME = 'myspine-chat-v1';
const STATIC_ASSETS = [
    '/',
    '/style.css',
    '/app.js',
    '/icon-192.png',
    '/icon-512.png'
];

// Install — cache static assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', event => {
    // Don't cache API calls or SSE
    if (event.request.url.includes('/api/') || event.request.url.includes('/webhook')) {
        return;
    }
    event.respondWith(
        fetch(event.request)
            .then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// Push Notification
self.addEventListener('push', event => {
    let data = { title: 'MySpine Chat', body: 'New message received' };

    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [200, 100, 200],
        tag: data.tag || 'new-message',
        renotify: true,
        data: {
            url: data.url || '/',
            chatId: data.chatId
        }
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// Click on notification — open chat
self.addEventListener('notificationclick', event => {
    event.notification.close();

    const url = event.notification.data.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // Focus existing window if open
            for (const client of windowClients) {
                if (client.url.includes(self.location.origin)) {
                    client.focus();
                    if (event.notification.data.chatId) {
                        client.postMessage({
                            type: 'OPEN_CHAT',
                            chatId: event.notification.data.chatId
                        });
                    }
                    return;
                }
            }
            // Otherwise open new window
            return clients.openWindow(url);
        })
    );
});
