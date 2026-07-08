import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Dimensions, TouchableOpacity, Modal } from 'react-native';
import ProgressiveImage from './ui/ProgressiveImage';
import { HydratedChatMessage, chatCacheService } from '../services/chatCacheService';
import { useTheme } from '../hooks/useTheme';
import { FileViewer } from './FileViewer';
import { 
  getFileTypeInfo, 
  isAudioFile, 
  isPdfFile, 
  isCodeFile, 
  isImageFile, 
  isVideoFile 
} from '../lib/fileUtils';
import { formatMessageTimestamp } from '../lib/timeUtils';
import { useRenderTracker } from '../hooks/useRenderTracker';

interface EnhancedMessageRendererProps {
  message: HydratedChatMessage;
  onDownloadFile?: (url: string, fileName: string, localHint?: string) => void;
  onShareFile?: (url: string, fileName: string) => void;
}

type ThemeShape = ReturnType<typeof useTheme>['theme'];

function EnhancedMessageRendererInner({ 
  message, 
  onDownloadFile, 
  onShareFile 
}: EnhancedMessageRendererProps) {
  const { theme } = useTheme();
  const [gifModalVisible, setGifModalVisible] = useState(false);
  const [resolvedStickerUri, setResolvedStickerUri] = useState<string | null>(null);
  const [resolvedGifUri, setResolvedGifUri] = useState<string | null>(null);

  useRenderTracker({ tag: 'EnhancedMessageRenderer', key: message.id });

  // Debug logging for stickers and GIFs
  useEffect(() => {
    // Removed debug logs for cleaner console output
  }, [message]);

  const handleDownload = (url: string, fileName: string, localHint?: string) => {
    if (onDownloadFile) {
      onDownloadFile(url, fileName, localHint);
    }
  };

  const handleShare = (url: string, fileName: string) => {
    if (onShareFile) {
      onShareFile(url, fileName);
    }
  };

  // Sticker/GIF URLs from the configured provider (Giphy/Klipy) are already
  // direct, playable CDN URLs — no per-render resolution is needed. We still
  // route them through the local media cache so repeat views load instantly
  // and work offline.
  useEffect(() => {
    let cancelled = false;
    const hydrateSticker = async () => {
      if (!message.sticker?.url) {
        setResolvedStickerUri(null);
        return;
      }

      const originalUrl = message.sticker.url;
      setResolvedStickerUri(originalUrl);

      try {
        const localUri = await chatCacheService.getMediaForDownload(originalUrl, message.sticker?.name, undefined, 'normal');
        if (!cancelled) {
          setResolvedStickerUri(localUri || originalUrl);
        }
      } catch {
        if (!cancelled) {
          setResolvedStickerUri(originalUrl);
        }
      }
    };

    hydrateSticker();
    return () => {
      cancelled = true;
    };
  }, [message.sticker?.url, message.sticker?.name]);

  useEffect(() => {
    let cancelled = false;

    const hydrateGif = async () => {
      if (!message.gif?.url) {
        setResolvedGifUri(null);
        return;
      }

      const originalUrl = message.gif.url;
      setResolvedGifUri(originalUrl);

      try {
        const localUri = await chatCacheService.getMediaForDownload(
          originalUrl,
          message.gif?.title || message.gif?.source,
          undefined,
          'normal'
        );
        if (!cancelled) {
          setResolvedGifUri(localUri || originalUrl);
        }
      } catch {
        if (!cancelled) {
          setResolvedGifUri(originalUrl);
        }
      }
    };

    hydrateGif();

    return () => {
      cancelled = true;
    };
  }, [message.gif?.url, message.gif?.title, message.gif?.source]);

  const renderSticker = () => {
    if (!message.sticker) {
      return null;
    }

    const screenWidth = Dimensions.get('window').width;
    // Stickers should be smaller, like enhanced emojis
    const stickerSize = Math.min(screenWidth * 0.25, 120); // Max 25% of screen width or 120px

    const width = message.sticker.width ? Math.min(message.sticker.width, stickerSize) : stickerSize;
    const height = message.sticker.height ? Math.min(message.sticker.height, stickerSize) : stickerSize;
    const stickerUri = resolvedStickerUri || message.sticker.url;

    return (
      <View style={styles.stickerContainer}>
        <ProgressiveImage
          uri={stickerUri}
          style={[styles.stickerImage, { width, height }]}
          resizeMode="contain"
        />
        <View style={styles.badgeContainer}>
          <Text style={styles.badgeText}>Sticker</Text>
        </View>
      </View>
    );
  };

  const renderGif = () => {
    if (!message.gif) return null;

    const screenWidth = Dimensions.get('window').width;
    const maxWidth = screenWidth * 0.7; // Max 70% of screen width
    const maxHeight = 300; // Max height

    // Calculate display dimensions maintaining aspect ratio
    let displayWidth = message.gif.width || 300;
    let displayHeight = message.gif.height || 300;

    if (displayWidth > maxWidth) {
      const ratio = maxWidth / displayWidth;
      displayWidth = maxWidth;
      displayHeight = displayHeight * ratio;
    }

    if (displayHeight > maxHeight) {
      const ratio = maxHeight / displayHeight;
      displayHeight = maxHeight;
      displayWidth = displayWidth * ratio;
    }

    const gifUri = resolvedGifUri || message.gif.url;
    return (
      <View>
        <TouchableOpacity 
          style={styles.gifContainer}
          onPress={() => setGifModalVisible(true)}
        >
          <ProgressiveImage
            uri={gifUri}
            style={[styles.gifImage, { width: displayWidth, height: displayHeight }]}
            resizeMode="cover"
          />
          <View style={styles.badgeContainer}>
            <Text style={styles.badgeText}>GIF</Text>
          </View>
          {message.gif.title && (
            <Text style={styles.gifTitle}>{message.gif.title}</Text>
          )}
        </TouchableOpacity>

        {/* Full Screen GIF Modal */}
        <Modal
          visible={gifModalVisible}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setGifModalVisible(false)}
        >
          <View style={styles.gifModalOverlay}>
            <TouchableOpacity 
              style={styles.gifModalCloseArea}
              onPress={() => setGifModalVisible(false)}
            >
              <View style={styles.gifModalContent}>
                <ProgressiveImage uri={gifUri} style={styles.gifModalImage} resizeMode="contain" />
                {message.gif.title && (
                  <Text style={styles.gifModalTitle}>{message.gif.title}</Text>
                )}
              </View>
            </TouchableOpacity>
          </View>
        </Modal>
      </View>
    );
  };

  const renderFileAttachments = () => {
    if (message.attachments && message.attachments.length > 0) {
      return message.attachments.map((attachment, index) => (
        <FileViewer
          key={index}
          fileUrl={attachment.resolvedUrl || attachment.url}
          fileName={attachment.fileName}
          fileType={attachment.fileType}
          fileSize={attachment.fileSize}
          remoteFileUrl={attachment.url}
          thumbnailUrl={attachment.previewUri || attachment.thumbnailUrl}
          onDownload={() => handleDownload(attachment.url, attachment.fileName, attachment.resolvedUrl)}
          onShare={() => handleShare(attachment.url, attachment.fileName)}
        />
      ));
    }

    return null;
  };

  const getMessageTypeIndicator = () => {
    if (message.isSpecial) {
      return '⭐ Special';
    }

    // Don't show text indicators for stickers and GIFs since we display the actual media
    if (message.sticker || message.gif) {
      return null;
    }

    if (message.attachments && message.attachments.length > 0) {
      const fileTypes = message.attachments.map(att => {
        const fileInfo = getFileTypeInfo(att.fileType, att.fileName);
        return fileInfo.category;
      });

      const uniqueTypes = [...new Set(fileTypes)];
      if (uniqueTypes.length === 1) {
        return `📎 ${uniqueTypes[0]}`;
      } else if (uniqueTypes.length > 1) {
        return `📎 ${uniqueTypes.length} file types`;
      }
    }

    return null;
  };

  const styles = useMemo(() => createStyles(theme), [theme]);

  const typeIndicator = getMessageTypeIndicator();

  return (
    <View style={styles.container}>
      <View style={[
        styles.messageContent,
        message.isSpecial && styles.specialMessage
      ]}>
        <View style={styles.messageHeader}>
          <Text style={styles.senderText}>
            {message.sender}
            {message.isSpecial ? ' ⭐' : ''}
          </Text>
          <Text style={styles.timestampText}>
            {formatMessageTimestamp(message.timestamp)}
          </Text>
        </View>

        {message.text && message.text.trim() && (
          <Text style={styles.messageText}>{message.text}</Text>
        )}

        {typeIndicator && (
          <Text style={styles.typeIndicator}>{typeIndicator}</Text>
        )}
      </View>

      {/* Render stickers */}
      {message.sticker && renderSticker()}

      {/* Render GIFs */}
      {message.gif && renderGif()}

      {/* Render file attachments */}
      <View style={styles.filesContainer}>
        {renderFileAttachments()}
      </View>
    </View>
  );
}

