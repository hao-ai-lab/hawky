// =============================================================================
// Welcome Screen Component
//
// Boxed welcome banner with figlet "Hao AI Lab" ASCII art, tips, and session
// info. Similar to Claude Code's welcome screen layout.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";

interface WelcomeScreenProps {
  model: string;
  workingDirectory: string;
  gitBranch?: string;
  gitClean?: boolean;
  sessionInfo?: string; // e.g., "New session started" or "Resumed session abc-123"
}

// Figlet "Hao AI Lab" in standard font
const FIGLET_LINES = [
  `  _   _               _    ___`,
  ` | | | | __ _  ___   / \\  |_ _|`,
  ` | |_| |/ _\` |/ _ \\ / _ \\  | |`,
  ` |  _  | (_| | (_) / ___ \\ | |`,
  ` |_| |_|\\__,_|\\___/_/   \\_\\___|`,
  `        _          _`,
  `       | |    __ _| |__`,
  `       | |   / _\` | '_ \\`,
  `       | |__| (_| | |_) |`,
  `       |_____\\__,_|_.__/`,
];

// Shorten path for display
function shortenPath(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

export function WelcomeScreen({ model, workingDirectory, gitBranch, gitClean, sessionInfo }: WelcomeScreenProps) {
  const termWidth = process.stdout.columns ?? 80;
  const isWide = termWidth >= 80;

  const shortPath = shortenPath(workingDirectory);

  if (isWide) {
    return <WideLayout
      model={model}
      shortPath={shortPath}
      gitBranch={gitBranch}
      gitClean={gitClean}
      sessionInfo={sessionInfo}
    />;
  }

  return <NarrowLayout
    model={model}
    shortPath={shortPath}
    gitBranch={gitBranch}
    gitClean={gitClean}
    sessionInfo={sessionInfo}
  />;
}

// Wide layout: figlet left, tips right, in a box
function WideLayout({ model, shortPath, gitBranch, gitClean, sessionInfo }: {
  model: string;
  shortPath: string;
  gitBranch?: string;
  gitClean?: boolean;
  sessionInfo?: string;
}) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color="cyan" bold>─── </Text>
        <Text color="green" bold>Hawky v0.1.0</Text>
        <Text color="cyan" bold> {"─".repeat(50)}</Text>
      </Box>

      <Box marginTop={1}>
        {/* Left: figlet */}
        <Box flexDirection="column" width={38}>
          {FIGLET_LINES.map((line, i) => (
            <Text key={i} color="cyan" bold>{line}</Text>
          ))}
          <Box marginTop={1}>
            <Text color="white">{model}</Text>
          </Box>
          <Box>
            <Text color="gray">{shortPath}</Text>
            {gitBranch && (
              <>
                <Text color="gray"> · </Text>
                <Text color={gitClean ? "green" : "yellow"}>{gitBranch}</Text>
                <Text color={gitClean ? "green" : "yellow"}>{gitClean ? " ✓" : " ●"}</Text>
              </>
            )}
          </Box>
        </Box>

        {/* Separator */}
        <Box flexDirection="column" marginX={1}>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
          <Text color="gray">│</Text>
        </Box>

        {/* Right: tips + session */}
        <Box flexDirection="column">
          <Text color="white" bold>Tips</Text>
          <Text color="gray">  /help       all commands</Text>
          <Text color="gray">  /new        fresh session</Text>
          <Text color="gray">  /resume     continue a session</Text>
          <Text color="gray">  Ctrl+J      multi-line input</Text>
          <Text color="gray">  Esc         cancel agent turn</Text>
          <Text color="gray">  Ctrl+C      exit</Text>
          <Box marginTop={1}>
            <Text color="white" bold>Session</Text>
          </Box>
          <Text color="gray">  {sessionInfo ?? "New session started"}</Text>
        </Box>
      </Box>
    </Box>
  );
}

// Narrow layout: stacked (figlet on top, info below)
function NarrowLayout({ model, shortPath, gitBranch, gitClean, sessionInfo }: {
  model: string;
  shortPath: string;
  gitBranch?: string;
  gitClean?: boolean;
  sessionInfo?: string;
}) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color="green" bold>Hawky v0.1.0</Text>
        <Text color="gray"> — Coding Agent + Personal Assistant</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="white">{model}</Text>
        <Text color="gray"> · {shortPath}</Text>
        {gitBranch && (
          <>
            <Text color="gray"> · </Text>
            <Text color={gitClean ? "green" : "yellow"}>{gitBranch}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color="gray">/help · Ctrl+J newline · Esc cancel</Text>
      </Box>
      {sessionInfo && (
        <Box>
          <Text color="gray">{sessionInfo}</Text>
        </Box>
      )}
    </Box>
  );
}
