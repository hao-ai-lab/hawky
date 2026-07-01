import { useState, useCallback, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { NotificationIcon } from "./components/NotificationIcon";
import { ChatView } from "./components/ChatView";
import { InputBar } from "./components/InputBar";
import { InstallBanner } from "./components/InstallBanner";
import { MemoryEditor } from "./components/MemoryEditor";
import { StatusDashboard } from "./components/StatusDashboard";
import { SettingsPanel } from "./components/SettingsPanel";
import { LiveLab } from "./components/LiveLab";
import { LiveTranscription } from "./components/LiveTranscription";
import { PeopleView } from "./components/PeopleView";
import { DemoLanding } from "./components/DemoLanding";
import { DeliveryTargetDropdown } from "./components/DeliveryTargetDropdown";
import { TaskChip } from "./components/TaskChip";
import { BypassPill } from "./components/BypassPill";
import { formatChannelName } from "./components/ChannelList";
import { useSocketStore } from "./store/socket-store";
import { useSessionStore } from "./store/session-store";
import { useWebSettingsStore } from "./store/web-settings-store";

type ViewMode = "chat" | "memory" | "status" | "settings" | "demo" | "live" | "transcription" | "people";
const LIVE_LAB_ENABLED_KEY = "hawky-live-lab-enabled";
// Demo views (Live / Transcription / People) are first-class for the hosted
// web demo (#681): default ON, with a Settings toggle to hide them.
const DEMO_VIEWS: ViewMode[] = ["demo", "live", "transcription", "people"];

/** Header icon button with hover tooltip matching ConnectionStatus/NotificationIcon pattern. */
function HeaderIcon({ label, onClick, icon, active, wrapperClass }: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
  wrapperClass?: string;
}) {
  const [showLabel, setShowLabel] = useState(false);
  return (
    <div className={`relative ${wrapperClass ?? ""}`} onMouseEnter={() => setShowLabel(true)} onMouseLeave={() => setShowLabel(false)}>
      <button
        onClick={onClick}
        className={`p-1.5 rounded-lg transition-colors hover:bg-stone-100 dark:hover:bg-stone-800 ${
          active
            ? "text-stone-800 dark:text-stone-100"
            : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
        }`}
        aria-label={label}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {icon}
        </svg>
      </button>
      {showLabel && (
        <div className="absolute right-0 top-full mt-1 px-2 py-1 rounded-md bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-800 text-xs whitespace-nowrap shadow-md z-50">
          {label}
        </div>
      )}
    </div>
  );
}

