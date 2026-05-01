export interface ChatViewabilityReceiptCollectionInput {
  viewableEntries?: Iterable<unknown>;
  normalizedPartnerEmail: string | null;
  normalizedUserEmail: string | null;
  maxWarmTargets?: unknown;
}

export interface ChatViewabilityDeliverySyncMarker {
  partnerEmail: string | null;
  at: number;
}

export interface ChatViewabilityQueueDispatchPlan {
  shouldApplyViewabilityQueueDispatchPlan: boolean;
  nextDeliverySyncMarker: ChatViewabilityDeliverySyncMarker | null;
  shouldQueueSync: boolean;
  queueOptions: {
    readMessageIds: string[];
    requestConversationDelivered: boolean;
  };
}

export type ChatViewabilityQueueDispatchResolverFallbackReason =
  | 'missing'
  | 'invalid';

export interface ChatViewabilityQueueDispatchResolverFallbackMetricState {
  reason: ChatViewabilityQueueDispatchResolverFallbackReason | null;
  at: number;
}

export interface ChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlanInput {
  reason: ChatViewabilityQueueDispatchResolverFallbackReason;
  lastMetricState?: ChatViewabilityQueueDispatchResolverFallbackMetricState | null;
  nowMs?: unknown;
  cooldownMs?: unknown;
}

export interface ChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlan {
  shouldEmitMetric: boolean;
  nextMetricState: ChatViewabilityQueueDispatchResolverFallbackMetricState;
}

export interface ChatViewabilityQueueDispatchResolverFallbackMetricPayloadInput {
  reason: ChatViewabilityQueueDispatchResolverFallbackReason;
  hasPartnerEmail?: unknown;
  hasUserEmail?: unknown;
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatViewabilityQueueDispatchResolverFallbackMetricPayload {
  reason: ChatViewabilityQueueDispatchResolverFallbackReason;
  hasPartnerEmail: boolean;
  hasUserEmail: boolean;
  queueGeneration: number | null;
  activeGeneration: number | null;
  generationDelta: number | null;
}

export interface ChatViewabilityQueueDispatchResolverFallbackMetricEmissionPlanInput {
  reason: ChatViewabilityQueueDispatchResolverFallbackReason;
  lastMetricState?: ChatViewabilityQueueDispatchResolverFallbackMetricState | null;
  nowMs?: unknown;
  cooldownMs?: unknown;
  hasPartnerEmail?: unknown;
  hasUserEmail?: unknown;
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatViewabilityQueueDispatchResolverFallbackMetricEmissionPlan {
  shouldEmitMetric: boolean;
  nextMetricState: ChatViewabilityQueueDispatchResolverFallbackMetricState;
  metricPayload: ChatViewabilityQueueDispatchResolverFallbackMetricPayload;
}

export interface ChatViewabilityQueueDispatchResolverInput {
  partnerEmail: string | null;
  lastDeliverySyncMarker: ChatViewabilityDeliverySyncMarker;
  visibleUnreadIncomingIds: string[];
  nowMs?: unknown;
  cooldownMs?: unknown;
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export type ChatViewabilityQueueDispatchResolver = (
  input: ChatViewabilityQueueDispatchResolverInput
) => ChatViewabilityQueueDispatchPlan;

export interface ChatViewabilityReceiptQueueDispatchPlanInput
  extends ChatViewabilityReceiptCollectionInput {
  lastDeliverySyncMarker: ChatViewabilityDeliverySyncMarker;
  resolveQueueDispatchPlan?: ChatViewabilityQueueDispatchResolver;
  onQueueDispatchResolverFallback?: (
    reason: ChatViewabilityQueueDispatchResolverFallbackReason
  ) => void;
  nowMs?: unknown;
  cooldownMs?: unknown;
  queueGeneration?: unknown;
  activeGeneration?: unknown;
}

export interface ChatViewabilityWarmTarget {
  remoteUrl: string;
  fileName?: string;
}

export interface ChatViewabilityReceiptCollection {
  warmTargets: ChatViewabilityWarmTarget[];
  visibleUnreadIncomingIds: string[];
}

export interface ChatViewabilityReceiptQueueDispatchPlan {
  warmTargets: ChatViewabilityWarmTarget[];
  visibleUnreadIncomingIds: string[];
  queueDispatchPlan: ChatViewabilityQueueDispatchPlan;
}

export interface ChatViewabilityWarmTargetPrefetchPlan {
  shouldPrefetchWarmTargets: boolean;
  warmTargets: ChatViewabilityWarmTarget[];
}

export interface ChatViewabilityWarmTargetPrefetchPlanInput {
  warmTargets?: Iterable<unknown>;
}

export interface ChatViewabilityWarmTargetPrefetchApplyInput
  extends ChatViewabilityWarmTargetPrefetchPlanInput {
  prefetchWarmTarget?: (warmTarget: ChatViewabilityWarmTarget) => Promise<unknown>;
}

export interface ChatViewabilityQueueDispatchEffectsPlan {
  shouldApplyQueueDispatchEffectsPlan: boolean;
  shouldUpdateDeliverySyncMarker: boolean;
  nextDeliverySyncMarker: ChatViewabilityDeliverySyncMarker | null;
  shouldQueueSync: boolean;
  queueOptions: {
    readMessageIds: string[];
    requestConversationDelivered: boolean;
  };
}

function normalizeMaxWarmTargets(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 5;
  }

