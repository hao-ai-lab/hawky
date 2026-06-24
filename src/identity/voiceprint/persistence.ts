import {
  makeVoiceprintRecordId,
  type EventParticipation,
  type IsoTime,
  type RecordId,
  type SpeakerTurnTag,
  type TranscriptSpeakerAnnotation,
  type VoiceprintIdentitySignal,
} from "./contracts.js";
import type {
  VoiceprintTranscriptIdentityState,
  VoiceprintTranscriptIdentityStatePatch,
} from "./transcript-state.js";

export interface VoiceprintTranscriptJoin {
  sessionKey: string;
  transcriptItemId: string;
}

export interface VoiceprintStorageBundle {
  version: 1;
  id: RecordId;
  source: "voiceprint";
  sessionKey: string;
  createdAt: IsoTime;
  transcriptIdentityStates: VoiceprintTranscriptIdentityState[];
  speakerTurnTags: SpeakerTurnTag[];
  identitySignals: VoiceprintIdentitySignal[];
  transcriptSpeakerAnnotations: TranscriptSpeakerAnnotation[];
  eventParticipations: EventParticipation[];
  clearTranscriptIdentity: VoiceprintTranscriptJoin[];
}

export interface VoiceprintStorageSnapshot {
  transcriptIdentityStates: VoiceprintTranscriptIdentityState[];
  speakerTurnTags: SpeakerTurnTag[];
  identitySignals: VoiceprintIdentitySignal[];
  transcriptSpeakerAnnotations: TranscriptSpeakerAnnotation[];
  eventParticipations: EventParticipation[];
}

export interface VoiceprintStorageCounts {
  transcriptIdentityStates: number;
  speakerTurnTags: number;
  identitySignals: number;
  transcriptSpeakerAnnotations: number;
  eventParticipations: number;
}

export function emptyVoiceprintStorageSnapshot(): VoiceprintStorageSnapshot {
  return {
    transcriptIdentityStates: [],
    speakerTurnTags: [],
    identitySignals: [],
    transcriptSpeakerAnnotations: [],
    eventParticipations: [],
  };
}

export function countVoiceprintStorageSnapshot(
  snapshot: VoiceprintStorageSnapshot,
): VoiceprintStorageCounts {
  return {
    transcriptIdentityStates: snapshot.transcriptIdentityStates.length,
    speakerTurnTags: snapshot.speakerTurnTags.length,
    identitySignals: snapshot.identitySignals.length,
    transcriptSpeakerAnnotations: snapshot.transcriptSpeakerAnnotations.length,
    eventParticipations: snapshot.eventParticipations.length,
  };
}

export function buildVoiceprintStorageBundle(input: {
  states: readonly VoiceprintTranscriptIdentityState[];
  patches?: readonly VoiceprintTranscriptIdentityStatePatch[];
  createdAt?: IsoTime;
}): VoiceprintStorageBundle {
  const patches = input.patches ?? [];
  const sessionKey = singleSessionKey([...input.states, ...patches]);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const states = sortedStates(input.states);
  const scoredPatches = patches.filter((patch) => patch.kind === "scored");
  const explicitClears = patches
    .filter((patch) => patch.kind === "skipped")
    .map((patch) => joinFor(patch));
  const stateClears = states
    .filter((state) => stateRequiresIdentityClear(state))
    .map((state) => joinFor(state));

  validateUniqueJoins(states, "Voiceprint storage bundle state");
  validateUniqueJoins(patches, "Voiceprint storage bundle patch");

  const speakerTurnTags = scoredPatches.map((patch) => patch.update.speakerTurnTag);
  const identitySignals = scoredPatches.map((patch) => patch.update.identitySignal);
  const transcriptSpeakerAnnotations = scoredPatches.map(
    (patch) => patch.update.transcriptSpeakerAnnotation,
  );
  const eventParticipations = scoredPatches.flatMap((patch) =>
    patch.update.eventParticipation ? [patch.update.eventParticipation] : [],
  );
  const clearTranscriptIdentity = uniqueJoins([...explicitClears, ...stateClears]).filter(
    (join) =>
      !transcriptSpeakerAnnotations.some(
        (annotation) =>
          annotation.sessionKey === join.sessionKey &&
          annotation.transcriptItemId === join.transcriptItemId,
      ),
  );

  for (const patch of scoredPatches) {
    validateScoredPatchConsistency(patch);
  }
  validateStatesHaveRecords(states, transcriptSpeakerAnnotations);
  validateUniqueIds(speakerTurnTags, "Voiceprint storage bundle speaker tag");
  validateUniqueIds(identitySignals, "Voiceprint storage bundle identity signal");
  validateUniqueAnnotationJoins(transcriptSpeakerAnnotations);
  validateUniqueIds(eventParticipations, "Voiceprint storage bundle event participation");
  validateEventParticipationsHaveSignals(eventParticipations, identitySignals);
  validateStorageRecordReachability({
    annotations: transcriptSpeakerAnnotations,
    speakerTurnTags,
    identitySignals,
    eventParticipations,
  });

  const id = makeVoiceprintRecordId("vpstore", [
    sessionKey,
    states.map((state) => [state.id, state.updatedAt, state.lifecycle]),
    scoredPatches.map((patch) => patch.update.id),
    clearTranscriptIdentity,
  ]);

  return {
    version: 1,
    id,
    source: "voiceprint",
    sessionKey,
    createdAt,
    transcriptIdentityStates: states,
    speakerTurnTags,
    identitySignals,
    transcriptSpeakerAnnotations,
    eventParticipations,
    clearTranscriptIdentity,
  };
}

