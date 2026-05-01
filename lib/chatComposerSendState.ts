export interface ChatComposerSendState {
  trimmedMessage: string;
  hasSelectedRecipient: boolean;
  messageCharacterCount: number;
  messageWordCount: number;
  maxChars: number;
  maxWords: number;
  isEditingMessage: boolean;
  hasEditedMessageChanged: boolean;
}

export function isChatComposerMessageOverLimit(state: Pick<ChatComposerSendState, 'messageCharacterCount' | 'messageWordCount' | 'maxChars' | 'maxWords'>): boolean {
  return state.messageCharacterCount > state.maxChars || state.messageWordCount > state.maxWords;
}

export function canAttemptChatComposerSend(state: ChatComposerSendState): boolean {
  if (typeof state.trimmedMessage !== 'string' || state.trimmedMessage.trim().length === 0) {
    return false;
  }

  if (!state.hasSelectedRecipient) {
    return false;
  }

  if (isChatComposerMessageOverLimit(state)) {
    return false;
  }

  if (state.isEditingMessage) {
    return state.hasEditedMessageChanged;
  }

  return true;
}
