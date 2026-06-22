// =============================================================================
// Theme — light / dark / system, applied by toggling a class on <html> that
// flips CSS custom properties (see styles.css). Persisted to localStorage.
// =============================================================================

import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";
const KEY = "hawk-theme";

function load(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* ignore */ }
  return "dark"; // default to the iOS dark look
}

function systemPrefersDark(): boolean {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
}

/** Resolve a preference to the concrete theme to apply. */
export function resolve(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

/** Apply the resolved theme to <html> (toggles the `light`/`dark` class). */
export function applyTheme(pref: ThemePref): void {
  try {
    const mode = resolve(pref);
    const el = document.documentElement;
    el.classList.toggle("light", mode === "light");
    el.classList.toggle("dark", mode === "dark");
    el.style.colorScheme = mode;
  } catch { /* no document */ }
}

interface ThemeState {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  pref: load(),
  setPref: (pref) => {
    try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
    applyTheme(pref);
    set({ pref });
  },
}));

// React to system changes while on "system".
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (useTheme.getState().pref === "system") applyTheme("system");
  });
} catch { /* no matchMedia */ }
