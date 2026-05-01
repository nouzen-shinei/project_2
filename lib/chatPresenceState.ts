export function resolveChatPresenceTimestamp(value: unknown): Date | null {
  try {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const maybeObj = value as {
      seconds?: number;
      nanoseconds?: number;
      toDate?: () => Date;
    };

    if (typeof maybeObj.toDate === 'function') {
      const parsed = maybeObj.toDate();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof maybeObj.seconds === 'number') {
      const parsed = new Date(
        maybeObj.seconds * 1000 + Math.floor(((maybeObj.nanoseconds || 0) as number) / 1e6)
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
  } catch {
    return null;
  }
}

export function resolveChatRealtimeOnline(params: {
  isOnline: boolean | undefined;
  lastSeen: unknown;
  presenceMode: string;
  presenceThresholdMin: number;
  nowMs?: number;
}): boolean {
  const {
    isOnline,
    lastSeen,
    presenceMode,
    presenceThresholdMin,
    nowMs = Date.now(),
  } = params;

  if (String(presenceMode || '').toLowerCase() === 'flag') {
    return isOnline === true;
  }

  const parsedLastSeen = resolveChatPresenceTimestamp(lastSeen);
  if (parsedLastSeen) {
    const diffMinutes = (nowMs - parsedLastSeen.getTime()) / (1000 * 60);
    return diffMinutes <= presenceThresholdMin;
  }

  return isOnline ?? false;
}
