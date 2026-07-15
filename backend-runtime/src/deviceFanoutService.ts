/**
 * deviceFanoutService — Server_Fanout capability (device-push-fanout-migration).
 *
 * This module hosts the backend push fan-out that replaces the client-side
 * `sendNotificationToUser` fan-out in `services/deviceTrackingService.ts`. Its
 * first, purely-functional piece is {@link applyDeliveryFilter}: the deterministic
 * Delivery_Filter that decides which of a recipient's devices receive a push and
 * how (mobile vs web-push), with NO I/O.
 *
 * The decision order MUST mirror the Client_Fanout verbatim (see
 * `services/deviceTrackingService.ts` `sendNotificationToUser` ~line 3463,
 * `resolvePreferredMobilePushTarget` ~line 3425, `findActiveChatViewerDevice`
 * ~line 2948 and `isDeviceActivelyViewingChat` ~line 2920), so that toggling the
 * Fanout_Feature_Flag never changes observable behavior.
 *
 * All timestamp -> epoch-ms conversion reuses the shared resolver in
 * `./lib/deviceLastSeen` (`toEpochMs`) — do NOT fork a divergent one. Web-push
 * subscription validity reuses `sanitizeWebPushSubscription` from `./webPush`,
 * exactly as the backend `notify` orchestrator's `resolveNotifyTarget` does, so
 * "usable web-push subscription" means the same thing on every server path.
 */

import * as admin from 'firebase-admin';
import { toEpochMs } from './lib/deviceLastSeen';
import {
  sanitizeWebPushSubscription,
  sendWebPushNotification,
  type WebPushSubscriptionShape,
} from './webPush';
import { getFirestore } from './firebaseAdmin';
import {
  assertTenantScope,
  mapWithConcurrency,
  withTimeout,
  classifyOnline,
  DEFAULT_ONLINE_WINDOW_MS,
  NOTIFY_DELIVERY_TIMEOUT_MS,
  DEVICE_ACTION_CONCURRENCY,
} from './deviceAdminService';
import {
  sendExpoMessages,
  markPushTokensInvalid,
  type ExpoPushMessage,
  type PushTokenRecord,
} from './pushUtils';
import { inc } from './metrics';

/** Whole-recipient active-chat suppression window (Req 2.8, 2.9): 2 minutes. */
export const ACTIVE_CHAT_SUPPRESSION_WINDOW_MS = 120000;

/**
 * A Firestore timestamp field as it may arrive from a device document: an epoch
 * number, an ISO string, a `Date`, or a Firestore `Timestamp`-like object. All
 * of these are understood by {@link toEpochMs}.
 */
export type FanoutTimestamp =
  | number
  | string
  | Date
  | { toMillis?: () => number; toDate?: () => Date };

/** Notification categories that gate delivery by Per_Type_Toggle (design §4). */
export type Notification_Type =
  | 'chat_message'
  | 'notice_created'
  | 'team_membership_change'
  | 'daily_quote';

/** A tenant membership summary, mirroring `UserDevice.tenantMemberships`. */
export interface FanoutTenantMembership {
  tenantId: string;
  role?: string;
  status?: string;
}

/**
 * The backend projection of a `user_devices/{email}/devices/{id}` document that
 * the Server_Fanout reasons about. Field names mirror `UserDevice` in
 * `services/deviceTrackingService.ts` and the design's Data Models.
 */
export interface FanoutDevice {
  deviceId: string;
  deviceType?: 'mobile' | 'web' | 'tablet';
  isDeleted?: boolean;
  isOnline?: boolean;

  // Ban / logout device-state inputs (notice-parity exclusion — see
  // {@link isDeviceBannedOrLoggedOut}). Field names mirror `UserDevice` in
  // `services/deviceTrackingService.ts` (`evaluateDeviceEligibility` +
  // `canAttemptRemoteNotificationDelivery`/`isDeviceLoggedOut`).
  isHardBanned?: boolean;
  sessionActive?: boolean;
  logoutType?: string;
  lastActivityType?: string;
  manualLogoutAt?: FanoutTimestamp;
  forcedLogoutAt?: FanoutTimestamp;

  // Per_Type_Toggle flags (Req 2.1–2.5)
  notificationsEnabled?: boolean;
  chatNotificationsEnabled?: boolean;
  noticeNotificationsEnabled?: boolean;
  teamNotificationsEnabled?: boolean;
  dailyQuotesEnabled?: boolean;

  // Push channels
  expoPushToken?: string;
  fcmToken?: string;
  apnsToken?: string;
  webPushSubscription?: {
    endpoint: string;
    expirationTime?: number | null;
    keys: { p256dh: string; auth: string };
  };
  webPushStatus?: string;
  pushTokenStatus?: string;

  // Active-chat suppression inputs (Req 2.8, 2.9)
  activeChatIsFocused?: boolean;
  activeChatPartner?: string;
  activeChatPartnerId?: string;
  activeChatLastSeenAt?: FanoutTimestamp;

  // Freshness inputs
  lastSeen?: FanoutTimestamp;
  updatedAt?: FanoutTimestamp;
  lastTenantPingAt?: FanoutTimestamp;
  webPushLastSyncedAt?: FanoutTimestamp;
  webPushSubscribedAt?: FanoutTimestamp;

  // Tenant scoping
  tenantIds?: string[];
  activeTenantId?: string | null;
  tenantMemberships?: FanoutTenantMembership[];
}

/** The resolved push channel + credential for a selected device. */
export interface SelectedTarget {
  deviceId: string;
  channel: 'mobile' | 'web_push';
  /**
   * Present when `channel === 'mobile'`. The backend's ONLY mobile transport is
   * Expo (`pushUtils.sendExpoMessages`), which requires an `ExponentPushToken[...]`,
   * so this always carries the device's `expoPushToken` (transport `'expo'`). Raw
   * `fcmToken`/`apnsToken` fields are non-deliverable server-side and are never
   * used here — matching `deviceAdminService.notify.resolveNotifyTarget`, which
   * resolves the mobile channel from `expoPushToken` and prefers it over web-push
   * (Req 1.6).
   */
  mobileToken?: { token: string; transport: 'expo' };
  /** Present when `channel === 'web_push'`. */
  webPushSubscription?: WebPushSubscriptionShape;
}

/** The context the Delivery_Filter evaluates devices against. */
export interface FilterContext {
  notificationType?: Notification_Type;
  /** When true, no Per_Type_Toggle excludes a device (Req 2.6). */
  allowWhenDisabled: boolean;
  /** When true, `isOnline === false` devices are excluded (Req 2.7). */
  onlineOnly: boolean;
  /** The sender's email (lowercased inside), or null when there is no sender. */
  senderEmail: string | null;
  /** "Now" in epoch-ms, for the active-chat window comparison. */
  nowMs: number;
  /** Active-chat suppression window in ms (normally {@link ACTIVE_CHAT_SUPPRESSION_WINDOW_MS}). */
  activeChatWindowMs: number;
  /**
   * When true, hard-banned and manual/forced-logged-out devices are excluded
   * (notice-parity exclusion — see {@link isDeviceBannedOrLoggedOut}). This is a
   * hard device-state exclusion that `allowWhenDisabled` does NOT override, just
   * like `isDeleted`.
   *
   * The Server_Fanout sets this for the notice fan-out (`notice_created`) so the
   * endpoint reproduces the client notice path's `evaluateDeviceEligibility`
   * (hard-ban + offline logout-flag) UNION `canAttemptRemoteNotificationDelivery`
   * (`isDeviceLoggedOut`) exclusions verbatim. It defaults to `false`/absent, so
   * every OTHER fan-out (chat, team, daily-quote) keeps its exact shipped
   * behavior — no chat regression (Req 7.5).
   */
  excludeBannedOrLoggedOut?: boolean;
  /**
   * Single-device push targeting (device-push-fanout-migration, task 12.1 Part
   * B). When set to a non-empty device id, the Delivery_Filter restricts its
   * candidate set to the SINGLE device whose `deviceId` matches — BEFORE any
   * other rule (suppression, per-device exclusions, dedup) — so every existing
   * filter semantic (deleted, `onlineOnly`, Per_Type_Toggle, active-chat
   * suppression, mobile-dedup, and the notice-gated ban/logout exclusion) then
   * applies to just that one device. When absent/blank, the filter considers
   * every candidate device (its shipped behavior — Properties 1–18 unchanged).
   * The selection is therefore always a subset of `{ targetDevice }`
   * (Property 19).
   */
  targetDeviceId?: string;
}

/** The Delivery_Filter result. `selected` is `[]` when `suppressed` is true. */
export interface FilterOutcome {
  suppressed: boolean;
  selected: SelectedTarget[];
}

