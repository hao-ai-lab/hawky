import { useEffect, useState } from "react";
import { useNav } from "./lib/nav";
import { useSocketStore } from "./lib/socket-store";
import { useSessionStore } from "./lib/session-store";
import { Sidebar } from "./components/Sidebar";
import { MobileBar } from "./components/MobileBar";
import { Toaster } from "./components/Toaster";
import { LiveScreen } from "./screens/LiveScreen";
import { PeopleScreen } from "./screens/PeopleScreen";
import { MemoryScreen } from "./screens/MemoryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export function App() {
  const route = useNav((s) => s.route);
  const status = useSocketStore((s) => s.status);
  // Live hides the mobile bar when it goes full-screen video.
  const [barHidden, setBarHidden] = useState(false);
  useEffect(() => { if (route !== "live") setBarHidden(false); }, [route]);
  // Load the session list on connect so the header shows the active session's
  // name (auto-title) immediately, not just after opening History.
  useEffect(() => { if (status === "connected") void useSessionStore.getState().fetchSessions(); }, [status]);

  return (
    // Real web-app layout: a fixed-width sidebar on desktop (md+) and a flexible
    // content area; on mobile the sidebar collapses and a bottom bar appears.
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-white">
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <main className="relative min-h-0 flex-1 overflow-hidden">
          {/* Live stays MOUNTED across tab switches (just hidden) so an active
              realtime session — mic, camera, WebRTC — keeps running when you
              visit Settings/People/Memory. Unmounting would tear it down. */}
          <div className={`absolute inset-0 ${route === "live" ? "" : "hidden"}`}>
            <LiveScreen onFullscreenChange={setBarHidden} />
          </div>
          {route === "people" && <PeopleScreen />}
          {route === "memory" && <MemoryScreen />}
          {route === "settings" && <SettingsScreen />}
        </main>
        <MobileBar hidden={barHidden} />
      </div>
      <Toaster />
    </div>
  );
}
