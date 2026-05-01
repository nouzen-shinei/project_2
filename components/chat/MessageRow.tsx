import React from 'react';
import { logger } from '@/lib/logger';
import { useMessageUiState } from '@/hooks/useMessageUiState';
import ChatMessageItem from './ChatMessageItem';

export interface MessageRowProps {
  item: any;
}

/**
 * MessageRow – the leaf component rendered by FlashList for each chat message.
 *
 * Uses `ChatMessageItem` which reads its dependencies from ChatContext.
 * `useMessageUiState` provides per-message reactive slices (reactions,
 * isEditing) so only the affected row re-renders.
 */
const MessageRow = React.memo(function MessageRow({ item }: MessageRowProps) {
  const messageId = typeof item?.id === 'string' ? item.id : String(item?.id ?? '');
  const uiState = useMessageUiState(messageId);

  return (
    <ChatMessageItem
      msg={item}
      reactionsOverride={uiState.reactions}
      isEditingOverride={uiState.isEditing}
    />
  );
});

MessageRow.displayName = 'MessageRow';

export default MessageRow;
