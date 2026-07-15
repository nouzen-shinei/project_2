/**
 * Canonical device last-seen resolution.
 *
 * The Device Console read path (`deviceAdminService`) and the offline-device
 * prune maintenance job (`jobs/offlineDevicePrune`) MUST agree EXACTLY on when a
 * device was last seen, otherwise the console could show a device as "offline"
 * while the prune job disagrees about its age (or vice-versa). This module is
 * the single source of truth for that conversion — do NOT fork this logic into a
 * divergent resolver.
 */

/**
 * Resolve a Firestore `Timestamp` / `Date` / epoch-number / ISO string to epoch
 * milliseconds, or `null` when the value cannot be interpreted as a time.
 *
 * This mirrors the projection the Device Console list/detail reads apply when
 * serializing a raw device document's timestamp fields (`toEpochMs`): a finite
 * number is taken as-is, a string is parsed as an ISO date, a `Date`/Firestore
 * `Timestamp` is converted via `getTime()`/`toMillis()`/`toDate()`. Any
 * unparseable / non-finite input yields `null`.
 */
export function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const maybeToMillis = (value as { toMillis?: () => number }).toMillis;
  if (typeof maybeToMillis === 'function') {
    try {
      const ms = maybeToMillis.call(value);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  const maybeToDate = (value as { toDate?: () => Date }).toDate;
  if (typeof maybeToDate === 'function') {
    try {
      const ms = maybeToDate.call(value).getTime();
      return Number.isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve a device's last-seen epoch-ms, preferring the numeric `lastSeenMs`
 * companion when it is finite and otherwise interpreting the `lastSeen` field
 * (ISO string / Firestore `Timestamp` / `Date` / epoch number) via
 * {@link toEpochMs}.
 *
 * Returns `null` when NEITHER source yields a valid time. Callers MUST treat
 * `null` as "unknown last-seen": the console counts such a device as offline and
 * the prune job NEVER deletes it (a missing/malformed last-seen must not be
 * mistaken for a very old one).
 */
export function resolveDeviceLastSeenMs(device: {
  lastSeen?: unknown;
  lastSeenMs?: unknown;
}): number | null {
  if (typeof device.lastSeenMs === 'number' && Number.isFinite(device.lastSeenMs)) {
    return device.lastSeenMs;
  }
  return toEpochMs(device.lastSeen);
}
