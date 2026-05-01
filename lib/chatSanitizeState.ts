export function resolveChatSanitizedMessageText(
  value: unknown,
  fallback: string
): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '.') {
    return fallback;
  }
  return raw;
}

export function resolveChatSanitizedAttachmentFileName(value: unknown): string {
  const safeFileName = String(value || 'File').trim();
  if (!safeFileName || safeFileName === '.') {
    return 'File';
  }
  return safeFileName;
}

export function resolveChatSanitizedDateSeparatorLabel(value: unknown): string {
  const safeDate = String(value ?? '').trim();
  if (!safeDate || safeDate === '.') {
    return 'Today';
  }
  return safeDate;
}

export function resolveChatSafeDisplayInitial(value: unknown): string {
  const safeName = String(value ?? '').trim();
  if (!safeName) {
    return 'U';
  }
  const firstChar = safeName.charAt(0).toUpperCase();
  if (/^[A-Z0-9]$/i.test(firstChar)) {
    return firstChar;
  }
  return 'U';
}
