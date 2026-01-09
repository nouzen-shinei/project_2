import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  TouchableOpacity,
  Platform,
  Linking,
  Modal,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { Bell, MessageCircle, Quote, X, Megaphone, Users } from 'lucide-react-native';

import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@/hooks/useAuthUnified';
import { notificationService } from '@/services/notificationService';
import { logger } from '@/lib/logger';

type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

type PreferenceState = {
  pushEnabled: boolean;
  dailyQuotesEnabled: boolean;
  chatEnabled: boolean;
  noticesEnabled: boolean;
  teamNotificationsEnabled: boolean;
};

type ProcessingState = {
  push: boolean;
  dailyQuotes: boolean;
  chat: boolean;
  notices: boolean;
  team: boolean;
};

interface NotificationsPageProps {
  onClose?: () => void;
}

const NotificationsPage: React.FC<NotificationsPageProps> = ({ onClose }) => {
  const { theme } = useTheme();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermissionStatus>('undetermined');
  const [preferences, setPreferences] = useState<PreferenceState>({
    pushEnabled: true,
    dailyQuotesEnabled: true,
    chatEnabled: true,
    noticesEnabled: true,
    teamNotificationsEnabled: true,
  });
  const [processing, setProcessing] = useState<ProcessingState>({
    push: false,
    dailyQuotes: false,
    chat: false,
    notices: false,
    team: false,
  });
  const [closeRequested, setCloseRequested] = useState(false);
  const [processingMessage, setProcessingMessage] = useState<string | null>(null);

  const isPreferenceUpdateInProgress = useMemo(
    () =>
      processing.push ||
      processing.dailyQuotes ||
      processing.chat ||
      processing.notices ||
      processing.team,
    [processing.push, processing.dailyQuotes, processing.chat, processing.notices, processing.team]
  );

  const hasPendingProcesses = useMemo(
    () =>
      loading ||
      processing.push ||
      processing.dailyQuotes ||
      processing.chat ||
      processing.notices ||
      processing.team,
    [loading, processing.push, processing.dailyQuotes, processing.chat, processing.notices, processing.team]
  );

  useEffect(() => {
    let isMounted = true;

    const loadPreferences = async () => {
      try {
        const [{ status }, storedPrefs] = await Promise.all([
          Notifications.getPermissionsAsync(),
          notificationService.getNotificationPreferences(),
        ]);

        if (!isMounted) {
          return;
        }

        setPermissionStatus(status);
        setPreferences({
          pushEnabled: storedPrefs.notificationsEnabled,
          dailyQuotesEnabled: storedPrefs.dailyQuotesEnabled,
          chatEnabled: storedPrefs.chatNotificationsEnabled,
          noticesEnabled: storedPrefs.noticeNotificationsEnabled,
          teamNotificationsEnabled: storedPrefs.teamNotificationsEnabled ?? true,
        });
      } catch (error) {
        logger.error('Failed to load notification preferences:', error);
        if (isMounted) {
          Alert.alert('Error', 'Unable to load notification settings. Please try again later.');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadPreferences();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (closeRequested && !hasPendingProcesses) {
      onClose?.();
      setCloseRequested(false);
    }
  }, [closeRequested, hasPendingProcesses, onClose]);

  const toggleProcessing = useCallback((key: keyof ProcessingState, value: boolean) => {
    setProcessing((prev) => ({ ...prev, [key]: value }));
  }, []);

  const getProcessingMessage = useCallback((key: keyof ProcessingState, enabled: boolean) => {
    const action = enabled ? 'Turning on' : 'Turning off';

    switch (key) {
      case 'push':
        return enabled ? 'Enabling push notifications…' : 'Disabling push notifications…';
      case 'dailyQuotes':
        return enabled ? 'Scheduling daily quotes…' : 'Stopping daily quotes…';
      case 'chat':
        return enabled ? 'Enabling chat alerts…' : 'Muting chat alerts…';
      case 'notices':
        return enabled ? 'Enabling notice alerts…' : 'Muting notice alerts…';
      case 'team':
        return enabled ? 'Enabling team updates…' : 'Muting team updates…';
      default:
        return `${action} notifications…`;
    }
  }, []);

  const beginProcessing = useCallback(
    (key: keyof ProcessingState, enabled: boolean) => {
      setProcessingMessage(getProcessingMessage(key, enabled));
      toggleProcessing(key, true);
    },
    [getProcessingMessage, toggleProcessing]
  );

  useEffect(() => {
    if (!isPreferenceUpdateInProgress) {
      setProcessingMessage(null);
    }
  }, [isPreferenceUpdateInProgress]);

  const openNotificationSettings = useCallback(() => {
    if (Platform.OS === 'web') {
      Alert.alert(
        'Check Browser Settings',
        'Please enable notifications in your browser preferences.'
      );
      return;
    }

    Linking.openSettings().catch((error) => {
      logger.error('Failed to open notification settings:', error);
      Alert.alert('Error', 'Unable to open system settings. Please open them manually.');
    });
  }, []);

  const handlePushToggle = useCallback(
    async (value: boolean) => {
      if (processing.push) {
        return;
      }

      const previous = preferences.pushEnabled;
      setPreferences((prev) => ({ ...prev, pushEnabled: value }));
  beginProcessing('push', value);

      try {
        if (value) {
          let status = permissionStatus;

          if (status !== 'granted') {
            const { status: currentStatus } = await Notifications.getPermissionsAsync();
            status = currentStatus;

            if (status !== 'granted') {
              const { status: requestedStatus } = await Notifications.requestPermissionsAsync();
              status = requestedStatus;
            }

            setPermissionStatus(status);
          }

          if (status !== 'granted') {
            Alert.alert(
              'Permission Required',
              'Please enable notifications in your device settings to receive alerts.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: openNotificationSettings },
              ]
            );
            setPreferences((prev) => ({ ...prev, pushEnabled: previous }));
            return;
          }

          await notificationService.setNotificationsEnabled(true, user?.email ?? undefined);
        } else {
          await notificationService.setNotificationsEnabled(false);
        }
      } catch (error) {
        logger.error('Failed to toggle push notifications:', error);
        setPreferences((prev) => ({ ...prev, pushEnabled: previous }));
        Alert.alert('Error', 'Failed to update push notifications. Please try again.');
      } finally {
        toggleProcessing('push', false);
      }
    },
    [
      permissionStatus,
      preferences.pushEnabled,
      processing.push,
      toggleProcessing,
      user?.email,
      openNotificationSettings,
      beginProcessing,
    ]
  );

  const handleDailyQuotesToggle = useCallback(
    async (value: boolean) => {
      if (processing.dailyQuotes) {
        return;
      }

      const previous = preferences.dailyQuotesEnabled;
      setPreferences((prev) => ({ ...prev, dailyQuotesEnabled: value }));
  beginProcessing('dailyQuotes', value);

      try {
        if (value) {
          if (!preferences.pushEnabled) {
            Alert.alert('Enable Push Notifications', 'Please enable push notifications first.');
            setPreferences((prev) => ({ ...prev, dailyQuotesEnabled: previous }));
            return;
          }

          let status = permissionStatus;
          if (status !== 'granted') {
            const { status: currentStatus } = await Notifications.getPermissionsAsync();
            status = currentStatus;
            if (status !== 'granted') {
              const { status: requestedStatus } = await Notifications.requestPermissionsAsync();
              status = requestedStatus;
            }
            setPermissionStatus(status);
          }

          if (status !== 'granted') {
            Alert.alert(
              'Permission Required',
              'Please allow notifications to receive daily quotes.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: openNotificationSettings },
              ]
            );
            setPreferences((prev) => ({ ...prev, dailyQuotesEnabled: previous }));
            return;
          }
        }

        await notificationService.toggleDailyQuotes(value);

        Alert.alert(
          'Daily Quotes',
          value
            ? 'Daily quotes are now scheduled for 8:00 AM and 8:00 PM.'
            : 'Daily quote notifications have been turned off.'
        );
      } catch (error) {
        logger.error('Failed to toggle daily quotes:', error);
        setPreferences((prev) => ({ ...prev, dailyQuotesEnabled: previous }));
        Alert.alert('Error', 'Failed to update daily quotes. Please try again.');
      } finally {
        toggleProcessing('dailyQuotes', false);
      }
    },
    [
      permissionStatus,
      preferences.pushEnabled,
      preferences.dailyQuotesEnabled,
      processing.dailyQuotes,
      toggleProcessing,
      openNotificationSettings,
      beginProcessing,
    ]
  );

  const handleNoticeToggle = useCallback(
    async (value: boolean) => {
      if (processing.notices) {
        return;
      }

      const previous = preferences.noticesEnabled;
      setPreferences((prev) => ({ ...prev, noticesEnabled: value }));
  beginProcessing('notices', value);

      try {
        if (value && !preferences.pushEnabled) {
          Alert.alert('Enable Push Notifications', 'Please enable push notifications first.');
          setPreferences((prev) => ({ ...prev, noticesEnabled: previous }));
          return;
        }

        await notificationService.setNoticeNotificationsEnabled(value);
        Alert.alert(
          'Notice Notifications',
          value
            ? 'Notice alerts are enabled for this device.'
            : 'Notice notifications have been muted on this device.'
        );
      } catch (error) {
        logger.error('Failed to toggle notice notifications:', error);
        setPreferences((prev) => ({ ...prev, noticesEnabled: previous }));
        Alert.alert('Error', 'Failed to update notice notifications. Please try again.');
      } finally {
        toggleProcessing('notices', false);
      }
    },
    [processing.notices, preferences.noticesEnabled, preferences.pushEnabled, toggleProcessing, beginProcessing]
  );

  const handleTeamNotificationsToggle = useCallback(
    async (value: boolean) => {
      if (processing.team) {
        return;
      }

      const previous = preferences.teamNotificationsEnabled;
      setPreferences((prev) => ({ ...prev, teamNotificationsEnabled: value }));
  beginProcessing('team', value);

      try {
        if (value && !preferences.pushEnabled) {
          Alert.alert('Enable Push Notifications', 'Please enable push notifications first.');
          setPreferences((prev) => ({ ...prev, teamNotificationsEnabled: previous }));
          return;
        }

        await notificationService.setTeamNotificationsEnabled(value);
        Alert.alert(
          'Team Updates',
          value
            ? 'You will receive alerts when team members are added or removed.'
            : 'Team membership notifications have been muted on this device.'
        );
      } catch (error) {
        logger.error('Failed to toggle team notifications:', error);
        setPreferences((prev) => ({ ...prev, teamNotificationsEnabled: previous }));
        Alert.alert('Error', 'Failed to update team notifications. Please try again.');
      } finally {
        toggleProcessing('team', false);
      }
    },
    [processing.team, preferences.teamNotificationsEnabled, preferences.pushEnabled, toggleProcessing, beginProcessing]
  );

  const handleChatToggle = useCallback(
    async (value: boolean) => {
      if (processing.chat) {
        return;
      }

      const previous = preferences.chatEnabled;
      setPreferences((prev) => ({ ...prev, chatEnabled: value }));
  beginProcessing('chat', value);

      try {
        await notificationService.setChatNotificationsEnabled(value);
        Alert.alert(
          'Chat Notifications',
          value ? 'Chat notifications are enabled.' : 'Chat notifications have been muted.'
        );
      } catch (error) {
        logger.error('Failed to toggle chat notifications:', error);
        setPreferences((prev) => ({ ...prev, chatEnabled: previous }));
        Alert.alert('Error', 'Failed to update chat notifications. Please try again.');
      } finally {
        toggleProcessing('chat', false);
      }
    },
    [preferences.chatEnabled, processing.chat, toggleProcessing, beginProcessing]
  );

  const handleClosePress = useCallback(() => {
    if (!onClose) {
      return;
    }

    if (!hasPendingProcesses) {
      onClose();
      return;
    }

    setCloseRequested(true);
  }, [hasPendingProcesses, onClose]);

  const permissionLabel = useMemo(() => {
    switch (permissionStatus) {
      case 'granted':
        return 'Notifications permitted';
      case 'denied':
        return 'Notifications blocked at system level';
      default:
        return 'Permission undetermined';
    }
  }, [permissionStatus]);

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.background }]}> 
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading notification settings…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}> 
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {onClose ? (
            <TouchableOpacity
              onPress={handleClosePress}
              accessibilityLabel="Close notification settings"
              disabled={closeRequested && hasPendingProcesses}
              style={[
                styles.closeButton,
                closeRequested && hasPendingProcesses ? styles.closeButtonDisabled : null,
              ]}
            >
              {closeRequested && hasPendingProcesses ? (
                <ActivityIndicator size="small" color={theme.text} />
              ) : (
                <X size={24} color={theme.text} />
              )}
            </TouchableOpacity>
          ) : null}
          <Text style={[styles.headerTitle, { color: theme.text }]}>Notifications</Text>
        </View>
        <Text style={[styles.permissionStatus, { color: theme.textSecondary }]}>{permissionLabel}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.card, { backgroundColor: theme.surface }]}> 
          <View style={styles.cardHeader}>
            <Bell size={22} color={theme.primary} />
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Push Notifications</Text>
              <Text style={[styles.cardSubtitle, { color: theme.textSecondary }]}>Enable to receive alerts, reminders, and chat messages on this device.</Text>
            </View>
            <Switch
              value={preferences.pushEnabled}
              onValueChange={handlePushToggle}
              trackColor={{ false: theme.border, true: theme.primary }}
              thumbColor={Platform.OS === 'ios' ? undefined : theme.surface}
              disabled={processing.push}
            />
          </View>
          {permissionStatus === 'denied' ? (
            <Text style={[styles.warningText, { color: theme.error }]}>Notifications are blocked by the OS. Enable them in system settings to receive alerts.</Text>
          ) : null}
        </View>

        <View style={[styles.card, { backgroundColor: theme.surface }]}> 
          <View style={styles.cardHeader}>
            <Megaphone size={22} color={theme.primary} />
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Notice Notifications</Text>
              <Text style={[styles.cardSubtitle, { color: theme.textSecondary }]}>Get notified when new notices are posted.</Text>
            </View>
            <Switch
              value={preferences.noticesEnabled}
              onValueChange={handleNoticeToggle}
              trackColor={{ false: theme.border, true: theme.primary }}
              thumbColor={Platform.OS === 'ios' ? undefined : theme.surface}
              disabled={
                processing.notices ||
                (!preferences.pushEnabled && !preferences.noticesEnabled)
              }
            />
          </View>
          {!preferences.pushEnabled ? (
            <Text style={[styles.infoText, { color: theme.textSecondary }]}>Enable push notifications to receive notice alerts.</Text>
          ) : null}
        </View>

        <View style={[styles.card, { backgroundColor: theme.surface }]}> 
          <View style={styles.cardHeader}>
            <Quote size={22} color={theme.primary} />
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Daily Quotes</Text>
              <Text style={[styles.cardSubtitle, { color: theme.textSecondary }]}>Receive inspirational quotes at 8:00 AM and 8:00 PM.</Text>
            </View>
            <Switch
              value={preferences.dailyQuotesEnabled}
              onValueChange={handleDailyQuotesToggle}
              trackColor={{ false: theme.border, true: theme.primary }}
              thumbColor={Platform.OS === 'ios' ? undefined : theme.surface}
              disabled={
                processing.dailyQuotes ||
                (!preferences.pushEnabled && !preferences.dailyQuotesEnabled)
              }
            />
          </View>
          {!preferences.pushEnabled ? (
            <Text style={[styles.infoText, { color: theme.textSecondary }]}>Enable push notifications to receive scheduled quotes.</Text>
          ) : null}
          
        </View>

        <View style={[styles.card, { backgroundColor: theme.surface }]}> 
          <View style={styles.cardHeader}>
            <Users size={22} color={theme.primary} />
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Team Membership Updates</Text>
              <Text style={[styles.cardSubtitle, { color: theme.textSecondary }]}>Get notified whenever a user or admin is added or removed.</Text>
            </View>
            <Switch
              value={preferences.teamNotificationsEnabled}
              onValueChange={handleTeamNotificationsToggle}
              trackColor={{ false: theme.border, true: theme.primary }}
              thumbColor={Platform.OS === 'ios' ? undefined : theme.surface}
              disabled={
                processing.team ||
                (!preferences.pushEnabled && !preferences.teamNotificationsEnabled)
              }
            />
          </View>
          {!preferences.pushEnabled ? (
            <Text style={[styles.infoText, { color: theme.textSecondary }]}>Enable push notifications to receive team updates.</Text>
          ) : null}
        </View>

        <View style={[styles.card, { backgroundColor: theme.surface }]}> 
          <View style={styles.cardHeader}>
            <MessageCircle size={22} color={theme.primary} />
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Chat Notifications</Text>
              <Text style={[styles.cardSubtitle, { color: theme.textSecondary }]}>Control message alerts from team conversations.</Text>
            </View>
            <Switch
              value={preferences.chatEnabled}
              onValueChange={handleChatToggle}
              trackColor={{ false: theme.border, true: theme.primary }}
              thumbColor={Platform.OS === 'ios' ? undefined : theme.surface}
              disabled={processing.chat}
            />
          </View>
          {!preferences.pushEnabled ? (
            <Text style={[styles.infoText, { color: theme.textSecondary }]}>Push notifications must stay enabled for chat alerts.</Text>
          ) : null}
        </View>
      </ScrollView>

      <Modal
        visible={isPreferenceUpdateInProgress}
        transparent
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalContent, { backgroundColor: theme.surface }]}> 
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={[styles.modalText, { color: theme.textSecondary }]}>
              {processingMessage ?? 'Processing notification changes…'}
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonDisabled: {
    opacity: 0.5,
  },
  headerTitle: {
    fontSize: 22,
    fontFamily: 'Inter-SemiBold',
  },
  permissionStatus: {
    marginTop: 8,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 16,
  },
  card: {
    borderRadius: 18,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardHeaderText: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  cardSubtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 20,
  },
  warningText: {
    marginTop: 12,
    fontFamily: 'Inter-Medium',
    fontSize: 13,
  },
  infoText: {
    marginTop: 12,
    fontFamily: 'Inter-Regular',
    fontSize: 13,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalContent: {
    width: '70%',
    maxWidth: 320,
    borderRadius: 18,
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 6,
  },
  modalText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
});

export default NotificationsPage;