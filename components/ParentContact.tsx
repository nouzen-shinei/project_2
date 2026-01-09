import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Linking } from 'react-native';
import { Phone, Mail, MessageCircle } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';

interface ParentContactProps {
  parentContact?: string;
  parentEmail?: string;
  parentWhatsApp?: string;
  studentName: string;
  compact?: boolean;
}

export default function ParentContact({ 
  parentContact, 
  parentEmail, 
  parentWhatsApp, 
  studentName,
  compact = false 
}: ParentContactProps) {
  const { theme } = useTheme();

  const handleCall = () => {
    if (parentContact) {
      Linking.openURL(`tel:${parentContact}`);
    }
  };

  const handleEmail = () => {
    if (parentEmail) {
      const subject = `Regarding ${studentName}'s tuition`;
      Linking.openURL(`mailto:${parentEmail}?subject=${encodeURIComponent(subject)}`);
    }
  };

  const handleWhatsApp = () => {
    if (parentWhatsApp) {
      const message = `Dear Parent, this is regarding ${studentName}'s tuition.`;
      Linking.openURL(`whatsapp://send?phone=${parentWhatsApp}&text=${encodeURIComponent(message)}`);
    }
  };

  if (compact) {
    return (
      <View style={styles.compactContainer}>
        {parentContact && (
          <TouchableOpacity onPress={handleCall} style={styles.compactAction}>
            <Phone size={14} color={theme.primary} />
          </TouchableOpacity>
        )}
        {parentEmail && (
          <TouchableOpacity onPress={handleEmail} style={styles.compactAction}>
            <Mail size={14} color={theme.primary} />
          </TouchableOpacity>
        )}
        {parentWhatsApp && (
          <TouchableOpacity onPress={handleWhatsApp} style={styles.compactAction}>
            <MessageCircle size={14} color={theme.success} />
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {parentContact && (
        <View style={styles.contactItem}>
          <Phone size={14} color={theme.textSecondary} />
          <Text style={[styles.contactText, { color: theme.textSecondary }]}>{parentContact}</Text>
          <TouchableOpacity onPress={handleCall} style={[styles.actionButton, { backgroundColor: `${theme.primary}15` }]}>
            <Text style={[styles.actionText, { color: theme.primary }]}>Call</Text>
          </TouchableOpacity>
        </View>
      )}
      {parentEmail && (
        <View style={styles.contactItem}>
          <Mail size={14} color={theme.textSecondary} />
          <Text style={[styles.contactText, { color: theme.textSecondary }]}>{parentEmail}</Text>
          <TouchableOpacity onPress={handleEmail} style={[styles.actionButton, { backgroundColor: `${theme.primary}15` }]}>
            <Text style={[styles.actionText, { color: theme.primary }]}>Email</Text>
          </TouchableOpacity>
        </View>
      )}
      {parentWhatsApp && (
        <View style={styles.contactItem}>
          <MessageCircle size={14} color={theme.success} />
          <Text style={[styles.contactText, { color: theme.textSecondary }]}>{parentWhatsApp}</Text>
          <TouchableOpacity onPress={handleWhatsApp} style={[styles.actionButton, { backgroundColor: `${theme.success}15` }]}>
            <Text style={[styles.actionText, { color: theme.success }]}>WhatsApp</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  compactContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  contactText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    flex: 1,
  },
  actionButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  actionText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  compactAction: {
    padding: 6,
    borderRadius: 6,
  },
});
