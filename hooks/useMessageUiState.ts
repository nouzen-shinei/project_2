import { useSyncExternalStore } from 'react';
import { getMessageUiState, subscribeMessageUiState } from '@/lib/messageUiStateStore';

type MessageReactions = {
  [key: string]: Set<string>;
};

type MessageUiState = {
  reactions?: MessageReactions;
  isEditing: boolean;
};

const emptyState: MessageUiState = { isEditing: false };

export const useMessageUiState = (messageId?: string): MessageUiState => {
  const safeId = (messageId || '').trim();

  const subscribe = (listener: () => void) => {
    return subscribeMessageUiState(safeId, listener);
  };

  const getSnapshot = () => {
    if (!safeId) return emptyState;
    return getMessageUiState(safeId);
  };

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
