import React from 'react';
import { Modal, Pressable, View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Camera, File as FileIcon, Image as ImageIcon, Play } from 'lucide-react-native';

interface ChatAttachmentModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectImage: () => void;
  onSelectCamera: () => void;
  onSelectVideo: () => void;
  onSelectVideoCamera: () => void;
  onSelectDocument: () => void;
  theme: {
    surface: string;
    text: string;
    primary: string;
    [key: string]: any;
  };
}

export const ChatAttachmentModal: React.FC<ChatAttachmentModalProps> = ({
  visible,
  onClose,
  onSelectImage,
  onSelectCamera,
  onSelectVideo,
  onSelectVideoCamera,
  onSelectDocument,
  theme,
}) => {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable 
        style={styles.attachmentModalOverlay}
        onPress={onClose}
      >
        <View style={[styles.attachmentModal, { backgroundColor: theme.surface }]}>
          <Text style={[styles.attachmentModalTitle, { color: theme.text }]}>Send Attachment</Text>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={onSelectImage}
          >
            <ImageIcon size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Photo Library</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={onSelectCamera}
          >
            <Camera size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Camera</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={onSelectVideo}
          >
            <Play size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Video Library</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={onSelectVideoCamera}
          >
            <Camera size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Record Video</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={onSelectDocument}
          >
            <FileIcon size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Document</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  attachmentModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  attachmentModal: {
    margin: 20,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 4,
      },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 8,
    }),
  },
  attachmentModalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 20,
  },
  attachmentOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    width: '100%',
  },
  attachmentOptionText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginLeft: 16,
  },
});
