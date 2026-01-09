import { logger } from '@/lib/logger';
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  Image,
  Dimensions,
  Linking,
  Platform,
} from 'react-native';
import { 
  X, 
  ExternalLink,
  AlertCircle,
  CheckCircle,
  Clock,
  Music,
  User,
  Calendar,
  ChevronLeft,
  ChevronRight
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { useNotices } from '../hooks/useNotices';
import { useAuth } from '../hooks/useAuthUnified';
import { Notice } from '../types/notice';
import Toast from 'react-native-toast-message';
import { useTenant } from '../hooks/useTenantContext';
import { tenantService } from '../services/tenantService';
import type { TenantMembershipRole } from '../types/tenant';
import { AudioPlayer } from './AudioPlayer';

const formatFileSize = (size?: number) => {
  if (!size || size <= 0) return 'Unknown size';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDuration = (durationMs?: number) => {
  if (!durationMs || durationMs <= 0) return 'Unknown duration';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
};

interface NoticePopupProps {
  visible: boolean;
  onClose: () => void;
  notices: Notice[];
}

const NoticePopup: React.FC<NoticePopupProps> = ({ visible, onClose, notices }) => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { activeTenant } = useTenant();
  const { markNoticeAsViewed } = useNotices();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [screenData, setScreenData] = useState(Dimensions.get('window'));
  const [creatorRole, setCreatorRole] = useState<TenantMembershipRole | 'system' | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [viewedInSession, setViewedInSession] = useState<Set<string>>(new Set());

  const formatRoleLabel = (role: TenantMembershipRole | 'system' | null | undefined): string | null => {
    if (!role) return null;
    if (role === 'system') return 'System';
    return role.charAt(0).toUpperCase() + role.slice(1);
  };

  // Dynamic height calculation similar to NoticeModal
  const modalMaxWidth = Math.min(screenData.width * 0.9, 400);
  const maxModalHeight = screenData.height * 0.8; // Maximum 80% of screen height

  // Load creator's tenant role when current notice changes
  useEffect(() => {
    const loadCreatorRole = async () => {
      const currentNotice = notices[currentIndex];
      if (!currentNotice) return;

      if (typeof (currentNotice as any).createdByRole === 'string') {
        setCreatorRole((currentNotice as any).createdByRole as TenantMembershipRole | 'system' | null);
        return;
      }

      const email = currentNotice.createdByEmail?.toLowerCase?.() ?? null;
      const tenantId = currentNotice.tenantId || activeTenant?.id || null;
      if (!email || !tenantId) {
        setCreatorRole(null);
        return;
      }

      try {
        const memberships = await tenantService.getActiveMembershipsForTenant(tenantId);
        const matching = memberships.find((m) => (m.email?.toLowerCase?.() ?? '') === email);
        setCreatorRole((matching?.role as TenantMembershipRole | undefined) ?? null);
      } catch (error) {
        logger.warn('Failed to get tenant membership role:', error);
        setCreatorRole(null);
      }
    };
    
    if (notices.length > 0 && currentIndex < notices.length) {
      loadCreatorRole();
      
      // Get image dimensions if there's an image
      const currentNotice = notices[currentIndex];
      if (currentNotice?.imageUrl) {
        if (Platform.OS === 'web') {
          // For web, load image using HTML Image element for better compatibility
          const img = new window.Image();
          img.onload = () => {
            setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
          };
          img.onerror = (error) => {
            logger.warn('Failed to get image dimensions on web:', error);
            setImageDimensions(null);
          };
          img.src = currentNotice.imageUrl;
        } else {
          // For native platforms, use React Native's Image.getSize
          Image.getSize(
            currentNotice.imageUrl,
            (width, height) => {
              setImageDimensions({ width, height });
            },
            (error) => {
              logger.warn('Failed to get image dimensions:', error);
              setImageDimensions(null);
            }
          );
        }
      } else {
        setImageDimensions(null);
      }
    }
  }, [currentIndex, notices, activeTenant?.id]);

  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setScreenData(window);
    });
    return () => subscription?.remove?.();
  }, []);

  const currentNotice = notices[currentIndex];
  const hasMultiple = notices.length > 1;

  const handleClose = async () => {
    if (isClosing) return;
    
    setIsClosing(true);
    
    try {
      // Only mark the current notice as viewed if not already viewed in this session
      if (currentNotice && !viewedInSession.has(currentNotice.id)) {
        await markNoticeAsViewed(currentNotice.id);
        setViewedInSession(prev => new Set([...prev, currentNotice.id]));
      }
      onClose();
    } catch (error) {
      logger.error('[NoticePopup] Error closing notice:', error);
      // Still close even if marking as viewed fails
      onClose();
    } finally {
      // Reset loading state and session tracking after a delay to prevent immediate reopening
      setTimeout(() => {
        setIsClosing(false);
        setViewedInSession(new Set()); // Clear session tracking when closing
      }, 1000);
    }
  };

  const handleNext = async () => {
    if (isNavigating || isClosing) return;
    setIsNavigating(true);
    
    // Mark current notice as viewed before navigating to next (only if not already viewed in this session)
    if (currentNotice && !viewedInSession.has(currentNotice.id)) {
      try {
        await markNoticeAsViewed(currentNotice.id);
        setViewedInSession(prev => new Set([...prev, currentNotice.id]));
      } catch (error) {
        logger.error('[NoticePopup] Error marking notice as viewed on next:', error);
      }
    }
    
    if (currentIndex < notices.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
    
    setTimeout(() => {
      setIsNavigating(false);
    }, 300);
  };

  const handlePrevious = async () => {
    if (isNavigating || isClosing) return;
    setIsNavigating(true);
    
    // Mark current notice as viewed before navigating to previous (only if not already viewed in this session)
    if (currentNotice && !viewedInSession.has(currentNotice.id)) {
      try {
        await markNoticeAsViewed(currentNotice.id);
        setViewedInSession(prev => new Set([...prev, currentNotice.id]));
      } catch (error) {
        logger.error('[NoticePopup] Error marking notice as viewed on previous:', error);
      }
    }
    
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
    
    setTimeout(() => {
      setIsNavigating(false);
    }, 300);
  };

  const handleOpenLink = async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        Toast.show({
          type: 'error',
          text1: 'Cannot open link',
          text2: 'Invalid or unsupported URL',
          position: 'top',
        });
      }
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Error opening link',
        text2: 'Please try again',
        position: 'top',
      });
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return theme.error;
      case 'medium': return theme.warning;
      case 'low': return theme.success;
      default: return theme.textSecondary;
    }
  };

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case 'high': return AlertCircle;
      case 'medium': return Clock;
      case 'low': return CheckCircle;
      default: return Clock;
    }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Unknown date';
    }
  };

  if (!currentNotice || !visible) return null;

  const PriorityIcon = getPriorityIcon(currentNotice.priority);
  const userView = currentNotice.userViews?.[user?.uid || ''];
  const viewCount = userView?.count || 0;

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="fade"
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <View style={[
          styles.container, 
          { 
            backgroundColor: theme.surface,
            maxWidth: modalMaxWidth,
            maxHeight: maxModalHeight,
          }
        ]}>
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <View style={styles.headerLeft}>
              <View style={[styles.priorityBadge, { backgroundColor: `${getPriorityColor(currentNotice.priority)}20` }]}>
                <PriorityIcon size={16} color={getPriorityColor(currentNotice.priority)} />
                <Text style={[styles.priorityText, { color: getPriorityColor(currentNotice.priority) }]}>
                  {currentNotice.priority.toUpperCase()}
                </Text>
              </View>
              {hasMultiple && (
                <View style={[styles.countBadge, { backgroundColor: theme.primary }]}>
                  <Text style={styles.countText}>
                    {currentIndex + 1} of {notices.length}
                  </Text>
                </View>
              )}
            </View>
            <TouchableOpacity 
              onPress={handleClose} 
              style={styles.closeButton}
              disabled={isClosing}
            >
              <X size={24} color={isClosing ? theme.textSecondary + '60' : theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.content}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 40 }),
            }}
          >
            {/* Title */}
            <Text style={[styles.title, { color: theme.text }]}>{currentNotice.title}</Text>

            {/* Image */}
            {currentNotice.imageUrl && (
              <View style={styles.imageContainer}>
                <Image 
                  source={{ uri: currentNotice.imageUrl }} 
                  style={[
                    styles.image,
                    imageDimensions && {
                      aspectRatio: imageDimensions.width / imageDimensions.height,
                    }
                  ]} 
                  resizeMode="cover"
                />
              </View>
            )}

            {/* Content */}
            <Text style={[styles.contentText, { color: theme.text }]}>{currentNotice.content}</Text>

            {/* Audio Announcement */}
            {currentNotice.audioUrl ? (
              <View style={[styles.audioCard, { borderColor: theme.border, backgroundColor: theme.background }]}>
                <View style={styles.audioHeader}>
                  <View style={styles.audioMeta}>
                    <Music size={20} color={theme.primary} />
                    <View style={styles.audioMetaTextWrapper}>
                      <Text style={[styles.audioTitle, { color: theme.text }]} numberOfLines={1}>
                        {currentNotice.audioFileName || 'Audio announcement'}
                      </Text>
                      <Text style={[styles.audioSubtitle, { color: theme.textSecondary }]}>
                        {formatFileSize(currentNotice.audioFileSize)} • {formatDuration(currentNotice.audioDurationMs)}
                      </Text>
                    </View>
                  </View>
                </View>
                <View style={styles.audioPlayerWrapper}>
                  <AudioPlayer
                    fileUrl={currentNotice.audioUrl}
                    fileName={currentNotice.audioFileName || 'announcement-audio.mp3'}
                    fileSize={currentNotice.audioFileSize}
                  />
                </View>
              </View>
            ) : null}

            {/* Link */}
            {currentNotice.linkUrl && (
              <TouchableOpacity
                style={[styles.linkButton, { backgroundColor: theme.primary }]}
                onPress={() => handleOpenLink(currentNotice.linkUrl!)}
              >
                <ExternalLink size={20} color="#ffffff" />
                <Text style={styles.linkButtonText}>
                  {currentNotice.linkTitle || 'Open Link'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Meta Information */}
            <View style={[styles.metaContainer, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <View style={styles.metaRow}>
                <User size={16} color={theme.textSecondary} />
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>
                  Posted by {currentNotice.createdByName}
                  {formatRoleLabel(creatorRole) ? ` (${formatRoleLabel(creatorRole)})` : ''}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Calendar size={16} color={theme.textSecondary} />
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>
                  {formatDate(currentNotice.createdAt)}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>
                  Target: {currentNotice.targetAudience.includes('all') 
                    ? 'Everyone' 
                    : currentNotice.targetAudience.map(audience => 
                        audience.charAt(0).toUpperCase() + audience.slice(1)
                      ).join(', ')
                  }
                </Text>
              </View>
            </View>
          </ScrollView>

          {/* Actions */}
          <View style={[styles.actions, { borderTopColor: theme.border }]}>
            {hasMultiple && (
              <View style={styles.navigationButtons}>
                <TouchableOpacity
                  style={[
                    styles.navButton, 
                    { 
                      backgroundColor: (currentIndex > 0 && !isNavigating) ? theme.textSecondary : `${theme.textSecondary}40`,
                      opacity: (currentIndex > 0 && !isNavigating) ? 1 : 0.5
                    }
                  ]}
                  onPress={handlePrevious}
                  disabled={currentIndex === 0 || isNavigating || isClosing}
                >
                  <ChevronLeft size={20} color="#ffffff" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.navButton, 
                    { 
                      backgroundColor: (currentIndex < notices.length - 1 && !isNavigating) ? theme.textSecondary : `${theme.textSecondary}40`,
                      opacity: (currentIndex < notices.length - 1 && !isNavigating) ? 1 : 0.5
                    }
                  ]}
                  onPress={handleNext}
                  disabled={currentIndex === notices.length - 1 || isNavigating || isClosing}
                >
                  <ChevronRight size={20} color="#ffffff" />
                </TouchableOpacity>
              </View>
            )}
            
            <TouchableOpacity
              style={[
                styles.actionButton, 
                { 
                  backgroundColor: isClosing ? theme.primary + '80' : theme.primary,
                  opacity: isClosing ? 0.7 : 1
                }
              ]}
              onPress={handleClose}
              disabled={isClosing}
            >
              <Text style={styles.actionButtonText}>
                {isClosing ? 'Closing...' : (hasMultiple && currentIndex < notices.length - 1 ? 'Skip All' : 'Got it')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Pulse animation for high priority */}
          {currentNotice.priority === 'high' && (
            <View 
              style={[styles.pulseRing, { borderColor: theme.error }]} 
              pointerEvents="none"
            />
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  container: {
    width: '100%',
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 15,
    position: 'relative',
    // Allow dynamic sizing while constraining maximum height
    flexDirection: 'column',
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    flexShrink: 0, // Prevent header from shrinking
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  priorityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  priorityText: {
    fontSize: 12,
    fontFamily: 'Inter-Bold',
  },
  countBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  countText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  closeButton: {
    padding: 4,
  },
  content: {
    // Use flex to fill available space within maxHeight constraint
    flexGrow: 1,
    flexShrink: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  title: {
    fontSize: 22,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 16,
    lineHeight: 28,
  },
  imageContainer: {
    marginBottom: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    minHeight: 150,
    borderRadius: 12,
    backgroundColor: '#f0f0f0',
    maxWidth: '100%',
  },
  contentText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    lineHeight: 24,
    marginBottom: 16,
  },
  audioCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 16,
  },
  audioHeader: {
    marginBottom: 10,
  },
  audioMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  audioMetaTextWrapper: {
    flex: 1,
  },
  audioTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  audioSubtitle: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  audioPlayerWrapper: {
    marginTop: 2,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginVertical: 16,
    gap: 8,
  },
  linkButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  metaContainer: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    gap: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metaText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    gap: 12,
    flexShrink: 0, // Prevent actions section from shrinking
  },
  navigationButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  navButton: {
    padding: 10,
    borderRadius: 8,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  pulseRing: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderWidth: 3,
    borderRadius: 24,
    opacity: 0.3,
  },
});

export default NoticePopup;
