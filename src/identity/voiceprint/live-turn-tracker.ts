import type { SpeechTurn } from "./contracts.js";
import type { LiveVoiceprintTurnCandidate } from "./live-adapter.js";
import type { VoiceprintAudioQualityAssessment } from "./quality.js";

export interface LiveVoiceTurnTrackerOptions {
  sessionKey: string;
  route?: SpeechTurn["route"];
}

export interface LiveVoiceTurnSpeechWindow {
  id: string;
  startMs: number;
  endMs?: number;
  route?: SpeechTurn["route"];
}

export interface LiveVoiceTurnTranscript {
  transcriptItemId: string;
  role: SpeechTurn["role"];
  text?: string;
  speechWindowId?: string;
}

export interface LiveVoiceTurnAudioArtifact {
  audioArtifactId: string;
  audioPath?: string;
  samples?: Float32Array;
  sampleRate?: number;
  quality?: VoiceprintAudioQualityAssessment;
  route?: SpeechTurn["route"];
  speechWindowId?: string;
  transcriptItemId?: string;
}

export interface LiveVoiceTurnFinalized extends LiveVoiceprintTurnCandidate {
  speechWindowId: string;
  audioPath?: string;
}

export interface LiveVoiceTurnDrainOptions {
  includeMissingAudio?: boolean;
}

interface MutableSpeechWindow extends LiveVoiceTurnSpeechWindow {
  transcriptItemId?: string;
  audioArtifactId?: string;
}

interface MutableTranscript extends LiveVoiceTurnTranscript {
  speechWindowId?: string;
}

export class LiveVoiceTurnTracker {
  private readonly sessionKey: string;
  private readonly defaultRoute?: SpeechTurn["route"];
  private readonly speechWindows = new Map<string, MutableSpeechWindow>();
  private readonly transcripts = new Map<string, MutableTranscript>();
  private readonly audioByWindow = new Map<string, LiveVoiceTurnAudioArtifact>();
  private readonly audioByTranscript = new Map<string, LiveVoiceTurnAudioArtifact>();
  private readonly finalizedTranscriptIds = new Set<string>();
  private sequence = 0;

  constructor(options: LiveVoiceTurnTrackerOptions) {
    if (!options.sessionKey.trim()) {
      throw new Error("Live voice turn tracker requires sessionKey.");
    }
    this.sessionKey = options.sessionKey;
    this.defaultRoute = options.route;
  }

  recordSpeechStarted(input: {
    speechWindowId?: string;
    atMs: number;
    route?: SpeechTurn["route"];
  }): LiveVoiceTurnSpeechWindow {
    validateFiniteTime(input.atMs, "speech start");
    const id = this.resolveSpeechWindowId(input.speechWindowId);
    if (this.speechWindows.has(id)) {
      throw new Error(`Duplicate live voice speech window id: ${id}.`);
    }

    const window: MutableSpeechWindow = {
      id,
      startMs: input.atMs,
      route: input.route ?? this.defaultRoute,
    };
    this.speechWindows.set(id, window);
    return { ...window };
  }

  recordSpeechStopped(input: {
    speechWindowId?: string;
    atMs: number;
  }): LiveVoiceTurnSpeechWindow {
    validateFiniteTime(input.atMs, "speech stop");
    const window = input.speechWindowId
      ? this.speechWindows.get(input.speechWindowId)
      : this.latestOpenSpeechWindow();
    if (!window) {
      throw new Error("Live voice turn tracker cannot stop an unknown speech window.");
    }
    if (window.endMs !== undefined) {
      throw new Error(`Live voice speech window already stopped: ${window.id}.`);
    }
    if (input.atMs <= window.startMs) {
      throw new Error("Live voice speech stop must be after speech start.");
    }

    window.endMs = input.atMs;
    return { ...window };
  }

