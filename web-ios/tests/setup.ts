import "@testing-library/jest-dom/vitest";

// Native dialog focus trapping is verified in the browser; jsdom only models open.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    // Browsers queue this event, including the cleanup/reopen in StrictMode.
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  };
}

// jsdom lacks scrollIntoView + matchMedia; stub so components that use them
// (transcript auto-scroll, etc.) don't crash under test.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof window !== "undefined" && !window.matchMedia) {
  // @ts-expect-error minimal stub
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
