// =============================================================================
// Status Bar Component
//
// Inline status indicator shown at the end of the output area (before input).
// Only visible when the agent is working — disappears when idle.
// Shows animated spinner + status text + live token counts + elapsed time.
// Matches COCO/Claude Code pattern: status lives in the message flow, not in
// a separate bordered box.
// =============================================================================

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { TuiStatus, DisplayTokenUsage } from "../types.js";

// Braille spinner frames
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Thinking words — shuffled on startup so they don't repeat in the same order
const THINKING_WORDS_BASE = [
  "thinking",
  "pondering",
  "reasoning",
  "analyzing",
  "considering",
  "processing",
  // WoW-themed
  "casting",
  "summoning",
  "channeling",
  "conjuring",
  "divining",
  "attuning",
  "communing",
  "invoking",
  "scrying",
  "hearthstoning",
  "buffing",
  "soulstoning",
  "transmuting",
];

// Fisher-Yates shuffle — produces a fresh order every session
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const THINKING_WORDS = shuffle(THINKING_WORDS_BASE);

interface StatusBarProps {
  status: TuiStatus;
  model: string;
  /** Extra detail shown after the status label (e.g., current tool name) */
  statusDetail?: string | null;
  tokenUsage?: DisplayTokenUsage | null;
  /** True when viewing a system session (cron/heartbeat) — shows "watching" instead of "working" */
  isSystemSession?: boolean;
}

function StatusSpinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color={color}>{SPINNER_FRAMES[frame]}</Text>;
}

// Module-level counter — advances once per mount so each "step" gets a new word
let thinkingWordCursor = 0;

function ThinkingText() {
  // Pick word on mount, hold it for the entire step
  const [word] = useState(() => {
    const w = THINKING_WORDS[thinkingWordCursor % THINKING_WORDS.length];
    thinkingWordCursor++;
    return w;
  });

  return <Text color="#c96442" italic>{word}...</Text>;
}

function ElapsedTimer() {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    startRef.current = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  if (elapsed < 1) return null;
  return <Text color="gray"> {elapsed}s</Text>;
}

export function StatusBar({ status, model, statusDetail, tokenUsage, isSystemSession }: StatusBarProps) {
  // Only show when agent is working
  if (status === "idle" || status === "error") return null;

  const isThinking = status === "thinking";
  const isCompacting = status === "compacting";

  const spinnerColor = isSystemSession ? "gray"
    : isCompacting ? "yellow"
    : isThinking ? "#c96442"
    : "cyan";

  return (
    <Box paddingX={1} marginTop={1} marginBottom={1}>
      <StatusSpinner color={spinnerColor} />
      <Text> </Text>
      {isSystemSession ? (
        <Text color="gray">watching background session...</Text>
      ) : isCompacting ? (
        <Text color="yellow">compacting context...</Text>
      ) : (
        <>
          {isThinking && !statusDetail && <ThinkingText />}
          {isThinking && statusDetail && (
            <Text color="#c96442">running {statusDetail}...</Text>
          )}
          {status === "streaming" && (
            <Text color="cyan">streaming...</Text>
          )}
        </>
      )}
      {tokenUsage && (
        <Text color="gray"> {tokenUsage.input_tokens + (tokenUsage.cache_read_input_tokens ?? 0) + (tokenUsage.cache_creation_input_tokens ?? 0)}↓ {tokenUsage.output_tokens}↑</Text>
      )}
      {!isSystemSession && <ElapsedTimer />}
      {!isCompacting && <Text color="gray"> {isSystemSession ? "(/back to return)" : "(esc to interrupt)"}</Text>}
    </Box>
  );
}
