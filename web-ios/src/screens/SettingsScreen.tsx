// =============================================================================
// Settings Screen — web-styled settings for web-ios.
//
// Sections: Connection, OpenAI key (BYOK), Agent (config.get), Live (the
// iOS-matched realtime settings: model, voice, response, system prompt, turn
// detection + VAD, reasoning, tool choice, backend bridge), Appearance, About.
// Web-conventional controls (selects, sliders, checkboxes), not iOS pills.
// =============================================================================

import { useEffect, useState } from "react";
import { useSocketStore } from "../lib/socket-store";
import { loadByokKey, saveByokKey, looksLikeOpenAIKey, maskKey } from "../lib/byok";
import {
  useLiveSettings, REALTIME_MODELS, VOICES, TRANSCRIBE_MODELS, SEMANTIC_EAGERNESS, REASONING_EFFORT, TOOL_CHOICE,
} from "../lib/live-settings";
import { Header } from "../components/Header";
import { Icon } from "../components/Icon";
import { Section, Row, Field, TextField, TextArea, Select, Slider, Button, Toggle } from "../components/Form";
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
              {cat === "live" && <LiveSection />}
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
  const label = status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Disconnected";
  const color = status === "connected" ? "bg-ok" : status === "disconnected" ? "bg-danger" : "bg-warn";
  return (
    <Section title="Connection" footer="Connects to the Hawk gateway over /ws (same origin in production, dev-proxy in development).">
      <Row label="Gateway"><span className="flex items-center gap-2 text-sm text-white/70"><span className={`h-2.5 w-2.5 rounded-full ${color}`} /> {label}</span></Row>
      <Button onClick={() => void reconnect({ url: "/ws", sessionKey: "web:ios" })}>Reconnect / re-authenticate</Button>
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
    <Section title="OpenAI key (this device)" footer="Used by Live. Stored only in this browser and sent to the gateway solely to mint short-lived realtime secrets.">
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

// The full iOS Live settings, organized into the same nine sections.
function LiveSection() {
  const s = useLiveSettings();
  const sel = <T extends string>(k: keyof typeof s, opts: readonly T[] | { value: string; label: string }[]) =>
    <Select value={String(s[k])} onChange={(v) => s.set(k as never, v as never)} options={opts} />;

  return (
    <>
      <Section title="Live · Provider" footer="The realtime provider/model for the Live voice + camera session. Applied the next time you start Live.">
        <Row label="Realtime model">{sel("model", REALTIME_MODELS)}</Row>
      </Section>

      <Section title="Live · Response">
        <Row label="Response modality">{sel("responseModality", [{ value: "audio", label: "Audio + text" }, { value: "text", label: "Text only" }])}</Row>
        <Row label="Voice">{sel("voice", VOICES)}</Row>
        <Row label="Noise reduction">{sel("noiseReduction", [{ value: "none", label: "None" }, { value: "near_field", label: "Near field" }, { value: "far_field", label: "Far field" }] as const)}</Row>
        <Row label="User transcript" detail="Transcribe your speech"><Toggle checked={s.userTranscript} onChange={(v) => s.set("userTranscript", v)} /></Row>
        <Row label="Assistant transcript"><Toggle checked={s.assistantTranscript} onChange={(v) => s.set("assistantTranscript", v)} /></Row>
        <Row label="Transcription model">{sel("transcribeModel", TRANSCRIBE_MODELS)}</Row>
      </Section>

      <Section title="Live · Prompt">
        <Field label="System prompt" hint="Steers the realtime agent (persona + behavior).">
          <TextArea value={s.systemPrompt} onChange={(v) => s.set("systemPrompt", v)} rows={5} />
        </Field>
      </Section>

      <Section title="Live · Model configuration">
        <Row label="Max tokens">{sel("maxTokensMode", [{ value: "unlimited", label: "Unlimited" }, { value: "custom", label: "Custom" }] as const)}</Row>
        {s.maxTokensMode === "custom" && <Row label="Token limit"><Slider value={s.maxTokens} onChange={(v) => s.set("maxTokens", v)} min={256} max={4096} step={256} /></Row>}
        <Row label="Reasoning effort">{sel("reasoningEffort", REASONING_EFFORT)}</Row>
        <Row label="Tool choice">{sel("toolChoice", TOOL_CHOICE)}</Row>
        <Row label="Parallel tool calls"><Toggle checked={s.parallelToolCalls} onChange={(v) => s.set("parallelToolCalls", v)} /></Row>
      </Section>

      <Section title="Live · Turn detection">
        <Row label="Mode" detail="How the model decides you’ve finished speaking">
          {sel("turnDetection", [{ value: "server_vad", label: "Server VAD" }, { value: "semantic_vad", label: "Semantic VAD" }, { value: "manual", label: "Manual" }] as const)}
        </Row>
        {s.turnDetection === "server_vad" && (
          <>
            <Row label="VAD threshold"><Slider value={s.vadThreshold} onChange={(v) => s.set("vadThreshold", v)} min={0} max={1} step={0.05} /></Row>
            <Row label="Prefix padding"><Slider value={s.prefixPaddingMs} onChange={(v) => s.set("prefixPaddingMs", v)} min={0} max={2000} step={50} suffix="ms" /></Row>
            <Row label="Silence duration"><Slider value={s.silenceMs} onChange={(v) => s.set("silenceMs", v)} min={100} max={2000} step={50} suffix="ms" /></Row>
          </>
        )}
        {s.turnDetection === "semantic_vad" && (
          <Row label="Eagerness">{sel("semanticEagerness", SEMANTIC_EAGERNESS)}</Row>
        )}
        <Row label="Barge-in">{sel("bargeIn", [{ value: "interrupt", label: "Interrupt assistant" }, { value: "let_finish", label: "Let finish" }, { value: "full_duplex", label: "Full duplex" }] as const)}</Row>
      </Section>

      <Section title="Live · Inputs" footer="Camera cadence + behavioral modes. Visual frames are sent to the model at the chosen rate.">
        <Row label="Visual cadence">{sel("visualCadence", [{ value: "off", label: "Off" }, { value: "0.2", label: "0.2 fps" }, { value: "0.5", label: "0.5 fps" }, { value: "1", label: "1 fps" }, { value: "custom", label: "Custom" }] as const)}</Row>
        {s.visualCadence === "custom" && <Row label="Custom fps"><Slider value={s.customFps} onChange={(v) => s.set("customFps", v)} min={0.1} max={5} step={0.1} suffix="fps" /></Row>}
        <Row label="Camera">{sel("cameraPosition", [{ value: "front", label: "Front" }, { value: "back", label: "Back" }] as const)}</Row>
        <Row label="Skip near-identical frames"><Toggle checked={s.visualDedup} onChange={(v) => s.set("visualDedup", v)} /></Row>
        <Row label="Respond only when spoken to"><Toggle checked={s.speakOnlyWhenSpokenTo} onChange={(v) => s.set("speakOnlyWhenSpokenTo", v)} /></Row>
        <Row label="Cocktail Party" detail="Recognize faces & recall people"><Toggle checked={s.cocktailParty} onChange={(v) => s.set("cocktailParty", v)} /></Row>
        <Row label="Safety Check" detail="iPhone-only — silent hazard watch (not available in browser)"><Toggle checked={false} onChange={() => {}} /></Row>
      </Section>

      <Section title="Live · Conversation">
        <Row label="Show system messages"><Toggle checked={s.showSystemMessages} onChange={(v) => s.set("showSystemMessages", v)} /></Row>
      </Section>

      <Section title="Live · Hawk bridge" footer="How Live delegates durable work + memory to the backend agent.">
        <Row label="Backend agent bridge"><Toggle checked={s.backendBridge} onChange={(v) => s.set("backendBridge", v)} /></Row>
        <Row label="Require gateway connection"><Toggle checked={s.bridgeRequired} onChange={(v) => s.set("bridgeRequired", v)} /></Row>
        <Row label="Session mode">{sel("bridgeSessionMode", [{ value: "temporary", label: "New realtime channel" }, { value: "fixed", label: "Fixed channel" }, { value: "active_chat", label: "Active session" }] as const)}</Row>
        <Row label="Feed mode">{sel("bridgeFeedMode", [{ value: "on_demand", label: "On-demand tools" }, { value: "follow_stream", label: "Follow session stream" }] as const)}</Row>
        <Row label="Opening behavior">{sel("openingBehavior", [{ value: "silent", label: "Silent" }, { value: "first_contact", label: "First contact only" }, { value: "every_session", label: "Check in every session" }] as const)}</Row>
        <Button tone="secondary" onClick={s.reset}>Reset all Live settings</Button>
      </Section>
    </>
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
