// Shared classification for Firestore errors.
//
// `isPermissionDeniedError` is a pure classifier — it does NOT suppress anything on
// its own. Callers decide how to react based on context.
//
// Why this matters: the global auth-recovery interceptor (see hooks/useAuthUnified.ts)
// treats ANY warn/error log that looks like a permission-denied as a sign of stale
// credentials and kicks off a token-refresh + listener-reattach recovery cycle. So a
// permission-denied that is actually EXPECTED (e.g. a feature-gated tenant-wide read
// the rules legitimately deny) must be logged at debug, or it will drive a continuous
// recovery loop.
//
// IMPORTANT: only classify a denial as benign when it is genuinely expected. A denial
// on something the caller should always be able to do (e.g. reading their OWN data)
// is a real regression and must stay loud (warn/error) so it isn't hidden as
// "no data". Callers therefore combine this check with scope/context before choosing
// a log level — see reminderHistoryService.logReminderPermissionDenied for the
// canonical example (quiet for an 'all users' denial, loud for a self-scoped one).

const PERMISSION_DENIED_MARKERS = [
  'missing or insufficient permissions',
  'insufficient permissions',
  'permission-denied',
];

export function isPermissionDeniedError(error: unknown): boolean {
  if (!error) return false;
  const errorAny = error as any;
  const code = (errorAny?.code || '').toString().toLowerCase();
  if (code === 'permission-denied') return true;
  const message = (typeof error === 'string' ? error : errorAny?.message || '').toString().toLowerCase();
  if (!message) return false;
  return PERMISSION_DENIED_MARKERS.some((marker) => message.includes(marker));
}
