/**
 * Device Admin service (Stage 1 — backend).
 *
 * Home of the consolidated, server-side Device Console logic. This module is
 * grown incrementally by later tasks (search/filter/sort helpers, validation,
 * tenant-scoping, audit persistence, and the force-logout/ban/delete/notify
 * orchestrators). To keep it testable, the pure, input-varying helpers are kept
 * free of Firestore/I/O so they can be exercised with property-based tests.
 *
 * This first slice defines:
 *  - `DeviceAdminRecord`: the projected device read-model reconciled with the
 *    `UserDevice` type in `services/deviceTrackingService.ts` (timestamps are
 *    serialized to ISO strings at the API boundary, mirroring the existing
 *    `POST /admin/tenants/user-devices` projection).
 *  - `classifyOnline`: the 300-second (5-minute) online-window classifier
 *    (Requirement 1.6).
 *  - `computeCounts`: total/online/offline counts guaranteeing
 *    `online + offline === total` (Requirements 1.3, 1.8).
 */

import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { matchesTenantDevice, type TenantTaggedDocument } from './tenantDeviceFilter';
import { getFirestore } from './firebaseAdmin';
import { toEpochMs, resolveDeviceLastSeenMs } from './lib/deviceLastSeen';
import { sendExpoMessages, type ExpoPushMessage, type SendExpoMessagesResult } from './pushUtils';
import {
  sendWebPushNotification,
  sanitizeWebPushSubscription,
  type WebPushSubscriptionShape,
} from './webPush';

// ---------------------------------------------------------------------------
// Shared device types
// ---------------------------------------------------------------------------

/** Device form factor (mirrors `UserDevice.deviceType`). */
export type DeviceType = 'mobile' | 'web' | 'tablet';

/** Logout classification (mirrors `UserDevice.logoutType`). */
export type DeviceLogoutType = 'manual' | 'forced' | 'auto';

/** Expo push token sync status (mirrors `UserDevice.pushTokenStatus`). */
export type DevicePushTokenStatus = 'synced' | 'missing' | 'requested' | 'unknown';

/** Web push subscription status (mirrors `UserDevice.webPushStatus`). */
export type DeviceWebPushStatus =
  | 'subscribed'
  | 'unsubscribed'
  | 'unsupported'
  | 'permission_denied'
  | 'sync_required'
  | 'error';

/**
 * Tenant membership summary as stored on a device document. Kept structurally
 * loose (role/status as strings) because the backend does not import the
 * client's `@/types` role/status unions; matches `tenantDeviceFilter`.
 */
export interface DeviceTenantMembership {
  tenantId: string;
  role?: string;
  status?: string;
}

/** Web push subscription shape (mirrors `UserDevice.webPushSubscription`). */
export interface DeviceWebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Projected device record surfaced by the Device Admin API. This is the safe,
 * console-facing subset of the on-device `UserDevice` document. Field names are
 * kept identical to `UserDevice` so the projection maps one-to-one; timestamp
 * fields (`lastSeen`, `deletedAt`, `restoredAt`, `forcedLogoutAt`) are
 * serialized to ISO 8601 strings at the API boundary, and `*Ms` epoch-ms
 * companions are exposed where deterministic ordering/classification matters.
 */
export interface DeviceAdminRecord {
  // Identity
  deviceId: string;
  deviceType?: DeviceType;

  // Hardware / model metadata
  deviceName?: string;
  modelName?: string;
  manufacturer?: string;
  brand?: string;

  // Platform / OS metadata
  platformOS?: string;
  osName?: string;
  osVersion?: string;

  // Browser metadata (web only)
  browserName?: string;
  browserVersion?: string;
  userAgent?: string;

  // Network metadata
  ipAddress?: string;
  networkType?: string;
  carrierName?: string;
  countryCode?: string;

  // Presence / activity
  lastSeen?: string | null; // ISO 8601 (serialized from Firestore Timestamp)
  lastSeenMs?: number | null; // Epoch ms companion for deterministic ordering
  isOnline?: boolean; // Client-reported; the console recomputes via the 300s window
  sessionActive?: boolean;
  lastActivityType?: string;
  logoutType?: DeviceLogoutType;

  // Soft-delete provenance
  isDeleted?: boolean;
  deletedAt?: string | null; // ISO 8601
  deletedBy?: string;
  deletedByName?: string;
  deletionReason?: string;
  isRestored?: boolean;
  restoredAt?: string | null; // ISO 8601

  // Force-logout provenance
  forcedLogoutBy?: string;
  forcedLogoutByName?: string;
  forcedLogoutAt?: string | null; // ISO 8601
  forcedLogoutReason?: string;
  logoutSignal?: boolean; // Set true on force-logout / delete

  // Ban state
  // Whether the device currently has an active hard `Device_Ban`. Mirrors
  // `UserDevice.isHardBanned`; populated by the list endpoint from the
  // `device_bans` collection so the pure `matchesFilter`/`isInactiveDevice`
  // helpers can reason about ban state without touching Firestore.
  isHardBanned?: boolean;

  // Tenant scoping
  tenantIds?: string[];
  activeTenantId?: string | null;
  lastTenantId?: string | null;
  tenantMemberships?: DeviceTenantMembership[];

  // Owner attribution (derived from the parent `user_devices/{email}` doc)
  ownerEmail?: string | null;
  ownerDisplayName?: string | null;

  // Push targeting
  expoPushToken?: string;
  webPushSubscription?: DeviceWebPushSubscription;
  pushTokenStatus?: DevicePushTokenStatus;
  webPushStatus?: DeviceWebPushStatus;
}

/** Total / online / offline device counts for a tenant. */
export interface DeviceCounts {
  total: number;
  online: number;
  offline: number;
}

// ---------------------------------------------------------------------------
// Online classification & counts (pure helpers)
// ---------------------------------------------------------------------------

/**
 * The Device Console online-window: a device is online when its last-seen time
 * is within the last 5 minutes (300 seconds) — Requirement 1.6. This is
 * intentionally distinct from the on-device runtime's own 2-minute heartbeat
 * freshness window, which is left unchanged.
 */
export const DEFAULT_ONLINE_WINDOW_MS = 300_000;

/**
 * Classify a device as online iff its last-seen time is within `windowMs` of
 * `now` — i.e. `nowMs - lastSeenMs <= windowMs` (Requirement 1.6).
 *
 * A missing or invalid last-seen value (non-finite, e.g. `NaN`/`Infinity`) is
 * treated as offline. Pure: no I/O, deterministic in its inputs.
 *
 * @param lastSeenMs Epoch milliseconds of the device's last-seen time.
 * @param nowMs Epoch milliseconds of the current reference time.
 * @param windowMs Freshness window in ms (defaults to the 300s console window).
 */
