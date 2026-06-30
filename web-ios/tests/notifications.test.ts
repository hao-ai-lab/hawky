import { describe, it, expect, beforeEach } from "vitest";
import { resetNotificationsForTests, useNotifications } from "../src/lib/notifications";

beforeEach(() => resetNotificationsForTests());

describe("live notifications (notification.received)", () => {
  it("surfaces a fired reminder as a toast", () => {
    useNotifications.getState().handleEvent({
      type: "event", event: "notification.received", seq: 1,
      payload: { title: "Hawky: standup", body: "Time for standup", origin: "cron:standup" },
    } as any);
    const toasts = useNotifications.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe("Hawky: standup");
    expect(toasts[0].body).toBe("Time for standup");
    expect(toasts[0].origin).toBe("cron:standup");
  });

  it("accepts `message` as the body too", () => {
    useNotifications.getState().handleEvent({
      type: "event", event: "notification.received", seq: 2, payload: { message: "Reminder fired" },
    } as any);
    expect(useNotifications.getState().toasts[0].body).toBe("Reminder fired");
  });

  it("dedupes repeated backend notification ids", () => {
    const event = {
      type: "event", event: "notification.received", seq: 2,
      payload: { id: "notif-1", body: "Reminder fired" },
    } as any;

    useNotifications.getState().handleEvent(event);
    useNotifications.getState().handleEvent({ ...event, seq: 3 });

    const toasts = useNotifications.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toBe("notif-1");
    expect(toasts[0].body).toBe("Reminder fired");
  });

  it("keeps missing-id notifications as separate toasts", () => {
    useNotifications.getState().handleEvent({ type: "event", event: "notification.received", seq: 2, payload: { body: "A" } } as any);
    useNotifications.getState().handleEvent({ type: "event", event: "notification.received", seq: 3, payload: { body: "A" } } as any);

    expect(useNotifications.getState().toasts).toHaveLength(2);
  });

  it("ignores other events and empty bodies", () => {
    useNotifications.getState().handleEvent({ type: "event", event: "agent.text", seq: 3, payload: { text: "x" } } as any);
    useNotifications.getState().handleEvent({ type: "event", event: "notification.received", seq: 4, payload: {} } as any);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("dismiss removes a toast", () => {
    useNotifications.getState().handleEvent({ type: "event", event: "notification.received", seq: 5, payload: { body: "x" } } as any);
    const id = useNotifications.getState().toasts[0].id;
    useNotifications.getState().dismiss(id);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});
