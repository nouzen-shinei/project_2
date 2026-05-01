import React, { memo } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { ArrowLeft, Search, X } from 'lucide-react-native';

import { useChatStable, useChatReactive } from './ChatContext';
import { formatOnlineStatus } from '../../lib/timeUtils';
import TenantRoleBadge from '../TenantRoleBadge';
import AnimatedTypingIndicator from '../AnimatedTypingIndicator';

interface ChatHeaderProps {
  sharedTopPadding: number;
  effectiveHeaderComp: number;
  handleBackToChatList: () => void;
  openChatProfileModal: () => void;
  isTyping: boolean;
  toggleConversationSearch: () => void;
  conversationSearchVisible: boolean;
}

export const ChatHeader = memo(function ChatHeader({
  sharedTopPadding,
  effectiveHeaderComp,
  handleBackToChatList,
  openChatProfileModal,
  isTyping,
  toggleConversationSearch,
  conversationSearchVisible,
}: ChatHeaderProps) {
  const { getProfilePictureURL, getSafeDisplayInitial } = useChatStable();
  const { theme, selectedTeamMember } = useChatReactive();

  return (
    <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
      <TouchableOpacity 
        onPress={handleBackToChatList}
        style={styles.backButton}
      >
        <ArrowLeft size={24} color={theme.text} />
      </TouchableOpacity>
      
      <TouchableOpacity 
        style={styles.friendInfo}
        onPress={openChatProfileModal}
        activeOpacity={0.7}
      >
        <View style={[styles.avatar, { backgroundColor: theme.primary }]}>
          {getProfilePictureURL(selectedTeamMember) ? (
            <Image
              source={{ uri: getProfilePictureURL(selectedTeamMember) }}
              style={styles.avatarImage}
            />
          ) : (
            <Text style={styles.avatarText}>
              {getSafeDisplayInitial(selectedTeamMember?.name || 'T')}
            </Text>
          )}
        </View>

        <View>
          <View style={styles.friendNameRow}>
            <Text allowFontScaling={false} style={[styles.friendName, { color: theme.text }]}> 
              {selectedTeamMember?.name || 'Select Team Member'}
            </Text>
            {!!selectedTeamMember && (
              <TenantRoleBadge role={(selectedTeamMember as any)?.tenantRole ?? null} style={styles.marginLeft8} />
            )}
          </View>
          <View style={styles.friendStatusContainer}>
            {isTyping ? (
              <View style={styles.friendTypingRow}>
                <Text allowFontScaling={false} style={[styles.friendStatus, styles.friendTypingText, { color: theme.primary }]}>
                  typing...
                </Text>
                <View style={styles.marginLeft6}>
                  <AnimatedTypingIndicator color={theme.primary} />
                </View>
              </View>
            ) : (
              <>
                {selectedTeamMember?.isOnline !== undefined && (
                  <View style={[
                    styles.statusDot,
                    { backgroundColor: selectedTeamMember.isOnline ? theme.success : theme.textSecondary }
                  ]} />
                )}
                <Text allowFontScaling={false} style={[styles.friendStatus, { color: theme.textSecondary }]}>
                  {formatOnlineStatus(selectedTeamMember?.isOnline, selectedTeamMember?.lastSeen)}
                </Text>
              </>
            )}
          </View>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={toggleConversationSearch}
        style={styles.headerButton}
        accessibilityRole="button"
        accessibilityLabel={conversationSearchVisible ? 'Close conversation search' : 'Search this conversation'}
      >
        {conversationSearchVisible ? (
          <X size={20} color={theme.text} />
        ) : (
          <Search size={20} color={theme.text} />
        )}
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  headerButton: {
    padding: 8,
  },
  backButton: {
    padding: 8,
    marginRight: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  friendInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: 24,
  },
  avatarText: {
    fontSize: 16,
    fontFamily: 'Poppins-Bold',
    color: '#ffffff',
  },
  friendNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  friendName: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  friendStatus: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  friendStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  friendTypingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  friendTypingText: {
    fontFamily: 'Inter-Medium',
    fontStyle: 'italic',
  },
  marginLeft6: {
    marginLeft: 6,
  },
  marginLeft8: {
    marginLeft: 8,
  },
});
