export interface ChatSpecialComposerState {
  showSpecialCommand: boolean;
  isComposingSpecial: boolean;
}

const DEFAULT_CHAT_SPECIAL_COMPOSER_STATE: ChatSpecialComposerState = {
  showSpecialCommand: false,
  isComposingSpecial: false,
};

export function resolveChatSpecialComposerState(
  value: string | null | undefined
): ChatSpecialComposerState {
  if (typeof value !== 'string') {
    return DEFAULT_CHAT_SPECIAL_COMPOSER_STATE;
  }

  if (!value.startsWith('/special')) {
    return DEFAULT_CHAT_SPECIAL_COMPOSER_STATE;
  }

  if (value === '/special') {
    return {
      showSpecialCommand: true,
      isComposingSpecial: false,
    };
  }

  if (value.startsWith('/special ')) {
    return {
      showSpecialCommand: false,
      isComposingSpecial: true,
    };
  }

  return DEFAULT_CHAT_SPECIAL_COMPOSER_STATE;
}
