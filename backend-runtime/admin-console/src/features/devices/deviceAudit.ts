import type { AuditEntryRecord } from '../../lib/apiClient';

/**
 * Shared presentation helpers for `deviceAuditLogs` entries surfaced by the
 * tenant History panel (Requirement 13) and the per-device activity timeline
 * (Requirement 19). History and timeline read the same `AuditEntryRecord` shape,
 * so the action labels, actor attribution, target summary, and timestamp
 * formatting live here and are reused by both to stay consistent.
 */

/** Human-readable labels for the audit `action` enum written by the backend. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  force_logout: 'Force logout',
  force_logout_all: 'Force logout (all devices)',
  ban: 'Device banned',
  unban: 'Ban removed',
  delete: 'Device deleted',
  restore: 'Device restored',
  permanent_delete: 'Permanent delete',
  notify: 'Notification sent',
};

/** Map an audit `action` code to a display label, humanising any unknown code. */
export function formatActionLabel(action: string): string {
  const known = AUDIT_ACTION_LABELS[action];
  if (known) return known;
  const trimmed = (action || '').trim();
  if (!trimmed) return 'Unknown action';
  // Humanise an unexpected snake_case code, e.g. `some_new_action` → `Some new action`.
  const spaced = trimmed.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Indication shown for entries with no recorded actor (Requirements 13, 19.3). */
export const UNATTRIBUTED_LABEL = 'Unattributed — no administrator recorded';

/**
 * Resolve the acting-administrator attribution for an entry. Prefers the recorded
 * actor name, then the actor email, then the actor id. `attributed` is false when
 * none is present, so callers can render the "unattributed" indication
 * (Requirements 13.2, 19.2, 19.3).
 */
export function describeActor(entry: AuditEntryRecord): { attributed: boolean; label: string } {
  const name = entry.actorName?.trim();
  const email = entry.actorEmail?.trim();
  const id = entry.actorId?.trim();
  const label = name || email || id;
  if (label) return { attributed: true, label };
  return { attributed: false, label: UNATTRIBUTED_LABEL };
}

/**
 * Summarise the target of an audit entry: the target device id and/or the target
 * user email, whichever are present. Returns `null` when neither is recorded.
 */
export function describeTarget(entry: AuditEntryRecord): string | null {
  const device = entry.targetDeviceId?.trim();
  const user = entry.targetUserEmail?.trim();
  if (device && user) return `${device} · ${user}`;
  return device || user || null;
}

/**
 * Format an audit entry's action time for display including date, time, and time
 * zone (Requirement 13.2). Prefers the ISO 8601 `createdAt`, falling back to the
 * `actionTimeMs` epoch companion. Returns `null` when no valid time is present.
 */
export function formatAuditTimestamp(entry: AuditEntryRecord): string | null {
  let date: Date | null = null;
  if (entry.createdAt) {
    const parsed = new Date(entry.createdAt);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date && typeof entry.actionTimeMs === 'number' && Number.isFinite(entry.actionTimeMs)) {
    const parsed = new Date(entry.actionTimeMs);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) return null;
  // `timeStyle: 'long'` renders the time zone name alongside the date and time.
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' });
}
