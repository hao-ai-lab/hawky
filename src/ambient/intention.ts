// =============================================================================
// Intention primitive — canonical shapes for the ambient agent.
// Types + state-transition map only; no behavior beyond canTransition.
// =============================================================================

export type IntentionStrength = "hard" | "soft";
export type IntentionOrigin = "obvious" | "latent";
export type IntentionState = "pending_arm" | "armed" | "arm_failed" | "resolved" | "superseded" | "surfaced" | "suppressed";

export type TriggerWhen   = { kind: "when";   at?: string; relative?: string; window?: { start: string; end: string }; provenance?: "provided" | "inferred"; confidence?: number };
export type TriggerWhere  = { kind: "where";  place?: string; category?: string; provenance?: "provided" | "inferred"; confidence?: number };
export type TriggerWho    = { kind: "who";    entity?: string; scene?: string; provenance?: "provided" | "inferred"; confidence?: number };
export type TriggerManual = { kind: "manual"; provenance?: "provided" | "inferred"; confidence?: number };
export type TriggerTopic  = { kind: "topic";  topic: string; provenance?: "provided" | "inferred"; confidence?: number };
export type TriggerTerm   = TriggerWhen | TriggerWhere | TriggerWho | TriggerManual | TriggerTopic;

/** Composite predicate over trigger terms (conjunction over `all`). */
export interface TriggerPredicate {
  all?: TriggerTerm[];
}

/** First `when` term in a trigger predicate, or undefined. */
export function findWhenTerm(trigger: TriggerPredicate): TriggerWhen | undefined {
  return trigger.all?.find((t): t is TriggerWhen => t.kind === "when");
}

/** First `where` term carrying a named place, or undefined. */
export function findWhereTerm(trigger: TriggerPredicate): TriggerWhere | undefined {
  return trigger.all?.find((t): t is TriggerWhere => t.kind === "where" && !!t.place);
}

export interface IntentionEvidence {
  sessionKey?: string;
  spanRef?: string;
  ts: string;
}

export type Sensitivity = "public" | "private";

export interface Intention {
  id: string;
  content: string;
  trigger: TriggerPredicate;
  strength: IntentionStrength;
  origin: IntentionOrigin;
  state: IntentionState;
  evidence: IntentionEvidence;
  sensitivity: Sensitivity;
  consentScope?: string;
  confidence?: number;   // soft only
  createdAt: string;
  updatedAt: string;
}

// Legal transitions: pending_arm -> (armed | arm_failed | superseded);
// armed -> (surfaced | superseded | resolved | suppressed | arm_failed)  [resolved/suppressed: M9 satisfaction sweep]
// surfaced -> (resolved | armed | suppressed); suppressed -> [] (terminal)
// armed → arm_failed: location auth revocation during active monitoring (M8).
export const INTENTION_STATE_TRANSITIONS: Record<IntentionState, IntentionState[]> = {
  pending_arm: ["armed", "arm_failed", "superseded"],
  armed:       ["surfaced", "superseded", "resolved", "suppressed", "arm_failed"],
  arm_failed:  [],
  resolved:    [],
  superseded:  [],
  surfaced:    ["resolved", "armed", "suppressed"],
  suppressed:  [],
};

export function canTransition(from: IntentionState, to: IntentionState): boolean {
  return INTENTION_STATE_TRANSITIONS[from].includes(to);
}
