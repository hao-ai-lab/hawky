// =============================================================================
// Live Screen — transcript-first realtime (web-ios)
//
// Layout per the iOS Live transcript + the requested web design:
//   • The TRANSCRIPT is the main content — a full-width chat: user bubbles
//     right (amber), assistant text left, system lines, and TOOL-CALL bubbles
//     inline (colored cards: purple=running, green=ok, red=error) like iOS.
//   • The CAMERA is a small floating PiP in the top-right (not the background).
//   • Controls (mic / camera / silent / cocktail / end) float at the bottom.
//   • A text composer is docked at the bottom.
//
// The composer owns its own draft state so typing never re-renders the video
// elements (fixes the camera "shiver" on keystroke). All realtime logic lives
// in useRealtime.
// =============================================================================

import { memo, useEffect, useRef, useState } from "react";
import { useRealtime, artifactsFromTranscript, type LivePhase, type TranscriptEntry, type Artifact } from "../lib/useRealtime";
import { useSocketStore } from "../lib/socket-store";
import { useSessionStore } from "../lib/session-store";
import { Icon, type IconName } from "../components/Icon";
import { Logo } from "../components/Logo";
import { SessionMenu } from "../components/SessionMenu";
import { ChartLightbox, ArtifactsPanel, ArtifactsSheet } from "../components/ChartArtifacts";
import { previewModeFromLocation, previewOverrides } from "../lib/live-preview";
import { useKeyboardInset } from "../lib/use-keyboard-inset";

// A click handler for opening a chart in the lightbox, threaded to bubbles via
// React context so the deep Bubble/ToolBubble components can trigger it.
import { createContext, useContext } from "react";
const OpenArtifactContext = createContext<((a: Artifact) => void) | null>(null);

