import { logger } from '@/lib/logger';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ScrollView,
  Platform,
  ActivityIndicator,
  Alert
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Timestamp } from 'firebase/firestore';
import { 
  X, 
  AlertTriangle, 
  Ban, 
  RotateCcw, 
  LogOut, 
  Trash2, 
  CheckCircle, 
  Info,
  Shield,
  Clock
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { UserDevice, deviceTrackingService } from '../services/deviceTrackingService';

interface DeviceActionModalProps {
  visible: boolean;
  onClose: () => void;
  device: UserDevice;
  userEmail: string;
  adminEmail: string;
  adminName: string;
  initialActionType?: 'delete' | 'restore' | 'logout' | null;
  onActionComplete: () => void;
}

const DeviceActionModal: React.FC<DeviceActionModalProps> = ({
  visible,
  onClose,
  device,
  userEmail,
  adminEmail,
  adminName,
  initialActionType,
  onActionComplete
}) => {
  const { theme } = useTheme();
  
  // State management
  const [selectedAction, setSelectedAction] = useState<'delete' | 'restore' | 'logout' | 'restoreHardBan' | null>(
    initialActionType || null
  );
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [permanentDelete, setPermanentDelete] = useState(false);

  // Reset state when modal opens/closes
  React.useEffect(() => {
    if (visible) {
      setSelectedAction(initialActionType || null);
      setReason('');
      setLoading(false);
      setShowConfirmation(false);
  setPermanentDelete(false);
    }
  }, [visible, initialActionType]);

  // Action configurations
  const actionConfigs = {
    delete: {
      title: 'Delete Device',
      description: 'Remove this device from the user account. The device will need to re-register to access the application.',
      icon: <Ban size={24} color={theme.error} />,
      color: theme.error,
      buttonText: 'Delete Device',
      requiresReason: true,
      confirmText: 'This action will immediately remove the device from the user\'s account. Are you sure you want to continue?'
    },
    restore: {
      title: 'Restore Device',
      description: 'Restore this deleted device back to active status. The device will regain access to the application.',
      icon: <RotateCcw size={24} color={theme.success} />,
      color: theme.success,
      buttonText: 'Restore Device',
      requiresReason: false,
      confirmText: 'This will restore the device and grant it access to the application again. Continue?'
    },
    restoreHardBan: {
      title: 'Restore Hard Banned Device',
      description: 'Remove the hard ban from this device and restore access. This will deactivate all active bans and restore device access.',
      icon: <Shield size={24} color={theme.success} />,
      color: theme.success,
      buttonText: 'Remove Hard Ban',
      requiresReason: false,
      confirmText: 'This will remove the hard ban and restore device access. This action cannot be undone. Continue?'
    },
    logout: {
      title: 'Force Logout',
      description: 'Force logout this device remotely. The user will need to sign in again on this device.',
      icon: <LogOut size={24} color={theme.warning} />,
      color: theme.warning,
      buttonText: 'Force Logout',
      requiresReason: false,
      confirmText: 'This will immediately log out the user from this device. Continue?'
    }
  };

  // Format device info for display
  const getDeviceDisplayName = useCallback(() => {
    const parts = [];
    if (device.deviceName) parts.push(device.deviceName);
    if (device.modelName && device.modelName !== device.deviceName) {
      parts.push(`(${device.modelName})`);
    }
    if (device.browserName && device.browserVersion) {
      parts.push(`${device.browserName} ${device.browserVersion}`);
    }
    return parts.join(' ') || 'Unknown Device';
  }, [device]);

  const getDeviceType = useCallback(() => {
    if (device.deviceType === 'web' || device.platformOS === 'web' || 
        device.viewportWidth || device.currentUrl) {
      return 'Web Browser';
    }
    return device.deviceType === 'tablet' ? 'Tablet' : 'Mobile Device';
  }, [device]);

  const formatLastSeen = useCallback(() => {
    if (!device.lastSeen) return 'Never';
    
    let date: Date;
    
    try {
      if (device.lastSeen instanceof Date) {
        date = device.lastSeen;
      } else if (typeof device.lastSeen === 'string') {
        date = new Date(device.lastSeen);
      } else if (device.lastSeen && typeof device.lastSeen.toDate === 'function') {
        date = device.lastSeen.toDate();
      } else if (device.lastSeen && device.lastSeen.seconds) {
        date = new Date(device.lastSeen.seconds * 1000);
      } else {
        return 'Unknown';
      }
      
      if (isNaN(date.getTime())) return 'Invalid date';
      
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
      if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays} days ago`;
      return date.toLocaleDateString();
    } catch (error) {
      logger.error('Error formatting last seen:', error);
      return 'Unknown';
    }
  }, [device.lastSeen]);

  const formatTimestamp = useCallback((timestamp: any) => {
    if (!timestamp) return 'Unknown';
    
    let date: Date;
    
    try {
      if (timestamp instanceof Date) {
        date = timestamp;
      } else if (typeof timestamp === 'string') {
        date = new Date(timestamp);
      } else if (timestamp && typeof timestamp.toDate === 'function') {
        date = timestamp.toDate();
      } else if (timestamp && timestamp.seconds) {
        date = new Date(timestamp.seconds * 1000);
      } else {
        return 'Unknown';
      }
      
      if (isNaN(date.getTime())) return 'Invalid date';
      
      return date.toLocaleString();
    } catch (error) {
      logger.error('Error formatting timestamp:', error);
      return 'Unknown';
    }
  }, []);

  // Execute the selected action
  const executeAction = useCallback(async () => {
    if (!selectedAction) return;
    
    const config = actionConfigs[selectedAction];
    
    // Validate reason if required
    if (config.requiresReason && !reason.trim()) {
      Toast.show({
        type: 'error',
        text1: 'Reason Required',
        text2: 'Please provide a reason for this action'
      });
      return;
    }

    setLoading(true);
    
    try {
      let success = false;
      
      switch (selectedAction) {
        case 'delete':
          if (permanentDelete) {
            await deviceTrackingService.deleteDevicePermanently(
              userEmail,
              device.deviceId,
              adminEmail,
              adminName,
              reason.trim()
            );
          } else {
            await deviceTrackingService.markDeviceAsDeleted(
              userEmail, 
              device.deviceId, 
              adminEmail, 
              adminName, 
              reason.trim()
            );
          }
          success = true;
          break;
          
        case 'restore':
          await deviceTrackingService.restoreDevice(
            userEmail, 
            device.deviceId, 
            adminEmail, 
            adminName
          );
          success = true;
          break;

        case 'restoreHardBan':
          await deviceTrackingService.restoreHardBannedDevice(
            userEmail, 
            device.deviceId, 
            adminEmail, 
            adminName
          );
          success = true;
          break;
          
        case 'logout':
          await deviceTrackingService.forceLogoutDevice(
            userEmail, 
            device.deviceId, 
            adminEmail, 
            adminName,
            'Administrative force logout'
          );
          success = true;
          break;
      }

      if (success) {
        Toast.show({
          type: 'success',
          text1: 'Action Completed',
          text2: `Device ${selectedAction} successful`
        });
        
        onActionComplete();
        onClose();
      } else {
        Toast.show({
          type: 'error',
          text1: 'Action Failed',
          text2: `Failed to ${selectedAction} device`
        });
      }
    } catch (error) {
      logger.error(`Error ${selectedAction} device:`, error);
      Toast.show({
        type: 'error',
        text1: 'Action Failed',
        text2: `An error occurred while trying to ${selectedAction} the device`
      });
    } finally {
      setLoading(false);
    }
  }, [selectedAction, reason, userEmail, device.deviceId, adminEmail, adminName, onActionComplete, onClose]);

  // Handle action selection
  const handleActionSelect = useCallback((action: 'delete' | 'restore' | 'logout' | 'restoreHardBan') => {
    setSelectedAction(action);
    setShowConfirmation(false);
  }, []);

  // Handle execute button press
  const handleExecute = useCallback(() => {
    if (!selectedAction) return;
    
    setShowConfirmation(true);
  }, [selectedAction]);

  // Handle confirmation
  const handleConfirm = useCallback(() => {
    setShowConfirmation(false);
    executeAction();
  }, [executeAction]);

  if (!visible) return null;

  const currentConfig = selectedAction ? actionConfigs[selectedAction] : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <View style={styles.headerContent}>
            <Shield size={24} color={theme.primary} />
            <Text style={[styles.title, { color: theme.text }]}>Device Management</Text>
          </View>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            disabled={loading}
          >
            <X size={24} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.content}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: Platform.select({ web: 0, default: 20 }),
          }}
        >
          {/* Device Information */}
          <View style={[styles.deviceInfo, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Device Information</Text>
            
            <View style={styles.deviceDetails}>
              <View style={styles.deviceHeader}>
                <View style={[styles.deviceTypeIndicator, { backgroundColor: device.isOnline ? theme.success : theme.textSecondary }]}>
                  <Text style={styles.deviceTypeText}>{getDeviceType()}</Text>
                </View>
                <View style={[styles.statusBadge, { 
                  backgroundColor: device.isHardBanned ? theme.error : device.isDeleted ? theme.error : device.isOnline ? theme.success : theme.textSecondary 
                }]}>
                  <Text style={styles.statusText}>
                    {device.isHardBanned ? 'Hard banned' : device.isDeleted ? 'Deleted' : device.isOnline ? 'Online' : 'Offline'}
                  </Text>
                </View>
              </View>
              
              <Text style={[styles.deviceName, { color: theme.text }]}>
                {getDeviceDisplayName()}
              </Text>
              
              <Text style={[styles.userInfo, { color: theme.textSecondary }]}>
                Owner: {userEmail}
              </Text>
              
              <View style={styles.metadataGrid}>
                <View style={styles.metadataItem}>
                  <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>Device ID</Text>
                  <Text style={[styles.metadataValue, { color: theme.text }]} numberOfLines={2}>
                    {device.deviceId}
                  </Text>
                </View>
                
                {device.ipAddress && (
                  <View style={styles.metadataItem}>
                    <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>IP Address</Text>
                    <Text style={[styles.metadataValue, { color: theme.text }]}>
                      {device.ipAddress}
                    </Text>
                  </View>
                )}
                
                <View style={styles.metadataItem}>
                  <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>Last Seen</Text>
                  <Text style={[styles.metadataValue, { color: theme.text }]}>
                    {formatLastSeen()}
                  </Text>
                </View>
                
                {device.osName && (
                  <View style={styles.metadataItem}>
                    <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>Operating System</Text>
                    <Text style={[styles.metadataValue, { color: theme.text }]}>
                      {device.osName} {device.osVersion}
                    </Text>
                  </View>
                )}
              </View>
              
              {device.isDeleted && (
                <View style={[styles.deletionInfo, { backgroundColor: theme.error + '15', borderColor: theme.error }]}>
                  <View style={styles.deletionHeader}>
                    <AlertTriangle size={16} color={theme.error} />
                    <Text style={[styles.deletionTitle, { color: theme.error }]}>Device Deleted</Text>
                  </View>
                  <Text style={[styles.deletionDetails, { color: theme.textSecondary }]}>
                    Deleted by: {device.deletedByName || device.deletedBy}
                  </Text>
                  {device.deletedAt && (
                    <Text style={[styles.deletionDetails, { color: theme.textSecondary }]}>
                      Deleted on: {formatTimestamp(device.deletedAt)}
                    </Text>
                  )}
                  {device.deletionReason && (
                    <Text style={[styles.deletionReason, { color: theme.textSecondary }]}>
                      Reason: {device.deletionReason}
                    </Text>
                  )}
                </View>
              )}

              {/* Hard Ban Information */}
              {device.isHardBanned && device.banInfo && (
                <View style={[styles.hardBanInfo, { backgroundColor: theme.error + '20', borderColor: theme.error }]}>
                  <View style={styles.hardBanHeader}>
                    <Shield size={16} color={theme.error} />
                    <Text style={[styles.hardBanTitle, { color: theme.error }]}>
                      Device Hard Banned
                    </Text>
                  </View>
                  <Text style={[styles.hardBanDetails, { color: theme.textSecondary }]}>
                    Banned by: {device.banInfo.adminName || device.banInfo.adminEmail}
                  </Text>
                  <Text style={[styles.hardBanReason, { color: theme.textSecondary }]}>
                    Reason: {device.banInfo.reason}
                  </Text>
                  {device.banInfo.expiresAt && (
                    <Text style={[styles.hardBanExpiry, { color: theme.textSecondary }]}>
                      {(() => {
                        let expiryDate: Date;
                        try {
                          if (device.banInfo.expiresAt instanceof Date) {
                            expiryDate = device.banInfo.expiresAt;
                          } else if (device.banInfo.expiresAt instanceof Timestamp) {
                            expiryDate = device.banInfo.expiresAt.toDate();
                          } else if ((device.banInfo.expiresAt as any)?.toDate) {
                            expiryDate = (device.banInfo.expiresAt as any).toDate();
                          } else if ((device.banInfo.expiresAt as any)?.seconds) {
                            expiryDate = new Date((device.banInfo.expiresAt as any).seconds * 1000);
                          } else {
                            expiryDate = new Date(device.banInfo.expiresAt as any);
                          }
                        } catch (error) {
                          return `Expires: ${formatTimestamp(device.banInfo.expiresAt)}`;
                        }
                        
                        const now = new Date();
                        const diffTime = expiryDate.getTime() - now.getTime();
                        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                        
                        if (diffDays > 0) {
                          return `Expires in: ${diffDays} day${diffDays !== 1 ? 's' : ''}`;
                        } else {
                          return `Expired: ${formatTimestamp(device.banInfo.expiresAt)}`;
                        }
                      })()}
                    </Text>
                  )}
                  <Text style={[styles.hardBanTime, { color: theme.textSecondary }]}>
                    Banned on: {formatTimestamp(device.banInfo.createdAt)}
                  </Text>
                </View>
              )}

              {/* Logout Information - Show if device was logged out */}
              {(device.lastActivityType === 'forced_logout' || device.lastActivityType === 'logout' || device.logoutType) && (
                <View style={[styles.logoutInfo, { backgroundColor: theme.warning + '15', borderColor: theme.warning }]}>
                  <View style={styles.logoutHeader}>
                    <LogOut size={16} color={theme.warning} />
                    <Text style={[styles.logoutTitle, { color: theme.warning }]}>
                      {device.logoutType === 'forced' || device.lastActivityType === 'forced_logout' 
                        ? 'Force Logged Out' 
                        : 'Manually Logged Out'}
                    </Text>
                  </View>
                  
                  {/* Force logout details */}
                  {(device.logoutType === 'forced' || device.lastActivityType === 'forced_logout') && (
                    <>
                      {device.forcedLogoutByName && (
                        <Text style={[styles.logoutDetails, { color: theme.textSecondary }]}>
                          Logged out by: {device.forcedLogoutByName}
                        </Text>
                      )}
                      {device.forcedLogoutReason && (
                        <Text style={[styles.logoutReason, { color: theme.textSecondary }]}>
                          Reason: {device.forcedLogoutReason}
                        </Text>
                      )}
                      {device.forcedLogoutAt && (
                        <Text style={[styles.logoutTime, { color: theme.textSecondary }]}>
                          Time: {formatTimestamp(device.forcedLogoutAt)}
                        </Text>
                      )}
                    </>
                  )}
                  
                  {/* Manual logout details */}
                  {device.logoutType === 'manual' && device.manualLogoutAt && (
                    <Text style={[styles.logoutTime, { color: theme.textSecondary }]}>
                      Logged out manually at: {formatTimestamp(device.manualLogoutAt)}
                    </Text>
                  )}
                </View>
              )}
            </View>
          </View>

          {/* Action Selection */}
          <View style={[styles.actionsSection, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Available Actions</Text>
            
            <View style={styles.actionsList}>
              {/* Delete/Restore Action or Hard Ban Restore */}
              {device.isHardBanned ? (
                <TouchableOpacity
                  style={[
                    styles.actionOption,
                    { borderColor: theme.border },
                    selectedAction === 'restoreHardBan' && { 
                      borderColor: theme.success,
                      backgroundColor: theme.success + '10'
                    }
                  ]}
                  onPress={() => handleActionSelect('restoreHardBan')}
                  disabled={loading}
                >
                  <View style={styles.actionContent}>
                    <View style={styles.actionIcon}>
                      <Shield size={20} color={theme.success} />
                    </View>
                    <View style={styles.actionText}>
                      <Text style={[styles.actionTitle, { color: theme.text }]}>
                        Remove Hard Ban
                      </Text>
                      <Text style={[styles.actionDescription, { color: theme.textSecondary }]}>
                        Deactivate the hard ban and restore device access
                      </Text>
                    </View>
                  </View>
                  {selectedAction === 'restoreHardBan' && (
                    <CheckCircle size={20} color={theme.success} />
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.actionOption,
                    { borderColor: theme.border },
                    selectedAction === (device.isDeleted ? 'restore' : 'delete') && { 
                      borderColor: device.isDeleted ? theme.success : theme.error,
                      backgroundColor: (device.isDeleted ? theme.success : theme.error) + '10'
                    }
                  ]}
                  onPress={() => handleActionSelect(device.isDeleted ? 'restore' : 'delete')}
                  disabled={loading}
                >
                  <View style={styles.actionContent}>
                    <View style={styles.actionIcon}>
                      {device.isDeleted ? (
                        <RotateCcw size={20} color={theme.success} />
                      ) : (
                        <Ban size={20} color={theme.error} />
                      )}
                    </View>
                    <View style={styles.actionText}>
                      <Text style={[styles.actionTitle, { color: theme.text }]}>
                        {device.isDeleted ? 'Restore Device' : 'Delete Device'}
                      </Text>
                      <Text style={[styles.actionDescription, { color: theme.textSecondary }]}>
                        {device.isDeleted 
                          ? 'Restore this device and grant access again'
                          : 'Remove device access and require re-registration'
                        }
                      </Text>
                    </View>
                  </View>
                  {selectedAction === (device.isDeleted ? 'restore' : 'delete') && (
                    <CheckCircle size={20} color={device.isDeleted ? theme.success : theme.error} />
                  )}
                </TouchableOpacity>
              )}

              {/* Logout Action - Only for online, non-deleted, non-hard-banned devices */}
              {device.isOnline && !device.isDeleted && !device.isHardBanned && (
                <TouchableOpacity
                  style={[
                    styles.actionOption,
                    { borderColor: theme.border },
                    selectedAction === 'logout' && { 
                      borderColor: theme.warning,
                      backgroundColor: theme.warning + '10'
                    }
                  ]}
                  onPress={() => handleActionSelect('logout')}
                  disabled={loading}
                >
                  <View style={styles.actionContent}>
                    <View style={styles.actionIcon}>
                      <LogOut size={20} color={theme.warning} />
                    </View>
                    <View style={styles.actionText}>
                      <Text style={[styles.actionTitle, { color: theme.text }]}>
                        Force Logout
                      </Text>
                      <Text style={[styles.actionDescription, { color: theme.textSecondary }]}>
                        Remotely log out the user from this device
                      </Text>
                    </View>
                  </View>
                  {selectedAction === 'logout' && (
                    <CheckCircle size={20} color={theme.warning} />
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Action Details */}
          {selectedAction && currentConfig && (
            <View style={[styles.actionDetails, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <View style={styles.actionHeader}>
                {currentConfig.icon}
                <View style={styles.actionHeaderText}>
                  <Text style={[styles.actionDetailsTitle, { color: theme.text }]}>
                    {currentConfig.title}
                  </Text>
                  <Text style={[styles.actionDetailsDescription, { color: theme.textSecondary }]}>
                    {currentConfig.description}
                  </Text>
                </View>
              </View>

              {/* Reason Input (for delete action) */}
              {currentConfig.requiresReason && (
                <View style={styles.reasonSection}>
                  <Text style={[styles.reasonLabel, { color: theme.text }]}>
                    Reason for deletion <Text style={{ color: theme.error }}>*</Text>
                  </Text>
                  <TextInput
                    style={[styles.reasonInput, { 
                      backgroundColor: theme.background, 
                      borderColor: theme.border,
                      color: theme.text
                    }]}
                    placeholder="Please provide a reason for deleting this device..."
                    placeholderTextColor={theme.textSecondary}
                    value={reason}
                    onChangeText={setReason}
                    multiline
                    numberOfLines={3}
                    maxLength={500}
                    editable={!loading}
                  />
                  <Text style={[styles.characterCount, { color: theme.textSecondary }]}>
                    {reason.length}/500 characters
                  </Text>

                  {/* Permanent delete toggle */}
                  <TouchableOpacity
                    style={[styles.permanentRow, { borderColor: theme.border }]}
                    onPress={() => !loading && setPermanentDelete(v => !v)}
                    disabled={loading}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: permanentDelete }}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        { borderColor: permanentDelete ? theme.error : theme.border, backgroundColor: permanentDelete ? theme.error : 'transparent' }
                      ]}
                    >
                      {permanentDelete && <CheckCircle size={16} color="#fff" />}
                    </View>
                    <View style={styles.permanentTextWrap}>
                      <Text style={[styles.permanentTitle, { color: theme.text }]}>Delete permanently</Text>
                      <Text style={[styles.permanentNote, { color: theme.textSecondary }]}>
                        Also remove this device record from Database. This cannot be undone.
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>
              )}

              {/* Warning */}
              <View style={[styles.warningBox, { backgroundColor: theme.warning + '15', borderColor: theme.warning }]}>
                <AlertTriangle size={16} color={theme.warning} />
                <Text style={[styles.warningText, { color: theme.text }]}>
                  This action will take effect immediately and cannot be undone without admin intervention.
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Footer Actions */}
        <View style={[styles.footer, { borderTopColor: theme.border, backgroundColor: theme.surface }]}>
          <TouchableOpacity
            style={[styles.cancelButton, { backgroundColor: theme.background, borderColor: theme.border }]}
            onPress={onClose}
            disabled={loading}
          >
            <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.executeButton,
              { backgroundColor: selectedAction && currentConfig ? currentConfig.color : theme.textSecondary },
              (!selectedAction || loading) && styles.disabledButton
            ]}
            onPress={handleExecute}
            disabled={!selectedAction || loading || (currentConfig?.requiresReason && !reason.trim())}
          >
            {loading ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <View>
                <Text style={styles.executeButtonText}>
                  {currentConfig?.buttonText || 'Execute Action'}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Confirmation Modal */}
        <Modal
          visible={showConfirmation}
          transparent
          animationType="fade"
          onRequestClose={() => setShowConfirmation(false)}
        >
          <View style={styles.confirmationOverlay}>
            <View style={[styles.confirmationModal, { backgroundColor: theme.surface }]}>
              <View style={styles.confirmationHeader}>
                <AlertTriangle size={24} color={currentConfig?.color || theme.warning} />
                <Text style={[styles.confirmationTitle, { color: theme.text }]}>
                  Confirm Action
                </Text>
              </View>
              
              <Text style={[styles.confirmationMessage, { color: theme.textSecondary }] }>
                {selectedAction === 'delete' && permanentDelete
                  ? 'This will permanently delete this device and remove its records from Firestore. This cannot be undone. Continue?'
                  : currentConfig?.confirmText}
              </Text>
              
              <View style={styles.confirmationActions}>
                <TouchableOpacity
                  style={[styles.confirmationCancelButton, { backgroundColor: theme.background }]}
                  onPress={() => setShowConfirmation(false)}
                >
                  <Text style={[styles.confirmationCancelText, { color: theme.text }]}>Cancel</Text>
                </TouchableOpacity>
                
                <TouchableOpacity
                  style={[styles.confirmationConfirmButton, { backgroundColor: currentConfig?.color || theme.primary }]}
                  onPress={handleConfirm}
                >
                  <Text style={styles.confirmationConfirmText}>Confirm</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
  },
  closeButton: {
    padding: 4,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  
  // Device Info
  deviceInfo: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 16,
  },
  deviceDetails: {
    gap: 12,
  },
  deviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  deviceTypeIndicator: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  deviceTypeText: {
    color: 'white',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    color: 'white',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  deviceName: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
  },
  userInfo: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  metadataGrid: {
    gap: 12,
    marginTop: 8,
  },
  metadataItem: {
    gap: 4,
  },
  metadataLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  metadataValue: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  deletionInfo: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
  },
  deletionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  deletionTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  deletionDetails: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
  },
  deletionReason: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
    marginTop: 2,
  },

  // Logout Information
  logoutInfo: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
  },
  logoutHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  logoutTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  logoutDetails: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
  },
  logoutReason: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
    marginTop: 2,
  },
  logoutTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
    marginTop: 2,
  },

  // Hard Ban Information
  hardBanInfo: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
  },
  hardBanHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  hardBanTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  hardBanDetails: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
  },
  hardBanReason: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
    marginTop: 2,
  },
  hardBanExpiry: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
    marginTop: 2,
  },
  hardBanTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 24,
    marginTop: 2,
  },

  // Actions Section
  actionsSection: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 20,
  },
  actionsList: {
    gap: 12,
  },
  actionOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  actionText: {
    flex: 1,
    gap: 4,
  },
  actionTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  actionDescription: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },

  // Action Details
  actionDetails: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 20,
  },
  actionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  actionHeaderText: {
    flex: 1,
    gap: 4,
  },
  actionDetailsTitle: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
  },
  actionDetailsDescription: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  reasonSection: {
    marginBottom: 16,
  },
  reasonLabel: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  reasonInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    minHeight: 80,
    textAlignVertical: 'top',
  },
  characterCount: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    textAlign: 'right',
    marginTop: 4,
  },
  permanentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    marginTop: 12,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  permanentTextWrap: {
    flex: 1,
    gap: 2,
  },
  permanentTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  permanentNote: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  warningText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    flex: 1,
  },

  // Footer
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  executeButton: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  executeButtonText: {
    color: 'white',
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  disabledButton: {
    opacity: 0.6,
  },

  // Confirmation Modal
  confirmationOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  confirmationModal: {
    borderRadius: 12,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  confirmationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  confirmationTitle: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
  },
  confirmationMessage: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 20,
    marginBottom: 24,
  },
  confirmationActions: {
    flexDirection: 'row',
    gap: 12,
  },
  confirmationCancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmationCancelText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  confirmationConfirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmationConfirmText: {
    color: 'white',
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
});

export default DeviceActionModal;