  recordTranscriptCompleted(input: {
    transcriptItemId: string;
    text?: string;
    role?: SpeechTurn["role"];
    speechWindowId?: string;
  }): LiveVoiceTurnTranscript {
    const transcriptItemId = input.transcriptItemId.trim();
    const role = input.role ?? "user";
    if (!transcriptItemId) {
      throw new Error("Live voice transcript requires transcriptItemId.");
    }
    if (this.transcripts.has(transcriptItemId)) {
      throw new Error(`Duplicate live voice transcript item id: ${transcriptItemId}.`);
    }

    const explicitSpeechWindowId = input.speechWindowId?.trim();
    if (role !== "user" && explicitSpeechWindowId) {
      throw new Error("Live voice non-user transcript cannot bind to an input speech window.");
    }
    const speechWindowId =
      explicitSpeechWindowId ||
      (role === "user" ? this.firstClosedWindowWithoutTranscript()?.id : undefined);
    if (speechWindowId) {
      const window = this.speechWindows.get(speechWindowId);
      if (!window) {
        throw new Error(`Live voice transcript references unknown speech window: ${speechWindowId}.`);
      }
      if (window.transcriptItemId) {
        throw new Error(`Live voice speech window already has transcript: ${speechWindowId}.`);
      }
      window.transcriptItemId = transcriptItemId;
    }

    const transcript: MutableTranscript = {
      transcriptItemId,
      text: input.text,
      role,
      speechWindowId,
    };
    this.transcripts.set(transcriptItemId, transcript);
    return { ...transcript };
  }

  attachAudioArtifact(input: {
    audioArtifactId: string;
    audioPath?: string;
    samples?: Float32Array;
    sampleRate?: number;
    quality?: VoiceprintAudioQualityAssessment;
    route?: SpeechTurn["route"];
    speechWindowId?: string;
    transcriptItemId?: string;
  }): LiveVoiceTurnAudioArtifact {
    const audioArtifactId = input.audioArtifactId.trim();
    if (!audioArtifactId) {
      throw new Error("Live voice audio artifact requires audioArtifactId.");
    }
    if (input.sampleRate !== undefined && (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0)) {
      throw new Error("Live voice audio artifact sampleRate must be positive.");
    }

    const speechWindowId = this.resolveAudioSpeechWindowId(input);
    const transcriptItemId =
      input.transcriptItemId?.trim() ||
      (speechWindowId ? this.speechWindows.get(speechWindowId)?.transcriptItemId : undefined);
    this.validateAudioJoin({
      speechWindowId,
      transcriptItemId,
    });
    const artifact: LiveVoiceTurnAudioArtifact = {
      audioArtifactId,
      audioPath: input.audioPath,
      samples: input.samples,
      sampleRate: input.sampleRate,
      quality: input.quality,
      route: input.route,
      speechWindowId,
      transcriptItemId,
    };

    if (speechWindowId) {
      const window = this.speechWindows.get(speechWindowId);
      if (!window) {
        throw new Error(`Live voice audio references unknown speech window: ${speechWindowId}.`);
      }
      if (window.audioArtifactId && window.audioArtifactId !== audioArtifactId) {
        throw new Error(`Live voice speech window already has audio artifact: ${speechWindowId}.`);
      }
      window.audioArtifactId = audioArtifactId;
      this.audioByWindow.set(speechWindowId, artifact);
    }
    if (transcriptItemId) {
      if (this.audioByTranscript.has(transcriptItemId)) {
        throw new Error(`Live voice transcript already has audio artifact: ${transcriptItemId}.`);
      }
      this.audioByTranscript.set(transcriptItemId, artifact);
    }
    if (!speechWindowId && !transcriptItemId) {
      throw new Error("Live voice audio artifact requires a speechWindowId or transcriptItemId.");
    }

    return { ...artifact };
  }

  drainFinalizedTurns(options: LiveVoiceTurnDrainOptions = {}): LiveVoiceTurnFinalized[] {
    const finalized: LiveVoiceTurnFinalized[] = [];

    for (const transcript of this.transcripts.values()) {
      if (this.finalizedTranscriptIds.has(transcript.transcriptItemId)) {
        continue;
      }
      if (transcript.role !== "user") {
        this.finalizedTranscriptIds.add(transcript.transcriptItemId);
        continue;
      }
      if (!transcript.speechWindowId) {
        continue;
      }
      const window = this.speechWindows.get(transcript.speechWindowId);
      if (!window || window.endMs === undefined) {
        continue;
      }
      const audio =
        this.audioByTranscript.get(transcript.transcriptItemId) ??
        this.audioByWindow.get(window.id);
      if (!audio && options.includeMissingAudio !== true) {
        continue;
      }

      finalized.push({
        sessionKey: this.sessionKey,
        transcriptItemId: transcript.transcriptItemId,
        role: transcript.role,
        text: transcript.text,
        startMs: window.startMs,
        endMs: window.endMs,
        audioArtifactId: audio?.audioArtifactId,
        route: audio?.route ?? window.route ?? this.defaultRoute,
        samples: audio?.samples,
        sampleRate: audio?.sampleRate,
        quality: audio?.quality,
        audioPath: audio?.audioPath,
        speechWindowId: window.id,
      });
      this.finalizedTranscriptIds.add(transcript.transcriptItemId);
    }

    return finalized;
  }