export function LiveScreen({ onFullscreenChange }: { onFullscreenChange: (v: boolean) => void }) {
  const gatewayStatus = useSocketStore((s) => s.status);
  // The Live agent bridges to the active session (chosen via the Hawk pill).
  const activeKey = useSessionStore((s) => s.activeKey);
  const sessions = useSessionStore((s) => s.sessions);
  const realRt = useRealtime({ sessionKey: activeKey });
  // DEV-only presentation preview (?preview=live-connected|live-charts|live-idle):
  // overlay seeded transcript/phase so connected-state layouts can be reviewed
  // without a live session. No-op in production (previewMode is always null).
  const previewMode = previewModeFromLocation();
  const rt = previewMode ? { ...realRt, ...previewOverrides(previewMode) } : realRt;
  const {
    phase, error, transcript, historyLoading, micOn, cameraOn, staySilent, cocktailParty, safetyOn, speaking, bridgeOffline,
    canStart, videoElRef, audioElRef, start, stop, sendText,
    toggleMic, toggleCamera, toggleStaySilent, toggleCocktailParty, toggleSafety,
  } = rt;

  // Artifacts = every chart generated this session, chronological, derived from
  // the transcript. The panel lists them; the lightbox zooms a single one.
  const artifacts = artifactsFromTranscript(transcript);
  const [panelOpen, setPanelOpen] = useState(true);
  // Mobile: the side panel has no room, so the Artifacts button opens a sheet.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [lightbox, setLightbox] = useState<Artifact | null>(null);
  // Auto-open the panel the first time an artifact appears.
  const sawArtifactRef = useRef(false);
  useEffect(() => {
    if (artifacts.length > 0 && !sawArtifactRef.current) { sawArtifactRef.current = true; setPanelOpen(true); }
  }, [artifacts.length]);
  const showPanel = artifacts.length > 0 && panelOpen;

  const isConnected = phase === "connected";
  const showVideo = cameraOn && (phase === "connecting" || isConnected);

  // The PiP fullscreen toggle is the only thing that hides the app's nav bar.
  const [pipFull, setPipFull] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => onFullscreenChange(pipFull), [pipFull, onFullscreenChange]);
  // On mobile Safari the keyboard overlays bottom-anchored chrome; lift the
  // floating controls to sit just above it when it's open.
  const keyboardInset = useKeyboardInset();

  // Prefer the session's display name (auto-title) over the raw key suffix.
  const activeEntry = sessions.find((s) => s.key === activeKey);
  const sessionLabel = (activeEntry?.displayName && activeEntry.displayName.trim())
    || (activeKey.includes(":") ? activeKey.split(":").slice(1).join(":") : activeKey);

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      {/* The single source <video> for the camera stream; visually it lives in
          the PiP. Kept mounted (not conditionally re-created) so it never
          re-initializes on re-render. */}
      <audio ref={audioElRef} autoPlay />

      {/* Header — the Hawk pill opens the session menu (New / History / Status) */}
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 md:px-6">
        <button onClick={() => setMenuOpen(true)}
          className="pressable flex items-center gap-2 rounded-pill px-2 py-1 hover:bg-white/5" aria-label="Session menu">
          <Logo size={22} textClass="text-[15px]" />
          <span className="hidden max-w-[40vw] truncate text-xs text-white/40 sm:inline">· {sessionLabel}</span>
          <PhasePill phase={phase} />
          <Icon name="chevronDown" className="h-3.5 w-3.5 text-white/40" />
        </button>
        <div className="flex items-center gap-3">
          {isConnected && <span className="text-xs text-white/40">{speaking ? "speaking…" : "listening"}</span>}
          {/* Artifacts toggle — appears once a chart exists; shows/hides the panel. */}
          {artifacts.length > 0 && (
            <button
              // Mobile → open the bottom sheet; desktop → toggle the side panel.
              onClick={() => { setSheetOpen(true); setPanelOpen((v) => !v); }}
              aria-label="Artifacts"
              aria-pressed={panelOpen}
              title="Artifacts"
              className={`pressable flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium ${
                panelOpen
                  ? "border-accent/40 bg-accent/15 text-accent"
                  : "border-white/15 text-white/60 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon name="chart" className="h-4 w-4" />
              <span className="hidden sm:inline">Artifacts</span>
              <span className={`rounded-full px-1.5 text-[10px] font-bold ${panelOpen ? "bg-accent/25" : "bg-white/10"}`}>{artifacts.length}</span>
            </button>
          )}
        </div>
      </header>

      {/* Banners */}
      {(bridgeOffline || (phase === "failed" && error) || gatewayStatus !== "connected") && (
        <div className="space-y-2 px-4 pt-3 md:px-6">
          {gatewayStatus !== "connected" && <Banner tone="warn" icon="antenna" text="Connecting to the Hawk gateway…" />}
          {bridgeOffline && <Banner tone="warn" icon="antenna" text="Hawk backend offline — memory & tools unavailable." />}
          {phase === "failed" && error && <Banner tone="danger" icon="warning" text={error} />}
        </div>
      )}

      {/* Main content = transcript (+ artifacts panel on the right) */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          <OpenArtifactContext.Provider value={setLightbox}>
            <Transcript entries={transcript} phase={phase} loading={historyLoading} />
          </OpenArtifactContext.Provider>

          {/* Camera PiP — top-right, small */}
          {showVideo && (
            <button
              onClick={() => setPipFull(true)}
              className="pressable absolute right-4 top-4 overflow-hidden rounded-card border border-white/25 shadow-pip"
              style={{ width: 140, height: 188 }}
              aria-label="Expand camera"
            >
              <video ref={videoElRef} autoPlay muted playsInline className="h-full w-full object-cover" />
              <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-live/90 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-white" /> Live
              </span>
            </button>
          )}
          {/* When the camera is off we still need the <video> mounted to receive a
              stream if toggled on; park it hidden. */}
          {!showVideo && <video ref={videoElRef} autoPlay muted playsInline className="hidden" />}
          {/* The panel is toggled from the Artifacts button in the header. */}
        </div>

        {/* Artifacts panel — chronological chart thumbnails; click → lightbox. */}
        {showPanel && (
          <ArtifactsPanel artifacts={artifacts} onOpen={setLightbox} />
        )}
      </div>

      {/* Mobile artifacts bottom sheet (desktop uses the side panel above). */}
      <ArtifactsSheet open={sheetOpen} artifacts={artifacts} onOpen={setLightbox} onClose={() => setSheetOpen(false)} />

      {/* Fullscreen zoom/pan lightbox for a single chart. */}
      {lightbox && <ChartLightbox artifact={lightbox} onClose={() => setLightbox(null)} />}

      {/* Controls + composer — on mobile this floats as a glass cluster over the
          transcript, sitting above the bottom tab bar (so it never eats layout
          height or gets occluded by the MobileBar). On desktop (md+) it stays
          docked at the bottom of the column, as before. */}
      <div
        className="absolute inset-x-0 z-30 transition-[bottom] duration-200 md:static md:z-auto"
        style={{ bottom: keyboardInset > 0 ? keyboardInset + 8 : "var(--live-controls-bottom)" }}
      >
        <div className="mx-auto w-full max-w-3xl px-3 md:max-w-none md:px-0">
          {/* Connected → a glass control cluster on mobile; idle → the call
              button floats on its own (no bar) like a native FAB. Desktop keeps
              the docked bar in both states. */}
          <div className={`overflow-hidden border-white/10 md:border-t md:bg-paper/40 ${
            isConnected
              ? "max-md:rounded-glass max-md:border max-md:bg-[var(--glass-bg)] max-md:shadow-glass max-md:backdrop-blur-xl"
              : "max-md:flex max-md:justify-center"
          }`}>
            <ControlBar
              phase={phase} canStart={canStart} isConnected={isConnected}
              micOn={micOn} cameraOn={cameraOn} staySilent={staySilent} cocktailParty={cocktailParty} safetyOn={safetyOn} speaking={speaking}
              onStart={() => void start()} onStop={stop}
              onToggleMic={toggleMic} onToggleCamera={toggleCamera} onToggleSilent={toggleStaySilent} onToggleCocktail={toggleCocktailParty} onToggleSafety={toggleSafety}
            />
            {isConnected && <Composer onSend={sendText} />}
          </div>
        </div>
      </div>

      {/* Fullscreen video */}
      {pipFull && showVideo && (
        <FullscreenVideo sourceRef={videoElRef} transcript={transcript} onClose={() => setPipFull(false)} onHangup={() => { stop(); setPipFull(false); }} />
      )}

      {/* Hawk session menu (New session / History / Status) */}
      {menuOpen && <SessionMenu phase={phase} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Composer — owns its own draft state (typing never re-renders the video).
// -----------------------------------------------------------------------------
const Composer = memo(function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const send = () => { const t = draft.trim(); if (t) { onSend(t); setDraft(""); } };
  return (
    <div className="px-4 pb-4 pt-2 md:px-6">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={1}
          placeholder="Type a message…"
          className="max-h-32 min-h-[44px] flex-1 resize-none rounded-glass bg-paper px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/40 focus:ring-1 focus:ring-accent"
        />
        <button onClick={send} disabled={!draft.trim()} aria-label="Send"
          className="pressable grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-black disabled:opacity-40">
          <Icon name="send" className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
});

// -----------------------------------------------------------------------------
// Control bar (web style: a centered row of round controls)
// -----------------------------------------------------------------------------
function ControlBar(p: {
  phase: LivePhase; canStart: boolean; isConnected: boolean;
  micOn: boolean; cameraOn: boolean; staySilent: boolean; cocktailParty: boolean; safetyOn: boolean; speaking: boolean;
  onStart: () => void; onStop: () => void;
  onToggleMic: () => void; onToggleCamera: () => void; onToggleSilent: () => void; onToggleCocktail: () => void; onToggleSafety: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-2.5 py-2.5">
      {p.isConnected && (
        <>
          <Ctrl on={p.micOn} onIcon="mic" offIcon="micOff" label="Mic" onClick={p.onToggleMic} pulse={p.speaking} />
          <Ctrl on={p.cameraOn} onIcon="video" offIcon="videoOff" label="Camera" onClick={p.onToggleCamera} />
          <Ctrl on={p.staySilent} onIcon="earFill" offIcon="ear" label="Stay silent" onClick={p.onToggleSilent} />
          <Ctrl on={p.cocktailParty} onIcon="person2Fill" offIcon="person2" label="Cocktail Party" onClick={p.onToggleCocktail} />
          <Ctrl on={p.safetyOn} onIcon="warning" offIcon="warning" label="Safety Check" onClick={p.onToggleSafety} danger />
        </>
      )}
      <PrimaryButton phase={p.phase} canStart={p.canStart} onStart={p.onStart} onStop={p.onStop} />
    </div>
  );
}

function Ctrl({ on, onIcon, offIcon, label, onClick, pulse, danger }: {
  on: boolean; onIcon: IconName; offIcon: IconName; label: string; onClick: () => void; pulse?: boolean; danger?: boolean;
}) {
  const onCls = danger ? "bg-danger text-white" : "bg-white text-black";
  return (
    <button onClick={onClick} aria-label={label} aria-pressed={on}
      className={`pressable relative grid h-11 w-11 place-items-center rounded-full ${on ? onCls : "bg-white/10 text-white hover:bg-white/15"}`}>
      <Icon name={on ? onIcon : offIcon} className="h-5 w-5" filled={on} />
      {pulse && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-accent" />}
    </button>
  );
}

function PrimaryButton({ phase, canStart, onStart, onStop }: { phase: LivePhase; canStart: boolean; onStart: () => void; onStop: () => void }) {
  // End button sits inline with the toggle row when connected → keep it the same
  // 44px footprint as the toggles; the idle call button is larger and prominent.
  if (phase === "connected" || phase === "paused") {
    return <button onClick={onStop} aria-label="End session" className="pressable grid h-11 w-11 place-items-center rounded-full bg-danger text-white shadow-glass"><Icon name="xmark" className="h-5 w-5" /></button>;
  }
  if (phase === "connecting") {
    return <div className="grid h-14 w-14 place-items-center rounded-full bg-danger/80 text-white"><span className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white" /></div>;
  }
  return <button onClick={onStart} disabled={!canStart} aria-label="Start session" className="pressable grid h-14 w-14 place-items-center rounded-full bg-ok text-white shadow-glass disabled:opacity-40"><Icon name="phone" className="h-6 w-6" filled /></button>;
}

// -----------------------------------------------------------------------------
// Transcript + bubbles (iOS-matched)
// -----------------------------------------------------------------------------
function Transcript({ entries, phase, loading }: { entries: TranscriptEntry[]; phase: LivePhase; loading?: boolean }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [entries]);

  if (loading && entries.length === 0) {
    return <div className="grid h-full place-items-center text-sm text-white/45">Loading conversation…</div>;
  }

  if (entries.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-xs">
          <img src="/hawk-icon.png" alt="Hawk"
            className={`mx-auto mb-5 h-24 w-24 rounded-[1.4rem] object-cover shadow-glass ${phase === "connecting" ? "animate-pulse" : ""}`} />
          {phase === "idle" && (
            <>
              <h2 className="text-xl font-semibold text-white">Talk to Hawky</h2>
              <p className="mt-2 text-sm leading-relaxed text-white/55">
                Tap the call button to start a live session — the conversation appears here and your camera shows in the corner.
              </p>
            </>
          )}
          {phase === "connecting" && <p className="text-sm text-white/55">Connecting…</p>}
          {phase === "failed" && <p className="text-sm text-white/55">Session ended — tap the call button to retry.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 pt-4 pb-48 md:px-6 md:pb-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {entries.map((e) => <Bubble key={e.id} entry={e} />)}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function Bubble({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "warning") {
    return (
      <div className="flex items-center gap-2 rounded-pill bg-danger px-3 py-2 text-sm font-bold text-white">
        <Icon name="warning" className="h-4 w-4 shrink-0" /> {entry.text}
      </div>
    );
  }
  if (entry.kind === "system") {
    return <div className="px-2 text-center text-xs text-white/45">{entry.text}</div>;
  }
  if (entry.kind === "tool") {
    return <ToolBubble entry={entry} />;
  }
  const isUser = entry.kind === "user";
  if (isUser) {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[80%] rounded-bubble bg-accent/[0.22] px-3.5 py-2 text-sm leading-relaxed text-white ring-1 ring-accent/30">
          {entry.text}
        </div>
        <Time at={entry.at} />
      </div>
    );
  }
  // assistant: plain left-aligned text, no bubble (iOS style)
  return (
    <div className="flex max-w-[88%] flex-col items-start">
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-white/90">{entry.text}</div>
      <Time at={entry.at} />
    </div>
  );
}

/** Tool-call bubble — colored card whose color reflects status, like iOS:
 *  running = purple (spinner), ok = green (check), error = red (warning). */
function ToolBubble({ entry }: { entry: TranscriptEntry }) {
  const openArtifact = useContext(OpenArtifactContext);
  const m = /^([a-zA-Z0-9_]+)\s*\((.*)\)$/s.exec(entry.text);
  const name = m ? m[1] : entry.text;
  const args = m ? m[2] : "";
  const status = entry.toolStatus ?? "running";

  const theme =
    status === "ok"
      ? { ring: "border-ok/40", fill: "bg-ok/10", icon: "text-ok", iconName: "checkmark" as IconName }
      : status === "error"
        ? { ring: "border-danger/40", fill: "bg-danger/10", icon: "text-danger", iconName: "warning" as IconName }
        : { ring: "border-purple-400/30", fill: "bg-purple-400/10", icon: "text-purple-300", iconName: "settings" as IconName };

  const statusLine =
    status === "running" ? "running…"
    : status === "ok" ? `done${entry.toolMs != null ? ` · ${formatMs(entry.toolMs)}` : ""}`
    : `error${entry.toolMs != null ? ` · ${formatMs(entry.toolMs)}` : ""}`;

  return (
    <div className="flex flex-col items-start">
      <div className={`flex max-w-[88%] items-start gap-2 rounded-card border ${theme.ring} ${theme.fill} px-3 py-2`}>
        {status === "running" ? (
          <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-purple-300/40 border-t-purple-300" />
        ) : (
          <Icon name={theme.iconName} className={`mt-0.5 h-4 w-4 shrink-0 ${theme.icon}`} filled={status === "ok"} />
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-white">{name}</span>
            <span className={`text-[10px] ${theme.icon}`}>{statusLine}</span>
          </div>
          {args && <div className="mt-0.5 break-words font-mono text-[11px] text-white/50">{args.length > 160 ? args.slice(0, 160) + "…" : args}</div>}
          {entry.toolDetail && status !== "running" && (
            <div className={`mt-0.5 text-[11px] ${status === "error" ? "text-danger/90" : "text-white/45"}`}>{entry.toolDetail}</div>
          )}
        </div>
      </div>
      {/* Inline image result (e.g. a generated chart) — rendered in the chat
          flow, persisted into history, and clickable to zoom in the lightbox. */}
      {entry.imageData && (
        <button
          onClick={() => openArtifact?.({ id: entry.id, src: entry.imageData!, title: entry.imageTitle || entry.text || "Chart", at: entry.at })}
          className="pressable group relative mt-2 block w-full max-w-[min(92%,520px)] overflow-hidden rounded-card border border-white/10 bg-white"
          aria-label="Zoom chart"
          title="Click to zoom"
        >
          <img src={entry.imageData} alt={entry.imageTitle || "Generated chart"} className="w-full" />
          <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md bg-black/40 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
            <Icon name="plus" className="h-4 w-4" />
          </span>
        </button>
      )}
      <Time at={entry.at} />
    </div>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function Time({ at }: { at: string }) {
  return <span className="mt-1 font-mono text-[10px] text-white/30">{at}</span>;
}

function PhasePill({ phase }: { phase: LivePhase }) {
  const color = phase === "connected" ? "bg-ok" : phase === "connecting" ? "bg-warn animate-pulse" : phase === "failed" ? "bg-danger" : "bg-white/40";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}

function Banner({ tone, icon, text }: { tone: "warn" | "danger"; icon: IconName; text: string }) {
  const cls = tone === "danger" ? "bg-danger/90 text-white" : "bg-warn/90 text-black";
  return (
    <div className={`mx-auto flex max-w-3xl items-center gap-2 rounded-pill px-3 py-2 text-xs font-medium ${cls}`}>
      <Icon name={icon} className="h-4 w-4 shrink-0" /> {text}
    </div>
  );
}

/** A second <video> that mirrors the source MediaStream, for fullscreen. */
function MirrorVideo({ sourceRef, className }: { sourceRef: React.RefObject<HTMLVideoElement | null>; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const src = sourceRef.current?.srcObject as MediaStream | null;
    if (ref.current && src) ref.current.srcObject = src;
  }, [sourceRef]);
  return <video ref={ref} autoPlay muted playsInline className={className} />;
}

function FullscreenVideo({ sourceRef, transcript, onClose, onHangup }: {
  sourceRef: React.RefObject<HTMLVideoElement | null>; transcript: TranscriptEntry[]; onClose: () => void; onHangup: () => void;
}) {
  const captions = transcript.filter((t) => t.kind === "user" || t.kind === "assistant").slice(-3);
  return (
    <div className="absolute inset-0 z-50 bg-black">
      <MirrorVideo sourceRef={sourceRef} className="h-full w-full object-cover" />
      <span className="absolute left-4 top-4 flex items-center gap-1 rounded-pill bg-live/90 px-2 py-1 text-[11px] font-bold uppercase text-white">
        <span className="h-1.5 w-1.5 rounded-full bg-white" /> Live
      </span>
      <button onClick={onClose} aria-label="Minimize" className="pressable absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white">
        <Icon name="chevronDown" className="h-5 w-5" />
      </button>
      <div className="absolute inset-x-4 bottom-24 space-y-1 text-center">
        {captions.map((c) => <p key={c.id} className="text-sm text-white drop-shadow">{c.text}</p>)}
      </div>
      <div className="absolute inset-x-0 bottom-6 flex justify-center">
        <button onClick={onHangup} aria-label="Hang up" className="pressable grid h-14 w-14 place-items-center rounded-full bg-danger text-white"><Icon name="xmark" className="h-6 w-6" /></button>
      </div>
    </div>
  );
}
