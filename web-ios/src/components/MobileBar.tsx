import { Icon, type IconName } from "./Icon";
import { useNav, type Route } from "../lib/nav";

const ICONS: Record<Route, IconName> = {
  live: "live", people: "people", memory: "memory", settings: "settings",
};

/** Mobile bottom bar (shown below md). Hidden when `hidden` (Live fullscreen). */
export function MobileBar({ hidden = false }: { hidden?: boolean }) {
  const route = useNav((s) => s.route);
  const setRoute = useNav((s) => s.setRoute);
  const hiddenTabs = useNav((s) => s.hidden);
  const nav = useNav.getState().visibleNav();
  void hiddenTabs; // re-render when tab visibility changes

  return (
    <nav className={`absolute inset-x-0 bottom-0 z-40 transition-transform duration-300 md:hidden ${hidden ? "translate-y-full" : "translate-y-0"}`}>
      <div className="glass border-t border-white/10 pb-safe">
        <div className="flex items-stretch justify-around px-1 pt-1.5 pb-1">
          {nav.map(({ id, label }) => {
            const active = route === id;
            return (
              <button key={id} onClick={() => setRoute(id)}
                className={`pressable flex flex-1 flex-col items-center gap-0.5 py-1 ${active ? "text-accent" : "text-white/55"}`}
                aria-current={active ? "page" : undefined}>
                <Icon name={ICONS[id]} className="h-6 w-6" filled={active} />
                <span className="text-[10px] font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