export function applyVoiceprintStorageBundle(input: {
  snapshot?: Partial<VoiceprintStorageSnapshot>;
  bundle: VoiceprintStorageBundle;
}): VoiceprintStorageSnapshot {
  validateBundle(input.bundle);

  const snapshot = {
    ...emptyVoiceprintStorageSnapshot(),
    ...input.snapshot,
  };
  const stateById = mapById(snapshot.transcriptIdentityStates);
  const tagById = mapById(snapshot.speakerTurnTags);
  const signalById = mapById(snapshot.identitySignals);
  const annotationByJoin = mapAnnotationsByJoin(snapshot.transcriptSpeakerAnnotations);
  const eventById = mapById(snapshot.eventParticipations);

  const clearedSpeakerTagIds = new Set<string>();
  const clearedIdentitySignalIds = new Set<string>();

  for (const join of input.bundle.clearTranscriptIdentity) {
    const current = annotationByJoin.get(transcriptJoinKey(join));
    if (!current) {
      continue;
    }
    annotationByJoin.delete(transcriptJoinKey(join));
    clearedSpeakerTagIds.add(current.speakerTurnTagId);
    clearedIdentitySignalIds.add(current.identitySignalId);
  }
  for (const annotation of input.bundle.transcriptSpeakerAnnotations) {
    const current = annotationByJoin.get(transcriptJoinKey(annotation));
    if (!current) {
      continue;
    }
    annotationByJoin.delete(transcriptJoinKey(annotation));
    clearedSpeakerTagIds.add(current.speakerTurnTagId);
    clearedIdentitySignalIds.add(current.identitySignalId);
  }

  for (const id of clearedSpeakerTagIds) {
    tagById.delete(id);
  }
  for (const id of clearedIdentitySignalIds) {
    signalById.delete(id);
  }
  for (const [id, event] of eventById) {
    if (event.supportingSignalIds.some((signalId) => clearedIdentitySignalIds.has(signalId))) {
      eventById.delete(id);
    }
  }

  for (const state of input.bundle.transcriptIdentityStates) {
    stateById.set(state.id, state);
  }
  for (const tag of input.bundle.speakerTurnTags) {
    tagById.set(tag.id, tag);
  }
  for (const signal of input.bundle.identitySignals) {
    signalById.set(signal.id, signal);
  }
  for (const annotation of input.bundle.transcriptSpeakerAnnotations) {
    annotationByJoin.set(transcriptJoinKey(annotation), annotation);
  }
  for (const event of input.bundle.eventParticipations) {
    eventById.set(event.id, event);
  }

  return {
    transcriptIdentityStates: [...stateById.values()],
    speakerTurnTags: [...tagById.values()],
    identitySignals: [...signalById.values()],
    transcriptSpeakerAnnotations: [...annotationByJoin.values()],
    eventParticipations: [...eventById.values()],
  };
}

