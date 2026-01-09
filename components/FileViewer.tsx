import { logger } from '@/lib/logger';
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Linking, Platform, Image } from 'react-native';
import { Download, Share, ExternalLink, Eye } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import {
  getFileTypeInfo,
  formatFileSize,
  isAudioFile,
  isPdfFile,
  isCodeFile,
  isImageFile,
  isVideoFile,
  getMimeTypeFromFileName,
} from '../lib/fileUtils';
import { PdfViewer } from './PdfViewer';
import { CodeViewer } from './CodeViewer';
import { ShareModal } from './ShareModal';
import { AudioPlayer } from './AudioPlayer';
import VideoPlayer from './VideoPlayer';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

const sanitizeFileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_');
const stripExtension = (name: string) => name.replace(/\.[^/.]+$/, '');
const inferExtension = (fileName: string, mimeType?: string) => {
  const trimmedName = fileName.trim();
  const extFromName = trimmedName.includes('.')
    ? trimmedName.split('.').pop()?.toLowerCase()
    : '';
  if (extFromName) return extFromName;

  const mime = (mimeType || '').toLowerCase();
  const mimeMap: Record<string, string> = {
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.oasis.opendocument.presentation': 'odp',
    'text/plain': 'txt',
    'application/rtf': 'rtf',
  };
  if (mimeMap[mime]) return mimeMap[mime];
  if (mime.includes('/')) return mime.split('/').pop() || 'bin';
  return 'bin';
};

const ANDROID_VIEW_INTENT = 'android.intent.action.VIEW';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;
const NATIVE_VIEW_CATEGORIES = new Set(['document', 'presentation', 'spreadsheet']);

interface FileViewerProps {
  fileUrl: string;
  fileName: string;
  fileType: string;
  thumbnailUrl?: string;
  isPreviewAsset?: boolean;
  fileSize?: number;
  onDownload?: () => void;
  onShare?: () => void;
  remoteFileUrl?: string;
}

