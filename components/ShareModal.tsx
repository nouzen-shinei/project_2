import { logger } from '@/lib/logger';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Platform, Share as RNShare, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Copy, Download, Share as ShareIcon, X } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';

import { useTheme } from '../hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { sharedFileService } from '@/services/sharedFileService';

interface ShareModalProps {
  visible: boolean;
  onClose: () => void;
  fileUrl: string;
  fileName: string;
  fileSize?: number;
  onDownload?: () => void;
}

export function ShareModal({ 
  visible, 
  onClose, 
  fileUrl, 
  fileName, 
  fileSize, 
  onDownload 
}: ShareModalProps) {
  const { theme } = useTheme();
  const { activeTenant } = useTenant();
  const tenantId = activeTenant?.id || null;

  const [resolvedShareUrl, setResolvedShareUrl] = useState<string | null>(null);
  const [isResolvingShareUrl, setIsResolvingShareUrl] = useState(false);
  const resolvingPromiseRef = useRef<Promise<string> | null>(null);

  const canGenerateSmartShareLink = useMemo(() => {
    const v = (fileUrl || '').trim();
    if (!/^https?:\/\//i.test(v)) return false;
    // Avoid wrapping if it's already a smart link or shared route.
    if (/\/l\?/i.test(v) || /\/shared\//i.test(v)) return false;
    return true;
  }, [fileUrl]);

  // When opened, try to show a cached share link immediately.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!visible) return;
      setResolvedShareUrl(null);
      setIsResolvingShareUrl(false);
      resolvingPromiseRef.current = null;

      const rawUrl = (fileUrl || '').trim();
      if (!rawUrl) return;
      if (!canGenerateSmartShareLink) return;
      if (!tenantId) return;

      const cached = await sharedFileService.getCachedSmartShareLink({ tenantId, fileUrl: rawUrl });
      if (cancelled) return;
      if (cached) setResolvedShareUrl(cached);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [visible, fileUrl, tenantId, canGenerateSmartShareLink]);

  const getShareUrl = useCallback(async (): Promise<string> => {
    const fallback = (fileUrl || '').trim();
    if (!fallback) {
      throw new Error('Missing link');
    }
    if (!canGenerateSmartShareLink) {
      return fallback;
    }
    if (resolvedShareUrl) {
      return resolvedShareUrl;
    }
    if (resolvingPromiseRef.current) {
      try {
        return await resolvingPromiseRef.current;
      } catch {
        return fallback;
      }
    }

    // If we have a tenantId, check storage cache again (covers cases where the
    // share token was recorded slightly after the modal opened).
    if (tenantId) {
      try {
        const cached = await sharedFileService.getCachedSmartShareLink({ tenantId, fileUrl: fallback });
        if (cached) {
          setResolvedShareUrl(cached);
          return cached;
        }
      } catch {
        // ignore
      }
    }

    setIsResolvingShareUrl(true);
    const work = sharedFileService
      .ensureSmartShareLink({
        fileUrl: fallback,
        fileName,
        fileSize,
        tenantId,
      })
      .then((smart) => {
        setResolvedShareUrl(smart);
        return smart;
      })
      .catch((e) => {
        logger.warn('ShareModal: failed to mint smart share link, falling back', e);
        return fallback;
      })
      .finally(() => {
        resolvingPromiseRef.current = null;
        setIsResolvingShareUrl(false);
      });

    resolvingPromiseRef.current = work;
    return await work;
  }, [canGenerateSmartShareLink, fileUrl, fileName, fileSize, resolvedShareUrl, tenantId]);

  const handleCopyLink = async () => {
    try {
      const url = await getShareUrl();
      await Clipboard.setStringAsync(url);
      Alert.alert('Copied!', 'File link copied to clipboard', [
        { text: 'OK', onPress: onClose }
      ]);
    } catch (error) {
      logger.error('Error copying to clipboard:', error);
      Alert.alert('Error', 'Failed to copy link to clipboard');
    }
  };

  const handleNativeShare = async () => {
    try {
      const url = await getShareUrl();
      if (Platform.OS === 'web') {
        // Web sharing using Web Share API or fallback
        if (navigator.share) {
          await navigator.share({
            title: fileName,
            text: `Check out this file: ${fileName}`,
            url,
          });
        } else {
          // Fallback for web browsers that don't support Web Share API
          await handleCopyLink();
        }
      } else {
        await RNShare.share({
          title: fileName,
          message: url,
          url,
        });
      }
      onClose();
    } catch (error) {
      logger.error('Error sharing:', error);
      Alert.alert('Error', 'Failed to share file');
    }
  };

  const handleDownload = () => {
    if (onDownload) {
      onDownload();
      onClose();
    } else {
      Alert.alert('Download', 'Download functionality not implemented');
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        modalOverlay: {
          flex: 1,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          justifyContent: 'center',
          alignItems: 'center',
        },
        modalContent: {
          backgroundColor: theme.surface,
          borderRadius: 16,
          padding: 24,
          margin: 20,
          width: '90%',
          maxWidth: 420,
          ...(Platform.OS === 'web'
            ? ({ boxShadow: '0 4px 8px rgba(0, 0, 0, 0.25)' } as any)
            : {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 8,
                elevation: 8,
              }),
        },
        header: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20,
        },
        title: {
          fontSize: 20,
          fontWeight: 'bold',
          color: theme.text,
        },
        closeButton: {
          padding: 8,
          borderRadius: 8,
          backgroundColor: theme.background,
        },
        fileInfo: {
          marginBottom: 24,
        },
        fileName: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.text,
          marginBottom: 6,
        },
        fileUrl: {
          fontSize: 12,
          color: theme.textSecondary,
          fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
          backgroundColor: theme.background,
          padding: 8,
          borderRadius: 8,
          marginBottom: 6,
        },
        fileSize: {
          fontSize: 13,
          color: theme.textSecondary,
        },
        actionsContainer: {
          gap: 12,
        },
        actionButton: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.background,
          borderRadius: 12,
          padding: 16,
          borderWidth: 1,
          borderColor: theme.border,
        },
        primaryActionButton: {
          backgroundColor: theme.primary,
          borderColor: theme.primary,
        },
        actionIcon: {
          marginRight: 12,
        },
        actionTextContainer: {
          flex: 1,
        },
        actionTitle: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.text,
          marginBottom: 2,
        },
        actionTitlePrimary: {
          color: 'white',
        },
        actionDescription: {
          fontSize: 12,
          color: theme.textSecondary,
        },
        actionDescriptionPrimary: {
          color: 'rgba(255, 255, 255, 0.85)',
        },
      }),
    [theme],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.header}>
            <Text style={styles.title}>Share File</Text>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={2}>{fileName}</Text>
            <Text style={styles.fileUrl} numberOfLines={2}>
              {resolvedShareUrl || (canGenerateSmartShareLink ? (isResolvingShareUrl ? 'Generating share link…' : 'Share link will be generated') : fileUrl)}
            </Text>
            {fileSize && (
              <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
            )}
          </View>

          <View style={styles.actionsContainer}>
            <TouchableOpacity 
              style={[styles.actionButton, styles.primaryActionButton]} 
              onPress={handleNativeShare}
              disabled={isResolvingShareUrl && !resolvedShareUrl}
            >
              <ShareIcon size={20} color="white" style={styles.actionIcon} />
              <View style={styles.actionTextContainer}>
                <Text style={[styles.actionTitle, styles.actionTitlePrimary]}>
                  {isResolvingShareUrl ? 'Generating…' : 'Share Link'}
                </Text>
                <Text style={[styles.actionDescription, styles.actionDescriptionPrimary]}>
                  {resolvedShareUrl ? 'Share your smart link' : 'Creates a smart link and shares it'}
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton} onPress={handleCopyLink}>
              <Copy size={20} color={theme.text} style={styles.actionIcon} />
              <View style={styles.actionTextContainer}>
                <Text style={styles.actionTitle}>Copy Link</Text>
                <Text style={styles.actionDescription}>
                  Copy share link to clipboard
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton} onPress={handleDownload}>
              <Download size={20} color={theme.text} style={styles.actionIcon} />
              <View style={styles.actionTextContainer}>
                <Text style={styles.actionTitle}>Download File</Text>
                <Text style={styles.actionDescription}>
                  Save file to your device
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
