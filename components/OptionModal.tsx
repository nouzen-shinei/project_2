import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ScrollView,
} from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { X } from 'lucide-react-native';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

interface OptionModalAction {
  text: string;
  onPress: () => void;
  style?: 'default' | 'destructive' | 'primary';
  icon?: React.ReactNode;
}

interface OptionModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  message?: string;
  actions: OptionModalAction[];
  showCancel?: boolean;
  cancelText?: string;
  icon?: React.ReactNode;
}

const OptionModal: React.FC<OptionModalProps> = ({
  visible,
  onClose,
  title,
  message,
  actions,
  showCancel = true,
  cancelText = 'Cancel',
  icon,
}) => {
  const { theme } = useTheme();

  const getActionButtonColor = (style: string = 'default') => {
    switch (style) {
      case 'destructive':
        return theme.error;
      case 'primary':
        return theme.primary;
      default:
        return theme.surface;
    }
  };

  const getActionTextColor = (style: string = 'default') => {
    switch (style) {
      case 'destructive':
        return '#FFFFFF';
      case 'primary':
        return '#FFFFFF';
      default:
        return theme.text;
    }
  };

  const handleActionPress = (action: OptionModalAction) => {
    action.onPress();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={[styles.modalContainer, { backgroundColor: theme.surface }]}>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <X size={20} color={theme.textSecondary} />
          </TouchableOpacity>

          <View style={styles.content}>
            {icon && (
              <View style={styles.iconContainer}>
                {icon}
              </View>
            )}

            <Text style={[styles.title, { color: theme.text }]}>
              {title}
            </Text>

            {message && (
              <Text style={[styles.message, { color: theme.textSecondary }]}>
                {message}
              </Text>
            )}
          </View>

          <ScrollView style={styles.actionsContainer} showsVerticalScrollIndicator={false}>
            {actions.map((action, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.actionButton,
                  { 
                    backgroundColor: getActionButtonColor(action.style),
                    borderColor: theme.border,
                  }
                ]}
                onPress={() => handleActionPress(action)}
              >
                <View style={styles.actionContent}>
                  {action.icon && (
                    <View style={styles.actionIcon}>
                      {action.icon}
                    </View>
                  )}
                  <Text style={[
                    styles.actionText, 
                    { color: getActionTextColor(action.style) }
                  ]}>
                    {action.text}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}

            {showCancel && (
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  styles.cancelButton,
                  { 
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                  }
                ]}
                onPress={onClose}
              >
                <Text style={[styles.actionText, { color: theme.textSecondary }]}>
                  {cancelText}
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContainer: {
    width: Math.min(screenWidth * 0.9, 400),
    maxHeight: screenHeight * 0.8,
    borderRadius: 16,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  closeButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 1,
    padding: 4,
  },
  content: {
    padding: 24,
    paddingTop: 40, // Account for close button
  },
  iconContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 12,
  },
  message: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  actionsContainer: {
    maxHeight: screenHeight * 0.4,
    padding: 20,
    paddingTop: 0,
  },
  actionButton: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  actionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIcon: {
    marginRight: 12,
  },
  actionText: {
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    marginTop: 8,
    borderWidth: 1,
  },
});

export default OptionModal;