const createStyles = (theme: ThemeShape) =>
  StyleSheet.create({
    container: {
      marginVertical: 4,
    },
    messageContent: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      padding: 12,
      marginBottom: 8,
    },
    messageText: {
      fontSize: 16,
      color: theme.text,
      lineHeight: 22,
    },
    messageHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    senderText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.primary,
    },
    timestampText: {
      fontSize: 12,
      color: theme.textSecondary,
    },
    typeIndicator: {
      fontSize: 12,
      color: theme.textSecondary,
      fontStyle: 'italic',
      marginTop: 4,
    },
    filesContainer: {
      marginTop: 8,
    },
    specialMessage: {
      backgroundColor: theme.warning + '20',
      borderLeftWidth: 4,
      borderLeftColor: theme.warning,
    },
    stickerContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: 8,
    },
    stickerEmoji: {
      textAlign: 'center',
    },
    stickerImage: {
      borderRadius: 8,
    },
    gifContainer: {
      alignItems: 'center',
      marginVertical: 8,
      borderRadius: 8,
      overflow: 'hidden',
    },
    gifImage: {
      borderRadius: 8,
    },
    gifTitle: {
      fontSize: 12,
      color: theme.textSecondary,
      marginTop: 4,
      textAlign: 'center',
    },
    gifModalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.9)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    gifModalCloseArea: {
      flex: 1,
      width: '100%',
      justifyContent: 'center',
      alignItems: 'center',
    },
    gifModalContent: {
      maxWidth: '90%',
      maxHeight: '90%',
      alignItems: 'center',
    },
    gifModalImage: {
      maxWidth: '100%',
      maxHeight: '100%',
    },
    gifModalTitle: {
      fontSize: 16,
      color: 'white',
      marginTop: 12,
      textAlign: 'center',
      fontWeight: '500',
    },
    badgeContainer: {
      position: 'absolute',
      bottom: 8,
      left: 8,
      backgroundColor: 'rgba(0,0,0,0.5)',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    badgeText: {
      color: 'white',
      fontSize: 10,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
  });

