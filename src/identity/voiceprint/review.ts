import {
  makeVoiceprintRecordId,
  type EventParticipation,
  type IsoTime,
  type RecordId,
  type ReviewState,
  type VoiceprintTurnRecords,
} from "./contracts.js";
import type { VoiceprintAnnotationAllowedUses } from "./policy.js";

export type VoiceprintReviewDecision =
  | "confirm_cluster"
  | "reject_identity"
  | "suppress_identity";

export interface VoiceprintReviewPatch {
  version: 1;
  id: RecordId;
  decision: VoiceprintReviewDecision;
  reviewedAt: IsoTime;
  reason?: string;
  records: VoiceprintTurnRecords;
  deletedEventParticipationId?: RecordId;
}

export function applyVoiceprintReviewDecision(input: {
  records: VoiceprintTurnRecords;
  decision: VoiceprintReviewDecision;
  reviewedAt?: IsoTime;
  reason?: string;
  eventId?: RecordId;
  claim?: string;
}): VoiceprintReviewPatch {
  assertConsistentVoiceprintRecords(input.records);

  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  const patchId = makeVoiceprintRecordId("vpreview", [
    input.records.identitySignal.id,
    input.records.speakerTurnTag.id,
    input.decision,
    reviewedAt,
  ]);

  switch (input.decision) {
    case "confirm_cluster":
      return {
        version: 1,
        id: patchId,
        decision: input.decision,
        reviewedAt,
        reason: input.reason,
        records: confirmUnknownCluster({
          records: input.records,
          reviewedAt,
          eventId: input.eventId,
          claim: input.claim,
        }),
      };
    case "reject_identity":
      return {
        version: 1,
        id: patchId,
        decision: input.decision,
        reviewedAt,
        reason: input.reason,
        records: terminalReviewRecords({
          records: input.records,
          state: "rejected",
          reviewedAt,
        }),
        deletedEventParticipationId: input.records.eventParticipation?.id,
      };
    case "suppress_identity":
      return {
        version: 1,
        id: patchId,
        decision: input.decision,
        reviewedAt,
        reason: input.reason,
        records: terminalReviewRecords({
          records: input.records,
          state: "suppressed",
          reviewedAt,
        }),
        deletedEventParticipationId: input.records.eventParticipation?.id,
      };
  }
}

function confirmUnknownCluster(input: {
  records: VoiceprintTurnRecords;
  reviewedAt: IsoTime;
  eventId?: RecordId;
  claim?: string;
}): VoiceprintTurnRecords {
  const subject = input.records.identitySignal.subject;
  if (
    input.records.speakerTurnTag.result !== "unknown_cluster" ||
    subject.type !== "unknown_cluster"
  ) {
    throw new Error("Voiceprint cluster confirmation requires an unknown_cluster record.");
  }

  const qualityAllowsEventGraph =
    input.records.identitySignal.metadata.quality?.allowedUses.eventGraph ?? true;
  const records = reviewRecords({
    records: input.records,
    state: "confirmed",
    reviewedAt: input.reviewedAt,
    annotationAllowedUses: {
      ...input.records.transcriptSpeakerAnnotation.allowedUses,
      diagnostics: true,
      transcriptDisplay: true,
      memoryPromotion: false,
      actionProposal: false,
      eventGraph: qualityAllowsEventGraph,
      contextExport: false,
      templateLearning: false,
    },
    identityAllowedUses: {
      tagSession: true,
      promoteMemory: false,
      proposeRelationship: qualityAllowsEventGraph,
      exportContext: false,
      triggerAction: false,
    },
  });

  if (!qualityAllowsEventGraph) {
    return {
      ...records,
      eventParticipation: undefined,
    };
  }

  const eventId = input.eventId ?? input.records.eventParticipation?.eventId;
  if (!eventId) {
    return records;
  }

  return {
    ...records,
    eventParticipation: buildReviewedUnknownClusterEventParticipation({
      records,
      clusterId: subject.id,
      eventId,
      claim: input.claim ?? input.records.eventParticipation?.claim ?? "",
      reviewedAt: input.reviewedAt,
    }),
  };
}

