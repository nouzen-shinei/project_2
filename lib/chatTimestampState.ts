export function resolveChatTimestampMs(value: unknown): number {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : 0;
  }

  if (value && typeof (value as { toDate?: () => unknown }).toDate === 'function') {
    try {
      const parsed = (value as { toDate: () => unknown }).toDate();
      return resolveChatTimestampMs(parsed);
    } catch {
      return 0;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}