export function classifyOnline(
  lastSeenMs: number,
  nowMs: number,
  windowMs: number = DEFAULT_ONLINE_WINDOW_MS
): boolean {
  if (!Number.isFinite(lastSeenMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return nowMs - lastSeenMs <= windowMs;
}

/**
 * Resolve a device's last-seen epoch-ms, preferring the numeric `lastSeenMs`
 * companion and falling back to parsing the `lastSeen` field. Returns `NaN`
 * when neither yields a valid time (so callers treat it as offline).
 *
 * Delegates to the shared {@link resolveDeviceLastSeenMs} (the single source of
 * truth also used by the offline-device prune job) and normalizes its `null`
 * "unknown" result to `NaN` for the pure `classifyOnline` window comparison.
 */
function resolveLastSeenMs(device: Pick<DeviceAdminRecord, 'lastSeen' | 'lastSeenMs'>): number {
  const ms = resolveDeviceLastSeenMs(device);
  return ms === null ? Number.NaN : ms;
}

/**
 * Compute total/online/offline counts for a set of devices at reference time
 * `nowMs`, using the 300-second online window (Requirement 1.6).
 *
 * A soft-deleted (`isDeleted === true`) or hard-banned (`isHardBanned === true`)
 * device is NEVER counted online — such a device cannot hold a live session, so
 * counting a stale-but-recent `lastSeen` as "online" would be misleading. It
 * instead counts toward `offline` (and `total`). The pure `classifyOnline`
 * helper is left untouched (lastSeen-only, Requirement 1.6); the deleted/banned
 * exclusion is applied here, where the full device records are available.
 *
 * Guarantees the partition invariant `online + offline === total` for any input
 * (Requirements 1.3, 1.8), and returns `{ total: 0, online: 0, offline: 0 }`
 * for an empty input. Pure: no I/O, deterministic in its inputs.
 */
export function computeCounts(
  devices: ReadonlyArray<
    Pick<DeviceAdminRecord, 'lastSeen' | 'lastSeenMs' | 'isDeleted' | 'isHardBanned'>
  >,
  nowMs: number
): DeviceCounts {
  const total = devices.length;
  let online = 0;
  for (const device of devices) {
    // A deleted or hard-banned device can have no live session — never online.
    if (device.isDeleted === true || device.isHardBanned === true) {
      continue;
    }
    if (classifyOnline(resolveLastSeenMs(device), nowMs)) {
      online += 1;
    }
  }
  return { total, online, offline: total - online };
}

// ---------------------------------------------------------------------------
// Search / filter / sort / group (pure helpers)
// ---------------------------------------------------------------------------
//
// These helpers reproduce the exact search/filter/sort/group semantics of the
// (now-retired) client console (`components/AdminNotificationCenter.tsx`) so the
// migrated Device Console behaves identically, with two deliberate
// reconciliations documented inline:
//   1. Online/offline are computed with the 300s console window via
//      `classifyOnline` (Requirement 1.6) so the online/offline filters agree
//      with the counts produced by `computeCounts`.
//   2. Ban state is read from the projected `isHardBanned` flag (populated by
//      the list endpoint) instead of the client's async ban-info cache, keeping
//      these helpers pure and free of Firestore/I/O.

/**
 * The ten device filters surfaced by the Device Console (Requirement 5.1).
 * `all` matches everything; the remainder narrow by presence, form factor,
 * lifecycle state, or ban state.
 */
export type DeviceFilter =
  | 'all'
  | 'online'
  | 'offline'
  | 'web'
  | 'mobile'
  | 'tablet'
  | 'deleted'
  | 'logged_out'
  | 'force_logged_out'
  | 'hard_banned';

/** The sort options offered by the Device Console (Requirement 5.3). */
export type DeviceSort = 'name' | 'lastSeen' | 'deviceType' | 'status';

/**
 * A single owner-email group in the grouped device view. `ownerEmail` is the
 * (trimmed) owner email, or `null` for the distinct final group of devices that
 * have no owner email (Requirement 5.7).
 */
export interface DeviceGroup {
  ownerEmail: string | null;
  devices: DeviceAdminRecord[];
}

/**
 * The grouped device view: an ordered list of owner-email groups. Groups are
 * ordered by owner email ascending (A→Z), with the no-owner-email group placed
 * last (Requirement 5.6, 5.7).
 */
export type GroupedDevices = DeviceGroup[];

/**
 * Case-insensitive "contains" search across a device's user-facing text fields
 * (Requirements 4.1, 4.2, 4.3).
 *
 * The term is trimmed and lowercased first; an empty or whitespace-only term
 * matches every device (returns `true`). Otherwise the device matches iff at
 * least one of these fields contains the normalized term: `deviceName`,
 * `deviceType`, `browserName`, `osName`, `modelName`, `ipAddress`,
 * `ownerEmail`, `ownerDisplayName`. Pure: no I/O, deterministic in its inputs.
 */
export function matchesSearch(device: DeviceAdminRecord, term: string): boolean {
  const normalized = term.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  const fields: Array<string | null | undefined> = [
    device.deviceName,
    device.deviceType,
    device.browserName,
    device.osName,
    device.modelName,
    device.ipAddress,
    device.ownerEmail,
    device.ownerDisplayName,
  ];
  return fields.some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(normalized)
  );
}

/**
 * Broad "logged out" predicate used by hide-inactive and status ordering.
 * A device counts as logged out when its session is explicitly inactive, its
 * `logoutType` is any logout kind (manual/forced/auto), or its
 * `lastActivityType` records a logout — mirroring the on-device runtime's
 * `DeviceTrackingService.isDeviceLoggedOut`.
 */
function isBroadlyLoggedOut(device: DeviceAdminRecord): boolean {
  if (device.sessionActive === false) {
    return true;
  }
  if (
    device.logoutType === 'manual' ||
    device.logoutType === 'forced' ||
    device.logoutType === 'auto'
  ) {
    return true;
  }
  return device.lastActivityType === 'logout' || device.lastActivityType === 'forced_logout';
}

/**
 * Narrow "logged out" predicate for the `logged_out` filter: a manual or
 * automatic (non-forced) logout — `logoutType` of `manual`/`auto` or a
 * `lastActivityType` of `logout` (Requirement 5.1).
 */
function isManualOrAutoLoggedOut(device: DeviceAdminRecord): boolean {
  if (device.logoutType === 'manual' || device.logoutType === 'auto') {
    return true;
  }
  return device.lastActivityType === 'logout';
}

/**
 * "Force logged out" predicate for the `force_logged_out` filter: a forced
 * logout indicated by `logoutType === 'forced'`, `lastActivityType ===
 * 'forced_logout'`, or force-logout provenance (`forcedLogoutBy` /
 * `forcedLogoutAt` set) — Requirement 5.1.
 */
function isForceLoggedOut(device: DeviceAdminRecord): boolean {
  if (device.logoutType === 'forced') {
    return true;
  }
  if (device.lastActivityType === 'forced_logout') {
    return true;
  }
  if (typeof device.forcedLogoutBy === 'string' && device.forcedLogoutBy.trim().length > 0) {
    return true;
  }
  if (typeof device.forcedLogoutAt === 'string' && device.forcedLogoutAt.trim().length > 0) {
    return true;
  }
  return false;
}

/**
 * "Inactive" predicate backing the "Hide inactive devices" toggle
 * (Requirement 5.5): a device is inactive when it is deleted, hard banned, or
 * (broadly) logged out. The list endpoint applies this to exclude inactive
 * devices when the toggle is enabled. Pure: no I/O, deterministic in its inputs.
 */
export function isInactiveDevice(device: DeviceAdminRecord): boolean {
  return (
    device.isDeleted === true ||
    device.isHardBanned === true ||
    isBroadlyLoggedOut(device)
  );
}

/**
 * Decide whether a device matches the selected filter at reference time
 * `nowMs` (Requirement 5.1). Online/offline use the 300-second console window
 * via `classifyOnline` AND exclude deleted/hard-banned devices from `online`
 * (they match `offline`) so the filter agrees with the online/offline split
 * produced by `computeCounts`; `web`/`mobile`/`tablet` match `deviceType`;
 * `deleted`/`hard_banned` read the lifecycle flags; `logged_out` is a
 * manual/auto logout and `force_logged_out` is a forced logout (see the
 * predicates above). Pure: no I/O, deterministic in its inputs.
 */
export function matchesFilter(
  device: DeviceAdminRecord,
  filter: DeviceFilter,
  nowMs: number
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'online':
      // A deleted / hard-banned device can hold no live session, so it never
      // matches `online` (it matches `offline`) — keeping this filter consistent
      // with the online/offline split produced by `computeCounts`.
      return (
        device.isDeleted !== true &&
        device.isHardBanned !== true &&
        classifyOnline(resolveLastSeenMs(device), nowMs)
      );
    case 'offline':
      return !(
        device.isDeleted !== true &&
        device.isHardBanned !== true &&
        classifyOnline(resolveLastSeenMs(device), nowMs)
      );
    case 'web':
      return device.deviceType === 'web';
    case 'mobile':
      return device.deviceType === 'mobile';
    case 'tablet':
      return device.deviceType === 'tablet';
    case 'deleted':
      return device.isDeleted === true;
    case 'logged_out':
      return isManualOrAutoLoggedOut(device);
    case 'force_logged_out':
      return isForceLoggedOut(device);
    case 'hard_banned':
      return device.isHardBanned === true;
    default: {
      // Exhaustiveness guard: adding a new filter without handling it here is a
      // compile-time error.
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

/**
 * Deterministic status ordering used by the `status` sort. Lower rank sorts
 * first (ascending), giving the documented order:
 *
 *   0 online → 1 offline → 2 logged out → 3 hard banned → 4 deleted
 *
 * A device is classified by the first matching state in that precedence: a
 * deleted device ranks last regardless of other flags, then hard banned, then
 * (broadly) logged out, and finally the online/offline split. When `nowMs` is
 * supplied the online/offline split is recomputed with the 300s window via
 * `classifyOnline`; otherwise it falls back to the record's stored `isOnline`
 * flag so the helper stays pure and deterministic without a clock.
 */
function deviceStatusRank(device: DeviceAdminRecord, nowMs?: number): number {
  if (device.isDeleted === true) {
    return 4;
  }
  if (device.isHardBanned === true) {
    return 3;
  }
  if (isBroadlyLoggedOut(device)) {
    return 2;
  }
  const online =
    typeof nowMs === 'number'
      ? classifyOnline(resolveLastSeenMs(device), nowMs)
      : device.isOnline === true;
  return online ? 0 : 1;
}

/**
 * Last-seen epoch-ms for ordering, treating an unknown/invalid last-seen as the
 * oldest possible time so such devices sort last under "most-recent-first".
 */
function lastSeenForOrdering(device: DeviceAdminRecord): number {
  const ms = resolveLastSeenMs(device);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Within-group comparator for the selected sort option. `name`, `deviceType`,
 * and `status` sort ascending (A→Z / low-rank-first); `lastSeen` sorts
 * most-recent-first. All options break ties by last-seen most-recent-first,
 * then by `deviceId` for a fully deterministic (stable) total order
 * (Requirement 5.3).
 */
function compareWithinGroup(
  a: DeviceAdminRecord,
  b: DeviceAdminRecord,
  sort: DeviceSort,
  nowMs?: number
): number {
  let primary = 0;
  switch (sort) {
    case 'name':
      primary = (a.deviceName ?? '').localeCompare(b.deviceName ?? '');
      break;
    case 'deviceType':
      primary = (a.deviceType ?? '').localeCompare(b.deviceType ?? '');
      break;
    case 'status':
      primary = deviceStatusRank(a, nowMs) - deviceStatusRank(b, nowMs);
      break;
    case 'lastSeen':
    default:
      primary = lastSeenForOrdering(b) - lastSeenForOrdering(a); // most recent first
      break;
  }
  if (primary !== 0) {
    return primary;
  }
  // Tie-break 1: last-seen most-recent-first.
  const bySeen = lastSeenForOrdering(b) - lastSeenForOrdering(a);
  if (bySeen !== 0) {
    return bySeen;
  }
  // Tie-break 2: deviceId, for a fully deterministic order across equal keys.
  return (a.deviceId ?? '').localeCompare(b.deviceId ?? '');
}

/** Trim an owner email, mapping missing/blank values to `null`. */
function normalizeOwnerEmail(ownerEmail: string | null | undefined): string | null {
  if (typeof ownerEmail !== 'string') {
    return null;
  }
  const trimmed = ownerEmail.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Group devices by owner email (A→Z) and sort within each group by the selected
 * option (Requirements 5.2, 5.3, 5.6, 5.7).
 *
 * Groups are ordered by owner email ascending; devices with no owner email are
 * collected into a distinct final group with `ownerEmail: null`. Within every
 * group devices are ordered by `compareWithinGroup`. The optional `nowMs` is
 * only consulted by the `status` sort to recompute online/offline with the
 * 300s window; when omitted, `status` falls back to the stored `isOnline` flag.
 *
 * Pure and deterministic: the same inputs always yield the same grouping and
 * ordering (stable across repeated calls).
 */
export function sortAndGroup(
  devices: ReadonlyArray<DeviceAdminRecord>,
  sort: DeviceSort,
  nowMs?: number
): GroupedDevices {
  const groups = new Map<string, DeviceAdminRecord[]>();
  const noOwner: DeviceAdminRecord[] = [];

  for (const device of devices) {
    const email = normalizeOwnerEmail(device.ownerEmail);
    if (email === null) {
      noOwner.push(device);
      continue;
    }
    const existing = groups.get(email);
    if (existing) {
      existing.push(device);
    } else {
      groups.set(email, [device]);
    }
  }

  const orderedEmails = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  const result: GroupedDevices = orderedEmails.map((email) => ({
    ownerEmail: email,
    devices: [...groups.get(email)!].sort((a, b) => compareWithinGroup(a, b, sort, nowMs)),
  }));

  if (noOwner.length > 0) {
    result.push({
      ownerEmail: null,
      devices: [...noOwner].sort((a, b) => compareWithinGroup(a, b, sort, nowMs)),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Result-set pagination (pure helpers)
// ---------------------------------------------------------------------------
//
// Recommendation #2 — real device-list pagination.
//
// The list endpoint computes EXACT total/online/offline counts (Req 1.3, 1.8),
// an 8-field substring search (Req 4), and owner-grouping sort (Req 5.2, 5.3,
// 5.6, 5.7). Each of those inherently needs the FULL tenant device set in
// memory, so a true datastore cursor — which would truncate the scan to a page
// — is incompatible with them. We therefore paginate the RETURNED, already
// deterministically-ordered result array with an opaque cursor while leaving
// counts/search/filter/sort computed over the full set exactly as before.
//
// TRADEOFF: every page still scans the whole tenant device set, so the read
// cost is O(tenant devices) per page rather than O(limit). This is acceptable
// for an admin console (bounded tenants, infrequent calls) and keeps counts
// exact. The future path to genuinely read-bounded pagination is an external
// search index (Algolia / Typesense) plus precomputed aggregate counters, which
// would let a page and the counts be served without loading the full set.
//
// KNOWN CAVEAT: the cursor is an offset into a freshly-recomputed ordered
// result, so a concurrent mutation (a device added/removed between two page
// requests) can shift rows by one and cause a row to be skipped or repeated
// across pages. This is acceptable for an admin console — the counts are
// recomputed on every call and the operator can refresh — and it is more robust
// than a keyset boundary, which would not survive re-sorting under a different
// sort option.

/** Default device-list page size applied when a caller omits `limit`. */
export const DEFAULT_DEVICE_LIST_LIMIT = 100;

/** Hard upper bound on a single device-list page (request-validation cap). */
export const MAX_DEVICE_LIST_LIMIT = 500;

/**
 * Encode a non-negative integer offset into an opaque, URL-safe cursor. The
 * offset is serialized to its decimal string then base64url-encoded so the
 * token carries no meaning to the client (they only ever echo it back).
 */
function encodeDeviceCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/**
 * Decode an opaque device-list cursor back into a non-negative integer offset.
 * Anything invalid — absent, blank, not base64url, or not a canonical
 * non-negative integer — decodes to 0 (the first page), so a garbage cursor
 * degrades gracefully rather than throwing. Pure: no I/O.
 */
function decodeDeviceCursor(cursor: string | undefined): number {
  if (typeof cursor !== 'string') {
    return 0;
  }
  const trimmed = cursor.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  // `Buffer.from(_, 'base64url')` never throws — it ignores non-alphabet chars —
  // so we validate the DECODED payload is a canonical non-negative integer.
  const decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) {
    return 0;
  }
  const parsed = Number(decoded);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

/**
 * Paginate an already-ordered device result with an opaque offset cursor
 * (Recommendation #2).
 *
 * `cursor` decodes to a non-negative integer offset (absent/blank/invalid => 0),
 * clamped into `[0, ordered.length]`. `limit` is clamped to
 * `[1, MAX_DEVICE_LIST_LIMIT]`; a non-positive / non-finite limit falls back to
 * `DEFAULT_DEVICE_LIST_LIMIT` so a single page is always well-bounded. Returns
 * the `page` slice `[offset, offset + limit)`, `hasMore` (whether any rows
 * remain past this page), and `nextCursor` — the opaque cursor for the next
 * page, present iff `hasMore`.
 *
 * Pure: no I/O, deterministic in its inputs. This helper ONLY slices the
 * ordered result; the caller is responsible for computing counts/search/filter/
 * sort over the FULL set (see the module comment for the read-cost tradeoff).
 */
export function paginateDevices(
  ordered: ReadonlyArray<DeviceAdminRecord>,
  cursor: string | undefined,
  limit: number
): { page: DeviceAdminRecord[]; hasMore: boolean; nextCursor?: string } {
  const flooredLimit = Number.isFinite(limit) ? Math.floor(limit) : Number.NaN;
  const safeLimit =
    Number.isInteger(flooredLimit) && flooredLimit > 0
      ? Math.min(flooredLimit, MAX_DEVICE_LIST_LIMIT)
      : DEFAULT_DEVICE_LIST_LIMIT;

  const rawOffset = decodeDeviceCursor(cursor);
  const offset = Math.min(Math.max(rawOffset, 0), ordered.length);

  const page = ordered.slice(offset, offset + safeLimit);
  const hasMore = offset + safeLimit < ordered.length;
  const nextCursor = hasMore ? encodeDeviceCursor(offset + safeLimit) : undefined;

  return { page, hasMore, nextCursor };
}

// ---------------------------------------------------------------------------
// Input validation (pure helpers)
// ---------------------------------------------------------------------------
//
// These helpers back the request-validation layer of the Device Admin API
// (Requirements 8.1, 8.4, 8.8, 9.2, 10.2, 12.1, 12.4, 12.6, 14.2) and design
// Property 15 ("input validation rejects invalid requests with no side
// effects"). They are intentionally pure — no Firestore, no I/O, no throwing —
// so routes can branch on the result before performing any mutation, and so
// task 2.2's property test can exercise them across generated inputs. On
// success each returns the normalized (trimmed) value; on failure it returns a
// descriptive, human-readable error string.

/**
 * Discriminated-union result returned by every validation helper. `ok: true`
 * carries the normalized `value`; `ok: false` carries a human-readable `error`.
 * Using a result type (instead of throwing) keeps the helpers pure and lets
 * callers reject a request without side effects.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Default reason length bounds (1–500 chars after trimming). */
export const DEFAULT_REASON_MIN = 1;
export const DEFAULT_REASON_MAX = 500;

/** Notification title length bound (1–100 chars after trimming) — Req 12.1. */
export const NOTIFICATION_TITLE_MAX = 100;

/** Notification message length bound (1–500 chars after trimming) — Req 12.4. */
export const NOTIFICATION_MESSAGE_MAX = 500;

/** Default maximum number of notification / bulk targets — Req 12.6, 14.2. */
export const DEFAULT_MAX_TARGETS = 500;

/** A single notification / bulk-action recipient. */
export interface DeviceTarget {
  email: string;
  deviceId: string;
}

/**
 * Shared trimmed-length validator for a bounded free-text field. Rejects
 * non-strings, values that are empty/whitespace-only or under `min`, and values
 * over `max` (all measured after trimming). Returns the trimmed value on
 * success. Pure: no I/O, deterministic in its inputs.
 */
function validateBoundedText(
  value: unknown,
  fieldName: string,
  min: number,
  max: number
): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, error: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    const error =
      min <= 1
        ? `${fieldName} must not be empty or whitespace-only`
        : `${fieldName} must be at least ${min} characters after trimming`;
    return { ok: false, error };
  }
  if (trimmed.length > max) {
    return {
      ok: false,
      error: `${fieldName} must be at most ${max} characters after trimming`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate a destructive-action reason (Requirements 8.1, 8.4, 9.2, 10.2).
 *
 * Defaults to a 1–500 character bound (overridable via `opts`). Trims first,
 * then rejects non-strings, empty/whitespace-only values, values under `min`,
 * and values over `max`, each with a descriptive error. On success returns the
 * trimmed reason. Pure: no I/O, deterministic in its inputs.
 */
export function validateReason(
  reason: unknown,
  opts?: { min?: number; max?: number }
): ValidationResult<string> {
  const min = opts?.min ?? DEFAULT_REASON_MIN;
  const max = opts?.max ?? DEFAULT_REASON_MAX;
  return validateBoundedText(reason, 'reason', min, max);
}

/**
 * Validate an optional ban expiration against the creation time
 * (Requirements 8.8, 14.2 support).
 *
 * `expiresAt` is optional: `null`/`undefined` yields `{ ok: true, value: null }`
 * (no expiration). When provided it must be either an ISO 8601 datetime string
 * or an epoch-millisecond number that parses to a time STRICTLY GREATER THAN
 * `createdAtMs`; otherwise the request is rejected. Returns the parsed epoch-ms
 * on success. Pure: no I/O, deterministic in its inputs.
 */
export function validateExpiration(
  expiresAt: unknown,
  createdAtMs: number
): ValidationResult<number | null> {
  if (expiresAt === null || expiresAt === undefined) {
    return { ok: true, value: null };
  }
  if (!Number.isFinite(createdAtMs)) {
    return { ok: false, error: 'createdAtMs must be a finite epoch-millisecond value' };
  }

  let parsedMs: number;
  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt)) {
      return { ok: false, error: 'expiration epoch milliseconds must be a finite number' };
    }
    parsedMs = expiresAt;
  } else if (typeof expiresAt === 'string') {
    const trimmed = expiresAt.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: 'expiration must be a non-empty ISO datetime string' };
    }
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      return { ok: false, error: 'expiration must be a valid ISO datetime string' };
    }
    parsedMs = parsed;
  } else {
    return {
      ok: false,
      error: 'expiration must be an ISO datetime string or epoch milliseconds',
    };
  }

  if (!(parsedMs > createdAtMs)) {
    return { ok: false, error: 'expiration must be strictly later than the creation time' };
  }
  return { ok: true, value: parsedMs };
}

/**
 * Validate a notification title: trimmed, 1–100 characters (Requirement 12.1).
 * Returns the trimmed title on success. Pure: no I/O.
 */
export function validateTitle(title: unknown): ValidationResult<string> {
  return validateBoundedText(title, 'title', 1, NOTIFICATION_TITLE_MAX);
}

/**
 * Validate a notification message/body: trimmed, 1–500 characters
 * (Requirement 12.4). Returns the trimmed message on success. Pure: no I/O.
 */
export function validateMessage(body: unknown): ValidationResult<string> {
  return validateBoundedText(body, 'message', 1, NOTIFICATION_MESSAGE_MAX);
}

/**
 * Validate a notification / bulk-action target list (Requirements 12.6, 14.2).
 *
 * `targets` must be a non-empty array (Req 12.6) with at most `opts.max`
 * elements (default 500 — Req 14.2), where each element is an object with a
 * non-empty `email` and a non-empty `deviceId` (measured after trimming). On
 * success returns the normalized (trimmed) targets, preserving order. Pure: no
 * I/O, deterministic in its inputs.
 */
export function validateTargets(
  targets: unknown,
  opts?: { max?: number }
): ValidationResult<DeviceTarget[]> {
  const max = opts?.max ?? DEFAULT_MAX_TARGETS;
  if (!Array.isArray(targets)) {
    return { ok: false, error: 'targets must be an array' };
  }
  if (targets.length === 0) {
    return { ok: false, error: 'targets must contain at least one recipient' };
  }
  if (targets.length > max) {
    return { ok: false, error: `targets must not exceed ${max} recipients` };
  }

  const normalized: DeviceTarget[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const entry = targets[i];
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: `targets[${i}] must be an object with email and deviceId` };
    }
    const { email, deviceId } = entry as { email?: unknown; deviceId?: unknown };
    if (typeof email !== 'string' || email.trim().length === 0) {
      return { ok: false, error: `targets[${i}].email must be a non-empty string` };
    }
    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      return { ok: false, error: `targets[${i}].deviceId must be a non-empty string` };
    }
    normalized.push({ email: email.trim(), deviceId: deviceId.trim() });
  }

  return { ok: true, value: normalized };
}

// ---------------------------------------------------------------------------
// Tenant scoping (pure helpers)
// ---------------------------------------------------------------------------
//
// These helpers back the server-side tenant-isolation guarantees of the Device
// Admin API (Requirements 3.1, 3.2, 3.3) and design Property 3 (tenant
// isolation for the device listing) and Property 4 (tenant isolation for
// actions and bulk actions). They are intentionally pure — no Firestore, no
// I/O — so the list endpoint and every action route can decide scope before
// touching Firestore, and so task 2.4's property test can exercise them across
// generated inputs.
//
// The single source of truth for "does this device belong to this tenant?" is
// `tenantDeviceFilter.matchesTenantDevice`, which inspects `tenantIds`,
// `activeTenantId`, and active `tenantMemberships`. These helpers DELEGATE to
// it rather than re-deriving that logic, so listing/action scoping stays
// consistent with the existing `/admin/tenants/user-devices` read endpoint.

/**
 * Any object that may carry tenant-association metadata: either a raw Firestore
 * device document or the projected `DeviceAdminRecord`. Both expose the fields
 * `matchesTenantDevice` reads (`tenantIds`, `activeTenantId`,
 * `tenantMemberships`), so `assertTenantScope` accepts either shape.
 */
export type TenantScopedDevice =
  | DeviceAdminRecord
  | TenantTaggedDocument
  | Record<string, unknown>;

/**
 * Project an arbitrary device-like object down to the `TenantTaggedDocument`
 * shape `matchesTenantDevice` understands, pulling only the three tenant fields
 * it inspects. Non-objects (and `null`/`undefined`) become `null`, which
 * `matchesTenantDevice` treats as "not associated". This is the "adapt the
 * object shape" step that lets a raw device doc and a projected
 * `DeviceAdminRecord` be scoped through the same code path.
 */
function toTenantTaggedDocument(
  deviceData: TenantScopedDevice | null | undefined
): TenantTaggedDocument | null {
  if (!deviceData || typeof deviceData !== 'object') {
    return null;
  }
  const data = deviceData as {
    tenantIds?: unknown;
    activeTenantId?: unknown;
    tenantMemberships?: unknown;
  };
  return {
    tenantIds: data.tenantIds,
    activeTenantId: data.activeTenantId,
    tenantMemberships: data.tenantMemberships,
  };
}

/**
 * Whether a device is associated with `tenantId` (Requirements 3.1, 3.2, 3.3).
 *
 * Delegates the association decision to `tenantDeviceFilter.matchesTenantDevice`
 * (which checks `tenantIds`, `activeTenantId`, and active `tenantMemberships`)
 * after adapting the input to that helper's expected shape — so it works
 * uniformly against a raw device document and the projected `DeviceAdminRecord`.
 * Pure: no I/O, deterministic in its inputs.
 *
 * Note: mirroring `matchesTenantDevice`, an empty/whitespace-only `tenantId` is
 * treated as "match all"; the list endpoint (Requirement 3.5) remains
 * responsible for showing no devices when no `Selected_Tenant` is scoped.
 */
export function assertTenantScope(
  deviceData: TenantScopedDevice | null | undefined,
  tenantId: string
): boolean {
  return matchesTenantDevice(toTenantTaggedDocument(deviceData), tenantId);
}

/**
 * Tenant-scoped listing selector backing the list endpoint's tenant isolation
 * (design Property 3, Requirement 3.1): return exactly the devices associated
 * with `tenantId`, preserving input order, using `assertTenantScope` for the
 * per-device decision. A device associated only with a different tenant is
 * excluded. Pure: no I/O, deterministic in its inputs.
 */
export function filterDevicesForTenant(
  devices: ReadonlyArray<DeviceAdminRecord>,
  tenantId: string
): DeviceAdminRecord[] {
  return devices.filter((device) => assertTenantScope(device, tenantId));
}

/**
 * Compute a device's Device_Tenant_Index (`tenantIndex`) from its
 * Tenant_Scoping_Source — the single source of truth for how the denormalized
 * per-device tenant index is derived (Requirements 1.1–1.6).
 *
 * The index is the UNION of:
 *   - the trimmed, non-empty entries of `tenantIds`;
 *   - the trimmed, non-empty `activeTenantId`; and
 *   - the trimmed, non-empty `tenantId` of each ACTIVE `tenantMemberships`
 *     entry, where a membership is active when its `status` lowercases to
 *     `'active'` OR its `status` is not a string (absent/non-string ⇒ active).
 *
 * Field handling mirrors `tenantDeviceFilter.matchesTenantDevice` EXACTLY
 * (reusing {@link toTenantTaggedDocument} for shape adaptation), so membership
 * in the returned index is provably equivalent to `matchesTenantDevice` for
 * every non-empty, trimmed tenant id (Requirement 1.6): the same three channels
 * are inspected with the same trimming, the same empty-id exclusion
 * (Requirement 1.4), and the same active-membership rule (Requirement 1.3, 1.5).
 *
 * Empty/whitespace-only ids are excluded from every channel (Requirement 1.4).
 * The result is collected into a `Set` and returned de-duplicated and SORTED,
 * so the output is canonical: equality and idempotence checks reduce to exact
 * array comparisons, and Firestore stores a stable value (order is irrelevant
 * to `array-contains`). Non-object / `null` / `undefined` input yields `[]`.
 * Pure: no I/O, deterministic in its inputs.
 */
export function deriveTenantIndex(
  deviceData: TenantScopedDevice | null | undefined
): string[] {
  const data = toTenantTaggedDocument(deviceData);
  if (!data) {
    return [];
  }

  const tenantSet = new Set<string>();

  // Channel 1 — `tenantIds`: trimmed, non-empty entries.
  if (Array.isArray(data.tenantIds)) {
    for (const value of data.tenantIds) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) {
        tenantSet.add(trimmed);
      }
    }
  }

  // Channel 2 — `activeTenantId`: trimmed, non-empty.
  const activeTenantId =
    typeof data.activeTenantId === 'string' ? data.activeTenantId.trim() : '';
  if (activeTenantId) {
    tenantSet.add(activeTenantId);
  }

  // Channel 3 — `tenantMemberships`: trimmed, non-empty tenantId of each ACTIVE
  // entry (active = status lowercased === 'active' OR status not a string).
  if (Array.isArray(data.tenantMemberships)) {
    for (const entry of data.tenantMemberships) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const membership = entry as { tenantId?: unknown; status?: unknown };
      const membershipTenantId =
        typeof membership.tenantId === 'string' ? membership.tenantId.trim() : '';
      if (!membershipTenantId) {
        continue;
      }
      const status =
        typeof membership.status === 'string' ? membership.status.toLowerCase() : 'active';
      if (status === 'active') {
        tenantSet.add(membershipTenantId);
      }
    }
  }

  return [...tenantSet].sort();
}

/**
 * WRITE-PATH CONTRACT — "recompute-and-persist-in-the-same-write".
 *
 * Any backend mutation that CHANGES a device's Tenant_Scoping_Source
 * (`tenantIds`, `activeTenantId`, or `tenantMemberships`) MUST keep the derived
 * `tenantIndex` consistent in the SAME atomic write (`set`/`update`/transaction)
 * so the scope change and the index change never diverge (Requirements 2.1,
 * 2.2, 2.5). There are three writer kinds:
 *
 *   1. ADDITIVE writers that only ever ADD the pinged tenant (heartbeat/full
 *      pings): union that one tenant into `tenantIndex` in the same
 *      `set(merge)` (no extra read) — correct because adding `t` to the source
 *      changes the derived set by exactly `∪ {t}`.
 *   2. FULL-RECOMPUTE writers whose change may REMOVE tenants or alter
 *      `tenantMemberships` (register pings, the backfill): read the resulting
 *      source and persist `deriveTenantIndex(resultingSource)` wholesale, inside
 *      a transaction when the read+write must be atomic (Requirement 2.6).
 *   3. Scope-INVARIANT writers (the admin orchestrators — forceLogout, ban,
 *      softDelete, restore, permanentDelete, notify, ...): no maintenance
 *      needed; they never touch the scoping source.
 *
 * This helper builds the resulting Tenant_Scoping_Source for a FULL-RECOMPUTE
 * writer that adds a single tenant (and sets it active) on top of the CURRENT
 * (already-persisted) source, so callers can pass the result straight to
 * {@link deriveTenantIndex} without re-implementing the union/trim rules. It is
 * pure: no I/O, deterministic in its inputs.
 */
