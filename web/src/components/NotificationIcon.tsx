// =============================================================================
// Notification Icon — Header Bar
//
// Minimalist bell icon for push notification status.
// Filled bell = subscribed, outline bell = not subscribed.
// Click toggles subscription. Tooltip on hover/tap.
// =============================================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useSocketStore } from "../store/socket-store";
import {
  type PushState,
  getPushState,
  getActiveSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from "../lib/push";

export function NotificationIcon() {
  const [pushState, setPushState] = useState<PushState>("unsupported");
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const rpc = useSocketStore((s) => s.rpc);
  const status = useSocketStore((s) => s.status);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch VAPID key and determine push state
  useEffect(() => {
    if (status !== "connected" || !rpc) return;

    let cancelled = false;
    (async () => {
      try {
        const result = (await rpc("push.vapidKey", {})) as {
          enabled: boolean;
          publicKey: string | null;
        };

        if (cancelled) return;

        const pushEnabled = result.enabled && !!result.publicKey;
        if (pushEnabled) setVapidPublicKey(result.publicKey);

        let state = getPushState(pushEnabled);

        if (state === "prompt" && "Notification" in window && Notification.permission === "granted") {
          const existing = await getActiveSubscription();
          if (existing && !cancelled) state = "subscribed";
        }

        if (!cancelled) setPushState(state);
      } catch {
        if (!cancelled) setPushState("disabled");
      }
    })();

    return () => { cancelled = true; };
  }, [status, rpc]);

  const handleClick = useCallback(async () => {
    // If not actionable, just show tooltip
    if (pushState === "unsupported" || pushState === "disabled" || pushState === "not-standalone" || pushState === "denied") {
      setShowTooltip(true);
      setTimeout(() => setShowTooltip(false), 2000);
      return;
    }

    if (!rpc || !vapidPublicKey) return;

    setPushState("subscribing");
    try {
      const newState = pushState === "subscribed"
        ? await unsubscribeFromPush(rpc)
        : await subscribeToPush(vapidPublicKey, rpc);
      if (mountedRef.current) setPushState(newState);
    } catch {
      if (mountedRef.current) setPushState("error");
    }
  }, [pushState, vapidPublicKey, rpc]);

  // Don't render if push is completely unavailable
  if (pushState === "unsupported" || pushState === "disabled") {
    return null;
  }

  const tooltip =
    pushState === "subscribed" ? "Notifications on" :
    pushState === "subscribing" ? "Subscribing..." :
    pushState === "denied" ? "Notifications blocked" :
    pushState === "not-standalone" ? "Install app first" :
    pushState === "error" ? "Notification error" :
    "Notifications off";

  const isActive = pushState === "subscribed";

  return (
    <div
      className="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        onClick={handleClick}
        className={`p-1.5 rounded-lg transition-colors ${
          isActive
            ? "text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
            : "text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
        }`}
        aria-label={tooltip}
        data-testid="notification-icon"
      >
        {isActive ? (
          /* Filled bell — subscribed */
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M5.85 3.5a.75.75 0 00-1.117-1 9.719 9.719 0 00-2.348 4.876.75.75 0 001.479.248A8.219 8.219 0 015.85 3.5zM19.267 2.5a.75.75 0 10-1.118 1 8.22 8.22 0 011.987 4.124.75.75 0 001.48-.248A9.72 9.72 0 0019.266 2.5z" />
            <path fillRule="evenodd" d="M12 2.25A6.75 6.75 0 005.25 9v.75a8.217 8.217 0 01-2.119 5.52.75.75 0 00.298 1.206c1.544.57 3.16.99 4.831 1.243a3.75 3.75 0 007.48 0 24.583 24.583 0 004.83-1.244.75.75 0 00.298-1.205 8.217 8.217 0 01-2.118-5.52V9A6.75 6.75 0 0012 2.25zM9.75 18c0-.034 0-.067.002-.1a25.05 25.05 0 004.496 0l.002.1a2.25 2.25 0 01-4.5 0z" clipRule="evenodd" />
          </svg>
        ) : pushState === "denied" ? (
          /* Bell with slash — blocked */
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.143 17.082a24.248 24.248 0 005.714 0m-7.03-7.357L3.75 15.75h16.5l-4.077-6.025M12 2.25A6.75 6.75 0 005.25 9v.75" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3l18 18" />
          </svg>
        ) : (
          /* Outline bell — not subscribed */
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
        )}
        {pushState === "subscribing" && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-stone-400 animate-pulse" />
        )}
      </button>

      {showTooltip && (
        <div className="absolute right-0 top-full mt-1 px-2 py-1 rounded-md bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-800 text-xs whitespace-nowrap shadow-md z-50">
          {tooltip}
        </div>
      )}
    </div>
  );
}
