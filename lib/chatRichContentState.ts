const COMPLEX_EMOJI_PATTERN = /[\u{1F600}-\u{1F64F}][\u{FE0F}]?[\u{1F3FB}-\u{1F3FF}]?|[\u{1F300}-\u{1F5FF}][\u{FE0F}]?|[\u{1F680}-\u{1F6FF}][\u{FE0F}]?|[\u{1F700}-\u{1F77F}]|[\u{1F780}-\u{1F7FF}]|[\u{1F800}-\u{1F8FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{2600}-\u{26FF}][\u{FE0F}]?|[\u{2700}-\u{27BF}][\u{FE0F}]?/gu;
const COMPOUND_EMOJI_PATTERN = /[\u{1F3F4}][\u{E0067}][\u{E0062}][\u{E0065}][\u{E006E}][\u{E0067}][\u{E007F}]|[\u{1F468}][\u{200D}][\u{1F469}][\u{200D}][\u{1F467}][\u{200D}][\u{1F466}]|[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]/gu;
const SKIN_TONE_PATTERN = /[\u{1F3FB}-\u{1F3FF}]/gu;

export function resolveChatDetectedRichContent(text: string): {
  hasRichEmojis: boolean;
  emojiCount: number;
  isEmojiOnly: boolean;
  emojis: string[];
} {
  const emojiMatches = text.match(COMPLEX_EMOJI_PATTERN) || [];
  const compoundMatches = text.match(COMPOUND_EMOJI_PATTERN) || [];
  const skinToneMatches = text.match(SKIN_TONE_PATTERN) || [];

  return {
    hasRichEmojis:
      emojiMatches.length > 0 ||
      compoundMatches.length > 0 ||
      skinToneMatches.length > 0,
    emojiCount: emojiMatches.length + compoundMatches.length,
    isEmojiOnly:
      text
        .trim()
        .replace(COMPLEX_EMOJI_PATTERN, '')
        .replace(COMPOUND_EMOJI_PATTERN, '')
        .trim() === '',
    emojis: [...emojiMatches, ...compoundMatches],
  };
}

export function resolveChatRichTextInputResult(inputText: string):
  | {
      type: 'sticker';
      content: {
        url: string;
        name: string;
        pack: 'system';
        width: number;
        height: number;
        isEmoji: true;
        original: string;
      };
      originalText: string;
    }
  | {
      type: 'text';
      content: string;
      originalText: string;
    } {
  const richContent = resolveChatDetectedRichContent(inputText);

  const remainder = inputText
    .trim()
    .replace(COMPLEX_EMOJI_PATTERN, '')
    .replace(COMPOUND_EMOJI_PATTERN, '')
    .replace(/[\u200D\uFE0F\s]/g, '')
    .trim();

  const isEmojiMostly =
    richContent.emojiCount >= 1 &&
    richContent.emojiCount <= 5 &&
    (remainder.length === 0 ||
      (remainder.length === 1 && /[A-Za-z]/.test(remainder)));

  if (isEmojiMostly) {
    return {
      type: 'sticker',
      content: {
        url: '',
        name: richContent.emojis.join(''),
        pack: 'system',
        width: 100,
        height: 100,
        isEmoji: true,
        original: inputText.trim(),
      },
      originalText: inputText,
    };
  }

  return {
    type: 'text',
    content: inputText,
    originalText: inputText,
  };
}
