/**
 * ChatContext – Centralized state provider for extracted chat sub-components.
 *
 * This context aggregates the many closure-bound variables (state, callbacks,
 * refs, theme, utilities) that `renderMessage` and other chat render functions
 * previously accessed via closure scope in the monolithic chat.tsx.
 *
 * **Design rationale:**
 * - 43+ closure dependencies make prop drilling impractical
 * - Context value is split into `stable` (callbacks/refs wrapped in useCallback,
 *   utilities, static styles) and `reactive` (state that changes per render)
 * - Sub-components use `useChatStable()` for the callback bag (rarely changes)
 *   and `useChatReactive()` for per-render state
 * - This split prevents re-renders in children that only need stable refs
 *
 * **Performance notes:**
 * - The stable context value is memoized with minimal deps
 * - The reactive context value changes only when its constituent state changes
 * - All callback factories (getReactionPressHandler, etc.) are pre-stabilized
 *   via useCallback in chat.tsx before being passed here
 */
import React, { createContext, useContext, useMemo } from 'react';
import type { StyleProp, ViewStyle, TextStyle } from 'react-native';
import type { ThemeColors } from '../../types/theme';

// ─── Re-export canonical types from service layer ────────────────────
// Using the same type definitions as the rest of the codebase avoids
// TypeScript structural-type mismatches when passing callbacks.
export type { HydratedAttachment } from '../../services/chatCacheService';
export type { ChatReplyContext } from '../../services/chatService';
import type { HydratedAttachment } from '../../services/chatCacheService';
import type { ChatReplyContext } from '../../services/chatService';


/** Theme colors — use the canonical ThemeColors type from types/theme.ts */
export type ChatTheme = ThemeColors;

/** Themed styles generated from the theme */
export interface ChatThemedStyles {
  bgPrimary: StyleProp<ViewStyle>;
  bgBackground: StyleProp<ViewStyle>;
  colorText: StyleProp<TextStyle>;
  colorTextSecondary: StyleProp<TextStyle>;
  colorWarning: StyleProp<TextStyle>;
  colorPrimary: StyleProp<TextStyle>;
  specialBubble: StyleProp<ViewStyle>;
  friendBubble: StyleProp<ViewStyle>;
  deletedPlaceholder: StyleProp<ViewStyle>;
  borderPrimary: StyleProp<ViewStyle>;
  editBorderOwn: StyleProp<ViewStyle>;
  editBorderFriend: StyleProp<ViewStyle>;
  linkStyleOwn: StyleProp<TextStyle>;
  linkStylePrimary: StyleProp<TextStyle>;
  dateSepLine: StyleProp<ViewStyle>;
  dateSepText: StyleProp<TextStyle>;
  unreadSepLine: StyleProp<ViewStyle>;
  unreadSepText: StyleProp<TextStyle>;
  newDividerLine: StyleProp<ViewStyle>;
  newDividerText: StyleProp<TextStyle>;
  searchMarkerActive: StyleProp<ViewStyle>;
  searchMarkerInactive: StyleProp<ViewStyle>;
  searchDotActive: StyleProp<ViewStyle>;
  searchDotInactive: StyleProp<ViewStyle>;
  retryButton: StyleProp<ViewStyle>;
  retryButtonDisabled: StyleProp<ViewStyle>;
  retryText: StyleProp<TextStyle>;
  [key: string]: any;
}

/**
 * Stable context: callbacks, refs, and utilities that rarely change identity.
 * Components consuming only this context won't re-render on state changes.
 */
export interface ChatStableContextValue {
  // ── Callback factories (identity-stable via useCallback) ──
  normalizeMessageId: (id: unknown) => string;
  getReactionPressHandler: (messageId: unknown, reactionType: string) => () => void;
  getQuickTapReactionHandler: (messageId: unknown) => () => void;
  getAttachmentImageViewPressHandler: (attachment: HydratedAttachment) => () => void;
  getAttachmentDownloadPressHandler: (attachment: HydratedAttachment, fallbackFileName?: string) => () => void;
  getDownloadKey: (url: string) => string | undefined;
  handleMessageLongPress: (messageId: string, event: any) => void;
  handleImageError: (url: string) => void;
  jumpToReplyMessage: (replyContext: any) => void;
  isMessageActionPending: (messageId: string) => boolean;
  getMessageReactionSummary: (messageId: string, reactionsOverride?: { [key: string]: Set<string> }) => any;