/** trim + lowercase, mirroring `deviceTrackingService.normalizeEmailValue`. */
function normalizeEmailValue(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

/**
 * Resolve the device's mobile push token — the trimmed `expoPushToken` when it is
 * a non-empty string (transport `'expo'`), otherwise `null`.
 *
 * The backend's ONLY mobile transport is Expo (`pushUtils.sendExpoMessages`),
 * which requires an `ExponentPushToken[...]` and internally routes it to FCM/APNS.
 * The raw `fcmToken`/`apnsToken` fields are collected on the client purely for
 * record-keeping — there is NO direct FCM/APNS transport anywhere in
 * backend-runtime — so they are NOT deliverable server-side and are deliberately
 * ignored here. Returning a raw fcm/apns token as the "mobile token" is exactly
 * the production bug this resolves: `sendExpoMessages` rejected it with
 * `"<raw-token>" is not a valid Expo push token`. This now matches
 * `deviceAdminService.notify`'s `resolveNotifyTarget`, which resolves the mobile
 * channel from `expoPushToken` and prefers it over web-push (Req 1.6). A device
 * whose only token is a raw fcm/apns value therefore has no usable mobile token
 * and correctly falls back to web-push (if a valid subscription exists) or no
 * target — identical to `notify`. Returns `null` when there is no Expo token.
 */
export function resolvePreferredMobileToken(
  device: FanoutDevice
): { token: string; transport: 'expo' } | null {
  const expoToken = typeof device.expoPushToken === 'string' ? device.expoPushToken.trim() : '';
  if (expoToken) {
    return { token: expoToken, transport: 'expo' };
  }

  return null;
}

/**
 * The per-device active-chat predicate, mirroring
 * `deviceTrackingService.isDeviceActivelyViewingChat` verbatim, but reading
 * "now" from `nowMs` rather than `Date.now()` so the filter stays pure. A device
 * is "actively viewing the sender's conversation" when it is focused on a chat
 * whose partner (by email or id) matches the sender AND its latest active-chat
 * activity timestamp is within the window.
 */
function isDeviceActivelyViewingChat(
  device: FanoutDevice,
  normalizedSender: string,
  nowMs: number,
  activeWindowMs: number
): boolean {
  if (!normalizedSender || device.activeChatIsFocused !== true) {
    return false;
  }

  const activePartner = normalizeEmailValue(device.activeChatPartner);
  const activePartnerId = normalizeEmailValue(device.activeChatPartnerId);
  const partnerMatches =
    activePartner === normalizedSender || activePartnerId === normalizedSender;
  if (!partnerMatches) {
    return false;
  }

  const activityCandidates = [
    toEpochMs(device.activeChatLastSeenAt),
    toEpochMs(device.lastTenantPingAt),
    toEpochMs(device.lastSeen),
    toEpochMs(device.updatedAt),
  ].filter((value): value is number => typeof value === 'number' && value > 0);

  if (!activityCandidates.length) {
    return false;
  }

  const lastActiveMs = Math.max(...activityCandidates);
  return nowMs - lastActiveMs <= Math.max(0, activeWindowMs);
}

/**
 * The Per_Type_Toggle exclusion decision (Req 2.1–2.5), evaluated only when
 * `allowWhenDisabled` is false. `notificationsEnabled === false` excludes for
 * every type; the type-specific toggle excludes for its matching type.
 */
function isExcludedByToggle(device: FanoutDevice, ctx: FilterContext): boolean {
  if (ctx.allowWhenDisabled) {
    return false;
  }

  if (device.notificationsEnabled === false) {
    return true;
  }

  switch (ctx.notificationType) {
    case 'chat_message':
      return device.chatNotificationsEnabled === false;
    case 'notice_created':
      return device.noticeNotificationsEnabled === false;
    case 'team_membership_change':
      return device.teamNotificationsEnabled === false;
    case 'daily_quote':
      return device.dailyQuotesEnabled === false;
    default:
      return false;
  }
}

/**
 * The hard-ban / manual-or-forced-logout device-state exclusion, evaluated only
 * when {@link FilterContext.excludeBannedOrLoggedOut} is set (the notice
 * fan-out). It is the VERBATIM union of the two client-side exclusions the
 * notice path applies before delivery in `services/noticeService.ts`:
 *
 *   - `evaluateDeviceEligibility` (per recipient device): excludes
 *     `isHardBanned === true` and, for an OFFLINE device (`isOnline !== true`),
 *     `logoutType` ∈ {manual, forced} OR a set `manualLogoutAt`/`forcedLogoutAt`;
 *   - `sendNotificationToDeviceDetailed` → `canAttemptRemoteNotificationDelivery`
 *     → `isDeviceLoggedOut` (applied to EVERY device it delivers to): excludes
 *     `sessionActive === false`, `logoutType` ∈ {manual, forced} (regardless of
 *     online), and `lastActivityType` ∈ {logout, forced_logout}.
 *
 * The `logoutType` ∈ {manual, forced} branch of `isDeviceLoggedOut` supersets the
 * eligibility's offline-only `logoutType` check, so the union collapses to the
 * predicate below. This is a HARD device-state exclusion (like `isDeleted`):
 * `allowWhenDisabled` does NOT override it, matching the client, where neither
 * `evaluateDeviceEligibility` nor `isDeviceLoggedOut` consults `allowWhenDisabled`.
 *
 * Pure — no I/O. `manualLogoutAt`/`forcedLogoutAt` are treated as "set" when they
 * resolve to a positive epoch-ms via {@link toEpochMs} (a truthy timestamp),
 * mirroring the client's truthiness check on those fields.
 */
function isDeviceBannedOrLoggedOut(device: FanoutDevice): boolean {
  if (device.isHardBanned === true) {
    return true;
  }
  if (device.sessionActive === false) {
    return true;
  }
  if (device.logoutType === 'manual' || device.logoutType === 'forced') {
    return true;
  }
  if (device.lastActivityType === 'logout' || device.lastActivityType === 'forced_logout') {
    return true;
  }
  if (device.isOnline !== true) {
    const manualLogoutMs = toEpochMs(device.manualLogoutAt);
    const forcedLogoutMs = toEpochMs(device.forcedLogoutAt);
    if (
      (typeof manualLogoutMs === 'number' && manualLogoutMs > 0) ||
      (typeof forcedLogoutMs === 'number' && forcedLogoutMs > 0)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a surviving device to its preferred push target: the mobile token is
 * preferred over web-push (Req 1.6); otherwise a sanitized web-push subscription
 * is used. Returns `null` when the device has no usable channel (such a device
 * is never selected).
 */
function resolveTarget(device: FanoutDevice): SelectedTarget | null {
  const mobile = resolvePreferredMobileToken(device);
  if (mobile) {
    return { deviceId: device.deviceId, channel: 'mobile', mobileToken: mobile };
  }

  const subscription = sanitizeWebPushSubscription(device.webPushSubscription);
  if (subscription) {
    return { deviceId: device.deviceId, channel: 'web_push', webPushSubscription: subscription };
  }

  return null;
}

/**
 * The pure Delivery_Filter (design §4). Given a recipient's candidate devices
 * and a {@link FilterContext}, it either reports whole-recipient active-chat
 * suppression or returns the selected push targets. It performs NO I/O and is
 * deterministic.
 *
 * Decision order (mirrors the Client_Fanout verbatim):
 *   1. Whole-recipient active-chat suppression (Req 2.9).
 *   2. Per-device exclusions: deleted (2.11), onlineOnly/offline (2.7),
 *      hard-ban / manual-or-forced-logout when `excludeBannedOrLoggedOut` is set
 *      (notice parity — see {@link isDeviceBannedOrLoggedOut}), Per_Type_Toggle
 *      unless allowWhenDisabled (2.1–2.6), per-device active-chat form (2.8).
 *   3. Target resolution (mobile preferred over web-push, Req 1.6) + mobile-token
 *      dedup keeping the first device per distinct token (Req 2.10); web targets
 *      are never token-deduped.
 *
 * The `selected` set is always a subset of the input (Req 11.2) and the filter
 * is idempotent on an already-filtered set (Req 11.3).
 */
export function applyDeliveryFilter(
  devices: ReadonlyArray<FanoutDevice>,
  ctx: FilterContext
): FilterOutcome {
  const normalizedSender = normalizeEmailValue(ctx.senderEmail);
  const isChat = ctx.notificationType === 'chat_message';

  // (0) Single-device targeting (Part B): when a `targetDeviceId` is set, narrow
  // the candidate set to the ONE matching device BEFORE any other rule, so all
  // downstream filter semantics (suppression, per-device exclusions, dedup) apply
  // to just that device and the selection is a subset of `{ targetDevice }`
  // (Property 19). When absent/blank, every candidate is considered (unchanged).
  const targetDeviceId =
    typeof ctx.targetDeviceId === 'string' ? ctx.targetDeviceId.trim() : '';
  const candidateDevices: ReadonlyArray<FanoutDevice> = targetDeviceId
    ? devices.filter((device) => !!device && device.deviceId === targetDeviceId)
    : devices;

  // (1) Whole-recipient active-chat suppression (Req 2.9): if any non-deleted
  // device is actively viewing the sender's conversation, suppress the entire
  // fan-out.
  if (isChat && normalizedSender) {
    const hasActiveViewer = candidateDevices.some(
      (device) =>
        !!device &&
        device.isDeleted !== true &&
        isDeviceActivelyViewingChat(device, normalizedSender, ctx.nowMs, ctx.activeChatWindowMs)
    );
    if (hasActiveViewer) {
      return { suppressed: true, selected: [] };
    }
  }

  // (2) Per-device exclusions, preserving input order.
  const survivors: FanoutDevice[] = [];
  for (const device of candidateDevices) {
    if (!device) {
      continue;
    }
    if (device.isDeleted === true) {
      continue; // Req 2.11
    }
    if (ctx.onlineOnly && device.isOnline === false) {
      continue; // Req 2.7
    }
    if (ctx.excludeBannedOrLoggedOut && isDeviceBannedOrLoggedOut(device)) {
      continue; // notice parity: hard-ban + manual/forced-logout exclusion (Req 7.5)
    }
    if (isExcludedByToggle(device, ctx)) {
      continue; // Req 2.1–2.6
    }
    if (
      isChat &&
      normalizedSender &&
      isDeviceActivelyViewingChat(device, normalizedSender, ctx.nowMs, ctx.activeChatWindowMs)
    ) {
      continue; // per-device form of Req 2.8
    }
    survivors.push(device);
  }

  // (3) Resolve targets + mobile-token dedup (Req 1.6, 2.10).
  const selected: SelectedTarget[] = [];
  const seenMobileTokens = new Set<string>();
  for (const device of survivors) {
    const target = resolveTarget(device);
    if (!target) {
      continue; // no usable channel
    }
    if (target.channel === 'mobile') {
      const token = target.mobileToken?.token ?? '';
      if (token) {
        if (seenMobileTokens.has(token)) {
          continue; // duplicate mobile token — deliver once (Req 2.10)
        }
        seenMobileTokens.add(token);
      }
    }
    selected.push(target);
  }

  return { suppressed: false, selected };
}

/* -------------------------------------------------------------------------- *
 * Web_Push_Cleanup decision (pure) — device-push-fanout-migration Req 3.1–3.3, 3.5
 * -------------------------------------------------------------------------- *
 *
 * `classifyWebPushCleanup` is the pure port of the client-side classification
 * inside `services/deviceTrackingService.ts` `cleanupStaleWebPushSubscriptions`
 * (~line 687) and its `getWebPushEndpointKey` (~line 660) /
 * `getDeviceFreshnessMs` (~line 667) helpers. It performs NO I/O: it takes a
 * recipient's devices and "now" (epoch-ms) and returns which device ids are
 * stale, which are removable duplicates, and the surviving devices. The backend
 * `fanout()` orchestrator (task 3.2) applies the corresponding Admin-SDK writes
 * — this function only decides.
 *
 * The rules mirror the client VERBATIM:
 *   - Only `deviceType === 'web'` AND `!isDeleted` devices are considered; every
 *     non-web / deleted device is passed through untouched to `survivors` in
 *     input order (they are simply not cleanup participants — the Delivery_Filter
 *     excludes deleted devices later).
 *   - STALE (Req 3.1, 3.2) when the web-push subscription `expirationTime` is a
 *     finite number `> 0` AND `<= now` (expired) OR (`webPushStatus === 'subscribed'`
 *     AND no non-empty trimmed endpoint) (subscribed-without-endpoint).
 *   - DUPLICATE (Req 3.3) among the non-stale web devices sharing an identical
 *     trimmed endpoint key: keep the FRESHEST device and mark every other sharing
 *     device removable. Freshness = the latest epoch-ms across `updatedAt`,
 *     `lastSeen`, `webPushLastSyncedAt`, `webPushSubscribedAt`, `lastTenantPingAt`
 *     (via {@link toEpochMs}). The winner is decided by
 *     `deviceFreshnessMs(existing) >= deviceFreshnessMs(candidate)`, so on a tie
 *     the FIRST-seen (earlier in iteration order) device is retained.
 *   - `survivors` = input devices minus stale minus duplicates, preserving input
 *     order (Req 3.5), so a cleaned-subscription device never reaches the
 *     fan-out's push targets.
 */

/**
 * The cleanup reason / error-code that applies to a stale or duplicate device,
 * matching the client write shape: an expired subscription is `subscription_expired`,
 * a subscribed-without-endpoint device is `subscription_missing`, and a removable
 * duplicate is `duplicate_subscription_replaced`.
 */
export type WebPushCleanupReason =
  | 'subscription_expired'
  | 'subscription_missing'
  | 'duplicate_subscription_replaced';

/**
 * The deterministic portion of a Web_Push_Cleanup write for a device, derived
 * solely from its {@link WebPushCleanupReason}. The orchestrator (task 3.2)
 * combines this with the I/O-specific fields the client also writes
 * (`webPushSubscription: deleteField()`, `webPushLastErrorAt`, `updatedAt`) when
 * it applies the cleanup through the Admin SDK.
 */
export interface WebPushCleanupWrite {
  webPushStatus: 'unsubscribed' | 'sync_required';
  webPushLastErrorCode: WebPushCleanupReason;
}

/** The `classifyWebPushCleanup` result. */
export interface WebPushCleanupClassification {
  /** Device ids classified stale (expired OR subscribed-without-endpoint). */
  stale: string[];
  /** Device ids classified as removable duplicates (a fresher device won). */
  duplicates: string[];
  /** Input devices minus stale minus duplicates, in input order. */
  survivors: FanoutDevice[];
}

/**
 * The richer classification the orchestrator (task 3.2) consumes: it adds a
 * per-device-id {@link WebPushCleanupReason} map so each stale/duplicate device's
 * cleanup write can be resolved via {@link webPushCleanupWriteFor}. This is the
 * single source of truth; {@link classifyWebPushCleanup} is a thin projection of
 * it that drops the reasons to keep the specified `{ stale, duplicates, survivors }`
 * signature.
 */
export interface WebPushCleanupClassificationDetailed extends WebPushCleanupClassification {
  /** deviceId -> the cleanup reason that applies (only for stale/duplicate ids). */
  reasons: Record<string, WebPushCleanupReason>;
}

/**
 * The trimmed web-push endpoint key, or `null` when absent/blank — mirrors the
 * client `getWebPushEndpointKey` verbatim. Devices are deduplicated by this key.
 */
function webPushEndpointKey(device: FanoutDevice): string | null {
  const endpoint =
    typeof device.webPushSubscription?.endpoint === 'string'
      ? device.webPushSubscription.endpoint.trim()
      : '';
  return endpoint || null;
}

/**
 * A device's freshness in epoch-ms — the latest of `updatedAt`, `lastSeen`,
 * `webPushLastSyncedAt`, `webPushSubscribedAt`, and `lastTenantPingAt`, converted
 * via the shared {@link toEpochMs} resolver. Mirrors the client
 * `getDeviceFreshnessMs`: unparseable/absent timestamps are ignored and the base
 * is `0` (so a device with no usable timestamps is the least fresh).
 */
function deviceFreshnessMs(device: FanoutDevice): number {
  const candidates: Array<FanoutTimestamp | undefined> = [
    device.updatedAt,
    device.lastSeen,
    device.webPushLastSyncedAt,
    device.webPushSubscribedAt,
    device.lastTenantPingAt,
  ];
  let latest = 0;
  for (const value of candidates) {
    const ms = toEpochMs(value);
    if (typeof ms === 'number' && ms > latest) {
      latest = ms;
    }
  }
  return latest;
}

/**
 * Resolve the deterministic Web_Push_Cleanup write fields for a cleanup reason,
 * matching the client writes: `subscription_missing` downgrades to
 * `sync_required`; `subscription_expired` and `duplicate_subscription_replaced`
 * unsubscribe. Pure — no I/O.
 */
export function webPushCleanupWriteFor(reason: WebPushCleanupReason): WebPushCleanupWrite {
  if (reason === 'subscription_missing') {
    return { webPushStatus: 'sync_required', webPushLastErrorCode: 'subscription_missing' };
  }
  return { webPushStatus: 'unsubscribed', webPushLastErrorCode: reason };
}

/**
 * The detailed Web_Push_Cleanup classification (the implementation core). It
 * mirrors the client `cleanupStaleWebPushSubscriptions` classification order
 * exactly: stale detection short-circuits before dedup, and dedup only considers
 * non-stale web devices that expose a trimmed endpoint. See the module section
 * comment above for the precise rules and requirement mapping.
 */
export function classifyWebPushCleanupDetailed(
  devices: ReadonlyArray<FanoutDevice>,
  nowMs: number
): WebPushCleanupClassificationDetailed {
  const staleIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const reasons: Record<string, WebPushCleanupReason> = {};
  const endpointWinners = new Map<string, FanoutDevice>();

  for (const device of devices) {
    // Only non-deleted web devices participate (Req 3.1–3.3); everything else
    // passes through to survivors untouched.
    if (!device || device.deviceType !== 'web' || device.isDeleted === true) {
      continue;
    }

    const endpointKey = webPushEndpointKey(device);
    const rawExpiration = device.webPushSubscription?.expirationTime;
    const expirationTime = typeof rawExpiration === 'number' ? rawExpiration : null;
    const hasExpiredSubscription =
      typeof expirationTime === 'number' &&
      Number.isFinite(expirationTime) &&
      expirationTime > 0 &&
      expirationTime <= nowMs;
    const subscribedWithoutEndpoint = device.webPushStatus === 'subscribed' && !endpointKey;

    // STALE (Req 3.1 expired, Req 3.2 subscribed-without-endpoint). The
    // subscribed-without-endpoint branch takes precedence for the reason, exactly
    // as the client write chooses `sync_required`/`subscription_missing` first.
    if (hasExpiredSubscription || subscribedWithoutEndpoint) {
      staleIds.add(device.deviceId);
      reasons[device.deviceId] = subscribedWithoutEndpoint
        ? 'subscription_missing'
        : 'subscription_expired';
      continue;
    }

    // Non-stale web devices without an endpoint are NOT dedup participants (they
    // just survive without being a web-push target).
    if (!endpointKey) {
      continue;
    }

    const existingWinner = endpointWinners.get(endpointKey);
    if (!existingWinner) {
      endpointWinners.set(endpointKey, device);
      continue;
    }

    // Freshest wins; on a freshness tie the already-seen (existing) device is
    // retained — `>=` keeps existing (Req 3.3).
    const keepExisting = deviceFreshnessMs(existingWinner) >= deviceFreshnessMs(device);
    const winner = keepExisting ? existingWinner : device;
    const loser = keepExisting ? device : existingWinner;
    endpointWinners.set(endpointKey, winner);
    duplicateIds.add(loser.deviceId);
    reasons[loser.deviceId] = 'duplicate_subscription_replaced';
  }

  const survivors = devices.filter(
    (device): device is FanoutDevice =>
      !!device && !staleIds.has(device.deviceId) && !duplicateIds.has(device.deviceId)
  );

  return {
    stale: [...staleIds],
    duplicates: [...duplicateIds],
    survivors,
    reasons,
  };
}

/**
 * The pure Web_Push_Cleanup decision (design "Data Models → Web_Push_Cleanup
 * decision"). Given a recipient's devices and "now" in epoch-ms, it returns the
 * stale device ids, the removable duplicate device ids, and the surviving devices
 * (input minus stale minus duplicates, in input order). It performs NO I/O and is
 * deterministic — the exact port of the client `cleanupStaleWebPushSubscriptions`
 * classification (see the module section comment above for the verbatim rules).
 *
 * Use {@link classifyWebPushCleanupDetailed} + {@link webPushCleanupWriteFor} when
 * the per-device cleanup reason/write shape is also needed (the orchestrator).
 */
export function classifyWebPushCleanup(
  devices: ReadonlyArray<FanoutDevice>,
  nowMs: number
): WebPushCleanupClassification {
  const { stale, duplicates, survivors } = classifyWebPushCleanupDetailed(devices, nowMs);
  return { stale, duplicates, survivors };
}

/* -------------------------------------------------------------------------- *
 * Fanout_Result assembly (pure) — device-push-fanout-migration
 *   Req 5.4 (response hygiene), 6.1 (contract), 6.2/6.3 (count semantics),
 *   6.4 (suppression zeroing), 9.5 (flag-invariant shape).
 * -------------------------------------------------------------------------- *
 *
 * `assembleFanoutResult` and `serializeFanoutResponse` are the pure tail of the
 * Server_Fanout pipeline (design "Components §2 step 6"). The orchestrator
 * (task 3.2) collects the filter/delivery/cleanup outcomes and hands them to
 * `assembleFanoutResult`, which builds the ten-field DeviceNotificationFanoutResult;
 * the Fanout_Endpoint (task 4.1) hands that result to `serializeFanoutResponse`,
 * which produces the JSON body returned to the client. Both are I/O-free and
 * deterministic.
 */

/**
 * The fan-out result contract returned to callers (Req 6.1). It mirrors
 * `DeviceNotificationFanoutResult` in `services/deviceTrackingService.ts`
 * (~line 351) EXACTLY — the same ten numeric fields, same names, same order — so
 * that toggling the Fanout_Feature_Flag never changes the contract callers depend
 * on (Req 9.5). Every field is always a finite number (never undefined), so the
 * shape is complete regardless of the fan-out's outcome (Req 6.1).
 */
export interface DeviceNotificationFanoutResult {
  success: number;
  failed: number;
  deliverableDeviceCount: number;
  onlineDeliverableCount: number;
  presenceDeliveredCount: number;
  pushAcceptedCount: number;
  mobilePushAcceptedCount: number;
  webPushAcceptedCount: number;
  staleWebPushSubscriptionsCleaned: number;
  deduplicatedWebPushSubscriptionsCleaned: number;
}

/**
 * The complete, ordered set of keys a serialized Fanout_Result may contain — the
 * ten DeviceNotificationFanoutResult counts and NOTHING else. This is the single
 * source of truth shared by {@link serializeFanoutResponse} and its property test
 * (Property 11), guaranteeing the response never grows a token/endpoint/network
 * metadata field.
 */
export const FANOUT_RESULT_KEYS: ReadonlyArray<keyof DeviceNotificationFanoutResult> = [
  'success',
  'failed',
  'deliverableDeviceCount',
  'onlineDeliverableCount',
  'presenceDeliveredCount',
  'pushAcceptedCount',
  'mobilePushAcceptedCount',
  'webPushAcceptedCount',
  'staleWebPushSubscriptionsCleaned',
  'deduplicatedWebPushSubscriptionsCleaned',
];

/**
 * The fan-out's outcome inputs that {@link assembleFanoutResult} folds into a
 * DeviceNotificationFanoutResult. This is the minimal, I/O-free summary the
 * orchestrator (task 3.2) produces from the Delivery_Filter, the push delivery
 * pass, and the Web_Push_Cleanup — never raw tokens/endpoints/devices.
 */
export interface FanoutResultInput {
  /** Whole-recipient active-chat suppression signal (Req 2.9 → 6.4). */
  suppressed: boolean;
  /** Count of devices that survived the Delivery_Filter (design step 3). */
  deliverableDeviceCount: number;
  /** Of the deliverable devices, how many were online. */
  onlineDeliverableCount: number;
  /** Presence deliveries — client-side only; 0 for a cross-user server push. */
  presenceDeliveredCount: number;
  /** Accepted mobile (Expo/FCM/APNS) push deliveries. */
  mobileAccepted: number;
  /** Accepted web-push deliveries. */
  webPushAccepted: number;
  /** Failed delivery attempts. */
  failed: number;
  /** Stale web-push subscriptions cleaned (from `classifyWebPushCleanup`). */
  staleCleaned: number;
  /** Duplicate web-push subscriptions cleaned (from `classifyWebPushCleanup`). */
  duplicatesCleaned: number;
}

/**
 * Coerce a value to a finite number, mapping any non-finite value (NaN, ±∞) or
 * `undefined`/missing input to `0`. This is what keeps every assembled field a
 * finite number so the result shape is always complete (Req 6.1, 9.5).
 */
function finiteCount(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Build the ten-field {@link DeviceNotificationFanoutResult} from the fan-out's
 * outcome inputs — pure, no I/O (design "Components §2 step 6").
 *
 * Count semantics (Req 6.2, 6.3; Property 13):
 *   - `mobilePushAcceptedCount` / `webPushAcceptedCount` pass through from the
 *     delivery pass, and `pushAcceptedCount === mobilePushAcceptedCount +
 *     webPushAcceptedCount` by construction.
 *   - `staleWebPushSubscriptionsCleaned` / `deduplicatedWebPushSubscriptionsCleaned`
 *     reflect the Web_Push_Cleanup outcome and are ALWAYS reported.
 *   - `success === presenceDeliveredCount + pushAcceptedCount`, mirroring the
 *     client fan-out's success accounting (`sendNotificationToUser` in
 *     `services/deviceTrackingService.ts` counts every delivered device — whether
 *     its `deliverySource` is `'presence'` or `'push'` — as a success). `failed`
 *     passes through.
 *
 * Suppression zeroing (Req 6.4; Property 14): when `suppressed` is true, every
 * count is forced to 0 EXCEPT the two cleanup counts, which still report the
 * Web_Push_Cleanup that was performed before suppression took effect.
 *
 * Every returned field is a finite number regardless of the inputs (Req 6.1, 9.5;
 * Property 12).
 */
export function assembleFanoutResult(input: FanoutResultInput): DeviceNotificationFanoutResult {
  // Cleanup counts are reported in EVERY case, including under suppression
  // (Req 6.2, 6.4) — the cleanup runs before the suppression decision.
  const staleWebPushSubscriptionsCleaned = finiteCount(input.staleCleaned);
  const deduplicatedWebPushSubscriptionsCleaned = finiteCount(input.duplicatesCleaned);

  if (input.suppressed) {
    return {
      success: 0,
      failed: 0,
      deliverableDeviceCount: 0,
      onlineDeliverableCount: 0,
      presenceDeliveredCount: 0,
      pushAcceptedCount: 0,
      mobilePushAcceptedCount: 0,
      webPushAcceptedCount: 0,
      staleWebPushSubscriptionsCleaned,
      deduplicatedWebPushSubscriptionsCleaned,
    };
  }

  const mobilePushAcceptedCount = finiteCount(input.mobileAccepted);
  const webPushAcceptedCount = finiteCount(input.webPushAccepted);
  // Push acceptance is split across exactly the two channels (Req 6.3). The sum
  // is re-coerced so an extreme-magnitude overflow still yields a finite number,
  // keeping the shape complete (Req 6.1, 9.5).
  const pushAcceptedCount = finiteCount(mobilePushAcceptedCount + webPushAcceptedCount);
  const presenceDeliveredCount = finiteCount(input.presenceDeliveredCount);
  // A delivered device (presence OR push) counts as a success — parity with the
  // client fan-out's per-device success accounting. Re-coerced against overflow.
  const success = finiteCount(presenceDeliveredCount + pushAcceptedCount);

  return {
    success,
    failed: finiteCount(input.failed),
    deliverableDeviceCount: finiteCount(input.deliverableDeviceCount),
    onlineDeliverableCount: finiteCount(input.onlineDeliverableCount),
    presenceDeliveredCount,
    pushAcceptedCount,
    mobilePushAcceptedCount,
    webPushAcceptedCount,
    staleWebPushSubscriptionsCleaned,
    deduplicatedWebPushSubscriptionsCleaned,
  };
}

/**
 * Serialize a Fanout_Result into the object the Fanout_Endpoint returns to the
 * client (Req 5.4; Property 11). It returns an object containing ONLY the ten
 * numeric DeviceNotificationFanoutResult fields.
 *
 * SECURITY: this response MUST NEVER leak a recipient's push tokens (Expo/FCM/APNS),
 * web-push subscription endpoints, or device network metadata (e.g. `ipAddress`,
 * user-agent). The ten known fields are therefore copied EXPLICITLY rather than
 * spread from `result`, so that even if a caller passes an object accidentally
 * enriched with secret-bearing fields, those fields can never reach the response
 * body — only the ten counts are ever emitted.
 */
export function serializeFanoutResponse(
  result: DeviceNotificationFanoutResult
): DeviceNotificationFanoutResult {
  return {
    success: result.success,
    failed: result.failed,
    deliverableDeviceCount: result.deliverableDeviceCount,
    onlineDeliverableCount: result.onlineDeliverableCount,
    presenceDeliveredCount: result.presenceDeliveredCount,
    pushAcceptedCount: result.pushAcceptedCount,
    mobilePushAcceptedCount: result.mobilePushAcceptedCount,
    webPushAcceptedCount: result.webPushAcceptedCount,
    staleWebPushSubscriptionsCleaned: result.staleWebPushSubscriptionsCleaned,
    deduplicatedWebPushSubscriptionsCleaned: result.deduplicatedWebPushSubscriptionsCleaned,
  };
}

/* -------------------------------------------------------------------------- *
 * fanout() orchestrator — device-push-fanout-migration
 *   Req 1.1 (Admin-SDK resolution), 1.2 (reuse sendExpoMessages/sendWebPush),
 *   1.5 (no new transport), 1.6 (mobile preferred), 3.1–3.6 (Web_Push_Cleanup +
 *   Token_Refresh_Flag through the Admin SDK, per-device isolation), 4.2/4.4
 *   (server-side push + Admin-SDK bypasses rules), 5.2/5.3 (tenant scoping),
 *   6.5 (totality — never throws).
 * -------------------------------------------------------------------------- *
 *
 * `fanout()` is the Server_Fanout entry point (design "Components §2
 * deviceFanoutService" + "Server_Fanout pipeline"). It mirrors the
 * `deviceAdminService.notify` three-phase orchestrator VERBATIM — resolve →
 * one batched `sendExpoMessages` under a single `withTimeout` → per-target
 * web-push via `mapWithConcurrency` — and REUSES those exact primitives so no
 * new push transport is introduced (Req 1.5). The pure decisions
 * (`classifyWebPushCleanupDetailed`, `applyDeliveryFilter`,
 * `assembleFanoutResult`) live above this section; this function only adds the
 * I/O (Admin-SDK reads/writes + push delivery) around them.
 */

/**
 * The Server_Fanout input (design "Data Models → FanoutParams"). `actor` is the
 * authenticated sender, carried only for observability — the endpoint has
 * already authorized the sender against the tenant (Req 5.1, 5.3) before this
 * runs.
 */
export interface FanoutParams {
  tenantId: string;
  recipientEmail: string;
  notification: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
  onlineOnly: boolean;
  /**
   * Optional single-device target (device-push-fanout-migration, task 12.1 Part
   * B). When present, the fan-out restricts its candidate devices to the ONE
   * device whose `deviceId` matches — device-scoped Web_Push_Cleanup, Delivery_Filter,
   * and delivery all operate on just that device — so the client single-device
   * push path (`sendNotificationToDeviceDetailed`) can route through the server
   * without reading another user's device documents. When absent, the fan-out
   * considers every recipient device (recipient-wide fan-out, unchanged).
   */
  targetDeviceId?: string;
  actor: { id?: string; email?: string; name?: string };
}

/**
 * The failure Fanout_Result returned when the pipeline hits an unexpected error
 * (Req 6.5, Property 15). It mirrors the client fan-out's `catch` branch
 * (`services/deviceTrackingService.ts` `sendNotificationToUser`): `failed: 1`,
 * every other count `0`. Kept as a factory so each call returns a fresh object.
 */
function fanoutFailureResult(): DeviceNotificationFanoutResult {
  return {
    success: 0,
    failed: 1,
    deliverableDeviceCount: 0,
    onlineDeliverableCount: 0,
    presenceDeliveredCount: 0,
    pushAcceptedCount: 0,
    mobilePushAcceptedCount: 0,
    webPushAcceptedCount: 0,
    staleWebPushSubscriptionsCleaned: 0,
    deduplicatedWebPushSubscriptionsCleaned: 0,
  };
}

/** Coerce an unknown notification-data field to a trimmed string, or undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Map the notification's `data.priority` onto Expo's `priority` field. */
function toExpoPriority(value: unknown): 'default' | 'normal' | 'high' {
  if (value === 'high') {
    return 'high';
  }
  if (value === 'low') {
    return 'default';
  }
  return 'normal';
}

/** Map the notification's `data.priority` onto web-push `urgency`. */
function toWebPushUrgency(value: unknown): 'very-low' | 'low' | 'normal' | 'high' {
  if (value === 'high') {
    return 'high';
  }
  if (value === 'low') {
    return 'low';
  }
  return 'normal';
}

/**
 * Project a raw `user_devices/{email}/devices/{id}` document into a
 * {@link FanoutDevice}. Every field is spread through verbatim (the downstream
 * pure functions guard field types themselves — e.g. `resolvePreferredMobileToken`
 * checks `typeof === 'string'`, `toEpochMs` accepts any timestamp shape), and
 * only `deviceId` is forced from the doc id.
 *
 * `isOnline` is taken from the STORED device field — NOT recomputed server-side —
 * so the server path filters on exactly the value the Client_Fanout used
 * (`services/deviceTrackingService.ts` reads `device.isOnline` directly),
 * keeping the fan-out flag-invariant (Req 9.5). Req 2.7's "isOnline value is
 * false" exclusion is applied by the pure `applyDeliveryFilter`.
 */
function projectFanoutDevice(deviceId: string, data: Record<string, unknown>): FanoutDevice {
  return { ...data, deviceId } as unknown as FanoutDevice;
}

/**
 * The Server_Fanout orchestrator (design "Components §2 step 1–6"). Resolves a
 * recipient's push targets through the Admin SDK, applies the pure
 * Web_Push_Cleanup + Delivery_Filter decisions, delivers push by REUSING
 * `sendExpoMessages` / `sendWebPushNotification`, performs the two cross-user
 * writes (cleanup + Token_Refresh_Flag) through the Admin SDK with per-device
 * isolation, and returns the ten-field {@link DeviceNotificationFanoutResult}.
 *
 * TOTALITY (Req 6.5, Property 15): the ENTIRE pipeline — from the device read
 * onward — is wrapped in a single `try/catch`; any unexpected error resolves to
 * {@link fanoutFailureResult} (`failed: 1`, rest `0`) and is NEVER thrown to the
 * caller, so the Fanout_Endpoint always responds with a well-formed result.
 *
 * PRESENCE: `presenceDeliveredCount` is ALWAYS 0 on this server path. Realtime
 * `'presence'` delivery is inherently client-side (it fires only for the
 * signed-in user's own current device using local state — design "client/server
 * boundary", Req 4.1); the client merges its local presence outcome into the
 * returned result in task 7.1. The server never performs presence delivery.
 *
 * AUDIT — PRODUCTION DEVIATION FROM THE DESIGN (deliberate): the design's
 * "Components §2 step 6" said to write one `deviceAuditLogs` entry per fan-out,
 * by analogy to the admin `notify` orchestrator. We DO NOT do that here. The
 * Fanout_Endpoint serves high-volume ROUTINE chat/notice pushes (potentially one
 * per chat message), so a `deviceAuditLogs` write per fan-out would cause write
 * amplification against the append-only audit log and would flood the Device
 * Console history — which is meant for deliberate ADMIN actions (force-logout /
 * ban / delete / admin-notify), not per-message delivery. Skipping the audit
 * write avoids that amplification while preserving the returned result contract.
 * For observability we instead bump lightweight in-process `device_fanout_*`
 * counters via `metrics.inc` (no I/O, no write amplification).
 */
export async function fanout(params: FanoutParams): Promise<DeviceNotificationFanoutResult> {
  const { tenantId, recipientEmail, notification, onlineOnly } = params;
  const targetDeviceId =
    typeof params.targetDeviceId === 'string' ? params.targetDeviceId.trim() : '';
  const data = notification.data;
  inc('device_fanout_requests_total');

  try {
    const db = getFirestore();
    const nowMs = Date.now();

    // (1) RESOLVE recipient devices via the Admin SDK (Req 1.1, 4.4). Keep ONLY
    // devices sharing the notification's tenant scope (Req 5.2, 5.3) — an
    // out-of-tenant device is never a candidate.
    const snapshot = await db
      .collection('user_devices')
      .doc(recipientEmail)
      .collection('devices')
      .get();

    const tenantDevices: FanoutDevice[] = [];
    for (const docSnap of snapshot.docs) {
      const raw = (docSnap.data() ?? {}) as Record<string, unknown>;
      if (!assertTenantScope(raw, tenantId)) {
        continue; // out-of-tenant device — never a candidate (Req 5.2, 5.3)
      }
      tenantDevices.push(projectFanoutDevice(docSnap.id, raw));
    }

    // (1b) SINGLE-DEVICE TARGETING (Part B): when a `targetDeviceId` is supplied,
    // restrict the candidate set to the ONE matching device so Web_Push_Cleanup,
    // the Delivery_Filter, and delivery are all DEVICE-SCOPED. A non-matching /
    // absent id yields an empty candidate set → no cleanup, no selection, an
    // all-zero result. The pure Delivery_Filter re-applies the same restriction
    // via `FilterContext.targetDeviceId` (defence-in-depth + Property 19).
    const candidateDevices = targetDeviceId
      ? tenantDevices.filter((device) => device.deviceId === targetDeviceId)
      : tenantDevices;

    // (2) WEB_PUSH_CLEANUP (Req 3.1–3.6). Decide (pure) then apply the Admin-SDK
    // writes PER-DEVICE inside their own try/catch so one failure never aborts
    // the rest (Req 3.6). Cleaned-subscription devices drop out of the candidate
    // set (Req 3.5) via `survivors`.
    const cleanup = classifyWebPushCleanupDetailed(candidateDevices, nowMs);
    const cleanupIds = [...cleanup.stale, ...cleanup.duplicates];
    for (const deviceId of cleanupIds) {
      const reason = cleanup.reasons[deviceId];
      if (!reason) {
        continue;
      }
      try {
        await db
          .collection('user_devices')
          .doc(recipientEmail)
          .collection('devices')
          .doc(deviceId)
          .update({
            webPushSubscription: admin.firestore.FieldValue.delete(),
            ...webPushCleanupWriteFor(reason),
            webPushLastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      } catch (err) {
        // Req 3.6: a per-device cleanup write failure is isolated and logged; the
        // fan-out continues and the outcome is still reported.
        console.warn(
          '[device_fanout] web push cleanup write failed',
          { recipientEmail, deviceId },
          err instanceof Error ? err.message : err
        );
      }
    }
    // Cleanup counts follow the client's id-set semantics: what was DECIDED for
    // cleanup is counted, even if the isolated write above failed (the client
    // `cleanupStaleWebPushSubscriptions` counts by `staleIds.size`/`dedupedIds.size`
    // and swallows write errors identically) — Req 3.6, 6.2.
    const staleCleaned = cleanup.stale.length;
    const duplicatesCleaned = cleanup.duplicates.length;

    // (3) DELIVERY_FILTER (pure). Whole-recipient active-chat suppression (Req
    // 2.9) short-circuits to zeros + the cleanup counts (Req 6.4).
    const notificationTypeValue = optionalString(data?.type) as Notification_Type | undefined;
    const outcome = applyDeliveryFilter(cleanup.survivors, {
      notificationType: notificationTypeValue,
      allowWhenDisabled: data?.allowWhenDisabled === true,
      onlineOnly,
      senderEmail: optionalString(data?.senderEmail) ?? null,
      nowMs,
      activeChatWindowMs: ACTIVE_CHAT_SUPPRESSION_WINDOW_MS,
      // Notice-parity exclusion (Req 7.5): the client notice fan-out
      // (`services/noticeService.ts`) excludes hard-banned and manual/forced-
      // logged-out devices via `evaluateDeviceEligibility` +
      // `canAttemptRemoteNotificationDelivery`, which the base Delivery_Filter
      // does NOT. Enable that exclusion ONLY for the notice fan-out
      // (`notice_created`) so notices reach exactly the same devices the retired
      // client reader did, while every other fan-out (chat/team/daily-quote)
      // keeps its exact shipped behavior — no chat regression.
      excludeBannedOrLoggedOut: notificationTypeValue === 'notice_created',
      // Single-device targeting (Part B): the candidate set above is already
      // narrowed to the target device; passing it here keeps the pure filter the
      // authoritative source of the restriction (Property 19).
      targetDeviceId: targetDeviceId || undefined,
    });

    if (outcome.suppressed) {
      inc('device_fanout_suppressed_total');
      return assembleFanoutResult({
        suppressed: true,
        deliverableDeviceCount: 0,
        onlineDeliverableCount: 0,
        presenceDeliveredCount: 0,
        mobileAccepted: 0,
        webPushAccepted: 0,
        failed: 0,
        staleCleaned,
        duplicatesCleaned,
      });
    }

    // Map deviceId -> surviving device so a selected target can be traced back to
    // its source device for the online count (the SelectedTarget carries only
    // deviceId + channel + credential).
    const deviceById = new Map<string, FanoutDevice>();
    for (const device of cleanup.survivors) {
      deviceById.set(device.deviceId, device);
    }

    const deliverableDeviceCount = outcome.selected.length;
    // `isOnline !== false` mirrors Req 2.7's exclusion predicate: under
    // `onlineOnly` a selected device always satisfies this, matching the client's
    // online-deliverable accounting.
    const onlineDeliverableCount = outcome.selected.reduce((count, target) => {
      const device = deviceById.get(target.deviceId);
      return device && device.isOnline !== false ? count + 1 : count;
    }, 0);

    let mobileAccepted = 0;
    let webPushAccepted = 0;
    let failed = 0;

    // Split the selected targets by channel, preserving each target's source
    // device id so invalid Expo tokens can be mapped back to their device doc for
    // the Token_Refresh_Flag write (Req 3.4).
    const mobileEntries: Array<{ deviceId: string; token: string; message: ExpoPushMessage }> = [];
    const webEntries: Array<{
      deviceId: string;
      subscription: NonNullable<SelectedTarget['webPushSubscription']>;
    }> = [];

    for (const target of outcome.selected) {
      if (target.channel === 'mobile' && target.mobileToken) {
        mobileEntries.push({
          deviceId: target.deviceId,
          token: target.mobileToken.token,
          message: {
            to: target.mobileToken.token,
            title: notification.title,
            body: notification.body,
            priority: toExpoPriority(data?.priority),
            data: data ?? {},
          },
        });
      } else if (target.channel === 'web_push' && target.webPushSubscription) {
        webEntries.push({ deviceId: target.deviceId, subscription: target.webPushSubscription });
      }
    }

    // (4a) EXPO BATCH — ALL mobile targets go out in ONE `sendExpoMessages` call
    // (internally chunked ≤100/request) under a SINGLE shared timeout, mirroring
    // `notify` (Req 1.2, 1.5). Outcomes are read back BY INDEX from `.results`
    // (never by token). On a batch timeout/throw, EVERY mobile target is failed
    // (Req 6.5 path).
    let invalidTokenSet = new Set<string>();
    const refreshRecords: PushTokenRecord[] = [];
    if (mobileEntries.length > 0) {
      let batchResults: Awaited<ReturnType<typeof sendExpoMessages>> | null = null;
      try {
        batchResults = await withTimeout(
          sendExpoMessages(
            mobileEntries.map((entry) => entry.message),
            { context: 'device_fanout' }
          ),
          NOTIFY_DELIVERY_TIMEOUT_MS
        );
      } catch (err) {
        console.warn(
          '[device_fanout] expo batch delivery failed',
          { recipientEmail },
          err instanceof Error ? err.message : err
        );
      }

      if (!batchResults) {
        // Batch timed out / threw / push service unavailable — every mobile
        // target is a failure (Req 6.5).
        failed += mobileEntries.length;
      } else {
        invalidTokenSet = new Set(batchResults.invalidTokens);
        mobileEntries.forEach((entry, index) => {
          const perMessage = batchResults!.results[index];
          if (perMessage?.ok === true) {
            mobileAccepted += 1;
          } else {
            failed += 1;
          }
          // (5) TOKEN_REFRESH_FLAG collection (Req 3.4): a target whose per-index
          // result / the aggregate `invalidTokens` set flags the token as
          // invalid/DeviceNotRegistered is queued for the flag write below.
          const errorText = typeof perMessage?.error === 'string' ? perMessage.error : '';
          const isInvalid =
            invalidTokenSet.has(entry.token) || errorText.includes('DeviceNotRegistered');
          if (isInvalid) {
            refreshRecords.push({
              token: entry.token,
              deviceDocPath: `user_devices/${recipientEmail}/devices/${entry.deviceId}`,
              deviceId: entry.deviceId,
              ownerEmail: recipientEmail,
            });
          }
        });
      }
    }

    // (4b) WEB-PUSH — each target delivered individually with its OWN timeout,
    // concurrently with a bounded fan-out, each in its own try/catch so one
    // failure never aborts the rest (Req 1.2, 3.6).
    if (webEntries.length > 0) {
      const webOk = await mapWithConcurrency(
        webEntries,
        DEVICE_ACTION_CONCURRENCY,
        async (entry): Promise<boolean> => {
          try {
            const result = await withTimeout(
              sendWebPushNotification({
                subscription: entry.subscription,
                payload: {
                  title: notification.title,
                  body: notification.body,
                  data: data ?? {},
                },
                urgency: toWebPushUrgency(data?.priority),
              }),
              NOTIFY_DELIVERY_TIMEOUT_MS
            );
            return result.ok === true;
          } catch (err) {
            console.warn(
              '[device_fanout] web push delivery failed',
              { recipientEmail, deviceId: entry.deviceId },
              err instanceof Error ? err.message : err
            );
            return false;
          }
        }
      );
      for (const ok of webOk) {
        if (ok) {
          webPushAccepted += 1;
        } else {
          failed += 1;
        }
      }
    }

    // (5) TOKEN_REFRESH_FLAG write (Req 3.4) through the Admin SDK, reusing the
    // `markPushTokensInvalid` write shape. It already swallows per-record errors;
    // wrap defensively so a total failure never aborts the fan-out (Req 3.6).
    if (refreshRecords.length > 0) {
      try {
        await markPushTokensInvalid(refreshRecords, { context: 'device_fanout' });
      } catch (err) {
        console.warn(
          '[device_fanout] token refresh flag write failed',
          { recipientEmail },
          err instanceof Error ? err.message : err
        );
      }
    }

    inc('device_fanout_delivered_total');

    // (6) ASSEMBLE the ten-field result. `presenceDeliveredCount` is 0 on the
    // server path (presence stays client-side — see the doc comment above).
    return assembleFanoutResult({
      suppressed: false,
      deliverableDeviceCount,
      onlineDeliverableCount,
      presenceDeliveredCount: 0,
      mobileAccepted,
      webPushAccepted,
      failed,
      staleCleaned,
      duplicatesCleaned,
    });
  } catch (err) {
    // (7) TOTALITY (Req 6.5, Property 15): any unexpected error anywhere in the
    // pipeline resolves to a failure result and is never thrown to the caller.
    inc('device_fanout_errors_total');
    console.warn(
      '[device_fanout] fan-out failed',
      { recipientEmail: params.recipientEmail },
      err instanceof Error ? err.message : err
    );
    return fanoutFailureResult();
  }
}
/* -------------------------------------------------------------------------- *
 * Stage 3 resolution endpoints — server-side online-status + multi-user listing
 *   device-push-fanout-migration Req 5.4 (response hygiene), 7.3 (migrate the
 *   Cross_User_Readers to Admin-SDK server paths), 7.5 (preserve the observable
 *   behavior — online-status boolean + the multi-user device listing).
 * -------------------------------------------------------------------------- *
 *
 * These two functions are the server-side replacements for the client
 * Cross_User_Readers `checkUserOnlineStatus` and `getAllUsersWithDevices`
 * (`services/deviceTrackingService.ts`). They resolve another user's devices
 * through the Admin SDK (which bypasses the `user_devices` read rule), so once
 * task 12.1 rewires the client to them, no client path reads a recipient's
 * `user_devices` tree (the precondition for the Stage 4 read-rule lockdown).
 *
 * OBSERVABLE PARITY (Req 7.5): the shapes mirror the client readers VERBATIM,
 * with two deliberate, documented reconciliations:
 *   1. ONLINE WINDOW. Online is recomputed with the shared 300-second
 *      (`DEFAULT_ONLINE_WINDOW_MS`) console window via `deviceAdminService.classifyOnline`
 *      — the single server-side online standard (Req 1.6) — combined with the
 *      stored `isOnline !== false` reconciliation the client applies in
 *      `getUserDevices` (`hasRecentActivity && (isOnline === undefined || isOnline === true)`).
 *      This reuses the existing helper rather than reimplementing a window.
 *   2. PROFILE-SOURCED FIELDS. `role`/`displayName` in the client's
 *      `AuthorizedUser` come from `tenantProfiles`/`users` (via
 *      `authService.getUserProfile`) — NOT from `user_devices` — so they are NOT
 *      Cross_User_Readers of `user_devices` and stay out of this endpoint's
 *      scope. The client (task 12.1) overlays them from its unchanged profile
 *      lookup, preserving the full `AuthorizedUser` shape with zero observable
 *      change. This endpoint returns ONLY the `user_devices`-derived observable
 *      fields (`email`, `devices`, `isOnline`, `totalDevices`, `tenantIds`).
 *
 * RESPONSE HYGIENE (Req 5.4, 7.5): every returned device has its raw push tokens,
 * web-push subscription (endpoint + keys), and device network metadata
 * (`ipAddress`-style fields) stripped by {@link toObservableDevice}, so a caller
 * can never harvest push secrets through the listing.
 */

/**
 * Device-document fields that must NEVER appear in a resolution response
 * (Req 5.4, 7.5): raw push tokens (`expoPushToken`/`fcmToken`/`apnsToken`), the
 * web-push subscription (its `endpoint` + `keys`), and device network metadata.
 * The network-metadata group mirrors the `// Network metadata` fields on the
 * device record (`ipAddress`, `networkType`, `carrierName`) plus the
 * browser/user-agent fingerprint (`userAgent`) — none of which is part of the
 * observable listing any consumer of this endpoint renders, and all of which
 * Req 5.4 prohibits returning. Every {@link ObservableDevice} has these stripped.
 */
export const SENSITIVE_OBSERVABLE_DEVICE_FIELDS: ReadonlyArray<string> = [
  'expoPushToken',
  'fcmToken',
  'apnsToken',
  'webPushSubscription',
  'ipAddress',
  'networkType',
  'carrierName',
  'userAgent',
];

/**
 * A recipient device projected for a resolution response: the stored device
 * fields MINUS {@link SENSITIVE_OBSERVABLE_DEVICE_FIELDS}, with `deviceId` forced
 * from the doc id and `isOnline` recomputed server-side (design "client/server
 * boundary"). Structurally mirrors the client `UserDevice` the retired
 * `getUserDevices` produced, minus the secret-bearing fields.
 */
export interface ObservableDevice {
  deviceId: string;
  isOnline: boolean;
  [key: string]: unknown;
}

/**
 * The per-recipient observable listing entry — the `user_devices`-derived subset
 * of the client `AuthorizedUser` (see the section comment for why `role`/
 * `displayName` are intentionally excluded).
 */
export interface ObservableUserDevices {
  email: string;
  devices: ObservableDevice[];
  isOnline: boolean;
  totalDevices: number;
  tenantIds?: string[];
}

/** Input for {@link resolveRecipientOnlineStatus}. */
export interface OnlineStatusParams {
  tenantId: string;
  recipientEmail: string;
}

/** Input for {@link listRecipientsWithDevices}. */
export interface DeviceListingParams {
  tenantId: string;
  recipientEmails: string[];
  /** The signed-in caller's email, used only for the `includeCurrentUser` skip. */
  currentUserEmail?: string;
  /** When false (default), the caller's own email is skipped from the listing. */
  includeCurrentUser?: boolean;
}

/**
 * The freshest presence time (epoch-ms) across a device doc's `lastSeen`,
 * `updatedAt`, and `lastTenantPingAt`, mirroring the client `getUserDevices`
 * freshness inputs. Returns `NaN` when none are parseable (so `classifyOnline`
 * treats the device as offline).
 */
function freshestPresenceMs(data: Record<string, unknown>): number {
  let latest = Number.NaN;
  for (const value of [data.lastSeen, data.updatedAt, data.lastTenantPingAt]) {
    const ms = toEpochMs(value);
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      latest = Number.isNaN(latest) ? ms : Math.max(latest, ms);
    }
  }
  return latest;
}

/**
 * Recompute a device's observable online status, mirroring the client
 * `getUserDevices` derivation: recent presence activity within the online window
 * AND the stored `isOnline` is not explicitly `false`
 * (`hasRecentActivity && (isOnline === undefined || isOnline === true)`).
 *
 * The freshness window is the shared 300-second console window
 * ({@link DEFAULT_ONLINE_WINDOW_MS}) evaluated by
 * `deviceAdminService.classifyOnline` (Req 1.6) — reused rather than
 * reimplemented. Pure: no I/O, deterministic in its inputs.
 */
export function isDeviceObservablyOnline(data: Record<string, unknown>, nowMs: number): boolean {
  const fresh = classifyOnline(freshestPresenceMs(data), nowMs, DEFAULT_ONLINE_WINDOW_MS);
  return fresh && (data as { isOnline?: unknown }).isOnline !== false;
}

/**
 * Project a raw `user_devices/.../devices/{id}` document into an
 * {@link ObservableDevice}: copy every field EXCEPT
 * {@link SENSITIVE_OBSERVABLE_DEVICE_FIELDS}, force `deviceId` from the doc id,
 * and set `isOnline` to the recomputed value. Pure: no I/O.
 */
export function toObservableDevice(
  deviceId: string,
  data: Record<string, unknown>,
  nowMs: number
): ObservableDevice {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_OBSERVABLE_DEVICE_FIELDS.includes(key)) {
      continue; // never leak push tokens / web-push endpoints / network metadata
    }
    safe[key] = value;
  }
  safe.deviceId = deviceId;
  safe.isOnline = isDeviceObservablyOnline(data, nowMs);
  return safe as ObservableDevice;
}

/** Ordering key: a device's last-seen epoch-ms, or `-Infinity` when unknown. */
function observableLastSeenMs(device: ObservableDevice): number {
  const ms = toEpochMs(device.lastSeen);
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Resolve whether a recipient has ANY online device within the notification's
 * tenant scope — the server-side replacement for the client
 * `checkUserOnlineStatus` (`devices.some(d => d.isOnline)`), which reads the
 * recipient's devices through the Admin SDK (Req 7.3) and preserves the boolean
 * "any device online" result (Req 7.5).
 *
 * Tenant-scoped via {@link assertTenantScope} so a caller can only resolve
 * within a tenant they share with the recipient (Req 5.2, 5.3). Mirrors the
 * client reader's non-throwing contract: any unexpected error resolves to
 * `false` (the client `catch` returns `false`).
 */
export async function resolveRecipientOnlineStatus(params: OnlineStatusParams): Promise<boolean> {
  const { tenantId, recipientEmail } = params;
  try {
    const db = getFirestore();
    const nowMs = Date.now();
    const snapshot = await db
      .collection('user_devices')
      .doc(recipientEmail)
      .collection('devices')
      .get();

    for (const docSnap of snapshot.docs) {
      const raw = (docSnap.data() ?? {}) as Record<string, unknown>;
      if (!assertTenantScope(raw, tenantId)) {
        continue; // out-of-tenant device is never in scope (Req 5.2, 5.3)
      }
      // Mirrors `checkUserOnlineStatus`: any device online (NO deleted exclusion).
      if (isDeviceObservablyOnline(raw, nowMs)) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn(
      '[device_fanout] online-status resolution failed',
      { recipientEmail },
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Resolve the multi-user device listing for a set of recipients within the
 * notification's tenant scope — the server-side replacement for the client
 * `getAllUsersWithDevices` (Req 7.3), preserving its observable listing behavior
 * (Req 7.5) while stripping push secrets from every device (Req 5.4).
 *
 * Mirrors the client reader step-for-step: normalize + dedupe the recipient
 * emails; optionally skip the caller's own email (`includeCurrentUser`); read
 * each recipient's devices through the Admin SDK, keep only the tenant-scoped
 * ones (Req 5.2, 5.3), project each to a secret-free {@link ObservableDevice},
 * and order them most-recently-seen first; derive the per-user `isOnline`
 * (`devices.some(d => d.isOnline && !d.isDeleted)`), `totalDevices`, and
 * `tenantIds` (from the devices, falling back to the scoped tenant). Finally
 * order users online-first then by email ascending, exactly as the client does.
 *
 * A per-recipient read failure is isolated (that user surfaces with an empty
 * device set), matching the client's per-user `catch` branch; a total failure
 * resolves to `[]`, matching the client's outer `catch`.
 */
export async function listRecipientsWithDevices(
  params: DeviceListingParams
): Promise<ObservableUserDevices[]> {
  const { tenantId, recipientEmails } = params;
  try {
    const db = getFirestore();
    const nowMs = Date.now();
    const normalizedCurrentUser = normalizeEmailValue(params.currentUserEmail);
    const includeCurrentUser = params.includeCurrentUser === true;

    // Normalize + dedupe recipient emails, mirroring `getAllUsersWithDevices`.
    const normalizedEmails = Array.from(
      new Set(
        recipientEmails
          .map((email) => normalizeEmailValue(email))
          .filter((email) => email.length > 0)
      )
    );

    const users: ObservableUserDevices[] = [];
    for (const email of normalizedEmails) {
      // Skip the caller's own email unless explicitly included (client parity).
      if (normalizedCurrentUser && email === normalizedCurrentUser && !includeCurrentUser) {
        continue;
      }

      let devices: ObservableDevice[] = [];
      try {
        const snapshot = await db
          .collection('user_devices')
          .doc(email)
          .collection('devices')
          .get();
        const projected: ObservableDevice[] = [];
        for (const docSnap of snapshot.docs) {
          const raw = (docSnap.data() ?? {}) as Record<string, unknown>;
          if (!assertTenantScope(raw, tenantId)) {
            continue; // out-of-tenant device is never listed (Req 5.2, 5.3)
          }
          projected.push(toObservableDevice(docSnap.id, raw, nowMs));
        }
        // Most-recently-seen first, mirroring the client `getUserDevices` sort.
        projected.sort((a, b) => observableLastSeenMs(b) - observableLastSeenMs(a));
        devices = projected;
      } catch (err) {
        // Per-recipient isolation, mirroring the client per-user `catch`.
        console.warn(
          '[device_fanout] device-listing read failed for recipient',
          { email },
          err instanceof Error ? err.message : err
        );
        devices = [];
      }

      const derivedTenantIds = Array.from(
        new Set(
          devices.flatMap((device) =>
            Array.isArray(device.tenantIds) ? (device.tenantIds as string[]) : []
          )
        )
      );
      // User is online iff any NON-deleted device is online (client parity).
      const isOnline = devices.some(
        (device) => device.isOnline === true && (device as { isDeleted?: unknown }).isDeleted !== true
      );

      users.push({
        email,
        devices,
        isOnline,
        totalDevices: devices.length,
        tenantIds: derivedTenantIds.length ? derivedTenantIds : [tenantId],
      });
    }

    // Online users first, then email ascending — the client's final sort.
    return users.sort((a, b) => {
      if (a.isOnline !== b.isOnline) {
        return a.isOnline ? -1 : 1;
      }
      return a.email.localeCompare(b.email);
    });
  } catch (err) {
    console.warn(
      '[device_fanout] device-listing resolution failed',
      { tenantId },
      err instanceof Error ? err.message : err
    );
    return [];
  }
}
