import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { X, AlertCircle, RotateCcw, Reply, Edit3, FileIcon } from 'lucide-react-native';
import MobileChatInput, { MobileChatInputRef } from '../MobileChatInput';
import { TeamMember } from '@/hooks/useAuthUnified';

const CHAT_MESSAGE_MAX_CHARS = 4000;
const CHAT_MESSAGE_MAX_WORDS = 800;

export interface ChatComposerProps {
  theme: any;
  isDarkMode: boolean;
  selectedTeamMember: TeamMember | null;
  isOffline: boolean;
  
  // Message & Input
  message: string;
  handleTyping: (text: string) => void;
  handleSendMessage: () => void;
  isSendingMessage: boolean;
  canAttemptSend: boolean;
  appendFormattingText: (suffix: string) => void;
  
  // Formatting Guide
  showFormattingGuide: boolean;
  toggleFormattingGuide: () => void;
  hideFormattingGuide: () => void;

  // Retry All Banner
  retryAllPendingCount: number;
  isRetryingAllPending: boolean;
  handleRetryAllPendingPress: () => void;
  
  // Replying
  replyingToMessage: any;
  replyingSenderLabel: string;
  replyingPreviewText: string;
  cancelReplyingToMessage: () => void;
  
  // Editing
  editingMessageInfo: any;
  editingPreviewText: string;
  cancelEditingMessage: () => void;
  handleEditLastOwnMessageShortcut: () => void;
  
  // MobileInput specific
  mobileInputRef: React.RefObject<MobileChatInputRef | null>;
  openAttachmentModal: () => void;
  openStickerGifPicker: () => void;
  isComposingSpecial: boolean;
  setInputHeight: (height: number) => void;
  handleComposerBlur: () => void;
  getComposerPlaceholder: () => string;
  
  // Char count / Limits
  showInputLimitCounter: boolean;
  messageCharacterCount: number;
  messageWordCount: number;
  
  // Chat drop active
  isChatDropActive: boolean;
}

