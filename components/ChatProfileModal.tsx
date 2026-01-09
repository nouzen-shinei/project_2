import React from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  Image,
  ScrollView,
  Dimensions,
} from 'react-native';
import {
  X,
  User,
  Mail,
  School,
  FileText,
  Clock,
  Circle,
  Phone,
 Calendar } from 'lucide-react-native';
import { TeamMember } from '../hooks/useAuthUnified';
import { formatOnlineStatus } from '../lib/timeUtils';
import { getProfileImageUrl } from '../lib/profileImage';
import TenantRoleBadge from '@/components/TenantRoleBadge';

const { width: screenWidth } = Dimensions.get('window');

interface ChatProfileModalProps {
  visible: boolean;
  onClose: () => void;
  teamMember: TeamMember | null;
  theme: any;
}

export default function ChatProfileModal({
  visible,
  onClose,
  teamMember,
  theme,
}: ChatProfileModalProps) {
  if (!teamMember) return null;

  // Use shared helper to ensure consistent profile image selection across the app
  const profileImageUrl = getProfileImageUrl(teamMember);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          {/* Header */}
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Profile</Text>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.closeButton, { backgroundColor: theme.surface }]}
            >
              <X size={20} color={theme.text} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
            {/* Profile Picture and Basic Info */}
            <View style={[styles.profileSection, { backgroundColor: theme.surface }]}>
              <View style={styles.profileImageContainer}>
                {profileImageUrl ? (
                  <Image 
                    source={{ uri: profileImageUrl }} 
                    style={styles.profileImage}
                  />
                ) : (
                  <View style={[styles.profileImagePlaceholder, { backgroundColor: theme.primary }]}>
                    <User size={50} color="#ffffff" />
                  </View>
                )}
              </View>

              <Text style={[styles.profileName, { color: theme.text }]}>
                {teamMember.salutation ? `${teamMember.salutation} ${teamMember.name}` : teamMember.name}
              </Text>

              {/* Online Status */}
              <View style={styles.statusContainer}>
                <View style={[
                  styles.statusIndicator,
                  { backgroundColor: teamMember.isOnline ? theme.success : theme.textSecondary }
                ]} />
                <Text style={[styles.statusText, { color: theme.textSecondary }]}>
                  {formatOnlineStatus(teamMember.isOnline, teamMember.lastSeen)}
                </Text>
              </View>

              {/* Role Badge */}
              <View style={styles.roleBadgeContainer}>
                <TenantRoleBadge role={(teamMember as any)?.tenantRole ?? null} />
              </View>
            </View>

            {/* Contact Information */}
            <View style={[styles.infoSection, { backgroundColor: theme.surface }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Contact Information</Text>
              
              <View style={styles.infoRow}>
                <View style={[styles.infoIcon, { backgroundColor: theme.primary + '20' }]}>
                  <Mail size={20} color={theme.primary} />
                </View>
                <View style={styles.infoContent}>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Email</Text>
                  <Text style={[styles.infoValue, { color: theme.text }]}>
                    {teamMember.email}
                  </Text>
                </View>
              </View>

              {teamMember.phone && (
                <View style={styles.infoRow}>
                  <View style={[styles.infoIcon, { backgroundColor: theme.success + '20' }]}>
                    <Phone size={20} color={theme.success} />
                  </View>
                  <View style={styles.infoContent}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Phone</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>
                      {teamMember.phone}
                    </Text>
                  </View>
                </View>
              )}

              {teamMember.dateOfBirth && (
                <View style={[styles.infoRow, { marginTop: 12 }]}> 
                  <View style={[styles.infoIcon, { backgroundColor: theme.primary + '20' }]}> 
                    <Calendar size={20} color={theme.primary} />
                  </View>
                  <View style={styles.infoContent}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Date of Birth</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}> 
                      {new Date(teamMember.dateOfBirth).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </Text>
                  </View>
                </View>
              )}

              {teamMember.subjects && teamMember.subjects.length > 0 && (
                <View style={[styles.infoRow, { marginTop: 12 }]}> 
                  <View style={[styles.infoIcon, { backgroundColor: theme.warning + '20' }]}> 
                    <FileText size={20} color={theme.warning} />
                  </View>
                  <View style={styles.infoContent}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Subjects</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}> 
                      {teamMember.subjects.join(', ')}
                    </Text>
                  </View>
                </View>
              )}
            </View>

            {/* Institution Information */}
            {teamMember.school && (
              <View style={[styles.infoSection, { backgroundColor: theme.surface }]}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Institution</Text>
                
                <View style={styles.infoRow}>
                  <View style={[styles.infoIcon, { backgroundColor: theme.warning + '20' }]}>
                    <School size={20} color={theme.warning} />
                  </View>
                  <View style={styles.infoContent}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>School/Institution</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>
                      {teamMember.school}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Bio Section */}
            {teamMember.bio && (
              <View style={[styles.infoSection, { backgroundColor: theme.surface }]}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>About</Text>
                
                <View style={styles.infoRow}>
                  <View style={[styles.infoIcon, { backgroundColor: theme.error + '20' }]}>
                    <FileText size={20} color={theme.error} />
                  </View>
                  <View style={styles.infoContent}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Bio</Text>
                    <Text style={[styles.bioText, { color: theme.text }]}>
                      {teamMember.bio}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Empty State if no additional info */}
            {!teamMember.school && !teamMember.bio && !teamMember.phone && (
              <View style={[styles.infoSection, { backgroundColor: theme.surface }]}>
                <View style={styles.emptyState}>
                  <User size={40} color={theme.textSecondary} />
                  <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>
                    No additional information available
                  </Text>
                  <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}> 
                    {(() => {
                      const rawName = teamMember?.name || 'This user';
                      const safeName = typeof rawName === 'string' ? rawName.trim() : 'This user';
                      if (!safeName || safeName === '.' || safeName.length === 0) return 'This user';
                      return safeName;
                    })()}
                    {" hasn't added their contact details, bio or school information yet."}
                  </Text>
                </View>
              </View>
            )}

            {/* Bottom spacing */}
            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    minHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalContent: {
    flex: 1,
  },
  profileSection: {
    alignItems: 'center',
    padding: 24,
    margin: 16,
    borderRadius: 16,
  },
  profileImageContainer: {
    marginBottom: 16,
  },
  profileImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  profileImagePlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileName: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
    marginBottom: 8,
    textAlign: 'center',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  roleBadgeContainer: {
    alignItems: 'center',
  },
  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  roleText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 4,
  },
  infoSection: {
    margin: 16,
    marginTop: 0,
    padding: 20,
    borderRadius: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 16,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  infoIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  infoContent: {
    flex: 1,
    justifyContent: 'center',
  },
  infoLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  bioText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    lineHeight: 24,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyStateText: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
    marginTop: 16,
    textAlign: 'center',
  },
  emptyStateSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
});
