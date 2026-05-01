import React, { useCallback } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { X, AlertCircle, Download, Share, RotateCcw } from 'lucide-react-native';
import ProgressiveImage from '../ui/ProgressiveImage';
import { ShareModal } from '../index';
import { useDownloadState } from '../../hooks/useDownloadState';
import { useEasedDownloadProgressPercent } from '../../hooks/useEasedDownloadProgressPercent';
import { resolveDownloadProgressLabel } from '../../lib/uploadProgressDisplayEasing';
import { normalizeSharedFileName } from '@/services/sharedFileService';

// ---------------------------------------------------------------------------
// ImageViewerDownloadButton – extracted from the chat.tsx closure
// ---------------------------------------------------------------------------

interface ImageViewerDownloadButtonProps {
  sourceUri: string;
  localHint?: string;
  getDownloadKey: (url?: string) => string;
  onDownload: (fileUrl: string, fileName: string, localHint?: string) => void;
}

const ImageViewerDownloadButtonBase: React.FC<ImageViewerDownloadButtonProps> = ({
  sourceUri,
  localHint,
  getDownloadKey,
  onDownload,
}) => {
  const downloadKey = getDownloadKey(sourceUri);
  const downloadState = useDownloadState(downloadKey);
  const normalizedProgress = useEasedDownloadProgressPercent(
    downloadState.progress,
    downloadState.isDownloading
  );
  const downloadLabel = resolveDownloadProgressLabel(
    downloadState.isDownloading,
    normalizedProgress
  );
  const handleDownloadPress = useCallback(() => {
    const derived = normalizeSharedFileName({ fileUrl: sourceUri, fileName: '' });
    const downloadName = derived && derived !== 'file' ? derived : 'image.jpg';
    onDownload(sourceUri, downloadName, localHint);
  }, [onDownload, localHint, sourceUri]);

  return (
    <TouchableOpacity
      style={[styles.imageViewerActionButton, { opacity: downloadState.isDownloading ? 0.7 : 1 }]}
      onPress={handleDownloadPress}
      disabled={downloadState.isDownloading}
    >
      <Download size={20} color="#ffffff" />
      <Text style={styles.imageViewerButtonText}>{downloadLabel}</Text>
    </TouchableOpacity>
  );
};

ImageViewerDownloadButtonBase.displayName = 'ImageViewerDownloadButtonBase';
const ImageViewerDownloadButton = React.memo(ImageViewerDownloadButtonBase);
ImageViewerDownloadButton.displayName = 'ImageViewerDownloadButton';

// ---------------------------------------------------------------------------
// ChatImageViewerModal
// ---------------------------------------------------------------------------

interface ChatImageViewerModalProps {
  visible: boolean;
  onClose: () => void;
  selectedImageUri: string;
  lastViewedRemoteImage: string | undefined;
  brokenFileUrls: Set<string>;
  networkErrorUrls: Set<string>;
  onImageError: (fileUrl: string) => void;
  onClearNetworkError: (url: string) => void;
  onSetSelectedImageUri: (uri: string) => void;
  onDownloadFile: (fileUrl: string, fileName: string, localHint?: string) => void;
  getDownloadKey: (url?: string) => string;
  // Share modal
  showImageShareModal: boolean;
  onOpenImageShareModal: () => void;
  onCloseImageShareModal: () => void;
}

