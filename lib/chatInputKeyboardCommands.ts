export type ChatInputKeyboardCommand = 'send-message' | 'edit-last-message' | 'cancel-edit-message' | null;

export interface ChatInputKeyboardCommandState {
  platformOS: string;
  key?: string | null;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  hasMessageContent: boolean;
  isEditingMessage: boolean;
}

function shouldSendOnComposerEnter(state: ChatInputKeyboardCommandState): boolean {
  if (state.platformOS !== 'web') {
    return false;
  }

  if (state.key !== 'Enter') {
    return false;
  }

  if (state.shiftKey || state.ctrlKey || state.metaKey || state.altKey) {
    return false;
  }

  if (state.isComposing || state.repeat) {
    return false;
  }

  return true;
}

export function resolveChatInputKeyboardCommand(state: ChatInputKeyboardCommandState): ChatInputKeyboardCommand {
  if (state.platformOS !== 'web') {
    return null;
  }

  if (shouldSendOnComposerEnter(state)) {
    return 'send-message';
  }

  if (state.key === 'Escape') {
    return state.isEditingMessage ? 'cancel-edit-message' : null;
  }

  if (state.key !== 'ArrowUp') {
    return null;
  }

  if (state.shiftKey || state.ctrlKey || state.metaKey || state.altKey) {
    return null;
  }

  if (state.isComposing || state.repeat) {
    return null;
  }

  if (state.hasMessageContent || state.isEditingMessage) {
    return null;
  }

  return 'edit-last-message';
}