function terminalReviewRecords(input: {
  records: VoiceprintTurnRecords;
  state: Extract<ReviewState, "rejected" | "suppressed">;
  reviewedAt: IsoTime;
}): VoiceprintTurnRecords {
  return {
    ...reviewRecords({
      records: input.records,
      state: input.state,
      reviewedAt: input.reviewedAt,
      annotationAllowedUses: annotationAllowedUsesForTerminalReview(input.state),
      identityAllowedUses: {
        tagSession: false,
        promoteMemory: false,
        proposeRelationship: false,
        exportContext: false,
        triggerAction: false,
      },
    }),
    eventParticipation: undefined,
  };
}

function reviewRecords(input: {
  records: VoiceprintTurnRecords;
  state: ReviewState;
  reviewedAt: IsoTime;
  annotationAllowedUses: VoiceprintAnnotationAllowedUses;
  identityAllowedUses: VoiceprintTurnRecords["identitySignal"]["allowedUses"];
}): VoiceprintTurnRecords {
  return {
    evidenceRefs: input.records.evidenceRefs.map((ref) => ({ ...ref })),
    speakerTurnTag: {
      ...input.records.speakerTurnTag,
      review: {
        state: input.state,
        reviewedAt: input.reviewedAt,
      },
    },
    identitySignal: {
      ...input.records.identitySignal,
      updatedAt: input.reviewedAt,
      review: {
        state: input.state,
        reviewedAt: input.reviewedAt,
      },
      allowedUses: { ...input.identityAllowedUses },
    },
    transcriptSpeakerAnnotation: {
      ...input.records.transcriptSpeakerAnnotation,
      evidenceRefs: input.records.transcriptSpeakerAnnotation.evidenceRefs.map((ref) => ({
        ...ref,
      })),
      allowedUses: { ...input.annotationAllowedUses },
    },
    eventParticipation: input.records.eventParticipation
      ? {
          ...input.records.eventParticipation,
          evidenceRefs: input.records.eventParticipation.evidenceRefs.map((ref) => ({
            ...ref,
          })),
          supportingSignalIds: [...input.records.eventParticipation.supportingSignalIds],
          review: {
            state: input.state,
            reviewedAt: input.reviewedAt,
          },
        }
      : undefined,
  };
}

function buildReviewedUnknownClusterEventParticipation(input: {
  records: VoiceprintTurnRecords;
  clusterId: RecordId;
  eventId: RecordId;
  claim: string;
  reviewedAt: IsoTime;
}): EventParticipation {
  return {
    id: makeVoiceprintRecordId("vpevent", [
      input.eventId,
      input.records.speakerTurnTag.transcriptItemId,
      input.records.speakerTurnTag.result,
      input.records.identitySignal.id,
    ]),
    eventId: input.eventId,
    actor: { type: "unknown_cluster", clusterId: input.clusterId },
    role: "speaker",
    claim: input.claim,
    evidenceRefs: input.records.evidenceRefs.map((ref) => ({ ...ref })),
    supportingSignalIds: [input.records.identitySignal.id],
    confidence: input.records.identitySignal.confidence,
    review: {
      state: "confirmed",
      reviewedAt: input.reviewedAt,
    },
    allowedUses: {
      memoryPromotion: false,
      actionProposal: false,
      contextExport: false,
    },
  };
}

function annotationAllowedUsesForTerminalReview(
  state: Extract<ReviewState, "rejected" | "suppressed">,
): VoiceprintAnnotationAllowedUses {
  return {
    diagnostics: state === "rejected",
    transcriptDisplay: false,
    memoryPromotion: false,
    actionProposal: false,
    eventGraph: false,
    contextExport: false,
    templateLearning: false,
  };
}

function assertConsistentVoiceprintRecords(records: VoiceprintTurnRecords): void {
  if (records.speakerTurnTag.identitySignalId !== records.identitySignal.id) {
    throw new Error("Voiceprint review records have mismatched identity signal ids.");
  }
  if (records.transcriptSpeakerAnnotation.identitySignalId !== records.identitySignal.id) {
    throw new Error("Voiceprint review annotation has mismatched identity signal id.");
  }
  if (records.transcriptSpeakerAnnotation.speakerTurnTagId !== records.speakerTurnTag.id) {
    throw new Error("Voiceprint review annotation has mismatched speaker turn tag id.");
  }
  if (
    records.transcriptSpeakerAnnotation.sessionKey !== records.speakerTurnTag.sessionKey ||
    records.transcriptSpeakerAnnotation.transcriptItemId !==
      records.speakerTurnTag.transcriptItemId
  ) {
    throw new Error("Voiceprint review records have mismatched transcript joins.");
  }
}
