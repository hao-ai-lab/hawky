import { describe, it, expect, beforeEach } from "vitest";
import { useNotifications } from "../src/lib/notifications";

beforeEach(() => useNotifications.setState({ toasts: [] }));

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
