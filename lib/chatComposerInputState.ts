export function resolveChatComposerWordCount(value?: string | null): number {
  if (typeof value !== 'string') {
    return 0;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 0;
  }

  return normalized.split(' ').length;
}

export function resolveChatComposerMessageWithinLimits(params: {
  value?: string | null;
  maxChars: number;
  maxWords: number;
}): string {
  const { value, maxChars, maxWords } = params;

  let nextValue = typeof value === 'string' ? value : '';

  if (nextValue.length > maxChars) {
    nextValue = nextValue.slice(0, maxChars);
  }

  if (!nextValue.trim()) {
    return nextValue;
  }

  const compact = nextValue.replace(/\s+/g, ' ').trim();
  const words = compact.split(' ');
  if (words.length > maxWords) {
    return words.slice(0, maxWords).join(' ');
  }

  return nextValue;
}
