// =============================================================================
// Settings Screen — web-styled settings for web-ios.
//
// Sections: Connection, OpenAI key (BYOK), Agent (config.get), Live (the
// iOS-matched realtime settings: model, voice, response, turn
// detection + VAD, reasoning, tool choice, backend bridge), Appearance, About.
// Web-conventional controls (selects, sliders, checkboxes), not iOS pills.
// =============================================================================

import { useEffect, useState } from "react";
import { clearStoredDeviceTokens, useSocketStore } from "../lib/socket-store";
import { loadByokKey, saveByokKey, looksLikeOpenAIKey, maskKey } from "../lib/byok";
import { LiveSettingsPanel } from "../components/LiveSettingsPanel";
import { Header } from "../components/Header";
import { Icon } from "../components/Icon";
import { Section, Row, TextField, Select, Button, Toggle } from "../components/Form";
import { useTheme } from "../lib/theme";
import { useNav, HIDEABLE, NAV } from "../lib/nav";

interface ConfigData {
  model: string;
  provider: string;
  effort?: string | null;
  has_openai_key?: boolean;
  has_anthropic_key?: boolean;
}

type Category = "general" | "appearance" | "live" | "agent" | "notifications" | "layout" | "about";

const CATEGORIES: { id: Category; label: string; icon: import("../components/Icon").IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "appearance", label: "Appearance", icon: "live" },
  { id: "live", label: "Live", icon: "mic" },
  { id: "agent", label: "Agent", icon: "brain" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "layout", label: "App Layout", icon: "memory" },
  { id: "about", label: "About", icon: "chevronRight" },
];