export function ChatComposer({
  theme,
  isDarkMode,
  selectedTeamMember,
  isOffline,
  
  message,
  handleTyping,
  handleSendMessage,
  isSendingMessage,
  canAttemptSend,
  appendFormattingText,
  
  showFormattingGuide,
  toggleFormattingGuide,
  hideFormattingGuide,

  retryAllPendingCount,
  isRetryingAllPending,
  handleRetryAllPendingPress,
  
  replyingToMessage,
  replyingSenderLabel,
  replyingPreviewText,
  cancelReplyingToMessage,
  
  editingMessageInfo,
  editingPreviewText,
  cancelEditingMessage,
  handleEditLastOwnMessageShortcut,
  
  mobileInputRef,
  openAttachmentModal,
  openStickerGifPicker,
  isComposingSpecial,
  setInputHeight,
  handleComposerBlur,
  getComposerPlaceholder,
  
  showInputLimitCounter,
  messageCharacterCount,
  messageWordCount,
  
  isChatDropActive,
}: ChatComposerProps) {

  const handleQuickFormatExtraBold = useCallback(() => {
    appendFormattingText('***extra bold***');
  }, [appendFormattingText]);

  const handleQuickFormatBold = useCallback(() => {
    appendFormattingText('**bold**');
  }, [appendFormattingText]);

  const handleQuickFormatItalic = useCallback(() => {
    appendFormattingText('*italic*');
  }, [appendFormattingText]);

  const handleQuickFormatUnderline = useCallback(() => {
    appendFormattingText('__underline__');
  }, [appendFormattingText]);

  const handleQuickFormatStrike = useCallback(() => {
    appendFormattingText('~~strike~~');
  }, [appendFormattingText]);

  const handleQuickFormatCode = useCallback(() => {
    appendFormattingText('`code`');
  }, [appendFormattingText]);

  const handleQuickFormatSpecial = useCallback(() => {
    appendFormattingText('/special ');
  }, [appendFormattingText]);

  return (
    <>
      {showFormattingGuide && (
        <View style={[styles.formattingGuide, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.formattingGuideHeader}>
            <Text style={[styles.formattingTitle, { color: theme.text }]}>Text Formatting</Text>
            <TouchableOpacity onPress={hideFormattingGuide}>
              <X size={18} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
          
          {/* Quick format buttons */}
          {Platform.OS === 'web' && (
            <View style={styles.quickFormatButtons}>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={handleQuickFormatExtraBold}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, fontWeight: '900' }]}>B+</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={handleQuickFormatBold}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, fontWeight: 'bold' }]}>B</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={handleQuickFormatItalic}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, fontStyle: 'italic' }]}>I</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={handleQuickFormatUnderline}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, textDecorationLine: 'underline' }]}>U</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={handleQuickFormatStrike}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, textDecorationLine: 'line-through' }]}>S</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={handleQuickFormatCode}
              >
                <Text style={[styles.quickFormatButtonText, { 
                  color: theme.text, 
                  fontFamily: 'monospace' 
                }]}>{'<>'}</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: '#FFF7CC', borderColor: '#FFD24C' }]}
                onPress={handleQuickFormatSpecial}
              >
                <Text style={[styles.quickFormatButtonText, { color: '#B8860B', fontWeight: 'bold' }]}>⭐</Text>
              </TouchableOpacity>
            </View>
          )}
          
          <View style={styles.formattingOptions}>
            <View style={[styles.formattingRow, { flexDirection: 'row', alignItems: 'center' }]}> 
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>***extra bold***</Text>
              <Text style={[styles.formattingResult, { color: theme.text, fontWeight: '900', fontSize: 16 }]}>extra bold</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>**bold text**</Text>
              <Text style={[styles.formattingResult, { color: theme.text, fontWeight: 'bold' }]}>bold text</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>*italic text*</Text>
              <Text style={[styles.formattingResult, { color: theme.text, fontStyle: 'italic' }]}>italic text</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>__underline__</Text>
              <Text style={[styles.formattingResult, { color: theme.text, textDecorationLine: 'underline' }]}>underline</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>~~strikethrough~~</Text>
              <Text style={[styles.formattingResult, { color: theme.text, textDecorationLine: 'line-through' }]}>strikethrough</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>`code text`</Text>
              <Text style={[styles.formattingResult, {
                color: theme.text,
                fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                backgroundColor: theme.background,
                paddingHorizontal: 4,
                paddingVertical: 1,
                borderRadius: 3,
                alignSelf: 'flex-start'
              }]}>code text</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>/special</Text>
              <Text style={[styles.formattingResult, {
                color: '#FFD700',
                fontWeight: 'bold',
                backgroundColor: 'rgba(255, 215, 0, 0.2)',
                paddingHorizontal: 4,
                paddingVertical: 1,
                borderRadius: 3,
                borderWidth: 1,
                borderColor: '#FFD700',
                alignSelf: 'flex-start'
              }]}>✨special text✨</Text>
            </View>
          </View>
        </View>
      )}
      {selectedTeamMember && retryAllPendingCount > 0 && (
        <View
          style={[
            styles.retryAllBanner,
            {
              backgroundColor: isDarkMode ? theme.surface : '#f5f8ff',
              borderColor: theme.border,
            },
          ]}
        >
          <View style={styles.retryAllBannerLeft}>
            <AlertCircle size={14} color={theme.warning} />
            <Text style={[styles.retryAllBannerText, { color: theme.text }]}>
              {retryAllPendingCount} pending {retryAllPendingCount === 1 ? 'item' : 'items'} not sent
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleRetryAllPendingPress}
            disabled={isRetryingAllPending || isOffline}
            style={[
              styles.retryAllBannerButton,
              {
                backgroundColor: theme.primary,
                opacity: isRetryingAllPending || isOffline ? 0.65 : 1,
              },
            ]}
          >
            {isRetryingAllPending ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <RotateCcw size={14} color="#ffffff" />
            )}
            <Text style={styles.retryAllBannerButtonText}>
              {isRetryingAllPending ? 'Retrying...' : 'Retry all'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {/* Input Area - Mobile vs Web */}
      {replyingToMessage && !editingMessageInfo && (
        <View
          style={[
            styles.replyBanner,
            {
              borderColor: theme.primary,
              backgroundColor: isDarkMode ? theme.primary + '28' : theme.primary + '14',
            },
          ]}
        >
          <Reply size={16} color={theme.primary} style={styles.replyBannerIcon} />
          <View style={styles.replyBannerCopy}>
            <Text style={[styles.replyBannerTitle, { color: theme.primary }]}>Replying to {replyingSenderLabel}</Text>
            <Text
              style={[
                styles.replyBannerDescription,
                { color: replyingPreviewText ? theme.text : theme.textSecondary },
              ]}
              numberOfLines={1}
            >
              {replyingPreviewText || 'Add your reply below'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.replyBannerClose, { borderColor: theme.primary }]}
            onPress={cancelReplyingToMessage}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
          >
            <X size={14} color={theme.primary} />
            <Text style={[styles.replyBannerCloseText, { color: theme.primary }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
      {editingMessageInfo && (
        <View
          style={[
            styles.editingBanner,
            {
              borderColor: theme.primary,
              backgroundColor: isDarkMode ? theme.primary + '33' : theme.primary + '18',
            },
          ]}
        >
          <Edit3 size={16} color={theme.primary} style={styles.editingBannerIcon} />
          <View style={styles.editingBannerCopy}>
            <Text style={[styles.editingBannerTitle, { color: theme.primary }]}>Editing message</Text>
            <Text
              style={[
                styles.editingBannerDescription,
                { color: editingPreviewText ? theme.text : theme.textSecondary },
              ]}
              numberOfLines={1}
            >
              {editingPreviewText || 'Make your changes below'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.editingBannerClose, { borderColor: theme.primary }]}
            onPress={cancelEditingMessage}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Cancel editing"
          >
            <X size={14} color={theme.primary} />
            <Text style={[styles.editingBannerCloseText, { color: theme.primary }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
      <MobileChatInput
        ref={mobileInputRef}
        message={message}
        onMessageChange={handleTyping}
        onSendMessage={handleSendMessage}
        onAttachmentPress={openAttachmentModal}
        onStickerPress={openStickerGifPicker}
        selectedTeamMember={selectedTeamMember}
        isOffline={isOffline}
        isComposingSpecial={isComposingSpecial}
        showFormattingGuide={showFormattingGuide}
        onFormattingToggle={toggleFormattingGuide}
        isEditingMessage={!!editingMessageInfo}
        onEditLastMessageShortcut={handleEditLastOwnMessageShortcut}
        onCancelEditShortcut={cancelEditingMessage}
        onInputHeightChange={setInputHeight}
        onInputBlur={handleComposerBlur}
        placeholder={getComposerPlaceholder()}
        maxLength={CHAT_MESSAGE_MAX_CHARS}
        showCharacterCount={false}
        isSendingMessage={isSendingMessage}
        canSend={canAttemptSend}
      />

      {showInputLimitCounter && (
        <View style={styles.inputLimitCounter}>
          <Text
            style={[
              styles.inputLimitCounterText,
              {
                color:
                  messageCharacterCount >= CHAT_MESSAGE_MAX_CHARS || messageWordCount >= CHAT_MESSAGE_MAX_WORDS
                    ? theme.error
                    : theme.textSecondary,
              },
            ]}
          >
            {messageCharacterCount}/{CHAT_MESSAGE_MAX_CHARS} chars · {messageWordCount}/{CHAT_MESSAGE_MAX_WORDS} words
          </Text>
        </View>
      )}

      {Platform.OS === 'web' && isChatDropActive && selectedTeamMember && (
        <View pointerEvents="none" style={styles.chatDropOverlay}>
          <View style={[styles.chatDropCard, { backgroundColor: theme.surface, borderColor: theme.primary }]}> 
            <FileIcon size={26} color={theme.primary} />
            <Text style={[styles.chatDropTitle, { color: theme.text }]}>Drop files to send</Text>
            <Text style={[styles.chatDropSubtitle, { color: theme.textSecondary }]}>Files will open in preview before sending</Text>
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  formattingGuide: {
    padding: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderStyle: 'solid',
  },
  formattingGuideHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  formattingTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  quickFormatButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  quickFormatButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
    minWidth: 40,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  quickFormatButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  formattingOptions: {
    flexDirection: 'column',
    gap: 8,
  },
  formattingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  formattingExample: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  formattingResult: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  retryAllBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  retryAllBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  retryAllBannerText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    marginLeft: 8,
  },
  retryAllBannerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    marginLeft: 12,
  },
  retryAllBannerButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 6,
  },
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  replyBannerIcon: {
    marginRight: 10,
  },
  replyBannerCopy: {
    flex: 1,
  },
  replyBannerTitle: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 2,
  },
  replyBannerDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  replyBannerClose: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    marginLeft: 12,
  },
  replyBannerCloseText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 4,
  },
  editingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  editingBannerIcon: {
    marginRight: 10,
  },
  editingBannerCopy: {
    flex: 1,
  },
  editingBannerTitle: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 2,
  },
  editingBannerDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  editingBannerClose: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    marginLeft: 12,
  },
  editingBannerCloseText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 4,
  },
  inputLimitCounter: {
    position: 'absolute',
    bottom: 5,
    right: 15,
  },
  inputLimitCounterText: {
    fontSize: 10,
    fontFamily: 'Inter-Regular',
  },
  chatDropOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  chatDropCard: {
    padding: 30,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  chatDropTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 16,
    marginBottom: 8,
  },
  chatDropSubtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
});
