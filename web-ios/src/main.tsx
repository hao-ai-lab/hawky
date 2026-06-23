import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getStoredDeviceToken, useSocketStore } from "./lib/socket-store";
import { useNotifications } from "./lib/notifications";
import { useSessionStore } from "./lib/session-store";
import { applyTheme, useTheme } from "./lib/theme";
import "./styles.css";

// Apply the saved theme (light/dark/system) before first paint.
applyTheme(useTheme.getState().pref);

// Relative "/ws" works in dev (Vite proxy) and prod (gateway serves the app).
const GATEWAY_WS_URL = "/ws";

// The active session (from ?session= URL → localStorage → default). Reflect it
// in the URL on load so a reloaded/shared link stays on the same session.
const activeKey = useSessionStore.getState().activeKey;
useSessionStore.getState().setActive(activeKey);

// Connect outside React so it survives StrictMode double-invoke + HMR.
void useSocketStore
  .getState()
  .connect({ url: GATEWAY_WS_URL, sessionKey: activeKey, token: getStoredDeviceToken() })
  .catch(() => {
    // Error is captured in the store; the UI surfaces "Disconnected".
  });

// Surface fired reminders/notifications (notification.received) live while the
// tab is open. Closed-tab Web Push would need a service worker (not set up here).
useSocketStore.getState().subscribe((e) => useNotifications.getState().handleEvent(e));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
