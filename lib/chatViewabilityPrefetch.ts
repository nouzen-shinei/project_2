export interface ChatViewabilityPrefetchCandidateIndicesInput {
  viewableItems?: Iterable<unknown>;
  messageCount: unknown;
  behindDistance?: unknown;
  aheadDistance?: unknown;
}

export interface ChatViewabilityNearbyMediaPrefetchPlanInput {
  displayedMessages?: Iterable<unknown>;
  candidateIndices?: Iterable<unknown>;
  stickerUrlMap?: ReadonlyMap<string, string>;
  gifUrlMap?: ReadonlyMap<string, string>;
  isWeb?: boolean;
  shouldPrefetchAttachment?: (attachment: unknown) => boolean;
}

export interface ChatViewabilityNearbyMediaPrefetchPlan {
  immediatePrefetchUrls: string[];
  stickerResolveUrls: string[];
  gifResolveUrls: string[];
}

export interface ChatViewabilityDeferredResolveDispatchPlanInput {
  stickerResolveUrls?: Iterable<unknown>;
  gifResolveUrls?: Iterable<unknown>;
  dispatchStickerResolve?: (stickerUrl: string) => void;
  dispatchGifResolve?: (gifUrl: string) => void;
}

export interface ChatViewabilityDeferredResolveDispatchPlan {
  stickerResolveUrls: string[];
  gifResolveUrls: string[];
  shouldDispatchStickerResolve: boolean;
  shouldDispatchGifResolve: boolean;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const normalized = Math.trunc(numeric);
  return normalized >= 0 ? normalized : fallback;
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeResolveUrls(urls?: Iterable<unknown>): string[] {
  const deduped = new Set<string>();
  const normalizedUrls: string[] = [];

  for (const candidate of urls || []) {
    const normalized = normalizeUrl(candidate);
    if (!normalized || deduped.has(normalized)) {
      continue;
    }

    deduped.add(normalized);
    normalizedUrls.push(normalized);
  }

  return normalizedUrls;
}

export function resolveChatViewabilityPrefetchCandidateIndices(
  input: ChatViewabilityPrefetchCandidateIndicesInput
): number[] {
  const messageCount = normalizePositiveInteger(input.messageCount, 0);
  if (messageCount <= 0) {
    return [];
  }

  const viewableItems = input.viewableItems;
  if (!viewableItems) {
    return [];
  }

  const behindDistance = normalizePositiveInteger(input.behindDistance, 2);
  const aheadDistance = normalizePositiveInteger(input.aheadDistance, 4);

  const seen = new Set<number>();
  const candidates: number[] = [];

  for (const entry of viewableItems) {
    const rawEntry = entry as { index?: unknown } | null | undefined;
    const rawIndex = rawEntry?.index;
    if (typeof rawIndex !== 'number' || !Number.isFinite(rawIndex)) {
      continue;
    }

    const centerIndex = Math.trunc(rawIndex);
    if (centerIndex < 0 || centerIndex >= messageCount) {
      continue;
    }

    const startIndex = Math.max(0, centerIndex - behindDistance);
    const endIndex = Math.min(messageCount - 1, centerIndex + aheadDistance);
    for (let candidateIndex = startIndex; candidateIndex <= endIndex; candidateIndex += 1) {
      if (seen.has(candidateIndex)) {
        continue;
      }

      seen.add(candidateIndex);
      candidates.push(candidateIndex);
    }
  }

  return candidates;
}

export function resolveChatViewabilityNearbyMediaPrefetchPlan(
  input: ChatViewabilityNearbyMediaPrefetchPlanInput
): ChatViewabilityNearbyMediaPrefetchPlan {
  const displayedMessages = Array.isArray(input.displayedMessages)
    ? input.displayedMessages
    : [];
  const stickerUrlMap = input.stickerUrlMap;
  const gifUrlMap = input.gifUrlMap;
  const shouldPrefetchAttachment = input.shouldPrefetchAttachment;
  const isWeb = input.isWeb === true;

  const immediatePrefetchUrlSet = new Set<string>();
  const stickerResolveUrlSet = new Set<string>();
  const gifResolveUrlSet = new Set<string>();
  const immediatePrefetchUrls: string[] = [];
  const stickerResolveUrls: string[] = [];
  const gifResolveUrls: string[] = [];

  for (const rawCandidateIndex of input.candidateIndices || []) {
    if (typeof rawCandidateIndex !== 'number' || !Number.isFinite(rawCandidateIndex)) {
      continue;
    }

    const candidateIndex = Math.trunc(rawCandidateIndex);
    if (candidateIndex < 0 || candidateIndex >= displayedMessages.length) {
      continue;
    }

    const message = displayedMessages[candidateIndex] as
      | {
          sticker?: { url?: unknown } | null;
          gif?: { url?: unknown } | null;
          attachments?: Iterable<unknown>;
        }
      | undefined;
    if (!message || typeof message !== 'object') {
      continue;
    }

    const stickerOriginalUrl = normalizeUrl(message.sticker?.url);
    if (stickerOriginalUrl) {
      const stickerDisplayUrl =
        isWeb || !stickerUrlMap
          ? stickerOriginalUrl
          : normalizeUrl(stickerUrlMap.get(stickerOriginalUrl)) || stickerOriginalUrl;
      if (!immediatePrefetchUrlSet.has(stickerDisplayUrl)) {
        immediatePrefetchUrlSet.add(stickerDisplayUrl);
        immediatePrefetchUrls.push(stickerDisplayUrl);
      }

      if (!isWeb && !stickerResolveUrlSet.has(stickerOriginalUrl)) {
        stickerResolveUrlSet.add(stickerOriginalUrl);
        stickerResolveUrls.push(stickerOriginalUrl);
      }
    }

    const gifOriginalUrl = normalizeUrl(message.gif?.url);
    if (gifOriginalUrl) {
      const gifDisplayUrl =
        isWeb || !gifUrlMap
          ? gifOriginalUrl
          : normalizeUrl(gifUrlMap.get(gifOriginalUrl)) || gifOriginalUrl;
      if (!immediatePrefetchUrlSet.has(gifDisplayUrl)) {
        immediatePrefetchUrlSet.add(gifDisplayUrl);
        immediatePrefetchUrls.push(gifDisplayUrl);
      }

      if (!isWeb && !gifResolveUrlSet.has(gifOriginalUrl)) {
        gifResolveUrlSet.add(gifOriginalUrl);
        gifResolveUrls.push(gifOriginalUrl);
      }
    }

    if (!Array.isArray(message.attachments)) {
      continue;
    }

    for (const attachment of message.attachments) {
      if (
        typeof shouldPrefetchAttachment === 'function' &&
        !shouldPrefetchAttachment(attachment)
      ) {
        continue;
      }

      const attachmentUrl = normalizeUrl(
        (attachment as { url?: unknown } | null | undefined)?.url
      );
      if (!attachmentUrl || immediatePrefetchUrlSet.has(attachmentUrl)) {
        continue;
      }

      immediatePrefetchUrlSet.add(attachmentUrl);
      immediatePrefetchUrls.push(attachmentUrl);
    }
  }

  return {
    immediatePrefetchUrls,
    stickerResolveUrls,
    gifResolveUrls,
  };
}

export function resolveChatViewabilityDeferredResolveDispatchPlan(
  input: ChatViewabilityDeferredResolveDispatchPlanInput
): ChatViewabilityDeferredResolveDispatchPlan {
  const stickerResolveUrls = normalizeResolveUrls(input.stickerResolveUrls);
  const gifResolveUrls = normalizeResolveUrls(input.gifResolveUrls);

  return {
    stickerResolveUrls,
    gifResolveUrls,
    shouldDispatchStickerResolve:
      typeof input.dispatchStickerResolve === 'function' &&
      stickerResolveUrls.length > 0,
    shouldDispatchGifResolve:
      typeof input.dispatchGifResolve === 'function' && gifResolveUrls.length > 0,
  };
}

export function applyChatViewabilityDeferredResolveDispatchPlan(
  input: ChatViewabilityDeferredResolveDispatchPlanInput
): ChatViewabilityDeferredResolveDispatchPlan {
  const deferredResolveDispatchPlan =
    resolveChatViewabilityDeferredResolveDispatchPlan(input);
  const dispatchStickerResolve = input.dispatchStickerResolve;
  const dispatchGifResolve = input.dispatchGifResolve;

  if (
    deferredResolveDispatchPlan.shouldDispatchStickerResolve &&
    typeof dispatchStickerResolve === 'function'
  ) {
    deferredResolveDispatchPlan.stickerResolveUrls.forEach((stickerUrl) => {
      dispatchStickerResolve(stickerUrl);
    });
  }

  if (
    deferredResolveDispatchPlan.shouldDispatchGifResolve &&
    typeof dispatchGifResolve === 'function'
  ) {
    deferredResolveDispatchPlan.gifResolveUrls.forEach((gifUrl) => {
      dispatchGifResolve(gifUrl);
    });
  }

  return deferredResolveDispatchPlan;
}