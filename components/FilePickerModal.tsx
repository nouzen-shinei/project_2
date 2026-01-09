import { logger } from '@/lib/logger';
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Alert, Platform } from 'react-native';
import { 
  Paperclip, 
  Image, 
  Video, 
  Music, 
  FileText, 
  Code, 
  Presentation, 
  Sheet, 
  Archive,
  File,
  X,
  Upload 
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { MediaPickerUtil } from '../lib/mediaPickerUtil';

interface FilePickerModalProps {
  visible: boolean;
  onClose: () => void;
  onFileSelected: (files: {
    uri: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
  }[]) => void;
  allowMultiple?: boolean;
}

export function FilePickerModal({ 
  visible, 
  onClose, 
  onFileSelected, 
  allowMultiple = false 
}: FilePickerModalProps) {
  const { theme } = useTheme();
  const [isLoading, setIsLoading] = useState(false);

  const handleFileTypeSelection = async (type: string) => {
    try {
      setIsLoading(true);
      let result: any = null;

      switch (type) {
        case 'image':
          result = await MediaPickerUtil.selectImage(allowMultiple);
          break;
        case 'video':
          result = await MediaPickerUtil.selectVideo(allowMultiple);
          break;
        case 'audio':
          result = await MediaPickerUtil.selectAudioFiles(allowMultiple);
          break;
        case 'pdf':
          result = await MediaPickerUtil.selectPdfFiles(allowMultiple);
          break;
        case 'code':
          result = await MediaPickerUtil.selectCodeFiles(allowMultiple);
          break;
        case 'presentation':
          result = await MediaPickerUtil.selectPresentationFiles(allowMultiple);
          break;
        case 'spreadsheet':
          result = await MediaPickerUtil.selectSpreadsheetFiles(allowMultiple);
          break;
        case 'document':
          result = await MediaPickerUtil.selectDocument('*/*', allowMultiple);
          break;
        case 'mixed':
          result = await MediaPickerUtil.selectMixedFiles(allowMultiple);
          break;
        default:
          result = await MediaPickerUtil.selectDocument('*/*', allowMultiple);
      }

      if (result && !result.canceled && result.assets) {
        const files = result.assets.map((asset: any) => ({
          uri: asset.uri,
          fileName: asset.name || 'unknown',
          fileType: asset.mimeType || 'application/octet-stream',
          fileSize: asset.size,
        }));
        
        onFileSelected(files);
        onClose();
      }
        // Support both asset-array results (ImagePicker/web fallbacks) and DocumentPicker-style results on web
        if (result) {
          let files: { uri: string; fileName: string; fileType: string; fileSize?: number }[] | null = null;

          if (!result.canceled && Array.isArray(result.assets)) {
            files = result.assets.map((asset: any) => ({
              uri: asset.uri,
              fileName: asset.name || asset.fileName || 'unknown',
              fileType: asset.mimeType || 'application/octet-stream',
              fileSize: asset.size || asset.fileSize,
            }));
          } else if (result.type === 'success') {
            // DocumentPicker web shim returns either a single file object or an array in `files`
            const normalize = (item: any) => ({
              uri: item.uri,
              fileName: item.name || item.fileName || 'unknown',
              fileType: item.mimeType || 'application/octet-stream',
              fileSize: item.size,
            });
            if (Array.isArray((result as any).files)) {
              files = (result as any).files.map(normalize);
            } else {
              files = [normalize(result)];
            }
          }

          if (files && files.length > 0) {
            onFileSelected(files);
            onClose();
          }
        }
    } catch (error) {
      logger.error('Error selecting files:', error);
      Alert.alert('Error', 'Failed to select files. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const fileTypes = [
    {
      id: 'image',
      name: 'Images',
      icon: Image,
      color: '#10B981',
      description: 'JPG, PNG, GIF, WebP...',
    },
    {
      id: 'video',
      name: 'Videos',
      icon: Video,
      color: '#EF4444',
      description: 'MP4, AVI, MOV, WebM...',
    },
    {
      id: 'audio',
      name: 'Audio',
      icon: Music,
      color: '#8B5CF6',
      description: 'MP3, WAV, FLAC, AAC...',
    },
    {
      id: 'pdf',
      name: 'PDF',
      icon: FileText,
      color: '#DC2626',
      description: 'PDF documents',
    },
    {
      id: 'code',
      name: 'Code',
      icon: Code,
      color: '#7C3AED',
      description: 'JS, TS, Python, Java...',
    },
    {
      id: 'presentation',
      name: 'Presentations',
      icon: Presentation,
      color: '#F59E0B',
      description: 'PPT, PPTX, ODP, KEY...',
    },
    {
      id: 'spreadsheet',
      name: 'Spreadsheets',
      icon: Sheet,
      color: '#059669',
      description: 'XLS, XLSX, CSV, ODS...',
    },
    {
      id: 'document',
      name: 'Documents',
      icon: FileText,
      color: '#3B82F6',
      description: 'DOC, DOCX, TXT, RTF...',
    },
    {
      id: 'mixed',
      name: 'All Files',
      icon: Upload,
      color: '#6B7280',
      description: 'Any file type',
    },
  ];

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
      padding: 20,
      margin: 20,
      width: '90%',
      maxHeight: '80%',
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
    subtitle: {
      fontSize: 14,
      color: theme.textSecondary,
      marginBottom: 16,
      textAlign: 'center',
    },
    fileTypesContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
    },
    fileTypeButton: {
      width: '48%',
      backgroundColor: theme.background,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: 'center',
    },
    fileTypeButtonPressed: {
      backgroundColor: theme.primary + '20',
      borderColor: theme.primary,
    },
    fileTypeIcon: {
      marginBottom: 8,
    },
    fileTypeName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.text,
      marginBottom: 4,
      textAlign: 'center',
    },
    fileTypeDescription: {
      fontSize: 12,
      color: theme.textSecondary,
      textAlign: 'center',
    },
    loadingOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.3)',
      borderRadius: 16,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      color: 'white',
      fontSize: 16,
      fontWeight: '600',
      marginTop: 8,
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
            <Text style={styles.title}>Select File Type</Text>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
          
          <Text style={styles.subtitle}>
            Choose the type of file you want to upload
            {allowMultiple ? ' (multiple files allowed)' : ''}
          </Text>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 20 }),
            }}
          >
            <View style={styles.fileTypesContainer}>
              {fileTypes.map((fileType) => {
                const IconComponent = fileType.icon;
                return (
                  <TouchableOpacity
                    key={fileType.id}
                    style={styles.fileTypeButton}
                    onPress={() => handleFileTypeSelection(fileType.id)}
                    disabled={isLoading}
                  >
                    <IconComponent 
                      size={32} 
                      color={fileType.color} 
                      style={styles.fileTypeIcon}
                    />
                    <Text style={styles.fileTypeName}>{fileType.name}</Text>
                    <Text style={styles.fileTypeDescription}>
                      {fileType.description}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>

          {isLoading && (
            <View style={styles.loadingOverlay}>
              <Text style={styles.loadingText}>Loading...</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
