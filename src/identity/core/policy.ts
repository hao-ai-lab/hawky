import {
  makeIdentityAllowedUses,
  type IdentityAllowedUses,
  type IdentitySignalBase,
  type IdentitySubject,
  type ReviewState,
} from "./contracts.js";

export interface IdentityPolicyConsent {
  captureAllowed?: boolean;
  identityProcessingAllowed?: boolean;
  memoryPromotionAllowed?: boolean;
  actionProposalAllowed?: boolean;
  contextExportAllowed?: boolean;
  relationshipProposalAllowed?: boolean;
  diagnosticsAllowed?: boolean;
  transcriptDisplayAllowed?: boolean;
  profilePromotionAllowed?: boolean;
  templateLearningAllowed?: boolean;
  reason?: string;
}

export interface IdentityPolicyThresholds {
  ownerMemoryConfidence: number;
  confirmedPersonMemoryConfidence: number;
}

export const DEFAULT_IDENTITY_POLICY_THRESHOLDS: IdentityPolicyThresholds = {
  ownerMemoryConfidence: 0.9,
  confirmedPersonMemoryConfidence: 0.85,
};

// Frozen so the shared deny-all baseline can't be mutated by a consumer (it's a
// single shared object; an accidental write would corrupt every reader).
export const NO_IDENTITY_ALLOWED_USES: IdentityAllowedUses = Object.freeze(makeIdentityAllowedUses());

export function allowedUsesForIdentitySignal(input: {
  subject: IdentitySubject;
  reviewState?: ReviewState;
  confidence?: number;
  consent?: IdentityPolicyConsent;
  thresholds?: Partial<IdentityPolicyThresholds>;
}): IdentityAllowedUses {
  const consent = input.consent ?? {};
  if (consent.captureAllowed === false || consent.identityProcessingAllowed === false) {
    return makeIdentityAllowedUses();
  }

  const reviewState = input.reviewState ?? "unreviewed";
  const confidence = Number.isFinite(input.confidence) ? input.confidence! : 0;
  const thresholds = {
    ...DEFAULT_IDENTITY_POLICY_THRESHOLDS,
    ...input.thresholds,
  };

  const diagnostics = consent.diagnosticsAllowed !== false;
  const transcriptDisplay = consent.transcriptDisplayAllowed !== false;

  if (input.subject.type === "owner") {
    const strongOwner = reviewState === "confirmed" && confidence >= thresholds.ownerMemoryConfidence;
    return makeIdentityAllowedUses({
      diagnostics,
      tagSession: reviewState === "confirmed",
      transcriptDisplay: reviewState === "confirmed" && transcriptDisplay,
      eventGraph: reviewState === "confirmed",
      promoteMemory: strongOwner && consent.memoryPromotionAllowed === true,
      triggerAction: strongOwner && consent.actionProposalAllowed === true,
      templateLearning: strongOwner && consent.templateLearningAllowed === true,
    });
  }

  if (input.subject.type === "person") {
    const strongPerson =
      reviewState === "confirmed" && confidence >= thresholds.confirmedPersonMemoryConfidence;
    return makeIdentityAllowedUses({
      diagnostics,
      tagSession: reviewState === "confirmed",
      transcriptDisplay: reviewState === "confirmed" && transcriptDisplay,
      eventGraph: reviewState === "confirmed",
      promoteMemory: strongPerson && consent.memoryPromotionAllowed === true,
      exportContext: strongPerson && consent.contextExportAllowed === true,
      profilePromotion: false,
    });
  }

  if (
    reviewState === "confirmed" &&
    (input.subject.type === "person_candidate" || input.subject.type === "unknown_cluster")
  ) {
    return makeIdentityAllowedUses({
      diagnostics,
      transcriptDisplay,
      eventGraph: true,
      proposeRelationship: consent.relationshipProposalAllowed === true,
      profilePromotion: consent.profilePromotionAllowed === true,
    });
  }

  return makeIdentityAllowedUses({ diagnostics });
}

export function assertIdentitySignalAllowedUsesSafe(
  signal: IdentitySignalBase,
  thresholds: Partial<IdentityPolicyThresholds> = {},
): void {
  const limits = { ...DEFAULT_IDENTITY_POLICY_THRESHOLDS, ...thresholds };
  const confidence = Number.isFinite(signal.confidence) ? signal.confidence : 0;
  const confirmed = signal.review.state === "confirmed";

  // Strongly-gated, biometric-grade uses. templateLearning belongs here too: the
  // producer only ever grants it to a strong owner, so the safety invariant must
  // gate it (previously it was omitted — any subject could set it and pass).
  const sensitive =
    signal.allowedUses.promoteMemory ||
    signal.allowedUses.exportContext ||
    signal.allowedUses.triggerAction ||
    signal.allowedUses.templateLearning;

  if (sensitive) {
    // Owner: requires confirmed + ownerMemoryConfidence floor (the producer's
    // strongOwner gate). Person: confirmed + confirmedPersonMemoryConfidence.
    // Matching the producer's floors here closes the gap where a hand-built
    // confirmed-but-low-confidence signal could promote memory.
    const ownerOk =
      signal.subject.type === "owner" && confirmed && confidence >= limits.ownerMemoryConfidence;
    const personOk =
      signal.subject.type === "person" &&
      confirmed &&
      confidence >= limits.confirmedPersonMemoryConfidence;
    // templateLearning is owner-only in the producer; a person must not carry it.
    if (signal.allowedUses.templateLearning && signal.subject.type !== "owner") {
      throw new Error("Only a confirmed owner identity signal can learn biometric templates.");
    }
    if (!ownerOk && !personOk) {
      throw new Error(
        "Only confirmed owner or person identity signals above the memory-confidence floor can promote memory, export context, trigger actions, or learn templates.",
      );
    }
  }

  if (!signal.allowedUses.profilePromotion) {
    return;
  }

  if (
    confirmed &&
    (signal.subject.type === "person_candidate" || signal.subject.type === "unknown_cluster")
  ) {
    return;
  }

  throw new Error(
    "Only confirmed person candidates or unknown clusters can promote profiles.",
  );
}

export function identitySignalCanInfluenceMemory(signal: IdentitySignalBase): boolean {
  return signal.allowedUses.promoteMemory;
}

export function identitySignalCanTriggerAction(signal: IdentitySignalBase): boolean {
  return signal.allowedUses.triggerAction;
}

export function identitySignalCanExportContext(signal: IdentitySignalBase): boolean {
  return signal.allowedUses.exportContext;
}

export function intersectIdentityAllowedUses(
  left: IdentityAllowedUses,
  right: IdentityAllowedUses,
): IdentityAllowedUses {
  return makeIdentityAllowedUses({
    diagnostics: left.diagnostics && right.diagnostics,
    tagSession: left.tagSession && right.tagSession,
    transcriptDisplay: left.transcriptDisplay && right.transcriptDisplay,
    eventGraph: left.eventGraph && right.eventGraph,
    promoteMemory: left.promoteMemory && right.promoteMemory,
    proposeRelationship: left.proposeRelationship && right.proposeRelationship,
    exportContext: left.exportContext && right.exportContext,
    triggerAction: left.triggerAction && right.triggerAction,
    templateLearning: left.templateLearning && right.templateLearning,
    profilePromotion: left.profilePromotion && right.profilePromotion,
  });
}
