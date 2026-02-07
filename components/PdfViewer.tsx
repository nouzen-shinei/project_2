import { logger } from '@/lib/logger';
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Linking, Platform, ActivityIndicator } from 'react-native';
import { FileText, Download, Share, ExternalLink } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { formatFileSize } from '../lib/fileUtils';
import { ShareModal } from './ShareModal';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { PdfNativeRenderer } from './PdfNativeRenderer';

const sanitizeFileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_');
const ensurePdfExtension = (name: string) =>
  name.trim().toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
const ANDROID_VIEW_INTENT = 'android.intent.action.VIEW';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

interface PdfViewerProps {
  fileUrl: string;
  fileName: string;
  fileSize?: number;
  onDownload?: () => void;
  onShare?: () => void;
  remoteFileUrl?: string;
  previewHeight?: number;
}

type ThemeShape = ReturnType<typeof useTheme>['theme'];

const createPdfViewerStyles = (theme: ThemeShape, previewHeight: number) =>
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
    fileSize: {
      fontSize: 14,
      color: theme.textSecondary,
    },
    fileType: {
      fontSize: 12,
      color: theme.textSecondary,
      fontWeight: '500',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 12,
    },
    primaryButton: {
      backgroundColor: theme.primary,
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
      color: 'white',
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
    previewContainer: {
      marginTop: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    previewFrame: {
      width: '100%',
      // maxWidth: 620,
      height: previewHeight,
      borderRadius: 12,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.background,
    },
    previewLoading: {
      width: '100%',
      // maxWidth: 620,
      height: previewHeight,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    description: {
      fontSize: 14,
      color: theme.textSecondary,
      textAlign: 'center',
      marginTop: 8,
      fontStyle: 'italic',
    },
  });

const arePdfViewerPropsEqual = (prev: PdfViewerProps, next: PdfViewerProps) => {
  if (prev.fileUrl !== next.fileUrl) return false;
  if (prev.fileName !== next.fileName) return false;
  if ((prev.fileSize ?? 0) !== (next.fileSize ?? 0)) return false;
  if ((prev.remoteFileUrl ?? '') !== (next.remoteFileUrl ?? '')) return false;
  if ((prev.previewHeight ?? 0) !== (next.previewHeight ?? 0)) return false;
  if (prev.onDownload !== next.onDownload) return false;
  if (prev.onShare !== next.onShare) return false;
  return true;
};

function PdfViewerInner({ 
  fileUrl, 
  fileName, 
  fileSize, 
  onDownload, 
  onShare,
  remoteFileUrl,
  previewHeight = 100,
}: PdfViewerProps) {
  const { theme } = useTheme();
  const isWeb = Platform.OS === 'web';
  const [isLoading, setIsLoading] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const isLocalFile = Platform.OS !== 'web' && fileUrl.startsWith('file://');
  const remoteUrl = remoteFileUrl || fileUrl;
  const shareUrl = isLocalFile ? fileUrl : remoteUrl;
  const [localFileUri, setLocalFileUri] = useState<string | null>(
    isLocalFile ? fileUrl : null
  );
  const [inlineUri, setInlineUri] = useState<string | null>(null);
  

  useEffect(() => {
    if (isLocalFile) {
      setLocalFileUri(fileUrl);
    } else {
      setLocalFileUri(null);
    }
  }, [fileUrl, isLocalFile, remoteUrl]);

  const remoteSignature = useMemo(() => {
    if (!remoteUrl) return '';
    let hash = 0;
    for (let i = 0; i < remoteUrl.length; i++) {
      hash = (hash * 31 + remoteUrl.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  }, [remoteUrl]);

  const downloadFileName = useMemo(() => {
    const rawBase = fileName?.trim().length ? fileName.trim() : `document-${Date.now()}`;
    const sanitized = sanitizeFileName(rawBase) || `document-${Date.now()}`;
    const baseWithoutExt = sanitized.replace(/\.pdf$/i, '');
    const withHash = remoteSignature ? `${baseWithoutExt}_${remoteSignature}` : baseWithoutExt;
    return ensurePdfExtension(withHash);
  }, [fileName, remoteSignature]);

  const ensureLocalFile = useCallback(async (): Promise<string> => {
    // We cache remote PDFs locally so native viewers can consume a file:// or content URI.
    if (Platform.OS === 'web') {
      return remoteUrl;
    }

    if (isLocalFile) {
      return fileUrl;
    }

    if (localFileUri) {
      try {
        const info = await FileSystem.getInfoAsync(localFileUri);
        if (info.exists) {
          return localFileUri;
        }
      } catch (infoError) {
        logger.warn('Failed to inspect cached PDF', infoError);
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
    } catch (deleteError) {
      logger.warn('Failed to clean up previous PDF download', deleteError);
    }

    const downloadResult = await FileSystem.downloadAsync(remoteUrl, targetPath);
    setLocalFileUri(downloadResult.uri);
    return downloadResult.uri;
  }, [downloadFileName, fileUrl, isLocalFile, localFileUri, remoteUrl]);

  useEffect(() => {
    let cancelled = false;

    const loadInline = async () => {
      if (Platform.OS === 'web') {
        setInlineUri(remoteUrl);
        return;
      }

      try {
        const localUri = await ensureLocalFile();
        if (!cancelled) {
          setInlineUri(localUri);
        }
      } catch (error) {
        logger.error('PdfViewer: inline preview failed', error);
        if (!cancelled) {
          setInlineUri(remoteUrl);
        }
      }
    };

    void loadInline();

    return () => {
      cancelled = true;
    };
  }, [ensureLocalFile, remoteUrl]);

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

  const handleOpenExternal = async () => {
    try {
      setIsLoading(true);
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.open(remoteUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      const localUri = isLocalFile ? fileUrl : await ensureLocalFile();

      if (Platform.OS === 'android') {
        const contentUri = await FileSystem.getContentUriAsync(localUri);
        await IntentLauncher.startActivityAsync(ANDROID_VIEW_INTENT, {
          data: contentUri,
          flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
          type: 'application/pdf',
        });
        return;
      }

      await Linking.openURL(localUri);
    } catch (error) {
      logger.error('Error opening external URL:', error);
      Alert.alert('Error', 'Unable to open PDF in external app');
    } finally {
      setIsLoading(false);
    }
  };

  const styles = useMemo(() => createPdfViewerStyles(theme, previewHeight), [theme, previewHeight]);
  const IFrame = useMemo(() => ('iframe' as any), []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <FileText size={24} color="#DC2626" style={styles.icon} />
        <View style={styles.fileInfo}>
          <Text style={styles.fileName}>{fileName}</Text>
          <Text style={styles.fileType}>PDF Document</Text>
          {fileSize && (
            <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
          )}
        </View>
      </View>

      <View style={styles.previewContainer}>
        {inlineUri ? (
          isWeb ? (
            <View style={styles.previewFrame}>
              <IFrame
                src={remoteUrl}
                title={fileName}
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            </View>
          ) : (
            <PdfNativeRenderer
              uri={inlineUri}
              style={styles.previewFrame}
              loadingColor={theme.textSecondary}
              onError={(error: unknown) => {
                logger.error('PdfViewer: native render failed', error);
              }}
            />
          )
        ) : (
          <View style={styles.previewLoading}>
            <ActivityIndicator size="small" color={theme.textSecondary} />
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <TouchableOpacity 
          style={styles.primaryButton}
          onPress={handleOpenExternal}
          disabled={isLoading}
        >
          <ExternalLink size={20} color="white" />
          <Text style={styles.primaryButtonText}>
            {isLoading ? 'Opening...' : 'Open external'}
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
        PDF preview is shown inline. Open externally for full reader controls.
      </Text>

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

export const PdfViewer = React.memo(PdfViewerInner, arePdfViewerPropsEqual);
