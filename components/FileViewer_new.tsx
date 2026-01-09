import { logger } from '@/lib/logger';
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Linking } from 'react-native';
import { Download, Share, ExternalLink, Eye } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import StyledText from './StyledText';
import { 
  getFileTypeInfo, 
  formatFileSize, 
  isAudioFile, 
  isPdfFile, 
  isCodeFile, 
  isImageFile, 
  isVideoFile 
} from '../lib/fileUtils';
// import { AudioPlayer } from './AudioPlayer'; // Temporarily disabled due to issues
import { PdfViewer } from './PdfViewer';
import { CodeViewer } from './CodeViewer';
// import VideoPlayer from './VideoPlayer'; // Temporarily disabled due to issues
import { ShareModal } from './ShareModal';

interface FileViewerProps {
  fileUrl: string;
  fileName: string;
  fileType: string;
  fileSize?: number;
  onDownload?: () => void;
  onShare?: () => void;
  messageText?: string; // Add message text prop
  isOwnMessage?: boolean; // Add message ownership prop
  theme?: any; // Add theme prop for consistent styling
}

export function FileViewer({ 
  fileUrl, 
  fileName, 
  fileType, 
  fileSize, 
  onDownload, 
  onShare,
  messageText,
  isOwnMessage = false,
  theme: propTheme 
}: FileViewerProps) {
  const { theme } = useTheme();
  const effectiveTheme = propTheme || theme;
  const fileInfo = getFileTypeInfo(fileType, fileName);

  // For audio files, use the audio player
  if (isAudioFile(fileType, fileName)) {
    return (
      <View>
        {/* Message text above audio player (if present) */}
        {messageText && messageText.trim().length > 0 && (
          <View style={{ marginBottom: 8 }}>
            <StyledText
              text={messageText}
              style={[{ 
                color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.text,
                fontSize: 16,
                lineHeight: 22,
                textAlign: isOwnMessage ? 'right' : 'left'
              }]}
              linkStyle={{
                color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.primary,
                fontWeight: '600'
              }}
            />
          </View>
        )}
        {/* AudioPlayer temporarily disabled due to issues */}
        <View style={{ 
          backgroundColor: effectiveTheme.surface, 
          borderRadius: 12, 
          padding: 16, 
          marginVertical: 4,
          borderWidth: 1,
          borderColor: effectiveTheme.border
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ 
              width: 40, 
              height: 40, 
              borderRadius: 20, 
              backgroundColor: effectiveTheme.primary + '20',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 12
            }}>
              <Download size={20} color={effectiveTheme.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[{ color: effectiveTheme.text, fontSize: 14, fontWeight: '600' }]} numberOfLines={2}>
                {fileName || 'Audio File'}
              </Text>
              <Text style={[{ color: effectiveTheme.textSecondary, fontSize: 12 }]}>
                Audio Player Disabled - {fileSize ? formatFileSize(fileSize) : 'Unknown size'}
              </Text>
            </View>
          </View>
          {onDownload && (
            <TouchableOpacity 
              style={{ 
                backgroundColor: effectiveTheme.primary,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                marginTop: 12,
                alignItems: 'center'
              }}
              onPress={onDownload}
            >
              <Text style={{ color: 'white', fontSize: 14, fontWeight: '600' }}>Download Audio</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // For PDF files, use the PDF viewer
  if (isPdfFile(fileType, fileName)) {
    return (
      <PdfViewer
        fileUrl={fileUrl}
        fileName={fileName}
        fileSize={fileSize}
        onDownload={onDownload}
        onShare={onShare}
      />
    );
  }

  // For code files, use the code viewer
  if (isCodeFile(fileType, fileName)) {
    return (
      <CodeViewer
        fileUrl={fileUrl}
        fileName={fileName}
        fileSize={fileSize}
        onDownload={onDownload}
        onShare={onShare}
      />
    );
  }

  // For video files, show message text and video placeholder
  if (isVideoFile(fileType)) {
    return (
      <View>
        {/* Message text above video player (if present) */}
        {messageText && messageText.trim().length > 0 && (
          <View style={{ marginBottom: 8 }}>
            <StyledText
              text={messageText}
              style={[{ 
                color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.text,
                fontSize: 16,
                lineHeight: 22,
                textAlign: isOwnMessage ? 'right' : 'left'
              }]}
              linkStyle={{
                color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.primary,
                fontWeight: '600'
              }}
            />
          </View>
        )}
        {/* VideoPlayer temporarily disabled due to issues */}
        <View style={{ 
          backgroundColor: effectiveTheme.surface, 
          borderRadius: 12, 
          padding: 16, 
          marginVertical: 4,
          borderWidth: 1,
          borderColor: effectiveTheme.border
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ 
              width: 40, 
              height: 40, 
              borderRadius: 20, 
              backgroundColor: effectiveTheme.primary + '20',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 12
            }}>
              <Download size={20} color={effectiveTheme.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[{ color: effectiveTheme.text, fontSize: 14, fontWeight: '600' }]} numberOfLines={2}>
                {fileName || 'Video File'}
              </Text>
              <Text style={[{ color: effectiveTheme.textSecondary, fontSize: 12 }]}>
                Video Player Disabled - {fileSize ? formatFileSize(fileSize) : 'Unknown size'}
              </Text>
            </View>
          </View>
          {onDownload && (
            <TouchableOpacity 
              style={{ 
                backgroundColor: effectiveTheme.primary,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                marginTop: 12,
                alignItems: 'center'
              }}
              onPress={onDownload}
            >
              <Text style={{ color: 'white', fontSize: 14, fontWeight: '600' }}>Download Video</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // For images, show message text above the image
  if (isImageFile(fileType)) {
    return (
      <View>
        {/* Message text above image (if present) */}
        {messageText && messageText.trim().length > 0 && (
          <View style={{ marginBottom: 8 }}>
            <StyledText
              text={messageText}
              style={[{ 
                color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.text,
                fontSize: 16,
                lineHeight: 22,
                textAlign: isOwnMessage ? 'right' : 'left'
              }]}
              linkStyle={{
                color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.primary,
                fontWeight: '600'
              }}
            />
          </View>
        )}
        {/* Image file handled by chat component directly */}
        <View style={{ 
          backgroundColor: effectiveTheme.surface, 
          borderRadius: 12, 
          padding: 16, 
          marginVertical: 4,
          borderWidth: 1,
          borderColor: effectiveTheme.border
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ 
              width: 40, 
              height: 40, 
              borderRadius: 20, 
              backgroundColor: effectiveTheme.primary + '20',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 12
            }}>
              <Download size={20} color={effectiveTheme.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[{ color: effectiveTheme.text, fontSize: 14, fontWeight: '600' }]} numberOfLines={2}>
                {fileName || 'Image File'}
              </Text>
              <Text style={[{ color: effectiveTheme.textSecondary, fontSize: 12 }]}>
                {fileSize ? formatFileSize(fileSize) : 'Unknown size'}
              </Text>
            </View>
          </View>
          {onDownload && (
            <TouchableOpacity 
              style={{ 
                backgroundColor: effectiveTheme.primary,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                marginTop: 12,
                alignItems: 'center'
              }}
              onPress={onDownload}
            >
              <Text style={{ color: 'white', fontSize: 14, fontWeight: '600' }}>Download Image</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // Generic file viewer for other file types
  return (
    <View>
      {/* Message text above generic file (if present) */}
      {messageText && messageText.trim().length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <StyledText
            text={messageText}
            style={[{ 
              color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.text,
              fontSize: 16,
              lineHeight: 22,
              textAlign: isOwnMessage ? 'right' : 'left'
            }]}
            linkStyle={{
              color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : effectiveTheme.primary,
              fontWeight: '600'
            }}
          />
        </View>
      )}
      <GenericFileViewer 
        fileUrl={fileUrl}
        fileName={fileName}
        fileType={fileType}
        fileSize={fileSize}
        fileInfo={fileInfo}
        onDownload={onDownload}
        onShare={onShare}
      />
    </View>
  );
}

interface GenericFileViewerProps {
  fileUrl: string;
  fileName: string;
  fileType: string;
  fileSize?: number;
  fileInfo: ReturnType<typeof getFileTypeInfo>;
  onDownload?: () => void;
  onShare?: () => void;
}

function GenericFileViewer({ 
  fileUrl, 
  fileName, 
  fileType, 
  fileSize, 
  fileInfo,
  onDownload, 
  onShare 
}: GenericFileViewerProps) {
  const { theme } = useTheme();
  const [showShareModal, setShowShareModal] = React.useState(false);

  const handlePreview = async () => {
    try {
      await Linking.openURL(fileUrl);
    } catch (error) {
      logger.error('Error opening file:', error);
      Alert.alert('Error', 'Unable to open this file type');
    }
  };

  const handleDownload = () => {
    if (onDownload) {
      onDownload();
    } else {
      Alert.alert('Download', 'Download functionality not implemented');
    }
  };

  const handleShare = () => {
    setShowShareModal(true);
  };

  const getCategoryDescription = (category: string): string => {
    const descriptions: Record<string, string> = {
      'presentation': 'Presentation file - can be opened with presentation apps',
      'spreadsheet': 'Spreadsheet file - can be opened with spreadsheet apps',
      'database': 'Database file - requires specific database software',
      'ebook': 'E-book file - can be opened with e-book readers',
      'archive': 'Archive file - contains compressed files',
      'other': 'File can be opened with compatible applications',
    };
    return descriptions[category] || 'File can be opened with compatible applications';
  };

  const styles = StyleSheet.create({
    container: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      padding: 16,
      marginVertical: 8,
      borderWidth: 1,
      borderColor: theme.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 16,
    },
    icon: {
      marginRight: 12,
    },
    fileInfo: {
      flex: 1,
    },
    fileName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.text,
      marginBottom: 4,
    },
    fileType: {
      fontSize: 12,
      color: theme.textSecondary,
      fontWeight: '500',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    fileSize: {
      fontSize: 14,
      color: theme.textSecondary,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    primaryButton: {
      backgroundColor: fileInfo.canPreview ? theme.primary : theme.border,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
      marginRight: 8,
    },
    primaryButtonText: {
      color: fileInfo.canPreview ? 'white' : theme.textSecondary,
      fontSize: 16,
      fontWeight: '600',
      marginLeft: 8,
    },
    actionButtons: {
      flexDirection: 'row',
      gap: 8,
    },
    actionButton: {
      padding: 12,
      borderRadius: 8,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
    },
    description: {
      fontSize: 14,
      color: theme.textSecondary,
      textAlign: 'center',
      marginTop: 12,
      fontStyle: 'italic',
    },
    categoryBadge: {
      backgroundColor: fileInfo.color + '20',
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    categoryText: {
      fontSize: 12,
      color: fileInfo.color,
      fontWeight: '600',
      textTransform: 'capitalize',
    },
  });

  const IconComponent = fileInfo.icon;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <IconComponent size={24} color={fileInfo.color} style={styles.icon} />
        <View style={styles.fileInfo}>
          <Text style={styles.fileName}>{fileName}</Text>
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryText}>{fileInfo.category}</Text>
          </View>
          {fileSize && (
            <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
          )}
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity 
          style={styles.primaryButton} 
          onPress={handlePreview}
          disabled={!fileInfo.canPreview}
        >
          {fileInfo.canPreview ? (
            <Eye size={20} color="white" />
          ) : (
            <ExternalLink size={20} color={theme.textSecondary} />
          )}
          <Text style={styles.primaryButtonText}>
            {fileInfo.canPreview ? 'Open' : 'External App'}
          </Text>
        </TouchableOpacity>

        <View style={styles.actionButtons}>
          <TouchableOpacity style={styles.actionButton} onPress={handleDownload}>
            <Download size={20} color={theme.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={handleShare}>
            <Share size={20} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.description}>
        {getCategoryDescription(fileInfo.category)}
      </Text>

      <ShareModal
        visible={showShareModal}
        onClose={() => setShowShareModal(false)}
        fileUrl={fileUrl}
        fileName={fileName}
        fileSize={fileSize}
        onDownload={onDownload}
      />
    </View>
  );
}
