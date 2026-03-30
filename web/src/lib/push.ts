// =============================================================================
// Client-side Push Subscription Management
//
// Handles: permission request, PushManager subscription, gateway RPC calls.
// Works with the custom service worker (sw-custom.ts) push event handler.
// =============================================================================

/** Push subscription state for UI display */
export type PushState =
  | "unsupported"     // Browser doesn't support push or not in secure context
  | "not-standalone"  // iOS Safari — must install PWA first
  | "disabled"        // Gateway has no VAPID configured
  | "prompt"          // Permission not yet asked — show enable toggle
  | "denied"          // User denied permission — show instructions to unblock
  | "subscribing"     // Subscription in progress
  | "subscribed"      // Active push subscription
  | "error";          // Subscription failed

/**
 * Determine the current push notification state.
 * @param pushEnabled Whether the gateway reported push as enabled (from push.vapidKey RPC)
 */
export function getPushState(pushEnabled: boolean): PushState {
  // Check browser support
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }

  // On iOS, push only works from installed PWA (standalone mode)
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS && !isStandalone) {
    return "not-standalone";
  }

  // Gateway must have VAPID configured
  if (!pushEnabled) {
    return "disabled";
  }

  // Check permission state
  const permission = Notification.permission;
  if (permission === "denied") {
    return "denied";
  }
  if (permission === "default") {
    return "prompt";
  }

  // Permission granted — check if we have an active subscription
  // (Caller should check via getActiveSubscription and override to "subscribed" if found)
  return "prompt";
}

/**
 * Convert a VAPID public key string to the Uint8Array format needed by PushManager.
 * VAPID keys are base64url-encoded.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Get the active push subscription from the service worker, if any.
 */
export async function getActiveSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Subscribe to push notifications.
 * Requests permission if needed, creates PushManager subscription,
 * and sends it to the gateway via the provided RPC function.
 *
 * @param vapidPublicKey The VAPID public key from gateway (push.vapidKey RPC)
 * @param rpc Function to call gateway RPC methods
 * @returns The push state after subscription attempt
 */
export async function subscribeToPush(
  vapidPublicKey: string,
  rpc: (method: string, params: unknown) => Promise<unknown>,
): Promise<PushState> {
  // Request notification permission
  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    return "denied";
  }
  if (permission !== "granted") {
    return "prompt";
  }

  try {
    const registration = await navigator.serviceWorker.ready;

    // Subscribe with VAPID key
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
    });

    // Send subscription to gateway
    const sub = subscription.toJSON();
    await rpc("push.subscribe", {
      subscription: {
        endpoint: sub.endpoint,
        keys: sub.keys,
        expirationTime: sub.expirationTime,
      },
    });

    return "subscribed";
  } catch (err) {
    console.error("Push subscription failed:", err);
    return "error";
  }
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(
  rpc: (method: string, params: unknown) => Promise<unknown>,
): Promise<PushState> {
  try {
    const subscription = await getActiveSubscription();
    if (subscription) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await rpc("push.unsubscribe", { endpoint });
    }
    return "prompt";
  } catch (err) {
    console.error("Push unsubscribe failed:", err);
    return "error";
  }
}