export function FileViewer({
  fileUrl,
  fileName,
  fileType,
  thumbnailUrl,
  isPreviewAsset,
  fileSize,
  onDownload,
  onShare,
  remoteFileUrl,
}: FileViewerProps) {
  const { theme } = useTheme();
  const fileInfo = getFileTypeInfo(fileType, fileName);
  const downloadSource = remoteFileUrl || fileUrl;

  if (isAudioFile(fileType, fileName)) {
    return (
      <AudioPlayer
        fileUrl={fileUrl}
        fileName={fileName}
        fileSize={fileSize}
        onDownload={onDownload}
        onShare={onShare}
        shareUrl={downloadSource}
      />
    );
  }

  if (isPdfFile(fileType, fileName)) {
    return (
      <PdfViewer
        fileUrl={fileUrl}
        fileName={fileName}
        fileSize={fileSize}
        onDownload={onDownload}
        onShare={onShare}
        remoteFileUrl={downloadSource}
      />
    );
  }

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

  if (isVideoFile(fileType)) {
    return (
      <VideoPlayer
        uri={fileUrl}
        fileName={fileName}
        onDownload={onDownload}
        onShare={onShare}
        shareUrl={downloadSource}
        thumbnailUrl={thumbnailUrl}
      />
    );
  }

  if (isImageFile(fileType)) {
    return (
      <MemoizedGenericFileViewer
        fileUrl={fileUrl}
        fileName={fileName}
        fileType={fileType}
        fileSize={fileSize}
        fileInfo={fileInfo}
        onDownload={onDownload}
        onShare={onShare}
        remoteFileUrl={downloadSource}
        thumbnailUrl={thumbnailUrl}
        isPreviewAsset={isPreviewAsset}
      />
    );
  }

  return (
    <MemoizedGenericFileViewer
      fileUrl={fileUrl}
      fileName={fileName}
      fileType={fileType}
      fileSize={fileSize}
      fileInfo={fileInfo}
      onDownload={onDownload}
      onShare={onShare}
      remoteFileUrl={downloadSource}
      thumbnailUrl={thumbnailUrl}
      isPreviewAsset={isPreviewAsset}
    />
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
  thumbnailUrl?: string;
  isPreviewAsset?: boolean;
  isDisabled?: boolean;
  disabledReason?: string;
  remoteFileUrl?: string;
}

type ThemeShape = ReturnType<typeof useTheme>['theme'];

const getCategoryDescription = (category: string): string => {
  const descriptions: Record<string, string> = {
    presentation: 'Presentation file - can be opened with presentation apps',
    spreadsheet: 'Spreadsheet file - can be opened with spreadsheet apps',
    database: 'Database file - requires specific database software',
    ebook: 'E-book file - can be opened with e-book readers',
    archive: 'Archive file - contains compressed files',
    other: 'File can be opened with compatible applications',
  };
  return descriptions[category] || 'File can be opened with compatible applications';
};

const createGenericFileViewerStyles = (
  theme: ThemeShape,
  accentColor: string,
  canOpen: boolean
) =>
  StyleSheet.create({
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
    iconWrapper: {
      width: 48,
      height: 48,
      borderRadius: 12,
      overflow: 'hidden',
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: `${accentColor}1A`,
      marginRight: 12,
    },
    icon: {
      marginRight: 0,
    },
    thumbnail: {
      width: '100%',
      height: '100%',
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
      backgroundColor: canOpen ? theme.primary : theme.border,
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
      color: canOpen ? 'white' : theme.textSecondary,
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
      backgroundColor: `${accentColor}20`,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    categoryText: {
      fontSize: 12,
      color: accentColor,
      fontWeight: '600',
      textTransform: 'capitalize',
    },
    previewBadge: {
      marginTop: 4,
      alignSelf: 'flex-start',
      backgroundColor: `${theme.primary}1A`,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
    },
    previewBadgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.primary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    previewNotice: {
      marginTop: 4,
      color: theme.textSecondary,
    },
  });

const areGenericFileViewerPropsEqual = (
  prev: GenericFileViewerProps,
  next: GenericFileViewerProps
): boolean => {
  if (prev.fileUrl !== next.fileUrl) return false;
  if (prev.fileName !== next.fileName) return false;
  if (prev.fileType !== next.fileType) return false;
  if ((prev.fileSize ?? 0) !== (next.fileSize ?? 0)) return false;
  if ((prev.thumbnailUrl ?? '') !== (next.thumbnailUrl ?? '')) return false;
  if ((prev.isPreviewAsset ?? false) !== (next.isPreviewAsset ?? false)) return false;
  if ((prev.isDisabled ?? false) !== (next.isDisabled ?? false)) return false;
  if ((prev.disabledReason ?? '') !== (next.disabledReason ?? '')) return false;
  if ((prev.remoteFileUrl ?? '') !== (next.remoteFileUrl ?? '')) return false;
  if (prev.onDownload !== next.onDownload) return false;
  if (prev.onShare !== next.onShare) return false;

  const prevInfo = prev.fileInfo;
  const nextInfo = next.fileInfo;
  if (prevInfo.category !== nextInfo.category) return false;
  if (prevInfo.color !== nextInfo.color) return false;
  if (prevInfo.canPreview !== nextInfo.canPreview) return false;
  if (prevInfo.icon !== nextInfo.icon) return false;

  return true;
};

const MemoizedGenericFileViewer = React.memo(
  GenericFileViewerInner,
  areGenericFileViewerPropsEqual
);

function GenericFileViewerInner({
  fileUrl,
  fileName,
  fileType,
  fileSize,
  fileInfo,
  onDownload,
  onShare,
  thumbnailUrl,
  isPreviewAsset,
  isDisabled = false,
  disabledReason,
  remoteFileUrl,
}: GenericFileViewerProps) {
  const { theme } = useTheme();
  const [showShareModal, setShowShareModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const remoteUrl = remoteFileUrl || fileUrl;
  const previewOnly = Boolean(isPreviewAsset && remoteFileUrl && remoteFileUrl !== fileUrl);
  const canOpen = previewOnly || fileInfo.canPreview;
  const openTarget = previewOnly ? remoteUrl : fileUrl;
  const isLocalTarget = Platform.OS !== 'web' && openTarget.startsWith('file://');
  const shareUrl = isLocalTarget ? openTarget : remoteUrl;
  const [localFileUri, setLocalFileUri] = useState<string | null>(
    isLocalTarget ? openTarget : null
  );
  const shouldUseNativeIntent = Platform.OS !== 'web' && NATIVE_VIEW_CATEGORIES.has(fileInfo.category);

  useEffect(() => {
    if (openTarget.startsWith('file://')) {
      setLocalFileUri(openTarget);
    } else {
      setLocalFileUri(null);
    }
  }, [openTarget]);

  const remoteSignature = useMemo(() => {
    if (!remoteUrl) return '';
    let hash = 0;
    for (let i = 0; i < remoteUrl.length; i++) {
      hash = (hash * 31 + remoteUrl.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  }, [remoteUrl]);

  const downloadFileName = useMemo(() => {
    const baseNameRaw = stripExtension(fileName?.trim() || '') || `document-${Date.now()}`;
    const sanitizedBase = sanitizeFileName(baseNameRaw);
    const extension = inferExtension(fileName || sanitizedBase, fileType);
    const withHash = remoteSignature ? `${sanitizedBase}_${remoteSignature}` : sanitizedBase;
    return `${withHash}.${extension}`;
  }, [fileName, fileType, remoteSignature]);

  const ensureLocalFile = useCallback(async (): Promise<string> => {
    if (Platform.OS === 'web') {
      return remoteUrl;
    }

    const sourceUrl = openTarget.startsWith('file://') ? openTarget : remoteUrl;
    if (!sourceUrl) {
      throw new Error('Missing file URL');
    }

    if (sourceUrl.startsWith('file://')) {
      setLocalFileUri(sourceUrl);
      return sourceUrl;
    }

    if (localFileUri) {
      try {
        const info = await FileSystem.getInfoAsync(localFileUri);
        if (info.exists) {
          return localFileUri;
        }
      } catch (error) {
        logger.warn('Failed to inspect cached document', error);
      }
      setLocalFileUri(null);
    }

    const downloadDirectory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
    if (!downloadDirectory) {
      throw new Error('No writable directory available for downloads');
    }

    const targetPath = `${downloadDirectory}${downloadFileName}`;

    try {
      await FileSystem.deleteAsync(targetPath, { idempotent: true });
    } catch (cleanupError) {
      logger.warn('Failed to clean up previous document download', cleanupError);
    }

    const downloadResult = await FileSystem.downloadAsync(sourceUrl, targetPath);
    setLocalFileUri(downloadResult.uri);
    return downloadResult.uri;
  }, [downloadFileName, localFileUri, openTarget, remoteUrl]);

  const handleOpen = async () => {
    if (!canOpen || isDisabled) {
      if (disabledReason) {
        Alert.alert('Unavailable', disabledReason);
      }
      return;
    }

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(openTarget, '_blank', 'noopener,noreferrer');
      return;
    }

    if (!shouldUseNativeIntent) {
      try {
        const targetUri = openTarget.startsWith('file://') ? openTarget : remoteUrl;
        if (!targetUri) throw new Error('Missing file URL');
        if (targetUri.startsWith('file://')) {
          if (Platform.OS === 'android') {
            const contentUri = await FileSystem.getContentUriAsync(targetUri);
            await Linking.openURL(contentUri);
          } else {
            await Linking.openURL(targetUri);
          }
          return;
        }
        await Linking.openURL(targetUri);
      } catch (error) {
        logger.error('Error opening file:', error);
        Alert.alert('Error', 'Unable to open this file type');
      }
      return;
    }

    try {
      setIsLoading(true);
  const localUri = await ensureLocalFile();
  const inferredName = fileName || downloadFileName;
  const mimeType = fileType || getMimeTypeFromFileName(inferredName);

      if (Platform.OS === 'android') {
        const contentUri = await FileSystem.getContentUriAsync(localUri);
        try {
          await IntentLauncher.startActivityAsync(ANDROID_VIEW_INTENT, {
            data: contentUri,
            type: mimeType || 'application/octet-stream',
            flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
          });
        } catch (intentError) {
          logger.warn('Document intent launch failed, falling back to Linking', intentError);
          await Linking.openURL(contentUri);
        }
        return;
      }

      await Linking.openURL(localUri);
    } catch (error) {
      logger.error('Error opening file:', error);
      Alert.alert('Error', 'Unable to open this file type');
    } finally {
      setIsLoading(false);
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
  const styles = useMemo(
    () => createGenericFileViewerStyles(theme, fileInfo.color, canOpen && !isDisabled),
    [theme, fileInfo.color, canOpen, isDisabled]
  );

  const IconComponent = fileInfo.icon;
  const PrimaryIcon = canOpen ? Eye : ExternalLink;
  const primaryLabel = previewOnly ? 'Preview Remote' : canOpen ? 'Open' : 'External App';
  const descriptionText = previewOnly
    ? 'Preview cached while the original file downloads in the background.'
    : getCategoryDescription(fileInfo.category);
  const isPrimaryDisabled = !canOpen || isDisabled || isLoading;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.iconWrapper}>
          {thumbnailUrl ? (
            <Image source={{ uri: thumbnailUrl }} style={styles.thumbnail} resizeMode="cover" />
          ) : (
            <IconComponent size={24} color={fileInfo.color} style={styles.icon} />
          )}
        </View>
        <View style={styles.fileInfo}>
          <Text style={styles.fileName}>{fileName}</Text>
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryText}>{fileInfo.category}</Text>
          </View>
          {previewOnly && (
            <View style={styles.previewBadge}>
              <Text style={styles.previewBadgeText}>Preview</Text>
            </View>
          )}
          {isDisabled && disabledReason && (
            <Text style={[styles.fileSize, { fontStyle: 'italic' }]}>{disabledReason}</Text>
          )}
          {previewOnly && (
            <Text style={[styles.fileSize, styles.previewNotice]}>
              Preview ready. Opening loads the latest remote file.
            </Text>
          )}
          {fileSize && <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>}
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handleOpen}
          disabled={isPrimaryDisabled}
        >
          <PrimaryIcon size={20} color={isPrimaryDisabled ? theme.textSecondary : 'white'} />
          <Text style={styles.primaryButtonText}>{isLoading ? 'Opening...' : primaryLabel}</Text>
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

      <Text style={styles.description}>{descriptionText}</Text>

      <ShareModal
        visible={showShareModal}
        onClose={() => setShowShareModal(false)}
        fileUrl={shareUrl}
        fileName={fileName}
        fileSize={fileSize}
        onDownload={onDownload}
      />
    </View>
  );
}
