import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CreditCard, X } from 'lucide-react-native';

import { useTheme } from '@/hooks/useTheme';

interface TenantQuotaUpgradeModalProps {
  visible: boolean;
  onClose: () => void;
}

const TenantQuotaUpgradeModal = ({ visible, onClose }: TenantQuotaUpgradeModalProps) => {
  const { theme } = useTheme();
  const router = useRouter();

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>Need more seats?</Text>
            <Pressable onPress={onClose} style={styles.closeButton}>
              <X size={18} color={theme.textSecondary} />
            </Pressable>
          </View>
          <Text style={[styles.body, { color: theme.textSecondary }]}>Upgrade your plan to unlock higher student limits, additional staff seats, and priority support for your coaching center.</Text>
          <Pressable
            style={[styles.actionButton, { backgroundColor: theme.primary }]}
            onPress={() => {
              onClose();
              router.push('/(tabs)/plan');
            }}
          >
            <CreditCard size={16} color="#fff" />
            <Text style={styles.actionButtonText}>Upgrade</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  closeButton: {
    padding: 6,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  actionButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});

export default TenantQuotaUpgradeModal;
