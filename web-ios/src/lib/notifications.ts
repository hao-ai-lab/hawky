// =============================================================================
// Notifications — live in-app delivery for web-ios.
//
// When a reminder/cron/intention fires, the gateway broadcasts a
// `notification.received` WebSocket event to subscribed clients (see
// src/gateway/notification.ts). With the tab open, we surface it as a toast and
// (best-effort) a desktop Notification. Closed-tab Web Push is NOT handled here
// — that needs a service worker / PWA install (see the web/ app).
// =============================================================================

import { create } from "zustand";
import type { EventFrame } from "@hawky/protocol";

export interface AppNotification {
  id: string;
  title?: string;
  body: string;
  origin?: string;
  at: string;
}

interface NotificationState {
  toasts: AppNotification[];
  dismiss: (id: string) => void;
  handleEvent: (e: EventFrame) => void;
}

function nid(): string {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const seenNotificationIds = new Set<string>();
const MAX_SEEN_NOTIFICATION_IDS = 200;

function rememberNotificationId(id: string): boolean {
  if (seenNotificationIds.has(id)) return false;
  seenNotificationIds.add(id);
  if (seenNotificationIds.size > MAX_SEEN_NOTIFICATION_IDS) {
    const first = seenNotificationIds.values().next().value;
    if (first) seenNotificationIds.delete(first);
  }
  return true;
}

export function resetNotificationsForTests(): void {
  seenNotificationIds.clear();
  useNotifications.setState({ toasts: [] });
}

export const useNotifications = create<NotificationState>((set, get) => ({
  toasts: [],

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  handleEvent: (e) => {
    if (e.event !== "notification.received") return;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const body = typeof p.body === "string" ? p.body : typeof p.message === "string" ? p.message : "";
    if (!body) return;
    const eventId = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
    if (eventId && !rememberNotificationId(eventId)) return;
    const n: AppNotification = {
      id: eventId ?? nid(),
      title: typeof p.title === "string" ? p.title : undefined,
      body,
      origin: typeof p.origin === "string" ? p.origin : undefined,
      at: new Date().toLocaleTimeString(),
    };
    set((s) => ({ toasts: [...s.toasts, n].slice(-5) }));

    // Best-effort desktop notification when the page is in the background.
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        new Notification(n.title ?? "Hawk", { body: n.body });
      }
    } catch { /* not supported */ }

    // Auto-dismiss the toast after a while.
    const id = n.id;
    setTimeout(() => get().dismiss(id), 8000);
  },
}));
