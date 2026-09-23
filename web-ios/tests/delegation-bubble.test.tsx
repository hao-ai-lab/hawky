import { render, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import { DelegationBubble } from "../src/components/DelegationBubble";
import type { DelegationTask } from "../../src/gateway/delegation-types";
it("preserves long input and output inside an expandable task", () => {
  const request = "Read the exact contents of this file, including the last line. ".repeat(8);
  const result = "result ".repeat(1000);
  const task: DelegationTask = { id: "a", ownerSession: "web:a", backendSession: "web:a-bridge", runtime: "native", model: "fixture", request, result,
    createdAt: 1000, completedAt: 2000, status: "completed", events: [] };
  const view = render(<DelegationBubble task={task} />);
  const details = view.container.querySelector("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(view.container.querySelector("summary")!);
  expect(details.open).toBe(true);
  expect(details.textContent).toContain(request);
  expect(details.textContent).toContain(result);
  fireEvent.click(view.container.querySelector("summary")!);
  expect(details.open).toBe(false);
});
