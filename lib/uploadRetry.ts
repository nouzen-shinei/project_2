/**
 * Shared retry policy for backend file uploads.
 *
 * A transient blip (a dropped/rese­t connection, a gateway 502/503/504) shouldn't
 * fail an otherwise-fine upload. This module centralizes the single policy used by
 * every upload transport (`services/backendStorageUploadService.ts` for
 * receipt/notice/student/logo, and `chatService.uploadProfilePicture` for the
 * user's avatar) so retry behavior is consistent and defined in one place.
 *
 * Only genuinely transient failures are retried; deterministic errors (quota 409,
 * too-large 413, auth 401, validation 400) are handled by the callers and fail
 * fast. Note: retrying a POST can, in the rare "server saved but the response was
 * lost" case, create a duplicate stored object for callers that use a timestamped
 * object path (receipt/notice/student). Profile-picture/logo paths are
 * deterministic (overwrite), so they never orphan. This is an accepted trade-off:
 * transient-failure resilience is worth far more than a rare, quota-only orphan.
 */

/** 1 initial attempt + up to 2 retries. */
export const UPLOAD_MAX_ATTEMPTS = 3;

/** Gateway/availability statuses worth retrying (never quota/auth/validation). */
export function isTransientUploadStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** Exponential backoff (400ms, 800ms, …) capped at 4s, plus up to 250ms jitter. */
export function uploadRetryBackoffMs(attempt: number): number {
  return Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

/** Await a delay (used between retry attempts). */
export const uploadRetryDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
