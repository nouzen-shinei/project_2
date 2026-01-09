import { logger } from '@/lib/logger';
import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView } from 'react-native';
import { FileCode, Eye, Download, Share, Copy } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { formatFileSize } from '../lib/fileUtils';
import * as Clipboard from 'expo-clipboard';
import { ShareModal } from './ShareModal';

interface CodeViewerProps {
  fileUrl: string;
  fileName: string;
  fileSize?: number;
  onDownload?: () => void;
  onShare?: () => void;
}

type ThemeShape = ReturnType<typeof useTheme>['theme'];

const createCodeViewerStyles = (theme: ThemeShape, showPreview: boolean) =>
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
      marginBottom: showPreview ? 16 : 0,
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
      alignItems: 'center',
    },
    actionButton: {
      padding: 12,
      borderRadius: 8,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
      marginLeft: 8,
    },
    actionButtonFirst: {
      marginLeft: 0,
    },
    previewContainer: {
      backgroundColor: '#1e1e1e',
      borderRadius: 8,
      padding: 16,
      maxHeight: 300,
    },
    previewHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    previewTitle: {
      color: '#d4d4d4',
      fontWeight: '600',
    },
    copyButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: '#2e2e2e',
      borderRadius: 6,
    },
    codeScrollView: {
      maxHeight: 260,
    },
    codeText: {
      fontFamily: 'monospace',
      fontSize: 12,
      color: '#d4d4d4',
      lineHeight: 18,
    },
    description: {
      fontSize: 14,
      color: theme.textSecondary,
      textAlign: 'center',
      marginTop: 8,
      fontStyle: 'italic',
    },
    errorText: {
      color: theme.error,
      marginTop: 8,
    },
  });

const areCodeViewerPropsEqual = (prev: CodeViewerProps, next: CodeViewerProps) => {
  if (prev.fileUrl !== next.fileUrl) return false;
  if (prev.fileName !== next.fileName) return false;
  if ((prev.fileSize ?? 0) !== (next.fileSize ?? 0)) return false;
  if (prev.onDownload !== next.onDownload) return false;
  if (prev.onShare !== next.onShare) return false;
  return true;
};

const getLanguageFromFileName = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    js: 'JavaScript',
    jsx: 'React JSX',
    ts: 'TypeScript',
    tsx: 'React TSX',
    py: 'Python',
    java: 'Java',
    cpp: 'C++',
    c: 'C',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    xml: 'XML',
    md: 'Markdown',
    yml: 'YAML',
    yaml: 'YAML',
    php: 'PHP',
    rb: 'Ruby',
    go: 'Go',
    rs: 'Rust',
    swift: 'Swift',
    kt: 'Kotlin',
  };
  return languageMap[ext] || 'Text';
};

function CodeViewerInner({ fileUrl, fileName, fileSize, onDownload, onShare }: CodeViewerProps) {
  const { theme } = useTheme();
  const [isLoading, setIsLoading] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);

  const styles = useMemo(() => createCodeViewerStyles(theme, showPreview), [theme, showPreview]);

  const loadContent = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error('Failed to fetch file content');
      }

      const text = await response.text();
      setContent(text);
      setShowPreview(true);
    } catch (err) {
      logger.error('Error loading code content:', err);
      setError('Failed to load file content');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePreview = () => {
    if (showPreview) {
      setShowPreview(false);
      return;
    }

    if (content) {
      setShowPreview(true);
      return;
    }

    void loadContent();
  };

  const handleCopyContent = async () => {
    if (!content) {
      return;
    }

    try {
      await Clipboard.setStringAsync(content);
      Alert.alert('Copied', 'Code content copied to clipboard');
    } catch (copyError) {
      logger.error('Error copying to clipboard:', copyError);
      Alert.alert('Error', 'Failed to copy content');
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
    if (onShare) {
      onShare();
    } else {
      setShowShareModal(true);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <FileCode size={24} color="#7C3AED" style={styles.icon} />
        <View style={styles.fileInfo}>
          <Text style={styles.fileName}>{fileName}</Text>
          <Text style={styles.fileType}>{getLanguageFromFileName(fileName)}</Text>
          {fileSize ? <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text> : null}
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.primaryButton} onPress={handlePreview} disabled={isLoading}>
          <Eye size={20} color="white" />
          <Text style={styles.primaryButtonText}>{isLoading ? 'Loading…' : showPreview ? 'Hide' : 'Preview'}</Text>
        </TouchableOpacity>

        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonFirst]}
            onPress={handleDownload}
          >
            <Download size={20} color={theme.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={handleShare}>
            <Share size={20} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {showPreview && content ? (
        <View style={styles.previewContainer}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle}>{getLanguageFromFileName(fileName)} Code Preview</Text>
            <TouchableOpacity style={styles.copyButton} onPress={handleCopyContent}>
              <Copy size={16} color="white" />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.codeScrollView} showsVerticalScrollIndicator={true}>
            <Text style={styles.codeText}>{content}</Text>
          </ScrollView>
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {!showPreview && !error ? (
        <Text style={styles.description}>Tap Preview to view code content with syntax highlighting</Text>
      ) : null}

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

export const CodeViewer = React.memo(CodeViewerInner, areCodeViewerPropsEqual);
