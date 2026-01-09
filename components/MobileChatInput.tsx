import { logger } from '@/lib/logger';
import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle, memo, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Keyboard,
  KeyboardAvoidingView,
  Animated,
  Dimensions,
  UIManager,
  findNodeHandle,
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
import RichEditText, { RichEditTextRef } from './RichEditText';
import StyledText from './StyledText';

export interface MobileChatInputRef {
  clearInput: () => void;
  focusInput: () => void;
  syncValueFromParent: (value: string) => void;
}

interface MobileChatInputProps {
  message: string;
  onMessageChange: (text: string) => void;
  onSendMessage: () => void;
  onAttachmentPress: () => void;
  onStickerPress: () => void;
  selectedTeamMember: any;
  isOffline: boolean;
  isComposingSpecial: boolean;
  processingKeyboardMedia?: boolean;
  onRichContent?: (items: any[]) => void;
  showFormattingGuide: boolean;
  onFormattingToggle: () => void;
  placeholder?: string;
  maxLength?: number;
  isSendingMessage: boolean;
  canSend?: boolean;
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
  processingKeyboardMedia = false,
  onRichContent,
  showFormattingGuide,
  onFormattingToggle,
  placeholder,
  maxLength = 500,
  isSendingMessage,
  canSend = true,
}, ref) {
  const { theme } = useTheme();
  const textInputRef = useRef<TextInput>(null);
  const richTextInputRef = useRef<RichEditTextRef>(null);
  const lastSyncedValueRef = useRef('');
  const [inputHeight, setInputHeight] = useState(40);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [isClearingInProgress, setIsClearingInProgress] = useState(false); // NEW: Clearing flag
  // Removed remount key to avoid keyboard flicker on Android
  const keyboardHeightAnim = useRef(new Animated.Value(0)).current;
  
  const screenData = Dimensions.get('window');
  const isSmallScreen = screenData.width < 560;

  // Keep track of keyboard state
  useEffect(() => {
    const keyboardWillShow = (event: any) => {
      setIsKeyboardVisible(true);
      const keyboardHeight = event.endCoordinates.height;
      Animated.timing(keyboardHeightAnim, {
        toValue: keyboardHeight,
        duration: event.duration || 250,
        useNativeDriver: false,
      }).start();
    };

    const keyboardWillHide = (event: any) => {
      setIsKeyboardVisible(false);
      Animated.timing(keyboardHeightAnim, {
        toValue: 0,
        duration: event.duration || 250,
        useNativeDriver: false,
      }).start();
    };

    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      keyboardWillShow
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      keyboardWillHide
    );

    return () => {
      showSubscription?.remove();
      hideSubscription?.remove();
    };
  }, [keyboardHeightAnim]);

  const clearInput = useCallback(() => {
    if (__DEV__) logger.debug('MobileChatInput: clearInput');

    const hadMessage = typeof message === 'string' && message.length > 0;

    setIsClearingInProgress(true);

    if (hadMessage) {
      onMessageChange('');
      if (__DEV__) logger.debug('MobileChatInput: state -> empty');
    }

    lastSyncedValueRef.current = '';

    if (Platform.OS === 'android' && richTextInputRef.current) {
      try {
        // Direct native clear via exposed nativeRef
        // @ts-ignore
        const native = richTextInputRef.current.nativeRef?.current;
        native?.setNativeProps?.({ text: ' ', selection: { start: 1, end: 1 } });
        setTimeout(() => native?.setNativeProps?.({ text: '', selection: { start: 0, end: 0 } }), 5);
      } catch {}
      try {
        richTextInputRef.current.clear?.();
        if (__DEV__) logger.debug('MobileChatInput: Android in-place clear');
      } catch {}
    } else if (textInputRef.current) {
      textInputRef.current.clear?.();
    }

    setTimeout(() => {
      if (Platform.OS === 'android' && richTextInputRef.current) {
        try {
          // @ts-ignore
          const native = richTextInputRef.current.nativeRef?.current;
          native?.setNativeProps?.({ text: '', selection: { start: 0, end: 0 } });
        } catch {}
      }
    }, 50);

    setTimeout(() => {
      setIsClearingInProgress(false);
      if (__DEV__) logger.debug('MobileChatInput: clear completed');
    }, 160);
  }, [message, onMessageChange]);

  const syncNativeValue = useCallback((value: string) => {
    const safeValue = typeof value === 'string' ? value : '';

    if (Platform.OS === 'android' && richTextInputRef.current) {
      const native = richTextInputRef.current?.nativeRef?.current;
      const nodeHandle = native ? findNodeHandle(native) : null;
      if (nodeHandle != null) {
        try {
          const config = UIManager.getViewManagerConfig?.('RichEditText');
          const command = config?.Commands?.setTextFromJs ?? 'setTextFromJs';
          UIManager.dispatchViewManagerCommand(nodeHandle, command as any, [safeValue]);
          logger.debug('MobileChatInput: dispatched setTextFromJs command', { length: safeValue.length });
        } catch (error) {
          if (__DEV__) {
            logger.debug('MobileChatInput: setTextFromJs command failed, falling back to setNativeProps', { error });
          }
          try {
            native?.setNativeProps?.({ text: safeValue, selection: { start: safeValue.length, end: safeValue.length } });
          } catch (nativeError) {
            if (__DEV__) logger.debug('MobileChatInput: native fallback failed', { nativeError });
          }
        }
      }
    } else if (textInputRef.current) {
      try {
        textInputRef.current.setNativeProps?.({ text: safeValue, selection: { start: safeValue.length, end: safeValue.length } });
        logger.info?.('MobileChatInput: synced iOS/native text input value', { length: safeValue.length });
      } catch (error) {
        if (__DEV__) logger.debug('MobileChatInput: syncNativeValue ios failed', { error });
      }
    }
    lastSyncedValueRef.current = safeValue;
  }, []);

  useEffect(() => {
    if (isClearingInProgress) {
      return;
    }

    const safeMessage = typeof message === 'string' ? message : '';

    if (safeMessage === lastSyncedValueRef.current) {
      return;
    }

    logger.debug('MobileChatInput: message prop changed, syncing native value', {
      length: safeMessage.length,
    });
    syncNativeValue(safeMessage);
  }, [message, isClearingInProgress, syncNativeValue]);

  const handleAttachmentPress = useCallback(() => {
    // Prevent keyboard dismissal by maintaining focus
    const currentInputRef = Platform.OS === 'ios' ? textInputRef : richTextInputRef;
    
    onAttachmentPress();
    
    // Re-focus the input after a short delay to maintain keyboard
    setTimeout(() => {
      if (currentInputRef.current && selectedTeamMember) {
        try {
          currentInputRef.current.focus();
        } catch (e) {
          logger.debug('Focus not available');
        }
      }
    }, 100);
  }, [onAttachmentPress, selectedTeamMember]);

  const handleStickerPress = useCallback(() => {
    // Prevent keyboard dismissal by maintaining focus
    const currentInputRef = Platform.OS === 'ios' ? textInputRef : richTextInputRef;
    
    onStickerPress();
    
    // Re-focus the input after a short delay to maintain keyboard
    setTimeout(() => {
      if (currentInputRef.current && selectedTeamMember) {
        try {
          currentInputRef.current.focus();
        } catch (e) {
          logger.debug('Focus not available');
        }
      }
    }, 100);
  }, [onStickerPress, selectedTeamMember]);

  const handleInputSizeChange = useCallback((event: any) => {
    const { height } = event.nativeEvent.contentSize;
    const newHeight = Math.max(40, Math.min(120, height));
    setInputHeight(newHeight);
  }, []);

  const handleTyping = useCallback((text: string) => {
    onMessageChange(text);
    lastSyncedValueRef.current = typeof text === 'string' ? text : '';
  }, [onMessageChange]);

  const generatePlaceholder = useCallback(() => {
    if (placeholder) return placeholder;
    if (processingKeyboardMedia) return 'Processing media from keyboard...';
    if (isOffline) return 'Offline - messages will be queued';
    if (isComposingSpecial) return 'Type your special message here...';
    if (isSmallScreen) return 'Message';
    
    const rawName = selectedTeamMember?.name || 'team member';
    const safeName = typeof rawName === 'string' ? rawName.trim() : 'team member';
    if (!safeName || safeName === '.' || safeName.length === 0) return 'Message team member...';
    return `Message ${safeName}...`;
  }, [placeholder, processingKeyboardMedia, isOffline, isComposingSpecial, isSmallScreen, selectedTeamMember]);

  const trimmedMessage = useMemo(() => {
    return typeof message === 'string' ? message.trim() : '';
  }, [message]);

  const canSendMessage = useMemo(() => {
    if (!canSend) return false;
    if (!trimmedMessage) return false;
    if (!selectedTeamMember) return false;
    if (processingKeyboardMedia) return false;
    return true;
  }, [canSend, trimmedMessage, selectedTeamMember, processingKeyboardMedia]);

  const sendDisabled = isSendingMessage || !canSendMessage;

  const handleSendMessage = useCallback(() => {
    if (canSendMessage && !isSendingMessage) {
      onSendMessage();
    }
  }, [canSendMessage, isSendingMessage, onSendMessage]);

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    clearInput: () => {
      // Use the robust, component-recreation clearing flow defined above
      clearInput();
    },
    focusInput: () => {
      if (Platform.OS === 'ios' && textInputRef.current) {
        textInputRef.current.focus();
      } else if (Platform.OS === 'android' && richTextInputRef.current) {
        try {
          richTextInputRef.current.focus();
        } catch (e) {
          logger.debug('Focus failed');
        }
      }
    },
    syncValueFromParent: (value: string) => {
      setIsClearingInProgress(false);
      logger.info?.('MobileChatInput: syncValueFromParent invoked', { length: typeof value === 'string' ? value.length : 0 });
      syncNativeValue(value);
    },
  }));

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 25}
      style={styles.keyboardAvoidingView}
    >
      <View style={[styles.container, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
        {/* Main Input Row */}
        <View style={[styles.inputRow, { backgroundColor: theme.background, borderColor: theme.border }]}>
          {/* Attachment Button */}
          <TouchableOpacity 
            style={[styles.iconButton, { backgroundColor: theme.surface }]}
            onPress={handleAttachmentPress}
            disabled={!selectedTeamMember}
          >
            <Paperclip size={20} color={selectedTeamMember ? theme.primary : theme.textSecondary} />
          </TouchableOpacity>
          
          {/* Sticker/Emoji Button */}
          <TouchableOpacity 
            style={[styles.iconButton, { backgroundColor: theme.surface }]}
            onPress={handleStickerPress}
            disabled={!selectedTeamMember}
          >
            <Smile size={20} color={selectedTeamMember ? theme.primary : theme.textSecondary} />
          </TouchableOpacity>
          
          {/* Text Input Container */}
          <View style={styles.textInputContainer}>
            {Platform.OS === 'android' ? (
              <RichEditText
                // @ts-ignore - RichEditText ref handling
                ref={richTextInputRef}
                style={[
                  styles.textInput, 
                  { 
                    color: theme.text, 
                    height: Math.max(40, inputHeight),
                    backgroundColor: 'transparent',
                  }
                ]}
                value={isClearingInProgress ? '' : message}
                onChangeText={handleTyping}
                onContentSizeChange={handleInputSizeChange}
                placeholder={generatePlaceholder()}
                placeholderTextColor={processingKeyboardMedia ? theme.primary : (isOffline ? theme.warning : theme.textSecondary)}
                multiline={true}
                numberOfLines={1}
                textAlignVertical="center"
                maxLength={maxLength}
                editable={!!selectedTeamMember && !processingKeyboardMedia}
                autoCorrect={false}
                autoComplete="off"
                blurOnSubmit={false}
                enablesReturnKeyAutomatically={false}
                returnKeyType="send"
                onSubmitEditing={handleSendMessage}
                onRichContent={onRichContent}
                suppressChange={isClearingInProgress}
                underlineColorAndroid="transparent"
              />
            ) : (
              <TextInput
                ref={textInputRef}
                style={[
                  styles.textInput, 
                  { 
                    color: theme.text, 
                    height: Math.max(40, inputHeight),
                    backgroundColor: 'transparent',
                  }
                ]}
                value={isClearingInProgress ? '' : message}
                onChangeText={handleTyping}
                onContentSizeChange={handleInputSizeChange}
                placeholder={generatePlaceholder()}
                placeholderTextColor={isOffline ? theme.warning : theme.textSecondary}
                multiline={true}
                numberOfLines={1}
                textAlignVertical="center"
                maxLength={maxLength}
                editable={!!selectedTeamMember}
                blurOnSubmit={false}
                enablesReturnKeyAutomatically={false}
                returnKeyType="send"
                onSubmitEditing={handleSendMessage}
                underlineColorAndroid="transparent"
              />
            )}
            
            {/* Format Preview */}
            {message && typeof message === 'string' && message.trim().length > 0 && 
             (message.includes('***') || message.includes('**') || message.includes('*') || 
              message.includes('__') || message.includes('~~') || message.includes('`')) && 
             !message.includes('/special') && (
              <View style={[styles.formatPreview, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.formatPreviewLabel, { color: theme.textSecondary }]}>Preview:</Text>
                <StyledText
                  text={message.trim() || 'Message preview'}
                  style={[styles.formatPreviewText, { color: theme.text }]}
                  linkStyle={{ color: theme.primary }}
                />
              </View>
            )}
          </View>
          
          {/* Action Buttons Row */}
          <View style={styles.actionButtons}>
            {/* Formatting Button */}
            <TouchableOpacity 
              style={[
                styles.iconButton, 
                { backgroundColor: showFormattingGuide ? theme.primary + '20' : theme.surface }
              ]}
              onPress={onFormattingToggle}
            >
              <Edit3 size={18} color={showFormattingGuide ? theme.primary : theme.textSecondary} />
            </TouchableOpacity>
            
            {/* Send Button */}
            <TouchableOpacity 
              style={[
                styles.sendButton, 
                { 
                  backgroundColor: canSendMessage
                    ? (isOffline 
                        ? theme.warning 
                        : isComposingSpecial 
                          ? theme.warning 
                          : theme.primary)
                    : theme.border,
                  opacity: isSendingMessage ? 0.7 : 1,
                }
              ]}
              onPress={handleSendMessage}
              disabled={sendDisabled}
            >
              {isSendingMessage ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : isOffline && canSendMessage ? (
                <Clock size={18} color="#ffffff" />
              ) : isComposingSpecial && canSendMessage ? (
                <Star size={18} color="#ffffff" />
              ) : (
                <Send 
                  size={18} 
                  color={canSendMessage ? '#ffffff' : theme.textSecondary} 
                />
              )}
            </TouchableOpacity>
          </View>
        </View>
        
        {/* Character Count (shown when near limit) */}
        {message.length > maxLength * 0.8 && (
          <View style={styles.characterCount}>
            <Text style={[
              styles.characterCountText, 
              { 
                color: message.length > maxLength * 0.9 ? theme.error : theme.textSecondary 
              }
            ]}>
              {message.length}/{maxLength}
            </Text>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
});

MobileChatInputComponent.displayName = 'MobileChatInput';

export default memo(MobileChatInputComponent);

const styles = StyleSheet.create({
  keyboardAvoidingView: {
    position: 'relative',
  },
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
    minHeight: 40,
    maxHeight: 120,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    textAlignVertical: 'center',
    includeFontPadding: false,
    ...Platform.select({
      android: {
        textAlignVertical: 'center',
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
