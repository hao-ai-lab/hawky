#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  formatVoiceprintReport,
  loadVoiceprintManifest,
  materializeManifestEmbeddingsWithSidecar,
  scoreVoiceprintManifest,
  type ManifestSidecarMode,
  type VoiceprintThresholds,
} from "../src/identity/voiceprint/index.js";

interface CliArgs {
  manifest: string;
  jsonOut?: string;
  ownerAccept?: number;
  ownerPossible?: number;
  sidecarCommand?: string;
  sidecarArgs: string[];
  sidecarTimeoutMs?: number;
  sidecarMode?: ManifestSidecarMode;
  sidecarTargetSampleRate?: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    manifest: "fixtures/voiceprint/manifest.example.json",
    sidecarArgs: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`Missing value after ${arg}.`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case "--manifest":
        args.manifest = next();
        break;
      case "--json-out":
        args.jsonOut = next();
        break;
      case "--owner-accept":
        args.ownerAccept = Number(next());
        break;
      case "--owner-possible":
        args.ownerPossible = Number(next());
        break;
      case "--sidecar-command":
        args.sidecarCommand = next();
        break;
      case "--sidecar-arg":
        args.sidecarArgs.push(next());
        break;
      case "--sidecar-timeout-ms":
        args.sidecarTimeoutMs = Number(next());
        break;
      case "--sidecar-mode":
        args.sidecarMode = parseSidecarMode(next());
        break;
      case "--sidecar-target-sample-rate":
        args.sidecarTargetSampleRate = Number(next());
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}.`);
    }
  }

  return args;
}

function usage(): string {
  return `voiceprint-score-fixtures

Usage:
  bun run scripts/voiceprint-score-fixtures.ts [options]

Options:
  --manifest <path>          Fixture manifest JSON.
  --json-out <path>          Optional JSON report output path.
  --owner-accept <number>    Override owner accept threshold.
  --owner-possible <number>  Override possible-owner threshold.
  --sidecar-command <path>   Optional embedding sidecar command.
  --sidecar-arg <value>      Argument passed to the sidecar command. Repeatable.
  --sidecar-timeout-ms <n>   Sidecar timeout. Default: 30000.
  --sidecar-mode <mode>      missing_embeddings or all_audio. Default: missing_embeddings.
  --sidecar-target-sample-rate <n>
                            Optional target sample rate sent to sidecar requests.
  --help                    Show this help.

The default manifest uses inline vectors so the pipeline is runnable without
SpeechBrain/WeSpeaker installed. Real fixtures can point to WAV files or model
embedding JSON files. With --sidecar-command, audioPath sources without
embeddings are embedded through JSON stdin/stdout before scoring.
`;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const thresholdOverrides: Partial<VoiceprintThresholds> = {};
  if (args.ownerAccept !== undefined) {
    thresholdOverrides.ownerAccept = args.ownerAccept;
  }
  if (args.ownerPossible !== undefined) {
    thresholdOverrides.ownerPossible = args.ownerPossible;
  }

  const manifestPath = resolve(args.manifest);
  const { manifest, baseDir } = await loadVoiceprintManifest(manifestPath);
  let scoringManifest = manifest;

  if (args.sidecarCommand) {
    const materialized = await materializeManifestEmbeddingsWithSidecar({
      manifest,
      baseDir,
      sidecar: {
        command: args.sidecarCommand,
        args: args.sidecarArgs,
        timeoutMs: args.sidecarTimeoutMs,
      },
      mode: args.sidecarMode,
      targetSampleRate: args.sidecarTargetSampleRate,
    });
    scoringManifest = materialized.manifest;
    process.stderr.write(
      `Voiceprint sidecar embedded ${materialized.requestCount} audio source(s).${materialized.model ? ` model=${materialized.model.provider}/${materialized.model.modelId}` : ""}\n`,
    );
  }

  const report = await scoreVoiceprintManifest(scoringManifest, {
    baseDir,
    thresholdOverrides,
  });

  process.stdout.write(formatVoiceprintReport(report));

  if (args.jsonOut) {
    const outPath = resolve(args.jsonOut);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function parseSidecarMode(value: string): ManifestSidecarMode {
  if (value === "missing_embeddings" || value === "all_audio") {
    return value;
  }
  throw new Error(`Unknown sidecar mode: ${value}.`);
}
