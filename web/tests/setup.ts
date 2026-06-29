import "@testing-library/jest-dom/vitest";

function createMemoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear() {
      items.clear();
    },
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(items.keys())[index] ?? null;
    },
    removeItem(key: string) {
      items.delete(key);
    },
    setItem(key: string, value: string) {
      items.set(key, value);
    },
  };
}

function hasUsableLocalStorage(value: unknown): value is Storage {
  return Boolean(
    value
      && typeof (value as Storage).getItem === "function"
      && typeof (value as Storage).setItem === "function"
      && typeof (value as Storage).removeItem === "function"
      && typeof (value as Storage).clear === "function",
  );
}

if (!hasUsableLocalStorage(globalThis.localStorage)) {
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
    writable: true,
  });

  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
}
