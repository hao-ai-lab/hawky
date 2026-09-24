import { useEffect, useState } from "react";
import { useSocketStore } from "../lib/socket-store";
import { useLiveSettings, REALTIME_MODELS, VOICES, TRANSCRIBE_MODELS, SEMANTIC_EAGERNESS, REASONING_EFFORT, TOOL_CHOICE } from "../lib/live-settings";
import { Section, Row, Select, Slider, Button, Toggle } from "./Form";

// Shared by Settings and the Live popup so both edit the same saved options.
export function LiveSettingsPanel() {
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
        <Row label="Microphone" detail="Capture audio when the session starts"><Toggle checked={s.microphoneEnabled} onChange={v => s.set("microphoneEnabled", v)} /></Row>
        <Row label="Camera input" detail="Capture video when the session starts"><Toggle checked={s.cameraEnabled} onChange={v => s.set("cameraEnabled", v)} /></Row>
        <Row label="Start quietly" detail="Listen without replying until Stay silent is turned off"><Toggle checked={s.staySilent} onChange={v => s.set("staySilent", v)} /></Row>
        <Row label="Visual cadence">{sel("visualCadence", [{ value: "off", label: "Off" }, { value: "0.2", label: "0.2 fps" }, { value: "0.5", label: "0.5 fps" }, { value: "1", label: "1 fps" }, { value: "custom", label: "Custom" }] as const)}</Row>
        {s.visualCadence === "custom" && <Row label="Custom fps"><Slider value={s.customFps} onChange={(v) => s.set("customFps", v)} min={0.1} max={5} step={0.1} suffix="fps" /></Row>}
        <Row label="Camera">{sel("cameraPosition", [{ value: "front", label: "Front" }, { value: "back", label: "Back" }] as const)}</Row>
        <Row label="Skip near-identical frames"><Toggle checked={s.visualDedup} onChange={(v) => s.set("visualDedup", v)} /></Row>
        <Row label="Respond only when spoken to"><Toggle checked={s.speakOnlyWhenSpokenTo} onChange={(v) => s.set("speakOnlyWhenSpokenTo", v)} /></Row>
        <Row label="Cocktail Party" detail="Recognize faces & recall people"><Toggle checked={s.cocktailParty} onChange={(v) => s.set("cocktailParty", v)} /></Row>
        <Row label="Safety Check" detail="Needs camera input and the gateway hazard service"><Toggle checked={s.safetyCheck} onChange={v => s.set("safetyCheck", v)} /></Row>
      </Section>

      <Section title="Live · Conversation">
        <Row label="Show system messages"><Toggle checked={s.showSystemMessages} onChange={(v) => s.set("showSystemMessages", v)} /></Row>
      </Section>

      <Section title="Live · Hawk bridge" footer="How Live delegates durable work + memory to the backend agent.">
        <Row label="Backend agent bridge"><Toggle checked={s.backendBridge} onChange={(v) => s.set("backendBridge", v)} /></Row>
        <ExternalRuntimeToggle />
        <Row label="Backend runtime" detail="Codex and Claude use their local CLI login and permission settings.">{sel("backendRuntime", [{ value: "native", label: "Hawk provider" }, { value: "codex", label: "Codex CLI" }, { value: "claude", label: "Claude Code CLI" }] as const)}</Row>
        <Row label="Require gateway connection"><Toggle checked={s.bridgeRequired} onChange={(v) => s.set("bridgeRequired", v)} /></Row>
        <Row label="Session mode">{sel("bridgeSessionMode", [{ value: "temporary", label: "New realtime channel" }, { value: "fixed", label: "Fixed channel" }, { value: "active_chat", label: "Active session" }] as const)}</Row>
        <Row label="Feed mode">{sel("bridgeFeedMode", [{ value: "on_demand", label: "On-demand tools" }, { value: "follow_stream", label: "Follow session stream" }] as const)}</Row>
        <Row label="Opening behavior">{sel("openingBehavior", [{ value: "silent", label: "Silent" }, { value: "first_contact", label: "First contact only" }, { value: "every_session", label: "Check in every session" }] as const)}</Row>
        <Button tone="secondary" onClick={s.reset}>Reset all Live settings</Button>
      </Section>
    </>
  );
}

function ExternalRuntimeToggle() {
  const rpc = useSocketStore(s => s.rpc);
  const status = useSocketStore(s => s.status);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (status !== "connected") return;
    let active = true;
    void rpc("config.get").then((c: any) => { if (active) setEnabled(c.experiments?.agent_runtimes === true); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [rpc, status]);
  async function update(value: boolean) {
    if (saving || status !== "connected") return;
    setSaving(true);
    try { await rpc("config.update", { experiments: { agent_runtimes: value } }); setEnabled(value); setError(""); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  return <Row label="Enable CLI runtimes" detail={error || (saving ? "Saving…" : "Uses Codex or Claude installed on the gateway host.")}>
    <Toggle checked={enabled} onChange={v => void update(v)} />
  </Row>;
}
