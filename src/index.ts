#!/usr/bin/env bun

import { startTui } from "./tui/index.js";
import { loadConfig, resetConfig, getConfigDir, getConfigPath } from "./storage/config.js";
import { initLogger, resolveLoggerSettings, enableConsoleCapture, createSubsystemLogger } from "./logging/index.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

// Gateway imports (used by both "chat" client mode and "gateway" server mode)
import { GatewayServer } from "./gateway/server.js";
import { AgentSessionManager } from "./gateway/agent-sessions.js";
import { registerAgentMethods } from "./gateway/agent-methods.js";
import { IntentionService } from "./ambient/intention-service.js";
import { FileIntentionStore } from "./ambient/file-intention-store.js";
import { WhenAdapter } from "./ambient/arm-when.js";
import { applyDefaultLaneConcurrency, setAgentSessionsRef } from "./gateway/lanes.js";
import { HeartbeatService } from "./gateway/heartbeat.js";
import { registerHeartbeatMethods } from "./gateway/heartbeat-methods.js";
import { CronService } from "./gateway/cron.js";
import { registerCronMethods } from "./gateway/cron-methods.js";
import { registerConfigMethods } from "./gateway/config-methods.js";
import { registerPromptMethods } from "./gateway/prompt-methods.js";
import { registerMediaMethods } from "./gateway/media-methods.js";
import { registerVisionMethods } from "./gateway/vision-methods.js";
import { registerPeopleMethods } from "./gateway/people-methods.js";
import { registerPersonMethods } from "./gateway/person-methods.js";
import { registerToolMethods } from "./gateway/tool-methods.js";
import { registerMemoryMethods } from "./gateway/memory-methods.js";
import {
  registerVoiceprintMethods,
  resolveVoiceprintLiveScoringConfigFromConfig,
  resolveVoiceprintMemoryBridgeConfigFromConfig,
} from "./gateway/voiceprint-methods.js";
import { resolveVoiceprintLifecycleFromConfig } from "./gateway/voiceprint-lifecycle.js";
import { MemoryScheduler } from "./memory/scheduler.js";
import { registerFrontendBootContextMethods } from "./gateway/frontend-boot-context.js";
import { MethodError } from "./gateway/methods.js";
import { setCronServiceRef } from "./tools/cron.js";
import { setNodeRegistryRef } from "./tools/nodes.js";
import { setBashNodeRegistry } from "./tools/bash.js";
import { setSendMessageDeps } from "./tools/send_message.js";
import { setSendPhotoDeps } from "./tools/send_photo.js";
import { setSlackListMembersDeps } from "./tools/slack_list_members.js";
import { setPushService, setChannelRegistry } from "./gateway/delivery.js";
import { createPushService } from "./gateway/push.js";
import { printGatewayBanner } from "./gateway/startup-banner.js";
import { installShutdownHandlers } from "./gateway/shutdown.js";

// Gateway-only imports (only used by "gateway" command)
import { createProvider } from "./agent/provider-factory.js";
import { WorkspaceManager, setWorkspaceDir } from "./storage/workspace.js";
import { getSessionsDir } from "./storage/session.js";
import { getGlobalMemoryIndex } from "./memory/global.js";
import { startSkillsWatcher } from "./skills/watcher.js";
import { promptForLlmCredentials, promptForOpenAIKey } from "./storage/setup-prompt.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  makeRetryingRecognizer,
  isLatentModelEnabled,
} from "./ambient/latent-recognizer.js";

const PACKAGE_VERSION = "0.1.0";
const VERSION = resolveVersion(PACKAGE_VERSION);
const DEFAULT_MODEL = "claude-opus-4-7";

/**
 * Resolve version string. In dev mode (running from source with .git),
 * appends the short commit hash and subject: "0.1.0-dev (abc1234: Fix bug)".
 * In production (npm install, no .git), returns the package version as-is.
 */
function resolveVersion(packageVersion: string): string {
  try {
    const gitDir = join(import.meta.dir, "..", ".git");
    if (!existsSync(gitDir)) return packageVersion;

    const cwd = join(import.meta.dir, "..");
    const hashResult = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd, stdout: "pipe", stderr: "pipe",
    });
    const commit = hashResult.stdout.toString().trim();
    if (!commit) return packageVersion;

    const subjectResult = Bun.spawnSync(["git", "log", "-1", "--format=%s"], {
      cwd, stdout: "pipe", stderr: "pipe",
    });
    const subject = subjectResult.stdout.toString().trim();
    const shortSubject = subject.length > 50 ? subject.slice(0, 47) + "..." : subject;

    return `${packageVersion}-dev (${commit}: ${shortSubject})`;
  } catch {
    return packageVersion;
  }
}