function validateBundle(bundle: VoiceprintStorageBundle): void {
  if (bundle.version !== 1) {
    throw new Error("Voiceprint storage bundle version must be 1.");
  }
  if (bundle.source !== "voiceprint") {
    throw new Error("Voiceprint storage bundle source must be voiceprint.");
  }
  if (!bundle.sessionKey.trim()) {
    throw new Error("Voiceprint storage bundle requires sessionKey.");
  }
  if (!bundle.id.trim()) {
    throw new Error("Voiceprint storage bundle requires id.");
  }
  const sessionKey = singleSessionKey([
    ...bundle.transcriptIdentityStates,
    ...bundle.speakerTurnTags,
    ...bundle.transcriptSpeakerAnnotations,
    ...bundle.clearTranscriptIdentity,
  ]);
  if (sessionKey !== bundle.sessionKey) {
    throw new Error("Voiceprint storage bundle sessionKey does not match records.");
  }
  validateUniqueJoins(bundle.transcriptIdentityStates, "Voiceprint storage bundle state");
  validateStatesHaveRecords(
    bundle.transcriptIdentityStates,
    bundle.transcriptSpeakerAnnotations,
  );
  validateUniqueAnnotationJoins(bundle.transcriptSpeakerAnnotations);
  validateUniqueIds(bundle.speakerTurnTags, "Voiceprint storage bundle speaker tag");
  validateUniqueIds(bundle.identitySignals, "Voiceprint storage bundle identity signal");
  validateUniqueIds(bundle.eventParticipations, "Voiceprint storage bundle event participation");
  validateEventParticipationsHaveSignals(bundle.eventParticipations, bundle.identitySignals);
  validateStorageRecordReachability({
    annotations: bundle.transcriptSpeakerAnnotations,
    speakerTurnTags: bundle.speakerTurnTags,
    identitySignals: bundle.identitySignals,
    eventParticipations: bundle.eventParticipations,
  });
}

function validateScoredPatchConsistency(
  patch: Extract<VoiceprintTranscriptIdentityStatePatch, { kind: "scored" }>,
): void {
  const update = patch.update;
  const annotation = update.transcriptSpeakerAnnotation;
  if (
    patch.sessionKey !== update.sessionKey ||
    patch.transcriptItemId !== update.transcriptItemId ||
    patch.state.sessionKey !== update.sessionKey ||
    patch.state.transcriptItemId !== update.transcriptItemId
  ) {
    throw new Error("Voiceprint storage bundle scored patch join mismatch.");
  }
  if (
    annotation.sessionKey !== update.sessionKey ||
    annotation.transcriptItemId !== update.transcriptItemId
  ) {
    throw new Error("Voiceprint storage bundle annotation join mismatch.");
  }
  if (
    patch.state.updateId !== update.id ||
    patch.state.speakerTurnTagId !== annotation.speakerTurnTagId ||
    patch.state.identitySignalId !== annotation.identitySignalId
  ) {
    throw new Error("Voiceprint storage bundle state does not match scored records.");
  }
  if (update.speakerTurnTag.id !== annotation.speakerTurnTagId) {
    throw new Error("Voiceprint storage bundle speaker tag id mismatch.");
  }
  if (update.identitySignal.id !== annotation.identitySignalId) {
    throw new Error("Voiceprint storage bundle identity signal id mismatch.");
  }
}

function stateRequiresIdentityClear(state: VoiceprintTranscriptIdentityState): boolean {
  return (
    state.lifecycle === "skipped" ||
    state.lifecycle === "not_applicable" ||
    state.lifecycle === "error"
  );
}

function validateStatesHaveRecords(
  states: readonly VoiceprintTranscriptIdentityState[],
  annotations: readonly TranscriptSpeakerAnnotation[],
): void {
  const annotationByJoin = mapAnnotationsByJoin(annotations);
  for (const state of states) {
    if (!state.speakerTurnTagId && !state.identitySignalId && !state.updateId) {
      continue;
    }
    const annotation = annotationByJoin.get(transcriptJoinKey(state));
    if (!annotation) {
      throw new Error(
        `Voiceprint storage bundle state has no matching annotation: ${state.sessionKey}/${state.transcriptItemId}.`,
      );
    }
    if (
      annotation.speakerTurnTagId !== state.speakerTurnTagId ||
      annotation.identitySignalId !== state.identitySignalId
    ) {
      throw new Error("Voiceprint storage bundle state record ids do not match annotation.");
    }
  }
}

function validateEventParticipationsHaveSignals(
  events: readonly EventParticipation[],
  signals: readonly VoiceprintIdentitySignal[],
): void {
  const signalIds = new Set(signals.map((signal) => signal.id));
  for (const event of events) {
    for (const signalId of event.supportingSignalIds) {
      if (!signalIds.has(signalId)) {
        throw new Error("Voiceprint storage bundle event participation references missing identity signal.");
      }
    }
  }
}

