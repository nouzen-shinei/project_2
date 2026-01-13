import { logger } from '@/lib/logger';
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  ActivityIndicator,
  Dimensions,
  Linking,
  Platform,
} from 'react-native';
import { 
  X, 
  Plus, 
  Edit3, 
  Trash2, 
  Image as ImageIcon, 
  Link as LinkIcon,
  AlertCircle,
  CheckCircle,
  Clock,
  ExternalLink,
  User,
  Calendar,
  Eye,
  Music,
  FileAudio
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { useNotices } from '../hooks/useNotices';
import { useAuth, authService } from '../hooks/useAuthUnified';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useTenant } from '../hooks/useTenantContext';
import { Notice, NoticeFormData } from '../types/notice';
import Toast from 'react-native-toast-message';
import { tenantService } from '../services/tenantService';
import { uploadBlobViaBackend } from '../services/backendStorageUploadService';
import { maybeShowStorageLimitReachedAlert } from '../services/storageLimitAlert';
import type { TenantMembershipRole } from '../types/tenant';
import {
  DEFAULT_NOTICE_REACTIONS,
  NOTICE_REACTION_CATEGORIES,
  NOTICE_REACTION_EMOJIS,
} from '../lib/noticeReactionEmojiCatalog';
import {
  loadNoticeReactionEmojiStore,
  recordNoticeReactionEmoji,
  extractFirstEmoji,
  type NoticeReactionEmojiStore,
} from '../lib/noticeReactionEmojiStore';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import ConfirmationModal from './ConfirmationModal';
import { createAudioPlayer, PLAYBACK_STATUS_UPDATE } from 'expo-audio';
import { AudioPlayer } from './AudioPlayer';

// Link normalizer function to add missing URL formats
const normalizeUrl = (url: string): string => {
  if (!url || !url.trim()) return '';
  
  const trimmedUrl = url.trim();
  
  // If URL already has a protocol, return as is
  if (/^https?:\/\//i.test(trimmedUrl)) {
    return trimmedUrl;
  }
  
  // If URL starts with www., add https://
  if (/^www\./i.test(trimmedUrl)) {
    return `https://${trimmedUrl}`;
  }
  
  // If URL looks like a domain (contains at least one dot and no spaces)
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*(\.[a-zA-Z]{2,})+([/\w.-]*)*\/?$/.test(trimmedUrl)) {
    return `https://${trimmedUrl}`;
  }
  
  // If it doesn't match common patterns but isn't empty, assume it needs https://
  if (trimmedUrl.length > 0 && !trimmedUrl.includes(' ')) {
    return `https://${trimmedUrl}`;
  }
  
  // Return original if it doesn't match any pattern
  return trimmedUrl;
};

const formatStorageBytesForUsageNotice = (value: number): string => {
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  const mb = value / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
};

const getUsageNoticeContentOverride = (notice: any): string | null => {
  const metadata = notice?.metadata;
  const metric = typeof metadata?.metric === 'string' ? metadata.metric : null;
  if (!metric) {
    return null;
  }
  const ratio = typeof metadata?.ratio === 'number' ? metadata.ratio : null;
  const value = typeof metadata?.value === 'number' ? metadata.value : null;
  const limit = typeof metadata?.limit === 'number' ? metadata.limit : null;
  const monthId = typeof metadata?.monthId === 'string' ? metadata.monthId : null;
  const threshold = metadata?.threshold === 'critical' ? 'critical' : metadata?.threshold === 'warning' ? 'warning' : null;

  if (
    ratio === null
    || !Number.isFinite(ratio)
    || value === null
    || !Number.isFinite(value)
    || limit === null
    || !Number.isFinite(limit)
    || !monthId
    || !threshold
  ) {
    return null;
  }

  const metricLabelByKey: Record<string, string> = {
    students: 'Students',
    staff: 'Team seats',
    reminders: 'Reminders',
    storage: 'Storage',
  };
  const metricLabel = metricLabelByKey[metric] ?? metric;
  const percentage = Math.round(ratio * 100);

  const formatValue = (m: string, v: number) => {
    if (m === 'storage') {
      return formatStorageBytesForUsageNotice(v);
    }
    return v.toLocaleString('en-IN');
  };

  const valueLabel = formatValue(metric, value);
  const limitLabel = formatValue(metric, limit);
  return threshold === 'critical'
    ? `${metricLabel} usage reached ${valueLabel} (${percentage}% of ${limitLabel}) for ${monthId}. Clear space or upgrade to restore full access.`
    : `${metricLabel} usage is at ${percentage}% (${valueLabel} of ${limitLabel}) for ${monthId}. Review usage before limits are enforced.`;
};

const MAX_AUDIO_FILE_SIZE = 15 * 1024 * 1024; // 15 MB limit for announcements

type EmojiPickerCategory = 'Recent' | 'Custom' | 'All' | (typeof NOTICE_REACTION_CATEGORIES)[number];

