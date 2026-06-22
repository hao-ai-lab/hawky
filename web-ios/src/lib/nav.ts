// Navigation model for the web-ios app. A real responsive web app: a left
// sidebar on desktop, a bottom bar on mobile. Every iOS function is a route.
import { create } from "zustand";

export type Route = "live" | "people" | "memory" | "settings";

export interface NavItem {
  id: Route;
  label: string;
  /** Shown in the compact mobile bar (primary tabs). */
  primary: boolean;
}

// Live-tab focused: the iOS Live experience and its supporting screens.
export const NAV: NavItem[] = [
  { id: "live", label: "Live", primary: true },
  { id: "people", label: "People", primary: true },
  { id: "memory", label: "Memory", primary: true },
  { id: "settings", label: "Settings", primary: true },
];

// Tabs the user has chosen to hide from the nav (App Layout setting). Live and
// Settings can't be hidden — Live is the core screen, Settings holds the toggle.
export const HIDEABLE: Route[] = ["people", "memory"];
const HIDDEN_KEY = "hawk-hidden-tabs";

function loadHidden(): Route[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (raw) return (JSON.parse(raw) as Route[]).filter((t) => HIDEABLE.includes(t));
  } catch { /* ignore */ }
  return [];
}

const COLLAPSED_KEY = "hawk-nav-collapsed";
function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
}

interface NavState {
  route: Route;
  hidden: Route[];
  /** Sidebar collapsed to an icon-only rail (logo mark + icons, no labels). */
  collapsed: boolean;
  setRoute: (r: Route) => void;
  toggleHidden: (r: Route) => void;
  toggleCollapsed: () => void;
  visibleNav: () => NavItem[];
}

export const useNav = create<NavState>((set, get) => ({
  route: "live", // flagship default, matching iOS
  hidden: loadHidden(),
  collapsed: loadCollapsed(),
  setRoute: (route) => set({ route }),
  toggleCollapsed: () => set((s) => {
    const collapsed = !s.collapsed;
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "true" : "false"); } catch { /* ignore */ }
    return { collapsed };
  }),
  toggleHidden: (r) => {
    if (!HIDEABLE.includes(r)) return;
    set((s) => {
      const hidden = s.hidden.includes(r) ? s.hidden.filter((x) => x !== r) : [...s.hidden, r];
      try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)); } catch { /* ignore */ }
      // If we just hid the active route, fall back to Live.
      const route = hidden.includes(s.route) ? "live" : s.route;
      return { hidden, route };
    });
  },
  visibleNav: () => NAV.filter((n) => !get().hidden.includes(n.id)),
}));
