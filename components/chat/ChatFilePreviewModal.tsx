import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, SafeAreaView, TextInput, Image, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { X, Trash2, Send, File as FileIcon, Music, Play, Pause } from 'lucide-react-native';
import VideoPlayer from '../VideoPlayer';
import { isImageFile, isVideoFile, isAudioFile } from '../../lib/fileUtils';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';

const CHAT_MESSAGE_MAX_CHARS = 500;
const MAX_CHAT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatDuration = (seconds: number): string => {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

interface ChatFilePreviewModalProps {
  visible: boolean;
  onClose: () => void;
  selectedFiles: any[];
  skippedPreviewFiles: any[];
  groupedSkippedPreviewFiles: {
    folder: string[];
    duplicate: string[];
    tooLarge: { name: string; fileSize: number }[];
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

// ---------------------------------------------------------------------------
// ImagePreview — renders image URIs including blob: object URLs.
// blob: images work once img-src in the CSP includes 'blob:'.
// Uses RN Image on native; on web RN Web translates Image → <img> natively.
// ---------------------------------------------------------------------------
function ImagePreview({ uri, theme }: { uri: string; theme: any }) {
  const [errored, setErrored] = useState(false);

  if (!uri || errored) {
    return (
      <View style={[styles.fileIconContainer, { marginRight: 12 }]}>
        <FileIcon size={32} color={theme.primary} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={styles.previewImage}
      resizeMode="cover"
      onError={() => setErrored(true)}
    />
  );
}

// ---------------------------------------------------------------------------
// PreviewAudioPlayer — compact audio player that matches the video thumbnail
// footprint (~140 px tall). Uses expo-video under the hood, same as AudioPlayer.
// ---------------------------------------------------------------------------
const PreviewAudioPlayer = React.memo(function PreviewAudioPlayer({
  uri,
}: {
  uri: string;
}) {
  const [hasEnded, setHasEnded] = useState(false);

  const player = useVideoPlayer(uri || null, (p) => {
    p.loop = false;
    p.muted = false;
    p.timeUpdateEventInterval = 0.25;
  });

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const timeUpdate = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime ?? 0,
    bufferedPosition: player.bufferedPosition ?? 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  const position = useMemo(() => {
    const t = timeUpdate.currentTime ?? 0;
    return Number.isFinite(t) && t >= 0 ? t : 0;
  }, [timeUpdate]);

  const duration = useMemo(() => {
    const d = player.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, status, timeUpdate]);

  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const isLoading = status === 'loading';

  // Pause + release when unmounted
  useEffect(() => {
    return () => {
      try { player.pause(); } catch { /* ignore */ }
    };
  }, [player]);

  // Detect end-of-track
  useEffect(() => {
    if (!isPlaying && duration > 0 && position >= Math.max(0, duration - 0.1)) {
      setHasEnded(true);
    }
  }, [isPlaying, position, duration]);

  const toggle = useCallback(() => {
    if (isPlaying) { player.pause(); return; }
    if (hasEnded) { player.currentTime = 0; setHasEnded(false); }
    player.play();
  }, [isPlaying, hasEnded, player]);

  const fmt = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <View style={previewAudioStyles.container}>
      {/* expo-video requires a VideoView even for audio — keep it zero-size */}
      <VideoView
        player={player as any}
        nativeControls={false}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
        style={previewAudioStyles.hiddenVideo}
      />

      {/* Decorative background icon */}
      <Music size={80} color="rgba(139,92,246,0.18)" style={previewAudioStyles.bgIcon} />

      {/* Centred play / pause button — mirrors the video thumbnail overlay */}
      <TouchableOpacity
        onPress={toggle}
        style={previewAudioStyles.playBtn}
        disabled={isLoading}
        activeOpacity={0.8}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color="white" />
        ) : isPlaying ? (
          <Pause size={22} color="white" />
        ) : (
          <Play size={26} color="white" />
        )}
      </TouchableOpacity>

      {/* Thin progress bar + time labels pinned to the bottom */}
      <View style={previewAudioStyles.bottom}>
        <View style={previewAudioStyles.progressTrack}>
          <View style={[previewAudioStyles.progressFill, { width: `${progress}%` as any }]} />
        </View>
        <View style={previewAudioStyles.timeRow}>
          <Text style={previewAudioStyles.timeText}>{fmt(position)}</Text>
          <Text style={previewAudioStyles.timeText}>{duration > 0 ? fmt(duration) : '--:--'}</Text>
        </View>
      </View>
    </View>
  );
});

// Extracts the playback duration of a local media URI on web via a hidden
// HTMLMediaElement. Resolves to 0 on error or if not on web.
function getMediaDurationWeb(uri: string): Promise<number> {
  return new Promise((resolve) => {
    if (Platform.OS !== 'web' || !uri) {
      resolve(0);
      return;
    }
    const el = document.createElement('video');
    el.preload = 'metadata';
    const timeout = setTimeout(() => {
      el.src = '';
      resolve(0);
    }, 6000);
    el.onloadedmetadata = () => {
      clearTimeout(timeout);
      resolve(isFinite(el.duration) && el.duration > 0 ? el.duration : 0);
      el.src = '';
    };
    el.onerror = () => {
      clearTimeout(timeout);
      resolve(0);
    };
    el.src = uri;
  });
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
  // Durations extracted from media files (not provided by the file picker)
  const [mediaDurations, setMediaDurations] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!visible) return;
    // Reset whenever the file list changes
    setMediaDurations({});

    let cancelled = false;
    const extract = async () => {
      const result: Record<number, number> = {};
      for (let i = 0; i < selectedFiles.length; i++) {
        if (cancelled) break;
        const file = selectedFiles[i];
        const mimeType = String(file.mimeType || file.type || file.fileType || '').toLowerCase();
        const name = String(file.fileName || file.name || '');
        // Use file-provided duration first; otherwise probe via HTML5 media element
        if (file.duration && file.duration > 0) {
          result[i] = file.duration;
        } else if (isVideoFile(mimeType, name) || isAudioFile(mimeType, name)) {
          const uri = String(file.uri || file.previewUri || '');
          const dur = await getMediaDurationWeb(uri);
          if (dur > 0) result[i] = dur;
        }
      }
      if (!cancelled) setMediaDurations(result);
    };
    extract();
    return () => { cancelled = true; };
  }, [visible, selectedFiles]);
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
                      Too Large — max {formatFileSize(MAX_CHAT_FILE_SIZE)} ({groupedSkippedPreviewFiles.tooLarge.length})
                    </Text>
                    {groupedSkippedPreviewFiles.tooLarge.map((entry, idx) => (
                      <View key={`too_large_${idx}`} style={styles.skippedTooLargeItem}>
                        <Text style={styles.skippedPreviewGroupItem} numberOfLines={1}>
                          • {entry.name}
                        </Text>
                        {entry.fileSize > 0 && (
                          <View style={styles.skippedTooLargeSizeRow}>
                            <Text style={styles.skippedTooLargeSizeLabel}>Size: </Text>
                            <Text style={styles.skippedTooLargeSizeValue}>
                              {formatFileSize(entry.fileSize)}
                            </Text>
                            <Text style={styles.skippedTooLargeSizeLabel}>  ·  Limit: </Text>
                            <Text style={styles.skippedTooLargeSizeLimit}>
                              {formatFileSize(MAX_CHAT_FILE_SIZE)}
                            </Text>
                          </View>
                        )}
                      </View>
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
              const durationValue: number | null | undefined = mediaDurations[index] ?? file.duration;
              const isImage = isImageFile(mimeType, safePreviewName);
              const isVideo = isVideoFile(mimeType, safePreviewName);
              const isAudio = isAudioFile(mimeType, safePreviewName);
              const previewImageUri = String(file.previewUri || file.uri || '');
              const thumbnailUri = file.thumbnail || file.preview || file.poster || null;

              // Build the metadata string: size · duration
              const metaParts: string[] = [];
              if (fileSizeValue) metaParts.push(formatFileSize(fileSizeValue));
              if ((isVideo || isAudio) && durationValue && durationValue > 0) metaParts.push(formatDuration(durationValue));
              const metaString = metaParts.join('  ·  ');

              return (
                <View key={index} style={[styles.filePreviewItem, { backgroundColor: theme.background }]}>
                  <View style={[styles.filePreviewInfo, (isVideo || isAudio) ? styles.filePreviewInfoVideo : null]}>
                    {isImage && previewImageUri ? (
                      <ImagePreview uri={previewImageUri} theme={theme} />
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
                    ) : isAudio ? (
                      <View style={styles.audioPreviewContainer}>
                        <PreviewAudioPlayer
                          uri={file.uri}
                        />
                      </View>
                    ) : (
                      <View style={styles.fileIconContainer}>
                        <FileIcon size={32} color={theme.primary} />
                      </View>
                    )}
                    {/* Show filename + size below every file type, same pattern as video */}
                    <View style={styles.filePreviewDetails}>
                      <Text style={[styles.previewFileName, { color: theme.text }]} numberOfLines={2}>
                        {safePreviewName}
                      </Text>
                      {metaString ? (
                        <Text style={[styles.previewFileSize, { color: theme.textSecondary }]}>
                          {metaString}
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
  audioPreviewContainer: {
    maxWidth: 360,
    width: '100%',
    marginBottom: 4,
    alignSelf: 'flex-start',
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
  skippedTooLargeItem: {
    marginBottom: 6,
  },
  skippedTooLargeSizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
    marginTop: 2,
  },
  skippedTooLargeSizeLabel: {
    color: '#B45309',
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },
  skippedTooLargeSizeValue: {
    color: '#DC2626',
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  skippedTooLargeSizeLimit: {
    color: '#92400E',
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },
});

const previewAudioStyles = StyleSheet.create({
  container: {
    width: '100%',
    height: 140,
    borderRadius: 8,
    backgroundColor: 'rgba(139,92,246,0.12)',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hiddenVideo: {
    width: 0,
    height: 0,
    position: 'absolute',
  },
  bgIcon: {
    position: 'absolute',
    opacity: 1,
  },
  playBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  progressTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 4,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#8B5CF6',
    borderRadius: 2,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.7)',
    fontFamily: 'Inter-Regular',
  },
});
