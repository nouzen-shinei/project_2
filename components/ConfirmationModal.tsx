import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { createPortal } from 'react-dom';
import { useTheme } from '../hooks/useTheme';
import { X } from 'lucide-react-native';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

interface ConfirmationModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  message: string;
  actions?: {
    text: string;
    onPress?: () => void;
    style?: 'default' | 'cancel' | 'destructive' | 'primary';
    disabled?: boolean;
  }[];
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmStyle?: 'default' | 'destructive' | 'primary';
  icon?: React.ReactNode;
  showCloseButton?: boolean;
  showCancelButton?: boolean;
  showConfirmButton?: boolean;
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  cancelDisabled?: boolean;
  autoCloseOnConfirm?: boolean;
  statusMessage?: string | null;
  statusType?: 'neutral' | 'error' | 'success' | 'warning';
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  visible,
  onClose,
  title,
  message,
  actions,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  confirmStyle = 'primary',
  icon,
  showCloseButton = true,
  showCancelButton = true,
  showConfirmButton = true,
  confirmDisabled = false,
  confirmLoading = false,
  cancelDisabled = false,
  autoCloseOnConfirm = true,
  statusMessage = null,
  statusType = 'neutral',
}) => {
  const { theme } = useTheme();

  const hasCustomActions = Array.isArray(actions) && actions.length > 0;

  const handleCancel = () => {
    if (cancelDisabled) {
      return;
    }
    onCancel?.();
    onClose();
  };

  const handleConfirm = () => {
    if (confirmDisabled || confirmLoading) {
      return;
    }
    onConfirm?.();
    // If no confirm handler is provided, treat confirm as an acknowledgement and close.
    // This prevents "OK" dialogs from getting stuck when a caller disables auto-close
    // for other flows (e.g., async confirmations).
    if (autoCloseOnConfirm || !onConfirm) {
      onClose();
    }
  };

  const getConfirmButtonColor = () => {
    switch (confirmStyle) {
      case 'destructive':
        return theme.error;
      case 'primary':
        return theme.primary;
      default:
        return theme.textSecondary;
    }
  };

  const getActionButtonColor = (style?: 'default' | 'cancel' | 'destructive' | 'primary') => {
    switch (style) {
      case 'destructive':
        return theme.error;
      case 'primary':
        return theme.primary;
      default:
        return theme.background;
    }
  };

  const getActionTextColor = (style?: 'default' | 'cancel' | 'destructive' | 'primary') => {
    switch (style) {
      case 'destructive':
      case 'primary':
        return '#FFFFFF';
      case 'cancel':
        return theme.textSecondary;
      default:
        return theme.text;
    }
  };

  const getStatusColor = () => {
    switch (statusType) {
      case 'error':
        return theme.error;
      case 'success':
        return theme.success;
      case 'warning':
        return theme.warning;
      default:
        return theme.textSecondary;
    }
  };

  const statusColor = getStatusColor();

  // Web: render an overlay directly via portal so it always stacks above other modals.
  if (Platform.OS === 'web') {
    if (!visible) {
      return null;
    }

    const modalContent = (
      <View style={[styles.overlay, styles.webOverlay]}>
        <View style={[styles.modalContainer, { backgroundColor: theme.surface }]}>
          {showCloseButton && (
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              disabled={cancelDisabled}
            >
              <X size={20} color={theme.textSecondary} />
            </TouchableOpacity>
          )}

          <View style={styles.content}>
            {icon && <View style={styles.iconContainer}>{icon}</View>}

            <Text style={[styles.title, { color: theme.text }]}>{title}</Text>

            <Text style={[styles.message, { color: theme.textSecondary }]}>{message}</Text>

            {statusMessage ? (
              <View
                style={[
                  styles.statusContainer,
                  {
                    backgroundColor: `${statusColor}20`,
                    borderColor: `${statusColor}40`,
                  },
                ]}
              >
                <Text style={[styles.statusText, { color: statusColor }]}>{statusMessage}</Text>
              </View>
            ) : null}
          </View>

          <View
            style={[
              styles.buttonContainer,
              hasCustomActions ? styles.buttonContainerColumn : null,
            ]}
          >
            {hasCustomActions
              ? actions!.map((action, index) => {
                  const isFilled = action.style === 'primary' || action.style === 'destructive';
                  const disabled = Boolean(action.disabled) || cancelDisabled;

                  return (
                    <TouchableOpacity
                      key={`${action.text}-${index}`}
                      style={[
                        styles.button,
                        isFilled ? styles.confirmButton : styles.cancelButton,
                        styles.actionButtonFullWidth,
                        {
                          backgroundColor: getActionButtonColor(action.style),
                          borderColor: theme.border,
                          opacity: disabled ? 0.6 : 1,
                        },
                      ]}
                      onPress={() => {
                        if (disabled) {
                          return;
                        }
                        action.onPress?.();
                        onClose();
                      }}
                      disabled={disabled}
                    >
                      <Text style={[styles.buttonText, { color: getActionTextColor(action.style) }]}>
                        {action.text}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              : (
                <>
                  {showCancelButton ? (
                    <TouchableOpacity
                      style={[
                        styles.button,
                        styles.cancelButton,
                        {
                          backgroundColor: theme.background,
                          borderColor: theme.border,
                        },
                      ]}
                      onPress={handleCancel}
                      disabled={cancelDisabled}
                    >
                      <Text style={[styles.buttonText, { color: theme.textSecondary }]}>{cancelText}</Text>
                    </TouchableOpacity>
                  ) : null}

                  {showConfirmButton ? (
                    <TouchableOpacity
                      style={[
                        styles.button,
                        styles.confirmButton,
                        !showCancelButton ? styles.singleButton : null,
                        {
                          backgroundColor: getConfirmButtonColor(),
                          opacity: confirmDisabled || confirmLoading ? 0.6 : 1,
                        },
                      ]}
                      onPress={handleConfirm}
                      disabled={confirmDisabled || confirmLoading}
                    >
                      {confirmLoading ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={[styles.buttonText, { color: '#FFFFFF' }]}>{confirmText}</Text>
                      )}
                    </TouchableOpacity>
                  ) : null}
                </>
              )}
          </View>
        </View>
      </View>
    );

    // Use portal to render at document body level, bypassing parent modal stacking contexts
    return createPortal(modalContent, document.body);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!cancelDisabled) {
          onClose();
        }
      }}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={[styles.modalContainer, { backgroundColor: theme.surface }]}>
          {showCloseButton && (
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              disabled={cancelDisabled}
            >
              <X size={20} color={theme.textSecondary} />
            </TouchableOpacity>
          )}

          <View style={styles.content}>
            {icon && (
              <View style={styles.iconContainer}>
                {icon}
              </View>
            )}

            <Text style={[styles.title, { color: theme.text }]}>
              {title}
            </Text>

            <Text style={[styles.message, { color: theme.textSecondary }]}>
              {message}
            </Text>

            {statusMessage ? (
              <View
                style={[
                  styles.statusContainer,
                  {
                    backgroundColor: `${statusColor}20`,
                    borderColor: `${statusColor}40`,
                  },
                ]}
              >
                <Text style={[styles.statusText, { color: statusColor }]}>
                  {statusMessage}
                </Text>
              </View>
            ) : null}
          </View>

          <View
            style={[
              styles.buttonContainer,
              hasCustomActions ? styles.buttonContainerColumn : null,
              styles.nativeButtonContainer,
            ]}
          >
            {hasCustomActions
              ? actions!.map((action, index) => {
                  const isFilled = action.style === 'primary' || action.style === 'destructive';
                  const disabled = Boolean(action.disabled) || cancelDisabled;

                  return (
                    <TouchableOpacity
                      key={`${action.text}-${index}`}
                      style={[
                        styles.button,
                        isFilled ? styles.confirmButton : styles.cancelButton,
                        styles.actionButtonFullWidth,
                        {
                          backgroundColor: getActionButtonColor(action.style),
                          borderColor: theme.border,
                          opacity: disabled ? 0.6 : 1,
                        },
                      ]}
                      onPress={() => {
                        if (disabled) {
                          return;
                        }
                        action.onPress?.();
                        onClose();
                      }}
                      disabled={disabled}
                    >
                      <Text style={[styles.buttonText, { color: getActionTextColor(action.style) }]}>
                        {action.text}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              : (
                <>
                  {showCancelButton ? (
                    <TouchableOpacity
                      style={[
                        styles.button,
                        styles.cancelButton,
                        {
                          backgroundColor: theme.background,
                          borderColor: theme.border,
                        },
                      ]}
                      onPress={handleCancel}
                      disabled={cancelDisabled}
                    >
                      <Text style={[styles.buttonText, { color: theme.textSecondary }]}>
                        {cancelText}
                      </Text>
                    </TouchableOpacity>
                  ) : null}

                  {showConfirmButton ? (
                    <TouchableOpacity
                      style={[
                        styles.button,
                        styles.confirmButton,
                        !showCancelButton ? styles.singleButton : null,
                        {
                          backgroundColor: getConfirmButtonColor(),
                          opacity: confirmDisabled || confirmLoading ? 0.6 : 1,
                        },
                      ]}
                      onPress={handleConfirm}
                      disabled={confirmDisabled || confirmLoading}
                    >
                      {confirmLoading ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={[styles.buttonText, { color: '#FFFFFF' }]}>
                          {confirmText}
                        </Text>
                      )}
                    </TouchableOpacity>
                  ) : null}
                </>
              )}
          </View>
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
  webOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2147483647,
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
  },
  buttonContainer: {
    flexDirection: 'row',
    padding: 20,
    paddingTop: 0,
    gap: 12,
  },
  nativeButtonContainer: {
    paddingBottom: Platform.OS === 'web' ? 42 : 40,
  },
  buttonContainerColumn: {
    flexDirection: 'column',
  },
  actionButtonFullWidth: {
    width: '100%',
  },
  singleButton: {
    flex: 1,
  },
  statusContainer: {
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  cancelButton: {
    borderWidth: 1,
  },
  confirmButton: {
    // backgroundColor set dynamically
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default ConfirmationModal;
