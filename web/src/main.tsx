import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getStoredDeviceToken, useSocketStore } from "./store/socket-store";
import { useSessionStore } from "./store/session-store";
import "./styles/globals.css";

// Gateway WebSocket URL: relative "/ws" works in both dev (Vite proxy) and production (same origin).
const GATEWAY_WS_URL = "/ws";

// Check for session key from notification click URL (?session=cron:job-id)
const urlParams = new URLSearchParams(window.location.search);
const DEFAULT_SESSION_KEY = urlParams.get("session") ?? "web:general";

// Clean up URL param after reading (don't leave ?session= in the URL bar)
if (urlParams.has("session")) {
  window.history.replaceState({}, "", window.location.pathname);
}

// Initialize session store with the target session BEFORE connecting,
// so App.tsx's connect effect doesn't override it back to "web:general".
if (DEFAULT_SESSION_KEY !== "web:general") {
  useSessionStore.setState({ activeKey: DEFAULT_SESSION_KEY });
}

// Connect OUTSIDE React lifecycle — survives StrictMode double-invoke and HMR.
// The Zustand store is a singleton; components subscribe to slices.
// Use stored device token if available (from previous browser auth).
const storedDeviceToken = getStoredDeviceToken();
void useSocketStore.getState().connect({
  url: GATEWAY_WS_URL,
  sessionKey: DEFAULT_SESSION_KEY,
  token: storedDeviceToken,
}).catch(() => {
  // Connection error captured in store.error — UI will show "Disconnected"
});

// Detect service worker updates — show a reload prompt when new code is available.
// Without this, the old SW serves stale cached JS until the user clears site data.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.ready.then((registration) => {
    // Check for updates periodically (every 60s)
    setInterval(() => registration.update().catch(() => {}), 60_000);

    const onNewSW = (sw: ServiceWorker) => {
      if (sw.state === "installed") {
        showUpdateBanner(sw);
      } else {
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed") showUpdateBanner(sw);
        });
      }
    };

    registration.addEventListener("updatefound", () => {
      const newSW = registration.installing;
      if (newSW) onNewSW(newSW);
    });

    // Also check if there's already a waiting SW (page loaded after SW updated in background)
    if (registration.waiting) showUpdateBanner(registration.waiting);
  });
}

function showUpdateBanner(waitingSW: ServiceWorker): void {
  // Don't show duplicate banners
  if (document.getElementById("hawky-update-banner")) return;

  const banner = document.createElement("div");
  banner.id = "hawky-update-banner";
  banner.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;" +
    "background:#1a1a2e;color:#e5e5e5;padding:12px 20px;border-radius:8px;" +
    "font-family:system-ui,sans-serif;font-size:14px;display:flex;align-items:center;gap:12px;" +
    "box-shadow:0 4px 12px rgba(0,0,0,0.4);border:1px solid #333;";
  banner.innerHTML =
    '<span>New version available</span>' +
    '<button id="hawky-update-btn" style="background:#60a5fa;color:#000;border:none;' +
    'padding:6px 16px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500;">Reload</button>';
  document.body.appendChild(banner);

  document.getElementById("hawky-update-btn")!.addEventListener("click", () => {
    waitingSW.postMessage({ type: "SKIP_WAITING" });
    window.location.reload();
  });
}

// Listen for messages from service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    // Notification click → navigate to the relevant session
    if (event.data?.type === "notification-click" && event.data.sessionKey) {
      void useSessionStore.getState().switchSession(event.data.sessionKey);
    }
    // Push subscription rotated by browser → re-subscribe with gateway
    if (event.data?.type === "push-subscription-changed") {
      void (async () => {
        try {
          const rpc = useSocketStore.getState().rpc;
          const reg = await navigator.serviceWorker.ready;
          const newSub = await reg.pushManager.getSubscription();
          if (newSub) {
            const sub = newSub.toJSON();
            await rpc("push.subscribe", {
              subscription: { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime },
            });
          }
          // Clean up old endpoint if provided
          if (event.data.oldEndpoint) {
            await rpc("push.unsubscribe", { endpoint: event.data.oldEndpoint });
          }
        } catch (err) {
          console.error("Failed to re-register push subscription after rotation:", err);
        }
      })();
    }
  });
}

// Expose store in dev for manual testing (console: window.__socketStore.getState().rpc(...))
if (import.meta.env.DEV) {
  (window as any).__socketStore = useSocketStore;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
