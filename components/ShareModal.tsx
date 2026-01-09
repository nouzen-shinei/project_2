import { logger } from '@/lib/logger';
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform, Alert } from 'react-native';
import { Share, Copy, X, Link, Download } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import * as Clipboard from 'expo-clipboard';

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

  const handleCopyLink = async () => {
    try {
      await Clipboard.setStringAsync(fileUrl);
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
      if (Platform.OS === 'web') {
        // Web sharing using Web Share API or fallback
        if (navigator.share) {
          await navigator.share({
            title: fileName,
            text: `Check out this file: ${fileName}`,
            url: fileUrl,
          });
        } else {
          // Fallback for web browsers that don't support Web Share API
          await handleCopyLink();
        }
      } else {
        // Mobile sharing using expo-sharing
        const { Sharing } = require('expo-sharing');
        const isAvailable = await Sharing.isAvailableAsync();
        
        if (isAvailable) {
          await Sharing.shareAsync(fileUrl, {
            mimeType: '*/*',
            dialogTitle: `Share ${fileName}`,
            UTI: '*/*'
          });
        } else {
          // Fallback to copying link
          await handleCopyLink();
        }
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

  const styles = StyleSheet.create({
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
      maxWidth: 400,
      ...(Platform.OS === 'web' ? {
        boxShadow: '0 4px 8px rgba(0, 0, 0, 0.25)'
      } : {
        shadowColor: '#000',
        shadowOffset: {
          width: 0,
          height: 4,
        },
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
      marginBottom: 4,
    },
    fileUrl: {
      fontSize: 12,
      color: theme.textSecondary,
      fontFamily: 'monospace',
      backgroundColor: theme.background,
      padding: 8,
      borderRadius: 6,
      marginBottom: 4,
    },
    fileSize: {
      fontSize: 14,
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
    primaryActionTitle: {
      color: 'white',
    },
    actionDescription: {
      fontSize: 12,
      color: theme.textSecondary,
    },
    primaryActionDescription: {
      color: 'rgba(255, 255, 255, 0.8)',
    },
  });

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
            <Text style={styles.fileUrl} numberOfLines={2}>{fileUrl}</Text>
            {fileSize && (
              <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
            )}
          </View>

          <View style={styles.actionsContainer}>
            <TouchableOpacity 
              style={[styles.actionButton, styles.primaryActionButton]} 
              onPress={handleNativeShare}
            >
              <Share size={20} color="white" style={styles.actionIcon} />
              <View style={styles.actionTextContainer}>
                <Text style={[styles.actionTitle, styles.primaryActionTitle]}>
                  Share Link
                </Text>
                <Text style={[styles.actionDescription, styles.primaryActionDescription]}>
                  Share this file with others
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton} onPress={handleCopyLink}>
              <Copy size={20} color={theme.text} style={styles.actionIcon} />
              <View style={styles.actionTextContainer}>
                <Text style={styles.actionTitle}>Copy Link</Text>
                <Text style={styles.actionDescription}>
                  Copy Google Storage link to clipboard
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