export const ChatImageViewerModal: React.FC<ChatImageViewerModalProps> = ({
  visible,
  onClose,
  selectedImageUri,
  lastViewedRemoteImage,
  brokenFileUrls,
  networkErrorUrls,
  onImageError,
  onClearNetworkError,
  onSetSelectedImageUri,
  onDownloadFile,
  getDownloadKey,
  showImageShareModal,
  onOpenImageShareModal,
  onCloseImageShareModal,
}) => {
  const sourceUri = lastViewedRemoteImage || selectedImageUri;
  const activeImageUri = sourceUri;
  const isSelectedImageBroken = brokenFileUrls.has(selectedImageUri);
  const hasActiveImageNetworkError = networkErrorUrls.has(activeImageUri);

  const derivedSharedImageFileName = normalizeSharedFileName({ fileUrl: sourceUri, fileName: '' });
  const sharedImageFileName =
    derivedSharedImageFileName && derivedSharedImageFileName !== 'file'
      ? derivedSharedImageFileName
      : 'image.jpg';

  const retryActiveImage = useCallback(() => {
    onClearNetworkError(activeImageUri);
    onSetSelectedImageUri(activeImageUri);
  }, [activeImageUri, onClearNetworkError, onSetSelectedImageUri]);

  const downloadSharedImage = useCallback(() => {
    const src = lastViewedRemoteImage || selectedImageUri;
    onDownloadFile(src, sharedImageFileName, selectedImageUri);
  }, [lastViewedRemoteImage, selectedImageUri, sharedImageFileName, onDownloadFile]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.imageViewerOverlay}>
        <TouchableOpacity
          style={styles.imageViewerCloseButton}
          onPress={onClose}
        >
          <X size={30} color="#ffffff" />
        </TouchableOpacity>
        {isSelectedImageBroken ? (
          <View style={styles.brokenImageContainer}>
            <AlertCircle size={64} color="#ffffff" />
            <Text style={styles.brokenImageText}>
              Image no longer available
            </Text>
            <Text style={styles.brokenImageSubtext}>
              This image has been deleted or is no longer accessible
            </Text>
          </View>
        ) : (
          <View style={styles.imageViewerContent}>
            <ProgressiveImage
              uri={selectedImageUri}
              style={styles.fullScreenImage}
              resizeMode="contain"
              onError={() => onImageError(activeImageUri)}
            />
            {hasActiveImageNetworkError && (
              <TouchableOpacity
                style={styles.imageRetryBadge}
                onPress={retryActiveImage}
              >
                <RotateCcw size={14} color="#ffffff" />
                <Text style={styles.imageRetryText}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {!isSelectedImageBroken && hasActiveImageNetworkError && (
          <View style={[styles.imageViewerNetworkError, { backgroundColor: 'rgba(0, 0, 0, 0.55)', borderColor: 'rgba(255, 255, 255, 0.2)' }]}>
            <View style={styles.networkErrorInfo}>
              <AlertCircle size={16} color="#ffffff" />
              <Text style={[styles.networkErrorText, { color: '#ffffff' }]}>Network error. Tap retry.</Text>
            </View>
            <TouchableOpacity
              style={[styles.networkErrorRetryButton, { borderColor: '#ffffff' }]}
              onPress={retryActiveImage}
            >
              <RotateCcw size={14} color="#ffffff" />
              <Text style={[styles.networkErrorRetryText, { color: '#ffffff' }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
        {/* Action buttons positioned at the bottom with proper spacing */}
        {!isSelectedImageBroken && (
          <View style={styles.imageViewerButtonContainer}>
            <ImageViewerDownloadButton
              sourceUri={sourceUri}
              localHint={selectedImageUri}
              getDownloadKey={getDownloadKey}
              onDownload={onDownloadFile}
            />
            <TouchableOpacity
              style={styles.imageViewerActionButton}
              onPress={onOpenImageShareModal}
            >
              <Share size={20} color="#ffffff" />
              <Text style={styles.imageViewerButtonText}>Share</Text>
            </TouchableOpacity>
          </View>
        )}
        <ShareModal
          visible={showImageShareModal}
          onClose={onCloseImageShareModal}
          fileUrl={lastViewedRemoteImage || selectedImageUri}
          fileName={sharedImageFileName}
          onDownload={downloadSharedImage}
        />
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  imageViewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerContent: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerCloseButton: {
    position: 'absolute',
    top: 60,
    right: 20,
    zIndex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 20,
    padding: 10,
  },
  fullScreenImage: {
    width: '100%',
    height: '100%',
  },
  imageRetryBadge: {
    position: 'absolute',
    bottom: 110,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  imageRetryText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  imageViewerButtonContainer: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
  },
  imageViewerActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
  },
  imageViewerNetworkError: {
    position: 'absolute',
    top: 110,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  imageViewerButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginLeft: 8,
  },
  brokenImageContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  brokenImageText: {
    color: '#ffffff',
    fontSize: 20,
    fontFamily: 'Inter-SemiBold',
    marginTop: 16,
    textAlign: 'center',
  },
  brokenImageSubtext: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  // Network error styles (duplicated from chat.tsx for self-containment)
  networkErrorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  networkErrorText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 8,
  },
  networkErrorRetryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    marginLeft: 10,
  },
  networkErrorRetryText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
});
