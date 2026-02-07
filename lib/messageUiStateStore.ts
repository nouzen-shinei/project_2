type MessageReactions = {
  [key: string]: Set<string>;
};

type MessageUiState = {
  reactions?: MessageReactions;
  isEditing: boolean;
};

type MessageUiListener = () => void;

const reactionsByMessage = new Map<string, MessageReactions>();
const messageListeners = new Map<string, Set<MessageUiListener>>();
const messageStateById = new Map<string, MessageUiState>();
let editingMessageId: string | null = null;

const emptyState: MessageUiState = { isEditing: false };

const notifyMessage = (messageId: string) => {
  const listeners = messageListeners.get(messageId);
  if (!listeners || listeners.size === 0) return;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore listener errors.
    }
  });
};

const updateMessageState = (messageId: string) => {
  if (!messageId) return;
  const nextState: MessageUiState = {
    reactions: reactionsByMessage.get(messageId),
    isEditing: editingMessageId === messageId,
  };

  if (!nextState.reactions && !nextState.isEditing) {
    if (messageStateById.delete(messageId)) {
      notifyMessage(messageId);
    }
    return;
  }

  const existing = messageStateById.get(messageId);
  if (existing && existing.reactions === nextState.reactions && existing.isEditing === nextState.isEditing) {
    return;
  }

  messageStateById.set(messageId, nextState);
  notifyMessage(messageId);
};

export const setMessageReactionsForMessage = (messageId: string, reactions?: MessageReactions) => {
  if (!messageId) return;
  if (!reactions) {
    if (reactionsByMessage.has(messageId)) {
      reactionsByMessage.delete(messageId);
      updateMessageState(messageId);
    }
    return;
  }
  reactionsByMessage.set(messageId, reactions);
  updateMessageState(messageId);
};

export const setEditingMessageId = (nextId: string | null) => {
  if (editingMessageId === nextId) return;
  const previous = editingMessageId;
  editingMessageId = nextId;
  if (previous) updateMessageState(previous);
  if (nextId) updateMessageState(nextId);
};

export const getMessageUiState = (messageId: string): MessageUiState => {
  if (!messageId) {
    return emptyState;
  }
  return messageStateById.get(messageId) ?? emptyState;
};

export const subscribeMessageUiState = (messageId: string, listener: MessageUiListener): (() => void) => {
  if (!messageId) {
    return () => {};
  }
  const existing = messageListeners.get(messageId);
  if (existing) {
    existing.add(listener);
  } else {
    messageListeners.set(messageId, new Set([listener]));
  }

  return () => {
    const listeners = messageListeners.get(messageId);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) {
      messageListeners.delete(messageId);
    }
  };
};
