// =============================================================================
// Modes — scaffolding for the (deferred) latent-intention path (§5).
//
// Three detents on one dial.  At this stage, changing mode changes ONLY
// whether latent intention is enabled — no other settings are affected.
// =============================================================================

export type Mode = "quiet" | "ambient" | "directive";

export interface ModePolicy {
  latentIntentionEnabled: boolean;
}

// =============================================================================
// Presets
// =============================================================================

export const MODE_PRESETS: Record<Mode, ModePolicy> = {
  quiet:     { latentIntentionEnabled: false },
  ambient:   { latentIntentionEnabled: true },
  directive: { latentIntentionEnabled: true },
};

/** Return the policy for the given mode. */
export function projectMode(mode: Mode): ModePolicy {
  return MODE_PRESETS[mode];
}
