// =============================================================================
// Push Notification Settings
//
// Toggle for enabling/disabling push notifications.
// Shows contextual state: unsupported, must install PWA, blocked, enabled.
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

export function PushSettings() {
  const [pushState, setPushState] = useState<PushState>("unsupported");
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
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

        // If permission already granted, check for existing subscription
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

  const handleToggle = useCallback(async () => {
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

  // Don't render if push is not available at all
  if (pushState === "unsupported" || pushState === "disabled") {
    return null;
  }

  return (
    <div className="px-4 py-2" data-testid="push-settings">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <BellIcon />
          <span className="text-sm text-gray-600 dark:text-gray-400 truncate">
            Notifications
          </span>
        </div>
        {pushState === "not-standalone" ? (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            Install app first
          </span>
        ) : pushState === "denied" ? (
          <span className="text-xs text-red-400">Blocked</span>
        ) : pushState === "subscribing" ? (
          <span className="text-xs text-gray-400 animate-pulse">...</span>
        ) : pushState === "error" ? (
          <span className="text-xs text-red-400">Error</span>
        ) : (
          <button
            onClick={handleToggle}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              pushState === "subscribed"
                ? "bg-stone-800 dark:bg-stone-300"
                : "bg-stone-300 dark:bg-stone-600"
            }`}
            aria-label={pushState === "subscribed" ? "Disable notifications" : "Enable notifications"}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                pushState === "subscribed" ? "translate-x-4" : "translate-x-1"
              }`}
            />
          </button>
        )}
      </div>
      {pushState === "denied" && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Unblock in browser settings
        </p>
      )}
      {pushState === "not-standalone" && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Add to Home Screen first
        </p>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  );
}
