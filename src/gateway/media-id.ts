// =============================================================================
// Shared safe-ID format for media / capture identifiers.
//
// These ids become path segments under the media/vision roots, so they must
// match a conservative allow-list: a leading alnum/_/- (no leading dot), then
// up to 63 more chars of alnum plus `.` `_` `-` (`.` accommodates UUIDs and
// track markers like `c-<ts>.mic`). No path separators. Total length 1-64.
// =============================================================================

export const MEDIA_ID_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
