export interface ChatInputKeypressState {
  platformOS: string;
  key?: string | null;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

export function shouldSendOnComposerEnter(state: ChatInputKeypressState): boolean {
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
