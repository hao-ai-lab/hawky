import { Icon, type IconName } from "./Icon";
import { Logo } from "./Logo";
import { useNav, type Route } from "../lib/nav";
import { useSocketStore } from "../lib/socket-store";

const ICONS: Record<Route, IconName> = {
  live: "live", people: "people", memory: "memory", settings: "settings",
};

/** Desktop left sidebar: brand, nav list, connection status footer. A collapse
 *  toggle (top-right) shrinks it to an icon-only rail (logo mark + icons). */
export function Sidebar() {
  const route = useNav((s) => s.route);
  const setRoute = useNav((s) => s.setRoute);
  const hidden = useNav((s) => s.hidden);
  const collapsed = useNav((s) => s.collapsed);
  const toggleCollapsed = useNav((s) => s.toggleCollapsed);
  const status = useSocketStore((s) => s.status);
  const nav = useNav.getState().visibleNav();
  void hidden; // re-render when visibility changes

  return (
    <aside className={`hidden h-full shrink-0 flex-col border-r border-white/10 bg-paper/60 transition-[width] duration-200 md:flex ${collapsed ? "w-16 items-center" : "w-60"}`}>
      {/* Header. Expanded: brand + collapse toggle on the right.
          Collapsed (ChatGPT-style): just the logo; hovering the logo slot reveals
          the expand button floating OVER the logo — otherwise it's unseen. */}
      {collapsed ? (
        <div className="group relative my-5 h-9 w-9">
          {/* Logo — fades out on hover */}
          <div className="absolute inset-0 grid place-items-center transition-opacity group-hover:opacity-0">
            <Logo size={26} showText={false} />
          </div>
          {/* Expand button — hidden until the logo slot is hovered */}
          <button
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand"
            className="pressable absolute inset-0 grid place-items-center rounded-lg text-white/70 opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
          >
            <Icon name="sidebar" className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between px-5 py-5">
          <Logo size={26} textClass="text-lg text-white" />
          <button
            onClick={toggleCollapsed}
            aria-label="Collapse sidebar"
            title="Collapse"
            className="pressable grid h-7 w-7 place-items-center rounded-md text-white/45 hover:bg-white/10 hover:text-white/80"
          >
            <Icon name="sidebar" className="h-5 w-5" />
          </button>
        </div>
      )}

      <nav className={`flex-1 space-y-0.5 ${collapsed ? "px-2" : "px-3"}`}>
        {nav.map(({ id, label }) => {
          const active = route === id;
          return (
            <button
              key={id}
              onClick={() => setRoute(id)}
              title={collapsed ? label : undefined}
              className={`pressable flex w-full items-center rounded-pill text-sm font-medium ${
                collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5"
              } ${active ? "bg-accent/15 text-accent" : "text-white/60 hover:bg-white/5 hover:text-white"}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={ICONS[id]} className="h-5 w-5 shrink-0" filled={active} />
              {!collapsed && label}
            </button>
          );
        })}
      </nav>

      <div className={`border-t border-white/10 py-3 ${collapsed ? "flex justify-center px-0" : "px-5"}`}>
        {collapsed ? <StatusDot status={status} /> : <StatusLine status={status} />}
      </div>
    </aside>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "connected" ? "bg-ok" : status === "disconnected" ? "bg-danger" : "bg-warn";
  return <span className={`h-2.5 w-2.5 rounded-full ${color}`} title={status} />;
}

export function StatusLine({ status }: { status: string }) {
  const label =
    status === "connected" ? "Connected"
    : status === "connecting" ? "Connecting…"
    : status === "reconnecting" ? "Reconnecting…" : "Disconnected";
  const color = status === "connected" ? "bg-ok" : status === "disconnected" ? "bg-danger" : "bg-warn";
  return (
    <div className="flex items-center gap-2 text-xs text-white/50">
      <span className={`h-2 w-2 rounded-full ${color}`} /> {label}
    </div>
  );
}
