import "@testing-library/jest-dom/vitest";

// jsdom lacks scrollIntoView + matchMedia; stub so components that use them
// (transcript auto-scroll, etc.) don't crash under test.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof window !== "undefined" && !window.matchMedia) {
  // @ts-expect-error minimal stub
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