function printHelp() {
  console.log(`
hawky v${VERSION} - A personal assistant built on a coding agent core

Usage:
  hawky [command] [options]

Commands:
  gateway           Start the gateway server (foreground, visible logs)
  chat              Start chat client (default, connects to existing gateway)
  mcp               Start read-only Hawky MCP server over stdio
  node              Start node host (connects to gateway, exposes local tools)
  doctor            Check system health (API keys, skills, config)
  asr-replay        Replay dead-lettered ASR items (transcripts only)
  export            Export data for machine migration
  import            Import data from migration archive
  logs              Tail gateway log file
  setup             Run first-time setup

Options:
  --connect <url>   Connect to gateway at URL (default: ws://localhost:4242)
  --session <key>   Session key (default: tui:main)
  --auto            Auto-start gateway in background if not running
  --port <port>     Gateway port (default: 4242)
  --bind <host>     Gateway bind address (default: 127.0.0.1)
  --token <token>   Device token for gateway auth (auto-acquired if not set)
  --version, -v     Show version
  --help, -h        Show this help message

Examples:
  hawky gateway             # Start the gateway server (terminal 1)
  hawky                     # Start TUI (terminal 2, connects to gateway)
  hawky --auto              # Auto-start gateway in background + TUI
  hawky --connect ws://remote:4242  # Connect to remote gateway
  hawky --session project-x         # Use a specific session
  hawky node                       # Start node host (local gateway)
  hawky node --connect ws://cloud:4242 --name work-mac  # Remote gateway
  hawky doctor              # Check system health
  hawky logs                # Tail gateway log file
`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`hawky v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // First non-flag arg is the command.
  // Skip args that are values for flags (--model X, --resume X, --connect X).
  const flagsWithValues = new Set(["--model", "--connect", "--session", "--port", "--bind", "--token", "--name"]);
  let command = "chat";
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValues.has(args[i])) {
      i++; // Skip the value after the flag
      continue;
    }
    if (!args[i].startsWith("--")) {
      command = args[i];
      break;
    }
  }

  switch (command) {
    case "chat": {
      // Load config (for port and logging only — gateway manages everything else)
      resetConfig();
      const config = loadConfig();

      // Initialize structured logger (TUI mode = console suppressed)
      // NOTE: Don't enable console capture yet — error messages before TUI starts
      // need to go to stderr directly so the user can see them.
      const logDir = config.logging?.dir ?? join(getConfigDir(), "logs");
      const logSettings = resolveLoggerSettings(config.logging, logDir, /* tuiMode */ true);
      initLogger(logSettings);
      const log = createSubsystemLogger("app");

      // Determine gateway URL and device token
      const explicitConnect = getArg(args, "--connect");
      const gwPort = config.gateway_port ?? 4242;
      const connectUrl = explicitConnect ?? `ws://localhost:${gwPort}`;
      const sessionKey = getArg(args, "--session") ?? "tui:main";

      // Token resolution: --token > persisted file > config fallback
      let clientToken = getArg(args, "--token") ?? null;
      if (!clientToken) {
        const { loadDeviceToken } = await import("./gateway/device-auth.js");
        clientToken = loadDeviceToken(connectUrl);
      }
      if (!clientToken) {
        clientToken = config.gateway?.auth?.token ?? null;
      }

      // Auto-start gateway if --auto flag is passed and no explicit --connect
      const autoStart = args.includes("--auto");
      if (autoStart && !explicitConnect) {
        const { isGatewayRunning, spawnGatewayBackground } = await import("./gateway/probe.js");
        if (!(await isGatewayRunning(gwPort))) {
          // First-run: auth is provider-specific. Vertex users pre-authed
          // via `gcloud auth application-default login`; they just need
          // vertex.project_id in config.json (no API-key prompt).
          const provider = config.provider ?? "anthropic";
          const isVertex = provider === "vertex";
          const isOpenai = provider === "openai";
          const isOpenaiCompatible = provider === "openai_compatible";
          if (isVertex && !config.vertex?.project_id) {
            process.stderr.write(
              "Error: provider is 'vertex' but vertex.project_id is empty in ~/.hawky/config.json.\n" +
                "See deploy/VERTEX_SETUP.md for setup.\n",
            );
            process.exit(1);
          }
          if (isOpenai && !config.api_keys.openai) {
            if (!process.stdin.isTTY) {
              process.stderr.write("Error: OPENAI_API_KEY is required. Set it in environment or ~/.hawky/config.json\n");
              process.exit(1);
            }
            await promptForOpenAIKey();
            resetConfig();
          } else if (!isVertex && !isOpenai && !isOpenaiCompatible && !config.api_keys.anthropic) {
            if (!process.stdin.isTTY) {
              process.stderr.write("Error: ANTHROPIC_API_KEY is required. Set it in environment or ~/.hawky/config.json\n");
              process.exit(1);
            }
            await promptForLlmCredentials();
            resetConfig();
          }

          try {
            await spawnGatewayBackground(gwPort);
          } catch (err) {
            process.stderr.write(
              `\nFailed to start gateway: ${err instanceof Error ? err.message : String(err)}\n` +
              `  You can start it manually: hawky gateway\n\n`,
            );
          }
        }
      }

      log.info("hawky TUI starting", { version: VERSION, gateway: connectUrl, sessionKey });

      // Acquire device token via browser auth flow.
      // Extracted as a function so it can be reused on auth rejection (reauth).
      async function doAcquireToken(): Promise<string | null> {
        const { acquireDeviceToken, ManualAuthRequired } = await import("./gateway/gateway-client.js");
        const { saveDeviceToken } = await import("./gateway/device-auth.js");
        try {
          const token = await acquireDeviceToken({
            gatewayUrl: connectUrl,
            deviceLabel: "tui",
            onStatus: (msg) => process.stderr.write(`  ${msg}\n`),
          });
          saveDeviceToken(token, connectUrl);
          return token;
        } catch (err) {
          if (err instanceof ManualAuthRequired) {
            process.stderr.write(`  ${(err as any).manualUrl}\n\n`);
            const readline = await import("node:readline");
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
            const token = await new Promise<string>((resolve) => {
              rl.question("  Paste token: ", (answer) => { rl.close(); resolve(answer.trim()); });
            });
            saveDeviceToken(token, connectUrl);
            return token;
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn("device token acquisition failed", { error: msg });
            process.stderr.write(
              `\nWarning: Could not acquire device token: ${msg}\n` +
              `  You can get one manually: curl -s ${connectUrl.replace(/^ws(s?):\/\//, "http$1://")}/auth/device?mode=json\n\n`,
            );
            return null;
          }
        }
      }

      if (!clientToken) {
        clientToken = await doAcquireToken();
      }

      // Create gateway client
      const { GatewayClient } = await import("./gateway/gateway-client.js");

      // Heartbeat info state (updated by gateway events, read by TUI)
      let heartbeatInfo: import("./tui/components/heartbeat_indicator.js").HeartbeatInfo | null = null;
      // Listeners notified on every heartbeat event (for event-driven TUI updates)
      const heartbeatListeners: Array<() => void> = [];
      // Listeners notified on flush events (for TUI flush status display)
      const flushListeners: Array<(event: string, payload?: unknown) => void> = [];
      // Listeners notified on compaction events (for TUI compaction status display)
      const compactionListeners: Array<(event: string, payload?: unknown) => void> = [];
      // Permission-mode state (drives the TUI footer [BYPASS] indicator)
      let permissionModeInfo: import("./tui/index.js").PermissionModeInfo = { mode: null, forceBypass: false };
      const permissionModeListeners: Array<(info: import("./tui/index.js").PermissionModeInfo) => void> = [];
      const notifyPermissionModeChange = () => {
        for (const fn of permissionModeListeners) {
          try { fn(permissionModeInfo); } catch {}
        }
      };
      // The client is constructed below; this ref lets the
      // onConnectionChange hook re-fetch on reconnect without a
      // forward-reference TDZ error.
      const clientRef: { current: import("./gateway/gateway-client.js").GatewayClient | null } = { current: null };
      const refetchPermissionMode = () => {
        const c = clientRef.current;
        if (!c) return;
        c.rpc("permission.mode", { sessionKey }).then((result: any) => {
          if (!result || typeof result !== "object") return;
          permissionModeInfo = {
            mode: (result.mode as "default" | "accept-edits" | "bypass" | undefined) ?? null,
            forceBypass: !!result.forceBypass,
          };
          notifyPermissionModeChange();
        }).catch(() => {
          // RPC unavailable — leave the previous state in place.
        });
      };

      const client = new GatewayClient({
        url: connectUrl,
        sessionKey,
        workingDirectory: process.cwd(),
        platform: "tui",
        token: clientToken ?? undefined,
        onAuthFailed: async () => {
          log.info("device token rejected, re-authenticating");
          const { clearDeviceToken } = await import("./gateway/device-auth.js");
          clearDeviceToken(connectUrl);
          const newToken = await doAcquireToken();
          if (newToken) clientToken = newToken;
          return newToken;
        },
        onConnectionChange: (status) => {
          log.info("connection status", { status });
          // After reconnect, re-fetch the permission mode — broadcasts
          // are not replayed, so during an outage another client (or
          // a gateway restart with a different --dangerously-skip-
          // permissions setting) may have changed the mode and the
          // TUI's [BYPASS] indicator would otherwise stay stale.
          if (status === "connected") refetchPermissionMode();
        },
        onHeartbeatEvent: (event, payload) => {
          // Heartbeat events
          if (event === "heartbeat.started" || event === "heartbeat.completed") {
            const p = payload as any;
            if (event === "heartbeat.started") {
              heartbeatInfo = {
                ...(heartbeatInfo ?? { lastStatus: null, lastRunAt: null, nextRunAt: null, alertCount: 0 }),
                running: true,
              };
            } else {
              heartbeatInfo = {
                enabled: true,
                lastStatus: p?.status ?? null,
                lastReason: p?.reason,
                lastRunAt: p?.timestamp ?? Date.now(),
                nextRunAt: p?.nextRunAt ?? null,
                alertCount: p?.alertCount ?? 0,
                running: false,
                activeHoursStart: p?.activeHoursStart,
              };
            }
            for (const fn of heartbeatListeners) {
              try { fn(); } catch {}
            }
          }
          // Flush events
          if (event === "flush.started" || event === "flush.completed" || event === "flush.skipped") {
            for (const fn of flushListeners) {
              try { fn(event, payload); } catch {}
            }
          }
          // Compaction events
          if (event === "compaction.started" || event === "compaction.completed") {
            for (const fn of compactionListeners) {
              try { fn(event, payload); } catch {}
            }
          }
          // Permission mode change → update the [BYPASS] indicator
          if (event === "permission.mode.changed") {
            const p = payload as { mode?: string; forceBypass?: boolean };
            permissionModeInfo = {
              mode: (p?.mode as "default" | "accept-edits" | "bypass" | undefined) ?? null,
              forceBypass: !!p?.forceBypass,
            };
            notifyPermissionModeChange();
          }
        },
      });

      // Connect to gateway — don't exit on failure, let TUI show "Disconnected"
      // and auto-reconnect in the background.
      try {
        await client.connect();
      } catch {
        // Initial connection failed — the gateway-client's scheduleReconnect
        // will keep retrying in the background. TUI starts in disconnected state.
        log.warn("initial gateway connection failed, will retry in background", {
          url: connectUrl,
        });
        process.stderr.write(
          `\nWarning: Cannot connect to gateway at ${connectUrl}\n` +
          `  The TUI will auto-reconnect when the gateway starts.\n` +
          `  Start the gateway with: bun run gateway\n\n`,
        );
      }

      // Bind the client ref so the onConnectionChange hook can
      // re-fetch permission mode after reconnects.
      clientRef.current = client;

      // Console capture enabled after connection attempt (before TUI render)
      enableConsoleCapture();

      // Fetch initial heartbeat status from gateway (non-blocking)
      client.rpc("heartbeat.status").then((status: any) => {
        if (status && typeof status === "object") {
          heartbeatInfo = {
            enabled: status.enabled ?? false,
            lastStatus: status.lastStatus ?? null,
            lastReason: status.lastReason,
            lastRunAt: status.lastRunAt ?? null,
            nextRunAt: status.nextRunAt ?? null,
            alertCount: status.alertCount ?? 0,
            running: status.running ?? false,
            activeHoursStart: status.activeHoursStart,
          };
          for (const fn of heartbeatListeners) {
            try { fn(); } catch {}
          }
        }
      }).catch(() => {
        // Gateway might not support heartbeat.status yet — ignore
      });

      // Initial permission mode fetch — populates the [BYPASS]
      // indicator on first paint without waiting for a broadcast.
      // Subsequent reconnects re-fetch via the same helper from
      // onConnectionChange.
      refetchPermissionMode();

      startTui({
        model: config.model ?? DEFAULT_MODEL,
        agentSource: client,
        sessionKey,
        getHeartbeatInfo: () => heartbeatInfo,
        onHeartbeatChange: (fn) => {
          heartbeatListeners.push(fn);
          return () => {
            const idx = heartbeatListeners.indexOf(fn);
            if (idx >= 0) heartbeatListeners.splice(idx, 1);
          };
        },
        onFlushEvent: (fn) => {
          flushListeners.push(fn);
          return () => {
            const idx = flushListeners.indexOf(fn);
            if (idx >= 0) flushListeners.splice(idx, 1);
          };
        },
        onCompactionEvent: (fn) => {
          compactionListeners.push(fn);
          return () => {
            const idx = compactionListeners.indexOf(fn);
            if (idx >= 0) compactionListeners.splice(idx, 1);
          };
        },
        getPermissionMode: () => permissionModeInfo,
        onPermissionModeChange: (fn) => {
          permissionModeListeners.push(fn);
          return () => {
            const idx = permissionModeListeners.indexOf(fn);
            if (idx >= 0) permissionModeListeners.splice(idx, 1);
          };
        },
      });
      break;
    }

    case "gateway": {
      // Ambient intentions (reminders / timed + latent triggers) default ON.
      // Every downstream check is `process.env.AMBIENT_INTENTIONS === "1"`, so
      // defaulting the env var here flips them all without touching each call
      // site. Set AMBIENT_INTENTIONS=0 explicitly to opt out.
      if (process.env.AMBIENT_INTENTIONS === undefined) {
        process.env.AMBIENT_INTENTIONS = "1";
      }
      // Where-triggers (location reminders) default ON now that the iOS CoreLocation
      // wiring is complete (#481: significant-location reprojection landed). Gated the
      // same way as AMBIENT_INTENTIONS — every downstream check is `=== "1"`, so
      // defaulting here flips them all. Set AMBIENT_WHERE=0 explicitly to opt out.
      if (process.env.AMBIENT_WHERE === undefined) {
        process.env.AMBIENT_WHERE = "1";
      }

      // Load config (let, not const, so we can reload after first-run setup)
      resetConfig();
      let gwConfig = loadConfig();
      const gwModel = getArg(args, "--model") ?? gwConfig.model ?? DEFAULT_MODEL;
      gwConfig.model = gwModel;

      // Initialize logger (gateway mode = console transport enabled)
      const gwLogDir = gwConfig.logging?.dir ?? join(getConfigDir(), "logs");
      const gwLogSettings = resolveLoggerSettings(gwConfig.logging, gwLogDir, /* tuiMode */ false);
      initLogger(gwLogSettings);
      const gwLog = createSubsystemLogger("app");
      gwLog.info("hawky gateway starting", { version: VERSION, model: gwModel });

      // Initialize workspace
      if (gwConfig.workspace_dir) {
        setWorkspaceDir(gwConfig.workspace_dir);
      }
      const gwWorkspace = new WorkspaceManager();
      gwWorkspace.init();

      // Require auth for the selected provider — the Vertex path uses ADC
      // (configured via `gcloud auth application-default login`) and has its
      // own project_id field, so skip the Anthropic key prompt in that case.
      // OpenAI uses its own key from env or api_keys.openai.
      const gwActiveProvider = gwConfig.provider ?? "anthropic";
      if (gwActiveProvider === "vertex") {
        if (!gwConfig.vertex?.project_id) {
          console.error(
            "Error: provider is 'vertex' but vertex.project_id is empty in ~/.hawky/config.json.\n" +
              "See deploy/VERTEX_SETUP.md for full GCP setup (create project, enable Vertex AI API + Model Garden, run `gcloud auth application-default login`).",
          );
          process.exit(1);
        }
      } else if (gwActiveProvider === "openai" && !gwConfig.api_keys.openai) {
        if (!process.stdin.isTTY) {
          console.error("Error: OPENAI_API_KEY is required. Set it in environment or ~/.hawky/config.json");
          process.exit(1);
        }
        await promptForOpenAIKey();
        resetConfig();
        gwConfig = loadConfig();
        gwConfig.model = gwModel;
      } else if (gwActiveProvider !== "openai" && gwActiveProvider !== "openai_compatible" && !gwConfig.api_keys.anthropic) {
        if (!process.stdin.isTTY) {
          console.error("Error: ANTHROPIC_API_KEY is required. Set it in environment or ~/.hawky/config.json");
          process.exit(1);
        }
        await promptForLlmCredentials();
        resetConfig();
        // Reload — promptForLlmCredentials may have switched providers entirely,
        // and createProvider below needs the post-setup config.
        gwConfig = loadConfig();
        gwConfig.model = gwModel;
      }

      // Initialize memory + skills
      getGlobalMemoryIndex(
        gwWorkspace.getWorkspacePath(),
        gwConfig.api_keys.openai || undefined,
        undefined, // dbPath — use default
        getSessionsDir(),
      );
      startSkillsWatcher(gwWorkspace.getWorkspacePath());

      // Create provider (routes to Anthropic or Vertex based on config.provider)
      const gwProvider = createProvider(gwConfig);

      // Create gateway server
      // Gateway imports are at top of file (static imports)

      // Configure command lanes from config (or defaults).
      // Cron lane: if concurrency.cron_max is explicitly set, use it.
      // Otherwise derive from max_concurrent_runs + 1 (preserving the old
      // invariant that the lane can always fit scheduled jobs + one force-run).
      const concurrency = gwConfig.concurrency;
      const cronMaxRuns = gwConfig.cron?.max_concurrent_runs ?? 1;
      const cronLaneMax = concurrency?.cron_max ?? (cronMaxRuns + 1);

      // Validate concurrency values — reject non-finite or non-positive values
      // to prevent silent lane deadlocks from bad config.
      const safePositiveInt = (v: unknown, fallback: number): number => {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return fallback;
        return Math.floor(v);
      };

      applyDefaultLaneConcurrency({
        main: safePositiveInt(concurrency?.main_max, 4),
        cron: safePositiveInt(cronLaneMax, 2),
        subagent: safePositiveInt(concurrency?.subagent_max, 8),
      });

      // Initialize device authentication (signing key stored in state dir)
      const { DeviceAuth } = await import("./gateway/device-auth.js");
      const deviceAuth = DeviceAuth.init();

      // Create server first (sessions need server ref for WS permission resolver)
      const gateway = new GatewayServer(deviceAuth);

      // Wire the task-store broadcaster so task.update events flow to
      // every client subscribed to a session. Registered at the
      // registry level (not per AgentLoop) so we only subscribe when
      // a session actually creates a task — task-less sessions stay
      // absent from the registry and don't allocate empty stores.
      const { setTaskBroadcaster } = await import("./tools/task_global.js");
      setTaskBroadcaster((sk, evt, payload) => gateway.broadcastToSession(sk, evt, payload));

      // Check for --dangerously-skip-permissions flag
      const dangerouslySkipPermissions = args.includes("--dangerously-skip-permissions");
      if (dangerouslySkipPermissions) {
        gwLog.warn("⚠ --dangerously-skip-permissions: ALL tools will auto-approve without prompting");
      }

      // Create agent session manager (with server ref for WS permissions)
      const agentSessions = new AgentSessionManager({
        provider: gwProvider,
        config: gwConfig,
        workingDirectory: process.cwd(),
        server: gateway,
        dangerouslySkipPermissions,
      });

      gateway.setActiveSessionCounter(() => agentSessions.size);

      // Initialize error log directory
      const { setErrorLogDir } = await import("./logging/error-buffer.js");
      setErrorLogDir(join(gwLogDir, "errors"));

      // Initialize cost tracker. The tracker now owns its own periodic
      // flush timer (default 5 min, configurable via constructor option),
      // so we don't keep a separate setInterval here. Crash-resilience is
      // enforced inside CostTracker.constructor — see PERIODIC_FLUSH_INTERVAL_MS.
      const { CostTracker, setCostTracker, formatTokenCount, formatCost } = await import("./agent/cost-tracker.js");
      const costTracker = new CostTracker();
      setCostTracker(costTracker);

      // Initialize push notification service (disabled if vapid_email not configured)
      const pushService = createPushService(gwConfig.notifications?.vapid_email);
      setPushService(pushService);
      gateway.setPushService(pushService);

      // Start MCP servers (before agent methods so tools are available for sessions)
      const { getMcpServerManager } = await import("./mcp/server-manager.js");
      const mcpManager = getMcpServerManager();
      if (gwConfig.mcp_servers && Object.keys(gwConfig.mcp_servers).length > 0) {
        await mcpManager.startAll(gwConfig.mcp_servers as any);
        gwLog.info("MCP servers ready", {
          connected: mcpManager.connectedCount,
          tools: mcpManager.totalToolCount,
        });
      }

      // Wire session key lookup for web auto-subscribe
      gateway.setGetSessionKeys(() => agentSessions.keys());

      // Initialize channel adapters (Slack, etc.)
      const { ChannelRegistry } = await import("./gateway/channel.js");
      const { SessionBindingService } = await import("./gateway/session-binding.js");
      const { setAgentTurnChannelRelay } = await import("./gateway/agent-turn.js");
      const channelRegistry = new ChannelRegistry();
      const sessionBindings = new SessionBindingService();
      /** Shutdown hooks for channel machinery (debouncers, etc.). Flushed before adapters stop. */
      const channelShutdownHooks: Array<() => Promise<void>> = [];

      const slackConfig = gwConfig.channels?.slack;
      if (slackConfig?.bot_token && slackConfig?.app_token && slackConfig?.enabled !== false) {
        // Fail closed: refuse to initialize Slack inbound without an allowed user.
        // Without default_dm_user, anyone in the workspace who can DM the bot
        // could drive the agent (tool execution, session history access).
        if (!slackConfig.default_dm_user || !/^U[A-Z0-9]+$/.test(slackConfig.default_dm_user)) {
          gwLog.warn(
            "slack adapter disabled: channels.slack.default_dm_user is required " +
              "(must be your Slack user ID, e.g. U0123456). Without it, any workspace " +
              "member could drive the agent. See deploy/SLACK_SETUP.md Step 4.",
          );
        } else try {
          const { SlackAdapter } = await import("./gateway/adapters/slack.js");
          const { createInboundDebouncer } = await import("./gateway/inbound-debounce.js");
          const { triggerAgentTurn } = await import("./gateway/agent-turn.js");
          const { CommandLane } = await import("./gateway/types.js");
          const slackAdapter = new SlackAdapter({
            botToken: slackConfig.bot_token,
            appToken: slackConfig.app_token,
            userToken: slackConfig.user_token,
            allowedUserId: slackConfig.default_dm_user,
            botPostFooter: slackConfig.bot_post_footer,
          });
          channelRegistry.register(slackAdapter);

          // Bind Slack bot DMs → configured session (default: web:general)
          const bindTarget = slackConfig.bind_to_session ?? "web:general";
          sessionBindings.bind("slack", "*", bindTarget);

          // Inbound debouncer: coalesce rapid Slack messages into one agent turn
          const debouncer = createInboundDebouncer({
            debounceMs: 2000,
            buildKey: (msg: any) => `${msg.senderId}:${msg.conversationId}`,
            onFlush: async (msgs: any[]) => {
              const first = msgs[0];
              const sessionKey = sessionBindings.resolve("slack", first.conversationId) ?? bindTarget;
              const combinedText = msgs.map((m: any) => m.text).join("\n");

              const result = await triggerAgentTurn({
                sessionKey,
                message: combinedText,
                lane: CommandLane.Main,
                origin: `slack:${first.senderId}`,
                headless: false,
              }, { sessions: agentSessions, server: gateway });

              // Relay response back to Slack
              if (result.status === "completed" && result.fullSummary) {
                void slackAdapter.sendText({
                  to: first.conversationId,
                  text: result.fullSummary,
                  threadId: first.threadId,
                }).catch((err: any) => {
                  gwLog.warn("slack reply relay failed", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              }
            },
            onError: (err: any) => {
              gwLog.warn("slack inbound debounce error", {
                error: err instanceof Error ? err.message : String(err),
              });
            },
          });

          // Wire inbound messages through debouncer.
          // resolveAndBind promotes wildcard matches to exact bindings so
          // outbound relay (via listBySession) can target the real conversation.
          slackAdapter.onMessage((msg) => {
            sessionBindings.resolveAndBind("slack", msg.conversationId);
            debouncer.push(msg);
          });

          // Register debouncer stop() so shutdown flushes any buffered messages
          // before the adapter stops. Without this, the 2s debounce window can
          // silently drop inbound messages on restart.
          channelShutdownHooks.push(() => debouncer.stop());

          await slackAdapter.start();
          gwLog.info("slack adapter started", {
            bindTo: bindTarget,
            hasUserToken: slackAdapter.hasUserToken(),
          });

          // Warm + periodically refresh the persisted directory/graph (#535) so
          // recipient resolution and member lookups read a fresh local cache
          // instead of fanning out to the Slack API on every send.
          void slackAdapter.refreshDirectory();
          const dirRefreshMin = slackConfig.directory_refresh_minutes ?? 60;
          if (dirRefreshMin > 0) {
            const dirTimer = setInterval(
              () => { void slackAdapter.refreshDirectory(); },
              dirRefreshMin * 60_000,
            );
            channelShutdownHooks.push(async () => { clearInterval(dirTimer); });
          }

          // Register slack.status RPC
          gateway.registerMethod("slack.status", () => slackAdapter.getStatus());
        } catch (err) {
          const { classifySlackInitError } = await import("./gateway/adapters/slack-errors.js");
          const rawMessage = err instanceof Error ? err.message : String(err);
          const decision = classifySlackInitError(rawMessage);
          if (decision.level === "error") {
            gwLog.error(decision.message, decision.data);
          } else {
            gwLog.warn(decision.message, decision.data);
          }
        }
      }

      // Wire channel relay to delivery system and agent methods
      setChannelRegistry(channelRegistry);
      setAgentTurnChannelRelay(channelRegistry, sessionBindings);

      // Let the send_message tool reach external channels (Slack, ...).
      setSendMessageDeps(channelRegistry);
      // Let the send_photo tool upload camera frames to Slack (files.uploadV2).
      setSendPhotoDeps(channelRegistry);
      // Let the slack_list_members tool read the Slack directory/graph (#535).
      setSlackListMembersDeps(channelRegistry);

      // M7 — ambient timed-intention loop (flag-gated via AMBIENT_INTENTIONS;
      // in-memory, additive — does not affect the existing agent+cron path).
      // M8 — where-trigger feature flag. Wire whereDeps only when AMBIENT_WHERE=1 (iOS
      // CoreLocation wiring: geocode + AmbientLocationManager.updateRegions +
      // reportRegionArmed/reportRegionEntered/reportLocationAuth callbacks) is the
      // remaining device work that must land before flipping this flag.
      const whereLog = createSubsystemLogger("ambient/where");
      const whereDeps = process.env.AMBIENT_WHERE === "1"
        ? {
            emitRegions: (sessionKey: string, regions: import("./ambient/arm-where.js").RegionDescriptor[]) => {
              const delivered = gateway.broadcastToSession(sessionKey, "agent.regions.update", { type: "regions.update", regions });
              // #481 observability: how many live device connections received the
              // region set. 0 = no subscriber → the device never sees it (the bug
              // where the iOS bridge stream isn't connected at emit time).
              whereLog.info("emitRegions", {
                sessionKey,
                regionCount: regions.length,
                intentionIds: regions.map((r) => r.intentionId),
                deliveredToConnections: delivered,
              });
            },
          }
        : undefined;
      // #483: use durable SQLite store so intentions/suppression survive restart.
      const durableStore = process.env.AMBIENT_INTENTIONS === "1"
        ? new FileIntentionStore(join(getConfigDir(), "intentions.db"))
        : undefined;
      // #482 — when-trigger notification deps: broadcast arm/disarm events so the
      // device can schedule/cancel a local UNCalendarNotification fallback.
      // Gated under AMBIENT_INTENTIONS=1 (same as the intention loop itself).
      const whenDeps = {
        emitWhenArmed(sessionKey: string, descriptor: import("./ambient/arm-when.js").WhenNotificationDescriptor) {
          gateway.broadcastToSession(sessionKey, "agent.when.armed", { type: "when.armed", ...descriptor });
        },
        emitWhenDisarmed(sessionKey: string, intentionId: string) {
          gateway.broadcastToSession(sessionKey, "agent.when.disarmed", { type: "when.disarmed", intentionId });
        },
      };
      const intentionLoop = process.env.AMBIENT_INTENTIONS === "1"
        ? new IntentionService({
            store: durableStore,
            broadcast: (k: string, e: string, pl: unknown) => gateway.broadcastToSession(k, e, pl),
            hasSession: (k: string) => [...gateway.getConnections().values()].some((c) => c.sessionKey === k),
            log: (m: string, meta?: Record<string, unknown>) => gwLog.warn(m, meta),
            whereDeps,
            whenDeps,
          })
        : undefined;
      intentionLoop?.start();

      // #483: rehydrate when-timers for armed intentions that survived the restart.
      if (intentionLoop && durableStore) {
        const toReschedule = await durableStore.getArmedWhenIntentions();
        if (toReschedule.length > 0) {
          const whenAdapter = intentionLoop.getAdapter("when");
          if (whenAdapter instanceof WhenAdapter) {
            for (const intention of toReschedule) {
              // prepare()+activate() re-schedules the timer without touching store state.
              const result = await whenAdapter.prepare(intention);
              if (result.ok) whenAdapter.activate(intention);
            }
          }
          gwLog.info(`ambient: rehydrated ${toReschedule.length} when-timer(s) after restart`);
        }
      }

      // M8 — latent recognition service (flag-gated; shares the same IntentionStore as
      // IntentionService so minted latents are visible to the tick loop).
      //
      // Production recognizer: ModelLatentRecognizer backed by claude-sonnet-4-6
      // (#454: Sonnet validated at 100% precision / 100% recall on held-out set;
      // Haiku reached only 82% precision — below bar). Model id is configurable via
      // LATENT_RECOGNIZER_MODEL env (default "claude-sonnet-4-6"). Model failures
      // retry once for transient errors, then fail soft to no latent results.
      const { LatentService } = await import("./ambient/latent-service.js");
      const { LatentHeartbeatService } = await import("./ambient/latent-heartbeat.js");
      let latentService: InstanceType<typeof LatentService> | undefined;
      if (process.env.AMBIENT_INTENTIONS === "1" && intentionLoop) {
        // Build the Anthropic client reusing the same api key + base URL as the
        // agent loop (gwConfig.api_keys.anthropic / gwConfig.api_base_url).
        const latentModelId = process.env.LATENT_RECOGNIZER_MODEL ?? "claude-sonnet-4-6";
        const anthropicApiKey = gwConfig.api_keys?.anthropic ?? "";
        // ambient.latent_model_processing: when false, skip model calls entirely.
        // No transcript data is sent to the model, and latent recognition/surfacing
        // becomes a no-op rather than falling back to local keyword matching.
        const anthropicClient = (anthropicApiKey && isLatentModelEnabled(gwConfig.ambient))
          ? new Anthropic({
              apiKey: anthropicApiKey,
              baseURL: gwConfig.api_base_url ?? "https://api.anthropic.com",
            })
          : null;

        // modelInvokeFn: single non-streaming call; the prompt is the full
        // system+user message (ModelLatentRecognizer passes everything in one string).
        const modelInvokeFn = anthropicClient
          ? async (prompt: string): Promise<string> => {
              const msg = await anthropicClient.messages.create({
                model: latentModelId,
                max_tokens: 512,
                messages: [{ role: "user", content: prompt }],
              });
              const block = msg.content[0];
              return block.type === "text" ? block.text : "";
            }
          : null;

        // LLM-only recognizer with one transient retry; fail-soft to [] (and a
        // no-op when no model is configured). See makeRetryingRecognizer (#520).
        const recognizer = makeRetryingRecognizer(modelInvokeFn ?? undefined);

        const { makeRelevanceGate } = await import("./ambient/relevance-gate.js");
        latentService = new LatentService({
          store: intentionLoop.store,
          recognizer,
          // Surfacing-poll wiring: without these, _surfacingPass is inert (armed
          // latents would never reach the session). Mirrors the IntentionService wiring.
          broadcast: (k: string, e: string, pl: unknown) => gateway.broadcastToSession(k, e, pl),
          hasSession: (k: string) => [...gateway.getConnections().values()].some((c) => c.sessionKey === k),
          liveSessions: () => {
            // De-dupe live connections by sessionKey; a session counts as non-quiet
            // if ANY of its connections is ambient/directive.
            const byKey = new Map<string, "quiet" | "ambient" | "directive">();
            for (const c of gateway.getConnections().values()) {
              if (!c.sessionKey) continue;
              const prev = byKey.get(c.sessionKey);
              if (prev === undefined || (prev === "quiet" && c.mode !== "quiet")) byKey.set(c.sessionKey, c.mode);
            }
            return [...byKey].map(([sessionKey, mode]) => ({ sessionKey, mode }));
          },
          // M11: LLM relevance gate (reuses the recognizer's Sonnet invoke); fail-soft to no results.
          relevanceGate: makeRelevanceGate(modelInvokeFn ?? undefined),
          // Fix 8: disarm where-regions on terminal latent transitions (resolved/suppressed).
          disarmWhereFn: intentionLoop
            ? async (i) => {
                const wa = intentionLoop.getAdapter("where");
                if (wa) await wa.disarm(i);
              }
            : undefined,
        });

        // Single LatentHeartbeat loop: drives recognition on a fixed interval.
        // LATENT_HEARTBEAT_MS env var configures the interval (default 60000ms;
        // 30000ms is a supported value for tighter distillation cadence).
        const latentHeartbeat = new LatentHeartbeatService({
          latentService,
          intervalMs: parseInt(process.env.LATENT_HEARTBEAT_MS ?? "") || 60_000,
          enabled: true,
        });
        latentHeartbeat.start();
        // Stop the heartbeat cleanly on channel shutdown.
        channelShutdownHooks.push(async () => { latentHeartbeat.stop(); });
      }
      // #483: close the durable store on shutdown (flush WAL, release file lock).
      if (durableStore) {
        channelShutdownHooks.push(async () => { durableStore.close(); });
      }

      // Register agent methods (chat.send, chat.cancel, session.*, permission.*, push.*)
      registerAgentMethods(gateway, agentSessions, gwConfig, pushService, intentionLoop, latentService);

      // Wire channel relay to agent-methods (for full sync: web/TUI → Slack)
      const { setChannelRelay } = await import("./gateway/agent-methods.js");
      setChannelRelay(channelRegistry, sessionBindings);

      // Wire node registry ref for the nodes tool and bash tool node routing
      setNodeRegistryRef(gateway.nodeRegistry);
      setBashNodeRegistry(gateway.nodeRegistry);

      // Start server (CLI --port and --bind override config)
      const gwPort = parseInt(getArg(args, "--port") ?? "") || (gwConfig.gateway_port ?? 4242);
      const bindHost = getArg(args, "--bind") ?? "127.0.0.1";

      // Bind enforcement: refuse to bind to non-loopback without device auth
      const isLoopback = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
      if (!isLoopback && !deviceAuth) {
        console.error(
          `\nError: refusing to bind gateway to ${bindHost}:${gwPort} without authentication.\n` +
          `  Device auth should be initialized automatically. Check ~/.hawky/state/ permissions.\n` +
          `  Or bind to localhost (default) and use a tunnel for remote access.\n`,
        );
        process.exit(1);
      }

      gateway.start(gwPort, bindHost);

      // Create heartbeat service
      const heartbeat = new HeartbeatService({
        sessions: agentSessions,
        server: gateway,
        config: gwConfig,
        memorySchedulerOwnsMemory: true,
      });

      // Register heartbeat RPC methods (heartbeat.status, heartbeat.trigger)
      registerHeartbeatMethods(gateway, heartbeat);

      // Let chat.rewind reset the heartbeat distillation byte-offset for a
      // rewound session file (without this, distillation would skip content
      // after the rewind because the old offset pointed into a now-truncated
      // file).
      const { setHeartbeatForRewind } = await import("./gateway/agent-methods.js");
      setHeartbeatForRewind(heartbeat);

      // Wire heartbeat into agentSessions for live-swap config push.
      agentSessions.setHeartbeat(heartbeat);
      // Wire agentSessions into lanes so executeInSession can check the swap guard.
      setAgentSessionsRef(agentSessions);

      // Register config RPC methods (config.get, config.update)
      registerConfigMethods(gateway, heartbeat, agentSessions);

      // Register prompt CRUD RPC methods (prompts.list/get/set/delete)
      registerPromptMethods(gateway);

      // Register provider.listModels (returns OpenAI catalog from probe or fallback).
      const {
        getCachedCatalog: getOpenaiCatalog,
        KNOWN_OPENAI_MODELS,
        probeCatalogAsync,
        resolveOpenAIModelCatalogProbe,
      } = await import("./agent/openai-models.js");
      gateway.registerMethod("provider.listModels", () => {
        const probed = getOpenaiCatalog();
        if (probed) {
          return {
            models: probed.map((m) => m.id),
            source: "probe" as const,
          };
        }
        return {
          models: [...KNOWN_OPENAI_MODELS],
          source: "fallback" as const,
        };
      });
      const catalogProbe = resolveOpenAIModelCatalogProbe(gwConfig);
      if (catalogProbe) {
        probeCatalogAsync(catalogProbe.apiKey, { baseURL: catalogProbe.baseURL });
      }

      // Register media RPC methods (media.chunk.upload — M0 Slice 0)
      registerMediaMethods(gateway);
      registerVisionMethods(gateway);

      // people.list/person.* — person service over the face-match backend (#681).
      // Degrades gracefully when the face backend is not running so the demo renders
      // an empty/local state instead of erroring.
      registerPeopleMethods(gateway);
      registerPersonMethods(gateway);

      // Register deterministic frontend boot context RPC. This returns a
      // compact startup memory packet for low-latency frontend agents without
      // invoking the backend agent loop.
      registerFrontendBootContextMethods(gateway);

      // Register tool.invoke RPC (extension-declared direct-invocation surface).
      // Lets iOS / WS clients execute these tools without an agent loop.
      registerToolMethods(gateway);

      // Memory feature (#653): memory.snapshot + memory.distill. Closure over
      // gwConfig so distillation uses the live provider/key (re-set after /setup).
      registerMemoryMethods(gateway, () => gwConfig);

      // Voiceprint identity annotations are applied as a session-scoped bundle.
      // Live scoring stays disabled unless explicitly configured server-side.
      // A4 lifecycle: durable, file-backed consent ledger + audit log under the
      // config root, with the retention window from config. NON-ENFORCING by
      // default (records + audits but does not gate enroll/score), so this is
      // additive and inert for existing call sites.
      registerVoiceprintMethods(
        gateway,
        undefined,
        undefined,
        resolveVoiceprintLiveScoringConfigFromConfig(gwConfig),
        undefined,
        undefined,
        resolveVoiceprintLifecycleFromConfig(gwConfig),
        resolveVoiceprintMemoryBridgeConfigFromConfig(gwConfig),
      );

      // Memory feature (#653): consolidate daily → global every 6h, but only if
      // a daily log changed since the last run. Replaces the (now-disabled)
      // heartbeat consolidation. Session→daily distillation is triggered by iOS
      // on session end, not here.
      const memoryScheduler = new MemoryScheduler({ getConfig: () => gwConfig });
      memoryScheduler.start();

      // Slice 1 live-chunk firehose logger. Stub consumer: logs every
      // `media.live.chunk` event. Real consumers (streaming providers,
      // retention GC) attach in later slices.
      try {
        const { registerLiveChunkLogger } = await import(
          "./consumers/live-chunk-logger/index.js"
        );
        registerLiveChunkLogger();
      } catch (err) {
        gwLog.warn("live-chunk-logger wiring failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Wire the ASR consumer onto the bus: media.finalized → asr.partial / asr.final.
      // chat-poster subscribes to `asr.final` and posts the transcript into
      // the per-node voice:* session. Failures here must not take down the gateway.
      try {
        const { createBackend } = await import("./consumers/asr/backends/index.js");
        const { registerAsrPipeline } = await import("./consumers/asr/pipeline.js");
        const { resolveAsrConfig, resolveChatPosterConfig } = await import("./consumers/asr/config.js");
        const { registerChatPoster } = await import("./consumers/chat-poster/index.js");
        const asrCfg = resolveAsrConfig(gwConfig);
        if (asrCfg.enabled && asrCfg.backend !== "disabled") {
          const backend = createBackend({
            backend: asrCfg.backend,
            whisper_api: asrCfg.whisper_api,
            assemblyai: asrCfg.assemblyai,
          });
          if (backend) {
            // Intentionally discard the returned unsubscribe handle:
            // the gateway does not currently support runtime
            // re-registration of ASR consumers on config change. A future
            // hot-reload path would need to capture this and call it
            // before re-registering.
            registerAsrPipeline({ backend, config: asrCfg });
          } else {
            console.log(
              `[gateway] asr backend "${asrCfg.backend}" not constructible (likely missing API key) — no pipeline registered`,
            );
          }
        } else {
          console.log(
            `[gateway] asr disabled per config (enabled=${asrCfg.enabled}, backend="${asrCfg.backend}") — no pipeline registered`,
          );
        }
        // chat-poster wires independently of the ASR backend selection so
        // tests / alt-pipelines can publish `asr.final` directly.
        const chatPosterCfg = resolveChatPosterConfig(gwConfig);
        registerChatPoster({
          sessions: agentSessions,
          server: gateway,
          config: chatPosterCfg,
        });

        // Slice 3 (priority-stream-ingest): live multimodal consumer. Gated
        // on live_consumer.provider; returns a no-op when disabled or when
        // GEMINI_API_KEY is missing (logs a warning, does not crash).
        try {
          const { registerGeminiLiveConsumer } = await import(
            "./consumers/gemini-live-channel/index.js"
          );
          const { resolveGeminiLiveConsumerConfig } = await import(
            "./consumers/gemini-live-channel/config.js"
          );
          const liveCfg = resolveGeminiLiveConsumerConfig(gwConfig);
          if (liveCfg.provider === "gemini-live") {
            registerGeminiLiveConsumer({
              sessions: agentSessions,
              server: gateway,
              config: liveCfg,
            });
          }
        } catch (err) {
          console.error(
            `Warning: gemini-live consumer wiring failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } catch (err) {
        console.error(
          `Warning: ASR consumer wiring failed — voice transcription disabled: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Start heartbeat timer (if enabled)
      heartbeat.start();

      // Create and start cron service
      const cronService = new CronService({
        sessions: agentSessions,
        server: gateway,
        config: gwConfig,
      });
      registerCronMethods(gateway, cronService);
      setCronServiceRef(cronService);
      // Give session.list access to cron store for sidebar filtering
      const { setCronStoreForSessionList } = await import("./gateway/agent-methods.js");
      setCronStoreForSessionList(cronService.store);
      cronService.start();

      // Register gateway RPCs (needs all subsystems wired)
      const { getGatewayStatus, setGatewayStartTime, loadUsageHistory } = await import("./gateway/status.js");
      setGatewayStartTime(Date.now());
      gateway.registerMethod("gateway.status", () => {
        return getGatewayStatus({
          server: gateway,
          heartbeat,
          cronService,
          sessions: agentSessions,
          nodeRegistry: gateway.nodeRegistry,
        });
      });
      // Node list is visible to all authenticated clients (single-user system).
      // For multi-user, scope this to the owning session/user.
      gateway.registerMethod("node.list", () => {
        return {
          nodes: gateway.nodeRegistry.listConnected().map((n) => ({
            nodeId: n.nodeId,
            name: n.name,
            platform: n.platform,
            commands: n.commands,
            connectedAt: n.connectedAt,
          })),
        };
      });
      gateway.registerMethod("node.invoke", async (conn, params: any) => {
        if (conn.clientRole !== "client") {
          throw new MethodError("FORBIDDEN", "node.invoke is only available to client connections");
        }

        const { nodeId, method, args, timeoutMs } = params ?? {};
        if (typeof nodeId !== "string" || typeof method !== "string") {
          throw new MethodError(
            "INVALID_REQUEST",
            "node.invoke requires { nodeId: string, method: string, args?: unknown, timeoutMs?: number }",
          );
        }

        return await gateway.nodeRegistry.invoke(nodeId, method, args, timeoutMs ?? 30000);
      });
      gateway.registerMethod("gateway.usageHistory", (_conn: any, params: any) => {
        const range = (params as any)?.range ?? "7d";
        if (range !== "7d" && range !== "30d" && range !== "all") {
          throw new Error("range must be '7d', '30d', or 'all'");
        }
        return loadUsageHistory(range);
      });

      // Print startup config summary
      printGatewayBanner({
        version: VERSION,
        port: gwPort,
        bindHost,
        model: gwModel,
        config: gwConfig,
        configPath: getConfigPath(),
        logDir: gwLogDir,
        cronJobCount: cronService.listJobs().length,
      });

      // Graceful shutdown on SIGINT/SIGTERM
      installShutdownHandlers({
        gateway,
        heartbeat,
        cronService,
        getActiveSessionKeys: () => agentSessions.keys(),
        onBeforeShutdown: async () => {
          // Stop the memory consolidation timer (#653).
          memoryScheduler.stop();
          // Flush channel shutdown hooks BEFORE stopping adapters — drains any
          // buffered inbound messages (debouncers) so they get processed rather
          // than silently dropped. Adapter.stop() after this closes the socket.
          for (const hook of channelShutdownHooks) {
            try { await hook(); } catch (err) {
              gwLog.warn("channel shutdown hook failed (non-fatal)", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // Stop channel adapters (Slack, etc.)
          await channelRegistry.stopAll();
          // Stop MCP servers
          await mcpManager.stopAll();
          // Persist daily usage before exit + stop the periodic flush
          // timer so a stuck shutdown doesn't keep firing it.
          costTracker.persistDaily();
          costTracker.dispose();
          // Print cost summary to console
          const daily = costTracker.getDailyUsage();
          if (daily.apiCalls > 0) {
            // Sum all three input buckets so the banner reflects total
            // input the model processed today, not just the fresh slice
            // (cache_read is the bulk once prompt caching engages).
            const totalInput =
              daily.tokens.input
              + (daily.tokens.cacheRead ?? 0)
              + (daily.tokens.cacheCreation ?? 0);
            console.log(`\n  Today's usage: ${formatCost(daily.costUSD)} (${formatTokenCount(totalInput)}↓ ${formatTokenCount(daily.tokens.output)}↑, ${daily.apiCalls} API calls)\n`);
          }
        },
      });

      break;
    }

    case "node": {
      const { runNodeHost } = await import("./node/runner.js");
      const nodeConfig = loadConfig();
      await runNodeHost({
        name: getArg(args, "--name"),
        connect: getArg(args, "--connect") ?? `ws://localhost:${nodeConfig.gateway_port ?? 4242}`,
        token: getArg(args, "--token") ?? nodeConfig.gateway?.auth?.token ?? undefined,
      });
      break;
    }

    case "mcp": {
      const { runHawkyMcpStdioServer } = await import("./mcp/hawky-server.js");
      await runHawkyMcpStdioServer();
      break;
    }

    case "setup":
      console.log(`hawky v${VERSION}`);
      console.log("Setup is now interactive. Start the gateway and TUI, then type /setup.");
      console.log("");
      console.log("  1. bun run gateway    (start the gateway)");
      console.log("  2. bun run dev        (start the TUI)");
      console.log("  3. Type /setup        (in the TUI)");
      break;

    case "doctor": {
      const { runDoctorChecksAsync, printDoctorReport } = await import("./commands/doctor.js");
      const report = await runDoctorChecksAsync();
      printDoctorReport(report);
      break;
    }

    case "asr-replay": {
      // One-shot CLI: replay dead-lettered ASR items. Does not start the
      // gateway. Transcripts only — chat-poster wiring lives in the gateway.
      const { runAsrReplay, parseArgs: parseReplayArgs } = await import("./cli/asr-replay.js");
      const subArgs = args.slice(args.indexOf("asr-replay") + 1);
      const exitCode = await runAsrReplay(parseReplayArgs(subArgs));
      process.exit(exitCode);
    }

    case "export": {
      const { runExport } = await import("./commands/migrate.js");
      await runExport(getArg(args, "--output"));
      break;
    }

    case "import": {
      const { runImport } = await import("./commands/migrate.js");
      const archiveArg = args[args.indexOf("import") + 1];
      await runImport(archiveArg, args.includes("--force"));
      break;
    }

    case "logs": {
      const logsDir = join(getConfigDir(), "logs");
      // Try background gateway log first, then find latest daily log
      const bgLog = join(logsDir, "gateway.log");
      let logPath: string | null = null;

      if (existsSync(bgLog)) {
        logPath = bgLog;
      } else if (existsSync(logsDir)) {
        // Find the most recent hawky-*.log file (from foreground gateway)
        const { readdirSync } = await import("node:fs");
        const dailyLogs = readdirSync(logsDir)
          .filter((f: string) => f.startsWith("hawky-") && f.endsWith(".log"))
          .sort()
          .reverse();
        if (dailyLogs.length > 0) {
          logPath = join(logsDir, dailyLogs[0]);
        }
      }

      if (!logPath) {
        console.error(`No gateway logs found in ${logsDir}`);
        console.error("Start the gateway first: hawky gateway");
        process.exit(1);
      }
      console.log(`Tailing ${logPath} (Ctrl+C to stop)\n`);
      Bun.spawn(["tail", "-f", logPath], { stdio: ["ignore", "inherit", "inherit"] });
      await new Promise(() => {}); // Keep alive until Ctrl+C
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main();
