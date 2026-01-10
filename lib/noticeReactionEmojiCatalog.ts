export type NoticeReactionEmojiCategory =
  | 'Smileys'
  | 'Celebration'
  | 'Work'
  | 'Info'
  | 'Support'
  | 'Other';

export type NoticeReactionEmojiItem = {
  emoji: string;
  keywords: string[];
  category: NoticeReactionEmojiCategory;
};

export const DEFAULT_NOTICE_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏'] as const;

export const NOTICE_REACTION_EMOJIS: NoticeReactionEmojiItem[] = [
  // Smileys
  { emoji: '😄', keywords: ['smile', 'happy'], category: 'Smileys' },
  { emoji: '🙂', keywords: ['smile', 'ok'], category: 'Smileys' },
  { emoji: '😎', keywords: ['cool'], category: 'Smileys' },
  { emoji: '🤔', keywords: ['think'], category: 'Smileys' },
  { emoji: '😮', keywords: ['wow', 'surprised'], category: 'Smileys' },
  { emoji: '😢', keywords: ['sad', 'cry'], category: 'Smileys' },
  { emoji: '😂', keywords: ['lol', 'funny', 'laugh'], category: 'Smileys' },
  { emoji: '🤣', keywords: ['rofl', 'laugh'], category: 'Smileys' },

  // Celebration
  { emoji: '🎉', keywords: ['party', 'celebrate'], category: 'Celebration' },
  { emoji: '🥳', keywords: ['party', 'celebrate'], category: 'Celebration' },
  { emoji: '👏', keywords: ['clap', 'well done'], category: 'Celebration' },
  { emoji: '✨', keywords: ['sparkle', 'nice'], category: 'Celebration' },
  { emoji: '⭐️', keywords: ['star', 'favorite'], category: 'Celebration' },
  { emoji: '🌟', keywords: ['star', 'great'], category: 'Celebration' },
  { emoji: '💯', keywords: ['100', 'perfect'], category: 'Celebration' },

  // Work
  { emoji: '✅', keywords: ['done', 'ok', 'check'], category: 'Work' },
  { emoji: '📌', keywords: ['pin', 'important'], category: 'Work' },
  { emoji: '📝', keywords: ['note', 'write'], category: 'Work' },
  { emoji: '📎', keywords: ['attachment', 'file'], category: 'Work' },
  { emoji: '📅', keywords: ['calendar', 'schedule'], category: 'Work' },
  { emoji: '⏰', keywords: ['time', 'clock'], category: 'Work' },
  { emoji: '📍', keywords: ['location', 'pin'], category: 'Work' },

  // Info
  { emoji: '📣', keywords: ['announcement', 'loud'], category: 'Info' },
  { emoji: '🔔', keywords: ['bell', 'notify'], category: 'Info' },
  { emoji: '📷', keywords: ['photo', 'image'], category: 'Info' },
  { emoji: '🎵', keywords: ['music', 'audio'], category: 'Info' },
  { emoji: '🚀', keywords: ['go', 'launch'], category: 'Info' },
  { emoji: '🔥', keywords: ['fire', 'lit', 'hot'], category: 'Info' },

  // Support
  { emoji: '👍', keywords: ['like', 'yes', 'good', 'thumb'], category: 'Support' },
  { emoji: '👎', keywords: ['dislike', 'no', 'bad', 'thumb'], category: 'Support' },
  { emoji: '🙏', keywords: ['thanks', 'pray'], category: 'Support' },
  { emoji: '🙌', keywords: ['yay', 'hands'], category: 'Support' },
  { emoji: '🤝', keywords: ['deal', 'agree'], category: 'Support' },

  // Other
  { emoji: '❤️', keywords: ['love', 'heart'], category: 'Other' },
  { emoji: '🫶', keywords: ['love', 'heart'], category: 'Other' },
  { emoji: '💡', keywords: ['idea', 'lightbulb'], category: 'Other' },
  { emoji: '🧠', keywords: ['idea', 'smart'], category: 'Other' },
];

export const NOTICE_REACTION_CATEGORIES: NoticeReactionEmojiCategory[] = [
  'Smileys',
  'Celebration',
  'Work',
  'Info',
  'Support',
  'Other',
];
