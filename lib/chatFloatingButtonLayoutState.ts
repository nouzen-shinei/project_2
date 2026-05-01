/**
 * Floating button layout helpers.
 */

export const CHAT_FLOATING_BUTTON_BASE_OFFSET = 12;
export const CHAT_FLOATING_BUTTON_BASE_COMPOSER_HEIGHT = 40;

export function resolveChatFloatingButtonBottomOffset(
  inputHeight?: number | null,
  baseComposerHeight: number = CHAT_FLOATING_BUTTON_BASE_COMPOSER_HEIGHT,
  baseOffset: number = CHAT_FLOATING_BUTTON_BASE_OFFSET
): number {
  const composerHeight = typeof inputHeight === 'number' ? inputHeight : baseComposerHeight;
  return baseOffset + Math.max(0, composerHeight - baseComposerHeight);
}

export interface ChatScrollToBottomButtonStyleState {
  position: 'absolute';
  right: number;
  bottom: number;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  paddingHorizontal: number;
  paddingVertical: number;
  backgroundColor: string;
  flexDirection: 'row';
  alignItems: 'center';
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number;
}

export function resolveChatScrollToBottomButtonStyleState(input: {
  inputHeight?: number | null;
  surfaceColor: string;
  borderColor: string;
  borderWidth: number;
}): ChatScrollToBottomButtonStyleState {
  return {
    position: 'absolute',
    right: 12,
    bottom: resolveChatFloatingButtonBottomOffset(input.inputHeight),
    backgroundColor: input.surfaceColor,
    borderColor: input.borderColor,
    borderWidth: input.borderWidth,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  };
}
