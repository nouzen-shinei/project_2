import React from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, SafeAreaView, TextInput, Image, StyleSheet, Platform } from 'react-native';
import { X, Trash2, Send, File as FileIcon } from 'lucide-react-native';
import VideoPlayer from '../VideoPlayer';
import { isImageFile, isVideoFile } from '../../lib/fileUtils';

const CHAT_MESSAGE_MAX_CHARS = 500;

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

interface ChatFilePreviewModalProps {
  visible: boolean;
  onClose: () => void;
  selectedFiles: any[];
  skippedPreviewFiles: any[];
  groupedSkippedPreviewFiles: {
    folder: string[];
    duplicate: string[];
    tooLarge: string[];
    other: string[];
  };
  message: string;
  onTyping: (text: string) => void;
  isUploading: boolean;
  easedUploadProgress: number;
  onSendWithFiles: () => void;
  onRemoveFile: (index: number) => () => void;
  theme: {
    surface: string;
    text: string;
    primary: string;
    background: string;
    textSecondary: string;
    border: string;
    error: string;
    [key: string]: any;
  };
}

export const ChatFilePreviewModal: React.FC<ChatFilePreviewModalProps> = ({
  visible,
  onClose,
  selectedFiles,
  skippedPreviewFiles,
  groupedSkippedPreviewFiles,
  message,
  onTyping,
  isUploading,
  easedUploadProgress,
  onSendWithFiles,
  onRemoveFile,
  theme,
}) => {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.filePreviewOverlay}>
        <SafeAreaView style={styles.filePreviewContainer}>
          <View style={[styles.filePreviewHeader, { backgroundColor: theme.surface }]}>
            <Text style={[styles.filePreviewTitle, { color: theme.text }]}>
              Preview Files ({selectedFiles.length})
            </Text>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeButton}
            >
              <X size={24} color={theme.text} />
            </TouchableOpacity>
          </View>

          {skippedPreviewFiles.length > 0 && (
            <View style={styles.skippedPreviewContainer}>
              <Text style={styles.skippedPreviewTitle}>
                Skipped while adding files ({skippedPreviewFiles.length})
              </Text>
              <ScrollView style={styles.skippedPreviewScrollView} nestedScrollEnabled>
                {groupedSkippedPreviewFiles.folder.length > 0 && (
                  <>
                    <Text style={[styles.skippedPreviewGroupTitle, { marginTop: 2 }]}>
                      Folders ({groupedSkippedPreviewFiles.folder.length})
                    </Text>
                    {groupedSkippedPreviewFiles.folder.map((entry, idx) => (
                      <Text key={`folder_${entry}_${idx}`} style={styles.skippedPreviewGroupItem} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
                {groupedSkippedPreviewFiles.duplicate.length > 0 && (
                  <>
                    <Text style={styles.skippedPreviewGroupTitle}>
                      Duplicates ({groupedSkippedPreviewFiles.duplicate.length})
                    </Text>
                    {groupedSkippedPreviewFiles.duplicate.map((entry, idx) => (
                      <Text key={`duplicate_${entry}_${idx}`} style={styles.skippedPreviewGroupItem} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
                {groupedSkippedPreviewFiles.tooLarge.length > 0 && (
                  <>
                    <Text style={styles.skippedPreviewGroupTitle}>
                      Too Large ({groupedSkippedPreviewFiles.tooLarge.length})
                    </Text>
                    {groupedSkippedPreviewFiles.tooLarge.map((entry, idx) => (
                      <Text key={`too_large_${entry}_${idx}`} style={styles.skippedPreviewGroupItem} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
                {groupedSkippedPreviewFiles.other.length > 0 && (
                  <>
                    <Text style={styles.skippedPreviewGroupTitle}>
                      Other ({groupedSkippedPreviewFiles.other.length})
                    </Text>
                    {groupedSkippedPreviewFiles.other.map((entry, idx) => (
                      <Text key={`other_${entry}_${idx}`} style={styles.skippedPreviewGroupItem} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
              </ScrollView>
            </View>
          )}

          <ScrollView
            style={styles.filePreviewContent}
            contentContainerStyle={{ paddingBottom: Platform.select({ web: 0, default: 20 }) }}
          >
            {selectedFiles.map((file, index) => {
              const mimeType = String(file.mimeType || file.type || file.fileType || '').toLowerCase();
              const safePreviewNameCandidate = String(file.fileName || file.name || 'Unknown file').trim();
              const safePreviewName = !safePreviewNameCandidate || safePreviewNameCandidate === '.'
                ? 'Unknown file'
                : safePreviewNameCandidate;
              const fileSizeValue = file.fileSize || file.size;
              const isImage = isImageFile(mimeType, safePreviewName);
              const isVideo = isVideoFile(mimeType, safePreviewName);
              const previewImageUri = String(file.previewUri || file.uri || '');
              const thumbnailUri = file.thumbnail || file.preview || file.poster || null;

              return (
                <View key={index} style={[styles.filePreviewItem, { backgroundColor: theme.background }]}>
                  <View style={[styles.filePreviewInfo, isVideo ? styles.filePreviewInfoVideo : null]}>
                    {isImage && previewImageUri ? (
                      <Image source={{ uri: previewImageUri }} style={styles.previewImage} />
                    ) : isVideo ? (
                      <View style={styles.videoPreviewContainer}>
                        <VideoPlayer
                          uri={file.uri}
                          fileName={safePreviewName}
                          thumbnailUrl={thumbnailUri || undefined}
                          style={styles.videoPreviewPlayer}
                          maxHeight={140}
                          controlVariant="minimal"
                        />
                      </View>
                    ) : (
                      <View style={styles.fileIconContainer}>
                        <FileIcon size={32} color={theme.primary} />
                      </View>
                    )}
                    <View style={styles.filePreviewDetails}>
                      <Text style={[styles.previewFileName, { color: theme.text }]} numberOfLines={2}>
                        {safePreviewName}
                      </Text>
                      {fileSizeValue ? (
                        <Text style={[styles.previewFileSize, { color: theme.textSecondary }]}>
                          {formatFileSize(fileSizeValue)}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={onRemoveFile(index)}
                    style={styles.removeFileButton}
                  >
                    <Trash2 size={20} color={theme.error} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>

          <View style={[styles.filePreviewFooter, { backgroundColor: theme.surface }]}>
            <TextInput
              style={[styles.previewMessageInput, { 
                backgroundColor: theme.background, 
                borderColor: theme.border,
                color: theme.text 
              }]}
              value={message}
              onChangeText={onTyping}
              placeholder="Add a message (optional)..."
              placeholderTextColor={theme.textSecondary}
              multiline
              numberOfLines={3}
              maxLength={CHAT_MESSAGE_MAX_CHARS}
            />
            
            {isUploading ? (
              <View style={styles.uploadProgressContainer}>
                <Text style={[styles.uploadProgressText, { color: theme.text }]}>
                  Uploading... {Math.round(easedUploadProgress)}%
                </Text>
                <View style={[styles.progressBar, { backgroundColor: theme.border }]}>
                  <View 
                    style={[
                      styles.progressFill, 
                      { 
                        backgroundColor: theme.primary,
                        width: `${easedUploadProgress}%`
                      }
                    ]} 
                  />
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.sendFilesButton, { backgroundColor: theme.primary }]}
                onPress={onSendWithFiles}
                disabled={selectedFiles.length === 0}
              >
                <Send size={20} color="#ffffff" />
                <Text style={styles.sendFilesButtonText}>
                  Send {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  filePreviewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
  },
  filePreviewContainer: {
    flex: 1,
  },
  filePreviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  filePreviewTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  closeButton: {
    padding: 8,
  },
  filePreviewContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  filePreviewItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    borderRadius: 12,
    elevation: 2,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)'
    } : {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
    }),
  },
  filePreviewInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  filePreviewInfoVideo: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  previewImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
    marginRight: 12,
  },
  videoPreviewContainer: {
    width: '100%',
    marginBottom: 8,
  },
  videoPreviewPlayer: {
    width: '100%',
    borderRadius: 8,
    overflow: 'hidden',
  },
  fileIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  filePreviewDetails: {
    flex: 1,
  },
  previewFileName: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginBottom: 4,
  },
  previewFileSize: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  removeFileButton: {
    padding: 8,
    marginLeft: 8,
  },
  filePreviewFooter: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  previewMessageInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    maxHeight: 100,
    textAlignVertical: 'top',
  },
  uploadProgressContainer: {
    marginVertical: 16,
  },
  uploadProgressText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
    marginBottom: 8,
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  sendFilesButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  sendFilesButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 8,
  },
  skippedPreviewContainer: {
    marginHorizontal: 20,
    marginTop: 10,
    backgroundColor: '#FFFBEB',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  skippedPreviewTitle: {
    color: '#92400E',
    fontWeight: '600',
    fontSize: 13,
    marginBottom: 4,
  },
  skippedPreviewScrollView: {
    maxHeight: 140,
  },
  skippedPreviewGroupTitle: {
    color: '#92400E',
    fontWeight: '700',
    fontSize: 12,
    marginTop: 6,
    marginBottom: 2,
  },
  skippedPreviewGroupItem: {
    color: '#B45309',
    fontSize: 12,
  },
});