export function buildResultingTenantScopeForAddedTenant(
  current: TenantScopedDevice | null | undefined,
  addTenantId: string
): { tenantIds: string[]; activeTenantId: string; tenantMemberships: unknown } {
  const source = toTenantTaggedDocument(current);
  const trimmedAdd = typeof addTenantId === 'string' ? addTenantId.trim() : '';

  const tenantIds = new Set<string>();
  if (source && Array.isArray(source.tenantIds)) {
    for (const value of source.tenantIds) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) {
        tenantIds.add(trimmed);
      }
    }
  }
  if (trimmedAdd) {
    tenantIds.add(trimmedAdd);
  }

  return {
    tenantIds: [...tenantIds],
    activeTenantId: trimmedAdd,
    // `tenantMemberships` is authored by the client's registration
    // `setDoc(merge)`; carry the current (post-merge) value through unchanged so
    // membership adds/removals/status changes are reflected in the recompute.
    tenantMemberships: source ? source.tenantMemberships : undefined,
  };
}

// ---------------------------------------------------------------------------
// Audit logging (append-only persistence + pure shaping)
// ---------------------------------------------------------------------------
//
// These back the durable audit trail for destructive/notify actions
// (Requirements 16.3, 17.1–17.4) and design Property 14 ("audit completeness").
// The console records exactly one durable entry per successful action, carrying
// the action type, the authenticated administrator identity, the target device
// or target user, the supplied reason (stored up to 1000 chars), the affected
// count for bulk/force-logout-all, an outcome, and the action timestamp.
//
// Shape aligns with the existing `tenantAuditLogs` convention written by
// `POST /admin/tenants/memberships/role` (`{ tenantId, actorId, actorEmail,
// action, ..., createdAt }`, actor resolved via `resolveAuthenticatedEmail`),
// plus device-specific fields, and lives in its own append-only
// `deviceAuditLogs` collection (no TTL, no auto-delete — Requirement 17.3).
//
// `shapeAuditEntry` is a pure function (no Firestore/I/O) so it can be
// unit/property-tested in isolation; `writeAudit` shapes then persists and
// deliberately does NOT swallow errors, so a persistence failure surfaces to
// the caller which reports the action as "not recorded" (Requirement 17.4).

/**
 * The append-only Firestore collection that stores Device Console audit
 * entries. Dedicated and separate from the tenant-wide `tenantAuditLogs`
 * collection (Requirement 17.3).
 */
export const DEVICE_AUDIT_LOG_COLLECTION = 'deviceAuditLogs';

/**
 * Maximum stored reason length. Route-level validation enforces the 1–500
 * input bound; the audit record stores up to 1000 characters (Requirement
 * 17.2), so `shapeAuditEntry` truncates anything longer.
 */
export const DEVICE_AUDIT_REASON_MAX = 1000;

/**
 * The device action being audited (Requirement 17.1). Mirrors the design's
 * Audit_Log `action` enum.
 */
export type DeviceAuditAction =
  | 'force_logout'
  | 'force_logout_all'
  | 'ban'
  | 'unban'
  | 'delete'
  | 'restore'
  | 'permanent_delete'
  | 'notify';

/**
 * Outcome of a bulk / partial action (Requirements 11.4, 14.7). `success` when
 * every target succeeded, `partial` when some succeeded and some failed, and
 * `failure` when none succeeded.
 */
export type DeviceAuditOutcome = 'success' | 'partial' | 'failure';

/**
 * Input shape passed to `writeAudit` / `shapeAuditEntry`. `tenantId` and
 * `action` are required; the actor identity, target, reason, affected count,
 * outcome, and metadata are supplied by the calling orchestrator. `actionTimeMs`
 * and `createdAt` are optional here and defaulted by `shapeAuditEntry`
 * (`Date.now()` and its ISO 8601 rendering) so callers need not compute them.
 */
export interface DeviceAuditEntry {
  /** Tenant that scopes the entry in history + timeline views (Req 13.1, 17.5). */
  tenantId: string;
  /** The device action being recorded (Req 17.1). */
  action: DeviceAuditAction;
  /** Authenticated actor id (`authContext.uid` or token type) — Req 16.3. */
  actorId?: string;
  /** Authenticated actor email (`resolveAuthenticatedEmail(authContext)`) — Req 16.3. */
  actorEmail?: string;
  /** Actor display name, when supplied. */
  actorName?: string;
  /** Target device id, for device-scoped actions. */
  targetDeviceId?: string;
  /** Target user email, for user-scoped actions (e.g. force-logout-all). */
  targetUserEmail?: string;
  /** Supplied reason; stored truncated to {@link DEVICE_AUDIT_REASON_MAX} (Req 17.2). */
  reason?: string;
  /** Affected device count for force-logout-all / bulk actions (Req 11.2). */
  affectedCount?: number;
  /** Result classification for bulk/partial actions (Req 11.4, 14.7). */
  outcome?: DeviceAuditOutcome;
  /** Free-form details, e.g. per-device results or delivery counts. */
  metadata?: Record<string, unknown>;
  /** Epoch ms of the action; defaults to `Date.now()` when omitted. */
  actionTimeMs?: number;
  /** ISO 8601 timestamp (with timezone); derived from `actionTimeMs` when omitted. */
  createdAt?: string;
}

/**
 * Normalized, persisted document shape written to `deviceAuditLogs`. Identical
 * to {@link DeviceAuditEntry} except `actionTimeMs` (primary sort key) and
 * `createdAt` (ISO 8601 with timezone) are always present. The Firestore auto
 * id is returned separately by `writeAudit` and is not part of the stored body.
 */
export interface PersistedDeviceAuditEntry {
  tenantId: string;
  action: DeviceAuditAction;
  actorId?: string;
  actorEmail?: string;
  actorName?: string;
  targetDeviceId?: string;
  targetUserEmail?: string;
  reason?: string;
  affectedCount?: number;
  outcome?: DeviceAuditOutcome;
  metadata?: Record<string, unknown>;
  /** Epoch ms; primary sort key for history/timeline ordering. */
  actionTimeMs: number;
  /** ISO 8601 timestamp with timezone (Req 13.2). */
  createdAt: string;
}

/**
 * Normalize a {@link DeviceAuditEntry} into the {@link PersistedDeviceAuditEntry}
 * document body (Requirements 16.3, 17.1, 17.2; design Property 14).
 *
 * Deterministic derivations:
 *  - `actionTimeMs` defaults to `Date.now()` when omitted or non-finite.
 *  - `createdAt` is preserved when a non-empty string is supplied; otherwise it
 *    is derived from the resolved `actionTimeMs` as an ISO 8601 UTC string
 *    (`Z` timezone), keeping the two timestamp fields mutually consistent.
 *  - `reason` is clamped to at most {@link DEVICE_AUDIT_REASON_MAX} characters
 *    (Req 17.2); shorter/absent reasons pass through unchanged.
 *  - Optional fields that are absent (or of the wrong type) are omitted from the
 *    result rather than written as `undefined`, so the persisted document stays
 *    clean and the helper is straightforward to property-test.
 *
 * Pure: no Firestore, no I/O, no throwing — deterministic in its inputs (given
 * a fixed clock for the defaults).
 */
export function shapeAuditEntry(entry: DeviceAuditEntry): PersistedDeviceAuditEntry {
  const actionTimeMs =
    typeof entry.actionTimeMs === 'number' && Number.isFinite(entry.actionTimeMs)
      ? entry.actionTimeMs
      : Date.now();

  const createdAt =
    typeof entry.createdAt === 'string' && entry.createdAt.trim().length > 0
      ? entry.createdAt
      : new Date(actionTimeMs).toISOString();

  const shaped: PersistedDeviceAuditEntry = {
    tenantId: entry.tenantId,
    action: entry.action,
    actionTimeMs,
    createdAt,
  };

  if (typeof entry.actorId === 'string') {
    shaped.actorId = entry.actorId;
  }
  if (typeof entry.actorEmail === 'string') {
    shaped.actorEmail = entry.actorEmail;
  }
  if (typeof entry.actorName === 'string') {
    shaped.actorName = entry.actorName;
  }
  if (typeof entry.targetDeviceId === 'string') {
    shaped.targetDeviceId = entry.targetDeviceId;
  }
  if (typeof entry.targetUserEmail === 'string') {
    shaped.targetUserEmail = entry.targetUserEmail;
  }
  if (typeof entry.reason === 'string') {
    shaped.reason = entry.reason.slice(0, DEVICE_AUDIT_REASON_MAX);
  }
  if (typeof entry.affectedCount === 'number' && Number.isFinite(entry.affectedCount)) {
    shaped.affectedCount = entry.affectedCount;
  }
  if (
    entry.outcome === 'success' ||
    entry.outcome === 'partial' ||
    entry.outcome === 'failure'
  ) {
    shaped.outcome = entry.outcome;
  }
  if (entry.metadata !== undefined && entry.metadata !== null) {
    shaped.metadata = entry.metadata;
  }

  return shaped;
}

/**
 * Append exactly one entry to the append-only `deviceAuditLogs` collection and
 * return the new document id (Requirements 16.3, 17.1–17.3; design Property 14).
 *
 * Shapes the input via {@link shapeAuditEntry}, then persists through the shared
 * Firestore Admin accessor (`getFirestore()` from `./firebaseAdmin`, the same
 * accessor the rest of the backend uses). A failed write must NOT be swallowed:
 * it is rethrown as a typed {@link AuditWriteError} (`audit_write_failed`, 500)
 * so the route layer surfaces the distinct "action ran but was NOT recorded"
 * outcome to the operator, instead of the endpoint's generic fallback code
 * (Requirement 17.4). The underlying persistence error is attached as `cause`.
 * Callers invoke this only after the action itself has succeeded, so at most one
 * audit entry is written per successful action.
 */
export async function writeAudit(entry: DeviceAuditEntry): Promise<{ id: string }> {
  const shaped = shapeAuditEntry(entry);
  const db = getFirestore();
  try {
    const ref = await db.collection(DEVICE_AUDIT_LOG_COLLECTION).add(shaped);
    return { id: ref.id };
  } catch (cause) {
    throw new AuditWriteError('Failed to persist device audit entry', cause);
  }
}

// ---------------------------------------------------------------------------
// Typed service errors (mapped to HTTP status codes by the route layer)
// ---------------------------------------------------------------------------
//
// The mutation orchestrators below perform their scope/validation checks BEFORE
// any Firestore write, and signal state through these typed errors so the route
// layer (task 9.2) can translate them into the status codes documented in the
// design's Error Handling table without re-deriving intent from message text.
// Each error carries a stable `code` string (matching the design's error codes)
// and the `status` the route should return.

/**
 * Base class for Device Admin service errors. Carries a machine-readable
 * `code` (used by the route layer for `{ error: code }` responses) and the
 * `status` code the route should return. Subclasses fix these for a specific
 * failure mode.
 */
