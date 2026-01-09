import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useAuth } from '@/hooks/useAuthUnified';
import { useTenant } from '@/hooks/useTenantContext';
import { useTheme } from '@/hooks/useTheme';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import TenantMembershipManager from './TenantMembershipManager';

interface TenantAccessScreenProps {
  visible: boolean;
  onClose?: () => void;
}

const TenantAccessScreen = ({ visible, onClose }: TenantAccessScreenProps) => {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { user } = useAuth();
  const { memberships, pendingMemberships } = useTenant();
  const { isOffline } = useNetworkStatus();

  const hasPending = pendingMemberships.length > 0;
  const headline = user?.displayName ? `Welcome, ${user.displayName}` : 'Welcome';
  const subhead = memberships.length
    ? 'Activate a coaching center to continue.'
    : 'Create or join a coaching center to start using the app.';
  const helper = isOffline
    ? 'Reconnect to create or join a coaching center.'
    : 'Use the options below to add this account to a workspace.';

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.backdrop,
          {
            paddingTop: Math.max(insets.top + 24, 60),
            paddingBottom: Math.max(insets.bottom + 24, 60),
          },
        ]}
      >
        <View
          style={[
            styles.card,
            {
              borderColor: theme.border,
              backgroundColor: theme.surface,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.headline, { color: theme.text }]}>{headline}</Text>
              <Text style={[styles.subhead, { color: theme.textSecondary }]}>{subhead}</Text>
              <Text style={[styles.helper, { color: theme.textSecondary }]}>{helper}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[styles.closeButton, { borderColor: theme.border }]}> 
              <X size={16} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
          {hasPending && (
            <View style={[styles.pendingPill, { backgroundColor: `${theme.warning}1A` }]}> 
              <Text style={[styles.pendingText, { color: theme.warning }]}>
                {pendingMemberships.length} pending {pendingMemberships.length === 1 ? 'request' : 'requests'} awaiting approval
              </Text>
            </View>
          )}
          <ScrollView
            style={styles.cardBody}
            contentContainerStyle={{ paddingBottom: 12 }}
            keyboardShouldPersistTaps="handled"
          >
            <TenantMembershipManager />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 520,
    borderWidth: 1,
    borderRadius: 24,
    padding: 20,
    maxHeight: '90%',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  headline: {
    fontSize: 20,
    fontWeight: '700',
  },
  subhead: {
    fontSize: 15,
    marginTop: 8,
  },
  helper: {
    fontSize: 13,
    marginTop: 8,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  pendingPill: {
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  pendingText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  cardBody: {
    flexGrow: 1,
  },
});

export default TenantAccessScreen;
