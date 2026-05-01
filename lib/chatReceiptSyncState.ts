export interface ChatReceiptSyncQueueOptions {
  readMessageIds?: unknown;
  requestConversationDelivered?: boolean;
}

export interface ChatReceiptSyncQueueRequestPlanInput {
  readMessageIds?: Iterable<unknown>;
  requestConversationDelivered?: boolean;
}

export interface ChatReceiptSyncQueueRequestPlan {
  readMessageIds: string[];
  requestConversationDelivered: boolean;
  shouldQueueSync: boolean;
}

export interface ChatReceiptSyncQueueInvocationPlan {
  shouldQueueSync: boolean;
  queueOptions: {
    readMessageIds: string[];
    requestConversationDelivered: boolean;
  };
}

export interface ChatReceiptForegroundQueuePlanInput {
  partnerEmail: unknown;
  userEmail: unknown;
  isFocused: boolean;
  isAppActive: boolean;
  readMessageIds?: Iterable<unknown>;
  requestConversationDelivered?: boolean;
}

export interface ChatReceiptForegroundQueueExecutionPlanInput
  extends ChatReceiptForegroundQueuePlanInput {
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatReceiptForegroundQueuePlan {
  queueRequestPlan: ChatReceiptSyncQueueRequestPlan;
  shouldQueueSync: boolean;
}

export interface ChatReceiptIncomingUnreadMessageInput {
  message: unknown;
  partnerEmail: unknown;
  userEmail: unknown;
}

export interface ChatReceiptIncomingUnreadMessageNormalizedInput {
  message: unknown;
  normalizedPartnerEmail: string | null;
  normalizedUserEmail: string | null;
}

export interface ChatReceiptSyncQueueUpdate {
  readMessageIds: string[];
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncFlushInput {
  partnerEmail: unknown;
  userEmail: unknown;
  isFocused: boolean;
  isAppActive: boolean;
  queuedReadMessageIds: Iterable<unknown>;
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncFlushPlan {
  shouldResetQueue: boolean;
  shouldSync: boolean;
  partnerEmail: string | null;
  userEmail: string | null;
  readMessageIds: string[];
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncFlushExecutionSkipPlan {
  shouldClearQueue: boolean;
  shouldRunSync: false;
  partnerEmail: string | null;
  readMessageIds: string[];
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncFlushExecutionRunPlan {
  shouldClearQueue: boolean;
  shouldRunSync: true;
  partnerEmail: string;
  readMessageIds: string[];
  requestConversationDelivered: boolean;
}

export type ChatReceiptSyncFlushExecutionPlan =
  | ChatReceiptSyncFlushExecutionSkipPlan
  | ChatReceiptSyncFlushExecutionRunPlan;

export interface ChatReceiptSyncFailureInput {
  readMessageIds: Iterable<unknown>;
  requestConversationDelivered: boolean;
  partnerEmail: unknown;
}

export interface ChatReceiptSyncFailurePlan {
  rollbackReadMessageIds: string[];
  shouldResetDeliverySyncMarker: boolean;
  partnerEmail: string | null;
}

export interface ChatReceiptSyncFailureRecoveryPlan {
  rollbackMutationPlan: ChatReceiptRequestedReadMutationPlan;
  nextDeliverySyncMarker: ChatReceiptDeliverySyncMarker | null;
}

export interface ChatReceiptSyncRunAttemptInput {
  partnerEmail: unknown;
  readMessageIds: Iterable<unknown>;
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncRunAttemptPayload {
  readMessageIds: string[];
  markConversationDelivered: boolean;
}

export interface ChatReceiptSyncRunAttemptPlan {
  partnerEmail: string | null;
  syncPayload: ChatReceiptSyncRunAttemptPayload;
  requestMutationPlan: ChatReceiptRequestedReadMutationPlan;
  failureRecoveryPlan: ChatReceiptSyncFailureRecoveryPlan;
}

export interface ChatReceiptSyncFollowupInput {
  queuedReadMessageCount: unknown;
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncFollowupTriggerInput {
  queuedReadMessageCount: unknown;
  requestConversationDelivered: boolean;
  hasPendingTimeout?: boolean;
  triggerMode?: 'deferred' | 'immediate';
}

export interface ChatReceiptSyncFollowupTriggerPlan {
  shouldScheduleFollowup: boolean;
  shouldScheduleDeferredFlush: boolean;
  shouldFlushImmediately: boolean;
}

export interface ChatReceiptSyncFinalizePlanInput {
  queuedReadMessageCount: unknown;
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncFinalizePlan {
  followupTriggerPlan: ChatReceiptSyncFollowupTriggerPlan;
  shouldFlushImmediately: boolean;
}

export interface ChatReceiptSyncRunFinalizePlanInput {
  requestedReadMessageIds: Set<string>;
  failureRecoveryPlan?: ChatReceiptSyncFailureRecoveryPlan | null;
  currentDeliverySyncMarker: ChatReceiptDeliverySyncMarker;
  queuedReadMessageCount: unknown;
  requestConversationDelivered: boolean;
}

export interface ChatReceiptSyncRunFinalizePlan {
  nextDeliverySyncMarker: ChatReceiptDeliverySyncMarker;
  shouldFlushImmediately: boolean;
}

export interface ChatReceiptSyncRunContinuationInput {
  runGeneration: unknown;
  activeGeneration: unknown;
}

export interface ChatReceiptSyncDeferredFlushContinuationInput {
  scheduledGeneration: unknown;
  activeGeneration: unknown;
}

export interface ChatReceiptSyncQueueExecutionContinuationInput {
  queueGeneration: unknown;
  activeGeneration: unknown;
}

export interface ChatReceiptQueueInvocationExecutionPlanInput {
  queueInvocationPlan: ChatReceiptSyncQueueInvocationPlan;
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatReceiptQueueInvocationExecutionPlan {
  shouldApplyQueueInvocationExecutionPlan: boolean;
  shouldQueueSync: boolean;
  queueOptions: {
    readMessageIds: string[];
    requestConversationDelivered: boolean;
  };
}

export interface ChatReceiptDeliverySyncRequestInput {
  partnerEmail: unknown;
  lastPartnerEmail: unknown;
  lastAttemptAtMs: unknown;
  nowMs?: unknown;
  cooldownMs?: unknown;
}

export interface ChatReceiptDeliverySyncRequestDecision {
  requestConversationDelivered: boolean;
  partnerEmail: string | null;
  nowMs: number;
}

export interface ChatReceiptViewabilitySyncPlanInput {
  partnerEmail: unknown;
  lastPartnerEmail: unknown;
  lastAttemptAtMs: unknown;
  visibleUnreadIncomingIds?: Iterable<unknown>;
  nowMs?: unknown;
  cooldownMs?: unknown;
}

export interface ChatReceiptViewabilitySyncPlan {
  queueRequestPlan: ChatReceiptSyncQueueRequestPlan;
  nextDeliverySyncMarker: ChatReceiptDeliverySyncMarker | null;
}

export interface ChatReceiptViewabilityQueueInvocationPlan {
  nextDeliverySyncMarker: ChatReceiptDeliverySyncMarker | null;
  queueInvocationPlan: ChatReceiptSyncQueueInvocationPlan;
}

export interface ChatReceiptViewabilityQueueExecutionPlanInput
  extends ChatReceiptViewabilitySyncPlanInput {
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatReceiptViewabilityQueueExecutionPlan {
  shouldApplyViewabilityQueueExecutionPlan: boolean;
  nextDeliverySyncMarker: ChatReceiptDeliverySyncMarker | null;
  queueInvocationPlan: ChatReceiptSyncQueueInvocationPlan;
}

export type ChatReceiptViewabilityQueueDispatchPlanInput =
  ChatReceiptViewabilityQueueExecutionPlanInput;

export interface ChatReceiptViewabilityQueueDispatchPlanForMarkerInput {
  partnerEmail: unknown;
  lastDeliverySyncMarker?: ChatReceiptDeliverySyncMarker | null;
  visibleUnreadIncomingIds?: Iterable<unknown>;
  nowMs?: unknown;
  cooldownMs?: unknown;
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatReceiptViewabilityQueueDispatchPlan {
  shouldApplyViewabilityQueueDispatchPlan: boolean;
  nextDeliverySyncMarker: ChatReceiptDeliverySyncMarker | null;
  shouldQueueSync: boolean;
  queueOptions: {
    readMessageIds: string[];
    requestConversationDelivered: boolean;
  };
}

export interface ChatReceiptDeliverySyncMarker {
  partnerEmail: string | null;
  at: number;
}

export interface ChatReceiptSyncConversationResetPlan {
  requestConversationDelivered: boolean;
  deliverySyncMarker: ChatReceiptDeliverySyncMarker;
}

export interface ChatReceiptRequestedReadMutationInput {
  addMessageIds?: Iterable<unknown>;
  removeMessageIds?: Iterable<unknown>;
}

export interface ChatReceiptRequestedReadMutationPlan {
  addMessageIds: string[];
  removeMessageIds: string[];
}

export interface ChatReceiptSyncQueueApplyInput {
  queuedReadMessageIds: Set<string>;
  requestConversationDelivered: boolean;
  queueUpdate: ChatReceiptSyncQueueUpdate;
}

export interface ChatReceiptSyncQueueApplyPlan {
  addMessageIds: string[];
  nextRequestConversationDelivered: boolean;
  nextQueuedReadMessageCount: number;
}

export interface ChatReceiptSyncQueueSchedulePlanInput {
  options: ChatReceiptSyncQueueOptions;
  requestedReadMessageIds: Set<string>;
  queuedReadMessageIds: Set<string>;
  requestConversationDelivered: boolean;
  hasPendingTimeout: boolean;
}

export interface ChatReceiptSyncQueueSchedulePlan {
  queueApplyPlan: ChatReceiptSyncQueueApplyPlan;
  followupTriggerPlan: ChatReceiptSyncFollowupTriggerPlan;
}

export interface ChatReceiptSyncQueueExecutionPlanInput
  extends ChatReceiptSyncQueueSchedulePlanInput {
  deferredFlushDelayMs?: unknown;
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatReceiptSyncQueueExecutionPlan {
  shouldApplyQueueExecutionPlan: boolean;
  nextQueuedState: ChatReceiptSyncQueuedState;
  deferredFlushPlan: ChatReceiptSyncQueueDeferredFlushPlan;
}

export interface ChatReceiptSyncQueueDeferredFlushPlanInput {
  followupTriggerPlan: ChatReceiptSyncFollowupTriggerPlan;
  deferredFlushDelayMs?: unknown;
}

export interface ChatReceiptSyncQueueDeferredFlushPlan {
  shouldScheduleDeferredFlush: boolean;
  deferredFlushDelayMs: number;
}

export interface ChatReceiptSyncQueueScheduleDeferredFlushPlanInput {
  queueSchedulePlan: ChatReceiptSyncQueueSchedulePlan;
  deferredFlushDelayMs?: unknown;
}

export interface ChatReceiptSyncQueueScheduleExecutionPlanInput {
  queuedReadMessageIds: Set<string>;
  requestConversationDelivered: boolean;
  queueSchedulePlan: ChatReceiptSyncQueueSchedulePlan;
  deferredFlushDelayMs?: unknown;
}

export interface ChatReceiptSyncQueueScheduleExecutionPlan {
  nextQueuedState: ChatReceiptSyncQueuedState;
  deferredFlushPlan: ChatReceiptSyncQueueDeferredFlushPlan;
}

export interface ChatReceiptSyncQueuedState {
  queuedReadMessageIds: Set<string>;
  requestConversationDelivered: boolean;
}

export const DEFAULT_CHAT_RECEIPT_DELIVERY_SYNC_COOLDOWN_MS = 15000;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeChatReceiptSyncEmail(value: unknown): string | null {
  return normalizeEmail(value);
}

function normalizeMessageId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeQueuedReadMessageIds(ids: Iterable<unknown>): string[] {
  const deduped = new Set<string>();
  const normalizedIds: string[] = [];

  for (const id of ids) {
    const normalized = normalizeMessageId(id);
    if (!normalized || deduped.has(normalized)) {
      continue;
    }

    deduped.add(normalized);
    normalizedIds.push(normalized);
  }

  return normalizedIds;
}

function normalizeCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function normalizeGeneration(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Number.NaN;
  }

  return Math.trunc(numeric);
}

export function shouldApplyChatReceiptSyncRunContinuation(
  input: ChatReceiptSyncRunContinuationInput
): boolean {
  const runGeneration = normalizeGeneration(input.runGeneration);
  const activeGeneration = normalizeGeneration(input.activeGeneration);

  if (!Number.isFinite(runGeneration) || !Number.isFinite(activeGeneration)) {
    return false;
  }

  return runGeneration === activeGeneration;
}

export function shouldRunChatReceiptSyncDeferredFlushContinuation(
  input: ChatReceiptSyncDeferredFlushContinuationInput
): boolean {
  return shouldApplyChatReceiptSyncRunContinuation({
    runGeneration: input.scheduledGeneration,
    activeGeneration: input.activeGeneration,
  });
}

export function shouldApplyChatReceiptSyncQueueExecutionContinuation(
  input: ChatReceiptSyncQueueExecutionContinuationInput
): boolean {
  return shouldApplyChatReceiptSyncRunContinuation({
    runGeneration: input.queueGeneration,
    activeGeneration: input.activeGeneration,
  });
}

export function resolveChatReceiptQueueInvocationExecutionPlan(
  input: ChatReceiptQueueInvocationExecutionPlanInput
): ChatReceiptQueueInvocationExecutionPlan {
  const readMessageIds = normalizeQueuedReadMessageIds(
    input?.queueInvocationPlan?.queueOptions?.readMessageIds || []
  );
  const requestConversationDelivered =
    input?.queueInvocationPlan?.queueOptions?.requestConversationDelivered === true;
  const hasQueueWork = readMessageIds.length > 0 || requestConversationDelivered;
  const shouldQueueSync =
    input?.queueInvocationPlan?.shouldQueueSync === true && hasQueueWork;
  const hasQueueGenerationGuardInput =
    input.queueGeneration !== undefined || input.activeGeneration !== undefined;

  if (
    hasQueueGenerationGuardInput &&
    !shouldApplyChatReceiptSyncQueueExecutionContinuation({
      queueGeneration: input.queueGeneration,
      activeGeneration: input.activeGeneration,
    })
  ) {
    return {
      shouldApplyQueueInvocationExecutionPlan: false,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    };
  }

  return {
    shouldApplyQueueInvocationExecutionPlan: true,
    shouldQueueSync,
    queueOptions: {
      readMessageIds,
      requestConversationDelivered,
    },
  };
}

function resolveNowMs(value: unknown): number {
  const nowMs = normalizeCount(value);
  if (nowMs > 0) {
    return nowMs;
  }

  return Date.now();
}

function resolveCooldownMs(value: unknown): number {
  const cooldownMs = normalizeCount(value);
  if (cooldownMs > 0) {
    return cooldownMs;
  }

  return DEFAULT_CHAT_RECEIPT_DELIVERY_SYNC_COOLDOWN_MS;
}

export function resolveChatReceiptSyncQueueUpdate(
  options: ChatReceiptSyncQueueOptions,
  requestedReadMessageIds: Set<string>
): ChatReceiptSyncQueueUpdate {
  const requested = requestedReadMessageIds instanceof Set ? requestedReadMessageIds : new Set<string>();
  const readMessageIdsInput = Array.isArray(options?.readMessageIds) ? options.readMessageIds : [];
  const deduped = new Set<string>();
  const readMessageIds: string[] = [];

  for (const messageId of readMessageIdsInput) {
    const normalized = normalizeMessageId(messageId);
    if (!normalized || requested.has(normalized) || deduped.has(normalized)) {
      continue;
    }

    deduped.add(normalized);
    readMessageIds.push(normalized);
  }

  return {
    readMessageIds,
    requestConversationDelivered: options?.requestConversationDelivered === true,
  };
}

export function resolveChatReceiptIncomingUnreadMessageId(
  input: ChatReceiptIncomingUnreadMessageInput
): string | null {
  return resolveChatReceiptIncomingUnreadMessageIdForNormalizedParticipants({
    message: input.message,
    normalizedPartnerEmail: normalizeEmail(input.partnerEmail),
    normalizedUserEmail: normalizeEmail(input.userEmail),
  });
}

export function resolveChatReceiptIncomingUnreadMessageIdForNormalizedParticipants(
  input: ChatReceiptIncomingUnreadMessageNormalizedInput
): string | null {
  const partnerEmail = input.normalizedPartnerEmail;
  const userEmail = input.normalizedUserEmail;
  if (!partnerEmail || !userEmail) {
    return null;
  }

  const message = input.message;
  if (!message || typeof message !== 'object') {
    return null;
  }

  const rawMessage = message as Record<string, unknown>;
  const messageId = normalizeMessageId(rawMessage.id);
  if (!messageId || rawMessage.deleted || rawMessage.read) {
    return null;
  }

  const senderEmail = normalizeEmail(rawMessage.sender);
  const recipientEmail = normalizeEmail(rawMessage.recipientId);
  if (!senderEmail || !recipientEmail) {
    return null;
  }

  return senderEmail === partnerEmail && recipientEmail === userEmail
    ? messageId
    : null;
}

export function resolveChatReceiptSyncQueueRequestPlan(
  input: ChatReceiptSyncQueueRequestPlanInput
): ChatReceiptSyncQueueRequestPlan {
  const readMessageIds = normalizeQueuedReadMessageIds(input.readMessageIds || []);
  const requestConversationDelivered = input.requestConversationDelivered === true;

  return {
    readMessageIds,
    requestConversationDelivered,
    shouldQueueSync: readMessageIds.length > 0 || requestConversationDelivered,
  };
}

export function resolveChatReceiptSyncQueueInvocationPlan(
  queueRequestPlan: ChatReceiptSyncQueueRequestPlan
): ChatReceiptSyncQueueInvocationPlan {
  const readMessageIds = normalizeQueuedReadMessageIds(queueRequestPlan?.readMessageIds || []);
  const requestConversationDelivered =
    queueRequestPlan?.requestConversationDelivered === true;
  const hasQueueWork = readMessageIds.length > 0 || requestConversationDelivered;

  return {
    shouldQueueSync: queueRequestPlan?.shouldQueueSync === true && hasQueueWork,
    queueOptions: {
      readMessageIds,
      requestConversationDelivered,
    },
  };
}

export function resolveChatReceiptForegroundQueuePlan(
  input: ChatReceiptForegroundQueuePlanInput
): ChatReceiptForegroundQueuePlan {
  const partnerEmail = normalizeEmail(input.partnerEmail);
  const userEmail = normalizeEmail(input.userEmail);

  if (!partnerEmail || !userEmail || !input.isFocused || !input.isAppActive) {
    return {
      queueRequestPlan: {
        readMessageIds: [],
        requestConversationDelivered: false,
        shouldQueueSync: false,
      },
      shouldQueueSync: false,
    };
  }

  const queueRequestPlan = resolveChatReceiptSyncQueueRequestPlan({
    readMessageIds: input.readMessageIds || [],
    requestConversationDelivered: input.requestConversationDelivered,
  });

  return {
    queueRequestPlan,
    shouldQueueSync: queueRequestPlan.shouldQueueSync,
  };
}

export function resolveChatReceiptForegroundQueueInvocationPlan(
  input: ChatReceiptForegroundQueuePlanInput
): ChatReceiptSyncQueueInvocationPlan {
  const foregroundQueuePlan = resolveChatReceiptForegroundQueuePlan(input);
  return resolveChatReceiptSyncQueueInvocationPlan(foregroundQueuePlan.queueRequestPlan);
}

export function resolveChatReceiptForegroundQueueExecutionPlan(
  input: ChatReceiptForegroundQueueExecutionPlanInput
): ChatReceiptQueueInvocationExecutionPlan {
  const queueInvocationPlan = resolveChatReceiptForegroundQueueInvocationPlan(input);

  return resolveChatReceiptQueueInvocationExecutionPlan({
    queueInvocationPlan,
    queueGeneration: input.queueGeneration,
    activeGeneration: input.activeGeneration,
  });
}

export function resolveChatReceiptSyncFlushPlan(
  input: ChatReceiptSyncFlushInput
): ChatReceiptSyncFlushPlan {
  const partnerEmail = normalizeEmail(input.partnerEmail);
  const userEmail = normalizeEmail(input.userEmail);

  if (!partnerEmail || !userEmail || !input.isFocused || !input.isAppActive) {
    return {
      shouldResetQueue: true,
      shouldSync: false,
      partnerEmail,
      userEmail,
      readMessageIds: [],
      requestConversationDelivered: false,
    };
  }

  const readMessageIds = normalizeQueuedReadMessageIds(input.queuedReadMessageIds);
  const requestConversationDelivered = input.requestConversationDelivered === true;

  return {
    shouldResetQueue: false,
    shouldSync: readMessageIds.length > 0 || requestConversationDelivered,
    partnerEmail,
    userEmail,
    readMessageIds,
    requestConversationDelivered,
  };
}

export function resolveChatReceiptSyncFlushExecutionPlan(
  flushPlan: ChatReceiptSyncFlushPlan
): ChatReceiptSyncFlushExecutionPlan {
  if (flushPlan.shouldResetQueue) {
    return {
      shouldClearQueue: true,
      shouldRunSync: false,
      partnerEmail: normalizeEmail(flushPlan.partnerEmail),
      readMessageIds: [],
      requestConversationDelivered: false,
    };
  }

  const partnerEmail = normalizeEmail(flushPlan.partnerEmail);
  const readMessageIds = normalizeQueuedReadMessageIds(flushPlan.readMessageIds);
  const requestConversationDelivered = flushPlan.requestConversationDelivered === true;
  const shouldRunSync = flushPlan.shouldSync === true && Boolean(partnerEmail);

  if (!shouldRunSync || !partnerEmail) {
    return {
      shouldClearQueue: true,
      shouldRunSync: false,
      partnerEmail,
      readMessageIds,
      requestConversationDelivered,
    };
  }

  return {
    shouldClearQueue: true,
    shouldRunSync: true,
    partnerEmail,
    readMessageIds,
    requestConversationDelivered,
  };
}

export function resolveChatReceiptSyncFailurePlan(
  input: ChatReceiptSyncFailureInput
): ChatReceiptSyncFailurePlan {
  const partnerEmail = normalizeEmail(input.partnerEmail);
  const rollbackReadMessageIds = normalizeQueuedReadMessageIds(input.readMessageIds);
  const shouldResetDeliverySyncMarker =
    input.requestConversationDelivered === true && Boolean(partnerEmail);

  return {
    rollbackReadMessageIds,
    shouldResetDeliverySyncMarker,
    partnerEmail,
  };
}

export function resolveChatReceiptSyncFailureRecoveryPlan(
  input: ChatReceiptSyncFailureInput
): ChatReceiptSyncFailureRecoveryPlan {
  const failurePlan = resolveChatReceiptSyncFailurePlan(input);
  return {
    rollbackMutationPlan: resolveChatReceiptRequestedReadMutationPlan({
      removeMessageIds: failurePlan.rollbackReadMessageIds,
    }),
    nextDeliverySyncMarker:
      failurePlan.shouldResetDeliverySyncMarker && failurePlan.partnerEmail
        ? resolveChatReceiptDeliverySyncMarkerReset(failurePlan.partnerEmail)
        : null,
  };
}

export function resolveChatReceiptSyncRunAttemptPlan(
  input: ChatReceiptSyncRunAttemptInput
): ChatReceiptSyncRunAttemptPlan {
  const partnerEmail = normalizeEmail(input.partnerEmail);
  const readMessageIds = normalizeQueuedReadMessageIds(input.readMessageIds);
  const requestConversationDelivered = input.requestConversationDelivered === true;

  return {
    partnerEmail,
    syncPayload: {
      readMessageIds,
      markConversationDelivered: requestConversationDelivered,
    },
    requestMutationPlan: resolveChatReceiptRequestedReadMutationPlan({
      addMessageIds: readMessageIds,
    }),
    failureRecoveryPlan: resolveChatReceiptSyncFailureRecoveryPlan({
      readMessageIds,
      requestConversationDelivered,
      partnerEmail,
    }),
  };
}

export function shouldScheduleChatReceiptSyncFollowup(
  input: ChatReceiptSyncFollowupInput
): boolean {
  return (
    normalizeCount(input.queuedReadMessageCount) > 0 ||
    input.requestConversationDelivered === true
  );
}

export function resolveChatReceiptSyncFollowupTriggerPlan(
  input: ChatReceiptSyncFollowupTriggerInput
): ChatReceiptSyncFollowupTriggerPlan {
  const shouldScheduleFollowup = shouldScheduleChatReceiptSyncFollowup({
    queuedReadMessageCount: input.queuedReadMessageCount,
    requestConversationDelivered: input.requestConversationDelivered,
  });

  if (!shouldScheduleFollowup) {
    return {
      shouldScheduleFollowup: false,
      shouldScheduleDeferredFlush: false,
      shouldFlushImmediately: false,
    };
  }

  if (input.triggerMode === 'immediate') {
    return {
      shouldScheduleFollowup: true,
      shouldScheduleDeferredFlush: false,
      shouldFlushImmediately: true,
    };
  }

  return {
    shouldScheduleFollowup: true,
    shouldScheduleDeferredFlush: input.hasPendingTimeout !== true,
    shouldFlushImmediately: false,
  };
}

export function resolveChatReceiptSyncFinalizePlan(
  input: ChatReceiptSyncFinalizePlanInput
): ChatReceiptSyncFinalizePlan {
  const followupTriggerPlan = resolveChatReceiptSyncFollowupTriggerPlan({
    queuedReadMessageCount: input.queuedReadMessageCount,
    requestConversationDelivered: input.requestConversationDelivered,
    triggerMode: 'immediate',
  });

  return {
    followupTriggerPlan,
    shouldFlushImmediately: followupTriggerPlan.shouldFlushImmediately,
  };
}

export function resolveChatReceiptRequestedReadSeedMessageIds(
  messages: Iterable<unknown>
): string[] {
  const deduped = new Set<string>();
  const seedMessageIds: string[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const raw = message as Record<string, unknown>;
    if (!raw.id || !raw.read) {
      continue;
    }

    const messageId = normalizeMessageId(raw.id);
    if (!messageId || deduped.has(messageId)) {
      continue;
    }

    deduped.add(messageId);
    seedMessageIds.push(messageId);
  }

  return seedMessageIds;
}

export function resolveChatReceiptRequestedReadMutationPlan(
  input: ChatReceiptRequestedReadMutationInput
): ChatReceiptRequestedReadMutationPlan {
  const addMessageIds = normalizeQueuedReadMessageIds(input.addMessageIds || []);
  const removeMessageIds = normalizeQueuedReadMessageIds(input.removeMessageIds || []);

  if (addMessageIds.length <= 0 || removeMessageIds.length <= 0) {
    return {
      addMessageIds,
      removeMessageIds,
    };
  }

  const removeSet = new Set(removeMessageIds);
  return {
    addMessageIds: addMessageIds.filter((messageId) => !removeSet.has(messageId)),
    removeMessageIds,
  };
}

export function applyChatReceiptRequestedReadMutation(
  requestedReadMessageIds: Set<string>,
  mutationPlan: ChatReceiptRequestedReadMutationPlan
): void {
  if (!(requestedReadMessageIds instanceof Set)) {
    return;
  }

  mutationPlan.removeMessageIds.forEach((messageId) => {
    requestedReadMessageIds.delete(messageId);
  });
  mutationPlan.addMessageIds.forEach((messageId) => {
    requestedReadMessageIds.add(messageId);
  });
}

export function applyChatReceiptSyncFailureRecoveryPlan(
  requestedReadMessageIds: Set<string>,
  failureRecoveryPlan: ChatReceiptSyncFailureRecoveryPlan,
  currentDeliverySyncMarker: ChatReceiptDeliverySyncMarker
): ChatReceiptDeliverySyncMarker {
  const rollbackMutationPlan = resolveChatReceiptRequestedReadMutationPlan({
    addMessageIds: failureRecoveryPlan.rollbackMutationPlan.addMessageIds,
    removeMessageIds: failureRecoveryPlan.rollbackMutationPlan.removeMessageIds,
  });

  applyChatReceiptRequestedReadMutation(
    requestedReadMessageIds,
    rollbackMutationPlan
  );

  return failureRecoveryPlan.nextDeliverySyncMarker || currentDeliverySyncMarker;
}

export function applyChatReceiptSyncRunFinalizePlan(
  input: ChatReceiptSyncRunFinalizePlanInput
): ChatReceiptSyncRunFinalizePlan {
  const nextDeliverySyncMarker = input.failureRecoveryPlan
    ? applyChatReceiptSyncFailureRecoveryPlan(
        input.requestedReadMessageIds,
        input.failureRecoveryPlan,
        input.currentDeliverySyncMarker
      )
    : input.currentDeliverySyncMarker;

  const flushFinalizePlan = resolveChatReceiptSyncFinalizePlan({
    queuedReadMessageCount: input.queuedReadMessageCount,
    requestConversationDelivered: input.requestConversationDelivered,
  });

  return {
    nextDeliverySyncMarker,
    shouldFlushImmediately: flushFinalizePlan.shouldFlushImmediately,
  };
}

export function resolveChatReceiptSyncQueueApplyPlan(
  input: ChatReceiptSyncQueueApplyInput
): ChatReceiptSyncQueueApplyPlan {
  const queuedReadMessageIds =
    input.queuedReadMessageIds instanceof Set
      ? input.queuedReadMessageIds
      : new Set<string>();
  const queueUpdate = input.queueUpdate || {
    readMessageIds: [],
    requestConversationDelivered: false,
  };

  const deduped = new Set<string>();
  const addMessageIds: string[] = [];

  for (const messageId of Array.isArray(queueUpdate.readMessageIds)
    ? queueUpdate.readMessageIds
    : []) {
    const normalized = normalizeMessageId(messageId);
    if (!normalized || queuedReadMessageIds.has(normalized) || deduped.has(normalized)) {
      continue;
    }

    deduped.add(normalized);
    addMessageIds.push(normalized);
  }

  const nextRequestConversationDelivered =
    input.requestConversationDelivered === true ||
    queueUpdate.requestConversationDelivered === true;
  const nextQueuedReadMessageCount =
    normalizeCount(queuedReadMessageIds.size) + addMessageIds.length;

  return {
    addMessageIds,
    nextRequestConversationDelivered,
    nextQueuedReadMessageCount,
  };
}

export function resolveChatReceiptSyncQueueSchedulePlan(
  input: ChatReceiptSyncQueueSchedulePlanInput
): ChatReceiptSyncQueueSchedulePlan {
  const queueUpdate = resolveChatReceiptSyncQueueUpdate(
    input.options,
    input.requestedReadMessageIds
  );
  const queueApplyPlan = resolveChatReceiptSyncQueueApplyPlan({
    queuedReadMessageIds: input.queuedReadMessageIds,
    requestConversationDelivered: input.requestConversationDelivered,
    queueUpdate,
  });

  return {
    queueApplyPlan,
    followupTriggerPlan: resolveChatReceiptSyncFollowupTriggerPlan({
      queuedReadMessageCount: queueApplyPlan.nextQueuedReadMessageCount,
      requestConversationDelivered: queueApplyPlan.nextRequestConversationDelivered,
      hasPendingTimeout: input.hasPendingTimeout,
      triggerMode: 'deferred',
    }),
  };
}

export function resolveChatReceiptSyncQueueDeferredFlushPlan(
  input: ChatReceiptSyncQueueDeferredFlushPlanInput
): ChatReceiptSyncQueueDeferredFlushPlan {
  const shouldScheduleDeferredFlush =
    input?.followupTriggerPlan?.shouldScheduleDeferredFlush === true;

  if (!shouldScheduleDeferredFlush) {
    return {
      shouldScheduleDeferredFlush: false,
      deferredFlushDelayMs: 0,
    };
  }

  const normalizedDelayMs = normalizeCount(input.deferredFlushDelayMs);
  return {
    shouldScheduleDeferredFlush: true,
    deferredFlushDelayMs: normalizedDelayMs > 0 ? normalizedDelayMs : 120,
  };
}

export function resolveChatReceiptSyncQueueScheduleDeferredFlushPlan(
  input: ChatReceiptSyncQueueScheduleDeferredFlushPlanInput
): ChatReceiptSyncQueueDeferredFlushPlan {
  return resolveChatReceiptSyncQueueDeferredFlushPlan({
    followupTriggerPlan: input.queueSchedulePlan?.followupTriggerPlan,
    deferredFlushDelayMs: input.deferredFlushDelayMs,
  });
}

export function applyChatReceiptSyncQueueApplyPlan(
  queuedReadMessageIds: Set<string>,
  queueApplyPlan: ChatReceiptSyncQueueApplyPlan,
  requestConversationDelivered: boolean
): ChatReceiptSyncQueuedState {
  const queuedReadSet =
    queuedReadMessageIds instanceof Set ? queuedReadMessageIds : new Set<string>();
  const addMessageIds = Array.isArray(queueApplyPlan?.addMessageIds)
    ? queueApplyPlan.addMessageIds
    : [];

  addMessageIds.forEach((messageId) => {
    const normalized = normalizeMessageId(messageId);
    if (!normalized) {
      return;
    }

    queuedReadSet.add(normalized);
  });

  return {
    queuedReadMessageIds: queuedReadSet,
    requestConversationDelivered:
      queueApplyPlan?.nextRequestConversationDelivered === true ||
      requestConversationDelivered === true,
  };
}

export function applyChatReceiptSyncQueueScheduleExecutionPlan(
  input: ChatReceiptSyncQueueScheduleExecutionPlanInput
): ChatReceiptSyncQueueScheduleExecutionPlan {
  const nextQueuedState = applyChatReceiptSyncQueueApplyPlan(
    input.queuedReadMessageIds,
    input.queueSchedulePlan?.queueApplyPlan,
    input.requestConversationDelivered
  );

  return {
    nextQueuedState,
    deferredFlushPlan: resolveChatReceiptSyncQueueScheduleDeferredFlushPlan({
      queueSchedulePlan: input.queueSchedulePlan,
      deferredFlushDelayMs: input.deferredFlushDelayMs,
    }),
  };
}

export function resolveChatReceiptSyncQueueExecutionPlan(
  input: ChatReceiptSyncQueueExecutionPlanInput
): ChatReceiptSyncQueueExecutionPlan {
  const queuedReadMessageIds =
    input.queuedReadMessageIds instanceof Set
      ? input.queuedReadMessageIds
      : new Set<string>();
  const hasQueueGenerationGuardInput =
    input.queueGeneration !== undefined || input.activeGeneration !== undefined;

  if (
    hasQueueGenerationGuardInput &&
    !shouldApplyChatReceiptSyncQueueExecutionContinuation({
      queueGeneration: input.queueGeneration,
      activeGeneration: input.activeGeneration,
    })
  ) {
    return {
      shouldApplyQueueExecutionPlan: false,
      nextQueuedState: {
        queuedReadMessageIds,
        requestConversationDelivered: input.requestConversationDelivered === true,
      },
      deferredFlushPlan: {
        shouldScheduleDeferredFlush: false,
        deferredFlushDelayMs: 0,
      },
    };
  }

  const queueSchedulePlan = resolveChatReceiptSyncQueueSchedulePlan(input);
  const queueScheduleExecutionPlan = applyChatReceiptSyncQueueScheduleExecutionPlan({
    queuedReadMessageIds,
    requestConversationDelivered: input.requestConversationDelivered,
    queueSchedulePlan,
    deferredFlushDelayMs: input.deferredFlushDelayMs,
  });

  return {
    shouldApplyQueueExecutionPlan: true,
    nextQueuedState: queueScheduleExecutionPlan.nextQueuedState,
    deferredFlushPlan: queueScheduleExecutionPlan.deferredFlushPlan,
  };
}

export function clearChatReceiptSyncQueuedState(
  queuedReadMessageIds: Set<string>
): ChatReceiptSyncQueuedState {
  const queuedReadSet =
    queuedReadMessageIds instanceof Set ? queuedReadMessageIds : new Set<string>();
  queuedReadSet.clear();

  return {
    queuedReadMessageIds: queuedReadSet,
    requestConversationDelivered: false,
  };
}

export function resolveChatReceiptDeliverySyncRequest(
  input: ChatReceiptDeliverySyncRequestInput
): ChatReceiptDeliverySyncRequestDecision {
  const partnerEmail = normalizeEmail(input.partnerEmail);
  const nowMs = resolveNowMs(input.nowMs);

  if (!partnerEmail) {
    return {
      requestConversationDelivered: false,
      partnerEmail,
      nowMs,
    };
  }

  const lastPartnerEmail = normalizeEmail(input.lastPartnerEmail);
  const lastAttemptAtMs = normalizeCount(input.lastAttemptAtMs);
  const cooldownMs = resolveCooldownMs(input.cooldownMs);

  return {
    requestConversationDelivered:
      lastPartnerEmail !== partnerEmail || nowMs - lastAttemptAtMs >= cooldownMs,
    partnerEmail,
    nowMs,
  };
}

export function resolveChatReceiptViewabilitySyncPlan(
  input: ChatReceiptViewabilitySyncPlanInput
): ChatReceiptViewabilitySyncPlan {
  const deliverySyncRequest = resolveChatReceiptDeliverySyncRequest({
    partnerEmail: input.partnerEmail,
    lastPartnerEmail: input.lastPartnerEmail,
    lastAttemptAtMs: input.lastAttemptAtMs,
    nowMs: input.nowMs,
    cooldownMs: input.cooldownMs,
  });
  const queueRequestPlan = resolveChatReceiptSyncQueueRequestPlan({
    readMessageIds: input.visibleUnreadIncomingIds || [],
    requestConversationDelivered: deliverySyncRequest.requestConversationDelivered,
  });

  return {
    queueRequestPlan,
    nextDeliverySyncMarker:
      deliverySyncRequest.requestConversationDelivered && deliverySyncRequest.partnerEmail
        ? resolveChatReceiptDeliverySyncMarkerUpdate(
            deliverySyncRequest.partnerEmail,
            deliverySyncRequest.nowMs
          )
        : null,
  };
}

export function resolveChatReceiptViewabilityQueueInvocationPlan(
  input: ChatReceiptViewabilitySyncPlanInput
): ChatReceiptViewabilityQueueInvocationPlan {
  const viewabilitySyncPlan = resolveChatReceiptViewabilitySyncPlan(input);

  return {
    nextDeliverySyncMarker: viewabilitySyncPlan.nextDeliverySyncMarker,
    queueInvocationPlan: resolveChatReceiptSyncQueueInvocationPlan(
      viewabilitySyncPlan.queueRequestPlan
    ),
  };
}

export function resolveChatReceiptViewabilityQueueExecutionPlan(
  input: ChatReceiptViewabilityQueueExecutionPlanInput
): ChatReceiptViewabilityQueueExecutionPlan {
  const queueInvocationPlan = resolveChatReceiptViewabilityQueueInvocationPlan(input);
  const queueInvocationExecutionPlan = resolveChatReceiptQueueInvocationExecutionPlan({
    queueInvocationPlan: queueInvocationPlan.queueInvocationPlan,
    queueGeneration: input.queueGeneration,
    activeGeneration: input.activeGeneration,
  });

  if (!queueInvocationExecutionPlan.shouldApplyQueueInvocationExecutionPlan) {
    return {
      shouldApplyViewabilityQueueExecutionPlan: false,
      nextDeliverySyncMarker: null,
      queueInvocationPlan: {
        shouldQueueSync: queueInvocationExecutionPlan.shouldQueueSync,
        queueOptions: queueInvocationExecutionPlan.queueOptions,
      },
    };
  }

  return {
    shouldApplyViewabilityQueueExecutionPlan: true,
    nextDeliverySyncMarker: queueInvocationPlan.nextDeliverySyncMarker,
    queueInvocationPlan: {
      shouldQueueSync: queueInvocationExecutionPlan.shouldQueueSync,
      queueOptions: queueInvocationExecutionPlan.queueOptions,
    },
  };
}

export function resolveChatReceiptViewabilityQueueDispatchPlan(
  input: ChatReceiptViewabilityQueueDispatchPlanInput
): ChatReceiptViewabilityQueueDispatchPlan {
  const viewabilityQueueExecutionPlan =
    resolveChatReceiptViewabilityQueueExecutionPlan(input);

  return {
    shouldApplyViewabilityQueueDispatchPlan:
      viewabilityQueueExecutionPlan.shouldApplyViewabilityQueueExecutionPlan,
    nextDeliverySyncMarker: viewabilityQueueExecutionPlan.nextDeliverySyncMarker,
    shouldQueueSync: viewabilityQueueExecutionPlan.queueInvocationPlan.shouldQueueSync,
    queueOptions: viewabilityQueueExecutionPlan.queueInvocationPlan.queueOptions,
  };
}

export function resolveChatReceiptViewabilityQueueDispatchPlanForMarker(
  input: ChatReceiptViewabilityQueueDispatchPlanForMarkerInput
): ChatReceiptViewabilityQueueDispatchPlan {
  const lastPartnerEmail = normalizeEmail(input.lastDeliverySyncMarker?.partnerEmail);
  const lastAttemptAtMs = normalizeCount(input.lastDeliverySyncMarker?.at);

  return resolveChatReceiptViewabilityQueueDispatchPlan({
    partnerEmail: input.partnerEmail,
    lastPartnerEmail,
    lastAttemptAtMs,
    visibleUnreadIncomingIds: input.visibleUnreadIncomingIds,
    nowMs: input.nowMs,
    cooldownMs: input.cooldownMs,
    queueGeneration: input.queueGeneration,
    activeGeneration: input.activeGeneration,
  });
}

export function resolveChatReceiptDeliverySyncMarkerReset(
  partnerEmail: unknown
): ChatReceiptDeliverySyncMarker {
  return {
    partnerEmail: normalizeEmail(partnerEmail),
    at: 0,
  };
}

export function resolveChatReceiptDeliverySyncMarkerUpdate(
  partnerEmail: unknown,
  nowMs?: unknown
): ChatReceiptDeliverySyncMarker {
  const normalizedPartnerEmail = normalizeEmail(partnerEmail);
  if (!normalizedPartnerEmail) {
    return {
      partnerEmail: null,
      at: 0,
    };
  }

  return {
    partnerEmail: normalizedPartnerEmail,
    at: resolveNowMs(nowMs),
  };
}

export function resolveChatReceiptSyncConversationResetPlan(
  partnerEmail: unknown
): ChatReceiptSyncConversationResetPlan {
  return {
    requestConversationDelivered: false,
    deliverySyncMarker: resolveChatReceiptDeliverySyncMarkerReset(partnerEmail),
  };
}
