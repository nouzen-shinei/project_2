/**
 * Pending message server-ID matching logic
 * 
 * Deterministically matches pending text messages to their likely server counterpart
 * using sender, recipient, text content, and timestamp proximity.
 * 
 * No external helper imports to avoid module-resolution issues with ts-node.
 */

// PendingMessage type - extended signature from services/chatService
// We use a minimal local type to avoid import issues
export interface PendingMessageLike {
  text?: string;
  sender?: string;
  recipientId?: string;
  timestamp?: unknown;
  status?: string;
  serverMessageId?: string;
  deleted?: boolean;
  replyTo?: unknown;
}

export interface PendingMessageServerIdMatcherInput {
  pendingMsg?: PendingMessageLike;
  pendingStatus?: string;
  pendingTimestampMs?: number;
  normalizedPendingText?: string;
  normalizedSender?: string;
  normalizedRecipient?: string;
  candidates?: { id: string; timestampMs: number }[];
  maxTimestampDeltaMs?: number;
}

/**
 * Finds the best-matching server message ID for a pending text message.
 * 
 * Matches are determined by:
 * 1. Pending status must be 'sending' or 'sent'
 * 2. Text must be non-empty
 * 3. Sender and recipient must be normalized
 * 4. Candidate timestamp must be within maxTimestampDeltaMs (default 12000ms)
 * 5. If multiple candidates exist, choose the one with smallest timestamp delta
 * 
 * Returns empty string if no match found or preconditions not met.
 */
export function resolveChatPendingServerMessageIdFromCandidates(
  input?: PendingMessageServerIdMatcherInput
): string {
  if (!input) {
    return '';
  }

  const {
    pendingStatus,
    normalizedPendingText,
    normalizedSender,
    normalizedRecipient,
    pendingTimestampMs,
    candidates,
    maxTimestampDeltaMs = 12000,
  } = input;

  // Precondition: status must allow server matching
  if (pendingStatus !== 'sending' && pendingStatus !== 'sent') {
    return '';
  }

  // Precondition: text must exist
  if (!normalizedPendingText) {
    return '';
  }

  // Precondition: sender and recipient must be present
  if (!normalizedSender || !normalizedRecipient) {
    return '';
  }

  // Precondition: candidates must exist
  if (!candidates || candidates.length === 0) {
    return '';
  }

  let bestMatchId = '';
  let bestMatchDelta = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const candidateTimestamp = candidate.timestampMs;

    // If both timestamps are finite, calculate delta and apply threshold
    if (
      pendingTimestampMs != null &&
      Number.isFinite(pendingTimestampMs) &&
      Number.isFinite(candidateTimestamp)
    ) {
      const delta = Math.abs(candidateTimestamp - pendingTimestampMs);

      // Skip candidates outside the allowed time window
      if (delta > maxTimestampDeltaMs) {
        continue;
      }

      // Update best match if this candidate is closer
      if (delta < bestMatchDelta) {
        bestMatchDelta = delta;
        bestMatchId = candidate.id;
      }
      continue;
    }

    // If one or both timestamps are not finite, accept first match as fallback
    if (!bestMatchId) {
      bestMatchId = candidate.id;
    }
  }

  return bestMatchId;
}

/**
 * Builds a lookup map of pending text message candidates grouped by a match key.
 * 
 * Each displayed message (if not deleted) is indexed by:
 * `${normalizedSender}|${normalizedRecipient}|${normalizedText}`
 * 
 * This allows fast candidate lookup during server-ID matching.
 * 
 * Input type flexible to handle various message shapes; normalizes key fields.
 */
export function resolveChatPendingMessageCandidatesByKey(input: {
  displayedMessages?: readonly unknown[] | null;
  normalizeMessageId?: (id: unknown) => string;
  normalizeParticipantEmail?: (email: unknown) => string;
  normalizeMessageValue?: (text: string | null | undefined) => string;
}): Map<string, { id: string; timestampMs: number }[]> {
  const candidatesByKey = new Map<string, { id: string; timestampMs: number }[]>();

  if (!input || !input.displayedMessages || input.displayedMessages.length === 0) {
    return candidatesByKey;
  }

  const {
    displayedMessages,
    normalizeMessageId,
    normalizeParticipantEmail,
    normalizeMessageValue,
  } = input;

  for (const msg of displayedMessages) {
    if (!msg || (msg as any).deleted) {
      continue;
    }

    const candidateId = normalizeMessageId?.((msg as any)?.id) || '';
    if (!candidateId) {
      continue;
    }

    const candidateSender = normalizeParticipantEmail?.((msg as any)?.sender) || '';
    const candidateRecipient = normalizeParticipantEmail?.((msg as any)?.recipientId) || '';
    const candidateText = normalizeMessageValue?.(String((msg as any)?.text || '')) || '';

    if (!candidateSender || !candidateRecipient || !candidateText) {
      continue;
    }

    const matchKey = `${candidateSender}|${candidateRecipient}|${candidateText}`;
    const entry = {
      id: candidateId,
      timestampMs: resolveTimestampMs((msg as any)?.timestamp),
    };

    const bucket = candidatesByKey.get(matchKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      candidatesByKey.set(matchKey, [entry]);
    }
  }

  return candidatesByKey;
}

/**
 * Helper: Normalizes a timestamp value to milliseconds.
 * 
 * Handles:
 * - number: returned as-is (assumed ms)
 * - Date: converted to getTime()
 * - object with toMillis(): calls toMillis()
 * - Everything else: returns NaN (treated as non-finite)
 */
export function resolveTimestampMs(timestamp: unknown): number {
  if (typeof timestamp === 'number') {
    return timestamp;
  }
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }
  if (timestamp && typeof timestamp === 'object' && 'toMillis' in timestamp) {
    const toMillis = (timestamp as any).toMillis;
    if (typeof toMillis === 'function') {
      return toMillis();
    }
  }
  return NaN;
}

/**
 * Builds a match key for a pending message.
 * 
 * Key format: `${sender}|${recipient}|${text}`
 * Used to look up candidates in the candidatesByKey map.
 */
export function buildChatPendingTextMatchKey(
  sender: string,
  recipient: string,
  text: string
): string {
  return `${sender}|${recipient}|${text}`;
}
