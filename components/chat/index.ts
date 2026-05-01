/**
 * Chat Components – barrel export
 *
 * All components extracted from the monolithic chat.tsx to improve
 * FlashList performance and long-term maintainability.
 */

export { default as AnimatedMessageWrapper } from './AnimatedMessageWrapper';
export type { AnimatedMessageWrapperProps } from './AnimatedMessageWrapper';

export { default as MessageRow } from './MessageRow';
export type { MessageRowProps } from './MessageRow';

export { default as MessageReplySnippet } from './MessageReplySnippet';
export type { MessageReplySnippetProps } from './MessageReplySnippet';

export { default as MessageReactionPills } from './MessageReactionPills';
export type { MessageReactionPillsProps } from './MessageReactionPills';

export { default as MessageFooter } from './MessageFooter';
export type { MessageFooterProps } from './MessageFooter';

export { default as MessagePendingOverlay } from './MessagePendingOverlay';
export type { MessagePendingOverlayProps } from './MessagePendingOverlay';