  // ── Utility functions (module-level imports, never change) ──
  formatMessageTimestamp: (timestamp: any) => string;
  sanitizeMessageText: (text: string, fallback: string) => string;
  sanitizeAttachmentFileName: (fileName: string | undefined) => string;
  resolveChatReplyPreviewText: (params: any) => string;
  resolveChatReplySenderLabel: (replyContext: any) => string;
  resolveNativeSafeStickerUrl: (url: string) => Promise<string | null>;
  resolveOptimizedGifUrl: (url: string) => Promise<string | null>;
  isImageFile: (mimeType: string, fileName?: string) => boolean;
  isVideoFile: (mimeType: string, fileName?: string) => boolean;
  normalizeParticipantEmail: (email: string) => string;
  getProfilePictureURL: (member: any) => string | undefined;
  getSafeDisplayInitial: (name: string) => string;
  logger: any;

  // ── Static styles (never change after creation) ──
  styles: any;

  // ── Constants ──
  CHAT_REPLY_PREVIEW_MAX_CHARS: number;
}

/**
 * Reactive context: state that changes as the chat updates.
 * Components consuming this will re-render when any value changes.
 */
export interface ChatReactiveContextValue {
  // ── User & recipient ──
  effectiveUser: { email: string; [key: string]: any } | null;
  selectedTeamMember: { id: string; name?: string; [key: string]: any } | null;
  teamMembersByEmail: Map<string, any>;

  // ── Theme ──
  theme: ChatTheme;
  themedStyles: ChatThemedStyles;
  isDarkMode: boolean;

  // ── UI state ──
  isFocused: boolean;
  isOffline: boolean;
  animatedMessages: Set<string>;
  globalAnimatedMessages: React.MutableRefObject<Set<string>>;
  editingMessageInfo: { id: string; [key: string]: any } | null;
  replyJumpHighlightMessageId: string | null;
  conversationSearchHighlightMessageId: string | null;
  inlineConversationSearchHighlightQuery: string;

  // ── Asset state ──
  brokenFileUrls: Set<string>;
  networkErrorUrls: Set<string>;
  stickerUrlMap: Map<string, string>;
  gifUrlMap: Map<string, string>;
}

// ─── Context Creation ────────────────────────────────────────────────

const ChatStableContext = createContext<ChatStableContextValue | null>(null);
const ChatReactiveContext = createContext<ChatReactiveContextValue | null>(null);

ChatStableContext.displayName = 'ChatStableContext';
ChatReactiveContext.displayName = 'ChatReactiveContext';

// ─── Provider ────────────────────────────────────────────────────────

interface ChatContextProviderProps {
  stable: ChatStableContextValue;
  reactive: ChatReactiveContextValue;
  children: React.ReactNode;
}

/**
 * ChatContextProvider – wraps the chat message list area.
 *
 * Accepts pre-built `stable` and `reactive` value objects from chat.tsx.
 * The stable value should be memoized by the parent to avoid unnecessary
 * context propagation.
 */
export const ChatContextProvider = React.memo(function ChatContextProvider({
  stable,
  reactive,
  children,
}: ChatContextProviderProps) {
  return (
    <ChatStableContext.Provider value={stable}>
      <ChatReactiveContext.Provider value={reactive}>
        {children}
      </ChatReactiveContext.Provider>
    </ChatStableContext.Provider>
  );
});

// ─── Consumer Hooks ──────────────────────────────────────────────────

/**
 * Access stable (rarely-changing) chat values: callbacks, utilities, styles.
 * Components using only this hook won't re-render on state changes.
 */
export function useChatStable(): ChatStableContextValue {
  const ctx = useContext(ChatStableContext);
  if (!ctx) {
    throw new Error('useChatStable must be used within ChatContextProvider');
  }
  return ctx;
}

/**
 * Access reactive (frequently-changing) chat values: state, theme, flags.
 * Components using this hook will re-render when chat state changes.
 */
export function useChatReactive(): ChatReactiveContextValue {
  const ctx = useContext(ChatReactiveContext);
  if (!ctx) {
    throw new Error('useChatReactive must be used within ChatContextProvider');
  }
  return ctx;
}

export default ChatContextProvider;