const getReactionCounts = (notice: Notice | null | undefined): { type: string; count: number }[] => {
  const reactions = (notice as any)?.reactions;
  if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) {
    return [];
  }

  return Object.entries(reactions as Record<string, unknown>)
    .map(([type, users]) => ({
      type,
      count: Array.isArray(users) ? users.filter((v) => typeof v === 'string').length : 0,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
};

const getReactionUserIds = (notice: Notice | null | undefined, reactionType?: string | null): string[] => {
  const reactions = (notice as any)?.reactions;
  if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) {
    return [];
  }
  if (reactionType) {
    const users = (reactions as any)[reactionType];
    return Array.isArray(users) ? users.filter((v) => typeof v === 'string') : [];
  }
  const all = Object.values(reactions as Record<string, unknown>)
    .flatMap((users) => (Array.isArray(users) ? users : []))
    .filter((v) => typeof v === 'string') as string[];
  return Array.from(new Set(all));
};

const initialsFromName = (name?: string | null): string => {
  const safe = (name || '').trim();
  if (!safe) return '?';
  const parts = safe.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || '?';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : '';
  return (first + last).toUpperCase();
};

type ReactionMember = {
  userId: string;
  displayName?: string;
  email?: string;
  role?: TenantMembershipRole;
};

const EmojiPickerModal: React.FC<{
  visible: boolean;
  onClose: () => void;
  onPick: (emoji: string, meta?: { isCustom?: boolean }) => void;
  theme: any;
}> = ({ visible, onClose, onPick, theme }) => {
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');
  const [category, setCategory] = useState<EmojiPickerCategory>('All');
  const [store, setStore] = useState<NoticeReactionEmojiStore>({
    recent: [],
    custom: [],
    updatedAt: new Date().toISOString(),
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!visible) return;
      const next = await loadNoticeReactionEmojiStore();
      if (cancelled) return;
      setStore(next);
      setCategory('All');
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const fromCatalog = NOTICE_REACTION_EMOJIS;

    if (q) {
      const customSet = new Set([...(store.custom || []), ...(store.recent || [])]);
      const customItems = Array.from(customSet).map((emoji) => ({
        emoji,
        keywords: [emoji, 'custom'],
        category: 'Other' as const,
      }));
      const combined = [...customItems, ...fromCatalog];
      return combined.filter((e) => e.keywords.some((k) => k.includes(q)) || e.emoji.includes(q));
    }

    if (category === 'Recent') {
      return (store.recent || []).map((emoji) => ({
        emoji,
        keywords: [emoji, 'recent'],
        category: 'Other' as const,
      }));
    }
    if (category === 'Custom') {
      return (store.custom || []).map((emoji) => ({
        emoji,
        keywords: [emoji, 'custom'],
        category: 'Other' as const,
      }));
    }
    if (category === 'All') {
      const customItems = (store.custom || []).map((emoji) => ({
        emoji,
        keywords: [emoji, 'custom'],
        category: 'Other' as const,
      }));
      const catalogEmojis = fromCatalog.filter((item) => !customItems.some((c) => c.emoji === item.emoji));
      return [...customItems, ...catalogEmojis];
    }

    return fromCatalog.filter((e) => e.category === category);
  }, [query, store.custom, store.recent, category]);

  const pickCustom = () => {
    const raw = custom.trim();
    if (!raw) return;
    const emoji = extractFirstEmoji(raw);
    onPick(emoji, { isCustom: true });
    setCustom('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.detailModalOverlay}>
        <View style={[styles.pickerModalContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={[styles.pickerHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.pickerTitle, { color: theme.text }]}>Pick an emoji</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <X size={22} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.pickerInputs}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryRow}
            >
              {(['Recent', 'Custom', 'All', ...NOTICE_REACTION_CATEGORIES] as EmojiPickerCategory[]).map((c) => {
                const selected = category === c;
                return (
                  <TouchableOpacity
                    key={c}
                    style={[
                      styles.categoryChip,
                      {
                        borderColor: selected ? theme.primary : theme.border,
                        backgroundColor: selected ? `${theme.primary}18` : theme.background,
                      },
                    ]}
                    onPress={() => setCategory(c)}
                  >
                    <Text style={[styles.categoryChipText, { color: selected ? theme.primary : theme.textSecondary }]}>
                      {c}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TextInput
              style={[styles.pickerInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
              value={query}
              onChangeText={setQuery}
              placeholder="Search (e.g. love, party, thanks)"
              placeholderTextColor={theme.textSecondary}
            />
            <View style={styles.customRow}>
              <TextInput
                style={[styles.pickerInput, { flex: 1, backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
                value={custom}
                onChangeText={setCustom}
                placeholder="Or paste any emoji"
                placeholderTextColor={theme.textSecondary}
              />
              <TouchableOpacity
                style={[styles.customPickButton, { backgroundColor: theme.primary, opacity: custom.trim() ? 1 : 0.6 }]}
                onPress={pickCustom}
                disabled={!custom.trim()}
              >
                <Text style={styles.customPickButtonText}>Use</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.pickerGrid} showsVerticalScrollIndicator={false}>
            {filtered.map((item: { emoji: string; keywords: string[] }) => (
              <TouchableOpacity
                key={`${item.emoji}-${item.keywords[0]}`}
                style={[styles.pickerEmojiButton, { borderColor: theme.border, backgroundColor: theme.background }]}
                onPress={() => {
                  const isCustomPick = Boolean(store.custom?.includes(item.emoji)) && !NOTICE_REACTION_EMOJIS.some((c) => c.emoji === item.emoji);
                  onPick(item.emoji, { isCustom: isCustomPick });
                  onClose();
                }}
              >
                <Text style={styles.pickerEmojiText}>{item.emoji}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const hasUserReacted = (notice: Notice | null | undefined, reactionType: string, userId: string | null | undefined): boolean => {
  if (!userId) return false;
  const reactions = (notice as any)?.reactions as Record<string, unknown> | undefined;
  const users = reactions && typeof reactions === 'object' && !Array.isArray(reactions) ? reactions[reactionType] : null;
  if (!Array.isArray(users)) return false;
  return users.includes(userId);
};

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

const getAudioDurationMs = async (uri: string): Promise<number | undefined> => {
  const AudioConstructor = typeof globalThis !== 'undefined' ? (globalThis as any).Audio : undefined;
  if (Platform.OS === 'web' && typeof AudioConstructor === 'function') {
    return await new Promise((resolve) => {
      const audio = new AudioConstructor();
      audio.preload = 'metadata';

      const cleanup = (value?: number) => {
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        resolve(value);
      };

      const onLoaded = () => {
        const duration = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined;
        cleanup(duration && duration > 0 ? duration : undefined);
      };

      const onError = () => cleanup(undefined);

      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', onError);
      audio.src = uri;
    });
  }

  const player = createAudioPlayer({ uri }, 200);
  return await new Promise((resolve) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let subscription: { remove: () => void } | null = null;
    const cleanup = (value?: number) => {
      if (resolved) return;
      resolved = true;
      subscription?.remove();
      player.remove();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(value);
    };

    subscription = player.addListener(PLAYBACK_STATUS_UPDATE, (status) => {
      if (status?.isLoaded && typeof status.duration === 'number' && status.duration > 0) {
        cleanup(Math.round(status.duration * 1000));
      }
    });

    timeoutId = setTimeout(() => cleanup(undefined), 5000);

    if (player.isLoaded && typeof player.duration === 'number' && player.duration > 0) {
      cleanup(Math.round(player.duration * 1000));
    }
  });
};

type SelectedAudio = {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
  durationMs?: number;
};

interface NoticeModalProps {
  visible: boolean;
  onClose: () => void;
}

interface NoticeDetailModalProps {
  visible: boolean;
  onClose: () => void;
  notice: Notice | null;
  onMarkAsViewed?: () => void;
  showViewButton?: boolean;
}

export const NoticeDetailModal: React.FC<NoticeDetailModalProps> = ({ 
  visible, 
  onClose, 
  notice, 
  onMarkAsViewed,
  showViewButton = false 
}) => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { activeTenant } = useTenant();
  const { markNoticeAsViewed, toggleNoticeReaction } = useNotices();
  const { isOnline } = useNetworkStatus();
  const [creatorRole, setCreatorRole] = useState<TenantMembershipRole | 'system' | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [reactionBusy, setReactionBusy] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showReactedBy, setShowReactedBy] = useState(false);
  const [reactedByMembers, setReactedByMembers] = useState<Record<string, ReactionMember>>({});
  
  const screenWidth = Dimensions.get('window').width;
  const screenHeight = Dimensions.get('window').height;
  const modalMaxWidth = Math.min(500, screenWidth - 40); // 20px padding on each side
  const maxModalHeight = screenHeight * 0.8; // Maximum 80% of screen height

  const formatRoleLabel = (role: TenantMembershipRole | 'system' | null | undefined): string | null => {
    if (!role) return null;
    if (role === 'system') return 'System';
    return role.charAt(0).toUpperCase() + role.slice(1);
  };

  // Load creator's tenant role
  useEffect(() => {
    const loadCreatorRole = async () => {
      if (!notice) return;

      // Prefer the role stamped on the notice (new notices + billing/system).
      if (typeof (notice as any).createdByRole === 'string') {
        const stamped = (notice as any).createdByRole as TenantMembershipRole | 'system' | null;
        setCreatorRole(stamped);
        return;
      }

      // Legacy notices: fall back to tenant membership lookup by email.
      const email = notice.createdByEmail?.toLowerCase?.() ?? null;
      const tenantId = notice.tenantId || activeTenant?.id || null;
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
    
    if (notice) {
      loadCreatorRole();
      
      // Get image dimensions if there's an image
      if (notice.imageUrl) {
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
          img.src = notice.imageUrl;
        } else {
          // For native platforms, use React Native's Image.getSize
          Image.getSize(
            notice.imageUrl,
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
  }, [notice, activeTenant?.id]);

  const handleClose = async () => {
    if (notice && onMarkAsViewed) {
      onMarkAsViewed();
      await markNoticeAsViewed(notice.id);
    }
    onClose();
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

  const reactionCounts = useMemo(() => getReactionCounts(notice), [notice]);
  const reactionTypesToShow = useMemo(
    () => Array.from(new Set([ ...DEFAULT_NOTICE_REACTIONS, ...reactionCounts.map((r) => r.type) ])).slice(0, 10),
    [reactionCounts]
  );
  const reactedUserIds = useMemo(() => getReactionUserIds(notice), [notice]);
  const reactedCount = reactedUserIds.length;

  useEffect(() => {
    let cancelled = false;
    const loadMembers = async () => {
      const tenantId = notice?.tenantId || activeTenant?.id;
      if (!visible || !tenantId || reactedUserIds.length === 0) {
        if (!cancelled) setReactedByMembers({});
        return;
      }
      try {
        const memberships = await tenantService.getActiveMembershipsForTenant(tenantId);
        if (cancelled) return;
        const map: Record<string, ReactionMember> = {};
        memberships.forEach((m) => {
          if (!m.userId) return;
          map[m.userId] = {
            userId: m.userId,
            displayName: m.displayName,
            email: m.email,
            role: m.role as TenantMembershipRole,
          };
        });
        setReactedByMembers(map);
      } catch (error) {
        logger.warn('[NoticeDetailModal] Failed to load reacted-by members', error);
        if (!cancelled) setReactedByMembers({});
      }
    };

    loadMembers();
    return () => {
      cancelled = true;
    };
  }, [visible, notice?.tenantId, activeTenant?.id, reactedUserIds.join('|')]);

  const handleToggleReaction = async (reactionType: string) => {
    if (!notice?.id || !user?.uid) return;
    if (reactionBusy) return;

    if (!isOnline) {
      Toast.show({
        type: 'error',
        text1: 'Offline',
        text2: 'Reconnect to react to notices.',
        position: 'top',
      });
      return;
    }

    try {
      setReactionBusy(reactionType);
      await toggleNoticeReaction({ noticeId: notice.id, reactionType });
    } catch (error: any) {
      logger.warn('[NoticeDetailModal] Failed to toggle reaction', error);
      Toast.show({
        type: 'error',
        text1: 'Reaction failed',
        text2: error?.message || 'Please try again',
        position: 'top',
      });
    } finally {
      setReactionBusy(null);
    }
  };

  if (!notice) {
    return null;
  }

  const PriorityIcon = getPriorityIcon(notice.priority);
  const userView = notice.userViews?.[user?.uid || ''];
  const viewCount = userView?.count || 0;

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="fade"
      onRequestClose={handleClose}
    >
      <View style={styles.detailModalOverlay}>
        <View style={[
          styles.detailModalContainer, 
          { 
            backgroundColor: theme.surface,
            maxWidth: modalMaxWidth,
            maxHeight: maxModalHeight,
          }
        ]}>
          {/* Header */}
          <View style={[styles.detailHeader, { borderBottomColor: theme.border }]}>
            <View style={styles.detailHeaderLeft}>
              <View style={[styles.priorityBadge, { backgroundColor: `${getPriorityColor(notice.priority)}20` }]}>
                <PriorityIcon size={16} color={getPriorityColor(notice.priority)} />
                <Text style={[styles.priorityText, { color: getPriorityColor(notice.priority) }]}>
                  {notice.priority.toUpperCase()}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.detailScrollContainer}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 10 }),
            }}
          >
            <View style={styles.detailContentContainer}>
              {/* Title */}
              <Text style={[styles.detailTitle, { color: theme.text }]}>{notice.title}</Text>

            {/* Image */}
            {notice.imageUrl ? (
              <View style={styles.detailImageContainer}>
                <Image 
                  source={{ uri: notice.imageUrl }} 
                  style={[
                    styles.detailImage,
                    imageDimensions && {
                      aspectRatio: imageDimensions.width / imageDimensions.height,
                    }
                  ]} 
                  resizeMode="cover"
                />
              </View>
            ) : null}

            {/* Content */}
            <Text style={[styles.detailContentText, { color: theme.text }]}>
              {getUsageNoticeContentOverride(notice) || notice.content || 'No content available'}
            </Text>

            {notice.audioUrl ? (
              <View style={[styles.detailAudioCard, { borderColor: theme.border, backgroundColor: theme.background }]}>
                <View style={styles.detailAudioHeader}>
                  <View style={styles.detailAudioMeta}>
                    <Music size={20} color={theme.primary} />
                    <View style={styles.detailAudioMetaTextWrapper}>
                      <Text style={[styles.detailAudioTitle, { color: theme.text }]} numberOfLines={1}>
                        {notice.audioFileName || 'Audio announcement'}
                      </Text>
                      <Text style={[styles.detailAudioSubtitle, { color: theme.textSecondary }]}>
                        {formatFileSize(notice.audioFileSize)} • {formatDuration(notice.audioDurationMs)}
                      </Text>
                    </View>
                  </View>
                </View>
                <View style={styles.detailAudioPlayerWrapper}>
                  <AudioPlayer
                    fileUrl={notice.audioUrl}
                    fileName={notice.audioFileName || 'announcement-audio.mp3'}
                    fileSize={notice.audioFileSize}
                  />
                </View>
              </View>
            ) : null}

            {/* Link */}
            {notice.linkUrl && (
              <TouchableOpacity
                style={[styles.linkButton, { backgroundColor: theme.primary }]}
                onPress={() => handleOpenLink(notice.linkUrl!)}
              >
                <ExternalLink size={20} color="#ffffff" />
                <Text style={styles.linkButtonText}>
                  {notice.linkTitle || 'Open Link'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Reactions */}
            <View style={[styles.reactionsCard, { borderColor: theme.border, backgroundColor: theme.background }]}> 
              <Text style={[styles.reactionsTitle, { color: theme.textSecondary }]}>Reactions</Text>
              <View style={styles.reactionsRow}>
                {reactionTypesToShow.map((reactionType) => {
                  const count = reactionCounts.find((r) => r.type === reactionType)?.count || 0;
                  const selected = hasUserReacted(notice, reactionType, user?.uid);
                  const disabled = Boolean(reactionBusy) || !user?.uid;
                  return (
                    <TouchableOpacity
                      key={reactionType}
                      style={[
                        styles.reactionChip,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? `${theme.primary}18` : theme.surface,
                          opacity: disabled ? 0.6 : 1,
                        },
                      ]}
                      onPress={() => handleToggleReaction(reactionType)}
                      disabled={disabled}
                    >
                      <Text style={[styles.reactionChipText, { color: theme.text }]}>{reactionType}</Text>
                      {count > 0 ? (
                        <Text style={[styles.reactionChipCount, { color: selected ? theme.primary : theme.textSecondary }]}>
                          {count}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}

                <TouchableOpacity
                  style={[
                    styles.reactionChip,
                    {
                      borderColor: theme.border,
                      backgroundColor: theme.surface,
                      opacity: (!user?.uid || Boolean(reactionBusy)) ? 0.6 : 1,
                    },
                  ]}
                  onPress={() => setShowEmojiPicker(true)}
                  disabled={!user?.uid || Boolean(reactionBusy)}
                >
                  <Text style={[styles.reactionChipText, { color: theme.text }]}>＋</Text>
                  {/* <Text style={[styles.reactionChipCount, { color: theme.textSecondary }]}>More</Text> */}
                </TouchableOpacity>
              </View>

              {reactedCount > 0 ? (
                <TouchableOpacity
                  style={styles.reactedByRow}
                  onPress={() => setShowReactedBy(true)}
                >
                  <View style={styles.reactedByAvatars}>
                    {reactedUserIds.slice(0, 6).map((uid) => {
                      const member = reactedByMembers[uid];
                      const label = initialsFromName(member?.displayName || member?.email || '');
                      return (
                        <View
                          key={uid}
                          style={[styles.reactedAvatar, { backgroundColor: theme.surface, borderColor: theme.border }]}
                        >
                          <Text style={[styles.reactedAvatarText, { color: theme.textSecondary }]}>{label}</Text>
                        </View>
                      );
                    })}
                  </View>
                  <Text style={[styles.reactedByText, { color: theme.textSecondary }]}>
                    {reactedCount} reacted • Tap to view
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={[styles.reactedByText, { color: theme.textSecondary }]}>Be the first to react</Text>
              )}
            </View>

            {/* Meta Information */}
            <View style={[styles.metaContainer, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <View style={styles.metaRow}>
                <User size={16} color={theme.textSecondary} />
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>
                  Posted by {notice.createdByName}
                  {formatRoleLabel(creatorRole) ? ` (${formatRoleLabel(creatorRole)})` : ''}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Calendar size={16} color={theme.textSecondary} />
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>
                  {formatDate(notice.createdAt)}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Eye size={16} color={theme.textSecondary} />
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>
                  Viewed {viewCount} time{viewCount !== 1 ? 's' : ''} by you
                </Text> 
              </View>
              <View style={styles.metaRow}>
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>
                  Target: {notice.targetAudience.includes('all') 
                    ? 'Everyone' 
                    : notice.targetAudience.map(audience => 
                        audience.charAt(0).toUpperCase() + audience.slice(1)
                      ).join(', ')
                  }
                </Text>
              </View>

              {Array.isArray(notice.targetTenantRoles) && notice.targetTenantRoles.length > 0 ? (
                <View style={styles.metaRow}>
                  <Text style={[styles.metaText, { color: theme.textSecondary }]}>Visibility: Admins only</Text>
                </View>
              ) : null}
            </View>
            </View>
          </ScrollView>

          {/* Actions */}
          <View style={[styles.detailActions, { borderTopColor: theme.border }]}>
            {showViewButton && (
              <TouchableOpacity
                style={[styles.detailActionButton, { backgroundColor: theme.primary }]}
                onPress={handleClose}
              >
                <Text style={styles.detailActionButtonText}>Mark as Viewed</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.detailActionButton, { backgroundColor: theme.textSecondary }]}
              onPress={handleClose}
            >
              <Text style={styles.detailActionButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <EmojiPickerModal
        visible={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onPick={(emoji, meta) => {
          void recordNoticeReactionEmoji(emoji, { isCustom: Boolean(meta?.isCustom) });
          handleToggleReaction(emoji);
        }}
        theme={theme}
      />

      <Modal
        visible={showReactedBy}
        transparent
        animationType="fade"
        onRequestClose={() => setShowReactedBy(false)}
      >
        <View style={styles.detailModalOverlay}>
          <View style={[styles.pickerModalContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={[styles.pickerHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.pickerTitle, { color: theme.text }]}>Who reacted</Text>
              <TouchableOpacity onPress={() => setShowReactedBy(false)} style={styles.closeButton}>
                <X size={22} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ padding: 14 }}>
              {getReactionCounts(notice).map((entry) => {
                const users = getReactionUserIds(notice, entry.type);
                return (
                  <View key={entry.type} style={{ marginBottom: 14 }}>
                    <Text style={[styles.reactedSectionTitle, { color: theme.text }]}>
                      {entry.type}  {entry.count}
                    </Text>
                    {users.map((uid) => {
                      const member = reactedByMembers[uid];
                      const name = member?.displayName || member?.email || 'Unknown member';
                      const role = member?.role ? ` (${member.role})` : '';
                      return (
                        <View key={`${entry.type}-${uid}`} style={styles.reactedMemberRow}>
                          <View style={[styles.reactedAvatar, { backgroundColor: theme.background, borderColor: theme.border }]}>
                            <Text style={[styles.reactedAvatarText, { color: theme.textSecondary }]}> 
                              {initialsFromName(name)}
                            </Text>
                          </View>
                          <Text style={[styles.reactedMemberText, { color: theme.text }]} numberOfLines={1}>
                            {name}{role}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Modal>
  );
};

type NoticeWithPending = Notice & { __pendingDeletion?: boolean };

const NoticeModal: React.FC<NoticeModalProps> = ({ visible, onClose }) => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { activeMembership, activeTenant } = useTenant();
  const { notices, loading, addNotice, deleteNotice } = useNotices();
  const { isOnline } = useNetworkStatus();
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedNotice, setSelectedNotice] = useState<Notice | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedImageUri, setSelectedImageUri] = useState<string>(''); // Local image URI before upload
  const [selectedAudio, setSelectedAudio] = useState<SelectedAudio | null>(null);
  const [audioMetadataLoading, setAudioMetadataLoading] = useState(false);
  
  // Confirmation modal state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [noticeToDelete, setNoticeToDelete] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingDeleteNotices, setPendingDeleteNotices] = useState<Record<string, NoticeWithPending>>({});
  const [creatorRoleByEmail, setCreatorRoleByEmail] = useState<Record<string, TenantMembershipRole>>({});

  const formatRoleLabel = (role: TenantMembershipRole | 'system' | null | undefined): string | null => {
    if (!role) return null;
    if (role === 'system') return 'System';
    return role.charAt(0).toUpperCase() + role.slice(1);
  };

  const resolveCreatorRoleLabel = (notice: Notice): string | null => {
    const stamped = notice.createdByRole || null;
    const stampedLabel = formatRoleLabel(stamped as TenantMembershipRole | 'system' | null);
    if (stampedLabel) return stampedLabel;

    const email = notice.createdByEmail?.toLowerCase?.() ?? '';
    if (!email) return null;
    const role = creatorRoleByEmail[email];
    return formatRoleLabel(role);
  };

  useEffect(() => {
    let cancelled = false;

    const loadMembershipRoles = async () => {
      if (!visible) return;
      const tenantId = activeTenant?.id;
      if (!tenantId) {
        if (!cancelled) setCreatorRoleByEmail({});
        return;
      }

      try {
        const memberships = await tenantService.getActiveMembershipsForTenant(tenantId);
        if (cancelled) return;
        const map: Record<string, TenantMembershipRole> = {};
        memberships.forEach((m) => {
          const email = m.email?.toLowerCase?.();
          const role = m.role as TenantMembershipRole | undefined;
          if (email && role) {
            map[email] = role;
          }
        });
        setCreatorRoleByEmail(map);
      } catch (error) {
        logger.warn('[NoticeModal] Failed to load membership roles for creator labels', error);
        if (!cancelled) setCreatorRoleByEmail({});
      }
    };

    loadMembershipRoles();
    return () => {
      cancelled = true;
    };
  }, [visible, activeTenant?.id]);

  // Form state
  const [formData, setFormData] = useState<NoticeFormData>({
    title: '',
    content: '',
    imageUrl: '',
    linkUrl: '',
    linkTitle: '',
    priority: 'medium',
    targetAudience: ['all'], // Initialize as array with 'all' selected
    targetTenantRoles: undefined,
  });

  const resetForm = () => {
    setFormData({
      title: '',
      content: '',
      imageUrl: '',
      linkUrl: '',
      linkTitle: '',
      priority: 'medium',
      targetAudience: ['all'], // Reset to array with 'all' selected
      targetTenantRoles: undefined,
    });
    setSelectedImageUri(''); // Reset selected image
    setSelectedAudio(null);
    setAudioMetadataLoading(false);
  };

  // Reset form and show state when modal is closed
  useEffect(() => {
    if (!visible) {
      setShowAddForm(false);
      resetForm();
    }
  }, [visible]);

  const handleImagePicker = async () => {
    try {
      // Request permissions first
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Toast.show({
          type: 'error',
          text1: 'Permission denied',
          text2: 'Please grant permission to access photos in device settings',
          position: 'top',
          visibilityTime: 4000,
        });
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false, // Disable cropping to keep original size
        quality: 0.9, // Higher quality for full-size images
        selectionLimit: 1,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        // Store the selected image URI locally (don't upload yet)
        setSelectedImageUri(asset.uri);
        
        Toast.show({
          type: 'success',
          text1: 'Image selected',
          text2: 'Image will be uploaded when you post the notice',
          position: 'top',
          visibilityTime: 3000,
        });
      }
    } catch (error) {
      logger.error('Error picking image:', error);
      Toast.show({
        type: 'error',
        text1: 'Error selecting image',
        text2: 'Please try again',
        position: 'top',
      });
    }
  };

  const handleAudioPicker = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      if (!asset.uri) {
        Toast.show({
          type: 'error',
          text1: 'Audio selection failed',
          text2: 'Could not read the selected file. Please try another file.',
          position: 'top',
        });
        return;
      }

      let fileSize = asset.size;
      if ((!fileSize || fileSize <= 0) && asset.uri) {
        try {
          const info = await FileSystem.getInfoAsync(asset.uri);
          if (info.exists && typeof info.size === 'number') {
            fileSize = info.size;
          }
        } catch (infoError) {
          logger.warn('Failed to read audio file info', infoError);
        }
      }

      if (fileSize && fileSize > MAX_AUDIO_FILE_SIZE) {
        Toast.show({
          type: 'error',
          text1: 'Audio too large',
          text2: 'Please select an audio file smaller than 15 MB.',
          position: 'top',
        });
        return;
      }

      setAudioMetadataLoading(true);
      let durationMs: number | undefined;
      try {
        durationMs = await getAudioDurationMs(asset.uri);
      } catch (durationError) {
        logger.warn('Failed to compute audio duration', durationError);
      }

      setSelectedAudio({
        uri: asset.uri,
        name: asset.name || 'announcement-audio.mp3',
        size: fileSize,
        mimeType: asset.mimeType || 'audio/mpeg',
        durationMs,
      });

      Toast.show({
        type: 'success',
        text1: 'Audio attached',
        text2: 'Audio will upload when you post the notice.',
        position: 'top',
        visibilityTime: 3000,
      });
    } catch (error: any) {
      if (error?.code === 'DOCUMENT_PICKER_CANCELED') {
        return;
      }
      logger.error('Error picking audio:', error);
      Toast.show({
        type: 'error',
        text1: 'Audio selection failed',
        text2: 'Please try again with a supported audio file.',
        position: 'top',
      });
    } finally {
      setAudioMetadataLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!formData.title.trim() || !formData.content.trim()) {
      Toast.show({
        type: 'error',
        text1: 'Missing fields',
        text2: 'Please fill in title and content',
        position: 'top',
      });
      return;
    }

    if (audioMetadataLoading) {
      Toast.show({
        type: 'info',
        text1: 'Please wait',
        text2: 'Still reading audio details. Try again in a moment.',
        position: 'top',
      });
      return;
    }

    try {
      setUploading(true);
      let finalFormData = { ...formData };

      const actorRole = activeMembership?.role || null;
      const canSetNoticeVisibility = actorRole === 'owner' || actorRole === 'admin';
      if (!canSetNoticeVisibility) {
        finalFormData.targetTenantRoles = undefined;
      }
      if (Array.isArray(finalFormData.targetTenantRoles) && finalFormData.targetTenantRoles.length === 0) {
        finalFormData.targetTenantRoles = undefined;
      }
      
      // Normalize the link URL before submission if provided
      if (finalFormData.linkUrl && finalFormData.linkUrl.trim()) {
        finalFormData.linkUrl = normalizeUrl(finalFormData.linkUrl);
      }
      
      // Upload image if one is selected
      if (selectedImageUri) {
        let imageBlob: Blob | null = null;
        try {
          const tenantId = await tenantService.getCachedSelectedTenant();
          if (!tenantId) {
            throw new Error('Select a coaching center before uploading notice media.');
          }

          // Create a unique filename
          const filename = `notice_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

          // Upload via backend (storage quota enforced)
          const response = await fetch(selectedImageUri);
          imageBlob = await response.blob();

          const result = await uploadBlobViaBackend({
            tenantId,
            purpose: 'noticeImage',
            blob: imageBlob,
            contentType: imageBlob.type || 'image/jpeg',
            filename,
            suppressStorageLimitAlert: true,
          });

          finalFormData.imageUrl = result.url;
        } catch (uploadError) {
          logger.error('Upload error:', uploadError);
          // If storage is full, show a single storage-limit modal with accurate attachment size.
          if (
            maybeShowStorageLimitReachedAlert(uploadError, 'notice.imageUpload', {
              incrementBytes: typeof imageBlob?.size === 'number' ? imageBlob.size : undefined,
              extraMessageLines: ['Tip: You can post this notice without attachments.'],
            })
          ) {
            return;
          }
          Toast.show({
            type: 'error',
            text1: 'Image upload failed',
            text2: 'Failed to upload image. Please try again.',
            position: 'top',
          });
          return;
        }
      }

      if (selectedAudio) {
        let audioBlob: Blob | null = null;
        try {
          const tenantId = await tenantService.getCachedSelectedTenant();
          if (!tenantId) {
            throw new Error('Select a coaching center before uploading notice media.');
          }

          const response = await fetch(selectedAudio.uri);
          audioBlob = await response.blob();
          const extension = selectedAudio.name?.split('.')?.pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'mp3';
          const filename = `notice_audio_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${extension}`;

          const result = await uploadBlobViaBackend({
            tenantId,
            purpose: 'noticeAudio',
            blob: audioBlob,
            contentType: selectedAudio.mimeType || audioBlob.type || 'audio/mpeg',
            filename,
            suppressStorageLimitAlert: true,
          });

          finalFormData.audioUrl = result.url;
          finalFormData.audioFileName = selectedAudio.name;
          finalFormData.audioFileSize = selectedAudio.size;
          finalFormData.audioDurationMs = selectedAudio.durationMs;
          finalFormData.audioStoragePath = result.path;
        } catch (uploadError) {
          logger.error('Audio upload error:', uploadError);
          // If storage is full, show a single storage-limit modal with accurate attachment size.
          if (
            maybeShowStorageLimitReachedAlert(uploadError, 'notice.audioUpload', {
              incrementBytes: typeof audioBlob?.size === 'number' ? audioBlob.size : undefined,
              extraMessageLines: ['Tip: You can post this notice without attachments.'],
            })
          ) {
            return;
          }
          Toast.show({
            type: 'error',
            text1: 'Audio upload failed',
            text2: 'Failed to upload the audio file. Please try again.',
            position: 'top',
          });
          return;
        }
      }

      await addNotice(finalFormData);
      Toast.show({
        type: 'success',
        text1: 'Notice posted',
        text2: 'Notice has been posted successfully',
        position: 'top',
      });
      resetForm();
      setShowAddForm(false);
    } catch (error) {
      logger.error('Error adding notice:', error);
      Toast.show({
        type: 'error',
        text1: 'Failed to post notice',
        text2: 'Please try again',
        position: 'top',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = (noticeId: string) => {
    setDeleteLoading(false);
    setDeleteError(null);
    setNoticeToDelete(noticeId);
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    const noticeId = noticeToDelete;
    if (!noticeId || deleteLoading) return;

    if (!isOnline) {
      setDeleteError('You appear to be offline. Reconnect and try deleting the notice again.');
      return;
    }

    const existingNotice = notices.find(n => n.id === noticeId) || pendingDeleteNotices[noticeId];
    const noticeSnapshot: NoticeWithPending | undefined = existingNotice
      ? { ...existingNotice }
      : undefined;

    if (noticeSnapshot) {
      setPendingDeleteNotices(prev => ({
        ...prev,
        [noticeId]: { ...noticeSnapshot, __pendingDeletion: true },
      }));
    }

    setDeleteLoading(true);
    setDeleteError(null);

    try {
      await deleteNotice(noticeId);
      Toast.show({
        type: 'success',
        text1: 'Notice deleted',
        text2: 'Notice has been removed',
        position: 'top',
      });
      setDeleteError(null);
      setShowDeleteConfirm(false);
      setNoticeToDelete(null);
      setPendingDeleteNotices(prev => {
        if (!(noticeId in prev)) return prev;
        const next = { ...prev };
        delete next[noticeId];
        return next;
      });
    } catch (error: any) {
      logger.error('Error deleting notice:', error);
      const message = error?.message || 'Unable to delete the notice right now. Please try again.';
      setDeleteError(message);
      Toast.show({
        type: 'error',
        text1: 'Delete failed',
        text2: message,
        position: 'top',
      });
      if (noticeSnapshot) {
        setPendingDeleteNotices(prev => ({
          ...prev,
          [noticeId]: { ...noticeSnapshot, __pendingDeletion: false },
        }));
      } else {
        setPendingDeleteNotices(prev => {
          if (!(noticeId in prev)) return prev;
          const next = { ...prev };
          delete next[noticeId];
          return next;
        });
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDeleteCancel = () => {
    const noticeId = noticeToDelete;
    setShowDeleteConfirm(false);
    setNoticeToDelete(null);
    setDeleteLoading(false);
    setDeleteError(null);
    setPendingDeleteNotices(prev => {
      if (!noticeId || !(noticeId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[noticeId];
      return next;
    });
  };

  const canDeleteNotice = (notice: Notice): boolean => {
    if (!user) return false;

    const actorRole = activeMembership?.role || null;
    if (actorRole === 'owner') {
      return true;
    }

    const creatorRole = notice.createdByRole || null;
    if (actorRole === 'admin') {
      // Admins can delete any notice except those posted by owners.
      // If creator role is missing (legacy notices), allow the attempt and let backend be source of truth.
      if (creatorRole === 'owner') {
        return false;
      }
      return true;
    }

    // Staff + members can delete only their own notices.
    return notice.createdBy === user.uid;
  };

  const handleNoticePress = (notice: Notice) => {
    if (pendingDeleteNotices[notice.id]?.__pendingDeletion) {
      return;
    }
    setSelectedNotice(notice);
    setShowDetailModal(true);
  };

  // Keep selected notice synced with the latest snapshot (reactions, views, edits, etc.)
  useEffect(() => {
    if (!showDetailModal || !selectedNotice?.id) return;
    const updated = notices.find((n) => n.id === selectedNotice.id);
    if (updated) {
      setSelectedNotice(updated);
    }
  }, [notices, showDetailModal, selectedNotice?.id]);

  const renderReactionSummary = (notice: Notice) => {
    const counts = getReactionCounts(notice);
    if (counts.length === 0) return null;

    const top = counts.slice(0, 3);
    return (
      <View style={styles.reactionSummaryRow}>
        {top.map((entry) => (
          <View
            key={entry.type}
            style={[styles.reactionSummaryChip, { borderColor: theme.border, backgroundColor: theme.surface }]}
          >
            <Text style={[styles.reactionSummaryText, { color: theme.text }]}>{entry.type}</Text>
            <Text style={[styles.reactionSummaryCount, { color: theme.textSecondary }]}>{entry.count}</Text>
          </View>
        ))}
      </View>
    );
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return theme.error;
      case 'medium': return theme.warning;
      case 'low': return theme.success;
      default: return theme.textSecondary;
    }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Unknown';
    }
  };

  const noticesToDisplay = useMemo<NoticeWithPending[]>(() => {
    if (Object.keys(pendingDeleteNotices).length === 0) {
      return notices as NoticeWithPending[];
    }

    const baseList = notices.map(notice => ({ ...notice })) as NoticeWithPending[];
    const idToIndex = new Map(baseList.map((notice, index) => [notice.id, index]));

    Object.entries(pendingDeleteNotices).forEach(([id, pendingNotice]) => {
      if (idToIndex.has(id)) {
        const index = idToIndex.get(id)!;
        baseList[index] = { ...baseList[index], __pendingDeletion: pendingNotice.__pendingDeletion };
      } else {
        baseList.push({ ...pendingNotice });
      }
    });

    baseList.sort((a, b) => {
      const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bDate - aDate;
    });

    return baseList;
  }, [notices, pendingDeleteNotices]);

  useEffect(() => {
    setPendingDeleteNotices(prev => {
      if (Object.keys(prev).length === 0) {
        return prev;
      }

      const next = { ...prev };
      let changed = false;

      Object.entries(prev).forEach(([id, pendingNotice]) => {
        if (pendingNotice.__pendingDeletion) {
          return;
        }

        const existsInSnapshot = notices.some(notice => notice.id === id);
        if (existsInSnapshot) {
          delete next[id];
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [notices]);

  const hasPendingMedia = Boolean(selectedImageUri || selectedAudio);
  const canSetNoticeVisibility = activeMembership?.role === 'owner' || activeMembership?.role === 'admin';
  const isAdminsOnlyNotice = Array.isArray(formData.targetTenantRoles) && formData.targetTenantRoles.length > 0;

  return (
    <>
      <Modal
        visible={visible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => {
          if (showAddForm) {
            resetForm();
            setShowAddForm(false);
          } else {
            onClose();
          }
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContainer, { backgroundColor: theme.surface }]}>
            {/* Header */}
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>
                {showAddForm ? 'Add Notice' : 'Notices'}
              </Text>
              <View style={styles.headerActions}>
                {!showAddForm && (
                  <TouchableOpacity
                    onPress={() => setShowAddForm(true)}
                    style={[styles.addButton, { backgroundColor: theme.primary }]}
                  >
                    <Plus size={20} color="#ffffff" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity 
                  onPress={() => {
                    if (showAddForm) {
                      resetForm();
                      setShowAddForm(false);
                    } else {
                      onClose();
                    }
                  }} 
                  style={styles.closeButton}
                >
                  <X size={24} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Content */}
            {showAddForm ? (
              <ScrollView
                style={styles.formContainer}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{
                  paddingBottom: Platform.select({ web: 0, default: 30 }),
                }}
              >
                {/* Title */}
                <Text style={[styles.formLabel, { color: theme.text }]}>Title *</Text>
                <TextInput
                  style={[styles.formInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
                  value={formData.title}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, title: text }))}
                  placeholder="Enter notice title"
                  placeholderTextColor={theme.textSecondary}
                />

                {/* Content */}
                <Text style={[styles.formLabel, { color: theme.text }]}>Content *</Text>
                <TextInput
                  style={[styles.formTextArea, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
                  value={formData.content}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, content: text }))}
                  placeholder="Enter notice content"
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  numberOfLines={4}
                />

                {/* Image Upload */}
                <Text style={[styles.formLabel, { color: theme.text }]}>Poster Image (Optional)</Text>
                <TouchableOpacity
                  style={[styles.imageUploadButton, { backgroundColor: theme.background, borderColor: theme.border }]}
                  onPress={handleImagePicker}
                  disabled={uploading}
                >
                  {uploading ? (
                    <ActivityIndicator size="small" color={theme.primary} />
                  ) : (
                    <>
                      <ImageIcon size={24} color={theme.textSecondary} />
                      <Text style={[styles.imageUploadText, { color: theme.textSecondary }]}>
                        {selectedImageUri ? 'Change Image' : 'Select Image'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                {selectedImageUri && (
                  <View style={styles.imagePreview}>
                    <Image source={{ uri: selectedImageUri }} style={styles.previewImage} resizeMode="contain" />
                    <TouchableOpacity
                      style={[styles.removeImageButton, { backgroundColor: theme.error }]}
                      onPress={() => setSelectedImageUri('')}
                    >
                      <X size={16} color="#ffffff" />
                    </TouchableOpacity>
                  </View>
                )}

                {/* Audio Upload */}
                <Text style={[styles.formLabel, { color: theme.text }]}>Audio Announcement (Optional)</Text>
                <Text style={[styles.formHelpText, { color: theme.textSecondary }]}>MP3, WAV, or M4A up to 15 MB</Text>
                <TouchableOpacity
                  style={[styles.audioUploadButton, { backgroundColor: theme.background, borderColor: theme.border }]}
                  onPress={handleAudioPicker}
                  disabled={uploading || audioMetadataLoading}
                >
                  {audioMetadataLoading ? (
                    <ActivityIndicator size="small" color={theme.primary} />
                  ) : (
                    <>
                      <Music size={24} color={theme.textSecondary} />
                      <Text style={[styles.audioUploadText, { color: theme.textSecondary }]}>
                        {selectedAudio ? 'Change Audio' : 'Select Audio'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                {selectedAudio && (
                  <View style={[styles.audioPreview, { backgroundColor: theme.background, borderColor: theme.border }]}>
                    <View style={styles.audioInfoLeft}>
                      <FileAudio size={32} color={theme.primary} />
                      <View style={styles.audioMetaTextWrapper}>
                        <Text style={[styles.audioFileName, { color: theme.text }]} numberOfLines={1}>
                          {selectedAudio.name}
                        </Text>
                        <Text style={[styles.audioMetaText, { color: theme.textSecondary }]}>
                          {formatFileSize(selectedAudio.size)} • {formatDuration(selectedAudio.durationMs)}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={[styles.removeAudioButton, { backgroundColor: theme.error }]}
                      onPress={() => setSelectedAudio(null)}
                    >
                      <X size={16} color="#ffffff" />
                    </TouchableOpacity>
                  </View>
                )}

                {/* Link */}
                <Text style={[styles.formLabel, { color: theme.text }]}>Link URL (Optional)</Text>
                <Text style={[styles.formHelpText, { color: theme.textSecondary }]}>
                  {"Enter any URL format - we'll automatically add https:// if needed"}
                </Text>
                <TextInput
                  style={[styles.formInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
                  value={formData.linkUrl}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, linkUrl: text }))}
                  onBlur={() => {
                    // Normalize URL when user finishes editing
                    if (formData.linkUrl) {
                      const normalizedUrl = normalizeUrl(formData.linkUrl);
                      if (normalizedUrl !== formData.linkUrl) {
                        setFormData(prev => ({ ...prev, linkUrl: normalizedUrl }));
                      }
                    }
                  }}
                  placeholder="https://example.com or example.com or www.example.com"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="url"
                />

                {formData.linkUrl && (
                  <>
                    <Text style={[styles.formLabel, { color: theme.text }]}>Link Title</Text>
                    <TextInput
                      style={[styles.formInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
                      value={formData.linkTitle}
                      onChangeText={(text) => setFormData(prev => ({ ...prev, linkTitle: text }))}
                      placeholder="Learn More"
                      placeholderTextColor={theme.textSecondary}
                    />
                  </>
                )}

                {/* Priority */}
                <Text style={[styles.formLabel, { color: theme.text }]}>Priority</Text>
                <View style={styles.priorityContainer}>
                  {(['low', 'medium', 'high'] as const).map((priority) => (
                    <TouchableOpacity
                      key={priority}
                      style={[
                        styles.priorityButton,
                        {
                          backgroundColor: formData.priority === priority 
                            ? getPriorityColor(priority) 
                            : theme.background,
                          borderColor: getPriorityColor(priority),
                        }
                      ]}
                      onPress={() => setFormData(prev => ({ ...prev, priority }))}
                    >
                      <Text
                        style={[
                          styles.priorityButtonText,
                          {
                            color: formData.priority === priority 
                              ? '#ffffff' 
                              : getPriorityColor(priority),
                          }
                        ]}
                      >
                        {priority.charAt(0).toUpperCase() + priority.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Visibility (Admins/Owners only) */}
                {canSetNoticeVisibility ? (
                  <>
                    <Text style={[styles.formLabel, { color: theme.text }]}>Visibility</Text>
                    <Text style={[styles.formHelpText, { color: theme.textSecondary }]}>Choose who can see this notice</Text>
                    <View style={styles.audienceContainer}>
                      <TouchableOpacity
                        style={[
                          styles.audienceButton,
                          {
                            backgroundColor: !isAdminsOnlyNotice ? theme.primary : theme.background,
                            borderColor: theme.primary,
                          },
                        ]}
                        onPress={() => setFormData(prev => ({ ...prev, targetTenantRoles: undefined }))}
                      >
                        <Text
                          style={[
                            styles.audienceButtonText,
                            { color: !isAdminsOnlyNotice ? '#ffffff' : theme.primary },
                          ]}
                        >
                          Everyone
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.audienceButton,
                          {
                            backgroundColor: isAdminsOnlyNotice ? theme.primary : theme.background,
                            borderColor: theme.primary,
                          },
                        ]}
                        onPress={() => setFormData(prev => ({ ...prev, targetTenantRoles: ['owner', 'admin'] }))}
                      >
                        <Text
                          style={[
                            styles.audienceButtonText,
                            { color: isAdminsOnlyNotice ? '#ffffff' : theme.primary },
                          ]}
                        >
                          Admins only
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : null}

                {/* Target Audience */}
                <Text style={[styles.formLabel, { color: theme.text }]}>Target Audience</Text>
                <Text style={[styles.formHelpText, { color: theme.textSecondary }]}>
                  {formData.targetAudience.includes('all') 
                    ? 'Selected: Everyone' 
                    : `Selected: ${formData.targetAudience.length} group${formData.targetAudience.length !== 1 ? 's' : ''}`
                  } • Tap to select multiple groups
                </Text>
                <View style={styles.audienceContainer}>
                  {(['all', 'admins', 'staffs', 'members'] as const).map((audience) => (
                    <TouchableOpacity
                      key={audience}
                      style={[
                        styles.audienceButton,
                        {
                          backgroundColor: formData.targetAudience.includes(audience)
                            ? theme.primary 
                            : theme.background,
                          borderColor: theme.primary,
                        }
                      ]}
                      onPress={() => {
                        setFormData(prev => {
                          let newAudience = [...prev.targetAudience];
                          
                          if (audience === 'all') {
                            // If 'all' is selected, clear others and select only 'all'
                            newAudience = ['all'];
                          } else {
                            // Remove 'all' if selecting specific audiences
                            newAudience = newAudience.filter(a => a !== 'all');
                            
                            if (newAudience.includes(audience)) {
                              // Remove if already selected
                              newAudience = newAudience.filter(a => a !== audience);
                            } else {
                              // Add if not selected
                              newAudience.push(audience);
                            }
                            
                            // If no specific audience selected, default to 'all'
                            if (newAudience.length === 0) {
                              newAudience = ['all'];
                            }
                            // If all specific audiences are selected, switch to 'all'
                            else if (newAudience.length === 3 && 
                                   newAudience.includes('admins') && 
                                   newAudience.includes('staffs') && 
                                   newAudience.includes('members')) {
                              newAudience = ['all'];
                            }
                          }
                          
                          return { ...prev, targetAudience: newAudience };
                        });
                      }}
                    >
                      <Text
                        style={[
                          styles.audienceButtonText,
                          {
                            color: formData.targetAudience.includes(audience)
                              ? '#ffffff' 
                              : theme.primary,
                          }
                        ]}
                      >
                        {audience === 'all' ? 'Everyone' : audience.charAt(0).toUpperCase() + audience.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Form Actions */}
                <View style={styles.formActions}>
                  <TouchableOpacity
                    style={[styles.formButton, styles.cancelButton, { backgroundColor: theme.textSecondary }]}
                    onPress={() => {
                      setShowAddForm(false);
                      resetForm();
                    }}
                  >
                    <Text style={styles.formButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.formButton, 
                      styles.submitButton, 
                      { 
                        backgroundColor: uploading ? theme.textSecondary : theme.primary,
                        opacity: uploading ? 0.7 : 1 
                      }
                    ]}
                    onPress={handleSubmit}
                    disabled={uploading}
                  >
                    {uploading ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <ActivityIndicator size="small" color="#ffffff" />
                        <Text style={styles.formButtonText}>
                          {hasPendingMedia ? 'Uploading media...' : 'Posting...'}
                        </Text>
                      </View>
                    ) : (
                      <Text style={styles.formButtonText}>Post Notice</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </ScrollView>
            ) : (
              <ScrollView
                style={styles.noticesList}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{
                  paddingBottom: Platform.select({ web: 0, default: 35 }),
                }}
              >
                {loading ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.primary} />
                    <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading notices...</Text>
                  </View>
                ) : noticesToDisplay.length > 0 ? (
                  noticesToDisplay.map((notice) => {
                    const isPendingDeletion = Boolean(pendingDeleteNotices[notice.id]?.__pendingDeletion);
                    return (
                      <TouchableOpacity
                        key={notice.id}
                        style={[
                          styles.noticeCard,
                          {
                            backgroundColor: theme.background,
                            borderColor: theme.border,
                            opacity: isPendingDeletion ? 0.6 : 1,
                          },
                        ]}
                        onPress={() => handleNoticePress(notice)}
                        disabled={isPendingDeletion}
                      >
                        <View style={styles.noticeHeader}>
                          <View style={styles.noticeHeaderLeft}>
                            <View style={[styles.priorityIndicator, { backgroundColor: getPriorityColor(notice.priority) }]} />
                            <Text style={[styles.noticeTitle, { color: theme.text }]} numberOfLines={1}>
                              {notice.title}
                            </Text>
                            {Array.isArray(notice.targetTenantRoles) && notice.targetTenantRoles.length > 0 ? (
                              <View style={[styles.noticeRoleBadge, { backgroundColor: `${theme.primary}15` }]}>
                                <Text style={[styles.noticeBadgeText, { color: theme.primary }]}>Admins only</Text>
                              </View>
                            ) : null}
                            {notice.audioUrl ? (
                              <View style={[styles.noticeAudioBadge, { backgroundColor: `${theme.primary}15` }]}> 
                                <Music size={14} color={theme.primary} />
                              </View>
                            ) : null}
                          </View>
                          <View style={styles.noticeActions}>
                            {canDeleteNotice(notice) && (
                              <TouchableOpacity
                                style={[
                                  styles.actionButton,
                                  {
                                    backgroundColor: `${theme.error}20`,
                                    opacity: deleteLoading || isPendingDeletion ? 0.5 : 1,
                                  },
                                ]}
                                onPress={() => handleDelete(notice.id)}
                                disabled={deleteLoading || isPendingDeletion}
                              >
                                <Trash2 size={16} color={theme.error} />
                              </TouchableOpacity>
                            )}
                          </View>
                        </View>

                        <Text style={[styles.noticeContent, { color: theme.textSecondary }]} numberOfLines={2}>
                          {getUsageNoticeContentOverride(notice) || notice.content}
                        </Text>

                        {renderReactionSummary(notice)}

                        <View style={styles.noticeMeta}>
                          <Text style={[styles.noticeAuthor, { color: theme.textSecondary }]}>
                            By {notice.createdByName}
                            {resolveCreatorRoleLabel(notice) ? ` (${resolveCreatorRoleLabel(notice)})` : ''}
                          </Text>
                          <Text style={[styles.noticeDate, { color: theme.textSecondary }]}>
                            {formatDate(notice.createdAt)}
                          </Text>
                          {isPendingDeletion ? (
                            <Text style={[styles.noticePendingText, { color: theme.warning }]}>Deleting...</Text>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })
                ) : (
                  <View style={styles.emptyState}>
                    <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>
                      No notices available
                    </Text>
                    <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}>
                      Add the first notice to get started
                    </Text>
                  </View>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <NoticeDetailModal
        visible={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        notice={selectedNotice}
      />

      <ConfirmationModal
        visible={showDeleteConfirm}
        onClose={handleDeleteCancel}
        title="Delete Notice"
        message="Are you sure you want to delete this notice? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        confirmStyle="destructive"
        icon={<Trash2 size={24} color="#ef4444" />}
        confirmDisabled={deleteLoading}
        confirmLoading={deleteLoading}
        cancelDisabled={deleteLoading}
        autoCloseOnConfirm={false}
        statusMessage={deleteError}
        statusType={deleteError ? 'error' : 'neutral'}
      />
    </>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    height: '90%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  addButton: {
    padding: 8,
    borderRadius: 8,
  },
  closeButton: {
    padding: 4,
  },

  // Form Styles
  formContainer: {
    flex: 1,
    padding: 20,
  },
  formLabel: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
    marginTop: 16,
  },
  formHelpText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginBottom: 8,
    marginTop: -4,
  },
  formInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  formTextArea: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    height: 100,
    textAlignVertical: 'top',
  },
  imageUploadButton: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 20,
    alignItems: 'center',
    gap: 8,
  },
  imageUploadText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  imagePreview: {
    marginTop: 12,
    position: 'relative',
  },
  previewImage: {
    width: '100%',
    minHeight: 150,
    borderRadius: 12,
  },
  removeImageButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    padding: 6,
    borderRadius: 12,
  },
  audioUploadButton: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  audioUploadText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  audioPreview: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  audioInfoLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  audioMetaTextWrapper: {
    flex: 1,
  },
  audioFileName: {
    fontSize: 15,
    fontFamily: 'Inter-SemiBold',
  },
  audioMetaText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  removeAudioButton: {
    padding: 8,
    borderRadius: 12,
  },
  priorityContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  priorityButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  priorityButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  audienceContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  audienceButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  audienceButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  formActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
    marginBottom: 20,
  },
  formButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  cancelButton: {},
  submitButton: {},
  formButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },

  // Notices List Styles
  noticesList: {
    flex: 1,
    padding: 20,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    marginTop: 12,
  },
  noticeCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    position: 'relative',
  },
  noticeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  noticeHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  noticeRoleBadge: {
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noticeAudioBadge: {
    marginLeft: 8,
    padding: 9,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noticeBadgeText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  priorityIndicator: {
    width: 4,
    height: 16,
    borderRadius: 2,
    marginRight: 12,
  },
  noticeTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    flex: 1,
  },
  noticeActions: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 8,
  },
  actionButton: {
    padding: 8,
    borderRadius: 8,
  },
  noticeContent: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 20,
    marginBottom: 12,
  },
  noticeMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  noticeAuthor: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  noticeDate: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  noticePendingText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    alignSelf: 'flex-end',
    textAlign: 'right',
    flexBasis: '100%',
    marginTop: 4,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyStateText: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  emptyStateSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
  },

  // Detail Modal Styles
  detailModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  detailModalContainer: {
    width: '100%',
    maxWidth: 500,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
    // Allow dynamic sizing while constraining maximum height
    flexDirection: 'column',
    alignSelf: 'center',
  },
  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    flexShrink: 0, // Prevent header from shrinking
  },
  detailHeaderLeft: {
    flex: 1,
  },
  priorityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    alignSelf: 'flex-start',
    gap: 6,
  },
  priorityText: {
    fontSize: 12,
    fontFamily: 'Inter-Bold',
  },
  detailScrollContainer: {
    // Use flex to fill available space within maxHeight constraint
    flexGrow: 1,
    flexShrink: 1,
  },
  detailContentContainer: {
    padding: 20,
  },
  detailContentText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    lineHeight: 24,
    marginBottom: 16,
  },
  detailAudioCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  detailAudioHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  detailAudioMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  detailAudioMetaTextWrapper: {
    flex: 1,
  },
  detailAudioTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  detailAudioSubtitle: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  detailAudioPlayerWrapper: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  detailTitle: {
    fontSize: 22,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 16,
    lineHeight: 28,
  },
  detailImageContainer: {
    marginBottom: 16,
    width: '100%',
    alignSelf: 'center',
    overflow: 'hidden',
  },
  detailImage: {
    width: '100%',
    minHeight: 200,
    borderRadius: 12,
    backgroundColor: '#f0f0f0',
    maxWidth: '100%',
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
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
    marginTop: 20,
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

  // Reactions (detail)
  reactionsCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
  },
  reactionsTitle: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  reactionChipText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  reactionChipCount: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },

  // Reactions (list summary)
  reactionSummaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  reactionSummaryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  reactionSummaryText: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },
  reactionSummaryCount: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },

  reactedByRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  reactedByAvatars: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    flexWrap: 'wrap',
  },
  reactedAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactedAvatarText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  reactedByText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },

  // Picker + reacted-by modal
  pickerModalContainer: {
    width: '90%',
    maxWidth: 520,
    maxHeight: '60%',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  pickerHeader: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pickerTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  pickerInputs: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
  categoryRow: {
    paddingBottom: 2,
    paddingRight: 6,
    gap: 8,
    alignItems: 'center',
  },
  categoryChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  categoryChipText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  pickerInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  customRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  customPickButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  customPickButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  pickerGrid: {
    padding: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  pickerEmojiButton: {
    width: 46,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerEmojiText: {
    fontSize: 22,
  },
  reactedSectionTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  reactedMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  reactedMemberText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    flex: 1,
  },
  detailActions: {
    flexDirection: 'row',
    padding: 20,
    borderTopWidth: 1,
    gap: 12,
    flexShrink: 0, // Prevent this section from shrinking
  },
  detailActionButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  detailActionButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
});

export default NoticeModal;
