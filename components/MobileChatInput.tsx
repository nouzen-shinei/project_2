import { logger } from '@/lib/logger';
import { useState, useRef, useCallback, forwardRef, useImperativeHandle, memo, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native';
import {
  Send,
  Paperclip,
  Smile,
  Edit3,
  Clock,
  Star,
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { resolveChatInputKeyboardCommand } from '../lib/chatInputKeyboardCommands';
import StyledText from './StyledText';
import type { KeyboardMediaCandidate } from '../lib/chatKeyboardMediaSend';
import { PasteableTextInput } from './chat/PasteableTextInput';

export interface MobileChatInputRef {
  clearInput: () => void;
  focusInput: () => void;
  syncValueFromParent: (value: string) => void;
}

interface MobileChatInputRecipient {
  id?: string | number | null;
  email?: string | null;
  name?: string | null;
}

const COMPOSER_BUTTON_HIT_SLOP = { top: 8, right: 8, bottom: 8, left: 8 } as const;
const COMPOSER_MIN_INPUT_HEIGHT = 40;
const COMPOSER_MAX_INPUT_HEIGHT = 120;

type ComposerKeyPressEvent = NativeSyntheticEvent<TextInputKeyPressEventData> & {
  nativeEvent: NativeSyntheticEvent<TextInputKeyPressEventData>['nativeEvent'] & {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    repeat?: boolean;
  };
  preventDefault?: () => void;
};

interface MobileChatInputProps {
  message: string;
  onMessageChange: (text: string) => void;
  onSendMessage: () => void;
  onAttachmentPress: () => void;
  onStickerPress: () => void;
  selectedTeamMember: MobileChatInputRecipient | null;
  isOffline: boolean;
  isComposingSpecial: boolean;
  showFormattingGuide: boolean;
  onFormattingToggle: () => void;
  isEditingMessage?: boolean;
  onEditLastMessageShortcut?: () => void;
  onCancelEditShortcut?: () => void;
  onInputHeightChange?: (height: number) => void;
  onInputBlur?: () => void;
  placeholder?: string;
  maxLength?: number;
  showCharacterCount?: boolean;
  isSendingMessage: boolean;
  canSend?: boolean;
  /**
   * Fired when the user pastes/inserts media (image or video) via the keyboard
   * or clipboard while the composer is focused. Currently sourced from the web
   * clipboard `paste` event; a native `commitContent` bridge could feed the same
   * callback later. The parent is responsible for validating + sending.
   */
  onKeyboardMedia?: (candidate: KeyboardMediaCandidate) => void;
}

const MobileChatInputComponent = forwardRef<MobileChatInputRef, MobileChatInputProps>(function MobileChatInput({
  message,
  onMessageChange,
  onSendMessage,
  onAttachmentPress,
  onStickerPress,
  selectedTeamMember,
  isOffline,
  isComposingSpecial,
  showFormattingGuide,
  onFormattingToggle,
  isEditingMessage = false,
  onEditLastMessageShortcut,
  onCancelEditShortcut,
  onInputHeightChange,
  onInputBlur,
  placeholder,
  maxLength = 500,
  showCharacterCount = true,
  isSendingMessage,
  canSend = true,
  onKeyboardMedia,
}, ref) {
  const { theme } = useTheme();
  const { width } = useWindowDimensions();
  const textInputRef = useRef<TextInput>(null);
  const isFocusedRef = useRef(false);
  const lastReportedInputHeightRef = useRef(COMPOSER_MIN_INPUT_HEIGHT);
  const [inputHeight, setInputHeight] = useState(COMPOSER_MIN_INPUT_HEIGHT);
  const isSmallScreen = width < 560;
  const safeMessage = typeof message === 'string' ? message : '';
  const hasSelectedTeamMember = !!selectedTeamMember;

  const reportInputHeight = useCallback((nextHeight: number) => {
    if (lastReportedInputHeightRef.current === nextHeight) {
      return;
    }
    lastReportedInputHeightRef.current = nextHeight;
    onInputHeightChange?.(nextHeight);
  }, [onInputHeightChange]);

  const clearInput = useCallback(() => {
    if (__DEV__) logger.debug('MobileChatInput: clearInput');
    onMessageChange('');
    setInputHeight(COMPOSER_MIN_INPUT_HEIGHT);
    reportInputHeight(COMPOSER_MIN_INPUT_HEIGHT);

    try {
      textInputRef.current?.clear?.();
    } catch (error) {
      if (__DEV__) logger.debug('MobileChatInput: clearInput native clear failed', { error });
    }
  }, [onMessageChange, reportInputHeight]);

  useEffect(() => {
    if (safeMessage.length > 0) {
      return;
    }
    setInputHeight((prevHeight) => (prevHeight === COMPOSER_MIN_INPUT_HEIGHT ? prevHeight : COMPOSER_MIN_INPUT_HEIGHT));
    reportInputHeight(COMPOSER_MIN_INPUT_HEIGHT);
  }, [safeMessage, reportInputHeight]);

  const syncNativeValue = useCallback((value: string) => {
    const safeValue = typeof value === 'string' ? value : '';
    try {
      textInputRef.current?.setNativeProps?.({
        text: safeValue,
        selection: { start: safeValue.length, end: safeValue.length },
      });
    } catch (error) {
      if (__DEV__) logger.debug('MobileChatInput: syncNativeValue failed', { error });
    }
  }, []);

  const handleInputFocus = useCallback(() => {
    isFocusedRef.current = true;
  }, []);

  const handleInputBlur = useCallback(() => {
    isFocusedRef.current = false;
    onInputBlur?.();
  }, [onInputBlur]);

  // Web only: allow pasting an image/video (a GIF from the OS clipboard, a copied
  // screenshot, etc.) directly into the composer. We extract the first media item
  // from the clipboard and hand it to the parent for validation + send. Guarded by
  // focus so a paste elsewhere on the page never hijacks the chat input, and by
  // preventDefault so the browser doesn't also dump the binary into the text field.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !onKeyboardMedia) {
      return;
    }
    const handlePaste = (event: Event) => {
      if (!isFocusedRef.current) return;
      const clipboardData = (event as unknown as { clipboardData?: DataTransfer }).clipboardData;
      const items = clipboardData?.items;
      if (!items || items.length === 0) return;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind !== 'file') continue;
        const type = (item.type || '').toLowerCase();
        if (!type.startsWith('image/') && !type.startsWith('video/')) continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        let objectUrl = '';
        try {
          objectUrl = URL.createObjectURL(file);
        } catch {
          objectUrl = '';
        }
        onKeyboardMedia({
          uri: objectUrl || (file as { name?: string }).name || '',
          mimeType: file.type || type,
          fileName: (file as { name?: string }).name || undefined,
          fileSize: typeof file.size === 'number' ? file.size : undefined,
          webFile: file,
        });
        break; // one media item per paste
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [onKeyboardMedia]);

  const handleAttachmentPress = useCallback(() => {
    if (!hasSelectedTeamMember) {
      return;
    }
    onAttachmentPress();
  }, [hasSelectedTeamMember, onAttachmentPress]);

  const handleStickerPress = useCallback(() => {
    if (!hasSelectedTeamMember) {
      return;
    }
    onStickerPress();
  }, [hasSelectedTeamMember, onStickerPress]);

  const handleInputSizeChange = useCallback((event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    const rawHeight = Number(event?.nativeEvent?.contentSize?.height);
    if (!Number.isFinite(rawHeight)) {
      return;
    }
    const nextHeight = Math.max(COMPOSER_MIN_INPUT_HEIGHT, Math.min(COMPOSER_MAX_INPUT_HEIGHT, rawHeight));
    setInputHeight((prevHeight) => (prevHeight === nextHeight ? prevHeight : nextHeight));
    reportInputHeight(nextHeight);
  }, [reportInputHeight]);

  const handleTyping = useCallback((text: string) => {
    onMessageChange(typeof text === 'string' ? text : '');
  }, [onMessageChange]);

  const generatePlaceholder = useCallback(() => {
    if (placeholder) return placeholder;
    if (isOffline) return 'Offline - messages will be queued';
    if (isComposingSpecial) return 'Type your special message here...';
    if (isSmallScreen) return 'Message';
    
    const rawName = selectedTeamMember?.name || 'team member';
    const safeName = typeof rawName === 'string' ? rawName.trim() : 'team member';
    if (!safeName || safeName === '.' || safeName.length === 0) return 'Message team member...';
    return `Message ${safeName}...`;
  }, [placeholder, isOffline, isComposingSpecial, isSmallScreen, selectedTeamMember]);

  const trimmedMessage = useMemo(() => {
    return safeMessage.trim();
  }, [safeMessage]);

  const canSendMessage = useMemo(() => {
    if (!canSend) return false;
    if (!trimmedMessage) return false;
    if (!hasSelectedTeamMember) return false;
    return true;
  }, [canSend, trimmedMessage, hasSelectedTeamMember]);

  const sendDisabled = isSendingMessage || !canSendMessage;

  const handleSendMessage = useCallback(() => {
    if (canSendMessage && !isSendingMessage) {
      onSendMessage();
    }
  }, [canSendMessage, isSendingMessage, onSendMessage]);

  const handleKeyPress = useCallback((event: ComposerKeyPressEvent) => {
    const nativeEvent = event?.nativeEvent || {};
    const command = resolveChatInputKeyboardCommand({
      platformOS: Platform.OS,
      key: nativeEvent.key,
      shiftKey: nativeEvent.shiftKey,
      ctrlKey: nativeEvent.ctrlKey,
      metaKey: nativeEvent.metaKey,
      altKey: nativeEvent.altKey,
      isComposing: nativeEvent.isComposing,
      repeat: nativeEvent.repeat,
      hasMessageContent: safeMessage.trim().length > 0,
      isEditingMessage,
    });

    if (!command) {
      return;
    }

    event?.preventDefault?.();
    if (command === 'send-message') {
      handleSendMessage();
      return;
    }

    if (command === 'edit-last-message') {
      onEditLastMessageShortcut?.();
      return;
    }

    if (command === 'cancel-edit-message') {
      onCancelEditShortcut?.();
    }
  }, [handleSendMessage, isEditingMessage, onCancelEditShortcut, onEditLastMessageShortcut, safeMessage]);

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    clearInput,
    focusInput: () => {
      textInputRef.current?.focus();
    },
    syncValueFromParent: (value: string) => {
      syncNativeValue(value);
    },
  }), [clearInput, syncNativeValue]);

  return (
    <View style={[styles.container, { backgroundColor: theme.surface, borderTopColor: theme.border }]}> 
      <View style={[styles.inputRow, { backgroundColor: theme.background, borderColor: theme.border }]}> 
        <TouchableOpacity
          style={[styles.iconButton, { backgroundColor: theme.surface }]}
          onPress={handleAttachmentPress}
          disabled={!hasSelectedTeamMember}
          hitSlop={COMPOSER_BUTTON_HIT_SLOP}
          testID="chat-input-attach"
          accessibilityRole="button"
          accessibilityLabel="Attach file"
          accessibilityState={{ disabled: !hasSelectedTeamMember }}
        >
          <Paperclip size={20} color={hasSelectedTeamMember ? theme.primary : theme.textSecondary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.iconButton, { backgroundColor: theme.surface }]}
          onPress={handleStickerPress}
          disabled={!hasSelectedTeamMember}
          hitSlop={COMPOSER_BUTTON_HIT_SLOP}
          testID="chat-input-sticker"
          accessibilityRole="button"
          accessibilityLabel="Open sticker and emoji picker"
          accessibilityState={{ disabled: !hasSelectedTeamMember }}
        >
          <Smile size={20} color={hasSelectedTeamMember ? theme.primary : theme.textSecondary} />
        </TouchableOpacity>

        <View style={styles.textInputContainer}>
          <PasteableTextInput
            ref={textInputRef}
            onKeyboardMedia={onKeyboardMedia}
            style={[
              styles.textInput,
              {
                color: theme.text,
                height: Math.max(COMPOSER_MIN_INPUT_HEIGHT, inputHeight),
                backgroundColor: 'transparent',
              },
            ]}
            value={safeMessage}
            testID="chat-input-field"
            onChangeText={handleTyping}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            onContentSizeChange={handleInputSizeChange}
            placeholder={generatePlaceholder()}
            placeholderTextColor={isOffline ? theme.warning : theme.textSecondary}
            multiline={true}
            numberOfLines={1}
            textAlignVertical="top"
            maxLength={maxLength}
            editable={hasSelectedTeamMember}
            autoCorrect={false}
            autoComplete="off"
            selectionColor={theme.primary}
            blurOnSubmit={false}
            enablesReturnKeyAutomatically={false}
            returnKeyType="send"
            onSubmitEditing={Platform.OS === 'web' ? undefined : handleSendMessage}
            onKeyPress={handleKeyPress}
            underlineColorAndroid="transparent"
          />

          {safeMessage.trim().length > 0 &&
            (safeMessage.includes('***') ||
              safeMessage.includes('**') ||
              safeMessage.includes('*') ||
              safeMessage.includes('__') ||
              safeMessage.includes('~~') ||
              safeMessage.includes('`')) &&
            !safeMessage.includes('/special') && (
              <View style={[styles.formatPreview, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                <Text style={[styles.formatPreviewLabel, { color: theme.textSecondary }]}>Preview:</Text>
                <StyledText
                  text={safeMessage.trim() || 'Message preview'}
                  style={[styles.formatPreviewText, { color: theme.text }]}
                  linkStyle={{ color: theme.primary }}
                />
              </View>
            )}
        </View>

        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[
              styles.iconButton,
              { backgroundColor: showFormattingGuide ? theme.primary + '20' : theme.surface },
            ]}
            onPress={onFormattingToggle}
            hitSlop={COMPOSER_BUTTON_HIT_SLOP}
            testID="chat-input-formatting"
            accessibilityRole="button"
            accessibilityLabel="Toggle formatting guide"
          >
            <Edit3 size={18} color={showFormattingGuide ? theme.primary : theme.textSecondary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.sendButton,
              {
                backgroundColor: canSendMessage
                  ? isOffline
                    ? theme.warning
                    : isComposingSpecial
                      ? theme.warning
                      : theme.primary
                  : theme.border,
                opacity: isSendingMessage ? 0.7 : 1,
              },
            ]}
            onPress={handleSendMessage}
            disabled={sendDisabled}
            hitSlop={COMPOSER_BUTTON_HIT_SLOP}
            testID="chat-input-send"
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: sendDisabled, busy: isSendingMessage }}
          >
            {isSendingMessage ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : isOffline && canSendMessage ? (
              <Clock size={18} color="#ffffff" />
            ) : isComposingSpecial && canSendMessage ? (
              <Star size={18} color="#ffffff" />
            ) : (
              <Send size={18} color={canSendMessage ? '#ffffff' : theme.textSecondary} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {showCharacterCount && safeMessage.length > maxLength * 0.8 && (
        <View style={styles.characterCount}>
          <Text
            style={[
              styles.characterCountText,
              {
                color: safeMessage.length > maxLength * 0.9 ? theme.error : theme.textSecondary,
              },
            ]}
          >
            {safeMessage.length}/{maxLength}
          </Text>
        </View>
      )}
    </View>
  );
});

