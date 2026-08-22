import 'dotenv/config';
import express from 'express';
import * as admin from 'firebase-admin';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { createGzip } from 'node:zlib';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { scheduleVideoTranscode, transcodeDocId, isVideoTranscodeEnabled, videoContentIdentity } from './videoTranscoder';
import { enqueueReminder, enqueueCustomMessage, enqueuePaymentConfirmation, getJobStatus, listJobStatus, getInMemoryQueueSnapshot, shutdownQueue } from './queueProvider';
import { sendSMS as backendSendSMS, sendVoiceCall as backendSendVoiceCall } from './twilio';
import { metricsText, inc, metricNames, getFailureRate, getWindowCount } from './metrics';
import { findJobByMessageId } from './storage';
import { z } from 'zod';
import { cspMiddleware } from './csp';
import { ensureFirebase } from './firebaseAdmin';
import {
  listTenantDevices,
  deriveTenantIndex,
  buildResultingTenantScopeForAddedTenant,
  fetchDeviceDetail,
  fetchHistory as fetchDeviceHistory,
  fetchTimeline as fetchDeviceTimeline,
  matchesSearch,
  matchesFilter,
  isInactiveDevice,
  sortAndGroup,
  paginateDevices,
  DEFAULT_DEVICE_LIST_LIMIT,
  MAX_DEVICE_LIST_LIMIT,
  computeCounts,
  forceLogout,
  ban,
  unban,
  softDelete,
  restore,
  permanentDelete,
  validateReason,
  validateExpiration,
  validateTitle,
  validateMessage,
  validateTargets,
  DEFAULT_MAX_TARGETS,
  forceLogoutAll,
  bulkForceLogout,
  notify,
  mapWithConcurrency,
  DeviceAdminError,
  ForceLogoutAllError,
  type DeviceAdminRecord,
  type DeviceFilter,
  type DeviceSort,
} from './deviceAdminService';
import { getEmailBackendBaseUrl, getWebAppBaseUrl } from './runtimeEndpoints';
import { getMaintenanceMode } from './maintenanceMode';
import { finalizeReminderQuotaFromHistory } from './lib/reminderQuota';
import { startBirthdayNotificationScheduler, runBirthdayNotificationJob, BirthdayJobOptions } from './birthdayNotificationJob';
import { startDailyQuoteScheduler, runDailyQuoteJob, getDailyQuoteSchedulerStatus } from './dailyQuoteJob';
import { startBillingBackfillScheduler, getBillingBackfillSchedulerStatus } from './billingBackfillJob';
import { startPlayBillingReconcileScheduler, getPlayBillingReconcileSchedulerStatus } from './playBillingReconcileJob';
import {
  decodeInternalToken,
  getConversationWatchStats,
  getInboxWatchStats,
  getConversationKey,
  normalizeEmail,
  verifyInternalToken,
  watchConversationRealtime,
  watchUserInboxRealtime,
} from './chatRealtime';
import { checkChatRateLimit } from './chatRateLimiter';
import {
  sendChatMessage,
  editChatMessage,
  deleteChatMessage,
  toggleChatMessageReaction,
  syncChatConversationReceipts,
  confirmOutboundChatDelivery,
  promotePendingDeliveryForRecipientThrottled,
  markChatConversationRead,
  reconcileChatUnreadForUser,
  rebuildChatSummariesForUser,
  ChatMessageActionError,
} from './chatMessageWriter';
import { buildBackgroundUploadChatMessageInput } from './lib/backgroundUploadMessage';
import {
  computeUploadQuotaDelta,
  deriveUploadKeyHash,
  resolveUploadObjectPath,
  sanitizeStorageSegment,
  type StorageUploadPurpose,
} from './lib/uploadObjectPath';
import { STORAGE_TENANT_CATEGORIES } from './lib/storageObjectRef';
import { estimateTenantStorageBytes } from './lib/tenantStorageUsage';
import {
  sendTeamMembershipChangeNotification,
  sendTenantJoinRequestNotification,
  sendTenantJoinRequestOutcomeNotification,
} from './teamMembershipNotifier';
import { sendTenantInviteEmail } from './tenantNotificationEmail';
import { streamTenantExport, TenantExportAbortedError } from './lib/tenantExport';
import { buildInvoiceStoragePath, ensureInvoicePdfInStorage } from './lib/invoicePdf';
import {
  getPlanLimits,
  getUsagePercentage,
  getUsageStatus,
  type PlanId,
  type PlanLimits,
  type UsageStatus,
} from './lib/planLimits';
import {
  createRazorpaySubscription,
  cancelRazorpaySubscription,
  fetchRazorpaySubscription,
  resumeRazorpaySubscription,
  handleRazorpayWebhook,
  verifyRazorpayWebhookSignature,
  type RazorpayWebhookEvent,
} from './billing/razorpay';
import { runBillingBackfill } from './jobs/billingBackfill';
import { sendTenantBillingEventNotification } from './billing/billingNotifier';
import { recordBillingOpsEvent, safePreview } from './billing/billingOps';
import {
  builtInFreePlan,
  getPlanVariantById,
  listCoupons,
  listPlanVariants,
  resolveCouponCode,
  upsertCoupon,
  upsertPlanVariant,
} from './billing/catalog';
import {
  resolveEffectivePlanLimitsForTenant,
  resolvePlanLimitsFromCatalog,
  toTenantBillingLimitsSnapshot,
} from './lib/effectivePlanLimits';
import {
  getWebPushPublicKey,
  isWebPushConfigured,
  sanitizeWebPushSubscription,
  sendWebPushNotification,
} from './webPush';
import {
  fanout as deviceFanoutDefault,
  serializeFanoutResponse,
  resolveRecipientOnlineStatus as resolveRecipientOnlineStatusDefault,
  listRecipientsWithDevices as listRecipientsWithDevicesDefault,
  type FanoutParams as DeviceFanoutParams,
  type DeviceNotificationFanoutResult as DeviceFanoutResult,
  type OnlineStatusParams as DeviceOnlineStatusParams,
  type DeviceListingParams,
  type ObservableUserDevices,
} from './deviceFanoutService';

type TenantMembershipRole = 'owner' | 'admin' | 'staff' | 'member';

interface TenantJoinRequestRecord {
  id: string;
  tenantId: string;
  tenantName?: string;
  userId?: string;
  email?: string;
  displayName?: string;
  message?: string;
}

type TenantJoinRequestLoader = (requestId: string) => Promise<TenantJoinRequestRecord | null>;

interface TenantInviteRecord {
  id: string;
  tenantId: string;
  tenantName?: string;
  email: string;
  role?: string;
  token?: string;
  expiresAt?: string;
  invitationMessage?: string;
}

type TenantInviteLoader = (inviteId: string) => Promise<TenantInviteRecord | null>;
type TenantInviteSendRecorder = (inviteId: string, actorId?: string) => Promise<void>;
interface ExpoPushProxyExecutorResponse {
  status: number;
  ok: boolean;
  body: any;
  rawBody?: string;
}
type ExpoPushProxyExecutor = (options: {
  payload: Record<string, any>;
  endpoint: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
}) => Promise<ExpoPushProxyExecutorResponse>;

const tenantRolePriority: Record<TenantMembershipRole, number> = {
  member: 1,
  staff: 2,
  admin: 3,
  owner: 4,
};

type TenantAccessContext = {
  tenantId: string;
  role: TenantMembershipRole;
  membershipId: string | null;
};

declare module 'express-serve-static-core' {
  interface Request {
    authContext?: {
      tokenType: 'master' | 'internal' | 'firebase';
      uid?: string;
      email?: string;
      isGlobalAdmin?: boolean;
    };
    tenantAccess?: TenantAccessContext;
  }
}

// Simple in-memory rate limiter (IP + endpoint). Suitable for low volume.
interface RLBucket { tokens: number; updated: number }
const rlStore = new Map<string, RLBucket>();
function rateLimitMiddleware(opts: { windowMs: number; max: number }) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Allow skipping in tests
    if (process.env.TEST_MODE === '1') return next();
    const now = Date.now();
    // Opportunistic eviction so the in-memory bucket store can't grow unbounded
    // across many distinct client IPs over time (only scans when it gets large).
    if (rlStore.size > 5000) {
      for (const [k, b] of rlStore) {
        if (now - b.updated > opts.windowMs) rlStore.delete(k);
      }
    }
    const key = `${req.ip}:${req.path}`;
    const win = opts.windowMs;
    let bucket = rlStore.get(key);
    if (!bucket) { bucket = { tokens: opts.max, updated: now }; rlStore.set(key, bucket); }
    // Refill
    const elapsed = now - bucket.updated;
    if (elapsed > win) { bucket.tokens = opts.max; bucket.updated = now; }
    if (bucket.tokens <= 0) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    bucket.tokens -= 1;
    next();
  };
}

// Schemas
const smsSchema = z.object({ to: z.string().min(5), message: z.string().min(1).max(1600) });
const voiceSchema = z.object({
  to: z.string().min(5),
  message: z.string().min(1).max(3000),
  language: z.enum(['english','hindi','both']).optional(),
  voice: z.string().optional(),
  hindiVoice: z.string().optional(),
  englishVoice: z.string().optional(),
  pauseSeconds: z.number().int().min(1).max(60).optional()
});

const reminderHistoryWriteSchema = z
  .object({
    batchId: z.string().min(1).max(120).optional(),
    userId: z.string().min(1).max(200).optional(),
    studentId: z.string().min(1).max(200).optional(),
    studentName: z.string().min(1).max(200).optional(),
    parentName: z.string().min(1).max(200).optional(),
    parentContact: z.string().min(1).max(300).optional(),
    parentEmail: z.string().email().optional(),
    message: z.string().max(5000).optional(),
    amount: z.number().optional(),
    dueDate: z.string().max(50).optional(),
    feeCategories: z.array(z.string().max(200)).max(100).optional(),
    settings: z
      .object({
        useCustomMessage: z.boolean().optional(),
        useCustomNotes: z.boolean().optional(),
        language: z.enum(['english', 'hindi', 'both']).optional(),
        coachingName: z.string().max(200).optional(),
        teacherName: z.string().max(200).optional(),
      })
      .optional(),
  })
  .passthrough();

const tenantScopedSmsSchema = smsSchema.extend({
  tenantId: z.string().min(1),
  quotaBatchId: z.string().min(1).max(120).optional(),
  historyId: z.string().min(1).max(240).optional(),
  history: reminderHistoryWriteSchema.optional(),
});

const tenantScopedVoiceSchema = voiceSchema.extend({
  tenantId: z.string().min(1),
  quotaBatchId: z.string().min(1).max(120).optional(),
  historyId: z.string().min(1).max(240).optional(),
  history: reminderHistoryWriteSchema.optional(),
});

const reminderQuotaReserveSchema = z.object({
  tenantId: z.string().min(1),
  batchId: z.string().min(1).max(120),
  counts: z
    .object({
      email: z.number().int().min(0).max(100_000).optional(),
      sms: z.number().int().min(0).max(100_000).optional(),
      whatsapp: z.number().int().min(0).max(100_000).optional(),
      voice: z.number().int().min(0).max(100_000).optional(),
    })
    .default({}),
});

const reminderBatchSendEmailTemplateSchema = z
  .object({
    template: z.enum(['fee_reminder', 'custom_message_bilingual']),
    to_email: z.string().email(),
    to_name: z.string().max(200).optional(),
    subject: z.string().max(300).optional(),
    student_name: z.string().max(200).optional(),
    amount: z.string().max(50).optional(),
    due_date: z.string().max(50).optional(),
    custom_notes: z.string().max(2000).optional(),
    custom_message: z.string().max(5000).optional(),
    custom_message_english: z.string().max(5000).optional(),
    custom_message_hindi: z.string().max(5000).optional(),
    selectedLanguage: z.enum(['english', 'hindi', 'both']).optional(),
    languageOrder: z.enum(['english-first', 'hindi-first']).optional(),
    english_first: z.boolean().optional(),
    coaching_name: z.string().max(200).optional(),
    from_name: z.string().max(200).optional(),
    teacher_name: z.string().max(200).optional(),
    teacher_email: z.string().email().optional(),
    reply_to: z.string().email().optional(),
    show_coaching_name: z.boolean().optional(),
    show_teacher_name: z.boolean().optional(),
    tenant_id: z.string().min(1).max(100).optional(),
    tenantId: z.string().min(1).max(100).optional(),
  })
  .passthrough();

const reminderBatchSendItemSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('sms'),
      studentId: z.string().min(1).max(200),
      to: z.string().min(5).max(50),
      message: z.string().min(1).max(1600),
      historyId: z.string().min(1).max(240).optional(),
      history: reminderHistoryWriteSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('voice'),
      studentId: z.string().min(1).max(200),
      to: z.string().min(5).max(50),
      message: z.string().min(1).max(3000),
      language: z.enum(['english', 'hindi', 'both']).optional(),
      voice: z.string().optional(),
      hindiVoice: z.string().optional(),
      englishVoice: z.string().optional(),
      pauseSeconds: z.number().int().min(1).max(60).optional(),
      historyId: z.string().min(1).max(240).optional(),
      history: reminderHistoryWriteSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('whatsapp'),
      studentId: z.string().min(1).max(200),
      kind: z.enum(['fee', 'custom']),
      to: z.string().min(5).max(50),
      // fee fields
      studentName: z.string().max(200).optional(),
      amount: z.number().optional(),
      dueDate: z.string().max(50).optional(),
      parentName: z.string().max(200).optional(),
      greeting: z.string().max(50).optional(),
      customNotes: z.string().max(2000).optional(),
      customNotesEnglish: z.string().max(2000).nullable().optional(),
      customNotesHindi: z.string().max(2000).nullable().optional(),
      // custom fields
      message: z.string().max(5000).optional(),
      englishMessage: z.string().max(5000).optional(),
      hindiMessage: z.string().max(5000).optional(),
      // common
      teacherName: z.string().max(200).optional(),
      coachingName: z.string().max(200).optional(),
      selectedLanguage: z.enum(['english', 'hindi', 'both']).optional(),
      languageOrder: z.enum(['english-first', 'hindi-first']).optional(),
      historyId: z.string().min(1).max(240).optional(),
      history: reminderHistoryWriteSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('email'),
      studentId: z.string().min(1).max(200),
      email: reminderBatchSendEmailTemplateSchema,
      historyId: z.string().min(1).max(240).optional(),
      history: reminderHistoryWriteSchema.optional(),
    })
    .passthrough(),
]);

const reminderBatchSendSchema = z.object({
  tenantId: z.string().min(1),
  batchId: z.string().min(1).max(120),
  items: z.array(reminderBatchSendItemSchema).min(1).max(10_000),
});

const reminderHistoryStatusQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
  historyIds: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
});

const expoPushMessageSchema = z.object({
  // Cap the recipient-token array to bound request size / abuse (L10). Legitimate
  // sends target a single user's handful of devices; 1000 is far above that.
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(1000)]),
  title: z.string().optional(),
  body: z.string().optional(),
  data: z.record(z.any()).optional(),
  sound: z.union([z.literal('default'), z.string()]).optional(),
  subtitle: z.string().optional(),
  channelId: z.string().optional(),
  priority: z.enum(['default','normal','high']).optional(),
  ttl: z.number().int().min(0).max(2419200).optional(),
  expiration: z.union([z.number(), z.string()]).optional(),
  badge: z.number().int().optional(),
  mutableContent: z.boolean().optional(),
  categoryId: z.string().optional(),
  collapseId: z.string().optional(),
  // Allow any additional Expo-supported properties without failing validation
}).passthrough();

const expoPushPayloadSchema = z.union([
  expoPushMessageSchema,
  z.object({
    messages: z.array(expoPushMessageSchema).min(1).max(100),
    dryRun: z.boolean().optional()
  })
]);

const tenantScopedPushPayloadSchema = expoPushPayloadSchema.and(
  z.object({ tenantId: z.string().min(1) })
);

// Server_Fanout request body (device-push-fanout-migration, design "Components
// §1 Fanout_Endpoint"). A recipient identifier plus a notification payload
// carrying a title, body, and `data.type` (the Notification_Type) — Req 1.4.
const fanoutPayloadSchema = z.object({
  tenantId: z.string().min(1),
  recipientEmail: z.string().min(1),
  notification: z.object({
    title: z.string(),
    body: z.string(),
    data: z.record(z.unknown()).optional(),
  }),
  onlineOnly: z.boolean().optional(),
  // Optional single-device target (device-push-fanout-migration, task 12.1 Part
  // B). When present, the fan-out restricts its candidate devices to the ONE
  // device whose `deviceId` matches, so the client single-device push path
  // (`sendNotificationToDeviceDetailed`) can route through the server without
  // reading another user's device documents. Passed through as `targetDeviceId`.
  deviceId: z.string().min(1).optional(),
});

// Server-side online-status resolution body (device-push-fanout-migration Stage
// 3, design "Cross_User_Reader migration inventory"). Replaces the client
// `checkUserOnlineStatus` cross-user read — Req 7.3, 7.5.
const onlineStatusPayloadSchema = z.object({
  tenantId: z.string().min(1),
  recipientEmail: z.string().min(1),
});

// Server-side multi-user device-listing body (device-push-fanout-migration
// Stage 3). Replaces the client `getAllUsersWithDevices` cross-user reads —
// Req 7.3, 7.5. `recipientEmails` is bounded to mirror the client's batched
// listing and cap the Admin-SDK fan-out.
const deviceListingPayloadSchema = z.object({
  tenantId: z.string().min(1),
  recipientEmails: z.array(z.string().min(1)).min(1).max(500),
  currentUserEmail: z.string().optional(),
  includeCurrentUser: z.boolean().optional(),
});

const dailyQuoteTriggerSchema = z.object({
  timeOfDay: z.enum(['morning', 'evening', 'immediate', 'auto']).optional(),
  targetEmails: z.array(z.string().email()).min(1).max(200).optional(),
  dryRun: z.boolean().optional(),
  reason: z.string().optional(),
  now: z.string().optional(),
});

const tenantScopedDailyQuoteTriggerSchema = dailyQuoteTriggerSchema.and(
  z.object({ tenantId: z.string().min(1) })
);

const birthdayTriggerSchema = z.object({
  email: z.string().email().optional(),
  emails: z.array(z.string().email()).min(1).max(200).optional(),
  deviceId: z.string().min(1).optional(),
  deviceIds: z.array(z.string().min(1)).min(1).max(200).optional(),
  dryRun: z.boolean().optional(),
  forceSend: z.boolean().optional(),
  skipWhatsApp: z.boolean().optional(),
  suppressStateUpdates: z.boolean().optional(),
  reason: z.string().optional(),
  now: z.string().optional(),
});

const tenantScopedBirthdayTriggerSchema = birthdayTriggerSchema.and(
  z.object({ tenantId: z.string().min(1) })
);

const webPushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
}).passthrough();

const tenantScopedWebPushSubscribeSchema = z.object({
  tenantId: z.string().min(1),
  deviceId: z.string().trim().min(4).max(200),
  subscription: webPushSubscriptionSchema,
  notificationPermission: z.enum(['default', 'granted', 'denied']).optional(),
  userAgent: z.string().max(4000).optional(),
});

const tenantScopedWebPushUnsubscribeSchema = z.object({
  tenantId: z.string().min(1),
  deviceId: z.string().trim().min(4).max(200),
});

const tenantScopedWebPushSendSchema = z.object({
  tenantId: z.string().min(1),
  deviceId: z.string().trim().min(4).max(200),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  data: z.record(z.any()).optional(),
  tag: z.string().max(200).optional(),
  requireInteraction: z.boolean().optional(),
  clickUrl: z.string().max(1000).optional(),
  ttl: z.number().int().min(0).max(2419200).optional(),
  urgency: z.enum(['very-low', 'low', 'normal', 'high']).optional(),
});

const tenantScopedWebPushTestSchema = z.object({
  tenantId: z.string().min(1),
  deviceId: z.string().trim().min(4).max(200),
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(4000).optional(),
  type: z.string().min(1).max(120).optional(),
  clickUrl: z.string().max(1000).optional(),
  requireInteraction: z.boolean().optional(),
});

const devicePingSchema = z.object({
  tenantId: z.string().trim().min(1),
  userEmail: z.string().email(),
  deviceId: z.string().trim().min(4).max(200),
  pingType: z.enum(['register', 'heartbeat', 'full']).default('heartbeat'),
  requestId: z.string().trim().max(200).optional(),
  isOnline: z.boolean().optional(),
});

const chatDeltaSchema = z.object({
  userEmail: z.string().email(),
  partnerEmail: z.string().email(),
  direction: z.enum(['latest', 'older', 'newer']).default('older'),
  limit: z.number().int().min(1).max(200).default(50),
  tenantId: z.string().min(1),
  cursor: z
    .object({
      timestamp: z.string().optional(),
      messageId: z.string().optional(),
    })
    .partial()
    .optional(),
});

const chatAttachmentSchema = z.object({
  url: z.string().url(),
  fileName: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().int().min(0).optional(),
  thumbnailUrl: z.string().url().optional(),
});

const chatStickerSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1),
  pack: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

const chatGifSchema = z.object({
  url: z.string().url(),
  thumbnailUrl: z.string().url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
});

const chatReplyContextSchema = z.object({
  messageId: z.string().min(1),
  sender: z.string().email(),
  senderName: z.string().min(1).max(120).optional(),
  text: z.string().max(1000).optional(),
  isSpecial: z.boolean().optional(),
  hasAttachments: z.boolean().optional(),
  attachmentCount: z.number().int().min(1).max(20).optional(),
  hasSticker: z.boolean().optional(),
  hasGif: z.boolean().optional(),
});

const chatMessagePayloadSchema = z
  .object({
    recipientId: z.string().min(1),
    tenantId: z.string().min(1),
    clientMsgId: z.string().trim().min(1).max(200).optional(),
    text: z.string().max(5000).optional(),
    isSpecial: z.boolean().optional(),
    fileUrl: z.string().url().optional(),
    fileName: z.string().optional(),
    fileType: z.string().optional(),
    fileSize: z.number().int().min(0).optional(),
    thumbnailUrl: z.string().url().optional(),
    attachments: z.array(chatAttachmentSchema).max(10).optional(),
    replyTo: chatReplyContextSchema.optional(),
    sticker: chatStickerSchema.optional(),
    gif: chatGifSchema.optional(),
    // NOTE: client-supplied `delivered`/`read` are intentionally NOT accepted on
    // the initial send (chat-production-hardening, finding P2-4). Receipts are set
    // only via the dedicated delivery/read endpoints, never trusted from the
    // sender. Any such fields in the body are dropped by this schema.
  })
  .superRefine((value, ctx) => {
    const hasText = typeof value.text === 'string' && value.text.trim().length > 0;
    const hasAttachment = Array.isArray(value.attachments) && value.attachments.length > 0;
    const hasFile = typeof value.fileUrl === 'string' && value.fileUrl.length > 0;
    const hasSticker = Boolean(value.sticker);
    const hasGif = Boolean(value.gif);

    if (!hasText && !hasAttachment && !hasFile && !hasSticker && !hasGif && !value.isSpecial) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Message content is empty',
      });
    }
  });

const chatMessageEditSchema = z.object({
  text: z.string().min(1).max(5000),
  tenantId: z.string().min(1),
});

const chatMessageReactionSchema = z.object({
  tenantId: z.string().min(1),
  reactionType: z.string().min(1).max(32),
});

const chatReceiptSyncSchema = z
  .object({
    tenantId: z.string().min(1),
    partnerEmail: z.string().email(),
    deliveredMessageIds: z.array(z.string().trim().min(1)).max(200).optional(),
    readMessageIds: z.array(z.string().trim().min(1)).max(200).optional(),
    markConversationDelivered: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const deliveredCount = Array.isArray(value.deliveredMessageIds) ? value.deliveredMessageIds.length : 0;
    const readCount = Array.isArray(value.readMessageIds) ? value.readMessageIds.length : 0;
    const wantsConversationDelivery = value.markConversationDelivered === true;

    if (!deliveredCount && !readCount && !wantsConversationDelivery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one receipt sync action is required',
        path: ['readMessageIds'],
      });
    }
  });

const chatDeliveryProvenanceSchema = z.object({
  sources: z.array(z.enum(['presence', 'push'])).max(2).optional(),
  lastSource: z.enum(['presence', 'push']).optional(),
  lastUpdatedAt: z.string().datetime().optional(),
  presence: z.object({
    deliveredAt: z.string().datetime().optional(),
    onlineDeviceCount: z.number().int().min(0).max(1000).optional(),
    focusedDeviceCount: z.number().int().min(0).max(1000).optional(),
  }).partial().optional(),
  push: z.object({
    deliveredAt: z.string().datetime().optional(),
    acceptedDeviceCount: z.number().int().min(0).max(1000).optional(),
    mobileAcceptedCount: z.number().int().min(0).max(1000).optional(),
    webAcceptedCount: z.number().int().min(0).max(1000).optional(),
  }).partial().optional(),
}).partial();

const chatOutboundDeliverySchema = z
  .object({
    tenantId: z.string().min(1),
    partnerEmail: z.string().email(),
    deliveredMessageIds: z.array(z.string().trim().min(1)).max(200),
    provenance: chatDeliveryProvenanceSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.deliveredMessageIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one delivered message id is required',
        path: ['deliveredMessageIds'],
      });
    }
  });

// chat-production-hardening (finding P0-1 — Model A): the client no longer marks
// a conversation read or reconciles unread counters by writing to RTDB directly.
// It calls these authenticated endpoints instead, so the reader identity is bound
// to the token and can never be spoofed.
const chatConversationReadSchema = z.object({
  tenantId: z.string().min(1),
  partnerEmail: z.string().email(),
});

const chatUnreadReconcileSchema = z.object({
  tenantId: z.string().min(1),
});

// chat-production-hardening (finding P0-1 — Model A): summary reconstruction was
// the last client direct-writer. It now runs server-side through this endpoint so
// the RTDB writes happen under the Admin SDK bound to the caller's token.
const chatSummariesRebuildSchema = z.object({
  tenantId: z.string().min(1),
});

const teamMembershipRoleEnum = z.enum(['owner', 'admin', 'staff', 'member', 'user']);
const tenantMembershipRoleSchema = z.enum(['owner', 'admin', 'staff', 'member']);
const tenantMembershipStatusSchema = z.enum(['active', 'pending_request', 'revoked', 'rejected']);

const membershipActionMetadataSchema = z
  .object({
    reason: z.string().trim().max(200).optional(),
    initiatedFrom: z.enum(['web', 'mobile', 'system']).optional(),
    actorName: z.string().trim().max(120).optional(),
  })
  .optional();

const membershipRoleUpdateSchema = z.object({
  role: tenantMembershipRoleSchema,
  metadata: membershipActionMetadataSchema,
});

const membershipStatusUpdateSchema = z.object({
  status: tenantMembershipStatusSchema,
  metadata: membershipActionMetadataSchema,
});

const tenantInviteCreateSchema = z.object({
  email: z.string().email(),
  role: tenantMembershipRoleSchema.default('member'),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  message: z.string().trim().max(500).optional(),
});

const tenantInviteAcceptSchema = z.object({
  token: z
    .string()
    .trim()
    .min(8)
    .max(200),
});

const tenantInviteRejectSchema = z.object({
  token: z
    .string()
    .trim()
    .min(8)
    .max(200),
});

const joinRequestApprovalSchema = z.object({
  role: tenantMembershipRoleSchema.default('staff'),
  reviewerName: z.string().trim().max(120).optional(),
  metadata: membershipActionMetadataSchema,
});

const joinRequestRejectionSchema = z.object({
  reviewerName: z.string().trim().max(120).optional(),
  metadata: membershipActionMetadataSchema,
  reason: z.string().trim().max(200).optional(),
});

const teamMembershipEventSchema = z.object({
  tenantId: z.string().min(1),
  tenantName: z.string().min(1).max(160).optional(),
  action: z.enum(['added', 'removed', 'role_changed']),
  targetEmail: z.string().email(),
  targetRole: teamMembershipRoleEnum.optional(),
  previousRole: teamMembershipRoleEnum.optional(),
  metadata: z
    .object({
      displayName: z.string().min(1).max(120).optional(),
      reason: z.string().max(300).optional(),
      initiatedFrom: z.enum(['web', 'mobile', 'system']).optional(),
      actorName: z.string().min(1).max(120).optional(),
    })
    .partial()
    .optional(),
});

const tenantJoinRequestNotifySchema = z.object({
  tenantId: z.string().min(1),
  requestId: z.string().min(6),
});

const tenantInviteNotifySchema = z.object({
  tenantId: z.string().min(1),
  inviteId: z.string().min(6),
});

const tenantJoinRequestOutcomeSchema = z.object({
  tenantId: z.string().min(1),
  requestId: z.string().min(6),
  outcome: z.enum(['approved', 'rejected']),
  assignedRole: teamMembershipRoleEnum.optional(),
  reviewerName: z.string().min(1).max(120).optional(),
});

const tenantJoinCodeLookupSchema = z.object({
  code: z
    .string()
    .min(4)
    .max(32),
});

const tenantSearchSchema = z.object({
  query: z.string().trim().max(80).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const tenantUserDevicesSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
});

// Device Console (Device Admin API) read-endpoint schemas. Mirror the existing
// admin-route conventions: trimmed/bounded strings, `.safeParse(req.body || {})`,
// and a 400 `validation_failed` (with `issues`) on failure without mutating state.
const deviceFilterValues = [
  'all',
  'online',
  'offline',
  'web',
  'mobile',
  'tablet',
  'deleted',
  'logged_out',
  'force_logged_out',
  'hard_banned',
] as const;

const deviceSortValues = ['name', 'lastSeen', 'deviceType', 'status'] as const;

const tenantDeviceListSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  // Search term is optional; 1–256 chars (Req 4.1). An empty/omitted term
  // matches all devices, so only the upper bound is enforced here.
  search: z.string().trim().max(256).optional(),
  filter: z.enum(deviceFilterValues).optional(),
  sort: z.enum(deviceSortValues).optional(),
  hideInactive: z.boolean().optional(),
  // Page size cap for result-set pagination (Recommendation #2). Omitted =>
  // DEFAULT_DEVICE_LIST_LIMIT applied in the route.
  limit: z.number().int().positive().max(MAX_DEVICE_LIST_LIMIT).optional(),
  // Opaque page cursor (base64url offset into the deterministic ordered
  // result); blank/absent/invalid resolves to the first page.
  cursor: z.string().trim().min(1).max(400).optional(),
});

const tenantDeviceDetailSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  deviceId: z.string().trim().min(1).max(200),
});

const tenantDeviceHistorySchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().trim().min(1).max(400).optional(),
  action: z.string().trim().min(1).max(64).optional(),
});

const tenantDeviceTimelineSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  deviceId: z.string().trim().min(1).max(200),
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().trim().min(1).max(400).optional(),
});

// Single-device destructive-action bodies. `tenantId` is a required non-empty
// string (Req 3.6) so an unscoped request is rejected with 400 before any
// service call; the orchestrators additionally reject cross-tenant targets with
// `tenant_scope_violation`→403 (Req 3.2/3.3). Reason is accepted loosely here
// (optional/unbounded) for the endpoints that gate it through `validateReason`
// so a bad reason surfaces as the specific `invalid_reason`/`invalid_expiration`
// code rather than a generic `validation_failed`.
const tenantDeviceActionSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  deviceId: z.string().trim().min(1).max(200),
  reason: z.string().optional(),
});

const tenantDeviceBanSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  deviceId: z.string().trim().min(1).max(200),
  reason: z.string().optional(),
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional(),
});

// User-scoped force-logout-all body (#4). No `deviceId` — the orchestrator
// signals every active in-tenant device of `email`. Reason is accepted loosely
// (the orchestrator falls back to a default when omitted).
const tenantDeviceForceLogoutAllSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  reason: z.string().optional(),
});

// Bulk force-logout body (#5). `targets` is validated STRUCTURALLY here (array
// of `{ email, deviceId }`); the non-empty / ≤500 bounds are enforced by
// `validateTargets` in the handler so they surface as the specific
// `too_many_targets` code (Req 14.2/14.4).
const tenantDeviceBulkForceLogoutSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  targets: z.array(
    z.object({
      email: z.string().trim().email().max(200),
      deviceId: z.string().trim().min(1).max(200),
    })
  ),
  reason: z.string().optional(),
});

// Notify body (#11). `title`/`body`/`targets` are accepted loosely here so the
// length + count bounds surface as the specific `invalid_title` /
// `invalid_message` / `empty_recipients` / `too_many_targets` codes via
// `validateTitle`/`validateMessage`/`validateTargets` in the handler
// (Req 12.1, 12.4, 12.6, 14.4).
const tenantDeviceNotifySchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  title: z.string(),
  body: z.string(),
  targets: z.array(
    z.object({
      email: z.string().trim().email().max(200),
      deviceId: z.string().trim().min(1).max(200),
    })
  ),
  priority: z.enum(['high', 'normal', 'low']).optional(),
});

const tenantJoinCodeClaimSchema = tenantJoinCodeLookupSchema.extend({
  displayName: z.string().min(1).max(120).optional(),
  message: z.string().max(300).optional(),
});

const adminMembershipRoleOverrideSchema = z
  .object({
    tenantId: z.string().trim().min(6).max(120),
    userId: z.string().trim().min(1).max(200),
  })
  .merge(membershipRoleUpdateSchema);

const globalAdminClaimLookupSchemaBase = z
  .object({
    uid: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(320).optional(),
  });

const globalAdminClaimLookupSchema = globalAdminClaimLookupSchemaBase.refine((value) => Boolean(value.uid || value.email), {
    message: 'uid_or_email_required',
  });

const globalAdminClaimUpdateSchema = globalAdminClaimLookupSchemaBase.extend({
  admin: z.boolean(),
  reason: z.string().trim().max(200).optional(),
}).refine((value) => Boolean(value.uid || value.email), {
  message: 'uid_or_email_required',
});

const notificationPreferenceKeys = [
  'membershipEventsEmail',
  'membershipEventsPush',
  'joinRequestEmail',
  'joinRequestPush',
  'usageAlertEmail',
  'usageAlertPush',
  'usageAlertWhatsApp',
  'usageAlertSlack',
] as const;
type NotificationPreferenceKey = (typeof notificationPreferenceKeys)[number];

const DEFAULT_INVITE_EXPIRY_DAYS = 7;

const REVIEWER_AUTO_APPROVE_JOIN_CODE = normalizeTenantCode(process.env.REVIEWER_AUTO_APPROVE_JOIN_CODE || '');
const REVIEWER_AUTO_APPROVE_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.REVIEWER_AUTO_APPROVE_ENABLED || '').trim().toLowerCase(),
);
const REVIEWER_AUTO_APPROVE_TENANT_ID = String(process.env.REVIEWER_AUTO_APPROVE_TENANT_ID || '').trim();
const REVIEWER_AUTO_APPROVE_TENANT_SLUG = String(process.env.REVIEWER_AUTO_APPROVE_TENANT_SLUG || '').trim().toLowerCase();
const REVIEWER_AUTO_APPROVE_ROLE = (() => {
  const candidate = String(process.env.REVIEWER_AUTO_APPROVE_ROLE || '').trim().toLowerCase();
  if (candidate === 'admin' || candidate === 'staff' || candidate === 'member') {
    return candidate;
  }
  return 'member';
})();
const REVIEWER_AUTO_APPROVE_ACTOR_NAME = String(process.env.REVIEWER_AUTO_APPROVE_ACTOR_NAME || 'Reviewer quick join').trim();

function shouldAutoApproveReviewerJoinCode(options: {
  code: string;
  tenantId: string;
  tenantSlug?: string;
}): boolean {
  if (!REVIEWER_AUTO_APPROVE_ENABLED) {
    return false;
  }
  if (!REVIEWER_AUTO_APPROVE_JOIN_CODE) {
    return false;
  }
  if (options.code !== REVIEWER_AUTO_APPROVE_JOIN_CODE) {
    return false;
  }
  if (REVIEWER_AUTO_APPROVE_TENANT_ID && options.tenantId !== REVIEWER_AUTO_APPROVE_TENANT_ID) {
    return false;
  }
  if (REVIEWER_AUTO_APPROVE_TENANT_SLUG) {
    const slug = (options.tenantSlug || '').trim().toLowerCase();
    if (!slug || slug !== REVIEWER_AUTO_APPROVE_TENANT_SLUG) {
      return false;
    }
  }
  return true;
}

const DEFAULT_WEB_APP_BASE_URL = 'https://tuitionmanager.app';

function normalizeWebBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

async function resolveWebAppBaseUrlServer(): Promise<string> {
  const fromFirestore = normalizeWebBaseUrl(await getWebAppBaseUrl());
  if (fromFirestore) return fromFirestore;

  // Backward-compatible env fallback. NOTE: EXPO_PUBLIC_* is only public on the client;
  // on the server it's just an env var.
  const fromEnv =
    normalizeWebBaseUrl(process.env.WEB_APP_BASE_URL) ||
    normalizeWebBaseUrl(process.env.PUBLIC_WEB_APP_ORIGIN) ||
    normalizeWebBaseUrl(process.env.EXPO_PUBLIC_WEB_APP_URL);
  return fromEnv || DEFAULT_WEB_APP_BASE_URL;
}

async function buildTenantInviteLinkServer(token: string): Promise<string> {
  const base = await resolveWebAppBaseUrlServer();
  const safeToken = encodeURIComponent((token || '').trim());
  return `${base}/invite/${safeToken}`;
}

async function buildSmartSharedFileLinkServer(token: string): Promise<{ shareUrl: string; webUrl: string }> {
  const base = await resolveWebAppBaseUrlServer();
  const safeToken = encodeURIComponent((token || '').trim());
  const webUrl = `${base}/s/${safeToken}`;
  const q = new URLSearchParams();
  q.set('u', webUrl);
  q.set('dl', `s/${(token || '').trim()}`);
  const shareUrl = `${base}/l?${q.toString()}`;
  return { shareUrl, webUrl };
}

const tenantNotificationPreferencesSchema = z
  .object({
    membershipEventsEmail: z.boolean().optional(),
    membershipEventsPush: z.boolean().optional(),
    joinRequestEmail: z.boolean().optional(),
    joinRequestPush: z.boolean().optional(),
    usageAlertEmail: z.boolean().optional(),
    usageAlertPush: z.boolean().optional(),
    usageAlertWhatsApp: z.boolean().optional(),
    usageAlertSlack: z.boolean().optional(),
  })
  .strict();

const notificationPreferenceUpdateMetadataSchema = z
  .object({
    initiatedFrom: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional(),
    actorName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional(),
    reason: z
      .string()
      .trim()
      .max(300)
      .optional(),
  })
  .strict();

const tenantNotificationPreferencesUpdateSchema = z.object({
  notificationPreferences: tenantNotificationPreferencesSchema.refine(
    (prefs) => notificationPreferenceKeys.some((key) => typeof prefs[key] === 'boolean'),
    { message: 'at_least_one_preference' }
  ),
  metadata: notificationPreferenceUpdateMetadataSchema.optional(),
});

const defaultTenantNotificationPreferences: Record<NotificationPreferenceKey, boolean> = {
  membershipEventsEmail: true,
  membershipEventsPush: true,
  joinRequestEmail: true,
  joinRequestPush: true,
  usageAlertEmail: true,
  usageAlertPush: true,
  usageAlertWhatsApp: true,
  usageAlertSlack: true,
};

function normalizeTenantCode(raw?: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  return normalized.length >= 4 ? normalized : null;
}

function normalizeTenantNotificationPreferences(value: Record<string, any> | undefined | null): Record<NotificationPreferenceKey, boolean> {
  const normalized: Record<NotificationPreferenceKey, boolean> = { ...defaultTenantNotificationPreferences };
  if (value && typeof value === 'object') {
    for (const key of notificationPreferenceKeys) {
      const raw = value[key];
      if (typeof raw === 'boolean') {
        normalized[key] = raw;
      }
    }
  }
  return normalized;
}

interface TenantNotificationPreferencesRecord {
  tenantId: string;
  currentPreferences?: Record<string, any>;
  update: (payload: {
    notificationPreferences: Record<NotificationPreferenceKey, boolean>;
    updatedAt: string;
  }) => Promise<void>;
}

async function loadTenantNotificationPreferencesRecord(
  tenantId: string
): Promise<TenantNotificationPreferencesRecord | null> {
  ensureFirebase();
  const db = admin.firestore();
  const docRef = db.collection('tenants').doc(tenantId);
  const snap = await docRef.get();
  if (!snap.exists) {
    return null;
  }
  const data = snap.data() || {};
  return {
    tenantId,
    currentPreferences: (data.notificationPreferences as Record<string, any> | undefined) || undefined,
    update: (payload) => docRef.update(stripUndefinedDeep(payload)).then(() => undefined),
  };
}

/* c8 ignore start */
async function loadTenantJoinRequestFromFirestore(requestId: string): Promise<TenantJoinRequestRecord | null> {
  if (!requestId || typeof requestId !== 'string') {
    return null;
  }
  ensureFirebase();
  const db = admin.firestore();
  const snap = await db.collection('tenantJoinRequests').doc(requestId).get();
  if (!snap.exists) {
    return null;
  }
  const data = snap.data() || {};
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId.trim() : '';
  if (!tenantId) {
    return null;
  }
  return {
    id: snap.id,
    tenantId,
    tenantName: typeof data.tenantName === 'string' ? data.tenantName : undefined,
    userId: typeof data.userId === 'string' ? data.userId : undefined,
    email: typeof data.email === 'string' ? data.email : undefined,
    displayName: typeof data.displayName === 'string' ? data.displayName : undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
  };
}

async function loadTenantInviteFromFirestore(inviteId: string): Promise<TenantInviteRecord | null> {
  if (!inviteId || typeof inviteId !== 'string') {
    return null;
  }
  ensureFirebase();
  const db = admin.firestore();
  const snap = await db.collection('tenantInvites').doc(inviteId).get();
  if (!snap.exists) {
    return null;
  }
  const data = snap.data() || {};
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId.trim() : '';
  const email = typeof data.email === 'string' ? data.email.trim() : '';
  if (!tenantId || !email) {
    return null;
  }
  return {
    id: snap.id,
    tenantId,
    tenantName: typeof data.tenantName === 'string' ? data.tenantName : undefined,
    email,
    role: typeof data.role === 'string' ? data.role : undefined,
    token: typeof data.token === 'string' ? data.token : undefined,
    expiresAt: toIsoTimestamp(data.expiresAt) ?? undefined,
    invitationMessage: typeof data.invitationMessage === 'string' ? data.invitationMessage : undefined,
  };
}

/* c8 ignore stop */

async function executeExpoPushProxyRequestDefault(options: {
  payload: unknown;
  endpoint: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<ExpoPushProxyExecutorResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(options.timeoutMs, 1000));
  try {
    const expoRes = await options.fetchImpl(options.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.payload),
      signal: controller.signal,
    });
    const rawBody = await expoRes.text();
    let parsedBody: any = {};
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = { raw: rawBody };
      }
    }
    return { status: expoRes.status, ok: expoRes.ok, body: parsedBody, rawBody };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordTenantInviteSendMetadata(inviteId: string, actorId?: string): Promise<void> {
  if (!inviteId) {
    return;
  }
  ensureFirebase();
  const db = admin.firestore();
  await db
    .collection('tenantInvites')
    .doc(inviteId)
    .update({
      lastSentAt: new Date().toISOString(),
      lastSentBy: actorId || 'system',
    });
}

function membershipDocId(tenantId: string, userId: string): string {
  return `${tenantId}_${userId}`;
}

export class TenantAccessError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(body?.error ? String(body.error) : 'tenant_access_denied');
    this.status = status;
    this.body = body;
  }
}

class TenantSeatLimitError extends Error {
  limit: number | null;

  constructor(limit: number | null) {
    super('tenant_seat_limit_reached');
    this.limit = limit;
  }
}

class TenantReminderLimitError extends Error {
  limit: number;
  used: number;
  channel?: string;

  constructor(limit: number, used: number, channel?: string) {
    super('tenant_reminder_limit_reached');
    this.limit = limit;
    this.used = used;
    this.channel = channel;
  }
}

class TenantReminderBatchLimitError extends Error {
  limit: number;
  used: number;
  requested: number;
  channel: string;

  constructor(limit: number, used: number, requested: number, channel: string) {
    super('tenant_reminder_limit_reached');
    this.limit = limit;
    this.used = used;
    this.requested = requested;
    this.channel = channel;
  }
}

class TenantStudentLimitError extends Error {
  limit: number;
  used: number;

  constructor(limit: number, used: number) {
    super('tenant_student_limit_reached');
    this.limit = limit;
    this.used = used;
  }
}

/**
 * Thrown by `reserveTenantStorageBytes` when the tenant's allowance cannot
 * accommodate an increment. Exported so a test can drive `reserveUploadQuotaBytes`
 * with the same value the real reservation transaction rejects with, rather than an
 * approximation of it.
 */
export class TenantStorageLimitError extends Error {
  limitBytes: number;
  usedBytes: number;
  incrementBytes: number;

  constructor(limitBytes: number, usedBytes: number, incrementBytes: number) {
    super('tenant_storage_limit_reached');
    this.name = 'TenantStorageLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.limitBytes = limitBytes;
    this.usedBytes = usedBytes;
    this.incrementBytes = incrementBytes;
  }
}

type TenantStorageLimitErrorLike = {
  limitBytes: number;
  usedBytes: number;
  incrementBytes: number;
};

function tryExtractTenantStorageLimitError(input: unknown): TenantStorageLimitErrorLike | null {
  const parseFromText = (text: string): TenantStorageLimitErrorLike | null => {
    const raw = String(text || '');
    if (!raw) return null;

    const message = raw.toLowerCase();
    const hasStorageMarker =
      message.includes('tenant_storage_limit_reached') ||
      message.includes('tenantstoragelimiterror');

    const limitMatch = raw.match(/limitBytes["']?\s*[:=]\s*([0-9]+)/i);
    const usedMatch = raw.match(/usedBytes["']?\s*[:=]\s*([0-9]+)/i);
    const incrementMatch = raw.match(/incrementBytes["']?\s*[:=]\s*([0-9]+)/i);

    if (!limitMatch || !usedMatch || !incrementMatch) {
      return null;
    }

    const limitBytes = Number(limitMatch[1]);
    const usedBytes = Number(usedMatch[1]);
    const incrementBytes = Number(incrementMatch[1]);

    if (!Number.isFinite(limitBytes) || !Number.isFinite(usedBytes) || !Number.isFinite(incrementBytes)) {
      return null;
    }

    const deterministicOverLimit = limitBytes > 0 && usedBytes + incrementBytes > limitBytes;
    if (!hasStorageMarker && !deterministicOverLimit) {
      return null;
    }

    return { limitBytes, usedBytes, incrementBytes };
  };

  const parseCandidate = (candidate: unknown): TenantStorageLimitErrorLike | null => {
    if (!candidate) return null;

    if (typeof candidate === 'string') {
      return parseFromText(candidate);
    }

    if (typeof candidate !== 'object') {
      return null;
    }

    const asAny = candidate as any;
    const message = String(asAny?.message || '').toLowerCase();
    const name = String(asAny?.name || '').toLowerCase();
    const code = String(asAny?.code || '').toLowerCase();
    const errorCode = String(asAny?.error || '').toLowerCase();

    const looksLikeStorageLimitError =
      message.includes('tenant_storage_limit_reached') ||
      name.includes('tenantstoragelimiterror') ||
      code.includes('tenant_storage_limit_reached') ||
      errorCode.includes('tenant_storage_limit_reached');

    const limitBytes = Number(asAny?.limitBytes);
    const usedBytes = Number(asAny?.usedBytes);
    const incrementBytes = Number(asAny?.incrementBytes);

    if (!Number.isFinite(limitBytes) || !Number.isFinite(usedBytes) || !Number.isFinite(incrementBytes)) {
      return null;
    }

    const deterministicOverLimit = limitBytes > 0 && usedBytes + incrementBytes > limitBytes;
    if (!looksLikeStorageLimitError && !deterministicOverLimit) {
      // Some Firestore transaction errors flatten details into message/stack strings.
      const textParsed = parseFromText(`${String(asAny?.message || '')}\n${String(asAny?.stack || '')}`);
      if (textParsed) {
        return textParsed;
      }
      return null;
    }

    return { limitBytes, usedBytes, incrementBytes };
  };

  if (!input) return null;

  if (typeof input === 'string') {
    const directFromText = parseFromText(input);
    if (directFromText) {
      return directFromText;
    }
  }

  const queue: unknown[] = [input];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const parsed = parseCandidate(current);
    if (parsed) {
      return parsed;
    }

    if (typeof current !== 'object') {
      continue;
    }

    const asAny = current as any;
    const nestedCandidates: unknown[] = [
      asAny?.cause,
      asAny?.originalError,
      asAny?.innerError,
      asAny?.details,
      asAny?.reason,
      asAny?.metadata,
      asAny?.error,
    ];

    for (const nested of nestedCandidates) {
      if (nested && !seen.has(nested)) {
        queue.push(nested);
      }
    }

    if (Array.isArray(asAny?.errors)) {
      for (const nested of asAny.errors) {
        if (nested && !seen.has(nested)) {
          queue.push(nested);
        }
      }
    }
  }

  return null;
}

// `StorageUploadPurpose`, `sanitizeStorageSegment`, `inferExtensionFromContentType`,
// `hashStorageKey`, `normalizeConversationFolder`, `resolveUploadObjectPath` and
// `computeUploadQuotaDelta` all live in `./lib/uploadObjectPath` (pure,
// unit-tested) — see the import near the top of this file. There is exactly one
// implementation of each; `POST /storage/upload` calls `resolveUploadObjectPath`,
// which owns every per-purpose path format.

/**
 * Query-parameter schema for `POST /storage/upload`.
 *
 * Lifted out of the route handler to module scope (upload-idempotency spec, task
 * 4.6) so the accept/reject boundary of `uploadKey` is testable against the REAL
 * schema the endpoint parses with. A test that re-declared this shape would prove
 * nothing about the endpoint.
 *
 * A failure here is what produces the route's `400 { error: 'validation_failed',
 * issues }` response, so an out-of-bounds `uploadKey` is a hard rejection and
 * never a silent downgrade to a legacy timestamped path (Req 2.8, 6.8).
 */
export const storageUploadQuerySchema = z.object({
  tenantId: z.string().min(1),
  purpose: z.enum(['chat', 'tenantLogo', 'noticeImage', 'noticeAudio', 'studentProfile', 'receipt', 'profilePicture']),
  conversationFolder: z.string().optional(),
  feeId: z.string().optional(),
  email: z.string().optional(),
  filename: z.string().optional(),
  // upload-idempotency spec (background-transport gap): the human-visible name
  // for this upload, split OUT of `filename`.
  //
  // `filename` used to do two unrelated jobs — it seeded the `safeName` segment
  // of the object path AND it became the display name of the server-created chat
  // message (the sticker's `name`, the attachment's `fileName`) plus the
  // `sharedFiles` doc's `file.fileName`. Those two jobs pull in opposite
  // directions: the path wants a value that is DETERMINISTIC across every retry
  // of one logical action, the display wants the REAL name the user picked. With
  // one parameter, making the native background transport's path deterministic
  // would have renamed what the recipient sees.
  //
  // So: `filename` now drives the object path only, and `displayName` (when
  // present) drives every user-visible name. Absent ⇒ every consumer falls back
  // to `filename`, i.e. behavior is byte-identical to before this parameter
  // existed, which is what makes this safe for already-deployed clients.
  //
  // Bound: 255 characters, the single-path-component limit on every filesystem
  // this app's clients run on (ext4 / APFS / NTFS all cap a path component at
  // 255), so no real OS-supplied filename can exceed it — while still bounding
  // what a caller can write into a chat message doc and a `sharedFiles` doc.
  // Deliberately NO `.min()`: a blank/whitespace-only value must degrade to the
  // `filename` fallback exactly as an absent one does, not 400.
  displayName: z.string().trim().max(255).optional(),
  // Phase 2 (kill-safe background uploads): when createMessage === '1' and
  // purpose === 'chat', the endpoint ALSO creates the chat message after
  // storing the file, so the message exists even if the app is killed before
  // the (background) upload completes. Idempotent via clientMsgId. Absent on
  // the normal foreground upload path, so existing callers are unaffected.
  createMessage: z.string().optional(),
  clientMsgId: z.string().trim().min(1).max(200).optional(),
  recipientId: z.string().trim().min(1).max(320).optional(),
  mediaKind: z.enum(['sticker', 'gif', 'attachment']).optional(),
  messageText: z.string().max(5000).optional(),
  // upload-idempotency spec (task 4.2): optional, opaque, UNTRUSTED
  // idempotency key that a client keeps stable across every retry of one
  // logical upload action. Length-bounded here so an under/over-length
  // value falls out of the existing `400 validation_failed` branch in the
  // route (Req 2.8, 6.8). Never logged, never used as a metric label, never
  // interpolated into an object path — only the 20-hex hash
  // `deriveUploadKeyHash` derives from it can reach a path (Req 6.3, 6.4).
  //
  // `.trim()` runs BEFORE the length checks, so padding cannot buy a key its
  // way past the minimum and the value the route hashes is the trimmed one.
  uploadKey: z.string().trim().min(8).max(200).optional(),
});

/**
 * An object already stored at a deterministic upload path, as seen by
 * `probeExistingUploadObject`. Every field is normalized: `bytes` is always a
 * finite non-negative number, and `downloadToken` / `generation` are always either
 * a non-empty string or `null`, whatever shape the raw Storage metadata arrived in.
 */
export interface ExistingUploadObject {
  bytes: number;
  /** First value of `metadata.firebaseStorageDownloadTokens`, if any. */
  downloadToken: string | null;
  /**
   * The object's Storage `generation` as a DECIMAL STRING, or `null` when the read
   * carried none in a usable shape (upload-idempotency follow-up F9).
   *
   * Kept as a string on purpose: a GCS generation is an int64 and is serialized as
   * a string precisely because it does not fit a JS `number` — coercing it would
   * silently round, and a rounded generation sent as `ifGenerationMatch` would
   * either never match (breaking every conditional write) or, far worse, match a
   * DIFFERENT object version. It is only ever compared and echoed, never
   * arithmetic, so a string is the right carrier.
   */
  generation: string | null;
}

/**
 * Read the HTTP-ish status codes a Storage rejection can carry, from each of the
 * four places the SDK is known to put one. Reads are individually guarded because
 * the value can be anything a rejected promise can carry — including an object
 * whose property access itself throws.
 *
 * Shared by `isStorageObjectNotFound` and `isStoragePreconditionFailed` so the two
 * classifiers can never drift in WHERE they look; they differ only in the status
 * they look for.
 */
function readStorageErrorStatusCodes(error: unknown): (number | null)[] {
  const readNumeric = (read: () => unknown): number | null => {
    try {
      const raw = read();
      if (typeof raw === 'number') return raw;
      if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    } catch {
      return null;
    }
  };

  const candidate = error as any;
  return [
    readNumeric(() => candidate?.code),
    readNumeric(() => candidate?.statusCode),
    readNumeric(() => candidate?.status),
    readNumeric(() => candidate?.response?.status),
  ];
}

/** Is this rejection Storage's "object does not exist"? */
function isStorageObjectNotFound(error: unknown): boolean {
  return readStorageErrorStatusCodes(error).some((value) => value === 404);
}

/**
 * Is this rejection Storage's "your write precondition did not hold"?
 * (upload-idempotency follow-up F9.)
 *
 * `412 Precondition Failed` is what a conditional `file.save()` gets back when the
 * object's generation is not what `ifGenerationMatch` claimed — i.e. when a
 * concurrent sibling attempt of the SAME logical upload action wrote first.
 *
 * THIS IS THE HIGHEST-RISK CLASSIFIER ON THE UPLOAD PATH. A 412 that is not
 * recognized here becomes a `500 upload_failed` for a request whose file is, in
 * fact, correctly stored — turning a quota-counter improvement into an availability
 * regression. So it mirrors `isStorageObjectNotFound` exactly: the same four
 * locations, the same per-property guarding, and total for every rejection value
 * (a string, a number, `null`, an object with a throwing getter). Anything it
 * cannot read is simply "not a 412", which falls through to the pre-existing
 * `500` path — the same outcome as before preconditions existed.
 */
export function isStoragePreconditionFailed(error: unknown): boolean {
  return readStorageErrorStatusCodes(error).some((value) => value === 412);
}

/** Normalize a raw Storage `size` (absent, string, negative, NaN…) to bytes. */
function normalizeProbedObjectBytes(raw: unknown): number {
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : typeof raw === 'bigint'
          ? Number(raw)
          : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

/**
 * `firebaseStorageDownloadTokens` can hold several comma-joined tokens; the URL
 * Firebase serves resolves with any of them, and the first is the one this
 * endpoint wrote. Anything that is not a non-empty string yields `null`.
 */
function extractFirstDownloadToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0]?.trim() ?? '';
  return first.length > 0 ? first : null;
}

/**
 * A real GCS generation, or `null` (upload-idempotency follow-up F9).
 *
 * Normalized in the same defensive style as `normalizeProbedObjectBytes` /
 * `extractFirstDownloadToken`, because this value is fed straight back to Storage as
 * `ifGenerationMatch` and a wrong value there is not a no-op:
 *
 * - Kept as a DECIMAL STRING. A generation is an int64 (`1712345678901234567`),
 *   which is why the API serializes it as a string; `Number()` would round it and
 *   the precondition would then reference a version that never existed.
 * - `0` and anything with a leading zero are rejected. `ifGenerationMatch: 0` is
 *   Storage's "the object must NOT exist" — the exact OPPOSITE of "match the object
 *   I probed" — so letting a bogus `0` through would turn an intended overwrite
 *   into a create-only write that always 412s.
 * - More than 20 digits cannot be an int64, so it is treated as unparseable.
 *
 * Anything unusable yields `null`, and the caller then sends NO precondition, i.e.
 * today's last-writer-wins behavior. Degrade, never fail.
 */
function normalizeProbedObjectGeneration(raw: unknown): string | null {
  const text =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number'
        ? Number.isSafeInteger(raw) && raw > 0
          ? String(raw)
          : ''
        : typeof raw === 'bigint'
          ? raw > 0n
            ? raw.toString()
            : ''
          : '';
  return /^[1-9][0-9]{0,19}$/.test(text) ? text : null;
}

/**
 * What a probe of a deterministic upload path learned (upload-idempotency follow-up
 * F10).
 *
 * THE BUG THIS SHAPE FIXES. `probeExistingUploadObject` reports absence and failure
 * with the same value (`null`), so the write-precondition resolver could not tell
 * "the object is genuinely not there" from "I could not read the object state". It
 * mapped both to `ifGenerationMatch: 0` — an assertion about state the request never
 * observed — and a degraded probe against an object that DOES exist then 412'd, was
 * reported as a lost race, and the caller's bytes were silently dropped while the
 * response carried the pre-existing object's url. Req 9.13 forbids exactly that:
 * where the observed state cannot be read, send NO condition and complete the upload.
 *
 * Shape rationale: a discriminated union whose `object` field is present on EVERY
 * member. `state` adds the one genuinely new fact, while `object` keeps its old type
 * (`ExistingUploadObject | null`) and stays readable without narrowing — so every
 * downstream consumer (quota delta, token reuse, share-doc reuse, the overwrite
 * metric) is byte-identical for all three states and the new state cannot leak into
 * them. `{ object, stateKnown }` would have carried the same two bits, but it makes
 * "absent" and "unreadable" a derived combination rather than a named case, and it
 * cannot express "found ⇒ object is non-null" in the type.
 */
export type UploadObjectProbeResult =
  /** The metadata read succeeded and an object is stored at the path. */
  | { state: 'found'; object: ExistingUploadObject }
  /** The metadata read said 404: the path is genuinely empty. */
  | { state: 'absent'; object: null }
  /**
   * The object state could NOT be read — a non-404 read failure, or metadata whose
   * normalization itself threw. Nothing is known, so nothing may be asserted about
   * it in a write precondition (Req 9.13).
   */
  | { state: 'unreadable'; object: null };

/**
 * The probe result for a path that was never probed — an unkeyed legacy or
 * `profilePicture` path (Req 9.7: no probe runs there at all).
 *
 * `absent` rather than a fourth state on purpose: those paths are timestamped or
 * randomized, so nothing is expected to be there, and `resolveUploadSavePrecondition`
 * short-circuits on `keyed: false` before it ever reads `state`. Adding a
 * `not_probed` member would put a case in the union that no branch can act on.
 */
export const UPLOAD_OBJECT_PROBE_SKIPPED: UploadObjectProbeResult = Object.freeze({
  state: 'absent',
  object: null,
} as const);

/**
 * Read the object currently stored at a deterministic upload path
 * (upload-idempotency spec, task 4.1; three-state result added in follow-up F10).
 *
 * Reports `absent` when the object does not exist (404) and `unreadable` when the
 * metadata read fails for any other reason. Both carry `object: null`, so a failed
 * probe still degrades to "treat as a new object" for quota purposes, which
 * over-reserves at worst and can never under-count (Req 9.2, 9.4). The difference is
 * consumed by exactly one caller — `resolveUploadSavePrecondition` — which must not
 * assert a condition on state this request never observed (Req 9.13).
 *
 * TOTALITY (design Property 13): this runs on every opted-in upload, so an escaped
 * exception would turn a would-be-successful upload into a `500`. The promise
 * therefore always resolves — never rejects — for any rejection value and any
 * malformed metadata shape. Read-only: it calls `getMetadata()` and nothing else,
 * so it never writes and never mutates the probed object (Req 9.3).
 *
 * Also called a SECOND time, by `saveUploadObjectWithPrecondition`, after a `412`
 * (upload-idempotency follow-up F9): the totality contract is what lets that
 * recovery treat a re-probe as "found / not found" without a third failure mode.
 * That re-probe deliberately does NOT consume `state` — "absent" and "unreadable"
 * both correctly lead to the one unconditioned fallback write with the reservation
 * kept, so it keeps using the `ExistingUploadObject | null` adapter below.
 *
 * The raw `uploadKey` is deliberately not a parameter, so it cannot reach a log
 * line from here (Req 6.4); the warning below carries no client-supplied value —
 * not even `objectPath`, whose trailing segment embeds a caller-supplied filename.
 *
 * `purpose` is a parameter solely so the probe-failure counter can carry it as its
 * only label (Req 8.2). It is a closed seven-member union, so it is the one piece
 * of request context here with bounded cardinality and no leak surface — which is
 * exactly why it is the only label allowed (Req 6.4, 8.4).
 *
 * Only called for a deterministic path, so a caller that sends no `uploadKey`
 * adds zero Storage round trips (Req 2.5, 9.7).
 */
export async function probeUploadObjectState(
  bucket: ReturnType<admin.storage.Storage['bucket']>,
  objectPath: string,
  purpose: StorageUploadPurpose
): Promise<UploadObjectProbeResult> {
  try {
    let metadata: any;
    try {
      const result: unknown = await bucket.file(objectPath).getMetadata();
      // The Admin SDK resolves `[metadata, apiResponse]`; tolerate a bare object.
      metadata = Array.isArray(result) ? result[0] : result;
    } catch (error) {
      if (isStorageObjectNotFound(error)) {
        return { state: 'absent', object: null };
      }
      // Non-404: warn, count, and degrade to "no existing object" (Req 9.2).
      try {
        console.warn(
          '[storage_upload] existing-object probe failed; treating upload as a new object',
          error instanceof Error ? error.message : typeof error
        );
      } catch {
        // Even logging must not break the upload.
      }
      // Probe-failure counter (task 6.2, Req 8.2): exactly one increment per
      // non-404 failure, and none for a 404 or a successful read — the two branches
      // above and below this one both return without passing through here.
      //
      // Labelled by `purpose` ONLY. The raw `uploadKey`, its hash, the filename and
      // `objectPath` are all either unbounded-cardinality label values or a leak
      // surface, so none of them may become a label (Req 6.4, 8.4).
      //
      // Inside the failure-safety envelope on purpose: this whole function is
      // documented as total (design Property 13) because an escaped exception would
      // turn a would-be-successful upload into a 500. A metrics write is a plain
      // in-memory map update, but it is not worth betting the upload path on that,
      // so it gets the same treatment as the warning above.
      try {
        inc(metricNames.storageUploadOverwriteProbeFailed, { purpose });
      } catch {
        // Metrics are never worth failing an upload for.
      }
      return { state: 'unreadable', object: null };
    }

    return {
      state: 'found',
      object: {
        bytes: normalizeProbedObjectBytes(metadata?.size),
        downloadToken: extractFirstDownloadToken(metadata?.metadata?.firebaseStorageDownloadTokens),
        // Top-level `generation`, NOT `metadata.metadata.*`: it is object state Storage
        // maintains, not custom metadata (upload-idempotency follow-up F9).
        generation: normalizeProbedObjectGeneration(metadata?.generation),
      },
    };
  } catch {
    // Backstop: normalization reading a hostile metadata shape must not escape
    // either. The read itself may well have succeeded, but nothing usable came out
    // of it, so the state is UNKNOWN — the same conclusion as a failed read, and the
    // same consequence: no write condition may be asserted (Req 9.13). Deliberately
    // NOT counted by the probe-failure counter, which stays "exactly one increment
    // per non-404 read failure, zero for a 404 or a successful read" (Req 8.2).
    return { state: 'unreadable', object: null };
  }
}

/**
 * `probeUploadObjectState` reduced to the object it found, or `null`.
 *
 * Retained as the shape the `412` re-probe and every existing caller use: that
 * recovery treats "absent" and "unreadable" identically — both lead to one
 * unconditioned fallback write with the reservation kept — so widening it to the
 * three-state result would add a distinction it has no branch for.
 *
 * Total for the same reason its delegate is: it only reads a field off a value
 * `probeUploadObjectState` always resolves with.
 */
export async function probeExistingUploadObject(
  bucket: ReturnType<admin.storage.Storage['bucket']>,
  objectPath: string,
  purpose: StorageUploadPurpose
): Promise<ExistingUploadObject | null> {
  return (await probeUploadObjectState(bucket, objectPath, purpose)).object;
}

/**
 * Mint a fresh Firebase download token. This is the generator `POST
 * /storage/upload` has always used, factored out unchanged so the fresh branch of
 * `selectUploadDownloadToken` and the legacy (no `uploadKey`) path keep producing
 * exactly the same shape of value as today.
 */
function mintUploadDownloadToken(): string {
  return typeof (crypto as any).randomUUID === 'function'
    ? (crypto as any).randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

/**
 * Choose the download token for an upload write (upload-idempotency spec, task
 * 4.4, Req 4.1–4.4).
 *
 * The token is a capability: the returned `url` embeds it, so a retry that
 * rotated it would hand back a DIFFERENT url and silently break whatever the lost
 * first response's url was already persisted against (a fee's `receiptUrl`, a
 * notice image, a chat bubble). Reusing the token the probe read off the stored
 * object is what makes the retry's url byte-identical (Req 4.2).
 *
 * - Probe found an object carrying a non-blank token ⇒ reuse it (Req 4.1).
 * - Probe returned `null` (legacy path, 404, or a degraded probe), or the stored
 *   object carries no usable token ⇒ mint a fresh one (Req 4.3). A caller that
 *   sends no `uploadKey` never probes, so `existing` is always `null` there and
 *   this is byte-for-byte today's behavior (Req 2.4).
 *
 * The value is always read from the STORED OBJECT's metadata and is never derived
 * from `uploadKey` or any other client-supplied input (Req 4.4), so a client
 * cannot steer a capability token.
 *
 * `probeExistingUploadObject` already reduced a comma-joined
 * `firebaseStorageDownloadTokens` list to its first entry, which is the one this
 * endpoint wrote; no further splitting happens here, so whatever normalization the
 * probe applied is the single source of truth for the token's shape.
 *
 * Total by construction: every input shape (including a hand-built object with a
 * non-string `downloadToken`) falls through to a freshly minted token rather than
 * throwing — this runs on the critical path of every upload.
 */
export function selectUploadDownloadToken(existing: ExistingUploadObject | null): string {
  return resolveUploadDownloadToken(existing).token;
}

/**
 * The token an upload write will carry, together with WHERE it came from
 * (upload-idempotency follow-up F10).
 *
 * `reused` is `true` only when `token` was read off the probed object rather than
 * freshly minted. `saveUploadObjectWithPrecondition` needs exactly that fact to
 * attribute a `412`: a fresh UUID found stored can only be this request's own write,
 * whereas a reused token is what BOTH racers wrote, so attribution is undecidable.
 */
export interface UploadDownloadTokenDecision {
  token: string;
  reused: boolean;
}

/**
 * Choose the download token AND report whether it was reused (upload-idempotency
 * follow-up F10). `selectUploadDownloadToken` is a thin projection of this.
 *
 * WHY THIS EXISTS. The route used to re-derive the reuse flag by raw string
 * comparison — `(existing?.downloadToken ?? null) === attemptedDownloadToken` — which
 * only agreed with this function because both sides happened to trim identically.
 * That is a silent coupling between two normalizations: if either side's trimming
 * ever diverged, the flag would flip to `false`, a lost race would be mis-attributed
 * as `outcome: 'written'`, and the route would then perform the shrink release the
 * winner already performed — a double credit, i.e. the UNDER-count Req 9.4 forbids.
 * The reuse decision is made here, once, and handed to the caller as data.
 */
export function resolveUploadDownloadToken(existing: ExistingUploadObject | null): UploadDownloadTokenDecision {
  const reusable = typeof existing?.downloadToken === 'string' ? existing.downloadToken.trim() : '';
  return reusable.length > 0 ? { token: reusable, reused: true } : { token: mintUploadDownloadToken(), reused: false };
}

/**
 * Build the download URL the upload response returns. Extracted verbatim from the
 * route so the token-selection seam and the url it feeds are testable together
 * (design Property 12): url stability across retries is a property of the token
 * AND the path, and only this function combines them.
 */
export function buildUploadDownloadUrl(bucketName: string, objectPath: string, downloadToken: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`;
}

/**
 * The write precondition a conditional upload sends to Storage
 * (`SaveOptions.preconditionOpts`, @google-cloud/storage 7.x).
 *
 * `ifGenerationMatch: 0` is Storage's "only if no live object exists"; a decimal
 * generation string is "only if the live object is exactly this version".
 */
export type UploadSavePrecondition = { ifGenerationMatch: string | number };

export type UploadSavePreconditionReason =
  /** Probe read a genuine 404 ⇒ create-only, so a concurrent creator is detected. */
  | 'create_if_absent'
  /** Probe found an object with a usable generation ⇒ overwrite exactly that one. */
  | 'match_probed_generation'
  /** Deterministic path, but the probe carried no usable generation ⇒ degrade. */
  | 'generation_unavailable'
  /**
   * The probe could not read the object state at all (F10) ⇒ degrade. Asserting
   * anything here would condition the write on state the request never observed,
   * which Req 9.13 forbids.
   */
  | 'probe_unreadable'
  /** Legacy timestamped/random path: byte-for-byte unchanged, never conditioned. */
  | 'unkeyed_path';

export interface UploadSavePreconditionDecision {
  precondition: UploadSavePrecondition | null;
  reason: UploadSavePreconditionReason;
}

/**
 * Decide the write precondition for an upload (upload-idempotency follow-up F9,
 * Req 9.5, 9.12, 9.13).
 *
 * WHAT THIS FIXES. Two attempts of one logical action can be in flight at once —
 * most plausibly the native background uploader's internal retry firing while the
 * first attempt is still connected. Both probe before either writes, so both see no
 * existing object and both reserve the FULL file size, and recorded usage is
 * over-counted by one file size per racing pair until a reconcile. A generation
 * precondition turns "was I first?" into an atomic, lock-free, STATELESS question
 * that Storage itself answers, so the loser can release its reservation instead.
 *
 * WHY NOT A LEASE. A Firestore lease keyed on the key hash was rejected on purpose
 * and must not be reintroduced: a stale lease (holder crashed, expiry not yet
 * reached) blocks a legitimate retry, i.e. it breaks the exact flow this feature
 * exists to enable. A precondition has no such failure mode — there is nothing to
 * hold, nothing to expire and nothing to clean up.
 *
 * The branches:
 *
 * - `state: 'absent'` (a genuine 404) ⇒ `ifGenerationMatch: 0`. Create-only. A
 *   sibling that got there first turns this into a `412` instead of a silent second
 *   full write. This is the branch that closes the concurrency bug, and it applies
 *   ONLY to an observed 404 — never to a probe that failed.
 * - `state: 'found'` with a generation ⇒ `ifGenerationMatch: <generation>`. Overwrite
 *   exactly the version that was probed, so the quota delta computed from that
 *   version's byte count is the delta actually applied.
 * - `state: 'found'` without a usable generation ⇒ NO precondition, i.e. today's
 *   last-writer-wins. Degrade, never fail: a metadata shape we cannot read must not
 *   cost the user their upload.
 * - `state: 'unreadable'` ⇒ NO precondition (F10, Req 9.13). The request never
 *   observed the object state, so it may not assert one. Sending
 *   `ifGenerationMatch: 0` here was a real regression, not a performance nit: on an
 *   object that DOES exist it 412s, the recovery re-probe then finds the existing
 *   object, the `412` is attributed to a sibling, and the caller's bytes are silently
 *   dropped while the response hands back the pre-existing object's url. Before
 *   conditional writes existed this same request wrote its bytes correctly and merely
 *   over-counted usage until the next reconcile — which is precisely the degradation
 *   Req 9.2/9.4/9.13 ask for.
 *
 * `keyed` is `uploadKeyHash !== null`, and it is the gate rather than
 * `resolved.deterministic` for a substantive reason, not tidiness. The whole "a lost
 * race is a SUCCESS" semantics rests on the racers being attempts of ONE logical
 * action, which is exactly what a key hash certifies (it binds tenant + purpose +
 * actor + the client's stable key). `profilePicture` WITHOUT an `uploadKey` also
 * resolves a deterministic path, but two concurrent writes there may be two
 * genuinely different avatar picks; handing the second one the first one's URL and
 * dropping its bytes would be wrong. That path therefore keeps today's
 * last-writer-wins. Legacy timestamped/random paths are likewise never conditioned:
 * a collision there would be two UNRELATED uploads, so "return the winner's URL"
 * would hand back a different file.
 */
export function resolveUploadSavePrecondition(args: {
  /** `true` when the resolved path carries an upload-key hash. */
  keyed: boolean;
  /**
   * The probe result, NOT a bare `ExistingUploadObject | null` (F10). Taking the
   * union means "absent" and "unreadable" cannot arrive here as the same value, and
   * the contradictory pair "unreadable, but here is the object" is unrepresentable.
   * For an unkeyed path — where no probe runs — the route passes
   * `UPLOAD_OBJECT_PROBE_SKIPPED` and the `keyed` short-circuit below decides first.
   */
  probe: UploadObjectProbeResult;
}): UploadSavePreconditionDecision {
  if (!args.keyed) {
    return { precondition: null, reason: 'unkeyed_path' };
  }
  if (args.probe.state === 'unreadable') {
    return { precondition: null, reason: 'probe_unreadable' };
  }
  if (args.probe.state === 'absent') {
    return { precondition: { ifGenerationMatch: 0 }, reason: 'create_if_absent' };
  }
  const generation = normalizeProbedObjectGeneration(args.probe.object.generation);
  if (!generation) {
    return { precondition: null, reason: 'generation_unavailable' };
  }
  return { precondition: { ifGenerationMatch: generation }, reason: 'match_probed_generation' };
}

export type UploadObjectWriteResult =
  /**
   * This request's bytes are stored at the path, so it keeps its reservation.
   * `unconditioned` is true when the write that landed carried no precondition —
   * either because none was sent to begin with, or because a `412` was followed by
   * the object vanishing and the fallback write ran.
   */
  | { outcome: 'written'; unconditioned: boolean }
  /**
   * A sibling attempt of the same logical action won; this request wrote nothing.
   *
   * `downloadToken` is the WINNER's, so the URL the caller builds is byte-identical
   * to the one the winning request returned (Req 4.1, 4.2) — which is the whole
   * point: a URL already persisted against a fee, notice or message keeps
   * resolving.
   *
   * `releaseReservation` is false only when attribution is ambiguous (see below), in
   * which case holding the bytes over-counts rather than under-counts (Req 9.4).
   */
  | { outcome: 'lost_race'; downloadToken: string; releaseReservation: boolean };

export interface SaveUploadObjectWithPreconditionArgs {
  /** From `resolveUploadSavePrecondition`; `null` means "write as today". */
  precondition: UploadSavePrecondition | null;
  /** The download token this request put in the object's metadata. */
  attemptedDownloadToken: string;
  /**
   * Whether `attemptedDownloadToken` was REUSED from the probe rather than freshly
   * minted. This is what makes write attribution decidable — see below.
   */
  reusedProbedToken: boolean;
  /** Perform the write. The route wires this to `bucket.file(path).save(...)`. */
  save: (precondition: UploadSavePrecondition | null) => Promise<void>;
  /** Re-read the path. The route wires this to `probeExistingUploadObject`. */
  reprobe: () => Promise<ExistingUploadObject | null>;
}

/**
 * Write the object, and turn a lost precondition race into a SUCCESS
 * (upload-idempotency follow-up F9, Req 4.1, 4.2, 9.4, 9.5, 9.9–9.13).
 *
 * A `412` means a sibling attempt of the same logical action wrote first. That is
 * not an error — the file the user asked to store IS stored, byte-for-byte, because
 * the sibling is the same logical action. It MUST NEVER reach the client as a `4xx`
 * or `5xx`: an inflated usage counter is a reporting blemish, while a failed upload
 * is a broken feature. Guarding that is this function's entire job.
 *
 * The order below is not negotiable:
 *
 * 1. RE-PROBE first. Probing before releasing means bytes that are still ours are
 *    never released, and bytes we do not hold are never written. Reversing the two
 *    introduces an under-count.
 * 2. Object found with a usable token ⇒ the sibling won. The caller releases its
 *    reservation and returns the WINNER's URL. If instead the stored object carries
 *    the token this request minted, the winner is *this* request: a fresh UUID
 *    cannot have been written by anyone else, so the storage client's own retry
 *    landed after a lost acknowledgement, and the reservation must be KEPT
 *    (`outcome: 'written'`). When the token was reused from the probe, both racers
 *    wrote the same token and attribution is undecidable — reported as a lost race
 *    (the URL is identical either way) but with `releaseReservation: false`, because
 *    an over-count self-heals at the next reconcile and an under-count does not.
 * 3. Object NOT found — it vanished, or the re-probe degraded ⇒ keep the reservation
 *    and retry the write ONCE with NO precondition, i.e. exactly today's behavior.
 *
 * Non-412 save failures propagate untouched, so the route's existing rollback and
 * `500 upload_failed` are reached exactly as before. A `null` precondition
 * short-circuits the classifier entirely, which is what keeps the legacy path
 * byte-for-byte unchanged: one `save()` call, and any error propagates.
 *
 * A re-probe that somehow rejects is treated as "not found" rather than allowed to
 * escape, because escaping would convert the 412 into the `500` this function
 * exists to prevent. (`probeExistingUploadObject` is documented total, so in the
 * route this is unreachable; it is guarded because the seam is injectable.)
 */
export async function saveUploadObjectWithPrecondition(
  args: SaveUploadObjectWithPreconditionArgs
): Promise<UploadObjectWriteResult> {
  try {
    await args.save(args.precondition);
    return { outcome: 'written', unconditioned: args.precondition === null };
  } catch (error) {
    if (args.precondition === null || !isStoragePreconditionFailed(error)) {
      throw error;
    }

    // 1. Re-probe BEFORE any release.
    let winner: ExistingUploadObject | null = null;
    try {
      winner = await args.reprobe();
    } catch {
      winner = null;
    }
    const winnerToken = typeof winner?.downloadToken === 'string' ? winner.downloadToken.trim() : '';

    // 3. Vanished, or the re-probe could not give us a usable URL. Without the
    //    winner's token there is no valid URL to hand back — a freshly minted one
    //    would not authorize against bytes we did not write — so fall back to
    //    today's unconditioned write, still holding the reservation.
    if (!winner || !winnerToken) {
      await args.save(null);
      return { outcome: 'written', unconditioned: true };
    }

    // 2. Someone's bytes are at the path. Whose?
    const carriesOurToken = winnerToken === args.attemptedDownloadToken.trim();
    if (carriesOurToken && !args.reusedProbedToken) {
      // Freshly minted token, and it is what is stored ⇒ our own write landed.
      return { outcome: 'written', unconditioned: false };
    }
    return {
      outcome: 'lost_race',
      downloadToken: winnerToken,
      releaseReservation: !carriesOurToken,
    };
  }
}

/**
 * The purposes whose uploads receive a pre-created `sharedFiles` document. Kept as
 * a set purely so `resolveShareTokenForUpload` owns the filter; the membership is
 * unchanged from the inline `shouldPrecreateShareToken` chain it replaces —
 * `tenantLogo` and `profilePicture` still get no share doc, which keeps the user's
 * shared-files list free of records nobody ever shares.
 */
const UPLOAD_SHARE_TOKEN_PURPOSES: ReadonlySet<StorageUploadPurpose> = new Set<StorageUploadPurpose>([
  'chat',
  'receipt',
  'noticeImage',
  'noticeAudio',
  'studentProfile',
]);

export interface ResolveShareTokenForUploadArgs {
  purpose: StorageUploadPurpose;
  /** Tenant-guard-resolved id, never the query string value (Req 6.6). */
  tenantId: string;
  /** Authenticated actor uid; anything blank means "unknown actor" ⇒ no share doc. */
  actorUid: string | null | undefined;
  /** `quotaDelta.isOverwrite`: true only when the probe found an existing object. */
  isOverwrite: boolean;
  /** The url this write returns, already built from the (possibly reused) token. */
  fileUrl: string;
  /**
   * Latest ACTIVE share token for `(tenantId, uid, fileUrl)`, or `null` when there
   * is none. Only invoked on the overwrite path. The route wires this to
   * `findLatestActiveShareForFile`, which already skips revoked/expired docs via
   * `isActiveSharedFileDoc`, so a stale token can never be handed back.
   */
  findExistingShareToken: (input: { tenantId: string; uid: string; fileUrl: string }) => Promise<string | null>;
  /** Mint a token and persist its `sharedFiles` doc; `null` when unusable. */
  createShareToken: (input: { tenantId: string; uid: string; fileUrl: string }) => Promise<string | null>;
}

/**
 * Decide the `shareToken` a successful upload returns (upload-idempotency spec,
 * task 4.5, Req 5.1–5.3, 5.6).
 *
 * Only the OVERWRITE path changes. Because the download token was reused
 * (`selectUploadDownloadToken`), a retry's `fileUrl` is byte-identical to the one
 * the lost first response returned, so the existing `sharedFiles` doc for
 * `(tenant, actor, url)` is findable and reusable — one logical action leaves at
 * most one active share doc and does not leak a second live capability token
 * (Req 5.1, 5.2). When `isOverwrite` is false — which is every caller that sends
 * no `uploadKey`, since no probe runs for a legacy path — this mints and writes
 * exactly as it does today, with the same per-purpose filter and the same
 * unknown-actor early return (Req 5.3).
 *
 * Best effort in both directions, because the bytes are already stored by the time
 * this runs and failing the request would make the client re-upload an object that
 * is already correct:
 * - A failed REUSE LOOKUP (missing composite index, transient Firestore error)
 *   falls open to minting, matching `/shared-files/resolve-or-create`. At worst
 *   that leaves the extra share doc today's code would have created anyway.
 * - A failed MINT or WRITE resolves to `undefined`, so the response simply omits
 *   `shareToken` and still reports the successful upload (Req 5.6). The client
 *   handles an absent token by calling `ensureSmartShareLink`, which
 *   resolves-or-creates by url.
 *
 * The token is never derived from `uploadKey` or any other client-supplied value:
 * it is either read back from an existing doc or freshly minted (Req 4.4).
 */
export async function resolveShareTokenForUpload(args: ResolveShareTokenForUploadArgs): Promise<string | undefined> {
  if (!UPLOAD_SHARE_TOKEN_PURPOSES.has(args.purpose)) {
    return undefined;
  }
  const uid = typeof args.actorUid === 'string' ? args.actorUid.trim() : '';
  if (!uid) {
    return undefined;
  }

  const lookupInput = { tenantId: args.tenantId, uid, fileUrl: args.fileUrl };

  try {
    if (args.isOverwrite) {
      let reused: string | null = null;
      try {
        reused = await args.findExistingShareToken(lookupInput);
      } catch (error) {
        // Fail OPEN to minting rather than omitting the token: the upload already
        // succeeded, and a missing index must not cost the client its share link.
        console.warn('[storage_upload] share reuse lookup failed; minting a new share token', error);
        reused = null;
      }
      const reusableToken = typeof reused === 'string' ? reused.trim() : '';
      if (reusableToken) {
        return reusableToken;
      }
      // No active doc found (never created, or revoked/expired) ⇒ mint fresh.
    }

    const minted = await args.createShareToken(lookupInput);
    const mintedToken = typeof minted === 'string' ? minted.trim() : '';
    return mintedToken || undefined;
  } catch (error) {
    console.warn('[storage_upload] unable to precreate share token', error);
    return undefined;
  }
}

async function loadOrInitTenantStorageUsage(
  db: admin.firestore.Firestore,
  bucket: ReturnType<admin.storage.Storage['bucket']>,
  tenantId: string
): Promise<number> {
  const usageRef = db.collection('tenantStorageUsage').doc(tenantId);
  const snap = await usageRef.get();
  if (snap.exists) {
    const bytes = (snap.data() as any)?.bytes;
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) {
      return bytes;
    }
  }

  const estimated = await estimateTenantStorageBytes(bucket, tenantId, db);
  await usageRef.set(
    {
      tenantId,
      bytes: estimated,
      estimatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return estimated;
}

async function reserveTenantStorageBytes(
  db: admin.firestore.Firestore,
  tenantId: string,
  incrementBytes: number,
  limitBytes: number
): Promise<{ usedBytes: number }>{
  const usageRef = db.collection('tenantStorageUsage').doc(tenantId);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const current = snap.exists ? (snap.data() as any)?.bytes : undefined;
    const usedBytes = typeof current === 'number' && Number.isFinite(current) && current >= 0 ? current : 0;
    if (limitBytes > 0 && usedBytes + incrementBytes > limitBytes) {
      throw new TenantStorageLimitError(limitBytes, usedBytes, incrementBytes);
    }
    tx.set(
      usageRef,
      {
        tenantId,
        bytes: usedBytes + incrementBytes,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { usedBytes };
  });
}

async function releaseTenantStorageBytes(
  db: admin.firestore.Firestore,
  tenantId: string,
  decrementBytes: number
): Promise<void> {
  if (decrementBytes <= 0) return;
  const usageRef = db.collection('tenantStorageUsage').doc(tenantId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const current = snap.exists ? (snap.data() as any)?.bytes : undefined;
    const usedBytes = typeof current === 'number' && Number.isFinite(current) && current >= 0 ? current : 0;
    const next = Math.max(0, usedBytes - decrementBytes);
    tx.set(
      usageRef,
      {
        tenantId,
        bytes: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/**
 * What the reservation step of `POST /storage/upload` decided, as data.
 *
 * Every non-`reserved` outcome carries the exact HTTP status, response body and
 * metric stage label the route has always returned for that case, so the route's
 * job is a single forward — `res.status(result.status).json(result.body)` — and
 * there is no second place where a status code or a stage label could drift.
 */
export type UploadQuotaReservationResult =
  /** The bytes are held. The caller now owes a release if the write fails. */
  | { outcome: 'reserved' }
  | {
      outcome: 'rejected';
      status: 409;
      /** `metricNames.storageUploadRejected`. */
      metric: string;
      stage: 'reserve_reconcile' | 'reserve_retry' | 'last_chance';
      body: {
        error: 'storage_limit_reached';
        limitBytes: number;
        /** May be `undefined` on the retry path, exactly as before; JSON drops it. */
        usedBytes: number | undefined;
        incrementBytes: number;
      };
    }
  | {
      outcome: 'check_failed';
      status: 503;
      /** `metricNames.storageUploadQuotaCheckFailed`. */
      metric: string;
      stage: 'reserve_unknown';
      body: { error: 'storage_quota_check_failed' };
      /** The original reserve failure, for the route's warning log. */
      error: unknown;
    };

export interface ReserveUploadQuotaBytesArgs {
  /** `quotaDelta.reserveBytes`; the caller only invokes this when it is `> 0`. */
  reserveBytes: number;
  /** `0` means "no plan limit", matching the route's `limitBytes` convention. */
  limitBytes: number;
  /**
   * Hold `reserveBytes` against the tenant's recorded usage, rejecting with a
   * `TenantStorageLimitError` (or anything `tryExtractTenantStorageLimitError`
   * can classify) when the allowance cannot accommodate them. The route wires
   * this to `reserveTenantStorageBytes` PLUS its `invalidateLiveCount` call, so
   * the cache invalidation stays paired with the reservation and happens on the
   * first attempt and the retry alike, exactly as it does today (Req 3.10).
   *
   * Must be atomic: on rejection it holds nothing, which is what lets every
   * failure outcome below return without a release.
   */
  reserve: () => Promise<void>;
  /** Recompute recorded usage from bucket truth and return the new total. */
  reconcileUsageBytes: () => Promise<number>;
}

/**
 * Reserve an upload's quota delta, with the reconcile-and-retry recovery the
 * endpoint has always attempted (upload-idempotency spec follow-up).
 *
 * Extracted from the route body so the control flow below is assertable without an
 * Express or Firebase harness — the same seam pattern as
 * `probeExistingUploadObject`, `selectUploadDownloadToken` and
 * `resolveShareTokenForUpload`.
 *
 * The paths, in order:
 * 1. The reservation succeeds ⇒ `reserved`.
 * 2. It fails with a classifiable limit error ⇒ reconcile once (deletions may have
 *    happened since the counter was last trued up) and either reject with
 *    `reserve_reconcile` (still over limit) or retry the reservation. A SUCCESSFUL
 *    retry ⇒ `reserved`. A failing reconcile or a failing retry ⇒ `reserve_retry`.
 * 3. It fails with something unclassifiable ⇒ the last-chance deterministic check:
 *    reject with `last_chance` when reconciled usage proves the tenant is over
 *    limit, otherwise report `reserve_unknown` (the route's `503`).
 *
 * FIXED BUG, do not reintroduce: this used to be inlined in the route as a
 * `try/catch` whose limit-error branch fell THROUGH after a successful retry —
 * into the last-chance check and then unconditionally into
 * `503 storage_quota_check_failed`. Two consequences: the caller got a spurious
 * `503` although its bytes were reserved and the upload could have proceeded
 * (making this entire recovery path dead code), and the route's `reservedBytes`
 * was still `0`, so the rollback released nothing and the reservation leaked until
 * the next reconcile — a direct violation of Requirement 3.7. Returning
 * `{ outcome: 'reserved' }` from the retry branch is the fix; the last-chance
 * check below is reached only when the retry did NOT happen or did NOT succeed.
 */
export async function reserveUploadQuotaBytes(
  args: ReserveUploadQuotaBytesArgs
): Promise<UploadQuotaReservationResult> {
  const { reserveBytes, limitBytes } = args;

  try {
    await args.reserve();
    return { outcome: 'reserved' };
  } catch (error) {
    const limitError =
      error instanceof TenantStorageLimitError
        ? {
            limitBytes: error.limitBytes,
            usedBytes: error.usedBytes,
            incrementBytes: error.incrementBytes,
          }
        : tryExtractTenantStorageLimitError(error);

    if (limitError) {
      // Reconcile once (deletions might have happened) and retry.
      try {
        const reconciled = await args.reconcileUsageBytes();
        if (limitBytes > 0 && reconciled + reserveBytes > limitBytes) {
          return {
            outcome: 'rejected',
            status: 409,
            metric: metricNames.storageUploadRejected,
            stage: 'reserve_reconcile',
            body: {
              error: 'storage_limit_reached',
              limitBytes,
              usedBytes: reconciled,
              incrementBytes: reserveBytes,
            },
          };
        }
        await args.reserve();
        // The recovery worked: the bytes are held, so the request continues to the
        // write instead of falling through to the last-chance check and the 503.
        return { outcome: 'reserved' };
      } catch (reconcileOrRetryError) {
        const retryLimitError = tryExtractTenantStorageLimitError(reconcileOrRetryError);
        return {
          outcome: 'rejected',
          status: 409,
          metric: metricNames.storageUploadRejected,
          stage: 'reserve_retry',
          body: {
            error: 'storage_limit_reached',
            limitBytes: retryLimitError?.limitBytes ?? limitError.limitBytes ?? limitBytes,
            usedBytes: retryLimitError?.usedBytes ?? limitError.usedBytes,
            incrementBytes: retryLimitError?.incrementBytes ?? limitError.incrementBytes ?? reserveBytes,
          },
        };
      }
    }

    // Last-chance deterministic check for unclassified reserve failures.
    try {
      const reconciled = await args.reconcileUsageBytes();
      if (limitBytes > 0 && reconciled + reserveBytes > limitBytes) {
        return {
          outcome: 'rejected',
          status: 409,
          metric: metricNames.storageUploadRejected,
          stage: 'last_chance',
          body: {
            error: 'storage_limit_reached',
            limitBytes,
            usedBytes: reconciled,
            incrementBytes: reserveBytes,
          },
        };
      }
    } catch {
      // Keep original 503 fallback when reconciliation itself is unavailable.
    }

    return {
      outcome: 'check_failed',
      status: 503,
      metric: metricNames.storageUploadQuotaCheckFailed,
      stage: 'reserve_unknown',
      body: { error: 'storage_quota_check_failed' },
      error,
    };
  }
}

function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined) as any;
  }
  if (typeof value === 'object') {
    // Preserve non-plain objects (Firestore sentinels like FieldValue.serverTimestamp(),
    // Timestamp, GeoPoint, DocumentReference, etc). Treat only POJOs as maps.
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) {
      return value;
    }
    const out: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value as any)) {
      const cleaned = stripUndefinedDeep(entry);
      if (cleaned !== undefined) {
        out[key] = cleaned;
      }
    }
    return out as any;
  }
  return value;
}

async function countQueryFast(query: admin.firestore.Query): Promise<number> {
  const anyQuery = query as admin.firestore.Query & { count?: () => { get: () => Promise<{ data(): { count: number } }> } };
  if (typeof anyQuery.count === 'function') {
    const snapshot = await anyQuery.count().get();
    return snapshot.data().count ?? 0;
  }
  const snapshot = await query.get();
  return snapshot.size;
}

function monthBoundsUtc(monthId: string): { start: Date; end: Date } {
  const year = Number(monthId.slice(0, 4));
  const month = Number(monthId.slice(5, 7));
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, end };
}

async function resolveTenantPlanLimitsForEnforcement(
  db: admin.firestore.Firestore,
  tenantId: string
): Promise<import('./lib/planLimits').PlanLimits> {
  const tenantSnap = await db.collection('tenants').doc(tenantId).get();
  const tenantData = tenantSnap.exists ? tenantSnap.data() || {} : {};
  const quotasRaw = tenantData.quotas && typeof tenantData.quotas === 'object' ? (tenantData.quotas as any) : null;
  return await resolveEffectivePlanLimitsForTenant(db, tenantId, {
    billingTier: typeof tenantData.billingTier === 'string' ? tenantData.billingTier : null,
    quotas: quotasRaw
      ? {
          maxStaff: typeof quotasRaw.maxStaff === 'number' ? quotasRaw.maxStaff : null,
          maxStudents: typeof quotasRaw.maxStudents === 'number' ? quotasRaw.maxStudents : null,
          maxMonthlyReminders: typeof quotasRaw.maxMonthlyReminders === 'number' ? quotasRaw.maxMonthlyReminders : null,
          maxStorageMb: typeof quotasRaw.maxStorageMb === 'number' ? quotasRaw.maxStorageMb : null,
        }
      : null,
  });
}

async function reconcileTenantReminderUsageToBillableOnly(
  db: admin.firestore.Firestore,
  tenantId: string,
  monthId: string
): Promise<void> {
  if (process.env.DISABLE_REMINDER_USAGE_RECONCILE === '1') {
    return;
  }

  // Many unit tests use lightweight Firestore stubs that don't implement chained query builders.
  // Reconciliation is best-effort and should not run when query chaining isn't supported.
  try {
    const collectionAny = (db as any)?.collection?.('reminderHistory');
    if (!collectionAny || typeof collectionAny.where !== 'function') {
      return;
    }
    const chained = collectionAny.where('tenantId', '==', tenantId);
    if (!chained || typeof chained.where !== 'function') {
      return;
    }
  } catch {
    return;
  }

  let usageRef: any = null;
  try {
    const tenantUsageCollection = (db as any)?.collection?.('tenantReminderUsage');
    const tenantUsageDoc = tenantUsageCollection?.doc?.(tenantId);
    const monthsCollection = tenantUsageDoc?.collection?.('months');
    usageRef = monthsCollection?.doc?.(monthId) ?? null;
    if (!usageRef || typeof usageRef.get !== 'function') {
      return;
    }
  } catch {
    return;
  }
  const existingSnap = await usageRef.get();
  const existing = existingSnap.exists ? existingSnap.data() || {} : {};
  if ((existing as any).countingMode === 'billable_success_only_v2') {
    return;
  }

  const { start, end } = monthBoundsUtc(monthId);
  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs = admin.firestore.Timestamp.fromDate(end);

  const baseQuery = db
    .collection('reminderHistory')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'success')
    .where('createdAt', '>=', startTs)
    .where('createdAt', '<', endTs)
    // Align with existing composite indexes (tenantId + status + createdAt DESC).
    .orderBy('createdAt', 'desc');

  const total = await countQueryFast(baseQuery);
  const channels: ReminderChannel[] = ['email', 'sms', 'whatsapp', 'voice'];
  const channelCounts = await Promise.all(
    channels.map(async (channel) => ({
      channel,
      count: await countQueryFast(baseQuery.where('reminderType', '==', channel)),
    }))
  );

  const payload: Record<string, unknown> = {
    tenantId,
    month: monthId,
    total,
    countingMode: 'billable_success_only_v2',
    migratedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  channelCounts.forEach((entry) => {
    payload[entry.channel] = entry.count;
  });
  if (!existingSnap.exists) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await usageRef.set(payload, { merge: true });
}

async function assertTenantReminderQuotaAvailable(
  db: admin.firestore.Firestore,
  tenantId: string,
  reminderType: 'whatsapp' | 'sms' | 'email' | 'voice',
  incrementBy = 1,
  options?: {
    historyId?: string;
    history?: Record<string, any>;
  }
): Promise<void> {
  if (incrementBy <= 0) {
    return;
  }

  const planLimits = await resolveTenantPlanLimitsForEnforcement(db, tenantId);
  const totalLimit = Number.isFinite(planLimits.reminders.total) ? planLimits.reminders.total : 0;
  const channelLimitRaw = (planLimits.reminders as any)?.[reminderType];
  const channelLimit = typeof channelLimitRaw === 'number' && Number.isFinite(channelLimitRaw) ? channelLimitRaw : 0;

  if (totalLimit <= 0 && channelLimit <= 0) {
    return;
  }

  const monthId = normalizeMonthId(null);
  // One-time reconciliation for tenants that previously counted pending/failed against quota.
  try {
    await reconcileTenantReminderUsageToBillableOnly(db, tenantId, monthId);
  } catch (e) {
    console.warn('[reminder_quota] reconcile failed', e);
  }
  const ref = db.collection('tenantReminderUsage').doc(tenantId).collection('months').doc(monthId);

  const historyId = typeof options?.historyId === 'string' ? options.historyId.trim() : '';
  const historyRef = historyId ? db.collection('reminderHistory').doc(historyId) : null;
  const historyPayload = options?.history && typeof options.history === 'object' ? (options.history as any) : null;

  const inFlightTotalField = 'inFlightTotal';
  const inFlightChannelField = `inFlight${reminderType[0].toUpperCase()}${reminderType.slice(1)}`;

  await db.runTransaction(async (tx) => {
    const [snap, historySnap] = await Promise.all([
      tx.get(ref),
      historyRef ? tx.get(historyRef) : Promise.resolve(null),
    ]);
    // L13: refuse to reserve/write when the client-supplied historyId targets
    // ANOTHER tenant's reminderHistory doc (spoofed id) — never reserve quota for
    // it or write onto it.
    if (historyRef && historySnap && historySnap.exists) {
      const existingHistTenantId = ((historySnap.data() || {}) as Record<string, any>).tenantId;
      if (typeof existingHistTenantId === 'string' && existingHistTenantId && existingHistTenantId !== tenantId) {
        throw new TenantAccessError(403, { error: 'history_tenant_mismatch' });
      }
    }
    const data = snap.exists ? (snap.data() || {}) : {};
    const totalUsed = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : 0;
    const usedByChannel = typeof (data as any)[reminderType] === 'number' && Number.isFinite((data as any)[reminderType])
      ? Number((data as any)[reminderType])
      : 0;

    const inFlightTotal =
      typeof (data as any)[inFlightTotalField] === 'number' && Number.isFinite((data as any)[inFlightTotalField])
        ? Number((data as any)[inFlightTotalField])
        : 0;
    const inFlightByChannel =
      typeof (data as any)[inFlightChannelField] === 'number' && Number.isFinite((data as any)[inFlightChannelField])
        ? Number((data as any)[inFlightChannelField])
        : 0;

    // Enforce quotas against billable usage + in-flight sends.
    if (totalLimit > 0 && totalUsed + inFlightTotal + incrementBy > totalLimit) {
      throw new TenantReminderLimitError(totalLimit, totalUsed + inFlightTotal, 'total');
    }
    if (channelLimit > 0 && usedByChannel + inFlightByChannel + incrementBy > channelLimit) {
      throw new TenantReminderLimitError(channelLimit, usedByChannel + inFlightByChannel, reminderType);
    }

    const payload: Record<string, unknown> = {
      tenantId,
      month: monthId,
      [inFlightTotalField]: admin.firestore.FieldValue.increment(incrementBy),
      [inFlightChannelField]: admin.firestore.FieldValue.increment(incrementBy),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!snap.exists) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    tx.set(ref, payload, { merge: true });

    if (historyRef) {
      const existing = historySnap && historySnap.exists ? historySnap.data() || {} : {};
      const existingCreatedAt = (existing as any)?.createdAt;
      const needsCreatedAt = !(existingCreatedAt instanceof admin.firestore.Timestamp);
      const base: Record<string, unknown> = {
        tenantId,
        reminderType,
        status: 'pending',
        quota: {
          tenantId,
          monthId,
          channel: reminderType,
          inFlight: true,
          billed: false,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(needsCreatedAt ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
      };
      tx.set(historyRef, stripUndefinedDeep({ ...(historyPayload || {}), ...base }), { merge: true });
    }
  });
}

type ReminderChannel = 'email' | 'sms' | 'whatsapp' | 'voice';
interface ReminderQuotaStateSnapshot {
  hasUsageDoc: boolean;
  total: number;
  email: number;
  sms: number;
  whatsapp: number;
  voice: number;
  inFlightTotal: number;
  inFlightEmail: number;
  inFlightSms: number;
  inFlightWhatsapp: number;
  inFlightVoice: number;
  reservedTotal: number;
  reservedEmail: number;
  reservedSms: number;
  reservedWhatsapp: number;
  reservedVoice: number;
}

function normalizeReminderCount(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  return n > 0 ? n : 0;
}

function reminderReservationRef(
  db: admin.firestore.Firestore,
  tenantId: string,
  monthId: string,
  batchId: string
) {
  return db
    .collection('tenantReminderReservations')
    .doc(tenantId)
    .collection('months')
    .doc(monthId)
    .collection('batches')
    .doc(batchId);
}
async function loadTenantReminderQuotaState(
  db: admin.firestore.Firestore,
  tenantId: string,
  monthId: string
): Promise<ReminderQuotaStateSnapshot> {
  const fallback: ReminderQuotaStateSnapshot = {
    hasUsageDoc: false,
    total: 0,
    email: 0,
    sms: 0,
    whatsapp: 0,
    voice: 0,
    inFlightTotal: 0,
    inFlightEmail: 0,
    inFlightSms: 0,
    inFlightWhatsapp: 0,
    inFlightVoice: 0,
    reservedTotal: 0,
    reservedEmail: 0,
    reservedSms: 0,
    reservedWhatsapp: 0,
    reservedVoice: 0,
  };

  let usageRef: any = null;
  try {
    const tenantUsageCollection = (db as any)?.collection?.('tenantReminderUsage');
    const tenantUsageDoc = tenantUsageCollection?.doc?.(tenantId);
    const monthsCollection = tenantUsageDoc?.collection?.('months');
    usageRef = monthsCollection?.doc?.(monthId) ?? null;
    if (!usageRef || typeof usageRef.get !== 'function') {
      return fallback;
    }
  } catch {
    return fallback;
  }
  let usageData: Record<string, any> = {};
  let hasUsageDoc = false;
  try {
    const usageSnap = await usageRef.get();
    hasUsageDoc = usageSnap.exists;
    usageData = usageSnap.exists ? usageSnap.data() || {} : {};
  } catch {
    hasUsageDoc = false;
    usageData = {};
  }

  const state: ReminderQuotaStateSnapshot = {
    ...fallback,
    hasUsageDoc,
    total: safeNumber(usageData.total),
    email: safeNumber(usageData.email),
    sms: safeNumber(usageData.sms),
    whatsapp: safeNumber(usageData.whatsapp),
    voice: safeNumber(usageData.voice),
    inFlightTotal: safeNumber(usageData.inFlightTotal),
    inFlightEmail: safeNumber(usageData.inFlightEmail),
    inFlightSms: safeNumber(usageData.inFlightSms),
    inFlightWhatsapp: safeNumber(usageData.inFlightWhatsapp),
    inFlightVoice: safeNumber(usageData.inFlightVoice),
  };

  try {
    const batchesCollection = (db
      .collection('tenantReminderReservations')
      .doc(tenantId)
      .collection('months')
      .doc(monthId)
      .collection('batches') as any);

    if (!batchesCollection || typeof batchesCollection.where !== 'function') {
      return state;
    }

    const nowTs = admin.firestore.Timestamp.now();
    const activeQuery = batchesCollection.where('expiresAt', '>', nowTs);
    if (!activeQuery || typeof activeQuery.get !== 'function') {
      return state;
    }

    const activeReservations = await activeQuery.get();
    activeReservations.forEach((doc: any) => {
      const data = doc.data() || {};
      const remaining = data.remaining && typeof data.remaining === 'object' ? data.remaining : {};

      const email = safeNumber(remaining.email);
      const sms = safeNumber(remaining.sms);
      const whatsapp = safeNumber(remaining.whatsapp);
      const voice = safeNumber(remaining.voice);
      const totalRemaining = safeNumber(data.totalRemaining, email + sms + whatsapp + voice);

      state.reservedEmail += email;
      state.reservedSms += sms;
      state.reservedWhatsapp += whatsapp;
      state.reservedVoice += voice;
      state.reservedTotal += totalRemaining;
    });
  } catch (error) {
    console.warn('[usage] failed to load active reminder reservations', { tenantId, monthId, error });
  }

  return state;
}

async function reserveTenantReminderQuotaForBatch(
  db: admin.firestore.Firestore,
  tenantId: string,
  batchId: string,
  counts: Partial<Record<ReminderChannel, number>>
): Promise<{ monthId: string; reserved: Record<ReminderChannel, number> }>{
  const requested: Record<ReminderChannel, number> = {
    email: normalizeReminderCount(counts.email),
    sms: normalizeReminderCount(counts.sms),
    whatsapp: normalizeReminderCount(counts.whatsapp),
    voice: normalizeReminderCount(counts.voice),
  };
  const totalRequested = requested.email + requested.sms + requested.whatsapp + requested.voice;
  const monthId = normalizeMonthId(null);
  if (totalRequested <= 0) {
    return { monthId, reserved: requested };
  }

  // One-time reconciliation for tenants that previously counted pending/failed against quota.
  try {
    await reconcileTenantReminderUsageToBillableOnly(db, tenantId, monthId);
  } catch (e) {
    console.warn('[reminder_quota] reconcile failed', e);
  }

  const planLimits = await resolveTenantPlanLimitsForEnforcement(db, tenantId);
  const totalLimit = Number.isFinite(planLimits.reminders.total) ? planLimits.reminders.total : 0;

  const usageRef = db.collection('tenantReminderUsage').doc(tenantId).collection('months').doc(monthId);
  const reservationRef = reminderReservationRef(db, tenantId, monthId, batchId);

  // Crash-safe: reserve tokens only temporarily. Usage is incremented when tokens are consumed.
  const nowTs = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60_000); // 10 minutes
  const reservationsQuery = db
    .collection('tenantReminderReservations')
    .doc(tenantId)
    .collection('months')
    .doc(monthId)
    .collection('batches')
    .where('expiresAt', '>', nowTs);

  await db.runTransaction(async (tx) => {
    const existingReservation = await tx.get(reservationRef);
    if (existingReservation.exists) {
      return;
    }

    const usageSnap = await tx.get(usageRef);
    const usageData = usageSnap.exists ? usageSnap.data() || {} : {};
    const totalUsed = typeof usageData.total === 'number' && Number.isFinite(usageData.total) ? usageData.total : 0;
    const totalInFlight =
      typeof (usageData as any).inFlightTotal === 'number' && Number.isFinite((usageData as any).inFlightTotal)
        ? Number((usageData as any).inFlightTotal)
        : 0;

    // Sum outstanding (unexpired) reservations so app crashes/network retries don't permanently consume quota.
    const reservationsSnap = await tx.get(reservationsQuery);
    const reservedRemaining: Record<ReminderChannel, number> = { email: 0, sms: 0, whatsapp: 0, voice: 0 };
    let totalReservedRemaining = 0;
    reservationsSnap.forEach((doc) => {
      if (doc.id === batchId) {
        return;
      }
      const data = doc.data() || {};
      const remaining = (data as any).remaining || {};
      const totalRemaining =
        typeof (data as any).totalRemaining === 'number' && Number.isFinite((data as any).totalRemaining)
          ? Number((data as any).totalRemaining)
          : 0;
      totalReservedRemaining += Math.max(0, totalRemaining);
      (['email', 'sms', 'whatsapp', 'voice'] as ReminderChannel[]).forEach((channel) => {
        const v = typeof remaining[channel] === 'number' && Number.isFinite(remaining[channel]) ? Number(remaining[channel]) : 0;
        reservedRemaining[channel] += Math.max(0, v);
      });
    });

    if (totalLimit > 0 && totalUsed + totalInFlight + totalReservedRemaining + totalRequested > totalLimit) {
      throw new TenantReminderBatchLimitError(
        totalLimit,
        totalUsed + totalInFlight + totalReservedRemaining,
        totalRequested,
        'total'
      );
    }

    (['email', 'sms', 'whatsapp', 'voice'] as ReminderChannel[]).forEach((channel) => {
      const incrementBy = requested[channel];
      if (incrementBy <= 0) {
        return;
      }
      const channelLimitRaw = (planLimits.reminders as any)?.[channel];
      const channelLimit = typeof channelLimitRaw === 'number' && Number.isFinite(channelLimitRaw) ? channelLimitRaw : 0;
      const usedByChannel =
        typeof (usageData as any)[channel] === 'number' && Number.isFinite((usageData as any)[channel])
          ? Number((usageData as any)[channel])
          : 0;
      const inFlightField = `inFlight${channel[0].toUpperCase()}${channel.slice(1)}`;
      const inFlightByChannel =
        typeof (usageData as any)[inFlightField] === 'number' && Number.isFinite((usageData as any)[inFlightField])
          ? Number((usageData as any)[inFlightField])
          : 0;
      const reservedByChannel = reservedRemaining[channel] || 0;
      if (channelLimit > 0 && usedByChannel + inFlightByChannel + reservedByChannel + incrementBy > channelLimit) {
        throw new TenantReminderBatchLimitError(
          channelLimit,
          usedByChannel + inFlightByChannel + reservedByChannel,
          incrementBy,
          channel
        );
      }
    });

    tx.set(
      reservationRef,
      {
        tenantId,
        month: monthId,
        batchId,
        requested,
        remaining: { ...requested },
        totalRequested,
        totalRemaining: totalRequested,
        expiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  });

  return { monthId, reserved: requested };
}

async function consumeTenantReminderReservationToken(
  db: admin.firestore.Firestore,
  tenantId: string,
  batchId: string,
  channel: ReminderChannel,
  options?: {
    historyId?: string;
    history?: Record<string, any>;
  }
): Promise<void> {
  const monthId = normalizeMonthId(null);
  const ref = reminderReservationRef(db, tenantId, monthId, batchId);
  const usageRef = db.collection('tenantReminderUsage').doc(tenantId).collection('months').doc(monthId);
  const historyId = typeof options?.historyId === 'string' ? options.historyId.trim() : '';
  const historyPayload = options?.history && typeof options.history === 'object' ? (options.history as any) : null;
  const historyRef = historyId ? db.collection('reminderHistory').doc(historyId) : null;

  const nowTs = admin.firestore.Timestamp.now();

  const coerceToAdminTimestamp = (raw: any): admin.firestore.Timestamp | null => {
    if (!raw) return null;
    if (raw instanceof admin.firestore.Timestamp) return raw;
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return admin.firestore.Timestamp.fromMillis(ms);
      return null;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      // Heuristic: values > 1e12 are probably ms; otherwise seconds.
      const ms = raw > 1e12 ? raw : raw * 1000;
      return admin.firestore.Timestamp.fromMillis(ms);
    }
    if (typeof raw === 'object') {
      const seconds = (raw as any).seconds;
      const nanoseconds = (raw as any).nanoseconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        const ns = typeof nanoseconds === 'number' && Number.isFinite(nanoseconds) ? nanoseconds : 0;
        return new admin.firestore.Timestamp(seconds, ns);
      }
    }
    return null;
  };

  await db.runTransaction(async (tx) => {
    const [snap, usageSnap, existingHistory] = await Promise.all([
      tx.get(ref),
      tx.get(usageRef),
      historyRef ? tx.get(historyRef) : Promise.resolve(null),
    ]);

    // L13: refuse when the client-supplied historyId targets ANOTHER tenant's
    // reminderHistory doc (spoofed id).
    if (historyRef && existingHistory && existingHistory.exists) {
      const existingHistTenantId = ((existingHistory.data() || {}) as Record<string, any>).tenantId;
      if (typeof existingHistTenantId === 'string' && existingHistTenantId && existingHistTenantId !== tenantId) {
        throw new TenantAccessError(403, { error: 'history_tenant_mismatch' });
      }
    }

    if (!snap.exists) {
      throw new TenantAccessError(409, { error: 'reminder_quota_reservation_missing' });
    }
    const data = snap.data() || {};
    const expiresAtRaw = (data as any).expiresAt;
    const expiresAt = expiresAtRaw instanceof admin.firestore.Timestamp ? expiresAtRaw : null;
    if (expiresAt && expiresAt.toMillis() <= nowTs.toMillis()) {
      throw new TenantAccessError(409, { error: 'reminder_quota_reservation_expired' });
    }
    const remaining = (data as any).remaining || {};
    const remainingByChannel =
      typeof remaining[channel] === 'number' && Number.isFinite(remaining[channel]) ? Number(remaining[channel]) : 0;
    const totalRemaining =
      typeof (data as any).totalRemaining === 'number' && Number.isFinite((data as any).totalRemaining)
        ? Number((data as any).totalRemaining)
        : 0;
    if (remainingByChannel <= 0 || totalRemaining <= 0) {
      throw new TenantAccessError(409, { error: 'reminder_quota_reservation_exhausted', channel });
    }

    // Reserve an in-flight slot (billable usage is recorded only on success).
    const inFlightTotalField = 'inFlightTotal';
    const inFlightChannelField = `inFlight${channel[0].toUpperCase()}${channel.slice(1)}`;
    const usagePayload: Record<string, unknown> = {
      tenantId,
      month: monthId,
      [inFlightTotalField]: admin.firestore.FieldValue.increment(1),
      [inFlightChannelField]: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!usageSnap.exists) {
      usagePayload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }
    tx.set(usageRef, usagePayload, { merge: true });

    if (historyRef) {
      const base: Record<string, unknown> = {
        tenantId,
        reminderType: channel,
        status: 'pending',
        quota: {
          tenantId,
          monthId,
          batchId,
          channel,
          inFlight: true,
          billed: false,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      const existingData = existingHistory && existingHistory.exists ? existingHistory.data() || {} : null;
      const existingCreatedAt = existingData ? (existingData as any).createdAt : null;
      if (!existingHistory || !existingHistory.exists) {
        base.createdAt = admin.firestore.FieldValue.serverTimestamp();
      } else if (!(existingCreatedAt instanceof admin.firestore.Timestamp)) {
        // Repair legacy/malformed createdAt values so queries that order/filter by createdAt work reliably.
        const coerced = coerceToAdminTimestamp(existingCreatedAt);
        base.createdAt = coerced || admin.firestore.FieldValue.serverTimestamp();
      }
      tx.set(historyRef, stripUndefinedDeep({ ...(historyPayload || {}), ...base }), { merge: true });
    }

    tx.set(
      ref,
      {
        [`remaining.${channel}`]: admin.firestore.FieldValue.increment(-1),
        totalRemaining: admin.firestore.FieldValue.increment(-1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

async function releaseTenantReminderReservationTokenIfAvailable(
  db: admin.firestore.Firestore,
  tenantId: string,
  batchId: string,
  channel: ReminderChannel,
): Promise<void> {
  const monthId = normalizeMonthId(null);
  const ref = reminderReservationRef(db, tenantId, monthId, batchId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() || {};
    const remaining = (data as any).remaining || {};
    const remainingByChannel =
      typeof remaining[channel] === 'number' && Number.isFinite(remaining[channel]) ? Number(remaining[channel]) : 0;
    const totalRemaining =
      typeof (data as any).totalRemaining === 'number' && Number.isFinite((data as any).totalRemaining)
        ? Number((data as any).totalRemaining)
        : 0;

    if (remainingByChannel <= 0 || totalRemaining <= 0) {
      return;
    }

    tx.set(
      ref,
      {
        [`remaining.${channel}`]: admin.firestore.FieldValue.increment(-1),
        totalRemaining: admin.firestore.FieldValue.increment(-1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

async function assertTenantStudentCreateAllowed(
  db: admin.firestore.Firestore,
  tenantId: string,
  isActiveStudent: boolean
): Promise<void> {
  if (!isActiveStudent) {
    return;
  }
  const planLimits = await resolveTenantPlanLimitsForEnforcement(db, tenantId);
  const studentLimit = Number.isFinite(planLimits.students) ? planLimits.students : 0;
  if (studentLimit <= 0) {
    return;
  }
  const used = await countQueryFast(
    db
      .collection('students')
      .where('tenantId', '==', tenantId)
      .where('status', '==', 'active')
  );
  if (used >= studentLimit) {
    throw new TenantStudentLimitError(studentLimit, used);
  }
}

async function assertTenantStaffSeatAvailable(db: admin.firestore.Firestore, tenantId: string): Promise<void> {
  const tenantRef = db.collection('tenants').doc(tenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) {
    throw new TenantAccessError(404, { error: 'tenant_not_found' });
  }
  const tenantData = tenantSnap.data() || {};
  const quotasRaw = tenantData.quotas && typeof tenantData.quotas === 'object' ? (tenantData.quotas as any) : null;
  const planLimits = await resolveEffectivePlanLimitsForTenant(db, tenantId, {
    billingTier: typeof tenantData.billingTier === 'string' ? tenantData.billingTier : null,
    quotas: quotasRaw
      ? {
          maxStaff: typeof quotasRaw.maxStaff === 'number' ? quotasRaw.maxStaff : null,
          maxStudents: typeof quotasRaw.maxStudents === 'number' ? quotasRaw.maxStudents : null,
          maxMonthlyReminders: typeof quotasRaw.maxMonthlyReminders === 'number' ? quotasRaw.maxMonthlyReminders : null,
          maxStorageMb: typeof quotasRaw.maxStorageMb === 'number' ? quotasRaw.maxStorageMb : null,
        }
      : null,
  });
  const seatLimit = typeof planLimits.staffSeats === 'number' ? planLimits.staffSeats : null;
  if (!seatLimit || seatLimit <= 0) {
    return;
  }

  const isSeatRole = (role: unknown): boolean => {
    const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
    return normalized === 'owner' || normalized === 'admin' || normalized === 'staff';
  };

  const activeMembersSnap = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active')
    .get();
  let activeSeatCount = 0;
  activeMembersSnap.forEach((doc) => {
    const data = doc.data() || {};
    if (isSeatRole((data as any).role)) {
      activeSeatCount += 1;
    }
  });

  const pendingInvitesSnap = await db
    .collection('tenantInvites')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'pending')
    .get();
  let pendingSeatInvites = 0;
  pendingInvitesSnap.forEach((doc) => {
    const data = doc.data() || {};
    if (isSeatRole((data as any).role)) {
      pendingSeatInvites += 1;
    }
  });

  if (activeSeatCount + pendingSeatInvites >= seatLimit) {
    throw new TenantSeatLimitError(seatLimit);
  }
}

async function isTenantEmailActiveMember(tenantId: string, email: string): Promise<boolean> {
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedTenantId || !normalizedEmail) {
    return false;
  }

  ensureFirebase();
  const db = admin.firestore();
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', normalizedTenantId)
    .where('status', '==', 'active')
    .where('email', '==', normalizedEmail)
    .limit(1)
    .get();

  return !snapshot.empty;
}

function tenantInviteDocId(tenantId: string, email: string): string {
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  const normalizedEmail = normalizeEmail(email);
  // Firestore doc IDs cannot contain '/', but emails should not; still sanitize defensively.
  const safeEmail = normalizedEmail.replace(/\//g, '_');
  return `${normalizedTenantId}__${safeEmail}`;
}

const MEMBERSHIP_CACHE_TTL_MS = Math.max(Number(process.env.TENANT_MEMBERSHIP_CACHE_MS ?? 45_000), 5_000);
const MEMBERSHIP_CACHE_MAX = Math.max(Number(process.env.TENANT_MEMBERSHIP_CACHE_MAX ?? 1000), 100);
const membershipAccessCache = new Map<string, { role: TenantMembershipRole; expiresAt: number }>();

function getMembershipCacheKey(tenantId: string, uid: string): string {
  return `${tenantId}::${uid}`;
}

function pruneMembershipCache(now: number) {
  for (const [key, entry] of membershipAccessCache.entries()) {
    if (entry.expiresAt <= now) {
      membershipAccessCache.delete(key);
    }
  }
  if (membershipAccessCache.size <= MEMBERSHIP_CACHE_MAX) {
    return;
  }
  const excess = membershipAccessCache.size - MEMBERSHIP_CACHE_MAX;
  let removed = 0;
  for (const key of membershipAccessCache.keys()) {
    membershipAccessCache.delete(key);
    removed += 1;
    if (removed >= excess) {
      break;
    }
  }
}

async function requireTenantMembershipAccess(
  authContext: express.Request['authContext'],
  tenantIdRaw: string,
  options: { minRole?: TenantMembershipRole } = {}
): Promise<{ tenantId: string; role: TenantMembershipRole; membershipId: string | null }> {
  const normalizedTenantId = typeof tenantIdRaw === 'string' ? tenantIdRaw.trim() : '';
  if (!normalizedTenantId) {
    throw new TenantAccessError(400, { error: 'tenant_required' });
  }

  if (!authContext) {
    throw new TenantAccessError(401, { error: 'unauthorized' });
  }

  if (authContext.tokenType === 'master') {
    return { tenantId: normalizedTenantId, role: 'owner', membershipId: null };
  }

  const uid = authContext.uid;
  if (!uid) {
    throw new TenantAccessError(403, { error: 'not_authorized' });
  }

  ensureFirebase();
  const db = admin.firestore();
  const membershipId = membershipDocId(normalizedTenantId, uid);
  const cacheKey = getMembershipCacheKey(normalizedTenantId, uid);
  const now = Date.now();
  const cached = membershipAccessCache.get(cacheKey);
  let role: TenantMembershipRole | null = null;
  if (cached && cached.expiresAt > now) {
    role = cached.role;
  } else {
    const membershipSnap = await db.collection('tenantMemberships').doc(membershipId).get();
    if (!membershipSnap.exists) {
      throw new TenantAccessError(403, { error: 'tenant_membership_required' });
    }
    const membershipData = membershipSnap.data() || {};
    const status = typeof membershipData.status === 'string' ? membershipData.status.toLowerCase() : '';
    if (status !== 'active') {
      throw new TenantAccessError(403, { error: 'tenant_membership_inactive' });
    }

    const rawRole = typeof membershipData.role === 'string' ? membershipData.role.toLowerCase() : 'member';
    const allowedRoles: TenantMembershipRole[] = ['owner', 'admin', 'staff', 'member'];
    role = (allowedRoles.includes(rawRole as TenantMembershipRole)
      ? (rawRole as TenantMembershipRole)
      : 'member');
    membershipAccessCache.set(cacheKey, { role, expiresAt: now + MEMBERSHIP_CACHE_TTL_MS });
    if (membershipAccessCache.size > MEMBERSHIP_CACHE_MAX * 1.2) {
      pruneMembershipCache(now);
    }
  }

  const minRole = options.minRole ?? 'staff';
  const currentRank = tenantRolePriority[role] ?? 0;
  const requiredRank = tenantRolePriority[minRole] ?? tenantRolePriority.staff;
  if (currentRank < requiredRank) {
    throw new TenantAccessError(403, {
      error: 'tenant_role_insufficient',
      requiredRole: minRole,
      currentRole: role,
    });
  }

  return { tenantId: normalizedTenantId, role, membershipId };
}

function respondTenantAccessError(res: express.Response, error: unknown): boolean {
  if (error instanceof TenantAccessError) {
    res.status(error.status).json(error.body);
    return true;
  }
  return false;
}

type TenantIdResolver = (req: express.Request) => string | null | undefined;

interface TenantAccessMiddlewareOptions {
  resolveTenantId?: TenantIdResolver;
  minRole?: TenantMembershipRole;
  requireTenantId?: boolean;
}

function billingDelinquencyEnforcementEnabled(): boolean {
  return process.env.BILLING_DELINQUENCY_ENFORCEMENT_ENABLED === '1';
}

function billingAutoDowngradeAfterGraceEnabled(): boolean {
  // Default ON when delinquency enforcement is enabled.
  // Set BILLING_AUTO_DOWNGRADE_AFTER_GRACE=0 to disable.
  const raw = typeof process.env.BILLING_AUTO_DOWNGRADE_AFTER_GRACE === 'string' ? process.env.BILLING_AUTO_DOWNGRADE_AFTER_GRACE : '';
  if (raw.trim() === '0') {
    return false;
  }
  return true;
}

function billingDelinquencyGraceDays(): number {
  const raw = Number(process.env.BILLING_DELINQUENCY_GRACE_DAYS ?? '7');
  if (!Number.isFinite(raw) || raw < 0) {
    return 7;
  }
  return Math.floor(raw);
}

function isBillingEnforcementExemptPath(path: string): boolean {
  // Always allow billing endpoints so a tenant can recover by paying.
  return typeof path === 'string' && path.startsWith('/billing/');
}

async function assertTenantBillingInGoodStanding(
  db: admin.firestore.Firestore,
  tenantId: string,
  reqPath: string,
  authContext: express.Request['authContext']
): Promise<void> {
  if (!billingDelinquencyEnforcementEnabled()) {
    return;
  }
  if (!tenantId) {
    return;
  }
  if (isBillingEnforcementExemptPath(reqPath)) {
    return;
  }
  const tokenType = authContext?.tokenType;
  if (tokenType === 'master' || tokenType === 'internal') {
    return;
  }

  const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
  if (!billingSnap.exists) {
    return;
  }
  const data = billingSnap.data() || {};
  const statusRaw = typeof (data as any).status === 'string' ? String((data as any).status).toLowerCase() : '';
  const status = statusRaw === 'active' || statusRaw === 'delinquent' || statusRaw === 'canceled' || statusRaw === 'trial'
    ? statusRaw
    : '';

  // If billing record claims free, don't block.
  const planId = normalizePlanId((data as any).planId ?? (data as any).plan ?? 'free');
  if (planId === 'free') {
    return;
  }
  if (status !== 'delinquent') {
    return;
  }

  const nowMs = Date.now();
  const graceMs = billingDelinquencyGraceDays() * 24 * 60 * 60 * 1000;
  const delinquentSinceMs =
    (() => {
      const iso = typeof (data as any).delinquentSinceIso === 'string' ? (data as any).delinquentSinceIso : undefined;
      if (iso) {
        const parsed = Date.parse(iso);
        return Number.isNaN(parsed) ? undefined : parsed;
      }
      return timestampToMillis((data as any).delinquentSince) ?? timestampToMillis((data as any).updatedAt);
    })();

  if (typeof delinquentSinceMs === 'number' && Number.isFinite(delinquentSinceMs) && graceMs > 0) {
    if (nowMs <= delinquentSinceMs + graceMs) {
      return;
    }
  }

  const graceUntilIso =
    typeof delinquentSinceMs === 'number' && Number.isFinite(delinquentSinceMs)
      ? new Date(delinquentSinceMs + graceMs).toISOString()
      : null;

  if (billingAutoDowngradeAfterGraceEnabled()) {
    const billingProvider = typeof (data as any).billingProvider === 'string' ? String((data as any).billingProvider) : null;
    const subscriptionIdRaw = typeof (data as any).subscriptionId === 'string' ? String((data as any).subscriptionId) : '';
    const subscriptionId = subscriptionIdRaw.trim();
    const fromPlanId = planId;

    // Best-effort: cancel provider subscription so charges stop.
    if (billingProvider === 'razorpay' && subscriptionId) {
      try {
        await cancelRazorpaySubscription({ subscriptionId, cancelAtCycleEnd: false });
      } catch (error) {
        console.warn('[billing_enforcement] razorpay cancel failed during auto downgrade', error);
      }
    }

    try {
      await db
        .collection('tenantBilling')
        .doc(tenantId)
        .set(
          {
            planId: 'free',
            planVariantId: null,
            couponCode: null,
            status: 'canceled',
            renewalDate: null,
            cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
            scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
            scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
            limitsSnapshot: admin.firestore.FieldValue.delete(),
            limitsSnapshotAt: admin.firestore.FieldValue.delete(),
            delinquentSince: admin.firestore.FieldValue.delete(),
            delinquentSinceIso: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      await db
        .collection('tenants')
        .doc(tenantId)
        .set(
          {
            billingTier: 'free',
            quotas: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    } catch (error) {
      console.error('[billing_enforcement] auto downgrade failed', error);
      throw new TenantAccessError(500, { error: 'billing_auto_downgrade_failed' });
    }

    void sendTenantBillingEventNotification({
      tenantId,
      tenantName: undefined,
      kind: 'downgrade_to_free_immediate',
      title: 'Switched to Free plan',
      body: 'Your payment was overdue past the grace period, so the plan has been switched to Free.',
      priority: 'medium',
      metadata: {
        provider: billingProvider,
        subscriptionId: subscriptionId || null,
        fromPlanId,
        reason: 'grace_expired',
        graceUntil: graceUntilIso,
      },
    }).catch(() => undefined);

    // Tenant is now Free; allow request to proceed.
    return;
  }

  throw new TenantAccessError(402, {
    error: 'billing_past_due',
    status: 'delinquent',
    graceUntil: graceUntilIso,
  });
}

function defaultTenantIdResolver(req: express.Request): string | null {
  const tenantId = (req.body && typeof (req.body as any).tenantId === 'string') ? (req.body as any).tenantId : undefined;
  if (typeof tenantId === 'string') {
    const normalized = tenantId.trim();
    return normalized.length ? normalized : null;
  }
  return null;
}

function queryTenantIdResolver(paramName = 'tenantId'): TenantIdResolver {
  return (req: express.Request): string | null => {
    const rawValue = (req.query?.[paramName] ?? undefined) as unknown;
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim();
      return normalized.length ? normalized : null;
    }
    if (Array.isArray(rawValue) && rawValue.length > 0) {
      const first = String(rawValue[0]).trim();
      return first.length ? first : null;
    }
    return null;
  };
}

function paramsTenantIdResolver(paramName = 'tenantId'): TenantIdResolver {
  return (req: express.Request): string | null => {
    const params = req.params ?? {};
    const rawValue = params[paramName];
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim();
      return normalized.length ? normalized : null;
    }
    return null;
  };
}

const standardQueryTenantResolver = queryTenantIdResolver();
const standardParamsTenantResolver = paramsTenantIdResolver();
function pathTenantIdResolver(path?: string | null): string | null {
  if (!path) {
    return null;
  }
  const match = path.match(/^\/tenants\/([^/]+)/i);
  if (!match) {
    return null;
  }
  const candidate = match[1]?.trim();
  return candidate && candidate.length ? candidate : null;
}

function anyTenantIdResolver(req: express.Request): string | null {
  const bodyTenant = defaultTenantIdResolver(req);
  if (bodyTenant) {
    return bodyTenant;
  }
  const queryTenant = standardQueryTenantResolver(req);
  if (typeof queryTenant === 'string' && queryTenant.trim().length) {
    return queryTenant;
  }
  const paramsTenant = standardParamsTenantResolver(req);
  if (typeof paramsTenant === 'string' && paramsTenant.trim().length) {
    return paramsTenant;
  }
  const pathTenant = pathTenantIdResolver(req.path);
  if (pathTenant) {
    return pathTenant;
  }
  return null;
}

function tenantAccessMiddleware(
  options: TenantAccessMiddlewareOptions = {},
  accessFn: typeof requireTenantMembershipAccess = requireTenantMembershipAccess,
  getFirestore: () => admin.firestore.Firestore = () => {
    ensureFirebase();
    return admin.firestore();
  }
) {
  const resolveTenantId = options.resolveTenantId ?? defaultTenantIdResolver;
  const minRole = options.minRole ?? 'staff';
  const requireTenantId = options.requireTenantId ?? true;

  return async function tenantAccessGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
    let tenantId: string | null | undefined = null;
    try {
      tenantId = resolveTenantId(req);
    } catch (error) {
      console.error('[tenant_access] failed to resolve tenantId', error);
      return res.status(500).json({ error: 'tenant_resolution_failed' });
    }

    const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
    if (!normalizedTenantId) {
      if (requireTenantId) {
        return res.status(400).json({ error: 'tenant_required' });
      }
      return next();
    }

    const existingAccess = req.tenantAccess;
    if (existingAccess && existingAccess.tenantId === normalizedTenantId) {
      const currentRank = tenantRolePriority[existingAccess.role] ?? 0;
      const requiredRank = tenantRolePriority[minRole] ?? tenantRolePriority.staff;
      if (currentRank >= requiredRank) {
        return next();
      }
      return res.status(403).json({
        error: 'tenant_role_insufficient',
        requiredRole: minRole,
        currentRole: existingAccess.role,
      });
    }

    try {
      const access = await accessFn(req.authContext, normalizedTenantId, { minRole });
      req.tenantAccess = access;

      try {
        const db = getFirestore();
        await assertTenantBillingInGoodStanding(db, normalizedTenantId, req.path || '', req.authContext);
      } catch (error) {
        if (respondTenantAccessError(res, error)) {
          return;
        }
        if (error instanceof TenantAccessError) {
          return res.status(error.status).json(error.body);
        }
        console.error('[tenant_access] billing enforcement check failed', error);
        return res.status(500).json({ error: 'billing_enforcement_failed' });
      }

      return next();
    } catch (error) {
      if (respondTenantAccessError(res, error)) {
        return;
      }
      console.error('[tenant_access] tenant access check failed', error);
      return res.status(500).json({ error: 'tenant_check_failed' });
    }
  };
}

type DevicePingType = 'register' | 'heartbeat' | 'full';

function resolveDevicePingActivity(pingType: DevicePingType): string {
  switch (pingType) {
    case 'register':
      return 'device_registration';
    case 'full':
      return 'full_update';
    default:
      return 'heartbeat';
  }
}

function toIsoTimestamp(value: any): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return undefined;
    }
  }
  if (typeof value.seconds === 'number') {
    const millis = value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
    return new Date(millis).toISOString();
  }
  return undefined;
}

function formatIsoIstForDisplay(iso: string | undefined | null): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  try {
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const parts = formatter.formatToParts(date);
    const map = new Map(parts.map((p) => [p.type, p.value] as const));
    const dd = map.get('day');
    const mon = map.get('month');
    const yyyy = map.get('year');
    const hour = map.get('hour');
    const minute = map.get('minute');
    const dayPeriod = map.get('dayPeriod');
    if (dd && mon && yyyy && hour && minute && dayPeriod) {
      return `${dd} ${mon} ${yyyy}, ${hour}:${minute} ${dayPeriod} IST`;
    }
  } catch {
    // fall through
  }

  // Fallback: manual IST conversion (UTC+05:30)
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mon = months[ist.getUTCMonth()] ?? '';
  const yyyy = ist.getUTCFullYear();
  let hour24 = ist.getUTCHours();
  const minute = String(ist.getUTCMinutes()).padStart(2, '0');
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  hour24 = hour24 % 12;
  const hour12 = hour24 === 0 ? 12 : hour24;
  return `${dd} ${mon} ${yyyy}, ${hour12}:${minute} ${ampm} IST`;
}

function timestampToMillis(value: any): number | undefined {
  const iso = toIsoTimestamp(value);
  if (!iso) {
    return undefined;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

interface TenantAdminSummary {
  id: string;
  name?: string;
  slug?: string;
  code?: string;
  status?: string;
  billingTier?: string;
  ownerEmail?: string;
  ownerUserId?: string;
  contactEmail?: string;
  contactPhone?: string;
  logoUrl?: string | null;
  heroImageUrl?: string | null;
  branding?: {
    logoUrl?: string;
    heroImageUrl?: string;
    accentImageUrl?: string;
    tagline?: string;
    missionStatement?: string;
  };
  quotas?: {
    maxStudents?: number;
    maxStaff?: number;
    maxMonthlyReminders?: number;
    maxMonthlyWhatsappReminders?: number;
    maxMonthlySmsReminders?: number;
    maxMonthlyEmailReminders?: number;
    maxMonthlyVoiceReminders?: number;
    maxStorageMb?: number;
  };
  membershipCounts?: {
    total?: number;
    active?: number;
    pending?: number;
    owners?: number;
    admins?: number;
    staff?: number;
  };
  flags?: {
    allowJoinRequests?: boolean;
    notifyOnJoinRequest?: boolean;
    notifyViaEmail?: boolean;
  };
  createdAt?: string;
  updatedAt?: string;
  seatUsage?: {
    adminSeatsUsed: number | null;
    adminSeatLimit: number | null;
    remaining: number | null;
  };
}

interface TenantSearchResponse {
  results: TenantAdminSummary[];
  total: number;
  diagnostics: {
    query?: string;
    matchedBy: string[];
    fallbackApplied: boolean;
  };
}

interface TenantMembershipAdminRecord {
  id: string;
  tenantId: string;
  userId?: string;
  email?: string;
  displayName?: string;
  role?: string;
  status?: string;
  joinedVia?: string;
  joinCodeId?: string;
  invitedByUserId?: string;
  invitedByEmail?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
}

interface MembershipSummaryBuckets {
  count: number;
  byRole: Record<string, number>;
  byStatus: Record<string, number>;
}

interface TenantMembershipInspectorResponse {
  tenant: TenantAdminSummary;
  members: TenantMembershipAdminRecord[];
  total: number;
  hasMore: boolean;
  stats: {
    filtered: MembershipSummaryBuckets;
    scanned: MembershipSummaryBuckets;
    snapshot?: TenantAdminSummary['membershipCounts'];
  };
  filters: {
    limit: number;
    role: TenantMembershipRole | 'all';
    status: string;
    search?: string;
  };
}

const tenantMembershipInspectorSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
  limit: z.number().int().min(1).max(200).optional(),
  role: z.union([z.literal('all'), z.enum(['owner', 'admin', 'staff', 'member'])]).optional(),
  status: z.string().trim().max(40).optional(),
  search: z.string().trim().max(120).optional(),
});

interface TenantInviteAdminRecord {
  id: string;
  tenantId: string;
  email?: string;
  role?: string;
  status?: string;
  issuedBy?: string;
  issuedAt?: string;
  expiresAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  lastSentAt?: string;
  lastSentBy?: string;
  invitationMessage?: string;
}

interface TenantInviteInspectorResponse {
  tenant: TenantAdminSummary;
  invites: TenantInviteAdminRecord[];
  total: number;
  hasMore: boolean;
  stats: {
    byStatus: Record<string, number>;
  };
  filters: {
    limit: number;
    status: string;
    search?: string;
  };
}

const tenantInviteInspectorSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
  limit: z.number().int().min(1).max(200).optional(),
  status: z.string().trim().max(40).optional(),
  search: z.string().trim().max(120).optional(),
});

interface TenantAuditAdminRecord {
  id: string;
  tenantId: string;
  action: string;
  actorId?: string;
  actorEmail?: string;
  targetId?: string;
  targetType?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

interface TenantAuditInspectorResponse {
  tenant: TenantAdminSummary;
  entries: TenantAuditAdminRecord[];
  total: number;
  hasMore: boolean;
  stats: {
    byAction: Record<string, number>;
  };
  filters: {
    limit: number;
    action: string;
    search?: string;
  };
}

const tenantAuditInspectorSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
  limit: z.number().int().min(1).max(200).optional(),
  action: z.string().trim().max(80).optional(),
  search: z.string().trim().max(160).optional(),
});
 
interface NotificationHistoryAdminRecord {
  id: string;
  tenantId?: string | null;
  tenantName?: string | null;
  adminEmail?: string | null;
  adminName?: string | null;
  title: string;
  body?: string;
  type: string;
  priority: string;
  deliveryMethod?: string;
  totalTargets: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  failureReasonSummary?: Record<string, number>;
  onlineOnly?: boolean;
  sentAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface NotificationHistoryInspectorResponse {
  entries: NotificationHistoryAdminRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

interface NotificationStatsInspectorResponse {
  windowDays: number;
  startDate: string;
  totalNotifications: number;
  totalRecipients: number;
  successfulRecipients: number;
  failedRecipients: number;
  averageSuccessRate: number;
  notificationsByType: Record<string, number>;
  notificationsByPriority: Record<string, number>;
  failureReasons: Record<string, number>;
  tenantBreakdown: Array<{ tenantId: string; tenantName?: string | null; count: number; failedDeliveries: number }>;
  lastSentAt?: string;
}

const notificationHistoryInspectorSchema = z.object({
  tenantId: z.string().trim().min(2).max(128).optional(),
  adminEmail: z.string().trim().email().optional(),
  limit: z.number().int().min(10).max(200).optional(),
  cursor: z.string().trim().optional(),
});

const notificationStatsInspectorSchema = z.object({
  tenantId: z.string().trim().min(2).max(128).optional(),
  adminEmail: z.string().trim().email().optional(),
  days: z.number().int().min(1).max(180).optional(),
});

type UsageMetricKey = 'students' | 'staff' | 'reminders' | 'storage';

interface UsageStorageSource {
  label: string;
  bytes: number;
}

interface UsageDiagnostics {
  warnings?: string[];
  generatedAt?: string;
}

interface UsageMetricStatus {
  value: number;
  limit: number;
  percentage: number;
  status: UsageStatus;
}

type UsageMetricStatusMap = Partial<Record<UsageMetricKey, UsageMetricStatus>>;

interface UsageAlertRecord {
  id: string;
  metric: UsageMetricKey;
  type: 'warning' | 'critical';
  createdAt: string;
  acknowledgedAt?: string | null;
  details?: string;
  value?: number;
  limit?: number;
  ratio?: number;
}

interface UsageSummaryResponse {
  tenantId: string;
  month: string;
  planId: PlanId;
  planLimits: PlanLimits;
  students: number;
  studentsAdded: number;
  staff: number;
  staffBreakdown?: {
    active: number;
    pendingInvites: number;
  };
  reminders: {
    total: number;
    whatsapp: number;
    sms: number;
    email: number;
    voice?: number;
    other?: number;
    inFlight?: {
      total: number;
      whatsapp: number;
      sms: number;
      email: number;
      voice: number;
    };
    reserved?: {
      total: number;
      whatsapp: number;
      sms: number;
      email: number;
      voice: number;
    };
    effectiveUsed?: number;
    effectiveRemaining?: number | null;
  };
  paymentsReceived?: {
    count: number;
    amount: number;
  };
  noticePosts: number;
  deviceActions: number;
  chatMessages: number | null;
  storageBytes: number;
  storageSources: UsageStorageSource[];
  alerts: UsageAlertRecord[];
  metricsVersion?: number;
  lastRefreshedAt?: string;
  diagnostics?: UsageDiagnostics;
  statuses: UsageMetricStatusMap;
}

interface UsageHistoryPoint {
  month: string;
  students: number;
  studentsAdded?: number;
  staff: number;
  remindersTotal: number;
  remindersWhatsApp?: number;
  remindersSms?: number;
  remindersEmail?: number;
  storageBytes: number;
  noticePosts?: number;
  deviceActions?: number;
  chatMessages?: number | null;
  paymentsReceivedCount?: number;
  paymentsReceivedAmount?: number;
}

interface BillingInvoiceRecord {
  id: string;
  invoiceNumber?: string;
  amountInr: number;
  status: 'paid' | 'open' | 'failed' | 'void' | 'uncollectible';
  issuedAt?: string;
  dueAt?: string;
  updatedAt?: string;
  downloadUrl?: string;
  provider?: string;
  planId?: string;
  planVariantId?: string;
  couponCode?: string;
  isSynthetic?: boolean;
  sourceEvent?: string;
  providerPaymentId?: string;
  providerSubscriptionId?: string;
  subscriptionId?: string;
  rawEvent?: string;
  payerEmail?: string;
  method?: string;
  upiVpaMasked?: string;
  cardLast4?: string;
  cardNetwork?: string;
  authorizedAt?: string;
  capturedAt?: string;
  failedAt?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  createdByEmail?: string;
  createdByRole?: string;
  errorCode?: string;
  errorDescription?: string;
}

interface BillingAuditEntryRecord {
  id: string;
  action: string;
  actorEmail?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

interface BillingHistoryCursor {
  at: string;
  id: string;
}

interface BillingHistoryPageInfo {
  invoices: {
    nextCursor?: BillingHistoryCursor;
  };
  changes: {
    nextCursor?: BillingHistoryCursor;
  };
}

interface BillingHistoryRecord {
  tenantId: string;
  timeZone?: string;
  invoices: BillingInvoiceRecord[];
  changes: BillingAuditEntryRecord[];
  totals?: {
    invoices?: number;
    changes?: number;
  };
  matchingTotals?: {
    invoices?: number;
    changes?: number;
  };
  pageInfo: BillingHistoryPageInfo;
}

const BILLING_ACTION_PREFIX_START = 'billing_';
// One char after '_' in ASCII, used for Firestore prefix range query.
const BILLING_ACTION_PREFIX_END = 'billing`';

async function countTenantBillingInvoices(
  db: FirebaseFirestore.Firestore,
  tenantId: string,
  options?: { status?: BillingInvoiceRecord['status'] }
): Promise<number> {
  let query: FirebaseFirestore.Query = db.collection('billingInvoices').doc(tenantId).collection('invoices');
  if (options?.status) {
    // Treat VOID as FAILED for filtering/counting in UI.
    // This keeps totals consistent with the “Failed” filter while preserving the stored status.
    if (options.status === 'failed') {
      query = query.where('status', 'in', ['failed', 'void']);
    } else {
      query = query.where('status', '==', options.status);
    }
  }

  const snap = await query.count().get();
  const raw = (snap.data() as any)?.count;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

async function countTenantBillingAuditEntries(db: FirebaseFirestore.Firestore, tenantId: string): Promise<number> {
  const query = db
    .collection('tenantAuditLogs')
    .where('tenantId', '==', tenantId)
    .where('action', '>=', BILLING_ACTION_PREFIX_START)
    .where('action', '<', BILLING_ACTION_PREFIX_END)
    .orderBy('action');

  const snap = await query.count().get();
  const raw = (snap.data() as any)?.count;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

interface BillingSummaryRecord {
  tenantId: string;
  planId: PlanId;
  planVariantId?: string;
  status: 'trial' | 'active' | 'delinquent' | 'canceled';
  renewalDate?: string;
  checkoutRequired?: boolean;
  subscriptionProvider?: 'razorpay' | 'google_play' | 'unknown';
  subscriptionProviderStatus?: string;
  subscriptionId?: string;
  cancelAtCycleEnd?: boolean;
  invoices: BillingInvoiceRecord[];
}

interface BillingCurrentRecord {
  tenantId: string;
  planId: PlanId;
  planVariantId?: string;
  couponCode?: string;
  // Where the active subscription is managed (when known).
  // This is used by clients to route plan-management actions to the correct surface (web vs app).
  subscriptionProvider?: 'razorpay' | 'google_play' | 'unknown';
  status: 'trial' | 'active' | 'delinquent' | 'canceled';
  renewalDate?: string;
  checkoutRequired?: boolean;
  checkoutRequiredSince?: string;
  checkoutRequiredProvider?: string;
  cancelAtCycleEnd?: boolean;
  scheduledDowngradePlanId?: PlanId;
  scheduledDowngradeAt?: string;
}

interface BillingCheckoutSessionRecord {
  tenantId: string;
  planId: PlanId;
  provider: 'stripe' | 'razorpay';
  successUrl?: string;
  cancelUrl?: string;
  checkoutUrl?: string;
  metadata?: Record<string, string>;
  createdAt: string;
  createdBy: string;
  createdByEmail?: string;
  status: 'pending';
}

const MONTH_ID_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_USAGE_HISTORY_MONTHS = 6;
const MAX_USAGE_HISTORY_MONTHS = 24;
const BYTES_PER_MB = 1024 * 1024;

const quotaValueSchema = z.union([z.number().int().min(0).max(1_000_000), z.null()]).optional();

const tenantQuotaUpdateSchema = z
  .object({
    tenantId: z.string().trim().min(6).max(120),
    quotas: z.object({
      maxStudents: quotaValueSchema,
      maxStaff: quotaValueSchema,
      maxMonthlyReminders: quotaValueSchema,
      maxMonthlyWhatsappReminders: quotaValueSchema,
      maxMonthlySmsReminders: quotaValueSchema,
      maxMonthlyEmailReminders: quotaValueSchema,
      maxMonthlyVoiceReminders: quotaValueSchema,
      maxStorageMb: quotaValueSchema,
    }),
    note: z.string().trim().max(300).optional(),
  })
  .refine((value) => Object.values(value.quotas).some((entry) => entry !== undefined), {
    message: 'At least one quota must be provided',
    path: ['quotas'],
  });

const tenantBillingPlanVariantUpdateSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
  planVariantId: z.string().trim().min(1).max(120),
  note: z.string().trim().max(300).optional(),
  cancelExistingSubscription: z.enum(['none', 'immediate', 'end_of_cycle']).optional(),
});

const billingCheckoutSchema = z.object({
  tenantId: z.string().trim().min(6).max(120).optional(),
  planId: z.enum(['free', 'pro', 'enterprise']).optional(),
  planVariantId: z.string().trim().min(1).max(80).optional(),
  couponCode: z.string().trim().max(40).optional(),
  provider: z.enum(['stripe', 'razorpay']).default('razorpay'),
  successUrl: z.string().trim().url().optional(),
  cancelUrl: z.string().trim().url().optional(),
  metadata: z.record(z.string().trim().max(200)).optional(),
});

const billingCheckoutSessionPublicSchema = z.object({
  sessionId: z.string().trim().min(8).max(200),
  tenantId: z.string().trim().min(6).max(120).optional(),
});

const billingManageLinkSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
});

const billingPlanVariantUpsertSchema = z.object({
  id: z.string().trim().min(1).max(80),
  planId: z.enum(['free', 'pro', 'enterprise']),
  displayName: z.string().trim().min(1).max(80),
  priceInr: z.number().int().min(0).max(500_000),
  interval: z.enum(['month']).default('month'),
  provider: z.enum(['razorpay']).default('razorpay'),
  razorpayPlanId: z.string().trim().max(200).optional(),
  // Optional Google Play product/subscription id for Android store billing.
  playProductId: z.string().trim().max(120).optional(),
  applyChangesMode: z.enum(['immediate', 'next_billing']).optional(),
  decreasePolicy: z.enum(['soft', 'hard']).optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  limits: z
    .object({
      staffSeats: z.number().int().min(0).max(100_000).optional(),
      students: z.number().int().min(0).max(1_000_000).optional(),
      storageMb: z.number().int().min(0).max(5_000_000).optional(),
      reminders: z
        .object({
          total: z.number().int().min(0).max(10_000_000).optional(),
          whatsapp: z.number().int().min(0).max(10_000_000).optional(),
          sms: z.number().int().min(0).max(10_000_000).optional(),
          voice: z.number().int().min(0).max(10_000_000).optional(),
          email: z.number().int().min(0).max(10_000_000).optional(),
        })
        .optional(),
    })
    .optional(),
});

const billingCouponUpsertSchema = z.object({
  id: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(40),
  mapsToPlanVariantId: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
  startsAt: z.string().trim().datetime().optional(),
  endsAt: z.string().trim().datetime().optional(),
});

const billingLimitsSnapshotBackfillSchema = z
  .object({
    tenantId: z.string().trim().min(6).max(120).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    force: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .refine((value) => {
    const dryRun = value.confirm ? false : value.dryRun ?? true;
    return dryRun || value.confirm === true;
  }, {
    message: 'Write mode requires confirm=true',
    path: ['confirm'],
  });

const billingTenantBackfillSchema = z
  .object({
    tenantId: z.string().trim().min(6).max(120),
    maxPaymentsPerSubscription: z.number().int().min(1).max(500).optional(),
    dryRun: z.boolean().optional(),
    verbose: z.boolean().optional(),
    confirm: z.boolean().optional(),
    jobLabel: z.string().trim().min(1).max(80).optional(),
  })
  .refine(
    (value) => {
      const dryRun = value.confirm ? false : value.dryRun ?? true;
      return dryRun || value.confirm === true;
    },
    {
      message: 'Write mode requires confirm=true',
      path: ['confirm'],
    }
  );

const billingSwitchToFreeSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
});

const billingSwitchToFreeImmediateSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
});

const playVerificationSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
  purchaseToken: z.string().trim().min(10),
  // Google Play subscription/product id.
  productId: z.string().trim().min(3).max(120),
  // Billing catalog selection used to compute limits snapshot.
  planVariantId: z.string().trim().min(1).max(80).optional(),
  // Optional client-provided ids for logging/UI.
  orderId: z.string().trim().max(200).optional(),
});

type GooglePlayServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

function parseGooglePlayServiceAccountFromEnv(): GooglePlayServiceAccount {
  const raw = (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) {
    throw new Error('google_play_unconfigured');
  }

  const parseJson = (text: string): GooglePlayServiceAccount => {
    const parsed = JSON.parse(text) as any;
    const email = typeof parsed?.client_email === 'string' ? parsed.client_email.trim() : '';
    const key = typeof parsed?.private_key === 'string' ? parsed.private_key : '';
    if (!email || !key) {
      throw new Error('google_play_invalid_service_account');
    }
    return {
      client_email: email,
      private_key: key,
      project_id: typeof parsed?.project_id === 'string' ? parsed.project_id : undefined,
    };
  };

  if (raw.startsWith('{')) {
    return parseJson(raw);
  }

  // Accept base64-encoded JSON as well.
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) {
      return parseJson(decoded);
    }
  } catch {
    // ignore
  }

  // Fall back to raw JSON parse to surface a helpful error.
  return parseJson(raw);
}

type CachedGooglePlayToken = { accessToken: string; expiresAtMs: number };
let cachedGooglePlayToken: CachedGooglePlayToken | null = null;

async function getGooglePlayAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedGooglePlayToken && cachedGooglePlayToken.expiresAtMs - now > 30_000) {
    return cachedGooglePlayToken.accessToken;
  }

  // Lazy import to keep top-level dependency surface small.
  const { JWT } = await import('google-auth-library');

  const sa = parseGooglePlayServiceAccountFromEnv();
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  const auth = await client.authorize();
  const token = typeof auth?.access_token === 'string' ? auth.access_token : '';
  if (!token) {
    throw new Error('google_play_token_failed');
  }
  const expiresAtMs = typeof auth?.expiry_date === 'number' && Number.isFinite(auth.expiry_date) ? auth.expiry_date : now + 50 * 60_000;
  cachedGooglePlayToken = { accessToken: token, expiresAtMs };
  return token;
}

type GooglePlaySubscriptionPurchase = {
  orderId?: string;
  expiryTimeMillis?: string;
  acknowledgementState?: number;
  paymentState?: number;
  cancelReason?: number;
  purchaseType?: number;
  purchaseState?: number;
  startTimeMillis?: string;
};

async function fetchGooglePlaySubscriptionPurchase(options: {
  packageName: string;
  productId: string;
  purchaseToken: string;
}): Promise<GooglePlaySubscriptionPurchase> {
  if (process.env.TEST_MODE === '1') {
    return {
      orderId: `test_${options.purchaseToken}`,
      expiryTimeMillis: String(Date.now() + 7 * 24 * 60 * 60_000),
      acknowledgementState: 1,
      paymentState: 1,
    };
  }

  const accessToken = await getGooglePlayAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}` +
    `/purchases/subscriptions/${encodeURIComponent(options.productId)}/tokens/${encodeURIComponent(options.purchaseToken)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const err = new Error(text || `google_play_fetch_failed_${resp.status}`);
    (err as any).status = resp.status;
    (err as any).providerPayload = json;
    throw err;
  }
  return (json || {}) as GooglePlaySubscriptionPurchase;
}

async function acknowledgeGooglePlaySubscription(options: {
  packageName: string;
  productId: string;
  purchaseToken: string;
}): Promise<void> {
  if (process.env.TEST_MODE === '1') {
    return;
  }

  const accessToken = await getGooglePlayAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}` +
    `/purchases/subscriptions/${encodeURIComponent(options.productId)}/tokens/${encodeURIComponent(options.purchaseToken)}/acknowledge`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(text || `google_play_ack_failed_${resp.status}`);
    (err as any).status = resp.status;
    throw err;
  }
}

async function cancelGooglePlaySubscription(options: {
  packageName: string;
  productId: string;
  purchaseToken: string;
}): Promise<void> {
  if (process.env.TEST_MODE === '1') {
    return;
  }

  const accessToken = await getGooglePlayAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}` +
    `/purchases/subscriptions/${encodeURIComponent(options.productId)}/tokens/${encodeURIComponent(options.purchaseToken)}:cancel`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (resp.ok) {
    return;
  }

  const text = await resp.text().catch(() => '');
  const err = new Error(text || `google_play_cancel_failed_${resp.status}`);
  (err as any).status = resp.status;
  throw err;
}

async function revokeGooglePlaySubscription(options: {
  packageName: string;
  productId: string;
  purchaseToken: string;
}): Promise<void> {
  if (process.env.TEST_MODE === '1') {
    return;
  }

  const accessToken = await getGooglePlayAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}` +
    `/purchases/subscriptions/${encodeURIComponent(options.productId)}/tokens/${encodeURIComponent(options.purchaseToken)}:revoke`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (resp.ok) {
    return;
  }

  const text = await resp.text().catch(() => '');
  const err = new Error(text || `google_play_revoke_failed_${resp.status}`);
  (err as any).status = resp.status;
  throw err;
}

const appStoreVerificationSchema = z.object({
  tenantId: z.string().trim().min(6).max(120),
  transactionId: z.string().trim().min(6).max(120),
  signedTransactionInfo: z.string().trim().min(20).optional(),
  bundleId: z.string().trim().min(3).max(120).optional(),
});

function coerceNumber(value: any): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function coerceString(value: any): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlanId(value?: string | null): PlanId {
  if (!value) {
    return 'free';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pro' || normalized === 'enterprise') {
    return normalized;
  }
  return 'free';
}

function formatMonthId(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function normalizeMonthId(value?: string | null): string {
  if (value && MONTH_ID_REGEX.test(value)) {
    return value;
  }
  return formatMonthId(new Date());
}

function buildMonthSeries(count: number): string[] {
  const clamped = Math.max(1, Math.min(count, MAX_USAGE_HISTORY_MONTHS));
  const months: string[] = [];
  const cursor = new Date();
  for (let i = 0; i < clamped; i += 1) {
    months.push(formatMonthId(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return months;
}

function safeNumber(value: any, fallback = 0): number {
  const parsed = coerceNumber(value);
  return typeof parsed === 'number' ? parsed : fallback;
}

function storageToBytes(snapshot: Record<string, any>): number {
  const bytes = coerceNumber(snapshot.storageBytes);
  if (typeof bytes === 'number') {
    return bytes;
  }
  const mb = coerceNumber(snapshot.storageMb);
  if (typeof mb === 'number') {
    return mb * BYTES_PER_MB;
  }
  return 0;
}

function formatUsageMetricValue(metric: UsageMetricKey, value: number): string {
  if (metric === 'storage') {
    const gb = value / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    }
    const mb = value / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }
  return value.toLocaleString('en-IN');
}

function buildUsageAlertDetails(
  metric: UsageMetricKey,
  monthId: string,
  ratio: number,
  value: number,
  limit: number,
  threshold: 'warning' | 'critical'
): string {
  const METRIC_LABELS: Record<UsageMetricKey, string> = {
    students: 'Students',
    staff: 'Team seats',
    reminders: 'Reminders',
    storage: 'Storage',
  };
  const metricLabel = METRIC_LABELS[metric] ?? metric;
  const percentage = Math.round(ratio * 100);
  const valueLabel = formatUsageMetricValue(metric, value);
  const limitLabel = formatUsageMetricValue(metric, limit);
  return threshold === 'critical'
    ? `${metricLabel} usage reached ${valueLabel} (${percentage}% of ${limitLabel}) for ${monthId}. Clear space or upgrade to restore full access.`
    : `${metricLabel} usage is at ${percentage}% (${valueLabel} of ${limitLabel}) for ${monthId}. Review usage before limits are enforced.`;
}

function deriveStaffCount(summary?: TenantAdminSummary | null): number {
  if (!summary?.membershipCounts) {
    return 0;
  }
  const owners = safeNumber(summary.membershipCounts.owners, 0);
  const admins = safeNumber(summary.membershipCounts.admins, 0);
  const staff = safeNumber(summary.membershipCounts.staff, 0);
  return owners + admins + staff;
}

async function countActiveStaffSeatsLive(db: any, tenantId: string): Promise<number> {
  try {
    const snapshot = await db
      .collection('tenantMemberships')
      .where('tenantId', '==', tenantId)
      .where('status', '==', 'active')
      .get();
    if (!snapshot || snapshot.empty) {
      return 0;
    }
    let count = 0;
    snapshot.forEach((doc: any) => {
      const role = (doc?.data?.()?.role || '').toString().toLowerCase();
      if (role === 'owner' || role === 'admin' || role === 'staff') {
        count += 1;
      }
    });
    return count;
  } catch {
    return -1;
  }
}

type LiveCountCacheEntry = {
  value: number;
  fetchedAtMs: number;
};

const LIVE_COUNT_CACHE_TTL_MS = Math.max(0, Number(process.env.LIVE_COUNT_CACHE_TTL_MS ?? '10000'));
const liveCountCache = new Map<string, LiveCountCacheEntry>();
const liveCountInFlight = new Map<string, Promise<number>>();

async function getCachedLiveCount(cacheKey: string, fetcher: () => Promise<number>): Promise<number> {
  if (!Number.isFinite(LIVE_COUNT_CACHE_TTL_MS) || LIVE_COUNT_CACHE_TTL_MS <= 0) {
    return fetcher();
  }

  const now = Date.now();
  const cached = liveCountCache.get(cacheKey);
  if (cached && now - cached.fetchedAtMs < LIVE_COUNT_CACHE_TTL_MS) {
    return cached.value;
  }

  const existing = liveCountInFlight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const value = await fetcher();
      if (typeof value === 'number' && value >= 0) {
        liveCountCache.set(cacheKey, { value, fetchedAtMs: Date.now() });
      }
      return value;
    } finally {
      liveCountInFlight.delete(cacheKey);
    }
  })();

  liveCountInFlight.set(cacheKey, promise);
  return promise;
}

function invalidateLiveCount(cacheKey: string): void {
  liveCountCache.delete(cacheKey);
  liveCountInFlight.delete(cacheKey);
}

async function countActiveStudentsLive(db: any, tenantId: string): Promise<number> {
  try {
    const snapshot = await db
      .collection('students')
      .where('tenantId', '==', tenantId)
      .where('status', '==', 'active')
      .get();
    if (!snapshot || snapshot.empty) {
      return 0;
    }
    return snapshot.size;
  } catch {
    return -1;
  }
}

async function countActiveStaffSeatsLiveCached(db: any, tenantId: string): Promise<number> {
  return getCachedLiveCount(`staffSeats:${tenantId}`, () => countActiveStaffSeatsLive(db, tenantId));
}

async function countPendingSeatInvitesLiveCached(db: any, tenantId: string): Promise<number> {
  return getCachedLiveCount(`staffInvites:${tenantId}`, () => countPendingSeatInvitesLive(db, tenantId));
}

async function countActiveStudentsLiveCached(db: any, tenantId: string): Promise<number> {
  return getCachedLiveCount(`students:${tenantId}`, () => countActiveStudentsLive(db, tenantId));
}

async function readTenantStorageBytesLive(db: any, tenantId: string): Promise<number> {
  try {
    const snap = await db.collection('tenantStorageUsage').doc(tenantId).get();
    if (!snap.exists) {
      return -1;
    }
    const bytes = (snap.data() as any)?.bytes;
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) {
      return bytes;
    }
    return -1;
  } catch {
    return -1;
  }
}

async function readTenantStorageBytesLiveCached(db: any, tenantId: string): Promise<number> {
  return getCachedLiveCount(`storageBytes:${tenantId}`, () => readTenantStorageBytesLive(db, tenantId));
}

async function countPendingSeatInvitesLive(db: any, tenantId: string): Promise<number> {
  try {
    const snapshot = await db
      .collection('tenantInvites')
      .where('tenantId', '==', tenantId)
      .where('status', '==', 'pending')
      .get();
    if (!snapshot || snapshot.empty) {
      return 0;
    }
    let count = 0;
    snapshot.forEach((doc: any) => {
      const role = (doc?.data?.()?.role || '').toString().toLowerCase();
      if (role === 'owner' || role === 'admin' || role === 'staff') {
        count += 1;
      }
    });
    return count;
  } catch {
    return -1;
  }
}

function buildUsageMetricStatus(value: number, limit: number): UsageMetricStatus | null {
  if (!Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return {
    value,
    limit,
    percentage: getUsagePercentage(value, limit),
    status: getUsageStatus(value, limit),
  } satisfies UsageMetricStatus;
}

function normalizeStorageSources(value: any): UsageStorageSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: UsageStorageSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const labelRaw = typeof entry.label === 'string' ? entry.label.trim() : '';
    const label = labelRaw || 'unspecified';
    const bytes = safeNumber(entry.bytes ?? entry.size ?? 0, 0);
    normalized.push({ label, bytes });
  }
  return normalized;
}

function normalizeUsageDiagnostics(value: any): UsageDiagnostics | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const warnings = Array.isArray((value as any).warnings)
    ? (value as any).warnings.filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const generatedAt = toIsoTimestamp((value as any).generatedAt);
  if (!warnings?.length && !generatedAt) {
    return undefined;
  }
  return {
    warnings: warnings?.length ? warnings : undefined,
    generatedAt,
  } satisfies UsageDiagnostics;
}

async function loadUsageMonthSnapshot(
  db: admin.firestore.Firestore,
  tenantId: string,
  monthId: string
): Promise<{ ref: admin.firestore.DocumentReference | null; data: Record<string, any> }>
{
  const parentRef = db.collection('tenantUsage').doc(tenantId);
  const candidates: admin.firestore.DocumentReference[] = [
    parentRef.collection('months').doc(monthId),
    db.collection('tenantUsage').doc(`${tenantId}_${monthId}`),
  ];

  for (const candidate of candidates) {
    try {
      const snap = await candidate.get();
      if (snap.exists) {
        return { ref: candidate, data: snap.data() || {} };
      }
    } catch (error) {
      console.warn('[usage] failed to load snapshot', candidate.path, error);
    }
  }

  return { ref: null, data: {} };
}

async function loadUsageAlerts(
  docRef: admin.firestore.DocumentReference | null,
  monthId: string,
  limit = 20
): Promise<UsageAlertRecord[]>
{
  if (!docRef) {
    return [];
  }
  try {
    const snapshot = await docRef
      .collection('alerts')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    if (snapshot.empty) {
      return [];
    }
    return snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      const metric = (typeof data.metric === 'string' ? data.metric : 'reminders') as UsageMetricKey;
      const type = data.type === 'critical' ? 'critical' : 'warning';
      return {
        id: `${monthId}:${doc.id}`,
        metric,
        type,
        createdAt: toIsoTimestamp(data.createdAt) ?? new Date().toISOString(),
        acknowledgedAt: toIsoTimestamp(data.acknowledgedAt) ?? null,
        details: typeof data.details === 'string' ? data.details : undefined,
        value: coerceNumber(data.value),
        limit: coerceNumber(data.limit),
        ratio: coerceNumber(data.ratio),
      } satisfies UsageAlertRecord;
    });
  } catch (error) {
    console.warn('[usage] failed to load alerts', docRef.path, error);
    return [];
  }
}

async function loadBillingInvoices(
  db: admin.firestore.Firestore,
  tenantId: string,
  limit = 10
): Promise<BillingInvoiceRecord[]>
{
  try {
    const snapshot = await db
      .collection('billingInvoices')
      .doc(tenantId)
      .collection('invoices')
      .orderBy('issuedAt', 'desc')
      .limit(limit)
      .get();
    if (snapshot.empty) {
      return [];
    }
    return snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        invoiceNumber: typeof data.invoiceNumber === 'string' ? data.invoiceNumber : undefined,
        amountInr: safeNumber(data.amountInr ?? data.amount ?? 0, 0),
        status: (data.status || 'open') as BillingInvoiceRecord['status'],
        issuedAt: toIsoTimestamp(data.issuedAt) ?? undefined,
        dueAt: toIsoTimestamp(data.dueAt) ?? undefined,
        updatedAt:
          toIsoTimestamp(data.updatedAt) ?? (doc.updateTime ? doc.updateTime.toDate().toISOString() : undefined),
        downloadUrl: typeof data.downloadUrl === 'string' ? data.downloadUrl : undefined,
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        planId: typeof data.planId === 'string' ? data.planId : undefined,
        planVariantId: typeof data.planVariantId === 'string' ? data.planVariantId : undefined,
        couponCode: typeof data.couponCode === 'string' ? data.couponCode : undefined,
        isSynthetic: typeof data.isSynthetic === 'boolean' ? data.isSynthetic : undefined,
        sourceEvent: typeof data.sourceEvent === 'string' ? data.sourceEvent : undefined,
        providerPaymentId: typeof data.providerPaymentId === 'string' ? data.providerPaymentId : undefined,
        providerSubscriptionId: typeof data.providerSubscriptionId === 'string' ? data.providerSubscriptionId : undefined,
        subscriptionId: typeof data.subscriptionId === 'string' ? data.subscriptionId : undefined,
        rawEvent: typeof data.rawEvent === 'string' ? data.rawEvent : undefined,
        payerEmail: typeof data.payerEmail === 'string' ? data.payerEmail : undefined,
        method: typeof data.method === 'string' ? data.method : undefined,
        upiVpaMasked: typeof data.upiVpaMasked === 'string' ? data.upiVpaMasked : undefined,
        cardLast4: typeof data.cardLast4 === 'string' ? data.cardLast4 : undefined,
        cardNetwork: typeof data.cardNetwork === 'string' ? data.cardNetwork : undefined,
        authorizedAt: toIsoTimestamp(data.authorizedAt) ?? undefined,
        capturedAt: toIsoTimestamp(data.capturedAt) ?? undefined,
        failedAt: toIsoTimestamp(data.failedAt) ?? undefined,
        billingPeriodStart: toIsoTimestamp(data.billingPeriodStart) ?? undefined,
        billingPeriodEnd: toIsoTimestamp(data.billingPeriodEnd) ?? undefined,
        createdByEmail: typeof data.createdByEmail === 'string' ? data.createdByEmail : undefined,
        createdByRole: typeof data.createdByRole === 'string' ? data.createdByRole : undefined,
        errorCode: typeof data.errorCode === 'string' ? data.errorCode : undefined,
        errorDescription: typeof data.errorDescription === 'string' ? data.errorDescription : undefined,
      } satisfies BillingInvoiceRecord;
    });
  } catch (error) {
    console.warn('[billing] failed to load invoices for', tenantId, error);
    return [];
  }
}

async function loadBillingInvoicesPage(
  db: admin.firestore.Firestore,
  tenantId: string,
  limit: number,
  cursor?: BillingHistoryCursor,
  options?: { status?: BillingInvoiceRecord['status'] }
): Promise<{ invoices: BillingInvoiceRecord[]; nextCursor?: BillingHistoryCursor }>
{
  const normalizedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  try {
    let query: FirebaseFirestore.Query = db.collection('billingInvoices').doc(tenantId).collection('invoices');
    if (options?.status) {
      // Treat VOID as FAILED for filtering in UI.
      if (options.status === 'failed') {
        query = query.where('status', 'in', ['failed', 'void']);
      } else {
        query = query.where('status', '==', options.status);
      }
    }
    query = query.orderBy('issuedAt', 'desc').orderBy(admin.firestore.FieldPath.documentId(), 'desc');

    if (cursor?.at && cursor?.id) {
      query = query.startAfter(cursor.at, cursor.id);
    }

    const snapshot = await query.limit(normalizedLimit + 1).get();
    if (snapshot.empty) {
      return { invoices: [] };
    }

    const docs = snapshot.docs.slice(0, normalizedLimit);
    const invoices = docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        invoiceNumber: typeof data.invoiceNumber === 'string' ? data.invoiceNumber : undefined,
        amountInr: safeNumber(data.amountInr ?? data.amount ?? 0, 0),
        status: (data.status || 'open') as BillingInvoiceRecord['status'],
        issuedAt: toIsoTimestamp(data.issuedAt) ?? undefined,
        dueAt: toIsoTimestamp(data.dueAt) ?? undefined,
        updatedAt:
          toIsoTimestamp(data.updatedAt) ?? (doc.updateTime ? doc.updateTime.toDate().toISOString() : undefined),
        downloadUrl: typeof data.downloadUrl === 'string' ? data.downloadUrl : undefined,
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        planId: typeof data.planId === 'string' ? data.planId : undefined,
        planVariantId: typeof data.planVariantId === 'string' ? data.planVariantId : undefined,
        couponCode: typeof data.couponCode === 'string' ? data.couponCode : undefined,
        isSynthetic: typeof data.isSynthetic === 'boolean' ? data.isSynthetic : undefined,
        sourceEvent: typeof data.sourceEvent === 'string' ? data.sourceEvent : undefined,
        providerPaymentId: typeof data.providerPaymentId === 'string' ? data.providerPaymentId : undefined,
        providerSubscriptionId: typeof data.providerSubscriptionId === 'string' ? data.providerSubscriptionId : undefined,
        subscriptionId: typeof data.subscriptionId === 'string' ? data.subscriptionId : undefined,
        rawEvent: typeof data.rawEvent === 'string' ? data.rawEvent : undefined,
        payerEmail: typeof data.payerEmail === 'string' ? data.payerEmail : undefined,
        method: typeof data.method === 'string' ? data.method : undefined,
        upiVpaMasked: typeof data.upiVpaMasked === 'string' ? data.upiVpaMasked : undefined,
        cardLast4: typeof data.cardLast4 === 'string' ? data.cardLast4 : undefined,
        cardNetwork: typeof data.cardNetwork === 'string' ? data.cardNetwork : undefined,
        authorizedAt: toIsoTimestamp(data.authorizedAt) ?? undefined,
        capturedAt: toIsoTimestamp(data.capturedAt) ?? undefined,
        failedAt: toIsoTimestamp(data.failedAt) ?? undefined,
        billingPeriodStart: toIsoTimestamp(data.billingPeriodStart) ?? undefined,
        billingPeriodEnd: toIsoTimestamp(data.billingPeriodEnd) ?? undefined,
        createdByEmail: typeof data.createdByEmail === 'string' ? data.createdByEmail : undefined,
        createdByRole: typeof data.createdByRole === 'string' ? data.createdByRole : undefined,
        errorCode: typeof data.errorCode === 'string' ? data.errorCode : undefined,
        errorDescription: typeof data.errorDescription === 'string' ? data.errorDescription : undefined,
      } satisfies BillingInvoiceRecord;
    });

    const hasMore = snapshot.docs.length > normalizedLimit;
    if (!hasMore || invoices.length === 0) {
      return { invoices };
    }

    const lastDoc = docs[docs.length - 1];
    const lastData = lastDoc.data() || {};
    const issuedAtRaw = typeof lastData.issuedAt === 'string' ? lastData.issuedAt : toIsoTimestamp(lastData.issuedAt);
    const issuedAt = issuedAtRaw || '';
    return {
      invoices,
      nextCursor: issuedAt ? { at: issuedAt, id: lastDoc.id } : { at: new Date(0).toISOString(), id: lastDoc.id },
    };
  } catch (error) {
    console.warn('[billing] failed to load invoices page for', tenantId, error);
    return { invoices: [] };
  }
}

async function loadTenantBillingAuditEntries(
  db: admin.firestore.Firestore,
  tenantId: string,
  limit = 50
): Promise<BillingAuditEntryRecord[]>
{
  const normalizedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  try {
    // Avoid composite index requirements by querying by tenantId + createdAt desc,
    // then filtering billing-related actions in-memory.
    const snapshot = await db
      .collection('tenantAuditLogs')
      .where('tenantId', '==', tenantId)
      .orderBy('createdAt', 'desc')
      .limit(Math.max(200, normalizedLimit * 4))
      .get();

    if (snapshot.empty) {
      return [];
    }

    const entries = snapshot.docs
      .map((doc) => {
        const data = doc.data() || {};
        const action = typeof data.action === 'string' ? data.action : '';
        return {
          id: doc.id,
          action,
          actorEmail: typeof data.actorEmail === 'string' ? data.actorEmail : undefined,
          createdAt: toIsoTimestamp(data.createdAt) ?? undefined,
          metadata: typeof data.metadata === 'object' && data.metadata ? (data.metadata as Record<string, unknown>) : undefined,
        } satisfies BillingAuditEntryRecord;
      })
      .filter((entry) => entry.action.startsWith('billing_'))
      .slice(0, normalizedLimit);

    return entries;
  } catch (error) {
    console.warn('[billing] failed to load billing audit entries for', tenantId, error);
    return [];
  }
}

async function loadTenantBillingAuditEntriesPage(
  db: admin.firestore.Firestore,
  tenantId: string,
  limit: number,
  cursor?: BillingHistoryCursor
): Promise<{ changes: BillingAuditEntryRecord[]; nextCursor?: BillingHistoryCursor }>
{
  const normalizedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const batchSize = Math.max(50, Math.min(200, normalizedLimit * 6));

  try {
    let scanCursor = cursor;
    const out: BillingAuditEntryRecord[] = [];
    let hasMore = false;
    let lastConsidered: { at: string; id: string } | null = null;

    for (let i = 0; i < 5 && out.length < normalizedLimit; i += 1) {
      let query = db
        .collection('tenantAuditLogs')
        .where('tenantId', '==', tenantId)
        .orderBy('createdAt', 'desc')
        .orderBy(admin.firestore.FieldPath.documentId(), 'desc');

      if (scanCursor?.at && scanCursor?.id) {
        query = query.startAfter(scanCursor.at, scanCursor.id);
      }

      const snapshot = await query.limit(batchSize).get();
      if (snapshot.empty) {
        hasMore = false;
        break;
      }

      for (const doc of snapshot.docs) {
        const data = doc.data() || {};
        const createdAtRaw = typeof data.createdAt === 'string' ? data.createdAt : toIsoTimestamp(data.createdAt);
        const createdAt = createdAtRaw || '';
        lastConsidered = { at: createdAt || new Date(0).toISOString(), id: doc.id };

        const action = typeof data.action === 'string' ? data.action : '';
        if (!action.startsWith('billing_')) {
          continue;
        }

        out.push({
          id: doc.id,
          action,
          actorEmail: typeof data.actorEmail === 'string' ? data.actorEmail : undefined,
          createdAt: toIsoTimestamp(data.createdAt) ?? undefined,
          metadata:
            typeof data.metadata === 'object' && data.metadata ? (data.metadata as Record<string, unknown>) : undefined,
        } satisfies BillingAuditEntryRecord);

        if (out.length >= normalizedLimit) {
          hasMore = true;
          break;
        }
      }

      if (out.length >= normalizedLimit) {
        break;
      }

      // If we fetched a full batch, there might be more.
      hasMore = snapshot.docs.length >= batchSize;
      if (!hasMore) {
        break;
      }
      scanCursor = lastConsidered || scanCursor;
    }

    if (!hasMore || !lastConsidered) {
      return { changes: out };
    }

    return { changes: out.slice(0, normalizedLimit), nextCursor: lastConsidered };
  } catch (error) {
    console.warn('[billing] failed to load billing audit entries page for', tenantId, error);
    return { changes: [] };
  }
}

async function loadTenantBillingSummary(
  db: admin.firestore.Firestore,
  tenantId: string,
  fallbackPlanId: PlanId
): Promise<BillingSummaryRecord>
{
  try {
    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    const data = billingSnap.exists ? billingSnap.data() || {} : {};
    const planId = normalizePlanId((data.planId as string) || (data.plan as string) || fallbackPlanId);
    const planVariantId = typeof data.planVariantId === 'string' && data.planVariantId.trim() ? data.planVariantId.trim() : undefined;

    const billingProviderRaw =
      typeof (data as any).billingProvider === 'string' ? String((data as any).billingProvider).trim().toLowerCase() : '';
    const subscriptionProvider =
      billingProviderRaw === 'razorpay'
        ? 'razorpay'
        : billingProviderRaw === 'google_play' || billingProviderRaw === 'play'
          ? 'google_play'
          : billingProviderRaw
            ? 'unknown'
            : undefined;
    const subscriptionId = typeof (data as any).subscriptionId === 'string' && (data as any).subscriptionId.trim()
      ? String((data as any).subscriptionId).trim()
      : undefined;
    const cancelAtCycleEnd = typeof (data as any).cancelAtCycleEnd === 'boolean' ? Boolean((data as any).cancelAtCycleEnd) : undefined;

    const statusRaw = typeof data.status === 'string' ? data.status.toLowerCase() : undefined;
    let status = (statusRaw === 'active' || statusRaw === 'delinquent' || statusRaw === 'canceled'
      ? statusRaw
      : planId === 'free'
        ? 'trial'
        : 'active') as BillingSummaryRecord['status'];
    let renewalDate = toIsoTimestamp(data.renewalDate ?? data.renewsAt ?? data.renewalAt) ?? undefined;
    let subscriptionProviderStatus: string | undefined;
    // A Free plan should never be shown as "pending".
    let checkoutRequired = planId === 'free' ? false : typeof data.checkoutRequired === 'boolean' ? data.checkoutRequired : undefined;
    const invoices = await loadBillingInvoices(db, tenantId);

    const planLockedByOrg = (data as any).planLockedByOrg === true;
    const subscriptionIgnoredByAdmin = Boolean(subscriptionId) && subscriptionId?.includes('__ignored_by_admin_override__');
    if (
      subscriptionProvider === 'razorpay' &&
      subscriptionId &&
      (status === 'active' || status === 'delinquent') &&
      !planLockedByOrg &&
      !subscriptionIgnoredByAdmin
    ) {
      try {
        const fetched = await fetchRazorpaySubscription({ subscriptionId });
        const providerStatus = (fetched.status || '').trim().toLowerCase();
        subscriptionProviderStatus = providerStatus || undefined;
        if (providerStatus === 'cancelled' || providerStatus === 'expired' || providerStatus === 'completed') {
          status = 'canceled';
          renewalDate = undefined;
          if (billingSnap.exists) {
            await billingSnap.ref.set(
              {
                status: 'canceled',
                renewalDate: null,
                cancelAtCycleEnd: false,
                checkoutRequired: false,
                checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
                checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
        } else if (providerStatus === 'created' || providerStatus === 'pending') {
          status = planId === 'free' ? 'trial' : 'delinquent';
          renewalDate = undefined;
          checkoutRequired = planId === 'free' ? false : true;
        }
      } catch (error) {
        console.warn('[billing] failed to reconcile razorpay subscription status', tenantId, subscriptionId, error);
      }
    }
    return {
      tenantId,
      planId,
      planVariantId,
      status,
      renewalDate,
      ...(subscriptionProvider ? { subscriptionProvider } : {}),
      ...(subscriptionProviderStatus ? { subscriptionProviderStatus } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(typeof cancelAtCycleEnd === 'boolean' ? { cancelAtCycleEnd } : {}),
      ...(typeof checkoutRequired === 'boolean' ? { checkoutRequired } : {}),
      invoices,
    } satisfies BillingSummaryRecord;
  } catch (error) {
    console.warn('[billing] failed to load tenant billing summary', tenantId, error);
    return {
      tenantId,
      planId: fallbackPlanId,
      status: fallbackPlanId === 'free' ? 'trial' : 'active',
      invoices: [],
    } satisfies BillingSummaryRecord;
  }
}

async function loadTenantCurrentBilling(
  db: admin.firestore.Firestore,
  tenantId: string,
  fallbackPlanId: PlanId
): Promise<BillingCurrentRecord>
{
  try {
    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    const data = billingSnap.exists ? billingSnap.data() || {} : {};
    const planId = normalizePlanId((data.planId as string) || (data.plan as string) || fallbackPlanId);

    const billingProviderRaw =
      typeof (data as any).billingProvider === 'string' ? String((data as any).billingProvider).trim().toLowerCase() : '';
    const subscriptionProvider =
      billingProviderRaw === 'razorpay'
        ? 'razorpay'
        : billingProviderRaw === 'google_play' || billingProviderRaw === 'play'
          ? 'google_play'
          : billingProviderRaw
            ? 'unknown'
            : undefined;

    const statusRaw = typeof data.status === 'string' ? data.status.toLowerCase() : undefined;
    const status = (statusRaw === 'active' || statusRaw === 'delinquent' || statusRaw === 'canceled'
      ? statusRaw
      : planId === 'free'
        ? 'trial'
        : 'active') as BillingCurrentRecord['status'];
    const renewalDate = toIsoTimestamp(data.renewalDate ?? data.renewsAt ?? data.renewalAt) ?? undefined;
    const planVariantId = typeof data.planVariantId === 'string' && data.planVariantId.trim() ? data.planVariantId.trim() : undefined;
    const couponCode = typeof data.couponCode === 'string' && data.couponCode.trim() ? data.couponCode.trim() : undefined;
    const planLockedByOrg = (data as any).planLockedByOrg === true;
    const storedCheckoutRequired = typeof (data as any).checkoutRequired === 'boolean' ? (data as any).checkoutRequired : undefined;
    const storedCheckoutRequiredProvider =
      typeof (data as any).checkoutRequiredProvider === 'string' && (data as any).checkoutRequiredProvider.trim()
        ? (data as any).checkoutRequiredProvider.trim()
        : undefined;
    const storedCheckoutRequiredSince =
      toIsoTimestamp((data as any).checkoutRequiredSinceIso ?? (data as any).checkoutRequiredSince ?? (data as any).checkoutRequiredAtIso) ??
      undefined;

    let invoiceCheckoutRequired = false;
    let invoiceCheckoutRequiredSince: string | undefined;
    let invoiceCheckoutRequiredProvider: string | undefined;
    try {
      // If the tenant is on Free, do not surface any lingering open invoices as "payment pending".
      if (planId !== 'free' && !planLockedByOrg) {
        const invoiceSnap = await db
          .collection('billingInvoices')
          .doc(tenantId)
          .collection('invoices')
          .where('status', '==', 'open')
          .orderBy('issuedAt', 'desc')
          .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
          .limit(1)
          .get();
        if (!invoiceSnap.empty) {
          const inv = invoiceSnap.docs[0]?.data() || {};

          // Razorpay UPI AutoPay/mandate flows can emit `subscription.authenticated` before actual
          // payment capture. We record a synthetic "open" invoice for history, but it should not
          // be treated as a pending/dues state that requires payment-method update.
          const sourceEvent = typeof (inv as any).sourceEvent === 'string' ? String((inv as any).sourceEvent).trim() : '';
          const rawEvent = typeof (inv as any).rawEvent === 'string' ? String((inv as any).rawEvent).trim() : '';
          const isSynthetic = (inv as any).isSynthetic === true;
          const autopayEvent = (sourceEvent || rawEvent) as string;
          const isAutopayAuthenticated =
            isSynthetic &&
            (autopayEvent === 'subscription.authenticated' ||
              // Razorpay can emit `subscription.activated` for UPI AutoPay/mandate flows
              // before the first charge is actually captured.
              autopayEvent === 'subscription.activated');

          invoiceCheckoutRequired = true;
          invoiceCheckoutRequiredSince = toIsoTimestamp((inv as any).issuedAt ?? (inv as any).createdAt) ?? undefined;
          const invProvider = typeof (inv as any).provider === 'string' ? (inv as any).provider : undefined;
          invoiceCheckoutRequiredProvider = isAutopayAuthenticated ? 'razorpay_autopay' : invProvider;
        }
      }
    } catch (error) {
      // Best-effort: still return stored checkoutRequired if present.
      console.warn('[billing] failed to check open invoices for', tenantId, error);
    }

    const checkoutRequired = planId === 'free' || planLockedByOrg
      ? false
      : invoiceCheckoutRequired || storedCheckoutRequired === true
        ? true
        : storedCheckoutRequired;
    const checkoutRequiredSince = planId === 'free' || planLockedByOrg
      ? undefined
      : invoiceCheckoutRequiredSince ?? storedCheckoutRequiredSince;
    const checkoutRequiredProvider = planId === 'free' || planLockedByOrg
      ? undefined
      : invoiceCheckoutRequiredProvider ?? storedCheckoutRequiredProvider;
    const cancelAtCycleEnd = typeof (data as any).cancelAtCycleEnd === 'boolean' ? (data as any).cancelAtCycleEnd : undefined;
    const scheduledDowngradePlanIdRaw =
      typeof (data as any).scheduledDowngradePlanId === 'string' ? (data as any).scheduledDowngradePlanId.trim().toLowerCase() : '';
    const scheduledDowngradePlanId =
      scheduledDowngradePlanIdRaw === 'free' || scheduledDowngradePlanIdRaw === 'pro' || scheduledDowngradePlanIdRaw === 'enterprise'
        ? (scheduledDowngradePlanIdRaw as PlanId)
        : undefined;
    const scheduledDowngradeAt =
      typeof (data as any).scheduledDowngradeAt === 'string' && (data as any).scheduledDowngradeAt.trim()
        ? (data as any).scheduledDowngradeAt.trim()
        : undefined;
    return {
      tenantId,
      planId,
      planVariantId,
      couponCode,
      ...(subscriptionProvider ? { subscriptionProvider } : {}),
      status,
      renewalDate,
      ...(typeof checkoutRequired === 'boolean' ? { checkoutRequired } : {}),
      ...(checkoutRequiredSince ? { checkoutRequiredSince } : {}),
      ...(checkoutRequiredProvider ? { checkoutRequiredProvider } : {}),
      ...(typeof cancelAtCycleEnd === 'boolean' ? { cancelAtCycleEnd } : {}),
      ...(scheduledDowngradePlanId ? { scheduledDowngradePlanId } : {}),
      ...(scheduledDowngradeAt ? { scheduledDowngradeAt } : {}),
    } satisfies BillingCurrentRecord;
  } catch (error) {
    console.warn('[billing] failed to load tenant current billing', tenantId, error);
    return {
      tenantId,
      planId: fallbackPlanId,
      status: fallbackPlanId === 'free' ? 'trial' : 'active',
    } satisfies BillingCurrentRecord;
  }
}

async function loadTenantAdminSummaryRecord(
  db: admin.firestore.Firestore,
  tenantId: string
): Promise<TenantAdminSummary | null>
{
  try {
    const tenantSnap = await db.collection('tenants').doc(tenantId).get();
    if (!tenantSnap.exists) {
      return null;
    }
    return serializeTenantAdminSummary(tenantSnap);
  } catch (error) {
    console.warn('[tenant_admin_summary] failed', tenantId, error);
    return null;
  }
}

function parseUsageAlertCompositeId(value: string): { monthId: string; alertId: string } | null {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }
  const monthId = value.slice(0, separatorIndex);
  const alertId = value.slice(separatorIndex + 1);
  if (!MONTH_ID_REGEX.test(monthId) || !alertId) {
    return null;
  }
  return { monthId, alertId };
}

function billingWebhooksFeatureEnabled(): boolean {
  return process.env.BILLING_WEBHOOKS_ENABLED === '1';
}

function extractRawBody(body: unknown): string {
  if (!body) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Buffer) {
    return body.toString('utf8');
  }
  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

function storeBillingFeatureEnabled(): boolean {
  return process.env.STORE_BILLING_ENABLED === '1';
}

function serializeTenantAdminSummary(
  doc: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>
): TenantAdminSummary {
  const data = doc.data() || {};
  const quotasRaw = typeof data.quotas === 'object' && data.quotas ? data.quotas : undefined;
  const membershipCountsRaw =
    typeof data.membershipCounts === 'object' && data.membershipCounts ? data.membershipCounts : undefined;
  const settingsRaw = typeof data.settings === 'object' && data.settings ? data.settings : undefined;
  const brandingRaw = typeof data.branding === 'object' && data.branding ? data.branding : undefined;

  const owners = coerceNumber(membershipCountsRaw?.owners) ?? 0;
  const admins = coerceNumber(membershipCountsRaw?.admins) ?? 0;
  const staff = coerceNumber(membershipCountsRaw?.staff) ?? 0;
  const adminSeatLimit = coerceNumber(quotasRaw?.maxStaff) ?? null;
  const adminSeatsUsed = owners + admins + staff;
  const remaining = adminSeatLimit === null ? null : Math.max(adminSeatLimit - adminSeatsUsed, 0);

  const brandingNormalized = brandingRaw
    ? {
        logoUrl: coerceString(brandingRaw.logoUrl),
        heroImageUrl: coerceString(brandingRaw.heroImageUrl),
        accentImageUrl: coerceString(brandingRaw.accentImageUrl),
        tagline: coerceString(brandingRaw.tagline),
        missionStatement: coerceString(brandingRaw.missionStatement),
      }
    : undefined;
  const resolvedLogoUrl = coerceString(data.logoUrl) ?? brandingNormalized?.logoUrl ?? null;
  const resolvedHeroImageUrl = coerceString(data.heroImageUrl) ?? brandingNormalized?.heroImageUrl ?? null;

  return {
    id: doc.id,
    name: typeof data.name === 'string' ? data.name : undefined,
    slug: typeof data.slug === 'string' ? data.slug : undefined,
    code: typeof data.code === 'string' ? data.code : undefined,
    status: typeof data.status === 'string' ? data.status : undefined,
    billingTier: typeof data.billingTier === 'string' ? data.billingTier : undefined,
    ownerEmail: typeof data.ownerEmail === 'string' ? data.ownerEmail : undefined,
    ownerUserId: typeof data.ownerUserId === 'string' ? data.ownerUserId : undefined,
    contactEmail: typeof data.contactEmail === 'string' ? data.contactEmail : undefined,
    contactPhone: typeof data.contactPhone === 'string' ? data.contactPhone : undefined,
    logoUrl: resolvedLogoUrl,
    heroImageUrl: resolvedHeroImageUrl,
    quotas: quotasRaw
      ? {
          maxStudents: coerceNumber(quotasRaw.maxStudents),
          maxStaff: coerceNumber(quotasRaw.maxStaff),
          maxMonthlyReminders: coerceNumber(quotasRaw.maxMonthlyReminders),
          maxMonthlyWhatsappReminders: coerceNumber(quotasRaw.maxMonthlyWhatsappReminders),
          maxMonthlySmsReminders: coerceNumber(quotasRaw.maxMonthlySmsReminders),
          maxMonthlyEmailReminders: coerceNumber(quotasRaw.maxMonthlyEmailReminders),
          maxMonthlyVoiceReminders: coerceNumber(quotasRaw.maxMonthlyVoiceReminders),
          maxStorageMb: coerceNumber(quotasRaw.maxStorageMb),
        }
      : undefined,
    membershipCounts: membershipCountsRaw
      ? {
          total: coerceNumber(membershipCountsRaw.total),
          active: coerceNumber(membershipCountsRaw.active),
          pending: coerceNumber(membershipCountsRaw.pending),
          owners,
          admins,
          staff,
        }
      : undefined,
    flags: settingsRaw
      ? {
          allowJoinRequests: settingsRaw.allowJoinRequests,
          notifyOnJoinRequest: settingsRaw.notifyOnJoinRequest,
          notifyViaEmail: settingsRaw.notifyViaEmail,
        }
      : undefined,
    createdAt: toIsoTimestamp(data.createdAt),
    updatedAt: toIsoTimestamp(data.updatedAt),
    seatUsage: {
      adminSeatsUsed,
      adminSeatLimit,
      remaining,
    },
    branding: brandingNormalized,
  };
}

function serializeTenantMembershipAdminRecord(
  doc: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>
): TenantMembershipAdminRecord {
  const data = doc.data() || {};
  return {
    id: doc.id,
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : '',
    userId: typeof data.userId === 'string' ? data.userId : undefined,
    email: typeof data.email === 'string' ? data.email : undefined,
    displayName: typeof data.displayName === 'string' ? data.displayName : undefined,
    role: typeof data.role === 'string' ? data.role : undefined,
    status: typeof data.status === 'string' ? data.status : undefined,
    joinedVia: typeof data.joinedVia === 'string' ? data.joinedVia : undefined,
    joinCodeId: typeof data.joinCodeId === 'string' ? data.joinCodeId : undefined,
    invitedByUserId: typeof data.invitedByUserId === 'string' ? data.invitedByUserId : undefined,
    invitedByEmail: typeof data.invitedByEmail === 'string' ? data.invitedByEmail : undefined,
    createdAt: toIsoTimestamp(data.createdAt),
    updatedAt: toIsoTimestamp(data.updatedAt),
    lastActivityAt: toIsoTimestamp(data.lastActivityAt ?? data.lastActiveAt),
  };
}

function summarizeMemberships(list: TenantMembershipAdminRecord[]): MembershipSummaryBuckets {
  const summary: MembershipSummaryBuckets = {
    count: list.length,
    byRole: {},
    byStatus: {},
  };
  list.forEach((entry) => {
    const roleKey = (entry.role || 'member').toLowerCase();
    const statusKey = (entry.status || 'unknown').toLowerCase();
    summary.byRole[roleKey] = (summary.byRole[roleKey] || 0) + 1;
    summary.byStatus[statusKey] = (summary.byStatus[statusKey] || 0) + 1;
  });
  return summary;
}

function serializeTenantInviteRecord(
  doc: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>
): TenantInviteAdminRecord {
  const data = doc.data() || {};
  return {
    id: doc.id,
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : '',
    email: typeof data.email === 'string' ? data.email : undefined,
    role: typeof data.role === 'string' ? data.role : undefined,
    status: typeof data.status === 'string' ? data.status : undefined,
    issuedBy: typeof data.issuedBy === 'string' ? data.issuedBy : undefined,
    issuedAt: toIsoTimestamp(data.issuedAt),
    expiresAt: toIsoTimestamp(data.expiresAt),
    acceptedAt: toIsoTimestamp(data.acceptedAt),
    acceptedBy: typeof data.acceptedBy === 'string' ? data.acceptedBy : undefined,
    lastSentAt: toIsoTimestamp(data.lastSentAt),
    lastSentBy: typeof data.lastSentBy === 'string' ? data.lastSentBy : undefined,
    invitationMessage: typeof data.invitationMessage === 'string' ? data.invitationMessage : undefined,
  };
}

function summarizeInvites(list: TenantInviteAdminRecord[]): { byStatus: Record<string, number> } {
  const summary: Record<string, number> = {};
  list.forEach((entry) => {
    const status = (entry.status || 'unknown').toLowerCase();
    summary[status] = (summary[status] || 0) + 1;
  });
  return { byStatus: summary };
}

type QuotaFieldKey =
  | 'maxStudents'
  | 'maxStaff'
  | 'maxMonthlyReminders'
  | 'maxMonthlyWhatsappReminders'
  | 'maxMonthlySmsReminders'
  | 'maxMonthlyEmailReminders'
  | 'maxMonthlyVoiceReminders'
  | 'maxStorageMb';

function buildQuotaPatch(input: Partial<Record<QuotaFieldKey, number | null>>): Record<QuotaFieldKey, number | null> {
  const patch: Partial<Record<QuotaFieldKey, number | null>> = {};
  (
    [
      'maxStudents',
      'maxStaff',
      'maxMonthlyReminders',
      'maxMonthlyWhatsappReminders',
      'maxMonthlySmsReminders',
      'maxMonthlyEmailReminders',
      'maxMonthlyVoiceReminders',
      'maxStorageMb',
    ] as QuotaFieldKey[]
  ).forEach((key) => {
    if (input[key] === undefined) {
      return;
    }
    const value = input[key];
    patch[key] = value === null ? null : Number(value);
  });
  return patch as Record<QuotaFieldKey, number | null>;
}

function serializeTenantAuditRecord(
  doc: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>
): TenantAuditAdminRecord {
  const data = doc.data() || {};
  return {
    id: doc.id,
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : '',
    action: typeof data.action === 'string' ? data.action : 'unknown',
    actorId: typeof data.actorId === 'string' ? data.actorId : undefined,
    actorEmail: typeof data.actorEmail === 'string' ? data.actorEmail : undefined,
    targetId: typeof data.targetId === 'string' ? data.targetId : undefined,
    targetType: typeof data.targetType === 'string' ? data.targetType : undefined,
    metadata: typeof data.metadata === 'object' && data.metadata ? data.metadata : undefined,
    createdAt: toIsoTimestamp(data.createdAt),
  };
}

function summarizeAuditEntries(list: TenantAuditAdminRecord[]): { byAction: Record<string, number> } {
  const summary: Record<string, number> = {};
  list.forEach((entry) => {
    const action = (entry.action || 'unknown').toLowerCase();
    summary[action] = (summary[action] || 0) + 1;
  });
  return { byAction: summary };
}

function serializeNotificationHistoryRecord(
  doc: admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>
): NotificationHistoryAdminRecord {
  const data = doc.data() || {};
  return {
    id: doc.id,
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : null,
    tenantName: typeof data.tenantName === 'string' ? data.tenantName : null,
    adminEmail: typeof data.adminEmail === 'string' ? data.adminEmail : null,
    adminName: typeof data.adminName === 'string' ? data.adminName : null,
    title: typeof data.title === 'string' ? data.title : 'Untitled notification',
    body: typeof data.body === 'string' ? data.body : undefined,
    type: typeof data.type === 'string' ? data.type : 'info',
    priority: typeof data.priority === 'string' ? data.priority : 'normal',
    deliveryMethod: typeof data.deliveryMethod === 'string' ? data.deliveryMethod : undefined,
    totalTargets: typeof data.totalTargets === 'number' ? data.totalTargets : 0,
    successfulDeliveries: typeof data.successfulDeliveries === 'number' ? data.successfulDeliveries : 0,
    failedDeliveries: typeof data.failedDeliveries === 'number' ? data.failedDeliveries : 0,
    failureReasonSummary:
      typeof data.failureReasonSummary === 'object' && data.failureReasonSummary ? data.failureReasonSummary : undefined,
    onlineOnly: typeof data.onlineOnly === 'boolean' ? data.onlineOnly : undefined,
    sentAt: toIsoTimestamp(data.sentAt),
    createdAt: toIsoTimestamp(data.createdAt),
    updatedAt: toIsoTimestamp(data.updatedAt),
  };
}

async function runTenantMembershipInspector(options: {
  tenantId: string;
  limit: number;
  role?: TenantMembershipRole | 'all';
  status?: string;
  search?: string;
}): Promise<TenantMembershipInspectorResponse | null> {
  ensureFirebase();
  const db = admin.firestore();
  const normalizedTenantId = options.tenantId.trim();
  const tenantDoc = await db.collection('tenants').doc(normalizedTenantId).get();
  if (!tenantDoc.exists) {
    return null;
  }

  const limit = Math.min(Math.max(options.limit, 1), 200);
  const normalizedRole = options.role && options.role !== 'all' ? options.role : null;
  const normalizedStatus = options.status && options.status.toLowerCase() !== 'all'
    ? options.status.toLowerCase()
    : null;
  const normalizedSearch = (options.search || '').trim().toLowerCase();

  let fetchLimit = limit;
  if (normalizedRole) fetchLimit *= 2;
  if (normalizedStatus) fetchLimit *= 2;
  if (normalizedSearch) fetchLimit *= 4;
  fetchLimit = Math.max(limit * 2, Math.min(fetchLimit, 500));

  const membershipSnap = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', normalizedTenantId)
    .limit(fetchLimit)
    .get();

  const allMembers = membershipSnap.docs.map(serializeTenantMembershipAdminRecord);
  const tenantSummary = serializeTenantAdminSummary(tenantDoc);

  const filteredMembers = allMembers.filter((member) => {
    if (normalizedRole) {
      const role = (member.role || '').toLowerCase();
      if (role !== normalizedRole) {
        return false;
      }
    }
    if (normalizedStatus) {
      const status = (member.status || '').toLowerCase();
      if (status !== normalizedStatus) {
        return false;
      }
    }
    if (normalizedSearch) {
      const haystack = `${member.displayName || ''} ${member.email || ''} ${member.userId || ''}`.toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });

  filteredMembers.sort((a, b) => {
    const aTs = a.updatedAt || a.createdAt || '';
    const bTs = b.updatedAt || b.createdAt || '';
    return bTs.localeCompare(aTs);
  });

  const limitedMembers = filteredMembers.slice(0, limit);
  const filteredSummary = summarizeMemberships(filteredMembers);
  const scannedSummary = summarizeMemberships(allMembers);

  return {
    tenant: tenantSummary,
    members: limitedMembers,
    total: filteredMembers.length,
    hasMore: filteredMembers.length > limit,
    stats: {
      filtered: filteredSummary,
      scanned: scannedSummary,
      snapshot: tenantSummary.membershipCounts,
    },
    filters: {
      limit,
      role: normalizedRole ?? 'all',
      status: normalizedStatus ?? 'all',
      search: normalizedSearch || undefined,
    },
  };
}

async function runTenantInviteInspector(options: {
  tenantId: string;
  limit: number;
  status?: string;
  search?: string;
}): Promise<TenantInviteInspectorResponse | null> {
  ensureFirebase();
  const db = admin.firestore();
  const normalizedTenantId = options.tenantId.trim();
  const tenantDoc = await db.collection('tenants').doc(normalizedTenantId).get();
  if (!tenantDoc.exists) {
    return null;
  }

  const limit = Math.min(Math.max(options.limit, 1), 200);
  const normalizedStatus = options.status && options.status.toLowerCase() !== 'all'
    ? options.status.toLowerCase()
    : null;
  const normalizedSearch = (options.search || '').trim().toLowerCase();

  let fetchLimit = limit;
  if (normalizedStatus) fetchLimit *= 2;
  if (normalizedSearch) fetchLimit *= 3;
  fetchLimit = Math.max(limit * 2, Math.min(fetchLimit, 400));

  const inviteSnap = await db
    .collection('tenantInvites')
    .where('tenantId', '==', normalizedTenantId)
    .limit(fetchLimit)
    .get();

  const allInvites = inviteSnap.docs.map(serializeTenantInviteRecord);
  allInvites.sort((a, b) => {
    const aTs = a.issuedAt || a.lastSentAt || a.expiresAt || '';
    const bTs = b.issuedAt || b.lastSentAt || b.expiresAt || '';
    return bTs.localeCompare(aTs);
  });

  const filteredInvites = allInvites.filter((invite) => {
    if (normalizedStatus) {
      const status = (invite.status || '').toLowerCase();
      if (status !== normalizedStatus) {
        return false;
      }
    }
    if (normalizedSearch) {
      const haystack = `${invite.email || ''} ${invite.invitationMessage || ''} ${invite.issuedBy || ''}`.toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });

  const limitedInvites = filteredInvites.slice(0, limit);
  const stats = summarizeInvites(filteredInvites);
  const tenantSummary = serializeTenantAdminSummary(tenantDoc);

  return {
    tenant: tenantSummary,
    invites: limitedInvites,
    total: filteredInvites.length,
    hasMore: filteredInvites.length > limit,
    stats,
    filters: {
      limit,
      status: normalizedStatus ?? 'all',
      search: normalizedSearch || undefined,
    },
  };
}

async function runTenantAuditInspector(options: {
  tenantId: string;
  limit: number;
  action?: string;
  search?: string;
}): Promise<TenantAuditInspectorResponse | null> {
  ensureFirebase();
  const db = admin.firestore();
  const normalizedTenantId = options.tenantId.trim();
  const tenantDoc = await db.collection('tenants').doc(normalizedTenantId).get();
  if (!tenantDoc.exists) {
    return null;
  }

  const limit = Math.min(Math.max(options.limit, 1), 200);
  const normalizedAction = options.action && options.action.toLowerCase() !== 'all'
    ? options.action.toLowerCase()
    : null;
  const normalizedSearch = (options.search || '').trim().toLowerCase();

  let fetchLimit = limit * 2;
  if (normalizedAction) fetchLimit *= 2;
  if (normalizedSearch) fetchLimit *= 2;
  fetchLimit = Math.min(fetchLimit, 600);

  const auditSnap = await db
    .collection('tenantAuditLogs')
    .where('tenantId', '==', normalizedTenantId)
    .orderBy('createdAt', 'desc')
    .limit(fetchLimit)
    .get();

  const entries = auditSnap.docs.map(serializeTenantAuditRecord);

  const filtered = entries.filter((entry) => {
    if (normalizedAction) {
      const action = (entry.action || '').toLowerCase();
      if (action !== normalizedAction) {
        return false;
      }
    }
    if (normalizedSearch) {
      const haystack = `${entry.actorEmail || ''} ${entry.actorId || ''} ${entry.targetId || ''} ${
        entry.targetType || ''
      } ${JSON.stringify(entry.metadata || {})}`
        .toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });

  const limitedEntries = filtered.slice(0, limit);
  const stats = summarizeAuditEntries(filtered);
  const tenantSummary = serializeTenantAdminSummary(tenantDoc);

  return {
    tenant: tenantSummary,
    entries: limitedEntries,
    total: filtered.length,
    hasMore: filtered.length > limit,
    stats,
    filters: {
      limit,
      action: normalizedAction ?? 'all',
      search: normalizedSearch || undefined,
    },
  };
}

async function runNotificationHistoryInspector(options: {
  tenantId?: string;
  adminEmail?: string;
  limit: number;
  cursor?: string;
}): Promise<NotificationHistoryInspectorResponse> {
  ensureFirebase();
  const db = admin.firestore();
  const limit = Math.min(Math.max(options.limit, 10), 200);
  const normalizedTenantId = options.tenantId?.trim();
  const normalizedAdmin = options.adminEmail?.trim();

  let queryRef: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('admin_notification_history');
  if (normalizedTenantId) {
    queryRef = queryRef.where('tenantId', '==', normalizedTenantId);
  }
  if (normalizedAdmin) {
    queryRef = queryRef.where('adminEmail', '==', normalizedAdmin);
  }

  let cursorTimestamp: admin.firestore.Timestamp | null = null;
  if (options.cursor) {
    const parsed = new Date(options.cursor);
    if (!Number.isNaN(parsed.getTime())) {
      cursorTimestamp = admin.firestore.Timestamp.fromDate(parsed);
    }
  }

  queryRef = queryRef.orderBy('sentAt', 'desc');
  if (cursorTimestamp) {
    queryRef = queryRef.where('sentAt', '<', cursorTimestamp);
  }
  queryRef = queryRef.limit(limit + 1);

  const snap = await queryRef.get();
  const docs = snap.docs;
  const hasMore = docs.length > limit;
  const trimmedDocs = hasMore ? docs.slice(0, limit) : docs;
  const entries = trimmedDocs.map(serializeNotificationHistoryRecord);
  const nextCursor = hasMore && entries.length ? entries[entries.length - 1]?.sentAt : undefined;

  return {
    entries,
    hasMore,
    nextCursor,
  };
}

async function runNotificationStatsInspector(options: {
  tenantId?: string;
  adminEmail?: string;
  days: number;
}): Promise<NotificationStatsInspectorResponse> {
  ensureFirebase();
  const db = admin.firestore();
  const windowDays = Math.min(Math.max(options.days, 1), 180);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const normalizedTenantId = options.tenantId?.trim();
  const normalizedAdmin = options.adminEmail?.trim();

  let queryRef: admin.firestore.Query<admin.firestore.DocumentData> = db
    .collection('admin_notification_history')
    .where('sentAt', '>=', admin.firestore.Timestamp.fromDate(since));

  if (normalizedTenantId) {
    queryRef = queryRef.where('tenantId', '==', normalizedTenantId);
  }

  if (normalizedAdmin) {
    queryRef = queryRef.where('adminEmail', '==', normalizedAdmin);
  }

  queryRef = queryRef.orderBy('sentAt', 'desc');

  const snap = await queryRef.get();
  const failureReasons: Record<string, number> = {};
  const tenantMap = new Map<string, { tenantId: string; tenantName?: string | null; count: number; failedDeliveries: number }>();

  let totalNotifications = 0;
  let totalRecipients = 0;
  let successfulRecipients = 0;
  let failedRecipients = 0;
  const byType: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let lastSentAt: string | undefined;

  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    totalNotifications += 1;

    const successes = typeof data.successfulDeliveries === 'number' ? data.successfulDeliveries : 0;
    const failures = typeof data.failedDeliveries === 'number' ? data.failedDeliveries : 0;
    const totalTargets = typeof data.totalTargets === 'number' ? data.totalTargets : undefined;
    const fallbackTargets = successes + failures > 0
      ? successes + failures
      : ((Array.isArray(data.targetUsers) ? data.targetUsers.length : 0)
        + (Array.isArray(data.targetDevices) ? data.targetDevices.length : 0));
    const recipients = typeof totalTargets === 'number' ? totalTargets : fallbackTargets;

    totalRecipients += recipients;
    successfulRecipients += successes;
    failedRecipients += failures;

    const typeKey = (typeof data.type === 'string' && data.type.trim() ? data.type.trim().toLowerCase() : 'info');
    byType[typeKey] = (byType[typeKey] || 0) + 1;
    const priorityKey = (typeof data.priority === 'string' && data.priority.trim() ? data.priority.trim().toLowerCase() : 'normal');
    byPriority[priorityKey] = (byPriority[priorityKey] || 0) + 1;

    if (typeof data.failureReasonSummary === 'object' && data.failureReasonSummary) {
      Object.entries(data.failureReasonSummary).forEach(([reason, count]) => {
        if (!reason) return;
        const numeric = typeof count === 'number' ? count : 0;
        failureReasons[reason] = (failureReasons[reason] || 0) + numeric;
      });
    }

    const tenantId = typeof data.tenantId === 'string' && data.tenantId.trim() ? data.tenantId.trim() : 'unknown';
    const tenantEntry = tenantMap.get(tenantId) ?? {
      tenantId,
      tenantName: typeof data.tenantName === 'string' ? data.tenantName : null,
      count: 0,
      failedDeliveries: 0,
    };
    tenantEntry.count += 1;
    tenantEntry.failedDeliveries += failures;
    tenantMap.set(tenantId, tenantEntry);

    const sentIso = toIsoTimestamp(data.sentAt);
    if (sentIso && (!lastSentAt || sentIso > lastSentAt)) {
      lastSentAt = sentIso;
    }
  });

  const averageSuccessRate = totalRecipients > 0
    ? Number(((successfulRecipients / totalRecipients) * 100).toFixed(2))
    : 100;

  const tenantBreakdown = Array.from(tenantMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  return {
    windowDays,
    startDate: since.toISOString(),
    totalNotifications,
    totalRecipients,
    successfulRecipients,
    failedRecipients,
    averageSuccessRate,
    notificationsByType: byType,
    notificationsByPriority: byPriority,
    failureReasons,
    tenantBreakdown,
    lastSentAt,
  };
}

async function runTenantDirectorySearch({
  query,
  limit,
}: {
  query?: string;
  limit: number;
}): Promise<TenantSearchResponse> {
  ensureFirebase();
  const db = admin.firestore();
  const normalizedQuery = (query || '').trim();
  const matchedBy = new Set<string>();
  const docMap = new Map<string, admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>>();

  const limitRemaining = () => Math.max(0, limit - docMap.size);
  const maybeAddDoc = (
    snap: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>,
    reason: string
  ) => {
    if (!snap.exists || docMap.has(snap.id)) {
      return false;
    }
    if (limitRemaining() <= 0) {
      return false;
    }
    docMap.set(snap.id, snap);
    matchedBy.add(reason);
    return true;
  };

  const looksLikeTenantId = (value: string) => /^[a-zA-Z0-9_-]{12,}$/.test(value);
  const looksLikeCode = (value: string) => /^[A-Z0-9]{5,10}$/.test(value);
  const looksLikeSlug = (value: string) => /^[a-z0-9-]{3,40}$/.test(value);

  if (normalizedQuery) {
    if (looksLikeTenantId(normalizedQuery)) {
      const direct = await db.collection('tenants').doc(normalizedQuery).get();
      maybeAddDoc(direct, 'id');
    }

    if (limitRemaining() > 0 && looksLikeCode(normalizedQuery.toUpperCase())) {
      const codeSnap = await db
        .collection('tenants')
        .where('code', '==', normalizedQuery.toUpperCase())
        .limit(limitRemaining())
        .get();
      codeSnap.forEach((docSnap) => {
        maybeAddDoc(docSnap, 'code');
      });
    }

    if (limitRemaining() > 0 && looksLikeSlug(normalizedQuery.toLowerCase())) {
      const slugSnap = await db
        .collection('tenants')
        .where('slug', '==', normalizedQuery.toLowerCase())
        .limit(limitRemaining())
        .get();
      slugSnap.forEach((docSnap) => {
        maybeAddDoc(docSnap, 'slug');
      });
    }

    if (limitRemaining() > 0 && normalizedQuery.includes('@')) {
      const normalizedEmail = normalizeEmail(normalizedQuery);
      if (normalizedEmail) {
        let directEmailHit = false;
        const emailFields: Array<{ field: string; reason: string }> = [
          { field: 'ownerEmail', reason: 'ownerEmail' },
          { field: 'contactEmail', reason: 'contactEmail' },
        ];
        for (const { field, reason } of emailFields) {
          if (limitRemaining() <= 0) break;
          const snap = await db
            .collection('tenants')
            .where(field, '==', normalizedEmail)
            .limit(limitRemaining())
            .get();
          snap.forEach((docSnap) => {
            if (maybeAddDoc(docSnap, reason)) {
              directEmailHit = true;
            }
          });
        }

        // Include membership-email matches when there's still room under the limit.
        // Keep the membership fan-out query bounded; it can be large for shared emails.
        if (limitRemaining() > 0) {
          // Membership email fan-out can be large; keep it bounded and avoid N sequential reads.
          const membershipQueryLimit = directEmailHit
            ? Math.min(250, limitRemaining() * 5)
            : Math.min(500, limitRemaining() * 10);
          const membershipSnap = await db
            .collection('tenantMemberships')
            .where('email', '==', normalizedEmail)
            .select('tenantId')
            .limit(membershipQueryLimit)
            .get();

          const tenantIds: string[] = [];
          const seenTenantIds = new Set<string>();
          membershipSnap.forEach((docSnap) => {
            if (limitRemaining() <= 0) return;
            const tenantId = docSnap.get('tenantId');
            if (typeof tenantId !== 'string') return;
            const trimmed = tenantId.trim();
            if (!trimmed || seenTenantIds.has(trimmed)) return;
            seenTenantIds.add(trimmed);
            tenantIds.push(trimmed);
          });

          if (tenantIds.length) {
            const refs = tenantIds.slice(0, limitRemaining()).map((tenantId) => db.collection('tenants').doc(tenantId));
            const snaps = await db.getAll(...refs);
            snaps.forEach((tenantDoc) => {
              maybeAddDoc(tenantDoc, 'membershipEmail');
            });
          }
        }
      }
    }

    const attemptNameSearch = async (prefix: string) => {
      if (!prefix || limitRemaining() <= 0) return;
      try {
        const snap = await db
          .collection('tenants')
          .orderBy('name')
          .startAt(prefix)
          .endAt(prefix + '\uf8ff')
          .limit(limitRemaining())
          .get();
        snap.forEach((docSnap) => {
          maybeAddDoc(docSnap, 'name');
        });
      } catch (error) {
        console.warn('[tenant_search] name prefix query failed', error);
      }
    };

    if (limitRemaining() > 0 && normalizedQuery.length >= 3) {
      await attemptNameSearch(normalizedQuery);
      if (limitRemaining() > 0) {
        const capitalized = normalizedQuery.replace(/^(\w)/, (match) => match.toUpperCase());
        if (capitalized !== normalizedQuery) {
          await attemptNameSearch(capitalized);
        }
      }
    }
  }

  let fallbackApplied = false;
  if (!normalizedQuery && limitRemaining() > 0) {
    fallbackApplied = true;
    const fallbackSnap = await db
      .collection('tenants')
      .orderBy('createdAt', 'desc')
      .limit(limitRemaining())
      .get();
    fallbackSnap.forEach((docSnap) => {
      maybeAddDoc(docSnap, 'recent');
    });
  }

  const results = Array.from(docMap.values()).map(serializeTenantAdminSummary);

  return {
    results,
    total: results.length,
    diagnostics: {
      query: normalizedQuery || undefined,
      matchedBy: Array.from(matchedBy.values()),
      fallbackApplied,
    },
  };
}

type JoinCodeValidationError =
  | 'code_not_found'
  | 'code_revoked'
  | 'code_expired'
  | 'code_limit_reached'
  | 'tenant_not_found'
  | 'tenant_unavailable';

type JoinCodeValidationResult =
  | {
      ok: true;
      codeDoc: admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>;
      codeData: admin.firestore.DocumentData;
      tenantSnap: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>;
      tenantData: admin.firestore.DocumentData;
    }
  | {
      ok: false;
      error: JoinCodeValidationError;
      tenantStatus?: string;
    };

async function validateJoinCode(
  db: admin.firestore.Firestore,
  normalizedCode: string,
): Promise<JoinCodeValidationResult> {
  const codeQuery = await db
    .collection('tenantCodes')
    .where('code', '==', normalizedCode)
    .limit(1)
    .get();
  if (codeQuery.empty) {
    return { ok: false, error: 'code_not_found' };
  }

  const codeDoc = codeQuery.docs[0];
  const codeData = codeDoc.data() || {};
  const tenantId = typeof codeData.tenantId === 'string' ? codeData.tenantId : '';
  if (!tenantId) {
    return { ok: false, error: 'tenant_not_found' };
  }

  const status = typeof codeData.status === 'string' ? codeData.status.toLowerCase() : 'active';
  if (status === 'revoked') {
    return { ok: false, error: 'code_revoked' };
  }

  const expiresMs = timestampToMillis(codeData.expiresAt);
  if (typeof expiresMs === 'number' && expiresMs <= Date.now()) {
    await codeDoc.ref
      .update({ status: 'expired', updatedAt: new Date().toISOString() })
      .catch(() => undefined);
    return { ok: false, error: 'code_expired' };
  }

  const usageCap = typeof codeData.usageCap === 'number' ? codeData.usageCap : null;
  const usageCount = typeof codeData.usageCount === 'number' ? codeData.usageCount : 0;
  if (usageCap != null && usageCount >= usageCap) {
    await codeDoc.ref
      .update({ status: 'revoked', updatedAt: new Date().toISOString() })
      .catch(() => undefined);
    return { ok: false, error: 'code_limit_reached' };
  }

  const tenantSnap = await db.collection('tenants').doc(tenantId).get();
  if (!tenantSnap.exists) {
    return { ok: false, error: 'tenant_not_found' };
  }

  const tenantData = tenantSnap.data() || {};
  const tenantStatus = typeof tenantData.status === 'string' ? tenantData.status.toLowerCase() : 'active';
  if (tenantStatus !== 'active') {
    return { ok: false, error: 'tenant_unavailable', tenantStatus };
  }

  return { ok: true, codeDoc, codeData, tenantSnap, tenantData };
}

function mapJoinCodeError(result: Extract<JoinCodeValidationResult, { ok: false }>): {
  status: number;
  body: Record<string, any>;
} {
  switch (result.error) {
    case 'code_not_found':
      return { status: 404, body: { error: 'code_not_found' } };
    case 'code_revoked':
      return { status: 410, body: { error: 'code_revoked' } };
    case 'code_expired':
      return { status: 410, body: { error: 'code_expired' } };
    case 'tenant_not_found':
      return { status: 404, body: { error: 'tenant_not_found' } };
    case 'tenant_unavailable':
      return { status: 403, body: { error: 'tenant_unavailable', status: result.tenantStatus } };
    case 'code_limit_reached':
      return { status: 410, body: { error: 'code_limit_reached' } };
    default:
      return { status: 400, body: { error: 'invalid_code' } };
  }
}

type TenantMembershipAccessFn = (
  authContext: express.Request['authContext'],
  tenantIdRaw: string,
  options?: { minRole?: TenantMembershipRole }
) => Promise<{ tenantId: string; role: TenantMembershipRole; membershipId: string | null }>;

type TenantEmailMemberChecker = (tenantId: string, email: string) => Promise<boolean>;

type TenantAuditEventTargetType = 'reminder' | 'fee' | 'job' | 'attendance' | 'export' | 'tenant' | 'usage' | 'billing';
type TenantAuditEventAction =
  | 'reminder_queued'
  | 'daily_quotes_triggered'
  | 'birthday_job_triggered'
  | 'tenant_data_exported'
  | 'notification_preferences_updated'
  | 'usage_alert_acknowledged'
  | 'usage_refresh_requested'
  | 'billing_checkout_started'
  | 'billing_manage_link_requested'
  | 'billing_play_verified'
  | 'billing_downgrade_to_free'
  | 'billing_downgrade_to_free_scheduled';

type LogTenantAuditEventFn = (options: {
  tenantId: string;
  action: TenantAuditEventAction;
  authContext?: express.Request['authContext'];
  metadata?: Record<string, unknown>;
  targetId?: string;
  targetType?: TenantAuditEventTargetType;
}) => Promise<void>;

type FetchLike = typeof fetch;

type UsageSnapshotLoader = (
  tenantId: string,
  monthId: string
) => Promise<{ ref: admin.firestore.DocumentReference | null; data: Record<string, any> }>;

type UsageAlertsLoader = (
  docRef: admin.firestore.DocumentReference | null,
  monthId: string,
  limit?: number
) => Promise<UsageAlertRecord[]>;

type TenantBillingSummaryLoader = (tenantId: string, fallbackPlanId: PlanId) => Promise<BillingSummaryRecord>;

type TenantSummaryLoader = (tenantId: string) => Promise<TenantAdminSummary | null>;

type BillingCheckoutSessionCreator = (record: BillingCheckoutSessionRecord) => Promise<{ sessionId: string }>;

type FirestoreResolver = () => admin.firestore.Firestore;

export interface CreateAppOptions {
  overrides?: {
    verifyFirebaseIdToken?: (token: string) => Promise<any>;
    getAuthUserByUid?: (uid: string) => Promise<any>;
    getAuthUserByEmail?: (email: string) => Promise<any>;
    setAuthCustomUserClaims?: (uid: string, claims: Record<string, unknown> | null) => Promise<void>;
    revokeAuthRefreshTokens?: (uid: string) => Promise<void>;
    sendChatMessage?: typeof sendChatMessage;
    syncChatConversationReceipts?: typeof syncChatConversationReceipts;
    confirmOutboundChatDelivery?: typeof confirmOutboundChatDelivery;
    markChatConversationRead?: typeof markChatConversationRead;
    reconcileChatUnreadForUser?: typeof reconcileChatUnreadForUser;
    rebuildChatSummariesForUser?: typeof rebuildChatSummariesForUser;
    requireTenantMembershipAccess?: TenantMembershipAccessFn;
    isTenantEmailActiveMember?: TenantEmailMemberChecker;
    runNotificationHistoryInspector?: typeof runNotificationHistoryInspector;
    runNotificationStatsInspector?: typeof runNotificationStatsInspector;
    runTenantMembershipInspector?: typeof runTenantMembershipInspector;
    runTenantInviteInspector?: typeof runTenantInviteInspector;
    runTenantAuditInspector?: typeof runTenantAuditInspector;
    runDailyQuoteJob?: typeof runDailyQuoteJob;
    runBirthdayNotificationJob?: typeof runBirthdayNotificationJob;
    logTenantAuditEvent?: LogTenantAuditEventFn;
    sendSMS?: typeof backendSendSMS;
    sendVoiceCall?: typeof backendSendVoiceCall;
    fetch?: FetchLike;
    streamTenantExport?: typeof streamTenantExport;
    enqueueReminder?: typeof enqueueReminder;
    enqueueCustomMessage?: typeof enqueueCustomMessage;
    enqueuePaymentConfirmation?: typeof enqueuePaymentConfirmation;
    sendTeamMembershipChangeNotification?: typeof sendTeamMembershipChangeNotification;
    sendTenantJoinRequestNotification?: typeof sendTenantJoinRequestNotification;
    sendTenantJoinRequestOutcomeNotification?: typeof sendTenantJoinRequestOutcomeNotification;
    loadTenantJoinRequest?: TenantJoinRequestLoader;
    loadTenantInvite?: TenantInviteLoader;
    recordTenantInviteSend?: TenantInviteSendRecorder;
    sendTenantInviteEmail?: typeof sendTenantInviteEmail;
    executeExpoPushProxyRequest?: ExpoPushProxyExecutor;
    deviceFanout?: (params: DeviceFanoutParams) => Promise<DeviceFanoutResult>;
    resolveRecipientOnlineStatus?: (params: DeviceOnlineStatusParams) => Promise<boolean>;
    listRecipientsWithDevices?: (params: DeviceListingParams) => Promise<ObservableUserDevices[]>;
    checkChatRateLimit?: typeof checkChatRateLimit;
    loadTenantNotificationPreferencesRecord?: typeof loadTenantNotificationPreferencesRecord;
    loadUsageMonthSnapshot?: UsageSnapshotLoader;
    loadUsageAlerts?: UsageAlertsLoader;
    loadTenantBillingSummary?: TenantBillingSummaryLoader;
    loadTenantAdminSummary?: TenantSummaryLoader;
    createBillingCheckoutSession?: BillingCheckoutSessionCreator;
    createRazorpaySubscription?: typeof createRazorpaySubscription;
    cancelRazorpaySubscription?: typeof cancelRazorpaySubscription;
    resumeRazorpaySubscription?: typeof resumeRazorpaySubscription;
    getFirestore?: FirestoreResolver;
  };
}

/**
 * Parses a Firebase Storage download URL and returns the decoded object path.
 *
 * Firebase Storage download URLs have the form:
 *   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodedPath}?alt=media&token=...
 *
 * This is the inverse of `buildDownloadUrl` in videoTranscoder.ts.
 * Returns the decoded storage path (the `o/` parameter) or throws if the URL
 * is not a recognised Firebase Storage download URL.
 */
export function storagePathFromUrl(url: string): string {
  // Accept only well-formed http/https URLs.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`storagePathFromUrl: invalid URL: ${url}`);
  }

  // Match Firebase Storage hostname and path pattern /v0/b/{bucket}/o/{encodedPath}
  const match = parsed.pathname.match(/^\/v0\/b\/[^/]+\/o\/(.+)$/);
  if (!match) {
    throw new Error(`storagePathFromUrl: not a Firebase Storage download URL: ${url}`);
  }

  return decodeURIComponent(match[1]);
}

// True iff `url` is an https Firebase Storage / GCS download URL for OUR bucket.
// Used to constrain chat UPLOADED-file references (fileUrl / attachments[].url) to
// the app's own bucket so a client can't pass an arbitrary external URL that the
// recipient's client would then render/download (security-rules-hardening L7).
// Note: sticker/GIF/thumbnail fields are intentionally NOT constrained here — those
// legitimately reference external providers (Tenor/Giphy/link previews).
export function isOwnBucketStorageUrl(url: string, bucket: string): boolean {
  if (!url || !bucket) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  // Firebase download URL: firebasestorage.googleapis.com/v0/b/{bucket}/o/...
  if (host === 'firebasestorage.googleapis.com') {
    return parsed.pathname.startsWith(`/v0/b/${bucket}/o/`);
  }
  // GCS URL forms.
  if (host === 'storage.googleapis.com') {
    return parsed.pathname.startsWith(`/${bucket}/`);
  }
  if (host === `${bucket}.storage.googleapis.com`) return true;
  // Newer Firebase Storage download host.
  if (host === bucket || host === `${bucket}.firebasestorage.app`) return true;
  return false;
}

export function createApp(options: CreateAppOptions = {}){
  const app = express();
  const isTestProcess = process.env.TEST_MODE === '1' || process.argv.includes('--test');
  const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
  if (!isTestProcess) {
    eventLoopDelayMonitor.enable();
  }

  let inFlightHttpRequests = 0;
  let peakInFlightHttpRequests = 0;
  type HttpDurationSample = { ts: number; value: number };
  const httpDurationSamples: HttpDurationSample[] = [];
  const HTTP_DURATION_RETENTION_MS = 60 * 60 * 1000;
  const HTTP_DURATION_SAMPLE_HARD_CAP = 50_000;

  const pruneHttpDurationSamples = (nowMs: number): void => {
    const cutoff = nowMs - HTTP_DURATION_RETENTION_MS;
    let drop = 0;
    while (drop < httpDurationSamples.length && httpDurationSamples[drop].ts < cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      httpDurationSamples.splice(0, drop);
    }

    if (httpDurationSamples.length > HTTP_DURATION_SAMPLE_HARD_CAP) {
      httpDurationSamples.splice(0, httpDurationSamples.length - HTTP_DURATION_SAMPLE_HARD_CAP);
    }
  };

  const recordHttpDurationSample = (durationMs: number): void => {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    const nowMs = Date.now();
    httpDurationSamples.push({ ts: nowMs, value: durationMs });
    pruneHttpDurationSamples(nowMs);
  };

  const getHttpDurationWindowStats = (
    windowMs: number,
  ): { count: number; avg: number; p95: number; p99: number; max: number } | null => {
    if (!Number.isFinite(windowMs) || windowMs <= 0 || httpDurationSamples.length === 0) {
      return null;
    }

    const nowMs = Date.now();
    pruneHttpDurationSamples(nowMs);
    const cutoff = nowMs - Math.trunc(windowMs);
    const values: number[] = [];
    let sum = 0;
    let max = 0;

    for (let i = httpDurationSamples.length - 1; i >= 0; i -= 1) {
      const sample = httpDurationSamples[i];
      if (sample.ts < cutoff) {
        break;
      }
      values.push(sample.value);
      sum += sample.value;
      if (sample.value > max) {
        max = sample.value;
      }
    }

    if (values.length === 0) {
      return null;
    }

    values.sort((a, b) => a - b);
    const readPercentile = (percent: number): number => {
      const idx = Math.max(0, Math.min(values.length - 1, Math.ceil((percent / 100) * values.length) - 1));
      return values[idx];
    };

    return {
      count: values.length,
      avg: sum / values.length,
      p95: readPercentile(95),
      p99: readPercentile(99),
      max,
    };
  };

  const secondsSinceIso = (value: string | null | undefined): number | null => {
    const iso = (value || '').trim();
    if (!iso) {
      return null;
    }
    const timestamp = Date.parse(iso);
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  };

  const secondsUntilIso = (value: string | null | undefined): number | null => {
    const iso = (value || '').trim();
    if (!iso) {
      return null;
    }
    const timestamp = Date.parse(iso);
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return Math.max(0, Math.floor((timestamp - Date.now()) / 1000));
  };

  const readOptionalNumberEnv = (name: string): number | null => {
    const raw = (process.env[name] ?? '').trim();
    if (!raw) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const sendChatMessageImpl = options.overrides?.sendChatMessage ?? sendChatMessage;
  const syncChatConversationReceiptsImpl =
    options.overrides?.syncChatConversationReceipts ?? syncChatConversationReceipts;
  const confirmOutboundChatDeliveryImpl =
    options.overrides?.confirmOutboundChatDelivery ?? confirmOutboundChatDelivery;
  const markChatConversationReadImpl =
    options.overrides?.markChatConversationRead ?? markChatConversationRead;
  const reconcileChatUnreadForUserImpl =
    options.overrides?.reconcileChatUnreadForUser ?? reconcileChatUnreadForUser;
  const rebuildChatSummariesForUserImpl =
    options.overrides?.rebuildChatSummariesForUser ?? rebuildChatSummariesForUser;
  const requireTenantMembershipAccessImpl = options.overrides?.requireTenantMembershipAccess ?? requireTenantMembershipAccess;
  const isTenantEmailActiveMemberImpl = options.overrides?.isTenantEmailActiveMember ?? isTenantEmailActiveMember;
  const runNotificationHistoryInspectorImpl = options.overrides?.runNotificationHistoryInspector ?? runNotificationHistoryInspector;
  const runNotificationStatsInspectorImpl = options.overrides?.runNotificationStatsInspector ?? runNotificationStatsInspector;
  const runTenantMembershipInspectorImpl = options.overrides?.runTenantMembershipInspector ?? runTenantMembershipInspector;
  const runTenantInviteInspectorImpl = options.overrides?.runTenantInviteInspector ?? runTenantInviteInspector;
  const runTenantAuditInspectorImpl = options.overrides?.runTenantAuditInspector ?? runTenantAuditInspector;
  const runDailyQuoteJobImpl = options.overrides?.runDailyQuoteJob ?? runDailyQuoteJob;
  const runBirthdayNotificationJobImpl = options.overrides?.runBirthdayNotificationJob ?? runBirthdayNotificationJob;
  const logTenantAuditEventImpl = options.overrides?.logTenantAuditEvent ?? logTenantAuditEvent;
  const sendSMSImpl = options.overrides?.sendSMS ?? backendSendSMS;
  const sendVoiceCallImpl = options.overrides?.sendVoiceCall ?? backendSendVoiceCall;
  const fetchImpl = options.overrides?.fetch ?? fetch;
  const streamTenantExportImpl = options.overrides?.streamTenantExport ?? streamTenantExport;
  const enqueueReminderImpl = options.overrides?.enqueueReminder ?? enqueueReminder;
  const enqueueCustomMessageImpl = options.overrides?.enqueueCustomMessage ?? enqueueCustomMessage;
  const enqueuePaymentConfirmationImpl = options.overrides?.enqueuePaymentConfirmation ?? enqueuePaymentConfirmation;
  const checkChatRateLimitImpl = options.overrides?.checkChatRateLimit ?? checkChatRateLimit;
  const sendTeamMembershipChangeNotificationImpl =
    options.overrides?.sendTeamMembershipChangeNotification ?? sendTeamMembershipChangeNotification;
  const sendTenantJoinRequestNotificationImpl =
    options.overrides?.sendTenantJoinRequestNotification ?? sendTenantJoinRequestNotification;
  const sendTenantJoinRequestOutcomeNotificationImpl =
    options.overrides?.sendTenantJoinRequestOutcomeNotification ?? sendTenantJoinRequestOutcomeNotification;
  const loadTenantJoinRequestImpl = options.overrides?.loadTenantJoinRequest ?? loadTenantJoinRequestFromFirestore;
  const loadTenantInviteImpl = options.overrides?.loadTenantInvite ?? loadTenantInviteFromFirestore;
  const recordTenantInviteSendImpl = options.overrides?.recordTenantInviteSend ?? recordTenantInviteSendMetadata;
  const sendTenantInviteEmailImpl = options.overrides?.sendTenantInviteEmail ?? sendTenantInviteEmail;
  const executeExpoPushProxyRequestImpl =
    options.overrides?.executeExpoPushProxyRequest ?? executeExpoPushProxyRequestDefault;
  const deviceFanoutImpl = options.overrides?.deviceFanout ?? deviceFanoutDefault;
  const resolveRecipientOnlineStatusImpl =
    options.overrides?.resolveRecipientOnlineStatus ?? resolveRecipientOnlineStatusDefault;
  const listRecipientsWithDevicesImpl =
    options.overrides?.listRecipientsWithDevices ?? listRecipientsWithDevicesDefault;
  const loadTenantNotificationPreferencesRecordImpl =
    options.overrides?.loadTenantNotificationPreferencesRecord ?? loadTenantNotificationPreferencesRecord;
  const cancelRazorpaySubscriptionImpl = options.overrides?.cancelRazorpaySubscription ?? cancelRazorpaySubscription;
  const resumeRazorpaySubscriptionImpl = options.overrides?.resumeRazorpaySubscription ?? resumeRazorpaySubscription;
  const getFirestoreImpl = options.overrides?.getFirestore ?? (() => {
    ensureFirebase();
    return admin.firestore();
  });
  const loadTenantAdminSummaryImpl =
    options.overrides?.loadTenantAdminSummary ??
    ((tenantId: string) => loadTenantAdminSummaryRecord(getFirestoreImpl(), tenantId));
  const loadUsageMonthSnapshotImpl =
    options.overrides?.loadUsageMonthSnapshot ??
    ((tenantId: string, monthId: string) => loadUsageMonthSnapshot(getFirestoreImpl(), tenantId, monthId));
  const loadUsageAlertsImpl = options.overrides?.loadUsageAlerts ?? ((docRef, monthId, limit) =>
    loadUsageAlerts(docRef, monthId, limit)
  );
  const loadTenantBillingSummaryImpl =
    options.overrides?.loadTenantBillingSummary ??
    ((tenantId: string, fallbackPlanId: PlanId) => loadTenantBillingSummary(getFirestoreImpl(), tenantId, fallbackPlanId));
  const createRazorpaySubscriptionImpl = options.overrides?.createRazorpaySubscription ?? createRazorpaySubscription;
  const createBillingCheckoutSessionImpl =
    options.overrides?.createBillingCheckoutSession ??
    (async (record: BillingCheckoutSessionRecord) => {
      const db = getFirestoreImpl();
      const sessionRef = await db.collection('billingCheckoutSessions').add(stripUndefinedDeep(record));
      return { sessionId: sessionRef.id };
    });
  const verifyFirebaseIdTokenImpl = options.overrides?.verifyFirebaseIdToken ?? ((token: string) => admin.auth().verifyIdToken(token));
  const getAuthUserByUidImpl = options.overrides?.getAuthUserByUid ?? ((uid: string) => admin.auth().getUser(uid));
  const getAuthUserByEmailImpl = options.overrides?.getAuthUserByEmail ?? ((email: string) => admin.auth().getUserByEmail(email));
  const setAuthCustomUserClaimsImpl =
    options.overrides?.setAuthCustomUserClaims ??
    ((uid: string, claims: Record<string, unknown> | null) => admin.auth().setCustomUserClaims(uid, claims));
  const revokeAuthRefreshTokensImpl =
    options.overrides?.revokeAuthRefreshTokens ??
    ((uid: string) => admin.auth().revokeRefreshTokens(uid));
  const requireMemberTenantAccess = tenantAccessMiddleware({ minRole: 'member' }, requireTenantMembershipAccessImpl, getFirestoreImpl);
  const requireMemberTenantAccessFromQuery = tenantAccessMiddleware(
    { minRole: 'member', resolveTenantId: queryTenantIdResolver() },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const requireParamsMemberTenantAccess = tenantAccessMiddleware(
    { resolveTenantId: paramsTenantIdResolver('tenantId'), minRole: 'member' },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const requireAdminTenantAccess = tenantAccessMiddleware({ minRole: 'admin' }, requireTenantMembershipAccessImpl, getFirestoreImpl);
  const requireAdminTenantAccessFromQuery = tenantAccessMiddleware(
    { minRole: 'admin', resolveTenantId: queryTenantIdResolver() },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const requireAdminTenantAccessAny = tenantAccessMiddleware(
    { minRole: 'admin', resolveTenantId: anyTenantIdResolver },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const requireStaffTenantAccess = tenantAccessMiddleware({ minRole: 'staff' }, requireTenantMembershipAccessImpl, getFirestoreImpl);
  const requireStaffTenantAccessFromQuery = tenantAccessMiddleware(
    { minRole: 'staff', resolveTenantId: queryTenantIdResolver() },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const optionalQueryStaffTenantAccess = tenantAccessMiddleware(
    { resolveTenantId: queryTenantIdResolver(), minRole: 'staff', requireTenantId: false },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const optionalQueryMemberTenantAccess = tenantAccessMiddleware(
    { resolveTenantId: queryTenantIdResolver(), minRole: 'member', requireTenantId: false },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const optionalBodyMemberTenantAccess = tenantAccessMiddleware(
    { minRole: 'member', requireTenantId: false },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const optionalBodyStaffTenantAccess = tenantAccessMiddleware(
    { minRole: 'staff', requireTenantId: false },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const requireParamsStaffTenantAccess = tenantAccessMiddleware(
    { resolveTenantId: paramsTenantIdResolver('tenantId'), minRole: 'staff' },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const requireParamsAdminTenantAccess = tenantAccessMiddleware(
    { resolveTenantId: paramsTenantIdResolver('tenantId'), minRole: 'admin' },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );
  const defaultTenantGuard = tenantAccessMiddleware(
    { minRole: 'member', resolveTenantId: anyTenantIdResolver },
    requireTenantMembershipAccessImpl,
    getFirestoreImpl
  );

  const defaultTenantGuardBypassPatterns = [
    /^\/internal\/auth\/issue$/,
    /^\/internal\/reminder-history\/email-result$/,
    /^\/auth\/bridge$/,
    /^\/admin\/tenants\/search$/,
    /^\/admin\/tenants\/quotas$/,
    /^\/webhooks\/whatsapp$/,
    /^\/billing\/stripe\/webhook$/,
    /^\/billing\/razorpay\/webhook$/,
    /^\/billing\/catalog$/,
    /^\/billing\/catalog\/admin$/,
    /^\/billing\/catalog\/admin\//,
    // Operator billing endpoints (tenantId is not required; protected by requireOperatorAuth)
    /^\/billing\/admin\/limits-snapshot\/backfill$/,
    /^\/billing\/admin\/backfill$/,
    /^\/billing\/admin\/backfill\/status$/,
    /^\/billing\/admin\/backfill\/runs$/,
    /^\/billing\/admin\/ops-events$/,
    /^\/billing\/admin\/metrics-summary$/,
    /^\/billing\/checkout\/session-public$/,
    /^\/billing\/play\/notifications$/,
    /^\/billing\/appstore\/notifications$/,
    /^\/chat\/stream$/,
    /^\/chat\/inbox-stream$/,
    /^\/admin\/notifications\/history$/,
    /^\/admin\/notifications\/stats$/,
    /^\/admin\/settings\/runtime-endpoints$/,
    /^\/admin\/settings\/maintenance$/,
    /^\/admin\/settings\/reminder-channels$/,
    /^\/admin\/settings\/global-settings$/,
    /^\/admin\/auth\/global-admin\//,
    /^\/notifications\/daily-quotes\/status$/,
    /^\/metrics$/,
    /^\/ready$/,
    /^\/health$/,
    /^\/csp-report$/,
    /^\/internal\/presence\/sweep$/,
    /^\/notifications\/tenant-join-request$/,
    /^\/tenants$/,
    /^\/tenants\/[^/]+\/leave$/,
    /^\/tenants\/join-code\/resolve$/,
    /^\/tenants\/join-code\/claim$/,
    /^\/tenants\/invites\/accept$/,
    /^\/tenants\/invites\/sync-memberships$/,
    /^\/shared-files\/public\//,
    /^\/shared-files$/,
    /^\/shared-files\/mine$/,
  ];

  function shouldBypassDefaultTenantGuard(req: express.Request): boolean {
    if (req.method === 'OPTIONS') {
      return true;
    }
    const path = req.path || '';
    return defaultTenantGuardBypassPatterns.some((pattern) => pattern.test(path));
  }

  // IMPORTANT: Do not run the global JSON body parser on webhook endpoints that
  // require access to the exact raw payload (e.g. Razorpay signature checks).
  // Those routes mount their own `express.raw({ type: 'application/json' })` parsers.
  const jsonParser = express.json();
  app.use((req, res, next) => {
    const p = req.path || '';
    if (
      p === '/billing/stripe/webhook' ||
      p === '/billing/razorpay/webhook' ||
      p === '/billing/play/notifications' ||
      p === '/billing/appstore/notifications'
    ) {
      return next();
    }
    return jsonParser(req, res, next);
  });
  // Attach CSP headers early
  app.use(cspMiddleware({
    enableReportOnlyHeader: true,
    // Allow Firebase Realtime Database long-poll script for web
    extraScript: [
      // Project RTDB domain
      'https://tution-app-6c0c3-default-rtdb.asia-southeast1.firebasedatabase.app',
      // Firebase RTDB JSONP can come from sharded frontends like s-gke-*.firebasedatabase.app
      'https://*.firebasedatabase.app',
      // Google APIs for sign-in
      'https://apis.google.com'
    ],
    // Allow hidden iframes Firebase may use for long-poll control
    extraFrame: [
      'https://*.firebasedatabase.app',
      'https://tution-app-6c0c3.firebaseapp.com',
      'https://firebasestorage.googleapis.com'
    ]
  }));

  // Security-hardening L2: surface wildcard CORS in production. Auth is
  // bearer-token (not cookie) based, so `*` is not directly exploitable, but a
  // production deployment should pin an explicit allowlist of trusted web origins
  // via CORS_ALLOW_ORIGINS. Warn once at startup rather than silently allowing `*`.
  {
    const corsStartupConfig = (process.env.CORS_ALLOW_ORIGINS || '*').trim();
    if (corsStartupConfig === '*' && process.env.NODE_ENV === 'production') {
      console.warn(
        '[startup] CORS_ALLOW_ORIGINS is "*" in production. Set an explicit comma-separated allowlist of trusted web origins (bearer-token auth limits the risk, but wildcard CORS is not recommended for production).'
      );
    }
  }

  /* c8 ignore start - CORS pattern matching branches excluded */
  // --- CORS (copied from original) ---
  app.use((req, res, next) => {
    const cfg = process.env.CORS_ALLOW_ORIGINS || '*';
    const origins = cfg.split(',').map(o => o.trim()).filter(Boolean);
    const reqOrigin = (req.headers.origin as string | undefined) || '';
    let allowOrigin = '';
    if (cfg === '*') {
      allowOrigin='*';
    } else if (reqOrigin) {
      if (origins.includes(reqOrigin)) allowOrigin = reqOrigin; else {
        const devPatterns: RegExp[] = [/^https?:\/\/localhost(?::\d+)?$/i,/^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,/^https?:\/\/192\.168\.[0-9]{1,3}\.[0-9]{1,3}(?::\d+)?$/i,/^https?:\/\/10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?::\d+)?$/i,/^exp:\/\//i];
        const expoDevPorts=[19000,19006,19007,8081];
        const matchesDevPattern = devPatterns.some(r=>r.test(reqOrigin));
        const matchesExpoPort = (()=>{ try { const u=new URL(reqOrigin); return expoDevPorts.includes(Number(u.port)) || (u.hostname==='localhost' && u.port===''); } catch { return false; }})();
        if(matchesDevPattern||matchesExpoPort) allowOrigin=reqOrigin;
      }
    }
    if(allowOrigin){ res.setHeader('Access-Control-Allow-Origin', allowOrigin); res.setHeader('Vary','Origin'); }
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Internal-Secret');
    res.setHeader('Access-Control-Max-Age','600');
    if(req.method==='OPTIONS') return res.sendStatus(204);
    next();
  });
  /* c8 ignore stop */

  app.use((req, res, next) => {
    if (req.path === '/metrics') {
      return next();
    }

    inFlightHttpRequests += 1;
    if (inFlightHttpRequests > peakInFlightHttpRequests) {
      peakInFlightHttpRequests = inFlightHttpRequests;
    }

    const startedAt = process.hrtime.bigint();
    let finalized = false;

    const finalize = () => {
      if (finalized) {
        return;
      }
      finalized = true;

      inFlightHttpRequests = Math.max(0, inFlightHttpRequests - 1);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      recordHttpDurationSample(durationMs);

      const statusCode = Number(res.statusCode || 0);
      inc(metricNames.httpRequestsTotal);
      inc(metricNames.httpResponsesTotal);

      if (statusCode >= 400) {
        inc(metricNames.httpResponsesErrorTotal);
        if (statusCode < 500) {
          inc(metricNames.httpResponses4xxTotal);
        } else {
          inc(metricNames.httpResponses5xxTotal);
        }
      }

      if (statusCode === 401 || statusCode === 403) {
        inc(metricNames.httpAuthUnauthorizedTotal);
      }
      if (statusCode === 429) {
        inc(metricNames.httpRateLimitedTotal);
      }
      if (statusCode === 503) {
        inc(metricNames.httpMaintenanceBlockedTotal);
      }
    };

    res.once('finish', finalize);
    res.once('close', finalize);
    next();
  });

  // ----- Auth helpers -----
  function signInternalToken(sub: string, ttlSec=300, email?: string){ const secret=process.env.INTERNAL_API_KEY!; const exp=Math.floor(Date.now()/1000)+ttlSec; const payloadData: Record<string, unknown> = {sub,exp}; if(email){ payloadData.email = email; } const payload=Buffer.from(JSON.stringify(payloadData)).toString('base64url'); const sig=crypto.createHmac('sha256',secret).update(payload).digest('base64url'); return `${payload}.${sig}`; }

  async function resolveAuthenticatedEmail(authContext: express.Request['authContext']): Promise<string | null> {
    if (!authContext) {
      return null;
    }

    const directEmail = normalizeEmail(authContext.email);
    if (directEmail) {
      return directEmail;
    }

    if (!authContext.uid) {
      return null;
    }

    try {
      ensureFirebase();
      const userRecord = await getAuthUserByUidImpl(authContext.uid);
      return normalizeEmail(userRecord.email || undefined) || null;
    } catch (error) {
      // This can happen if a user was deleted while an old/stale token is still being used.
      // Treat as a normal "no email available" condition to avoid noisy logs.
      const err = error as any;
      const code = typeof err?.errorInfo?.code === 'string' ? err.errorInfo.code : '';
      if (code === 'auth/user-not-found' || code === 'auth/invalid-uid' || code === 'auth/argument-error') {
        console.info('[auth] user email unavailable', { code, uid: authContext.uid });
        return null;
      }

      console.warn('[auth] failed to resolve user email', { uid: authContext.uid, error });
      return null;
    }
  }

  function statusForChatActionError(error: ChatMessageActionError): number {
    switch (error.code) {
      case 'not_found':
        return 404;
      case 'invalid_payload':
        return 400;
      case 'not_authorized':
      case 'not_allowed':
        return 403;
      case 'too_old':
        return 409;
      case 'already_deleted':
        return 410;
      default:
        return 400;
    }
  }

  async function logTenantAuditEvent(options: {
    tenantId: string;
    action: TenantAuditEventAction;
    authContext?: express.Request['authContext'];
    metadata?: Record<string, unknown>;
    targetId?: string;
    targetType?: TenantAuditEventTargetType;
  }): Promise<void> {
    const actorId = options.authContext?.uid || options.authContext?.tokenType || 'system';
    const actorEmail = await resolveAuthenticatedEmail(options.authContext);
    try {
      await getFirestoreImpl().collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: options.tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: options.action,
          targetId: options.targetId,
          targetType: options.targetType ?? 'reminder',
          metadata: options.metadata,
          createdAt: new Date().toISOString(),
        })
      );
    } catch (error) {
      console.warn('[tenant_audit_log] failed', error);
    }
  }
  app.post('/internal/auth/issue',(req,res)=>{ const master=process.env.INTERNAL_API_KEY; if(!master) return res.status(501).json({error:'not_enabled'}); if(req.headers['x-internal-secret']!==master) return res.status(401).json({error:'unauthorized'}); const ttl=300; const token=signInternalToken('system',ttl); res.json({ token, expiresIn: ttl, expiresAt: Date.now()+ttl*1000 }); });

  // Firebase bridge
  app.post('/auth/bridge', async (req,res)=>{
    const start=Date.now();
    try {
      if(!process.env.INTERNAL_API_KEY) return res.status(501).json({error:'not_enabled'});
      const authz=req.headers['authorization']?.toString();
      let idToken = authz?.startsWith('Bearer ')? authz.slice(7): undefined;
      if(!idToken) idToken=(req.body as any)?.firebaseIdToken;
      if(!idToken) return res.status(401).json({error:'missing_id_token'});
      ensureFirebase();
  const decoded = await verifyFirebaseIdTokenImpl(idToken);
  const ttl=300; const internal=signInternalToken(decoded.uid, ttl, decoded.email);
      res.json({ token: internal, expiresIn: ttl, expiresAt: Date.now()+ttl*1000 });
    } catch(e:any){ console.error('[auth_bridge] verify failed:', e?.message); return res.status(401).json({error:'invalid_id_token'}); } finally { const dur=Date.now()-start; if(dur>1000) console.warn('[auth_bridge] slow', dur+'ms'); }
  });

  // Auth middleware
  app.use((req,res,next)=>{
    const master=process.env.INTERNAL_API_KEY;
    if(!master){
      // Fail closed in production: never serve the API unauthenticated (M4).
      // In dev/test (NODE_ENV !== 'production') keep the pass-through so local and
      // e2e setups without a configured master key still run; liveness probes are
      // always allowed so orchestrators can detect the misconfiguration.
      if (process.env.NODE_ENV === 'production') {
        const pp = req.path;
        if (pp === '/health' || pp === '/ready') return next();
        return res.status(503).json({ error: 'auth_not_configured' });
      }
      return next();
    }
    const p=req.path; if(p==='/health'||p==='/ready'||p.startsWith('/webhooks/whatsapp')||p==='/auth/bridge'||p.startsWith('/shared-files/public/')) return next();
    // The email-backend reminder-history callback authenticates itself at the
    // route level (requireReminderCallbackAuth) using a dedicated least-privilege
    // key, so it bypasses the global bearer-token gate (same pattern as webhooks).
    if(p==='/internal/reminder-history/email-result') return next();
    if(p==='/billing/stripe/webhook'||p==='/billing/razorpay/webhook'||p==='/billing/play/notifications'||p==='/billing/appstore/notifications') return next();
    if(p==='/billing/checkout/session-public') return next();
    if(p==='/chat/stream'||p==='/chat/inbox-stream'){
      const token = typeof req.query.token === 'string' ? req.query.token : undefined;
      if(token && verifyInternalToken(token)) return next();
      return res.sendStatus(401);
    }
    const auth=req.headers['authorization']; if(!auth?.startsWith('Bearer ')) return res.sendStatus(401);
    const cand=auth.slice(7);

    if(cand===master){
      req.authContext = { tokenType: 'master', uid: 'system', isGlobalAdmin: true };
      return next();
    }

    const payload = decodeInternalToken(cand);
    if(payload){
      req.authContext = {
        tokenType: payload.master ? 'master' : 'internal',
        uid: typeof payload.sub === 'string' ? payload.sub : undefined,
        email: payload.email,
        isGlobalAdmin: Boolean(payload.master),
      };
      return next();
    }

    ensureFirebase();
    return verifyFirebaseIdTokenImpl(cand)
      .then(decoded => {
        req.authContext = {
          tokenType: 'firebase',
          uid: decoded.uid,
          email: decoded.email || undefined,
          isGlobalAdmin: (decoded as any)?.admin === true,
        };
        next();
      })
      .catch(() => res.sendStatus(401));
  });

  // Maintenance mode enforcement (best-effort): block app-facing requests with 503.
  // We intentionally allow admin/internal/health/metrics/webhooks so operators and
  // provider callbacks keep working during maintenance.
  app.use(async (req, res, next) => {
    try {
      if (req.method === 'OPTIONS') return next();

      const p = (req.path || '').toString();
      if (!p) return next();

      const bypass =
        p === '/health' ||
        p === '/ready' ||
        p === '/metrics' ||
        p === '/csp-report' ||
        p === '/auth/bridge' ||
        p.startsWith('/shared-files/public/') ||
        p.startsWith('/admin/') ||
        p === '/admin' ||
        p.startsWith('/internal/') ||
        p === '/internal' ||
        p.startsWith('/webhooks/') ||
        p === '/billing/catalog' ||
        p === '/billing/checkout' ||
        p.startsWith('/billing/checkout/') ||
        p === '/billing/stripe/webhook' ||
        p === '/billing/razorpay/webhook' ||
        p === '/billing/play/notifications' ||
        p === '/billing/appstore/notifications';

      if (bypass) return next();

      const mode = await getMaintenanceMode();
      if (mode?.enabled) {
        return res
          .status(503)
          .setHeader('Retry-After', '60')
          .json({
            error: 'maintenance',
            message: mode.message || 'We are currently performing maintenance. Please try again shortly.',
          });
      }

      return next();
    } catch {
      // Fail open: do not take down the API if Firestore is temporarily unreachable.
      return next();
    }
  });

  app.use((req, res, next) => {
    if (shouldBypassDefaultTenantGuard(req)) {
      return next();
    }
    return defaultTenantGuard(req, res, next);
  });

  const sharedFileCreateSchema = z.object({
    tenantId: z.string().min(1).max(120),
    fileUrl: z.string().min(1).max(4000),
    fileName: z.string().min(1).max(400),
    fileType: z.string().max(240).optional(),
    fileSize: z.number().int().nonnegative().optional(),
    thumbnailUrl: z.string().max(4000).optional(),
    expiresAt: z.string().datetime().optional(),
  });

  const sharedFileListSchema = z.object({
    tenantId: z.string().min(1).max(120),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });

  const normalizeShareToken = (value: string | undefined): string => {
    const raw = (value || '').trim();
    return raw.replace(/[^a-zA-Z0-9_-]/g, '');
  };

  const mintShareToken = (): string => {
    try {
      // 12 bytes -> 16 chars base64url-ish. Good enough for non-guessable links.
      const token = (crypto as any)?.randomBytes?.(12)?.toString?.('base64url');
      if (typeof token === 'string' && token.trim()) {
        return token;
      }
    } catch {
      // ignore
    }
    // Fallback for older runtimes
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  };

  const isActiveSharedFileDoc = (data: any): boolean => {
    if (!data || typeof data !== 'object') return false;
    if (data.revokedAt) return false;
    if (typeof data.expiresAt === 'string') {
      const exp = Date.parse(data.expiresAt);
      if (!Number.isNaN(exp) && Date.now() > exp) return false;
    }
    return true;
  };

  const findLatestActiveShareForFile = async (db: FirebaseFirestore.Firestore, input: { tenantId: string; uid: string; fileUrl: string }) => {
    const snap = await db
      .collection('sharedFiles')
      .where('tenantId', '==', input.tenantId)
      .where('createdByUid', '==', input.uid)
      .where('file.url', '==', input.fileUrl)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    for (const doc of snap.docs) {
      const data = doc.data() as any;
      if (isActiveSharedFileDoc(data)) {
        return { token: normalizeShareToken(String(data?.token || doc.id)), data };
      }
    }
    return null;
  };

  // Create a share token for a file (auth + tenant required).
  app.post('/shared-files', optionalBodyMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = sharedFileCreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess?.tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }
    if (tenantAccess.tenantId !== parsed.data.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const nowIso = new Date().toISOString();
    const token = normalizeShareToken(mintShareToken());
    if (!token) {
      return res.status(500).json({ error: 'token_failed' });
    }

    const { shareUrl, webUrl } = await buildSmartSharedFileLinkServer(token);

    try {
      const db = getFirestoreImpl();
      const docRef = db.collection('sharedFiles').doc(token);
      await docRef.set(
        stripUndefinedDeep({
          token,
          tenantId: parsed.data.tenantId,
          shareUrl,
          webUrl,
          createdAt: nowIso,
          createdByUid: authContext.uid,
          createdByEmail: authContext.email || undefined,
          expiresAt: parsed.data.expiresAt || undefined,
          revokedAt: undefined,
          revokedByUid: undefined,
          file: {
            url: parsed.data.fileUrl,
            fileName: parsed.data.fileName,
            fileType: parsed.data.fileType || undefined,
            fileSize: parsed.data.fileSize ?? undefined,
            thumbnailUrl: parsed.data.thumbnailUrl || undefined,
          },
        }),
      );

      return res.json({ token, shareUrl, webUrl });
    } catch (error) {
      console.error('[shared_files] create failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // Resolve-or-create a share token for a file (auth + tenant required).
  // Used to avoid creating duplicate tokens for the same user+tenant+file.
  app.post('/shared-files/resolve-or-create', optionalBodyMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = sharedFileCreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess?.tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }
    if (tenantAccess.tenantId !== parsed.data.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const db = getFirestoreImpl();
      const existing = await findLatestActiveShareForFile(db, {
        tenantId: parsed.data.tenantId,
        uid: authContext.uid,
        fileUrl: parsed.data.fileUrl,
      });
      if (existing?.token) {
        const data = existing.data || {};
        const existingShareUrl = typeof (data as any)?.shareUrl === 'string' ? String((data as any).shareUrl).trim() : '';
        const existingWebUrl = typeof (data as any)?.webUrl === 'string' ? String((data as any).webUrl).trim() : '';
        if (existingShareUrl || existingWebUrl) {
          if (!existingWebUrl) {
            const { webUrl } = await buildSmartSharedFileLinkServer(existing.token);
            try {
              await db.collection('sharedFiles').doc(existing.token).set({ webUrl, updatedAt: new Date().toISOString() }, { merge: true });
            } catch {
              // ignore
            }
            return res.json({ token: existing.token, shareUrl: existingShareUrl, webUrl, existing: true });
          }
          return res.json({ token: existing.token, shareUrl: existingShareUrl, webUrl: existingWebUrl, existing: true });
        }
        const { shareUrl, webUrl } = await buildSmartSharedFileLinkServer(existing.token);
        // Best-effort backfill
        try {
          await db.collection('sharedFiles').doc(existing.token).set({ shareUrl, webUrl, updatedAt: new Date().toISOString() }, { merge: true });
        } catch {
          // ignore
        }
        return res.json({ token: existing.token, shareUrl, webUrl, existing: true });
      }
    } catch (error) {
      // Fail open to creation; do not block sharing if index is missing.
      console.warn('[shared_files] resolve failed; falling back to create', error);
    }

    const nowIso = new Date().toISOString();
    const token = normalizeShareToken(mintShareToken());
    if (!token) {
      return res.status(500).json({ error: 'token_failed' });
    }

    const { shareUrl, webUrl } = await buildSmartSharedFileLinkServer(token);

    try {
      const db = getFirestoreImpl();
      const docRef = db.collection('sharedFiles').doc(token);
      await docRef.set(
        stripUndefinedDeep({
          token,
          tenantId: parsed.data.tenantId,
          shareUrl,
          webUrl,
          createdAt: nowIso,
          createdByUid: authContext.uid,
          createdByEmail: authContext.email || undefined,
          expiresAt: parsed.data.expiresAt || undefined,
          revokedAt: undefined,
          revokedByUid: undefined,
          file: {
            url: parsed.data.fileUrl,
            fileName: parsed.data.fileName,
            fileType: parsed.data.fileType || undefined,
            fileSize: parsed.data.fileSize ?? undefined,
            thumbnailUrl: parsed.data.thumbnailUrl || undefined,
          },
        }),
      );

      return res.json({ token, shareUrl, webUrl, existing: false });
    } catch (error) {
      console.error('[shared_files] resolve-or-create failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // Return the canonical shareUrl for a token (auth + tenant required).
  // Useful when the client already has a token (e.g. from chat upload metadata) and wants
  // a server-generated web share link.
  app.get('/shared-files/link/:token', optionalQueryMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess?.tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }

    const token = normalizeShareToken(req.params.token);
    if (!token) {
      return res.status(400).json({ error: 'invalid_token' });
    }

    try {
      const db = getFirestoreImpl();
      const ref = db.collection('sharedFiles').doc(token);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'not_found' });
      }
      const data = snap.data() as any;
      if (!isActiveSharedFileDoc(data)) {
        return res.status(404).json({ error: 'not_found' });
      }
      if (data?.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const existingShareUrl = typeof data?.shareUrl === 'string' ? String(data.shareUrl).trim() : '';
      const existingWebUrl = typeof data?.webUrl === 'string' ? String(data.webUrl).trim() : '';
      if (existingShareUrl || existingWebUrl) {
        if (!existingWebUrl) {
          const { webUrl } = await buildSmartSharedFileLinkServer(token);
          try {
            await ref.set({ webUrl, updatedAt: new Date().toISOString() }, { merge: true });
          } catch {
            // ignore
          }
          return res.json({ token, shareUrl: existingShareUrl, webUrl });
        }
        return res.json({ token, shareUrl: existingShareUrl, webUrl: existingWebUrl });
      }

      const { shareUrl, webUrl } = await buildSmartSharedFileLinkServer(token);
      // Best-effort store so list endpoints can return it.
      try {
        await ref.set({ shareUrl, webUrl, updatedAt: new Date().toISOString() }, { merge: true });
      } catch {
        // ignore
      }

      return res.json({ token, shareUrl, webUrl });
    } catch (error) {
      console.error('[shared_files] link failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // List current user's share links (auth + tenant required).
  app.get('/shared-files/mine', optionalQueryMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = sharedFileListSchema.safeParse(req.query || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess?.tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }
    if (tenantAccess.tenantId !== parsed.data.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const limit = parsed.data.limit ?? 50;
    try {
      const db = getFirestoreImpl();
      const snap = await db
        .collection('sharedFiles')
        .where('tenantId', '==', parsed.data.tenantId)
        .where('createdByUid', '==', authContext.uid)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      const items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      return res.json({ items });
    } catch (error) {
      console.error('[shared_files] list failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // Resolve a share token publicly (no auth). Used by web recipients and deep links.
  app.get('/shared-files/public/:token', async (req, res) => {
    const token = normalizeShareToken(req.params.token);
    if (!token) {
      return res.status(400).json({ error: 'invalid_token' });
    }

    try {
      const db = getFirestoreImpl();
      const docRef = db.collection('sharedFiles').doc(token);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'not_found' });
      }

      const data = snap.data() as any;
      if (data?.revokedAt) {
        return res.status(404).json({ error: 'revoked' });
      }
      if (typeof data?.expiresAt === 'string') {
        const exp = Date.parse(data.expiresAt);
        if (!Number.isNaN(exp) && Date.now() > exp) {
          return res.status(404).json({ error: 'expired' });
        }
      }

      // Best-effort access timestamp
      try {
        await docRef.update({ lastAccessedAt: new Date().toISOString() });
      } catch {
        // ignore
      }

      // This endpoint is PUBLIC (no auth). Do not expose the creator's identity
      // or internal tenant metadata — a share link can leak via logs/referrers
      // (security-rules-hardening L8). Return the file payload only.
      const { createdByEmail: _cbe, createdByUid: _cbu, tenantId: _tid, ...publicData } = (data || {}) as Record<string, any>;
      return res.json({ token, ...publicData });
    } catch (error) {
      console.error('[shared_files] resolve failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  function requireOperatorAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const authContext = req.authContext;
    const tokenType = authContext?.tokenType;
    // The raw master key is a trusted operator principal.
    if (tokenType === 'master') {
      return next();
    }
    // An `internal` token is trusted for operator routes ONLY when it is the
    // master-minted SYSTEM token (sub==='system', issued exclusively by
    // /internal/auth/issue which requires the x-internal-secret master key).
    // Bridge-minted user tokens (/auth/bridge) carry sub===<firebase uid> and
    // MUST NOT reach operator routes — otherwise any signed-in user could hit
    // operator-only endpoints (security-rules-hardening C2).
    if (tokenType === 'internal' && authContext?.uid === 'system') {
      return next();
    }
    // A verified global-admin Firebase user is an operator.
    if (tokenType === 'firebase' && authContext?.isGlobalAdmin === true) {
      return next();
    }
    return res.status(403).json({ error: 'not_authorized' });
  }

  // Auth for the email-backend -> backend-runtime reminder-history callback.
  // Prefers a dedicated, least-privilege shared secret (REMINDER_CALLBACK_KEY)
  // presented via the x-reminder-callback-key header, so the email-backend does
  // NOT need to hold the master operator key. Falls back to the raw master key
  // as a Bearer token for backward compatibility during rollout (before the
  // dedicated key is configured on both services). This endpoint bypasses the
  // global bearer gate, so this middleware fully owns its authentication.
  function requireReminderCallbackAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const callbackKey = process.env.REMINDER_CALLBACK_KEY;
    if (callbackKey) {
      const provided = Buffer.from(req.header('x-reminder-callback-key') || '');
      const expected = Buffer.from(callbackKey);
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
        req.authContext = { tokenType: 'internal', uid: 'system', isGlobalAdmin: false };
        return next();
      }
    }
    // Backward-compatible fallback: the raw master key as a Bearer token.
    const master = process.env.INTERNAL_API_KEY;
    const authz = req.headers['authorization'];
    const token = authz?.startsWith('Bearer ') ? authz.slice(7) : undefined;
    if (master && token) {
      const provided = Buffer.from(token);
      const expected = Buffer.from(master);
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
        req.authContext = { tokenType: 'master', uid: 'system', isGlobalAdmin: true };
        return next();
      }
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  function requireGlobalAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (authContext.tokenType === 'master') {
      return next();
    }
    if (authContext.tokenType === 'firebase' && authContext.isGlobalAdmin === true) {
      return next();
    }
    return res.status(403).json({ error: 'not_authorized' });
  }

  function requireAuthContext(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!req.authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  }

  async function resolveGlobalAdminLookup(input: { uid?: string; email?: string }): Promise<{
    uid: string;
    email: string | null;
  }> {
    ensureFirebase();
    const normalizedEmail = normalizeEmail(input.email || '');
    if (input.uid) {
      const userRecord = await getAuthUserByUidImpl(input.uid);
      return {
        uid: userRecord.uid,
        email: normalizeEmail(userRecord.email || undefined) || null,
      };
    }
    if (!normalizedEmail) {
      throw new Error('uid_or_email_required');
    }
    const userRecord = await getAuthUserByEmailImpl(normalizedEmail);
    return {
      uid: userRecord.uid,
      email: normalizeEmail(userRecord.email || undefined) || normalizedEmail,
    };
  }

  const internalReminderHistoryEmailResultSchema = z.object({
    historyId: z.string().min(1).max(240),
    tenantId: z.string().min(1).max(120).optional(),
    status: z.enum(['queued', 'success', 'failed']).optional(),
    deliveryStatus: z.enum(['queued', 'retrying', 'sent', 'failed']).optional(),
    emailId: z.string().min(1).max(500).optional(),
    provider: z.string().min(1).max(100).optional(),
    errorMessage: z.string().min(1).max(2000).optional(),
  });

  app.post('/internal/reminder-history/email-result', requireReminderCallbackAuth, async (req, res) => {
    const parsed = internalReminderHistoryEmailResultSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const { historyId, tenantId, status, deliveryStatus, emailId, provider, errorMessage } = parsed.data;
    if (!status && !deliveryStatus && !emailId && !provider && !errorMessage && !tenantId) {
      return res.status(400).json({ error: 'empty_update' });
    }

    try {
      const metadata: Record<string, unknown> = {};
      if (typeof deliveryStatus === 'string') metadata.deliveryStatus = deliveryStatus;
      if (typeof emailId === 'string') metadata.emailId = emailId;
      if (typeof provider === 'string') metadata.provider = provider;

      await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId.trim(), {
        tenantId: tenantId || undefined,
        reminderType: 'email',
        status: status || undefined,
        metadata: Object.keys(metadata).length ? metadata : undefined,
        errorMessage: errorMessage || undefined,
      });

      const final =
        status === 'success' || deliveryStatus === 'sent'
          ? ('success' as const)
          : status === 'failed' || deliveryStatus === 'failed'
            ? ('failed' as const)
            : null;

      if (final) {
        try {
          await finalizeReminderQuotaFromHistory(getFirestoreImpl(), {
            historyId: historyId.trim(),
            finalStatus: final,
            fallbackTenantId: tenantId || undefined,
            fallbackChannel: 'email',
          });
        } catch (e) {
          console.warn('[internal_email_result] quota finalize failed', e);
        }
      }

      return res.json({ ok: true });
    } catch (error) {
      console.error('[internal_email_result] reminderHistory update failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/admin/tenants/search', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }
    const parsed = tenantSearchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    try {
      const payload = await runTenantDirectorySearch({
        query: parsed.data.query,
        limit: parsed.data.limit ?? 20,
      });
      return res.json(payload);
    } catch (error) {
      console.error('[tenant_search] failed', error);
      return res.status(500).json({ error: 'search_failed' });
    }
  });

  app.post('/admin/tenants/memberships', optionalBodyStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const parsed = tenantMembershipInspectorSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    const tenantId = tenantAccess?.tenantId ?? parsed.data.tenantId;
    if (!tenantId && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    try {
      const payload = await runTenantMembershipInspectorImpl({
        tenantId,
        limit: parsed.data.limit ?? 75,
        role: parsed.data.role,
        status: parsed.data.status,
        search: parsed.data.search,
      });
      if (!payload) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }
      return res.json(payload);
    } catch (error) {
      console.error('[tenant_memberships] lookup failed', error);
      return res.status(500).json({ error: 'membership_lookup_failed' });
    }
  });

  app.post('/admin/tenants/user-devices', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantUserDevicesSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }

    const toIso = (value: any): string | undefined => {
      if (!value) return undefined;
      if (typeof value === 'string') return value;
      if (typeof value?.toDate === 'function') {
        try {
          return value.toDate().toISOString();
        } catch {
          return undefined;
        }
      }
      return undefined;
    };

    try {
      const db = getFirestoreImpl();
      const devicesSnap = await db
        .collection('user_devices')
        .doc(normalizedEmail)
        .collection('devices')
        .select(
          'deviceId',
          'deviceType',
          'isOnline',
          'lastSeen',
          'lastTenantPingAt',
          'lastActivityType',
          'lastPingType',
          'activeTenantId',
          'lastTenantId',
          'tenantIds',
          'notificationsEnabled',
          'chatNotificationsEnabled',
          'expoPushToken',
          'pushTokenStatus',
          'webPushSubscription',
          'webPushStatus',
          'activeChatPartner',
          'activeChatPartnerId',
          'activeChatPartnerName',
          'activeChatIsFocused',
          'activeChatLastSeenAt',
          'activeChatLastMessageId',
          'activeChatLastMessageTimestamp',
          'webPushClientLastReceiptAt',
          'webPushClientLastReceiptType',
          'webPushClientLastReceiptNotificationId',
          'isDeleted',
        )
        .get();

      const devices = devicesSnap.docs
        .map((doc) => {
          const data = doc.data() || {};
          const deviceId = typeof data.deviceId === 'string' && data.deviceId.trim() ? data.deviceId.trim() : doc.id;
          const tenantIds = Array.isArray(data.tenantIds)
            ? data.tenantIds.filter((id: unknown) => typeof id === 'string' && id.trim()).map((id: string) => id.trim())
            : [];
          const activeTenantId = typeof data.activeTenantId === 'string' ? data.activeTenantId : undefined;
          const lastTenantId = typeof data.lastTenantId === 'string' ? data.lastTenantId : undefined;
          const isForTenant = tenantIds.includes(tenantId) || activeTenantId === tenantId || lastTenantId === tenantId;
          if (!isForTenant) return null;

          return {
            deviceId,
            deviceType: typeof data.deviceType === 'string' ? data.deviceType : undefined,
            isOnline: typeof data.isOnline === 'boolean' ? data.isOnline : undefined,
            lastSeen: toIso(data.lastSeen),
            lastTenantPingAt: toIso(data.lastTenantPingAt),
            lastActivityType: typeof data.lastActivityType === 'string' ? data.lastActivityType : undefined,
            lastPingType: typeof data.lastPingType === 'string' ? data.lastPingType : undefined,
            activeTenantId,
            lastTenantId,
            tenantIds,
            notificationsEnabled: typeof data.notificationsEnabled === 'boolean' ? data.notificationsEnabled : undefined,
            chatNotificationsEnabled:
              typeof data.chatNotificationsEnabled === 'boolean' ? data.chatNotificationsEnabled : undefined,
            pushTokenStatus: typeof data.pushTokenStatus === 'string' ? data.pushTokenStatus : undefined,
            webPushStatus: typeof data.webPushStatus === 'string' ? data.webPushStatus : undefined,
            hasExpoPushToken: typeof data.expoPushToken === 'string' && data.expoPushToken.trim().length > 0,
            hasWebPushSubscription:
              typeof data.webPushSubscription?.endpoint === 'string' && data.webPushSubscription.endpoint.trim().length > 0,
            activeChatPartner: typeof data.activeChatPartner === 'string' ? data.activeChatPartner : undefined,
            activeChatPartnerId: typeof data.activeChatPartnerId === 'string' ? data.activeChatPartnerId : undefined,
            activeChatPartnerName: typeof data.activeChatPartnerName === 'string' ? data.activeChatPartnerName : undefined,
            activeChatIsFocused: typeof data.activeChatIsFocused === 'boolean' ? data.activeChatIsFocused : undefined,
            activeChatLastSeenAt: toIso(data.activeChatLastSeenAt),
            activeChatLastMessageId: typeof data.activeChatLastMessageId === 'string' ? data.activeChatLastMessageId : undefined,
            activeChatLastMessageTimestamp: toIso(data.activeChatLastMessageTimestamp),
            webPushClientLastReceiptAt: toIso(data.webPushClientLastReceiptAt),
            webPushClientLastReceiptType:
              typeof data.webPushClientLastReceiptType === 'string' ? data.webPushClientLastReceiptType : undefined,
            webPushClientLastReceiptNotificationId:
              typeof data.webPushClientLastReceiptNotificationId === 'string'
                ? data.webPushClientLastReceiptNotificationId
                : undefined,
            isDeleted: typeof data.isDeleted === 'boolean' ? data.isDeleted : undefined,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));

      devices.sort((a, b) => {
        const aOnline = a.isOnline === true ? 1 : 0;
        const bOnline = b.isOnline === true ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;
        const aSeen = a.lastSeen ? Date.parse(a.lastSeen) : 0;
        const bSeen = b.lastSeen ? Date.parse(b.lastSeen) : 0;
        return bSeen - aSeen;
      });

      return res.json({ ok: true, tenantId, email: normalizedEmail, devices });
    } catch (error) {
      console.error('[admin_user_devices] lookup failed', error);
      return res.status(500).json({ error: 'device_lookup_failed' });
    }
  });

  // -------------------------------------------------------------------------
  // Device Console — read/listing endpoints (Device Admin API)
  // -------------------------------------------------------------------------
  //
  // All four routes sit behind the SAME master-token / global-admin gate as the
  // other `/admin/tenants/...` routes (Requirements 16.1, 16.2; Property 16):
  // no auth context or a non-admin caller is rejected with 403 `not_authorized`
  // and no state is read. Bodies are validated with `zod` (400 `validation_failed`
  // with `issues`). These are pure reads — they never mutate device/ban/signal
  // state — and delegate to `deviceAdminService`.

  // #1 List/search/filter/sort devices for a tenant, with online/offline counts.
  //
  // Pagination (Recommendation #2 — result-set pagination): the tenant-wide
  // counts and the search/filter/sort/hide-inactive pipeline are computed over
  // the FULL tenant device set (so counts stay exact), then the deterministic
  // ordered result is sliced into a page via `paginateDevices` using a real
  // opaque `cursor` (base64url offset). The response carries `hasMore` and an
  // optional `nextCursor` for the next page. TRADEOFF: each page still scans the
  // full tenant set (read cost O(tenant devices), not O(limit)); the future path
  // to read-bounded pagination is an external search index + precomputed
  // aggregate counters. See `deviceAdminService.paginateDevices` for details.
  app.post('/admin/tenants/devices', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceListSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const search = parsed.data.search ?? '';
    const filter: DeviceFilter = parsed.data.filter ?? 'all';
    const sort: DeviceSort = parsed.data.sort ?? 'lastSeen';
    const hideInactive = parsed.data.hideInactive === true;
    const limit = parsed.data.limit;

    try {
      const nowMs = Date.now();

      // Tenant-scoped devices (design Property 3 — scoping done in the service
      // via `filterDevicesForTenant`).
      const tenantDevices = await listTenantDevices(tenantId);

      // Counts reflect the Selected_Tenant's devices (Req 1.3, 1.8) independent
      // of the active search/filter; `computeCounts` guarantees
      // `online + offline === total` (Property 2).
      const counts = computeCounts(tenantDevices, nowMs);

      // Narrow to the displayed set: search (Req 4) + filter (Req 5.1) +
      // optional hide-inactive (Req 5.5).
      let visible = tenantDevices.filter(
        (device) => matchesSearch(device, search) && matchesFilter(device, filter, nowMs)
      );
      if (hideInactive) {
        visible = visible.filter((device) => !isInactiveDevice(device));
      }

      // Group by owner email (A→Z, no-owner group last) and sort in-group
      // (Req 5.2, 5.3, 5.6, 5.7), then flatten preserving that order. Each
      // record still carries `ownerEmail`, so grouping is losslessly derivable.
      const grouped = sortAndGroup(visible, sort, nowMs);
      const orderedDevices: DeviceAdminRecord[] = grouped.flatMap((group) => group.devices);

      // Result-set pagination (Recommendation #2): counts (above) are exact over
      // the full tenant set; here we slice the deterministic ordered result with
      // a real opaque cursor so matches beyond `limit` are reachable via
      // `nextCursor` instead of being silently dropped.
      const { page, hasMore, nextCursor } = paginateDevices(
        orderedDevices,
        parsed.data.cursor,
        limit ?? DEFAULT_DEVICE_LIST_LIMIT
      );

      return res.json({
        ok: true,
        tenantId,
        counts,
        devices: page,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
      });
    } catch (error) {
      console.error('[admin_devices_list] load failed', error);
      // The Device Console retains previously displayed data (Req 1.7); the
      // server just reports the failure.
      return res.status(500).json({ error: 'device_list_failed' });
    }
  });

  // #2 Full device detail + provenance for one device.
  app.post('/admin/tenants/devices/detail', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceDetailSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    try {
      const device = await fetchDeviceDetail({ tenantId, email: normalizedEmail, deviceId });
      return res.json({ ok: true, device });
    } catch (error) {
      // Typed service errors carry the status + code the route should return:
      // 404 `device_not_found`, 403 `tenant_scope_violation` (Req 6.6, 3.2, 3.3).
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_detail] load failed', error);
      return res.status(500).json({ error: 'device_detail_failed' });
    }
  });

  // #12 Tenant-scoped action + notification history (most-recent-first).
  app.post('/admin/tenants/devices/history', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceHistorySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();

    try {
      const result = await fetchDeviceHistory({
        tenantId,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
        action: parsed.data.action,
      });
      const response: {
        ok: true;
        entries: typeof result.entries;
        hasMore: boolean;
        nextCursor?: string;
      } = { ok: true, entries: result.entries, hasMore: result.hasMore };
      if (result.nextCursor) {
        response.nextCursor = result.nextCursor;
      }
      return res.json(response);
    } catch (error) {
      // All-or-nothing: on failure return no partial entries (Req 13.4, 13.5).
      console.error('[admin_devices_history] load failed', error);
      return res.status(500).json({ error: 'history_failed' });
    }
  });

  // #13 Per-device activity timeline (oldest-first, stable tie-break).
  app.post('/admin/tenants/devices/timeline', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceTimelineSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    try {
      const result = await fetchDeviceTimeline({
        tenantId,
        email: normalizedEmail,
        deviceId,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      });
      const response: {
        ok: true;
        entries: typeof result.entries;
        hasMore: boolean;
        nextCursor?: string;
      } = { ok: true, entries: result.entries, hasMore: result.hasMore };
      if (result.nextCursor) {
        response.nextCursor = result.nextCursor;
      }
      return res.json(response);
    } catch (error) {
      // Typed service errors carry the status + code the route should return:
      // 404 `device_not_found`, 403 `tenant_scope_violation` (Req 6.6, 3.2, 3.3).
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      // All-or-nothing: on any other failure return no partial entries.
      console.error('[admin_devices_timeline] load failed', error);
      return res.status(500).json({ error: 'timeline_failed' });
    }
  });

  // -------------------------------------------------------------------------
  // Device Console — single-device destructive endpoints (Device Admin API)
  // -------------------------------------------------------------------------
  //
  // Same master-token / global-admin gate as the read endpoints above
  // (Req 16.1, 16.2): no auth context or a non-admin caller → 403 `not_authorized`
  // with no state change. Bodies are `zod`-validated (400 `validation_failed`).
  // Each resolves the acting admin identity the same way the other admin routes
  // do — `resolveAuthenticatedEmail(authContext)` for `actor.email` and
  // `authContext.uid` for `actor.id` — and threads it onto provenance + audit.
  // Tenant scoping (Req 3.2/3.3/3.6) is enforced inside the orchestrators, which
  // throw `tenant_scope_violation`→403. All thrown `DeviceAdminError`s carry the
  // exact `status` + `code` the route should return, so a single mapping covers
  // every lifecycle/conflict/scope case; unknown errors → 500.

  // #3 Force logout a single device (Req 7.1, 7.3, 7.5, 7.7).
  app.post('/admin/tenants/devices/force-logout', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceActionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      await forceLogout({ tenantId, email: normalizedEmail, deviceId, actor, reason: parsed.data.reason });
      return res.json({ ok: true });
    } catch (error) {
      // Maps already_deleted→409, device_not_found→404, tenant_scope_violation→403,
      // signal_write_failed→500 via the carried status + code.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_force_logout] failed', error);
      return res.status(500).json({ error: 'force_logout_failed' });
    }
  });

  // #6 Ban a single device by fingerprint (Req 8.1, 8.4, 8.6, 8.8).
  app.post('/admin/tenants/devices/ban', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceBanSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    // Reason is required (1–500 after trimming) — Req 8.1/8.4.
    const reasonResult = validateReason(parsed.data.reason);
    if (!reasonResult.ok) {
      return res.status(400).json({ error: 'invalid_reason' });
    }
    // Optional expiration must be strictly later than now — Req 8.8.
    const expirationResult = validateExpiration(parsed.data.expiresAt, Date.now());
    if (!expirationResult.ok) {
      return res.status(400).json({ error: 'invalid_expiration' });
    }

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      const result = await ban({
        tenantId,
        email: normalizedEmail,
        deviceId,
        actor,
        reason: reasonResult.value,
        expiresAt: parsed.data.expiresAt ?? null,
      });
      return res.json({ ok: true, banId: result.banId });
    } catch (error) {
      // Maps active_ban_exists→409, device_not_found→404, tenant_scope_violation→403.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_ban] failed', error);
      return res.status(500).json({ error: 'ban_failed' });
    }
  });

  // #7 Remove an active ban and restore access (Req 8.7).
  app.post('/admin/tenants/devices/unban', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceActionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      await unban({ tenantId, email: normalizedEmail, deviceId, actor, reason: parsed.data.reason });
      return res.json({ ok: true });
    } catch (error) {
      // Maps no_active_ban→409, device_not_found→404, tenant_scope_violation→403.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_unban] failed', error);
      return res.status(500).json({ error: 'unban_failed' });
    }
  });

  // #8 Soft-delete a single device (Req 9.1, 9.2, 9.5, 9.7).
  app.post('/admin/tenants/devices/delete', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceActionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    // Reason is required (1–500 after trimming) — Req 9.2.
    const reasonResult = validateReason(parsed.data.reason);
    if (!reasonResult.ok) {
      return res.status(400).json({ error: 'invalid_reason' });
    }

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      await softDelete({ tenantId, email: normalizedEmail, deviceId, actor, reason: reasonResult.value });
      return res.json({ ok: true });
    } catch (error) {
      // Maps already_deleted→409, device_not_found→404, tenant_scope_violation→403.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_delete] failed', error);
      return res.status(500).json({ error: 'delete_failed' });
    }
  });

  // #9 Restore a soft-deleted device (Req 9.3, 9.6).
  app.post('/admin/tenants/devices/restore', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceActionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      await restore({ tenantId, email: normalizedEmail, deviceId, actor, reason: parsed.data.reason });
      return res.json({ ok: true });
    } catch (error) {
      // Maps not_deleted→409, device_not_found→404, tenant_scope_violation→403.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_restore] failed', error);
      return res.status(500).json({ error: 'restore_failed' });
    }
  });

  // #10 Permanently delete a device + related tracking records (Req 10.1, 10.2, 10.4, 10.6).
  app.post('/admin/tenants/devices/permanent-delete', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceActionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    const deviceId = parsed.data.deviceId.trim();

    // Reason is required (1–500 after trimming) — Req 10.2.
    const reasonResult = validateReason(parsed.data.reason);
    if (!reasonResult.ok) {
      return res.status(400).json({ error: 'invalid_reason' });
    }

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      await permanentDelete({ tenantId, email: normalizedEmail, deviceId, actor, reason: reasonResult.value });
      return res.json({ ok: true });
    } catch (error) {
      // Maps device_not_found→404, delete_rolled_back→500, tenant_scope_violation→403.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_permanent_delete] failed', error);
      return res.status(500).json({ error: 'permanent_delete_failed' });
    }
  });

  // -------------------------------------------------------------------------
  // Device Console — user-scoped + bulk endpoints (Device Admin API)
  // -------------------------------------------------------------------------
  //
  // Same master-token / global-admin gate as the single-device routes above
  // (Req 15.4, 16.1, 16.2): no auth context or a non-admin caller → 403
  // `not_authorized` with no state change. Bodies are `zod`-validated (400
  // `validation_failed`); notify/bulk additionally run the pure
  // `validateTitle`/`validateMessage`/`validateTargets` helpers so out-of-bounds
  // titles/messages and empty/over-limit selections surface as the specific
  // codes (`invalid_title`, `invalid_message`, `empty_recipients`,
  // `too_many_targets`) before any fan-out. Each resolves the acting admin
  // identity the same way the single-device routes do —
  // `resolveAuthenticatedEmail(authContext)` for `actor.email`/`actor.name` and
  // `authContext.uid` for `actor.id`.

  // #4 Force logout ALL active in-tenant devices of a user (Req 11.1, 11.4).
  app.post('/admin/tenants/devices/force-logout-all', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceForceLogoutAllSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      const result = await forceLogoutAll({ tenantId, email: normalizedEmail, actor, reason: parsed.data.reason });
      return res.json({ ok: true, affected: result.affected });
    } catch (error) {
      // Partial signal-write failure: some devices were signaled, others retained
      // their sessions — return 500 identifying the affected devices (Req 11.4).
      // Checked BEFORE the generic mapping because ForceLogoutAllError extends
      // DeviceAdminError.
      if (error instanceof ForceLogoutAllError) {
        return res.status(500).json({
          error: 'signal_write_failed',
          affected: error.affected,
          failedDeviceIds: error.failedDeviceIds,
        });
      }
      // Maps tenant_scope_violation→403 and any other typed lifecycle error via
      // the carried status + code (Req 11.1).
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_force_logout_all] failed', error);
      return res.status(500).json({ error: 'force_logout_all_failed' });
    }
  });

  // #5 Bulk force-logout up to 500 selected devices (Req 14.2, 14.4, 14.7).
  app.post('/admin/tenants/devices/bulk/force-logout', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceBulkForceLogoutSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();

    // Non-empty + ≤500 bounds → specific `too_many_targets` over the limit,
    // otherwise `validation_failed` (empty/other) — Req 14.2/14.4.
    const targetsResult = validateTargets(parsed.data.targets);
    if (!targetsResult.ok) {
      const code = parsed.data.targets.length > DEFAULT_MAX_TARGETS ? 'too_many_targets' : 'validation_failed';
      return res.status(400).json({ error: code });
    }

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      const result = await bulkForceLogout({
        tenantId,
        targets: targetsResult.value,
        actor,
        reason: parsed.data.reason,
      });
      // Bulk completeness: succeeded + failed === targets, one outcome each,
      // failures never block successes (Req 14.7; design Property 18).
      return res.json({ ok: true, succeeded: result.succeeded, failed: result.failed, results: result.results });
    } catch (error) {
      // Maps too_many_targets→400, tenant_scope_violation→403 via status + code.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_bulk_force_logout] failed', error);
      return res.status(500).json({ error: 'bulk_force_logout_failed' });
    }
  });

  // #11 Compose + send a notification to selected devices (Req 12.1, 12.4, 12.6, 14.4).
  app.post('/admin/tenants/devices/notify', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantDeviceNotifySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();

    // Title 1–100 (Req 12.1) and message 1–500 (Req 12.4) after trimming.
    const titleResult = validateTitle(parsed.data.title);
    if (!titleResult.ok) {
      return res.status(400).json({ error: 'invalid_title' });
    }
    const messageResult = validateMessage(parsed.data.body);
    if (!messageResult.ok) {
      return res.status(400).json({ error: 'invalid_message' });
    }
    // Non-empty recipients (Req 12.6) capped at 500 (Req 14.4): empty →
    // `empty_recipients`, over the limit → `too_many_targets`.
    const targetsResult = validateTargets(parsed.data.targets);
    if (!targetsResult.ok) {
      const code = parsed.data.targets.length > DEFAULT_MAX_TARGETS ? 'too_many_targets' : 'empty_recipients';
      return res.status(400).json({ error: code });
    }

    try {
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const actor = { id: authContext.uid, email: actorEmail ?? undefined, name: actorEmail ?? undefined };
      const result = await notify({
        tenantId,
        title: titleResult.value,
        body: messageResult.value,
        targets: targetsResult.value,
        actor,
        priority: parsed.data.priority,
      });
      // Aggregate completeness: successful + failed === targets, one outcome each
      // (Req 12.5/12.7; design Property 18).
      return res.json({ ok: true, successful: result.successful, failed: result.failed, results: result.results });
    } catch (error) {
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[admin_devices_notify] failed', error);
      return res.status(500).json({ error: 'notify_failed' });
    }
  });

  app.post('/admin/tenants/memberships/role', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = adminMembershipRoleOverrideSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    const targetUserId = parsed.data.userId.trim();
    const desiredRole = parsed.data.role;

    try {
      const db = getFirestoreImpl();
      const membershipId = membershipDocId(tenantId, targetUserId);
      const membershipRef = db.collection('tenantMemberships').doc(membershipId);
      const membershipSnap = await membershipRef.get();
      if (!membershipSnap.exists) {
        return res.status(404).json({ error: 'membership_not_found' });
      }

      const membership = membershipSnap.data() || {};
      const previousRoleResult = tenantMembershipRoleSchema.safeParse(
        typeof membership.role === 'string' ? membership.role : 'member'
      );
      const previousRole = previousRoleResult.success ? previousRoleResult.data : 'member';

      if (previousRole === desiredRole) {
        return res.json({
          ok: true,
          changed: false,
          membership: {
            id: membershipId,
            tenantId,
            userId: targetUserId,
            role: previousRole,
            status: membership.status,
          },
        });
      }

      const nowIso = new Date().toISOString();
      await membershipRef.update({ role: desiredRole, updatedAt: nowIso });

      const actorId = authContext.uid || authContext.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      const metadata = parsed.data.metadata || {};
      const auditMetadata: Record<string, unknown> = {
        previousRole,
        newRole: desiredRole,
        previousStatus: membership.status,
        actorRole: authContext.tokenType === 'master' ? 'master' : 'global_admin',
      };
      if (metadata.reason) {
        auditMetadata.reason = metadata.reason;
      }
      if (metadata.initiatedFrom) {
        auditMetadata.initiatedFrom = metadata.initiatedFrom;
      }
      if (metadata.actorName) {
        auditMetadata.actorName = metadata.actorName;
      }

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: 'membership_role_changed',
          targetId: membershipId,
          targetType: 'membership',
          metadata: auditMetadata,
          createdAt: nowIso,
        })
      );

      const notificationMetadata: Record<string, any> = {
        displayName: typeof membership.displayName === 'string' ? membership.displayName : undefined,
        reason: metadata.reason ?? 'admin_console_role_override',
        initiatedFrom: metadata.initiatedFrom ?? 'system',
        actorName: metadata.actorName,
      };

      void sendTeamMembershipChangeNotificationImpl({
        tenantId,
        tenantName: typeof membership.tenantName === 'string' ? membership.tenantName : undefined,
        action: 'role_changed',
        targetEmail: membership.email,
        targetRole: desiredRole,
        previousRole,
        metadata: notificationMetadata,
      }).catch((error) => console.warn('[admin_membership_role_override] notify failed', error));

      return res.json({
        ok: true,
        changed: true,
        membership: {
          id: membershipId,
          tenantId,
          userId: targetUserId,
          role: desiredRole,
          status: membership.status,
          updatedAt: nowIso,
        },
      });
    } catch (error) {
      console.error('[admin_membership_role_override] failed', error);
      return res.status(500).json({ error: 'role_update_failed' });
    }
  });

  app.post('/admin/tenants/invites', optionalBodyStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const parsed = tenantInviteInspectorSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    const tenantId = tenantAccess?.tenantId ?? parsed.data.tenantId;
    if (!tenantId && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    try {
      const payload = await runTenantInviteInspectorImpl({
        tenantId,
        limit: parsed.data.limit ?? 75,
        status: parsed.data.status,
        search: parsed.data.search,
      });
      if (!payload) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }
      return res.json(payload);
    } catch (error) {
      console.error('[tenant_invites] lookup failed', error);
      return res.status(500).json({ error: 'invite_lookup_failed' });
    }
  });

  app.post('/admin/tenants/audit', optionalBodyStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const parsed = tenantAuditInspectorSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    const tenantId = tenantAccess?.tenantId ?? parsed.data.tenantId;
    if (!tenantId && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    try {
      const payload = await runTenantAuditInspectorImpl({
        tenantId,
        limit: parsed.data.limit ?? 100,
        action: parsed.data.action,
        search: parsed.data.search,
      });
      if (!payload) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }
      return res.json(payload);
    } catch (error) {
      console.error('[tenant_audit] lookup failed', error);
      return res.status(500).json({ error: 'audit_lookup_failed' });
    }
  });

  app.post('/admin/notifications/history', optionalBodyStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const parsed = notificationHistoryInspectorSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    const tenantId = tenantAccess?.tenantId ?? parsed.data.tenantId;
    if (!tenantId && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    try {
      const payload = await runNotificationHistoryInspectorImpl({
        tenantId,
        adminEmail: parsed.data.adminEmail,
        limit: parsed.data.limit ?? 50,
        cursor: parsed.data.cursor,
      });
      return res.json(payload);
    } catch (error) {
      console.error('[notification_history] lookup failed', error);
      return res.status(500).json({ error: 'notification_history_failed' });
    }
  });

  app.post('/admin/notifications/stats', optionalBodyStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const parsed = notificationStatsInspectorSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    const tenantId = tenantAccess?.tenantId ?? parsed.data.tenantId;
    if (!tenantId && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }
    try {
      const payload = await runNotificationStatsInspectorImpl({
        tenantId,
        adminEmail: parsed.data.adminEmail,
        days: parsed.data.days ?? 30,
      });
      return res.json(payload);
    } catch (error) {
      console.error('[notification_stats] lookup failed', error);
      return res.status(500).json({ error: 'notification_stats_failed' });
    }
  });

  const runtimeEndpointsAdminUpdateSchema = z
    .object({
      apiBaseUrl: z.string().trim().min(1).optional(),
      emailApiBaseUrl: z.string().trim().min(1).optional(),
      notificationsApiBaseUrl: z.string().trim().min(1).optional(),
      wabaApiBaseUrl: z.string().trim().min(1).optional(),
      chatApiBaseUrl: z.string().trim().min(1).optional(),
      webAppBaseUrl: z.string().trim().min(1).optional(),
    })
    .strict();

  function normalizeRuntimeEndpointUrl(value: string | undefined): string | undefined {
    if (value == null) return undefined;
    const trimmed = String(value).trim().replace(/\/+$/, '');
    return trimmed ? trimmed : undefined;
  }

  app.get('/admin/settings/runtime-endpoints', requireOperatorAuth, async (_req, res) => {
    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appSettings').doc('runtimeEndpoints');
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      return res.json({ ok: true, data });
    } catch (error) {
      console.error('[admin_runtime_endpoints] fetch failed', error);
      return res.status(500).json({ error: 'runtime_endpoints_fetch_failed' });
    }
  });

  app.post('/admin/settings/runtime-endpoints', requireOperatorAuth, async (req, res) => {
    const parsed = runtimeEndpointsAdminUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const patch: Record<string, string> = {};
    const apiBaseUrl = normalizeRuntimeEndpointUrl(parsed.data.apiBaseUrl);
    const emailApiBaseUrl = normalizeRuntimeEndpointUrl(parsed.data.emailApiBaseUrl);
    const notificationsApiBaseUrl = normalizeRuntimeEndpointUrl(parsed.data.notificationsApiBaseUrl);
    const wabaApiBaseUrl = normalizeRuntimeEndpointUrl(parsed.data.wabaApiBaseUrl);
    const chatApiBaseUrl = normalizeRuntimeEndpointUrl(parsed.data.chatApiBaseUrl);
    const webAppBaseUrl = normalizeRuntimeEndpointUrl(parsed.data.webAppBaseUrl);

    if (apiBaseUrl) patch.apiBaseUrl = apiBaseUrl;
    if (emailApiBaseUrl) patch.emailApiBaseUrl = emailApiBaseUrl;
    if (notificationsApiBaseUrl) patch.notificationsApiBaseUrl = notificationsApiBaseUrl;
    if (wabaApiBaseUrl) patch.wabaApiBaseUrl = wabaApiBaseUrl;
    if (chatApiBaseUrl) patch.chatApiBaseUrl = chatApiBaseUrl;
    if (webAppBaseUrl) patch.webAppBaseUrl = webAppBaseUrl;

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'empty_update' });
    }

    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appSettings').doc('runtimeEndpoints');
      const now = new Date().toISOString();
      const snap = await ref.get();
      const isCreate = !snap.exists;
      await ref.set({ ...patch, updatedAt: now, ...(isCreate ? { createdAt: now } : {}) }, { merge: true });
      const updated = await ref.get();
      return res.json({ ok: true, data: updated.data() ?? null });
    } catch (error) {
      console.error('[admin_runtime_endpoints] update failed', error);
      return res.status(500).json({ error: 'runtime_endpoints_update_failed' });
    }
  });

  const maintenanceModeAdminUpdateSchema = z
    .object({
      enabled: z.boolean().optional(),
      message: z.string().optional(),
    })
    .strict();

  app.get('/admin/settings/maintenance', requireOperatorAuth, async (_req, res) => {
    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appConfig').doc('maintenance');
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      return res.json({ ok: true, data });
    } catch (error) {
      console.error('[admin_maintenance_mode] fetch failed', error);
      return res.status(500).json({ error: 'maintenance_fetch_failed' });
    }
  });

  app.post('/admin/settings/maintenance', requireOperatorAuth, async (req, res) => {
    const parsed = maintenanceModeAdminUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const patch: Record<string, unknown> = {};
    if (typeof parsed.data.enabled === 'boolean') {
      patch.enabled = parsed.data.enabled;
    }
    if (typeof parsed.data.message === 'string') {
      patch.message = parsed.data.message;
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'empty_update' });
    }

    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appConfig').doc('maintenance');
      const now = new Date().toISOString();
      const snap = await ref.get();
      const isCreate = !snap.exists;
      await ref.set({ ...patch, updatedAt: now, ...(isCreate ? { createdAt: now } : {}) }, { merge: true });
      const updated = await ref.get();
      return res.json({ ok: true, data: updated.data() ?? null });
    } catch (error) {
      console.error('[admin_maintenance_mode] update failed', error);
      return res.status(500).json({ error: 'maintenance_update_failed' });
    }
  });

  const reminderChannelsAdminUpdateSchema = z
    .object({
      enabledChannels: z
        .object({
          email: z.boolean().optional(),
          sms: z.boolean().optional(),
          whatsapp: z.boolean().optional(),
          voice: z.boolean().optional(),
        })
        .strict()
        .optional(),
      channelMessages: z
        .object({
          email: z.string().optional(),
          sms: z.string().optional(),
          whatsapp: z.string().optional(),
          voice: z.string().optional(),
        })
        .strict()
        .optional(),
      hideDisabledReminderTypes: z.boolean().optional(),
    })
    .strict();

  app.get('/admin/settings/reminder-channels', requireOperatorAuth, async (_req, res) => {
    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appSettings').doc('reminderChannels');
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      return res.json({ ok: true, data });
    } catch (error) {
      console.error('[admin_reminder_channels] fetch failed', error);
      return res.status(500).json({ error: 'reminder_channels_fetch_failed' });
    }
  });

  app.post('/admin/settings/reminder-channels', requireOperatorAuth, async (req, res) => {
    const parsed = reminderChannelsAdminUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.enabledChannels && Object.keys(parsed.data.enabledChannels).length) {
      patch.enabledChannels = parsed.data.enabledChannels;
    }
    if (parsed.data.channelMessages && Object.keys(parsed.data.channelMessages).length) {
      patch.channelMessages = parsed.data.channelMessages;
    }
    if (typeof parsed.data.hideDisabledReminderTypes === 'boolean') {
      patch.hideDisabledReminderTypes = parsed.data.hideDisabledReminderTypes;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'empty_update' });
    }

    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appSettings').doc('reminderChannels');
      const now = new Date().toISOString();
      const snap = await ref.get();
      const isCreate = !snap.exists;
      await ref.set({ ...patch, updatedAt: now, ...(isCreate ? { createdAt: now } : {}) }, { merge: true });
      const updated = await ref.get();
      return res.json({ ok: true, data: updated.data() ?? null });
    } catch (error) {
      console.error('[admin_reminder_channels] update failed', error);
      return res.status(500).json({ error: 'reminder_channels_update_failed' });
    }
  });

  // ── Global app settings (security-rules-hardening H2) ──────────────────────
  // appSettings/globalSettings holds GLOBAL, app-wide config (support contact,
  // legal links, default brand). It is world-readable to signed-in clients but
  // client writes are now denied by firestore.rules (write: if isAdmin()); the
  // operator admin-console edits it here via the Admin SDK. The tenant-scoped
  // visibility flags (allowNonAdminAllReminderHistory / hideAuthorizedEmailsForNonAdmins)
  // were moved to tenants/{id}.settings and are intentionally NOT settable here.
  const globalSettingsAdminUpdateSchema = z
    .object({
      supportEmail: z.string().trim().email().optional(),
      supportPhone: z.string().trim().max(40).optional(),
      whatsappNumber: z.string().trim().max(40).optional(),
      bugReportFormUrl: z.string().trim().max(2000).optional(),
      coachingName: z.string().trim().max(160).optional(),
      legal: z
        .object({
          privacyPolicyUrl: z.string().trim().max(2000).optional(),
          termsOfServiceUrl: z.string().trim().max(2000).optional(),
        })
        .strict()
        .optional(),
    })
    .strict();

  app.get('/admin/settings/global-settings', requireOperatorAuth, async (_req, res) => {
    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appSettings').doc('globalSettings');
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      return res.json({ ok: true, data });
    } catch (error) {
      console.error('[admin_global_settings] fetch failed', error);
      return res.status(500).json({ error: 'global_settings_fetch_failed' });
    }
  });

  app.post('/admin/settings/global-settings', requireOperatorAuth, async (req, res) => {
    const parsed = globalSettingsAdminUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const { legal, ...topLevel } = parsed.data;
    const patch: Record<string, unknown> = { ...topLevel };
    if (!Object.keys(parsed.data).length) {
      return res.status(400).json({ error: 'empty_update' });
    }

    try {
      const db = getFirestoreImpl();
      const ref = db.collection('appSettings').doc('globalSettings');
      const snap = await ref.get();
      const now = new Date().toISOString();
      const isCreate = !snap.exists;
      // Deep-merge the `legal` sub-map instead of overwriting it wholesale.
      if (legal && Object.keys(legal).length) {
        const existingLegal = (snap.data()?.legal as Record<string, unknown> | undefined) || {};
        patch.legal = { ...existingLegal, ...legal };
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'empty_update' });
      }
      await ref.set({ ...patch, updatedAt: now, ...(isCreate ? { createdAt: now } : {}) }, { merge: true });
      const updated = await ref.get();
      return res.json({ ok: true, data: updated.data() ?? null });
    } catch (error) {
      console.error('[admin_global_settings] update failed', error);
      return res.status(500).json({ error: 'global_settings_update_failed' });
    }
  });

  const tenantReminderSettingsQuerySchema = z
    .object({
      tenantId: z.string().trim().min(1),
    })
    .strict();

  const tenantReminderSettingsUpdateSchema = z
    .object({
      tenantId: z.string().trim().min(1),
      enabledChannels: z
        .object({
          email: z.boolean().optional(),
          sms: z.boolean().optional(),
          whatsapp: z.boolean().optional(),
          voice: z.boolean().optional(),
        })
        .strict()
        .optional(),
      channelMessages: z
        .object({
          email: z.string().optional(),
          sms: z.string().optional(),
          whatsapp: z.string().optional(),
          voice: z.string().optional(),
        })
        .strict()
        .optional(),
      // When null, the tenant override is cleared (inherit global).
      hideDisabledReminderTypes: z.boolean().nullable().optional(),
    })
    .strict();

  type ReminderChannelPolicy = {
    enabled: Record<'email' | 'sms' | 'whatsapp' | 'voice', boolean>;
    messages: Partial<Record<'email' | 'sms' | 'whatsapp' | 'voice', string>>;
  };

  async function getGlobalReminderChannelPolicy(db: admin.firestore.Firestore): Promise<ReminderChannelPolicy> {
    const ref = db.collection('appSettings').doc('reminderChannels');
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() as any) : null;
    const enabled = data?.enabledChannels as any;
    const messages = data?.channelMessages as any;
    return {
      enabled: {
        email: enabled?.email !== false,
        sms: enabled?.sms !== false,
        whatsapp: enabled?.whatsapp !== false,
        voice: enabled?.voice !== false,
      },
      messages: {
        email: typeof messages?.email === 'string' ? messages.email : undefined,
        sms: typeof messages?.sms === 'string' ? messages.sms : undefined,
        whatsapp: typeof messages?.whatsapp === 'string' ? messages.whatsapp : undefined,
        voice: typeof messages?.voice === 'string' ? messages.voice : undefined,
      },
    };
  }

  async function getTenantReminderChannelPolicy(
    db: admin.firestore.Firestore,
    tenantId: string,
  ): Promise<ReminderChannelPolicy> {
    const ref = db.collection('tenants').doc(tenantId).collection('settings').doc('reminders');
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() as any) : null;
    const enabled = data?.enabledChannels as any;
    const messages = data?.channelMessages as any;

    return {
      enabled: {
        email: enabled?.email !== false,
        sms: enabled?.sms !== false,
        whatsapp: enabled?.whatsapp !== false,
        voice: enabled?.voice !== false,
      },
      messages: {
        email: typeof messages?.email === 'string' ? messages.email : undefined,
        sms: typeof messages?.sms === 'string' ? messages.sms : undefined,
        whatsapp: typeof messages?.whatsapp === 'string' ? messages.whatsapp : undefined,
        voice: typeof messages?.voice === 'string' ? messages.voice : undefined,
      },
    };
  }

  async function getEffectiveReminderChannelPolicy(
    db: admin.firestore.Firestore,
    tenantId: string,
  ): Promise<ReminderChannelPolicy> {
    const [global, tenant] = await Promise.all([
      getGlobalReminderChannelPolicy(db),
      getTenantReminderChannelPolicy(db, tenantId),
    ]);

    const enabled: ReminderChannelPolicy['enabled'] = {
      email: global.enabled.email && tenant.enabled.email,
      sms: global.enabled.sms && tenant.enabled.sms,
      whatsapp: global.enabled.whatsapp && tenant.enabled.whatsapp,
      voice: global.enabled.voice && tenant.enabled.voice,
    };

    // Prefer tenant message if present; else fall back to global message.
    const messages: ReminderChannelPolicy['messages'] = {
      email: (tenant.messages.email || '').trim() ? tenant.messages.email : global.messages.email,
      sms: (tenant.messages.sms || '').trim() ? tenant.messages.sms : global.messages.sms,
      whatsapp: (tenant.messages.whatsapp || '').trim() ? tenant.messages.whatsapp : global.messages.whatsapp,
      voice: (tenant.messages.voice || '').trim() ? tenant.messages.voice : global.messages.voice,
    };

    return { enabled, messages };
  }

  function computeDisabledReminderChannels(
    enabled: Record<'email' | 'sms' | 'whatsapp' | 'voice', boolean>,
    requested: Partial<Record<'email' | 'sms' | 'whatsapp' | 'voice', number>>,
  ): Array<'email' | 'sms' | 'whatsapp' | 'voice'> {
    const disabled: Array<'email' | 'sms' | 'whatsapp' | 'voice'> = [];
    (['email', 'sms', 'whatsapp', 'voice'] as const).forEach((channel) => {
      const count = requested[channel] || 0;
      if (count > 0 && !enabled[channel]) disabled.push(channel);
    });
    return disabled;
  }

  app.get('/admin/tenants/reminder-settings', requireOperatorAuth, async (req, res) => {
    const parsed = tenantReminderSettingsQuerySchema.safeParse({
      tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : '',
    });
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const db = getFirestoreImpl();
      const ref = db.collection('tenants').doc(parsed.data.tenantId).collection('settings').doc('reminders');
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      return res.json({ ok: true, data });
    } catch (error) {
      console.error('[admin_tenant_reminder_settings] fetch failed', error);
      return res.status(500).json({ error: 'tenant_reminder_settings_fetch_failed' });
    }
  });

  app.post('/admin/tenants/reminder-settings', requireOperatorAuth, async (req, res) => {
    const parsed = tenantReminderSettingsUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.enabledChannels && Object.keys(parsed.data.enabledChannels).length) {
      patch.enabledChannels = parsed.data.enabledChannels;
    }
    if (parsed.data.channelMessages && Object.keys(parsed.data.channelMessages).length) {
      patch.channelMessages = parsed.data.channelMessages;
    }
    if (parsed.data.hideDisabledReminderTypes === null) {
      ensureFirebase();
      patch.hideDisabledReminderTypes = admin.firestore.FieldValue.delete();
    } else if (typeof parsed.data.hideDisabledReminderTypes === 'boolean') {
      patch.hideDisabledReminderTypes = parsed.data.hideDisabledReminderTypes;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'empty_update' });
    }

    try {
      const db = getFirestoreImpl();
      const ref = db.collection('tenants').doc(parsed.data.tenantId).collection('settings').doc('reminders');
      const now = new Date().toISOString();
      const snap = await ref.get();
      const isCreate = !snap.exists;
      await ref.set({ ...patch, updatedAt: now, ...(isCreate ? { createdAt: now } : {}) }, { merge: true });
      const updated = await ref.get();
      return res.json({ ok: true, data: updated.data() ?? null });
    } catch (error) {
      console.error('[admin_tenant_reminder_settings] update failed', error);
      return res.status(500).json({ error: 'tenant_reminder_settings_update_failed' });
    }
  });

  app.post('/admin/tenants/quotas', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantQuotaUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const db = getFirestoreImpl();
      const tenantId = parsed.data.tenantId.trim();
      const tenantRef = db.collection('tenants').doc(tenantId);
      const tenantSnap = await tenantRef.get();
      if (!tenantSnap.exists) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }

      const quotaPatch = buildQuotaPatch(parsed.data.quotas);
      if (!Object.keys(quotaPatch).length) {
        return res.status(400).json({ error: 'no_quota_values' });
      }

      const currentData = tenantSnap.data() || {};
      const existingQuotas =
        typeof currentData.quotas === 'object' && currentData.quotas ? { ...currentData.quotas } : {};
      const updatedQuotas = { ...existingQuotas, ...quotaPatch };
      const nowIso = new Date().toISOString();

      await tenantRef.set(
        {
          quotas: updatedQuotas,
          updatedAt: nowIso,
        },
        { merge: true }
      );

      const actorId = authContext.uid || authContext.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: 'quota_override',
          targetId: tenantId,
          targetType: 'quota',
          metadata: {
            before: existingQuotas,
            after: updatedQuotas,
            patch: quotaPatch,
            note: parsed.data.note,
          },
          createdAt: nowIso,
        })
      );

      const updatedSnap = await tenantRef.get();
      const summary = serializeTenantAdminSummary(updatedSnap);
      return res.json({ ok: true, tenant: summary });
    } catch (error) {
      console.error('[tenant_quota_override] failed', error);
      return res.status(500).json({ error: 'quota_override_failed' });
    }
  });

  app.post('/admin/tenants/billing/plan-variant', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || (authContext.tokenType !== 'master' && authContext.isGlobalAdmin !== true)) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = tenantBillingPlanVariantUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const db = getFirestoreImpl();
      const tenantId = parsed.data.tenantId.trim();
      const planVariantId = parsed.data.planVariantId.trim();
      const cancelMode = parsed.data.cancelExistingSubscription ?? 'none';

      const tenantRef = db.collection('tenants').doc(tenantId);
      const billingRef = db.collection('tenantBilling').doc(tenantId);

      const tenantSnap = await tenantRef.get();
      if (!tenantSnap.exists) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }

      const variant = await getPlanVariantById(db, planVariantId);
      if (!variant) {
        return res.status(400).json({ error: 'plan_variant_not_found' });
      }

      const nowIso = new Date().toISOString();
      const nextPlanId = normalizePlanId(variant.planId);
      const nextStatus: 'trial' | 'active' = nextPlanId === 'free' ? 'trial' : 'active';

      const beforeTenant = tenantSnap.data() || {};
      const beforeBillingSnap = await billingRef.get();
      const beforeBilling = beforeBillingSnap.exists ? beforeBillingSnap.data() || {} : {};

      const beforeBillingProviderRaw =
        typeof (beforeBilling as any).billingProvider === 'string'
          ? String((beforeBilling as any).billingProvider).trim().toLowerCase()
          : '';
      const beforeSubscriptionIdRaw =
        typeof (beforeBilling as any).subscriptionId === 'string' ? String((beforeBilling as any).subscriptionId).trim() : '';
      const beforeStatusRaw = typeof (beforeBilling as any).status === 'string' ? String((beforeBilling as any).status).trim().toLowerCase() : '';
      const hasActiveSubscription = Boolean(beforeSubscriptionIdRaw) && (beforeStatusRaw === 'active' || beforeStatusRaw === 'delinquent');

      let cancelledSubscription: null | {
        provider: 'razorpay' | 'google_play';
        mode: 'immediate' | 'end_of_cycle';
        subscriptionId: string;
        productId?: string;
      } = null;
      let nextTrackedSubscriptionId: string | null = null;

      const beforePlanId = normalizePlanId(
        (beforeBilling as any).planId ?? (beforeBilling as any).plan ?? (beforeTenant as any).billingTier ?? null
      );
      const beforePlanVariantId =
        typeof (beforeBilling as any).planVariantId === 'string' ? String((beforeBilling as any).planVariantId) : null;
      const didPlanChange = beforePlanId !== nextPlanId || beforePlanVariantId !== variant.id;

      // Optional: cancel an existing subscription (to avoid double-billing when the operator assigns a different plan).
      if (cancelMode !== 'none' && hasActiveSubscription) {
        const mode = cancelMode === 'end_of_cycle' ? 'end_of_cycle' : 'immediate';

        if (beforeBillingProviderRaw === 'razorpay') {
          // Prevent duplicate/surprise notifications: the admin console already sends a "plan updated" notice.
          // We also want to avoid the Razorpay cancellation webhook from downgrading billing state during a manual override.
          try {
            const suppressUntilIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
            await billingRef.set(
              {
                suppressProviderCancelNotificationUntilIso: suppressUntilIso,
                lastSystemCancelContext: {
                  source: 'admin_console_plan_override',
                  subscriptionId: beforeSubscriptionIdRaw,
                  mode,
                  atIso: nowIso,
                },
                updatedAt: nowIso,
              },
              { merge: true }
            );
          } catch {
            // best-effort
          }

          try {
            await cancelRazorpaySubscriptionImpl({
              subscriptionId: beforeSubscriptionIdRaw,
              cancelAtCycleEnd: mode === 'end_of_cycle',
            });
          } catch (error) {
            const msg = String((error as any)?.message || error);
            console.error('[tenant_billing_plan_override] razorpay cancel failed', error);
            return res.status(503).json({ error: 'razorpay_cancel_failed', message: msg });
          }

          cancelledSubscription = {
            provider: 'razorpay',
            mode,
            subscriptionId: beforeSubscriptionIdRaw,
          };
          // Prevent subsequent Razorpay cancellation webhooks for the old subscription from overwriting this manual plan override.
          nextTrackedSubscriptionId = `${beforeSubscriptionIdRaw}__ignored_by_admin_override__${Date.now()}`;
        } else if (beforeBillingProviderRaw === 'play' || beforeBillingProviderRaw === 'google_play') {
          const packageName = (process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
          if (!packageName) {
            return res.status(503).json({ error: 'google_play_unconfigured', message: 'Missing GOOGLE_PLAY_PACKAGE_NAME' });
          }

          // Prevent duplicate/surprise notifications + avoid RTDN-driven downgrade during this manual override.
          // (RTDN can arrive quickly after cancel/revoke; this is a best-effort race guard.)
          try {
            const suppressUntilIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
            await billingRef.set(
              {
                suppressProviderCancelNotificationUntilIso: suppressUntilIso,
                lastSystemCancelContext: {
                  source: 'admin_console_plan_override',
                  subscriptionId: beforeSubscriptionIdRaw,
                  mode,
                  atIso: nowIso,
                },
                updatedAt: nowIso,
              },
              { merge: true }
            );
          } catch {
            // best-effort
          }

          const storedProductId =
            typeof (beforeBilling as any).storeProductId === 'string' ? String((beforeBilling as any).storeProductId).trim() : '';
          let productId = storedProductId;
          if (!productId && beforePlanVariantId) {
            try {
              const currentVariant = await getPlanVariantById(db, beforePlanVariantId);
              const candidate = typeof (currentVariant as any)?.playProductId === 'string' ? String((currentVariant as any).playProductId).trim() : '';
              if (candidate) {
                productId = candidate;
              }
            } catch {
              // ignore
            }
          }
          if (!productId) {
            return res.status(503).json({
              error: 'google_play_product_missing',
              message: 'Unable to cancel Google Play subscription: missing productId (storeProductId/playProductId).',
            });
          }

          try {
            if (mode === 'end_of_cycle') {
              await cancelGooglePlaySubscription({ packageName, productId, purchaseToken: beforeSubscriptionIdRaw });
            } else {
              await revokeGooglePlaySubscription({ packageName, productId, purchaseToken: beforeSubscriptionIdRaw });
            }
          } catch (error) {
            const msg = String((error as any)?.message || error);
            console.error('[tenant_billing_plan_override] google play cancel/revoke failed', error);
            return res.status(503).json({ error: 'google_play_cancel_failed', message: msg });
          }

          cancelledSubscription = {
            provider: 'google_play',
            mode,
            subscriptionId: beforeSubscriptionIdRaw,
            productId,
          };
          // Prevent RTDN/renewal updates for the old purchaseToken from rewriting plan state.
          nextTrackedSubscriptionId = `${beforeSubscriptionIdRaw}__ignored_by_admin_override__${Date.now()}`;
        } else {
          return res.status(400).json({
            error: 'unsupported_subscription_provider',
            message: `Unsupported billingProvider for cancel: ${beforeBillingProviderRaw || '(missing)'}`,
          });
        }
      }

      await db.runTransaction(async (tx) => {
        tx.set(
          billingRef,
          {
            planId: nextPlanId,
            planVariantId: variant.id,
            status: nextStatus,
            checkoutRequired: false,
            checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
            checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
            checkoutRequiredSince: admin.firestore.FieldValue.delete(),
            checkoutRequiredAtIso: admin.firestore.FieldValue.delete(),
            billingAttemptId: admin.firestore.FieldValue.delete(),
            // When an operator assigns a plan in the admin console, treat the plan as organization-managed.
            // Tenant users should not be able to self-downgrade from the app without org approval.
            planLockedByOrg: nextPlanId === 'free' ? admin.firestore.FieldValue.delete() : true,
            planLockedByOrgAtIso: nextPlanId === 'free' ? admin.firestore.FieldValue.delete() : nowIso,
            updatedAt: nowIso,
            ...(nextTrackedSubscriptionId ? { subscriptionId: nextTrackedSubscriptionId } : {}),
            // Clear delinquency signals when an operator assigns a plan.
            delinquentSinceIso: admin.firestore.FieldValue.delete(),
            delinquentSince: admin.firestore.FieldValue.delete(),
            // Clear any scheduled downgrade/cancel intent: the operator is overriding plan state.
            cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
            scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
            scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
            limitsSnapshot: admin.firestore.FieldValue.delete(),
            limitsSnapshotAt: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );

        tx.set(
          tenantRef,
          {
            billingTier: nextPlanId,
            updatedAt: nowIso,
          },
          { merge: true }
        );
      });

      const actorId = authContext.uid || authContext.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(authContext);
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: 'billing_plan_override',
          targetId: tenantId,
          targetType: 'billing',
          metadata: {
            beforeTenant: {
              billingTier: (beforeTenant as any).billingTier,
            },
            afterTenant: {
              billingTier: nextPlanId,
            },
            beforeBilling: {
              planId: (beforeBilling as any).planId ?? (beforeBilling as any).plan,
              planVariantId: (beforeBilling as any).planVariantId,
              status: (beforeBilling as any).status,
              checkoutRequired: (beforeBilling as any).checkoutRequired,
              renewalDate:
                (beforeBilling as any).renewalDate ?? (beforeBilling as any).renewsAt ?? (beforeBilling as any).renewalAt,
            },
            afterBilling: {
              planId: nextPlanId,
              planVariantId: variant.id,
              status: nextStatus,
              checkoutRequired: false,
            },
            note: parsed.data.note,
            cancelExistingSubscription: cancelMode,
            ...(cancelledSubscription
              ? {
                  cancelledSubscription,
                }
              : {}),
          },
          createdAt: nowIso,
        })
      );

      if (didPlanChange) {
        const planLabel = nextPlanId === 'free' ? 'Free' : nextPlanId === 'pro' ? 'Pro' : 'Enterprise';
        void sendTenantBillingEventNotification({
          tenantId,
          kind: 'plan_overridden',
          title: 'Plan updated',
          body: `This coaching center has been switched to the ${planLabel} plan.`,
          priority: 'medium',
          metadata: {
            source: 'admin_console',
            fromPlanId: beforePlanId,
            fromPlanVariantId: beforePlanVariantId,
            toPlanId: nextPlanId,
            toPlanVariantId: variant.id,
            note: parsed.data.note ?? null,
            actorId,
            actorEmail: actorEmail || null,
            actorRole: authContext.tokenType,
          },
        }).catch(() => undefined);
      }

      const updatedSnap = await tenantRef.get();
      const summary = serializeTenantAdminSummary(updatedSnap);
      return res.json({ ok: true, tenant: summary });
    } catch (error) {
      console.error('[tenant_billing_plan_override] failed', error);
      return res.status(500).json({ error: 'tenant_billing_plan_override_failed' });
    }
  });

  app.get('/admin/auth/global-admin/me', requireGlobalAdminAuth, (req, res) => {
    const authContext = req.authContext;
    return res.json({
      ok: true,
      uid: authContext?.uid || null,
      email: authContext?.email || null,
      tokenType: authContext?.tokenType || null,
      isGlobalAdmin: authContext?.tokenType === 'master' || authContext?.isGlobalAdmin === true,
    });
  });

  app.post('/admin/auth/global-admin/get', requireGlobalAdminAuth, async (req, res) => {
    const parsed = globalAdminClaimLookupSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const target = await resolveGlobalAdminLookup(parsed.data);
      const userRecord = await getAuthUserByUidImpl(target.uid);
      const currentClaims = ((userRecord.customClaims || {}) as Record<string, unknown>) || {};
      return res.json({
        ok: true,
        uid: userRecord.uid,
        email: normalizeEmail(userRecord.email || undefined) || target.email,
        admin: currentClaims.admin === true,
        customClaims: currentClaims,
      });
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? error.code : '';
      if (code === 'auth/user-not-found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      console.error('[admin_global_admin_get] failed', error);
      return res.status(500).json({ error: 'global_admin_lookup_failed' });
    }
  });

  app.post('/admin/auth/global-admin/set', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || authContext.tokenType !== 'master') {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const parsed = globalAdminClaimUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const target = await resolveGlobalAdminLookup(parsed.data);
      const userRecord = await getAuthUserByUidImpl(target.uid);
      const currentClaims = ((userRecord.customClaims || {}) as Record<string, unknown>) || {};
      const previousAdmin = currentClaims.admin === true;

      const nextClaims: Record<string, unknown> = { ...currentClaims };
      if (parsed.data.admin) {
        nextClaims.admin = true;
      } else {
        delete nextClaims.admin;
      }

      await setAuthCustomUserClaimsImpl(userRecord.uid, Object.keys(nextClaims).length ? nextClaims : null);
      await revokeAuthRefreshTokensImpl(userRecord.uid);

      try {
        const actorId = authContext.uid || authContext.tokenType || 'system';
        const actorEmail = await resolveAuthenticatedEmail(authContext);
        await getFirestoreImpl().collection('adminSecurityAuditLogs').add(
          stripUndefinedDeep({
            action: 'global_admin_claim_set',
            actorId,
            actorEmail: actorEmail || undefined,
            targetUid: userRecord.uid,
            targetEmail: normalizeEmail(userRecord.email || undefined) || target.email,
            previousAdmin,
            nextAdmin: parsed.data.admin,
            changed: previousAdmin !== parsed.data.admin,
            reason: parsed.data.reason || undefined,
            createdAt: new Date().toISOString(),
          })
        );
      } catch (auditError) {
        console.warn('[admin_global_admin_set] audit_log_failed', auditError);
      }

      return res.json({
        ok: true,
        uid: userRecord.uid,
        email: normalizeEmail(userRecord.email || undefined) || target.email,
        admin: parsed.data.admin,
        previousAdmin,
        changed: previousAdmin !== parsed.data.admin,
        reason: parsed.data.reason || null,
      });
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? error.code : '';
      if (code === 'auth/user-not-found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      console.error('[admin_global_admin_set] failed', error);
      return res.status(500).json({ error: 'global_admin_update_failed' });
    }
  });

  app.post('/tenants/:tenantId/preferences', requireParamsStaffTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const requestedTenantId = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!requestedTenantId || requestedTenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const parsed = tenantNotificationPreferencesUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const preferenceMetadata = parsed.data.metadata ?? {};

    try {
      const tenantRecord = await loadTenantNotificationPreferencesRecordImpl(tenantAccess.tenantId);
      if (!tenantRecord) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }

      const currentPrefs = normalizeTenantNotificationPreferences(
        tenantRecord.currentPreferences || undefined
      );
      const patch = parsed.data.notificationPreferences;
      const updatedPrefs = { ...currentPrefs };
      const changedKeys: NotificationPreferenceKey[] = [];
      for (const key of notificationPreferenceKeys) {
        if (typeof patch[key] === 'boolean') {
          const nextValue = patch[key] as boolean;
          if (updatedPrefs[key] !== nextValue) {
            changedKeys.push(key);
          }
          updatedPrefs[key] = nextValue;
        }
      }

      if (!changedKeys.length) {
        return res.json({ ok: true, notificationPreferences: updatedPrefs, changedKeys: [] });
      }

      const nowIso = new Date().toISOString();
      await tenantRecord.update({
        notificationPreferences: updatedPrefs,
        updatedAt: nowIso,
      });

      const auditMetadata: Record<string, unknown> = {
        changedKeys,
        before: currentPrefs,
        after: updatedPrefs,
        actorRole: tenantAccess.role,
        actorMembershipId: tenantAccess.membershipId,
      };

      const initiatedFrom = typeof preferenceMetadata.initiatedFrom === 'string' ? preferenceMetadata.initiatedFrom.trim() : '';
      if (initiatedFrom) {
        auditMetadata.initiatedFrom = initiatedFrom;
      }
      if (typeof preferenceMetadata.actorName === 'string' && preferenceMetadata.actorName.trim()) {
        auditMetadata.actorName = preferenceMetadata.actorName.trim();
      }
      if (typeof preferenceMetadata.reason === 'string' && preferenceMetadata.reason.trim()) {
        auditMetadata.reason = preferenceMetadata.reason.trim();
      }

      const clientVersionHeader = req.headers['x-app-version'];
      const clientVersion = typeof clientVersionHeader === 'string' ? clientVersionHeader.trim() : '';
      if (clientVersion) {
        auditMetadata.clientVersion = clientVersion;
      }

      await logTenantAuditEventImpl({
        tenantId: tenantAccess.tenantId,
        action: 'notification_preferences_updated',
        authContext: req.authContext,
        metadata: auditMetadata,
        targetId: tenantAccess.tenantId,
        targetType: 'tenant',
      });

      return res.json({ ok: true, notificationPreferences: updatedPrefs, changedKeys });
    } catch (error) {
      console.error('[tenant_preferences] update failed', error);
      return res.status(500).json({ error: 'preferences_update_failed' });
    }
  });

  app.delete('/tenants/:tenantId/notices/:noticeId', requireParamsMemberTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    const authContext = req.authContext;
    if (!tenantAccess) {
      return res.status(400).json({ error: 'tenant_required' });
    }
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const tenantId = tenantAccess.tenantId;
    const actorUid = authContext.uid;
    const actorRole = tenantAccess.role;
    const noticeId = typeof req.params.noticeId === 'string' ? req.params.noticeId.trim() : '';
    if (!noticeId) {
      return res.status(400).json({ error: 'notice_required' });
    }

    const db = getFirestoreImpl();
    const noticeRef = db.collection('notices').doc(noticeId);

    const normalizeCreatorRole = (value: unknown): TenantMembershipRole | 'system' | null => {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!raw) return null;
      if (raw === 'system') return 'system';
      if (raw === 'owner' || raw === 'admin' || raw === 'staff' || raw === 'member') return raw;
      return null;
    };

    const resolveStoragePath = (explicitPath: unknown, downloadUrl: unknown): string | null => {
      const path = typeof explicitPath === 'string' ? explicitPath.trim() : '';
      if (path) return path;
      const urlRaw = typeof downloadUrl === 'string' ? downloadUrl.trim() : '';
      if (!urlRaw) return null;
      try {
        const url = new URL(urlRaw);
        const match = url.pathname.match(/\/o\/(.+?)(\?|$)/);
        if (match?.[1]) {
          return decodeURIComponent(match[1]);
        }
      } catch {
        // ignore
      }
      return null;
    };

    try {
      const snap = await noticeRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'notice_not_found' });
      }

      const notice = snap.data() || {};
      const noticeTenantId = typeof (notice as any).tenantId === 'string' ? (notice as any).tenantId : '';
      if (noticeTenantId && noticeTenantId !== tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const creatorUid = typeof (notice as any).createdBy === 'string' ? (notice as any).createdBy : '';
      let creatorRole = normalizeCreatorRole((notice as any).createdByRole);
      if (!creatorRole && creatorUid === 'system') {
        creatorRole = 'system';
      }
      if (!creatorRole && creatorUid) {
        try {
          const membershipId = membershipDocId(tenantId, creatorUid);
          const membershipSnap = await db.collection('tenantMemberships').doc(membershipId).get();
          if (membershipSnap.exists) {
            const membership = membershipSnap.data() || {};
            creatorRole = normalizeCreatorRole((membership as any).role);
          }
        } catch {
          // ignore
        }
      }

      const allowed = (() => {
        if (actorRole === 'owner') {
          return true;
        }
        if (actorRole === 'admin') {
          if (creatorUid === 'system' || creatorRole === 'system') {
            return true;
          }
          // If we can't determine creator role, be conservative and deny.
          if (!creatorRole) {
            return false;
          }
          return creatorRole !== 'owner';
        }
        // staff/member: only their own posts
        return creatorUid && creatorUid === actorUid;
      })();

      if (!allowed) {
        return res.status(403).json({ error: 'not_allowed' });
      }

      // Best-effort storage cleanup.
      try {
        ensureFirebase();
        const bucket = admin.storage().bucket();

        const imagePath = resolveStoragePath((notice as any).imageStoragePath, (notice as any).imageUrl);
        const audioPath = resolveStoragePath((notice as any).audioStoragePath, (notice as any).audioUrl);
        const deletes: Array<Promise<any>> = [];
        if (imagePath) {
          deletes.push(bucket.file(imagePath).delete({ ignoreNotFound: true } as any));
        }
        if (audioPath) {
          deletes.push(bucket.file(audioPath).delete({ ignoreNotFound: true } as any));
        }
        await Promise.allSettled(deletes);
      } catch (error) {
        console.warn('[notices_delete] storage cleanup failed', error);
      }

      await noticeRef.delete();
      return res.json({ ok: true });
    } catch (error) {
      console.error('[notices_delete] failed', error);
      return res.status(500).json({ error: 'delete_failed' });
    }
  });

  app.post('/tenants/invites/accept', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantInviteAcceptSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const token = parsed.data.token.trim().toLowerCase();
    try {
      const db = getFirestoreImpl();
      const inviteQuerySnap = await db
        .collection('tenantInvites')
        .where('token', '==', token)
        .limit(1)
        .get();
      if (inviteQuerySnap.empty) {
        return res.status(404).json({ error: 'invite_not_found' });
      }

      const inviteDoc = inviteQuerySnap.docs[0];
      const inviteData = inviteDoc.data() || {};
      const tenantId = typeof inviteData.tenantId === 'string' ? inviteData.tenantId.trim() : '';
      if (!tenantId) {
        return res.status(404).json({ error: 'invite_not_found' });
      }

      const userEmail = await resolveAuthenticatedEmail(authContext);
      if (!userEmail) {
        return res.status(400).json({ error: 'email_required' });
      }

      const inviteEmailRaw = typeof inviteData.email === 'string' ? inviteData.email : '';
      const inviteEmail = normalizeEmail(inviteEmailRaw);
      if (inviteEmail && inviteEmail !== userEmail) {
        return res.status(403).json({ error: 'invite_email_mismatch', expectedEmail: inviteEmail });
      }

      const inviteStatus = typeof inviteData.status === 'string' ? inviteData.status : 'pending';
      if (inviteStatus === 'revoked') {
        return res.status(409).json({ error: 'invite_revoked' });
      }
      if (inviteStatus === 'rejected') {
        return res.status(409).json({ error: 'invite_rejected' });
      }
      if (inviteStatus === 'accepted') {
        return res.status(409).json({ error: 'invite_already_used' });
      }

      const now = Date.now();
      const expiresAtIso = typeof inviteData.expiresAt === 'string' ? inviteData.expiresAt : null;
      const expiresAtTs = expiresAtIso ? Date.parse(expiresAtIso) : NaN;
      if (inviteStatus === 'expired' || (!Number.isNaN(expiresAtTs) && expiresAtTs < now)) {
        if (inviteStatus !== 'expired') {
          await inviteDoc.ref.update({ status: 'expired', updatedAt: new Date(now).toISOString() });
        }
        return res.status(410).json({ error: 'invite_expired' });
      }

      const membershipId = membershipDocId(tenantId, authContext.uid);
      const membershipRef = db.collection('tenantMemberships').doc(membershipId);
      const membershipSnap = await membershipRef.get();
      const existingMembership = membershipSnap.exists ? membershipSnap.data() || {} : null;
      const alreadyActive = existingMembership?.status === 'active';

      if (alreadyActive) {
        return res.status(409).json({
          error: 'already_member',
          message: 'You are already a member of this coaching center.',
        });
      }

      const nowIso = new Date().toISOString();
      const role = typeof inviteData.role === 'string' ? (inviteData.role as TenantMembershipRole) : 'member';
      const membershipPayload: Record<string, any> = {
        tenantId,
        userId: authContext.uid,
        email: userEmail,
        role,
        status: 'active',
        updatedAt: nowIso,
      };

      if (!existingMembership) {
        membershipPayload.createdAt = nowIso;
        membershipPayload.statusHistory = [
          {
            status: 'active',
            at: nowIso,
            actorId: authContext.uid,
            actorEmail: userEmail,
            reason: 'invite_accepted',
          },
        ];
      } else if (!alreadyActive) {
        membershipPayload.statusHistory = admin.firestore.FieldValue.arrayUnion({
          status: 'active',
          at: nowIso,
          actorId: authContext.uid,
          actorEmail: userEmail,
          reason: `status_changed_from_${existingMembership.status || 'unknown'}`,
        });
      }

      await db.runTransaction(async (tx) => {
        const freshInviteSnap = await tx.get(inviteDoc.ref);
        if (!freshInviteSnap.exists) {
          throw new TenantAccessError(404, { error: 'invite_not_found' });
        }
        const freshInvite = freshInviteSnap.data() || {};
        const freshStatus = typeof freshInvite.status === 'string' ? freshInvite.status : 'pending';
        if (freshStatus !== 'pending') {
          const mappedError =
            freshStatus === 'revoked'
              ? 'invite_revoked'
              : freshStatus === 'rejected'
                ? 'invite_rejected'
                : freshStatus === 'accepted'
                  ? 'invite_already_used'
                  : 'invite_not_found';
          throw new TenantAccessError(409, { error: mappedError });
        }

        const freshMembershipSnap = await tx.get(membershipRef);
        const freshMembership = freshMembershipSnap.exists ? freshMembershipSnap.data() || {} : null;
        if (freshMembership?.status === 'active') {
          throw new TenantAccessError(409, {
            error: 'already_member',
            message: 'You are already a member of this coaching center.',
          });
        }

        const joinRequestsQuery = db
          .collection('tenantJoinRequests')
          .where('tenantId', '==', tenantId)
          .where('userId', '==', authContext.uid)
          .where('status', '==', 'pending')
          .limit(50);
        const joinRequestsSnap = await tx.get(joinRequestsQuery);

        tx.set(membershipRef, membershipPayload, { merge: true });
        tx.update(inviteDoc.ref, {
          status: 'accepted',
          acceptedAt: nowIso,
          acceptedBy: authContext.uid,
          updatedAt: nowIso,
        });
        joinRequestsSnap.docs.forEach((docSnap) => {
          tx.update(docSnap.ref, {
            status: 'approved',
            reviewedAt: nowIso,
            reviewedBy: authContext.uid,
            assignedRole: role,
          });
        });
      });

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId,
          actorId: authContext.uid,
          actorEmail: userEmail,
          action: 'membership_invited',
          targetId: inviteDoc.id,
          targetType: 'invite',
          metadata: { outcome: 'accepted', inviteEmail: inviteEmail || undefined },
          createdAt: nowIso,
        })
      );

      return res.json({
        ok: true,
        tenantId,
        inviteId: inviteDoc.id,
        membership: {
          id: membershipId,
          tenantId,
          userId: authContext.uid,
          email: userEmail,
          role,
          status: 'active',
          createdAt: membershipPayload.createdAt ?? existingMembership?.createdAt ?? nowIso,
          updatedAt: nowIso,
        },
      });
    } catch (error) {
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.error('[tenant_invite_accept] failed', error);
      return res.status(500).json({ error: 'invite_accept_failed' });
    }
  });

  app.post('/tenants/invites/reject', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantInviteRejectSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const token = parsed.data.token.trim().toLowerCase();
    try {
      const db = getFirestoreImpl();
      const inviteQuerySnap = await db
        .collection('tenantInvites')
        .where('token', '==', token)
        .limit(1)
        .get();
      if (inviteQuerySnap.empty) {
        return res.status(404).json({ error: 'invite_not_found' });
      }

      const inviteDoc = inviteQuerySnap.docs[0];
      const inviteData = inviteDoc.data() || {};
      const tenantId = typeof inviteData.tenantId === 'string' ? inviteData.tenantId.trim() : '';
      if (!tenantId) {
        return res.status(404).json({ error: 'invite_not_found' });
      }

      const userEmail = await resolveAuthenticatedEmail(authContext);
      if (!userEmail) {
        return res.status(400).json({ error: 'email_required' });
      }

      const inviteEmailRaw = typeof inviteData.email === 'string' ? inviteData.email : '';
      const inviteEmail = normalizeEmail(inviteEmailRaw);
      if (inviteEmail && inviteEmail !== userEmail) {
        return res.status(403).json({ error: 'invite_email_mismatch', expectedEmail: inviteEmail });
      }

      const inviteStatus = typeof inviteData.status === 'string' ? inviteData.status : 'pending';
      if (inviteStatus === 'revoked') {
        return res.status(409).json({ error: 'invite_revoked' });
      }
      if (inviteStatus === 'rejected') {
        return res.status(409).json({ error: 'invite_rejected' });
      }
      if (inviteStatus === 'accepted') {
        return res.status(409).json({ error: 'invite_already_used' });
      }

      const now = Date.now();
      const expiresAtIso = typeof inviteData.expiresAt === 'string' ? inviteData.expiresAt : null;
      const expiresAtTs = expiresAtIso ? Date.parse(expiresAtIso) : NaN;
      if (inviteStatus === 'expired' || (!Number.isNaN(expiresAtTs) && expiresAtTs < now)) {
        if (inviteStatus !== 'expired') {
          await inviteDoc.ref.update({ status: 'expired', updatedAt: new Date(now).toISOString() });
        }
        return res.status(410).json({ error: 'invite_expired' });
      }

      const membershipId = membershipDocId(tenantId, authContext.uid);
      const membershipRef = db.collection('tenantMemberships').doc(membershipId);
      const nowIso = new Date().toISOString();

      await db.runTransaction(async (tx) => {
        const freshInviteSnap = await tx.get(inviteDoc.ref);
        if (!freshInviteSnap.exists) {
          throw new TenantAccessError(404, { error: 'invite_not_found' });
        }
        const freshInvite = freshInviteSnap.data() || {};
        const freshStatus = typeof freshInvite.status === 'string' ? freshInvite.status : 'pending';
        if (freshStatus !== 'pending') {
          const mappedError =
            freshStatus === 'revoked'
              ? 'invite_revoked'
              : freshStatus === 'rejected'
                ? 'invite_rejected'
                : freshStatus === 'accepted'
                  ? 'invite_already_used'
                  : 'invite_not_found';
          throw new TenantAccessError(409, { error: mappedError });
        }

        tx.update(inviteDoc.ref, {
          status: 'rejected',
          rejectedAt: nowIso,
          rejectedBy: authContext.uid,
          updatedAt: nowIso,
        });

        const membershipSnap = await tx.get(membershipRef);
        if (membershipSnap.exists) {
          const membership = membershipSnap.data() || {};
          const tokenMatches = typeof membership.inviteToken === 'string' ? membership.inviteToken.trim() === token : false;
          const isPendingInvite = membership.status === 'pending_invite';
          if (isPendingInvite || tokenMatches) {
            tx.set(
              membershipRef,
              {
                status: 'rejected',
                updatedAt: nowIso,
                inviteToken: admin.firestore.FieldValue.delete(),
                inviteExpiresAt: admin.firestore.FieldValue.delete(),
                invitedBy: admin.firestore.FieldValue.delete(),
                statusHistory: admin.firestore.FieldValue.arrayUnion({
                  status: 'rejected',
                  at: nowIso,
                  actorId: authContext.uid,
                  actorEmail: userEmail,
                  reason: 'invite_rejected_by_user',
                }),
              },
              { merge: true },
            );
          }
        }
      });

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId,
          actorId: authContext.uid,
          actorEmail: userEmail,
          action: 'membership_invited',
          targetId: inviteDoc.id,
          targetType: 'invite',
          metadata: { outcome: 'rejected', inviteEmail: inviteEmail || undefined },
          createdAt: nowIso,
        })
      );

      return res.json({ ok: true, tenantId, inviteId: inviteDoc.id });
    } catch (error) {
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.error('[tenant_invite_reject] failed', error);
      return res.status(500).json({ error: 'invite_reject_failed' });
    }
  });

  app.post('/tenants/:tenantId/invites', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const parsed = tenantInviteCreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const desiredRole = parsed.data.role ?? 'member';
    const actorIsOwner = tenantAccess.role === 'owner' || req.authContext?.tokenType === 'master';
    if (desiredRole === 'owner' && !actorIsOwner) {
      return res.status(403).json({ error: 'owner_role_required' });
    }

    try {
      const db = getFirestoreImpl();
      const inviteeEmail = normalizeEmail(parsed.data.email);
      if (!inviteeEmail) {
        return res.status(400).json({ error: 'email_required' });
      }

      const alreadyMember = await isTenantEmailActiveMemberImpl(tenantAccess.tenantId, inviteeEmail);
      if (alreadyMember) {
        return res.status(409).json({ error: 'membership_exists_for_email' });
      }

      // Enforce one invite record per tenant+email. If a new invite is created for the same email,
      // we overwrite the existing record (and delete any legacy duplicates).
      const canonicalInviteId = tenantInviteDocId(tenantAccess.tenantId, inviteeEmail);
      const inviteRef = db.collection('tenantInvites').doc(canonicalInviteId);

      const needsSeat = desiredRole === 'owner' || desiredRole === 'admin' || desiredRole === 'staff';

      // If the email already has a pending seat invite, renewing it should not require an extra seat.
      let alreadyReservedSeatForEmail = false;
      try {
        const existingInviteSnap = await db
          .collection('tenantInvites')
          .where('tenantId', '==', tenantAccess.tenantId)
          .where('email', '==', inviteeEmail)
          .limit(50)
          .get();
        existingInviteSnap.forEach((docSnap) => {
          const data = docSnap.data() || {};
          const status = typeof (data as any).status === 'string' ? String((data as any).status).toLowerCase() : '';
          const role = typeof (data as any).role === 'string' ? String((data as any).role).toLowerCase() : '';
          if (status === 'pending' && (role === 'owner' || role === 'admin' || role === 'staff')) {
            alreadyReservedSeatForEmail = true;
          }
        });
      } catch {
        // Non-fatal; proceed with standard enforcement.
      }

      if (needsSeat && !alreadyReservedSeatForEmail) {
        try {
          await assertTenantStaffSeatAvailable(db, tenantAccess.tenantId);
        } catch (error) {
          if (error instanceof TenantSeatLimitError) {
            return res.status(409).json({ error: 'seat_limit_reached', limit: error.limit });
          }
          throw error;
        }
      }

      const nowIso = new Date().toISOString();
      const expiresInDays = parsed.data.expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS;
      const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
      const token = crypto.randomBytes(16).toString('hex');
      const inviteLink = await buildTenantInviteLinkServer(token);
      const inviteData = {
        tenantId: tenantAccess.tenantId,
        email: inviteeEmail,
        role: desiredRole,
        status: 'pending',
        token,
        inviteLink,
        issuedBy: req.authContext?.uid || 'system',
        issuedAt: nowIso,
        expiresAt,
        lastSentAt: nowIso,
        lastSentBy: req.authContext?.uid || 'system',
        invitationMessage: parsed.data.message ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      } satisfies Record<string, unknown>;

      // Overwrite the canonical invite doc, and delete any other legacy duplicates for this email.
      await db.runTransaction(async (tx) => {
        const dupSnap = await tx.get(
          db
            .collection('tenantInvites')
            .where('tenantId', '==', tenantAccess.tenantId)
            .where('email', '==', inviteeEmail)
            .limit(50),
        );
        dupSnap.docs.forEach((docSnap) => {
          if (docSnap.id !== canonicalInviteId) {
            tx.delete(docSnap.ref);
          }
        });
        tx.set(inviteRef, inviteData, { merge: false });
      });

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId: req.authContext?.uid || req.authContext?.tokenType || 'system',
          actorEmail: (await resolveAuthenticatedEmail(req.authContext)) || undefined,
          action: 'membership_invited',
          targetId: canonicalInviteId,
          targetType: 'invite',
          metadata: { email: inviteeEmail, role: desiredRole, outcome: 'created' },
          createdAt: nowIso,
        })
      );

      return res.json({
        ok: true,
        invite: {
          id: canonicalInviteId,
          ...inviteData,
        },
      });
    } catch (error) {
      console.error('[tenant_invite_create] failed', error);
      return res.status(500).json({ error: 'invite_create_failed' });
    }
  });

  // Return a server-generated invite link (auth + admin tenant required).
  // Useful for older invites that may not yet have inviteLink stored.
  app.post('/tenants/:tenantId/invites/:inviteId/link', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    const inviteId = typeof req.params?.inviteId === 'string' ? req.params.inviteId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    if (!inviteId) {
      return res.status(400).json({ error: 'invite_required' });
    }

    try {
      const db = getFirestoreImpl();
      const inviteRef = db.collection('tenantInvites').doc(inviteId);
      const snap = await inviteRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'invite_not_found' });
      }
      const invite = snap.data() as any;
      if (invite?.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const token = typeof invite?.token === 'string' ? String(invite.token).trim() : '';
      if (!token) {
        return res.status(409).json({ error: 'invite_token_missing' });
      }

      const inviteLink = await buildTenantInviteLinkServer(token);
      // Best-effort store so Firestore listeners can use it.
      try {
        await inviteRef.set({ inviteLink, updatedAt: new Date().toISOString() }, { merge: true });
      } catch {
        // ignore
      }
      return res.json({ ok: true, inviteId, inviteLink });
    } catch (error) {
      console.error('[tenant_invite_link] failed', error);
      return res.status(500).json({ error: 'invite_link_failed' });
    }
  });

  app.post('/tenants/:tenantId/invites/:inviteId/resend', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    const inviteId = typeof req.params?.inviteId === 'string' ? req.params.inviteId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    if (!inviteId) {
      return res.status(400).json({ error: 'invite_required' });
    }

    try {
      const db = getFirestoreImpl();
      const inviteRef = db.collection('tenantInvites').doc(inviteId);
      const inviteSnap = await inviteRef.get();
      if (!inviteSnap.exists) {
        return res.status(404).json({ error: 'invite_not_found' });
      }
      const invite = inviteSnap.data() || {};
      if (invite.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }
      if (invite.status && invite.status !== 'pending') {
        return res.status(409).json({ error: 'invite_not_pending' });
      }
      const inviteRole = typeof invite.role === 'string' ? (invite.role as TenantMembershipRole) : 'member';
      const actorIsOwner = tenantAccess.role === 'owner' || req.authContext?.tokenType === 'master';
      if (inviteRole === 'owner' && !actorIsOwner) {
        return res.status(403).json({ error: 'owner_role_required' });
      }

      const nowIso = new Date().toISOString();
      const token = typeof invite.token === 'string' ? String(invite.token).trim() : '';
      const inviteLink = token ? await buildTenantInviteLinkServer(token) : undefined;
      await inviteRef.update(stripUndefinedDeep({ lastSentAt: nowIso, lastSentBy: req.authContext?.uid || 'system', inviteLink }));
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId: req.authContext?.uid || req.authContext?.tokenType || 'system',
          actorEmail: (await resolveAuthenticatedEmail(req.authContext)) || undefined,
          action: 'membership_invited',
          targetId: inviteId,
          targetType: 'invite',
          metadata: { outcome: 'resent' },
          createdAt: nowIso,
        })
      );

      return res.json({
        ok: true,
        invite: {
          id: inviteId,
          ...invite,
          ...(inviteLink ? { inviteLink } : {}),
          lastSentAt: nowIso,
          lastSentBy: req.authContext?.uid || 'system',
        },
      });
    } catch (error) {
      console.error('[tenant_invite_resend] failed', error);
      return res.status(500).json({ error: 'invite_resend_failed' });
    }
  });

  app.post('/tenants/:tenantId/invites/:inviteId/revoke', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    const inviteId = typeof req.params?.inviteId === 'string' ? req.params.inviteId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    if (!inviteId) {
      return res.status(400).json({ error: 'invite_required' });
    }

    try {
      const db = getFirestoreImpl();
      const inviteRef = db.collection('tenantInvites').doc(inviteId);
      const inviteSnap = await inviteRef.get();
      if (!inviteSnap.exists) {
        return res.status(404).json({ error: 'invite_not_found' });
      }
      const invite = inviteSnap.data() || {};
      if (invite.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }
      if (invite.status && invite.status !== 'pending') {
        return res.status(409).json({ error: 'invite_not_pending' });
      }
      const inviteRole = typeof invite.role === 'string' ? (invite.role as TenantMembershipRole) : 'member';
      const actorIsOwner = tenantAccess.role === 'owner' || req.authContext?.tokenType === 'master';
      if (inviteRole === 'owner' && !actorIsOwner) {
        return res.status(403).json({ error: 'owner_role_required' });
      }

      const nowIso = new Date().toISOString();
      const revokedBy = req.authContext?.uid || req.authContext?.tokenType || 'system';
      await inviteRef.update({
        status: 'revoked',
        revokedAt: nowIso,
        revokedBy,
        updatedAt: nowIso,
      });
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId: revokedBy,
          actorEmail: (await resolveAuthenticatedEmail(req.authContext)) || undefined,
          action: 'membership_invited',
          targetId: inviteId,
          targetType: 'invite',
          metadata: { outcome: 'revoked' },
          createdAt: nowIso,
        })
      );

      return res.json({
        ok: true,
        invite: {
          id: inviteId,
          ...invite,
          status: 'revoked',
          revokedAt: nowIso,
          revokedBy,
          updatedAt: nowIso,
        },
      });
    } catch (error) {
      console.error('[tenant_invite_revoke] failed', error);
      return res.status(500).json({ error: 'invite_revoke_failed' });
    }
  });

  app.post('/tenants/:tenantId/join-requests/:requestId/approve', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    if (!requestId) {
      return res.status(400).json({ error: 'request_required' });
    }

    const parsed = joinRequestApprovalSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const desiredRole = parsed.data.role ?? 'staff';
    const actorIsOwner = tenantAccess.role === 'owner' || req.authContext?.tokenType === 'master';
    if (desiredRole === 'owner' && !actorIsOwner) {
      return res.status(403).json({ error: 'owner_role_required' });
    }

    try {
      const db = getFirestoreImpl();
      const requestRef = db.collection('tenantJoinRequests').doc(requestId);
      const membershipCollection = db.collection('tenantMemberships');
      const requestSnap = await requestRef.get();
      if (!requestSnap.exists) {
        return res.status(404).json({ error: 'request_not_found' });
      }
      const request = requestSnap.data() || {};
      if (request.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }
      if (request.status && request.status !== 'pending') {
        return res.status(409).json({ error: 'request_already_reviewed' });
      }
      const targetUserId = typeof request.userId === 'string' ? request.userId.trim() : '';
      const targetEmailRaw = typeof request.email === 'string' ? request.email.trim() : '';
      if (!targetUserId || !targetEmailRaw) {
        return res.status(400).json({ error: 'request_missing_user' });
      }
      const normalizedEmail = targetEmailRaw.toLowerCase();
      const membershipId = membershipDocId(tenantAccess.tenantId, targetUserId);
      const membershipRef = membershipCollection.doc(membershipId);
      const membershipSnap = await membershipRef.get();
      const membershipExisting = membershipSnap.exists ? membershipSnap.data() || {} : null;
      const membershipStatus = typeof membershipExisting?.status === 'string' ? membershipExisting.status : null;
      const needsSeat = desiredRole === 'owner' || desiredRole === 'admin' || desiredRole === 'staff';
      const needsSeatCheck = needsSeat && (!membershipExisting || membershipStatus !== 'active');
      if (needsSeatCheck) {
        try {
          await assertTenantStaffSeatAvailable(db, tenantAccess.tenantId);
        } catch (error) {
          if (error instanceof TenantSeatLimitError) {
            return res.status(409).json({ error: 'seat_limit_reached', limit: error.limit });
          }
          throw error;
        }
      }

      const nowIso = new Date().toISOString();
      const actorId = req.authContext?.uid || req.authContext?.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const actorUid = req.authContext?.uid || null;
      const actorRole = tenantAccess.role;
      const actorMembershipId = tenantAccess.membershipId;
      const reviewerName = parsed.data.reviewerName || parsed.data.metadata?.actorName;
      const displayName = typeof request.displayName === 'string' && request.displayName.trim().length
        ? request.displayName.trim()
        : normalizedEmail;

      const statusEvent: Record<string, any> = stripUndefinedDeep({
        status: 'active',
        at: nowIso,
        actorId,
        actorEmail: actorEmail || undefined,
        reason: parsed.data.metadata?.reason ?? 'join_request_approved',
      });
      if (reviewerName) {
        statusEvent.actorName = reviewerName;
      }
      if (parsed.data.metadata?.initiatedFrom) {
        statusEvent.initiatedFrom = parsed.data.metadata.initiatedFrom;
      }

      const membershipPayload: Record<string, any> = {
        tenantId: tenantAccess.tenantId,
        userId: targetUserId,
        email: normalizedEmail,
        displayName,
        role: desiredRole,
        status: 'active',
        updatedAt: nowIso,
      };
      if (!membershipExisting) {
        membershipPayload.createdAt = nowIso;
        membershipPayload.statusHistory = [statusEvent];
      } else {
        membershipPayload.statusHistory = admin.firestore.FieldValue.arrayUnion(statusEvent);
      }

      await db.runTransaction(async (tx) => {
        const freshRequestSnap = await tx.get(requestRef);
        if (!freshRequestSnap.exists) {
          throw new TenantAccessError(404, { error: 'request_not_found' });
        }
        const freshRequest = freshRequestSnap.data() || {};
        if (freshRequest.status && freshRequest.status !== 'pending') {
          throw new TenantAccessError(409, { error: 'request_already_reviewed' });
        }
        tx.set(membershipRef, membershipPayload, { merge: true });
        tx.update(requestRef, {
          status: 'approved',
          reviewedAt: nowIso,
          reviewedBy: actorId,
          assignedRole: desiredRole,
        });

        const invitesQuery = db
          .collection('tenantInvites')
          .where('tenantId', '==', tenantAccess.tenantId)
          .where('email', '==', normalizedEmail)
          .where('status', '==', 'pending')
          .limit(50);
        const invitesSnap = await tx.get(invitesQuery);
        invitesSnap.docs.forEach((docSnap) => {
          tx.update(docSnap.ref, {
            status: 'accepted',
            acceptedAt: nowIso,
            acceptedBy: actorId,
            updatedAt: nowIso,
          });
        });
      });

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: 'join_request_reviewed',
          targetId: requestId,
          targetType: 'joinRequest',
          metadata: { outcome: 'approved', role: desiredRole },
          createdAt: nowIso,
        })
      );

      const notificationMetadata: Record<string, any> = {
        displayName,
        reason: parsed.data.metadata?.reason ?? 'join_request_approved',
        initiatedFrom: parsed.data.metadata?.initiatedFrom ?? 'system',
        actorName: reviewerName,
      };

      void sendTeamMembershipChangeNotificationImpl({
        tenantId: tenantAccess.tenantId,
        tenantName: typeof request.tenantName === 'string' ? request.tenantName : undefined,
        action: membershipExisting ? 'role_changed' : 'added',
        targetEmail: normalizedEmail,
        targetRole: desiredRole,
        metadata: notificationMetadata,
      }).catch((error) => console.warn('[join_request_approve] notify team failed', error));

      void sendTenantJoinRequestOutcomeNotificationImpl({
        tenantId: tenantAccess.tenantId,
        tenantName: typeof request.tenantName === 'string' ? request.tenantName : undefined,
        requestId,
        outcome: 'approved',
        assignedRole: desiredRole,
        reviewerName,
        requesterEmail: normalizedEmail,
        requesterName: typeof request.displayName === 'string' ? request.displayName : undefined,
      }).catch((error) => console.warn('[join_request_approve] notify requester failed', error));

      return res.json({
        ok: true,
        membership: {
          id: membershipId,
          tenantId: tenantAccess.tenantId,
          userId: targetUserId,
          email: normalizedEmail,
          role: desiredRole,
          status: 'active',
          updatedAt: nowIso,
        },
      });
    } catch (error) {
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.error('[join_request_approve] failed', error);
      return res.status(500).json({ error: 'join_request_approve_failed' });
    }
  });

  app.post('/tenants/:tenantId/join-requests/:requestId/reject', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    if (!requestId) {
      return res.status(400).json({ error: 'request_required' });
    }

    const parsed = joinRequestRejectionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const db = getFirestoreImpl();
      const requestRef = db.collection('tenantJoinRequests').doc(requestId);
      const requestSnap = await requestRef.get();
      if (!requestSnap.exists) {
        return res.status(404).json({ error: 'request_not_found' });
      }
      const request = requestSnap.data() || {};
      if (request.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }
      if (request.status && request.status !== 'pending') {
        return res.status(409).json({ error: 'request_already_reviewed' });
      }
      const requesterEmail = typeof request.email === 'string' ? request.email.trim().toLowerCase() : '';
      if (!requesterEmail) {
        return res.status(400).json({ error: 'requester_email_unavailable' });
      }

      const nowIso = new Date().toISOString();
      const actorId = req.authContext?.uid || req.authContext?.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const reviewerName = parsed.data.reviewerName || parsed.data.metadata?.actorName;

      await requestRef.update({
        status: 'rejected',
        reviewedAt: nowIso,
        reviewedBy: actorId,
      });

      const targetUserId = typeof request.userId === 'string' ? request.userId : null;
      if (targetUserId) {
        const membershipId = membershipDocId(tenantAccess.tenantId, targetUserId);
        const membershipRef = db.collection('tenantMemberships').doc(membershipId);
        const membershipSnap = await membershipRef.get();
        if (membershipSnap.exists) {
          const membership = membershipSnap.data() || {};
          if (membership.status === 'pending_request') {
            const statusEvent: Record<string, any> = stripUndefinedDeep({
              status: 'rejected',
              at: nowIso,
              actorId,
              actorEmail: actorEmail || undefined,
              reason: parsed.data.reason ?? 'join_request_rejected',
            });
            if (reviewerName) {
              statusEvent.actorName = reviewerName;
            }
            if (parsed.data.metadata?.initiatedFrom) {
              statusEvent.initiatedFrom = parsed.data.metadata.initiatedFrom;
            }
            await membershipRef.update({
              status: 'rejected',
              updatedAt: nowIso,
              statusHistory: admin.firestore.FieldValue.arrayUnion(statusEvent),
            });
          }
        }
      }

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: 'join_request_reviewed',
          targetId: requestId,
          targetType: 'joinRequest',
          metadata: { outcome: 'rejected' },
          createdAt: nowIso,
        })
      );

      void sendTenantJoinRequestOutcomeNotificationImpl({
        tenantId: tenantAccess.tenantId,
        tenantName: typeof request.tenantName === 'string' ? request.tenantName : undefined,
        requestId,
        outcome: 'rejected',
        reviewerName,
        requesterEmail,
        requesterName: typeof request.displayName === 'string' ? request.displayName : undefined,
      }).catch((error) => console.warn('[join_request_reject] notify requester failed', error));

      return res.json({ ok: true });
    } catch (error) {
      console.error('[join_request_reject] failed', error);
      return res.status(500).json({ error: 'join_request_reject_failed' });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant lifecycle endpoints (security-rules-hardening, finding C1).
  //
  // These move the last client-direct writes to `tenants`, `tenantMemberships`,
  // `tenantCodes` (and the audit trail) server-side so those collections can be
  // locked to backend-only in firestore.rules. Each verifies the caller through
  // the shared auth/tenant guards and writes via the Admin SDK.
  // ───────────────────────────────────────────────────────────────────────────

  // Keep in sync with the client UI cap (components/TenantJoinCodeManager.tsx MAX_ACTIVE_CODES).
  const MAX_ACTIVE_JOIN_CODES = 5;

  function slugifyTenantName(name: string): string {
    const base = (name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return base || `tenant-${Date.now().toString(36)}`;
  }

  function generateTenantJoinCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i += 1) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  const createTenantSchema = z.object({
    name: z.string().trim().min(1).max(160),
    defaultCurrency: z.string().trim().max(10).optional(),
    contactEmail: z.string().trim().email().optional(),
    contactPhone: z.string().trim().max(40).optional(),
    address: z.string().trim().max(500).optional(),
    timezone: z.string().trim().max(60).optional(),
    logoUrl: z.string().trim().url().max(2000).optional(),
    heroImageUrl: z.string().trim().url().max(2000).optional(),
    theme: z.record(z.any()).optional(),
  });

  // Create a coaching center. The authenticated caller becomes its owner. No
  // tenant membership is required (the caller isn't a member of anything yet),
  // only a valid auth context — mirrors the former client `createTenant`.
  const syncInvitesSchema = z.object({
    displayName: z.string().trim().max(120).optional(),
  });

  // Server-mediated (security-rules-hardening C1): mirror the caller's incoming
  // tenant invites into their own `tenantMemberships/{tenantId}_{uid}` placeholder
  // docs so the membership list shows a single row per coaching center. Only the
  // invitee can perform this mapping because it requires their uid; the backend
  // derives uid + email from the auth token and never trusts client-supplied ids.
  app.post('/tenants/invites/sync-memberships', requireAuthContext, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const email = (await resolveAuthenticatedEmail(authContext))?.trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'email_unavailable' });
    }
    const parsed = syncInvitesSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const userId = authContext.uid;
    const displayName = (parsed.data.displayName || email.split('@')[0] || email).slice(0, 120);

    const parseIsoTs = (value: unknown): number => {
      if (typeof value !== 'string') return Number.NEGATIVE_INFINITY;
      const p = Date.parse(value);
      return Number.isNaN(p) ? Number.NEGATIVE_INFINITY : p;
    };

    try {
      const db = getFirestoreImpl();
      const invitesSnap = await db
        .collection('tenantInvites')
        .where('email', '==', email)
        .limit(200)
        .get();

      const nowIso = new Date().toISOString();
      const bestInviteByTenant = new Map<string, any>();
      const bestSortKey = new Map<string, number>();
      invitesSnap.docs.forEach((docSnap) => {
        const invite = { id: docSnap.id, ...(docSnap.data() as any) };
        const tenantId = typeof invite?.tenantId === 'string' ? invite.tenantId.trim() : '';
        if (!tenantId) return;
        const sortKey = Math.max(
          parseIsoTs(invite.updatedAt),
          parseIsoTs(invite.revokedAt),
          parseIsoTs(invite.rejectedAt),
          parseIsoTs(invite.acceptedAt),
          parseIsoTs(invite.issuedAt)
        );
        const prev = bestSortKey.get(tenantId);
        if (prev === undefined || sortKey >= prev) {
          bestSortKey.set(tenantId, sortKey);
          bestInviteByTenant.set(tenantId, invite);
        }
      });

      let synced = 0;
      for (const invite of bestInviteByTenant.values()) {
        if (!invite?.tenantId) continue;
        if (invite.status === 'accepted') continue;

        const nextStatus =
          invite.status === 'pending'
            ? 'pending_invite'
            : invite.status === 'rejected'
              ? 'rejected'
              : invite.status === 'revoked' || invite.status === 'expired'
                ? 'revoked'
                : null;
        if (!nextStatus) continue;

        const membershipRef = db
          .collection('tenantMemberships')
          .doc(membershipDocId(invite.tenantId, userId));
        const snap = await membershipRef.get();
        const existing = snap.exists ? (snap.data() as any) : null;
        const existingStatus = existing?.status as string | undefined;

        // Never let a stale invite overwrite an active membership.
        if (existingStatus === 'active') continue;
        // Don't synthesize revoked/rejected placeholders the user never saw as pending.
        if (!snap.exists && nextStatus !== 'pending_invite') continue;

        const existingRole = existing?.role as string | undefined;
        const existingCreatedAt = typeof existing?.createdAt === 'string' ? existing.createdAt : nowIso;
        const existingToken = typeof existing?.inviteToken === 'string' ? existing.inviteToken : undefined;
        const existingExpiresAt = existing?.inviteExpiresAt;
        const inviteAt =
          nextStatus === 'pending_invite'
            ? invite.issuedAt
            : nextStatus === 'rejected'
              ? invite.rejectedAt || invite.issuedAt || nowIso
              : (invite.revokedAt as string | undefined) || invite.updatedAt || invite.issuedAt || nowIso;

        const shouldUpdateStatus = existingStatus !== nextStatus;
        const shouldUpdateToken = nextStatus === 'pending_invite' && existingToken !== invite.token;
        const shouldUpdateExpiry =
          nextStatus === 'pending_invite' &&
          typeof invite.expiresAt === 'string' &&
          (typeof existingExpiresAt !== 'string' || existingExpiresAt !== invite.expiresAt);
        const shouldClearInviteFields =
          (nextStatus === 'rejected' || nextStatus === 'revoked') &&
          (typeof existingToken === 'string' ||
            typeof existingExpiresAt === 'string' ||
            typeof existing?.invitedBy === 'string');
        const shouldUpdateRole = existingRole !== invite.role;

        if (
          !snap.exists ||
          shouldUpdateStatus ||
          shouldUpdateToken ||
          shouldUpdateExpiry ||
          shouldUpdateRole ||
          shouldClearInviteFields
        ) {
          const statusEvent = stripUndefinedDeep({
            status: nextStatus,
            at: typeof inviteAt === 'string' ? inviteAt : nowIso,
            actorId:
              nextStatus === 'pending_invite'
                ? invite.issuedBy
                : nextStatus === 'rejected'
                  ? userId
                  : String((invite.revokedBy as string | undefined) || invite.issuedBy || 'system'),
            actorEmail: nextStatus === 'rejected' ? email : undefined,
            actorName: nextStatus === 'rejected' ? displayName : undefined,
            reason:
              nextStatus === 'pending_invite'
                ? 'invite_received'
                : nextStatus === 'rejected'
                  ? 'invite_rejected_by_user'
                  : invite.status === 'expired'
                    ? 'invite_expired'
                    : 'invite_revoked',
          });

          if (!snap.exists) {
            const payload: Record<string, unknown> = {
              tenantId: invite.tenantId,
              userId,
              email,
              displayName,
              role: invite.role,
              status: nextStatus,
              createdAt: existingCreatedAt,
              updatedAt: nowIso,
              statusHistory: [statusEvent],
            };
            if (nextStatus === 'pending_invite') {
              payload.inviteToken = invite.token;
              payload.inviteExpiresAt = invite.expiresAt;
              payload.invitedBy = invite.issuedBy;
            }
            await membershipRef.set(stripUndefinedDeep(payload));
          } else {
            const updatePayload: Record<string, unknown> = { updatedAt: nowIso };
            if (shouldUpdateStatus) updatePayload.status = nextStatus;
            if (shouldUpdateRole) updatePayload.role = invite.role;
            if (nextStatus === 'pending_invite') {
              updatePayload.inviteToken = invite.token;
              updatePayload.inviteExpiresAt = invite.expiresAt;
              updatePayload.invitedBy = invite.issuedBy;
            } else if (nextStatus === 'rejected' || nextStatus === 'revoked') {
              updatePayload.inviteToken = admin.firestore.FieldValue.delete();
              updatePayload.inviteExpiresAt = admin.firestore.FieldValue.delete();
              updatePayload.invitedBy = admin.firestore.FieldValue.delete();
            }
            updatePayload.statusHistory = admin.firestore.FieldValue.arrayUnion(statusEvent);
            await membershipRef.set(stripUndefinedDeep(updatePayload), { merge: true });
          }
          synced += 1;
        }
      }

      return res.json({ ok: true, synced });
    } catch (error) {
      console.error('[tenant_invite_sync] failed', error);
      return res.status(500).json({ error: 'invite_sync_failed' });
    }
  });

  app.post('/tenants', requireAuthContext, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const parsed = createTenantSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const ownerEmail = await resolveAuthenticatedEmail(authContext);
    if (!ownerEmail) {
      return res.status(400).json({ error: 'owner_email_unavailable' });
    }

    try {
      const db = getFirestoreImpl();
      const nowIso = new Date().toISOString();
      const tenantRef = db.collection('tenants').doc();
      const tenantId = tenantRef.id;
      const displayName = ownerEmail.split('@')[0];

      const tenantData = stripUndefinedDeep({
        name: parsed.data.name.trim(),
        slug: slugifyTenantName(parsed.data.name),
        code: generateTenantJoinCode(),
        ownerUserId: authContext.uid,
        ownerEmail,
        defaultCurrency: parsed.data.defaultCurrency || 'INR',
        contactEmail: parsed.data.contactEmail || ownerEmail,
        contactPhone: parsed.data.contactPhone,
        address: parsed.data.address,
        timezone: parsed.data.timezone,
        logoUrl: parsed.data.logoUrl,
        heroImageUrl: parsed.data.heroImageUrl,
        theme: parsed.data.theme,
        status: 'active',
        billingTier: 'free',
        settings: { allowJoinRequests: true, notifyOnJoinRequest: true, notifyViaEmail: true },
        notificationPreferences: { ...defaultTenantNotificationPreferences },
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const membershipRef = db.collection('tenantMemberships').doc(membershipDocId(tenantId, authContext.uid));
      const ownerStatusEvent = {
        status: 'active',
        at: nowIso,
        actorId: authContext.uid,
        actorEmail: ownerEmail,
        actorName: displayName,
        reason: 'tenant_owner_created',
      };

      await db.runTransaction(async (tx) => {
        tx.set(tenantRef, tenantData);
        tx.set(membershipRef, {
          tenantId,
          userId: authContext.uid,
          email: ownerEmail,
          displayName,
          role: 'owner',
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
          statusHistory: [ownerStatusEvent],
        });
      });

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId,
          actorId: authContext.uid,
          actorEmail: ownerEmail,
          action: 'tenant_created',
          targetId: tenantId,
          targetType: 'tenant',
          createdAt: nowIso,
        })
      );

      return res.json({ ok: true, tenant: { id: tenantId, ...tenantData } });
    } catch (error) {
      console.error('[tenant_create] failed', error);
      return res.status(500).json({ error: 'tenant_create_failed' });
    }
  });

  const updateTenantSchema = z
    .object({
      name: z.string().trim().min(1).max(160).optional(),
      contactEmail: z.string().trim().email().optional(),
      contactPhone: z.string().trim().max(40).optional(),
      address: z.string().trim().max(500).optional(),
      timezone: z.string().trim().max(60).optional(),
      defaultCurrency: z.string().trim().max(10).optional(),
      logoUrl: z.string().trim().max(2000).nullable().optional(),
      heroImageUrl: z.string().trim().max(2000).nullable().optional(),
      theme: z.record(z.any()).optional(),
      branding: z.record(z.any()).optional(),
      settings: z
        .object({
          allowJoinRequests: z.boolean().optional(),
          notifyOnJoinRequest: z.boolean().optional(),
          notifyViaEmail: z.boolean().optional(),
          // H2: tenant-scoped visibility policies (moved off global appSettings).
          allowNonAdminAllReminderHistory: z.boolean().optional(),
          hideAuthorizedEmailsForNonAdmins: z.boolean().optional(),
        })
        .strict()
        .optional(),
      onboardingProgress: z.record(z.any()).optional(),
    })
    .strict();

  // Update editable coaching-center fields (owner/admin only). Tenant identity,
  // billing, quotas, code and membership counts are NOT settable here.
  app.post('/tenants/:tenantId/update', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }
    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    const parsed = updateTenantSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    if (!Object.keys(parsed.data).length) {
      return res.status(400).json({ error: 'empty_update' });
    }

    try {
      const db = getFirestoreImpl();
      const tenantRef = db.collection('tenants').doc(tenantAccess.tenantId);
      const snap = await tenantRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }

      // Merge the settings sub-map instead of overwriting it wholesale.
      const nowIso = new Date().toISOString();
      const { settings: settingsPatch, ...topLevel } = parsed.data;
      const patch: Record<string, unknown> = { ...topLevel, updatedAt: nowIso };
      if (settingsPatch && Object.keys(settingsPatch).length) {
        const existingSettings = (snap.data()?.settings as Record<string, unknown> | undefined) || {};
        patch.settings = { ...existingSettings, ...settingsPatch };
      }

      await tenantRef.set(stripUndefinedDeep(patch), { merge: true });
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId: req.authContext?.uid || 'system',
          actorEmail: (await resolveAuthenticatedEmail(req.authContext)) || undefined,
          action: 'tenant_updated',
          targetId: tenantAccess.tenantId,
          targetType: 'tenant',
          metadata: { fields: Object.keys(parsed.data) },
          createdAt: nowIso,
        })
      );
      const updated = await tenantRef.get();
      return res.json({ ok: true, tenant: { id: updated.id, ...(updated.data() || {}) } });
    } catch (error) {
      console.error('[tenant_update] failed', error);
      return res.status(500).json({ error: 'tenant_update_failed' });
    }
  });

  // Leave a coaching center (self-service). The caller may only revoke their OWN
  // membership; owners must transfer/downgrade first. Also withdraws any pending
  // join request for the caller.
  app.post('/tenants/:tenantId/leave', requireAuthContext, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext?.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const tenantId = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }

    try {
      const db = getFirestoreImpl();
      const membershipRef = db.collection('tenantMemberships').doc(membershipDocId(tenantId, authContext.uid));
      const snap = await membershipRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'membership_not_found' });
      }
      const membership = snap.data() || {};
      const role = String((membership as any).role || '').toLowerCase();
      if (role === 'owner') {
        return res.status(409).json({ error: 'owner_must_transfer_first' });
      }
      const nowIso = new Date().toISOString();
      const actorEmail = (await resolveAuthenticatedEmail(authContext)) || (membership as any).email || undefined;
      const wasPendingRequest = (membership as any).status === 'pending_request';

      if ((membership as any).status === 'revoked') {
        return res.json({ ok: true, alreadyLeft: true });
      }

      if (wasPendingRequest) {
        // Withdrawing a pending request removes the membership placeholder entirely.
        await membershipRef.delete();
      } else {
        await membershipRef.set(
          {
            status: 'revoked',
            updatedAt: nowIso,
            statusHistory: admin.firestore.FieldValue.arrayUnion({
              status: 'revoked',
              at: nowIso,
              actorId: authContext.uid,
              actorEmail,
              reason: 'self_leave',
            }),
          },
          { merge: true }
        );
      }

      // Clean up any pending join requests for this user/tenant.
      try {
        const pending = await db
          .collection('tenantJoinRequests')
          .where('tenantId', '==', tenantId)
          .where('userId', '==', authContext.uid)
          .where('status', '==', 'pending')
          .limit(10)
          .get();
        await Promise.all(pending.docs.map((d) => d.ref.delete()));
      } catch (e) {
        console.warn('[tenant_leave] join-request cleanup failed', e);
      }

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId,
          actorId: authContext.uid,
          actorEmail,
          action: 'membership_revoked',
          targetId: membershipDocId(tenantId, authContext.uid),
          targetType: 'membership',
          metadata: { previousRole: (membership as any).role, previousStatus: (membership as any).status, reason: wasPendingRequest ? 'request_withdrawn' : 'self_leave' },
          createdAt: nowIso,
        })
      );

      // Notify tenant admins when an actual member leaves (skip pending-request
      // withdrawals, which never represented an active member).
      if (!wasPendingRequest) {
        const targetRoleResult = tenantMembershipRoleSchema.safeParse(
          typeof (membership as any).role === 'string' ? (membership as any).role : 'member'
        );
        void sendTeamMembershipChangeNotificationImpl({
          tenantId,
          tenantName: typeof (membership as any).tenantName === 'string' ? (membership as any).tenantName : undefined,
          action: 'removed',
          targetEmail: (membership as any).email,
          targetRole: targetRoleResult.success ? targetRoleResult.data : 'member',
          metadata: {
            displayName: typeof (membership as any).displayName === 'string' ? (membership as any).displayName : undefined,
            reason: 'self_leave',
            initiatedFrom: 'system',
          },
        }).catch((error) => console.warn('[tenant_leave] notify failed', error));
      }

      return res.json({ ok: true });
    } catch (error) {
      console.error('[tenant_leave] failed', error);
      return res.status(500).json({ error: 'tenant_leave_failed' });
    }
  });

  const tenantCodeCreateSchema = z.object({
    expiresInDays: z.number().int().min(1).max(365).optional(),
    usageCap: z.number().int().min(1).max(100000).nullable().optional(),
  });

  // Create a join code (owner/admin only), capped at MAX_ACTIVE_JOIN_CODES active.
  app.post('/tenants/:tenantId/codes', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }
    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    const parsed = tenantCodeCreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const db = getFirestoreImpl();
      const activeSnap = await db
        .collection('tenantCodes')
        .where('tenantId', '==', tenantAccess.tenantId)
        .where('status', '==', 'active')
        .get();

      // Self-heal: flip any active-but-expired codes to 'expired' so they don't
      // count against the cap (the client no longer performs this write).
      const nowMs = Date.now();
      let liveActiveCount = 0;
      const expireBatch: FirebaseFirestore.WriteBatch = db.batch();
      let expiredPending = 0;
      const flipIso = new Date().toISOString();
      activeSnap.docs.forEach((docSnap) => {
        const data = docSnap.data() as any;
        const expiresAt = typeof data?.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
        if (!Number.isNaN(expiresAt) && expiresAt <= nowMs) {
          expireBatch.set(docSnap.ref, { status: 'expired', updatedAt: flipIso }, { merge: true });
          expiredPending += 1;
        } else {
          liveActiveCount += 1;
        }
      });
      if (expiredPending > 0) {
        await expireBatch.commit();
      }
      if (liveActiveCount >= MAX_ACTIVE_JOIN_CODES) {
        return res.status(409).json({ error: 'max_active_codes_reached', limit: MAX_ACTIVE_JOIN_CODES });
      }

      const nowIso = new Date().toISOString();
      const expiresAt = parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
      const codeData = stripUndefinedDeep({
        tenantId: tenantAccess.tenantId,
        code: generateTenantJoinCode(),
        createdBy: req.authContext?.uid || 'system',
        createdAt: nowIso,
        expiresAt,
        usageCount: 0,
        usageCap: typeof parsed.data.usageCap === 'number' ? parsed.data.usageCap : null,
        status: 'active',
      });
      const codeRef = await db.collection('tenantCodes').add(codeData);
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId: req.authContext?.uid || 'system',
          actorEmail: (await resolveAuthenticatedEmail(req.authContext)) || undefined,
          action: 'invite_regenerated',
          targetId: codeRef.id,
          targetType: 'code',
          metadata: { code: (codeData as any).code },
          createdAt: nowIso,
        })
      );
      return res.json({ ok: true, code: { id: codeRef.id, ...codeData } });
    } catch (error) {
      console.error('[tenant_code_create] failed', error);
      return res.status(500).json({ error: 'tenant_code_create_failed' });
    }
  });

  // Revoke a join code (owner/admin only).
  app.post('/tenants/:tenantId/codes/:codeId/revoke', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }
    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    const codeId = typeof req.params?.codeId === 'string' ? req.params.codeId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    if (!codeId) {
      return res.status(400).json({ error: 'code_required' });
    }

    try {
      const db = getFirestoreImpl();
      const codeRef = db.collection('tenantCodes').doc(codeId);
      const snap = await codeRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'code_not_found' });
      }
      if ((snap.data() as any)?.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }
      const nowIso = new Date().toISOString();
      await codeRef.set({ status: 'revoked', updatedAt: nowIso }, { merge: true });
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId: req.authContext?.uid || 'system',
          actorEmail: (await resolveAuthenticatedEmail(req.authContext)) || undefined,
          action: 'invite_regenerated',
          targetId: codeId,
          targetType: 'code',
          createdAt: nowIso,
        })
      );
      return res.json({ ok: true });
    } catch (error) {
      console.error('[tenant_code_revoke] failed', error);
      return res.status(500).json({ error: 'tenant_code_revoke_failed' });
    }
  });

  // Client-authored activity audit entries (attendance/fee operations). Security-
  // relevant audit events (tenant/membership/code lifecycle) are written by their
  // own endpoints via the Admin SDK and are NOT accepted here. The actor identity
  // and tenant are derived from the verified token/guard, never from the body.
  const tenantActivityAuditSchema = z.object({
    action: z.enum([
      'fee_record_created',
      'fee_record_updated',
      'fee_record_deleted',
      'fee_payment_updated',
      'fee_due_dates_updated',
      'attendance_record_saved',
      'attendance_records_batch_saved',
      'attendance_record_deleted',
    ]),
    targetId: z.string().trim().max(240).optional(),
    targetType: z.enum(['fee', 'attendance']).optional(),
    metadata: z.record(z.any()).optional(),
  });

  app.post('/tenants/:tenantId/audit/log', requireParamsStaffTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    const parsed = tenantActivityAuditSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const db = getFirestoreImpl();
      const nowIso = new Date().toISOString();
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId: req.authContext?.uid || 'system',
          actorEmail: (await resolveAuthenticatedEmail(req.authContext)) || undefined,
          action: parsed.data.action,
          targetId: parsed.data.targetId,
          targetType: parsed.data.targetType,
          metadata: parsed.data.metadata,
          createdAt: nowIso,
        })
      );
      return res.json({ ok: true });
    } catch (error) {
      console.error('[tenant_audit_log] failed', error);
      return res.status(500).json({ error: 'audit_log_failed' });
    }
  });

  app.post('/tenants/:tenantId/memberships/:userId/role', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const targetUserId = typeof req.params?.userId === 'string' ? req.params.userId.trim() : '';
    if (!targetUserId) {
      return res.status(400).json({ error: 'user_required' });
    }

    const parsed = membershipRoleUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const desiredRole = parsed.data.role;
    const actorRole = tenantAccess.role;
    const actorIsOwner = actorRole === 'owner' || req.authContext?.tokenType === 'master';
    if (desiredRole === 'owner' && !actorIsOwner) {
      return res.status(403).json({ error: 'owner_role_required' });
    }

    const membershipId = membershipDocId(tenantAccess.tenantId, targetUserId);
    const actorMembershipId = tenantAccess.membershipId;
    if (typeof actorMembershipId === 'string' && actorMembershipId === membershipId) {
      return res.status(403).json({ error: 'self_role_change_forbidden' });
    }

    try {
      const db = getFirestoreImpl();
      const membershipRef = db.collection('tenantMemberships').doc(membershipId);
      const membershipSnap = await membershipRef.get();
      if (!membershipSnap.exists) {
        return res.status(404).json({ error: 'membership_not_found' });
      }

      const membership = membershipSnap.data() || {};
      const previousRoleResult = tenantMembershipRoleSchema.safeParse(
        typeof membership.role === 'string' ? membership.role : 'member'
      );
      const previousRole = previousRoleResult.success ? previousRoleResult.data : 'member';
      if (previousRole === 'owner' && !actorIsOwner) {
        return res.status(403).json({ error: 'owner_role_required' });
      }
      if (previousRole === desiredRole) {
        return res.json({
          ok: true,
          changed: false,
          membership: {
            id: membershipId,
            tenantId: tenantAccess.tenantId,
            userId: targetUserId,
            role: previousRole,
            status: membership.status,
          },
        });
      }

      const nowIso = new Date().toISOString();
      await membershipRef.update({ role: desiredRole, updatedAt: nowIso });

      const actorId = req.authContext?.uid || req.authContext?.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const metadata = parsed.data.metadata || {};
      const auditMetadata: Record<string, unknown> = {
        previousRole,
        newRole: desiredRole,
        previousStatus: membership.status,
        actorRole,
      };
      if (metadata.reason) {
        auditMetadata.reason = metadata.reason;
      }
      if (metadata.initiatedFrom) {
        auditMetadata.initiatedFrom = metadata.initiatedFrom;
      }
      if (metadata.actorName) {
        auditMetadata.actorName = metadata.actorName;
      }

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: 'membership_role_changed',
          targetId: membershipId,
          targetType: 'membership',
          metadata: auditMetadata,
          createdAt: nowIso,
        })
      );

      const notificationMetadata: Record<string, any> = {
        displayName: typeof membership.displayName === 'string' ? membership.displayName : undefined,
        reason: metadata.reason ?? 'manual_role_update',
        initiatedFrom: metadata.initiatedFrom ?? 'system',
        actorName: metadata.actorName,
      };

      void sendTeamMembershipChangeNotificationImpl({
        tenantId: tenantAccess.tenantId,
        tenantName: typeof membership.tenantName === 'string' ? membership.tenantName : undefined,
        action: 'role_changed',
        targetEmail: membership.email,
        targetRole: desiredRole,
        previousRole,
        metadata: notificationMetadata,
      }).catch((error) => console.warn('[tenant_membership_role] notify failed', error));

      return res.json({
        ok: true,
        changed: true,
        membership: {
          id: membershipId,
          tenantId: tenantAccess.tenantId,
          userId: targetUserId,
          role: desiredRole,
          status: membership.status,
          updatedAt: nowIso,
        },
      });
    } catch (error) {
      console.error('[tenant_membership_role] update failed', error);
      return res.status(500).json({ error: 'role_update_failed' });
    }
  });

  app.post('/tenants/:tenantId/memberships/:userId/status', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    const tenantIdParam = typeof req.params?.tenantId === 'string' ? req.params.tenantId.trim() : '';
    if (!tenantIdParam || tenantIdParam !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const targetUserId = typeof req.params?.userId === 'string' ? req.params.userId.trim() : '';
    if (!targetUserId) {
      return res.status(400).json({ error: 'user_required' });
    }

    const parsed = membershipStatusUpdateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const desiredStatus = parsed.data.status;
    const actorRole = tenantAccess.role;
    const actorIsOwner = actorRole === 'owner' || req.authContext?.tokenType === 'master';
    const membershipId = membershipDocId(tenantAccess.tenantId, targetUserId);
    const actorMembershipId = tenantAccess.membershipId;
    const isSelfTarget = typeof actorMembershipId === 'string' && actorMembershipId === membershipId;
    const isRemovalStatus = desiredStatus === 'revoked' || desiredStatus === 'rejected';
    if (isSelfTarget && isRemovalStatus) {
      return res.status(403).json({ error: 'self_removal_forbidden' });
    }

    try {
      const db = getFirestoreImpl();
      const membershipRef = db.collection('tenantMemberships').doc(membershipId);
      const membershipSnap = await membershipRef.get();
      if (!membershipSnap.exists) {
        return res.status(404).json({ error: 'membership_not_found' });
      }

      const membership = membershipSnap.data() || {};
      const previousStatus = typeof membership.status === 'string' ? membership.status : 'unknown';
      const targetRoleResult = tenantMembershipRoleSchema.safeParse(
        typeof membership.role === 'string' ? membership.role : 'member'
      );
      const targetRole = targetRoleResult.success ? targetRoleResult.data : 'member';
      if (targetRole === 'owner' && !actorIsOwner && desiredStatus !== 'active') {
        return res.status(403).json({ error: 'owner_role_required' });
      }
      if (previousStatus === desiredStatus) {
        return res.json({
          ok: true,
          changed: false,
          membership: {
            id: membershipId,
            tenantId: tenantAccess.tenantId,
            userId: targetUserId,
            role: targetRole,
            status: previousStatus,
          },
        });
      }

      const nowIso = new Date().toISOString();
      const actorId = req.authContext?.uid || req.authContext?.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const metadata = parsed.data.metadata || {};
      const statusEvent: Record<string, any> = stripUndefinedDeep({
        status: desiredStatus,
        at: nowIso,
        actorId,
        actorEmail: actorEmail || undefined,
        reason: metadata.reason ?? 'membership_status_updated',
      });
      if (metadata.actorName) {
        statusEvent.actorName = metadata.actorName;
      }
      await db.runTransaction(async (tx) => {
        tx.update(membershipRef, {
          status: desiredStatus,
          updatedAt: nowIso,
          statusHistory: admin.firestore.FieldValue.arrayUnion(statusEvent),
        });

        if (desiredStatus !== 'active') {
          return;
        }

        const targetEmail = typeof membership.email === 'string' ? String(membership.email).trim().toLowerCase() : '';
        const joinRequestsQuery = db
          .collection('tenantJoinRequests')
          .where('tenantId', '==', tenantAccess.tenantId)
          .where('userId', '==', targetUserId)
          .where('status', '==', 'pending')
          .limit(50);
        const joinRequestsSnap = await tx.get(joinRequestsQuery);
        joinRequestsSnap.docs.forEach((docSnap) => {
          tx.update(docSnap.ref, {
            status: 'approved',
            reviewedAt: nowIso,
            reviewedBy: actorId,
            assignedRole: targetRole,
          });
        });

        if (targetEmail) {
          const invitesQuery = db
            .collection('tenantInvites')
            .where('tenantId', '==', tenantAccess.tenantId)
            .where('email', '==', targetEmail)
            .where('status', '==', 'pending')
            .limit(50);
          const invitesSnap = await tx.get(invitesQuery);
          invitesSnap.docs.forEach((docSnap) => {
            tx.update(docSnap.ref, {
              status: 'accepted',
              acceptedAt: nowIso,
              acceptedBy: actorId,
              updatedAt: nowIso,
            });
          });
        }
      });

      const auditMetadata: Record<string, unknown> = {
        previousStatus,
        newStatus: desiredStatus,
        previousRole: targetRole,
        actorRole,
      };
      if (metadata.reason) {
        auditMetadata.reason = metadata.reason;
      }
      if (metadata.initiatedFrom) {
        auditMetadata.initiatedFrom = metadata.initiatedFrom;
      }
      if (metadata.actorName) {
        auditMetadata.actorName = metadata.actorName;
      }

      const auditAction = desiredStatus === 'revoked' || desiredStatus === 'rejected'
        ? 'membership_revoked'
        : 'membership_status_changed';
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantAccess.tenantId,
          actorId,
          actorEmail: actorEmail || undefined,
          action: auditAction,
          targetId: membershipId,
          targetType: 'membership',
          metadata: auditMetadata,
          createdAt: nowIso,
        })
      );

      if (desiredStatus === 'revoked' || desiredStatus === 'rejected') {
        const notificationMetadata: Record<string, any> = {
          displayName: typeof membership.displayName === 'string' ? membership.displayName : undefined,
          reason: metadata.reason ?? 'membership_revoked',
          initiatedFrom: metadata.initiatedFrom ?? 'system',
          actorName: metadata.actorName,
        };
        void sendTeamMembershipChangeNotificationImpl({
          tenantId: tenantAccess.tenantId,
          tenantName: typeof membership.tenantName === 'string' ? membership.tenantName : undefined,
          action: 'removed',
          targetEmail: membership.email,
          targetRole,
          metadata: notificationMetadata,
        }).catch((error) => console.warn('[tenant_membership_status] notify failed', error));
      }

      return res.json({
        ok: true,
        changed: true,
        membership: {
          id: membershipId,
          tenantId: tenantAccess.tenantId,
          userId: targetUserId,
          role: targetRole,
          status: desiredStatus,
          updatedAt: nowIso,
        },
      });
    } catch (error) {
      console.error('[tenant_membership_status] update failed', error);
      return res.status(500).json({ error: 'status_update_failed' });
    }
  });

  app.post('/chat/messages', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = chatMessagePayloadSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const senderEmail = await resolveAuthenticatedEmail(authContext);

    if (!senderEmail) {
      return res.status(400).json({ error: 'sender_email_unavailable' });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const tenantId = tenantAccess.tenantId;

    const normalizedRecipient = normalizeEmail(parsed.data.recipientId);
    if (!normalizedRecipient) {
      return res.status(400).json({ error: 'invalid_recipient' });
    }

    const recipientIsMember = await isTenantEmailActiveMemberImpl(tenantId, normalizedRecipient);
    if (!recipientIsMember) {
      return res.status(403).json({ error: 'recipient_not_in_tenant' });
    }

    // L7: constrain UPLOADED-file references to our own Storage bucket so a client
    // can't attach an arbitrary external URL that the recipient's client renders /
    // downloads. Only enforced when the bucket is configured (skipped in tests /
    // when unconfigured); sticker/gif/thumbnail fields are left external by design.
    {
      let configuredBucket = '';
      try {
        ensureFirebase();
        configuredBucket = typeof admin.app().options.storageBucket === 'string'
          ? (admin.app().options.storageBucket as string)
          : '';
      } catch {
        configuredBucket = '';
      }
      if (configuredBucket) {
        const uploadedUrls: string[] = [];
        if (typeof parsed.data.fileUrl === 'string' && parsed.data.fileUrl) uploadedUrls.push(parsed.data.fileUrl);
        if (Array.isArray(parsed.data.attachments)) {
          for (const att of parsed.data.attachments) {
            if (att && typeof att.url === 'string' && att.url) uploadedUrls.push(att.url);
          }
        }
        for (const u of uploadedUrls) {
          if (!isOwnBucketStorageUrl(u, configuredBucket)) {
            return res.status(400).json({ error: 'invalid_attachment_url' });
          }
        }
      }
    }

    if (authContext.tokenType !== 'master') {
      const rateResult = await checkChatRateLimitImpl(senderEmail);
      if (!rateResult.allowed) {
        const now = Date.now();
        const blockedUntil = rateResult.blockedUntil ?? null;
        const retryAfterMs = blockedUntil && blockedUntil > now ? blockedUntil - now : 0;
        if (retryAfterMs > 0) {
          res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        }
        return res.status(429).json({
          error: 'rate_limited',
          retryAfterMs,
          blockedUntil,
        });
      }
    }

    try {
      const payload = parsed.data;
      const message = await sendChatMessageImpl({
        senderEmail,
        recipientEmail: normalizedRecipient,
        tenantId,
        clientMsgId: payload.clientMsgId,
        text: payload.text,
        isSpecial: payload.isSpecial,
        fileUrl: payload.fileUrl,
        fileName: payload.fileName,
        fileType: payload.fileType,
        fileSize: payload.fileSize,
        thumbnailUrl: payload.thumbnailUrl,
        attachments: payload.attachments,
        replyTo: payload.replyTo,
        sticker: payload.sticker,
        gif: payload.gif,
        // delivered/read are intentionally omitted — the write boundary forces
        // both false on the initial send (chat-production-hardening, P2-4).
      });

      // Echo both the durable serverMessageId and the caller's clientMsgId so the
      // client can confirm the durable write for the intended recipient exactly
      // once and reconcile idempotently (stuck-message-delivery-fix, Defect A).
      return res.json({
        ok: true,
        message,
        serverMessageId: message.id,
        clientMsgId: message.clientMsgId ?? payload.clientMsgId,
      });
    } catch (error) {
      // A self-addressed send is a client validation error, not a server fault.
      if (error instanceof ChatMessageActionError && error.code === 'not_allowed') {
        return res.status(400).json({ error: 'self_addressed_not_allowed' });
      }
      console.error('[chat_messages] send failed', error);
      return res.status(500).json({ error: 'send_failed' });
    }
  });

  app.post('/notifications/team-membership', requireStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = teamMembershipEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const normalizedTenantId = parsed.data.tenantId.trim();
    if (tenantAccess.tenantId !== normalizedTenantId && authContext.tokenType !== 'master') {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    if (!actorEmail) {
      return res.status(400).json({ error: 'actor_email_unavailable' });
    }

    try {
      const result = await sendTeamMembershipChangeNotificationImpl({
        ...parsed.data,
        tenantId: normalizedTenantId,
        actorEmail,
      });
      return res.json(result);
    } catch (error) {
      console.error('[team-membership] notification dispatch failed', error);
      return res.status(500).json({ error: 'dispatch_failed' });
    }
  });

  app.post('/notifications/tenant-join-request', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantJoinRequestNotifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const requestRecord = await loadTenantJoinRequestImpl(parsed.data.requestId);
      if (!requestRecord) {
        return res.status(404).json({ error: 'request_not_found' });
      }

      const expectedTenantId = parsed.data.tenantId.trim();
      if (!expectedTenantId) {
        return res.status(400).json({ error: 'tenant_required' });
      }

      if (requestRecord.tenantId !== expectedTenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const isRequester = requestRecord.userId === authContext.uid;
      if (!isRequester && authContext.tokenType !== 'master') {
        try {
          await requireTenantMembershipAccessImpl(authContext, requestRecord.tenantId, { minRole: 'admin' });
        } catch (error) {
          if (respondTenantAccessError(res, error)) {
            return;
          }
          console.error('[tenant-join-request] tenant access check failed', error);
          return res.status(500).json({ error: 'tenant_check_failed' });
        }
      }

      const requesterEmail =
        typeof requestRecord.email === 'string' && requestRecord.email
          ? requestRecord.email
          : await resolveAuthenticatedEmail(authContext);
      if (!requesterEmail) {
        return res.status(400).json({ error: 'requester_email_unavailable' });
      }

      const result = await sendTenantJoinRequestNotificationImpl({
        tenantId: requestRecord.tenantId,
        tenantName: requestRecord.tenantName,
        requestId: requestRecord.id,
        requesterEmail,
        requesterName: requestRecord.displayName,
        message: requestRecord.message,
      });
      return res.json(result);
    } catch (error) {
      console.error('[tenant-join-request] notification dispatch failed', error);
      return res.status(500).json({ error: 'dispatch_failed' });
    }
  });

  app.post('/notifications/tenant-join-request/outcome', requireStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantJoinRequestOutcomeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const tenantAccess = req.tenantAccess;
      if (!tenantAccess) {
        return res.status(500).json({ error: 'tenant_guard_missing' });
      }
      const normalizedTenantId = parsed.data.tenantId.trim();
      if (tenantAccess.tenantId !== normalizedTenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const requestRecord = await loadTenantJoinRequestImpl(parsed.data.requestId);
      if (!requestRecord) {
        return res.status(404).json({ error: 'request_not_found' });
      }
      if (requestRecord.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const requesterEmail = typeof requestRecord.email === 'string' ? requestRecord.email.trim() : '';
      if (!requesterEmail) {
        return res.status(400).json({ error: 'requester_email_unavailable' });
      }

      const reviewerEmail = await resolveAuthenticatedEmail(authContext);
      const result = await sendTenantJoinRequestOutcomeNotificationImpl({
        tenantId: requestRecord.tenantId,
        tenantName: requestRecord.tenantName,
        requestId: requestRecord.id,
        requesterEmail,
        requesterName: requestRecord.displayName,
        reviewerEmail: reviewerEmail ?? undefined,
        reviewerName: parsed.data.reviewerName,
        outcome: parsed.data.outcome,
        assignedRole: parsed.data.assignedRole,
      });
      return res.json(result);
    } catch (error) {
      console.error('[tenant-join-request-outcome] notification dispatch failed', error);
      return res.status(500).json({ error: 'dispatch_failed' });
    }
  });

  app.post('/notifications/tenant-invite', requireStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantInviteNotifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    try {
      const tenantAccess = req.tenantAccess;
      if (!tenantAccess) {
        return res.status(500).json({ error: 'tenant_guard_missing' });
      }

      const normalizedTenantId = parsed.data.tenantId.trim();
      if (tenantAccess.tenantId !== normalizedTenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const inviteRecord = await loadTenantInviteImpl(parsed.data.inviteId);
      if (!inviteRecord) {
        return res.status(404).json({ error: 'invite_not_found' });
      }
      if (inviteRecord.tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }
      if (!inviteRecord.token) {
        return res.status(400).json({ error: 'invite_token_missing' });
      }

      const result = await sendTenantInviteEmailImpl({
        tenantId: inviteRecord.tenantId,
        tenantName: inviteRecord.tenantName,
        inviteId: inviteRecord.id,
        inviteToken: inviteRecord.token,
        inviteeEmail: inviteRecord.email,
        role: inviteRecord.role ?? 'member',
        expiresAt: inviteRecord.expiresAt,
        message: inviteRecord.invitationMessage,
      });

      await recordTenantInviteSendImpl(inviteRecord.id, authContext.uid);
      return res.json(result);
    } catch (error) {
      console.error('[tenant-invite] notification dispatch failed', error);
      return res.status(500).json({ error: 'dispatch_failed' });
    }
  });

  app.post('/tenants/join-code/resolve', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantJoinCodeLookupSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const normalizedCode = normalizeTenantCode(parsed.data.code);
    if (!normalizedCode) {
      return res.status(400).json({ error: 'invalid_code' });
    }

    try {
      const db = getFirestoreImpl();
      const userEmail = await resolveAuthenticatedEmail(authContext);
      const validation = await validateJoinCode(db, normalizedCode);
      if (!validation.ok) {
        const { status, body } = mapJoinCodeError(validation);
        return res.status(status).json(body);
      }

      const { codeDoc, codeData, tenantSnap, tenantData } = validation;
      const membershipId = membershipDocId(tenantSnap.id, authContext.uid);
      const membershipSnap = await db.collection('tenantMemberships').doc(membershipId).get();
      let membership: Record<string, any> | null = null;
      if (membershipSnap.exists) {
        const membershipData = membershipSnap.data() || {};
        membership = {
          id: membershipSnap.id,
          email: membershipData.email,
          role: membershipData.role,
          status: membershipData.status,
          createdAt: toIsoTimestamp(membershipData.createdAt) ?? null,
          updatedAt: toIsoTimestamp(membershipData.updatedAt) ?? null,
        };
      }

      let pendingInvite = false;
      const normalizedEmail = userEmail ? userEmail.toLowerCase() : '';
      if (normalizedEmail) {
        try {
          const inviteSnap = await db
            .collection('tenantInvites')
            .where('tenantId', '==', tenantSnap.id)
            .where('email', '==', normalizedEmail)
            .where('status', '==', 'pending')
            .limit(1)
            .get();
          pendingInvite = !inviteSnap.empty;
        } catch {
          // best-effort
        }
      }

      return res.json({
        tenant: {
          id: tenantSnap.id,
          name: tenantData.name,
          slug: tenantData.slug,
          status: tenantData.status,
          logoUrl: tenantData.logoUrl || tenantData.branding?.logoUrl || null,
          heroImageUrl: tenantData.heroImageUrl || tenantData.branding?.heroImageUrl || null,
          theme: tenantData.theme || null,
          branding: tenantData.branding || undefined,
          settings: tenantData.settings || undefined,
          defaultCurrency: tenantData.defaultCurrency,
          timezone: tenantData.timezone,
        },
        code: {
          id: codeDoc.id,
          status: codeData.status || 'active',
          createdAt: toIsoTimestamp(codeData.createdAt) ?? null,
          expiresAt: toIsoTimestamp(codeData.expiresAt) ?? null,
          lastUsedAt: toIsoTimestamp(codeData.lastUsedAt) ?? null,
          usageCount: typeof codeData.usageCount === 'number' ? codeData.usageCount : 0,
          usageCap: typeof codeData.usageCap === 'number' ? codeData.usageCap : null,
        },
        membership,
        pendingInvite,
      });
    } catch (error) {
      console.error('[tenant-join-code] lookup failed', error);
      return res.status(500).json({ error: 'lookup_failed' });
    }
  });

  app.post('/tenants/join-code/claim', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantJoinCodeClaimSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const normalizedCode = normalizeTenantCode(parsed.data.code);
    if (!normalizedCode) {
      return res.status(400).json({ error: 'invalid_code' });
    }

    try {
      const db = getFirestoreImpl();
      const userEmail = await resolveAuthenticatedEmail(authContext);
      if (!userEmail) {
        return res.status(400).json({ error: 'email_required' });
      }

      const validation = await validateJoinCode(db, normalizedCode);
      if (!validation.ok) {
        const { status, body } = mapJoinCodeError(validation);
        return res.status(status).json(body);
      }

      const { codeDoc, codeData, tenantSnap, tenantData } = validation;
      const membershipId = membershipDocId(tenantSnap.id, authContext.uid);
      const membershipRef = db.collection('tenantMemberships').doc(membershipId);
      const membershipSnap = await membershipRef.get();
      const existingMembership = membershipSnap.exists ? membershipSnap.data() || {} : null;

      if (existingMembership && existingMembership.status === 'active') {
        return res.status(409).json({
          error: 'already_member',
          message: 'You are already a member of this coaching center.',
        });
      }
      if (existingMembership && existingMembership.status === 'pending_invite') {
        return res.status(409).json({
          error: 'invite_pending',
          message: 'You already have an invite to this coaching center. Please accept the invite instead of using a join code.',
        });
      }
      if (existingMembership && existingMembership.status === 'pending_request') {
        return res.status(409).json({
          error: 'join_request_pending',
          message: 'Your request to join this coaching center is still pending review.',
        });
      }

      const pendingInviteSnap = await db
        .collection('tenantInvites')
        .where('tenantId', '==', tenantSnap.id)
        .where('email', '==', userEmail.toLowerCase())
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      if (!pendingInviteSnap.empty) {
        return res.status(409).json({
          error: 'invite_pending',
          message: 'You already have an invite to this coaching center. Please accept the invite instead of using a join code.',
        });
      }

      const nowIso = new Date().toISOString();
      const existingCreatedAt = existingMembership
        ? toIsoTimestamp(existingMembership.createdAt) ?? nowIso
        : nowIso;
      const preferredDisplayName = (parsed.data.displayName?.trim() || existingMembership?.displayName || '').trim();
      const fallbackName = userEmail.split('@')[0] || userEmail;
      const displayName = (preferredDisplayName || fallbackName).slice(0, 120);
      const role = existingMembership?.role || 'member';
      const message = parsed.data.message?.trim();
      const requestExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const joinRequestsRef = db.collection('tenantJoinRequests');
      const shouldAutoApprove = shouldAutoApproveReviewerJoinCode({
        code: normalizedCode,
        tenantId: tenantSnap.id,
        tenantSlug: typeof tenantData.slug === 'string' ? tenantData.slug : undefined,
      });
      const existingRequestSnap = await joinRequestsRef
        .where('tenantId', '==', tenantSnap.id)
        .where('userId', '==', authContext.uid)
        .where('status', '==', 'pending')
        .limit(1)
        .get();

      let joinRequestDocRef: admin.firestore.DocumentReference<admin.firestore.DocumentData>;
      let joinRequestData: Record<string, any>;
      let createdNewJoinRequest = false;

      if (!existingRequestSnap.empty) {
        return res.status(409).json({
          error: 'join_request_pending',
          message: 'You already have a pending request for this coaching center.',
        });
      } else {
        createdNewJoinRequest = true;
        const joinRequestPayload = {
          tenantId: tenantSnap.id,
          tenantName: tenantData.name,
          userId: authContext.uid,
          email: userEmail.toLowerCase(),
          displayName,
          message: message || null,
          status: 'pending',
          requestedAt: nowIso,
          expiresAt: requestExpiresAt,
          joinCodeId: codeDoc.id,
          joinCodeValue: normalizedCode,
          joinCodeStatusSnapshot: codeData.status || 'active',
          joinCodeUsageCap: typeof codeData.usageCap === 'number' ? codeData.usageCap : null,
          joinCodeUsageCount: typeof codeData.usageCount === 'number' ? codeData.usageCount : 0,
        };
        joinRequestDocRef = await joinRequestsRef.add(joinRequestPayload);
        joinRequestData = { id: joinRequestDocRef.id, ...joinRequestPayload };
      }

      const membershipPayload: Record<string, any> = {
        tenantId: tenantSnap.id,
        userId: authContext.uid,
        email: userEmail.toLowerCase(),
        displayName,
        role,
        status: 'pending_request',
        joinedVia: 'join_code',
        joinCodeId: codeDoc.id,
        requestedAt: joinRequestData.requestedAt || nowIso,
        createdAt: existingCreatedAt,
        updatedAt: nowIso,
      };

      const pendingStatusEvent: Record<string, any> = {
        status: 'pending_request',
        at: nowIso,
        actorId: authContext.uid,
        actorEmail: userEmail.toLowerCase(),
        reason: 'join_code_claim',
      };
      if (displayName) {
        pendingStatusEvent.actorName = displayName;
      }

      if (!existingMembership) {
        membershipPayload.statusHistory = [pendingStatusEvent];
      } else if (existingMembership.status !== 'pending_request') {
        membershipPayload.statusHistory = admin.firestore.FieldValue.arrayUnion(pendingStatusEvent);
      }

      await membershipRef.set(membershipPayload, { merge: true });

      if (createdNewJoinRequest && !shouldAutoApprove) {
        void sendTenantJoinRequestNotificationImpl({
          tenantId: tenantSnap.id,
          tenantName: tenantData.name,
          requestId: joinRequestData.id,
          requesterEmail: userEmail.toLowerCase(),
          requesterName: displayName,
          message: message || undefined,
        }).catch((error) => console.warn('[tenant-join-code] join request notify failed', error));
      }

      const usageCap = typeof codeData.usageCap === 'number' ? codeData.usageCap : null;
      const updatedUsageCount = typeof codeData.usageCount === 'number' ? codeData.usageCount + 1 : 1;
      const codeUpdate: Record<string, any> = {
        usageCount: updatedUsageCount,
        lastUsedAt: nowIso,
      };
      if (usageCap != null && updatedUsageCount >= usageCap) {
        codeUpdate.status = 'revoked';
        codeUpdate.updatedAt = nowIso;
      }
      await codeDoc.ref.update(codeUpdate);

      const auditMetadata: Record<string, unknown> = {
        via: 'join_code',
        codeId: codeDoc.id,
      };
      if (message) {
        auditMetadata.message = message;
      }

      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantSnap.id,
          actorId: authContext.uid,
          actorEmail: userEmail,
          action: 'join_request_submitted',
          targetId: joinRequestData.id,
          targetType: 'joinRequest',
          metadata: auditMetadata,
          createdAt: nowIso,
        })
      );

      let membershipResponse = {
        id: membershipId,
        tenantId: tenantSnap.id,
        userId: authContext.uid,
        email: membershipPayload.email,
        displayName,
        role,
        status: 'pending_request',
        createdAt: existingCreatedAt,
        updatedAt: nowIso,
      };

      let joinRequestResponse = {
        id: joinRequestData.id,
        status: joinRequestData.status,
        requestedAt: toIsoTimestamp(joinRequestData.requestedAt) ?? nowIso,
        reviewedAt: toIsoTimestamp(joinRequestData.reviewedAt) ?? null,
        message: typeof joinRequestData.message === 'string' ? joinRequestData.message : null,
        expiresAt: toIsoTimestamp(joinRequestData.expiresAt) ?? null,
      };

      let pendingRequest = true;

      if (shouldAutoApprove) {
        const autoApprovedAt = new Date().toISOString();
        const desiredRole = REVIEWER_AUTO_APPROVE_ROLE;
        const actorId = 'system_reviewer_quick_join';
        const actorEmail = 'system@reviewer-quick-join.local';
        const reviewerName = REVIEWER_AUTO_APPROVE_ACTOR_NAME || 'Reviewer quick join';
        const normalizedTargetEmail = userEmail.toLowerCase();
        const needsSeat = desiredRole === 'admin' || desiredRole === 'staff';
        const needsSeatCheck = needsSeat && (!existingMembership || existingMembership.status !== 'active');

        if (needsSeatCheck) {
          try {
            await assertTenantStaffSeatAvailable(db, tenantSnap.id);
          } catch (error) {
            if (error instanceof TenantSeatLimitError) {
              return res.status(409).json({ error: 'seat_limit_reached', limit: error.limit });
            }
            throw error;
          }
        }

        const approvedStatusEvent: Record<string, any> = stripUndefinedDeep({
          status: 'active',
          at: autoApprovedAt,
          actorId,
          actorEmail,
          actorName: reviewerName,
          reason: 'join_code_auto_approved',
          initiatedFrom: 'system',
        });

        await db.runTransaction(async (tx) => {
          const freshRequestSnap = await tx.get(joinRequestDocRef);
          if (!freshRequestSnap.exists) {
            throw new TenantAccessError(404, { error: 'request_not_found' });
          }
          const freshRequest = freshRequestSnap.data() || {};
          if (freshRequest.status && freshRequest.status !== 'pending') {
            throw new TenantAccessError(409, { error: 'request_already_reviewed' });
          }

          const invitesQuery = db
            .collection('tenantInvites')
            .where('tenantId', '==', tenantSnap.id)
            .where('email', '==', normalizedTargetEmail)
            .where('status', '==', 'pending')
            .limit(50);
          const invitesSnap = await tx.get(invitesQuery);

          tx.set(
            membershipRef,
            {
              role: desiredRole,
              status: 'active',
              updatedAt: autoApprovedAt,
              statusHistory: admin.firestore.FieldValue.arrayUnion(approvedStatusEvent),
            },
            { merge: true },
          );
          tx.update(joinRequestDocRef, {
            status: 'approved',
            reviewedAt: autoApprovedAt,
            reviewedBy: actorId,
            assignedRole: desiredRole,
          });
          invitesSnap.docs.forEach((docSnap) => {
            tx.update(docSnap.ref, {
              status: 'accepted',
              acceptedAt: autoApprovedAt,
              acceptedBy: actorId,
              updatedAt: autoApprovedAt,
            });
          });
        });

        await db.collection('tenantAuditLogs').add(
          stripUndefinedDeep({
            tenantId: tenantSnap.id,
            actorId,
            actorEmail,
            action: 'join_request_reviewed',
            targetId: joinRequestData.id,
            targetType: 'joinRequest',
            metadata: { outcome: 'approved', role: desiredRole, via: 'reviewer_quick_join', codeId: codeDoc.id },
            createdAt: autoApprovedAt,
          }),
        );

        void sendTeamMembershipChangeNotificationImpl({
          tenantId: tenantSnap.id,
          tenantName: typeof tenantData.name === 'string' ? tenantData.name : undefined,
          action: existingMembership ? 'role_changed' : 'added',
          targetEmail: normalizedTargetEmail,
          targetRole: desiredRole,
          metadata: {
            displayName,
            reason: 'join_code_auto_approved',
            initiatedFrom: 'system',
            actorName: reviewerName,
          },
        }).catch((error) => console.warn('[tenant-join-code] auto-approve team notify failed', error));

        pendingRequest = false;
        membershipResponse = {
          ...membershipResponse,
          role: desiredRole,
          status: 'active',
          updatedAt: autoApprovedAt,
        };
        joinRequestResponse = {
          ...joinRequestResponse,
          status: 'approved',
          reviewedAt: autoApprovedAt,
        };
      }

      return res.json({
        ok: true,
        pendingRequest,
        tenant: {
          id: tenantSnap.id,
          name: tenantData.name,
          slug: tenantData.slug,
          status: tenantData.status,
          logoUrl: tenantData.logoUrl || tenantData.branding?.logoUrl || null,
          heroImageUrl: tenantData.heroImageUrl || tenantData.branding?.heroImageUrl || null,
          theme: tenantData.theme || null,
          branding: tenantData.branding || undefined,
          settings: tenantData.settings || undefined,
          defaultCurrency: tenantData.defaultCurrency,
          timezone: tenantData.timezone,
        },
        membership: membershipResponse,
        joinRequest: joinRequestResponse,
        code: {
          id: codeDoc.id,
          status:
            usageCap != null && updatedUsageCount >= usageCap ? 'revoked' : codeData.status || 'active',
          createdAt: toIsoTimestamp(codeData.createdAt) ?? null,
          expiresAt: toIsoTimestamp(codeData.expiresAt) ?? null,
          usageCount: updatedUsageCount,
          usageCap,
        },
      });
    } catch (error) {
      console.error('[tenant-join-code] claim failed', error);
      return res.status(500).json({ error: 'claim_failed' });
    }
  });

  app.post('/tenants/join-code/resolve', async (req, res) => {
    const authContext = req.authContext;
    if (!authContext || !authContext.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = tenantJoinCodeLookupSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const normalizedCode = normalizeTenantCode(parsed.data.code);
    if (!normalizedCode) {
      return res.status(400).json({ error: 'invalid_code' });
    }

    try {
      const db = getFirestoreImpl();
      const codeQuery = await db.collection('tenantCodes').where('code', '==', normalizedCode).limit(1).get();
      if (codeQuery.empty) {
        return res.status(404).json({ error: 'code_not_found' });
      }

      const codeDoc = codeQuery.docs[0];
      const codeData = codeDoc.data() as Record<string, any>;
      const tenantId = typeof codeData.tenantId === 'string' ? codeData.tenantId : '';
      if (!tenantId) {
        console.warn('[tenant-join-code] code missing tenantId', codeDoc.id);
        return res.status(404).json({ error: 'code_not_found' });
      }

      const nowMs = Date.now();
      const expiresMs = timestampToMillis(codeData.expiresAt);
      const isRevoked = (codeData.status || '').toLowerCase() === 'revoked';
      if (isRevoked) {
        return res.status(410).json({ error: 'code_revoked' });
      }
      if (typeof expiresMs === 'number' && expiresMs <= nowMs) {
        const patch = { status: 'expired', updatedAt: new Date().toISOString() };
        codeDoc.ref.update(stripUndefinedDeep(patch)).catch(() => undefined);
        return res.status(410).json({ error: 'code_expired' });
      }

      const tenantSnap = await db.collection('tenants').doc(tenantId).get();
      if (!tenantSnap.exists) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }

      const tenantData = tenantSnap.data() as Record<string, any>;
      const tenantStatus = (tenantData.status || 'active').toLowerCase();
      if (tenantStatus !== 'active') {
        return res.status(403).json({ error: 'tenant_unavailable', status: tenantStatus });
      }

      let membership: Record<string, any> | null = null;
      const membershipId = membershipDocId(tenantId, authContext.uid);
      const membershipSnap = await db.collection('tenantMemberships').doc(membershipId).get();
      if (membershipSnap.exists) {
        const membershipData = membershipSnap.data() as Record<string, any>;
        membership = {
          id: membershipSnap.id,
          role: membershipData.role,
          status: membershipData.status,
          createdAt: toIsoTimestamp(membershipData.createdAt) ?? null,
          updatedAt: toIsoTimestamp(membershipData.updatedAt) ?? null,
        };
      }

      const responseBody = {
        tenant: {
          id: tenantSnap.id,
          name: tenantData.name,
          slug: tenantData.slug,
          status: tenantData.status,
          logoUrl: tenantData.logoUrl || tenantData.branding?.logoUrl || null,
          heroImageUrl: tenantData.heroImageUrl || tenantData.branding?.heroImageUrl || null,
          theme: tenantData.theme || null,
          branding: tenantData.branding || undefined,
          settings: tenantData.settings || undefined,
          defaultCurrency: tenantData.defaultCurrency,
          timezone: tenantData.timezone,
        },
        code: {
          id: codeDoc.id,
          status: codeData.status || 'active',
          createdAt: toIsoTimestamp(codeData.createdAt) ?? null,
          expiresAt: toIsoTimestamp(codeData.expiresAt) ?? null,
          lastUsedAt: toIsoTimestamp(codeData.lastUsedAt) ?? null,
          usageCount: typeof codeData.usageCount === 'number' ? codeData.usageCount : 0,
          usageCap: typeof codeData.usageCap === 'number' ? codeData.usageCap : null,
        },
        membership,
      };

      return res.json(responseBody);
    } catch (error) {
      console.error('[tenant-join-code] lookup failed', error);
      return res.status(500).json({ error: 'lookup_failed' });
    }
  });

  app.patch('/chat/messages/:id', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const messageId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!messageId) {
      return res.status(400).json({ error: 'missing_message_id' });
    }

    const parsed = chatMessageEditSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const editorEmail = await resolveAuthenticatedEmail(authContext);
    const force = authContext.tokenType === 'master';

    try {
      const message = await editChatMessage({
        messageId,
        editorEmail: editorEmail || undefined,
        text: parsed.data.text,
        tenantId: tenantAccess.tenantId,
        force,
      });
      return res.json({ ok: true, message });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_messages_edit] failed', error);
      return res.status(500).json({ error: 'edit_failed' });
    }
  });

  app.post('/chat/receipts/sync', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = chatReceiptSyncSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    if (!actorEmail) {
      return res.status(400).json({ error: 'actor_email_unavailable' });
    }

    const normalizedPartner = normalizeEmail(parsed.data.partnerEmail);
    if (!normalizedPartner) {
      return res.status(400).json({ error: 'invalid_partner' });
    }

    const partnerIsMember = await isTenantEmailActiveMemberImpl(tenantAccess.tenantId, normalizedPartner);
    if (!partnerIsMember) {
      return res.status(403).json({ error: 'partner_not_in_tenant' });
    }

    try {
      const result = await syncChatConversationReceiptsImpl({
        tenantId: tenantAccess.tenantId,
        actorEmail,
        partnerEmail: normalizedPartner,
        deliveredMessageIds: parsed.data.deliveredMessageIds,
        readMessageIds: parsed.data.readMessageIds,
        markConversationDelivered: parsed.data.markConversationDelivered,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_receipts_sync] failed', error);
      return res.status(500).json({ error: 'receipt_sync_failed' });
    }
  });

  app.post('/chat/receipts/outbound-delivered', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = chatOutboundDeliverySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    if (!actorEmail) {
      return res.status(400).json({ error: 'actor_email_unavailable' });
    }

    const normalizedPartner = normalizeEmail(parsed.data.partnerEmail);
    if (!normalizedPartner) {
      return res.status(400).json({ error: 'invalid_partner' });
    }

    const partnerIsMember = await isTenantEmailActiveMemberImpl(tenantAccess.tenantId, normalizedPartner);
    if (!partnerIsMember) {
      return res.status(403).json({ error: 'partner_not_in_tenant' });
    }

    try {
      const result = await confirmOutboundChatDeliveryImpl({
        tenantId: tenantAccess.tenantId,
        actorEmail,
        partnerEmail: normalizedPartner,
        deliveredMessageIds: parsed.data.deliveredMessageIds,
        provenance: parsed.data.provenance,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_receipts_outbound_delivered] failed', error);
      return res.status(500).json({ error: 'outbound_delivery_confirmation_failed' });
    }
  });

  // Mark a whole conversation read on behalf of the authenticated reader
  // (chat-production-hardening, finding P0-1 — Model A: backend is the only
  // writer). The reader is bound to the token via resolveAuthenticatedEmail, so a
  // caller can only ever mark THEIR OWN incoming messages read — a forged actor
  // is impossible. Tenant membership of both the actor and the partner is
  // enforced before any write.
  app.post('/chat/conversations/read', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = chatConversationReadSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    if (!actorEmail) {
      return res.status(400).json({ error: 'actor_email_unavailable' });
    }

    const normalizedPartner = normalizeEmail(parsed.data.partnerEmail);
    if (!normalizedPartner) {
      return res.status(400).json({ error: 'invalid_partner' });
    }

    const partnerIsMember = await isTenantEmailActiveMemberImpl(tenantAccess.tenantId, normalizedPartner);
    if (!partnerIsMember) {
      return res.status(403).json({ error: 'partner_not_in_tenant' });
    }

    try {
      const result = await markChatConversationReadImpl({
        tenantId: tenantAccess.tenantId,
        actorEmail,
        partnerEmail: normalizedPartner,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_conversations_read] failed', error);
      return res.status(500).json({ error: 'mark_conversation_read_failed' });
    }
  });

  // Reconcile the authenticated user's stored unread counters against the true
  // unread set and clean up any stuck self-conversation nodes
  // (chat-production-hardening, finding P0-1 — Model A). The user is bound to the
  // token, so a caller can only reconcile THEIR OWN counters.
  app.post('/chat/unread/reconcile', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = chatUnreadReconcileSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    if (!actorEmail) {
      return res.status(400).json({ error: 'actor_email_unavailable' });
    }

    try {
      const result = await reconcileChatUnreadForUserImpl({
        tenantId: tenantAccess.tenantId,
        actorEmail,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_unread_reconcile] failed', error);
      return res.status(500).json({ error: 'unread_reconcile_failed' });
    }
  });

  // Reconstruct the authenticated user's conversation summaries server-side
  // (chat-production-hardening, finding P0-1 — Model A). This replaces the
  // client's former direct RTDB rebuild, which now fails under the `.write:false`
  // lockdown. The user is bound to the token via resolveAuthenticatedEmail, so a
  // caller can only ever rebuild THEIR OWN summaries — a forged actor is
  // impossible.
  app.post('/chat/summaries/rebuild', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = chatSummariesRebuildSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    if (!actorEmail) {
      return res.status(400).json({ error: 'actor_email_unavailable' });
    }

    try {
      const result = await rebuildChatSummariesForUserImpl({
        tenantId: tenantAccess.tenantId,
        actorEmail,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_summaries_rebuild] failed', error);
      return res.status(500).json({ error: 'summaries_rebuild_failed' });
    }
  });

  app.post('/chat/messages/:id/reactions', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const messageId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!messageId) {
      return res.status(400).json({ error: 'missing_message_id' });
    }

    const parsed = chatMessageReactionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    if (!actorEmail) {
      return res.status(400).json({ error: 'actor_email_unavailable' });
    }

    try {
      const result = await toggleChatMessageReaction({
        messageId,
        tenantId: tenantAccess.tenantId,
        actorEmail,
        reactionType: parsed.data.reactionType,
      });

      return res.json({ ok: true, updatedUsers: result.updatedUsers, reactions: result.reactions });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_messages_reactions] failed', error);
      return res.status(500).json({ error: 'reaction_failed' });
    }
  });

  app.delete('/chat/messages/:id', requireMemberTenantAccessFromQuery, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const messageId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!messageId) {
      return res.status(400).json({ error: 'missing_message_id' });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const requesterEmail = await resolveAuthenticatedEmail(authContext);
    const force = authContext.tokenType === 'master';

    try {
      const message = await deleteChatMessage({
        messageId,
        requesterEmail: requesterEmail || undefined,
        tenantId: tenantAccess.tenantId,
        force,
      });
      return res.json({ ok: true, message });
    } catch (error) {
      if (error instanceof ChatMessageActionError) {
        const status = statusForChatActionError(error);
        return res.status(status).json({
          error: error.code,
          message: error.message,
          details: error.details || undefined,
        });
      }
      console.error('[chat_messages_delete] failed', error);
      return res.status(500).json({ error: 'delete_failed' });
    }
  });

  // ----- Webhooks (unchanged logic) -----
  app.get('/webhooks/whatsapp', (req,res)=>{ const mode=req.query['hub.mode']; const token=req.query['hub.verify_token']; const challenge=req.query['hub.challenge']; if(mode==='subscribe' && token===process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge); return res.sendStatus(403); });
  app.post('/webhooks/whatsapp', express.raw({type:'application/json'}),(req,res)=>{ try { const raw=req.body instanceof Buffer? req.body.toString('utf8') : (req as any).rawBody||''; if(process.env.META_APP_SECRET){ const sig=req.headers['x-hub-signature-256'] as string|undefined; if(!verifySignature(raw,sig)) return res.sendStatus(401);} let body:any={}; try{ body=JSON.parse(raw);}catch{} const statuses=extractStatuses(body); statuses.forEach(s=>{ const jobId=findJobByMessageId(s.id); if(jobId){ inc(metricNames.messageStatus,{status:s.status}); }}); return res.sendStatus(200);} catch { return res.sendStatus(200);} });

  /* c8 ignore start - webhook helper branches */
  function verifySignature(raw:string,sig?:string){ if(!sig) return false; try { const h=crypto.createHmac('sha256', process.env.META_APP_SECRET!); h.update(raw); const expected='sha256='+h.digest('hex'); return timingSafeEq(expected,sig);} catch { return false; } }
  function timingSafeEq(a:string,b:string){ const A=Buffer.from(a); const B=Buffer.from(b); if(A.length!==B.length) return false; return crypto.timingSafeEqual(A,B);}    
  function extractStatuses(body:any){ const out:{id:string;status:string}[]=[]; const entries=body?.entry||[]; entries.forEach((e:any)=> e.changes?.forEach((c:any)=>{ c.value?.statuses?.forEach((st:any)=>{ if(st.id&&st.status) out.push({id:st.id,status:st.status}); }); })); return out; }
  /* c8 ignore stop */

  // ----- Reminder quota reservation (batch, all-or-nothing) -----
  app.post('/reminders/quota/reserve-batch', requireStaffTenantAccess, async (req, res) => {
    const parsed = reminderQuotaReserveSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const adminDb = getFirestoreImpl();
      const policy = await getEffectiveReminderChannelPolicy(adminDb, normalizedTenantId);
      const disabled = computeDisabledReminderChannels(policy.enabled, parsed.data.counts as any);
      if (disabled.length) {
        return res.status(400).json({
          error: 'reminder_channels_disabled',
          disabled,
          message: 'One or more reminder channels are disabled.',
          channelMessages: policy.messages,
        });
      }
    } catch (error) {
      console.warn('[reminders_quota_reserve_batch] channel gate check failed', error);
    }

    try {
      const result = await reserveTenantReminderQuotaForBatch(
        getFirestoreImpl(),
        normalizedTenantId,
        parsed.data.batchId,
        parsed.data.counts
      );
      return res.json({ ok: true, monthId: result.monthId, reserved: result.reserved, batchId: parsed.data.batchId });
    } catch (error) {
      if (error instanceof TenantReminderBatchLimitError) {
        const remaining = Math.max(0, error.limit - error.used);
        return res.status(409).json({
          error: 'reminder_limit_reached',
          channel: error.channel,
          limit: error.limit,
          used: error.used,
          requested: error.requested,
          remaining,
        });
      }
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.warn('[reminders_quota_reserve_batch] failed', error);
      return res.status(503).json({ error: 'reminder_quota_reserve_failed' });
    }
  });

  function normalizeBaseUrl(raw?: string | null): string | null {
    if (!raw) {
      return null;
    }
    const trimmed = raw.trim().replace(/\/$/, '');
    return trimmed.length ? trimmed : null;
  }

  async function getEmailBackendConfigForReminderSends(): Promise<{ url: string; headers: Record<string, string> } | null> {
    if (isTestProcess) {
      return null;
    }

    const remoteBase = await getEmailBackendBaseUrl();
    const base =
      normalizeBaseUrl(remoteBase) ||
      normalizeBaseUrl(process.env.EMAIL_BACKEND_BASE_URL) ||
      normalizeBaseUrl(process.env.EXPO_PUBLIC_EMAIL_API_BASE_URL);
    if (!base) {
      return null;
    }

    const internalKey = process.env.EMAIL_BACKEND_INTERNAL_KEY || process.env.INTERNAL_API_KEY;
    const bearerToken = process.env.EMAIL_BACKEND_BEARER;
    if (!internalKey && !bearerToken) {
      return null;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (internalKey) {
      headers['x-internal-key'] = internalKey;
    }
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }

    return {
      url: `${base}/email/send-template`,
      headers,
    };
  }

  const coerceToAdminTimestamp = (raw: any): admin.firestore.Timestamp | null => {
    if (!raw) return null;
    if (raw instanceof admin.firestore.Timestamp) return raw;
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return admin.firestore.Timestamp.fromMillis(ms);
      return null;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const ms = raw > 1e12 ? raw : raw * 1000;
      return admin.firestore.Timestamp.fromMillis(ms);
    }
    if (typeof raw === 'object') {
      const seconds = (raw as any).seconds;
      const nanoseconds = (raw as any).nanoseconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        const ns = typeof nanoseconds === 'number' && Number.isFinite(nanoseconds) ? nanoseconds : 0;
        return new admin.firestore.Timestamp(seconds, ns);
      }
    }
    return null;
  };

  async function upsertReminderHistoryWithDates(
    db: admin.firestore.Firestore,
    historyId: string,
    data: Record<string, any>
  ): Promise<void> {
    const trimmed = (historyId || '').trim();
    if (!trimmed) return;
    const ref = db.collection('reminderHistory').doc(trimmed);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? snap.data() || {} : null;
      // L13: never overwrite a reminderHistory doc owned by a DIFFERENT tenant. The
      // incoming write always carries the caller's tenantId in `data`; a client that
      // supplies a historyId pointing at another tenant's doc must not be able to
      // clobber it (or hijack it by rewriting tenantId).
      const existingTenantId = existing && typeof (existing as any).tenantId === 'string' ? (existing as any).tenantId : '';
      const incomingTenantId = typeof (data as any)?.tenantId === 'string' ? (data as any).tenantId : '';
      if (existing && existingTenantId && incomingTenantId && existingTenantId !== incomingTenantId) {
        return;
      }
      const existingCreatedAt = existing ? (existing as any).createdAt : null;

      let createdAtWrite: any = undefined;
      if (!snap.exists) {
        createdAtWrite = admin.firestore.FieldValue.serverTimestamp();
      } else if (!(existingCreatedAt instanceof admin.firestore.Timestamp)) {
        createdAtWrite = coerceToAdminTimestamp(existingCreatedAt) || admin.firestore.FieldValue.serverTimestamp();
      }

      tx.set(
        ref,
        stripUndefinedDeep({
          ...data,
          ...(createdAtWrite ? { createdAt: createdAtWrite } : {}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
        { merge: true }
      );
    });
  }

  app.get('/reminders/history/status', requireStaffTenantAccessFromQuery, async (req, res) => {
    const parsed = reminderHistoryStatusQuerySchema.safeParse({
      tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
      historyIds: req.query.historyIds,
    });
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const rawIds = parsed.data.historyIds;
    const splitIds = (value: string) =>
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const historyIds = (Array.isArray(rawIds) ? rawIds.flatMap(splitIds) : splitIds(rawIds)).slice(0, 1000);
    if (!historyIds.length) {
      return res.status(400).json({ error: 'validation_failed', issues: [{ message: 'historyIds required' }] });
    }

    const db = getFirestoreImpl();
    const refs = historyIds.map((id) => db.collection('reminderHistory').doc(id));

    const deriveStatusFromHistory = (historyData: any): 'pending' | 'queued' | 'success' | 'failed' => {
      const st = typeof historyData?.status === 'string' ? historyData.status : 'pending';
      if (st === 'success') return 'success';
      if (st === 'failed') return 'failed';
      const delivery = historyData?.metadata?.deliveryStatus;
      if (delivery === 'queued') return 'queued';
      return 'pending';
    };

    try {
      const snaps = await db.getAll(...refs);
      const results = snaps.map((snap, idx) => {
        const historyId = historyIds[idx];
        if (!snap.exists) {
          return {
            historyId,
            status: 'pending' as const,
            message: 'Not found yet',
          };
        }
        const data = snap.data() || {};
        const status = deriveStatusFromHistory(data);
        const message =
          typeof (data as any)?.errorMessage === 'string'
            ? (data as any).errorMessage
            : status === 'success'
              ? 'Sent successfully'
              : status === 'queued'
                ? 'Queued for send'
                : status === 'failed'
                  ? 'Failed to send'
                  : 'Pending';
        return {
          historyId,
          status,
          message,
        };
      });

      return res.json({ results });
    } catch (error) {
      console.warn('[reminders_history_status] failed', error);
      return res.status(503).json({ error: 'status_lookup_failed' });
    }
  });

  app.post('/reminders/batch/send', rateLimitMiddleware({ windowMs: 60_000, max: 60 }), requireStaffTenantAccess, async (req, res) => {
    const parsed = reminderBatchSendSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const batchId = parsed.data.batchId;
    const items = parsed.data.items;
    const actorUid = req.authContext?.uid;

    const counts: Partial<Record<ReminderChannel, number>> = { email: 0, sms: 0, whatsapp: 0, voice: 0 };
    for (const item of items) {
      if (item.type === 'sms') counts.sms = (counts.sms || 0) + 1;
      if (item.type === 'voice') counts.voice = (counts.voice || 0) + 1;
      if (item.type === 'whatsapp') counts.whatsapp = (counts.whatsapp || 0) + 1;
      if (item.type === 'email') counts.email = (counts.email || 0) + 1;
    }

    try {
      const policy = await getEffectiveReminderChannelPolicy(getFirestoreImpl(), normalizedTenantId);
      const disabled = computeDisabledReminderChannels(policy.enabled, counts as any);
      if (disabled.length) {
        return res.status(400).json({
          error: 'reminder_channels_disabled',
          disabled,
          message: 'One or more reminder channels are disabled.',
          channelMessages: policy.messages,
        });
      }
    } catch (error) {
      console.warn('[reminders_batch_send] channel gate check failed', error);
    }

    let monthId = normalizeMonthId(null);
    try {
      const result = await reserveTenantReminderQuotaForBatch(getFirestoreImpl(), normalizedTenantId, batchId, counts);
      monthId = result.monthId;
    } catch (error) {
      if (error instanceof TenantReminderBatchLimitError) {
        const remaining = Math.max(0, error.limit - error.used);
        return res.status(409).json({
          error: 'reminder_limit_reached',
          channel: error.channel,
          limit: error.limit,
          used: error.used,
          requested: error.requested,
          remaining,
        });
      }
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.warn('[reminders_batch_send] quota reserve failed', error);
      return res.status(503).json({ error: 'reminder_quota_reserve_failed' });
    }

    const db = getFirestoreImpl();
    const emailBackend = await getEmailBackendConfigForReminderSends();
    const results: Array<{
      studentId: string;
      type: 'email' | 'sms' | 'whatsapp' | 'voice';
      status: 'pending' | 'queued' | 'success' | 'failed' | 'skipped';
      message?: string;
      jobId?: string;
    }> = [];

    const deriveStatusFromHistory = (historyData: any): 'pending' | 'queued' | 'success' | 'failed' => {
      const st = typeof historyData?.status === 'string' ? historyData.status : 'pending';
      if (st === 'success') return 'success';
      if (st === 'failed') return 'failed';
      const delivery = historyData?.metadata?.deliveryStatus;
      if (delivery === 'queued') return 'queued';
      return 'pending';
    };

    // PERF (P11): process items with bounded concurrency instead of a strictly
    // serial loop. Each item's quota-token/history/idempotency logic is unchanged;
    // only the outer iteration overlaps the (network-bound) SMS/voice/email sends
    // and WhatsApp enqueues. Results are still keyed by studentId+type on the
    // client, so completion order is irrelevant. Concurrency is kept modest so the
    // per-batch reservation-token transactions don't contend excessively.
    const REMINDER_BATCH_SEND_CONCURRENCY = 5;
    const processItem = async (item: (typeof items)[number]): Promise<void> => {
      const studentId = item.studentId;
      const historyId = typeof (item as any).historyId === 'string' ? String((item as any).historyId).trim() : '';
      const rawHistory = (item as any).history;
      const history = rawHistory && typeof rawHistory === 'object' ? (rawHistory as any) : undefined;
      const historyWithActor = history
        ? stripUndefinedDeep({ ...history, userId: (history as any)?.userId || actorUid })
        : actorUid
          ? ({ userId: actorUid } as any)
          : undefined;
      let quotaTokenConsumed = false;
      let quotaFinalized = false;

      const finalizeConsumedQuotaAsFailed = async (errorMessage: string) => {
        if (!historyId || !quotaTokenConsumed || quotaFinalized) {
          return;
        }
        try {
          await upsertReminderHistoryWithDates(db, historyId, {
            ...(historyWithActor || {}),
            tenantId: normalizedTenantId,
            reminderType: item.type,
            status: 'failed',
            metadata: { deliveryStatus: 'failed' },
            errorMessage,
          });
        } catch (e) {
          console.warn('[reminders_batch_send] reminderHistory failed during quota finalization fallback', e);
        }

        try {
          await finalizeReminderQuotaFromHistory(db, {
            historyId,
            finalStatus: 'failed',
            fallbackTenantId: normalizedTenantId,
            fallbackChannel: item.type,
            fallbackMonthId: monthId,
          });
          quotaFinalized = true;
        } catch (e) {
          console.warn('[reminders_batch_send] quota finalize fallback failed', e);
        }
      };

      try {
        if (historyId) {
          const existing = await db.collection('reminderHistory').doc(historyId).get();
          if (existing.exists) {
            // This item already has history (idempotent retry path); release one reserved token
            // if still present so active reservations don't stay inflated until expiry.
            try {
              await releaseTenantReminderReservationTokenIfAvailable(db, normalizedTenantId, batchId, item.type);
            } catch (e) {
              console.warn('[reminders_batch_send] reservation release failed for existing history', e);
            }
            const st = deriveStatusFromHistory(existing.data() || {});
            results.push({ studentId, type: item.type, status: st });
            return;
          }
        }

        if (item.type === 'sms') {
          await consumeTenantReminderReservationToken(db, normalizedTenantId, batchId, 'sms', {
            historyId: historyId || undefined,
            history: historyWithActor || undefined,
          });
          quotaTokenConsumed = true;

          const sendResult = await sendSMSImpl({ to: item.to, message: item.message });
          if (historyId) {
            try {
              await upsertReminderHistoryWithDates(db, historyId, {
                ...(historyWithActor || {}),
                tenantId: normalizedTenantId,
                reminderType: 'sms',
                status: sendResult.success ? 'success' : 'failed',
                message: item.message,
                metadata: {
                  deliveryStatus: sendResult.success ? 'sent' : 'failed',
                  twilioSid: sendResult.success ? sendResult.sid : undefined,
                },
                errorMessage: sendResult.success ? undefined : (sendResult as any)?.error || 'send_failed',
              });
            } catch (e) {
              console.warn('[reminders_batch_send] sms reminderHistory update failed', e);
            }

            try {
              await finalizeReminderQuotaFromHistory(db, {
                historyId,
                finalStatus: sendResult.success ? 'success' : 'failed',
                fallbackTenantId: normalizedTenantId,
                fallbackChannel: 'sms',
                fallbackMonthId: monthId,
              });
              quotaFinalized = true;
            } catch (e) {
              console.warn('[reminders_batch_send] sms quota finalize failed', e);
            }
          }

          results.push({
            studentId,
            type: 'sms',
            status: sendResult.success ? 'success' : 'failed',
            message: sendResult.success ? 'Sent successfully' : (sendResult as any)?.error || 'send_failed',
          });
          return;
        }

        if (item.type === 'voice') {
          await consumeTenantReminderReservationToken(db, normalizedTenantId, batchId, 'voice', {
            historyId: historyId || undefined,
            history: historyWithActor || undefined,
          });
          quotaTokenConsumed = true;

          const sendResult = await sendVoiceCallImpl({
            to: item.to,
            message: item.message,
            language: item.language,
            voice: item.voice,
            hindiVoice: item.hindiVoice,
            englishVoice: item.englishVoice,
            pauseSeconds: item.pauseSeconds,
          });

          if (historyId) {
            try {
              await upsertReminderHistoryWithDates(db, historyId, {
                ...(historyWithActor || {}),
                tenantId: normalizedTenantId,
                reminderType: 'voice',
                status: sendResult.success ? 'success' : 'failed',
                message: item.message,
                metadata: {
                  deliveryStatus: sendResult.success ? 'sent' : 'failed',
                  twilioSid: sendResult.success ? sendResult.sid : undefined,
                },
                errorMessage: sendResult.success ? undefined : (sendResult as any)?.error || 'send_failed',
              });
            } catch (e) {
              console.warn('[reminders_batch_send] voice reminderHistory update failed', e);
            }

            try {
              await finalizeReminderQuotaFromHistory(db, {
                historyId,
                finalStatus: sendResult.success ? 'success' : 'failed',
                fallbackTenantId: normalizedTenantId,
                fallbackChannel: 'voice',
                fallbackMonthId: monthId,
              });
              quotaFinalized = true;
            } catch (e) {
              console.warn('[reminders_batch_send] voice quota finalize failed', e);
            }
          }

          results.push({
            studentId,
            type: 'voice',
            status: sendResult.success ? 'success' : 'failed',
            message: sendResult.success ? 'Sent successfully' : (sendResult as any)?.error || 'send_failed',
          });
          return;
        }

        if (item.type === 'whatsapp') {
          await consumeTenantReminderReservationToken(db, normalizedTenantId, batchId, 'whatsapp', {
            historyId: historyId || undefined,
            history: historyWithActor || undefined,
          });
          quotaTokenConsumed = true;

          let jobId = '';
          if (item.kind === 'fee') {
            if (!item.studentName || typeof item.amount !== 'number' || !item.dueDate) {
              await finalizeConsumedQuotaAsFailed('missing_fields');
              results.push({ studentId, type: 'whatsapp', status: 'failed', message: 'missing_fields' });
              return;
            }
            jobId = enqueueReminderImpl({
              tenantId: normalizedTenantId,
              to: item.to,
              parentName: item.parentName,
              studentName: item.studentName,
              amount: item.amount,
              dueDate: item.dueDate,
              greeting: item.greeting,
              customNotes: item.customNotes,
              customNotesEnglish: item.customNotesEnglish,
              customNotesHindi: item.customNotesHindi,
              teacherName: item.teacherName,
              coachingName: item.coachingName,
              selectedLanguage: item.selectedLanguage,
              languageOrder: item.languageOrder,
              historyId: historyId || undefined,
              history: historyWithActor || undefined,
            } as any);
          } else {
            if (!item.message) {
              await finalizeConsumedQuotaAsFailed('missing_fields');
              results.push({ studentId, type: 'whatsapp', status: 'failed', message: 'missing_fields' });
              return;
            }
            jobId = enqueueCustomMessageImpl({
              tenantId: normalizedTenantId,
              to: item.to,
              message: item.message,
              englishMessage: item.englishMessage,
              hindiMessage: item.hindiMessage,
              teacherName: item.teacherName,
              coachingName: item.coachingName,
              selectedLanguage: item.selectedLanguage,
              languageOrder: item.languageOrder,
              historyId: historyId || undefined,
              history: historyWithActor || undefined,
            } as any);
          }

          if (historyId) {
            try {
              await db
                .collection('reminderHistory')
                .doc(historyId)
                .set(
                  stripUndefinedDeep({
                    ...(historyWithActor || {}),
                    tenantId: normalizedTenantId,
                    reminderType: 'whatsapp',
                    status: 'pending',
                    metadata: { messageId: jobId, deliveryStatus: 'queued' },
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  }),
                  { merge: true }
                );
            } catch (e) {
              console.warn('[reminders_batch_send] whatsapp reminderHistory update failed', e);
            }
          }

          void logTenantAuditEventImpl({
            tenantId: normalizedTenantId,
            action: 'reminder_queued',
            authContext: req.authContext,
            targetId: jobId,
            metadata: {
              channel: item.kind === 'fee' ? 'whatsapp_fee' : 'whatsapp_custom',
              destination: item.to,
            },
          });

          results.push({ studentId, type: 'whatsapp', status: 'queued', jobId, message: 'Queued for send' });
          return;
        }

        if (item.type === 'email') {
          if (!emailBackend) {
            if (historyId) {
              try {
                await upsertReminderHistoryWithDates(db, historyId, {
                  ...(historyWithActor || {}),
                  tenantId: normalizedTenantId,
                  reminderType: 'email',
                  status: 'failed',
                  errorMessage: 'email_backend_not_configured',
                });
              } catch (e) {
                console.warn('[reminders_batch_send] email reminderHistory update failed (no backend)', e);
              }
            }
            results.push({ studentId, type: 'email', status: 'failed', message: 'email_backend_not_configured' });
            return;
          }

          // Create history entry + consume quota token before attempting send.
          await consumeTenantReminderReservationToken(db, normalizedTenantId, batchId, 'email', {
            historyId: historyId || undefined,
            history: historyWithActor || undefined,
          });
          quotaTokenConsumed = true;

          const payload = {
            ...item.email,
            tenant_id: normalizedTenantId,
            historyId: historyId || undefined,
          };

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12_000);
          let emailResp: any;
          try {
            const response = await fetchImpl(emailBackend.url, {
              method: 'POST',
              signal: controller.signal,
              headers: {
                ...emailBackend.headers,
                'x-tenant': normalizedTenantId,
              },
              body: JSON.stringify(payload),
            });
            const text = await response.text();
            try {
              emailResp = text ? JSON.parse(text) : null;
            } catch {
              emailResp = { text };
            }

            if (response.ok) {
              if (historyId) {
                try {
                  await upsertReminderHistoryWithDates(db, historyId, {
                    ...(historyWithActor || {}),
                    tenantId: normalizedTenantId,
                    reminderType: 'email',
                    status: response.status === 202 ? 'queued' : 'success',
                    metadata: {
                      emailId: (emailResp as any)?.id || (emailResp as any)?.emailId || undefined,
                      deliveryStatus: response.status === 202 ? 'queued' : 'sent',
                    },
                  });
                } catch (e) {
                  console.warn('[reminders_batch_send] email reminderHistory update failed', e);
                }

                // For 202 (queued), keep in-flight until /internal/reminder-history/email-result finalizes.
                if (response.status !== 202) {
                  try {
                    await finalizeReminderQuotaFromHistory(db, {
                      historyId,
                      finalStatus: 'success',
                      fallbackTenantId: normalizedTenantId,
                      fallbackChannel: 'email',
                      fallbackMonthId: monthId,
                    });
                    quotaFinalized = true;
                  } catch (e) {
                    console.warn('[reminders_batch_send] email quota finalize failed', e);
                  }
                }
              }
              results.push({
                studentId,
                type: 'email',
                status: response.status === 202 ? 'queued' : 'success',
                message: response.status === 202 ? 'Queued for send' : 'Sent successfully',
              });
            } else {
              if (historyId) {
                try {
                  await upsertReminderHistoryWithDates(db, historyId, {
                    ...(historyWithActor || {}),
                    tenantId: normalizedTenantId,
                    reminderType: 'email',
                    status: 'failed',
                    metadata: { deliveryStatus: 'failed' },
                    errorMessage:
                      typeof (emailResp as any)?.error === 'string' ? (emailResp as any).error : `email_failed_${response.status}`,
                  });
                } catch (e) {
                  console.warn('[reminders_batch_send] email reminderHistory update failed', e);
                }

                try {
                  await finalizeReminderQuotaFromHistory(db, {
                    historyId,
                    finalStatus: 'failed',
                    fallbackTenantId: normalizedTenantId,
                    fallbackChannel: 'email',
                    fallbackMonthId: monthId,
                  });
                  quotaFinalized = true;
                } catch (e) {
                  console.warn('[reminders_batch_send] email quota finalize failed (non-2xx)', e);
                }
              }
              results.push({
                studentId,
                type: 'email',
                status: 'failed',
                message: typeof emailResp?.error === 'string' ? emailResp.error : `email_failed_${response.status}`,
              });
            }
          } catch (error) {
            if (historyId) {
              try {
                await upsertReminderHistoryWithDates(db, historyId, {
                  ...(historyWithActor || {}),
                  tenantId: normalizedTenantId,
                  reminderType: 'email',
                  status: 'failed',
                  metadata: { deliveryStatus: 'failed' },
                  errorMessage: 'email_send_failed',
                });
              } catch (e) {
                console.warn('[reminders_batch_send] email reminderHistory update failed (send error)', e);
              }

              try {
                await finalizeReminderQuotaFromHistory(db, {
                  historyId,
                  finalStatus: 'failed',
                  fallbackTenantId: normalizedTenantId,
                  fallbackChannel: 'email',
                  fallbackMonthId: monthId,
                });
                quotaFinalized = true;
              } catch (e) {
                console.warn('[reminders_batch_send] email quota finalize failed (send error)', e);
              }
            }
            results.push({ studentId, type: 'email', status: 'failed', message: 'email_send_failed' });
          } finally {
            clearTimeout(timeout);
          }
          return;
        }

        results.push({ studentId, type: (item as any).type, status: 'failed', message: 'unsupported_type' });
        return;
      } catch (error) {
        await finalizeConsumedQuotaAsFailed('send_failed');
        if (error instanceof TenantAccessError) {
          results.push({
            studentId,
            type: item.type,
            status: 'failed',
            message: typeof (error.body as any)?.error === 'string' ? (error.body as any).error : 'tenant_access_error',
          });
          return;
        }
        console.warn('[reminders_batch_send] item failed', { type: (item as any)?.type, studentId }, error);
        results.push({ studentId, type: item.type, status: 'failed', message: 'send_failed' });
      }
    };

    await mapWithConcurrency(items, REMINDER_BATCH_SEND_CONCURRENCY, processItem);

    return res.json({ ok: true, tenantId: normalizedTenantId, batchId, monthId, results });
  });

  // ----- WhatsApp queue endpoints (light validation) -----
  app.post('/whatsapp/queue/fee-reminder', rateLimitMiddleware({ windowMs: 60_000, max: 600 }), requireStaffTenantAccess, async (req,res)=>{
    const { to, studentName, amount, dueDate, tenantId, quotaBatchId, historyId, history } = req.body||{};
    if(!to||!studentName||typeof amount!=='number'||!dueDate||typeof tenantId!=='string') {
      return res.status(400).json({error:'missing_fields'});
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const normalizedTenantId = tenantAccess.tenantId;
    const actorUid = req.authContext?.uid;
    const historyWithActor = history && typeof history === 'object'
      ? stripUndefinedDeep({ ...(history as any), userId: (history as any)?.userId || actorUid })
      : actorUid
        ? ({ userId: actorUid } as any)
        : undefined;
    const providedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    try {
      if (typeof quotaBatchId === 'string' && quotaBatchId.trim()) {
        await consumeTenantReminderReservationToken(getFirestoreImpl(), normalizedTenantId, quotaBatchId.trim(), 'whatsapp', {
          historyId: typeof historyId === 'string' ? historyId : undefined,
          history: historyWithActor || undefined,
        });
      } else {
        await assertTenantReminderQuotaAvailable(getFirestoreImpl(), normalizedTenantId, 'whatsapp', 1, {
          historyId: typeof historyId === 'string' ? historyId : undefined,
          history: historyWithActor || undefined,
        });
      }
    } catch (error) {
      if (error instanceof TenantReminderLimitError) {
        return res.status(409).json({ error: 'reminder_limit_reached', limit: error.limit, used: error.used, channel: error.channel });
      }
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.warn('[whatsapp_queue_fee] reminder quota check failed', error);
      const isTestMode = process.env.TEST_MODE === '1' || process.argv.includes('--test');
      if (!isTestMode) {
        return res.status(503).json({ error: 'reminder_quota_check_failed' });
      }
    }
    const id = enqueueReminderImpl({ ...req.body, tenantId: normalizedTenantId });

    if (typeof historyId === 'string' && historyId.trim()) {
      try {
        await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId.trim(), {
          ...(historyWithActor || {}),
          tenantId: normalizedTenantId,
          reminderType: 'whatsapp',
          status: 'pending',
          metadata: { messageId: id, deliveryStatus: 'queued' },
        });
      } catch (e) {
        console.warn('[whatsapp_queue_fee] reminderHistory update failed', e);
      }
    }
    void logTenantAuditEventImpl({
      tenantId: normalizedTenantId,
      action: 'reminder_queued',
      authContext: req.authContext,
      targetId: id,
      metadata: {
        channel: 'whatsapp_fee',
        destination: to,
        studentName,
        amount,
        dueDate,
      },
    });
    res.json({jobId:id});
  });

  app.post('/whatsapp/queue/custom-message', rateLimitMiddleware({ windowMs: 60_000, max: 600 }), requireStaffTenantAccess, async (req,res)=>{
    const { to, message, tenantId, quotaBatchId, historyId, history } = req.body||{};
    if(!to||!message||typeof tenantId!=='string') {
      return res.status(400).json({error:'missing_fields'});
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const normalizedTenantId = tenantAccess.tenantId;
    const actorUid = req.authContext?.uid;
    const historyWithActor = history && typeof history === 'object'
      ? stripUndefinedDeep({ ...(history as any), userId: (history as any)?.userId || actorUid })
      : actorUid
        ? ({ userId: actorUid } as any)
        : undefined;
    const providedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    try {
      if (typeof quotaBatchId === 'string' && quotaBatchId.trim()) {
        await consumeTenantReminderReservationToken(getFirestoreImpl(), normalizedTenantId, quotaBatchId.trim(), 'whatsapp', {
          historyId: typeof historyId === 'string' ? historyId : undefined,
          history: historyWithActor || undefined,
        });
      } else {
        await assertTenantReminderQuotaAvailable(getFirestoreImpl(), normalizedTenantId, 'whatsapp', 1, {
          historyId: typeof historyId === 'string' ? historyId : undefined,
          history: historyWithActor || undefined,
        });
      }
    } catch (error) {
      if (error instanceof TenantReminderLimitError) {
        return res.status(409).json({ error: 'reminder_limit_reached', limit: error.limit, used: error.used, channel: error.channel });
      }
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.warn('[whatsapp_queue_custom] reminder quota check failed', error);
      const isTestMode = process.env.TEST_MODE === '1' || process.argv.includes('--test');
      if (!isTestMode) {
        return res.status(503).json({ error: 'reminder_quota_check_failed' });
      }
    }
    const id = enqueueCustomMessageImpl({ ...req.body, tenantId: normalizedTenantId });

    if (typeof historyId === 'string' && historyId.trim()) {
      try {
        await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId.trim(), {
          ...(historyWithActor || {}),
          tenantId: normalizedTenantId,
          reminderType: 'whatsapp',
          status: 'pending',
          metadata: { messageId: id, deliveryStatus: 'queued' },
        });
      } catch (e) {
        console.warn('[whatsapp_queue_custom] reminderHistory update failed', e);
      }
    }
    void logTenantAuditEventImpl({
      tenantId: normalizedTenantId,
      action: 'reminder_queued',
      authContext: req.authContext,
      targetId: id,
      metadata: {
        channel: 'whatsapp_custom',
        destination: to,
      },
    });
    res.json({jobId:id});
  });

  app.post('/whatsapp/queue/payment-confirmation', rateLimitMiddleware({ windowMs: 60_000, max: 600 }), requireStaffTenantAccess, async (req,res)=>{
    const { to, studentName, amount, paymentDate, tenantId, quotaBatchId, historyId, history } = req.body||{};
    if(!to||!studentName||typeof amount!=='number'||!paymentDate||typeof tenantId!=='string') {
      return res.status(400).json({error:'missing_fields'});
    }
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const normalizedTenantId = tenantAccess.tenantId;
    const actorUid = req.authContext?.uid;
    const historyWithActor = history && typeof history === 'object'
      ? stripUndefinedDeep({ ...(history as any), userId: (history as any)?.userId || actorUid })
      : actorUid
        ? ({ userId: actorUid } as any)
        : undefined;
    const providedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    try {
      if (typeof quotaBatchId === 'string' && quotaBatchId.trim()) {
        await consumeTenantReminderReservationToken(getFirestoreImpl(), normalizedTenantId, quotaBatchId.trim(), 'whatsapp', {
          historyId: typeof historyId === 'string' ? historyId : undefined,
          history: historyWithActor || undefined,
        });
      } else {
        await assertTenantReminderQuotaAvailable(getFirestoreImpl(), normalizedTenantId, 'whatsapp', 1, {
          historyId: typeof historyId === 'string' ? historyId : undefined,
          history: historyWithActor || undefined,
        });
      }
    } catch (error) {
      if (error instanceof TenantReminderLimitError) {
        return res.status(409).json({ error: 'reminder_limit_reached', limit: error.limit, used: error.used, channel: error.channel });
      }
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.warn('[whatsapp_queue_payment] reminder quota check failed', error);
      const isTestMode = process.env.TEST_MODE === '1' || process.argv.includes('--test');
      if (!isTestMode) {
        return res.status(503).json({ error: 'reminder_quota_check_failed' });
      }
    }
    const id = enqueuePaymentConfirmationImpl({ ...req.body, tenantId: normalizedTenantId });

    if (typeof historyId === 'string' && historyId.trim()) {
      try {
        await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId.trim(), {
          ...(historyWithActor || {}),
          tenantId: normalizedTenantId,
          reminderType: 'whatsapp',
          status: 'pending',
          metadata: { messageId: id, deliveryStatus: 'queued' },
        });
      } catch (e) {
        console.warn('[whatsapp_queue_payment] reminderHistory update failed', e);
      }
    }
    void logTenantAuditEventImpl({
      tenantId: normalizedTenantId,
      action: 'reminder_queued',
      authContext: req.authContext,
      targetId: id,
      metadata: {
        channel: 'whatsapp_payment_confirmation',
        destination: to,
        studentName,
        amount,
        paymentDate,
      },
      targetType: 'fee',
    });
    res.json({jobId:id});
  });

  // ----- Usage & billing admin endpoints -----
  app.post('/storage/reconcile', requireAdminTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = z
      .object({
        tenantId: z.string().min(1),
      })
      .safeParse({
        tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : '',
      });

    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = parsed.data.tenantId.trim();
    if (providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    ensureFirebase();
    const bucketConfigured = typeof admin.app().options.storageBucket === 'string';
    if (!bucketConfigured) {
      return res.status(501).json({ error: 'storage_bucket_not_configured' });
    }
    const bucket = admin.storage().bucket();
    const db = getFirestoreImpl();

    try {
      const planLimits = await resolveTenantPlanLimitsForEnforcement(db, normalizedTenantId);
      const limitBytes =
        typeof planLimits.storageBytes === 'number' && Number.isFinite(planLimits.storageBytes)
          ? planLimits.storageBytes
          : 0;

      const bytes = await estimateTenantStorageBytes(bucket, normalizedTenantId, db);
      await db
        .collection('tenantStorageUsage')
        .doc(normalizedTenantId)
        .set(
          {
            tenantId: normalizedTenantId,
            bytes,
            estimatedAt: admin.firestore.FieldValue.serverTimestamp(),
            reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
            reconciledBy: req.authContext?.uid ?? 'system',
          },
          { merge: true }
        );

      invalidateLiveCount(`storageBytes:${normalizedTenantId}`);

      return res.json({ tenantId: normalizedTenantId, bytes, limitBytes });
    } catch (error) {
      console.warn('[storage_reconcile] failed', error);
      return res.status(503).json({ error: 'storage_reconcile_failed' });
    }
  });

  app.get('/storage/upload/preflight', requireStaffTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = z
      .object({
        tenantId: z.string().min(1),
        bytes: z.coerce.number().int().positive(),
      })
      .safeParse({
        tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : '',
        bytes: typeof req.query.bytes === 'string' ? req.query.bytes : Number.NaN,
      });

    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = parsed.data.tenantId.trim();
    if (providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    inc(metricNames.storageUploadPreflightRequests);

    const incrementBytes = parsed.data.bytes;
    const MAX_BYTES = 50 * 1024 * 1024;
    if (incrementBytes > MAX_BYTES) {
      return res.status(413).json({ error: 'file_too_large', maxBytes: MAX_BYTES });
    }

    ensureFirebase();
    const bucketConfigured = typeof admin.app().options.storageBucket === 'string';
    if (!bucketConfigured) {
      return res.status(501).json({ error: 'storage_bucket_not_configured' });
    }
    const bucket = admin.storage().bucket();
    const db = getFirestoreImpl();

    const reconcileUsageBytes = async (): Promise<number> => {
      const reconciled = await estimateTenantStorageBytes(bucket, normalizedTenantId, db);
      await db.collection('tenantStorageUsage').doc(normalizedTenantId).set(
        {
          tenantId: normalizedTenantId,
          bytes: reconciled,
          estimatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      invalidateLiveCount(`storageBytes:${normalizedTenantId}`);
      return reconciled;
    };

    const planLimits = await resolveTenantPlanLimitsForEnforcement(db, normalizedTenantId);
    const limitBytes =
      typeof planLimits.storageBytes === 'number' && Number.isFinite(planLimits.storageBytes)
        ? planLimits.storageBytes
        : 0;

    let usedBytes = 0;
    try {
      usedBytes = await loadOrInitTenantStorageUsage(db, bucket, normalizedTenantId);
    } catch (error) {
      console.warn('[storage_upload_preflight] unable to init storage usage; failing closed', error);
      inc(metricNames.storageUploadPreflightQuotaCheckFailed, { stage: 'init_usage' });
      return res.status(503).json({ error: 'storage_quota_check_failed' });
    }

    if (limitBytes > 0 && usedBytes + incrementBytes > limitBytes) {
      try {
        usedBytes = await reconcileUsageBytes();
      } catch (error) {
        console.warn('[storage_upload_preflight] reconcile failed', error);
        inc(metricNames.storageUploadPreflightQuotaCheckFailed, { stage: 'reconcile' });
        return res.status(503).json({ error: 'storage_quota_check_failed' });
      }

      if (usedBytes + incrementBytes > limitBytes) {
        inc(metricNames.storageUploadPreflightBlocked);
        return res.status(409).json({
          error: 'storage_limit_reached',
          limitBytes,
          usedBytes,
          incrementBytes,
        });
      }
    }

    inc(metricNames.storageUploadPreflightAllowed);
    return res.json({
      ok: true,
      tenantId: normalizedTenantId,
      limitBytes,
      usedBytes,
      incrementBytes,
      availableBytes: limitBytes > 0 ? Math.max(0, limitBytes - usedBytes) : null,
    });
  });

  // Backend-mediated object delete (security-rules-hardening M1). Client
  // `deleteObject` is disabled in storage.rules (`allow delete: if false`) so no
  // signed-in user can delete arbitrary objects across tenants. Deletes are now
  // routed here and authorized against the caller's tenant: every managed object
  // is stored under `{category}/{tenantId}/…`, so we require the object's second
  // path segment to equal the caller's tenant and the category to be one we own.
  // The category list itself now lives in `src/lib/storageObjectRef.ts` as
  // `STORAGE_TENANT_CATEGORIES`, so these two routes, `estimateTenantStorageBytes`'s
  // quota sum, the usage rollup's prefixes and the orphan sweep cannot disagree
  // about what a managed prefix is: a seventh category added to one copy but not
  // the others is exactly the shape of a data-loss bug. This Set is DERIVED from
  // that tuple for O(1) `has`, never a second list. `_orphan-quarantine` is
  // deliberately not in the tuple, which is what keeps both routes rejecting a
  // quarantine path.
  const MANAGED_STORAGE_CATEGORY_SET: ReadonlySet<string> = new Set<string>(STORAGE_TENANT_CATEGORIES);

  function resolveManagedStorageObjectPath(target: string): string | null {
    const raw = (target || '').trim();
    if (!raw) return null;
    // gs://bucket/objectPath
    if (raw.startsWith('gs://')) {
      const withoutScheme = raw.slice('gs://'.length);
      const slash = withoutScheme.indexOf('/');
      if (slash < 0) return null;
      try {
        return decodeURIComponent(withoutScheme.slice(slash + 1));
      } catch {
        return null;
      }
    }
    // Firebase download URL: .../o/{ENCODED_OBJECT_PATH}?alt=media&token=…
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const marker = '/o/';
      const idx = raw.indexOf(marker);
      if (idx < 0) return null;
      let rest = raw.slice(idx + marker.length);
      const q = rest.indexOf('?');
      if (q >= 0) rest = rest.slice(0, q);
      try {
        return decodeURIComponent(rest);
      } catch {
        return null;
      }
    }
    // Plain object path.
    return raw.replace(/^\/+/, '');
  }

  const storageDeleteBodySchema = z.object({
    target: z.string().trim().min(1).max(4000),
  });

  app.post('/storage/delete', requireStaffTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const providedTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    if (!providedTenantId || providedTenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    const parsed = storageDeleteBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const objectPath = resolveManagedStorageObjectPath(parsed.data.target);
    if (!objectPath) {
      return res.status(400).json({ error: 'invalid_object_path' });
    }
    const segments = objectPath.split('/');
    const category = segments[0];
    const pathTenantId = segments[1];
    if (!MANAGED_STORAGE_CATEGORY_SET.has(category) || pathTenantId !== tenantAccess.tenantId) {
      // The object is not under this tenant's managed prefix — refuse so a caller
      // can never delete another tenant's (or an unmanaged) object.
      return res.status(403).json({ error: 'forbidden_object_path' });
    }

    ensureFirebase();
    if (typeof admin.app().options.storageBucket !== 'string') {
      return res.status(501).json({ error: 'storage_bucket_not_configured' });
    }
    const bucket = admin.storage().bucket();
    const db = getFirestoreImpl();
    const file = bucket.file(objectPath);

    try {
      let sizeBytes = 0;
      try {
        const [metadata] = await file.getMetadata();
        sizeBytes = Number((metadata as any)?.size || 0);
      } catch (metaErr: any) {
        if (metaErr?.code === 404) {
          return res.json({ ok: true, alreadyDeleted: true, path: objectPath });
        }
        throw metaErr;
      }

      await file.delete();

      if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
        try {
          await releaseTenantStorageBytes(db, tenantAccess.tenantId, sizeBytes);
          invalidateLiveCount(`storageBytes:${tenantAccess.tenantId}`);
        } catch (releaseErr) {
          console.warn('[storage_delete] usage release failed', releaseErr);
        }
      }

      return res.json({ ok: true, deleted: true, path: objectPath, bytes: sizeBytes });
    } catch (error: any) {
      if (error?.code === 404) {
        return res.json({ ok: true, alreadyDeleted: true, path: objectPath });
      }
      console.error('[storage_delete] failed', error);
      return res.status(500).json({ error: 'storage_delete_failed' });
    }
  });

  app.post('/storage/upload', requireStaffTenantAccessFromQuery, express.raw({ type: '*/*', limit: '55mb' }), async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    // Schema lives at module scope (`storageUploadQuerySchema`) so its
    // accept/reject boundary — notably `uploadKey`'s — is unit-testable against
    // the exact shape this route parses with.
    const parsed = storageUploadQuerySchema.safeParse({
      tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : '',
      purpose: typeof req.query.purpose === 'string' ? req.query.purpose : '',
      conversationFolder: typeof req.query.conversationFolder === 'string' ? req.query.conversationFolder : undefined,
      feeId: typeof req.query.feeId === 'string' ? req.query.feeId : undefined,
      email: typeof req.query.email === 'string' ? req.query.email : undefined,
      filename: typeof req.query.filename === 'string' ? req.query.filename : undefined,
      displayName: typeof req.query.displayName === 'string' ? req.query.displayName : undefined,
      createMessage: typeof req.query.createMessage === 'string' ? req.query.createMessage : undefined,
      clientMsgId: typeof req.query.clientMsgId === 'string' ? req.query.clientMsgId : undefined,
      recipientId: typeof req.query.recipientId === 'string' ? req.query.recipientId : undefined,
      mediaKind: typeof req.query.mediaKind === 'string' ? req.query.mediaKind : undefined,
      messageText: typeof req.query.messageText === 'string' ? req.query.messageText : undefined,
      uploadKey: typeof req.query.uploadKey === 'string' ? req.query.uploadKey : undefined,
    });

    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = parsed.data.tenantId.trim();
    if (providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const uploadPurpose: StorageUploadPurpose = parsed.data.purpose;
    const uploadMetricLabels = { purpose: uploadPurpose };

    ensureFirebase();
    const bucketConfigured = typeof admin.app().options.storageBucket === 'string';
    if (!bucketConfigured) {
      return res.status(501).json({ error: 'storage_bucket_not_configured' });
    }
    const bucket = admin.storage().bucket();
    const db = getFirestoreImpl();

    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/octet-stream';

    // Security-hardening L4: reject script-capable content types. Uploaded objects
    // are served via download URLs with the stored contentType; a file declared as
    // HTML/XHTML/SVG/XML/JS could execute script if opened inline (stored-XSS
    // surface). None of the upload purposes (images/audio/video/docs) need these
    // types, so refuse them outright rather than trusting a client-set header.
    const normalizedContentType = contentType.split(';')[0].trim().toLowerCase();
    const DISALLOWED_UPLOAD_CONTENT_TYPES = new Set([
      'text/html',
      'application/xhtml+xml',
      'image/svg+xml',
      'application/xml',
      'text/xml',
      'application/javascript',
      'text/javascript',
      'application/ecmascript',
      'text/ecmascript',
    ]);
    if (DISALLOWED_UPLOAD_CONTENT_TYPES.has(normalizedContentType)) {
      return res.status(415).json({ error: 'unsupported_content_type', contentType: normalizedContentType });
    }

    const body = req.body as Buffer;
    const bytes = Buffer.isBuffer(body) ? body.length : 0;
    if (!bytes) {
      return res.status(400).json({ error: 'missing_file_body' });
    }

    const MAX_BYTES = 50 * 1024 * 1024;
    if (bytes > MAX_BYTES) {
      return res.status(413).json({ error: 'file_too_large', maxBytes: MAX_BYTES });
    }

    // ── Object path derivation (upload-idempotency spec, task 3.1) ────────────
    // Hoisted ABOVE the quota block: the resolved path must be known before any
    // reservation so a later revision can probe it and reserve only the delta.
    // `resolveUploadObjectPath` (./lib/uploadObjectPath, pure + unit-tested) is
    // the single source of truth for every purpose's path format; when
    // `uploadKeyHash` is `null` (no `uploadKey` sent) it reproduces today's
    // timestamped/randomized paths character-for-character.
    const purpose = uploadPurpose;
    // Kept route-local because downstream consumers (`hasProvidedName`, the video
    // detection regex and the background chat-message input) need this exact
    // value, including the empty-string case a whitespace-only `filename`
    // produces. `resolved.safeName` substitutes a fallback there, so it is not a
    // drop-in replacement.
    const filename = sanitizeStorageSegment(parsed.data.filename || 'file');
    // ── Display name, split out of `filename` (upload-idempotency spec) ───────
    // `filename` above drives the OBJECT PATH only. Every user-visible name (the
    // share doc's `file.fileName` below, and the server-created chat message's
    // sticker `name` / attachment `fileName`) prefers this value when the caller
    // sent one, so a transport that must send a DETERMINISTIC `filename` to get a
    // stable object path can still show the recipient the real file name.
    //
    // Sanitized with the same helper as `filename`, so the new parameter cannot
    // introduce characters the old one could not: today's display name is already
    // a `sanitizeStorageSegment`'d value, and this keeps a chat message doc / a
    // `sharedFiles` doc inside `[A-Za-z0-9._-]`. For the client this is the
    // identity — `chatService` already applies the same reduction before the value
    // reaches the query string.
    //
    // `''` for an absent OR whitespace-only value, and every consumer below falls
    // back to `filename` on a falsy value, so a caller that sends no
    // `displayName` is byte-identical to before this parameter existed.
    const displayName = sanitizeStorageSegment(parsed.data.displayName || '');
    // ── Upload-key scoping (upload-idempotency spec, task 4.2) ────────────────
    // The client value is bound to server-derived scope before hashing, so the
    // same literal key from another tenant, another purpose or another actor can
    // never resolve to the same object (Req 6.1, 6.2).
    //
    // `tenantId` is deliberately `normalizedTenantId` (= `req.tenantAccess
    // .tenantId`, the guard's resolved value) and NOT `parsed.data.tenantId`:
    // taking it from the query string would make a cross-tenant overwrite a
    // matter of editing a query parameter (Req 6.6).
    //
    // Absent-uid decision: when `req.authContext?.uid` is missing we derive
    // `null` — i.e. we ignore the key entirely and fall back to a legacy
    // timestamped path — rather than hashing with an empty actor scope. Hashing
    // with `actorUid: ''` would put every uid-less caller into ONE shared actor
    // scope, so two unrelated callers that happened to pick the same key would
    // silently overwrite each other's object. Degrading to a legacy path costs at
    // most one orphan on retry (today's behavior) instead, which is strictly the
    // safer failure. In practice this branch is unreachable for the flows this
    // feature targets: `requireStaffTenantAccessFromQuery` runs first and the
    // share/chat-message blocks below already treat a missing uid as "no actor".
    const uploadActorUid = req.authContext?.uid;
    const uploadKeyHash = uploadActorUid
      ? deriveUploadKeyHash({
          uploadKey: parsed.data.uploadKey,
          tenantId: normalizedTenantId,
          purpose: uploadPurpose,
          actorUid: uploadActorUid,
        })
      : null;
    const resolved = resolveUploadObjectPath({
      purpose,
      tenantId: normalizedTenantId,
      filename: parsed.data.filename,
      contentType,
      conversationFolder: parsed.data.conversationFolder,
      feeId: parsed.data.feeId,
      email: parsed.data.email,
      // `null` when no `uploadKey` was sent (or no authenticated uid): the path
      // stays on the legacy branch, byte-for-byte as today (Req 2.1).
      uploadKeyHash,
      now: Date.now(),
      randomSuffix: crypto.randomBytes(3).toString('hex'),
    });
    if (!resolved.ok) {
      // Same status code and body as before; raised before any reservation, so
      // the previous reserve-then-release-then-400 round trips are gone.
      return res.status(400).json({ error: resolved.error });
    }
    const objectPath = resolved.objectPath;
    const safeExt = resolved.safeExt;

    // ── Existing-object probe (upload-idempotency spec, task 4.1) ─────────────
    // One read of the resolved path, and only when that path is deterministic, so
    // a caller that sends no `uploadKey` adds zero Storage round trips (Req 9.7).
    // `probeUploadObjectState` never throws: a non-404 failure resolves to
    // `state: 'unreadable'` with `object: null`, i.e. "treat as a new object" for
    // everything downstream (Req 9.2).
    //
    // This one probe result drives the quota delta below; download-token reuse and
    // share-doc reuse consume it in tasks 4.4/4.5.
    const probe: UploadObjectProbeResult = resolved.deterministic
      ? await probeUploadObjectState(bucket, objectPath, uploadPurpose)
      : UPLOAD_OBJECT_PROBE_SKIPPED;
    // `existing` is `null` for BOTH "genuinely absent" and "could not read"
    // (F10) — deliberately, so the quota delta, the download-token decision, the
    // share-doc reuse decision and the idempotent-overwrite metric are all
    // byte-identical to what a 404 produces. The only consumer of the difference is
    // the write precondition below (Req 9.13).
    const existing: ExistingUploadObject | null = probe.object;

    // ── Delta-based quota accounting (upload-idempotency spec, task 4.3) ──────
    // Recorded usage must move by the REAL change in stored bytes, not by the
    // full body size (Req 3.1). `existingBytes` is 0 for every caller that sends
    // no `uploadKey` (no probe ⇒ `existing === null`) and 0 when a probe failed
    // or 404'd, so a legacy caller still reserves the full size exactly as today
    // (Req 2.3) and a degraded probe over-reserves rather than under-counting
    // (Req 9.4).
    const quotaDelta = computeUploadQuotaDelta({ newBytes: bytes, existingBytes: existing?.bytes ?? 0 });
    // Total amount this request currently holds against the tenant's recorded
    // usage. Every rollback path releases exactly this, never the raw body size
    // and never `shrinkBytes` (Req 3.7).
    let reservedBytes = 0;

    // CONCURRENT UPLOADS WITH THE SAME uploadKey (Req 9.5, 9.9–9.14, design
    // "Concurrent uploads with the same uploadKey"; upload-idempotency follow-up F9).
    //
    // Two attempts of one logical action can be in flight at once — most plausibly
    // the native background uploader's internal retry firing while the first
    // attempt is still connected, i.e. a common case for this feature rather than
    // an exotic one. Both reach the probe above before either writes, so both see
    // no existing object and both compute `reserveBytes = full size`.
    //
    // That USED to be accepted: last-writer-wins left exactly one object (the file
    // outcome was always correct) but recorded usage was over-counted by one file
    // size per racing pair until a reconcile. It is now closed by a Storage write
    // PRECONDITION (`resolveUploadSavePrecondition` +
    // `saveUploadObjectWithPrecondition` below), which makes "was I first?" an
    // atomic, lock-free, stateless question Storage itself answers: the loser gets
    // a `412`, releases exactly what it reserved, and returns the winner's URL —
    // so exactly one object AND exactly one net reservation. As a second win the
    // loser also skips a redundant multi-megabyte write entirely, rather than
    // merely un-doing its share of the double count.
    //
    // Still NO lease/lock, deliberately: a Firestore lease keyed on the key hash
    // would add a transaction to the critical upload path and a new failure mode —
    // a stale lease (holder crashed, clock skew, expiry not yet reached) would
    // block a legitimate retry, i.e. it would break the very flow this feature
    // exists to make work. A precondition has none of that: there is nothing to
    // hold, nothing to expire and nothing to clean up.
    //
    // A residual, bounded discrepancy remains where the outcome cannot be
    // attributed — a probe that carried no usable generation or could not be read at
    // all (no precondition sent, F10), or a 412 whose winner carries the same token
    // this request reused so the writer is undecidable. All are resolved toward
    // OVER-counting and left to the existing reconciliation path (Req 9.4, 9.8).

    const planLimits = await resolveTenantPlanLimitsForEnforcement(db, normalizedTenantId);
    const limitBytes =
      typeof planLimits.storageBytes === 'number' && Number.isFinite(planLimits.storageBytes)
        ? planLimits.storageBytes
        : 0;

    const reconcileUsageBytes = async (): Promise<number> => {
      const reconciled = await estimateTenantStorageBytes(bucket, normalizedTenantId, db);
      await db.collection('tenantStorageUsage').doc(normalizedTenantId).set(
        {
          tenantId: normalizedTenantId,
          bytes: reconciled,
          estimatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      invalidateLiveCount(`storageBytes:${normalizedTenantId}`);
      return reconciled;
    };

    // The ENTIRE reservation path is skipped when the delta is zero — no usage
    // load, no reservation transaction, and therefore no way to reach a `409`
    // (Req 3.6, 3.8). That is the same-size-retry case: a retry of an upload that
    // already succeeded stores the same bytes over itself, consumes no additional
    // allowance, and must never be rejected for quota even when the tenant is
    // already at its limit. It is also cheaper than today, since it skips a
    // Firestore read and a transaction.
    //
    // A shrink (`shrinkBytes > 0`) also lands here with `reserveBytes === 0`:
    // freeing space needs no allowance, and the release happens only AFTER the
    // write succeeds (below), so a failed write can never credit bytes that are
    // still stored.
    if (quotaDelta.reserveBytes > 0) {
      // Initialize usage doc from live bucket estimate on first use.
      let knownUsedBytes = 0;
      try {
        knownUsedBytes = await loadOrInitTenantStorageUsage(db, bucket, normalizedTenantId);
      } catch (error) {
        console.warn('[storage_upload] unable to init storage usage; failing closed', error);
        inc(metricNames.storageUploadQuotaCheckFailed, { ...uploadMetricLabels, stage: 'init_usage' });
        return res.status(503).json({ error: 'storage_quota_check_failed' });
      }

      // Deterministic pre-check: if definitely over-limit, return 409 directly.
      // Enforced against the DELTA, so an overwrite is judged on the additional
      // bytes it needs, not on the full body size (Req 3.5). `incrementBytes` in
      // the 409 body is likewise the delta — the same key with the honest number;
      // for any caller that sends no `uploadKey` it still equals `bytes`.
      if (limitBytes > 0 && knownUsedBytes + quotaDelta.reserveBytes > limitBytes) {
        try {
          knownUsedBytes = await reconcileUsageBytes();
        } catch (error) {
          console.warn('[storage_upload] precheck reconcile failed', error);
          inc(metricNames.storageUploadQuotaCheckFailed, { ...uploadMetricLabels, stage: 'precheck_reconcile' });
          return res.status(503).json({ error: 'storage_quota_check_failed' });
        }

        if (knownUsedBytes + quotaDelta.reserveBytes > limitBytes) {
          inc(metricNames.storageUploadRejected, { ...uploadMetricLabels, stage: 'precheck' });
          return res.status(409).json({
            error: 'storage_limit_reached',
            limitBytes,
            usedBytes: knownUsedBytes,
            incrementBytes: quotaDelta.reserveBytes,
          });
        }
      }

      // Reserve bytes transactionally to avoid concurrency overruns.
      //
      // The reserve → classify → reconcile-and-retry → last-chance sequence lives in
      // `reserveUploadQuotaBytes` (module scope, exported, injectable) so it is
      // assertable without an Express/Firebase harness. It returns the decision as
      // DATA — status, body and metric stage — and everything below is a forward.
      //
      // It also fixes a fall-through this block used to have: a successful
      // reconcile-and-retry reservation continued into the last-chance check and then
      // unconditionally into `503 storage_quota_check_failed`, so the recovery could
      // never actually let an upload through, and the bytes it had just reserved
      // leaked (`reservedBytes` was still 0, so the rollback released nothing —
      // Req 3.7). `outcome: 'reserved'` now covers both the first attempt and the
      // retry, and only that outcome reaches the write.
      const reservation = await reserveUploadQuotaBytes({
        reserveBytes: quotaDelta.reserveBytes,
        limitBytes,
        // `invalidateLiveCount` stays paired with the reservation here in the route,
        // on the first attempt and the retry alike, exactly as before (Req 3.10).
        reserve: async () => {
          await reserveTenantStorageBytes(db, normalizedTenantId, quotaDelta.reserveBytes, limitBytes);
          invalidateLiveCount(`storageBytes:${normalizedTenantId}`);
        },
        reconcileUsageBytes,
      });

      if (reservation.outcome !== 'reserved') {
        if (reservation.outcome === 'check_failed') {
          console.warn('[storage_upload] reserve failed', reservation.error);
        }
        // `uploadMetricLabels` is `{ purpose }`; the stage comes from the seam, so
        // every existing label pair (`reserve_reconcile`, `reserve_retry`,
        // `last_chance`, `reserve_unknown`) is preserved verbatim.
        inc(reservation.metric, { ...uploadMetricLabels, stage: reservation.stage });
        return res.status(reservation.status).json(reservation.body);
      }

      // The reservation above succeeded — on the first attempt or on the retry — so
      // this request now holds exactly `quotaDelta.reserveBytes`.
      reservedBytes = quotaDelta.reserveBytes;
    }
    // Invariant from here on: `reservedBytes === quotaDelta.reserveBytes`, i.e.
    // the rollback below releases exactly what this request took, and releases
    // nothing when it took nothing.

    // ── Download-token reuse (upload-idempotency spec, task 4.4) ──────────────
    // Same probe result that drove the quota delta: when it found an object with a
    // token, that token is reused so this write's `url` is byte-identical to the
    // one the first (possibly lost) response returned (Req 4.1, 4.2). `existing`
    // is always `null` for a caller that sends no `uploadKey`, so that path mints
    // a fresh token exactly as today (Req 2.4, 4.3).
    //
    // `reused` comes back from the same call that chose the token (F10), so the
    // write-attribution flag below is read from the decision rather than
    // re-derived by comparing strings the two sides normalized separately.
    const downloadTokenDecision = resolveUploadDownloadToken(existing);
    const attemptedDownloadToken = downloadTokenDecision.token;
    // ── Conditional write (upload-idempotency follow-up F9) ───────────────────
    // `null` for every legacy (unkeyed) path, whenever the probe carried no usable
    // generation, and whenever the probe could not read the object state at all
    // (F10, Req 9.13) — in which case the write below is byte-for-byte today's.
    const savePrecondition = resolveUploadSavePrecondition({
      keyed: uploadKeyHash !== null,
      probe,
    });
    try {
      const file = bucket.file(objectPath);
      const write = await saveUploadObjectWithPrecondition({
        precondition: savePrecondition.precondition,
        attemptedDownloadToken,
        // True ⇒ both racers would write the same token, so a 412 winner carrying it
        // does not prove who wrote. The seam needs that to attribute the write.
        //
        // Taken from the token decision itself (F10). It used to be re-derived here
        // as `(existing?.downloadToken ?? null) === attemptedDownloadToken`, which
        // was correct only because `extractFirstDownloadToken` and the selector
        // trimmed identically — if either normalization had ever diverged the flag
        // would read `false`, a lost race would be mis-attributed as `written`, and
        // the shrink release the winner already performed would run a second time:
        // the double credit / under-count Req 9.4 forbids.
        reusedProbedToken: downloadTokenDecision.reused,
        save: (precondition) =>
          file.save(body, {
            resumable: false,
            contentType,
            metadata: {
              metadata: {
                firebaseStorageDownloadTokens: attemptedDownloadToken,
              },
            },
            // Omitted entirely when there is no precondition, so the options object
            // a legacy upload passes is identical to the pre-F9 one.
            ...(precondition ? { preconditionOpts: precondition } : {}),
          }),
        reprobe: () => probeExistingUploadObject(bucket, objectPath, uploadPurpose),
      });

      // A lost race is a SUCCESS: the sibling attempt of this same logical action
      // stored the identical bytes, so the file the user asked for IS stored. The
      // response continues down the normal success path (share doc, chat message,
      // 200) and is byte-identical to the winner's, because the url below is built
      // from the WINNER's download token (Req 4.1, 4.2).
      const lostRace = write.outcome === 'lost_race';
      const downloadToken = write.outcome === 'lost_race' ? write.downloadToken : attemptedDownloadToken;

      if (write.outcome === 'lost_race' && write.releaseReservation && reservedBytes > 0) {
        // Order matters and is asserted by the seam: the re-probe already happened,
        // so these bytes are provably not ours to hold. Release exactly
        // `reservedBytes` and zero it, so the outer rollback cannot double-release.
        try {
          await releaseTenantStorageBytes(db, normalizedTenantId, reservedBytes);
          invalidateLiveCount(`storageBytes:${normalizedTenantId}`);
          reservedBytes = 0;
        } catch (error) {
          // `reservedBytes` deliberately stays as it is: the release did not happen,
          // so this request still holds those bytes and the invariant
          // "`reservedBytes` is what is currently held" must keep holding. Usage is
          // over-counted until the next reconcile (Req 9.8) — never under-counted.
          console.warn(
            '[storage_upload] lost-race reservation release failed; usage over-counted until the next reconcile',
            error
          );
        }
      }
      if (lostRace) {
        // Labelled by `purpose` only (Req 6.4, 8.4), and wrapped because a metrics
        // write must never be able to fail an upload that already succeeded.
        try {
          inc(metricNames.storageUploadConcurrentRaceLost, uploadMetricLabels);
        } catch {
          // Metrics are never worth failing an upload for.
        }
      }

      // Built from the selected token, so a retry's url matches the first write's
      // character-for-character (Req 4.2). Same format as before this task.
      const url = buildUploadDownloadUrl(bucket.name, objectPath, downloadToken);

      // ── Post-write true-up for a smaller replacement (task 4.3) ─────────────
      // Only AFTER the write succeeded: until `save()` returns, the larger object
      // is still the one stored, so crediting the difference earlier would
      // under-count usage (Req 3.4). `releaseTenantStorageBytes` no-ops on `<= 0`,
      // so guarding on `> 0` is about skipping the transaction, not correctness.
      //
      // Best effort: a failure here warns and STILL returns 200 (Req 3.8, 9.6).
      // The file is stored and the URL is valid; failing the request would be
      // strictly worse, because the client would retry and re-upload an object
      // that is already correct. Usage stays over-counted by `shrinkBytes` until
      // the next reconcile — the same self-healing discrepancy a degraded probe
      // produces. Note `reservedBytes` is 0 whenever `shrinkBytes > 0` (the delta
      // never has both non-zero), so the outer rollback below can never turn this
      // release into a double credit.
      //
      // Skipped on a lost race (F9): this request wrote nothing, so the shrink it
      // computed was either already credited by the winner — releasing it again
      // would UNDER-count, the one direction Req 9.4 forbids — or has not happened
      // at all. Not releasing over-counts at worst, which reconciles away.
      if (!lostRace && quotaDelta.shrinkBytes > 0) {
        try {
          await releaseTenantStorageBytes(db, normalizedTenantId, quotaDelta.shrinkBytes);
          invalidateLiveCount(`storageBytes:${normalizedTenantId}`);
        } catch (error) {
          console.warn(
            '[storage_upload] shrink release failed after a successful write; usage over-counted until the next reconcile',
            error
          );
        }
      }

      // Best-effort: create a share token at upload time for shareable uploads.
      // This makes ShareModal instant later and avoids exposing raw Storage URLs.
      //
      // ── Share-doc reuse on overwrite (upload-idempotency spec, task 4.5) ─────
      // The per-purpose eligibility filter and the unknown-actor early return now
      // live inside `resolveShareTokenForUpload`; the only behavior change is that
      // an OVERWRITE reuses the existing active doc for this `(tenant, uid, url)`
      // instead of minting a second token (Req 5.1, 5.2). `quotaDelta.isOverwrite`
      // is only ever true for a deterministic path whose probe found an object, so
      // a caller that sends no `uploadKey` takes the mint-and-write branch exactly
      // as today (Req 5.3). The outer try/catch is retained so nothing in this
      // block — including the filename derivation — can fail the stored upload.
      let shareToken: string | undefined;
      try {
        const authContext = req.authContext;
        // Unchanged derivation, hoisted out of the eligibility branch (pure string
        // work; it is simply unused for the two purposes that get no share doc).
        const hasProvidedName = Boolean((parsed.data.filename || '').trim()) && filename !== 'file';
        // DECISION (upload-idempotency spec): `displayName` wins here, ahead of
        // `filename`. This name is what a share sheet and the `sharedFiles` list
        // render, so it must be the human-meaningful one. Now that the native
        // background transport sends a deterministic `filename` derived from the
        // send's `clientMsgId`, keeping this on `filename` would put
        // `pick_pm_1712…_a1b2c3d4e5f6g7.jpg` in the share sheet — a user-visible
        // regression, and precisely the thing splitting the parameter exists to
        // avoid. The `hasProvidedName` chain is retained UNCHANGED behind it, so a
        // caller that sends only `filename` gets the identical name it gets today.
        const shareFileName =
          displayName ||
          (hasProvidedName ? filename : '') ||
          (purpose === 'receipt'
            ? `receipt.${safeExt}`
            : purpose === 'noticeAudio'
              ? `notice_audio.${safeExt}`
              : purpose === 'noticeImage'
                ? `notice.${safeExt}`
                : purpose === 'studentProfile'
                  ? `student_profile.${safeExt}`
                  : `file.${safeExt}`);

        shareToken = await resolveShareTokenForUpload({
          purpose,
          tenantId: normalizedTenantId,
          actorUid: authContext?.uid,
          // `|| lostRace` (F9): a lost race means an object — and therefore possibly
          // an active share doc for this exact url — already exists at the path, so
          // the reuse lookup must run for the same reason an overwrite runs it: one
          // logical action must leave at most one active share doc (Req 5.2).
          isOverwrite: quotaDelta.isOverwrite || lostRace,
          // Built from the reused download token above, so a retry's url matches
          // the first write's byte-for-byte and the lookup below can find the doc
          // that write created.
          fileUrl: url,
          findExistingShareToken: async (input) => {
            // Already-deployed composite index (also used by
            // `/shared-files/resolve-or-create`); returns only ACTIVE docs, since
            // it filters through `isActiveSharedFileDoc` — a revoked or expired
            // doc yields `null` here and the mint branch runs instead.
            const found = await findLatestActiveShareForFile(db, input);
            return found?.token || null;
          },
          createShareToken: async (input) => {
            const token = normalizeShareToken(mintShareToken());
            if (!token) return null;
            await db
              .collection('sharedFiles')
              .doc(token)
              .set(
                stripUndefinedDeep({
                  token,
                  tenantId: input.tenantId,
                  createdAt: new Date().toISOString(),
                  createdByUid: input.uid,
                  createdByEmail: authContext?.email || undefined,
                  file: {
                    url: input.fileUrl,
                    fileName: shareFileName,
                    fileType: contentType || undefined,
                    fileSize: bytes,
                  },
                }),
              );
            return token;
          },
        });
      } catch (error) {
        console.warn('[storage_upload] unable to precreate share token', error);
      }

      // ── Idempotent-overwrite counter (upload-idempotency spec, task 6.2) ──────
      // Counted on the SUCCESS path, after `save()` returned, because an Overwrite
      // is by definition a *successful* write to a deterministic path at which an
      // object already existed (Req 8.1). A request that failed at the write takes
      // the outer catch below and never reaches here, and a request that overwrote
      // nothing has `isOverwrite === false` — `quotaDelta.isOverwrite` is only ever
      // true when the probe of a deterministic path actually found an object, so a
      // caller that sends no `uploadKey` (no probe ⇒ `existing === null`) can never
      // increment it.
      //
      // This is the number that says how many orphans the feature prevented: it
      // rising while tenant byte totals stay flat across reconciles is the rollout
      // signal (Req 11.8).
      //
      // `uploadMetricLabels` is `{ purpose }` and nothing else. The `uploadKey`, its
      // hash, the filename and the object path are deliberately absent: they are
      // unbounded cardinality and a leak surface (Req 6.4, 8.4).
      //
      // `&& !lostRace` (F9): an Overwrite is by definition a successful WRITE at a
      // path that already held an object, and a request that lost the precondition
      // race wrote nothing. It is counted by `storage_upload_concurrent_race_lost_total`
      // instead, which keeps the three success counters disjoint — accepted =
      // fresh + overwrite + race lost — so neither number has to be read with a
      // caveat.
      if (quotaDelta.isOverwrite && !lostRace) {
        inc(metricNames.storageUploadIdempotentOverwrite, uploadMetricLabels);
      }
      inc(metricNames.storageUploadAccepted, uploadMetricLabels);

      // Fire async video transcode for chat video uploads.
      // The original URL is returned immediately; the transcoded H.264 URL is
      // written to Firestore (videoTranscodes collection) when ready.
      // This fixes HEVC/H.265 videos from iPhone/VN-editor that won't play
      // in Android mobile browsers (Chrome/Edge lack an HEVC decoder).
      //
      // ── Transcode dedupe, CONFIRMED (upload-idempotency spec, task 4.5) ──────
      // No change needed here (Req 5.4). `runTranscodeJob` keys its Firestore doc
      // on `sha256(originalPath)` (`videoTranscoder.ts`, also exported as
      // `transcodeDocId`), and a deterministic `objectPath` is identical across
      // every retry of one logical action, so N retries all target ONE
      // `videoTranscodes/{sha256(path)}` doc — never a second job. The job also
      // returns early when that doc already carries a `transcodedUrl`, so a retry
      // that lands while the first job is finishing cannot transcode twice.
      //
      // GAP NOW CLOSED (upload-idempotency follow-up F21; design: "Transcode of an
      // already-transcoded original"). Once a job has completed it DELETES the
      // original and stores `originalDeleted: true`. If the same `uploadKey` was
      // reused long after that, the new bytes landed at the same path but the early
      // return on `transcodedUrl` meant they were never transcoded, and both
      // `ChatCacheService` and `/video/request-transcode` kept handing out the OLD
      // `transcodedUrl` — which lives at a DIFFERENT path (`{base}_h264.mp4`) and so
      // still exists and still plays. The viewer got the previous video, indefinitely.
      //
      // The job now carries `originalContentHash`, the identity of the bytes this
      // request stored, and `decideTranscodeReuse` uses it to tell "same bytes again"
      // (dedupe, unchanged) from "different bytes at the same path" (reset the record
      // and transcode). The hash is computed from `body`, which is already in memory,
      // and only for a video upload — a plain SHA-256 pass whose cost is invisible
      // next to the transcode it gates.
      // Deliberately reads the STORAGE `filename`, never `displayName`: this decides
      // what to do with the stored bytes, so it must follow the value that named
      // them. A deterministic client-derived name still carries an extension —
      // `deriveStableUploadFileName` (`lib/uploadFileName.ts`) appends the mime
      // subtype, so `video/mp4` produces a `.mp4` suffix and this regex fires. The
      // `contentType.startsWith('video/')` arm covers the mime types whose subtype
      // is not itself a container extension (`video/quicktime` gives `.quicktime`),
      // so a background video upload is detected either way.
      const isVideoUpload =
        uploadPurpose === 'chat' &&
        (contentType.startsWith('video/') ||
          /\.(mp4|mov|m4v|avi|mkv|webm|hevc|heic)$/i.test(filename || ''));
      if (isVideoUpload) {
        scheduleVideoTranscode({
          originalPath: objectPath,
          bucketName: bucket.name,
          originalUrl: url,
          contentType,
          tenantId: normalizedTenantId,
          // Identity of the bytes THIS request stored (F21). A retry of one logical
          // upload stores byte-identical content and so produces the same value,
          // which is what keeps the transcode deduped; a different video reusing the
          // same `uploadKey` produces a different value, which is what makes the
          // stale record self-heal. Never `generation` — that changes on every write.
          originalContentHash: videoContentIdentity(body),
        });
      }

      // Phase 2 (kill-safe background uploads): atomically create the chat message
      // now that the file is stored, so a background upload that finishes while the
      // app is killed still produces a delivered message. Idempotent by clientMsgId
      // (sendChatMessage upserts). Best-effort + fail-open: any failure here never
      // fails the upload response — the client's durable outbox re-drives the send
      // idempotently on next launch, so no message is ever lost or duplicated.
      //
      // ── Chat-message dedupe, CONFIRMED (upload-idempotency spec, task 4.5) ────
      // No change needed here (Req 5.5). `sendChatMessage` sanitizes the supplied
      // `clientMsgId`, looks the conversation up by it
      // (`findChatMessageByClientMsgId`) and returns the EXISTING record when one
      // is found, then claims `conversationClientMsgIndex/{conv}/{clientMsgId}`
      // through an RTDB transaction and defers to the winning claim — so it is an
      // upsert under retries and under concurrency alike. The client derives the
      // `uploadKey` from this same `clientMsgId` (`uploadKeyFromStableId`), so a
      // retried upload re-drives ONE message; and because the download token was
      // reused above, that one message carries the SAME url it carried the first
      // time rather than a rotated one that would 403.
      let createdMessageId: string | undefined;
      if (
        parsed.data.createMessage === '1' &&
        uploadPurpose === 'chat' &&
        parsed.data.recipientId &&
        req.authContext?.email
      ) {
        try {
          const record = await sendChatMessageImpl(
            buildBackgroundUploadChatMessageInput({
              mediaKind: parsed.data.mediaKind || 'attachment',
              url,
              filename,
              // Preferred over `filename` for the sticker `name` / attachment
              // `fileName` the recipient sees; `''` here (no `displayName` sent)
              // leaves the builder on its existing `filename` fallback chain,
              // including `'Sticker'` and `file.{ext}`.
              displayName,
              contentType,
              bytes,
              safeExt,
              senderEmail: req.authContext.email,
              recipientId: parsed.data.recipientId,
              tenantId: normalizedTenantId,
              clientMsgId: parsed.data.clientMsgId,
              text: parsed.data.messageText,
            })
          );
          createdMessageId = record?.id;
        } catch (error) {
          console.warn('[storage_upload] background chat message create failed (client outbox will re-drive)', error);
        }
      }

      return res.json({
        url,
        path: objectPath,
        bytes,
        contentType,
        ...(shareToken ? { shareToken } : {}),
        ...(createdMessageId ? { messageId: createdMessageId } : {}),
      });
    } catch (error) {
      // Release exactly what was reserved for this request — `bytes` for a new
      // object, the delta for a growing overwrite, and nothing at all for a
      // same-size retry or a shrink — so the rollback can never over- or
      // under-release (Req 3.7).
      //
      // `quotaDelta.shrinkBytes` is deliberately NOT released here: the write
      // failed, so the previous, LARGER object is still stored and still owes its
      // full byte count. The client's retry re-derives the same deterministic path
      // and tries again.
      await releaseTenantStorageBytes(db, normalizedTenantId, reservedBytes).catch(() => undefined);
      invalidateLiveCount(`storageBytes:${normalizedTenantId}`);
      console.error('[storage_upload] upload failed', error);
      inc(metricNames.storageUploadFailed, { ...uploadMetricLabels, stage: 'save' });
      return res.status(500).json({ error: 'upload_failed' });
    }
  });

  // ─── POST /video/request-transcode ───────────────────────────────────────────
  // On-demand transcoding endpoint. Idempotent: returns existing job status if a
  // videoTranscodes document already exists for the given URL, or schedules a new
  // job if none exists (or the previous one errored out).
  // Requirements: 1.3, 1.4
  const requestTranscodeSchema = z.object({
    originalUrl: z.string().url(),
    tenantId: z.string().min(1),
  });

  app.post(
    '/video/request-transcode',
    requireMemberTenantAccess,
    rateLimitMiddleware({ windowMs: 60_000, max: 10 }),
    async (req, res) => {
      const tenantAccess = req.tenantAccess;
      if (!tenantAccess) {
        return res.status(500).json({ error: 'tenant_guard_missing' });
      }
      const parsed = requestTranscodeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
      }

      const { originalUrl, tenantId } = parsed.data;
      if (tenantId !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      // Requirement 8: when transcoding is disabled, never schedule a job.
      // Report 'disabled' so the client surfaces the unsupported-video error.
      if (!isVideoTranscodeEnabled()) {
        return res.status(200).json({ status: 'disabled' });
      }

      // Derive the deterministic document ID the same way the transcoder does:
      // sha256(storagePath) — where storagePath is extracted from the download URL.
      let storagePath: string;
      try {
        storagePath = storagePathFromUrl(originalUrl);
      } catch {
        return res.status(400).json({ error: 'invalid_storage_url' });
      }

      // Enforce that the object belongs to the CALLER'S tenant and sits under a
      // managed category prefix ({category}/{tenantId}/…). The transcoder reads the
      // original via the Admin SDK (bypassing Storage rules) and then permanently
      // DELETES it, so without this a member could point originalUrl at another
      // tenant's video and destroy it / mis-attribute storage quota
      // (security-rules-hardening H5).
      const pathSegments = storagePath.split('/');
      if (!MANAGED_STORAGE_CATEGORY_SET.has(pathSegments[0]) || pathSegments[1] !== tenantAccess.tenantId) {
        return res.status(403).json({ error: 'forbidden_object_path' });
      }

      const docId = transcodeDocId(storagePath);

      let db: admin.firestore.Firestore;
      try {
        ensureFirebase();
        db = getFirestoreImpl();
      } catch (err) {
        console.error('[request_transcode] firestore init failed', err);
        return res.status(500).json({ error: 'internal_error' });
      }

      try {
        const docRef = db.collection('videoTranscodes').doc(docId);
        const snap = await docRef.get();

        if (snap.exists) {
          const data = snap.data() as Record<string, any>;
          const status: string = typeof data?.status === 'string' ? data.status : '';
          const existingTranscodedUrl: string | undefined =
            typeof data?.transcodedUrl === 'string' && data.transcodedUrl.length > 0
              ? data.transcodedUrl
              : undefined;

          // If a transcoded URL is present, return it immediately regardless of status.
          // This handles the case where status was set to 'error' by a LATER attempt
          // to re-download the original file that was already deleted after a successful
          // first transcode (originalDeleted: true but a retry call saw status: 'error').
          if (existingTranscodedUrl) {
            // Repair the status field if it's wrong so future queries find it correctly.
            if (status !== 'done') {
              docRef.set(
                {
                  status: 'done',
                  error: admin.firestore.FieldValue.delete(),
                  failedAt: admin.firestore.FieldValue.delete(),
                },
                { merge: true }
              ).catch((err: unknown) =>
                console.warn('[request_transcode] failed to repair status field', err)
              );
            }
            return res.status(200).json({ status: 'done', transcodedUrl: existingTranscodedUrl });
          }

          if (status === 'processing') {
            return res.status(202).json({ status: 'processing' });
          }

          // status === 'error' with no transcodedUrl → schedule a new transcode job
        }

        // Document absent or status is 'error' — schedule a new transcode job.
        // The job itself will write the initial Firestore document with status: 'processing'.
        scheduleVideoTranscode({
          originalPath: storagePath,
          bucketName: admin.storage().bucket().name,
          originalUrl,
          contentType: 'video/mp4',
          tenantId: tenantAccess.tenantId,
        });

        return res.status(202).json({ status: 'processing' });
      } catch (err) {
        console.error('[request_transcode] firestore read failed', err);
        return res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  app.post('/students/create', requireStaffTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const tenantIdRaw = typeof (req.body as any)?.tenantId === 'string' ? (req.body as any).tenantId : '';
    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = tenantIdRaw.trim();
    if (!providedTenantId) {
      return res.status(400).json({ error: 'missing_tenant_id' });
    }
    if (providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const studentDataRaw = (req.body as any)?.studentData;
    if (!studentDataRaw || typeof studentDataRaw !== 'object') {
      return res.status(400).json({ error: 'missing_student_data' });
    }
    const name = typeof (studentDataRaw as any).name === 'string' ? (studentDataRaw as any).name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'missing_student_name' });
    }

    const statusRaw = typeof (studentDataRaw as any).status === 'string' ? (studentDataRaw as any).status.trim().toLowerCase() : '';
    const isActiveStudent = statusRaw ? statusRaw === 'active' : true;

    try {
      const db = getFirestoreImpl();
      await assertTenantStudentCreateAllowed(db, normalizedTenantId, isActiveStudent);

      const nowIso = new Date().toISOString();
      const createdBy = typeof (req.body as any)?.createdBy === 'string' ? (req.body as any).createdBy : undefined;
      const record = stripUndefinedDeep({
        tenantId: normalizedTenantId,
        ...studentDataRaw,
        name,
        status: statusRaw || (studentDataRaw as any).status || 'active',
        order: typeof (studentDataRaw as any).order === 'number' ? (studentDataRaw as any).order : Date.now(),
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: createdBy || (req.authContext?.uid ?? 'system'),
      });

      const ref = await db.collection('students').add(record as any);
      invalidateLiveCount(`students:${tenantAccess.tenantId}`);
      return res.json({ id: ref.id });
    } catch (error) {
      if (error instanceof TenantStudentLimitError) {
        return res.status(409).json({ error: 'student_limit_reached', limit: error.limit, used: error.used });
      }
      console.error('[students_create] failed', error);
      return res.status(500).json({ error: 'student_create_failed' });
    }
  });
  app.get('/usage/current', requireStaffTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const monthParam = typeof req.query.month === 'string' ? req.query.month : null;
    const planParam = typeof req.query.planId === 'string' ? req.query.planId : null;
    const monthId = normalizeMonthId(monthParam);

    try {
      const tenantSummary = await loadTenantAdminSummaryImpl(tenantAccess.tenantId);
      if (!tenantSummary) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }

      const db = getFirestoreImpl();

      const planLimits = planParam
        ? getPlanLimits(planParam)
        : await resolveEffectivePlanLimitsForTenant(db, tenantAccess.tenantId, {
            billingTier: tenantSummary.billingTier ?? null,
            quotas: tenantSummary.quotas ?? null,
          });
      const planId = planLimits.id;
      const { ref: usageDocRef, data: usageData } = await loadUsageMonthSnapshotImpl(tenantAccess.tenantId, monthId);
      const alertsRaw = await loadUsageAlertsImpl(usageDocRef, monthId);

      const remindersSource = (usageData.remindersSent ?? usageData.reminders ?? {}) as Record<string, any>;
      const reminders = {
        total: 0,
        whatsapp: safeNumber(remindersSource.whatsapp),
        sms: safeNumber(remindersSource.sms),
        email: safeNumber(remindersSource.email),
        voice: safeNumber(remindersSource.voice ?? remindersSource.voiceCall),
        other: safeNumber(remindersSource.other),
        inFlight: {
          total: 0,
          whatsapp: 0,
          sms: 0,
          email: 0,
          voice: 0,
        },
        reserved: {
          total: 0,
          whatsapp: 0,
          sms: 0,
          email: 0,
          voice: 0,
        },
        effectiveUsed: 0,
        effectiveRemaining: null as number | null,
      };
      reminders.total = safeNumber(
        remindersSource.total,
        reminders.whatsapp + reminders.sms + reminders.email + reminders.voice + reminders.other
      );

      const canViewPayments = tenantAccess.role === 'owner' || tenantAccess.role === 'admin';
      const paymentsReceived = canViewPayments
        ? (() => {
            const paymentsSource = (usageData.paymentsReceived ?? {}) as Record<string, any>;
            return {
              count: safeNumber(paymentsSource.count ?? usageData.paymentsReceivedCount),
              amount: safeNumber(paymentsSource.amount ?? usageData.paymentsReceivedAmount),
            };
          })()
        : undefined;

      const studentsFallback = safeNumber(tenantSummary.membershipCounts?.total);
      const staffFallback = deriveStaffCount(tenantSummary);
      const currentMonthId = formatMonthId(new Date());

      if (monthId === currentMonthId) {
        // Keep reminder usage in sync with live quota enforcement state.
        try {
          await reconcileTenantReminderUsageToBillableOnly(db, tenantAccess.tenantId, monthId);
        } catch (error) {
          console.warn('[usage_current] reminder reconcile skipped', error);
        }

        const liveReminderState = await loadTenantReminderQuotaState(db, tenantAccess.tenantId, monthId);
        const shouldUseLiveReminderCounters =
          liveReminderState.hasUsageDoc ||
          safeNumber(liveReminderState.inFlightTotal) > 0 ||
          safeNumber(liveReminderState.reservedTotal) > 0;

        if (shouldUseLiveReminderCounters) {
          reminders.total = safeNumber(liveReminderState.total);
          reminders.email = safeNumber(liveReminderState.email);
          reminders.sms = safeNumber(liveReminderState.sms);
          reminders.whatsapp = safeNumber(liveReminderState.whatsapp);
          reminders.voice = safeNumber(liveReminderState.voice);
          reminders.other = Math.max(0, reminders.total - (reminders.email + reminders.sms + reminders.whatsapp + reminders.voice));
        }

        reminders.inFlight = {
          total: safeNumber(liveReminderState.inFlightTotal),
          email: safeNumber(liveReminderState.inFlightEmail),
          sms: safeNumber(liveReminderState.inFlightSms),
          whatsapp: safeNumber(liveReminderState.inFlightWhatsapp),
          voice: safeNumber(liveReminderState.inFlightVoice),
        };
        reminders.reserved = {
          total: safeNumber(liveReminderState.reservedTotal),
          email: safeNumber(liveReminderState.reservedEmail),
          sms: safeNumber(liveReminderState.reservedSms),
          whatsapp: safeNumber(liveReminderState.reservedWhatsapp),
          voice: safeNumber(liveReminderState.reservedVoice),
        };
      }

      reminders.effectiveUsed = safeNumber(reminders.total) + safeNumber(reminders.inFlight.total) + safeNumber(reminders.reserved.total);
      reminders.effectiveRemaining =
        planLimits.reminders.total > 0 ? Math.max(0, planLimits.reminders.total - reminders.effectiveUsed) : null;

      // Seats are a "current state" metric; prefer a live count for the current month
      // so UI doesn't drift when rollups lag or fail.
      const shouldUseLiveStaffSeats = !monthParam || monthId === currentMonthId;
      const shouldUseLiveStudents = !monthParam || monthId === currentMonthId;
      const shouldUseLiveStorageBytes = !monthParam || monthId === currentMonthId;
      let liveStaffSeats: number | null = null;
      let livePendingSeatInvites: number | null = null;
      let liveActiveStudents: number | null = null;
      let liveStorageBytes: number | null = null;
      if (shouldUseLiveStaffSeats) {
        const live = await countActiveStaffSeatsLiveCached(db, tenantAccess.tenantId);
        liveStaffSeats = live >= 0 ? live : null;

        const pending = await countPendingSeatInvitesLiveCached(db, tenantAccess.tenantId);
        livePendingSeatInvites = pending >= 0 ? pending : null;
      }

      if (shouldUseLiveStudents) {
        const live = await countActiveStudentsLiveCached(db, tenantAccess.tenantId);
        liveActiveStudents = live >= 0 ? live : null;
      }

      if (shouldUseLiveStorageBytes) {
        const live = await readTenantStorageBytesLiveCached(db, tenantAccess.tenantId);
        liveStorageBytes = live >= 0 ? live : null;
      }

      const studentsValue = safeNumber(
        liveActiveStudents ?? usageData.activeStudents ?? usageData.students ?? usageData.studentCount,
        studentsFallback
      );
      const staffActiveValue = safeNumber(
        liveStaffSeats ?? usageData.staffSeatsUsed ?? usageData.staff ?? usageData.activeStaff,
        staffFallback
      );
      const staffPendingInvitesValue = safeNumber(livePendingSeatInvites, 0);
      const staffValue = staffActiveValue + staffPendingInvitesValue;
      const studentsAdded = safeNumber(
        usageData.studentsAdded ?? usageData.newStudents ?? usageData.studentsAddedThisMonth
      );
      const noticePosts = safeNumber(usageData.noticePosts ?? usageData.noticeCount);
      const deviceActions = safeNumber(usageData.deviceActions ?? usageData.deviceActionCount);
      const chatMessagesValue = coerceNumber(usageData.chatMessages ?? usageData.chatMessageCount);
      const metricsVersion = coerceNumber(usageData.metricsVersion);
      const lastRefreshedAt = toIsoTimestamp(usageData.lastRefreshedAt ?? usageData.updatedAt);
      const storageBytes = safeNumber(liveStorageBytes ?? storageToBytes(usageData), storageToBytes(usageData));
      const storageSources = normalizeStorageSources(usageData.storageSources);
      const diagnostics = normalizeUsageDiagnostics(usageData.rollupDiagnostics);

      const summary: UsageSummaryResponse = {
        tenantId: tenantAccess.tenantId,
        month: monthId,
        planId,
        planLimits,
        students: studentsValue,
        studentsAdded,
        staff: staffValue,
        staffBreakdown: {
          active: staffActiveValue,
          pendingInvites: staffPendingInvitesValue,
        },
        reminders,
        paymentsReceived,
        noticePosts,
        deviceActions,
        chatMessages: typeof chatMessagesValue === 'number' ? chatMessagesValue : null,
        storageBytes,
        storageSources,
        alerts: alertsRaw,
        metricsVersion: typeof metricsVersion === 'number' ? metricsVersion : undefined,
        lastRefreshedAt,
        diagnostics,
        statuses: {},
      };

      const metricSnapshots: Partial<Record<UsageMetricKey, { value: number; limit: number }>> = {
        students: { value: summary.students, limit: planLimits.students },
        staff: { value: summary.staff, limit: planLimits.staffSeats },
        reminders: { value: summary.reminders.total, limit: planLimits.reminders.total },
        storage: { value: summary.storageBytes, limit: planLimits.storageBytes },
      };

      const alerts = alertsRaw.flatMap((alert) => {
        const snapshot = metricSnapshots[alert.metric];
        if (!snapshot || snapshot.limit <= 0) {
          return [alert];
        }

        const ratio = snapshot.value / snapshot.limit;
        const computedThreshold =
          ratio >= planLimits.criticalThreshold
            ? 'critical'
            : ratio >= planLimits.warningThreshold
              ? 'warning'
              : null;

        // If the metric is now below the warning threshold and this alert was never acknowledged,
        // treat it as resolved so the UI doesn't show stale banners/details.
        if (!computedThreshold && !alert.acknowledgedAt) {
          return [];
        }

        const nextType = computedThreshold ?? alert.type;
        const nextDetails = computedThreshold
          ? buildUsageAlertDetails(alert.metric, monthId, ratio, snapshot.value, snapshot.limit, computedThreshold)
          : alert.details;

        return [
          {
            ...alert,
            type: nextType,
            value: snapshot.value,
            limit: snapshot.limit,
            ratio,
            details: nextDetails,
          },
        ];
      });

      summary.alerts = alerts;

      const statuses: UsageMetricStatusMap = {};
      const studentStatus = buildUsageMetricStatus(summary.students, planLimits.students);
      if (studentStatus) statuses.students = studentStatus;
      const staffStatus = buildUsageMetricStatus(summary.staff, planLimits.staffSeats);
      if (staffStatus) statuses.staff = staffStatus;
      const reminderStatus = buildUsageMetricStatus(summary.reminders.total, planLimits.reminders.total);
      if (reminderStatus) statuses.reminders = reminderStatus;
      const storageStatus = buildUsageMetricStatus(summary.storageBytes, planLimits.storageBytes);
      if (storageStatus) statuses.storage = storageStatus;
      summary.statuses = statuses;

      return res.json(summary);
    } catch (error) {
      console.error('[usage_current] failed', error);
      return res.status(500).json({ error: 'usage_snapshot_failed' });
    }
  });

  app.get('/usage/history', requireAdminTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const monthsParam = Number(req.query.months);
    const monthsCount = Number.isFinite(monthsParam) ? Number(monthsParam) : DEFAULT_USAGE_HISTORY_MONTHS;
    const monthIds = buildMonthSeries(monthsCount);

    try {
      const snapshots = await Promise.all(
        monthIds.map((monthId) => loadUsageMonthSnapshotImpl(tenantAccess.tenantId, monthId))
      );
      const history: UsageHistoryPoint[] = monthIds.map((monthId, index) => {
        const snapshot = snapshots[index]?.data ?? {};
        const remindersSource = (snapshot.remindersSent ?? snapshot.reminders ?? {}) as Record<string, any>;
        return {
          month: monthId,
          students: safeNumber(snapshot.activeStudents ?? snapshot.students ?? snapshot.studentCount),
          studentsAdded: safeNumber(snapshot.studentsAdded ?? snapshot.newStudents ?? snapshot.studentsAddedThisMonth),
          staff: safeNumber(snapshot.staffSeatsUsed ?? snapshot.staff ?? snapshot.activeStaff),
          remindersTotal: safeNumber(remindersSource.total),
          remindersWhatsApp: safeNumber(remindersSource.whatsapp),
          remindersSms: safeNumber(remindersSource.sms),
          remindersEmail: safeNumber(remindersSource.email),
          storageBytes: storageToBytes(snapshot),
          noticePosts: safeNumber(snapshot.noticePosts ?? snapshot.noticeCount),
          deviceActions: safeNumber(snapshot.deviceActions ?? snapshot.deviceActionCount),
          chatMessages: coerceNumber(snapshot.chatMessages ?? snapshot.chatMessageCount) ?? null,
        } satisfies UsageHistoryPoint;
      });
      return res.json(history);
    } catch (error) {
      console.error('[usage_history] failed', error);
      return res.status(500).json({ error: 'usage_history_failed' });
    }
  });

  app.post('/usage/alerts/:alertId/ack', requireAdminTenantAccessAny, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = parseUsageAlertCompositeId(req.params.alertId || '');
    if (!parsed) {
      return res.status(400).json({ error: 'invalid_alert_id' });
    }

    try {
      const { ref: usageDocRef } = await loadUsageMonthSnapshotImpl(tenantAccess.tenantId, parsed.monthId);
      if (!usageDocRef) {
        return res.status(404).json({ error: 'usage_snapshot_missing' });
      }
      const alertRef = usageDocRef.collection('alerts').doc(parsed.alertId);
      const alertSnap = await alertRef.get();
      if (!alertSnap.exists) {
        return res.status(404).json({ error: 'alert_not_found' });
      }
      const acknowledgedAt = new Date().toISOString();
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const acknowledgementPayload: Record<string, unknown> = {
        acknowledgedAt,
        acknowledgedBy: req.authContext?.uid || 'system',
        acknowledgedByEmail: actorEmail || undefined,
      };
      const ackMetadata = ((alertSnap.data()?.notifications as Record<string, unknown> | undefined)?.ack ?? null) as
        | Record<string, unknown>
        | null;
      if (ackMetadata) {
        acknowledgementPayload['notifications.ack.pending'] = false;
        acknowledgementPayload['notifications.ack.closedAt'] = acknowledgedAt;
        acknowledgementPayload['notifications.ack.closedAtTimestamp'] = admin.firestore.FieldValue.serverTimestamp();
      }
      await alertRef.set(acknowledgementPayload, { merge: true });
      void logTenantAuditEventImpl({
        tenantId: tenantAccess.tenantId,
        action: 'usage_alert_acknowledged',
        authContext: req.authContext,
        metadata: { alertId: parsed.alertId, monthId: parsed.monthId },
        targetId: parsed.alertId,
        targetType: 'usage',
      });
      return res.json({ ok: true, acknowledgedAt });
    } catch (error) {
      console.error('[usage_alert_ack] failed', error);
      return res.status(500).json({ error: 'alert_ack_failed' });
    }
  });

  app.post('/usage/refresh', requireAdminTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const monthPayload = typeof (req.body as any)?.month === 'string' ? (req.body as any).month : null;
    const monthParam = monthPayload ?? (typeof req.query.month === 'string' ? req.query.month : null);
    const monthId = normalizeMonthId(monthParam);

    try {
      const db = getFirestoreImpl();
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const refreshRequestsRef = db.collection('tenantUsageRefreshRequests');

      const findExistingActiveRequest = async (
        status: 'pending' | 'processing'
      ): Promise<{ id: string; status: 'pending' | 'processing' } | null> => {
        const coll: any = refreshRequestsRef as any;
        if (!coll || typeof coll.where !== 'function') {
          return null;
        }
        const query = coll
          .where('tenantId', '==', tenantAccess.tenantId)
          .where('month', '==', monthId)
          .where('status', '==', status)
          .limit(1);
        if (!query || typeof query.get !== 'function') {
          return null;
        }
        const snap = await query.get();
        if (!snap || typeof snap.empty !== 'boolean' || snap.empty) {
          return null;
        }
        const doc = Array.isArray((snap as any).docs) ? (snap as any).docs[0] : null;
        if (!doc || typeof doc.id !== 'string' || !doc.id.trim()) {
          return null;
        }
        return { id: doc.id, status };
      };

      try {
        const existingPending = await findExistingActiveRequest('pending');
        if (existingPending) {
          return res.json({
            ok: true,
            requestId: existingPending.id,
            month: monthId,
            alreadyQueued: true,
            status: existingPending.status,
          });
        }

        const existingProcessing = await findExistingActiveRequest('processing');
        if (existingProcessing) {
          return res.json({
            ok: true,
            requestId: existingProcessing.id,
            month: monthId,
            alreadyQueued: true,
            status: existingProcessing.status,
          });
        }
      } catch (lookupError) {
        console.warn('[usage_refresh_request] dedupe lookup failed, continuing with enqueue', lookupError);
      }

      const requestRef = await db.collection('tenantUsageRefreshRequests').add({
        tenantId: tenantAccess.tenantId,
        month: monthId,
        status: 'pending',
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        requestedBy: req.authContext?.uid ?? 'system',
        requestedByEmail: actorEmail ?? null,
        source: (req.headers['x-client-name'] as string) || 'mobile_admin_panel',
      });

      void logTenantAuditEventImpl({
        tenantId: tenantAccess.tenantId,
        action: 'usage_refresh_requested',
        authContext: req.authContext,
        targetId: requestRef.id,
        targetType: 'usage',
        metadata: {
          monthId,
          requestId: requestRef.id,
        },
      });

      return res.json({ ok: true, requestId: requestRef.id, month: monthId });
    } catch (error) {
      console.error('[usage_refresh_request] failed', error);
      return res.status(500).json({ error: 'usage_refresh_request_failed' });
    }
  });

  app.get('/billing/summary', requireAdminTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const planParam = typeof req.query.planId === 'string' ? req.query.planId : null;

    try {
      const db = getFirestoreImpl();
      const tenantSummary = await loadTenantAdminSummaryImpl(tenantAccess.tenantId);
      if (!tenantSummary) {
        return res.status(404).json({ error: 'tenant_not_found' });
      }

      const planLimits = planParam
        ? await (async () => {
            const normalizedPlanId = normalizePlanId(planParam);
            let limits = getPlanLimits(normalizedPlanId);

            // Keep /billing/summary?planId=<tier> consistent with canonical editable tier variants
            // (doc ids: 'free' | 'pro' | 'enterprise').
            try {
              const tierVariant = await getPlanVariantById(db, normalizedPlanId);
              const variantLimits = tierVariant?.planId === normalizedPlanId ? tierVariant.limits : undefined;
              if (variantLimits && typeof variantLimits === 'object') {
                const staffSeats = coerceNumber((variantLimits as any).staffSeats);
                const students = coerceNumber((variantLimits as any).students);
                const storageMb = coerceNumber((variantLimits as any).storageMb);

                const reminders = (variantLimits as any).reminders;
                const remindersTotal = coerceNumber(reminders?.total);
                const remindersWhatsapp = coerceNumber(reminders?.whatsapp);
                const remindersSms = coerceNumber(reminders?.sms);
                const remindersVoice = coerceNumber(reminders?.voice);
                const remindersEmail = coerceNumber(reminders?.email);

                limits = {
                  ...limits,
                  staffSeats:
                    typeof staffSeats === 'number' && staffSeats >= 0 ? Math.trunc(staffSeats) : limits.staffSeats,
                  students: typeof students === 'number' && students >= 0 ? Math.trunc(students) : limits.students,
                  reminders: {
                    ...limits.reminders,
                    total:
                      typeof remindersTotal === 'number' && remindersTotal >= 0
                        ? Math.trunc(remindersTotal)
                        : limits.reminders.total,
                    whatsapp:
                      typeof remindersWhatsapp === 'number' && remindersWhatsapp >= 0
                        ? Math.trunc(remindersWhatsapp)
                        : limits.reminders.whatsapp,
                    sms:
                      typeof remindersSms === 'number' && remindersSms >= 0 ? Math.trunc(remindersSms) : limits.reminders.sms,
                    voice:
                      typeof remindersVoice === 'number' && remindersVoice >= 0
                        ? Math.trunc(remindersVoice)
                        : limits.reminders.voice,
                    email:
                      typeof remindersEmail === 'number' && remindersEmail >= 0
                        ? Math.trunc(remindersEmail)
                        : limits.reminders.email,
                  },
                  storageBytes:
                    typeof storageMb === 'number' && storageMb >= 0 ? Math.round(storageMb * 1024 * 1024) : limits.storageBytes,
                };
              }
            } catch {
              // Ignore catalog lookup failures; fall back to defaults.
            }

            return limits;
          })()
        : await resolveEffectivePlanLimitsForTenant(db, tenantAccess.tenantId, {
            billingTier: tenantSummary.billingTier ?? null,
            quotas: tenantSummary.quotas ?? null,
          });
      const summary = await loadTenantBillingSummaryImpl(tenantAccess.tenantId, planLimits.id);
      return res.json(summary);
    } catch (error) {
      console.error('[billing_summary] failed', error);
      return res.status(500).json({ error: 'billing_summary_failed' });
    }
  });

  app.get('/billing/history', requireAdminTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const pageSizeParam = typeof req.query.pageSize === 'string' ? req.query.pageSize : null;
    const limitInvoicesParam = typeof req.query.limitInvoices === 'string' ? req.query.limitInvoices : null;
    const limitChangesParam = typeof req.query.limitChanges === 'string' ? req.query.limitChanges : null;
    const pageSize = Math.max(1, Math.min(200, Math.trunc(coerceNumber(pageSizeParam) ?? 10)));
    const limitInvoicesRaw = Math.trunc(coerceNumber(limitInvoicesParam) ?? pageSize);
    const limitChangesRaw = Math.trunc(coerceNumber(limitChangesParam) ?? pageSize);
    const limitInvoices = Math.max(0, Math.min(200, limitInvoicesRaw));
    const limitChanges = Math.max(0, Math.min(200, limitChangesRaw));

    const cursorInvoiceAt = typeof req.query.cursorInvoiceAt === 'string' ? req.query.cursorInvoiceAt : null;
    const cursorInvoiceId = typeof req.query.cursorInvoiceId === 'string' ? req.query.cursorInvoiceId : null;
    const cursorChangeAt = typeof req.query.cursorChangeAt === 'string' ? req.query.cursorChangeAt : null;
    const cursorChangeId = typeof req.query.cursorChangeId === 'string' ? req.query.cursorChangeId : null;

    const invoiceStatusParam = typeof req.query.invoiceStatus === 'string' ? req.query.invoiceStatus : null;
    const invoiceStatusRaw = invoiceStatusParam?.trim() || '';
    // Treat VOID as FAILED everywhere.
    // We still accept `invoiceStatus=void` for backward compatibility, but normalize it.
    const invoiceStatusNormalized = invoiceStatusRaw === 'void' ? 'failed' : invoiceStatusRaw;
    const invoiceStatus = (
      invoiceStatusNormalized === 'paid' ||
      invoiceStatusNormalized === 'open' ||
      invoiceStatusNormalized === 'failed' ||
      invoiceStatusNormalized === 'uncollectible'
        ? (invoiceStatusNormalized as BillingInvoiceRecord['status'])
        : undefined
    );

    const invoiceCursor = cursorInvoiceAt && cursorInvoiceId ? { at: cursorInvoiceAt, id: cursorInvoiceId } : undefined;
    const changeCursor = cursorChangeAt && cursorChangeId ? { at: cursorChangeAt, id: cursorChangeId } : undefined;

    const includeTotalsParam = typeof req.query.includeTotals === 'string' ? req.query.includeTotals : null;
    const includeTotals = includeTotalsParam === null ? false : includeTotalsParam !== '0';

    try {
      const db = getFirestoreImpl();

      const tenantSnap = await db.collection('tenants').doc(tenantAccess.tenantId).get().catch(() => null as any);
      const tenantData = tenantSnap && tenantSnap.exists ? (tenantSnap.data() as any) : null;
      const timeZoneRaw =
        tenantData && typeof tenantData.timeZone === 'string'
          ? tenantData.timeZone
          : tenantData && typeof tenantData.timezone === 'string'
            ? tenantData.timezone
            : '';
      const timeZone = (timeZoneRaw || '').trim() || 'Asia/Kolkata';

      const includeInvoiceTotals = includeTotals && limitInvoices > 0 && !invoiceCursor;
      const includeChangeTotals = includeTotals && limitChanges > 0 && !changeCursor;
      const includeInvoiceMatchingTotals = includeInvoiceTotals && Boolean(invoiceStatus);

      const [invoicePage, changePage, invoicesTotal, changesTotal, invoicesMatchingTotal] = await Promise.all([
        limitInvoices > 0
          ? loadBillingInvoicesPage(db, tenantAccess.tenantId, limitInvoices, invoiceCursor, { status: invoiceStatus })
          : Promise.resolve({ invoices: [] as BillingInvoiceRecord[], nextCursor: undefined }),
        limitChanges > 0
          ? loadTenantBillingAuditEntriesPage(db, tenantAccess.tenantId, limitChanges, changeCursor)
          : Promise.resolve({ changes: [] as BillingAuditEntryRecord[], nextCursor: undefined }),
        includeInvoiceTotals
          ? countTenantBillingInvoices(db, tenantAccess.tenantId).catch((error) => {
              console.warn('[billing_history] invoice totals failed', error);
              return undefined as unknown as number;
            })
          : Promise.resolve(undefined as unknown as number),
        includeChangeTotals
          ? countTenantBillingAuditEntries(db, tenantAccess.tenantId).catch((error) => {
              console.warn('[billing_history] change totals failed', error);
              return undefined as unknown as number;
            })
          : Promise.resolve(undefined as unknown as number),
        includeInvoiceMatchingTotals
          ? countTenantBillingInvoices(db, tenantAccess.tenantId, { status: invoiceStatus }).catch((error) => {
              console.warn('[billing_history] invoice matching totals failed', error);
              return undefined as unknown as number;
            })
          : Promise.resolve(undefined as unknown as number),
      ]);

      const totals: { invoices?: number; changes?: number } = {};
      if (includeInvoiceTotals && typeof invoicesTotal === 'number' && Number.isFinite(invoicesTotal)) {
        totals.invoices = Math.max(0, Math.trunc(invoicesTotal));
      }
      if (includeChangeTotals && typeof changesTotal === 'number' && Number.isFinite(changesTotal)) {
        totals.changes = Math.max(0, Math.trunc(changesTotal));
      }

      const matchingTotals: { invoices?: number; changes?: number } = {};
      if (
        includeInvoiceMatchingTotals &&
        typeof invoicesMatchingTotal === 'number' &&
        Number.isFinite(invoicesMatchingTotal)
      ) {
        matchingTotals.invoices = Math.max(0, Math.trunc(invoicesMatchingTotal));
      }

      return res.json({
        tenantId: tenantAccess.tenantId,
        timeZone,
        invoices: invoicePage.invoices,
        changes: changePage.changes,
        totals: Object.keys(totals).length ? totals : undefined,
        matchingTotals: Object.keys(matchingTotals).length ? matchingTotals : undefined,
        pageInfo: {
          invoices: { nextCursor: invoicePage.nextCursor },
          changes: { nextCursor: changePage.nextCursor },
        },
      } satisfies BillingHistoryRecord);
    } catch (error) {
      console.error('[billing_history] failed', error);
      return res.status(500).json({ error: 'billing_history_failed' });
    }
  });

  app.get('/billing/invoice/download-url', requireAdminTenantAccessFromQuery, async (req, res) => {
    const INVOICE_PDF_VERSION = 2;

    function resolveTenantTimeZone(tenantData: any): string {
      const raw =
        tenantData && typeof tenantData.timeZone === 'string'
          ? tenantData.timeZone
          : tenantData && typeof tenantData.timezone === 'string'
            ? tenantData.timezone
            : '';
      return (raw || '').trim() || 'Asia/Kolkata';
    }

    function computeInvoicePdfFingerprint(payload: Record<string, unknown>): string {
      const crypto = require('crypto') as typeof import('crypto');
      const serialized = JSON.stringify(payload);
      return crypto.createHash('sha256').update(serialized).digest('hex');
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = z
      .object({
        tenantId: z.string().trim().min(1),
        invoiceId: z.string().trim().min(1),
        force: z
          .preprocess((value) => {
            if (value === undefined || value === null) return undefined;
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value !== 0;
            if (typeof value === 'string') {
              const v = value.trim().toLowerCase();
              if (!v) return undefined;
              return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
            }
            return undefined;
          }, z.boolean().optional())
          .optional(),
      })
      .safeParse({
        tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : '',
        invoiceId: typeof req.query.invoiceId === 'string' ? req.query.invoiceId : '',
        force: (req.query as any).force,
      });

    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = tenantAccess.tenantId;
    if (parsed.data.tenantId !== tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    ensureFirebase();
    const bucketConfigured = typeof admin.app().options.storageBucket === 'string';
    if (!bucketConfigured) {
      return res.status(501).json({ error: 'storage_bucket_not_configured' });
    }
    const bucket = admin.storage().bucket();
    const db = getFirestoreImpl();

    try {
      const invoiceRef = db.collection('billingInvoices').doc(tenantId).collection('invoices').doc(parsed.data.invoiceId);
      const snap = await invoiceRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'invoice_not_found' });
      }

      const data = snap.data() || {};
      const existingUrl = typeof (data as any).downloadUrl === 'string' ? (data as any).downloadUrl.trim() : '';
      const existingPdfVersion = typeof (data as any).invoicePdfVersion === 'number' ? (data as any).invoicePdfVersion : null;
      const existingPdfFingerprint =
        typeof (data as any).invoicePdfFingerprint === 'string' ? String((data as any).invoicePdfFingerprint).trim() : '';
      const forceRegenerate = parsed.data.force === true;
      let shouldRegenerate = forceRegenerate || !existingUrl || existingPdfVersion !== INVOICE_PDF_VERSION;

      const amountInrRaw = (data as any).amountInr ?? (data as any).amount ?? 0;
      const amountInr = typeof amountInrRaw === 'number' && Number.isFinite(amountInrRaw) ? Math.round(amountInrRaw) : 0;

      const tenantSnap = await db.collection('tenants').doc(tenantId).get().catch(() => null as any);
      const tenantData = tenantSnap && tenantSnap.exists ? (tenantSnap.data() as any) : null;
      const timeZone = resolveTenantTimeZone(tenantData);
      const coachingName =
        tenantData && typeof tenantData.coachingName === 'string'
          ? tenantData.coachingName
          : tenantData && typeof tenantData.name === 'string'
            ? tenantData.name
            : undefined;

      const issuedAt = typeof (data as any).issuedAt === 'string' ? (data as any).issuedAt : undefined;
      const dueAt = typeof (data as any).dueAt === 'string' ? (data as any).dueAt : undefined;
      const updatedAt = toIsoTimestamp((data as any).updatedAt) ?? (snap.updateTime ? snap.updateTime.toDate().toISOString() : undefined);

      const billingPeriodStartRaw = typeof (data as any).billingPeriodStart === 'string' ? (data as any).billingPeriodStart : undefined;
      const billingPeriodEndRaw = typeof (data as any).billingPeriodEnd === 'string' ? (data as any).billingPeriodEnd : undefined;

      let billingPeriodStart: string | undefined = billingPeriodStartRaw;
      let billingPeriodEnd: string | undefined = billingPeriodEndRaw;
      if (!billingPeriodStart && !billingPeriodEnd) {
        const billingSnap = await db.collection('tenantBilling').doc(tenantId).get().catch(() => null as any);
        const billingData = billingSnap && billingSnap.exists ? (billingSnap.data() as any) : null;
        const renewalDate = billingData && typeof billingData.renewalDate === 'string' ? billingData.renewalDate : undefined;
        // Best-effort: use payment/issue date and next billing date.
        if (issuedAt) billingPeriodStart = issuedAt;
        if (renewalDate) billingPeriodEnd = renewalDate;
      }

      function formatInvoiceNumber(sequence: number, atIso?: string): string {
        const d = atIso ? new Date(atIso) : new Date();
        const year = Number.isFinite(d.getTime()) ? d.getFullYear() : new Date().getFullYear();
        return `INV-${year}-${String(Math.max(0, Math.trunc(sequence))).padStart(6, '0')}`;
      }

      // Ensure we have a human-friendly invoice number stored.
      const existingInvoiceNumber =
        typeof (data as any).invoiceNumber === 'string' && String((data as any).invoiceNumber).trim()
          ? String((data as any).invoiceNumber).trim()
          : '';

      const invoiceNumber = existingInvoiceNumber
        ? existingInvoiceNumber
        : await db.runTransaction(async (tx) => {
            const invSnap = await tx.get(invoiceRef);
            const invData = invSnap.data() || {};
            const already =
              typeof (invData as any).invoiceNumber === 'string' && String((invData as any).invoiceNumber).trim()
                ? String((invData as any).invoiceNumber).trim()
                : '';
            if (already) return already;

            const counterRef = db.collection('systemCounters').doc('invoiceNumber');
            const counterSnap = await tx.get(counterRef);
            const counterData = counterSnap.exists ? (counterSnap.data() as any) : {};
            const currentSeqRaw = counterData && typeof counterData.sequence === 'number' ? counterData.sequence : 0;
            const nextSeq = Math.max(0, Math.trunc(currentSeqRaw)) + 1;
            const nextNumber = formatInvoiceNumber(nextSeq, issuedAt);
            tx.set(counterRef, { sequence: nextSeq, updatedAt: new Date().toISOString() }, { merge: true });
            tx.set(invoiceRef, { invoiceNumber: nextNumber }, { merge: true });
            return nextNumber;
          });

      const invoicePdfInput = {
        tenantId,
        coachingName,
        invoiceId: snap.id,
        invoiceNumber,
        amountInr,
        status: typeof (data as any).status === 'string' ? (data as any).status : undefined,
        issuedAt,
        dueAt,
        updatedAt,
        authorizedAt: toIsoTimestamp((data as any).authorizedAt) ?? undefined,
        capturedAt: toIsoTimestamp((data as any).capturedAt) ?? undefined,
        failedAt: toIsoTimestamp((data as any).failedAt) ?? undefined,
        planId: typeof (data as any).planId === 'string' ? (data as any).planId : undefined,
        planVariantId: typeof (data as any).planVariantId === 'string' ? (data as any).planVariantId : undefined,
        couponCode: typeof (data as any).couponCode === 'string' ? (data as any).couponCode : undefined,
        payerEmail: typeof (data as any).payerEmail === 'string' ? (data as any).payerEmail : undefined,
        method: typeof (data as any).method === 'string' ? (data as any).method : undefined,
        cardLast4: typeof (data as any).cardLast4 === 'string' ? (data as any).cardLast4 : undefined,
        cardNetwork: typeof (data as any).cardNetwork === 'string' ? (data as any).cardNetwork : undefined,
        upiVpaMasked: typeof (data as any).upiVpaMasked === 'string' ? (data as any).upiVpaMasked : undefined,
        billingPeriodStart,
        billingPeriodEnd,
        provider: typeof (data as any).provider === 'string' ? (data as any).provider : undefined,
        providerPaymentId: typeof (data as any).providerPaymentId === 'string' ? (data as any).providerPaymentId : undefined,
        providerSubscriptionId:
          typeof (data as any).providerSubscriptionId === 'string' ? (data as any).providerSubscriptionId : undefined,
        subscriptionId: typeof (data as any).subscriptionId === 'string' ? (data as any).subscriptionId : undefined,
        timeZone,
      };

      const fingerprintPayload = {
        v: INVOICE_PDF_VERSION,
        invoice: invoicePdfInput,
      };
      const computedPdfFingerprint = computeInvoicePdfFingerprint(fingerprintPayload);
      if (!shouldRegenerate && computedPdfFingerprint && computedPdfFingerprint !== existingPdfFingerprint) {
        shouldRegenerate = true;
      }

      if (!shouldRegenerate) {
        const storedPathRaw = typeof (data as any).invoicePdfPath === 'string' ? String((data as any).invoicePdfPath).trim() : '';
        const storagePath = storedPathRaw || buildInvoiceStoragePath(tenantId, snap.id);
        const [exists] = await bucket.file(storagePath).exists().catch(() => [false as boolean]);
        if (exists) {
          // Refresh the token URL so the caller always receives a working link.
          const refreshed = await ensureInvoicePdfInStorage({
            bucket,
            tenantId,
            force: false,
            invoice: invoicePdfInput,
          });

          await invoiceRef.set(
            {
              downloadUrl: refreshed.downloadUrl,
              invoicePdfPath: refreshed.path,
              invoicePdfGeneratedAt: new Date().toISOString(),
              invoicePdfVersion: INVOICE_PDF_VERSION,
              invoicePdfFingerprint: computedPdfFingerprint,
              invoiceNumber,
              ...(billingPeriodStart ? { billingPeriodStart } : {}),
              ...(billingPeriodEnd ? { billingPeriodEnd } : {}),
            },
            { merge: true }
          );

          return res.json({ ok: true, downloadUrl: refreshed.downloadUrl });
        }
        shouldRegenerate = true;
      }

      const { downloadUrl, path } = await ensureInvoicePdfInStorage({
        bucket,
        tenantId,
        force: true,
        invoice: invoicePdfInput,
      });

      await invoiceRef.set(
        {
          downloadUrl,
          invoicePdfPath: path,
          invoicePdfGeneratedAt: new Date().toISOString(),
          invoicePdfVersion: INVOICE_PDF_VERSION,
          invoicePdfFingerprint: computedPdfFingerprint,
          invoiceNumber,
          ...(billingPeriodStart ? { billingPeriodStart } : {}),
          ...(billingPeriodEnd ? { billingPeriodEnd } : {}),
        },
        { merge: true }
      );

      return res.json({ ok: true, downloadUrl });
    } catch (error) {
      console.error('[billing_invoice_download_url] failed', error);
      return res.status(500).json({ error: 'billing_invoice_download_failed' });
    }
  });

  // Direct invoice PDF download (browser-friendly). Regenerates when missing/outdated.
  app.get('/billing/invoice/download', requireAdminTenantAccessFromQuery, async (req, res) => {
    const INVOICE_PDF_VERSION = 2;

    function resolveTenantTimeZone(tenantData: any): string {
      const raw =
        tenantData && typeof tenantData.timeZone === 'string'
          ? tenantData.timeZone
          : tenantData && typeof tenantData.timezone === 'string'
            ? tenantData.timezone
            : '';
      return (raw || '').trim() || 'Asia/Kolkata';
    }

    function computeInvoicePdfFingerprint(payload: Record<string, unknown>): string {
      const crypto = require('crypto') as typeof import('crypto');
      const serialized = JSON.stringify(payload);
      return crypto.createHash('sha256').update(serialized).digest('hex');
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = z
      .object({
        tenantId: z.string().trim().min(1),
        invoiceId: z.string().trim().min(1),
        force: z
          .preprocess((value) => {
            if (value === undefined || value === null) return undefined;
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value !== 0;
            if (typeof value === 'string') {
              const v = value.trim().toLowerCase();
              if (!v) return undefined;
              return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
            }
            return undefined;
          }, z.boolean().optional())
          .optional(),
      })
      .safeParse({
        tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : '',
        invoiceId: typeof req.query.invoiceId === 'string' ? req.query.invoiceId : '',
        force: (req.query as any).force,
      });

    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = tenantAccess.tenantId;
    if (parsed.data.tenantId !== tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    ensureFirebase();
    const bucketConfigured = typeof admin.app().options.storageBucket === 'string';
    if (!bucketConfigured) {
      return res.status(501).json({ error: 'storage_bucket_not_configured' });
    }

    const bucket = admin.storage().bucket();
    const db = getFirestoreImpl();

    try {
      const invoiceRef = db.collection('billingInvoices').doc(tenantId).collection('invoices').doc(parsed.data.invoiceId);
      const snap = await invoiceRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'invoice_not_found' });
      }

      const data = snap.data() || {};
      const existingPdfVersion = typeof (data as any).invoicePdfVersion === 'number' ? (data as any).invoicePdfVersion : null;
      const existingPdfFingerprint =
        typeof (data as any).invoicePdfFingerprint === 'string' ? String((data as any).invoicePdfFingerprint).trim() : '';
      const forceRegenerate = parsed.data.force === true;

      const amountInrRaw = (data as any).amountInr ?? (data as any).amount ?? 0;
      const amountInr = typeof amountInrRaw === 'number' && Number.isFinite(amountInrRaw) ? Math.round(amountInrRaw) : 0;

      const tenantSnap = await db.collection('tenants').doc(tenantId).get().catch(() => null as any);
      const tenantData = tenantSnap && tenantSnap.exists ? (tenantSnap.data() as any) : null;
      const timeZone = resolveTenantTimeZone(tenantData);
      const coachingName =
        tenantData && typeof tenantData.coachingName === 'string'
          ? tenantData.coachingName
          : tenantData && typeof tenantData.name === 'string'
            ? tenantData.name
            : undefined;

      const issuedAt = typeof (data as any).issuedAt === 'string' ? (data as any).issuedAt : undefined;
      const dueAt = typeof (data as any).dueAt === 'string' ? (data as any).dueAt : undefined;
      const updatedAt = toIsoTimestamp((data as any).updatedAt) ?? (snap.updateTime ? snap.updateTime.toDate().toISOString() : undefined);

      const billingPeriodStartRaw =
        typeof (data as any).billingPeriodStart === 'string' ? (data as any).billingPeriodStart : undefined;
      const billingPeriodEndRaw = typeof (data as any).billingPeriodEnd === 'string' ? (data as any).billingPeriodEnd : undefined;

      let billingPeriodStart: string | undefined = billingPeriodStartRaw;
      let billingPeriodEnd: string | undefined = billingPeriodEndRaw;
      if (!billingPeriodStart && !billingPeriodEnd) {
        const billingSnap = await db.collection('tenantBilling').doc(tenantId).get().catch(() => null as any);
        const billingData = billingSnap && billingSnap.exists ? (billingSnap.data() as any) : null;
        const renewalDate = billingData && typeof billingData.renewalDate === 'string' ? billingData.renewalDate : undefined;
        if (issuedAt) billingPeriodStart = issuedAt;
        if (renewalDate) billingPeriodEnd = renewalDate;
      }

      function formatInvoiceNumber(sequence: number, atIso?: string): string {
        const d = atIso ? new Date(atIso) : new Date();
        const year = Number.isFinite(d.getTime()) ? d.getFullYear() : new Date().getFullYear();
        return `INV-${year}-${String(Math.max(0, Math.trunc(sequence))).padStart(6, '0')}`;
      }

      const existingInvoiceNumber =
        typeof (data as any).invoiceNumber === 'string' && String((data as any).invoiceNumber).trim()
          ? String((data as any).invoiceNumber).trim()
          : '';

      const invoiceNumber = existingInvoiceNumber
        ? existingInvoiceNumber
        : await db.runTransaction(async (tx) => {
            const invSnap = await tx.get(invoiceRef);
            const invData = invSnap.data() || {};
            const already =
              typeof (invData as any).invoiceNumber === 'string' && String((invData as any).invoiceNumber).trim()
                ? String((invData as any).invoiceNumber).trim()
                : '';
            if (already) return already;

            const counterRef = db.collection('systemCounters').doc('invoiceNumber');
            const counterSnap = await tx.get(counterRef);
            const counterData = counterSnap.exists ? (counterSnap.data() as any) : {};
            const currentSeqRaw = counterData && typeof counterData.sequence === 'number' ? counterData.sequence : 0;
            const nextSeq = Math.max(0, Math.trunc(currentSeqRaw)) + 1;
            const nextNumber = formatInvoiceNumber(nextSeq, issuedAt);
            tx.set(counterRef, { sequence: nextSeq, updatedAt: new Date().toISOString() }, { merge: true });
            tx.set(invoiceRef, { invoiceNumber: nextNumber }, { merge: true });
            return nextNumber;
          });

      const invoicePdfInput = {
        tenantId,
        coachingName,
        invoiceId: snap.id,
        invoiceNumber,
        amountInr,
        status: typeof (data as any).status === 'string' ? (data as any).status : undefined,
        issuedAt,
        dueAt,
        updatedAt,
        authorizedAt: toIsoTimestamp((data as any).authorizedAt) ?? undefined,
        capturedAt: toIsoTimestamp((data as any).capturedAt) ?? undefined,
        failedAt: toIsoTimestamp((data as any).failedAt) ?? undefined,
        planId: typeof (data as any).planId === 'string' ? (data as any).planId : undefined,
        planVariantId: typeof (data as any).planVariantId === 'string' ? (data as any).planVariantId : undefined,
        couponCode: typeof (data as any).couponCode === 'string' ? (data as any).couponCode : undefined,
        payerEmail: typeof (data as any).payerEmail === 'string' ? (data as any).payerEmail : undefined,
        method: typeof (data as any).method === 'string' ? (data as any).method : undefined,
        cardLast4: typeof (data as any).cardLast4 === 'string' ? (data as any).cardLast4 : undefined,
        cardNetwork: typeof (data as any).cardNetwork === 'string' ? (data as any).cardNetwork : undefined,
        upiVpaMasked: typeof (data as any).upiVpaMasked === 'string' ? (data as any).upiVpaMasked : undefined,
        billingPeriodStart,
        billingPeriodEnd,
        provider: typeof (data as any).provider === 'string' ? (data as any).provider : undefined,
        providerPaymentId: typeof (data as any).providerPaymentId === 'string' ? (data as any).providerPaymentId : undefined,
        providerSubscriptionId:
          typeof (data as any).providerSubscriptionId === 'string' ? (data as any).providerSubscriptionId : undefined,
        subscriptionId: typeof (data as any).subscriptionId === 'string' ? (data as any).subscriptionId : undefined,
        timeZone,
      };

      const computedPdfFingerprint = computeInvoicePdfFingerprint({ v: INVOICE_PDF_VERSION, invoice: invoicePdfInput });

      const storedPathRaw = typeof (data as any).invoicePdfPath === 'string' ? String((data as any).invoicePdfPath).trim() : '';
      const storagePath = storedPathRaw || buildInvoiceStoragePath(tenantId, snap.id);
      const file = bucket.file(storagePath);
      const [exists] = await file.exists().catch(() => [false as boolean]);

      const shouldRegenerate =
        forceRegenerate ||
        !exists ||
        existingPdfVersion !== INVOICE_PDF_VERSION ||
        (computedPdfFingerprint && computedPdfFingerprint !== existingPdfFingerprint);
      if (shouldRegenerate) {
        const refreshed = await ensureInvoicePdfInStorage({
          bucket,
          tenantId,
          force: true,
          invoice: invoicePdfInput,
        });

        await invoiceRef.set(
          {
            downloadUrl: refreshed.downloadUrl,
            invoicePdfPath: refreshed.path,
            invoicePdfGeneratedAt: new Date().toISOString(),
            invoicePdfVersion: INVOICE_PDF_VERSION,
            invoicePdfFingerprint: computedPdfFingerprint,
            invoiceNumber,
            ...(billingPeriodStart ? { billingPeriodStart } : {}),
            ...(billingPeriodEnd ? { billingPeriodEnd } : {}),
          },
          { merge: true }
        );
      }

      const filename = `${invoiceNumber || snap.id}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

      const finalPath = shouldRegenerate ? buildInvoiceStoragePath(tenantId, snap.id) : storagePath;
      const finalFile = bucket.file(finalPath);

      const stream = finalFile.createReadStream();
      stream.on('error', (err) => {
        console.error('[billing_invoice_download] stream failed', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'billing_invoice_stream_failed' });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (error) {
      console.error('[billing_invoice_download] failed', error);
      return res.status(500).json({ error: 'billing_invoice_download_failed' });
    }
  });

  app.get('/billing/current', requireMemberTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    try {
      const tenantSummary = await loadTenantAdminSummaryImpl(tenantAccess.tenantId);
      const fallbackPlanId = getPlanLimits(tenantSummary?.billingTier ?? 'free').id;
      const current = await loadTenantCurrentBilling(getFirestoreImpl(), tenantAccess.tenantId, fallbackPlanId);
      return res.json(current);
    } catch (error) {
      console.error('[billing_current] failed', error);
      return res.status(500).json({ error: 'billing_current_failed' });
    }
  });

  app.get('/billing/catalog', async (req, res) => {
    try {
      const db = getFirestoreImpl();
      const configured = await listPlanVariants(db, { includeInactive: false });

      // Public catalog: expose Free + all active Pro variants.
      // Enterprise is intentionally hidden from the public catalog (sales-assisted / manual upgrade flow).
      const free = configured.find((entry) => entry.id === 'free') ?? builtInFreePlan();
      const proVariants = configured
        .filter((entry) => entry.planId === 'pro')
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

      return res.json({ plans: [free, ...proVariants] });
    } catch (error) {
      console.error('[billing_catalog] failed', error);
      return res.status(500).json({ error: 'billing_catalog_failed' });
    }
  });

  app.get('/billing/catalog/admin', requireOperatorAuth, async (req, res) => {
    try {
      const db = getFirestoreImpl();
      const plans = await listPlanVariants(db, { includeInactive: true });
      const coupons = await listCoupons(db, { includeInactive: true });
      const hasFree = plans.some((entry) => entry.id === 'free');
      const allPlans = hasFree ? plans : [builtInFreePlan(), ...plans];
      return res.json({ plans: allPlans, coupons });
    } catch (error) {
      console.error('[billing_catalog_admin] failed', error);
      return res.status(500).json({ error: 'billing_catalog_admin_failed' });
    }
  });

  app.post('/billing/catalog/admin/plans/upsert', requireOperatorAuth, async (req, res) => {
    const parsed = billingPlanVariantUpsertSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    try {
      const db = getFirestoreImpl();
      const payload = parsed.data;
      const isFreePlan = payload.id === 'free' || payload.planId === 'free';
      const upsertPayload: Parameters<typeof upsertPlanVariant>[1] = {
        id: payload.id,
        planId: isFreePlan ? 'free' : payload.planId,
        displayName: payload.displayName,
        currency: 'INR',
        priceInr: isFreePlan ? 0 : payload.priceInr,
        interval: payload.interval,
        provider: payload.provider,
        limits: payload.limits,
        applyChangesMode: isFreePlan ? 'immediate' : payload.applyChangesMode,
        decreasePolicy: payload.decreasePolicy,
        active: isFreePlan ? true : payload.active,
        sortOrder: isFreePlan ? 0 : payload.sortOrder,
      };

      if (!isFreePlan && typeof payload.razorpayPlanId === 'string' && payload.razorpayPlanId.trim()) {
        upsertPayload.razorpayPlanId = payload.razorpayPlanId;
      }

      if (!isFreePlan && typeof payload.playProductId === 'string' && payload.playProductId.trim()) {
        (upsertPayload as any).playProductId = payload.playProductId;
      }

      await upsertPlanVariant(db, upsertPayload);

      // Return the saved record so the admin console can confirm persistence.
      const saved = await getPlanVariantById(db, upsertPayload.id);
      return res.json({ ok: true, plan: saved });
    } catch (error) {
      console.error('[billing_catalog_plan_upsert] failed', error);
      return res.status(500).json({ error: 'billing_catalog_plan_upsert_failed' });
    }
  });

  app.post('/billing/catalog/admin/coupons/upsert', requireOperatorAuth, async (req, res) => {
    const parsed = billingCouponUpsertSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }
    try {
      const db = getFirestoreImpl();
      const payload = parsed.data;
      await upsertCoupon(db, {
        id: payload.id,
        code: payload.code,
        mapsToPlanVariantId: payload.mapsToPlanVariantId,
        active: payload.active,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
      });
      return res.json({ ok: true });
    } catch (error) {
      console.error('[billing_catalog_coupon_upsert] failed', error);
      return res.status(500).json({ error: 'billing_catalog_coupon_upsert_failed' });
    }
  });

  // Backfill tenantBilling.limitsSnapshot so next_billing (and soft decrease) behavior can work
  // immediately for existing paid tenants (before their next renewal webhook).
  app.post('/billing/admin/limits-snapshot/backfill', requireOperatorAuth, async (req, res) => {
    const parsed = billingLimitsSnapshotBackfillSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const dryRun = payload.confirm ? false : payload.dryRun ?? true;
    const force = payload.force === true;
    const limit = typeof payload.limit === 'number' ? payload.limit : 200;

    try {
      const db = getFirestoreImpl();

      let docs: Array<admin.firestore.DocumentSnapshot<admin.firestore.DocumentData> & { ref?: any }> = [];
      if (payload.tenantId) {
        const ref = db.collection('tenantBilling').doc(payload.tenantId);
        const snap = await ref.get();
        // Align with query snapshots that provide ref.
        (snap as any).ref = ref;
        docs = [snap as any];
      } else {
        let query: any = db.collection('tenantBilling');
        if (limit) {
          query = query.limit(limit);
        }
        const snap = await query.get();
        docs = (snap?.docs || []) as any;
      }

      let scanned = 0;
      let skippedFree = 0;
      let skippedExisting = 0;
      let updated = 0;
      let errors = 0;
      const errorSamples: Array<{ tenantId: string; error: string }> = [];

      for (const docSnap of docs) {
        scanned += 1;
        const tenantId = docSnap.id;
        const data = (docSnap.exists ? docSnap.data() || {} : {}) as Record<string, any>;

        const planId = normalizePlanId(data.planId ?? data.plan);
        if (planId === 'free') {
          skippedFree += 1;
          continue;
        }

        const hasSnapshot = Boolean(data.limitsSnapshot && typeof data.limitsSnapshot === 'object');
        if (hasSnapshot && !force) {
          skippedExisting += 1;
          continue;
        }

        const planVariantId = typeof data.planVariantId === 'string' && data.planVariantId.trim() ? data.planVariantId.trim() : null;

        try {
          const resolved = await resolvePlanLimitsFromCatalog(db, { planId, planVariantId });
          const limitsSnapshot = toTenantBillingLimitsSnapshot(resolved);
          if (!dryRun) {
            const ref = (docSnap as any).ref || db.collection('tenantBilling').doc(tenantId);
            await ref.set(
              {
                limitsSnapshot,
                limitsSnapshotAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
          updated += 1;
        } catch (error: any) {
          errors += 1;
          if (errorSamples.length < 5) {
            errorSamples.push({ tenantId, error: String(error?.message || error) });
          }
        }
      }

      return res.json({
        ok: true,
        dryRun,
        force,
        limit: payload.tenantId ? 1 : limit,
        scanned,
        updated,
        skippedFree,
        skippedExisting,
        errors,
        errorSamples,
      });
    } catch (error) {
      console.error('[billing_limits_snapshot_backfill] failed', error);
      return res.status(500).json({ error: 'billing_limits_snapshot_backfill_failed' });
    }
  });

  // Manual backfill trigger for a single tenant.
  // Runs the Razorpay reconciliation flow (subscription + payments) and upserts invoices + billing state.
  app.post('/billing/admin/backfill', requireOperatorAuth, async (req, res) => {
    const parsed = billingTenantBackfillSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const dryRun = payload.confirm ? false : payload.dryRun ?? true;
    const verbose = payload.verbose === true;
    const maxPaymentsPerSubscription =
      typeof payload.maxPaymentsPerSubscription === 'number' ? payload.maxPaymentsPerSubscription : 200;
    const jobLabel = payload.jobLabel || 'manual_api';

    try {
      const db = getFirestoreImpl();
      const runnerId = req.authContext?.uid || 'operator_api';

      const stats = await runBillingBackfill(db, {
        tenantIds: [payload.tenantId],
        maxPaymentsPerSubscription,
        dryRun,
        verbose,
        jobLabel,
        runnerId,
      });

      return res.json({
        ok: true,
        dryRun,
        runId: stats.runId,
        tenantsProcessed: stats.tenantsProcessed,
        invoicesUpserted: stats.invoicesUpserted,
        invoicesPatched: stats.invoicesPatched,
        billingDocsUpdated: stats.billingDocsUpdated,
        tenantDocsUpdated: stats.tenantDocsUpdated,
        reconciliation: stats.reconciliation,
        reconciliationTenantsPreview: stats.reconciliationTenantsPreview,
        errors: stats.errors.length,
        errorsPreview: stats.errors.slice(0, 10),
      });
    } catch (error) {
      console.error('[billing_manual_backfill] failed', error);
      return res.status(500).json({ error: 'billing_manual_backfill_failed' });
    }
  });

  app.get('/billing/admin/ops-events', requireOperatorAuth, async (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : '';
    const beforeRaw = typeof req.query.before === 'string' ? req.query.before : '';
    const tenantIdRaw = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';

    const limit = Math.max(1, Math.min(200, Number(limitRaw || '50') || 50));
    const before = beforeRaw && beforeRaw.trim() ? beforeRaw.trim() : null;
    const tenantId = tenantIdRaw && tenantIdRaw.trim() ? tenantIdRaw.trim() : null;

    try {
      const db = getFirestoreImpl();
      const fetchLimit = tenantId ? Math.min(500, limit * 5) : limit;
      let query: FirebaseFirestore.Query = db.collection('billingOpsEvents');
      if (before) {
        query = query.where('createdAtIso', '<', before);
      }
      query = query.orderBy('createdAtIso', 'desc').limit(fetchLimit);
      const snap = await query.get();
      let items = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) }));
      if (tenantId) {
        items = items.filter((row) => row.tenantId === tenantId);
      }
      items = items.slice(0, limit);
      const nextCursor = items.length > 0 ? (items[items.length - 1] as any).createdAtIso || null : null;
      return res.json({ ok: true, items, nextCursor });
    } catch (error) {
      console.error('[billing_ops_events_list] failed', error);
      return res.status(500).json({ error: 'billing_ops_events_list_failed' });
    }
  });

  app.get('/billing/admin/backfill/runs', requireOperatorAuth, async (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : '';
    const beforeRaw = typeof req.query.before === 'string' ? req.query.before : '';

    const limit = Math.max(1, Math.min(200, Number(limitRaw || '50') || 50));
    const before = beforeRaw && beforeRaw.trim() ? beforeRaw.trim() : null;

    try {
      const db = getFirestoreImpl();
      let query: FirebaseFirestore.Query = db.collection('billingBackfillRuns');
      if (before) {
        query = query.where('startedAtIso', '<', before);
      }
      query = query.orderBy('startedAtIso', 'desc').limit(limit);
      const snap = await query.get();
      const items = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) }));
      const nextCursor = items.length > 0 ? (items[items.length - 1] as any).startedAtIso || null : null;
      return res.json({ ok: true, items, nextCursor });
    } catch (error) {
      console.error('[billing_backfill_runs_list] failed', error);
      return res.status(500).json({ error: 'billing_backfill_runs_list_failed' });
    }
  });

  app.post('/billing/checkout', requireAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = billingCheckoutSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const payload = parsed.data;
    if (payload.tenantId && payload.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    const planId = normalizePlanId(payload.planId);
    const provider = payload.provider ?? 'razorpay';
    if (provider !== 'razorpay') {
      return res.status(400).json({ error: 'provider_not_supported', message: 'Only Razorpay is supported.' });
    }
    const baseCheckoutUrl = process.env.BILLING_CHECKOUT_BASE_URL || 'https://billing.tuitionmanager.app/checkout';

    try {
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const actorUid = req.authContext?.uid || null;
      const actorRole = tenantAccess.role;
      const actorMembershipId = tenantAccess.membershipId;

      // IMPORTANT: Avoid creating duplicate Razorpay subscriptions.
      // 1) If a checkout is already in progress (lock is active), return the existing checkout URL.
      // 2) If this tenant already has a pending Razorpay subscription/attempt (checkoutRequired=true),
      //    reuse the existing attempt/session (or create a new hosted checkout session pointing to the same
      //    Razorpay subscription id) instead of creating a new subscription.
      const db = getFirestoreImpl();
      const nowIso = new Date().toISOString();
      const lockRef = db.collection('billingCheckoutLocks').doc(tenantAccess.tenantId);
      const billingRef = db.collection('tenantBilling').doc(tenantAccess.tenantId);

      const [existingLockSnap, billingSnap] = await Promise.all([lockRef.get(), billingRef.get()]);
      if (existingLockSnap && existingLockSnap.exists) {
        const existing = (existingLockSnap.data && existingLockSnap.data()) || {};
        const existingExpiresAt = typeof existing.expiresAt === 'string' ? existing.expiresAt : '';
        if (existingExpiresAt && existingExpiresAt > nowIso) {
          return res.status(409).json({
            error: 'billing_checkout_in_progress',
            message: 'Another admin has already started a payment for this coaching center. Please wait for it to complete.',
            ...(typeof existing.sessionId === 'string' && existing.sessionId ? { sessionId: existing.sessionId } : {}),
            ...(typeof existing.checkoutUrl === 'string' && existing.checkoutUrl ? { checkoutUrl: existing.checkoutUrl } : {}),
            expiresAt: existingExpiresAt,
            ...(typeof existing.startedByEmail === 'string' && existing.startedByEmail ? { startedByEmail: existing.startedByEmail } : {}),
          });
        }
      }

      const billing = billingSnap.exists ? billingSnap.data() || {} : {};
      const existingBillingProvider =
        typeof (billing as any).billingProvider === 'string' ? String((billing as any).billingProvider).toLowerCase() : '';
      const existingCheckoutRequired = (billing as any).checkoutRequired === true;
      const existingSubscriptionId =
        typeof (billing as any).subscriptionId === 'string' ? String((billing as any).subscriptionId).trim() : '';
      const existingRazorpayKeyId =
        typeof (billing as any).razorpayKeyId === 'string' ? String((billing as any).razorpayKeyId).trim() : '';
      const envRazorpayKeyId = (process.env.RAZORPAY_KEY_ID || '').trim();
      const existingBillingAttemptId =
        typeof (billing as any).billingAttemptId === 'string' ? String((billing as any).billingAttemptId).trim() : '';
      const pendingPlanVariantId =
        typeof (billing as any).pendingPlanVariantId === 'string' ? String((billing as any).pendingPlanVariantId).trim() : '';
      const requestedPlanVariantId = typeof payload.planVariantId === 'string' ? payload.planVariantId.trim() : '';

      let canReuseExistingPendingSubscription =
        provider === 'razorpay' &&
        existingCheckoutRequired &&
        existingBillingProvider === 'razorpay' &&
        Boolean(existingSubscriptionId) &&
        // Only reuse automatically if the caller isn't trying to change variants.
        (!requestedPlanVariantId || !pendingPlanVariantId || requestedPlanVariantId === pendingPlanVariantId);

      // If billing state was created under a different Razorpay key (test vs live), do not reuse.
      // Reusing a subscription created in one environment with a key from another will cause
      // checkout.js to fail with 400 "Invalid request payload".
      if (canReuseExistingPendingSubscription && existingRazorpayKeyId && envRazorpayKeyId && existingRazorpayKeyId !== envRazorpayKeyId) {
        canReuseExistingPendingSubscription = false;
      }

      // If we can't verify the subscription in the current Razorpay environment, clear stale pending
      // markers so a fresh subscription can be created.
      if (canReuseExistingPendingSubscription) {
        let subscriptionExists = true;
        try {
          await fetchRazorpaySubscription({ subscriptionId: existingSubscriptionId });
        } catch {
          subscriptionExists = false;
        }

        if (!subscriptionExists) {
          canReuseExistingPendingSubscription = false;
          try {
            await billingRef.set(
              {
                checkoutRequired: false,
                checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
                checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
                billingAttemptId: admin.firestore.FieldValue.delete(),
                subscriptionId: admin.firestore.FieldValue.delete(),
                pendingPlanVariantId: admin.firestore.FieldValue.delete(),
                pendingPlanId: admin.firestore.FieldValue.delete(),
                pendingCouponCode: admin.firestore.FieldValue.delete(),
                razorpayKeyId: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          } catch {
            // Best-effort cleanup; proceed to create a new subscription regardless.
          }
        }
      }

      if (canReuseExistingPendingSubscription) {
        const lockTtlMinutesRaw = Number.parseInt((process.env.BILLING_CHECKOUT_LOCK_TTL_MINUTES || '').trim() || '15', 10);
        const lockTtlMinutes = Number.isFinite(lockTtlMinutesRaw)
          ? Math.max(1, Math.min(120, lockTtlMinutesRaw))
          : 15;
        const reuseMinCreatedAtIso = new Date(Date.now() - lockTtlMinutes * 60 * 1000).toISOString();

        // If we still have the original checkout session url, return it as-is.
        if (existingBillingAttemptId) {
          const existingSessionSnap = await db.collection('billingCheckoutSessions').doc(existingBillingAttemptId).get();
          const existingSession = existingSessionSnap.exists ? existingSessionSnap.data() || {} : {};
          const existingCheckoutUrl = typeof (existingSession as any).checkoutUrl === 'string' ? (existingSession as any).checkoutUrl.trim() : '';
          const existingCreatedAt = typeof (existingSession as any).createdAt === 'string' ? String((existingSession as any).createdAt).trim() : '';
          // Only reuse a recent session URL; older sessions commonly show checkout_session_expired.
          if (existingCheckoutUrl && (!existingCreatedAt || existingCreatedAt >= reuseMinCreatedAtIso)) {
            return res.json({
              checkoutUrl: existingCheckoutUrl,
              provider: 'razorpay',
              sessionId: existingBillingAttemptId,
              providerSessionId: existingSubscriptionId,
            });
          }
        }

        // Otherwise, create a new hosted checkout session that points to the SAME Razorpay subscription id.
        // This avoids creating duplicate subscriptions when the tenant is already in an authenticated/pending state.
        const sessionRef = db.collection('billingCheckoutSessions').doc();
        const sessionId = sessionRef.id;
        const billingAttemptId = sessionId;

        const preferHostedCheckout =
          provider === 'razorpay' && Boolean(payload.successUrl || payload.cancelUrl) && Boolean(baseCheckoutUrl);
        const checkoutUrl = `${baseCheckoutUrl}?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(
          tenantAccess.tenantId
        )}`;

        const expiresAtIso = new Date(Date.now() + lockTtlMinutes * 60 * 1000).toISOString();

        const effectiveReusePlanId =
          typeof (billing as any).pendingPlanId === 'string' && String((billing as any).pendingPlanId).trim()
            ? normalizePlanId(String((billing as any).pendingPlanId))
            : planId;

        const record: BillingCheckoutSessionRecord = {
          tenantId: tenantAccess.tenantId,
          planId: effectiveReusePlanId,
          provider,
          ...(payload.successUrl ? { successUrl: payload.successUrl } : {}),
          ...(payload.cancelUrl ? { cancelUrl: payload.cancelUrl } : {}),
          metadata: {
            ...(payload.metadata || {}),
            ...(existingRazorpayKeyId || envRazorpayKeyId ? { razorpayKeyId: existingRazorpayKeyId || envRazorpayKeyId } : {}),
            razorpaySubscriptionId: existingSubscriptionId,
            ...(pendingPlanVariantId ? { planVariantId: pendingPlanVariantId } : {}),
            planId: effectiveReusePlanId,
          },
          createdAt: nowIso,
          createdBy: req.authContext?.uid || 'system',
          ...(actorEmail ? { createdByEmail: actorEmail } : {}),
          status: 'pending',
        };

        if (!preferHostedCheckout) {
          // For now, always return hosted checkout URL; it is the only flow we can safely reuse without provider calls.
          // (If this ever needs to support non-hosted flows, add a provider-side retry link fetcher.)
        }

        await Promise.all([
          sessionRef.set({ ...record, checkoutUrl }, { merge: false }),
          lockRef.set(
            {
              tenantId: tenantAccess.tenantId,
              provider,
              planId: effectiveReusePlanId,
              sessionId,
              checkoutUrl,
              startedAt: nowIso,
              expiresAt: expiresAtIso,
              startedBy: req.authContext?.uid || 'system',
              ...(actorEmail ? { startedByEmail: actorEmail } : {}),
              providerSessionId: existingSubscriptionId,
              billingAttemptId,
            },
            { merge: false }
          ),
        ]);

        void logTenantAuditEventImpl({
          tenantId: tenantAccess.tenantId,
          action: 'billing_checkout_started',
          authContext: req.authContext,
          metadata: {
            provider,
            planId: effectiveReusePlanId,
            sessionId,
            actorRole,
            actorMembershipId,
            razorpaySubscriptionId: existingSubscriptionId,
            reused: true,
            ...(existingBillingAttemptId ? { reusedFromSessionId: existingBillingAttemptId } : {}),
          },
          targetId: sessionId,
          targetType: 'billing',
        });

        return res.json({
          checkoutUrl,
          provider,
          sessionId,
          providerSessionId: existingSubscriptionId,
        });
      }

      if (provider === 'razorpay' && planId === 'free') {
        return res.status(400).json({ error: 'invalid_plan', message: 'Free plan does not require checkout' });
      }

      let razorpaySubscription:
        | {
            subscriptionId: string;
            shortUrl?: string;
          }
        | undefined;

      if (provider === 'razorpay') {
        try {
          const db = getFirestoreImpl();
          const activePlans = await listPlanVariants(db, { includeInactive: false });
          if (!activePlans.length) {
            return res.status(503).json({ error: 'billing_catalog_unconfigured' });
          }
          const coupons = await listCoupons(db, { includeInactive: false });

          let selectedVariant = payload.planVariantId
            ? activePlans.find((entry) => entry.id === payload.planVariantId)
            : // If caller only specifies planId (recommended long-term), default to canonical variant id === planId.
              (planId !== 'free' ? activePlans.find((entry) => entry.id === planId) : undefined);

          if (!selectedVariant && !payload.couponCode) {
            return res.status(400).json({ error: 'plan_variant_required' });
          }

          if (!selectedVariant) {
            // If coupon is present, it may resolve to a variant below.
            if (!payload.couponCode) {
              return res.status(400).json({ error: 'invalid_plan_variant' });
            }
          }

          const resolvedCoupon = resolveCouponCode(coupons, payload.couponCode);
          if (resolvedCoupon) {
            const mapped = activePlans.find((entry) => entry.id === resolvedCoupon.mapsToPlanVariantId);
            if (!mapped || !mapped.active) {
              return res.status(400).json({ error: 'invalid_coupon' });
            }
            selectedVariant = mapped;
          } else if (payload.couponCode) {
            return res.status(400).json({ error: 'invalid_coupon' });
          }

          if (!selectedVariant) {
            return res.status(400).json({ error: 'invalid_plan_variant' });
          }

          if (selectedVariant.planId === 'free') {
            return res.status(400).json({ error: 'invalid_plan', message: 'Free plan does not require checkout' });
          }

          const razorpayPlanIdOverride = selectedVariant.razorpayPlanId;
          if (!razorpayPlanIdOverride) {
            return res.status(503).json({ error: 'razorpay_unconfigured', message: 'Missing Razorpay plan mapping' });
          }

          const created = await createRazorpaySubscriptionImpl({
            tenantId: tenantAccess.tenantId,
            planId: selectedVariant.planId,
            planVariantId: selectedVariant.id,
            couponCode: resolvedCoupon?.code,
            razorpayPlanIdOverride,
            customerEmail: actorEmail || null,
            notes: {
              createdByEmail: actorEmail || 'unknown',
              ...(actorUid ? { createdByUid: actorUid } : {}),
              createdByRole: actorRole,
              ...(actorMembershipId ? { createdByMembershipId: actorMembershipId } : {}),
            },
          });
          razorpaySubscription = { subscriptionId: created.subscriptionId, shortUrl: created.shortUrl };

          // Store the effective selection in metadata for future reconciliation.
          payload.metadata = {
            ...(payload.metadata || {}),
            planVariantId: selectedVariant.id,
            planId: selectedVariant.planId,
            ...(resolvedCoupon?.code ? { couponCode: resolvedCoupon.code } : {}),
          };
        } catch (error) {
          console.error('[billing_checkout] razorpay subscription create failed', error);
          return res.status(503).json({ error: 'razorpay_unconfigured' });
        }
      }

      const effectivePlanId =
        provider === 'razorpay' && payload.metadata && typeof payload.metadata.planId === 'string'
          ? normalizePlanId(payload.metadata.planId)
          : planId;

      const razorpayKeyIdAtCreation = provider === 'razorpay' ? (process.env.RAZORPAY_KEY_ID || '').trim() : '';

      // Note: nowIso is already computed above (used for lock/pending reuse checks).
      const record: BillingCheckoutSessionRecord = {
        tenantId: tenantAccess.tenantId,
        planId: effectivePlanId,
        provider,
        ...(payload.successUrl ? { successUrl: payload.successUrl } : {}),
        ...(payload.cancelUrl ? { cancelUrl: payload.cancelUrl } : {}),
        ...(() => {
          const metadata = {
            ...(payload.metadata || {}),
            ...(razorpayKeyIdAtCreation ? { razorpayKeyId: razorpayKeyIdAtCreation } : {}),
            ...(razorpaySubscription?.subscriptionId ? { razorpaySubscriptionId: razorpaySubscription.subscriptionId } : {}),
          };
          return Object.keys(metadata).length ? { metadata } : {};
        })(),
        createdAt: nowIso,
        createdBy: req.authContext?.uid || 'system',
        ...(actorEmail ? { createdByEmail: actorEmail } : {}),
        status: 'pending',
      };
      // db is already initialized above.

      const lockTtlMinutesRaw = Number.parseInt((process.env.BILLING_CHECKOUT_LOCK_TTL_MINUTES || '').trim() || '15', 10);
      const lockTtlMinutes = Number.isFinite(lockTtlMinutesRaw)
        ? Math.max(1, Math.min(120, lockTtlMinutesRaw))
        : 15;
      const expiresAtIso = new Date(Date.now() + lockTtlMinutes * 60 * 1000).toISOString();

      // lockRef and billingRef are already initialized above.
      const result = await db.runTransaction(async (tx: any) => {
        const existingSnap = await tx.get(lockRef);
        if (existingSnap && existingSnap.exists) {
          const existing = (existingSnap.data && existingSnap.data()) || {};
          const existingExpiresAt = typeof existing.expiresAt === 'string' ? existing.expiresAt : '';
          if (existingExpiresAt && existingExpiresAt > nowIso) {
            return {
              locked: true as const,
              sessionId: typeof existing.sessionId === 'string' ? existing.sessionId : null,
              checkoutUrl: typeof existing.checkoutUrl === 'string' ? existing.checkoutUrl : null,
              expiresAt: existingExpiresAt,
              startedByEmail: typeof existing.startedByEmail === 'string' ? existing.startedByEmail : null,
            };
          }
        }

        // Generate a Firestore doc id without writing.
        const sessionRef = db.collection('billingCheckoutSessions').doc();
        const sessionId = sessionRef.id;
        const billingAttemptId = sessionId;

        const preferHostedCheckout =
          provider === 'razorpay' && Boolean(payload.successUrl || payload.cancelUrl) && Boolean(baseCheckoutUrl);

        const checkoutUrl = preferHostedCheckout
          ? `${baseCheckoutUrl}?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(tenantAccess.tenantId)}`
          : provider === 'razorpay' && razorpaySubscription?.shortUrl
            ? razorpaySubscription.shortUrl
            : `${baseCheckoutUrl}?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(
                tenantAccess.tenantId
              )}&planId=${planId}`;

        tx.set(sessionRef, { ...record, checkoutUrl }, { merge: false });
        tx.set(
          lockRef,
          {
            tenantId: tenantAccess.tenantId,
            provider,
            planId: effectivePlanId,
            sessionId,
            checkoutUrl,
            startedAt: nowIso,
            expiresAt: expiresAtIso,
            startedBy: req.authContext?.uid || 'system',
            ...(actorEmail ? { startedByEmail: actorEmail } : {}),
            ...(razorpaySubscription?.subscriptionId ? { providerSessionId: razorpaySubscription.subscriptionId } : {}),
            billingAttemptId,
          },
          { merge: false }
        );

        // Persist a durable "payment pending" marker so:
        // - the app can show a banner without invoice scans,
        // - the 24h stale-pending sweeper can cancel this subscription if no payment occurs.
        if (provider === 'razorpay' && effectivePlanId !== 'free') {
          tx.set(
            billingRef,
            stripUndefinedDeep({
              checkoutRequired: true,
              checkoutRequiredProvider: 'razorpay',
              checkoutRequiredSinceIso: nowIso,
              billingAttemptId,
              billingProvider: 'razorpay',
              ...(razorpayKeyIdAtCreation ? { razorpayKeyId: razorpayKeyIdAtCreation } : {}),
              ...(razorpaySubscription?.subscriptionId ? { subscriptionId: razorpaySubscription.subscriptionId } : {}),
              // Best-effort: remember plan intent for history/debugging.
              ...(payload.metadata && typeof payload.metadata.planVariantId === 'string' ? { pendingPlanVariantId: payload.metadata.planVariantId } : {}),
              ...(payload.metadata && typeof payload.metadata.planId === 'string' ? { pendingPlanId: payload.metadata.planId } : {}),
              ...(payload.metadata && typeof payload.metadata.couponCode === 'string' ? { pendingCouponCode: payload.metadata.couponCode } : {}),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }),
            { merge: true }
          );
        }
        return { locked: false as const, sessionId, checkoutUrl };
      });

      if (result.locked) {
        return res.status(409).json({
          error: 'billing_checkout_in_progress',
          message: 'Another admin has already started a payment for this coaching center. Please wait for it to complete.',
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.checkoutUrl ? { checkoutUrl: result.checkoutUrl } : {}),
          expiresAt: result.expiresAt,
          ...(result.startedByEmail ? { startedByEmail: result.startedByEmail } : {}),
        });
      }

      void logTenantAuditEventImpl({
        tenantId: tenantAccess.tenantId,
        action: 'billing_checkout_started',
        authContext: req.authContext,
        metadata: {
          provider,
          planId,
          sessionId: result.sessionId,
          actorRole,
          actorMembershipId,
          ...(razorpaySubscription?.subscriptionId ? { razorpaySubscriptionId: razorpaySubscription.subscriptionId } : {}),
        },
        targetId: result.sessionId,
        targetType: 'billing',
      });
      return res.json({
        checkoutUrl: result.checkoutUrl,
        provider,
        sessionId: result.sessionId,
        ...(razorpaySubscription?.subscriptionId ? { providerSessionId: razorpaySubscription.subscriptionId } : {}),
      });
    } catch (error) {
      console.error('[billing_checkout] failed', error);
      return res.status(500).json({ error: 'checkout_init_failed' });
    }
  });

  // Returns a Razorpay management link (short_url) for the existing subscription, if present.
  // This is used for "Update payment method" / "Retry" flows without creating a new subscription.
  app.post('/billing/manage-link', requireAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = billingManageLinkSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    if (tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const db = getFirestoreImpl();
      const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
      const billing = billingSnap.exists ? billingSnap.data() || {} : {};

      const providerRaw =
        typeof (billing as any).billingProvider === 'string' ? String((billing as any).billingProvider).trim().toLowerCase() : '';

      if (providerRaw === 'google_play') {
        return res.status(409).json({
          error: 'google_play_manage_required',
          message:
            'This subscription is managed by Google Play. Please use the mobile app / Google Play to update payment method, cancel, or change your subscription, then refresh billing.',
        });
      }

      // Backward compatibility: allow missing provider for older billing records.
      // Only block if provider is explicitly set to a non-Razorpay value.
      if (providerRaw && providerRaw !== 'razorpay') {
        return res.status(409).json({ error: 'billing_provider_missing' });
      }

      let subscriptionId = typeof (billing as any).subscriptionId === 'string' ? String((billing as any).subscriptionId).trim() : '';

      // Best-effort fallback: derive subscription id from the latest billing attempt session metadata.
      if (!subscriptionId) {
        const billingAttemptId =
          typeof (billing as any).billingAttemptId === 'string' ? String((billing as any).billingAttemptId).trim() : '';
        if (billingAttemptId) {
          const sessionSnap = await db.collection('billingCheckoutSessions').doc(billingAttemptId).get();
          const session = sessionSnap.exists ? sessionSnap.data() || {} : {};
          const meta = (session as any).metadata || {};
          const fromMeta = typeof meta.razorpaySubscriptionId === 'string' ? String(meta.razorpaySubscriptionId).trim() : '';
          if (fromMeta) {
            subscriptionId = fromMeta;
          }
        }
      }

      if (!subscriptionId) {
        return res.status(409).json({ error: 'subscription_missing' });
      }

      const fetched = await fetchRazorpaySubscription({ subscriptionId });
      const url = (fetched.shortUrl || '').trim();
      if (!url) {
        return res.status(404).json({ error: 'manage_link_unavailable' });
      }

      void logTenantAuditEventImpl({
        tenantId,
        action: 'billing_manage_link_requested',
        authContext: req.authContext,
        metadata: {
          provider: 'razorpay',
          subscriptionId,
          status: fetched.status || null,
        },
        targetId: subscriptionId,
        targetType: 'billing',
      });

      return res.json({ ok: true, provider: 'razorpay', url, subscriptionId });
    } catch (error) {
      console.error('[billing_manage_link] failed', error);
      return res.status(500).json({ error: 'billing_manage_link_failed' });
    }
  });

  // Public checkout session fetcher for the hosted web checkout UI.
  // This endpoint is intentionally public: the `sessionId` is an unguessable Firestore doc id,
  // and we enforce a short TTL using BILLING_CHECKOUT_LOCK_TTL_MINUTES.
  app.get('/billing/checkout/session-public', async (req, res) => {
    const parsed = billingCheckoutSessionPublicSchema.safeParse({
      sessionId: req.query?.sessionId,
      tenantId: req.query?.tenantId,
    });
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const { sessionId, tenantId } = parsed.data;
    try {
      const db = getFirestoreImpl();
      const snap = await db.collection('billingCheckoutSessions').doc(sessionId).get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'checkout_session_not_found' });
      }

      const data = (snap.data && snap.data()) || {};
      const sessionTenantId = typeof data.tenantId === 'string' ? data.tenantId : '';
      if (tenantId && tenantId !== sessionTenantId) {
        return res.status(403).json({ error: 'tenant_mismatch' });
      }

      const createdAtIso = typeof data.createdAt === 'string' ? data.createdAt : '';
      const createdAtMs = createdAtIso ? Date.parse(createdAtIso) : NaN;
      if (!Number.isFinite(createdAtMs)) {
        return res.status(410).json({ error: 'checkout_session_expired' });
      }

      const lockTtlMinutesRaw = Number.parseInt((process.env.BILLING_CHECKOUT_LOCK_TTL_MINUTES || '').trim() || '15', 10);
      const lockTtlMinutes = Number.isFinite(lockTtlMinutesRaw)
        ? Math.max(1, Math.min(120, lockTtlMinutesRaw))
        : 15;

      const expiresAtMs = createdAtMs + lockTtlMinutes * 60 * 1000;
      if (Date.now() > expiresAtMs) {
        return res.status(410).json({ error: 'checkout_session_expired' });
      }

      const provider = data.provider === 'razorpay' ? 'razorpay' : null;
      if (!provider) {
        return res.status(400).json({ error: 'provider_not_supported' });
      }

      const meta = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, any>;

      const storedKeyId = typeof meta.razorpayKeyId === 'string' ? meta.razorpayKeyId.trim() : '';
      const envKeyId = (process.env.RAZORPAY_KEY_ID || '').trim();
      const keyId = storedKeyId || envKeyId;
      if (!keyId) {
        return res.status(503).json({ error: 'razorpay_unconfigured' });
      }

      const subscriptionId = typeof meta.razorpaySubscriptionId === 'string' ? meta.razorpaySubscriptionId.trim() : '';
      if (!subscriptionId) {
        return res.status(409).json({ error: 'subscription_missing' });
      }

      const planId: PlanId = normalizePlanId(data.planId);
      const planVariantId = typeof meta.planVariantId === 'string' ? meta.planVariantId.trim() : '';
      const successUrl = typeof data.successUrl === 'string' ? data.successUrl : undefined;
      const cancelUrl = typeof data.cancelUrl === 'string' ? data.cancelUrl : undefined;

      // This endpoint is PUBLIC (no auth) — do NOT return the creator's email
      // (security-rules-hardening L8); it isn't needed to render Razorpay checkout
      // and a sessionId can leak via checkout-URL logs/referrers.
      return res.json({
        provider,
        sessionId,
        tenantId: sessionTenantId,
        planId,
        ...(planVariantId ? { planVariantId } : {}),
        razorpay: {
          keyId,
          subscriptionId,
        },
        ...(successUrl ? { successUrl } : {}),
        ...(cancelUrl ? { cancelUrl } : {}),
      });
    } catch (error) {
      console.error('[billing_checkout_session_public] failed', error);
      return res.status(500).json({ error: 'checkout_session_failed' });
    }
  });

  app.post('/billing/switch-to-free', requireAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = billingSwitchToFreeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    if (tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const db = getFirestoreImpl();
      const actorId = req.authContext?.uid || req.authContext?.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const actorRole = tenantAccess.role;
      const actorMembershipId = tenantAccess.membershipId;
      const billingRef = db.collection('tenantBilling').doc(tenantId);
      const tenantRef = db.collection('tenants').doc(tenantId);

      const billingSnap = await billingRef.get();
      const billingData = billingSnap.exists ? billingSnap.data() || {} : {};
      const currentPlanId = normalizePlanId((billingData as any).planId ?? (billingData as any).plan ?? 'free');
      if (currentPlanId === 'free') {
        return res.json({ ok: true, planId: 'free' });
      }

      if ((billingData as any).planLockedByOrg === true) {
        return res.status(409).json({
          error: 'plan_locked_by_org',
          message: 'This subscription plan was updated by our organization. Please contact support to change the plan.',
        });
      }

      const alreadyScheduled = Boolean((billingData as any).cancelAtCycleEnd) && ((billingData as any).scheduledDowngradePlanId === 'free');
      if (alreadyScheduled) {
        const existingAt = toIsoTimestamp((billingData as any).scheduledDowngradeAt ?? (billingData as any).renewalDate) ?? null;
        return res.json({
          ok: true,
          scheduled: true,
          scheduledDowngradePlanId: 'free',
          ...(existingAt ? { scheduledDowngradeAt: existingAt } : {}),
        });
      }

      const billingProvider = typeof (billingData as any).billingProvider === 'string' ? (billingData as any).billingProvider : null;
      const subscriptionId = typeof (billingData as any).subscriptionId === 'string' ? (billingData as any).subscriptionId.trim() : '';
      const statusRaw = typeof (billingData as any).status === 'string' ? String((billingData as any).status).trim().toLowerCase() : '';
      const subscriptionIdIsIgnoredByAdminOverride = subscriptionId.includes('__ignored_by_admin_override__');
      const cancellableSubscriptionId = subscriptionIdIsIgnoredByAdminOverride ? '' : subscriptionId;
      const hasActiveProviderSubscription = Boolean(cancellableSubscriptionId) && (statusRaw === 'active' || statusRaw === 'delinquent');
      const renewalDate = toIsoTimestamp((billingData as any).renewalDate ?? (billingData as any).renewsAt ?? (billingData as any).renewalAt) ?? null;

      // Google Play subscriptions cannot be cancelled/updated by the backend.
      // Prevent downgrading in-app while the Play subscription may still be active and billable.
      if (String(billingProvider || '').toLowerCase() === 'google_play' && hasActiveProviderSubscription) {
        return res.status(409).json({
          error: 'google_play_manage_required',
          message:
            'This subscription is managed by Google Play. Please cancel it in Google Play first (and update payment method there if needed), then return to the app and refresh billing.',
        });
      }

      // Google Play subscriptions cannot be cancelled/updated by the backend.
      // Prevent immediate downgrade in-app while the Play subscription may still be active and billable.
      if (String(billingProvider || '').toLowerCase() === 'google_play' && hasActiveProviderSubscription) {
        return res.status(409).json({
          error: 'google_play_manage_required',
          message:
            'This subscription is managed by Google Play. Please cancel it in Google Play first, then return to the app and refresh billing.',
        });
      }

      // If this tenant is billed via Razorpay and we have a subscription id, schedule cancellation
      // at the end of the current billing cycle so there are no further charges.
      if (billingProvider === 'razorpay' && hasActiveProviderSubscription) {
        // Enforce: cancellation should only be possible after we have evidence of a captured payment.
        // This prevents cancel attempts during UPI AutoPay mandate authentication / open-invoice states
        // where the subscription may appear "active" but no charge has been captured yet.
        if ((billingData as any).checkoutRequired === true) {
          return res.status(409).json({
            error: 'payment_not_captured_yet',
            message: 'This subscription has a pending payment. Please wait for payment confirmation, then try again.',
          });
        }

        let hasPaidInvoiceForSubscription = false;
        if (process.env.TEST_MODE === '1') {
          // Unit tests use an in-memory Firestore stub without query APIs.
          // In test mode, assume payment captured so cancellation policy paths are testable.
          hasPaidInvoiceForSubscription = true;
        } else {
          try {
            const invoicesRef = db.collection('billingInvoices').doc(tenantId).collection('invoices');
            const paidByProviderSub = await invoicesRef
              .where('status', '==', 'paid')
              .where('providerSubscriptionId', '==', cancellableSubscriptionId)
              .limit(1)
              .get();
            hasPaidInvoiceForSubscription = !paidByProviderSub.empty;

            if (!hasPaidInvoiceForSubscription) {
              const paidBySub = await invoicesRef
                .where('status', '==', 'paid')
                .where('subscriptionId', '==', cancellableSubscriptionId)
                .limit(1)
                .get();
              hasPaidInvoiceForSubscription = !paidBySub.empty;
            }
          } catch {
            // Best-effort. If we cannot verify, stay conservative.
            hasPaidInvoiceForSubscription = false;
          }
        }

        if (!hasPaidInvoiceForSubscription) {
          return res.status(409).json({
            error: 'payment_not_captured_yet',
            message: 'This subscription cannot be cancelled until the first payment is captured. Please wait for payment confirmation, then try again.',
          });
        }

        try {
          await cancelRazorpaySubscriptionImpl({ subscriptionId: cancellableSubscriptionId, cancelAtCycleEnd: true });
        } catch (error) {
          const status = typeof (error as any)?.status === 'number' ? (error as any).status : null;
          const providerPayload = (error as any)?.providerPayload;
          const providerCode = typeof providerPayload?.error?.code === 'string' ? String(providerPayload.error.code) : '';
          const providerDescription = typeof providerPayload?.error?.description === 'string' ? String(providerPayload.error.description) : '';
          const isNoBillingCycleError =
            status === 400 &&
            providerCode === 'BAD_REQUEST_ERROR' &&
            providerDescription.toLowerCase().includes('no billing cycle is going on');

          const isAlreadyCancelledError =
            status === 400 &&
            providerCode === 'BAD_REQUEST_ERROR' &&
            providerDescription.toLowerCase().includes('not cancellable in cancelled status');

          if (isNoBillingCycleError) {
            // This commonly happens when UPI AutoPay is authenticated but the first charge hasn't happened yet.
            // Razorpay does not allow cancelling the subscription until a billing cycle starts.
            return res.status(409).json({
              error: 'razorpay_cancel_not_available',
              message: 'This subscription cannot be cancelled yet because the first billing cycle has not started. Please wait for payment confirmation, then try again.',
            });
          }

          if (isAlreadyCancelledError) {
            // Treat as already cancelled; proceed with scheduling downgrade.
          } else {
          console.error('[billing_switch_to_free] razorpay cancel failed', error);
          return res.status(503).json({
            error: 'razorpay_cancel_failed',
            message:
              'We could not cancel your Razorpay subscription right now. Please try again later, or contact support if it keeps failing.',
          });
          }
        }

        await billingRef.set(
          {
            cancelAtCycleEnd: true,
            scheduledDowngradePlanId: 'free',
            scheduledDowngradeAt: renewalDate,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        void logTenantAuditEventImpl({
          tenantId,
          action: 'billing_downgrade_to_free_scheduled',
          authContext: req.authContext,
          metadata: {
            fromPlanId: currentPlanId,
            provider: billingProvider,
            subscriptionId: cancellableSubscriptionId,
            ...(renewalDate ? { effectiveAt: renewalDate } : {}),
          },
          targetId: tenantId,
          targetType: 'billing',
        });

        void sendTenantBillingEventNotification({
          tenantId,
          kind: 'downgrade_to_free_scheduled',
          title: 'Downgrade to Free scheduled',
          body: (() => {
            const lines: string[] = ['This coaching center will switch to the Free plan.'];
            const when = formatIsoIstForDisplay(renewalDate ?? undefined);
            if (when) {
              lines.push(`Switch date: ${when}.`);
            } else {
              lines.push('Switch date: end of the current billing cycle.');
            }
            return lines.join('\n');
          })(),
          priority: 'medium',
          metadata: {
            provider: billingProvider,
            subscriptionId: cancellableSubscriptionId,
            fromPlanId: currentPlanId,
            scheduledAt: renewalDate,
            actorId,
            actorEmail: actorEmail || null,
            actorRole,
            actorMembershipId,
          },
        }).catch(() => undefined);

        return res.json({
          ok: true,
          scheduled: true,
          scheduledDowngradePlanId: 'free',
          ...(renewalDate ? { scheduledDowngradeAt: renewalDate } : {}),
        });
      }

      // No active subscription to cancel: downgrade immediately (best-effort).
      await db.runTransaction(async (tx: any) => {
        const tenantSnap = await tx.get(tenantRef);
        if (!tenantSnap.exists) {
          throw new Error('tenant_missing');
        }

        tx.set(
          billingRef,
          {
            planId: 'free',
            planVariantId: null,
            couponCode: null,
            status: 'canceled',
            renewalDate: null,
            checkoutRequired: admin.firestore.FieldValue.delete(),
            checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
            checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
            billingAttemptId: admin.firestore.FieldValue.delete(),
            pendingPlanVariantId: admin.firestore.FieldValue.delete(),
            pendingPlanId: admin.firestore.FieldValue.delete(),
            pendingCouponCode: admin.firestore.FieldValue.delete(),
            billingProvider: admin.firestore.FieldValue.delete(),
            subscriptionId: admin.firestore.FieldValue.delete(),
            cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
            scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
            scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
            limitsSnapshot: admin.firestore.FieldValue.delete(),
            limitsSnapshotAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        tx.set(
          tenantRef,
          {
            billingTier: 'free',
            quotas: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      });

      void logTenantAuditEventImpl({
        tenantId,
        action: 'billing_downgrade_to_free',
        authContext: req.authContext,
        metadata: {
          fromPlanId: currentPlanId,
          provider: billingProvider,
          mode: 'immediate',
          ...(subscriptionId ? { subscriptionId } : {}),
          ...(subscriptionIdIsIgnoredByAdminOverride ? { subscriptionIdIgnoredByAdminOverride: true } : {}),
        },
        targetId: tenantId,
        targetType: 'billing',
      });

      void sendTenantBillingEventNotification({
        tenantId,
        kind: 'downgrade_to_free_immediate',
        title: 'Switched to Free plan',
        body: 'This coaching center has been switched to the Free plan.',
        priority: 'medium',
        metadata: {
          provider: billingProvider,
          subscriptionId: subscriptionId || null,
          fromPlanId: currentPlanId,
          actorId,
          actorEmail: actorEmail || null,
          actorRole,
          actorMembershipId,
        },
      }).catch(() => undefined);

      return res.json({ ok: true, scheduled: false, planId: 'free' });
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (msg === 'tenant_missing') {
        return res.status(404).json({ error: 'tenant_missing' });
      }
      console.error('[billing_switch_to_free] failed', error);
      return res.status(500).json({ error: 'billing_switch_to_free_failed' });
    }
  });

  // Cancel the current paid plan immediately (best-effort) and switch to Free right away.
  // This will cancel the provider subscription with cancelAtCycleEnd=false when possible.
  app.post('/billing/switch-to-free/immediate', requireAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const parsed = billingSwitchToFreeImmediateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantId = parsed.data.tenantId.trim();
    if (tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const db = getFirestoreImpl();
      const actorId = req.authContext?.uid || req.authContext?.tokenType || 'system';
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const actorRole = tenantAccess.role;
      const actorMembershipId = tenantAccess.membershipId;

      const billingRef = db.collection('tenantBilling').doc(tenantId);
      const tenantRef = db.collection('tenants').doc(tenantId);

      const billingSnap = await billingRef.get();
      const billingData = billingSnap.exists ? billingSnap.data() || {} : {};
      const currentPlanId = normalizePlanId((billingData as any).planId ?? (billingData as any).plan ?? 'free');
      if (currentPlanId === 'free') {
        return res.json({ ok: true, scheduled: false, planId: 'free' });
      }

      if ((billingData as any).planLockedByOrg === true) {
        return res.status(409).json({
          error: 'plan_locked_by_org',
          message: 'This subscription plan was updated by our organization. Please contact support to change the plan.',
        });
      }

      const billingProvider = typeof (billingData as any).billingProvider === 'string' ? (billingData as any).billingProvider : null;
      const subscriptionId = typeof (billingData as any).subscriptionId === 'string' ? (billingData as any).subscriptionId.trim() : '';
      const statusRaw = typeof (billingData as any).status === 'string' ? String((billingData as any).status).trim().toLowerCase() : '';
      const subscriptionIdIsIgnoredByAdminOverride = subscriptionId.includes('__ignored_by_admin_override__');
      const cancellableSubscriptionId = subscriptionIdIsIgnoredByAdminOverride ? '' : subscriptionId;
      const hasActiveProviderSubscription = Boolean(cancellableSubscriptionId) && (statusRaw === 'active' || statusRaw === 'delinquent');

      if (billingProvider === 'razorpay' && hasActiveProviderSubscription) {
        // Enforce: do not allow immediate cancellation until payment is captured.
        if ((billingData as any).checkoutRequired === true) {
          return res.status(409).json({
            error: 'payment_not_captured_yet',
            message: 'This subscription has a pending payment. Please wait for payment confirmation, then try again.',
          });
        }

        let hasPaidInvoiceForSubscription = false;
        try {
          const invoicesRef = db.collection('billingInvoices').doc(tenantId).collection('invoices');
          const paidByProviderSub = await invoicesRef
            .where('status', '==', 'paid')
            .where('providerSubscriptionId', '==', cancellableSubscriptionId)
            .limit(1)
            .get();
          hasPaidInvoiceForSubscription = !paidByProviderSub.empty;

          if (!hasPaidInvoiceForSubscription) {
            const paidBySub = await invoicesRef
              .where('status', '==', 'paid')
              .where('subscriptionId', '==', cancellableSubscriptionId)
              .limit(1)
              .get();
            hasPaidInvoiceForSubscription = !paidBySub.empty;
          }
        } catch {
          hasPaidInvoiceForSubscription = false;
        }

        if (!hasPaidInvoiceForSubscription) {
          return res.status(409).json({
            error: 'payment_not_captured_yet',
            message: 'This subscription cannot be cancelled until the first payment is captured. Please wait for payment confirmation, then try again.',
          });
        }

        try {
          await cancelRazorpaySubscriptionImpl({ subscriptionId: cancellableSubscriptionId, cancelAtCycleEnd: false });
        } catch (error) {
          const status = typeof (error as any)?.status === 'number' ? (error as any).status : null;
          const providerPayload = (error as any)?.providerPayload;
          const providerCode = typeof providerPayload?.error?.code === 'string' ? String(providerPayload.error.code) : '';
          const providerDescription = typeof providerPayload?.error?.description === 'string' ? String(providerPayload.error.description) : '';
          const isNoBillingCycleError =
            status === 400 &&
            providerCode === 'BAD_REQUEST_ERROR' &&
            providerDescription.toLowerCase().includes('no billing cycle is going on');

          const isAlreadyCancelledError =
            status === 400 &&
            providerCode === 'BAD_REQUEST_ERROR' &&
            providerDescription.toLowerCase().includes('not cancellable in cancelled status');

          if (isNoBillingCycleError) {
            return res.status(409).json({
              error: 'razorpay_cancel_not_available',
              message: 'This subscription cannot be cancelled yet because the first billing cycle has not started. Please wait for payment confirmation, then try again.',
            });
          }

          if (isAlreadyCancelledError) {
            // Treat as already cancelled; proceed with immediate downgrade.
          } else {
          console.error('[billing_switch_to_free_immediate] razorpay cancel failed', error);
          return res.status(503).json({
            error: 'razorpay_cancel_failed',
            message:
              'We could not cancel your Razorpay subscription right now. Please try again later, or contact support if it keeps failing.',
          });
          }
        }
      }

      await db.runTransaction(async (tx: any) => {
        const tenantSnap = await tx.get(tenantRef);
        if (!tenantSnap.exists) {
          throw new Error('tenant_missing');
        }

        tx.set(
          billingRef,
          {
            planId: 'free',
            planVariantId: null,
            couponCode: null,
            status: 'canceled',
            renewalDate: null,
            checkoutRequired: admin.firestore.FieldValue.delete(),
            checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
            checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
            billingAttemptId: admin.firestore.FieldValue.delete(),
            pendingPlanVariantId: admin.firestore.FieldValue.delete(),
            pendingPlanId: admin.firestore.FieldValue.delete(),
            pendingCouponCode: admin.firestore.FieldValue.delete(),
            billingProvider: admin.firestore.FieldValue.delete(),
            subscriptionId: admin.firestore.FieldValue.delete(),
            cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
            scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
            scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
            limitsSnapshot: admin.firestore.FieldValue.delete(),
            limitsSnapshotAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        tx.set(
          tenantRef,
          {
            billingTier: 'free',
            quotas: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      });

      void logTenantAuditEventImpl({
        tenantId,
        action: 'billing_downgrade_to_free',
        authContext: req.authContext,
        metadata: {
          fromPlanId: currentPlanId,
          provider: billingProvider,
          mode: 'immediate',
          ...(subscriptionId ? { subscriptionId } : {}),
        },
        targetId: tenantId,
        targetType: 'billing',
      });

      void sendTenantBillingEventNotification({
        tenantId,
        kind: 'downgrade_to_free_immediate',
        title: 'Switched to Free plan',
        body: 'This coaching center has been switched to the Free plan.',
        priority: 'medium',
        metadata: {
          provider: billingProvider,
          subscriptionId: subscriptionId || null,
          fromPlanId: currentPlanId,
          actorId,
          actorEmail: actorEmail || null,
          actorRole,
          actorMembershipId,
        },
      }).catch(() => undefined);

      return res.json({ ok: true, scheduled: false, planId: 'free' });
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (msg === 'tenant_missing') {
        return res.status(404).json({ error: 'tenant_missing' });
      }
      console.error('[billing_switch_to_free_immediate] failed', error);
      return res.status(500).json({ error: 'billing_switch_to_free_immediate_failed' });
    }
  });

  app.post('/billing/play/verify', requireAdminTenantAccess, async (req, res) => {
    if (!storeBillingFeatureEnabled()) {
      return res.status(503).json({ error: 'store_billing_disabled' });
    }

    const parsed = playVerificationSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const db = getFirestoreImpl();

    if (process.env.TEST_MODE === '1') {
      const now = Date.now();
      const renewalDate = new Date(now + 7 * 24 * 60 * 60_000).toISOString();
      return res.json({
        ok: true,
        provider: 'google_play',
        status: 'verified',
        planId: 'pro',
        planVariantId: typeof parsed.data.planVariantId === 'string' ? parsed.data.planVariantId.trim() : undefined,
        renewalDate,
        acknowledged: true,
      });
    }

    const packageName = (process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
    if (!packageName) {
      return res.status(503).json({ error: 'google_play_unconfigured', message: 'Missing GOOGLE_PLAY_PACKAGE_NAME' });
    }

    const productId = parsed.data.productId.trim();
    const purchaseToken = parsed.data.purchaseToken.trim();
    const requestedPlanVariantId = typeof parsed.data.planVariantId === 'string' ? parsed.data.planVariantId.trim() : '';

    try {
      const purchase = await fetchGooglePlaySubscriptionPurchase({ packageName, productId, purchaseToken });
      const expiryMs = typeof purchase.expiryTimeMillis === 'string' ? Number(purchase.expiryTimeMillis) : NaN;
      const expiryIso = Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null;

      // Basic validity checks.
      const nowMs = Date.now();
      if (Number.isFinite(expiryMs) && expiryMs <= nowMs) {
        return res.status(409).json({ error: 'purchase_expired', expiryTime: expiryIso });
      }

      // paymentState (subscriptions):
      // 0 = pending, 1 = received, 2 = free trial, 3 = pending deferred upgrade/downgrade.
      const paymentState = typeof purchase.paymentState === 'number' ? purchase.paymentState : null;
      if (paymentState === 0) {
        const nowIso = new Date().toISOString();
        const billingAttemptId = `play_${crypto
          .createHash('sha256')
          .update(`${productId}:${purchaseToken}`)
          .digest('hex')
          .slice(0, 24)}`;
        try {
          await db.collection('tenantBilling').doc(tenantAccess.tenantId).set(
            {
              checkoutRequired: true,
              checkoutRequiredProvider: 'google_play',
              checkoutRequiredSinceIso: nowIso,
              billingAttemptId,
              billingProvider: 'play',
              subscriptionId: purchaseToken,
              storeProductId: productId,
              lastStoreVerifyAtIso: nowIso,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch {
          // Best-effort.
        }
        return res.status(409).json({ error: 'purchase_pending' });
      }

      // Resolve the granted plan STRICTLY from the SKU actually purchased
      // (productId → billingPlanVariants.playProductId), NEVER from the client-
      // supplied planVariantId. Otherwise a tenant admin could buy the cheapest
      // real SKU and claim an expensive plan (security-rules-hardening H6).
      let resolvedVariantId = '';
      let resolvedPlanId: PlanId = 'pro';
      let resolvedPriceInr = 0;
      {
        const configured = await listPlanVariants(db, { includeInactive: false });
        const match = configured.find((v) => typeof (v as any).playProductId === 'string' && (v as any).playProductId === productId);
        if (match) {
          resolvedVariantId = match.id;
          resolvedPlanId = match.planId;
          resolvedPriceInr = Number.isFinite(match.priceInr) ? Math.max(0, Math.trunc(match.priceInr)) : 0;
        }
      }

      if (!resolvedVariantId) {
        return res.status(400).json({
          error: 'plan_variant_unresolved',
          message: 'No billingPlanVariants.playProductId mapping found for this productId; configure the SKU→plan mapping.',
        });
      }

      // A client-supplied planVariantId is advisory only and MUST match the
      // SKU-derived variant — a mismatch means the client is claiming a different
      // plan than the one it actually purchased.
      if (requestedPlanVariantId && requestedPlanVariantId !== resolvedVariantId) {
        return res.status(409).json({ error: 'plan_variant_mismatch' });
      }

      // Bind this purchaseToken to a single tenant so one genuine purchase can't be
      // replayed through /billing/play/verify to upgrade multiple tenants the same
      // actor administers (security-rules-hardening H6-related).
      const purchaseTokenClaimId = crypto.createHash('sha256').update(purchaseToken).digest('hex');
      const purchaseTokenClaimRef = db.collection('playPurchaseTokenClaims').doc(purchaseTokenClaimId);
      try {
        await db.runTransaction(async (tx) => {
          const claimSnap = await tx.get(purchaseTokenClaimRef);
          if (claimSnap.exists) {
            const owner = (claimSnap.data() as any)?.tenantId;
            if (typeof owner === 'string' && owner && owner !== tenantAccess.tenantId) {
              throw new Error('purchase_token_bound_to_other_tenant');
            }
          }
          tx.set(
            purchaseTokenClaimRef,
            {
              tenantId: tenantAccess.tenantId,
              productId,
              claimedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        });
      } catch (error: any) {
        if (error?.message === 'purchase_token_bound_to_other_tenant') {
          return res.status(409).json({ error: 'purchase_token_bound_to_other_tenant' });
        }
        // Transient transaction failure: log and continue so a legitimate
        // activation isn't blocked by a best-effort dedup write.
        console.warn('[play_verify] purchase-token claim failed (continuing)', error?.message || error);
      }

      let limitsSnapshot: ReturnType<typeof toTenantBillingLimitsSnapshot> | null = null;
      try {
        const resolved = await resolvePlanLimitsFromCatalog(db, {
          planId: resolvedPlanId,
          planVariantId: resolvedVariantId || null,
        });
        limitsSnapshot = toTenantBillingLimitsSnapshot(resolved);
      } catch {
        limitsSnapshot = null;
      }

      // Acknowledge purchase if needed.
      const acknowledgementState = typeof purchase.acknowledgementState === 'number' ? purchase.acknowledgementState : null;
      if (acknowledgementState === 0) {
        try {
          await acknowledgeGooglePlaySubscription({ packageName, productId, purchaseToken });
        } catch (error) {
          // Best-effort: still proceed to activate, but record ops event for debugging.
          void recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_ack_failed',
            severity: 'warn',
            message: 'Google Play acknowledge failed (best-effort)',
            tenantId: tenantAccess.tenantId,
            subscriptionId: purchaseToken,
            httpStatus: typeof (error as any)?.status === 'number' ? (error as any).status : null,
            requestPath: '/billing/play/verify',
          }).catch(() => undefined);
        }
      }

      const nowIso = new Date().toISOString();
      const billingAttemptId = `play_${crypto
        .createHash('sha256')
        .update(`${productId}:${purchaseToken}`)
        .digest('hex')
        .slice(0, 24)}`;
      const billingRef = db.collection('tenantBilling').doc(tenantAccess.tenantId);
      const tenantRef = db.collection('tenants').doc(tenantAccess.tenantId);

      // Mirror Razorpay's "payment received / subscription activated" notification behavior.
      // Idempotency: only notify once per subscriptionId (purchaseToken).
      let shouldSendActivated = false;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(billingRef);
          const data = snap.exists ? snap.data() ?? {} : {};
          const lastNotifiedSub = typeof (data as any).activationNotifiedSubscriptionId === 'string'
            ? (data as any).activationNotifiedSubscriptionId
            : null;

          if (purchaseToken && lastNotifiedSub !== purchaseToken) {
            shouldSendActivated = true;
          }

          tx.set(
            billingRef,
            stripUndefinedDeep({
              planId: resolvedPlanId,
              planVariantId: resolvedVariantId,
              status: 'active',
              billingProvider: 'play',
              subscriptionId: purchaseToken,
              renewalDate: expiryIso,
              checkoutRequired: false,
              checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
              checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
              billingAttemptId: admin.firestore.FieldValue.delete(),
              cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
              scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
              scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
              delinquentSince: admin.firestore.FieldValue.delete(),
              delinquentSinceIso: admin.firestore.FieldValue.delete(),
              ...(limitsSnapshot ? { limitsSnapshot, limitsSnapshotAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              lastStoreVerifyAtIso: nowIso,
              storeProductId: productId,
              storeOrderId: typeof purchase.orderId === 'string' ? purchase.orderId : parsed.data.orderId,
              ...(shouldSendActivated
                ? {
                    activationNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                    activationNotifiedAtIso: nowIso,
                    activationNotifiedSubscriptionId: purchaseToken,
                  }
                : {}),
            }),
            { merge: true }
          );
        });
      } catch {
        // Still proceed; notification is best-effort.
      }

      await tenantRef.set(
        {
          billingTier: resolvedPlanId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (shouldSendActivated) {
        const expiryDisplay = formatIsoIstForDisplay(expiryIso || undefined);
        const bodyLines: string[] = [];
        bodyLines.push(`Your ${String(resolvedPlanId).toUpperCase()} subscription is activated.`);
        if (resolvedPriceInr > 0) bodyLines.push(`Amount: ₹${resolvedPriceInr}.`);
        if (expiryDisplay) bodyLines.push(`Next billing: ${expiryDisplay}.`);

        void sendTenantBillingEventNotification({
          tenantId: tenantAccess.tenantId,
          tenantName: undefined,
          kind: 'subscription_activated',
          title: 'Subscription activated',
          body: bodyLines.join('\n'),
          priority: 'medium',
          metadata: {
            provider: 'play',
            planId: resolvedPlanId,
            planVariantId: resolvedVariantId,
            productId,
            subscriptionId: purchaseToken,
            orderId: typeof purchase.orderId === 'string' ? purchase.orderId : parsed.data.orderId,
            renewalDate: expiryIso,
            paymentState,
          },
        }).catch(() => undefined);
      }

      // Persist an invoice entry (best-effort).
      try {
        const orderId = (typeof purchase.orderId === 'string' ? purchase.orderId : parsed.data.orderId || '').trim();
        const issuedAt = nowIso;
        const invoiceId = orderId ? `play_${orderId}` : `play_${purchaseToken.slice(0, 12)}_${issuedAt}`;
        const status: BillingInvoiceRecord['status'] = paymentState === 2 ? 'open' : 'paid';
        await db
          .collection('billingInvoices')
          .doc(tenantAccess.tenantId)
          .collection('invoices')
          .doc(invoiceId)
          .set(
            stripUndefinedDeep({
              amountInr: resolvedPriceInr,
              status,
              provider: 'play',
              issuedAt,
              planId: resolvedPlanId,
              planVariantId: resolvedVariantId,
              isSynthetic: true,
              sourceEvent: 'play_verify',
              providerSubscriptionId: purchaseToken,
              subscriptionId: purchaseToken,
              billingAttemptId,
              providerPaymentId: orderId || null,
              rawEvent: 'play_verify',
            }),
            { merge: true }
          );
      } catch {
        // ignore
      }

      // Tenant audit trail (best-effort)
      void logTenantAuditEventImpl({
        tenantId: tenantAccess.tenantId,
        action: 'billing_play_verified',
        authContext: req.authContext,
        metadata: {
          provider: 'play',
          productId,
          planId: resolvedPlanId,
          planVariantId: resolvedVariantId,
          expiryTime: expiryIso,
          orderId: typeof purchase.orderId === 'string' ? purchase.orderId : parsed.data.orderId,
          paymentState,
        },
        targetId: typeof purchase.orderId === 'string' ? purchase.orderId : purchaseToken,
        targetType: 'billing',
      }).catch(() => undefined);

      return res.json({
        ok: true,
        provider: 'google_play',
        status: 'verified',
        planId: resolvedPlanId,
        planVariantId: resolvedVariantId,
        renewalDate: expiryIso,
        acknowledged: acknowledgementState === 1 ? true : undefined,
      });
    } catch (error: any) {
      const status = typeof error?.status === 'number' ? error.status : 500;
      const message = typeof error?.message === 'string' ? error.message : 'play_verify_failed';
      console.error('[billing_play_verify] failed', { tenantId: tenantAccess.tenantId, status, message });
      void recordBillingOpsEvent(db, {
        provider: 'play',
        type: 'play_verify_failed',
        severity: 'error',
        message,
        tenantId: tenantAccess.tenantId,
        subscriptionId: purchaseToken,
        httpStatus: status,
        requestPath: '/billing/play/verify',
      }).catch(() => undefined);
      return res.status(status >= 400 && status < 600 ? status : 500).json({ error: 'play_verify_failed', message });
    }
  });

  app.post('/billing/appstore/verify', requireAdminTenantAccess, async (req, res) => {
    if (!storeBillingFeatureEnabled()) {
      return res.status(503).json({ error: 'store_billing_disabled' });
    }

    const parsed = appStoreVerificationSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    console.info('[billing_appstore_verify] stub payload received', {
      tenantId: tenantAccess.tenantId,
      transactionId: parsed.data.transactionId,
      bundleId: parsed.data.bundleId,
    });
    return res.json({ ok: true, provider: 'app_store', status: 'received' });
  });

  const playNotificationParser = express.raw({ type: 'application/json' });
  app.post('/billing/play/notifications', playNotificationParser, async (req, res) => {
    if (!storeBillingFeatureEnabled()) {
      return res.status(503).json({ error: 'store_billing_disabled' });
    }

    const rawPayload = extractRawBody(req.body);

    // Keep the tests lightweight (they don't configure Firebase/Play credentials).
    if (process.env.TEST_MODE === '1') {
      console.info('[billing_play_notification] test-mode payload received', safePreview(rawPayload));
      return res.status(202).json({ ok: true, provider: 'google_play' });
    }

    const requiredAudience = (process.env.PLAY_RTDN_OIDC_AUDIENCE || '').trim();
    if (!requiredAudience) {
      // Fail closed (security-rules-hardening M7-related): don't accept an
      // UNVERIFIED Pub/Sub RTDN push. When store billing is enabled the operator
      // MUST configure PLAY_RTDN_OIDC_AUDIENCE so the push token can be verified.
      console.error('[billing_play_notification] PLAY_RTDN_OIDC_AUDIENCE not configured — refusing RTDN (fail closed)');
      return res.status(503).json({ error: 'rtdn_oidc_not_configured' });
    }
    try {
      const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token) {
        return res.status(401).json({ error: 'missing_oidc_token' });
      }

      const { OAuth2Client } = await import('google-auth-library');
      const client = new OAuth2Client();
      await client.verifyIdToken({ idToken: token, audience: requiredAudience });
    } catch (error) {
      console.warn('[billing_play_notification] oidc verification failed', (error as any)?.message || error);
      return res.status(401).json({ error: 'invalid_oidc_token' });
    }

    // Always respond 2xx quickly so Pub/Sub doesn't retry aggressively.
    res.status(202).json({ ok: true, provider: 'google_play' });

    void (async () => {
      try {
        const parsedEnvelope = (() => {
          try {
            return JSON.parse(rawPayload || '{}') as any;
          } catch {
            return null;
          }
        })();

        const b64 = typeof parsedEnvelope?.message?.data === 'string' ? parsedEnvelope.message.data : '';
        const messageId = typeof parsedEnvelope?.message?.messageId === 'string' ? parsedEnvelope.message.messageId : null;
        const publishTime = typeof parsedEnvelope?.message?.publishTime === 'string' ? parsedEnvelope.message.publishTime : null;

        if (!b64) {
          const db = getFirestoreImpl();
          await recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_rtdn_missing_message_data',
            severity: 'warn',
            message: 'RTDN Pub/Sub push missing message.data',
            httpStatus: 202,
            requestPath: '/billing/play/notifications',
            ip: typeof req.ip === 'string' ? req.ip : null,
            userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
            payloadPreview: safePreview(rawPayload),
            metadata: { messageId, publishTime },
          });
          return;
        }

        const decoded = (() => {
          try {
            return Buffer.from(b64, 'base64').toString('utf8');
          } catch {
            return '';
          }
        })();
        if (!decoded) {
          const db = getFirestoreImpl();
          await recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_rtdn_decode_failed',
            severity: 'warn',
            message: 'RTDN Pub/Sub base64 decode failed',
            httpStatus: 202,
            requestPath: '/billing/play/notifications',
            ip: typeof req.ip === 'string' ? req.ip : null,
            userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
            payloadPreview: safePreview(rawPayload),
            metadata: { messageId, publishTime },
          });
          return;
        }

        const developerNotification = (() => {
          try {
            return JSON.parse(decoded || '{}') as any;
          } catch {
            return null;
          }
        })();

        const subscriptionNotification = developerNotification?.subscriptionNotification;
        const notificationType = typeof subscriptionNotification?.notificationType === 'number' ? subscriptionNotification.notificationType : null;
        const purchaseToken = typeof subscriptionNotification?.purchaseToken === 'string' ? subscriptionNotification.purchaseToken.trim() : '';
        const productId = typeof subscriptionNotification?.subscriptionId === 'string' ? subscriptionNotification.subscriptionId.trim() : '';

        const packageNameFromEvent = typeof developerNotification?.packageName === 'string' ? developerNotification.packageName.trim() : '';
        const packageNameEnv = (process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
        const packageName = packageNameEnv || packageNameFromEvent;

        if (!packageName) {
          const db = getFirestoreImpl();
          await recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_rtdn_unconfigured',
            severity: 'error',
            message: 'Missing GOOGLE_PLAY_PACKAGE_NAME (required for RTDN processing)',
            httpStatus: 202,
            requestPath: '/billing/play/notifications',
            payloadPreview: safePreview(decoded),
            metadata: { messageId, publishTime },
          });
          return;
        }

        if (packageNameEnv && packageNameFromEvent && packageNameEnv !== packageNameFromEvent) {
          const db = getFirestoreImpl();
          await recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_rtdn_package_mismatch',
            severity: 'warn',
            message: 'RTDN packageName mismatch',
            httpStatus: 202,
            requestPath: '/billing/play/notifications',
            payloadPreview: safePreview(decoded),
            metadata: { messageId, publishTime, packageNameEnv, packageNameFromEvent },
          });
          return;
        }

        if (!purchaseToken || !productId || notificationType == null) {
          const db = getFirestoreImpl();
          await recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_rtdn_invalid_payload',
            severity: 'warn',
            message: 'RTDN payload missing subscriptionNotification fields',
            httpStatus: 202,
            requestPath: '/billing/play/notifications',
            payloadPreview: safePreview(decoded),
            metadata: { messageId, publishTime, notificationType, purchaseTokenPresent: Boolean(purchaseToken), productIdPresent: Boolean(productId) },
          });
          return;
        }

        const db = getFirestoreImpl();

        // Resolve tenant by Play subscriptionId (we store purchaseToken as subscriptionId).
        const billingSnap = await db.collection('tenantBilling').where('subscriptionId', '==', purchaseToken).limit(1).get();
        if (billingSnap.empty) {
          await recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_rtdn_tenant_not_found',
            severity: 'warn',
            message: 'RTDN purchaseToken not mapped to any tenantBilling.subscriptionId',
            httpStatus: 202,
            requestPath: '/billing/play/notifications',
            subscriptionId: purchaseToken,
            payloadPreview: safePreview(decoded),
            metadata: { messageId, publishTime, notificationType, productId },
          });
          return;
        }

        const doc = billingSnap.docs[0];
        const tenantId = doc.id;
        const billingData = doc.data() || {};

        // Admin plan override can cancel/revoke a Play subscription as part of switching plans.
        // RTDN can arrive quickly after the operator action; avoid any RTDN-driven downgrade
        // and avoid generic cancellation notifications during that window.
        try {
          const suppressUntilIso =
            typeof (billingData as any).suppressProviderCancelNotificationUntilIso === 'string'
              ? String((billingData as any).suppressProviderCancelNotificationUntilIso)
              : '';
          const suppressActive = Boolean(suppressUntilIso) && Date.now() < Date.parse(suppressUntilIso);
          const ctx = (billingData as any).lastSystemCancelContext as any;
          const ctxSource = typeof ctx?.source === 'string' ? String(ctx.source) : '';
          const ctxSubId = typeof ctx?.subscriptionId === 'string' ? String(ctx.subscriptionId) : '';
          const matchesCtxSub = !purchaseToken || !ctxSubId || ctxSubId === purchaseToken;

          if (suppressActive && ctxSource === 'admin_console_plan_override' && matchesCtxSub) {
            const billingRef = db.collection('tenantBilling').doc(tenantId);
            try {
              await billingRef.set(
                {
                  suppressProviderCancelNotificationUntilIso: admin.firestore.FieldValue.delete(),
                  lastSystemCancelContext: admin.firestore.FieldValue.delete(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            } catch {
              // ignore
            }
            return;
          }
        } catch {
          // ignore
        }

        const planId: PlanId = normalizePlanId(typeof (billingData as any).planId === 'string' ? (billingData as any).planId : 'pro');
        const planVariantId = typeof (billingData as any).planVariantId === 'string' ? (billingData as any).planVariantId : null;

        let resolvedVariantId = planVariantId;
        let resolvedPlanId: PlanId = planId === 'free' ? 'pro' : planId;
        let resolvedPriceInr = 0;
        if (resolvedVariantId) {
          try {
            const variant = await getPlanVariantById(db, resolvedVariantId);
            if (variant) {
              resolvedPlanId = variant.planId;
              resolvedPriceInr = Number.isFinite(variant.priceInr) ? Math.max(0, Math.trunc(variant.priceInr)) : 0;
            }
          } catch {
            // ignore
          }
        } else {
          try {
            const configured = await listPlanVariants(db, { includeInactive: false });
            const match = configured.find((v) => typeof (v as any).playProductId === 'string' && (v as any).playProductId === productId);
            if (match) {
              resolvedVariantId = match.id;
              resolvedPlanId = match.planId;
              resolvedPriceInr = Number.isFinite(match.priceInr) ? Math.max(0, Math.trunc(match.priceInr)) : 0;
            }
          } catch {
            // ignore
          }
        }

        const purchase = await fetchGooglePlaySubscriptionPurchase({ packageName, productId, purchaseToken });
        const expiryMs = typeof purchase.expiryTimeMillis === 'string' ? Number(purchase.expiryTimeMillis) : NaN;
        const expiryIso = Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null;
        const expiryDisplay = formatIsoIstForDisplay(expiryIso || undefined);
        const nowIso = new Date().toISOString();
        const nowMs = Date.now();

        const paymentState = typeof purchase.paymentState === 'number' ? purchase.paymentState : null;
        const orderId = typeof purchase.orderId === 'string' ? purchase.orderId.trim() : '';
        const autoRenewing = typeof (purchase as any).autoRenewing === 'boolean' ? Boolean((purchase as any).autoRenewing) : null;

        // Notification types:
        // 1 RECOVERED, 2 RENEWED, 3 CANCELED, 4 PURCHASED, 5 ON_HOLD,
        // 6 IN_GRACE_PERIOD, 7 RESTARTED, 12 REVOKED, 13 EXPIRED.
        const isExpired = Number.isFinite(expiryMs) && expiryMs <= nowMs;

        const billingRef = db.collection('tenantBilling').doc(tenantId);
        const tenantRef = db.collection('tenants').doc(tenantId);

        const lastRenewalOrderId = typeof (billingData as any).lastStoreRenewalNotifiedOrderId === 'string' ? (billingData as any).lastStoreRenewalNotifiedOrderId : '';
        const lastRenewalExpiryIso = typeof (billingData as any).lastStoreRenewalNotifiedExpiryIso === 'string' ? (billingData as any).lastStoreRenewalNotifiedExpiryIso : '';
        const lastCancelExpiryIso = typeof (billingData as any).lastStoreCancelNotifiedExpiryIso === 'string' ? (billingData as any).lastStoreCancelNotifiedExpiryIso : '';
        const lastDelinquentKey = typeof (billingData as any).lastStoreDelinquentNotifiedKey === 'string' ? (billingData as any).lastStoreDelinquentNotifiedKey : '';
        const lastExpiredExpiryIso = typeof (billingData as any).lastStoreExpiredNotifiedExpiryIso === 'string' ? (billingData as any).lastStoreExpiredNotifiedExpiryIso : '';

        const isNewRenewal = Boolean(expiryIso) && (orderId ? orderId !== lastRenewalOrderId : expiryIso !== lastRenewalExpiryIso);

        if (notificationType === 2 /* RENEWED */) {
          if (isNewRenewal) {
            try {
              await billingRef.set(
                stripUndefinedDeep({
                  planId: resolvedPlanId,
                  planVariantId: resolvedVariantId || null,
                  status: 'active',
                  billingProvider: 'play',
                  subscriptionId: purchaseToken,
                  renewalDate: expiryIso,
                  storeProductId: productId,
                  ...(orderId ? { storeOrderId: orderId } : {}),
                  ...(autoRenewing === true
                    ? {
                        cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
                        scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
                        scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
                      }
                    : {}),
                  delinquentSince: admin.firestore.FieldValue.delete(),
                  delinquentSinceIso: admin.firestore.FieldValue.delete(),
                  lastStoreVerifyAtIso: nowIso,
                  lastPaymentCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
                  lastPaymentCapturedAtIso: nowIso,
                  lastPaymentCapturedPaymentId: orderId || null,
                  lastPaymentCapturedSubscriptionId: purchaseToken,
                  lastStoreRenewalNotifiedOrderId: orderId || null,
                  lastStoreRenewalNotifiedExpiryIso: expiryIso || null,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }),
                { merge: true }
              );
            } catch {
              // ignore
            }

            try {
              await tenantRef.set(
                {
                  billingTier: resolvedPlanId,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            } catch {
              // ignore
            }

            // Invoice (best-effort)
            try {
              const invoiceId = orderId ? `play_${orderId}` : expiryIso ? `play_${purchaseToken.slice(0, 12)}_${expiryIso}` : `play_${purchaseToken.slice(0, 12)}_${nowIso}`;
              await db
                .collection('billingInvoices')
                .doc(tenantId)
                .collection('invoices')
                .doc(invoiceId)
                .set(
                  stripUndefinedDeep({
                    amountInr: resolvedPriceInr,
                    status: 'paid',
                    provider: 'play',
                    issuedAt: nowIso,
                    planId: resolvedPlanId,
                    planVariantId: resolvedVariantId || null,
                    isSynthetic: true,
                    sourceEvent: 'play_rtdn_renewed',
                    providerSubscriptionId: purchaseToken,
                    subscriptionId: purchaseToken,
                    providerPaymentId: orderId || null,
                    rawEvent: 'play_rtdn',
                  }),
                  { merge: true }
                );
            } catch {
              // ignore
            }

            const bodyLines: string[] = [];
            bodyLines.push(`Payment received for the ${String(resolvedPlanId).toUpperCase()} plan.`);
            if (resolvedPriceInr > 0) bodyLines.push(`Amount: ₹${resolvedPriceInr}.`);
            if (expiryDisplay) bodyLines.push(`Next billing: ${expiryDisplay}.`);

            void sendTenantBillingEventNotification({
              tenantId,
              tenantName: undefined,
              kind: 'subscription_charged',
              title: 'Subscription payment received',
              body: bodyLines.join('\n'),
              priority: 'medium',
              metadata: {
                provider: 'play',
                planId: resolvedPlanId,
                planVariantId: resolvedVariantId || null,
                productId,
                subscriptionId: purchaseToken,
                orderId: orderId || null,
                renewalDate: expiryIso,
                paymentState,
                notificationType,
              },
            }).catch(() => undefined);
          }
          return;
        }

        if (notificationType === 3 /* CANCELED */) {
          if (expiryIso && expiryIso === lastCancelExpiryIso) {
            return;
          }

          try {
            await billingRef.set(
              stripUndefinedDeep({
                planId: resolvedPlanId,
                planVariantId: resolvedVariantId || null,
                status: isExpired ? 'canceled' : 'active',
                billingProvider: 'play',
                subscriptionId: purchaseToken,
                renewalDate: expiryIso,
                storeProductId: productId,
                ...(orderId ? { storeOrderId: orderId } : {}),
                cancelAtCycleEnd: true,
                scheduledDowngradePlanId: 'free',
                ...(expiryIso ? { scheduledDowngradeAt: expiryIso } : {}),
                lastStoreCancelNotifiedExpiryIso: expiryIso || nowIso,
                lastStoreVerifyAtIso: nowIso,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              { merge: true }
            );
          } catch {
            // ignore
          }

          const bodyLines: string[] = [];
          bodyLines.push('Your subscription was cancelled (auto-renew turned off).');
          if (expiryDisplay) {
            bodyLines.push(`Your plan remains active until ${expiryDisplay}, then switches to Free.`);
          }

          void sendTenantBillingEventNotification({
            tenantId,
            tenantName: undefined,
            kind: 'subscription_cancelled',
            title: 'Subscription cancelled',
            body: bodyLines.join('\n'),
            priority: 'medium',
            metadata: {
              provider: 'play',
              planId: resolvedPlanId,
              planVariantId: resolvedVariantId || null,
              productId,
              subscriptionId: purchaseToken,
              orderId: orderId || null,
              renewalDate: expiryIso,
              notificationType,
            },
          }).catch(() => undefined);
          return;
        }

        if (notificationType === 5 /* ON_HOLD */ || notificationType === 6 /* IN_GRACE_PERIOD */) {
          if ((billingData as any).planLockedByOrg === true) {
            return;
          }
          const delinquentKey = `${purchaseToken}:${notificationType}:${expiryIso || 'unknown'}`;
          if (delinquentKey === lastDelinquentKey) {
            return;
          }

          const kind = notificationType === 6 ? 'payment_failed' : 'subscription_failed';
          const title = notificationType === 6 ? 'Subscription payment failed' : 'Subscription issue';
          const body =
            notificationType === 6
              ? ['A subscription payment failed.', 'Please update your payment method to avoid interruption.', ...(expiryDisplay ? [`Grace until: ${expiryDisplay}.`] : [])].join('\n')
              : ['There was an issue with your subscription.', 'Please update your payment method to avoid any interruption.'].join('\n');

          try {
            await billingRef.set(
              stripUndefinedDeep({
                planId: resolvedPlanId,
                planVariantId: resolvedVariantId || null,
                status: 'delinquent',
                billingProvider: 'play',
                subscriptionId: purchaseToken,
                renewalDate: expiryIso,
                storeProductId: productId,
                ...(orderId ? { storeOrderId: orderId } : {}),
                ...((billingData as any).delinquentSince ? {} : { delinquentSince: admin.firestore.FieldValue.serverTimestamp() }),
                delinquentSinceIso: typeof (billingData as any).delinquentSinceIso === 'string' ? (billingData as any).delinquentSinceIso : nowIso,
                lastStoreDelinquentNotifiedKey: delinquentKey,
                lastStoreVerifyAtIso: nowIso,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              { merge: true }
            );
          } catch {
            // ignore
          }

          void sendTenantBillingEventNotification({
            tenantId,
            tenantName: undefined,
            kind,
            title,
            body,
            priority: 'high',
            metadata: {
              provider: 'play',
              planId: resolvedPlanId,
              productId,
              subscriptionId: purchaseToken,
              orderId: orderId || null,
              renewalDate: expiryIso,
              paymentState,
              notificationType,
            },
          }).catch(() => undefined);
          return;
        }

        if (notificationType === 12 /* REVOKED */ || notificationType === 13 /* EXPIRED */ || isExpired) {
          if (expiryIso && expiryIso === lastExpiredExpiryIso) {
            return;
          }

          try {
            await billingRef.set(
              {
                planId: 'free',
                planVariantId: null,
                couponCode: null,
                status: 'canceled',
                billingProvider: 'play',
                subscriptionId: purchaseToken,
                renewalDate: null,
                cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
                scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
                scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
                limitsSnapshot: admin.firestore.FieldValue.delete(),
                limitsSnapshotAt: admin.firestore.FieldValue.delete(),
                delinquentSince: admin.firestore.FieldValue.delete(),
                delinquentSinceIso: admin.firestore.FieldValue.delete(),
                lastStoreExpiredNotifiedExpiryIso: expiryIso || nowIso,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          } catch {
            // ignore
          }

          try {
            await tenantRef.set(
              {
                billingTier: 'free',
                quotas: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          } catch {
            // ignore
          }

          void sendTenantBillingEventNotification({
            tenantId,
            tenantName: undefined,
            kind: 'subscription_cancelled',
            title: 'Subscription cancelled',
            body: 'Your subscription has ended and the plan is now Free.',
            priority: 'medium',
            metadata: {
              provider: 'play',
              productId,
              subscriptionId: purchaseToken,
              orderId: orderId || null,
              renewalDate: expiryIso,
              paymentState,
              notificationType,
            },
          }).catch(() => undefined);
          return;
        }

        // Default: record and ignore unknown RTDN types.
        await recordBillingOpsEvent(db, {
          provider: 'play',
          type: 'play_rtdn_unhandled_notification_type',
          severity: 'info',
          message: 'Unhandled RTDN subscription notificationType',
          tenantId,
          subscriptionId: purchaseToken,
          httpStatus: 202,
          requestPath: '/billing/play/notifications',
          payloadPreview: safePreview(decoded),
          metadata: { messageId, publishTime, notificationType, productId, paymentState, orderId: orderId || null },
        });
      } catch (error) {
        try {
          const db = getFirestoreImpl();
          await recordBillingOpsEvent(db, {
            provider: 'play',
            type: 'play_rtdn_handler_failed',
            severity: 'error',
            message: typeof (error as any)?.message === 'string' ? (error as any).message : 'RTDN handler failed',
            httpStatus: 202,
            requestPath: '/billing/play/notifications',
            payloadPreview: safePreview(rawPayload),
          });
        } catch {
          // ignore
        }
        console.error('[billing_play_notification] handler failed', error);
      }
    })();
  });

  const appStoreNotificationParser = express.raw({ type: 'application/json' });
  app.post('/billing/appstore/notifications', appStoreNotificationParser, (req, res) => {
    if (!storeBillingFeatureEnabled()) {
      return res.status(503).json({ error: 'store_billing_disabled' });
    }
    const rawPayload = extractRawBody(req.body);
    console.info('[billing_appstore_notification] stub payload received', rawPayload.slice(0, 500));
    return res.status(202).json({ ok: true, provider: 'app_store' });
  });

  const stripeWebhookParser = express.raw({ type: 'application/json' });
  app.post('/billing/stripe/webhook', stripeWebhookParser, (req, res) => {
    return res.status(410).json({ error: 'stripe_disabled', message: 'Stripe billing is disabled; use Razorpay.' });
  });

  const razorpayWebhookParser = express.raw({ type: 'application/json' });
  app.post('/billing/razorpay/webhook', razorpayWebhookParser, (req, res) => {
    if (!billingWebhooksFeatureEnabled()) {
      return res.status(503).json({ error: 'billing_webhooks_disabled' });
    }
    const rawBodyBuffer = req.body instanceof Buffer ? req.body : Buffer.from(extractRawBody(req.body), 'utf8');
    const rawPayload = rawBodyBuffer.toString('utf8');

    const razorpayEventId = typeof req.headers['x-razorpay-event-id'] === 'string' ? req.headers['x-razorpay-event-id'] : null;
    const requestId = typeof req.headers['request-id'] === 'string' ? req.headers['request-id'] : null;

    const signature = typeof req.headers['x-razorpay-signature'] === 'string' ? req.headers['x-razorpay-signature'] : '';
    const webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
    const isTestMode = process.env.TEST_MODE === '1';

    if (!isTestMode) {
      if (!webhookSecret) {
        // Fail closed (security-rules-hardening M7): webhooks are enabled but no
        // secret is configured — refuse rather than process an UNVERIFIED payload
        // that drives tenant plan/limit changes off attacker-controlled notes.
        inc('billing_webhook_signature_failures_total', { provider: 'razorpay' });
        console.error('[billing_razorpay_webhook] RAZORPAY_WEBHOOK_SECRET not configured — refusing to process (fail closed)');
        return res.status(503).json({ error: 'webhook_secret_not_configured' });
      }
      const ok = verifyRazorpayWebhookSignature({ rawBody: rawBodyBuffer, signatureHeader: signature, webhookSecret });
      if (!ok) {
        inc('billing_webhook_signature_failures_total', { provider: 'razorpay' });
        const payloadLen = rawBodyBuffer.length;
        const payloadSha256 = crypto.createHash('sha256').update(rawBodyBuffer).digest('hex');
        console.warn('[billing_razorpay_webhook] invalid signature', {
          razorpayEventId,
          requestId,
          signaturePresent: Boolean(signature),
          signatureLen: (signature || '').length,
          payloadLen,
          payloadSha256Prefix: payloadSha256.slice(0, 12),
          contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
        });
        void (async () => {
          try {
            const parsed = (() => {
              try {
                return JSON.parse(rawPayload || '{}') as any;
              } catch {
                return null;
              }
            })();
            const paymentEntity = parsed?.payload?.payment?.entity;
            const subscriptionEntity = parsed?.payload?.subscription?.entity;
            const event = typeof parsed?.event === 'string' ? parsed.event : null;
            const subscriptionId = typeof subscriptionEntity?.id === 'string'
              ? subscriptionEntity.id
              : typeof paymentEntity?.subscription_id === 'string'
                ? paymentEntity.subscription_id
                : null;
            const paymentId = typeof paymentEntity?.id === 'string' ? paymentEntity.id : null;
            const tenantId =
              typeof subscriptionEntity?.notes?.tenantId === 'string'
                ? subscriptionEntity.notes.tenantId
                : typeof paymentEntity?.notes?.tenantId === 'string'
                  ? paymentEntity.notes.tenantId
                  : null;

            const db = getFirestoreImpl();
            await recordBillingOpsEvent(db, {
              provider: 'razorpay',
              type: 'razorpay_webhook_invalid_signature',
              severity: 'error',
              message: 'Invalid Razorpay webhook signature',
              httpStatus: 400,
              requestPath: '/billing/razorpay/webhook',
              ip: typeof req.ip === 'string' ? req.ip : null,
              userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
              tenantId,
              event,
              subscriptionId,
              paymentId,
              payloadPreview: safePreview(rawPayload),
              metadata: {
                razorpayEventId,
                requestId,
                signaturePresent: Boolean(signature),
                signatureLen: (signature || '').length,
                webhookSecretConfigured: Boolean(webhookSecret),
                payloadLen: rawBodyBuffer.length,
                payloadSha256: crypto.createHash('sha256').update(rawBodyBuffer).digest('hex'),
                contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
              },
            });
          } catch {
            // ignore
          }
        })();
        return res.status(400).json({ error: 'invalid_signature' });
      }
    }

    let parsed: RazorpayWebhookEvent;
    try {
      parsed = JSON.parse(rawPayload || '{}');
    } catch (error) {
      inc('billing_webhook_invalid_json_total', { provider: 'razorpay' });
      console.warn('[billing_razorpay_webhook] invalid json', { razorpayEventId, requestId, error });
      void (async () => {
        try {
          const db = getFirestoreImpl();
          await recordBillingOpsEvent(db, {
            provider: 'razorpay',
            type: 'razorpay_webhook_invalid_json',
            severity: 'error',
            message: 'Invalid Razorpay webhook JSON payload',
            httpStatus: 400,
            requestPath: '/billing/razorpay/webhook',
            ip: typeof req.ip === 'string' ? req.ip : null,
            userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
            payloadPreview: safePreview(rawPayload),
            metadata: {
              razorpayEventId,
              requestId,
              contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
              payloadLen: rawBodyBuffer.length,
            },
          });
        } catch {
          // ignore
        }
      })();
      return res.status(400).json({ error: 'invalid_json' });
    }

    void (async () => {
      try {
        const db = getFirestoreImpl();
        await handleRazorpayWebhook({ db, rawBody: rawPayload, parsedBody: parsed });
      } catch (error) {
        inc('billing_webhook_handler_failures_total', { provider: 'razorpay' });
        console.error('[billing_razorpay_webhook] handler failed', error);
        void (async () => {
          try {
            const paymentEntity = (parsed as any)?.payload?.payment?.entity;
            const subscriptionEntity = (parsed as any)?.payload?.subscription?.entity;
            const event = typeof (parsed as any)?.event === 'string' ? (parsed as any).event : null;
            const subscriptionId = typeof subscriptionEntity?.id === 'string'
              ? subscriptionEntity.id
              : typeof paymentEntity?.subscription_id === 'string'
                ? paymentEntity.subscription_id
                : null;
            const paymentId = typeof paymentEntity?.id === 'string' ? paymentEntity.id : null;
            const tenantId =
              typeof subscriptionEntity?.notes?.tenantId === 'string'
                ? subscriptionEntity.notes.tenantId
                : typeof paymentEntity?.notes?.tenantId === 'string'
                  ? paymentEntity.notes.tenantId
                  : null;

            const err = error as any;
            const stack = typeof err?.stack === 'string' ? err.stack : null;
            const message = typeof err?.message === 'string' ? err.message : 'Razorpay webhook handler failed';

            const db = getFirestoreImpl();
            await recordBillingOpsEvent(db, {
              provider: 'razorpay',
              type: 'razorpay_webhook_handler_failed',
              severity: 'error',
              message,
              httpStatus: 202,
              requestPath: '/billing/razorpay/webhook',
              ip: typeof req.ip === 'string' ? req.ip : null,
              userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
              tenantId,
              event,
              subscriptionId,
              paymentId,
              payloadPreview: safePreview(rawPayload),
              metadata: {
                razorpayEventId,
                requestId,
                stackPreview: safePreview(stack, 1200),
              },
            });
          } catch {
            // ignore
          }
        })();
      }
    })();

    inc('billing_webhook_accepted_total', { provider: 'razorpay' });

    return res.status(202).json({ ok: true, provider: 'razorpay' });
  });

  // ----- Twilio endpoints with validation + rate limiting -----
  const rl = rateLimitMiddleware({ windowMs: 60_000, max: 30 }); // 30 requests/minute per IP per endpoint
  app.post('/twilio/sms', rl, requireStaffTenantAccess, async (req,res)=>{
    const parsed = tenantScopedSmsSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({ error:'validation_failed', issues: parsed.error.issues });
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    const normalizedTenantId = tenantAccess.tenantId;
    const actorUid = req.authContext?.uid;
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const historyId = typeof parsed.data.historyId === 'string' ? parsed.data.historyId.trim() : '';
    const rawHistory = (parsed.data as any).history;
    const historyWithActor = rawHistory && typeof rawHistory === 'object'
      ? stripUndefinedDeep({ ...(rawHistory as any), userId: (rawHistory as any)?.userId || actorUid })
      : actorUid
        ? ({ userId: actorUid } as any)
        : undefined;

    try {
      if (parsed.data.quotaBatchId) {
        await consumeTenantReminderReservationToken(getFirestoreImpl(), normalizedTenantId, parsed.data.quotaBatchId, 'sms', {
          historyId: parsed.data.historyId,
          history: historyWithActor || undefined,
        });
      } else {
        await assertTenantReminderQuotaAvailable(getFirestoreImpl(), normalizedTenantId, 'sms', 1, {
          historyId: historyId || undefined,
          history: historyWithActor || undefined,
        });
      }
    } catch (error) {
      if (error instanceof TenantReminderLimitError) {
        return res.status(409).json({
          error: 'reminder_limit_reached',
          limit: error.limit,
          used: error.used,
          channel: error.channel,
        });
      }
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.warn('[twilio_sms] reminder quota check failed', error);
      const isTestMode = process.env.TEST_MODE === '1' || process.argv.includes('--test');
      if (!isTestMode) {
        return res.status(503).json({ error: 'reminder_quota_check_failed' });
      }
    }

    const { tenantId: _tenantId, quotaBatchId: _quotaBatchId, historyId: _historyId, history: _history, ...twilioPayload } = parsed.data;
    void _tenantId;
    void _quotaBatchId;
    void _history;

    if (historyId) {
      try {
        await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId, {
          ...(historyWithActor || {}),
          tenantId: normalizedTenantId,
          reminderType: 'sms',
          status: 'pending',
          message: twilioPayload.message,
          metadata: { deliveryStatus: 'sending' },
        });
      } catch (e) {
        console.warn('[twilio_sms] reminderHistory pre-send upsert failed', e);
      }
    }

    let result: any;
    try {
      result = await sendSMSImpl(twilioPayload);
    } catch (error: any) {
      if (historyId) {
        try {
          await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId, {
            ...(historyWithActor || {}),
            tenantId: normalizedTenantId,
            reminderType: 'sms',
            status: 'failed',
            message: twilioPayload.message,
            metadata: { deliveryStatus: 'failed' },
            errorMessage:
              typeof error?.message === 'string' && error.message.trim() ? error.message : 'sms_send_exception',
          });
        } catch (e) {
          console.warn('[twilio_sms] reminderHistory update failed (exception)', e);
        }

        try {
          await finalizeReminderQuotaFromHistory(getFirestoreImpl(), {
            historyId,
            finalStatus: 'failed',
            fallbackTenantId: normalizedTenantId,
            fallbackChannel: 'sms',
          });
        } catch (e) {
          console.warn('[twilio_sms] quota finalize failed (exception)', e);
        }
      }
      return res.status(500).json({ success: false, error: 'send_exception' });
    }
    if (historyId) {
      try {
        await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId, {
          ...(historyWithActor || {}),
          tenantId: normalizedTenantId,
          reminderType: 'sms',
          status: result.success ? 'success' : 'failed',
          message: twilioPayload.message,
          metadata: {
            deliveryStatus: result.success ? 'sent' : 'failed',
            twilioSid: result.success ? result.sid : undefined,
          },
          errorMessage: result.success ? undefined : (result as any)?.error || 'send_failed',
        });
      } catch (e) {
        console.warn('[twilio_sms] reminderHistory update failed', e);
      }

      try {
        await finalizeReminderQuotaFromHistory(getFirestoreImpl(), {
          historyId,
          finalStatus: result.success ? 'success' : 'failed',
          fallbackTenantId: normalizedTenantId,
          fallbackChannel: 'sms',
        });
      } catch (e) {
        console.warn('[twilio_sms] quota finalize failed', e);
      }
    }
    if(!result.success) return res.status(500).json(result);
    void logTenantAuditEventImpl({
      tenantId: normalizedTenantId,
      action: 'reminder_queued',
      authContext: req.authContext,
      metadata: {
        channel: 'twilio_sms',
        destination: twilioPayload.to,
        messageLength: twilioPayload.message.length,
        sid: result.sid,
      },
    });
    res.json(result);
  });

  app.post('/twilio/voice-call', rl, requireStaffTenantAccess, async (req,res)=>{
    const parsed = tenantScopedVoiceSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({ error:'validation_failed', issues: parsed.error.issues });
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    const normalizedTenantId = tenantAccess.tenantId;
    const actorUid = req.authContext?.uid;
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const historyId = typeof parsed.data.historyId === 'string' ? parsed.data.historyId.trim() : '';
    const rawHistory = (parsed.data as any).history;
    const historyWithActor = rawHistory && typeof rawHistory === 'object'
      ? stripUndefinedDeep({ ...(rawHistory as any), userId: (rawHistory as any)?.userId || actorUid })
      : actorUid
        ? ({ userId: actorUid } as any)
        : undefined;

    try {
      if (parsed.data.quotaBatchId) {
        await consumeTenantReminderReservationToken(getFirestoreImpl(), normalizedTenantId, parsed.data.quotaBatchId, 'voice', {
          historyId: parsed.data.historyId,
          history: historyWithActor || undefined,
        });
      } else {
        await assertTenantReminderQuotaAvailable(getFirestoreImpl(), normalizedTenantId, 'voice', 1, {
          historyId: historyId || undefined,
          history: historyWithActor || undefined,
        });
      }
    } catch (error) {
      if (error instanceof TenantReminderLimitError) {
        return res.status(409).json({
          error: 'reminder_limit_reached',
          limit: error.limit,
          used: error.used,
          channel: error.channel,
        });
      }
      if (error instanceof TenantAccessError) {
        return res.status(error.status).json(error.body);
      }
      console.warn('[twilio_voice] reminder quota check failed', error);
      const isTestMode = process.env.TEST_MODE === '1' || process.argv.includes('--test');
      if (!isTestMode) {
        return res.status(503).json({ error: 'reminder_quota_check_failed' });
      }
    }

    const { tenantId: _tenantId, quotaBatchId: _quotaBatchId, historyId: _historyId, history: _history, ...voicePayload } = parsed.data;
    void _tenantId;
    void _quotaBatchId;
    void _history;

    if (historyId) {
      try {
        await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId, {
          ...(historyWithActor || {}),
          tenantId: normalizedTenantId,
          reminderType: 'voice',
          status: 'pending',
          message: voicePayload.message,
          metadata: { deliveryStatus: 'sending' },
        });
      } catch (e) {
        console.warn('[twilio_voice] reminderHistory pre-send upsert failed', e);
      }
    }

    let result: any;
    try {
      result = await sendVoiceCallImpl(voicePayload);
    } catch (error: any) {
      if (historyId) {
        try {
          await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId, {
            ...(historyWithActor || {}),
            tenantId: normalizedTenantId,
            reminderType: 'voice',
            status: 'failed',
            message: voicePayload.message,
            metadata: { deliveryStatus: 'failed' },
            errorMessage:
              typeof error?.message === 'string' && error.message.trim() ? error.message : 'voice_send_exception',
          });
        } catch (e) {
          console.warn('[twilio_voice] reminderHistory update failed (exception)', e);
        }

        try {
          await finalizeReminderQuotaFromHistory(getFirestoreImpl(), {
            historyId,
            finalStatus: 'failed',
            fallbackTenantId: normalizedTenantId,
            fallbackChannel: 'voice',
          });
        } catch (e) {
          console.warn('[twilio_voice] quota finalize failed (exception)', e);
        }
      }
      return res.status(500).json({ success: false, error: 'send_exception' });
    }
    if (historyId) {
      try {
        await upsertReminderHistoryWithDates(getFirestoreImpl(), historyId, {
          ...(historyWithActor || {}),
          tenantId: normalizedTenantId,
          reminderType: 'voice',
          status: result.success ? 'success' : 'failed',
          message: voicePayload.message,
          metadata: {
            deliveryStatus: result.success ? 'sent' : 'failed',
            twilioSid: result.success ? result.sid : undefined,
          },
          errorMessage: result.success ? undefined : (result as any)?.error || 'send_failed',
        });
      } catch (e) {
        console.warn('[twilio_voice] reminderHistory update failed', e);
      }

      try {
        await finalizeReminderQuotaFromHistory(getFirestoreImpl(), {
          historyId,
          finalStatus: result.success ? 'success' : 'failed',
          fallbackTenantId: normalizedTenantId,
          fallbackChannel: 'voice',
        });
      } catch (e) {
        console.warn('[twilio_voice] quota finalize failed', e);
      }
    }
    if(!result.success) return res.status(500).json(result);
    void logTenantAuditEventImpl({
      tenantId: normalizedTenantId,
      action: 'reminder_queued',
      authContext: req.authContext,
      metadata: {
        channel: 'twilio_voice',
        destination: voicePayload.to,
        language: voicePayload.language ?? 'english',
        sid: result.sid,
        fallback: result.fallback,
      },
    });
    res.json(result);
  });

  const pushProxyRL = rateLimitMiddleware({ windowMs: 60_000, max: 120 });
  let apnsProviderCache: any | null = null;
  let apnsProviderInitAttempted = false;

  const resolveApnsProvider = (): { provider: any | null; topic: string | null } => {
    const topic = (process.env.APNS_BUNDLE_ID || '').trim();
    const keyId = (process.env.APNS_KEY_ID || '').trim();
    const teamId = (process.env.APNS_TEAM_ID || '').trim();
    const keyPath = (process.env.APNS_AUTH_KEY_PATH || '').trim();
    const keyB64 = (process.env.APNS_AUTH_KEY_B64 || '').trim();

    if (!topic || !keyId || !teamId || (!keyPath && !keyB64)) {
      return { provider: null, topic: null };
    }

    if (!apnsProviderInitAttempted) {
      apnsProviderInitAttempted = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const apnLib = require('apn') as any;
        const key = keyB64 ? Buffer.from(keyB64, 'base64').toString('utf8') : keyPath;
        apnsProviderCache = new apnLib.Provider({
          token: {
            key,
            keyId,
            teamId,
          },
          production: String(process.env.APNS_PRODUCTION || 'true').toLowerCase() !== 'false',
        });
      } catch (error) {
        console.warn('[push_proxy] APNs provider init failed', error);
        apnsProviderCache = null;
      }
    }

    return { provider: apnsProviderCache, topic };
  };

  app.post('/notifications/push', pushProxyRL, requireStaffTenantAccess, async (req,res)=>{
    const parsed = tenantScopedPushPayloadSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const payloadData = parsed.data as any;
    const { tenantId: _tenantId, ...payload } = payloadData;
    void _tenantId;

    const payloadAny = payload as any;
    const messageBatch: Array<{ to: string | string[] }> = Array.isArray(payloadAny.messages)
      ? payloadAny.messages
      : [payloadAny];
    const targetCount = messageBatch.reduce((count: number, msg) => {
      if (Array.isArray(msg?.to)) return count + msg.to.length;
      return count + 1;
    }, 0);
    const auditMetadata = {
      channel: 'expo_push',
      messageCount: messageBatch.length,
      targetCount,
      dryRun: Boolean('dryRun' in payloadAny ? payloadAny.dryRun : false),
    };

    if (process.env.TEST_MODE === '1') {
      void logTenantAuditEventImpl({
        tenantId: normalizedTenantId,
        action: 'reminder_queued',
        authContext: req.authContext,
        metadata: { ...auditMetadata, testMode: true },
      });
      return res.json({ data: { status: 'ok', id: 'test-mode', details: 'expo push skipped in test mode' } });
    }

    const requestPayload = 'messages' in payload ? { messages: payload.messages, dryRun: payload.dryRun } : payload;
    const endpoint = process.env.EXPO_PUSH_ENDPOINT || 'https://exp.host/--/api/v2/push/send';
    const timeoutMs = Number(process.env.EXPO_PUSH_PROXY_TIMEOUT_MS || 10000);

    const isExpoPushToken = (token: string): boolean => /^(ExponentPushToken|ExpoPushToken)\[/i.test(token);
    const toStringMap = (data: Record<string, unknown> | undefined): Record<string, string> => {
      if (!data || typeof data !== 'object') return {};
      const output: Record<string, string> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value == null) continue;
        if (typeof value === 'string') {
          output[key] = value;
          continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          output[key] = String(value);
          continue;
        }
        try {
          output[key] = JSON.stringify(value);
        } catch {
          output[key] = String(value);
        }
      }
      return output;
    };

    const looksLikeApnsToken = (token: string): boolean => /^[a-f0-9]{64,}$/i.test(token);
    const splitTargets = (raw: any): { expoMessages: any[]; fcmMessages: any[]; apnsMessages: any[] } => {
      const rawMessages = Array.isArray(raw?.messages) ? raw.messages : [raw];
      const expoMessages: any[] = [];
      const fcmMessages: any[] = [];
      const apnsMessages: any[] = [];

      for (const rawMessage of rawMessages) {
        const targets = Array.isArray(rawMessage?.to) ? rawMessage.to : [rawMessage?.to];
        const common = { ...rawMessage };
        delete (common as any).to;

        for (const target of targets) {
          if (typeof target !== 'string' || !target.trim()) {
            continue;
          }
          const token = target.trim();
          const hintRaw = common?.data?._tmPushTransportHint;
          const hint = typeof hintRaw === 'string' ? hintRaw.toLowerCase() : '';
          if (isExpoPushToken(token)) {
            expoMessages.push({ ...common, to: token });
          } else if (hint === 'apns' || looksLikeApnsToken(token)) {
            apnsMessages.push({ ...common, to: token });
          } else {
            fcmMessages.push({ ...common, to: token });
          }
        }
      }

      return { expoMessages, fcmMessages, apnsMessages };
    };

    const sendApnsMessages = async (messages: any[]): Promise<{ sent: number; failed: number; errors: any[] }> => {
      if (!messages.length) {
        return { sent: 0, failed: 0, errors: [] };
      }

      const { provider, topic } = resolveApnsProvider();
      if (!provider || !topic) {
        return {
          sent: 0,
          failed: messages.length,
          errors: messages.map((entry: any) => ({
            token: entry?.to,
            code: 'apns_not_configured',
            message: 'APNS_BUNDLE_ID/APNS_KEY_ID/APNS_TEAM_ID/APNS_AUTH_KEY_* missing',
          })),
        };
      }

      let sent = 0;
      let failed = 0;
      const errors: any[] = [];

      for (const message of messages) {
        const token = typeof message?.to === 'string' ? message.to.trim() : '';
        if (!token) {
          failed += 1;
          errors.push({ code: 'missing_token', message: 'Missing APNs token' });
          continue;
        }

        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const apnLib = require('apn') as any;
          const notification = new apnLib.Notification();
          notification.topic = topic;
          notification.pushType = (message?._contentAvailable || message?.data?._tmReceiptProbe) ? 'background' : 'alert';
          notification.priority = (message?.priority === 'high') ? 10 : 5;

          if (typeof message?.expiration === 'number') {
            notification.expiry = message.expiration;
          } else if (typeof message?.ttl === 'number' && Number.isFinite(message.ttl)) {
            notification.expiry = Math.floor(Date.now() / 1000) + Math.max(0, Math.floor(message.ttl));
          }

          if (typeof message?.title === 'string' || typeof message?.body === 'string') {
            notification.alert = {
              title: typeof message?.title === 'string' ? message.title : undefined,
              body: typeof message?.body === 'string' ? message.body : undefined,
            };
          }

          if (message?.sound === 'default') {
            notification.sound = 'default';
          }

          if (message?._contentAvailable) {
            notification.contentAvailable = 1;
          }
          if (message?.mutableContent) {
            notification.mutableContent = 1;
          }

          const payloadData = message?.data && typeof message.data === 'object' ? message.data : {};
          notification.payload = payloadData;

          const response = await provider.send(notification, token);
          const sentCount = Array.isArray(response?.sent) ? response.sent.length : 0;
          const failedItems = Array.isArray(response?.failed) ? response.failed : [];

          sent += sentCount;
          if (failedItems.length > 0) {
            failed += failedItems.length;
            for (const entry of failedItems) {
              errors.push({
                token,
                code: entry?.response?.reason || entry?.error?.code || 'apns_send_failed',
                message: entry?.response?.reason || entry?.error?.message || 'apns_send_failed',
              });
            }
          }
        } catch (error: any) {
          failed += 1;
          errors.push({
            token,
            code: error?.code || 'apns_send_failed',
            message: error?.message || String(error),
          });
        }
      }

      return { sent, failed, errors };
    };

    const sendFcmMessages = async (messages: any[]): Promise<{ sent: number; failed: number; errors: any[] }> => {
      if (!messages.length) {
        return { sent: 0, failed: 0, errors: [] };
      }

      ensureFirebase();
      const messaging = admin.messaging();
      let sent = 0;
      let failed = 0;
      const errors: any[] = [];

      for (const message of messages) {
        const token = typeof message?.to === 'string' ? message.to.trim() : '';
        if (!token) {
          failed += 1;
          errors.push({ error: 'missing_token' });
          continue;
        }

        const data = toStringMap(message?.data as Record<string, unknown> | undefined);
        const highPriority = (message?.priority === 'high') || data.priority === 'high';
        const fcmPayload: admin.messaging.Message = {
          token,
          data,
          android: {
            priority: highPriority ? 'high' : 'normal',
            notification: {
              channelId: typeof message?.channelId === 'string' ? message.channelId : undefined,
              sound: message?.sound === 'default' ? 'default' : undefined,
            },
          },
          apns: {
            headers: {
              'apns-priority': highPriority ? '10' : '5',
            },
            payload: {
              aps: {
                sound: message?.sound === 'default' ? 'default' : undefined,
                'content-available': message?._contentAvailable ? 1 : undefined,
                'mutable-content': message?.mutableContent ? 1 : undefined,
              },
            },
          },
          notification: (typeof message?.title === 'string' || typeof message?.body === 'string')
            ? {
                title: typeof message?.title === 'string' ? message.title : undefined,
                body: typeof message?.body === 'string' ? message.body : undefined,
              }
            : undefined,
        };

        try {
          await messaging.send(stripUndefinedDeep(fcmPayload) as admin.messaging.Message, Boolean((requestPayload as any)?.dryRun));
          sent += 1;
        } catch (error: any) {
          failed += 1;
          errors.push({
            token,
            code: error?.code || 'fcm_send_failed',
            message: error?.message || String(error),
          });
        }
      }

      return { sent, failed, errors };
    };

    try {
      const targets = splitTargets(requestPayload);
      const expoPayload = targets.expoMessages.length === 1
        ? targets.expoMessages[0]
        : targets.expoMessages;
      const expoResult = targets.expoMessages.length
        ? await executeExpoPushProxyRequestImpl({
            payload: expoPayload,
            endpoint,
            timeoutMs,
            fetchImpl,
          })
        : null;

      if (expoResult && !expoResult.ok) {
        console.warn('[push_proxy] expo push request failed', expoResult.status, expoResult.rawBody?.slice?.(0, 200));
        return res.status(expoResult.status).json(expoResult.body);
      }

      const apnsResult = await sendApnsMessages(targets.apnsMessages);
      const fcmResult = await sendFcmMessages(targets.fcmMessages);

      void logTenantAuditEventImpl({
        tenantId: normalizedTenantId,
        action: 'reminder_queued',
        authContext: req.authContext,
        metadata: {
          ...auditMetadata,
          status: expoResult?.status ?? 200,
          expoTargetCount: targets.expoMessages.length,
          apnsTargetCount: targets.apnsMessages.length,
          fcmTargetCount: targets.fcmMessages.length,
          apnsSent: apnsResult.sent,
          apnsFailed: apnsResult.failed,
          fcmSent: fcmResult.sent,
          fcmFailed: fcmResult.failed,
        },
      });

      const hasNativeFailures = apnsResult.failed > 0 || fcmResult.failed > 0;
      const responseStatus = expoResult?.status ?? (hasNativeFailures ? 207 : 200);
      const expoBody = expoResult?.body;
      return res.status(responseStatus).json({
        ok: apnsResult.failed === 0 && fcmResult.failed === 0,
        expo: expoBody,
        apns: apnsResult,
        fcm: fcmResult,
      });
    } catch (e: any) {
      const message = e?.name === 'AbortError' ? 'expo_push_timeout' : e?.message || String(e);
      console.warn('[push_proxy] error', message);
      return res.status(502).json({ error: 'expo_push_failed', message });
    }
  });

  // Fanout_Endpoint — POST /notifications/fanout (device-push-fanout-migration,
  // design "Components §1 Fanout_Endpoint" + "§3 Fanout_Authorization").
  //
  // The Server_Fanout entry point: the client delegates push-target resolution
  // and push delivery here so it never reads a recipient's device documents
  // (Req 1.3). The middleware chain mirrors `/notifications/push`:
  //   pushProxyRL → requireMemberTenantAccess (Fanout_Authorization, min role
  //   `member` — Req 5.1, 5.3, 5.5).
  // The global auth middleware has already authenticated the sender's per-user
  // internal token (Req 5.1); an unauthenticated request never reaches here.
  app.post('/notifications/fanout', pushProxyRL, requireMemberTenantAccess, async (req, res) => {
    const parsed = fanoutPayloadSchema.safeParse(req.body || {});
    if (!parsed.success) {
      // Req 1.4: reject a malformed payload before any device resolution.
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    // Confirm the body's tenant matches the authorized tenant scope, mirroring
    // `/notifications/push` (defence-in-depth against a caller acting outside the
    // tenant it authenticated against).
    if (parsed.data.tenantId.trim() !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    // Elevated-type authorization (Req 5.5): a `team_membership_change`
    // notification requires the caller to hold at least the `staff` role in the
    // tenant. `member` is the default for chat/notice types. The role comparison
    // reuses the shared `tenantRolePriority` ladder (member 1 < staff 2 < admin 3
    // < owner 4) — no hand-rolled role logic. Rejecting here happens BEFORE any
    // device resolution, so an under-privileged caller never resolves the
    // recipient's Push_Targets (Req 5.2).
    const notificationType =
      typeof parsed.data.notification.data?.type === 'string'
        ? parsed.data.notification.data.type
        : undefined;
    if (notificationType === 'team_membership_change') {
      const currentRank = tenantRolePriority[tenantAccess.role] ?? 0;
      const requiredRank = tenantRolePriority.staff;
      if (currentRank < requiredRank) {
        return res.status(403).json({ error: 'insufficient_role' });
      }
    }

    // Resolve the acting sender's identity for the fan-out audit/observability,
    // exactly as the device-admin `notify` route builds its `actor`.
    const actorEmail = await resolveAuthenticatedEmail(req.authContext);
    const actor = {
      id: req.authContext?.uid,
      email: actorEmail ?? undefined,
      name: actorEmail ?? undefined,
    };

    // SECURITY (security-rules-hardening M6): the fan-out's `senderEmail` and
    // `allowWhenDisabled` must be server-controlled, NOT taken from the client-
    // supplied `notification.data`. Otherwise a tenant member could (a) spoof
    // another `senderEmail` (which drives active-chat suppression) and (b) set
    // `allowWhenDisabled:true` to push to recipients who disabled that
    // notification type. senderEmail is forced to the authenticated actor;
    // allowWhenDisabled is honored only for the master/system caller.
    const clientNotificationData = (parsed.data.notification.data ?? {}) as Record<string, unknown>;
    const sanitizedNotification = {
      ...parsed.data.notification,
      data: {
        ...clientNotificationData,
        senderEmail: actorEmail ?? undefined,
        allowWhenDisabled:
          req.authContext?.tokenType === 'master' ? clientNotificationData.allowWhenDisabled === true : false,
      },
    };

    // Delegate to the Server_Fanout. It resolves the recipient's devices through
    // the Admin SDK, applies the Delivery_Filter, delivers push, performs the
    // cross-user writes, and returns the counts-only Fanout_Result — it never
    // throws to the endpoint (Req 6.5).
    const result = await deviceFanoutImpl({
      tenantId: tenantAccess.tenantId,
      recipientEmail: parsed.data.recipientEmail.trim().toLowerCase(),
      notification: sanitizedNotification,
      onlineOnly: parsed.data.onlineOnly ?? true,
      // Single-device targeting (Part B): route the optional `deviceId` through
      // as the fan-out's `targetDeviceId`. Absent → recipient-wide fan-out.
      targetDeviceId: parsed.data.deviceId,
      actor,
    });

    // Respond with ONLY the ten DeviceNotificationFanoutResult counts — never a
    // recipient's push tokens, web-push endpoints, or device network metadata
    // (Req 5.4). `serializeFanoutResponse` guarantees the counts-only shape.
    return res.json(serializeFanoutResponse(result));
  });

  // Online-status resolution — POST /notifications/online-status
  // (device-push-fanout-migration Stage 3; design "Cross_User_Reader migration
  // inventory"). The server-side replacement for the client
  // `checkUserOnlineStatus` cross-user read: it resolves the recipient's devices
  // through the Admin SDK (Req 7.3) and returns ONLY the boolean "any device
  // online" result (Req 7.5) — no per-device detail, no tokens, no endpoints, no
  // network metadata (Req 5.4). Middleware mirrors `/notifications/fanout`:
  //   pushProxyRL → requireMemberTenantAccess (min role `member`).
  app.post('/notifications/online-status', pushProxyRL, requireMemberTenantAccess, async (req, res) => {
    const parsed = onlineStatusPayloadSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId.trim() !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    // Tenant-scoped Admin-SDK resolution. Returns only the boolean.
    const online = await resolveRecipientOnlineStatusImpl({
      tenantId: tenantAccess.tenantId,
      recipientEmail: parsed.data.recipientEmail.trim().toLowerCase(),
    });

    return res.json({ online });
  });

  // Multi-user device listing — POST /notifications/device-listing
  // (device-push-fanout-migration Stage 3). The server-side replacement for the
  // client `getAllUsersWithDevices` cross-user reads: it resolves each
  // recipient's devices through the Admin SDK (Req 7.3) and returns the same
  // observable listing the client produced (Req 7.5), with every device's raw
  // push tokens, web-push subscription endpoints, and device network metadata
  // stripped (Req 5.4). Middleware mirrors `/notifications/fanout`.
  app.post('/notifications/device-listing', pushProxyRL, requireMemberTenantAccess, async (req, res) => {
    const parsed = deviceListingPayloadSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId.trim() !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    // Tenant-scoped Admin-SDK resolution. Each returned device is secret-free.
    const users = await listRecipientsWithDevicesImpl({
      tenantId: tenantAccess.tenantId,
      recipientEmails: parsed.data.recipientEmails,
      currentUserEmail: parsed.data.currentUserEmail,
      includeCurrentUser: parsed.data.includeCurrentUser,
    });

    return res.json({ users });
  });

  app.get('/notifications/web-push/config', requireMemberTenantAccessFromQuery, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess?.tenantId) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    if (!isWebPushConfigured()) {
      return res.json({ enabled: false });
    }

    return res.json({
      enabled: true,
      publicKey: getWebPushPublicKey(),
    });
  });

  app.post('/notifications/web-push/subscribe', requireMemberTenantAccess, async (req, res) => {
    const parsed = tenantScopedWebPushSubscribeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId.trim() !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const actorEmail = normalizeEmail((await resolveAuthenticatedEmail(req.authContext)) || req.authContext?.email || '');
    if (!actorEmail) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const sanitized = sanitizeWebPushSubscription(parsed.data.subscription);
    if (!sanitized) {
      return res.status(400).json({ error: 'invalid_subscription' });
    }

    try {
      const db = getFirestoreImpl();
      const deviceRef = db.collection('user_devices').doc(actorEmail).collection('devices').doc(parsed.data.deviceId);
      const userRef = db.collection('user_devices').doc(actorEmail);

      await deviceRef.set({
        deviceId: parsed.data.deviceId,
        ownerEmail: actorEmail,
        tenantIds: admin.firestore.FieldValue.arrayUnion(tenantAccess.tenantId),
        activeTenantId: tenantAccess.tenantId,
        webPushSubscription: sanitized,
        webPushStatus: 'subscribed',
        webPushVapidPublicKey: getWebPushPublicKey(),
        webPushSubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        webPushLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        webPushLastErrorAt: admin.firestore.FieldValue.delete(),
        webPushLastErrorCode: admin.firestore.FieldValue.delete(),
        notificationPermission: parsed.data.notificationPermission,
        userAgent: parsed.data.userAgent,
        serviceWorkerSupport: true,
        pushNotificationsSupport: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await userRef.set({
        email: actorEmail,
        tenantIds: admin.firestore.FieldValue.arrayUnion(tenantAccess.tenantId),
        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.json({ ok: true, status: 'subscribed' });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/notifications/web-push/unsubscribe', requireMemberTenantAccess, async (req, res) => {
    const parsed = tenantScopedWebPushUnsubscribeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId.trim() !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const actorEmail = normalizeEmail((await resolveAuthenticatedEmail(req.authContext)) || req.authContext?.email || '');
    if (!actorEmail) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const db = getFirestoreImpl();
      const deviceRef = db.collection('user_devices').doc(actorEmail).collection('devices').doc(parsed.data.deviceId);
      await deviceRef.set({
        webPushSubscription: admin.firestore.FieldValue.delete(),
        webPushStatus: 'unsubscribed',
        webPushLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.json({ ok: true, status: 'unsubscribed' });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/notifications/web-push/send', pushProxyRL, requireStaffTenantAccess, async (req, res) => {
    const parsed = tenantScopedWebPushSendSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId.trim() !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const db = getFirestoreImpl();
      const usersSnap = await db.collection('user_devices').where('tenantIds', 'array-contains', tenantAccess.tenantId).get();
      let matchedDevice: { ref: admin.firestore.DocumentReference<admin.firestore.DocumentData>; data: admin.firestore.DocumentData } | null = null;

      for (const userDoc of usersSnap.docs) {
        const deviceRef = userDoc.ref.collection('devices').doc(parsed.data.deviceId);
        const deviceSnap = await deviceRef.get();
        if (deviceSnap.exists) {
          matchedDevice = { ref: deviceRef, data: deviceSnap.data() || {} };
          break;
        }
      }

      if (!matchedDevice) {
        return res.status(404).json({ error: 'device_not_found' });
      }

      const subscription = sanitizeWebPushSubscription(matchedDevice.data.webPushSubscription);
      if (!subscription) {
        return res.status(404).json({ error: 'no_web_push_subscription' });
      }

      const notificationId = typeof parsed.data.data?.notificationId === 'string' && parsed.data.data.notificationId.trim()
        ? parsed.data.data.notificationId.trim()
        : `webpush:${parsed.data.deviceId}:${Date.now()}`;

      const result = await sendWebPushNotification({
        subscription,
        payload: {
          title: parsed.data.title,
          body: parsed.data.body,
          tag: parsed.data.tag,
          requireInteraction: parsed.data.requireInteraction,
          clickUrl: parsed.data.clickUrl,
          data: {
            ...(parsed.data.data || {}),
            notificationId,
            deviceId: parsed.data.deviceId,
          },
        },
        ttl: parsed.data.ttl,
        urgency: parsed.data.urgency,
      });

      if (!result.ok && result.shouldDeleteSubscription) {
        await matchedDevice.ref.set({
          webPushSubscription: admin.firestore.FieldValue.delete(),
          webPushStatus: 'unsubscribed',
          webPushLastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
          webPushLastErrorCode: result.errorCode || 'subscription_gone',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } else if (result.ok) {
        await matchedDevice.ref.set({
          webPushStatus: 'subscribed',
          webPushLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          webPushLastErrorAt: admin.firestore.FieldValue.delete(),
          webPushLastErrorCode: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        await matchedDevice.ref.set({
          webPushStatus: 'error',
          webPushLastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
          webPushLastErrorCode: result.errorCode || 'web_push_failed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      if (!result.ok) {
        return res.status(result.statusCode || 502).json({ ok: false, error: result.errorCode || 'web_push_failed' });
      }

      return res.json({ ok: true, notificationId });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/notifications/web-push/test', pushProxyRL, requireStaffTenantAccess, async (req, res) => {
    const parsed = tenantScopedWebPushTestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId.trim() !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const db = getFirestoreImpl();
      const usersSnap = await db.collection('user_devices').where('tenantIds', 'array-contains', tenantAccess.tenantId).get();
      let matchedDevice: { ref: admin.firestore.DocumentReference<admin.firestore.DocumentData>; data: admin.firestore.DocumentData } | null = null;

      for (const userDoc of usersSnap.docs) {
        const deviceRef = userDoc.ref.collection('devices').doc(parsed.data.deviceId);
        const deviceSnap = await deviceRef.get();
        if (deviceSnap.exists) {
          matchedDevice = { ref: deviceRef, data: deviceSnap.data() || {} };
          break;
        }
      }

      if (!matchedDevice) {
        return res.status(404).json({ error: 'device_not_found' });
      }

      const subscription = sanitizeWebPushSubscription(matchedDevice.data.webPushSubscription);
      if (!subscription) {
        return res.status(404).json({ error: 'no_web_push_subscription' });
      }

      const notificationType = parsed.data.type?.trim() || 'admin_web_push_test';
      const notificationId = `webpush:test:${parsed.data.deviceId}:${Date.now()}`;
      const title = parsed.data.title?.trim() || 'Web Push Test';
      const body = parsed.data.body?.trim() || 'This is a live Web Push test notification from Tuition Manager.';
      const result = await sendWebPushNotification({
        subscription,
        payload: {
          title,
          body,
          requireInteraction: parsed.data.requireInteraction ?? true,
          clickUrl: parsed.data.clickUrl?.trim() || '/(tabs)',
          tag: `web-push-test:${parsed.data.deviceId}`,
          data: {
            type: notificationType,
            notificationId,
            deviceId: parsed.data.deviceId,
            tenantId: tenantAccess.tenantId,
            source: 'admin_web_push_test',
          },
        },
        ttl: 300,
        urgency: 'high',
      });

      if (!result.ok && result.shouldDeleteSubscription) {
        await matchedDevice.ref.set({
          webPushSubscription: admin.firestore.FieldValue.delete(),
          webPushStatus: 'unsubscribed',
          webPushLastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
          webPushLastErrorCode: result.errorCode || 'subscription_gone',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } else if (result.ok) {
        await matchedDevice.ref.set({
          webPushStatus: 'subscribed',
          webPushLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          webPushLastErrorAt: admin.firestore.FieldValue.delete(),
          webPushLastErrorCode: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      if (!result.ok) {
        return res.status(result.statusCode || 502).json({ ok: false, error: result.errorCode || 'web_push_failed' });
      }

      return res.json({
        ok: true,
        notificationId,
        deviceId: parsed.data.deviceId,
        title,
        body,
        type: notificationType,
      });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.get('/tenants/:tenantId/export', requireParamsStaffTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const exportStarted = new Date();
    const exportStartedIso = exportStarted.toISOString();
    const exportedBy = (await resolveAuthenticatedEmail(req.authContext)) ?? req.authContext?.uid ?? null;
    const safeTenantId = tenantAccess.tenantId.replace(/[^A-Za-z0-9_-]/g, '_');
    const safeTimestamp = exportStartedIso.replace(/[:]/g, '-').replace(/\./g, '-');
    const filename = `tenant-${safeTenantId}-export-${safeTimestamp}.json.gz`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    const gzip = createGzip({ level: 6 });
    const abortController = new AbortController();
    const handleAbort = () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };

    req.on('aborted', handleAbort);
    req.on('close', handleAbort);

    gzip.on('error', (error) => {
      console.error('[tenant_export] gzip stream error', error);
      if (!res.headersSent) {
        res.removeHeader('Content-Encoding');
        res.removeHeader('Content-Disposition');
        res.status(500).json({ error: 'tenant_export_failed' });
      } else {
        res.destroy(error);
      }
    });

    gzip.pipe(res);

    try {
      const result = await streamTenantExportImpl({
        tenantId: tenantAccess.tenantId,
        writer: gzip,
        exportedBy,
        signal: abortController.signal,
        startedAt: exportStartedIso,
      });
      gzip.end();
      void logTenantAuditEventImpl({
        tenantId: tenantAccess.tenantId,
        action: 'tenant_data_exported',
        authContext: req.authContext,
        targetType: 'export',
        metadata: {
          exportedBy,
          durationMs: Date.now() - exportStarted.getTime(),
          totalDocuments: result.totalDocuments,
          datasetCounts: result.datasetCounts,
          format: 'json.gz',
        },
      });
    } catch (error) {
      gzip.destroy();
      if (error instanceof TenantExportAbortedError || abortController.signal.aborted) {
        console.warn('[tenant_export] request aborted', { tenantId: tenantAccess.tenantId });
        return;
      }
      console.error('[tenant_export] failed', error);
      if (!res.headersSent) {
        res.removeHeader('Content-Encoding');
        res.removeHeader('Content-Disposition');
        return res.status(500).json({ error: 'tenant_export_failed' });
      }
    } finally {
      req.off('aborted', handleAbort);
      req.off('close', handleAbort);
    }
  });

  // Force logout every active in-tenant device of a member (tenant-admin authorized).
  //
  // This is the app-client-reachable counterpart to the master-gated
  // `/admin/tenants/devices/force-logout-all` Device Console endpoint. The app
  // client authenticates with a per-user INTERNAL token (Firebase ID token ->
  // `/auth/bridge`), not a master token, so it cannot call the master-gated
  // console route. Instead it proves tenant-admin access through the shared
  // tenant-access guard (`requireParamsAdminTenantAccess`, owner/admin only) and
  // reuses the exact same `deviceAdminService.forceLogoutAll` orchestrator, so
  // the signal writes + audit entry are identical to the console path.
  //
  // The client calls this when an authorized email is removed from a tenant:
  // Stage 4 locked `logout_signals` / `user_devices` to backend-only writes, so
  // the former direct-Firestore force-logout can no longer run on the device.
  app.post('/tenants/:tenantId/members/force-logout', requireParamsAdminTenantAccess, async (req, res) => {
    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    // Defense-in-depth: the guard already enforced minRole 'admin', but mirror
    // the membership routes' explicit owner/admin gate so a low-role caller is
    // rejected here too (Req 16.1/16.2).
    if (tenantAccess.role !== 'owner' && tenantAccess.role !== 'admin') {
      return res.status(403).json({ error: 'admin_role_required' });
    }

    // Body is just the target member email (tenantId comes from the resolved,
    // authorized route param). Trim + validate as an email, max 200 chars.
    const parsed = z
      .object({ email: z.string().trim().email().max(200) })
      .safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const normalizedEmail = normalizeEmail(parsed.data.email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }

    try {
      // Resolve the acting admin identity the same way the other device/admin
      // routes do so provenance + audit attribute the action (Req 16.3).
      const actorEmail = await resolveAuthenticatedEmail(req.authContext);
      const actor = {
        id: req.authContext?.uid,
        email: actorEmail ?? undefined,
        name: actorEmail ?? undefined,
      };
      const result = await forceLogoutAll({
        tenantId: tenantAccess.tenantId,
        email: normalizedEmail,
        actor,
      });
      return res.json({ ok: true, affected: result.affected });
    } catch (error) {
      // Partial signal-write failure: some devices were signaled, others kept
      // their sessions — return 500 identifying the affected devices (Req 11.4).
      // Checked before the generic mapping because ForceLogoutAllError extends
      // DeviceAdminError.
      if (error instanceof ForceLogoutAllError) {
        return res.status(500).json({
          error: 'signal_write_failed',
          affected: error.affected,
          failedDeviceIds: error.failedDeviceIds,
        });
      }
      // Any other typed lifecycle/scope error maps via its carried status + code.
      if (error instanceof DeviceAdminError) {
        return res.status(error.status).json({ error: error.code });
      }
      console.error('[tenant_members_force_logout] failed', error);
      return res.status(500).json({ error: 'force_logout_all_failed' });
    }
  });

  app.get('/notifications/daily-quotes/status', optionalQueryStaffTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';

    if (!tenantId) {
      if (authContext.tokenType === 'master') {
        return res.json(getDailyQuoteSchedulerStatus());
      }
      return res.status(400).json({ error: 'tenant_required' });
    }
    if (!req.tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    res.json(getDailyQuoteSchedulerStatus());
  });

  app.post('/notifications/daily-quotes/trigger', requireStaffTenantAccess, async (req, res) => {
    const parsed = tenantScopedDailyQuoteTriggerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    const normalizedTenantId = tenantAccess.tenantId;
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== normalizedTenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const { timeOfDay, targetEmails, dryRun, reason, now } = parsed.data;
      let overrideNow: Date | undefined;
      if (now) {
        const parsedNow = new Date(now);
        if (Number.isNaN(parsedNow.getTime())) {
          return res.status(400).json({ error: 'invalid_now' });
        }
        overrideNow = parsedNow;
      }
      const stats = await runDailyQuoteJobImpl({
        tenantId: normalizedTenantId,
        timeOfDay,
        targetEmails,
        dryRun,
        reason,
        now: overrideNow,
      });

      const targetEmailsCount = Array.isArray(targetEmails) ? targetEmails.length : 0;
      const statsSummary = {
        sent: stats.sent,
        failed: stats.failed,
        attemptedDeliveries: stats.attemptedDeliveries,
        eligibleDevices: stats.eligibleDevices,
        totalDevices: stats.totalDevices,
        dryRun: stats.dryRun,
      };
      void logTenantAuditEventImpl({
        tenantId: normalizedTenantId,
        action: 'daily_quotes_triggered',
        authContext: req.authContext,
        targetType: 'job',
        metadata: {
          timeOfDay: timeOfDay ?? 'auto',
          dryRun: Boolean(dryRun),
          reason: reason ?? 'manual_trigger',
          targetEmailsCount,
          overrideNow: overrideNow?.toISOString(),
          stats: statsSummary,
        },
      });

      res.json({ ok: true, stats });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  type BirthdayTriggerDefaults = Partial<Pick<BirthdayJobOptions, 'dryRun' | 'forceSend' | 'skipWhatsApp' | 'suppressStateUpdates' | 'reason' | 'now'>>;

  async function handleBirthdayTrigger(
    req: express.Request,
    res: express.Response,
    defaults: BirthdayTriggerDefaults = {}
  ) {
    const parsed = tenantScopedBirthdayTriggerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    const tenantId = tenantAccess.tenantId;
    const providedTenantId = typeof parsed.data.tenantId === 'string' ? parsed.data.tenantId.trim() : '';
    if (providedTenantId && providedTenantId !== tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    try {
      const {
        email,
        emails,
        deviceId,
        deviceIds,
        dryRun,
        forceSend,
        skipWhatsApp,
        suppressStateUpdates,
        reason,
        now,
      } = parsed.data;

      const emailSet = new Set<string>();
      if (typeof email === 'string') emailSet.add(email);
      if (Array.isArray(emails)) emails.forEach(entry => emailSet.add(entry));

      const combinedDeviceIds = [
        ...(typeof deviceId === 'string' ? [deviceId] : []),
        ...(Array.isArray(deviceIds) ? deviceIds : []),
      ]
        .map(id => id.trim())
        .filter(Boolean);
      const deviceIdSet = new Set(combinedDeviceIds);

      const options: BirthdayJobOptions = {
        tenantId,
        targetEmails: emailSet.size > 0 ? Array.from(emailSet) : undefined,
        targetDeviceIds: deviceIdSet.size > 0 ? Array.from(deviceIdSet) : undefined,
        dryRun: dryRun ?? defaults.dryRun,
        forceSend: forceSend ?? defaults.forceSend,
        skipWhatsApp: skipWhatsApp ?? defaults.skipWhatsApp,
        suppressStateUpdates: suppressStateUpdates ?? defaults.suppressStateUpdates,
        reason: reason ?? defaults.reason ?? 'manual_trigger',
      };

      if (now) {
        const parsedNow = new Date(now);
        if (Number.isNaN(parsedNow.getTime())) {
          return res.status(400).json({ error: 'invalid_now' });
        }
        options.now = parsedNow;
      } else if (defaults.now instanceof Date) {
        options.now = defaults.now;
      }

      const stats = await runBirthdayNotificationJobImpl(options);
      const targetDeviceIdsCount = deviceIdSet.size;
      const targetEmailsCount = emailSet.size;
      void logTenantAuditEventImpl({
        tenantId,
        action: 'birthday_job_triggered',
        authContext: req.authContext,
        targetType: 'job',
        metadata: {
          dryRun: Boolean(options.dryRun),
          forceSend: Boolean(options.forceSend),
          skipWhatsApp: Boolean(options.skipWhatsApp),
          suppressStateUpdates: Boolean(options.suppressStateUpdates),
          reason: options.reason,
          targetEmailsCount,
          targetDeviceIdsCount,
          stats,
        },
      });
      res.json({ ok: true, stats });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  }

  app.post('/notifications/birthday/trigger', requireStaffTenantAccess, (req, res) => handleBirthdayTrigger(req, res));
  app.post('/notifications/birthday/test', requireStaffTenantAccess, (req, res) =>
    handleBirthdayTrigger(req, res, {
      forceSend: true,
      skipWhatsApp: true,
      suppressStateUpdates: true,
      reason: 'manual_birthday_test',
    })
  );

  app.post('/devices/ping', requireMemberTenantAccess, async (req, res) => {
    const parsed = devicePingSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    const tenantId = tenantAccess?.tenantId?.trim();
    if (!tenantAccess || !tenantId) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }

    if (tenantId !== parsed.data.tenantId.trim()) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }

    const normalizedEmail = normalizeEmail(parsed.data.userEmail);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'invalid_email' });
    }

    const authEmail = normalizeEmail(req.authContext?.email || '');
    // The caller must be the device owner. Only the raw master key (no email) is
    // exempt; any other token MUST match rather than skipping the check when its
    // email is absent (security-rules-hardening L5 — close the fail-open).
    if (req.authContext?.tokenType !== 'master' && authEmail !== normalizedEmail) {
      return res.status(403).json({ error: 'email_mismatch' });
    }

    const deviceId = parsed.data.deviceId.trim();
    if (!deviceId) {
      return res.status(400).json({ error: 'invalid_device_id' });
    }

    try {
      const db = getFirestoreImpl();
      const deviceRef = db.collection('user_devices').doc(normalizedEmail).collection('devices').doc(deviceId);
      const userRef = db.collection('user_devices').doc(normalizedEmail);
      const pingType = parsed.data.pingType;
      const activity = resolveDevicePingActivity(pingType);
      const baseUpdate: admin.firestore.UpdateData<admin.firestore.DocumentData> = {
        deviceId,
        ownerEmail: normalizedEmail,
        tenantIds: admin.firestore.FieldValue.arrayUnion(tenantId),
        activeTenantId: tenantId,
        lastTenantId: tenantId,
        lastTenantPingAt: admin.firestore.FieldValue.serverTimestamp(),
        tenantEnforcedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        isOnline: parsed.data.isOnline ?? true,
        lastActivityType: activity,
        lastPingType: pingType,
      };

      if (parsed.data.requestId) {
        baseUpdate.lastPingRequestId = parsed.data.requestId;
      }
      if (req.authContext?.uid) {
        baseUpdate.ownerUid = req.authContext.uid;
      }

      // Device_Tenant_Index write-path maintenance (device-tenant-index feature).
      // This endpoint is the single backend writer of the Tenant_Scoping_Source
      // (`tenantIds`/`activeTenantId`), so it also keeps the denormalized derived
      // `tenantIndex` consistent IN THE SAME atomic write per the
      // "recompute-and-persist-in-the-same-write" contract documented in
      // deviceAdminService. `tenantId` is already trimmed + non-empty (schema
      // `.trim().min(1)` and the tenant guard above), so no empty id is ever
      // written into the index (Requirement 1.4).
      if (pingType === 'register') {
        // FULL RECOMPUTE. Registration is the only moment scope can SHRINK or
        // `tenantMemberships` can change: the client's preceding setDoc(merge)
        // may have replaced/removed `tenantIds`/`tenantMemberships`/
        // `activeTenantId` wholesale. We therefore read the CURRENT (post
        // client-merge) source inside a transaction, apply this ping's
        // contribution (add + activate the pinged tenant), recompute the whole
        // index via `deriveTenantIndex`, and write scope + index together
        // atomically (Requirements 2.1, 2.2, 2.4, 2.5, 3.2). On transaction
        // failure nothing changes and the outer catch surfaces 500
        // internal_error (Requirement 2.6) — the failure is not swallowed.
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(deviceRef);
          const current = (snap.data() ?? {}) as Record<string, unknown>;
          const resultingSource = buildResultingTenantScopeForAddedTenant(current, tenantId);
          const tenantIndex = deriveTenantIndex(resultingSource);
          tx.set(deviceRef, { ...baseUpdate, tenantIndex }, { merge: true });
        });
      } else {
        // ADDITIVE. `heartbeat`/`full` pings only ever ADD the pinged tenant to
        // scope (`arrayUnion` on `tenantIds`, `activeTenantId = tenantId`); they
        // never remove a tenant and never touch `tenantMemberships`. So the only
        // effect on the derived index is "ensure `tenantId` is present" — a
        // matching `arrayUnion` on `tenantIndex` in the SAME set(merge) keeps the
        // scope change and index change in ONE atomic write with NO extra read,
        // preserving the hot heartbeat path's cost (Requirements 2.3, 2.5, 3.1,
        // 3.3). A presence-only heartbeat still (idempotently) reasserts the
        // pinged tenant and never drops existing tenants.
        baseUpdate.tenantIndex = admin.firestore.FieldValue.arrayUnion(tenantId);
        await deviceRef.set(baseUpdate, { merge: true });
      }

      const parentUpdate: admin.firestore.UpdateData<admin.firestore.DocumentData> = {
        email: normalizedEmail,
        lastActivity: admin.firestore.FieldValue.serverTimestamp(),
        tenantIds: admin.firestore.FieldValue.arrayUnion(tenantId),
      };
      if (req.authContext?.uid) {
        parentUpdate.userId = req.authContext.uid;
      }
      await userRef.set(parentUpdate, { merge: true });

      // Fire-and-forget, THROTTLED: bursty pings for the same (tenant, recipient)
      // coalesce into at most one promotion per short window so the hot ping path
      // does not re-enumerate every conversation on each heartbeat. A skipped
      // (throttled) call resolves to null; the next ping after the window — or the
      // next inbound message — still promotes, so no receipt is dropped. The
      // graceful index fallback inside the promotion means a not-yet-deployed
      // `.indexOn` no longer hard-fails this path.
      void promotePendingDeliveryForRecipientThrottled({
        tenantId,
        recipientEmail: normalizedEmail,
      }).catch((error) => {
        console.warn('[devices/ping] receipt promotion failed', {
          tenantId,
          userEmail: normalizedEmail,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      res.json({ ok: true, tenantId, deviceId });
    } catch (error) {
      console.error('[devices/ping] failed to enforce tenant metadata', error);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/chat/stream', async (req, res) => {
    const master = process.env.INTERNAL_API_KEY;
    if (!master) {
      return res.status(501).json({ error: 'not_enabled' });
    }

    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const tokenPayload = decodeInternalToken(token);
    if (!token || !tokenPayload) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }

    const userEmail = typeof req.query.user === 'string' ? req.query.user : '';
    const partnerEmail = typeof req.query.partner === 'string' ? req.query.partner : '';
    const normalizedUser = normalizeEmail(userEmail);
    const normalizedPartner = normalizeEmail(partnerEmail);
    const conversationKey = getConversationKey(normalizedUser, normalizedPartner);

    if (!normalizedUser || !normalizedPartner || !conversationKey) {
      return res.status(400).json({ error: 'invalid_conversation' });
    }

    if (!tokenPayload.master && normalizeEmail(tokenPayload.email ?? '') !== normalizedUser) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const userIsMember = await isTenantEmailActiveMemberImpl(tenantId, normalizedUser);
    const partnerIsMember = await isTenantEmailActiveMemberImpl(tenantId, normalizedPartner);
    if (!userIsMember || !partnerIsMember) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    try {
      ensureFirebase();
    } catch (error) {
      console.error('[chat-stream] firebase init failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }

    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    (res as any).flushHeaders?.();

    let closed = false;
    const send = (payload: unknown) => {
      if (closed || res.writableEnded) {
        return;
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({ type: 'ready', payload: { tenantId, conversationKey } });

    let cleanup: (() => void) | null = null;
    const heartbeat = setInterval(() => {
      send({ type: 'ping', timestamp: Date.now() });
    }, 25000);

    const closeStream = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      cleanup?.();
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', closeStream);
    req.on('aborted', closeStream);

    try {
      cleanup = await watchConversationRealtime(tenantId, conversationKey, {
        onMessage: (message) => send({ type: 'message', payload: message }),
        onStatus: (status) => send({ type: 'status', payload: status }),
        onMessageUpdate: (message) => send({ type: 'message_update', payload: message }),
        onMessageDelete: (message) => send({ type: 'message_delete', payload: message }),
      });

      if (closed) {
        cleanup();
        cleanup = null;
        return;
      }
    } catch (error) {
      console.error('[chat-stream] watch failed', error);
      send({ type: 'status', payload: { error: 'internal_error' } });
      closeStream();
      return;
    }
  });

  // Per-user inbound-message stream (SSE). Replaces the client's direct read of
  // the RTDB `messageIndex` node (which drove in-app chat notifications) so that
  // node's `.read` rule can be locked to `false`. The backend watches the
  // CALLER'S OWN inbound index records via the Admin SDK (which bypasses RTDB
  // rules) and streams a compact inbound event per newly-arrived message.
  //
  // Auth mirrors `/chat/stream`: an internal token is required, the actor is
  // taken from the TOKEN (its `email` claim must match the `user` query param —
  // a client cannot stream another user's inbox by spoofing the query), and the
  // user must be an active member of the tenant.
  app.get('/chat/inbox-stream', async (req, res) => {
    const master = process.env.INTERNAL_API_KEY;
    if (!master) {
      return res.status(501).json({ error: 'not_enabled' });
    }

    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const tokenPayload = decodeInternalToken(token);
    if (!token || !tokenPayload) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }

    const userEmail = typeof req.query.user === 'string' ? req.query.user : '';
    const normalizedUser = normalizeEmail(userEmail);
    if (!normalizedUser) {
      return res.status(400).json({ error: 'invalid_user' });
    }

    // Actor is derived from the TOKEN, never trusted from the query param.
    if (!tokenPayload.master && normalizeEmail(tokenPayload.email ?? '') !== normalizedUser) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const userIsMember = await isTenantEmailActiveMemberImpl(tenantId, normalizedUser);
    if (!userIsMember) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    try {
      ensureFirebase();
    } catch (error) {
      console.error('[chat-inbox-stream] firebase init failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }

    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    (res as any).flushHeaders?.();

    let closed = false;
    const send = (payload: unknown) => {
      if (closed || res.writableEnded) {
        return;
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({ type: 'ready', payload: { tenantId, user: normalizedUser } });

    let cleanup: (() => void) | null = null;
    const heartbeat = setInterval(() => {
      send({ type: 'ping', timestamp: Date.now() });
    }, 25000);

    const closeStream = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      cleanup?.();
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', closeStream);
    req.on('aborted', closeStream);

    try {
      cleanup = await watchUserInboxRealtime(tenantId, normalizedUser, {
        onInbound: (payload) => send({ type: 'inbound', payload }),
      });

      if (closed) {
        cleanup();
        cleanup = null;
        return;
      }
    } catch (error) {
      console.error('[chat-inbox-stream] watch failed', error);
      send({ type: 'status', payload: { error: 'internal_error' } });
      closeStream();
      return;
    }
  });

  app.post('/chat/delta', requireMemberTenantAccess, async (req, res) => {
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const parsed = chatDeltaSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
    }

    const tenantAccess = req.tenantAccess;
    if (!tenantAccess) {
      return res.status(500).json({ error: 'tenant_guard_missing' });
    }
    if (parsed.data.tenantId !== tenantAccess.tenantId) {
      return res.status(403).json({ error: 'not_authorized', message: 'Tenant mismatch' });
    }

    const actorEmail = await resolveAuthenticatedEmail(authContext);
    const normalizedActor = normalizeEmail(actorEmail);
    const normalizedUser = normalizeEmail(parsed.data.userEmail);
    if (authContext.tokenType !== 'master' && (!normalizedActor || normalizedActor !== normalizedUser)) {
      return res.status(403).json({ error: 'not_authorized', message: 'User email mismatch' });
    }

    try {
      const { partnerEmail, limit, direction, cursor } = parsed.data;
      const normalizedPartner = normalizeEmail(partnerEmail);
      const conversationKey = getConversationKey(normalizedUser, normalizedPartner);
      if (!normalizedUser || !normalizedPartner || !conversationKey) {
        return res.status(200).json({
          messages: [],
          hasMore: false,
          cursor: { oldestTimestamp: null, newestTimestamp: null, count: 0 },
        });
      }

      const partnerIsMember = await isTenantEmailActiveMemberImpl(tenantAccess.tenantId, normalizedPartner);
      if (!partnerIsMember) {
        return res.status(403).json({ error: 'partner_not_in_tenant' });
      }

      ensureFirebase();

      const db = admin.database();
      const conversationRef = db
        .ref('tenantChat')
        .child(tenantAccess.tenantId)
        .child('conversationMessages')
        .child(conversationKey);

      const queryLimit = Math.min(Math.max(limit, 1), 200);
      const cursorTimestamp = cursor?.timestamp || null;
      const cursorMessageId = cursor?.messageId || null;

      let queryRef: admin.database.Query = conversationRef.orderByChild('timestamp');

      if (direction === 'older') {
        if (cursorTimestamp) {
          queryRef = queryRef.endAt(cursorTimestamp).limitToLast(queryLimit + 1);
        } else {
          queryRef = queryRef.limitToLast(queryLimit);
        }
      } else if (direction === 'newer' && cursorTimestamp) {
        queryRef = queryRef.startAt(cursorTimestamp).limitToFirst(queryLimit + 1);
      } else {
        queryRef = queryRef.limitToLast(queryLimit);
      }

      const snapshot = await queryRef.get();
      if (!snapshot.exists()) {
        return res.status(200).json({
          messages: [],
          hasMore: false,
          cursor: { oldestTimestamp: null, newestTimestamp: null, count: 0 },
        });
      }

    const rows: { id: string; value: Record<string, any> }[] = [];
    let scannedRowCount = 0;

      snapshot.forEach((childSnap) => {
        if (!childSnap.key) return false;
        const value = childSnap.val() as Record<string, any> | null;
        if (value) {
          scannedRowCount += 1;
          rows.push({ id: childSnap.key, value });
        }
        return false;
      });

      rows.sort((a, b) => {
        const aTs = Date.parse((a.value.timestamp as string) || '') || 0;
        const bTs = Date.parse((b.value.timestamp as string) || '') || 0;
        return aTs - bTs;
      });

      const isCursorMatch = (msgId: string | undefined, timestamp: string | undefined) => {
        if (!cursorTimestamp) {
          return false;
        }
        if (!timestamp) {
          return false;
        }
        if (timestamp !== cursorTimestamp) {
          return false;
        }
        if (!cursorMessageId) {
          return true;
        }
        return msgId === cursorMessageId;
      };

      const rawCount = scannedRowCount;

      const normalizedMessages = rows
        .map(({ id, value }) => {
          if ((direction === 'older' || direction === 'newer') && isCursorMatch(id, value.timestamp)) {
            return null;
          }
          return {
            ...value,
            id,
            sender: normalizeEmail(value.sender),
            recipientId: normalizeEmail(value.recipientId) || undefined,
            conversationKey,
          } as Record<string, any>;
        })
        .filter((entry): entry is Record<string, any> => Boolean(entry));

      const moreAvailable = cursorTimestamp ? rawCount > queryLimit : rawCount === queryLimit;
      const trimmedMessages = moreAvailable
        ? normalizedMessages.slice(normalizedMessages.length - queryLimit)
        : normalizedMessages;

      const responseMessages: Record<string, any>[] = trimmedMessages.map((message) => ({
        ...message,
        sender: normalizeEmail(message.sender),
        recipientId: message.recipientId ? normalizeEmail(message.recipientId) : undefined,
        tenantId: typeof message.tenantId === 'string' ? message.tenantId : undefined,
      }));

      const oldest = responseMessages[0]?.timestamp ?? null;
      const newest = responseMessages[responseMessages.length - 1]?.timestamp ?? null;

      return res.status(200).json({
        messages: responseMessages,
        hasMore: moreAvailable,
        cursor: {
          oldestTimestamp: oldest,
          newestTimestamp: newest,
          count: responseMessages.length,
        },
      });
    } catch (error) {
      console.error('[chat-delta] failed', error);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ----- CSP violation reports (backend aggregation) -----
  const cspRL = rateLimitMiddleware({ windowMs: 60_000, max: 120 }); // generous: 120 reports/min per IP
  app.post('/csp-report', cspRL, express.json({ type: ['application/json','application/reports+json','application/csp-report'] as any }), async (req,res)=>{
    const receivedAt = Date.now();
    try {
      const reportBody:any = req.body || {};
      const payload = reportBody['csp-report'] || reportBody?.cspReport || reportBody?.body || reportBody;
      const entries = Array.isArray(payload)? payload : [payload];
      const db = getFirestoreImpl();
      const batch = db.batch();
      let count = 0;
      for (const entry of entries.slice(0,25)) {
        const eff = typeof entry === 'object'? {
          violatedDirective: entry['violated-directive'] || entry['violatedDirective'],
          effectiveDirective: entry['effective-directive'] || entry['effectiveDirective'],
          blockedURI: entry['blocked-uri'] || entry['blockedURI'],
          sourceFile: entry['source-file'] || entry['sourceFile'],
          disposition: entry['disposition'],
          referrer: entry['referrer'],
          originalPolicy: (entry['original-policy'] || entry['originalPolicy'])?.slice?.(0,400),
          scriptSample: entry['script-sample'] || entry['scriptSample']?.slice?.(0,200),
        } : { raw: String(entry).slice(0,500) };
        console.warn('[csp_violation]', JSON.stringify(eff));
        inc(metricNames.cspViolation, { directive: eff.effectiveDirective || eff.violatedDirective || 'unknown' });
        try {
          // Persist (collection: security_csp_violations)
          const docRef = db.collection('security_csp_violations').doc();
          batch.set(docRef, { ...eff, receivedAt });
        } catch {}
        count++;
      }
      if (count > 0) {
  try { await batch.commit(); } catch(e:any){ console.warn('[csp_violation] firestore_batch_error', e?.message); inc(metricNames.cspViolationPersistFailure); }
      }
    } catch(e:any){ console.warn('[csp_violation] parse_error', e?.message||e); }
    res.status(204).end();
  });

  // ----- CSP violation pruning job -----
  const CSP_RETENTION_DAYS = Number(process.env.CSP_VIOLATION_RETENTION_DAYS || 7);
  const CSP_PRUNE_INTERVAL_MS = Number(process.env.CSP_VIOLATION_PRUNE_INTERVAL_MS || 3600000); // 1h
  async function pruneCspViolations(){
    if (CSP_RETENTION_DAYS <= 0) return;
    try {
      const db = getFirestoreImpl();
      const cutoff = Date.now() - CSP_RETENTION_DAYS*24*60*60*1000;
      const snap = await db.collection('security_csp_violations')
        .where('receivedAt','<', cutoff)
        .limit(500)
        .get();
      if (snap.empty) return;
      let batch = db.batch();
      let count = 0;
      snap.docs.forEach(d=>{ batch.delete(d.ref); count++; });
      await batch.commit();
      console.log(`[csp_prune] removed ${count} violations older than ${CSP_RETENTION_DAYS}d`);
  inc(metricNames.cspViolationPruned, { days: String(CSP_RETENTION_DAYS) });
      // If we hit limit, schedule a faster follow-up
      if (count === 500) setTimeout(()=>{ pruneCspViolations().catch(()=>{}); }, 5000).unref?.();
    } catch(e:any){ console.warn('[csp_prune] error', e?.message||e); }
  }
  if (!isTestProcess && CSP_PRUNE_INTERVAL_MS > 0) {
    setInterval(()=>{ pruneCspViolations().catch(()=>{}); }, CSP_PRUNE_INTERVAL_MS).unref?.();
    setTimeout(()=>{ pruneCspViolations().catch(()=>{}); }, 20000).unref?.();
  }

  // Expose for tests
  (app as any)._pruneCspViolations = pruneCspViolations;

  app.get('/whatsapp/queue/status', optionalQueryStaffTenantAccess, async (req,res)=>{
    const authContext = req.authContext;
    if (!authContext) {
      return res.status(401).json({ error:'unauthorized' });
    }
    const single = typeof req.query.jobId === 'string' ? req.query.jobId.trim() : undefined;
    const multiRaw = req.query.jobIds;
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId.trim() : undefined;

    const tenantFilterRaw = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : undefined;
    const tenantFilter = tenantFilterRaw || undefined;
    if (!tenantFilter && authContext.tokenType !== 'master') {
      return res.status(400).json({ error: 'tenant_required' });
    }

    const parseJobIds = (raw: unknown): string[] => {
      if (typeof raw === 'string') {
        return raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (Array.isArray(raw)) {
        return raw
          .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return [];
    };

    if(messageId){
      const jobId=findJobByMessageId(messageId);
      if(!jobId) return res.status(404).json({error:'not_found'});
      const st=await Promise.resolve(getJobStatus(jobId, tenantFilter));
      if(!st) return res.status(404).json({error:'not_found'});
      return res.json({ jobs:[{ id: jobId, ...st }]});
    }
    if(single){
      const st=await Promise.resolve(getJobStatus(single, tenantFilter));
      if(!st) return res.status(404).json({error:'not_found'});
      return res.json({ jobs:[{id:single,...st}]});
    }

    const multi = parseJobIds(multiRaw);
    if (multi.length > 0) {
      const jobs = await Promise.resolve(listJobStatus(multi, tenantFilter));
      return res.json({ jobs });
    }
    return res.status(400).json({ error:'missing_jobId' });
  });

  app.get('/metrics', async (_req, res) => {
    const snap = await getInMemoryQueueSnapshot();
    const base = `wa_queue_depth ${snap.queued}\nwa_queue_in_flight ${snap.processing}`;
    const metrics = metricsText(base);
    const lines = [metrics.trim()];

    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    lines.push(`wa_runtime_uptime_seconds ${Math.floor(process.uptime())}`);
    lines.push(`wa_runtime_memory_rss_bytes ${memoryUsage.rss}`);
    lines.push(`wa_runtime_memory_heap_used_bytes ${memoryUsage.heapUsed}`);
    lines.push(`wa_runtime_memory_heap_total_bytes ${memoryUsage.heapTotal}`);
    lines.push(`wa_runtime_memory_external_bytes ${memoryUsage.external}`);
    if (typeof memoryUsage.arrayBuffers === 'number') {
      lines.push(`wa_runtime_memory_array_buffers_bytes ${memoryUsage.arrayBuffers}`);
    }
    lines.push(`wa_runtime_cpu_user_seconds_total ${(cpuUsage.user / 1_000_000).toFixed(4)}`);
    lines.push(`wa_runtime_cpu_system_seconds_total ${(cpuUsage.system / 1_000_000).toFixed(4)}`);

    if (!isTestProcess) {
      const lagMeanMs = eventLoopDelayMonitor.mean / 1_000_000;
      const lagP95Ms = eventLoopDelayMonitor.percentile(95) / 1_000_000;
      const lagP99Ms = eventLoopDelayMonitor.percentile(99) / 1_000_000;
      const lagMaxMs = eventLoopDelayMonitor.max / 1_000_000;

      if (Number.isFinite(lagMeanMs)) {
        lines.push(`wa_runtime_event_loop_lag_mean_ms ${lagMeanMs.toFixed(2)}`);
      }
      if (Number.isFinite(lagP95Ms)) {
        lines.push(`wa_runtime_event_loop_lag_p95_ms ${lagP95Ms.toFixed(2)}`);
      }
      if (Number.isFinite(lagP99Ms)) {
        lines.push(`wa_runtime_event_loop_lag_p99_ms ${lagP99Ms.toFixed(2)}`);
      }
      if (Number.isFinite(lagMaxMs)) {
        lines.push(`wa_runtime_event_loop_lag_max_ms ${lagMaxMs.toFixed(2)}`);
      }
    }

    lines.push(`wa_http_requests_in_flight ${inFlightHttpRequests}`);
    lines.push(`wa_http_requests_in_flight_peak ${peakInFlightHttpRequests}`);

    const chatWatchStats = getConversationWatchStats();
    lines.push(`wa_chat_realtime_watches_active ${chatWatchStats.activeWatches}`);
    lines.push(`wa_chat_realtime_watch_subscribers ${chatWatchStats.totalSubscribers}`);

    const chatInboxWatchStats = getInboxWatchStats();
    lines.push(`wa_chat_inbox_watches_active ${chatInboxWatchStats.activeWatches}`);
    lines.push(`wa_chat_inbox_watch_subscribers ${chatInboxWatchStats.totalSubscribers}`);

    const chatWatchThreshold = readOptionalNumberEnv('ALERT_CHAT_REALTIME_WATCHES_ACTIVE');
    if (chatWatchThreshold !== null) {
      lines.push(`wa_alert_chat_realtime_watches_active_exceeded ${chatWatchStats.activeWatches > chatWatchThreshold ? 1 : 0}`);
    }

    const chatSubscriberThreshold = readOptionalNumberEnv('ALERT_CHAT_REALTIME_WATCH_SUBSCRIBERS');
    if (chatSubscriberThreshold !== null) {
      lines.push(`wa_alert_chat_realtime_watch_subscribers_exceeded ${chatWatchStats.totalSubscribers > chatSubscriberThreshold ? 1 : 0}`);
    }

    const window5m = 5 * 60 * 1000;
    const window15m = 15 * 60 * 1000;
    const window24h = 24 * 60 * 60 * 1000;

    const requests5m = getWindowCount(metricNames.httpRequestsTotal, window5m);
    const errors5m = getWindowCount(metricNames.httpResponsesErrorTotal, window5m);
    const clientErrors5m = getWindowCount(metricNames.httpResponses4xxTotal, window5m);
    const serverErrors5m = getWindowCount(metricNames.httpResponses5xxTotal, window5m);
    const unauthorized5m = getWindowCount(metricNames.httpAuthUnauthorizedTotal, window5m);
    const rateLimited5m = getWindowCount(metricNames.httpRateLimitedTotal, window5m);
    const maintenanceBlocked5m = getWindowCount(metricNames.httpMaintenanceBlockedTotal, window5m);
    const errorRate5m = requests5m > 0 ? errors5m / requests5m : 0;

    lines.push(`wa_http_requests_5m ${requests5m}`);
    lines.push(`wa_http_errors_5m ${errors5m}`);
    lines.push(`wa_http_4xx_5m ${clientErrors5m}`);
    lines.push(`wa_http_5xx_5m ${serverErrors5m}`);
    lines.push(`wa_http_unauthorized_5m ${unauthorized5m}`);
    lines.push(`wa_http_rate_limited_5m ${rateLimited5m}`);
    lines.push(`wa_http_maintenance_blocked_5m ${maintenanceBlocked5m}`);
    lines.push(`wa_http_error_rate_5m ${errorRate5m.toFixed(4)}`);

    const httpDuration5m = getHttpDurationWindowStats(window5m);
    if (httpDuration5m) {
      lines.push(`wa_http_request_duration_count_5m ${httpDuration5m.count}`);
      lines.push(`wa_http_request_duration_avg_ms_5m ${httpDuration5m.avg.toFixed(2)}`);
      lines.push(`wa_http_request_duration_p95_ms_5m ${httpDuration5m.p95.toFixed(2)}`);
      lines.push(`wa_http_request_duration_p99_ms_5m ${httpDuration5m.p99.toFixed(2)}`);
      lines.push(`wa_http_request_duration_max_ms_5m ${httpDuration5m.max.toFixed(2)}`);
    }

    const httpErrorRateThreshold = readOptionalNumberEnv('ALERT_HTTP_ERROR_RATE_5M');
    if (httpErrorRateThreshold !== null) {
      const exceeded = requests5m > 0 ? errorRate5m > httpErrorRateThreshold : false;
      lines.push(`wa_alert_http_error_rate_5m_exceeded ${exceeded ? 1 : 0}`);
    }

    const http5xxThreshold = readOptionalNumberEnv('ALERT_HTTP_5XX_5M');
    if (http5xxThreshold !== null) {
      lines.push(`wa_alert_http_5xx_5m_exceeded ${serverErrors5m > http5xxThreshold ? 1 : 0}`);
    }

    const httpP95Threshold = readOptionalNumberEnv('ALERT_HTTP_P95_MS_5M');
    if (httpP95Threshold !== null && httpDuration5m) {
      lines.push(`wa_alert_http_p95_ms_5m_exceeded ${httpDuration5m.p95 > httpP95Threshold ? 1 : 0}`);
    }

    const eventLoopP99Threshold = readOptionalNumberEnv('ALERT_RUNTIME_EVENT_LOOP_P99_MS');
    if (eventLoopP99Threshold !== null && !isTestProcess) {
      const lagP99Ms = eventLoopDelayMonitor.percentile(99) / 1_000_000;
      if (Number.isFinite(lagP99Ms)) {
        lines.push(`wa_alert_runtime_event_loop_p99_ms_exceeded ${lagP99Ms > eventLoopP99Threshold ? 1 : 0}`);
      }
    }

    const depthThresh = Number(process.env.ALERT_QUEUE_DEPTH || '');
    if (!isNaN(depthThresh)) lines.push(`wa_alert_queue_depth_exceeded ${snap.queued > depthThresh ? 1 : 0}`);

    const failThresh = Number(process.env.ALERT_FAILURE_RATE || '');
    if (!isNaN(failThresh)) {
      const rate = getFailureRate();
      lines.push(`wa_failure_rate ${rate.toFixed(4)}`);
      lines.push(`wa_alert_failure_rate_exceeded ${rate > failThresh ? 1 : 0}`);
    }

    // Billing alert-style gauges computed from in-memory rolling windows.
    // Intended as a lightweight alternative when no external alerting exists.

    const sig15 = getWindowCount('billing_webhook_signature_failures_total', window15m, { provider: 'razorpay' });
    const json15 = getWindowCount('billing_webhook_invalid_json_total', window15m, { provider: 'razorpay' });
    const handler15 = getWindowCount('billing_webhook_handler_failures_total', window15m, { provider: 'razorpay' });
    const invoice15 = getWindowCount('billing_invoice_write_failures_total', window15m, { provider: 'razorpay' });
    const state15 = getWindowCount('billing_state_write_failures_total', window15m, { provider: 'razorpay' });
    const unknown24 = getWindowCount('billing_webhook_unknown_events_total', window24h, { provider: 'razorpay' });

    lines.push(`wa_billing_webhook_signature_failures_15m ${sig15}`);
    lines.push(`wa_billing_webhook_invalid_json_15m ${json15}`);
    lines.push(`wa_billing_webhook_handler_failures_15m ${handler15}`);
    lines.push(`wa_billing_invoice_write_failures_15m ${invoice15}`);
    lines.push(`wa_billing_state_write_failures_15m ${state15}`);
    lines.push(`wa_billing_unknown_events_24h ${unknown24}`);

    // Backfill freshness: how long since the scheduler last ran.
    // Note: this tracks only the in-process scheduler, not manual CLI runs.
    const backfillStatus = getBillingBackfillSchedulerStatus();
    const backfillAgeSeconds = secondsSinceIso(backfillStatus.lastRunAt);
    lines.push(`wa_billing_backfill_scheduler_enabled ${backfillStatus.enabled ? 1 : 0}`);
    lines.push(`wa_billing_backfill_scheduler_started ${backfillStatus.schedulerStarted ? 1 : 0}`);
    lines.push(`wa_billing_backfill_scheduler_running ${backfillStatus.isRunning ? 1 : 0}`);
    lines.push(`wa_billing_backfill_last_run_age_seconds ${backfillAgeSeconds ?? -1}`);

    const playReconcileStatus = getPlayBillingReconcileSchedulerStatus();
    const playReconcileAgeSeconds = secondsSinceIso(playReconcileStatus.lastRunAt);
    const playReconcileNextRunInSeconds = secondsUntilIso(playReconcileStatus.nextRunAt);
    lines.push(`wa_billing_play_reconcile_scheduler_enabled ${playReconcileStatus.enabled ? 1 : 0}`);
    lines.push(`wa_billing_play_reconcile_scheduler_started ${playReconcileStatus.schedulerStarted ? 1 : 0}`);
    lines.push(`wa_billing_play_reconcile_scheduler_running ${playReconcileStatus.isRunning ? 1 : 0}`);
    lines.push(`wa_billing_play_reconcile_last_run_age_seconds ${playReconcileAgeSeconds ?? -1}`);
    lines.push(`wa_billing_play_reconcile_next_run_in_seconds ${playReconcileNextRunInSeconds ?? -1}`);

    const dailyQuoteStatus = getDailyQuoteSchedulerStatus();
    const dailyQuoteLastRunAgeSeconds = secondsSinceIso(dailyQuoteStatus.lastRunAt);
    const dailyQuoteNextRunInSeconds = secondsUntilIso(dailyQuoteStatus.nextRunAt);
    lines.push(`wa_daily_quotes_scheduler_enabled ${dailyQuoteStatus.enabled ? 1 : 0}`);
    lines.push(`wa_daily_quotes_scheduler_started ${dailyQuoteStatus.schedulerStarted ? 1 : 0}`);
    lines.push(`wa_daily_quotes_scheduler_running ${dailyQuoteStatus.isRunning ? 1 : 0}`);
    lines.push(`wa_daily_quotes_last_run_age_seconds ${dailyQuoteLastRunAgeSeconds ?? -1}`);
    lines.push(`wa_daily_quotes_next_run_in_seconds ${dailyQuoteNextRunInSeconds ?? -1}`);

    const sigThreshRaw = (process.env.ALERT_BILLING_SIGNATURE_FAILURES_15M ?? '').trim();
    const sigThresh = sigThreshRaw === '' ? Number.NaN : Number(sigThreshRaw);
    if (Number.isFinite(sigThresh)) {
      lines.push(`wa_alert_billing_webhook_signature_failures_15m_exceeded ${sig15 > sigThresh ? 1 : 0}`);
    }
    const jsonThreshRaw = (process.env.ALERT_BILLING_INVALID_JSON_15M ?? '').trim();
    const jsonThresh = jsonThreshRaw === '' ? Number.NaN : Number(jsonThreshRaw);
    if (Number.isFinite(jsonThresh)) {
      lines.push(`wa_alert_billing_webhook_invalid_json_15m_exceeded ${json15 > jsonThresh ? 1 : 0}`);
    }
    const handlerThreshRaw = (process.env.ALERT_BILLING_HANDLER_FAILURES_15M ?? '').trim();
    const handlerThresh = handlerThreshRaw === '' ? Number.NaN : Number(handlerThreshRaw);
    if (Number.isFinite(handlerThresh)) {
      lines.push(`wa_alert_billing_webhook_handler_failures_15m_exceeded ${handler15 > handlerThresh ? 1 : 0}`);
    }
    const invoiceThreshRaw = (process.env.ALERT_BILLING_INVOICE_WRITE_FAILURES_15M ?? '').trim();
    const invoiceThresh = invoiceThreshRaw === '' ? Number.NaN : Number(invoiceThreshRaw);
    if (Number.isFinite(invoiceThresh)) {
      lines.push(`wa_alert_billing_invoice_write_failures_15m_exceeded ${invoice15 > invoiceThresh ? 1 : 0}`);
    }
    const stateThreshRaw = (process.env.ALERT_BILLING_STATE_WRITE_FAILURES_15M ?? '').trim();
    const stateThresh = stateThreshRaw === '' ? Number.NaN : Number(stateThreshRaw);
    if (Number.isFinite(stateThresh)) {
      lines.push(`wa_alert_billing_state_write_failures_15m_exceeded ${state15 > stateThresh ? 1 : 0}`);
    }
    const unknownThreshRaw = (process.env.ALERT_BILLING_UNKNOWN_EVENTS_24H ?? '').trim();
    const unknownThresh = unknownThreshRaw === '' ? Number.NaN : Number(unknownThreshRaw);
    if (Number.isFinite(unknownThresh)) {
      lines.push(`wa_alert_billing_unknown_events_24h_exceeded ${unknown24 > unknownThresh ? 1 : 0}`);
    }

    const backfillStaleHoursRaw = (process.env.ALERT_BILLING_BACKFILL_STALE_HOURS ?? '').trim();
    const backfillStaleHours = backfillStaleHoursRaw === '' ? Number.NaN : Number(backfillStaleHoursRaw);
    if (Number.isFinite(backfillStaleHours) && backfillStaleHours > 0) {
      const staleSeconds = Math.max(0, Math.floor(backfillStaleHours * 3600));
      // If the scheduler hasn't run yet, don't raise a "stale exceeded" alert.
      // This avoids false positives right after deployment/startup.
      const exceeded = backfillAgeSeconds !== null ? backfillAgeSeconds > staleSeconds : false;
      lines.push(`wa_alert_billing_backfill_stale_exceeded ${exceeded ? 1 : 0}`);
    }

    const playReconcileStaleHours = readOptionalNumberEnv('ALERT_BILLING_PLAY_RECONCILE_STALE_HOURS');
    if (playReconcileStaleHours !== null && playReconcileStaleHours > 0) {
      const staleSeconds = Math.max(0, Math.floor(playReconcileStaleHours * 3600));
      const exceeded = playReconcileAgeSeconds !== null ? playReconcileAgeSeconds > staleSeconds : false;
      lines.push(`wa_alert_billing_play_reconcile_stale_exceeded ${exceeded ? 1 : 0}`);
    }

    const dailyQuotesStaleHours = readOptionalNumberEnv('ALERT_DAILY_QUOTES_STALE_HOURS');
    if (dailyQuotesStaleHours !== null && dailyQuotesStaleHours > 0) {
      const staleSeconds = Math.max(0, Math.floor(dailyQuotesStaleHours * 3600));
      const exceeded = dailyQuoteLastRunAgeSeconds !== null ? dailyQuoteLastRunAgeSeconds > staleSeconds : false;
      lines.push(`wa_alert_daily_quotes_stale_exceeded ${exceeded ? 1 : 0}`);
    }

    res.type('text/plain').send(lines.join('\n') + '\n');
  });
  app.get('/ready', (_req,res)=> res.sendStatus(200));
  app.get('/health', (_req,res)=> res.json({status:'ok', uptime: process.uptime(), ts: Date.now()}));

  app.get('/billing/admin/backfill/status', requireOperatorAuth, (_req, res) => {
    return res.json({ ok: true, scheduler: getBillingBackfillSchedulerStatus() });
  });

  app.get('/billing/admin/play-reconcile/status', requireOperatorAuth, async (_req, res) => {
    const scheduler = getPlayBillingReconcileSchedulerStatus();
    const lockDocPath = (process.env.PLAY_BILLING_RECONCILE_LOCK_DOC || '').trim() || 'billingLocks/play_billing_reconcile';

    const parseDocPath = (value: string): { collection: string; docId: string } | null => {
      const parts = value
        .split('/')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length !== 2) return null;
      return { collection: parts[0], docId: parts[1] };
    };

    const toJson = (value: any): any => {
      if (value == null) return value;
      if (typeof value !== 'object') return value;
      if (typeof value.toDate === 'function') {
        try {
          return value.toDate().toISOString();
        } catch {
          return String(value);
        }
      }
      if (Array.isArray(value)) return value.map(toJson);
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
      return out;
    };

    let lockDoc: Record<string, unknown> | null = null;
    const parsed = parseDocPath(lockDocPath);
    if (parsed) {
      try {
        const db = getFirestoreImpl();
        const snap = await db.collection(parsed.collection).doc(parsed.docId).get();
        lockDoc = snap.exists ? (toJson(snap.data() || {}) as Record<string, unknown>) : null;
      } catch (error: any) {
        lockDoc = { error: typeof error?.message === 'string' ? error.message : 'lock_doc_read_failed' } as any;
      }
    } else {
      lockDoc = { error: 'invalid_lock_doc_path', lockDocPath } as any;
    }

    return res.json({ ok: true, scheduler, lockDocPath, lockDoc });
  });

  app.get('/billing/admin/metrics-summary', requireOperatorAuth, (_req, res) => {
    try {
      const readNumberEnv = (name: string): number => {
        const raw = (process.env[name] ?? '').trim();
        if (!raw) return Number.NaN;
        const n = Number(raw);
        return Number.isFinite(n) ? n : Number.NaN;
      };

      const window15m = 15 * 60 * 1000;
      const window24h = 24 * 60 * 60 * 1000;

      const provider = 'razorpay';
      const gauges = {
        billing_webhook_signature_failures_15m: getWindowCount('billing_webhook_signature_failures_total', window15m, { provider }),
        billing_webhook_invalid_json_15m: getWindowCount('billing_webhook_invalid_json_total', window15m, { provider }),
        billing_webhook_handler_failures_15m: getWindowCount('billing_webhook_handler_failures_total', window15m, { provider }),
        billing_invoice_write_failures_15m: getWindowCount('billing_invoice_write_failures_total', window15m, { provider }),
        billing_state_write_failures_15m: getWindowCount('billing_state_write_failures_total', window15m, { provider }),
        billing_unknown_events_24h: getWindowCount('billing_webhook_unknown_events_total', window24h, { provider }),
      };

      const backfillStatus = getBillingBackfillSchedulerStatus();
      const lastBackfillIso = backfillStatus.lastRunAt;
      let backfillLastRunAgeSeconds: number | null = null;
      if (lastBackfillIso) {
        const t = Date.parse(lastBackfillIso);
        if (!Number.isNaN(t)) {
          backfillLastRunAgeSeconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
        }
      }

      const thresholds = {
        signatureFailures15m: readNumberEnv('ALERT_BILLING_SIGNATURE_FAILURES_15M'),
        invalidJson15m: readNumberEnv('ALERT_BILLING_INVALID_JSON_15M'),
        handlerFailures15m: readNumberEnv('ALERT_BILLING_HANDLER_FAILURES_15M'),
        invoiceWriteFailures15m: readNumberEnv('ALERT_BILLING_INVOICE_WRITE_FAILURES_15M'),
        stateWriteFailures15m: readNumberEnv('ALERT_BILLING_STATE_WRITE_FAILURES_15M'),
        unknownEvents24h: readNumberEnv('ALERT_BILLING_UNKNOWN_EVENTS_24H'),
        backfillStaleHours: readNumberEnv('ALERT_BILLING_BACKFILL_STALE_HOURS'),
      };

      const enabled = {
        signatureFailures15m: Number.isFinite(thresholds.signatureFailures15m),
        invalidJson15m: Number.isFinite(thresholds.invalidJson15m),
        handlerFailures15m: Number.isFinite(thresholds.handlerFailures15m),
        invoiceWriteFailures15m: Number.isFinite(thresholds.invoiceWriteFailures15m),
        stateWriteFailures15m: Number.isFinite(thresholds.stateWriteFailures15m),
        unknownEvents24h: Number.isFinite(thresholds.unknownEvents24h),
        backfillStaleHours: Number.isFinite(thresholds.backfillStaleHours) && thresholds.backfillStaleHours > 0,
      };

      const alerts = {
        signatureFailures15mExceeded: enabled.signatureFailures15m
          ? gauges.billing_webhook_signature_failures_15m > thresholds.signatureFailures15m
          : false,
        invalidJson15mExceeded: enabled.invalidJson15m ? gauges.billing_webhook_invalid_json_15m > thresholds.invalidJson15m : false,
        handlerFailures15mExceeded: enabled.handlerFailures15m
          ? gauges.billing_webhook_handler_failures_15m > thresholds.handlerFailures15m
          : false,
        invoiceWriteFailures15mExceeded: enabled.invoiceWriteFailures15m
          ? gauges.billing_invoice_write_failures_15m > thresholds.invoiceWriteFailures15m
          : false,
        stateWriteFailures15mExceeded: enabled.stateWriteFailures15m
          ? gauges.billing_state_write_failures_15m > thresholds.stateWriteFailures15m
          : false,
        unknownEvents24hExceeded: enabled.unknownEvents24h ? gauges.billing_unknown_events_24h > thresholds.unknownEvents24h : false,
        backfillStaleExceeded: enabled.backfillStaleHours
          ? backfillLastRunAgeSeconds !== null
            ? backfillLastRunAgeSeconds > Math.max(0, Math.floor(thresholds.backfillStaleHours * 3600))
            : false
          : false,
      };

      const activeAlerts = Object.entries(alerts)
        .filter(([, v]) => v)
        .map(([k]) => k);

      return res.json({
        ok: true,
        provider,
        gauges,
        backfill: {
          schedulerEnabled: backfillStatus.enabled,
          schedulerStarted: backfillStatus.schedulerStarted,
          lastRunAt: backfillStatus.lastRunAt,
          lastRunAgeSeconds: backfillLastRunAgeSeconds,
        },
        thresholds: {
          signatureFailures15m: enabled.signatureFailures15m ? thresholds.signatureFailures15m : null,
          invalidJson15m: enabled.invalidJson15m ? thresholds.invalidJson15m : null,
          handlerFailures15m: enabled.handlerFailures15m ? thresholds.handlerFailures15m : null,
          invoiceWriteFailures15m: enabled.invoiceWriteFailures15m ? thresholds.invoiceWriteFailures15m : null,
          stateWriteFailures15m: enabled.stateWriteFailures15m ? thresholds.stateWriteFailures15m : null,
          unknownEvents24h: enabled.unknownEvents24h ? thresholds.unknownEvents24h : null,
          backfillStaleHours: enabled.backfillStaleHours ? thresholds.backfillStaleHours : null,
        },
        alerts,
        activeAlerts,
        generatedAtIso: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[billing_metrics_summary] failed', error);
      return res.status(500).json({ error: 'billing_metrics_summary_failed' });
    }
  });

  // Firebase init helpers handled via ensureFirebase() imported from firebaseAdmin.ts

  /* c8 ignore start - presence sweeper operational path excluded from coverage (timers, Firestore side-effects) */
  // ---------------- Presence Sweeper (restored original) ----------------
  const TENANT_JOIN_REQUEST_COLLECTION = 'tenantJoinRequests';
  const JOIN_REQUEST_AUTO_EXPIRE_ACTOR = 'system:auto-expire';
  const JOIN_REQUEST_EXPIRY_SWEEP_INTERVAL_MS = Number(
    process.env.JOIN_REQUEST_EXPIRY_SWEEP_INTERVAL_MS || 60 * 60 * 1000,
  );
  const JOIN_REQUEST_EXPIRY_SWEEP_BATCH_SIZE = Math.min(
    Math.max(Number(process.env.JOIN_REQUEST_EXPIRY_SWEEP_BATCH_SIZE || 200), 1),
    500,
  );

  const TENANT_INVITE_COLLECTION = 'tenantInvites';
  const INVITE_AUTO_EXPIRE_ACTOR = 'system:auto-expire';
  const INVITE_EXPIRY_SWEEP_INTERVAL_MS = Number(
    process.env.INVITE_EXPIRY_SWEEP_INTERVAL_MS || 60 * 60 * 1000,
  );
  const INVITE_EXPIRY_SWEEP_BATCH_SIZE = Math.min(
    Math.max(Number(process.env.INVITE_EXPIRY_SWEEP_BATCH_SIZE || 200), 1),
    500,
  );

  const TENANT_CODE_COLLECTION = 'tenantCodes';
  const JOIN_CODE_AUTO_EXPIRE_ACTOR = 'system:auto-expire';
  const JOIN_CODE_EXPIRY_SWEEP_INTERVAL_MS = Number(
    process.env.JOIN_CODE_EXPIRY_SWEEP_INTERVAL_MS || 60 * 60 * 1000,
  );
  const JOIN_CODE_EXPIRY_SWEEP_BATCH_SIZE = Math.min(
    Math.max(Number(process.env.JOIN_CODE_EXPIRY_SWEEP_BATCH_SIZE || 200), 1),
    500,
  );

  const PRESENCE_SWEEP_INTERVAL_MS = Number(process.env.PRESENCE_SWEEP_INTERVAL_MS || 300000);
  const PRESENCE_STALE_MINUTES = Number(process.env.PRESENCE_STALE_MINUTES || 5);
  const PRESENCE_STALE_WINDOW_MS = PRESENCE_STALE_MINUTES * 60_000;
  const PRESENCE_COLLECTION = process.env.PRESENCE_COLLECTION || 'tenantPresence';
  type PresenceQueryMode = 'online_only' | 'full_scan';
  const PRESENCE_SWEEP_QUERY_MODE: PresenceQueryMode =
    (process.env.PRESENCE_SWEEP_QUERY_MODE || 'online_only').toLowerCase() === 'full_scan'
      ? 'full_scan'
      : 'online_only';

  async function expireJoinRequestsOnce() {
    try {
      const db = getFirestoreImpl();
      const nowIso = new Date().toISOString();
      let expired = 0;
      while (true) {
        const snapshot = await db
          .collection(TENANT_JOIN_REQUEST_COLLECTION)
          .where('status', '==', 'pending')
          .where('expiresAt', '<=', nowIso)
          .limit(JOIN_REQUEST_EXPIRY_SWEEP_BATCH_SIZE)
          .get();
        if (snapshot.empty) {
          break;
        }
        const batch = db.batch();
        snapshot.docs.forEach((docSnap) => {
          const expiresAtRaw = docSnap.get('expiresAt');
          let expiresAtIso: string | null = null;
          if (expiresAtRaw && typeof (expiresAtRaw as any).toDate === 'function') {
            expiresAtIso = (expiresAtRaw as admin.firestore.Timestamp).toDate().toISOString();
          } else if (typeof expiresAtRaw === 'string') {
            expiresAtIso = expiresAtRaw;
          }
          const reviewedAt = expiresAtIso && !Number.isNaN(Date.parse(expiresAtIso)) ? expiresAtIso : nowIso;
          batch.update(docSnap.ref, {
            status: 'expired',
            reviewedAt,
            reviewedBy: JOIN_REQUEST_AUTO_EXPIRE_ACTOR,
            lastUpdatedAt: nowIso,
          });
        });
        await batch.commit();
        expired += snapshot.size;
        if (snapshot.size < JOIN_REQUEST_EXPIRY_SWEEP_BATCH_SIZE) {
          break;
        }
      }
      if (expired) {
        console.log(`[join_request_expiry] expired ${expired} stale join requests (cutoff ${nowIso})`);
      }
      return { expired };
    } catch (error: any) {
      console.warn('[join_request_expiry] sweep error', error?.message || error);
      throw error;
    }
  }

  async function expireInvitesOnce() {
    try {
      const db = getFirestoreImpl();
      const nowIso = new Date().toISOString();
      const nowTs = admin.firestore.Timestamp.now();
      let expired = 0;

      const expireBatch = async (snapshot: admin.firestore.QuerySnapshot<admin.firestore.DocumentData>) => {
        if (snapshot.empty) return 0;
        const batch = db.batch();
        snapshot.docs.forEach((docSnap) => {
          const expiresAtRaw = docSnap.get('expiresAt');
          let expiresAtIso: string | null = null;
          if (expiresAtRaw && typeof (expiresAtRaw as any).toDate === 'function') {
            expiresAtIso = (expiresAtRaw as admin.firestore.Timestamp).toDate().toISOString();
          } else if (typeof expiresAtRaw === 'string') {
            expiresAtIso = expiresAtRaw;
          }

          const expiredAt = expiresAtIso && !Number.isNaN(Date.parse(expiresAtIso)) ? expiresAtIso : nowIso;
          batch.update(docSnap.ref, {
            status: 'expired',
            expiredAt,
            expiredBy: INVITE_AUTO_EXPIRE_ACTOR,
            updatedAt: nowIso,
          });
        });
        await batch.commit();
        return snapshot.size;
      };

      // Sweep invites where expiresAt is stored as an ISO string.
      while (true) {
        const snapshot = await db
          .collection(TENANT_INVITE_COLLECTION)
          .where('status', '==', 'pending')
          .where('expiresAt', '<=', nowIso)
          .limit(INVITE_EXPIRY_SWEEP_BATCH_SIZE)
          .get();
        const processed = await expireBatch(snapshot);
        expired += processed;
        if (processed === 0 || processed < INVITE_EXPIRY_SWEEP_BATCH_SIZE) {
          break;
        }
      }

      // Backward/defensive: sweep invites where expiresAt might be a Firestore Timestamp.
      while (true) {
        let snapshot: admin.firestore.QuerySnapshot<admin.firestore.DocumentData>;
        try {
          snapshot = await db
            .collection(TENANT_INVITE_COLLECTION)
            .where('status', '==', 'pending')
            .where('expiresAt', '<=', nowTs)
            .limit(INVITE_EXPIRY_SWEEP_BATCH_SIZE)
            .get();
        } catch {
          break;
        }

        const processed = await expireBatch(snapshot);
        expired += processed;
        if (processed === 0 || processed < INVITE_EXPIRY_SWEEP_BATCH_SIZE) {
          break;
        }
      }

      if (expired) {
        console.log(`[invite_expiry] expired ${expired} pending invites (cutoff ${nowIso})`);
      }
      return { expired };
    } catch (error: any) {
      console.warn('[invite_expiry] sweep error', error?.message || error);
      throw error;
    }
  }

  async function expireJoinCodesOnce() {
    try {
      const db = getFirestoreImpl();
      const nowIso = new Date().toISOString();
      const nowTs = admin.firestore.Timestamp.now();
      let expired = 0;

      const expireCodeBatch = async (snapshot: admin.firestore.QuerySnapshot<admin.firestore.DocumentData>) => {
        if (snapshot.empty) return 0;
        const batch = db.batch();
        snapshot.docs.forEach((docSnap) => {
          batch.update(docSnap.ref, {
            status: 'expired',
            updatedAt: nowIso,
            expiredBy: JOIN_CODE_AUTO_EXPIRE_ACTOR,
          });
        });
        await batch.commit();
        return snapshot.size;
      };

      // Sweep codes where expiresAt is stored as an ISO string (primary format).
      while (true) {
        const snapshot = await db
          .collection(TENANT_CODE_COLLECTION)
          .where('status', '==', 'active')
          .where('expiresAt', '<=', nowIso)
          .limit(JOIN_CODE_EXPIRY_SWEEP_BATCH_SIZE)
          .get();
        const processed = await expireCodeBatch(snapshot);
        expired += processed;
        if (processed === 0 || processed < JOIN_CODE_EXPIRY_SWEEP_BATCH_SIZE) {
          break;
        }
      }

      // Defensive: sweep codes where expiresAt might be a Firestore Timestamp.
      while (true) {
        let snapshot: admin.firestore.QuerySnapshot<admin.firestore.DocumentData>;
        try {
          snapshot = await db
            .collection(TENANT_CODE_COLLECTION)
            .where('status', '==', 'active')
            .where('expiresAt', '<=', nowTs)
            .limit(JOIN_CODE_EXPIRY_SWEEP_BATCH_SIZE)
            .get();
        } catch {
          break;
        }
        const processed = await expireCodeBatch(snapshot);
        expired += processed;
        if (processed === 0 || processed < JOIN_CODE_EXPIRY_SWEEP_BATCH_SIZE) {
          break;
        }
      }

      if (expired) {
        console.log(`[join_code_expiry] expired ${expired} active join codes (cutoff ${nowIso})`);
      }
      return { expired };
    } catch (error: any) {
      console.warn('[join_code_expiry] sweep error', error?.message || error);
      throw error;
    }
  }

  if (!isTestProcess && JOIN_REQUEST_EXPIRY_SWEEP_INTERVAL_MS > 0) {
    const scheduleJoinExpirySweep = () =>
      expireJoinRequestsOnce().catch((error) =>
        console.warn('[join_request_expiry] periodic error', error instanceof Error ? error.message : error),
      );
    setInterval(scheduleJoinExpirySweep, JOIN_REQUEST_EXPIRY_SWEEP_INTERVAL_MS).unref?.();
    setTimeout(scheduleJoinExpirySweep, 10000).unref?.();
  }

  if (!isTestProcess && INVITE_EXPIRY_SWEEP_INTERVAL_MS > 0) {
    const scheduleInviteExpirySweep = () =>
      expireInvitesOnce().catch((error) =>
        console.warn('[invite_expiry] periodic error', error instanceof Error ? error.message : error),
      );
    setInterval(scheduleInviteExpirySweep, INVITE_EXPIRY_SWEEP_INTERVAL_MS).unref?.();
    setTimeout(scheduleInviteExpirySweep, 12000).unref?.();
  }

  app.post('/internal/join-requests/expire', requireOperatorAuth, async (_req, res) => {
    try {
      const result = await expireJoinRequestsOnce();
      res.json({ ok: true, ...result });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/internal/invites/expire', requireOperatorAuth, async (_req, res) => {
    try {
      const result = await expireInvitesOnce();
      res.json({ ok: true, ...result });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  if (!isTestProcess && JOIN_CODE_EXPIRY_SWEEP_INTERVAL_MS > 0) {
    const scheduleJoinCodeExpirySweep = () =>
      expireJoinCodesOnce().catch((error) =>
        console.warn('[join_code_expiry] periodic error', error instanceof Error ? error.message : error),
      );
    setInterval(scheduleJoinCodeExpirySweep, JOIN_CODE_EXPIRY_SWEEP_INTERVAL_MS).unref?.();
    setTimeout(scheduleJoinCodeExpirySweep, 14000).unref?.();
  }

  app.post('/internal/join-codes/expire', requireOperatorAuth, async (_req, res) => {
    try {
      const result = await expireJoinCodesOnce();
      res.json({ ok: true, ...result });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  // Expose for tests
  (app as any)._expireInvitesOnce = expireInvitesOnce;
  (app as any)._expireJoinCodesOnce = expireJoinCodesOnce;

  function parseAnyTimestamp(val: any): Date | null {
    try {
      if (!val) return null;
      if (val && typeof val === 'object' && (val as any)._methodName === 'serverTimestamp') return new Date();
      if (val && typeof val === 'object' && typeof (val as any).seconds === 'number') return new Date((val as any).seconds * 1000 + Math.floor(((val as any).nanoseconds || 0) / 1e6));
      if (val && typeof (val as any).toDate === 'function') return (val as any).toDate();
      if (val instanceof Date) return val;
      if (typeof val === 'number' || typeof val === 'string') return new Date(val);
      return null;
    } catch { return null; }
  }

  async function fetchPresenceSnapshot(
    col: admin.firestore.CollectionReference<admin.firestore.DocumentData>,
    preferredMode: PresenceQueryMode
  ): Promise<{ snap: admin.firestore.QuerySnapshot<admin.firestore.DocumentData>; modeUsed: PresenceQueryMode }> {
    if (preferredMode === 'online_only') {
      try {
        const snap = await col.where('isOnline', '==', true).get();
        return { snap, modeUsed: 'online_only' };
      } catch (error) {
        console.warn('[presence_sweeper] online_only query failed; falling back to full_scan', error instanceof Error ? error.message : error);
      }
    }
    const snap = await col.get();
    return { snap, modeUsed: 'full_scan' };
  }

  async function sweepPresenceOnce(){
    try {
      const db = getFirestoreImpl();
      const col = db.collection(PRESENCE_COLLECTION);
      const { snap, modeUsed } = await fetchPresenceSnapshot(col, PRESENCE_SWEEP_QUERY_MODE);
      const now = Date.now();
      let scanned = 0;
      // PERF (P16): collect the docs that need flipping to offline, then commit the
      // independent, idempotent `isOnline:false` updates in chunked writeBatches
      // (≤400) instead of one awaited `update` per doc. Semantics are unchanged:
      // an online doc is marked offline when it has no parseable lastSeen OR its
      // lastSeen is older than the stale window; offline docs are never touched.
      const staleRefs: admin.firestore.DocumentReference[] = [];
      for (const doc of snap.docs){
        const data = doc.data() as any;
        const isOnline = data.isOnline === true;
        const parsed = parseAnyTimestamp(data.lastSeen);
        scanned++;
        if (!isOnline) {
          continue;
        }
        if (!parsed || now - parsed.getTime() > PRESENCE_STALE_WINDOW_MS) {
          staleRefs.push(doc.ref);
        }
      }

      const PRESENCE_SWEEP_BATCH_LIMIT = 400;
      for (let i = 0; i < staleRefs.length; i += PRESENCE_SWEEP_BATCH_LIMIT) {
        const batch = db.batch();
        for (const ref of staleRefs.slice(i, i + PRESENCE_SWEEP_BATCH_LIMIT)) {
          batch.update(ref, { isOnline: false });
        }
        await batch.commit();
      }
      const updates = staleRefs.length;

      console.log(`[presence_sweeper] mode=${modeUsed} scanned ${scanned} docs, updated ${updates} stale presence flags`);
      return { scanned, updates };
    } catch(e:any) {
      console.warn('[presence_sweeper] sweep error', e?.message||e);
      throw e;
    }
  }

  if (!isTestProcess && PRESENCE_SWEEP_INTERVAL_MS > 0) {
    setInterval(() => { sweepPresenceOnce().catch((e)=>console.warn('[presence_sweeper] periodic error', e?.message||e)); }, PRESENCE_SWEEP_INTERVAL_MS).unref?.();
    setTimeout(() => { sweepPresenceOnce().catch((e)=>console.warn('[presence_sweeper] startup error', e?.message||e)); }, 5000).unref?.();
  }

  app.post('/internal/presence/sweep', requireOperatorAuth, async (_req, res) => {
    try {
      const { scanned, updates } = await sweepPresenceOnce();
      res.json({ ok: true, scanned, updates, thresholdMinutes: PRESENCE_STALE_MINUTES });
    } catch (e:any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  const schedulersEnabled = !isTestProcess;
  if (schedulersEnabled) {
    startBirthdayNotificationScheduler();
    startDailyQuoteScheduler();
    startBillingBackfillScheduler();
    startPlayBillingReconcileScheduler();
  }

  // Expose for tests and diagnostics
  (app as any)._runBirthdayNotificationJob = runBirthdayNotificationJobImpl;
  (app as any)._runDailyQuoteJob = runDailyQuoteJobImpl;
  // Graceful shutdown helper for external usage
  (app as any).shutdown = async () => { try { await shutdownQueue(); } catch {} };
  /* c8 ignore stop */
  return app;
}

// If run directly, start server
if (require.main === module) {
  const app = createApp();
  const PORT = process.env.PORT || 8080;
  const server = app.listen(PORT, ()=> console.log('Backend runtime listening on', PORT));
  ['SIGINT','SIGTERM'].forEach(sig=>process.on(sig, ()=>{ server.close(()=>process.exit(0)); setTimeout(()=>process.exit(1), 10000); }));
}