  const normalized = Math.trunc(numeric);
  return normalized > 0 ? normalized : 0;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const normalized = Math.trunc(numeric);
  return normalized >= 0 ? normalized : fallback;
}

function normalizeNowMs(value: unknown): number {
  const normalizedNowMs = normalizePositiveInteger(value, 0);
  if (normalizedNowMs > 0) {
    return normalizedNowMs;
  }

  return Date.now();
}

function normalizeGeneration(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.trunc(numeric);
}

function normalizeParticipantEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeMessageId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeWarmTarget(
  value: unknown
): ChatViewabilityWarmTarget | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as { remoteUrl?: unknown; fileName?: unknown };
  const remoteUrl = typeof raw.remoteUrl === 'string' ? raw.remoteUrl.trim() : '';
  if (!remoteUrl || remoteUrl.startsWith('file://')) {
    return null;
  }

  const normalizedFileName =
    typeof raw.fileName === 'string' ? raw.fileName.trim() : '';

  if (normalizedFileName) {
    return {
      remoteUrl,
      fileName: normalizedFileName,
    };
  }

  return {
    remoteUrl,
  };
}

function createNoopQueueDispatchPlan(): ChatViewabilityQueueDispatchPlan {
  return {
    shouldApplyViewabilityQueueDispatchPlan: false,
    nextDeliverySyncMarker: null,
    shouldQueueSync: false,
    queueOptions: {
      readMessageIds: [],
      requestConversationDelivered: false,
    },
  };
}

function resolveQueueOptions(
  queueDispatchPlan: ChatViewabilityQueueDispatchPlan | null | undefined
): {
  readMessageIds: string[];
  requestConversationDelivered: boolean;
} {
  const deduped = new Set<string>();
  const readMessageIds: string[] = [];
  const rawReadMessageIds = Array.isArray(queueDispatchPlan?.queueOptions?.readMessageIds)
    ? queueDispatchPlan?.queueOptions?.readMessageIds
    : [];

  for (const messageId of rawReadMessageIds) {
    const normalized = normalizeMessageId(messageId);
    if (!normalized || deduped.has(normalized)) {
      continue;
    }

    deduped.add(normalized);
    readMessageIds.push(normalized);
  }

  return {
    readMessageIds,
    requestConversationDelivered:
      queueDispatchPlan?.queueOptions?.requestConversationDelivered === true,
  };
}

export function resolveChatViewabilityQueueDispatchEffectsPlan(
  queueDispatchPlan: ChatViewabilityQueueDispatchPlan | null | undefined
): ChatViewabilityQueueDispatchEffectsPlan {
  const shouldApplyQueueDispatchEffectsPlan =
    queueDispatchPlan?.shouldApplyViewabilityQueueDispatchPlan === true;
  const queueOptions = resolveQueueOptions(queueDispatchPlan);
  const hasQueueWork =
    queueOptions.readMessageIds.length > 0 ||
    queueOptions.requestConversationDelivered;

  if (!shouldApplyQueueDispatchEffectsPlan) {
    return {
      shouldApplyQueueDispatchEffectsPlan: false,
      shouldUpdateDeliverySyncMarker: false,
      nextDeliverySyncMarker: null,
      shouldQueueSync: false,
      queueOptions,
    };
  }

  return {
    shouldApplyQueueDispatchEffectsPlan: true,
    shouldUpdateDeliverySyncMarker:
      queueDispatchPlan?.nextDeliverySyncMarker !== null &&
      queueDispatchPlan?.nextDeliverySyncMarker !== undefined,
    nextDeliverySyncMarker: queueDispatchPlan?.nextDeliverySyncMarker || null,
    shouldQueueSync: queueDispatchPlan?.shouldQueueSync === true && hasQueueWork,
    queueOptions,
  };
}

export function resolveChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlan(
  input: ChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlanInput
): ChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlan {
  const nowMs = normalizeNowMs(input.nowMs);
  const cooldownMs = normalizePositiveInteger(input.cooldownMs, 15000);
  const lastMetricState = input.lastMetricState || {
    reason: null,
    at: 0,
  };
  const shouldEmitMetric = !(
    lastMetricState.reason === input.reason &&
    nowMs - lastMetricState.at < cooldownMs
  );

  return {
    shouldEmitMetric,
    nextMetricState: shouldEmitMetric
      ? {
          reason: input.reason,
          at: nowMs,
        }
      : {
          reason: lastMetricState.reason,
          at: lastMetricState.at,
        },
  };
}

export function resolveChatViewabilityQueueDispatchResolverFallbackMetricPayload(
  input: ChatViewabilityQueueDispatchResolverFallbackMetricPayloadInput
): ChatViewabilityQueueDispatchResolverFallbackMetricPayload {
  const queueGeneration = normalizeGeneration(input.queueGeneration);
  const activeGeneration = normalizeGeneration(input.activeGeneration);

  return {
    reason: input.reason,
    hasPartnerEmail: input.hasPartnerEmail === true,
    hasUserEmail: input.hasUserEmail === true,
    queueGeneration,
    activeGeneration,
    generationDelta:
      queueGeneration !== null && activeGeneration !== null
        ? activeGeneration - queueGeneration
        : null,
  };
}

export function resolveChatViewabilityQueueDispatchResolverFallbackMetricEmissionPlan(
  input: ChatViewabilityQueueDispatchResolverFallbackMetricEmissionPlanInput
): ChatViewabilityQueueDispatchResolverFallbackMetricEmissionPlan {
  const throttlePlan =
    resolveChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlan({
      reason: input.reason,
      lastMetricState: input.lastMetricState,
      nowMs: input.nowMs,
      cooldownMs: input.cooldownMs,
    });

  return {
    shouldEmitMetric: throttlePlan.shouldEmitMetric,
    nextMetricState: throttlePlan.nextMetricState,
    metricPayload:
      resolveChatViewabilityQueueDispatchResolverFallbackMetricPayload({
        reason: input.reason,
        hasPartnerEmail: input.hasPartnerEmail,
        hasUserEmail: input.hasUserEmail,
        queueGeneration: input.queueGeneration,
        activeGeneration: input.activeGeneration,
      }),
  };
}

export function resolveChatViewabilityWarmTargetPrefetchPlan(
  input: ChatViewabilityWarmTargetPrefetchPlanInput
): ChatViewabilityWarmTargetPrefetchPlan {
  const warmTargets: ChatViewabilityWarmTarget[] = [];
  const deduped = new Set<string>();

  for (const candidate of input.warmTargets || []) {
    const warmTarget = normalizeWarmTarget(candidate);
    if (!warmTarget) {
      continue;
    }

    const dedupeKey = `${warmTarget.remoteUrl}::${warmTarget.fileName || ''}`;
    if (deduped.has(dedupeKey)) {
      continue;
    }

    deduped.add(dedupeKey);
    warmTargets.push(warmTarget);
  }

  return {
    shouldPrefetchWarmTargets: warmTargets.length > 0,
    warmTargets,
  };
}

export function applyChatViewabilityWarmTargetPrefetch(
  input: ChatViewabilityWarmTargetPrefetchApplyInput
): ChatViewabilityWarmTargetPrefetchPlan {
  const warmTargetPrefetchPlan =
    resolveChatViewabilityWarmTargetPrefetchPlan(input);
  const prefetchWarmTarget = input.prefetchWarmTarget;

  if (
    !warmTargetPrefetchPlan.shouldPrefetchWarmTargets ||
    typeof prefetchWarmTarget !== 'function'
  ) {
    return warmTargetPrefetchPlan;
  }

  Promise.allSettled(
    warmTargetPrefetchPlan.warmTargets.map((warmTarget) =>
      prefetchWarmTarget(warmTarget).catch(() => undefined)
    )
  ).catch(() => undefined);

  return warmTargetPrefetchPlan;
}

function resolveIncomingUnreadMessageIdForNormalizedParticipants(
  message: unknown,
  normalizedPartnerEmail: string | null,
  normalizedUserEmail: string | null
): string | null {
  if (!normalizedPartnerEmail || !normalizedUserEmail) {
    return null;
  }

  if (!message || typeof message !== 'object') {
    return null;
  }

  const rawMessage = message as Record<string, unknown>;
  const messageId = normalizeMessageId(rawMessage.id);
  if (!messageId || rawMessage.deleted || rawMessage.read) {
    return null;
  }

  const senderEmail = normalizeParticipantEmail(rawMessage.sender);
  const recipientEmail = normalizeParticipantEmail(rawMessage.recipientId);
  if (!senderEmail || !recipientEmail) {
    return null;
  }

  return senderEmail === normalizedPartnerEmail && recipientEmail === normalizedUserEmail
    ? messageId
    : null;
}

export function resolveChatViewabilityReceiptCollection(
  input: ChatViewabilityReceiptCollectionInput
): ChatViewabilityReceiptCollection {
  const maxWarmTargets = normalizeMaxWarmTargets(input.maxWarmTargets);
  const warmTargets: ChatViewabilityWarmTarget[] = [];
  const warmTargetKeys = new Set<string>();
  const visibleUnreadIncomingIds: string[] = [];
  const visibleUnreadIncomingIdSet = new Set<string>();

  for (const entry of input.viewableEntries || []) {
    const message = (entry as { item?: unknown } | null | undefined)?.item;
    if (!message || typeof message !== 'object') {
      continue;
    }

    if (maxWarmTargets > 0 && warmTargets.length < maxWarmTargets) {
      const attachments = (message as { attachments?: unknown }).attachments;
      if (Array.isArray(attachments)) {
        for (const attachment of attachments) {
          if (warmTargets.length >= maxWarmTargets) {
            break;
          }

          const raw = attachment as { url?: unknown; fileName?: unknown } | null;
          const url = typeof raw?.url === 'string' ? raw.url : '';
          if (!url || url.startsWith('file://')) {
            continue;
          }

          const fileName = typeof raw?.fileName === 'string' ? raw.fileName : '';
          const targetKey = `${url}::${fileName}`;
          if (warmTargetKeys.has(targetKey)) {
            continue;
          }

          warmTargetKeys.add(targetKey);
          if (fileName) {
            warmTargets.push({
              remoteUrl: url,
              fileName,
            });
          } else {
            warmTargets.push({ remoteUrl: url });
          }
        }
      }
    }

    const unreadMessageId = resolveIncomingUnreadMessageIdForNormalizedParticipants(
      message,
      input.normalizedPartnerEmail,
      input.normalizedUserEmail
    );
    if (!unreadMessageId || visibleUnreadIncomingIdSet.has(unreadMessageId)) {
      continue;
    }

    visibleUnreadIncomingIdSet.add(unreadMessageId);
    visibleUnreadIncomingIds.push(unreadMessageId);
  }

  return {
    warmTargets,
    visibleUnreadIncomingIds,
  };
}

export function resolveChatViewabilityReceiptQueueDispatchPlan(
  input: ChatViewabilityReceiptQueueDispatchPlanInput
): ChatViewabilityReceiptQueueDispatchPlan {
  const receiptCollection = resolveChatViewabilityReceiptCollection(input);
  const hasQueueDispatchResolver = input.resolveQueueDispatchPlan !== undefined;
  const resolveQueueDispatchPlan =
    typeof input.resolveQueueDispatchPlan === 'function'
      ? input.resolveQueueDispatchPlan
      : () => createNoopQueueDispatchPlan();

  if (typeof input.resolveQueueDispatchPlan !== 'function') {
    if (hasQueueDispatchResolver) {
      input.onQueueDispatchResolverFallback?.('invalid');
    } else {
      input.onQueueDispatchResolverFallback?.('missing');
    }
  }

  return {
    warmTargets: receiptCollection.warmTargets,
    visibleUnreadIncomingIds: receiptCollection.visibleUnreadIncomingIds,
    queueDispatchPlan: resolveQueueDispatchPlan({
      partnerEmail: input.normalizedPartnerEmail,
      lastDeliverySyncMarker: input.lastDeliverySyncMarker,
      visibleUnreadIncomingIds: receiptCollection.visibleUnreadIncomingIds,
      nowMs: input.nowMs,
      cooldownMs: input.cooldownMs,
      queueGeneration: input.queueGeneration,
      activeGeneration: input.activeGeneration,
    }),
  };
}