export class DeviceAdminError extends Error {
  /** Stable, machine-readable error code (e.g. `'device_not_found'`). */
  readonly code: string;
  /** HTTP status the route layer should return for this error. */
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    // Preserve the concrete subclass name and prototype chain across the
    // TS/CommonJS transpile so `instanceof` checks work in the route layer.
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The target device document does not exist (Requirements 7.3 lookup, 9.7,
 * 10.4). Route maps to `404 { error: 'device_not_found' }`.
 */
export class DeviceNotFoundError extends DeviceAdminError {
  constructor(message = 'Device not found') {
    super('device_not_found', 404, message);
  }
}

/**
 * The target device is not associated with the scoped tenant, or no tenant is
 * scoped (Requirements 3.2, 3.3, 3.6). Route maps to
 * `403 { error: 'tenant_scope_violation' }`; the device is left unchanged
 * because this check runs before any write.
 */
export class TenantScopeError extends DeviceAdminError {
  constructor(message = 'Device is not associated with the selected tenant') {
    super('tenant_scope_violation', 403, message);
  }
}

/**
 * The action conflicts with the device's current lifecycle state — e.g. a
 * force-logout or delete targeting an already-deleted device
 * (Requirements 7.3, 9.5, 9.6). Route maps the carried `code`
 * (`'already_deleted'` / `'not_deleted'`) to `409`. Thrown before any write so
 * the device state is left unchanged.
 */
export class DeviceConflictError extends DeviceAdminError {
  constructor(code = 'already_deleted', message?: string) {
    super(code, 409, message ?? code);
  }
}

/**
 * Recording the `Force_Logout_Signal` (and its co-committed device provenance
 * update) failed (Requirement 7.5). Because the provenance update and signal
 * write are committed atomically in one batch, a failure leaves the device
 * state unchanged. Route maps to `500 { error: 'signal_write_failed' }`.
 */
export class SignalWriteError extends DeviceAdminError {
  constructor(message = 'Failed to record force-logout signal', cause?: unknown) {
    super('signal_write_failed', 500, message);
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Persisting the durable audit entry to `deviceAuditLogs` failed after the
 * action itself had already committed (Requirement 17.4). This is distinct from
 * the action failing: the action ran, but its durable audit record was NOT
 * written, so callers/operators can tell "not recorded" apart from any other
 * failure mode. Route maps to `500 { error: 'audit_write_failed' }`. The
 * underlying persistence error is attached as `cause`.
 */
export class AuditWriteError extends DeviceAdminError {
  constructor(message = 'Failed to record device audit entry', cause?: unknown) {
    super('audit_write_failed', 500, message);
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * One or more per-device signal writes failed during a force-logout-all
 * (Requirement 11.4). Successfully-signaled devices remain logged out; the
 * `failedDeviceIds` retain their active sessions (their per-device batch rolled
 * back). Carries the count that succeeded (`affected`) and the ids that failed
 * so the route can return `500` identifying the affected devices. A failure
 * audit entry is written before this is thrown.
 */
export class ForceLogoutAllError extends DeviceAdminError {
  /** Number of devices that were successfully signaled before the failure(s). */
  readonly affected: number;
  /** Device ids whose signal write failed (sessions retained). */
  readonly failedDeviceIds: string[];

  constructor(affected: number, failedDeviceIds: string[], message?: string) {
    super(
      'signal_write_failed',
      500,
      message ?? 'Failed to record force-logout signal for one or more devices'
    );
    this.affected = affected;
    this.failedDeviceIds = failedDeviceIds;
  }
}

/**
 * The requested tenant id is empty / whitespace-only after trimming
 * (Requirement 7.4). The scoped-listing equivalence between
 * `deriveTenantIndex`/`array-contains(t)` and `matchesTenantDevice(device, t)`
 * holds ONLY for non-empty trimmed ids — an empty id makes `matchesTenantDevice`
 * short-circuit to "match everything" while `array-contains('')` matches
 * nothing. The listing boundary therefore rejects an empty id outright so it
 * can never reach the query and the two paths agree on every input the system
 * can actually issue. Route maps to `400 { error: 'invalid_tenant_id' }`; no
 * Firestore read is performed.
 */
export class InvalidTenantIdError extends DeviceAdminError {
  constructor(message = 'tenantId must be a non-empty, non-whitespace string') {
    super('invalid_tenant_id', 400, message);
  }
}

// ---------------------------------------------------------------------------
// Force-logout orchestrators (server-side; these DO touch Firestore)
// ---------------------------------------------------------------------------
//
// These port the exact Firestore field names and semantics of
// `services/deviceTrackingService.ts` `forceLogoutDevice` /
// `forceLogoutAllUserDevices` / `createLogoutSignal`, relocated behind the
// server-side Device Admin API:
//   - devices live at `user_devices/{email}/devices/{deviceId}`;
//   - force-logout signals live at `logout_signals/{email}_{deviceId}` with
//     `consumed: false` so the on-device runtime's `checkLogoutSignal` picks
//     them up on its next poll;
//   - the device doc gets the force-logout provenance fields plus
//     `logoutSignal: true` / `isOnline: false` / `sessionActive: false`.
//
// The device-provenance update and the signal write are committed together in
// one Firestore `WriteBatch`, so a signal-write failure leaves the device
// unchanged (Requirement 7.5). Scope/lifecycle checks run BEFORE any write, so
// a rejected request performs no mutation (Requirements 3.2/3.3, 7.3). Exactly
// one audit entry is written per successful action, only after the mutation
// commits (Requirements 7.4, 11.2; design Property 14).

/** The acting administrator identity threaded onto provenance + audit fields. */
export interface ForceLogoutActor {
  id?: string;
  email?: string;
  name?: string;
}

/** Parameters for {@link forceLogout} (single device). */
export interface ForceLogoutParams {
  tenantId: string;
  email: string;
  deviceId: string;
  actor: ForceLogoutActor;
  reason?: string;
}

/** Parameters for {@link forceLogoutAll} (all active in-tenant devices of a user). */
export interface ForceLogoutAllParams {
  tenantId: string;
  email: string;
  actor: ForceLogoutActor;
  reason?: string;
}

/** Default reason recorded when the caller supplies none (matches the client). */
const DEFAULT_FORCE_LOGOUT_REASON = 'Administrative action';
/** Default actor identity for system-initiated cascades (matches the client). */
const DEFAULT_ACTOR_EMAIL = 'system';
const DEFAULT_ACTOR_NAME = 'System Administrator';

/** Normalize a supplied reason, falling back to the client-compatible default. */
function resolveReason(reason?: string): string {
  return typeof reason === 'string' && reason.trim().length > 0
    ? reason
    : DEFAULT_FORCE_LOGOUT_REASON;
}

/**
 * Build the device-doc force-logout provenance update, porting the exact field
 * names set by `deviceTrackingService.forceLogoutDevice`: force-logout
 * provenance (`forcedLogoutBy/ByName/At/Reason`), lifecycle flags
 * (`logoutType: 'forced'`, `lastActivityType: 'forced_logout'`,
 * `logoutSignal: true`, `isOnline: false`, `sessionActive: false`), refreshed
 * timestamps, and push-token teardown so a forced-out device stops receiving
 * pushes. Uses `admin.firestore.FieldValue` sentinels the same way `app.ts` does.
 */
function buildForceLogoutDeviceUpdate(
  actor: ForceLogoutActor,
  reason?: string
): admin.firestore.UpdateData<admin.firestore.DocumentData> {
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
  const deleteField = admin.firestore.FieldValue.delete();
  return {
    lastSeen: serverTimestamp,
    updatedAt: serverTimestamp,
    lastActivityType: 'forced_logout',
    forcedLogoutBy: actor.email ?? actor.id ?? DEFAULT_ACTOR_EMAIL,
    forcedLogoutByName: actor.name ?? DEFAULT_ACTOR_NAME,
    forcedLogoutAt: serverTimestamp,
    forcedLogoutReason: resolveReason(reason),
    logoutType: 'forced',
    logoutSignal: true,
    isOnline: false,
    sessionActive: false,
    // Push-token teardown (mirrors the client): a forced-out device must stop
    // being a push target until it re-registers.
    expoPushToken: deleteField,
    pushTokenStatus: 'missing',
    webPushSubscription: deleteField,
    webPushStatus: 'unsubscribed',
  };
}

/**
 * Build the `logout_signals/{email}_{deviceId}` document body, porting the exact
 * fields written by `deviceTrackingService.createLogoutSignal`
 * (`userEmail`, `deviceId`, `adminEmail`, `adminName`, `reason`, `createdAt`,
 * `consumed: false`). Written with a non-merging `set`, so it (re)creates an
 * unconsumed signal even if a prior, consumed signal existed for the pair.
 */
function buildLogoutSignal(
  email: string,
  deviceId: string,
  actor: ForceLogoutActor,
  reason?: string
): admin.firestore.DocumentData {
  return {
    userEmail: email,
    deviceId,
    adminEmail: actor.email ?? actor.id ?? DEFAULT_ACTOR_EMAIL,
    adminName: actor.name ?? DEFAULT_ACTOR_NAME,
    reason: resolveReason(reason),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    consumed: false,
  };
}

/**
 * Force logout a single device (Requirements 7.1, 7.3, 7.4, 7.5; design
 * Property 12).
 *
 * Reads the device at `user_devices/{email}/devices/{deviceId}` and, BEFORE any
 * write, rejects: a missing device ({@link DeviceNotFoundError} → 404), a device
 * outside the scoped tenant ({@link TenantScopeError} → 403), and an
 * already-deleted device ({@link DeviceConflictError} `already_deleted` → 409),
 * each leaving state unchanged (Requirement 7.3). It then atomically commits, in
 * one batch, the device force-logout provenance update and an unconsumed
 * `logout_signals/{email}_{deviceId}` document; a commit failure surfaces as
 * {@link SignalWriteError} with the device left unchanged (Requirement 7.5).
 * Finally it writes exactly one `force_logout` audit entry (Requirement 7.4).
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT write `tenantIds`/`activeTenantId`/`tenantMemberships`, so a device's
 * derived `tenantIndex` is unchanged by it and needs no maintenance here.
 */
export async function forceLogout(params: ForceLogoutParams): Promise<{ ok: true }> {
  const { tenantId, email, deviceId, actor, reason } = params;
  const db = getFirestore();

  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);

  const snapshot = await deviceRef.get();
  if (!snapshot.exists) {
    throw new DeviceNotFoundError();
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(data, tenantId)) {
    throw new TenantScopeError();
  }
  if (data.isDeleted === true) {
    throw new DeviceConflictError('already_deleted', 'Device is already deleted');
  }

  // Provenance update + unconsumed signal are committed together so a failure
  // leaves the device unchanged (Requirement 7.5).
  const signalRef = db.collection('logout_signals').doc(`${email}_${deviceId}`);
  const userRef = db.collection('user_devices').doc(email);
  const batch = db.batch();
  batch.update(deviceRef, buildForceLogoutDeviceUpdate(actor, reason));
  batch.set(signalRef, buildLogoutSignal(email, deviceId, actor, reason));
  // Touch the parent user doc's activity marker (mirrors the client). `merge`
  // avoids a spurious NOT_FOUND when the parent doc is virtual.
  batch.set(
    userRef,
    { lastActivity: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  try {
    await batch.commit();
  } catch (err) {
    throw new SignalWriteError('Failed to record force-logout signal', err);
  }

  // Exactly one durable audit entry, only after the mutation committed
  // (Requirement 7.4; design Property 14). A failure here propagates so the
  // route reports the action as not recorded (Requirement 17.4).
  await writeAudit({
    tenantId,
    action: 'force_logout',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    targetDeviceId: deviceId,
    targetUserEmail: email,
    reason,
  });

  return { ok: true };
}

/**
 * Force logout every active, in-tenant device belonging to a user
 * (Requirements 11.1, 11.2, 11.3, 11.4; design Property 13).
 *
 * Enumerates `user_devices/{email}/devices` and selects exactly the devices
 * that are (a) associated with `tenantId` (`assertTenantScope`), (b) not
 * soft-deleted, and (c) have an active session (`sessionActive !== false`).
 * Each selected device is signaled via its own atomic batch (device provenance
 * update + unconsumed signal), so a per-device failure leaves that device's
 * session intact (Requirement 11.4). When no device qualifies, no signal is
 * written and the affected count is 0 (Requirement 11.3).
 *
 * Exactly one `force_logout_all` audit entry is written recording the affected
 * count and outcome (Requirements 11.2, 11.3). If any per-device write failed,
 * the audit outcome is `partial`/`failure`, the failed device ids are recorded,
 * and a {@link ForceLogoutAllError} is thrown identifying them (Requirement
 * 11.4); otherwise the outcome is `success` and `{ ok, affected }` is returned.
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT write `tenantIds`/`activeTenantId`/`tenantMemberships`, so a device's
 * derived `tenantIndex` is unchanged by it and needs no maintenance here.
 */
export async function forceLogoutAll(
  params: ForceLogoutAllParams
): Promise<{ ok: true; affected: number }> {
  const { tenantId, email, actor, reason } = params;
  const db = getFirestore();

  const devicesSnapshot = await db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .get();

  // Select only active-session, non-deleted, in-tenant devices (Req 11.1).
  const targets = devicesSnapshot.docs.filter((docSnap) => {
    const data = (docSnap.data() ?? {}) as Record<string, unknown>;
    if (data.isDeleted === true) {
      return false;
    }
    if (data.sessionActive === false) {
      return false;
    }
    return assertTenantScope(data, tenantId);
  });

  const signaled: string[] = [];
  const failed: string[] = [];

  for (const docSnap of targets) {
    const deviceId = docSnap.id;
    const signalRef = db.collection('logout_signals').doc(`${email}_${deviceId}`);
    const batch = db.batch();
    batch.update(docSnap.ref, buildForceLogoutDeviceUpdate(actor, reason));
    batch.set(signalRef, buildLogoutSignal(email, deviceId, actor, reason));
    try {
      // Per-device commit isolates failures so a failed device keeps its
      // session (Requirement 11.4).
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
      signaled.push(deviceId);
    } catch {
      failed.push(deviceId);
    }
  }

  // Touch the parent user doc once if anything was signaled (mirrors the client).
  if (signaled.length > 0) {
    await db
      .collection('user_devices')
      .doc(email)
      .set(
        { lastActivity: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
  }

  const affected = signaled.length;
  const outcome: DeviceAuditOutcome =
    failed.length === 0 ? 'success' : affected > 0 ? 'partial' : 'failure';

  // Exactly one audit entry recording the affected count and outcome
  // (Requirements 11.2, 11.3, 11.4).
  await writeAudit({
    tenantId,
    action: 'force_logout_all',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    targetUserEmail: email,
    affectedCount: affected,
    outcome,
    reason,
    metadata: failed.length > 0 ? { failedDeviceIds: failed } : undefined,
  });

  if (failed.length > 0) {
    // Some sessions were retained; surface the affected devices (Req 11.4).
    throw new ForceLogoutAllError(affected, failed);
  }

  return { ok: true, affected };
}

// ---------------------------------------------------------------------------
// Ban / unban orchestrators (server-side; these DO touch Firestore)
// ---------------------------------------------------------------------------
//
// These port the exact `device_bans` field semantics of
// `services/deviceTrackingService.ts` `createDeviceBan` / `restoreHardBannedDevice`
// behind the server-side Device Admin API:
//   - hard bans live in the top-level `device_bans` collection, keyed to a
//     device fingerprint (never per user/device sub-collection);
//   - a ban document mirrors the client shape exactly:
//     `{ banType:'hard', deviceFingerprint, bannedFields, reason, adminEmail,
//        adminName, targetDeviceId, targetUserEmail, isActive:true, createdAt,
//        expiresAt?, lastChecked }`;
//   - the device to ban lives at `user_devices/{email}/devices/{deviceId}` and
//     supplies the fingerprint (`deviceSeedHash` → stored `fallbackFingerprintHash`
//     → recomputed fallback) and the `bannedFields` snapshot.
//
// Scope/lifecycle checks run BEFORE any write, so a rejected request performs no
// mutation (Requirements 3.2/3.3, 8.6, 8.7). Ban creation runs inside a Firestore
// transaction that first asserts there is no active ban for the fingerprint, so
// at most one active ban exists per fingerprint even under concurrency
// (Requirement 8.6; design Property 10). Exactly one audit entry is written per
// successful action, only after the mutation commits (Requirement 8.5).

/** The top-level Firestore collection that stores hard `Device_Ban` records. */
export const DEVICE_BANS_COLLECTION = 'device_bans';

/** Parameters for {@link ban} (create a hard ban for a single device). */
export interface BanParams {
  tenantId: string;
  email: string;
  deviceId: string;
  actor: ForceLogoutActor;
  /** Validated at the route layer (1–500 chars); stored on the ban record. */
  reason: string;
  /** Optional expiration; validated at the route layer, stored when provided (Req 8.2). */
  expiresAt?: string | number | null;
}

/** Parameters for {@link unban} (deactivate the active ban and restore access). */
export interface UnbanParams {
  tenantId: string;
  email: string;
  deviceId: string;
  actor: ForceLogoutActor;
  reason?: string;
}

/**
 * Normalize a single fingerprint component exactly like the on-device runtime's
 * `DeviceTrackingService.normalizeFingerprintValue`: `null`/`undefined` and
 * non-finite numbers become `''`; finite numbers stringify; everything else is
 * `String(value).trim().toLowerCase()`. Keeps the recomputed fallback hash
 * byte-for-byte compatible with the client's stored fingerprint.
 */
function normalizeFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toString() : '';
  }
  return String(value).trim().toLowerCase();
}

/**
 * Recompute the fallback device fingerprint from a raw device document, porting
 * `DeviceTrackingService.computeFallbackFingerprintHash`: normalize the same
 * ordered hardware/platform fields, drop empties, join with `|`, and hash with
 * SHA-256 truncated to 20 hex chars (`hashFingerprintData`). Used only when the
 * device stored neither `deviceSeedHash` nor `fallbackFingerprintHash`.
 */
function computeFallbackFingerprint(data: Record<string, unknown>): string {
  const supportedCpu = Array.isArray(data.supportedCpuArchitectures)
    ? (data.supportedCpuArchitectures as unknown[]).join(',')
    : '';
  const fingerprintData = [
    data.userAgent,
    data.manufacturer,
    data.modelName,
    data.modelId,
    data.hardwareConcurrency,
    data.totalMemory,
    data.screenWidth,
    data.screenHeight,
    supportedCpu,
    data.jsHeapSizeLimit,
    data.platform,
    data.vendor,
  ]
    .map((value) => normalizeFingerprintValue(value))
    .filter(Boolean)
    .join('|');
  return createHash('sha256').update(fingerprintData).digest('hex').slice(0, 20);
}

/**
 * Derive a device's ban fingerprint from its stored fields, mirroring
 * `DeviceTrackingService.generateDeviceFingerprint`: prefer a stored, trimmed
 * `deviceSeedHash`; otherwise use the stored `fallbackFingerprintHash`; and only
 * as a last resort recompute the fallback from the raw hardware fields via
 * {@link computeFallbackFingerprint}. Always returns a non-empty fingerprint.
 */
function deriveDeviceFingerprint(data: Record<string, unknown>): string {
  const seed = data.deviceSeedHash;
  if (typeof seed === 'string' && seed.trim().length > 0) {
    return seed.trim();
  }
  const fallback = data.fallbackFingerprintHash;
  if (typeof fallback === 'string' && fallback.trim().length > 0) {
    return fallback.trim();
  }
  return computeFallbackFingerprint(data);
}

/**
 * Extract the `bannedFields` snapshot from a raw device document, porting the
 * exact field set stored by `deviceTrackingService.createDeviceBan`.
 * `undefined` values are stripped so Firestore accepts the nested object.
 */
function extractBannedFields(data: Record<string, unknown>): Record<string, unknown> {
  return stripUndefinedShallow({
    userAgent: data.userAgent,
    manufacturer: data.manufacturer,
    modelName: data.modelName,
    modelId: data.modelId,
    hardwareConcurrency: data.hardwareConcurrency,
    totalMemory: data.totalMemory,
    screenWidth: data.screenWidth,
    screenHeight: data.screenHeight,
    supportedCpuArchitectures: data.supportedCpuArchitectures,
    jsHeapSizeLimit: data.jsHeapSizeLimit,
    platform: data.platform,
    vendor: data.vendor,
  });
}

/**
 * Convert an optional `expiresAt` (ISO datetime string or epoch ms) into a
 * Firestore `Timestamp`, mirroring the client's `Timestamp.fromDate(...)`.
 * Returns `undefined` (i.e. "no expiration") for `null`/`undefined` or an
 * unparseable value; expiration validity (must be later than creation) is
 * enforced at the route layer (task 9.2) via `validateExpiration`.
 */
function resolveExpiresAtTimestamp(
  expiresAt?: string | number | null
): admin.firestore.Timestamp | undefined {
  if (expiresAt === null || expiresAt === undefined) {
    return undefined;
  }
  let ms: number;
  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt)) {
      return undefined;
    }
    ms = expiresAt;
  } else if (typeof expiresAt === 'string') {
    const parsed = Date.parse(expiresAt.trim());
    if (Number.isNaN(parsed)) {
      return undefined;
    }
    ms = parsed;
  } else {
    return undefined;
  }
  return admin.firestore.Timestamp.fromMillis(ms);
}

/** Shallow-strip `undefined` values so a Firestore write is accepted. */
function stripUndefinedShallow(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Create a hard `Device_Ban` for a single device (Requirements 8.1, 8.2, 8.3,
 * 8.5, 8.6; design Properties 9, 10).
 *
 * Reads the device at `user_devices/{email}/devices/{deviceId}` and, BEFORE any
 * write, rejects: a missing device ({@link DeviceNotFoundError} → 404) and a
 * device outside the scoped tenant ({@link TenantScopeError} → 403), each
 * leaving state unchanged. It derives the device fingerprint and `bannedFields`
 * from the device's stored fields, then in a single Firestore TRANSACTION
 * asserts no active `device_bans` doc exists for that fingerprint — throwing
 * {@link DeviceConflictError} `active_ban_exists` (409) and creating nothing if
 * one does (Requirement 8.6) — otherwise creating exactly one active ban doc
 * that mirrors the client's `createDeviceBan` shape (storing `expiresAt` only
 * when provided — Requirement 8.2). Finally it writes exactly one `ban` audit
 * entry (Requirement 8.5) and returns the new ban id.
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT write `tenantIds`/`activeTenantId`/`tenantMemberships`, so a device's
 * derived `tenantIndex` is unchanged by it and needs no maintenance here.
 */
export async function ban(params: BanParams): Promise<{ ok: true; banId: string }> {
  const { tenantId, email, deviceId, actor, reason, expiresAt } = params;
  const db = getFirestore();

  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);

  const snapshot = await deviceRef.get();
  if (!snapshot.exists) {
    throw new DeviceNotFoundError();
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(data, tenantId)) {
    throw new TenantScopeError();
  }

  const deviceFingerprint = deriveDeviceFingerprint(data);
  const bannedFields = extractBannedFields(data);
  const expiresTimestamp = resolveExpiresAtTimestamp(expiresAt);

  // Assert-then-create inside one transaction so at most one active ban exists
  // per fingerprint even under concurrency (Requirement 8.6; Property 10). The
  // conflict throw propagates out of the transaction, so nothing is written.
  const banId = await db.runTransaction(async (tx) => {
    const activeBansQuery = db
      .collection(DEVICE_BANS_COLLECTION)
      .where('deviceFingerprint', '==', deviceFingerprint)
      .where('isActive', '==', true);
    const existing = await tx.get(activeBansQuery);
    if (!existing.empty) {
      throw new DeviceConflictError(
        'active_ban_exists',
        'An active ban already exists for this device fingerprint'
      );
    }

    const banRef = db.collection(DEVICE_BANS_COLLECTION).doc();
    const banData = stripUndefinedShallow({
      banType: 'hard',
      deviceFingerprint,
      bannedFields,
      reason,
      adminEmail: actor.email ?? actor.id ?? DEFAULT_ACTOR_EMAIL,
      adminName: actor.name ?? DEFAULT_ACTOR_NAME,
      targetDeviceId: deviceId,
      targetUserEmail: email,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: expiresTimestamp,
      lastChecked: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(banRef, banData);
    return banRef.id;
  });

  // Exactly one durable audit entry, only after the ban committed
  // (Requirement 8.5). A failure here propagates so the route reports the
  // action as not recorded (Requirement 17.4).
  await writeAudit({
    tenantId,
    action: 'ban',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    targetDeviceId: deviceId,
    targetUserEmail: email,
    reason,
  });

  return { ok: true, banId };
}

/**
 * Remove an active hard `Device_Ban` and restore the device's access
 * (Requirements 8.3, 8.5, 8.7; design Property 9).
 *
 * Reads the device and, BEFORE any write, rejects a missing device
 * ({@link DeviceNotFoundError} → 404) and a device outside the scoped tenant
 * ({@link TenantScopeError} → 403). It derives the fingerprint and finds the
 * active `device_bans` doc(s) for it; when none exist it throws
 * {@link DeviceConflictError} `no_active_ban` (409) with no mutation
 * (Requirement 8.7). Otherwise it atomically, in one batch, deactivates each
 * active ban (`isActive:false` plus unban provenance) and restores the device
 * (clearing deletion provenance, mirroring `restoreHardBannedDevice`), then
 * writes exactly one `unban` audit entry (Requirement 8.5).
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT write `tenantIds`/`activeTenantId`/`tenantMemberships`, so a device's
 * derived `tenantIndex` is unchanged by it and needs no maintenance here.
 */
export async function unban(params: UnbanParams): Promise<{ ok: true }> {
  const { tenantId, email, deviceId, actor, reason } = params;
  const db = getFirestore();

  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);

  const snapshot = await deviceRef.get();
  if (!snapshot.exists) {
    throw new DeviceNotFoundError();
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(data, tenantId)) {
    throw new TenantScopeError();
  }

  const deviceFingerprint = deriveDeviceFingerprint(data);

  const activeBans = await db
    .collection(DEVICE_BANS_COLLECTION)
    .where('deviceFingerprint', '==', deviceFingerprint)
    .where('isActive', '==', true)
    .get();
  if (activeBans.empty) {
    throw new DeviceConflictError('no_active_ban', 'No active ban exists for this device');
  }

  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
  const deleteField = admin.firestore.FieldValue.delete();
  const adminEmail = actor.email ?? actor.id ?? DEFAULT_ACTOR_EMAIL;
  const adminName = actor.name ?? DEFAULT_ACTOR_NAME;

  // Deactivate every matching active ban + restore the device in one atomic
  // batch, so a failure leaves both the ban(s) and the device unchanged.
  const batch = db.batch();
  for (const banDoc of activeBans.docs) {
    batch.update(
      banDoc.ref,
      stripUndefinedShallow({
        isActive: false,
        lastChecked: serverTimestamp,
        unbannedAt: serverTimestamp,
        unbannedBy: adminEmail,
        unbannedByName: adminName,
        unbanReason: typeof reason === 'string' && reason.trim().length > 0 ? reason : undefined,
      }) as admin.firestore.UpdateData<admin.firestore.DocumentData>
    );
  }
  // Restore device access (mirrors `restoreHardBannedDevice`).
  batch.update(deviceRef, {
    isDeleted: false,
    isRestored: true,
    restoredAt: serverTimestamp,
    updatedAt: serverTimestamp,
    deletedAt: deleteField,
    deletedBy: deleteField,
    deletedByName: deleteField,
    deletionReason: deleteField,
  });
  // Touch the parent user doc's activity marker (mirrors the client). `merge`
  // avoids a spurious NOT_FOUND when the parent doc is virtual.
  batch.set(
    db.collection('user_devices').doc(email),
    { lastActivity: serverTimestamp },
    { merge: true }
  );

  await batch.commit();

  // Exactly one durable audit entry, only after the mutation committed
  // (Requirement 8.5).
  await writeAudit({
    tenantId,
    action: 'unban',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    targetDeviceId: deviceId,
    targetUserEmail: email,
    reason,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Soft delete / restore orchestrators (server-side; these DO touch Firestore)
// ---------------------------------------------------------------------------
//
// These port the exact Firestore field semantics of
// `services/deviceTrackingService.ts` `markDeviceAsDeleted` / `restoreDevice`
// (the regular, non-hard-ban restore path) behind the server-side Device Admin
// API:
//   - devices live at `user_devices/{email}/devices/{deviceId}`;
//   - a soft delete sets the deletion provenance (`isDeleted:true`, `deletedAt`,
//     `deletedBy`, `deletedByName`, `deletionReason`) plus `isOnline:false` /
//     `logoutSignal:true`, AND records an unconsumed force-logout signal at
//     `logout_signals/{email}_{deviceId}` (reusing {@link buildLogoutSignal})
//     so the on-device runtime signs the device out on its next poll;
//   - a restore returns the device to active by setting `isDeleted:false`,
//     `isRestored:true`, `restoredAt`, and clearing the deletion fields.
//
// Scope/lifecycle checks run BEFORE any write, so a rejected request performs no
// mutation (Requirements 3.2/3.3, 9.5, 9.6, 9.7): an already-deleted delete and
// a not-deleted restore are rejected with NO extra signal/mutation. The device
// provenance update and the signal write are committed together in one Firestore
// `WriteBatch`, so a commit failure leaves the device unchanged (Requirement
// 9.1 signal semantics). Exactly one audit entry is written per successful
// action, only after the mutation commits (Requirement 9.4; design Properties
// 11, 14). Reason length is validated at the route layer (`validateReason`); the
// orchestrator assumes an already-validated reason.

/** Parameters for {@link softDelete} (soft delete a single device). */
export interface SoftDeleteParams {
  tenantId: string;
  email: string;
  deviceId: string;
  actor: ForceLogoutActor;
  /** Validated at the route layer (1–500 chars); stored as `deletionReason`. */
  reason: string;
}

/** Parameters for {@link restore} (restore a soft-deleted device). */
export interface RestoreParams {
  tenantId: string;
  email: string;
  deviceId: string;
  actor: ForceLogoutActor;
  /** Optional; recorded on the audit entry when provided (Req 9.4). */
  reason?: string;
}

/**
 * Build the device-doc soft-delete provenance update, porting the exact field
 * names set by `deviceTrackingService.markDeviceAsDeleted`: deletion provenance
 * (`isDeleted:true`, `deletedAt`, `deletedBy`, `deletedByName`,
 * `deletionReason`), a refreshed `updatedAt`, and the sign-out flags
 * (`isOnline:false`, `logoutSignal:true`) so a deleted device is treated as
 * logged out. Uses `admin.firestore.FieldValue` sentinels the same way the
 * force-logout builder does.
 */
function buildSoftDeleteDeviceUpdate(
  actor: ForceLogoutActor,
  reason: string
): admin.firestore.UpdateData<admin.firestore.DocumentData> {
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
  return {
    isDeleted: true,
    deletedAt: serverTimestamp,
    deletedBy: actor.email ?? actor.id ?? DEFAULT_ACTOR_EMAIL,
    deletedByName: actor.name ?? DEFAULT_ACTOR_NAME,
    deletionReason: reason,
    updatedAt: serverTimestamp,
    isOnline: false,
    logoutSignal: true,
  };
}

/**
 * Build the device-doc restore update, porting the exact field names set by
 * `deviceTrackingService.restoreDevice` (the regular, non-hard-ban path):
 * mark the device active/restored (`isDeleted:false`, `isRestored:true`,
 * `restoredAt`, refreshed `updatedAt`) and clear the deletion provenance
 * (`deletedAt`, `deletedBy`, `deletedByName`, `deletionReason`) via
 * `FieldValue.delete()`.
 */
function buildRestoreDeviceUpdate(): admin.firestore.UpdateData<admin.firestore.DocumentData> {
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
  const deleteField = admin.firestore.FieldValue.delete();
  return {
    isDeleted: false,
    isRestored: true,
    restoredAt: serverTimestamp,
    updatedAt: serverTimestamp,
    deletedAt: deleteField,
    deletedBy: deleteField,
    deletedByName: deleteField,
    deletionReason: deleteField,
  };
}

/**
 * Soft delete a single device (Requirements 9.1, 9.4, 9.5, 9.7; design
 * Property 11).
 *
 * Reads the device at `user_devices/{email}/devices/{deviceId}` and, BEFORE any
 * write, rejects: a missing device ({@link DeviceNotFoundError} → 404), a device
 * outside the scoped tenant ({@link TenantScopeError} → 403), and an
 * already-deleted device ({@link DeviceConflictError} `already_deleted` → 409),
 * each leaving state unchanged and — critically for an already-deleted device —
 * recording NO additional force-logout signal (Requirement 9.5). It then
 * atomically commits, in one batch, the device soft-delete provenance update and
 * an unconsumed `logout_signals/{email}_{deviceId}` document (Requirement 9.1);
 * a commit failure surfaces as {@link SignalWriteError} with the device left
 * unchanged. Finally it writes exactly one `delete` audit entry carrying the
 * reason and target (Requirement 9.4).
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT write `tenantIds`/`activeTenantId`/`tenantMemberships`, so a device's
 * derived `tenantIndex` is unchanged by it and needs no maintenance here.
 */
export async function softDelete(params: SoftDeleteParams): Promise<{ ok: true }> {
  const { tenantId, email, deviceId, actor, reason } = params;
  const db = getFirestore();

  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);

  const snapshot = await deviceRef.get();
  if (!snapshot.exists) {
    throw new DeviceNotFoundError();
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(data, tenantId)) {
    throw new TenantScopeError();
  }
  if (data.isDeleted === true) {
    // Already deleted: reject with NO extra signal/mutation (Requirement 9.5).
    throw new DeviceConflictError('already_deleted', 'Device is already deleted');
  }

  // Provenance update + unconsumed signal are committed together so a failure
  // leaves the device unchanged (Requirement 9.1).
  const signalRef = db.collection('logout_signals').doc(`${email}_${deviceId}`);
  const userRef = db.collection('user_devices').doc(email);
  const batch = db.batch();
  batch.update(deviceRef, buildSoftDeleteDeviceUpdate(actor, reason));
  batch.set(signalRef, buildLogoutSignal(email, deviceId, actor, reason));
  // Touch the parent user doc's activity marker (mirrors the client). `merge`
  // avoids a spurious NOT_FOUND when the parent doc is virtual.
  batch.set(
    userRef,
    { lastActivity: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  try {
    await batch.commit();
  } catch (err) {
    throw new SignalWriteError(
      'Failed to record device deletion and force-logout signal',
      err
    );
  }

  // Exactly one durable audit entry, only after the mutation committed
  // (Requirement 9.4; design Property 14). A failure here propagates so the
  // route reports the action as not recorded (Requirement 17.4).
  await writeAudit({
    tenantId,
    action: 'delete',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    targetDeviceId: deviceId,
    targetUserEmail: email,
    reason,
  });

  return { ok: true };
}

/**
 * Restore a soft-deleted device (Requirements 9.3, 9.4, 9.6, 9.7; design
 * Property 11).
 *
 * Reads the device and, BEFORE any write, rejects: a missing device
 * ({@link DeviceNotFoundError} → 404), a device outside the scoped tenant
 * ({@link TenantScopeError} → 403), and a device that is NOT deleted
 * ({@link DeviceConflictError} `not_deleted` → 409), each leaving state
 * unchanged (Requirement 9.6). Otherwise it atomically, in one batch, marks the
 * device active/restored and clears the deletion provenance (mirroring
 * `restoreDevice`), then writes exactly one `restore` audit entry
 * (Requirement 9.4).
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT write `tenantIds`/`activeTenantId`/`tenantMemberships`, so a device's
 * derived `tenantIndex` is unchanged by it and needs no maintenance here.
 */
export async function restore(params: RestoreParams): Promise<{ ok: true }> {
  const { tenantId, email, deviceId, actor, reason } = params;
  const db = getFirestore();

  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);

  const snapshot = await deviceRef.get();
  if (!snapshot.exists) {
    throw new DeviceNotFoundError();
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(data, tenantId)) {
    throw new TenantScopeError();
  }
  if (data.isDeleted !== true) {
    // Not deleted: nothing to restore (Requirement 9.6).
    throw new DeviceConflictError('not_deleted', 'Device is not deleted');
  }

  const userRef = db.collection('user_devices').doc(email);
  const batch = db.batch();
  batch.update(deviceRef, buildRestoreDeviceUpdate());
  // Touch the parent user doc's activity marker (mirrors the client). `merge`
  // avoids a spurious NOT_FOUND when the parent doc is virtual.
  batch.set(
    userRef,
    { lastActivity: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  await batch.commit();

  // Exactly one durable audit entry, only after the mutation committed
  // (Requirement 9.4; design Property 14).
  await writeAudit({
    tenantId,
    action: 'restore',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    targetDeviceId: deviceId,
    targetUserEmail: email,
    reason,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Permanent-delete orchestrator (server-side; this DOES touch Firestore)
// ---------------------------------------------------------------------------
//
// This ports the exact intent of `services/deviceTrackingService.ts`
// `deleteDevicePermanently` behind the server-side Device Admin API, but tightens
// its multi-step client sequence into a single ATOMIC removal so it is
// all-or-nothing (Requirements 10.1, 10.6; design Property 17):
//   - the device lives at `user_devices/{email}/devices/{deviceId}`;
//   - its related force-logout signal lives at `logout_signals/{email}_{deviceId}`;
//   - the parent `user_devices/{email}` doc holds the `totalDevices` /
//     `lastActivity` counters the client refreshes after a permanent delete.
//
// The client's `deleteDevicePermanently` performs several independent, best-effort
// steps (optional pre-delete force-logout, a persistent signal write, the device
// `deleteDoc`, best-effort `device_actions` cleanup, then a recomputed counter
// update). Here the destructive removal is committed in ONE Firestore
// `WriteBatch` — deleting the device doc, deleting the related logout signal,
// and decrementing the parent counter — so a mid-operation datastore failure
// rolls the whole thing back and leaves every record unchanged (Property 17),
// surfacing as {@link DeleteRolledBackError} (500 `delete_rolled_back`).
// Consistent with the client, active `device_bans` (keyed by fingerprint, not by
// user/device) are NOT removed here.
//
// Scope/existence checks run BEFORE any write, so a rejected request performs no
// mutation (Requirements 10.4, 3.2/3.3). Exactly one audit entry is written per
// successful removal, only after the mutation commits (Requirement 10.3; design
// Property 14). Reason length + non-Global_Admin rejection are enforced at the
// route layer (Requirements 10.2, 10.5); this orchestrator assumes a validated
// reason.

/**
 * The atomic permanent-delete removal (device doc + related tracking records +
 * counter update) failed at the datastore layer (Requirements 10.1, 10.6;
 * design Property 17). Because the removal is committed in a single Firestore
 * `WriteBatch`, a failure leaves every record unchanged (all-or-nothing). Route
 * maps to `500 { error: 'delete_rolled_back' }`.
 */
export class DeleteRolledBackError extends DeviceAdminError {
  constructor(message = 'Permanent delete rolled back; nothing was removed', cause?: unknown) {
    super('delete_rolled_back', 500, message);
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Parameters for {@link permanentDelete} (permanently remove a single device). */
export interface PermanentDeleteParams {
  tenantId: string;
  email: string;
  deviceId: string;
  actor: ForceLogoutActor;
  /** Validated at the route layer (1–500 chars); recorded on the audit entry. */
  reason: string;
}

/**
 * Permanently delete a single device and its related tracking records
 * (Requirements 10.1, 10.3, 10.4, 10.6; design Property 17).
 *
 * Reads the device at `user_devices/{email}/devices/{deviceId}` and, BEFORE any
 * write, rejects a missing device ({@link DeviceNotFoundError} → 404,
 * Requirement 10.4) and a device outside the scoped tenant
 * ({@link TenantScopeError} → 403), each leaving state unchanged. It then
 * commits, in ONE atomic Firestore `WriteBatch`, the removal of the device doc,
 * the related `logout_signals/{email}_{deviceId}` doc (a no-op when absent), and
 * a decrement of the parent `user_devices/{email}` `totalDevices` counter plus a
 * refreshed `lastActivity` — so a mid-operation datastore failure rolls back
 * completely and leaves every record unchanged (Requirements 10.1, 10.6),
 * surfacing as {@link DeleteRolledBackError} (500 `delete_rolled_back`).
 * Finally, only after the removal commits, it writes exactly one
 * `permanent_delete` audit entry carrying the reason and target
 * (Requirement 10.3) and returns `{ ok: true }`.
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT mutate `tenantIds`/`activeTenantId`/`tenantMemberships`; it removes
 * the whole device doc, so its derived `tenantIndex` is deleted together with it
 * and needs no separate maintenance here.
 */
export async function permanentDelete(
  params: PermanentDeleteParams
): Promise<{ ok: true }> {
  const { tenantId, email, deviceId, actor, reason } = params;
  const db = getFirestore();

  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);

  // Read + scope checks BEFORE any write (Requirements 10.4, 3.2/3.3): a missing
  // or out-of-scope device is rejected with no mutation.
  const snapshot = await deviceRef.get();
  if (!snapshot.exists) {
    throw new DeviceNotFoundError();
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(data, tenantId)) {
    throw new TenantScopeError();
  }

  // Atomic removal: device doc + related logout signal + parent counter update
  // are committed in a single `WriteBatch`, which Firestore applies
  // all-or-nothing — so a mid-op failure leaves every record unchanged
  // (Requirements 10.1, 10.6; design Property 17). `delete` on an absent signal
  // is a harmless no-op. The parent counter is decremented atomically (the
  // device we just confirmed exists is being removed) and `lastActivity` is
  // refreshed, mirroring the client's post-delete counter update; `merge` avoids
  // a spurious NOT_FOUND when the parent doc is virtual. Active `device_bans`
  // (keyed by fingerprint) are intentionally left untouched, matching the
  // client's `deleteDevicePermanently`.
  const signalRef = db.collection('logout_signals').doc(`${email}_${deviceId}`);
  const userRef = db.collection('user_devices').doc(email);
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.delete(deviceRef);
  batch.delete(signalRef);
  batch.set(
    userRef,
    {
      totalDevices: admin.firestore.FieldValue.increment(-1),
      lastActivity: serverTimestamp,
    },
    { merge: true }
  );

  try {
    await batch.commit();
  } catch (err) {
    // The batch rolled back atomically; nothing was removed (Property 17).
    throw new DeleteRolledBackError(
      'Permanent delete rolled back; nothing was removed',
      err
    );
  }

  // Exactly one durable audit entry, only after the removal committed
  // (Requirement 10.3; design Property 14). A failure here propagates so the
  // route reports the action as not recorded (Requirement 17.4).
  await writeAudit({
    tenantId,
    action: 'permanent_delete',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    targetDeviceId: deviceId,
    targetUserEmail: email,
    reason,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Notify + bulk force-logout orchestrators (server-side; these DO touch Firestore
// and the shared Push_Delivery_Service)
// ---------------------------------------------------------------------------
//
// These two orchestrators implement the console's fan-out actions over a set of
// pre-validated `DeviceTarget`s (route-level validation enforces the non-empty,
// ≤500, and title/body bounds — Requirements 12.1, 12.4, 12.6, 14.2). Both are
// built for BULK COMPLETENESS (design Property 18): the returned success + fail
// counts equal the number of targets, every target appears exactly once in the
// per-target `results`, a single-target failure never aborts the rest
// (Requirements 12.5, 14.7), and when the push service is unavailable every
// affected delivery is counted as failed (Requirement 12.7).
//
// `notify` reuses the EXISTING delivery primitives — `pushUtils.sendExpoMessages`
// for Expo-token targets and `webPush.sendWebPushNotification` for web-push
// targets (design's Push_Delivery_Service reuse; Requirements 12.2, 12.3) — and
// never builds a new delivery path. Expo-token targets are BATCHED: all of a
// single notify call's Expo messages go out in ONE `sendExpoMessages(...)` call
// (which internally chunks to ≤100 messages per Expo HTTP request), instead of
// one Expo HTTP request per device, cutting the fan-out from up to 500 requests
// to ceil(N/100). Web-push targets stay per-target (Expo's batch endpoint has no
// web-push equivalent) and run concurrently with a bounded fan-out.
//
// TIMEOUT-GRANULARITY TRADEOFF (Requirement 12.5): the single batched Expo call
// is wrapped in ONE 30s `withTimeout`, so up to 100 Expo messages now SHARE a
// single 30s budget rather than each getting its own 30s timer. If that batched
// call times out or the push service is unavailable/throws, EVERY Expo target in
// the batch is counted as failed (Requirement 12.7). Web-push deliveries keep
// their per-target 30s timeout. This is an intentional cost of batching: it
// trades per-message timeout isolation for far fewer outbound HTTP requests.
// Exactly ONE `notify` audit entry is written per call, carrying the delivery
// counts and an aggregate outcome (design's "every notify call writes one
// deviceAuditLogs entry with delivery counts").
//
// AUDIT APPROACH for `bulkForceLogout` (documented per task 7.1): each per-target
// force-logout delegates to the single-device `forceLogout`, which already writes
// EXACTLY ONE `force_logout` audit entry per successful device (Requirement 7.4;
// design Property 14 — "exactly one durable audit entry" per force logout). To
// keep that invariant and because the audit `action` enum has no dedicated
// bulk-force-logout type, `bulkForceLogout` does NOT write an additional summary
// audit entry; it returns the aggregate `{ succeeded, failed, results }` instead.
// The bulk SUMMARY (Requirement 14.8) is a Device_Console concern rendered from
// that aggregate, not a second audit row. (Failed targets — validation/scope/
// conflict/signal-write failures — write no audit entry, consistent with the
// per-device orchestrator, so there is never a partial/duplicate audit.)

/**
 * Delivery/action timeout for notify deliveries (Requirement 12.5). Applied
 * per web-push target and ONCE around the single batched Expo call — so a batch
 * of up to 100 Expo messages shares one 30s budget (see the batching/timeout
 * tradeoff note above and on {@link notify}). A timeout counts the affected
 * delivery(ies) as failed rather than hanging the send.
 */
export const NOTIFY_DELIVERY_TIMEOUT_MS = 30_000;

/**
 * Maximum number of per-target device actions (notify deliveries / bulk
 * force-logouts) run concurrently. Bounds the fan-out so a single bulk request
 * over up to `DEFAULT_MAX_TARGETS` (500) targets does not open hundreds of
 * simultaneous Firestore reads / push calls / write batches at once. Kept small
 * and internal; it does not change any observable output (see
 * {@link mapWithConcurrency}), only the concurrency of the fan-out.
 */
export const DEVICE_ACTION_CONCURRENCY = 20;

/** Notification priority accepted by the console; mapped to Expo/web transports. */
export type NotifyPriority = 'high' | 'normal' | 'low';

/**
 * Per-target outcome for a bulk/notify action. `ok` marks a successful delivery
 * (notify) or successful force-logout (bulk); `error` carries a stable code or
 * message when `ok` is false. Every target produces exactly one of these
 * (design Property 18).
 */
export interface DeviceActionOutcome {
  email: string;
  deviceId: string;
  ok: boolean;
  error?: string;
}

/** Parameters for {@link notify} (send one notification to many targets). */
export interface NotifyParams {
  tenantId: string;
  title: string;
  body: string;
  targets: DeviceTarget[];
  actor: ForceLogoutActor;
  priority?: NotifyPriority;
}

/** Result of {@link notify}: aggregate counts + per-target outcomes. */
export interface NotifyResult {
  ok: true;
  successful: number;
  failed: number;
  results: DeviceActionOutcome[];
}

/** Parameters for {@link bulkForceLogout} (force-logout many selected devices). */
export interface BulkForceLogoutParams {
  tenantId: string;
  targets: DeviceTarget[];
  actor: ForceLogoutActor;
  reason?: string;
}

/** Result of {@link bulkForceLogout}: aggregate counts + per-target outcomes. */
export interface BulkForceLogoutResult {
  ok: true;
  succeeded: number;
  failed: number;
  results: DeviceActionOutcome[];
}

/** Human-readable message for an arbitrary thrown value. */
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stable error code for a per-target failure: the {@link DeviceAdminError}
 * `code` when available (so the aggregate results carry the same machine-readable
 * codes the single-device routes return), otherwise the error message.
 */
function toServiceErrorCode(err: unknown): string {
  return err instanceof DeviceAdminError ? err.code : toErrorMessage(err);
}

/**
 * Race a delivery promise against a `timeoutMs` timer, rejecting with a
 * `delivery_timeout` error if the timer wins (Requirement 12.5). The timer is
 * `unref`'d so it never keeps the process alive, and cleared as soon as the
 * delivery settles.
 *
 * Exported so the Server_Fanout orchestrator (`deviceFanoutService.fanout`) can
 * reuse the SAME delivery-timeout primitive as `notify` rather than forking a
 * divergent one (device-push-fanout-migration Req 1.5).
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('delivery_timeout'));
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Map `items` through the async `fn` with a bounded concurrency, returning the
 * results in INPUT ORDER (`results[i]` corresponds to `items[i]`).
 *
 * At most `limit` invocations of `fn` are in flight at any moment; as each
 * settles, the next pending item is started, so the total in-flight never
 * exceeds `min(limit, items.length)`. The result array is pre-sized and each
 * result is written at its source index, so ordering is independent of the
 * order in which the tasks happen to finish.
 *
 * This helper NEVER rejects as long as `fn` never rejects — it is used only
 * with mappers that catch their own errors and resolve to an outcome value
 * (see the notify target-resolution / web-push mappers and the per-target bulk
 * mapper), so the bounded fan-out is a pure performance concern with no
 * behavioral change. An
 * empty `items` list resolves immediately to `[]` without invoking `fn`. A
 * `limit <= 0` is clamped to `1`.
 *
 * Pure with respect to output: for the same `items`/`fn` it yields the same
 * ordered results as `Promise.all(items.map(fn))`, only with a capped number of
 * concurrent tasks.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) {
    return results;
  }
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));

  let nextIndex = 0;
  async function worker(): Promise<void> {
    // Each worker pulls the next unclaimed index until the queue drains,
    // preserving positional results via `results[index]`.
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < effectiveLimit; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/** Map the console notification priority onto Expo's `priority` field. */
function toExpoPriority(priority?: NotifyPriority): 'default' | 'normal' | 'high' {
  switch (priority) {
    case 'high':
      return 'high';
    case 'low':
      return 'default';
    case 'normal':
    default:
      return 'normal';
  }
}

/** Map the console notification priority onto web push `urgency`. */
function toWebPushUrgency(priority?: NotifyPriority): 'very-low' | 'low' | 'normal' | 'high' {
  switch (priority) {
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    case 'normal':
    default:
      return 'normal';
  }
}

/**
 * Classification of a single notify target after its device doc is read.
 *
 * `notify` resolves every target into exactly one of these WITHOUT throwing, so
 * a missing/out-of-scope/channel-less device is captured as a failure rather
 * than aborting the rest (Requirement 3.2; design Property 18). `expo`/`web`
 * carry the resolved push address; `failure` carries the stable error code that
 * becomes the target's {@link DeviceActionOutcome} error verbatim.
 */
type ResolvedNotifyTarget =
  | { kind: 'failure'; email: string; deviceId: string; error: string }
  | { kind: 'expo'; email: string; deviceId: string; token: string }
  | { kind: 'web'; email: string; deviceId: string; subscription: WebPushSubscriptionShape };

/**
 * Resolve one notify target's push channel from its device doc, NEVER throwing.
 *
 * Loads `user_devices/{email}/devices/{deviceId}` and classifies the target:
 * `device_not_found` for a missing doc, a read-error message on a failed read,
 * `tenant_scope_violation` for an out-of-tenant device (Requirement 3.2), an
 * `expo` target when a non-empty `expoPushToken` is present (PREFERRED over
 * web-push), a `web` target for a valid `webPushSubscription`, or a
 * `no_push_target` failure when the device has no usable channel. This is the
 * read/classification half of delivery; the actual send happens in the batched
 * Expo phase / per-target web-push phase of {@link notify}.
 */
async function resolveNotifyTarget(
  db: admin.firestore.Firestore,
  tenantId: string,
  target: DeviceTarget
): Promise<ResolvedNotifyTarget> {
  const { email, deviceId } = target;

  let data: Record<string, unknown>;
  try {
    const deviceRef = db
      .collection('user_devices')
      .doc(email)
      .collection('devices')
      .doc(deviceId);
    const snapshot = await deviceRef.get();
    if (!snapshot.exists) {
      return { kind: 'failure', email, deviceId, error: 'device_not_found' };
    }
    data = (snapshot.data() ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { kind: 'failure', email, deviceId, error: toErrorMessage(err) };
  }

  // Tenant isolation for bulk: an out-of-scope target is a FAILED result, not a
  // throw, so the remaining targets are still processed (Requirement 3.2).
  if (!assertTenantScope(data, tenantId)) {
    return { kind: 'failure', email, deviceId, error: 'tenant_scope_violation' };
  }

  const expoToken =
    typeof data.expoPushToken === 'string' && data.expoPushToken.trim().length > 0
      ? data.expoPushToken.trim()
      : undefined;
  if (expoToken) {
    // Expo token is PREFERRED over web-push (unchanged precedence).
    return { kind: 'expo', email, deviceId, token: expoToken };
  }

  const subscription: WebPushSubscriptionShape | null = sanitizeWebPushSubscription(
    data.webPushSubscription
  );
  if (subscription) {
    return { kind: 'web', email, deviceId, subscription };
  }

  // No usable push channel on this device.
  return { kind: 'failure', email, deviceId, error: 'no_push_target' };
}

/**
 * Deliver one notification to a single WEB-PUSH target, returning its
 * {@link DeviceActionOutcome}. Wraps the `sendWebPushNotification` call in a 30s
 * timeout (Requirement 12.5) and NEVER throws — a delivery failure, timeout, or
 * push-service-unavailable condition maps to a FAILED outcome (Requirements
 * 12.5, 12.7, 14.7). Expo targets are NOT delivered here; they go through the
 * batched Expo phase in {@link notify}.
 */
async function deliverWebPushNotification(
  target: { email: string; deviceId: string; subscription: WebPushSubscriptionShape },
  title: string,
  body: string,
  priority?: NotifyPriority
): Promise<DeviceActionOutcome> {
  const { email, deviceId, subscription } = target;
  try {
    const result = await withTimeout(
      sendWebPushNotification({
        subscription,
        payload: { title, body, data: { type: 'device_console_notification' } },
        urgency: toWebPushUrgency(priority),
      }),
      NOTIFY_DELIVERY_TIMEOUT_MS
    );
    const ok = result.ok === true;
    return {
      email,
      deviceId,
      ok,
      error: ok ? undefined : result.errorCode ?? 'web_push_delivery_failed',
    };
  } catch (err) {
    return { email, deviceId, ok: false, error: toErrorMessage(err) };
  }
}

/**
 * Send one notification to many selected in-tenant targets through the existing
 * Push_Delivery_Service (Requirements 12.2, 12.3, 12.5, 12.7, 14.7, 14.8; design
 * Property 18).
 *
 * Runs in three phases so the completeness invariants hold regardless of channel
 * mix:
 *   1. RESOLUTION — read each device doc concurrently (bounded fan-out) and
 *      classify it into a failure outcome (`device_not_found` /
 *      `tenant_scope_violation` / read error / `no_push_target`), an Expo target,
 *      or a web-push target (Expo token preferred). Never throws.
 *   2. EXPO BATCH — all Expo targets go out in ONE `sendExpoMessages(...)` call
 *      (internally chunked to ≤100 per HTTP request) wrapped in a SINGLE 30s
 *      timeout. Each target's outcome is read from the index-aligned per-message
 *      `results`. If the batched call times out or the push service is
 *      unavailable/throws, EVERY Expo target in the batch is failed
 *      (Requirement 12.7).
 *   3. WEB-PUSH — each web-push target is delivered individually with its own 30s
 *      timeout, concurrently with a bounded fan-out.
 * Outcomes are reassembled into INPUT ORDER so `results[i]` corresponds to
 * `targets[i]`.
 *
 * TIMEOUT-GRANULARITY TRADEOFF (Requirement 12.5): batching means up to 100 Expo
 * messages now SHARE one 30s timeout instead of each getting its own. This is an
 * intentional cost of collapsing up to 500 Expo HTTP requests into ceil(N/100).
 * A per-target failure, timeout, or push-service-unavailable condition is still
 * captured as a failed outcome and never aborts the remaining targets
 * (Requirements 12.7, 14.7). The returned `successful + failed` equals the number
 * of targets and every target appears exactly once in `results` (design
 * Property 18). Exactly one `notify` audit entry is written recording the
 * delivery counts and the aggregate outcome (`success` when none failed,
 * `failure` when none succeeded, otherwise `partial`); an audit-write failure
 * propagates so the route reports the action as not recorded (Requirement 17.4).
 * Route-level validation guarantees a non-empty, ≤500 target list and the
 * title/body bounds; the ≤500 cap is re-asserted here defensively (Property 19).
 *
 * Scope-invariant (device-tenant-index write-path contract): this orchestrator
 * does NOT write `tenantIds`/`activeTenantId`/`tenantMemberships`, so a device's
 * derived `tenantIndex` is unchanged by it and needs no maintenance here.
 */
export async function notify(params: NotifyParams): Promise<NotifyResult> {
  const { tenantId, title, body, targets, actor, priority } = params;

  // Defensive cap (the route also validates 1–500 targets — Requirement 14.2,
  // design Property 19).
  if (targets.length > DEFAULT_MAX_TARGETS) {
    throw new DeviceAdminError(
      'too_many_targets',
      400,
      `notify accepts at most ${DEFAULT_MAX_TARGETS} targets`
    );
  }

  const db = getFirestore();

  // Phase 1 — RESOLUTION. Read + classify every target concurrently (bounded
  // fan-out). `resolveNotifyTarget` never throws, and `mapWithConcurrency`
  // preserves input order, so `resolved[i]` corresponds to `targets[i]`.
  const resolved = await mapWithConcurrency(targets, DEVICE_ACTION_CONCURRENCY, (target) =>
    resolveNotifyTarget(db, tenantId, target)
  );

  // Outcomes are written back at each target's ORIGINAL index so the returned
  // `results` are in INPUT ORDER and every target appears exactly once
  // (design Property 18).
  const results: DeviceActionOutcome[] = new Array(targets.length);
  const expoEntries: Array<{ index: number; email: string; deviceId: string; message: ExpoPushMessage }> = [];
  const webEntries: Array<{ index: number; email: string; deviceId: string; subscription: WebPushSubscriptionShape }> = [];

  resolved.forEach((entry, index) => {
    if (entry.kind === 'failure') {
      results[index] = { email: entry.email, deviceId: entry.deviceId, ok: false, error: entry.error };
    } else if (entry.kind === 'expo') {
      expoEntries.push({
        index,
        email: entry.email,
        deviceId: entry.deviceId,
        message: {
          to: entry.token,
          title,
          body,
          priority: toExpoPriority(priority),
          data: { type: 'device_console_notification' },
        },
      });
    } else {
      webEntries.push({
        index,
        email: entry.email,
        deviceId: entry.deviceId,
        subscription: entry.subscription,
      });
    }
  });

  // Phase 2 — EXPO BATCH. All Expo targets go out in ONE `sendExpoMessages` call
  // (internally chunked ≤100/request) under a SINGLE shared 30s timeout. On a
  // batch timeout / thrown / push-service-unavailable condition, EVERY Expo
  // target in the batch is failed (Requirement 12.7); otherwise each target's
  // outcome comes from the index-aligned per-message `results`.
  if (expoEntries.length > 0) {
    let batchResult: SendExpoMessagesResult | null = null;
    let batchError: string | null = null;
    try {
      batchResult = await withTimeout(
        sendExpoMessages(
          expoEntries.map((e) => e.message),
          { context: 'device_notify' }
        ),
        NOTIFY_DELIVERY_TIMEOUT_MS
      );
    } catch (err) {
      batchError = toErrorMessage(err);
    }

    expoEntries.forEach((entry, k) => {
      if (!batchResult) {
        results[entry.index] = {
          email: entry.email,
          deviceId: entry.deviceId,
          ok: false,
          error: batchError ?? 'expo_delivery_failed',
        };
        return;
      }
      const perMessage = batchResult.results[k];
      const ok = perMessage?.ok === true;
      results[entry.index] = {
        email: entry.email,
        deviceId: entry.deviceId,
        ok,
        error: ok ? undefined : perMessage?.error ?? 'expo_delivery_failed',
      };
    });
  }

  // Phase 3 — WEB-PUSH. Each web-push target keeps its own per-target 30s
  // timeout, delivered concurrently with a bounded fan-out.
  if (webEntries.length > 0) {
    const webOutcomes = await mapWithConcurrency(webEntries, DEVICE_ACTION_CONCURRENCY, (entry) =>
      deliverWebPushNotification(entry, title, body, priority)
    );
    webEntries.forEach((entry, k) => {
      results[entry.index] = webOutcomes[k];
    });
  }

  const successful = results.reduce((count, r) => (r.ok ? count + 1 : count), 0);
  const failed = results.length - successful;
  const outcome: DeviceAuditOutcome =
    failed === 0 ? 'success' : successful === 0 ? 'failure' : 'partial';

  // Exactly one notify audit entry with delivery counts + outcome (design's
  // "every notify call writes one deviceAuditLogs entry with delivery counts").
  await writeAudit({
    tenantId,
    action: 'notify',
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.name,
    affectedCount: successful,
    outcome,
    metadata: { successful, failed, total: results.length, title },
  });

  return { ok: true, successful, failed, results };
}

/**
 * Force logout many selected in-tenant devices (Requirements 14.2, 14.4, 14.7,
 * 14.8; design Properties 18, 19).
 *
 * Fans out to the single-device {@link forceLogout} per target, capturing each
 * per-target error into `results` and continuing past failures so one target's
 * failure never aborts the rest (Requirement 14.7). Each successful per-target
 * force-logout writes its OWN single `force_logout` audit entry (Requirement 7.4;
 * design Property 14); this aggregate does not write an extra summary audit entry
 * (see the audit-approach note above). The returned `succeeded + failed` equals
 * the number of targets and every target appears exactly once in `results`
 * (design Property 18). Accepts at most 500 targets, rejecting a larger selection
 * with `too_many_targets` (Requirement 14.2; design Property 19) — the route also
 * validates this.
 */
export async function bulkForceLogout(
  params: BulkForceLogoutParams
): Promise<BulkForceLogoutResult> {
  const { tenantId, targets, actor, reason } = params;

  // ≤500 cap (Requirement 14.2, design Property 19); the route also validates.
  if (targets.length > DEFAULT_MAX_TARGETS) {
    throw new DeviceAdminError(
      'too_many_targets',
      400,
      `bulkForceLogout accepts at most ${DEFAULT_MAX_TARGETS} targets`
    );
  }

  // Bounded fan-out over the single-device orchestrator. `mapWithConcurrency`
  // preserves input order and returns exactly one outcome per target (the
  // mapper catches its own errors and never rejects), so `succeeded + failed`
  // still equals the number of targets and every target appears exactly once in
  // `results` (design Property 18) — only the concurrency is capped.
  const results = await mapWithConcurrency(
    targets,
    DEVICE_ACTION_CONCURRENCY,
    async (target): Promise<DeviceActionOutcome> => {
      try {
        // Reuse the single-device orchestrator: it asserts tenant scope + not
        // deleted before any write and writes its own `force_logout` audit entry.
        await forceLogout({
          tenantId,
          email: target.email,
          deviceId: target.deviceId,
          actor,
          reason,
        });
        return { email: target.email, deviceId: target.deviceId, ok: true };
      } catch (err) {
        // Per-target failure captured without aborting the rest (Requirement 14.7).
        return {
          email: target.email,
          deviceId: target.deviceId,
          ok: false,
          error: toServiceErrorCode(err),
        };
      }
    }
  );

  const succeeded = results.reduce((count, r) => (r.ok ? count + 1 : count), 0);
  const failed = results.length - succeeded;

  return { ok: true, succeeded, failed, results };
}

// ---------------------------------------------------------------------------
// History & timeline queries (server-side reads; NO mutation)
// ---------------------------------------------------------------------------
//
// These back the tenant-scoped action/notification history (Requirements 13.1,
// 13.5, 17.5; design Property 21) and the per-device activity timeline
// (Requirements 19.1, 19.4; design Property 22). Both are pure reads against the
// append-only `deviceAuditLogs` collection written by `writeAudit` — they never
// mutate state.
//
// ALL-OR-NOTHING (Requirement 13.5): neither helper wraps its Firestore read in
// a try/catch. The whole result set is materialized from a single `.get()` and
// only then mapped to records, so if the query throws, the error propagates to
// the route (which maps it to `history_failed`) and NO partial entries are ever
// returned.
//
// CURSOR / ORDERING SCHEME:
//   - `fetchHistory` orders most-recent-first (`actionTimeMs` DESC — Req 13.1,
//     17.5) and paginates with an opaque cursor that is simply the Firestore
//     document id of the last entry of the previous page. To advance, the cursor
//     doc is re-read and passed to Firestore `startAfter(snapshot)`, which
//     positions deterministically using the ordered field values plus the
//     implicit document-name tiebreak. Because the audit collection is
//     append-only (docs are never deleted), a handed-out cursor remains valid;
//     an unknown/blank cursor is ignored (first page). One extra doc is fetched
//     per page (`limit + 1`) purely to compute `hasMore` / `nextCursor`.
//   - `fetchTimeline` orders oldest-first (`actionTimeMs` ASC — Req 19.1) and
//     applies a STABLE secondary sort by audit-entry `id` for equal
//     `actionTimeMs` (Req 19.4). Entries are keyed by `targetDeviceId`, matching
//     the `(tenantId, targetDeviceId, actionTimeMs)` composite index (task 3.3).
//     It first asserts the target device exists and is tenant-scoped (mirroring
//     `fetchDeviceDetail`: 404 `device_not_found` / 403 `tenant_scope_violation`)
//     and paginates with the SAME `limit + 1` opaque doc-id cursor as
//     `fetchHistory`, taking the cursor boundary from the Firestore-ordered page
//     (before the in-memory id re-sort) so pages join without gaps/overlaps.

/** Default page size for {@link fetchHistory} when the caller omits `limit`. */
export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * A single audit entry surfaced by the history/timeline reads: the persisted
 * `deviceAuditLogs` document body plus its Firestore auto-id (`id`), which also
 * serves as the stable tie-break key for equal `actionTimeMs` (Requirement
 * 19.4). `action`/`outcome` are surfaced as-stored; `actionTimeMs` (primary
 * sort key) and `createdAt` (ISO 8601 with timezone) are always present.
 */
export interface AuditEntryRecord {
  /** Firestore auto-id of the audit doc; stable tie-break key (Req 19.4). */
  id: string;
  /** Tenant that scopes the entry (Req 13.1, 17.5). */
  tenantId: string;
  /** The recorded device action (surfaced as stored). */
  action: string;
  /** Authenticated actor id, when recorded. */
  actorId?: string;
  /** Authenticated actor email, when recorded. */
  actorEmail?: string;
  /** Actor display name, when recorded. */
  actorName?: string;
  /** Target device id, for device-scoped actions. */
  targetDeviceId?: string;
  /** Target user email, for user-scoped actions. */
  targetUserEmail?: string;
  /** Supplied reason, when recorded. */
  reason?: string;
  /** Affected device count for force-logout-all / bulk actions. */
  affectedCount?: number;
  /** Result classification for bulk/partial actions. */
  outcome?: DeviceAuditOutcome;
  /** Free-form details, e.g. per-device results or delivery counts. */
  metadata?: Record<string, unknown>;
  /** Epoch ms of the action; primary sort key. */
  actionTimeMs: number;
  /** ISO 8601 timestamp with timezone (Req 13.2). */
  createdAt: string;
}

/** Parameters for {@link fetchHistory} (tenant-scoped audit history). */
export interface FetchHistoryParams {
  /** The Selected_Tenant whose audit entries are returned (Req 13.1). */
  tenantId: string;
  /** Page size; defaults to {@link DEFAULT_HISTORY_LIMIT} when omitted. */
  limit?: number;
  /** Opaque pagination cursor: the `id` of the last entry of the prior page. */
  cursor?: string;
  /** Optional action filter (e.g. `'ban'`); when omitted, all actions match. */
  action?: string;
}

/** Result of {@link fetchHistory}. */
export interface FetchHistoryResult {
  ok: true;
  /** The page of audit entries, most-recent-first (Req 13.1, 17.5). */
  entries: AuditEntryRecord[];
  /** True when at least one more entry exists beyond this page. */
  hasMore: boolean;
  /** Cursor to pass as `cursor` for the next page; present iff `hasMore`. */
  nextCursor?: string;
}

/** Parameters for {@link fetchTimeline} (per-device activity timeline). */
export interface FetchTimelineParams {
  /** The Selected_Tenant that scopes the timeline (Req 19.1). */
  tenantId: string;
  /** Owning user email; used to locate the device doc for the existence check. */
  email: string;
  /** The device whose timeline is returned (keyed on `targetDeviceId`). */
  deviceId: string;
  /** Page size; defaults to {@link DEFAULT_HISTORY_LIMIT} when omitted. */
  limit?: number;
  /** Opaque pagination cursor: the `id` of the last entry of the prior page. */
  cursor?: string;
}

/** Result of {@link fetchTimeline}. */
export interface FetchTimelineResult {
  ok: true;
  /** The device's entries, oldest-first with a stable id tie-break (Req 19.4). */
  entries: AuditEntryRecord[];
  /** True when at least one more entry exists beyond this page. */
  hasMore: boolean;
  /** Cursor to pass as `cursor` for the next page; present iff `hasMore`. */
  nextCursor?: string;
}

/**
 * Resolve a caller-supplied history page size to a positive integer, falling
 * back to {@link DEFAULT_HISTORY_LIMIT} for missing/invalid values. Pure.
 */
function resolveHistoryLimit(limit?: number): number {
  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 1) {
    return Math.floor(limit);
  }
  return DEFAULT_HISTORY_LIMIT;
}

/**
 * Map a `deviceAuditLogs` document (`id` + raw data) to an
 * {@link AuditEntryRecord}. Defensive: required fields fall back to safe
 * defaults and optional fields are copied only when present with the expected
 * type, so a malformed stored doc can never produce `undefined`-typed required
 * fields. Pure: no I/O.
 */
function toAuditEntryRecord(
  id: string,
  raw: admin.firestore.DocumentData | undefined
): AuditEntryRecord {
  const data = (raw ?? {}) as Record<string, unknown>;
  const record: AuditEntryRecord = {
    id,
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : '',
    action: typeof data.action === 'string' ? data.action : '',
    actionTimeMs:
      typeof data.actionTimeMs === 'number' && Number.isFinite(data.actionTimeMs)
        ? data.actionTimeMs
        : 0,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
  };

  if (typeof data.actorId === 'string') {
    record.actorId = data.actorId;
  }
  if (typeof data.actorEmail === 'string') {
    record.actorEmail = data.actorEmail;
  }
  if (typeof data.actorName === 'string') {
    record.actorName = data.actorName;
  }
  if (typeof data.targetDeviceId === 'string') {
    record.targetDeviceId = data.targetDeviceId;
  }
  if (typeof data.targetUserEmail === 'string') {
    record.targetUserEmail = data.targetUserEmail;
  }
  if (typeof data.reason === 'string') {
    record.reason = data.reason;
  }
  if (typeof data.affectedCount === 'number' && Number.isFinite(data.affectedCount)) {
    record.affectedCount = data.affectedCount;
  }
  if (data.outcome === 'success' || data.outcome === 'partial' || data.outcome === 'failure') {
    record.outcome = data.outcome;
  }
  if (typeof data.metadata === 'object' && data.metadata !== null) {
    record.metadata = data.metadata as Record<string, unknown>;
  }

  return record;
}

/**
 * Read the Selected_Tenant's Device Console audit history, most-recent-first
 * (Requirements 13.1, 13.5, 17.5; design Property 21).
 *
 * Queries `deviceAuditLogs` where `tenantId == params.tenantId` (plus an
 * optional `action` equality filter), ordered by `actionTimeMs` DESC, and
 * paginates via the opaque doc-id cursor described in the section header
 * (`startAfter` on the re-read cursor snapshot). Fetches one extra document to
 * compute `hasMore` and `nextCursor`. ALL-OR-NOTHING: the read is not wrapped in
 * a try/catch, so a query failure propagates and no partial entries are returned
 * (Requirement 13.5); the route maps the failure to `history_failed`.
 */
export async function fetchHistory(params: FetchHistoryParams): Promise<FetchHistoryResult> {
  const { tenantId, limit, cursor, action } = params;
  const db = getFirestore();
  const pageSize = resolveHistoryLimit(limit);

  let query: admin.firestore.Query<admin.firestore.DocumentData> = db
    .collection(DEVICE_AUDIT_LOG_COLLECTION)
    .where('tenantId', '==', tenantId);

  if (typeof action === 'string' && action.trim().length > 0) {
    query = query.where('action', '==', action.trim());
  }

  // Most-recent-first (Req 13.1, 17.5).
  query = query.orderBy('actionTimeMs', 'desc');

  // Cursor = id of the last entry of the previous page. Re-read it and hand the
  // snapshot to `startAfter` for a deterministic position; ignore an
  // unknown/blank cursor (append-only ⇒ a handed-out cursor stays valid).
  if (typeof cursor === 'string' && cursor.trim().length > 0) {
    const cursorSnap = await db
      .collection(DEVICE_AUDIT_LOG_COLLECTION)
      .doc(cursor.trim())
      .get();
    if (cursorSnap.exists) {
      query = query.startAfter(cursorSnap);
    }
  }

  // One extra doc beyond the page reveals whether more entries exist.
  const snapshot = await query.limit(pageSize + 1).get();
  const docs = snapshot.docs;

  const hasMore = docs.length > pageSize;
  const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;
  const entries = pageDocs.map((doc) => toAuditEntryRecord(doc.id, doc.data()));

  const result: FetchHistoryResult = { ok: true, entries, hasMore };
  if (hasMore && entries.length > 0) {
    result.nextCursor = entries[entries.length - 1].id;
  }
  return result;
}

/**
 * Read a single device's activity timeline, oldest-first (Requirements 19.1,
 * 19.4, 6.6, 3.2; design Property 22).
 *
 * BEFORE returning any entries this reads `user_devices/{email}/devices/
 * {deviceId}` and rejects a device that does not exist ({@link
 * DeviceNotFoundError} → 404) or one outside the scoped tenant ({@link
 * TenantScopeError} → 403), mirroring {@link fetchDeviceDetail} so the timeline
 * agrees with the design's error table. A device that EXISTS and is in-scope but
 * has no audit rows still returns an empty `entries` array (200).
 *
 * Queries `deviceAuditLogs` where `tenantId == params.tenantId` AND
 * `targetDeviceId == params.deviceId`, ordered by `actionTimeMs` ASC, and
 * paginates with the same opaque doc-id cursor pattern as {@link fetchHistory}
 * (fetch `limit + 1` for look-ahead; `startAfter` on the re-read cursor
 * snapshot). A STABLE in-memory secondary sort by audit-entry `id` breaks equal
 * `actionTimeMs` values deterministically (Requirement 19.4); the cursor
 * boundary is taken from the Firestore-ordered page (before that re-sort) so
 * `startAfter` advances without skipping or duplicating entries. ALL-OR-NOTHING:
 * the reads are not wrapped in a try/catch, so a query failure propagates with
 * no partial entries.
 */
export async function fetchTimeline(params: FetchTimelineParams): Promise<FetchTimelineResult> {
  const { tenantId, email, deviceId, limit, cursor } = params;
  const db = getFirestore();
  const pageSize = resolveHistoryLimit(limit);

  // Existence + tenant-scope check BEFORE any read of the audit log, mirroring
  // `fetchDeviceDetail`: an unknown device → 404 `device_not_found`, an
  // out-of-scope device → 403 `tenant_scope_violation` (Req 6.6, 3.2, 3.3).
  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) {
    throw new DeviceNotFoundError();
  }
  const deviceData = (deviceSnap.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(deviceData, tenantId)) {
    throw new TenantScopeError();
  }

  let query: admin.firestore.Query<admin.firestore.DocumentData> = db
    .collection(DEVICE_AUDIT_LOG_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('targetDeviceId', '==', deviceId)
    // Oldest-first (Req 19.1).
    .orderBy('actionTimeMs', 'asc');

  // Cursor = id of the last entry of the previous page. Re-read it and hand the
  // snapshot to `startAfter` for a deterministic position; ignore an
  // unknown/blank cursor (append-only ⇒ a handed-out cursor stays valid).
  if (typeof cursor === 'string' && cursor.trim().length > 0) {
    const cursorSnap = await db
      .collection(DEVICE_AUDIT_LOG_COLLECTION)
      .doc(cursor.trim())
      .get();
    if (cursorSnap.exists) {
      query = query.startAfter(cursorSnap);
    }
  }

  // One extra doc beyond the page reveals whether more entries exist.
  const snapshot = await query.limit(pageSize + 1).get();
  const docs = snapshot.docs;

  const hasMore = docs.length > pageSize;
  const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;

  // Cursor boundary follows Firestore's ordering (BEFORE the in-memory re-sort
  // below) so `startAfter` continues from exactly where this page ends without
  // skipping or duplicating entries across pages.
  const nextCursor =
    pageDocs.length > 0 ? pageDocs[pageDocs.length - 1].id : undefined;

  const entries = pageDocs.map((doc) => toAuditEntryRecord(doc.id, doc.data()));

  // Stable secondary sort by id for equal actionTimeMs (Req 19.4). The primary
  // ordering already comes from Firestore; this makes the tie-break explicit and
  // deterministic regardless of Firestore's implicit tiebreak direction.
  entries.sort((a, b) => {
    if (a.actionTimeMs !== b.actionTimeMs) {
      return a.actionTimeMs - b.actionTimeMs;
    }
    return a.id.localeCompare(b.id);
  });

  const result: FetchTimelineResult = { ok: true, entries, hasMore };
  if (hasMore && nextCursor !== undefined) {
    result.nextCursor = nextCursor;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Device listing & detail reads (server-side; project raw docs → DeviceAdminRecord)
// ---------------------------------------------------------------------------
//
// These back the Device Console list endpoint (#1) and detail endpoint (#2)
// (Requirements 1.2, 1.4, 3.1, 3.5, 6.1). They generalize the existing
// `POST /admin/tenants/user-devices` projection from a single `(tenantId, email)`
// pair to the whole tenant: enumerate `user_devices/{email}` parent docs and
// their `devices/{deviceId}` subcollection, project each raw device document to
// the console-facing `DeviceAdminRecord`, and scope the result with
// `filterDevicesForTenant` (design Property 3).
//
// Timestamps are serialized to ISO 8601 strings at this boundary (mirroring the
// existing endpoint's `toIso`) plus an epoch-ms `lastSeenMs` companion so the
// pure `classifyOnline`/`computeCounts`/`sortAndGroup` helpers can reason about
// last-seen deterministically. `isHardBanned` is populated from active
// `device_bans` records (matched by the device's derived fingerprint) so the
// pure `matchesFilter`/`isInactiveDevice` helpers stay free of Firestore/I/O.
//
// Security: like the existing user-devices endpoint, this projection does NOT
// surface raw push credentials (`expoPushToken` / `webPushSubscription`); it
// exposes only their sync-status flags. The `notify` orchestrator reads the raw
// tokens straight from Firestore when it needs them.

/** Convert a Firestore `Timestamp`/`Date`/ISO string to an ISO 8601 string. */
function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : value.toISOString();
  }
  const maybeToDate = (value as { toDate?: () => Date }).toDate;
  if (typeof maybeToDate === 'function') {
    try {
      return maybeToDate.call(value).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

// `toEpochMs` (the raw Firestore Timestamp/Date/number/ISO → epoch-ms resolver)
// now lives in `./lib/deviceLastSeen` so the Device Console read path and the
// offline-device prune job share ONE conversion. It is imported at the top of
// this module.

/** Narrow an unknown value to `deviceType`, or `undefined`. */
function toDeviceType(value: unknown): DeviceType | undefined {
  return value === 'mobile' || value === 'web' || value === 'tablet' ? value : undefined;
}

/** Narrow an unknown value to `logoutType`, or `undefined`. */
function toLogoutType(value: unknown): DeviceLogoutType | undefined {
  return value === 'manual' || value === 'forced' || value === 'auto' ? value : undefined;
}

/** Narrow an unknown value to `pushTokenStatus`, or `undefined`. */
function toPushTokenStatus(value: unknown): DevicePushTokenStatus | undefined {
  return value === 'synced' || value === 'missing' || value === 'requested' || value === 'unknown'
    ? value
    : undefined;
}

/** Narrow an unknown value to `webPushStatus`, or `undefined`. */
function toWebPushStatus(value: unknown): DeviceWebPushStatus | undefined {
  return value === 'subscribed' ||
    value === 'unsubscribed' ||
    value === 'unsupported' ||
    value === 'permission_denied' ||
    value === 'sync_required' ||
    value === 'error'
    ? value
    : undefined;
}

/** Copy a string field through, mapping non-strings to `undefined`. */
function toStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Copy a boolean field through, mapping non-booleans to `undefined`. */
function toBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Project the stored `tenantMemberships` array to the loose console shape. */
function toTenantMemberships(value: unknown): DeviceTenantMembership[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const memberships: DeviceTenantMembership[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const m = entry as { tenantId?: unknown; role?: unknown; status?: unknown };
    if (typeof m.tenantId !== 'string' || m.tenantId.trim().length === 0) {
      continue;
    }
    const membership: DeviceTenantMembership = { tenantId: m.tenantId };
    if (typeof m.role === 'string') {
      membership.role = m.role;
    }
    if (typeof m.status === 'string') {
      membership.status = m.status;
    }
    memberships.push(membership);
  }
  return memberships;
}

/**
 * Project a raw `user_devices/{email}/devices/{deviceId}` document to the
 * console-facing {@link DeviceAdminRecord}. Field names mirror the on-device
 * `UserDevice`, so most fields copy through with a type guard; timestamp fields
 * are serialized to ISO strings (with an epoch-ms `lastSeenMs` companion), and
 * `ownerEmail` / `ownerDisplayName` / `isHardBanned` are supplied by the caller
 * (derived from the parent doc and the active `device_bans` records). Pure: no
 * I/O — takes already-loaded data. Deliberately omits raw push credentials.
 */
function projectDeviceRecord(
  deviceId: string,
  data: Record<string, unknown>,
  ownerEmail: string | null,
  ownerDisplayName: string | null,
  isHardBanned: boolean
): DeviceAdminRecord {
  const tenantIds = Array.isArray(data.tenantIds)
    ? (data.tenantIds as unknown[])
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim())
    : undefined;

  return {
    // Identity
    deviceId,
    deviceType: toDeviceType(data.deviceType),

    // Hardware / model metadata
    deviceName: toStr(data.deviceName),
    modelName: toStr(data.modelName),
    manufacturer: toStr(data.manufacturer),
    brand: toStr(data.brand),

    // Platform / OS metadata
    platformOS: toStr(data.platformOS),
    osName: toStr(data.osName),
    osVersion: toStr(data.osVersion),

    // Browser metadata
    browserName: toStr(data.browserName),
    browserVersion: toStr(data.browserVersion),
    userAgent: toStr(data.userAgent),

    // Network metadata
    ipAddress: toStr(data.ipAddress),
    networkType: toStr(data.networkType),
    carrierName: toStr(data.carrierName),
    countryCode: toStr(data.countryCode),

    // Presence / activity
    lastSeen: toIsoString(data.lastSeen),
    lastSeenMs: toEpochMs(data.lastSeen),
    isOnline: toBool(data.isOnline),
    sessionActive: toBool(data.sessionActive),
    lastActivityType: toStr(data.lastActivityType),
    logoutType: toLogoutType(data.logoutType),

    // Soft-delete provenance
    isDeleted: toBool(data.isDeleted),
    deletedAt: toIsoString(data.deletedAt),
    deletedBy: toStr(data.deletedBy),
    deletedByName: toStr(data.deletedByName),
    deletionReason: toStr(data.deletionReason),
    isRestored: toBool(data.isRestored),
    restoredAt: toIsoString(data.restoredAt),

    // Force-logout provenance
    forcedLogoutBy: toStr(data.forcedLogoutBy),
    forcedLogoutByName: toStr(data.forcedLogoutByName),
    forcedLogoutAt: toIsoString(data.forcedLogoutAt),
    forcedLogoutReason: toStr(data.forcedLogoutReason),
    logoutSignal: toBool(data.logoutSignal),

    // Ban state (derived by the caller from active `device_bans`)
    isHardBanned,

    // Tenant scoping
    tenantIds,
    activeTenantId: typeof data.activeTenantId === 'string' ? data.activeTenantId : null,
    lastTenantId: typeof data.lastTenantId === 'string' ? data.lastTenantId : null,
    tenantMemberships: toTenantMemberships(data.tenantMemberships),

    // Owner attribution (from the parent `user_devices/{email}` doc)
    ownerEmail,
    ownerDisplayName,

    // Push status (raw credentials intentionally not surfaced)
    pushTokenStatus: toPushTokenStatus(data.pushTokenStatus),
    webPushStatus: toWebPushStatus(data.webPushStatus),
  };
}

/**
 * Load the set of device fingerprints that currently have an active hard ban,
 * so `isHardBanned` can be resolved for a whole tenant's devices with a single
 * `device_bans` read instead of one lookup per device.
 */
async function loadActiveBanFingerprints(
  db: admin.firestore.Firestore
): Promise<Set<string>> {
  const snapshot = await db
    .collection(DEVICE_BANS_COLLECTION)
    .where('isActive', '==', true)
    .get();
  const fingerprints = new Set<string>();
  for (const doc of snapshot.docs) {
    const fingerprint = doc.get('deviceFingerprint');
    if (typeof fingerprint === 'string' && fingerprint.trim().length > 0) {
      fingerprints.add(fingerprint.trim());
    }
  }
  return fingerprints;
}

/** Resolve the owner email from the parent doc id (the email) or an `email` field. */
function resolveOwnerEmail(docId: string, parentData: Record<string, unknown>): string | null {
  if (typeof parentData.email === 'string' && parentData.email.trim().length > 0) {
    return parentData.email.trim();
  }
  return typeof docId === 'string' && docId.trim().length > 0 ? docId.trim() : null;
}

/** Resolve an owner display name from common parent-doc fields, if present. */
function resolveOwnerDisplayName(parentData: Record<string, unknown>): string | null {
  const candidates = [
    parentData.displayName,
    parentData.ownerDisplayName,
    parentData.name,
    parentData.userName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Full-scan listing of every device associated with `trimmed` (the retained,
 * proven fallback path — Requirements 1.2, 3.1; design Property 3, Component 5).
 *
 * Enumerates the `user_devices/{email}` parent docs and each doc's
 * `devices/{deviceId}` subcollection, projects every device via
 * {@link projectDeviceRecord} (populating `ownerEmail`/`ownerDisplayName` from
 * the parent doc and `isHardBanned` from the active `device_bans` fingerprint
 * set), and scopes the result to the tenant with {@link filterDevicesForTenant}.
 * Performs Firestore reads; a read failure propagates so the route maps it to
 * `device_list_failed` (Requirement 1.7). The returned records are unordered —
 * the route applies search/filter/sort/group and count via the pure helpers.
 *
 * This is the exact body of the pre-index `listTenantDevices`, retained
 * UNCHANGED: it is the forced fallback whenever the scoped path is disabled, the
 * backfill is incomplete, or the collection-group index is unavailable
 * (Requirements 8.1, 8.3, 8.4). `trimmed` is always a non-empty, already-trimmed
 * tenant id (the empty-id boundary is enforced by {@link listTenantDevices}).
 */
async function listTenantDevicesFullScan(trimmed: string): Promise<DeviceAdminRecord[]> {
  const db = getFirestore();

  // Bounded read count (independent of the number of users/devices): one
  // `device_bans` read for the active-ban fingerprint set, one `user_devices`
  // read for owner attribution, and one `collectionGroup('devices')` read for
  // every device doc. This replaces the previous `1 + N` sequential pattern
  // (one `user_devices.get()` plus one `devices` subcollection read PER user),
  // eliminating the per-user round trips (N+1) without changing the output.
  const [bannedFingerprints, userDocs, deviceDocs] = await Promise.all([
    loadActiveBanFingerprints(db),
    db.collection('user_devices').get(),
    db.collectionGroup('devices').get(),
  ]);

  // Prefetch owner attribution keyed by the parent `user_devices/{email}` doc
  // id. `ownerEmail`/`ownerDisplayName` are resolved via the SAME helpers used
  // before (`resolveOwnerEmail`/`resolveOwnerDisplayName`), so attribution is
  // identical to the per-user loop it replaces.
  const ownerByParentId = new Map<string, { ownerEmail: string | null; ownerDisplayName: string | null }>();
  for (const userDoc of userDocs.docs) {
    const parentData = (userDoc.data() ?? {}) as Record<string, unknown>;
    ownerByParentId.set(userDoc.id, {
      ownerEmail: resolveOwnerEmail(userDoc.id, parentData),
      ownerDisplayName: resolveOwnerDisplayName(parentData),
    });
  }

  const records: DeviceAdminRecord[] = [];
  for (const deviceDoc of deviceDocs.docs) {
    // Owning email is the parent-path id: `user_devices/{email}/devices/{id}`.
    const parentId = deviceDoc.ref.parent.parent?.id;
    const owner = parentId !== undefined ? ownerByParentId.get(parentId) : undefined;
    // Fall back to the path id / null exactly like `resolveOwnerEmail` /
    // `resolveOwnerDisplayName` do when the parent doc (map entry) is absent —
    // e.g. a device under a parent doc with no materialized fields.
    const ownerEmail = owner ? owner.ownerEmail : resolveOwnerEmail(parentId ?? '', {});
    const ownerDisplayName = owner ? owner.ownerDisplayName : null;

    const data = (deviceDoc.data() ?? {}) as Record<string, unknown>;
    const deviceId =
      typeof data.deviceId === 'string' && data.deviceId.trim().length > 0
        ? data.deviceId.trim()
        : deviceDoc.id;
    const fingerprint = deriveDeviceFingerprint(data);
    const isHardBanned = data.isHardBanned === true || bannedFingerprints.has(fingerprint);
    records.push(
      projectDeviceRecord(deviceId, data, ownerEmail, ownerDisplayName, isHardBanned)
    );
  }

  // Tenant isolation (design Property 3): drop any device not associated with T.
  //
  // Remaining characteristic (intentional, not addressed here): this still
  // reads EVERY device doc in the project because tenant association is derived
  // in `matchesTenantDevice` from multiple device fields
  // (`tenantIds`/`activeTenantId`/`tenantMemberships`) and cannot be expressed
  // as a single server-side filter. A future optimization would denormalize a
  // per-device tenant index and use a `collectionGroup('devices')` where-filter
  // backed by a composite index to push the tenant scope into Firestore. That
  // is a data-model change implemented by `listTenantDevicesScoped` below; this
  // full scan is retained as the forced fallback.
  return filterDevicesForTenant(records, trimmed);
}

// ---------------------------------------------------------------------------
// Scoped listing + rollout decision (design Components 5 & 6)
// ---------------------------------------------------------------------------
//
// `listTenantDevices` gains an indexed query path
// (`collectionGroup('devices').where('tenantIndex','array-contains', t)`) that
// produces a record set byte-for-byte equal to the full scan, so counts /
// search / filter / sort / group (all pure, downstream, in the route) are
// unchanged. The scoped path is selected by a PURE decision function combining a
// feature flag with backfill completion, is entered only for a non-empty trimmed
// tenant id, and transparently falls back to the full scan when the
// collection-group index is unavailable. A defensive `matchesTenantDevice`
// post-filter guarantees no cross-tenant leakage can occur under transient index
// drift.

/** The two listing execution modes selected by {@link decideListingMode}. */
export type ListingMode = 'scoped' | 'fallback';

/**
 * Pure rollout decision (Requirements 8.1–8.3): choose the scoped indexed path
 * ONLY when BOTH the feature flag is enabled AND the backfill has completed;
 * otherwise force the full-scan fallback. Index-unavailability (Req 8.4) is a
 * runtime concern handled at the call site (see {@link isIndexUnavailableError}),
 * not here. Pure: no I/O, deterministic in its inputs.
 */
export function decideListingMode(input: {
  flagEnabled: boolean;
  backfillCompleted: boolean;
}): ListingMode {
  if (!input.flagEnabled) {
    return 'fallback'; // Req 8.1 — flag off ⇒ fallback
  }
  if (!input.backfillCompleted) {
    return 'fallback'; // Req 8.3 — incomplete backfill forces fallback regardless of the flag
  }
  return 'scoped'; // Req 8.2 — flag on AND backfill complete ⇒ scoped
}

/** Environment variable gating the scoped listing path (Requirements 8.1, 8.2). */
export const DEVICE_TENANT_INDEX_LISTING_FLAG = 'DEVICE_TENANT_INDEX_LISTING_ENABLED';

/**
 * Whether the scoped-listing feature flag is enabled
 * (`DEVICE_TENANT_INDEX_LISTING_ENABLED === '1'`), matching the
 * `BILLING_DELINQUENCY_ENFORCEMENT_ENABLED === '1'` convention. Kept as a tiny
 * indirection so it is trivially stubbable in tests. Pure aside from the env read.
 */
export function isScopedListingEnabled(): boolean {
  return process.env[DEVICE_TENANT_INDEX_LISTING_FLAG] === '1';
}

/**
 * Whether `err` is a Firestore "index unavailable" error — the signal to
 * transparently fall back to the full scan (Requirement 8.4). Matches the
 * `FAILED_PRECONDITION` gRPC status (numeric code `9`, or the string
 * `'FAILED_PRECONDITION'` on `code`/`status`) and/or a message containing
 * `"requires an index"` (the text Firestore emits when a query needs an index
 * that has not finished building). Defensive across the shapes the Admin SDK
 * surfaces. Pure: no I/O, deterministic in its inputs.
 */
export function isIndexUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const candidate = err as { code?: unknown; status?: unknown; message?: unknown };

  // gRPC FAILED_PRECONDITION is numeric code 9; some transports surface the
  // string status 'FAILED_PRECONDITION' on `code` or `status` instead.
  if (candidate.code === 9) {
    return true;
  }
  if (typeof candidate.code === 'string' && candidate.code.toUpperCase() === 'FAILED_PRECONDITION') {
    return true;
  }
  if (
    typeof candidate.status === 'string' &&
    candidate.status.toUpperCase() === 'FAILED_PRECONDITION'
  ) {
    return true;
  }

  // Message-based detection: Firestore's missing-index error reads
  // "The query requires an index. ...".
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return message.includes('requires an index');
}

/** Firestore progress doc gating the scoped path on backfill completion. */
export const DEVICE_TENANT_INDEX_BACKFILL_PROGRESS_PATH =
  'migrationProgress/deviceTenantIndexBackfill';

// Backfill completion is MONOTONIC (once `completed`, it never reverts), so the
// observed `true` is memoized in-process to avoid a progress read on every
// listing once the migration is done. A `false` / absent result is deliberately
// NOT cached, so enabling the scoped path needs no redeploy after the backfill
// finishes — the next listing re-reads and flips to scoped.
let backfillCompletedMemo = false;

/**
 * Whether the device tenant-index backfill has completed
 * (`migrationProgress/deviceTenantIndexBackfill.status === 'completed'`).
 * Memoizes ONLY the `true` result (see the note above); reads Firestore at most
 * once per call while still incomplete.
 */
async function isBackfillCompleted(db: admin.firestore.Firestore): Promise<boolean> {
  if (backfillCompletedMemo) {
    return true;
  }
  const snap = await db.doc(DEVICE_TENANT_INDEX_BACKFILL_PROGRESS_PATH).get();
  const completed = snap.exists && snap.get('status') === 'completed';
  if (completed) {
    backfillCompletedMemo = true;
  }
  return completed;
}

/**
 * Whether the scoped indexed listing should be used for the (already-trimmed,
 * non-empty) tenant id `trimmed`, combining the feature flag
 * ({@link isScopedListingEnabled}) and backfill completion via the pure
 * {@link decideListingMode} (Requirements 8.1–8.3). Short-circuits the
 * (memoizable) progress read when the flag is off, so a disabled feature never
 * touches Firestore.
 */
async function shouldUseScopedListing(trimmed: string): Promise<boolean> {
  const flagEnabled = isScopedListingEnabled();
  if (!flagEnabled) {
    // Flag off — no need to read backfill progress (Req 8.1). `trimmed` is only
    // meaningful once we actually issue the scoped query.
    void trimmed;
    return false;
  }
  const db = getFirestore();
  const backfillCompleted = await isBackfillCompleted(db);
  return decideListingMode({ flagEnabled, backfillCompleted }) === 'scoped';
}

/**
 * Max number of parent `user_devices/{email}` refs read per `db.getAll(...)`
 * call in the scoped listing. For a large tenant the distinct-parent set can be
 * in the thousands; reading them in bounded chunks (instead of one enormous
 * `getAll`) keeps each round-trip small and reliable. Purely a batching knob —
 * the merged owner attribution (and therefore the output) is unchanged.
 */
const OWNER_READ_CHUNK_SIZE = 300;

/**
 * How many owner-read chunks may be in flight at once (small, bounded fan-out
 * via {@link mapWithConcurrency}). Output is order-independent (results are
 * merged into a map keyed by parent id), so concurrency changes nothing but the
 * wall-clock cost.
 */
const OWNER_READ_CONCURRENCY = 5;

/**
 * Scoped, index-backed listing of every device associated with `trimmed`
 * (design Component 5; Requirements 6.1–6.5, 7.1–7.3, 9.1–9.4).
 *
 * Runs `collectionGroup('devices').where('tenantIndex','array-contains', trimmed)`
 * in parallel with the bounded active-ban read, then resolves owner attribution
 * by reading ONLY the DISTINCT parent `user_devices/{email}` docs of the matched
 * devices via `db.getAll` (so both the device reads and the owner reads scale
 * with the requested tenant's device count, not the whole population —
 * Requirements 9.1–9.4). Projection reuses the SAME
 * {@link projectDeviceRecord} / {@link resolveOwnerEmail} /
 * {@link resolveOwnerDisplayName} / {@link deriveDeviceFingerprint} as the full
 * scan, so each {@link DeviceAdminRecord} is field-identical (Req 6.3, 6.4, 6.5).
 *
 * A defensive {@link filterDevicesForTenant} post-filter re-applies the
 * authoritative `matchesTenantDevice` predicate so a transiently over-inclusive
 * index can never leak another tenant's device (isolation, Req 7.3); it is a
 * no-op when the index is fresh. `trimmed` is always non-empty (the empty-id
 * boundary is enforced by {@link listTenantDevices}), so `array-contains` is
 * never issued with `''` (Req 7.4).
 */
async function listTenantDevicesScoped(trimmed: string): Promise<DeviceAdminRecord[]> {
  const db = getFirestore();

  // Read cost proportional to the tenant's device count (Req 9.1, 9.2, 9.4):
  // the scoped device read alongside the bounded active-ban read. Owner reads
  // necessarily follow (they depend on which devices matched) and are limited to
  // the DISTINCT owners of matched devices (Req 9.3).
  const [bannedFingerprints, deviceDocs] = await Promise.all([
    loadActiveBanFingerprints(db),
    db.collectionGroup('devices').where('tenantIndex', 'array-contains', trimmed).get(),
  ]);

  // Distinct parent `user_devices/{email}` doc ids of the matched devices.
  const parentIds = new Set<string>();
  for (const deviceDoc of deviceDocs.docs) {
    const parentId = deviceDoc.ref.parent.parent?.id;
    if (parentId) {
      parentIds.add(parentId);
    }
  }

  // Batch-read only the distinct parent docs (Req 9.3) for owner attribution,
  // resolved via the SAME helpers as the full scan. Reads are split into
  // bounded chunks of `OWNER_READ_CHUNK_SIZE` refs per `getAll(...)` (with a
  // small concurrent fan-out via `mapWithConcurrency`) so a large-tenant
  // distinct-parent set of thousands is fetched over several small round-trips
  // instead of one oversized call. The empty-refs fast path issues no `getAll`
  // at all. Merging every chunk's snapshots into one `ownerByParentId` map
  // yields attribution identical to a single `getAll` — only the number of
  // Firestore round-trips changes.
  const parentRefs = [...parentIds].map((id) => db.collection('user_devices').doc(id));
  const ownerByParentId = new Map<
    string,
    { ownerEmail: string | null; ownerDisplayName: string | null }
  >();
  if (parentRefs.length > 0) {
    const parentRefChunks: Array<typeof parentRefs> = [];
    for (let i = 0; i < parentRefs.length; i += OWNER_READ_CHUNK_SIZE) {
      parentRefChunks.push(parentRefs.slice(i, i + OWNER_READ_CHUNK_SIZE));
    }
    const chunkSnaps = await mapWithConcurrency(
      parentRefChunks,
      OWNER_READ_CONCURRENCY,
      (chunk) => db.getAll(...chunk)
    );
    for (const snaps of chunkSnaps) {
      for (const snap of snaps) {
        const parentData = (snap.data() ?? {}) as Record<string, unknown>;
        ownerByParentId.set(snap.id, {
          ownerEmail: resolveOwnerEmail(snap.id, parentData),
          ownerDisplayName: resolveOwnerDisplayName(parentData),
        });
      }
    }
  }

  const records: DeviceAdminRecord[] = [];
  for (const deviceDoc of deviceDocs.docs) {
    const parentId = deviceDoc.ref.parent.parent?.id;
    const owner = parentId !== undefined ? ownerByParentId.get(parentId) : undefined;
    // Fall back to the path id / null exactly like the full scan does when the
    // parent doc has no materialized fields.
    const ownerEmail = owner ? owner.ownerEmail : resolveOwnerEmail(parentId ?? '', {});
    const ownerDisplayName = owner ? owner.ownerDisplayName : null;

    const data = (deviceDoc.data() ?? {}) as Record<string, unknown>;
    const deviceId =
      typeof data.deviceId === 'string' && data.deviceId.trim().length > 0
        ? data.deviceId.trim()
        : deviceDoc.id;
    const fingerprint = deriveDeviceFingerprint(data);
    const isHardBanned = data.isHardBanned === true || bannedFingerprints.has(fingerprint);
    records.push(
      projectDeviceRecord(deviceId, data, ownerEmail, ownerDisplayName, isHardBanned)
    );
  }

  // Defensive isolation guard (Req 7.3): re-apply the authoritative predicate so
  // an over-inclusive index (transient drift) can never leak another tenant's
  // device. A no-op when the index is fresh.
  return filterDevicesForTenant(records, trimmed);
}

/**
 * List every device associated with `tenantId`, projected to
 * {@link DeviceAdminRecord} (Requirements 1.2, 3.1, 6.1–6.5, 7.4, 8.2–8.4;
 * design Property 3 and Components 5 & 6).
 *
 * Trims `tenantId` and REJECTS an empty / whitespace-only id with
 * {@link InvalidTenantIdError} so the scoped `array-contains` query is never
 * issued with `''` (Req 7.4). Selects the scoped indexed path vs. the retained
 * full scan via {@link shouldUseScopedListing}; the scoped call is wrapped in a
 * try/catch that transparently falls back to {@link listTenantDevicesFullScan}
 * when the collection-group index is unavailable ({@link isIndexUnavailableError},
 * Req 8.4) and rethrows any other error. The signature and return type are
 * unchanged (`Promise<DeviceAdminRecord[]>`); the route applies
 * search/filter/sort/group and counts via the pure helpers over the returned
 * set, so a byte-for-byte equal record set preserves the response exactly.
 */
export async function listTenantDevices(tenantId: string): Promise<DeviceAdminRecord[]> {
  const trimmed = tenantId.trim();
  if (trimmed.length === 0) {
    throw new InvalidTenantIdError(); // Req 7.4 — never issue array-contains('')
  }

  if (await shouldUseScopedListing(trimmed)) {
    try {
      return await listTenantDevicesScoped(trimmed);
    } catch (err) {
      if (isIndexUnavailableError(err)) {
        // Index still building / unavailable — serve via the proven full scan
        // (Req 8.4) rather than failing the listing.
        return await listTenantDevicesFullScan(trimmed);
      }
      throw err;
    }
  }

  return await listTenantDevicesFullScan(trimmed);
}

/** Parameters for {@link fetchDeviceDetail}. */
export interface FetchDeviceDetailParams {
  tenantId: string;
  email: string;
  deviceId: string;
}

/**
 * Load a single device's full detail record (Requirements 6.1, 3.2).
 *
 * Reads `user_devices/{email}/devices/{deviceId}` and, BEFORE returning,
 * rejects a missing device ({@link DeviceNotFoundError} → 404) and a device
 * outside the scoped tenant ({@link TenantScopeError} → 403). It resolves the
 * owner display name from the parent doc and `isHardBanned` from the active
 * `device_bans` record matching the device's derived fingerprint, then projects
 * the device to a {@link DeviceAdminRecord} (with deletion/ban/force-logout
 * provenance). Performs Firestore reads only — no mutation.
 */
export async function fetchDeviceDetail(
  params: FetchDeviceDetailParams
): Promise<DeviceAdminRecord> {
  const { tenantId, email, deviceId } = params;
  const db = getFirestore();

  const deviceRef = db
    .collection('user_devices')
    .doc(email)
    .collection('devices')
    .doc(deviceId);

  const snapshot = await deviceRef.get();
  if (!snapshot.exists) {
    throw new DeviceNotFoundError();
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!assertTenantScope(data, tenantId)) {
    throw new TenantScopeError();
  }

  let ownerDisplayName: string | null = null;
  try {
    const parentSnap = await db.collection('user_devices').doc(email).get();
    ownerDisplayName = resolveOwnerDisplayName((parentSnap.data() ?? {}) as Record<string, unknown>);
  } catch {
    ownerDisplayName = null;
  }

  const fingerprint = deriveDeviceFingerprint(data);
  const banSnapshot = await db
    .collection(DEVICE_BANS_COLLECTION)
    .where('deviceFingerprint', '==', fingerprint)
    .where('isActive', '==', true)
    .limit(1)
    .get();
  const isHardBanned = data.isHardBanned === true || !banSnapshot.empty;

  const resolvedDeviceId =
    typeof data.deviceId === 'string' && data.deviceId.trim().length > 0
      ? data.deviceId.trim()
      : deviceId;

  return projectDeviceRecord(resolvedDeviceId, data, email, ownerDisplayName, isHardBanned);
}