  pendingSpeechWindowCount(): number {
    let count = 0;
    for (const window of this.speechWindows.values()) {
      if (window.endMs === undefined) {
        count += 1;
      }
    }
    return count;
  }

  pendingTranscriptCount(): number {
    let count = 0;
    for (const transcript of this.transcripts.values()) {
      if (!this.finalizedTranscriptIds.has(transcript.transcriptItemId)) {
        count += 1;
      }
    }
    return count;
  }

  hasSpeechWindow(speechWindowId: string): boolean {
    return this.speechWindows.has(speechWindowId.trim());
  }

  hasTranscript(transcriptItemId: string): boolean {
    return this.transcripts.has(transcriptItemId.trim());
  }

  private resolveSpeechWindowId(id: string | undefined): string {
    const trimmed = id?.trim();
    if (trimmed) {
      return trimmed;
    }
    this.sequence += 1;
    return `speech_${this.sequence}`;
  }

  private latestOpenSpeechWindow(): MutableSpeechWindow | undefined {
    const windows = [...this.speechWindows.values()];
    for (let index = windows.length - 1; index >= 0; index -= 1) {
      const window = windows[index]!;
      if (window.endMs === undefined) {
        return window;
      }
    }
    return undefined;
  }

  private firstClosedWindowWithoutTranscript(): MutableSpeechWindow | undefined {
    for (const window of this.speechWindows.values()) {
      if (window.endMs !== undefined && !window.transcriptItemId) {
        return window;
      }
    }
    return undefined;
  }

  private firstClosedWindowWithoutAudio(): MutableSpeechWindow | undefined {
    for (const window of this.speechWindows.values()) {
      if (window.endMs !== undefined && !window.audioArtifactId) {
        return window;
      }
    }
    return undefined;
  }

  private resolveAudioSpeechWindowId(input: {
    transcriptItemId?: string;
    speechWindowId?: string;
  }): string | undefined {
    const explicitWindowId = input.speechWindowId?.trim();
    if (explicitWindowId) {
      return explicitWindowId;
    }
    const transcriptItemId = input.transcriptItemId?.trim();
    if (transcriptItemId) {
      const transcript = this.transcripts.get(transcriptItemId);
      if (!transcript) {
        throw new Error(`Live voice audio references unknown transcript: ${transcriptItemId}.`);
      }
      return transcript.speechWindowId;
    }
    return this.firstClosedWindowWithoutAudio()?.id;
  }

  private validateAudioJoin(input: {
    speechWindowId?: string;
    transcriptItemId?: string;
  }): void {
    const window = input.speechWindowId
      ? this.speechWindows.get(input.speechWindowId)
      : undefined;
    if (input.speechWindowId && !window) {
      throw new Error(`Live voice audio references unknown speech window: ${input.speechWindowId}.`);
    }

    const transcript = input.transcriptItemId
      ? this.transcripts.get(input.transcriptItemId)
      : undefined;
    if (input.transcriptItemId && !transcript) {
      throw new Error(`Live voice audio references unknown transcript: ${input.transcriptItemId}.`);
    }

    if (!window || !transcript) {
      return;
    }
    if (window.transcriptItemId && window.transcriptItemId !== transcript.transcriptItemId) {
      throw new Error("Live voice audio transcript/window join mismatch.");
    }
    if (transcript.speechWindowId && transcript.speechWindowId !== window.id) {
      throw new Error("Live voice audio transcript/window join mismatch.");
    }
    if (!window.transcriptItemId && !transcript.speechWindowId) {
      throw new Error("Live voice audio cannot bind unrelated transcript and speech window.");
    }
  }
}

function validateFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Live voice ${label} requires a finite timestamp.`);
  }
  if (value < 0) {
    throw new Error(`Live voice ${label} requires a non-negative timestamp.`);
  }
}
