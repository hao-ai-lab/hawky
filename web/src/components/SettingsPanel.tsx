// =============================================================================
// Settings Panel
//
// Web UI for viewing and modifying session-level and global settings.
// Session settings (effort, permission mode) apply to the active session.
// Global settings (model, heartbeat, screenshots) persist to config.json.
// =============================================================================

import { useState, useEffect } from "react";
import { useSocketStore } from "../store/socket-store";
import { useWebSettingsStore } from "../store/web-settings-store";
import { loadByokKey, saveByokKey, looksLikeOpenAIKey, maskKey } from "../lib/byok";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ConfigData {
  model: string;
  provider: string;
  openai_base_url?: string;
  effort: string | null;
  max_tokens: number;
  max_iterations: number;
  heartbeat: {
    enabled: boolean;
    interval_minutes: number;
    model: string | null;
    active_hours: { start: string; end: string };
    consolidation_enabled: boolean;
  };
  screenshots: { retention_days: number };
  experiments?: { agent_runtimes?: boolean };
  has_anthropic_key?: boolean;
  has_openai_key?: boolean;
  vertex?: { project_id?: string };
  openai_compatible?: {
    active_profile?: string;
    profile_names?: string[];
    profiles?: Record<string, { model?: string; base_url?: string }>;
  };
}

interface DraftState {
  model: string;
  openaiBaseUrl: string;
  defaultEffort: string;
  maxTokens: number;
  maxIterations: number;
  heartbeatEnabled: boolean;
  heartbeatInterval: number;
  heartbeatModel: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  consolidationEnabled: boolean;
  screenshotRetention: number;
  agentRuntimesEnabled: boolean;
}

const CLAUDE_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

const OPENAI_MODELS_FALLBACK = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-chat-latest",
  "gpt-5.3-codex",
];
const OPENAI_MODELS_ALLOWLIST = new Set(OPENAI_MODELS_FALLBACK);
const OPENAI_MODEL_LABELS: Record<string, string> = {
  "gpt-5.3-chat-latest": "gpt-5.3-chat-latest (ChatGPT instant)",
  "gpt-5.3-codex": "gpt-5.3-codex (coding)",
};

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function modelOptionLabel(model: string): string {
  return OPENAI_MODEL_LABELS[model] ?? model;
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted dark:text-muted-dark mb-3">
      {children}
    </h3>
  );
}

function SettingRow({ label, description, children }: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 min-h-[44px]">
      <div className="flex-1 min-w-0 mr-4">
        <div className="text-sm text-stone-700 dark:text-stone-300">{label}</div>
        {description && (
          <div className="text-xs text-muted dark:text-muted-dark mt-0.5">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SegmentedControl({ options, value, onChange }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg bg-stone-100 dark:bg-stone-800 p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-3 py-2 text-xs font-medium rounded-md transition-colors ${
            value === opt
              ? "bg-white dark:bg-stone-600 text-stone-800 dark:text-stone-100 shadow-sm"
              : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${
        checked ? "bg-stone-800 dark:bg-stone-300" : "bg-stone-300 dark:bg-stone-600"
      }`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white dark:bg-stone-900 transition-transform ${
        checked ? "translate-x-5" : ""
      }`} />
    </button>
  );
}

function NumberInput({ value, onChange, min, max, suffix }: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n) && n >= min && n <= max) onChange(n);
        }}
        min={min}
        max={max}
        className="w-20 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-2 text-sm text-right text-stone-700 dark:text-stone-300 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500"
      />
      {suffix && <span className="text-xs text-muted dark:text-muted-dark">{suffix}</span>}
    </div>
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-1 text-sm text-stone-700 dark:text-stone-300 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500"
    />
  );
}

/**
 * BYOK ("bring your own key") OpenAI key field for the hosted web demo (#681).
 *
 * Stored ONLY in this browser's localStorage (see lib/byok.ts) and sent to the
 * gateway broker per-session to mint short-lived realtime secrets. Self-managed
 * (saves immediately on its own button) so it stays independent of the global
 * config save bar, which writes to the gateway's config.json.
 */
