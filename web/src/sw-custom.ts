// =============================================================================
// Custom Service Worker
//
// Extends VitePWA's generated service worker with push notification handlers.
// Uses injectManifest strategy: Workbox precaching + custom push/notification code.
//
// Handles:
// 1. Precaching (Workbox) — same as previous generateSW mode
// 2. Push events — show notifications from gateway
// 3. Notification clicks — open/focus PWA and navigate to session
// =============================================================================

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";

// -----------------------------------------------------------------------------
// Workbox precaching (same behavior as previous generateSW mode)
// -----------------------------------------------------------------------------

// self.__WB_MANIFEST is injected by VitePWA at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigation fallback: serve cached index.html for all navigation requests
// except /ws, /api, /health paths. This is critical for standalone PWA mode
// where the service worker controls all page loads.
const navigationHandler = createHandlerBoundToURL("/index.html");
registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/ws/, /^\/api/, /^\/health/, /^\/auth/],
  }),
);

// skipWaiting() makes the new SW activate immediately (skip the "waiting" phase).
// We do NOT call clientsClaim() automatically — that would make the new SW take
// control of already-open pages mid-load, which disrupts active WebSocket
// connections on iOS Safari. Instead, the page sends a SKIP_WAITING message
// when the user explicitly clicks "Reload" on the update banner.
self.skipWaiting();

// Handle explicit SKIP_WAITING from the page (user clicked "Reload" on update banner)
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// -----------------------------------------------------------------------------
// Push notification handler
// -----------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let title = "Hawky";
  let body = "";
  let data: Record<string, unknown> = {};

  try {
    const parsed = event.data.json();
    title = parsed.title ?? title;
    body = parsed.body ?? body;
    data = parsed.data ?? data;
  } catch {
    body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/pwa-icon-192.png",
      data,
      requireInteraction: false,
      tag: "hawky-push",
    }),
  );
});

// -----------------------------------------------------------------------------
// Notification click handler
// -----------------------------------------------------------------------------

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data as { sessionKey?: string; url?: string } | undefined;
  const targetUrl = data?.url ?? "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      // If the app is already open, focus it
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin) {
          // Post message to client with session key for navigation
          if (data?.sessionKey) {
            client.postMessage({
              type: "notification-click",
              sessionKey: data.sessionKey,
            });
          }
          return client.focus();
        }
      }

      // Otherwise open a new window
      const url = data?.sessionKey
        ? `${targetUrl}?session=${encodeURIComponent(data.sessionKey)}`
        : targetUrl;
      return self.clients.openWindow(url);
    }),
  );
});

// -----------------------------------------------------------------------------
// Push subscription change handler
//
// When the browser rotates or expires a push subscription, re-subscribe
// directly in the service worker. We can't rely on an open page being
// available — if no page is open, the postMessage approach silently fails
// and push stops permanently.
// -----------------------------------------------------------------------------

self.addEventListener("pushsubscriptionchange", (event: Event) => {
  const pushEvent = event as unknown as {
    oldSubscription?: PushSubscription;
    newSubscription?: PushSubscription;
    waitUntil: (p: Promise<unknown>) => void;
  };

  pushEvent.waitUntil(
    (async () => {
      try {
        // Re-subscribe with the same options as the old subscription
        const oldSub = pushEvent.oldSubscription;
        const newSub = pushEvent.newSubscription ??
          await self.registration.pushManager.subscribe(
            oldSub?.options ?? { userVisibleOnly: true },
          );

        if (!newSub) return;

        // Send the new subscription to the gateway via fetch (not WS RPC,
        // since no page may be open)
        const sub = newSub.toJSON();
        await fetch("/api/push-resubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newSubscription: { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime },
            oldEndpoint: oldSub?.endpoint,
          }),
        });

        // Also notify any open pages
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) {
          client.postMessage({
            type: "push-subscription-changed",
            oldEndpoint: oldSub?.endpoint,
            newEndpoint: newSub.endpoint,
          });
        }
      } catch (err) {
        console.error("[sw] pushsubscriptionchange re-subscribe failed:", err);
      }
    })(),
  );
});
