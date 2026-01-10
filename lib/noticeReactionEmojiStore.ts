import AsyncStorage from '@react-native-async-storage/async-storage';

export type NoticeReactionEmojiStore = {
  recent: string[];
  custom: string[];
  updatedAt: string;
};

const STORAGE_KEY = 'notice_reaction_emojis_v1';
const MAX_RECENT = 24;
const MAX_CUSTOM = 24;

export const extractFirstEmoji = (emoji: string): string => {
  const raw = (emoji || '').trim();
  if (!raw) return '';

  try {
    const AnyIntl = Intl as unknown as { Segmenter?: any };
    if (AnyIntl?.Segmenter) {
      const segmenter = new AnyIntl.Segmenter(undefined, { granularity: 'grapheme' });
      const iterator = segmenter.segment(raw)[Symbol.iterator]();
      const first = iterator.next()?.value?.segment;
      return typeof first === 'string' ? first : '';
    }
  } catch {
    // ignore
  }

  // Fallback: first code point.
  return Array.from(raw)[0] || '';
};

const uniqFront = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const value = extractFirstEmoji(item);
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

export async function loadNoticeReactionEmojiStore(): Promise<NoticeReactionEmojiStore> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { recent: [], custom: [], updatedAt: new Date().toISOString() };
    }
    const parsed = JSON.parse(raw) as Partial<NoticeReactionEmojiStore>;
    const recent = Array.isArray(parsed.recent) ? parsed.recent : [];
    const custom = Array.isArray(parsed.custom) ? parsed.custom : [];
    return {
      recent: uniqFront(recent).slice(0, MAX_RECENT),
      custom: uniqFront(custom).slice(0, MAX_CUSTOM),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { recent: [], custom: [], updatedAt: new Date().toISOString() };
  }
}

export async function recordNoticeReactionEmoji(emoji: string, opts?: { isCustom?: boolean }): Promise<NoticeReactionEmojiStore> {
  const normalized = extractFirstEmoji(emoji);
  if (!normalized) {
    return await loadNoticeReactionEmojiStore();
  }

  const current = await loadNoticeReactionEmojiStore();

  const recent = uniqFront([normalized, ...current.recent]).slice(0, MAX_RECENT);
  const custom = opts?.isCustom
    ? uniqFront([normalized, ...current.custom]).slice(0, MAX_CUSTOM)
    : current.custom;

  const next: NoticeReactionEmojiStore = {
    recent,
    custom,
    updatedAt: new Date().toISOString(),
  };

  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }

  return next;
}

export async function removeCustomNoticeReactionEmoji(emoji: string): Promise<NoticeReactionEmojiStore> {
  const normalized = extractFirstEmoji(emoji);
  const current = await loadNoticeReactionEmojiStore();
  if (!normalized) return current;

  const next: NoticeReactionEmojiStore = {
    ...current,
    custom: current.custom.filter((e) => e !== normalized),
    updatedAt: new Date().toISOString(),
  };

  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }

  return next;
}
