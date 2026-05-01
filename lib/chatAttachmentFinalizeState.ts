/**
 * Attachment finalization state helpers
 * 
 * Pure deterministic logic for managing attachment upload finalization
 * timeouts and eligibility checks.
 */

export interface PendingAttachment {
  tempId?: string;
  status?: string;
  [key: string]: any;
}

/**
 * Default delay (milliseconds) before a finalizing attachment is removed.
 * 
 * Allows time for animations to complete and state to stabilize before cleanup.
 */
export const ATTACHMENT_FINALIZE_CLEANUP_DELAY_MS = 1200;

/**
 * Determines if an attachment should be eligible for finalization cleanup.
 * 
 * An attachment is eligible for cleanup if:
 * 1. It exists (not null/undefined)
 * 2. Its status is exactly 'finalizing'
 * 
 * Returns true only if both conditions are met.
 */
export function shouldFinalizeAttachmentCleanup(
  attachment?: PendingAttachment | null
): boolean {
  if (!attachment) {
    return false;
  }

  return attachment.status === 'finalizing';
}

/**
 * Checks if an attachment entry exists in a collection.
 * 
 * Handles null/undefined safely.
 */
export function hasPendingAttachment(
  collection?: Map<string, PendingAttachment> | null,
  tempId?: string
): boolean {
  if (!collection || !tempId) {
    return false;
  }

  return collection.has(tempId);
}

/**
 * Resolves the appropriate cleanup delay for an attachment.
 * 
 * Uses provided delayMs if specified and valid (> 0), otherwise uses default.
 * Returns milliseconds to delay before cleanup.
 */
export function resolveChatAttachmentFinalizeDelayMs(
  delayMs?: number
): number {
  if (delayMs !== undefined && delayMs > 0) {
    return delayMs;
  }

  return ATTACHMENT_FINALIZE_CLEANUP_DELAY_MS;
}

/**
 * Validates timer map state before scheduling cleanup.
 * 
 * Ensures timer map exists and is writable.
 */
export function isChatAttachmentTimerMapValid(
  timerMap?: Map<string, ReturnType<typeof setTimeout>> | null
): boolean {
  return timerMap instanceof Map;
}

/**
 * Builds cleanup action plan for attachment removal.
 * 
 * Determines whether cleanup should proceed based on:
 * 1. Attachment exists
 * 2. Attachment status is 'finalizing'
 * 3. No other conditions block cleanup
 * 
 * Returns a plan object with shouldCleanup boolean and reason for diagnostics.
 */
export function resolveChatAttachmentCleanupPlan(
  attachment?: PendingAttachment | null
): { shouldCleanup: boolean; reason: string } {
  if (!attachment) {
    return { shouldCleanup: false, reason: 'attachment-not-found' };
  }

  if (attachment.status !== 'finalizing') {
    return { shouldCleanup: false, reason: 'status-not-finalizing' };
  }

  return { shouldCleanup: true, reason: 'ready' };
}