export function SettingsScreen() {
  const status = useSocketStore((s) => s.status);
  const rpc = useSocketStore((s) => s.rpc);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cat, setCat] = useState<Category>("general");
  // Mobile drill-down: false = category list, true = the selected detail pane.
  // Ignored on md+, where both panes are always shown side by side.
  const [mobileDetail, setMobileDetail] = useState(false);
  const activeLabel = CATEGORIES.find((c) => c.id === cat)?.label ?? "";

  useEffect(() => {
    if (status !== "connected") return;
    let active = true;
    void (async () => {
      try { const c = (await rpc("config.get")) as ConfigData; if (active) { setConfig(c); setErr(null); } }
      catch (e) { if (active) setErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { active = false; };
  }, [status, rpc]);

  return (
    <div className="flex h-full flex-col">
      <Header title="Settings" />
      {/* Responsive: on md+ a two-pane (category rail + detail) like ChatGPT
          settings; on mobile a native-style drill-down (list → detail → back). */}
      <div className="flex min-h-0 flex-1">
        <nav className={`shrink-0 overflow-y-auto p-2 md:w-52 md:border-r md:border-white/10 ${mobileDetail ? "hidden md:block" : "block w-full"}`}>
          {CATEGORIES.map((c) => (
            <button key={c.id} onClick={() => { setCat(c.id); setMobileDetail(true); }}
              className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm ${cat === c.id ? "bg-accent/15 text-accent" : "text-white/70 hover:bg-white/5"}`}>
              <Icon name={c.icon} className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">{c.label}</span>
              <Icon name="chevronRight" className="h-4 w-4 shrink-0 text-white/30 md:hidden" />
            </button>
          ))}
        </nav>
        <div className={`min-w-0 flex-1 flex-col overflow-y-auto ${mobileDetail ? "flex" : "hidden md:flex"}`}>
          {/* Mobile back bar — returns to the category list. */}
          <button onClick={() => setMobileDetail(false)}
            className="pressable sticky top-0 z-10 flex min-h-[44px] items-center gap-1 border-b border-white/10 bg-canvas/85 px-2 text-[15px] font-medium text-accent backdrop-blur md:hidden">
            <Icon name="chevronLeft" className="h-5 w-5" />
            <span>Settings</span>
            <span className="ml-1 text-white/40">/ {activeLabel}</span>
          </button>
          <div className="px-4 pb-24 pt-4 md:px-8 md:pb-8 md:pt-5">
            <div className="mx-auto max-w-2xl">
              {cat === "general" && <><ConnectionSection status={status} /><ByokSection /></>}
              {cat === "appearance" && <AppearanceSection />}
              {cat === "live" && <LiveSettingsPanel />}
              {cat === "agent" && <AgentSection config={config} err={err} status={status} />}
              {cat === "notifications" && <NotificationsSection />}
              {cat === "layout" && <LayoutSection />}
              {cat === "about" && <AboutSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectionSection({ status }: { status: string }) {
  const reconnect = useSocketStore((s) => s.connect);
  const disconnect = useSocketStore((s) => s.disconnect);
  const label = status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Disconnected";
  const color = status === "connected" ? "bg-ok" : status === "disconnected" ? "bg-danger" : "bg-warn";
  const logout = () => {
    disconnect();
    clearStoredDeviceTokens();
    window.location.href = "/auth/logout?return_url=/auth/login";
  };
  return (
    <Section title="Connection" footer="Connects to the Hawk gateway over /ws (same origin in production, dev-proxy in development).">
      <Row label="Gateway"><span className="flex items-center gap-2 text-sm text-white/70"><span className={`h-2.5 w-2.5 rounded-full ${color}`} /> {label}</span></Row>
      <Button onClick={() => void reconnect({ url: "/ws", sessionKey: "web:ios" })}>Reconnect / re-authenticate</Button>
      <Button onClick={logout}>Log out</Button>
    </Section>
  );
}

function NotificationsSection() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(
    supported ? Notification.permission : "unsupported",
  );

  const enable = async () => {
    if (!supported) return;
    try {
      const result = await Notification.requestPermission();
      setPerm(result);
      if (result === "granted") {
        // Confirm with a sample so the user sees it land in macOS Notification Center.
        new Notification("Hawk", { body: "Notifications are on. Reminders will appear here." });
      }
    } catch { /* ignore */ }
  };

  const detail =
    perm === "unsupported" ? "This browser doesn’t support notifications."
    : perm === "granted" ? "On — reminders show in your system notifications."
    : perm === "denied" ? "Blocked — enable it in your browser’s site settings."
    : "Off — turn on to get reminders as macOS notifications.";

  return (
    <Section title="Notifications" footer="When a reminder fires it appears as an in-app toast, and (with this on) a macOS system notification — even if the Hawk tab is in the background. Fully-closed-tab delivery needs the installable app.">
      <Row label="System notifications" detail={detail}>
        <span className={`h-2.5 w-2.5 rounded-full ${perm === "granted" ? "bg-ok" : perm === "denied" ? "bg-danger" : "bg-white/30"}`} />
      </Row>
      {perm !== "granted" && perm !== "unsupported" && (
        <Button onClick={() => void enable()}>Enable system notifications</Button>
      )}
    </Section>
  );
}

function ByokSection() {
  const [stored, setStored] = useState(() => loadByokKey());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const hasKey = stored.length > 0;
  const valid = looksLikeOpenAIKey(draft);
  const save = () => { if (!valid) return; saveByokKey(draft); setStored(draft.trim()); setDraft(""); setEditing(false); };
  const clear = () => { saveByokKey(""); setStored(""); setDraft(""); setEditing(false); };
  return (
    <Section title="OpenAI key (optional)" footer="Live uses the Hawky Realtime Gateway when this is blank. A saved key overrides the gateway for this browser.">
      {hasKey && !editing ? (
        <>
          <Row label="API key" detail="Saved in this browser"><span className="font-mono text-xs text-white/60">{maskKey(stored)}</span></Row>
          <Button tone="secondary" onClick={() => { setEditing(true); setDraft(""); }}>Replace key</Button>
          <Button tone="danger" onClick={clear}>Clear key</Button>
        </>
      ) : (
        <>
          <Row label="API key"><TextField type="password" value={draft} onChange={setDraft} placeholder="sk-…" mono /></Row>
          <Button onClick={save} disabled={!valid}>Store key</Button>
          {(editing || hasKey) && <Button tone="secondary" onClick={() => { setEditing(false); setDraft(""); }}>Cancel</Button>}
        </>
      )}
    </Section>
  );
}

function AgentSection({ config, err, status }: { config: ConfigData | null; err: string | null; status: string }) {
  if (status !== "connected") return <Section title="Agent"><Row label="Backend agent" detail="Connect to view." /></Section>;
  if (err) return <Section title="Agent"><Row label="Backend agent" detail={err} /></Section>;
  if (!config) return <Section title="Agent"><Row label="Loading…" /></Section>;
  return (
    <Section title="Agent" footer="The backend agent powers durable work + memory; Live delegates to it.">
      <Row label="Provider" detail={config.provider} />
      <Row label="Model" detail={config.model} />
      {config.effort && <Row label="Effort" detail={config.effort} />}
      <Row label="OpenAI key on gateway" detail={config.has_openai_key ? "configured" : "none"}>
        <span className={`h-2.5 w-2.5 rounded-full ${config.has_openai_key ? "bg-ok" : "bg-white/30"}`} />
      </Row>
    </Section>
  );
}

function AppearanceSection() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  return (
    <Section title="Appearance" footer="Light follows the editorial style; dark matches the iOS app. “System” tracks your OS setting.">
      <Row label="Theme" detail="Applies instantly across the app">
        <Select value={pref} onChange={(v) => setPref(v as "system" | "light" | "dark")}
          options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </Row>
    </Section>
  );
}

function LayoutSection() {
  const hidden = useNav((s) => s.hidden);
  const toggleHidden = useNav((s) => s.toggleHidden);
  return (
    <Section title="App Layout" footer="Hide nav tabs you don’t use. Live and Settings are always shown.">
      {NAV.map((n) => {
        const lockable = !HIDEABLE.includes(n.id);
        const shown = !hidden.includes(n.id);
        return (
          <Row key={n.id} label={n.label} detail={lockable ? "Always shown" : undefined}>
            <Toggle checked={shown} onChange={() => { if (!lockable) toggleHidden(n.id); }} />
          </Row>
        );
      })}
    </Section>
  );
}

function AboutSection() {
  return (
    <Section title="About" footer="Hawk — web version of the iOS app.">
      <Row label="App" detail="Hawk Web" />
      <Row label="Camera / mic" detail="Requires https:// or localhost" />
      <Row label="Out of scope" detail="Glasses, native Safety vision (iPhone-only)" />
    </Section>
  );
}
