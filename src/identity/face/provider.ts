export type FaceProviderErrorCode =
  | "INVALID_REQUEST"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "NOT_IMPLEMENTED";

export type FaceProviderFailure = {
  ok: false;
  error: string;
  code?: FaceProviderErrorCode;
};

export interface FaceIndexProfile {
  id?: unknown;
  name?: unknown;
  created_at?: unknown;
  last_seen_at?: unknown;
  thumbnail?: unknown;
  embeddings?: unknown;
  embedding?: unknown;
  /**
   * Legacy DeepFace can still return stale person-shaped fields. Face providers
   * treat them as opaque compatibility payload; PersonService decides whether
   * any field may become person data.
   */
  [key: string]: unknown;
}

export interface FaceProviderRequestOptions {
  abortSignal?: AbortSignal;
}

export type FaceIdentifyFrameResult =
  | { ok: true; found: false }
  | {
      ok: true;
      found: true;
      /**
       * Compatibility payload from the legacy DeepFace index. PersonService
       * normalizes this into a person profile, candidate, or suppression result.
       */
      profile: FaceIndexProfile;
      similarity?: number;
    }
  | FaceProviderFailure;

export type FaceProfileListResult =
  | { ok: true; profiles: unknown[] }
  | FaceProviderFailure;

export type FaceProfileWriteResult =
  | { ok: true; profile: FaceIndexProfile }
  | FaceProviderFailure;

export type FaceIndexClearResult =
  | { ok: true; removed?: number }
  | FaceProviderFailure;

export interface FaceSignalProvider {
  identifyFrame(input: {
    imageBase64: string;
    sessionKey?: string;
    abortSignal?: AbortSignal;
  }): Promise<FaceIdentifyFrameResult>;

  listFaceProfiles(input?: FaceProviderRequestOptions): Promise<FaceProfileListResult>;

  enrollOrLinkTemplate(input: {
    imageBase64: string;
    label: string;
    profileId?: string | null;
    sessionKey?: string;
    abortSignal?: AbortSignal;
  }): Promise<FaceProfileWriteResult>;

  updateFaceProfileLabel(input: {
    profileId: string;
    label: string;
    abortSignal?: AbortSignal;
  }): Promise<FaceProfileWriteResult>;

  clearIndex?(input?: FaceProviderRequestOptions): Promise<FaceIndexClearResult>;
}