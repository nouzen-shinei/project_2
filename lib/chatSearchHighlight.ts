export interface ChatTextHighlightSegment {
  text: string;
  highlighted: boolean;
}

function normalizeHighlightQuery(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildHighlightRegExp(query: string): RegExp | null {
  const normalizedQuery = normalizeHighlightQuery(query);
  if (!normalizedQuery) {
    return null;
  }

  // Keep matching tolerant for multi-space/newline text spans.
  const pattern = escapeRegExp(normalizedQuery).replace(/\s+/g, '\\s+');
  if (!pattern) {
    return null;
  }

  try {
    return new RegExp(pattern, 'gi');
  } catch {
    return null;
  }
}

export function splitChatTextForHighlight(
  text: unknown,
  query: unknown
): ChatTextHighlightSegment[] {
  const sourceText = typeof text === 'string' ? text : '';
  if (!sourceText) {
    return [];
  }

  const matcher = buildHighlightRegExp(typeof query === 'string' ? query : '');
  if (!matcher) {
    return [{ text: sourceText, highlighted: false }];
  }

  const segments: ChatTextHighlightSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(sourceText)) !== null) {
    const matchedText = typeof match[0] === 'string' ? match[0] : '';
    if (!matchedText) {
      break;
    }

    const start = match.index;
    const end = start + matchedText.length;

    if (start > cursor) {
      segments.push({
        text: sourceText.slice(cursor, start),
        highlighted: false,
      });
    }

    segments.push({
      text: sourceText.slice(start, end),
      highlighted: true,
    });

    cursor = end;
  }

  if (cursor < sourceText.length) {
    segments.push({
      text: sourceText.slice(cursor),
      highlighted: false,
    });
  }

  if (segments.length === 0) {
    return [{ text: sourceText, highlighted: false }];
  }

  return segments;
}