// Memo comparator: shallow-compare relevant message fields to avoid unnecessary re-renders
function attachmentsEqual(a?: HydratedChatMessage['attachments'], b?: HydratedChatMessage['attachments']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (!bi) return false;
    if (ai.url !== bi.url || ai.fileName !== bi.fileName || ai.fileType !== bi.fileType || (ai.fileSize ?? 0) !== (bi.fileSize ?? 0)) {
      return false;
    }
  }
  return true;
}

function stickersEqual(a?: HydratedChatMessage['sticker'], b?: HydratedChatMessage['sticker']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.url === b.url &&
    (a.width ?? 0) === (b.width ?? 0) &&
    (a.height ?? 0) === (b.height ?? 0) &&
    (a.name ?? '') === (b.name ?? '')
  );
}

function gifsEqual(a?: HydratedChatMessage['gif'], b?: HydratedChatMessage['gif']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.url === b.url &&
    (a.width ?? 0) === (b.width ?? 0) &&
    (a.height ?? 0) === (b.height ?? 0) &&
    (a.title ?? '') === (b.title ?? '')
  );
}

const areEqual = (prev: EnhancedMessageRendererProps, next: EnhancedMessageRendererProps) => {
  const pm = prev.message;
  const nm = next.message;
  if (pm === nm && prev.onDownloadFile === next.onDownloadFile && prev.onShareFile === next.onShareFile) return true;

  // Core identifiers/status
  if (pm.id !== nm.id) return false;
  if (pm.timestamp !== nm.timestamp) return false;
  if (pm.text !== nm.text) return false;
  if (pm.sender !== nm.sender) return false;
  if (pm.recipientId !== nm.recipientId) return false;
  if (pm.isSpecial !== nm.isSpecial) return false;
  if ((pm.delivered ?? false) !== (nm.delivered ?? false)) return false;
  if ((pm.read ?? false) !== (nm.read ?? false)) return false;
  if ((pm.deliveredAt ?? '') !== (nm.deliveredAt ?? '')) return false;
  if ((pm.readAt ?? '') !== (nm.readAt ?? '')) return false;

  // Single-file legacy fields
  if ((pm.fileUrl ?? '') !== (nm.fileUrl ?? '')) return false;
  if ((pm.fileName ?? '') !== (nm.fileName ?? '')) return false;
  if ((pm.fileType ?? '') !== (nm.fileType ?? '')) return false;
  if ((pm.fileSize ?? 0) !== (nm.fileSize ?? 0)) return false;

  // Multi-attachments
  if (!attachmentsEqual(pm.attachments, nm.attachments)) return false;

  // Stickers/GIFs
  if (!stickersEqual(pm.sticker, nm.sticker)) return false;
  if (!gifsEqual(pm.gif, nm.gif)) return false;

  // If we reached here, message content is effectively the same. Re-render only if handlers changed.
  return prev.onDownloadFile === next.onDownloadFile && prev.onShareFile === next.onShareFile;
};

export const EnhancedMessageRenderer = React.memo(EnhancedMessageRendererInner, areEqual);