function ByokSection() {
  const [stored, setStored] = useState<string>(() => loadByokKey());
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");

  const hasKey = stored.length > 0;
  const draftValid = looksLikeOpenAIKey(draft);

  const save = () => {
    if (!draftValid) return;
    saveByokKey(draft);
    setStored(draft.trim());
    setDraft("");
    setEditing(false);
  };

  const clear = () => {
    saveByokKey("");
    setStored("");
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="py-5 border-b border-stone-200/40 dark:border-stone-700/30">
      <SectionHeader>OpenAI key (this browser)</SectionHeader>
      <p className="text-xs text-muted dark:text-muted-dark mb-3">
        Used for the Live and Transcription demos. Stored only in this browser and
        sent to the gateway solely to mint short-lived realtime secrets — never
        persisted on the server or shared.
      </p>

      {hasKey && !editing ? (
        <SettingRow label="API key" description="Saved in this browser">
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-stone-600 dark:text-stone-400">{maskKey(stored)}</code>
            <button
              onClick={() => { setEditing(true); setDraft(""); }}
              className="text-xs text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 underline"
            >
              Replace
            </button>
            <button
              onClick={clear}
              className="text-xs text-red-600 dark:text-red-400 hover:underline"
            >
              Clear
            </button>
          </div>
        </SettingRow>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            type="password"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && draftValid) save(); }}
            placeholder="sk-..."
            className="w-full rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-3 py-2 text-sm font-mono text-stone-700 dark:text-stone-300 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={!draftValid}
              className="rounded-md bg-stone-800 dark:bg-stone-200 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 disabled:opacity-40"
            >
              Store key
            </button>
            {(editing || hasKey) && (
              <button
                onClick={() => { setEditing(false); setDraft(""); }}
                className="text-xs text-muted dark:text-muted-dark hover:text-stone-700 dark:hover:text-stone-300"
              >
                Cancel
              </button>
            )}
            {draft.length > 0 && !draftValid && (
              <span className="text-xs text-amber-600 dark:text-amber-400">Expected an OpenAI key (sk-…)</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export function SettingsPanel({
  onClose,
  liveLabEnabled = false,
  onLiveLabEnabledChange = () => {},
}: {
  onClose: () => void;
  liveLabEnabled?: boolean;
  onLiveLabEnabledChange?: (enabled: boolean) => void;
}) {
  const rpc = useSocketStore((s) => s.rpc);
  const connStatus = useSocketStore((s) => s.status);
  const setGlobalAgentRuntimesEnabled = useWebSettingsStore((s) => s.setAgentRuntimesEnabled);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<DraftState | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [provider, setProvider] = useState<string>("anthropic");
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false);
  const [vertexProjectId, setVertexProjectId] = useState("");
  const [compatProfiles, setCompatProfiles] = useState<Record<string, { model?: string; base_url?: string }>>({});
  const [activeCompatProfile, setActiveCompatProfile] = useState<string>("");
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [pendingCompatProfile, setPendingCompatProfile] = useState<string | null>(null);

  // Load settings on mount
  const [openaiModels, setOpenaiModels] = useState<string[]>(OPENAI_MODELS_FALLBACK);

  useEffect(() => {
    if (connStatus !== "connected") {
      setLoading(false);
      return;
    }

    let active = true;
    (async () => {
      try {
        const config = await rpc("config.get") as ConfigData;

        if (!active) return;

        const state: DraftState = {
          model: config.model,
          openaiBaseUrl: config.openai_base_url ?? "",
          defaultEffort: config.effort ?? "",
          maxTokens: config.max_tokens,
          maxIterations: config.max_iterations,
          heartbeatEnabled: config.heartbeat.enabled,
          heartbeatInterval: config.heartbeat.interval_minutes,
          heartbeatModel: config.heartbeat.model ?? "",
          activeHoursStart: config.heartbeat.active_hours.start,
          activeHoursEnd: config.heartbeat.active_hours.end,
          consolidationEnabled: config.heartbeat.consolidation_enabled,
          screenshotRetention: config.screenshots.retention_days,
          agentRuntimesEnabled: config.experiments?.agent_runtimes === true,
        };

        setProvider(config.provider ?? "anthropic");
        setHasAnthropicKey(Boolean(config.has_anthropic_key));
        setHasOpenaiKey(Boolean(config.has_openai_key));
        setVertexProjectId(config.vertex?.project_id ?? "");
        setCompatProfiles(config.openai_compatible?.profiles ?? {});
        setActiveCompatProfile(config.openai_compatible?.active_profile ?? "");
        setSaved(state);
        setDraft({ ...state });
        setGlobalAgentRuntimesEnabled(state.agentRuntimesEnabled);
        setError(null);

        try {
          const result = await rpc("provider.listModels") as { models: string[] };
          if (active && Array.isArray(result.models) && result.models.length > 0) {
            const hasCustomEndpoint = Boolean(config.openai_base_url);
            setOpenaiModels(hasCustomEndpoint
              ? result.models
              : result.models.filter((m) => OPENAI_MODELS_ALLOWLIST.has(m)));
          }
        } catch {
          // probe failed; keep fallback list
        }
      } catch (err) {
        if (active) setError("Failed to load settings");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [connStatus, rpc]);

  const hasPendingProviderChange =
    Boolean(pendingProvider && pendingProvider !== provider) ||
    Boolean(
      pendingProvider === "openai_compatible" &&
      pendingCompatProfile &&
      pendingCompatProfile !== activeCompatProfile,
    );
  const isDirty = saved && draft && (JSON.stringify(draft) !== JSON.stringify(saved) || hasPendingProviderChange);

  const update = (field: keyof DraftState, value: string | number | boolean) => {
    setDraft((prev) => prev ? { ...prev, [field]: value } : prev);
  };

  // Claude models become pickable as long as ANY Anthropic credential is
  // available — either a direct API key, or a Vertex project_id (regardless
  // of which provider is currently active). Picking one switches the
  // provider to anthropic/vertex via inferProviderFromModel.
  const hasClaudeCreds = hasAnthropicKey || Boolean(vertexProjectId);

  const claudeModels = hasClaudeCreds ? CLAUDE_MODELS : [];
  const gptModels = hasOpenaiKey ? openaiModels : [];
  const compatEntries = Object.entries(compatProfiles)
    .filter(([, p]) => p.model)
    .map(([name, p]) => ({ name, model: p.model as string }));

  const availableModels = [...claudeModels, ...gptModels, ...compatEntries.map((e) => e.model)];

  // The select's option-value encodes which group the choice came from so
  // onChange can switch provider + active_profile in one step. Plain model
  // IDs map back onto provider via prefix; compat entries use `compat:<name>`.
  // Pending* state takes priority — it reflects the user's latest dropdown
  // pick BEFORE save, so the visible dropdown value updates immediately.
  const currentSelectValue = (() => {
    if (pendingProvider === "openai_compatible" && pendingCompatProfile) {
      return `compat:${pendingCompatProfile}`;
    }
    if (pendingProvider && draft && availableModels.includes(draft.model)) {
      return draft.model;
    }
    if (provider === "openai_compatible" && activeCompatProfile) {
      return `compat:${activeCompatProfile}`;
    }
    return draft && availableModels.includes(draft.model) ? draft.model : "__custom__";
  })();

  function inferProviderFromModel(model: string, current: string): string {
    if (model.startsWith("claude")) {
      // If already on a Claude-native provider, keep it.
      if (current === "vertex" || current === "anthropic") return current;
      // Switching away from openai (or unknown): prefer vertex if configured,
      // then anthropic if a key is present, otherwise fall back to current.
      if (vertexProjectId) return "vertex";
      if (hasAnthropicKey) return "anthropic";
      return current;
    }
    if (model.startsWith("gpt") || OPENAI_MODELS_ALLOWLIST.has(model)) {
      return "openai";
    }
    return current;
  }

  const handleSave = async () => {
    if (!draft || !saved) return;
    setSaving(true);
    setError(null);

    try {
      const modelChanged = draft.model !== saved.model;
      const baseUrlChanged = draft.openaiBaseUrl !== saved.openaiBaseUrl;
      const targetProvider = pendingProvider ?? (modelChanged ? inferProviderFromModel(draft.model, provider) : provider);
      const compatProfileChanged =
        targetProvider === "openai_compatible" &&
        Boolean(pendingCompatProfile) &&
        (provider !== "openai_compatible" || pendingCompatProfile !== activeCompatProfile);
      const needsProviderSwap =
        targetProvider !== provider ||
        compatProfileChanged ||
        (targetProvider === "openai" && baseUrlChanged);

      if (needsProviderSwap) {
        const swapParams: {
          provider: string;
          active_profile?: string;
          model?: string;
          openai_base_url?: string;
        } = { provider: targetProvider };
        if (targetProvider === "openai_compatible" && pendingCompatProfile) {
          swapParams.active_profile = pendingCompatProfile;
        }
        if (modelChanged) {
          swapParams.model = draft.model;
        }
        if (targetProvider === "openai" && baseUrlChanged) {
          swapParams.openai_base_url = draft.openaiBaseUrl;
        }

        const swapResult = await rpc("gateway.swapProvider", swapParams) as { ok?: boolean; error?: string } | undefined;
        if (swapResult?.ok === false) {
          setError(swapResult.error ?? "Live provider swap refused");
          return;
        }
        setProvider(targetProvider);
        if (targetProvider === "openai_compatible" && pendingCompatProfile) {
          setActiveCompatProfile(pendingCompatProfile);
        }
      }

      const updates: Record<string, unknown> = {};
      if (modelChanged && !needsProviderSwap) {
        updates.model = draft.model;
      }
      if (draft.defaultEffort !== saved.defaultEffort) {
        updates.effort = draft.defaultEffort || null;
      }
      if (draft.maxTokens !== saved.maxTokens) updates.max_tokens = draft.maxTokens;
      if (draft.maxIterations !== saved.maxIterations) updates.max_iterations = draft.maxIterations;

      if (draft.heartbeatEnabled !== saved.heartbeatEnabled ||
          draft.heartbeatInterval !== saved.heartbeatInterval ||
          draft.heartbeatModel !== saved.heartbeatModel ||
          draft.activeHoursStart !== saved.activeHoursStart ||
          draft.activeHoursEnd !== saved.activeHoursEnd ||
          draft.consolidationEnabled !== saved.consolidationEnabled) {
        updates.heartbeat = {
          enabled: draft.heartbeatEnabled,
          interval_minutes: draft.heartbeatInterval,
          ...(draft.heartbeatModel ? { model: draft.heartbeatModel } : {}),
          active_hours: { start: draft.activeHoursStart, end: draft.activeHoursEnd },
          consolidation_enabled: draft.consolidationEnabled,
        };
      }

      if (draft.screenshotRetention !== saved.screenshotRetention) {
        updates.screenshots = { retention_days: draft.screenshotRetention };
      }

      if (draft.agentRuntimesEnabled !== saved.agentRuntimesEnabled) {
        updates.experiments = { agent_runtimes: draft.agentRuntimesEnabled };
      }

      if (Object.keys(updates).length > 0) {
        await rpc("config.update", updates);
      }

      setSaved({ ...draft });
      setGlobalAgentRuntimesEnabled(draft.agentRuntimesEnabled);
      setPendingProvider(null);
      setPendingCompatProfile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = () => {
    if (saved) setDraft({ ...saved });
    setPendingProvider(null);
    setPendingCompatProfile(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted dark:text-muted-dark">Loading...</div>
        ) : !draft ? (
          <div className="flex items-center justify-center h-32 text-muted dark:text-muted-dark">
            {error ?? "Unable to load settings"}
          </div>
        ) : (
          <div className="max-w-xl mx-auto px-6 pt-6 pb-24">

            {/* Model & Agent */}
            <div className="py-5 border-b border-stone-200/40 dark:border-stone-700/30">
              <SectionHeader>Model</SectionHeader>
              <SettingRow label="Default model" description="Used for new sessions">
                {availableModels.length === 0 && compatEntries.length === 0 ? (
                  <p className="text-xs text-muted dark:text-muted-dark max-w-[260px]">
                    Configure an API key in{" "}
                    <code className="font-mono text-[11px] bg-stone-100 dark:bg-stone-800 px-1 py-0.5 rounded">
                      ~/.hawky/config.json
                    </code>{" "}
                    to see available models.
                  </p>
                ) : (
                  <select
                    value={currentSelectValue}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__custom__") return;
                      if (v.startsWith("compat:")) {
                        const profileName = v.slice("compat:".length);
                        const prof = compatProfiles[profileName];
                        if (!prof?.model) return;
                        update("model", prof.model);
                        setPendingProvider("openai_compatible");
                        setPendingCompatProfile(profileName);
                      } else {
                        update("model", v);
                        // Anthropic / vertex / openai — clear compat pending and
                        // record the inferred provider so the visible dropdown
                        // value flips immediately (without waiting for Save).
                        const inferred = inferProviderFromModel(v, provider);
                        setPendingProvider(inferred !== provider ? inferred : provider);
                        setPendingCompatProfile(null);
                      }
                    }}
                    className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-1 text-sm text-stone-700 dark:text-stone-300 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500 max-w-[280px]"
                  >
                    {claudeModels.length > 0 && (
                      <optgroup label="Claude">
                        {claudeModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </optgroup>
                    )}
                    {gptModels.length > 0 && (
                      <optgroup label="OpenAI">
                        {gptModels.map((m) => (
                          <option key={m} value={m}>{modelOptionLabel(m)}</option>
                        ))}
                      </optgroup>
                    )}
                    {compatEntries.length > 0 && (
                      <optgroup label="OpenAI-compatible">
                        {compatEntries.map((e) => (
                          <option key={`compat:${e.name}`} value={`compat:${e.name}`}>
                            {e.name}: {e.model}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {!availableModels.includes(draft.model) && currentSelectValue === "__custom__" && (
                      <option value="__custom__" disabled>{draft.model}</option>
                    )}
                  </select>
                )}
              </SettingRow>
              {provider === "openai" && (
                <SettingRow label="API base URL" description="Custom endpoint (vLLM, Groq, DeepInfra…). Leave blank for api.openai.com.">
                  <input
                    type="text"
                    value={draft.openaiBaseUrl}
                    onChange={(e) => update("openaiBaseUrl", e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-64 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-1 text-sm text-stone-700 dark:text-stone-300 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500"
                  />
                </SettingRow>
              )}
              <SettingRow label="Default effort" description="Applies to new sessions (default: medium)">
                <SegmentedControl
                  options={EFFORT_LEVELS}
                  value={draft.defaultEffort || "medium"}
                  onChange={(v) => update("defaultEffort", v)}
                />
              </SettingRow>
              <SettingRow label="Max tokens" description="Maximum output tokens per response">
                <NumberInput value={draft.maxTokens} onChange={(v) => update("maxTokens", v)} min={1024} max={128000} />
              </SettingRow>
              <SettingRow label="Max iterations" description="Agent loop iteration limit">
                <NumberInput value={draft.maxIterations} onChange={(v) => update("maxIterations", v)} min={1} max={200} />
              </SettingRow>
            </div>

            {/* Heartbeat */}
            <div className="py-5 border-b border-stone-200/40 dark:border-stone-700/30">
              <SectionHeader>Heartbeat</SectionHeader>
              <SettingRow label="Enabled">
                <Toggle checked={draft.heartbeatEnabled} onChange={(v) => update("heartbeatEnabled", v)} />
              </SettingRow>
              {draft.heartbeatEnabled && (
                <>
                  <SettingRow label="Interval">
                    <NumberInput value={draft.heartbeatInterval} onChange={(v) => update("heartbeatInterval", v)} min={1} max={1440} suffix="min" />
                  </SettingRow>
                  <SettingRow label="Model override" description="Use a different model for heartbeat">
                    <select
                      value={draft.heartbeatModel || ""}
                      onChange={(e) => update("heartbeatModel", e.target.value)}
                      className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-1 text-sm text-stone-700 dark:text-stone-300 focus:outline-none focus:border-stone-400 dark:focus:border-stone-500"
                    >
                      <option value="">Same as default</option>
                      {CLAUDE_MODELS.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                      {/* Custom-value fallback: preserve a user's existing
                          heartbeat.model (e.g. a deprecated 4-5 variant) so
                          their saved config still renders after upgrade. */}
                      {draft.heartbeatModel &&
                        !CLAUDE_MODELS.includes(draft.heartbeatModel) && (
                          <option value={draft.heartbeatModel}>
                            {draft.heartbeatModel} (custom)
                          </option>
                        )}
                    </select>
                  </SettingRow>
                  <SettingRow label="Active hours">
                    <div className="flex items-center gap-1.5">
                      <TimeInput value={draft.activeHoursStart} onChange={(v) => update("activeHoursStart", v)} />
                      <span className="text-xs text-muted dark:text-muted-dark">to</span>
                      <TimeInput value={draft.activeHoursEnd} onChange={(v) => update("activeHoursEnd", v)} />
                    </div>
                  </SettingRow>
                  <SettingRow label="Memory consolidation" description="Periodically consolidate daily memories">
                    <Toggle checked={draft.consolidationEnabled} onChange={(v) => update("consolidationEnabled", v)} />
                  </SettingRow>
                </>
              )}
            </div>

            {/* Data */}
            <div className="py-5 border-b border-stone-200/40 dark:border-stone-700/30">
              <SectionHeader>Data</SectionHeader>
              <SettingRow label="Screenshot retention">
                <NumberInput value={draft.screenshotRetention} onChange={(v) => update("screenshotRetention", v)} min={1} max={365} suffix="days" />
              </SettingRow>
            </div>

            {/* OpenAI key (BYOK) for the Live / Transcription demos */}
            <ByokSection />

            {/* Experiments */}
            <div className="py-5 border-b border-stone-200/40 dark:border-stone-700/30">
              <SectionHeader>Experiments</SectionHeader>
              <SettingRow
                label="External coding agents"
                description="Show experimental Codex and Hermes runtime choices when creating a channel."
              >
                <Toggle checked={draft.agentRuntimesEnabled} onChange={(v) => update("agentRuntimesEnabled", v)} />
              </SettingRow>
              <SettingRow
                label="Demo views"
                description="Show the Live, Transcription, and People demo views in the header."
              >
                <Toggle checked={liveLabEnabled} onChange={onLiveLabEnabledChange} />
              </SettingRow>
            </div>

            {/* Config file hint */}
            <div className="py-5">
              <p className="text-xs text-muted dark:text-muted-dark">
                Advanced settings (API keys, concurrency, MCP servers) can be edited in <code className="font-mono text-[11px] bg-stone-100 dark:bg-stone-800 px-1 py-0.5 rounded">~/.hawky/config.json</code>
              </p>
            </div>

            {error && (
              <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>
            )}
          </div>
        )}
      </div>

      {/* Save bar */}
      {isDirty && (
        <div className="sticky bottom-0 border-t border-stone-200/60 dark:border-stone-700/40 bg-surface dark:bg-surface-dark px-6 py-3 flex items-center justify-end gap-3">
          <button
            onClick={handleRevert}
            className="text-sm text-muted dark:text-muted-dark hover:text-stone-700 dark:hover:text-stone-300"
          >
            Revert
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-stone-800 dark:bg-stone-200 px-5 py-2.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-700 dark:hover:bg-stone-300 transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