function validateStorageRecordReachability(input: {
  annotations: readonly TranscriptSpeakerAnnotation[];
  speakerTurnTags: readonly SpeakerTurnTag[];
  identitySignals: readonly VoiceprintIdentitySignal[];
  eventParticipations: readonly EventParticipation[];
}): void {
  const tagById = mapById(input.speakerTurnTags);
  const signalById = mapById(input.identitySignals);
  const annotationTagIds = new Set(input.annotations.map((annotation) => annotation.speakerTurnTagId));
  const annotationSignalIds = new Set(input.annotations.map((annotation) => annotation.identitySignalId));

  for (const annotation of input.annotations) {
    const tag = tagById.get(annotation.speakerTurnTagId);
    if (!tag) {
      throw new Error("Voiceprint storage bundle annotation references missing speaker tag.");
    }
    if (
      tag.sessionKey !== annotation.sessionKey ||
      tag.transcriptItemId !== annotation.transcriptItemId
    ) {
      throw new Error("Voiceprint storage bundle annotation speaker tag join mismatch.");
    }
    if (tag.identitySignalId !== annotation.identitySignalId) {
      throw new Error("Voiceprint storage bundle annotation speaker tag signal mismatch.");
    }

    const signal = signalById.get(annotation.identitySignalId);
    if (!signal) {
      throw new Error("Voiceprint storage bundle annotation references missing identity signal.");
    }
    if (signal.metadata.transcriptItemId !== annotation.transcriptItemId) {
      throw new Error("Voiceprint storage bundle annotation identity signal transcript mismatch.");
    }
  }

  for (const event of input.eventParticipations) {
    for (const signalId of event.supportingSignalIds) {
      if (!annotationSignalIds.has(signalId)) {
        throw new Error("Voiceprint storage bundle event participation references unowned identity signal.");
      }
    }
  }

  for (const tag of input.speakerTurnTags) {
    if (!annotationTagIds.has(tag.id)) {
      throw new Error("Voiceprint storage bundle contains orphan speaker tag.");
    }
  }
  for (const signal of input.identitySignals) {
    if (!annotationSignalIds.has(signal.id)) {
      throw new Error("Voiceprint storage bundle contains orphan identity signal.");
    }
  }
}

function sortedStates(
  states: readonly VoiceprintTranscriptIdentityState[],
): VoiceprintTranscriptIdentityState[] {
  return [...states].sort((a, b) =>
    transcriptJoinKey(a).localeCompare(transcriptJoinKey(b)),
  );
}

function singleSessionKey(items: readonly VoiceprintTranscriptJoin[]): string {
  if (items.length === 0) {
    throw new Error("Voiceprint storage bundle requires at least one transcript join.");
  }
  const sessionKey = items[0]?.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("Voiceprint storage bundle requires sessionKey.");
  }
  for (const item of items) {
    if (item.sessionKey !== sessionKey) {
      throw new Error("Voiceprint storage bundle cannot mix session keys.");
    }
    if (!item.transcriptItemId.trim()) {
      throw new Error("Voiceprint storage bundle requires transcriptItemId.");
    }
  }
  return sessionKey;
}

function validateUniqueJoins(
  joins: readonly VoiceprintTranscriptJoin[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const join of joins) {
    const key = transcriptJoinKey(join);
    if (seen.has(key)) {
      throw new Error(`${label} has duplicate transcript join: ${join.sessionKey}/${join.transcriptItemId}.`);
    }
    seen.add(key);
  }
}

function validateUniqueAnnotationJoins(
  annotations: readonly TranscriptSpeakerAnnotation[],
): void {
  validateUniqueJoins(annotations, "Voiceprint storage bundle annotation");
}

function validateUniqueIds<T extends { id: string }>(items: readonly T[], label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id.trim()) {
      throw new Error(`${label} requires id.`);
    }
    if (seen.has(item.id)) {
      throw new Error(`${label} has duplicate id: ${item.id}.`);
    }
    seen.add(item.id);
  }
}

function uniqueJoins(joins: readonly VoiceprintTranscriptJoin[]): VoiceprintTranscriptJoin[] {
  const seen = new Set<string>();
  const unique: VoiceprintTranscriptJoin[] = [];
  for (const join of joins) {
    const key = transcriptJoinKey(join);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      sessionKey: join.sessionKey,
      transcriptItemId: join.transcriptItemId,
    });
  }
  return unique;
}

function mapById<T extends { id: string }>(items: readonly T[] = []): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

function mapAnnotationsByJoin(
  annotations: readonly TranscriptSpeakerAnnotation[] = [],
): Map<string, TranscriptSpeakerAnnotation> {
  const map = new Map<string, TranscriptSpeakerAnnotation>();
  for (const annotation of annotations) {
    map.set(transcriptJoinKey(annotation), annotation);
  }
  return map;
}

function joinFor(join: VoiceprintTranscriptJoin): VoiceprintTranscriptJoin {
  return {
    sessionKey: join.sessionKey,
    transcriptItemId: join.transcriptItemId,
  };
}

function transcriptJoinKey(join: VoiceprintTranscriptJoin): string {
  return JSON.stringify([join.sessionKey, join.transcriptItemId]);
}
