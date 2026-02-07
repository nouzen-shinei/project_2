import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  TextInput,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Paperclip, Send, Smile } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { useChat } from '../hooks/useChat';
import { useAuth } from '../hooks/useAuthUnified';
import { FilePickerModal } from './FilePickerModal';
import { StickerGifPicker } from './StickerGifPicker';
import { EnhancedMessageRenderer } from './EnhancedMessageRenderer';
import { 
  getFileTypeInfo, 
  formatFileSize,
  isAudioFile,
  isPdfFile,
  isCodeFile,
  canPreview
} from '../lib/fileUtils';
import { chatCacheService } from '../services/chatCacheService';
import { FileDownloadUtil } from '../lib/fileDownloadUtil';
import { logger } from '../lib/logger';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import type { HydratedChatMessage } from '../services/chatCacheService';

interface EnhancedChatInterfaceProps {
  recipientId?: string;
}

type DisplayMessage = HydratedChatMessage & { isNewMessage?: boolean };

export function EnhancedChatInterface({ recipientId }: EnhancedChatInterfaceProps) {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { 
    messages, 
    loading, 
    error, 
    sendMessage, 
    sendMessageWithFiles,
    sendDocumentFile,
    sendAudioFile,
    sendCodeFile,
    sendMixedFiles,
    sendSticker,
    sendGif,
    hasMore,
    loadingMore,
    loadMore,
  } = useChat(recipientId);
  
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [showStickerGifPicker, setShowStickerGifPicker] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<{
    uri: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
  }[]>([]);
  const [messageText, setMessageText] = useState('');
  const [inputHeight, setInputHeight] = useState(40); // Track input height for auto-expanding
  
  // Sound functionality
  const lastSoundPlayedRef = useRef<number>(0);
  const soundTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousMessageIds = useRef<Set<string>>(new Set());
  const SOUND_THROTTLE_MS = 1000; // Minimum time between sounds
  const listRef = useRef<FlashList<DisplayMessage> | null>(null);
  const loadMoreLockRef = useRef(false);
  const skipHistorySoundRef = useRef(true);
  const lastRecipientRef = useRef<string | undefined>(recipientId);

  // Simple sound service for web
  const playMessageSound = () => {
    if (Platform.OS === 'web') {
      const now = Date.now();
      // Throttle sound to prevent multiple plays within 1 second
      if (now - lastSoundPlayedRef.current < SOUND_THROTTLE_MS) {
        return;
      }
      lastSoundPlayedRef.current = now;
      
      // Clear any existing sound timeout
      if (soundTimeoutRef.current) {
        clearTimeout(soundTimeoutRef.current);
      }
      
      // Debounce the sound to group rapid messages
      soundTimeoutRef.current = setTimeout(() => {
        try {
          // Only use Web Audio API on web platform
          if (Platform.OS === 'web' && typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
            oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.1);
            gainNode.gain.setValueAtTime(0.2, audioContext.currentTime); // Reduced volume
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.2); // Shorter sound
          }
        } catch (error) {
          // Fail silently if sound cannot be played
        }
      }, 100); // Small delay to group rapid messages
    }
  };

  // Monitor for new incoming messages and play sound
  useEffect(() => {
    if (lastRecipientRef.current !== recipientId) {
      lastRecipientRef.current = recipientId;
      previousMessageIds.current.clear();
      skipHistorySoundRef.current = true;
    }
  }, [recipientId]);

  useEffect(() => {
    if (loading || messages.length === 0) {
      return;
    }

    if (skipHistorySoundRef.current) {
      messages.forEach((message) => {
        if (message.id) {
          previousMessageIds.current.add(message.id);
        }
      });
      skipHistorySoundRef.current = false;
      return;
    }

    messages.forEach((message) => {
      if (message.id && !previousMessageIds.current.has(message.id)) {
        const isIncomingMessage = user?.email && message.sender?.toLowerCase() !== user.email.toLowerCase();

        if (isIncomingMessage && (message.text || message.sticker || message.gif)) {
          playMessageSound();
        }

        previousMessageIds.current.add(message.id);
      }
    });
  }, [messages, loading, user?.email]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (soundTimeoutRef.current) {
        clearTimeout(soundTimeoutRef.current);
      }
    };
  }, []);

  const handleFileSelection = (files: {
    uri: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
  }[]) => {
    // Check file size limit (50 MB = 50 * 1024 * 1024 bytes)
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const oversizedFiles = files.filter(file => {
      const fileSize = file.fileSize || 0;
      return fileSize > MAX_FILE_SIZE;
    });

    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles.map(file => file.fileName).join(', ');
      Alert.alert(
        'File Too Large',
        `The following file(s) exceed the 50 MB limit: ${fileNames}`,
        [{ text: 'OK' }]
      );
      return;
    }

    setSelectedFiles(files);
  };

  // Handle text change with height calculation for auto-expanding input
  const handleTextChange = (text: string) => {
    setMessageText(text);
    
    // Calculate height based on text content for better responsiveness
    const lineHeight = 20; // Approximate line height
    const padding = 24; // Top and bottom padding (12px each)
    const lines = text.split('\n').length;
    const estimatedHeight = Math.max(40, Math.min(100, (lines * lineHeight) + padding));
    setInputHeight(estimatedHeight);
  };

  // Handle input height change for auto-expanding text input (secondary fallback)
  const handleInputSizeChange = (event: any) => {
    const contentHeight = event?.nativeEvent?.contentSize?.height;
    if (typeof contentHeight !== 'number' || !Number.isFinite(contentHeight)) {
      return;
    }
    const newHeight = Math.max(40, Math.min(100, contentHeight));
    setInputHeight(newHeight);
  };

  const handleSendMessage = async () => {
    if (!messageText.trim() && selectedFiles.length === 0) {
      Alert.alert('Error', 'Please enter a message or select files to send');
      return;
    }

    try {
      if (selectedFiles.length > 0) {
        // Analyze file types to choose appropriate sending method
        const audioFiles = selectedFiles.filter(f => isAudioFile(f.fileType, f.fileName));
        const pdfFiles = selectedFiles.filter(f => isPdfFile(f.fileType, f.fileName));
        const codeFiles = selectedFiles.filter(f => isCodeFile(f.fileType, f.fileName));
        
        if (selectedFiles.length === 1) {
          const file = selectedFiles[0];
          
          if (isAudioFile(file.fileType, file.fileName)) {
            await sendAudioFile(messageText, file.uri, file.fileName, recipientId);
          } else if (isPdfFile(file.fileType, file.fileName)) {
            await sendDocumentFile(messageText, file.uri, file.fileName, recipientId);
          } else if (isCodeFile(file.fileType, file.fileName)) {
            await sendCodeFile(messageText, file.uri, file.fileName, recipientId);
          } else {
            await sendDocumentFile(messageText, file.uri, file.fileName, recipientId);
          }
        } else {
          // Multiple files - use mixed files method
          await sendMixedFiles(messageText, selectedFiles, recipientId);
        }
      } else {
        // Text-only message
        await sendMessage(messageText, false, recipientId);
      }

      // Clear form
      setMessageText('');
      setInputHeight(40); // Reset input height after sending
      setSelectedFiles([]);
    } catch (error) {
      Alert.alert('Error', 'Failed to send message. Please try again.');
    }
  };

  // Handle sticker selection
  const handleStickerSelect = async (sticker: any) => {
    try {
      // Send sticker directly without Firebase Storage for now
      const stickerData = {
        url: sticker.url,
        name: sticker.name,
        width: sticker.width,
        height: sticker.height
      };
      
      await sendSticker(stickerData);
      setShowStickerGifPicker(false);
    } catch (error) {
      Alert.alert('Error', 'Failed to send sticker. Please try again.');
    }
  };

  // Handle GIF selection
  const handleGifSelect = async (gif: any) => {
    try {
      // Send GIF directly without Firebase Storage for now
      const gifData = {
        url: gif.url,
        title: gif.title,
        width: gif.width,
        height: gif.height,
        thumbnailUrl: gif.thumbnailUrl
      };
      
      await sendGif(gifData);
      setShowStickerGifPicker(false);
    } catch (error) {
      Alert.alert('Error', 'Failed to send GIF. Please try again.');
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(files => files.filter((_, i) => i !== index));
  };

  const handleDownloadFile = useCallback(async (url: string, fileName: string, localHint?: string) => {
    if (!url || !fileName) {
      Alert.alert('Download Failed', 'File information is incomplete.');
      return;
    }

    try {
      const effectiveUrl = await chatCacheService.getMediaForDownload(url, fileName, localHint, 'high');

      if (Platform.OS === 'web') {
        const isLocalWebUrl = typeof effectiveUrl === 'string' && (effectiveUrl.startsWith('blob:') || effectiveUrl.startsWith('data:'));
        if (!isLocalWebUrl) {
          const availability = await FileDownloadUtil.checkFileAvailability(effectiveUrl, { timeoutMs: 5000 });
          if (availability === 'missing') {
            Alert.alert('File Not Available', 'This file is no longer accessible.');
            return;
          }
        }

        await FileDownloadUtil.downloadFile(effectiveUrl, fileName);
        Alert.alert('Download Started', `Downloading ${fileName}...`);
        return;
      }

      const { FileSystem } = require('expo-file-system');
      const { Sharing } = require('expo-sharing');

      const isLocalFile = typeof effectiveUrl === 'string' && effectiveUrl.startsWith('file://');
      const downloadPath = isLocalFile
        ? effectiveUrl
        : `${FileSystem.documentDirectory}${fileName}`;
      const downloadResult = isLocalFile
        ? { status: 200, uri: effectiveUrl }
        : await FileSystem.downloadAsync(effectiveUrl, downloadPath);

      if (downloadResult.status === 200) {
        await Sharing.shareAsync(downloadResult.uri);
        Alert.alert('Download Complete', `${fileName} is ready to share.`);
        return;
      }

      throw new Error('Download failed');
    } catch (error) {
      logger.error('Enhanced chat download failed', error);
      Alert.alert(
        'Network Error',
        'Unable to reach the file. Check your connection and try again.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Retry', onPress: () => handleDownloadFile(url, fileName, localHint) },
        ]
      );
    }
  }, []);

  const handleShareFile = useCallback((url: string, fileName: string) => {
    // Implement share logic
    Alert.alert('Share', `Sharing ${fileName}...`);
  }, []);

  const handleLoadMoreTop = useCallback(() => {
    if (!hasMore || loadingMore || loadMoreLockRef.current) {
      return;
    }
    if (!loadMore) {
      return;
    }

    loadMoreLockRef.current = true;
    skipHistorySoundRef.current = true;
    loadMore()
      .catch(() => undefined)
      .finally(() => {
        loadMoreLockRef.current = false;
      });
  }, [hasMore, loadingMore, loadMore]);

  const renderMessageItem = useCallback(
    ({ item }: ListRenderItemInfo<DisplayMessage>) => (
      <EnhancedMessageRenderer
        message={item}
        onDownloadFile={handleDownloadFile}
        onShareFile={handleShareFile}
      />
    ),
    [handleDownloadFile, handleShareFile]
  );

  const keyExtractor = useCallback((item: DisplayMessage, index: number) => {
    if (item.id) {
      return String(item.id);
    }
    const safeTimestamp = item.timestamp || 'unknown-ts';
    const safeSender = item.sender || 'unknown-sender';
    return `${safeTimestamp}-${safeSender}-${index}`;
  }, []);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.background,
    },
    messagesContainer: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: 16,
      paddingVertical: 16,
      flexGrow: 1,
    },
    loadingMoreContainer: {
      paddingVertical: 12,
      alignItems: 'center',
    },
    listFooterSpacer: {
      height: 16,
    },
    inputContainer: {
      backgroundColor: theme.surface,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      padding: 16,
    },
    selectedFilesContainer: {
      marginBottom: 12,
    },
    selectedFile: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.background,
      borderRadius: 8,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: theme.border,
    },
    fileIcon: {
      marginRight: 12,
    },
    fileInfo: {
      flex: 1,
    },
    fileName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.text,
    },
    fileDetails: {
      fontSize: 12,
      color: theme.textSecondary,
      marginTop: 2,
    },
    removeButton: {
      padding: 4,
      borderRadius: 4,
      backgroundColor: theme.error + '20',
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 12,
    },
    textInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      padding: 12,
      fontSize: 16,
      color: theme.text,
      backgroundColor: theme.background,
      minHeight: 40,
      maxHeight: 100,
      textAlignVertical: 'top',
    },
    attachButton: {
      padding: 12,
      borderRadius: 8,
      backgroundColor: theme.primary + '20',
      borderWidth: 1,
      borderColor: theme.primary,
    },
    sendButton: {
      padding: 12,
      borderRadius: 8,
      backgroundColor: theme.primary,
    },
    loadingText: {
      textAlign: 'center',
      color: theme.textSecondary,
      padding: 20,
    },
    errorText: {
      textAlign: 'center',
      color: theme.error,
      padding: 20,
    },
  });

  if (loading) {
    return <Text style={styles.loadingText}>Loading messages...</Text>;
  }

  if (error) {
    return <Text style={styles.errorText}>Error: {error}</Text>;
  }

  return (
    <View style={styles.container}>
      <FlashList
        ref={listRef}
        data={messages as DisplayMessage[]}
        renderItem={renderMessageItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={160}
        style={styles.messagesContainer}
        contentContainerStyle={styles.listContent}
        inverted
        ListHeaderComponent={<View style={styles.listFooterSpacer} />}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.loadingMoreContainer}>
              <ActivityIndicator size="small" color={theme.primary} />
            </View>
          ) : null
        }
        onEndReached={handleLoadMoreTop}
        onEndReachedThreshold={0.1}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 64 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />

      <View style={styles.inputContainer}>
        {selectedFiles.length > 0 && (
          <View style={styles.selectedFilesContainer}>
            {selectedFiles.map((file, index) => {
              const fileInfo = getFileTypeInfo(file.fileType, file.fileName);
              const IconComponent = fileInfo.icon;
              
              return (
                <View key={index} style={styles.selectedFile}>
                  <IconComponent 
                    size={20} 
                    color={fileInfo.color} 
                    style={styles.fileIcon}
                  />
                  <View style={styles.fileInfo}>
                    <Text style={styles.fileName}>{file.fileName}</Text>
                    <Text style={styles.fileDetails}>
                      {fileInfo.category} • {file.fileSize ? formatFileSize(file.fileSize) : 'Unknown size'}
                      {canPreview(file.fileType, file.fileName) ? ' • Previewable' : ''}
                    </Text>
                  </View>
                  <TouchableOpacity 
                    style={styles.removeButton}
                    onPress={() => removeFile(index)}
                  >
                    <Text style={{ color: theme.error, fontSize: 12 }}>✕</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.textInput, { height: inputHeight }]}
            value={messageText}
            onChangeText={handleTextChange}
            onContentSizeChange={handleInputSizeChange}
            placeholder="Type a message..."
            placeholderTextColor={theme.textSecondary}
            multiline
            textAlignVertical="top"
          />
          
          <TouchableOpacity 
            style={styles.attachButton}
            onPress={() => setShowFilePicker(true)}
          >
            <Paperclip size={20} color={theme.primary} />
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.attachButton}
            onPress={() => setShowStickerGifPicker(true)}
          >
            <Smile size={20} color={theme.primary} />
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.sendButton}
            onPress={handleSendMessage}
          >
            <Send size={20} color="white" />
          </TouchableOpacity>
        </View>
      </View>

      <FilePickerModal
        visible={showFilePicker}
        onClose={() => setShowFilePicker(false)}
        onFileSelected={handleFileSelection}
        allowMultiple={true}
      />

      <StickerGifPicker
        visible={showStickerGifPicker}
        onClose={() => setShowStickerGifPicker(false)}
        onSelectSticker={handleStickerSelect}
        onSelectGif={handleGifSelect}
      />
    </View>
  );
}