/** A pill tab in the demo sub-navigation (Live / Transcription / People). */
function DemoTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
        active
          ? "bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-100"
          : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
      }`}
    >
      {label}
    </button>
  );
}

// Initialize theme from localStorage on load
if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
  const stored = localStorage.getItem("hawky-theme");
  if (stored === "dark" || stored === "light") {
    document.documentElement.classList.toggle("dark", stored === "dark");
  } else if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    document.documentElement.classList.add("dark");
  }
}

function loadLiveLabEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  // Default ON: demo views are first-class. Only an explicit "false" hides them.
  return localStorage.getItem(LIVE_LAB_ENABLED_KEY) !== "false";
}

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<ViewMode>("chat");
  const [liveLabEnabled, setLiveLabEnabledState] = useState(loadLiveLabEnabled);
  const [, forceUpdate] = useState(0); // For dark mode icon reactivity
  const status = useSocketStore((s) => s.status);
  const rpc = useSocketStore((s) => s.rpc);
  const subscribe = useSocketStore((s) => s.subscribe);
  const setAgentRuntimesEnabled = useWebSettingsStore((s) => s.setAgentRuntimesEnabled);
  const activeKey = useSessionStore((s) => s.activeKey);
  const activeSession = useSessionStore((s) => s.sessions.find((x) => x.key === s.activeKey));
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const switchSession = useSessionStore((s) => s.switchSession);
  const handleEvent = useSessionStore((s) => s.handleEvent);
  // Heartbeat is the only true "system / read-only" session — its key is a
  // singleton tied to the heartbeat subsystem, no chat semantic. Cron
  // sessions are now ordinary chattable threads (see PR that made cron
  // sessions chattable), so they don't get the 🔒 lock glyph anymore.
  const isSystem = activeKey.startsWith("heartbeat:");

  // Fetch sessions on connect + reconnect
  useEffect(() => {
    if (status === "connected") {
      // Fetch sidebar list first so switchSession can seed the footer
      // (context %, tokens, cost) from the backend-persisted entry.
      void (async () => {
        await fetchSessions();
        await switchSession(useSessionStore.getState().activeKey);
      })();
    } else if (status === "disconnected") {
      // Clear pending dialogs — gateway is gone, can't resolve them
      useSessionStore.setState({
        pendingPermission: null,
        pendingAskUser: null,
        agentStatus: "idle",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (status !== "connected") return;
    let active = true;
    void (async () => {
      try {
        const config = await rpc("config.get") as { experiments?: { agent_runtimes?: boolean } };
        if (active) setAgentRuntimesEnabled(config.experiments?.agent_runtimes === true);
      } catch {
        if (active) setAgentRuntimesEnabled(false);
      }
    })();
    return () => { active = false; };
  }, [status, rpc, setAgentRuntimesEnabled]);

  // Subscribe to gateway events for streaming
  useEffect(() => {
    const unsub = subscribe(handleEvent);
    return unsub;
  }, [subscribe, handleEvent]);

  // Clear PWA app badge when tab becomes visible (channel badges stay until clicked)
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        try { navigator.clearAppBadge?.(); } catch {}
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const setLiveLabEnabled = useCallback((enabled: boolean) => {
    localStorage.setItem(LIVE_LAB_ENABLED_KEY, enabled ? "true" : "false");
    setLiveLabEnabledState(enabled);
    if (!enabled) setView("chat");
  }, []);

  const isDemoView = DEMO_VIEWS.includes(view);

  // Close sidebar on mobile + return to chat view when switching channels
  useEffect(() => {
    setSidebarOpen(false);
    setView("chat");
  }, [activeKey]);

  useEffect(() => {
    if (!liveLabEnabled && DEMO_VIEWS.includes(view)) {
      setView("chat");
    }
  }, [liveLabEnabled, view]);

  const channelName = activeSession
    ? formatChannelName(activeSession)
    : activeKey.includes(":") ? activeKey.split(":")[1] : activeKey;

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed inset-y-0 left-0 z-30 w-72 transform transition-transform duration-300 ease-in-out
          md:relative md:translate-x-0 md:z-0
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <Sidebar
          onSettingsOpen={() => { setView("settings"); setSidebarOpen(false); }}
          onChannelClick={() => { setView("chat"); setSidebarOpen(false); }}
        />
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Shared header — persists across all views */}
        <header className="flex items-center gap-3 border-b border-stone-200/60 dark:border-stone-700/40 px-4 py-3 shrink-0">
          <button
            className="md:hidden p-2 -ml-1 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
          >
            <svg className="w-5 h-5 text-stone-600 dark:text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {view !== "chat" && (
            <button onClick={() => setView("chat")} className="p-2 -ml-1 rounded-md hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Back to chat">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <h2 className="text-lg font-serif font-normal text-stone-800 dark:text-stone-200 flex-1">
            {view === "chat" ? (
              <>
                {isSystem ? "🔒 " : ""}{channelName}
                {isSystem && (
                  <DeliveryTargetDropdown sessionKey={activeKey} />
                )}
              </>
            ) : view === "memory" ? "Memory" : view === "status" ? "Status"
              : view === "demo" ? "Demo"
              : view === "live" ? "Live"
              : view === "transcription" ? "Transcription"
              : view === "people" ? "People" : "Settings"}
          </h2>

          {/* Task chip — only in chat view. Hides itself when the
              active session has no tasks. */}
          {view === "chat" && <TaskChip />}
          {/* Bypass indicator — visible across all views so the user
              can't forget bypass is on while browsing memory/status. */}
          <BypassPill />

          {liveLabEnabled && (
            <HeaderIcon
              label="Demo"
              onClick={() => setView(isDemoView ? "chat" : "demo")}
              active={isDemoView}
              icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />}
            />
          )}
          <HeaderIcon
            label="Memory"
            onClick={() => setView(view === "memory" ? "chat" : "memory")}
            active={view === "memory"}
            icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />}
          />
          <HeaderIcon
            label="Status"
            onClick={() => setView(view === "status" ? "chat" : "status")}
            active={view === "status"}
            icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />}
          />
          <NotificationIcon />
          <ConnectionStatus />
          <HeaderIcon
            label={document.documentElement.classList.contains("dark") ? "Light mode" : "Dark mode"}
            onClick={() => {
              const isDark = document.documentElement.classList.toggle("dark");
              localStorage.setItem("hawky-theme", isDark ? "dark" : "light");
              forceUpdate((n) => n + 1);
            }}
            icon={
              document.documentElement.classList.contains("dark")
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            }
          />
        </header>

        {view === "memory" ? (
          <div className="flex-1 overflow-hidden">
            <MemoryEditor onClose={() => setView("chat")} />
          </div>
        ) : view === "status" ? (
          <div className="flex-1 overflow-hidden">
            <StatusDashboard />
          </div>
        ) : view === "settings" ? (
          <div className="flex-1 overflow-hidden">
            <SettingsPanel
              liveLabEnabled={liveLabEnabled}
              onLiveLabEnabledChange={setLiveLabEnabled}
            />
          </div>
        ) : isDemoView && liveLabEnabled ? (
          <div className="flex flex-1 flex-col min-h-0">
            {/* Demo sub-navigation — Live / Transcription / People */}
            {view !== "demo" && (
              <nav className="flex items-center gap-1 border-b border-stone-200/60 dark:border-stone-700/40 px-4 py-1.5 shrink-0">
                <DemoTab label="Overview" active={false} onClick={() => setView("demo")} />
                <DemoTab label="Live" active={view === "live"} onClick={() => setView("live")} />
                <DemoTab label="Transcription" active={view === "transcription"} onClick={() => setView("transcription")} />
                <DemoTab label="People" active={view === "people"} onClick={() => setView("people")} />
              </nav>
            )}
            {view === "demo" ? (
              <DemoLanding
                onStartLive={() => setView("live")}
                onOpenTranscription={() => setView("transcription")}
                onOpenPeople={() => setView("people")}
                onOpenSettings={() => setView("settings")}
              />
            ) : view === "transcription" ? (
              <LiveTranscription />
            ) : view === "people" ? (
              <PeopleView />
            ) : (
              <LiveLab />
            )}
          </div>
        ) : (
          <>
            {/* Chat area */}
            <ChatView />

            {/* Input bar */}
            <InputBar setView={setView} />

            {/* iOS install banner */}
            <InstallBanner />
          </>
        )}
      </div>
    </div>
  );
}