MobileChatInputComponent.displayName = 'MobileChatInput';

const getTeamMemberIdentity = (member: MobileChatInputRecipient | null) => {
  if (!member) {
    return '';
  }

  const idPart = member?.id != null ? String(member.id) : '';
  const emailPart = typeof member?.email === 'string' ? member.email.trim().toLowerCase() : '';
  const namePart = typeof member?.name === 'string' ? member.name.trim() : '';
  return `${idPart}|${emailPart}|${namePart}`;
};

const areMobileChatInputPropsEqual = (prev: MobileChatInputProps, next: MobileChatInputProps) => {
  return (
    prev.message === next.message &&
    prev.onMessageChange === next.onMessageChange &&
    prev.onSendMessage === next.onSendMessage &&
    prev.onAttachmentPress === next.onAttachmentPress &&
    prev.onStickerPress === next.onStickerPress &&
    getTeamMemberIdentity(prev.selectedTeamMember) === getTeamMemberIdentity(next.selectedTeamMember) &&
    prev.isOffline === next.isOffline &&
    prev.isComposingSpecial === next.isComposingSpecial &&
    prev.showFormattingGuide === next.showFormattingGuide &&
    prev.onFormattingToggle === next.onFormattingToggle &&
    prev.isEditingMessage === next.isEditingMessage &&
    prev.onEditLastMessageShortcut === next.onEditLastMessageShortcut &&
    prev.onCancelEditShortcut === next.onCancelEditShortcut &&
    prev.onInputHeightChange === next.onInputHeightChange &&
    prev.onInputBlur === next.onInputBlur &&
    prev.placeholder === next.placeholder &&
    prev.maxLength === next.maxLength &&
    prev.showCharacterCount === next.showCharacterCount &&
    prev.isSendingMessage === next.isSendingMessage &&
    prev.canSend === next.canSend &&
    prev.onKeyboardMedia === next.onKeyboardMedia
  );
};

export default memo(MobileChatInputComponent, areMobileChatInputPropsEqual);

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 25,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1.5,
    minHeight: 52,
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  textInputContainer: {
    flex: 1,
    position: 'relative',
    minHeight: 40,
    justifyContent: 'center',
  },
  textInput: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    minHeight: COMPOSER_MIN_INPUT_HEIGHT,
    maxHeight: COMPOSER_MAX_INPUT_HEIGHT,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    textAlignVertical: 'top',
    includeFontPadding: false,
    ...Platform.select({
      android: {
        textAlignVertical: 'top',
      },
      ios: {
        paddingTop: 10,
        paddingBottom: 10,
      },
    }),
  },
  actionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  formatPreview: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 8,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    zIndex: 1000,
    elevation: 10,
    ...Platform.select({
      web: {
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
      },
      default: {
        shadowColor: '#000',
        shadowOffset: {
          width: 0,
          height: 4,
        },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
    }),
  },
  formatPreviewLabel: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  formatPreviewText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  characterCount: {
    alignItems: 'flex-end',
    paddingTop: 4,
    paddingRight: 8,
  },
  characterCountText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
});
