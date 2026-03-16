import { logger } from '@/lib/logger';
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
  KeyboardAvoidingView,
  Keyboard,
  BackHandler,
  Platform,
  Image,
  FlatList as RNFlatList,
  Modal,
  Pressable,
  SafeAreaView,
  Animated,
  Dimensions,
  AppState,
  AppStateStatus,
  InteractionManager,
  Alert,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import Toast from 'react-native-toast-message';
import { useTheme } from '../../hooks/useTheme';
import { useAuth, authService } from '../../hooks/useAuthUnified';
import { useBirthdays } from '../../components/BirthdayProvider';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import type { TeamMember } from '../../hooks/useAuthUnified';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { useChat } from '../../hooks/useChat';
import { chatService, ChatRateLimitError, ChatMessageActionError, ChatUploadCanceledError } from '../../services/chatService';
import { MediaPickerUtil } from '../../lib/mediaPickerUtil';
import { getProfileImageUrl } from '../../lib/profileImage';
import { FileDownloadUtil } from '../../lib/fileDownloadUtil';
import { PendingMessage, PendingMessageStorage } from '../../lib/pendingMessageStorage';
import {
  EnhancedMessageRenderer,
  MobileChatInput,
  MessageStatusTicks,
  ChatProfileModal,
  StyledText,
  FileViewer,
  ShareModal,
  EnhancedEmojiPicker,
  OptionModal,
  ConfirmationModal,
} from '../../components';
import VideoPlayer from '../../components/VideoPlayer';
import { StickerGifPickerMobile } from '../../components/StickerGifPickerMobile';
import ProgressiveImage from '../../components/ui/ProgressiveImage';
import { ArrowLeft, Search, X, Paperclip, Smile, Play, Star, Clock, MessageCircle, Send, Heart, Eye, AlertCircle, Download, Share, Camera, Trash2, ChevronDown, RotateCcw, CheckCircle2, File as FileIcon, Image as ImageIcon, Edit3 } from 'lucide-react-native';
import { formatMessageTimestamp, getChatDateSeparator, formatOnlineStatus } from '../../lib/timeUtils';
import { isImageFile, isVideoFile } from '../../lib/fileUtils';
import { notificationService } from '../../services/notificationService';
import { chatPreferencesService } from '../../services/chatPreferencesService';
import type { FileAttachment , ConversationSummary } from '../../services/chatService';
import { chatCacheService } from '../../services/chatCacheService';
import type { HydratedAttachment } from '../../services/chatCacheService';
import RichEditText from '../../components/RichEditText';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';
import { useFrameTimingMonitor } from '../../hooks/useFrameTimingMonitor';
import { getChatPaginationProfile } from '@/lib/chatPaginationConfig';
import { clearDownloadState, setDownloadState } from '@/lib/downloadStateStore';
import { reconcileConversationUnreadCount, shouldRefreshChatSummariesOnForegroundResume } from '@/lib/chatReceiptState';
import { useTenant } from '@/hooks/useTenantContext';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { tenantService } from '@/services/tenantService';
import TenantRoleBadge from '@/components/TenantRoleBadge';
import { normalizeSharedFileName } from '@/services/sharedFileService';
import { useDownloadState } from '@/hooks/useDownloadState';
import { setEditingMessageId, setMessageReactionsForMessage } from '@/lib/messageUiStateStore';
import { useMessageUiState } from '@/hooks/useMessageUiState';

export default function Chat() {
  const { theme, isDarkMode } = useTheme();
  // Debug toggle: set to true while diagnosing scroll/anchor behavior (web/native)
  const CHAT_SCROLL_DEBUG = false;
  const { headerCompensation, setSuppressFab } = useBirthdays();
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);
  const sharedTopPadding = useSharedTopPadding();
  const isFocused = useIsFocused();
  const router = useRouter();
  const searchParams = useLocalSearchParams<{ senderEmail?: string; chatId?: string; messageId?: string; senderName?: string }>();
  const { user, loading: authLoading } = useAuth();
  const { activeTenant, loading: tenantLoading } = useTenant();
  const tenantUnavailable = !tenantLoading && !activeTenant?.id;
  const { isOffline } = useNetworkStatus();
  const [currentUser, setCurrentUser] = useState<any>(user);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [teamMembersWithChatInfo, setTeamMembersWithChatInfo] = useState<any[]>([]);
  const [teamMembersLoading, setTeamMembersLoading] = useState(false);
  const [teamMembersError, setTeamMembersError] = useState<string | null>(null);
  const [selectedTeamMember, setSelectedTeamMember] = useState<TeamMember | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [message, setMessage] = useState('');
  const latestMessageRef = useRef(message);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const sendInFlightRef = useRef(false);
  const [pendingMessages, setPendingMessages] = useState<Map<string, PendingMessage>>(new Map());
  const [pendingMedia, setPendingMedia] = useState<Map<string, PendingMediaItem>>(new Map());
  const [pendingAttachments, setPendingAttachments] = useState<Map<string, PendingAttachmentItem>>(new Map());
  const attachmentUploadCancelMap = useRef<Map<string, () => void | Promise<void>>>(new Map());
  const attachmentFinalizeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const tenantMembersRequestIdRef = useRef(0);
  const tenantRosterRef = useRef<TeamMember[]>([]);
  const presenceSnapshotRef = useRef<Map<string, TeamMember>>(new Map());
  const rawPresenceSnapshotRef = useRef<Map<string, TeamMember>>(new Map());
  const [retryingPendingMessages, setRetryingPendingMessages] = useState<Set<string>>(new Set());
  const clearAttachmentFinalizeTimer = useCallback((tempId: string) => {
    const timer = attachmentFinalizeTimers.current.get(tempId);
    if (timer) {
      clearTimeout(timer);
      attachmentFinalizeTimers.current.delete(tempId);
    }
  }, []);

  const scheduleAttachmentFinalizeCleanup = useCallback(
    (tempId: string, delayMs: number = 1200) => {
      clearAttachmentFinalizeTimer(tempId);
      const timer = setTimeout(() => {
        setPendingAttachments((prev) => {
          if (!prev.has(tempId)) {
            return prev;
          }
          const current = prev.get(tempId);
          if (!current || current.status !== 'finalizing') {
            return prev;
          }
          const next = new Map(prev);
          next.delete(tempId);
          return next;
        });
        attachmentFinalizeTimers.current.delete(tempId);
        attachmentUploadCancelMap.current.delete(tempId);
      }, delayMs);
      attachmentFinalizeTimers.current.set(tempId, timer);
    },
    [clearAttachmentFinalizeTimer]
  );

    const mergeRosterWithPresence = useCallback(
      (roster: TeamMember[], presenceMap: Map<string, TeamMember>): TeamMember[] => {
        if (!roster || roster.length === 0) {
          return [];
        }

        return roster.map((member) => {
          const key = member.email?.toLowerCase?.() || member.id;
          const presence = key ? presenceMap.get(key) : undefined;

          if (!presence) {
            return member;
          }

          return {
            ...member,
            role: member.role, // ensure tenant role overwrites stale role values
            tenantRole: member.tenantRole,
            name: presence.name || member.name,
            avatar: presence.avatar || member.avatar,
            photoURL: presence.photoURL ?? member.photoURL,
            customImageURL: presence.customImageURL ?? member.customImageURL,
            isOnline: presence.isOnline ?? member.isOnline,
            lastSeen: presence.lastSeen ?? member.lastSeen,
            typingTo: presence.typingTo ?? member.typingTo,
            school: presence.school ?? member.school,
            bio: presence.bio ?? member.bio,
            phone: presence.phone ?? member.phone,
            dateOfBirth: presence.dateOfBirth ?? member.dateOfBirth,
            salutation: presence.salutation ?? member.salutation,
            subjects: presence.subjects ?? member.subjects,
          } satisfies TeamMember;
        });
      },
      []
    );

    const buildPresenceSnapshotForRoster = useCallback((
      roster: TeamMember[],
    ): Map<string, TeamMember> => {
      if (!roster || roster.length === 0) {
        return new Map();
      }

      const rosterEmails = new Set(
        roster
          .map((member) => member.email?.toLowerCase?.())
          .filter((value): value is string => Boolean(value))
      );

      const filtered = new Map<string, TeamMember>();
      rawPresenceSnapshotRef.current.forEach((member, key) => {
        if (rosterEmails.has(key)) {
          filtered.set(key, member);
        }
      });

      return filtered;
    }, []);

  useEffect(() => {
    return () => {
      attachmentFinalizeTimers.current.forEach((timer) => clearTimeout(timer));
      attachmentFinalizeTimers.current.clear();
      attachmentUploadCancelMap.current.clear();
    };
  }, []);
  const [deleteConfirmState, setDeleteConfirmState] = useState<{ visible: boolean; message: any | null }>({
    visible: false,
    message: null,
  });
  const [attachmentModalVisible, setAttachmentModalVisible] = useState(false);
  const [richTextInputVisible, setRichTextInputVisible] = useState(false);
  const appStateRef = useRef<AppStateStatus>(
    (Platform.OS === 'web' ? 'active' : (AppState.currentState ?? 'active')) as AppStateStatus
  );
  const lastForegroundRefreshAtRef = useRef(0);
  const wasForegroundInteractiveRef = useRef(false);
  const [isAppActive, setIsAppActive] = useState(appStateRef.current === 'active');
  // Moved to top: showUnreadSeparator, unreadSeparatorMessageId
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [screenData, setScreenData] = useState(Dimensions.get('window'));
  const [isUserActiveInChat, setIsUserActiveInChat] = useState(false);
  const [lastUserActivityAt, setLastUserActivityAt] = useState<number>(Date.now());
  const [presenceIdleTick, setPresenceIdleTick] = useState(0);
  const lastUserActivityRef = useRef<number>(Date.now());
  const userActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userActiveRef = useRef(false);
  const mobileInputRef = useRef<any>(null);
  const textInputRef = useRef<TextInput>(null);
  const richTextInputRef = useRef<any>(null);
  const [isLoadingChatInfo, setIsLoadingChatInfo] = useState(false);
  const [conversationSummaries, setConversationSummaries] = useState<Map<string, ConversationSummary>>(new Map());
  const isSmallScreen = screenData.width < 700;
  const [pinnedChats, setPinnedChats] = useState<Record<string, number>>({});
  const [userListOptionsVisible, setUserListOptionsVisible] = useState(false);
  const [longPressedMember, setLongPressedMember] = useState<TeamMember | null>(null);
  const openAttachmentModal = useCallback(() => setAttachmentModalVisible(true), []);
  const closeAttachmentModal = useCallback(() => setAttachmentModalVisible(false), []);

  useFrameTimingMonitor({ tag: 'chat-screen', thresholdMs: 40, sampleSize: 240 });

  // Hide Birthday FAB on the chat message screen, show on chat list
  useEffect(() => {
    try {
      setSuppressFab(!!selectedTeamMember);
    } catch {}
    return () => {
      try { setSuppressFab(false); } catch {}
    };
  }, [selectedTeamMember, setSuppressFab]);

  useEffect(() => {
    latestMessageRef.current = message;
  }, [message]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      appStateRef.current = nextState;
      setIsAppActive(nextState === 'active');
    };

    if (Platform.OS === 'web' && typeof AppState.addEventListener !== 'function') {
      const handleVisibilityChange = () => {
        const visible = typeof document !== 'undefined' ? document.visibilityState === 'visible' : true;
        appStateRef.current = visible ? 'active' : 'background';
        setIsAppActive(visible);
      };

      handleVisibilityChange();

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange);
      }

      return () => {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', handleVisibilityChange);
        }
      };
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      }
    };
  }, []);

  // (moved back handler lower to avoid use-before-define)

  // Local types used in this screen
  interface TeamMemberWithChatInfo extends TeamMember {
    unreadCount: number;
    lastMessage: {
      text: string;
      timestamp: string;
      isOwnMessage: boolean;
      delivered: boolean;
      read: boolean;
    } | null;
    lastMessageTime?: string;
    summaryUpdatedAt?: string;
    pinnedSerial?: number;
  }

  interface PendingMediaItem {
    id: string;
    kind: 'gif' | 'sticker';
    previewUri: string;
    width?: number;
    height?: number;
    nameOrTitle?: string;
    timestamp: string;
    recipientId: string;
    sender: string;
    status: 'sending' | 'failed' | 'queued';
    mime?: string;
    source?: 'keyboard' | 'picker';
    progress?: number; // 0-100 upload progress for local uploads
  }

  interface PendingAttachmentItem {
    id: string;
    files: {
      uri: string;
      fileName: string;
      fileType: string;
      fileSize?: number;
    }[];
    messageText: string;
    recipientId: string;
    sender: string;
    status: 'sending' | 'failed' | 'finalizing';
    progress: number; // 0-100 overall progress
    cancelable?: boolean;
    cancelRequested?: boolean;
    failureReason?: 'error' | 'canceled';
  }

  // Helper to detect media type (gif vs sticker/image) from uri/mime
  const detectMediaTypeFromUri = (uri?: string, mime?: string): 'gif' | 'sticker' => {
    const m = (mime || '').toLowerCase();
    const u = (uri || '').toLowerCase();
    if (m.includes('gif') || /\.gif(\?|$)/.test(u)) return 'gif';
    return 'sticker';
  };

  // Chat data for selected member
  const {
    messages = [],
    loading = false,
    error = null,
    reconnect: reconnectChat,
    hasMore = false,
    loadingMore = false,
    loadMore,
    warmNextPage,
    sendMessage,
    sendMessageWithFile,
    sendMessageWithFiles,
    sendSticker,
    sendGif,
    editMessage: editChatMessage,
    deleteMessage: deleteChatMessage,
  } = useChat(selectedTeamMember?.id, { live: isFocused && isAppActive });

  const CHAT_RECONNECT_TIMEOUT_MS = 8000;
  const [showReconnectFallback, setShowReconnectFallback] = useState(false);
  const shouldTrackReconnectFallback =
    Boolean(selectedTeamMember) &&
    Boolean(error) &&
    !loading &&
    messages.length === 0;

  useEffect(() => {
    if (!shouldTrackReconnectFallback) {
      setShowReconnectFallback(false);
      return;
    }

    const timer = setTimeout(() => {
      setShowReconnectFallback(true);
    }, CHAT_RECONNECT_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [shouldTrackReconnectFallback]);

  const handleManualReconnect = useCallback(() => {
    setShowReconnectFallback(false);
    reconnectChat();
  }, [reconnectChat]);

  const [animatedMessages, setAnimatedMessages] = useState<Set<string>>(new Set());
  const [previousMessageIds, setPreviousMessageIds] = useState<Set<string>>(new Set());
  
  // Special message command state
  const [showSpecialCommand, setShowSpecialCommand] = useState(false);
  const [isComposingSpecial, setIsComposingSpecial] = useState(false);

  // Sticker and GIF picker state
  const [stickerGifPickerVisible, setStickerGifPickerVisible] = useState(false);
  const openStickerGifPicker = useCallback(() => setStickerGifPickerVisible(true), []);
  const closeStickerGifPicker = useCallback(() => setStickerGifPickerVisible(false), []);
  
  // Chat profile modal state
  const [chatProfileModalVisible, setChatProfileModalVisible] = useState(false);

  // Message reactions state with proper typing for any emoji
  const messageReactionsRef = useRef<Map<string, { [key: string]: Set<string> }>>(new Map());
  const reactionOptimisticUntilRef = useRef<Map<string, number>>(new Map());

  // Emoji picker state for all messages
  // Tenor fallback for sticker URLs on native (webp -> gif)
  const TENOR_API_KEY = process.env.EXPO_PUBLIC_TENOR_API_KEY;
  const TENOR_BASE_URL = 'https://tenor.googleapis.com/v2';
  const [stickerUrlMap, setStickerUrlMap] = useState<Map<string, string>>(new Map());
  const [gifUrlMap, setGifUrlMap] = useState<Map<string, string>>(new Map());
  // Centralized offline-aware loading gate (prevents empty chat UI on cold offline start)
  const { showLoading: showOfflineLoadingChat, offlineHint: offlineHintChat } = useOfflineDataGate(
    [teamMembers],
    [authLoading]
  );
  // Defer early return until after all hooks are declared

  const extractTenorIdFromUrl = useCallback((url: string): string | null => {
    try {
      const u = new URL(url);
      if (!u.hostname.includes('tenor.com')) return null;
      // media.tenor.com/{id}/...
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 1) return parts[0];
      return null;
    } catch {
      return null;
    }
  }, []);
  

  const headOk = useCallback(async (url: string) => {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const resolveNativeSafeStickerUrl = useCallback(async (originalUrl: string): Promise<string | null> => {
    if (Platform.OS === 'web') return originalUrl;
    // Already mapped
    const mapped = stickerUrlMap.get(originalUrl);
    if (mapped) return mapped;
    // If already gif, keep
    if (/\.gif($|\?)/i.test(originalUrl)) return originalUrl;

    // Quick extension swap try for Tenor
    if (/tenor\.com/.test(originalUrl) && /\.webp($|\?)/i.test(originalUrl)) {
      const guess = originalUrl.replace(/\.webp(\?|$)/i, '.gif$1');
      if (await headOk(guess)) {
        setStickerUrlMap(prev => new Map(prev).set(originalUrl, guess));
        return guess;
      }
    }

    // Use Tenor posts lookup by id to find gif variant
    const id = extractTenorIdFromUrl(originalUrl);
    if (id && TENOR_API_KEY) {
      try {
        const url = `${TENOR_BASE_URL}/posts?ids=${encodeURIComponent(id)}&key=${TENOR_API_KEY}&media_filter=basic`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const result = data?.results?.[0];
          const fm = result?.media_formats || {};
          const alt = fm.tinygif?.url || fm.nanogif?.url || fm.gif?.url || fm.mediumgif?.url || null;
          if (alt) {
            setStickerUrlMap(prev => new Map(prev).set(originalUrl, alt));
            return alt;
          }
        }
      } catch {}
    }
    return null;
  }, [TENOR_API_KEY, extractTenorIdFromUrl, headOk, stickerUrlMap]);

  // Prefer smaller Tenor GIF variant for performance
  const resolveOptimizedGifUrl = useCallback(async (originalUrl: string): Promise<string> => {
    const mapped = gifUrlMap.get(originalUrl);
    if (mapped) return mapped;
    const id = extractTenorIdFromUrl(originalUrl);
    if (id && TENOR_API_KEY) {
      try {
        const url = `${TENOR_BASE_URL}/posts?ids=${encodeURIComponent(id)}&key=${TENOR_API_KEY}&media_filter=basic`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const result = data?.results?.[0];
          const fm = result?.media_formats || {};
          const alt = fm.tinygif?.url || fm.nanogif?.url || fm.gif?.url || fm.mediumgif?.url || originalUrl;
          setGifUrlMap(prev => new Map(prev).set(originalUrl, alt));
          return alt;
        }
      } catch {}
    }
    return originalUrl;
  }, [TENOR_API_KEY, TENOR_BASE_URL, gifUrlMap, extractTenorIdFromUrl]);
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [selectedMessageForReaction, setSelectedMessageForReaction] = useState<string | null>(null);
  const [reactionPickerPosition, setReactionPickerPosition] = useState({ x: 0, y: 0 });
  const [selectedMessageForAction, setSelectedMessageForAction] = useState<any | null>(null);
  const [editingMessageInfo, setEditingMessageInfo] = useState<{ id: string; originalText: string } | null>(null);
  const [pendingMessageActions, setPendingMessageActions] = useState<Set<string>>(new Set());

  const buildDisplayKey = useCallback((message: any): string => {
    if (!message) {
      return '';
    }

    if (message.id) {
      return `id:${String(message.id)}`;
    }

    const sender = typeof message.sender === 'string' ? message.sender.toLowerCase() : '';
    const recipient = typeof message.recipientId === 'string' ? message.recipientId.toLowerCase() : '';

    let timestamp = '';
    const rawTimestamp = (message as any)?.timestamp;
    if (typeof rawTimestamp === 'string') {
      timestamp = rawTimestamp;
    } else if (rawTimestamp instanceof Date) {
      timestamp = rawTimestamp.toISOString();
    } else if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
      timestamp = new Date(rawTimestamp).toISOString();
    } else if (rawTimestamp && typeof rawTimestamp.toDate === 'function') {
      try {
        timestamp = rawTimestamp.toDate().toISOString();
      } catch {
        timestamp = '';
      }
    }

    const text = typeof message.text === 'string' ? message.text : '';
    const attachmentsSignature = Array.isArray(message.attachments)
      ? (message.attachments as (HydratedAttachment | FileAttachment | { url?: string; fileName?: string })[])
          .map((att) => `${att?.url ?? ''}:${att?.fileName ?? ''}`)
          .join(',')
      : '';
    const gifUrl = typeof message?.gif?.url === 'string' ? message.gif.url : '';
    const stickerUrl = typeof message?.sticker?.url === 'string' ? message.sticker.url : '';

    return `fallback:${sender}|${recipient}|${timestamp}|${text}|${attachmentsSignature}|${gifUrl}|${stickerUrl}`;
  }, []);

  const normalizeMessageId = useCallback((id: any): string => {
    if (id === null || id === undefined) {
      return '';
    }
    return String(id);
  }, []);

  const shouldKeepOptimisticReactions = useCallback(
    (messageId: string) => {
      if (!messageId) return false;
      const until = reactionOptimisticUntilRef.current.get(messageId);
      if (!until) return false;
      if (until > Date.now()) return true;
      reactionOptimisticUntilRef.current.delete(messageId);
      return false;
    },
    []
  );

  const stableMessageCacheRef = useRef<Map<string, { signature: string; message: any }>>(new Map());
  const stableDisplayedMessagesRef = useRef<any[]>([]);

  const getMessageRenderSignature = useCallback((message: any): string => {
    if (!message) {
      return '';
    }

    const sender = typeof message.sender === 'string' ? message.sender.toLowerCase() : '';
    const recipient = typeof message.recipientId === 'string' ? message.recipientId.toLowerCase() : '';

    let timestamp = '';
    const rawTimestamp = (message as any)?.timestamp;
    if (typeof rawTimestamp === 'string') {
      timestamp = rawTimestamp;
    } else if (rawTimestamp instanceof Date) {
      timestamp = rawTimestamp.toISOString();
    } else if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
      timestamp = new Date(rawTimestamp).toISOString();
    } else if (rawTimestamp && typeof rawTimestamp.toDate === 'function') {
      try {
        timestamp = rawTimestamp.toDate().toISOString();
      } catch {
        timestamp = '';
      }
    }

    const text = typeof message.text === 'string' ? message.text : '';
    const editCount = typeof message.editCount === 'number' ? String(message.editCount) : '';
    const editedAt = message.editedAt ? String(message.editedAt) : '';
    const deleted = message.deleted ? '1' : '0';
    const delivered = message.delivered ? '1' : '0';
    const read = message.read ? '1' : '0';
    const isSpecial = message.isSpecial ? '1' : '0';
    const gifUrl = typeof message?.gif?.url === 'string' ? message.gif.url : '';
    const stickerUrl = typeof message?.sticker?.url === 'string' ? message.sticker.url : '';
    const attachmentsSignature = Array.isArray(message.attachments)
      ? (message.attachments as (HydratedAttachment | FileAttachment | { url?: string; fileName?: string; fileType?: string; fileSize?: number; resolvedUrl?: string })[])
          .map((att) => `${att?.url ?? ''}:${(att as any)?.resolvedUrl ?? ''}:${att?.fileName ?? ''}:${att?.fileType ?? ''}:${att?.fileSize ?? ''}`)
          .join(',')
      : '';

    return [
      sender,
      recipient,
      timestamp,
      text,
      editCount,
      editedAt,
      deleted,
      delivered,
      read,
      isSpecial,
      gifUrl,
      stickerUrl,
      attachmentsSignature,
    ].join('|');
  }, []);

  const displayedMessages = useMemo(() => {
    if (!Array.isArray(messages) || messages.length === 0) {
      stableMessageCacheRef.current = new Map();
      stableDisplayedMessagesRef.current = [];
      return [] as any[];
    }

    const deduped = new Map<string, any>();

    messages.forEach((message: any) => {
      if (!message) {
        return;
      }
      const key = buildDisplayKey(message);
      if (!key) {
        return;
      }

      if (!deduped.has(key)) {
        deduped.set(key, message);
        return;
      }

      const existing = deduped.get(key);
      if (!existing?.id && message.id) {
        deduped.set(key, message);
        return;
      }

      const existingTime = new Date(existing?.timestamp ?? '').getTime();
      const incomingTime = new Date(message?.timestamp ?? '').getTime();
      if (Number.isFinite(incomingTime) && (!Number.isFinite(existingTime) || incomingTime > existingTime)) {
        deduped.set(key, message);
      }
    });

    const nextCache = new Map<string, { signature: string; message: any }>();
    const result = Array.from(deduped.entries()).map(([key, message]) => {
      const stableKey = message?.id != null
        ? `id:${String(message.id)}`
        : message?.localId != null
          ? `local:${String(message.localId)}`
          : `display:${key}`;
      const signature = getMessageRenderSignature(message);
      const cached = stableMessageCacheRef.current.get(stableKey);
      if (cached && cached.signature === signature) {
        nextCache.set(stableKey, cached);
        return cached.message;
      }
      const entry = { signature, message };
      nextCache.set(stableKey, entry);
      return message;
    });

    result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    stableMessageCacheRef.current = nextCache;

    const previous = stableDisplayedMessagesRef.current;
    if (previous.length === result.length && previous.every((msg, index) => msg === result[index])) {
      return previous;
    }

    stableDisplayedMessagesRef.current = result;
    return result;
  }, [messages, buildDisplayKey, getMessageRenderSignature]);

  const getMessageItemType = useCallback((item: any) => {
    if (!item) return 'unknown';
    if (item.sticker) return 'sticker';
    if (item.gif) return 'gif';
    if (Array.isArray(item.attachments) && item.attachments.length > 0) return 'attachment';
    if (item.isSpecial) return 'special';
    return 'text';
  }, []);

  const getMessageKey = useCallback(
    (item: any, index: number) => {
      if (!item) {
        return `ghost:${index}`;
      }

      if (item.id != null) {
        return `id:${String(item.id)}`;
      }

      if (item.localId) {
        return `local:${String(item.localId)}`;
      }

      const fallback = buildDisplayKey(item);
      if (fallback) {
        return `display:${fallback}`;
      }

      if (item.timestamp) {
        return `timestamp:${item.timestamp}:${index}`;
      }

      return `index:${index}`;
    },
    [buildDisplayKey]
  );

  const overrideMessageLayout = useCallback(
    (layout: { size?: number; span?: number }, item: any, _index: number) => {
      const type = getMessageItemType(item);
      if (type === 'sticker') {
        layout.size = 188;
      } else if (type === 'gif') {
        layout.size = 280;
      } else if (type === 'attachment') {
        layout.size = 220;
      }
    },
    [getMessageItemType]
  );

  useEffect(() => {
    if (!selectedTeamMember?.id) {
      setLocalMessageReactions(() => new Map());
      return;
    }

    const visibleIds = new Set(
      displayedMessages
        .map((msg: any) => normalizeMessageId(msg?.id))
        .filter((id: string) => id.length > 0)
    );

    setLocalMessageReactions(prev => {
      if (prev.size === 0) {
        return prev;
      }

      let changed = false;
      const next = new Map<string, { [key: string]: Set<string> }>();
      prev.forEach((value, key) => {
        if (visibleIds.has(key)) {
          next.set(key, value);
        } else {
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [displayedMessages, selectedTeamMember?.id]);

  // Formatting guide state
  const [showFormattingGuide, setShowFormattingGuide] = useState(false);
  const toggleFormattingGuide = useCallback(() => {
    setShowFormattingGuide(prev => !prev);
  }, []);
  const hideFormattingGuide = useCallback(() => {
    setShowFormattingGuide(false);
  }, []);
  // Processing state for keyboard-inserted media (Android/iOS)
  const [processingKeyboardMedia, setProcessingKeyboardMedia] = useState(false);

  // Sound throttling state
  const lastSoundPlayedRef = useRef<number>(0);
  const soundTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SOUND_THROTTLE_MS = 1000; // Minimum time between sounds

  // Global animation tracking to prevent multiple animations per message
  const globalAnimatedMessages = useRef<Set<string>>(new Set());

  // Simple sound service for web
  const playMessageSound = () => {
    if (Platform.OS === 'web') {
      const now = Date.now();
      // Throttle sound to prevent multiple plays within 1 second
      if (now - lastSoundPlayedRef.current < SOUND_THROTTLE_MS) {
        return;
      }
      lastSoundPlayedRef.current = now;
      
      // Clear any existing sound timeout
      if (soundTimeoutRef.current) {
        clearTimeout(soundTimeoutRef.current);
      }
      
      // Debounce the sound to group rapid messages
      soundTimeoutRef.current = setTimeout(() => {
        try {
          // Only use Web Audio API on web platform
          if (Platform.OS === 'web' && typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
            oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.1);
            gainNode.gain.setValueAtTime(0.2, audioContext.currentTime); // Reduced volume
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.2); // Shorter sound
          }
        } catch (error) {
          // Fail silently if sound cannot be played
        }
      }, 100); // Small delay to group rapid messages
    }
  };

  // sendMessageNotification is defined after effectiveUser to avoid TDZ
  const [selectedFiles, setSelectedFiles] = useState<any[]>([]);
  const selectedFilesRef = useRef<any[]>([]);
  const [isChatDropActive, setIsChatDropActive] = useState(false);
  const [skippedPreviewFiles, setSkippedPreviewFiles] = useState<string[]>([]);
  const MAX_SKIPPED_PREVIEW_ITEMS = 30;
  
  // Media prefetch cache
  const prefetchedUrisRef = useRef<Set<string>>(new Set());
  const prefetchUri = useCallback(async (uri?: string) => {
    if (!uri) return;
    if (prefetchedUrisRef.current.has(uri)) return;
    try {
      await Image.prefetch(uri);
      prefetchedUrisRef.current.add(uri);
    } catch {}
  }, []);
  const [filePreviewVisible, setFilePreviewVisible] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [selectedImageUri, setSelectedImageUri] = useState<string>('');
  const [lastViewedRemoteImage, setLastViewedRemoteImage] = useState<string | undefined>(undefined);
  const [brokenFileUrls, setBrokenFileUrls] = useState<Set<string>>(new Set());
  const [networkErrorUrls, setNetworkErrorUrls] = useState<Set<string>>(new Set());
  const downloadingUrlsRef = useRef<Set<string>>(new Set());
  const [fileValidationCache] = useState<Map<string, number>>(new Map()); // Cache file validation results
  const [showImageShareModal, setShowImageShareModal] = useState(false);

  const syncMessageReactions = useCallback(
    (prev: Map<string, { [key: string]: Set<string> }>, next: Map<string, { [key: string]: Set<string> }>) => {
      const changedIds = new Set<string>();

      next.forEach((value, key) => {
        if (prev.get(key) !== value) {
          changedIds.add(key);
        }
      });

      prev.forEach((_value, key) => {
        if (!next.has(key)) {
          changedIds.add(key);
        }
      });

      changedIds.forEach((messageId) => {
        setMessageReactionsForMessage(messageId, next.get(messageId));
      });
    },
    []
  );

  const setLocalMessageReactions = useCallback(
    (updater: (prev: Map<string, { [key: string]: Set<string> }>) => Map<string, { [key: string]: Set<string> }>) => {
      const prev = messageReactionsRef.current;
      const next = updater(prev);
      if (next === prev) {
        return;
      }
      messageReactionsRef.current = next;
      syncMessageReactions(prev, next);
    },
    [syncMessageReactions]
  );

  useEffect(() => {
    setEditingMessageId(editingMessageInfo?.id ?? null);
  }, [editingMessageInfo?.id]);

  // Intentionally avoid tying list re-renders to reactions/editing to prevent media interruptions.
  
  // ——— Viewability/prefetch dependencies kept in refs so the handler identity stays stable ———
  const effectiveUser = user || currentUser;
  const effectiveUserEmail = useMemo(() => {
    const candidate = effectiveUser?.email || user?.email || currentUser?.email;
    return typeof candidate === 'string' ? candidate.toLowerCase() : '';
  }, [effectiveUser?.email, user?.email, currentUser?.email]);
  const selectedMemberEmail = useMemo(() => {
    const email = selectedTeamMember?.email;
    return typeof email === 'string' ? email.toLowerCase() : '';
  }, [selectedTeamMember?.email]);
  const displayedMessagesRef = useRef<any[]>([]);
  useEffect(() => {
    const displayed = displayedMessages;
    if (displayed.length) {
      const memberId = selectedTeamMember?.id;
      const userEmail = effectiveUser?.email;
      if (memberId && userEmail) {
        const mediaToWarm: { remoteUrl: string; fileName?: string }[] = [];
        displayed.forEach((msg: any) => {
          const addUrl = (url?: string, fileName?: string) => {
            if (!url) return;
            if (url.startsWith('file://')) return;
            mediaToWarm.push({ remoteUrl: url, fileName });
          };
          if (Array.isArray(msg.attachments)) {
            msg.attachments.forEach((att: any) => addUrl(att.url, att.fileName));
          }
        });

        if (mediaToWarm.length) {
          Promise.allSettled(
            mediaToWarm.slice(0, 8).map(({ remoteUrl, fileName }) =>
              chatCacheService.getMediaForDownload(remoteUrl, fileName, undefined, 'low').catch(() => undefined)
            )
          ).catch(() => undefined);
        }
      }
    }
    displayedMessagesRef.current = displayed;
  }, [displayedMessages, selectedTeamMember?.id, effectiveUser?.email]);

  const selectedPartnerEmailRef = useRef<string | null>(null);
  useEffect(() => {
    selectedPartnerEmailRef.current = selectedTeamMember?.email?.toLowerCase?.() ?? null;
  }, [selectedTeamMember?.email]);

  const effectiveUserEmailRef = useRef<string | null>(null);
  useEffect(() => {
    effectiveUserEmailRef.current = effectiveUser?.email?.toLowerCase?.() ?? null;
  }, [effectiveUser?.email]);

  const stickerUrlMapRef = useRef(stickerUrlMap);
  useEffect(() => { stickerUrlMapRef.current = stickerUrlMap; }, [stickerUrlMap]);

  const gifUrlMapRef = useRef(gifUrlMap);
  useEffect(() => { gifUrlMapRef.current = gifUrlMap; }, [gifUrlMap]);

  const prefetchUriRef = useRef(prefetchUri);
  useEffect(() => { prefetchUriRef.current = prefetchUri; }, [prefetchUri]);

  const warmNextPageRef = useRef(warmNextPage);
  useEffect(() => { warmNextPageRef.current = warmNextPage; }, [warmNextPage]);

  const resolveNativeSafeStickerUrlRef = useRef(resolveNativeSafeStickerUrl);
  useEffect(() => { resolveNativeSafeStickerUrlRef.current = resolveNativeSafeStickerUrl; }, [resolveNativeSafeStickerUrl]);

  const resolveOptimizedGifUrlRef = useRef(resolveOptimizedGifUrl);
  useEffect(() => { resolveOptimizedGifUrlRef.current = resolveOptimizedGifUrl; }, [resolveOptimizedGifUrl]);

  const paginationProfile = useMemo(
    () => getChatPaginationProfile(Platform.OS === 'web' ? 'web' : 'native'),
    []
  );
  const requestOlderMessagesRef = useRef<((reason: 'auto' | 'manual') => void) | null>(null);
  const TOP_AUTO_LOAD_THRESHOLD = 2;
  const TOP_PREFETCH_THRESHOLD = paginationProfile.prefetchThreshold;
  const loadOlderLockRef = useRef(false);
  const loadOlderAttemptsRef = useRef(0);
  const reachedConversationStartRef = useRef(false);
  const [reachedConversationStart, setReachedConversationStart] = useState(false);
  const hasMoreRef = useRef(hasMore);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  const autoLoadAnchorRef = useRef<string | null>(null);
  const shouldUseManualAnchorPreservation = Platform.OS === 'web';

  // Scroll + anchor state shared across pagination and sticky headers
  const scrollViewRef = useRef<ScrollView>(null);
  const flatListRef = useRef<FlashList<any>>(null);
  type TelemetryProfile = Awaited<ReturnType<typeof chatCacheService.getTelemetryContext>>;
  const concurrencyProfileRef = useRef<TelemetryProfile | null>(null);
  const renderTraceRef = useRef<{
    startedAt: number;
    conversationId: string;
    reason: 'initial' | 'refresh';
    profile?: TelemetryProfile | null;
  } | null>(null);
  const prevSettlementRef = useRef<boolean | null>(null);

  const [stickyDateVisible, setStickyDateVisible] = useState(false);
  const [stickyDateText, setStickyDateText] = useState('');
  const [messagePositions, setMessagePositions] = useState<{ [key: string]: { y: number; height: number; date: string } }>({});
  const messagePositionsRef = useRef(messagePositions);
  useEffect(() => {
    messagePositionsRef.current = messagePositions;
  }, [messagePositions]);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollToBottomRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const lastTailIdRef = useRef<string | null>(null);
  const contentHeightRef = useRef(0);
  const layoutHeightRef = useRef(0);
  const lastScrollOffsetRef = useRef(0);
  const topVisibleMessageRef = useRef<{ id: string; index: number } | null>(null);
  const pendingPrependAnchorRef = useRef<{ id: string; offset: number; attempts: number } | null>(null);
  const lastAnchoredAtRef = useRef<number>(0);
  const anchoredTargetRef = useRef<{ type: 'bottom' | 'message'; id?: string } | null>(null);
  const userInteractedRef = useRef(false);
  const STABILIZE_MS = Platform.OS === 'android' ? 2500 : 1500;
  const DEFAULT_BOTTOM_VISIBILITY_BUFFER = Platform.select({
    ios: 28,
    android: 32,
    default: 24,
  }) ?? 24;
  const stabilizationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLoadingMoreRef = useRef(false);
  const [isInitialAnchorSettled, setIsInitialAnchorSettled] = useState(false);
  const [inputHeight, setInputHeight] = useState(40);
  const [lastTypingHeight, setLastTypingHeight] = useState(40);
  const previousIncomingUnreadRef = useRef<number>(0);
  const requestedReadReceiptIdsRef = useRef<Set<string>>(new Set());
  const queuedReadReceiptIdsRef = useRef<Set<string>>(new Set());
  const queuedConversationDeliverySyncRef = useRef(false);
  const receiptSyncRunningRef = useRef(false);
  const receiptSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastConversationDeliverySyncRef = useRef<{ partnerEmail: string | null; at: number }>({
    partnerEmail: null,
    at: 0,
  });
  const flushConversationReceiptSyncRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    requestedReadReceiptIdsRef.current.clear();
    queuedReadReceiptIdsRef.current.clear();
    queuedConversationDeliverySyncRef.current = false;
    lastConversationDeliverySyncRef.current = {
      partnerEmail: selectedTeamMember?.email?.toLowerCase?.() ?? null,
      at: 0,
    };
  }, [selectedTeamMember?.id, selectedTeamMember?.email]);

  useEffect(() => {
    messages.forEach((msg: any) => {
      if (msg?.id && msg.read) {
        requestedReadReceiptIdsRef.current.add(String(msg.id));
      }
    });
  }, [messages]);

  const queueConversationReceiptSync = useCallback((options: {
    readMessageIds?: string[];
    requestConversationDelivered?: boolean;
  }) => {
    const readMessageIds = Array.isArray(options.readMessageIds) ? options.readMessageIds : [];
    readMessageIds.forEach((messageId) => {
      const normalized = String(messageId || '').trim();
      if (!normalized || requestedReadReceiptIdsRef.current.has(normalized)) {
        return;
      }
      queuedReadReceiptIdsRef.current.add(normalized);
    });

    if (options.requestConversationDelivered) {
      queuedConversationDeliverySyncRef.current = true;
    }

    if (receiptSyncTimeoutRef.current) {
      return;
    }

    receiptSyncTimeoutRef.current = setTimeout(() => {
      receiptSyncTimeoutRef.current = null;
      void flushConversationReceiptSyncRef.current();
    }, 120);
  }, []);

  const flushConversationReceiptSync = useCallback(async () => {
    if (receiptSyncRunningRef.current) {
      return;
    }

    const partnerEmail = selectedPartnerEmailRef.current;
    const userEmail = effectiveUserEmailRef.current;
    if (!partnerEmail || !userEmail || !isFocused || !isAppActive) {
      queuedReadReceiptIdsRef.current.clear();
      queuedConversationDeliverySyncRef.current = false;
      return;
    }

    const readMessageIds = Array.from(queuedReadReceiptIdsRef.current);
    const requestConversationDelivered = queuedConversationDeliverySyncRef.current;
    queuedReadReceiptIdsRef.current.clear();
    queuedConversationDeliverySyncRef.current = false;

    if (!readMessageIds.length && !requestConversationDelivered) {
      return;
    }

    receiptSyncRunningRef.current = true;
    readMessageIds.forEach((messageId) => requestedReadReceiptIdsRef.current.add(messageId));

    try {
      await chatService.syncConversationReceipts(partnerEmail, {
        readMessageIds,
        markConversationDelivered: requestConversationDelivered,
      });
    } catch (error) {
      readMessageIds.forEach((messageId) => requestedReadReceiptIdsRef.current.delete(messageId));
      if (requestConversationDelivered) {
        lastConversationDeliverySyncRef.current = { partnerEmail, at: 0 };
      }
      logger.debug('Failed to sync chat receipts', error);
    } finally {
      receiptSyncRunningRef.current = false;
      if (queuedReadReceiptIdsRef.current.size || queuedConversationDeliverySyncRef.current) {
        void flushConversationReceiptSyncRef.current();
      }
    }
  }, [isAppActive, isFocused]);

  useEffect(() => {
    flushConversationReceiptSyncRef.current = flushConversationReceiptSync;
  }, [flushConversationReceiptSync]);

  useEffect(() => {
    return () => {
      if (receiptSyncTimeoutRef.current) {
        clearTimeout(receiptSyncTimeoutRef.current);
        receiptSyncTimeoutRef.current = null;
      }
    };
  }, []);

  // Stable handler for FlashList viewability changes
  const onViewableItemsChangedRef = useRef(({ viewableItems }: any) => {
    const displayedMessages = displayedMessagesRef.current;
    if (!displayedMessages || displayedMessages.length === 0) return;
    const prefetch = prefetchUriRef.current;
    const resolveSticker = resolveNativeSafeStickerUrlRef.current;
    const resolveGif = resolveOptimizedGifUrlRef.current;
    const stickerMap = stickerUrlMapRef.current;
    const gifMap = gifUrlMapRef.current;
    const partnerEmail = selectedPartnerEmailRef.current;
    const userEmail = effectiveUserEmailRef.current;
    if (partnerEmail && userEmail && Array.isArray(viewableItems)) {
      const warmTargets: { remoteUrl: string; fileName?: string }[] = [];
      const visibleUnreadIncomingIds: string[] = [];
      viewableItems.forEach((viewable: any) => {
        const msg = viewable?.item;
        if (!msg) return;
        const addUrl = (url?: string, fileName?: string) => {
          if (!url) return;
          if (url.startsWith('file://')) return;
          warmTargets.push({ remoteUrl: url, fileName });
        };
        if (Array.isArray(msg.attachments)) {
          msg.attachments.forEach((att: any) => addUrl(att.url, att.fileName));
        }
        if (
          msg.id &&
          !msg.deleted &&
          String(msg.sender || '').toLowerCase() === partnerEmail &&
          String(msg.recipientId || '').toLowerCase() === userEmail.toLowerCase() &&
          !msg.read
        ) {
          visibleUnreadIncomingIds.push(String(msg.id));
        }
      });
      if (warmTargets.length) {
        Promise.allSettled(
          warmTargets.slice(0, 5).map(({ remoteUrl, fileName }) =>
            chatCacheService.getMediaForDownload(remoteUrl, fileName, undefined, 'low').catch(() => undefined)
          )
        ).catch(() => undefined);
      }

      const normalizedPartner = selectedPartnerEmailRef.current;
      const now = Date.now();
      const requestConversationDelivered =
        Boolean(normalizedPartner) &&
        (lastConversationDeliverySyncRef.current.partnerEmail !== normalizedPartner ||
          now - lastConversationDeliverySyncRef.current.at >= 15000);

      if (requestConversationDelivered && normalizedPartner) {
        lastConversationDeliverySyncRef.current = {
          partnerEmail: normalizedPartner,
          at: now,
        };
      }

      if (visibleUnreadIncomingIds.length || requestConversationDelivered) {
        queueConversationReceiptSync({
          readMessageIds: visibleUnreadIncomingIds,
          requestConversationDelivered,
        });
      }
    }

    // Prefetch nearby media (stickers/GIFs/images) for smoother scrolling
    const indices = (viewableItems || [])
      .map((v: any) => v.index as number)
      .filter((i: number) => typeof i === 'number') as number[];
    const candidates = new Set<number>();
    indices.forEach(i => {
      for (let d = -2; d <= 4; d++) {
        const idx = i + d;
        if (idx >= 0 && idx < displayedMessages.length) candidates.add(idx);
      }
    });
    candidates.forEach((idx) => {
      const m = displayedMessages[idx];
      if (!m) return;
      // Stickers
      if (m.sticker?.url) {
        const original = m.sticker.url as string;
        const display = Platform.OS === 'web' ? original : (stickerMap.get(original) || original);
        prefetch(display);
        if (Platform.OS !== 'web') {
          resolveSticker(original).then((alt: string | null) => { if (alt) prefetch(alt); });
        }
      }
      // GIFs
      if (m.gif?.url) {
        const original = m.gif.url as string;
        const display = Platform.OS === 'web' ? original : (gifMap.get(original) || original);
        prefetch(display);
        if (Platform.OS !== 'web') {
          resolveGif(original).then((alt: string) => { if (alt) prefetch(alt); });
        }
      }
      // Image attachments
      if (m.attachments && Array.isArray(m.attachments)) {
        m.attachments.forEach((att: any) => {
          if (att?.url && isImageFile(att.fileType, att.fileName)) prefetch(att.url);
        });
      }
    });

    if (Array.isArray(viewableItems) && viewableItems.length) {

    const unreadId = unreadSeparatorMessageIdRef.current;
    if (unreadId) {
      const isUnreadVisible = Array.isArray(viewableItems) && viewableItems.some((viewable: any) => {
        const itemId = viewable?.item?.id;
        return itemId && itemId === unreadId;
      });

      if (isUnreadVisible) {
        hasAcknowledgedUnreadRef.current = true;
        if (incomingUnreadCountRef.current === 0) {
          scheduleUnreadSeparatorDismissRef.current?.(350);
        }
      }
    }
      let topEntry: any = null;
      let bottomEntry: any = null;
      for (const entry of viewableItems) {
        if (!entry) continue;
        const idx = typeof entry.index === 'number' ? entry.index : null;
        if (idx === null || idx < 0) continue;
        if (!topEntry || idx < topEntry.index) {
          topEntry = entry;
        }
        if (!bottomEntry || idx > bottomEntry.index) {
          bottomEntry = entry;
        }
      }

      if (topEntry?.item?.id != null) {
        const topIndex = typeof topEntry.index === 'number' ? topEntry.index : 0;
        const topId = String(topEntry.item.id);
        topVisibleMessageRef.current = {
          id: topId,
          index: topIndex,
        };

        const anchorBlocked = shouldUseManualAnchorPreservation && Boolean(pendingPrependAnchorRef.current);
        if (topIndex <= TOP_AUTO_LOAD_THRESHOLD) {
          if (topId !== autoLoadAnchorRef.current && !anchorBlocked) {
            autoLoadAnchorRef.current = topId;
            requestOlderMessagesRef.current?.('auto');
          }
        } else if (topIndex > TOP_AUTO_LOAD_THRESHOLD + 1) {
          autoLoadAnchorRef.current = null;
        }

        if (topIndex <= TOP_PREFETCH_THRESHOLD) {
          warmNextPageRef.current?.();
        }
      } else {
        autoLoadAnchorRef.current = null;
      }

      if (bottomEntry?.index != null) {
        const bottomIndex = typeof bottomEntry.index === 'number' ? bottomEntry.index : displayedMessages.length - 1;
        if (bottomIndex >= displayedMessages.length - 1) {
          isAtBottomRef.current = true;
        }
      }
    }
  });

  // Subscribe to pinned chats for the current user
  useEffect(() => {
    const currentEmail = (user?.email || '').toLowerCase();
    if (!currentEmail) return;
    const unsubscribe = chatPreferencesService.onPinnedChatsChange(currentEmail, (map) => {
      setPinnedChats(map || {});
    });
    return () => {
      try { unsubscribe && (unsubscribe as any)(); } catch {}
    };
  }, [user?.email]);

  // Stable viewability config
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 50 });

  useEffect(() => {
    let cancelled = false;
    chatCacheService
      .getTelemetryContext()
      .then((profile) => {
        if (!cancelled) {
          concurrencyProfileRef.current = profile;
        }
      })
      .catch((error) => {
        logger.warn('chat.render.trace.profileBootstrapError', { error });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  
  const BASE_COMPOSER_HEIGHT = 40;

  const bottomVisibilityPadding = useMemo(() => {
    const composerHeight = Math.max(inputHeight || BASE_COMPOSER_HEIGHT, BASE_COMPOSER_HEIGHT);
  const basePadding = DEFAULT_BOTTOM_VISIBILITY_BUFFER + 12; // small buffer to float above composer
    const extraComposerHeight = Math.max(0, composerHeight - BASE_COMPOSER_HEIGHT);
    const adaptiveExtra = Math.min(extraComposerHeight, 28);
    return basePadding + adaptiveExtra;
  }, [inputHeight, DEFAULT_BOTTOM_VISIBILITY_BUFFER]);
  const maintainVisibleContentPositionConfig = useMemo(() => {
    if (Platform.OS === 'web') {
      return undefined;
    }
    return {
      minIndexForVisible: 0,
      autoscrollToTopThreshold: bottomVisibilityPadding + 48,
    } as const;
  }, [bottomVisibilityPadding]);

  const stopAnchorStabilization = useCallback(() => {
    if (stabilizationTimeoutRef.current) {
      clearTimeout(stabilizationTimeoutRef.current);
      stabilizationTimeoutRef.current = null;
    }
    anchoredTargetRef.current = null;
    setIsInitialAnchorSettled(true);
  }, [setIsInitialAnchorSettled]);
  
  const MAX_PREPEND_ANCHOR_ATTEMPTS = 12;

  const restorePrependAnchorIfNeeded = useCallback(() => {
    if (!shouldUseManualAnchorPreservation) {
      return;
    }
    const anchor = pendingPrependAnchorRef.current;
    if (!anchor) {
      return;
    }
    const positions = messagePositionsRef.current || {};
    const target = positions[anchor.id];
    if (!target) {
      if (anchor.attempts >= MAX_PREPEND_ANCHOR_ATTEMPTS) {
        pendingPrependAnchorRef.current = null;

        const displayed = displayedMessagesRef.current;
        if (Array.isArray(displayed) && displayed.length) {
          const fallbackIndex = displayed.findIndex((m: any) => m && String(m.id) === anchor.id);
          if (fallbackIndex >= 0) {
            try {
              (flatListRef.current as any)?.scrollToIndex?.({
                index: fallbackIndex,
                animated: false,
                viewPosition: 0,
                viewOffset: Math.max(0, anchor.offset),
              });
            } catch {}
          }
        }
        return;
      }
      pendingPrependAnchorRef.current = { ...anchor, attempts: anchor.attempts + 1 };
      setTimeout(() => restorePrependAnchorIfNeeded(), 50);
      return;
    }

    const desiredOffset = Math.max(0, target.y + anchor.offset);
    try {
      (flatListRef.current as any)?.scrollToOffset?.({ offset: desiredOffset, animated: false });
      pendingPrependAnchorRef.current = null;
    } catch {
      if (anchor.attempts >= MAX_PREPEND_ANCHOR_ATTEMPTS) {
        pendingPrependAnchorRef.current = null;
        return;
      }
      pendingPrependAnchorRef.current = { ...anchor, attempts: anchor.attempts + 1 };
      setTimeout(() => restorePrependAnchorIfNeeded(), 50);
    }
  }, [shouldUseManualAnchorPreservation]);

  const capturePrependAnchor = useCallback((currentOffset: number) => {
    if (!shouldUseManualAnchorPreservation) return;
    if (pendingPrependAnchorRef.current) return;
    const topVisible = topVisibleMessageRef.current;
    if (!topVisible?.id) return;
    const topPos = messagePositionsRef.current[topVisible.id];
    const offset = Math.max(0, currentOffset - (topPos?.y ?? 0));
    pendingPrependAnchorRef.current = { id: topVisible.id, offset, attempts: 0 };
  }, [shouldUseManualAnchorPreservation]);
  const requestOlderMessages = useCallback(
    async (reason: 'auto' | 'manual' = 'manual') => {
      const alreadyAtStart = reachedConversationStartRef.current;
      if (loadOlderLockRef.current || loadingMore) {
        return;
      }

      if (alreadyAtStart) {
        if (reason === 'manual') {
          Toast.show({
            type: 'info',
            text1: 'No older messages',
            text2: 'You have reached the beginning of this chat history.',
            position: 'top',
          });
        }
        return;
      }

      const hasAttemptedBefore = loadOlderAttemptsRef.current > 0;

      if (!hasMore && reason === 'auto' && hasAttemptedBefore) {
        return;
      }
      if (typeof loadMore !== 'function') {
        return;
      }

      loadOlderAttemptsRef.current += 1;
      loadOlderLockRef.current = true;
      let added = false;
      try {
        const currentOffset = lastScrollOffsetRef.current || 0;
        capturePrependAnchor(currentOffset);
      } catch {}

      try {
        const loadOptions = reason === 'manual' ? { aggressive: true, force: true } : undefined;
        added = await loadMore(loadOptions);

        if (!added && reason === 'manual' && hasMoreRef.current) {
          added = await loadMore({ aggressive: true, force: true });
        }

        if (!added && reason === 'manual' && hasMoreRef.current) {
          Toast.show({
            type: 'info',
            text1: 'Syncing older messages…',
            text2: 'Fetching a fuller history from the server.',
            position: 'top',
          });
        }
      } catch (error) {
        logger.warn('chat.pagination.loadOlder.failed', { error, reason });
        pendingPrependAnchorRef.current = null;
      } finally {
        if (reason === 'auto' && !added) {
          autoLoadAnchorRef.current = null;
        }
        loadOlderLockRef.current = false;
      }
    },
    [hasMore, loadingMore, loadMore, capturePrependAnchor]
  );

  useEffect(() => {
    requestOlderMessagesRef.current = requestOlderMessages;
  }, [requestOlderMessages]);

  useEffect(() => {
    if (loadingMore) {
      return;
    }

    if (hasMore) {
      reachedConversationStartRef.current = false;
      setReachedConversationStart(false);
      return;
    }

    if (loadOlderAttemptsRef.current > 0) {
      reachedConversationStartRef.current = true;
      setReachedConversationStart(true);
    }
  }, [hasMore, loadingMore]);

  useEffect(() => {
    loadOlderAttemptsRef.current = 0;
    reachedConversationStartRef.current = false;
    setReachedConversationStart(false);
    autoLoadAnchorRef.current = null;
  }, [selectedTeamMember?.id]);

  const scheduleUnreadSeparatorDismiss = useCallback((delay: number = 400) => {
    if (!showUnreadSeparatorRef.current) {
      return;
    }

    if (unreadSeparatorDismissTimeoutRef.current) {
      clearTimeout(unreadSeparatorDismissTimeoutRef.current);
    }

    unreadSeparatorDismissTimeoutRef.current = setTimeout(() => {
      setShowUnreadSeparator(false);
      setUnreadSeparatorMessageId(null);
      unreadSeparatorDismissTimeoutRef.current = null;
    }, Math.max(0, delay));
  }, []);

  const scheduleUnreadSeparatorDismissRef = useRef(scheduleUnreadSeparatorDismiss);
  useEffect(() => {
    scheduleUnreadSeparatorDismissRef.current = scheduleUnreadSeparatorDismiss;
  }, [scheduleUnreadSeparatorDismiss]);

  // Helper function to get the appropriate profile picture URL for a team member
  // Centralized in lib/profileImage to keep behavior consistent across the app
  const getProfilePictureURL = getProfileImageUrl;

  // Rich content handling functions for keyboard stickers
  const detectRichContent = (text: string) => {
    // Detect if the text contains high-quality emojis or stickers
    // This includes extended Unicode emojis, compound emojis, and special characters
    const complexEmojiPattern = /[\u{1F600}-\u{1F64F}][\u{FE0F}]?[\u{1F3FB}-\u{1F3FF}]?|[\u{1F300}-\u{1F5FF}][\u{FE0F}]?|[\u{1F680}-\u{1F6FF}][\u{FE0F}]?|[\u{1F700}-\u{1F77F}]|[\u{1F780}-\u{1F7FF}]|[\u{1F800}-\u{1F8FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{2600}-\u{26FF}][\u{FE0F}]?|[\u{2700}-\u{27BF}][\u{FE0F}]?/gu;
    
    const emojiMatches = text.match(complexEmojiPattern) || [];
    
    // Check for compound emojis (multiple Unicode points forming one visual emoji)
    const compoundEmojiPattern = /[\u{1F3F4}][\u{E0067}][\u{E0062}][\u{E0065}][\u{E006E}][\u{E0067}][\u{E007F}]|[\u{1F468}][\u{200D}][\u{1F469}][\u{200D}][\u{1F467}][\u{200D}][\u{1F466}]|[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]/gu;
    const compoundMatches = text.match(compoundEmojiPattern) || [];
    
    // Check for skin tone variations
    const skinTonePattern = /[\u{1F3FB}-\u{1F3FF}]/gu;
    const skinToneMatches = text.match(skinTonePattern) || [];
    
    return {
      hasRichEmojis: emojiMatches.length > 0 || compoundMatches.length > 0 || skinToneMatches.length > 0,
      emojiCount: emojiMatches.length + compoundMatches.length,
      isEmojiOnly: text.trim().replace(complexEmojiPattern, '').replace(compoundEmojiPattern, '').trim() === '',
      emojis: [...emojiMatches, ...compoundMatches]
    };
  };

  const handleRichTextInput = async (inputText: string) => {
    const richContent = detectRichContent(inputText);
    // Compute remainder after removing emojis and common joiners/variation selectors
    const complexEmojiPattern = /[\u{1F600}-\u{1F64F}][\u{FE0F}]?[\u{1F3FB}-\u{1F3FF}]?|[\u{1F300}-\u{1F5FF}][\u{FE0F}]?|[\u{1F680}-\u{1F6FF}][\u{FE0F}]?|[\u{1F700}-\u{1F77F}]|[\u{1F780}-\u{1F7FF}]|[\u{1F800}-\u{1F8FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{2600}-\u{26FF}][\u{FE0F}]?|[\u{2700}-\u{27BF}][\u{FE0F}]?/gu;
    const compoundEmojiPattern = /[\u{1F3F4}][\u{E0067}][\u{E0062}][\u{E0065}][\u{E006E}][\u{E0067}][\u{E007F}]|[\u{1F468}][\u{200D}][\u{1F469}][\u{200D}][\u{1F467}][\u{200D}][\u{1F466}]|[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]/gu;
    const remainder = inputText
      .trim()
      .replace(complexEmojiPattern, '')
      .replace(compoundEmojiPattern, '')
      .replace(/[\u200D\uFE0F\s]/g, '') // strip ZWJ, VS-16, whitespace
      .trim();

    const isEmojiMostly = (richContent.emojiCount >= 1 && richContent.emojiCount <= 5) && (remainder.length === 0 || (remainder.length === 1 && /[A-Za-z]/.test(remainder)));

    if (isEmojiMostly) {
      // Only emojis (or emojis plus one stray character) → convert to sticker
      const emojiSticker = {
        url: '',
        name: richContent.emojis.join(''), // exclude the stray char from display
        pack: 'system',
        width: 100,
        height: 100,
        isEmoji: true,
        original: inputText.trim()
      };

      return {
        type: 'sticker' as const,
        content: emojiSticker,
        originalText: inputText
      };
    }

    return {
      type: 'text' as const,
      content: inputText,
      originalText: inputText
    };
  };

  // Handle emoji reactions with Firebase Realtime Database integration
  const handleReaction = async (messageId: string, reactionType: string) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!effectiveUser?.email || !normalizedMessageId) {
      logger.warn('Missing required data for reaction:', { 
        userEmail: !!effectiveUser?.email, 
        messageId: !!normalizedMessageId 
      });
      return;
    }
    
    const userEmail = effectiveUser.email;
    
    // Check if this is a special message
    const message = messages.find(m => normalizeMessageId(m?.id) === normalizedMessageId);
    const isSpecialMessage = message?.isSpecial === true;
    
    logger.debug('🎯 Reaction Debug Info:', {
      messageId: normalizedMessageId,
      messageFound: !!message,
      isSpecial: message?.isSpecial,
      isSpecialMessage,
      reactionType,
      userEmail
    });
    
    try {
      // Update local state immediately for responsive UI
      reactionOptimisticUntilRef.current.set(normalizedMessageId, Date.now() + 1500);
      setLocalMessageReactions(prevReactions => {
        const newReactions = new Map(prevReactions);
        const baseReaction = newReactions.get(normalizedMessageId) || {};
        const messageReaction: { [key: string]: Set<string> } = { ...baseReaction };
        
        if (isSpecialMessage) {
          // For special messages: handle multiple reactions per user
          logger.debug('🎯 Special message reaction handling:', {
            messageId,
            reactionType,
            userEmail,
            currentReactions: Object.keys(messageReaction),
            hasThisReaction: messageReaction[reactionType] && 
                            (messageReaction[reactionType] as Set<string>).has(userEmail)
          });
          
          // Check if user already has this specific reaction
          const existingSet = messageReaction[reactionType];
          const hasThisReaction = existingSet && (existingSet as Set<string>).has(userEmail);
          
          if (hasThisReaction) {
            // Remove this specific reaction (toggle off)
            logger.debug('🔄 Removing specific reaction for special message');
            const nextSet = new Set(existingSet as Set<string>);
            nextSet.delete(userEmail);
            if (nextSet.size === 0) {
              delete messageReaction[reactionType];
            } else {
              messageReaction[reactionType] = nextSet;
            }
          } else {
            // Add this reaction (don't remove others)
            logger.debug('✅ Adding new reaction for special message');
            const nextSet = new Set((existingSet as Set<string>) ?? []);
            nextSet.add(userEmail);
            messageReaction[reactionType] = nextSet;
          }
        } else {
          // For regular messages: only one reaction per user (existing behavior)
          // Find if user has already reacted with any emoji for this message
          let currentUserReaction = null;
          for (const [emoji, users] of Object.entries(messageReaction)) {
            if ((users as Set<string>).has(userEmail)) {
              currentUserReaction = emoji;
              break;
            }
          }
          
          // If user is selecting the same reaction they already have, remove it
          if (currentUserReaction === reactionType) {
            const existingSet = messageReaction[reactionType] as Set<string> | undefined;
            const nextSet = new Set(existingSet ?? []);
            nextSet.delete(userEmail);
            if (nextSet.size === 0) {
              delete messageReaction[reactionType];
            } else {
              messageReaction[reactionType] = nextSet;
            }
          } else {
            // Remove user's previous reaction if they had one
            if (currentUserReaction) {
              const previousSet = messageReaction[currentUserReaction] as Set<string> | undefined;
              const nextPrevSet = new Set(previousSet ?? []);
              nextPrevSet.delete(userEmail);
              if (nextPrevSet.size === 0) {
                delete messageReaction[currentUserReaction];
              } else {
                messageReaction[currentUserReaction] = nextPrevSet;
              }
            }
            
            // Add new reaction
            const nextSet = new Set((messageReaction[reactionType] as Set<string>) ?? []);
            nextSet.add(userEmail);
            messageReaction[reactionType] = nextSet;
          }
        }
        
        if (Object.keys(messageReaction).length === 0) {
          // Keep an explicit empty entry during optimistic window so removals stay visible.
          newReactions.set(normalizedMessageId, {});
        } else {
          newReactions.set(normalizedMessageId, messageReaction);
        }
        
        return newReactions;
      });

      // Save to Firebase Realtime Database
      const updatedUsers = await chatService.toggleMessageReaction(normalizedMessageId, reactionType, userEmail);
      
  // Close emoji picker after selection
  setEmojiPickerVisible(false);
  setSelectedMessageForReaction(null);
  setSelectedMessageForAction(null);
      
      logger.debug('✅ Reaction updated successfully:', { 
        messageId: normalizedMessageId, 
        reactionType, 
        users: updatedUsers 
      });
      
      const hasReacted = updatedUsers.includes(userEmail);
      
      // Show different toast messages for special vs regular messages
      if (isSpecialMessage) {
        Toast.show({
          type: 'success',
          text1: hasReacted ? 'Reaction Added' : 'Reaction Removed',
          text2: hasReacted 
            ? `Added ${getEmojiName(reactionType)} to special message` 
            : `Removed ${getEmojiName(reactionType)} from special message`,
          position: 'top',
          visibilityTime: 1500,
        });
      } else {
        Toast.show({
          type: 'success',
          text1: hasReacted ? 'Reaction Set' : 'Reaction Removed',
          text2: hasReacted 
            ? `You reacted with ${getEmojiName(reactionType)}` 
            : `You removed your ${getEmojiName(reactionType)} reaction`,
          position: 'top',
          visibilityTime: 1500,
        });
      }
    } catch (error) {
      logger.error('❌ Error handling reaction:', error);
      
      // Revert local state on error - this is complex because we need to restore the previous state
      // For simplicity, we'll just refresh the reactions from the server
      // In a production app, you might want to implement more sophisticated rollback logic
      setLocalMessageReactions(prevReactions => prevReactions);
      
      Toast.show({
        type: 'error',
        text1: 'Reaction Failed',
        text2: 'Could not save your reaction. Please try again.',
        position: 'top',
      });
    }
  };

  // Get emoji name for display
  const getEmojiName = (emoji: string): string => {
    const emojiNames: { [key: string]: string } = {
      '❤️': 'heart',
      '😂': 'laugh',
      '😮': 'wow',
      '😢': 'sad',
      '😡': 'angry',
      '👍': 'like',
      '👎': 'dislike',
      '🔥': 'fire',
      '💯': 'hundred',
      '✨': 'sparkles',
      'heart': 'heart',
      'star': 'star',
      'smile': 'smile'
    };
    return emojiNames[emoji] || emoji;
  };

  // Handle long press on message to show emoji picker
  const handleMessageLongPress = (messageId: string, event: any) => {
    const { pageX, pageY } = event.nativeEvent;
    const normalizedMessageId = normalizeMessageId(messageId);
    const targetMessage = (messages || []).find((m: any) => m && normalizeMessageId(m.id) === normalizedMessageId) || null;
    setSelectedMessageForReaction(normalizedMessageId);
    setSelectedMessageForAction(targetMessage);
    setReactionPickerPosition({ x: pageX, y: pageY });
    setEmojiPickerVisible(true);
  };

  const closeEmojiPicker = useCallback(() => {
    setEmojiPickerVisible(false);
    setSelectedMessageForReaction(null);
    setSelectedMessageForAction(null);
  }, []);

  // Quick reaction with double tap
  const handleQuickReaction = async (messageId: string) => {
    await handleReaction(normalizeMessageId(messageId), '❤️');
  };

  // Get reaction status for a message
  const getReactionStatus = (
    messageId: string,
    reactionType: string,
    reactionsOverride?: { [key: string]: Set<string> }
  ) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId || !reactionType) return { count: 0, hasUserReacted: false, users: [] };
    const reactions = reactionsOverride ?? messageReactionsRef.current.get(normalizedMessageId);
    if (!reactions || !reactions[reactionType]) return { count: 0, hasUserReacted: false, users: [] };
    
    const reactionSet = reactions[reactionType];
    if (!reactionSet) return { count: 0, hasUserReacted: false, users: [] };
    
    const users = Array.from(reactionSet);
    const hasUserReacted = effectiveUser?.email ? reactionSet.has(effectiveUser.email) : false;
    
    return {
      count: users.length,
      hasUserReacted,
      users
    };
  };

  // Get the user's current reaction(s) for a message
  const getUserCurrentReaction = (messageId: string, reactionsOverride?: { [key: string]: Set<string> }) => {
    if (!effectiveUser?.email) return null;
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) return null;

    const message = messages.find(m => normalizeMessageId(m?.id) === normalizedMessageId);
    const isSpecialMessage = message?.isSpecial === true;
    const reactions = reactionsOverride ?? messageReactionsRef.current.get(normalizedMessageId);
    if (!reactions) return null;
    
    // For special messages, return array of all user's reactions
    if (isSpecialMessage) {
      const userReactions: string[] = [];
      for (const [reactionType, users] of Object.entries(reactions)) {
        if ((users as Set<string>).has(effectiveUser.email)) {
          userReactions.push(reactionType);
        }
      }
      return userReactions.length > 0 ? userReactions : null;
    }
    
    // For regular messages, return single reaction (existing behavior)
    for (const [reactionType, users] of Object.entries(reactions)) {
      if ((users as Set<string>).has(effectiveUser.email)) {
        return reactionType;
      }
    }
    
    return null;
  };

  // Check if both sender and receiver reacted (for glow effect)
  const shouldGlow = (
    messageId: string,
    reactionType: string,
    reactionsOverride?: { [key: string]: Set<string> }
  ) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId || !reactionType || !selectedTeamMember) return false;
    
    const message = messages.find(m => m && normalizeMessageId(m.id) === normalizedMessageId);
    if (!message) return false;
    
    const reactions = reactionsOverride ?? messageReactionsRef.current.get(normalizedMessageId);
    if (!reactions || !reactions[reactionType]) return false;
    
    const reactionSet = reactions[reactionType];
    if (!reactionSet) return false;
    
    const senderEmail = (message.sender || '').toLowerCase();
    const recipientEmail = (selectedTeamMember.email || '').toLowerCase();
    
    // Check if both sender and recipient have reacted
    return reactionSet.has(senderEmail) && reactionSet.has(recipientEmail);
  };

  // Get all reactions for a message
  const getAllReactions = (messageId: string, reactionsOverride?: { [key: string]: Set<string> }) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) return [];
    const reactions = reactionsOverride ?? messageReactionsRef.current.get(normalizedMessageId);
    if (!reactions) return [];
    
    return Object.entries(reactions)
      .filter(([_, users]) => users && users.size > 0)
      .map(([emoji, users]) => ({
        emoji,
        count: users.size,
        users: Array.from(users),
        hasUserReacted: effectiveUser?.email ? users.has(effectiveUser.email) : false
      }))
      .sort((a, b) => b.count - a.count);
  };

  const isOwnMessageEmail = useCallback(
    (msg?: any) => {
      if (!msg) return false;
      if (!effectiveUserEmail) return false;
      const sender = typeof msg.sender === 'string' ? msg.sender.toLowerCase() : '';
      return sender === effectiveUserEmail.toLowerCase();
    },
    [effectiveUserEmail]
  );

  const canEditMessage = useCallback(
    (msg: any) => {
      if (!msg || !msg.id) return false;
      if (!isOwnMessageEmail(msg)) return false;
      if (msg.deleted) return false;
      if (msg.isSpecial) return false;
      if (msg.gif || msg.sticker) return false;
      if (Array.isArray(msg.attachments) && msg.attachments.length > 0) return false;
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      return text.length > 0;
    },
    [isOwnMessageEmail]
  );

  const canDeleteMessage = useCallback(
    (msg: any) => {
      if (!msg || !msg.id) return false;
      if (!isOwnMessageEmail(msg)) return false;
      return !msg.deleted;
    },
    [isOwnMessageEmail]
  );

  const isMessageActionPending = useCallback(
    (messageId?: string | null) => {
      if (!messageId) return false;
      return pendingMessageActions.has(messageId);
    },
    [pendingMessageActions]
  );

  const markMessageActionPending = useCallback((messageId: string) => {
    setPendingMessageActions((prev) => {
      const next = new Set(prev);
      next.add(messageId);
      return next;
    });
  }, []);

  const clearMessageActionPending = useCallback((messageId: string) => {
    setPendingMessageActions((prev) => {
      const next = new Set(prev);
      next.delete(messageId);
      return next;
    });
  }, []);
  
  // Unread messages separator state management
  const [showUnreadSeparator, setShowUnreadSeparator] = useState(false);
  const [unreadSeparatorMessageId, setUnreadSeparatorMessageId] = useState<string | null>(null);
  const unreadSeparatorDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unreadSeparatorMessageIdRef = useRef<string | null>(null);
  const showUnreadSeparatorRef = useRef(false);
  const hasAcknowledgedUnreadRef = useRef(false);
  const incomingUnreadCountRef = useRef(0);
  // New messages divider when user is away from bottom
  const [showNewDivider, setShowNewDivider] = useState(false);
  const [newDividerMessageId, setNewDividerMessageId] = useState<string | null>(null);
  const [chatWasActiveWhenMessageArrived, setChatWasActiveWhenMessageArrived] = useState(false);
  const hasAnchoredInitialScrollRef = useRef(false); // ensures we only snap to bottom once per chat load
  const pendingInitialAnchorRef = useRef(false); // tracks when we still need to align to the latest message
  const scrollToUnreadAttemptedRef = useRef(false); // tracks if we attempted to scroll to first unread
  const isAutoScrollingRef = useRef(false);
  const onScrollFailAttemptsRef = useRef(0); // track scrollToIndex failures (esp. on web)



  // Get user directly from authService as backup
  useEffect(() => {
    const getCurrentUser = () => {
      const authUser = authService.getCurrentUser();
      // Only update if user actually changed to prevent unnecessary re-renders
      setCurrentUser((prevUser: any) => {
        if (!prevUser && !authUser) return prevUser;
        if (!prevUser || !authUser) return authUser;
        if (prevUser.email !== authUser.email || prevUser.isAuthorized !== authUser.isAuthorized) {
          return authUser;
        }
        return prevUser;
      });
    };
    
    getCurrentUser();
    // Check every 5 seconds instead of 2 to reduce frequency
    const interval = setInterval(getCurrentUser, 5000);
    
    return () => clearInterval(interval);
  }, []);

  // Listen for screen dimension changes
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setScreenData(window);
    });
    
    return () => subscription?.remove();
  }, []);

  const firstUnreadMessageId = useMemo(() => {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    if (!effectiveUser?.email || !selectedTeamMember?.email) return null;
    const userEmail = effectiveUser.email.toLowerCase();
    const senderEmail = selectedTeamMember.email.toLowerCase();
    const unread = messages.filter((msg: any) =>
      msg?.sender?.toLowerCase?.() === senderEmail &&
      msg?.recipientId?.toLowerCase?.() === userEmail &&
      !msg?.read &&
      !msg?.deleted &&
      msg?.id
    );
    if (!unread.length) return null;
    return unread[0]?.id ?? null;
  }, [messages, effectiveUser?.email, selectedTeamMember?.email]);

  const incomingUnreadCount = useMemo(() => {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    if (!effectiveUser?.email || !selectedTeamMember?.email) return 0;
    const userEmail = effectiveUser.email.toLowerCase();
    const senderEmail = selectedTeamMember.email.toLowerCase();

    return messages.reduce((count, msg: any) => {
      if (
        msg?.sender?.toLowerCase?.() === senderEmail &&
        msg?.recipientId?.toLowerCase?.() === userEmail &&
        !msg?.read &&
        !msg?.deleted
      ) {
        return count + 1;
      }
      return count;
    }, 0);
  }, [messages, effectiveUser?.email, selectedTeamMember?.email]);

  useEffect(() => {
    unreadSeparatorMessageIdRef.current = unreadSeparatorMessageId;
  }, [unreadSeparatorMessageId]);

  useEffect(() => {
    showUnreadSeparatorRef.current = showUnreadSeparator;
  }, [showUnreadSeparator]);

  useEffect(() => {
    incomingUnreadCountRef.current = incomingUnreadCount;
  }, [incomingUnreadCount]);

  useEffect(() => {
    const partnerEmail = selectedTeamMember?.email?.toLowerCase?.();
    if (!partnerEmail) {
      return;
    }

    setConversationSummaries((prev) => {
      return reconcileConversationUnreadCount(prev, partnerEmail, incomingUnreadCount, {
        isFocused,
        isAppActive,
        loading,
      });
    });
  }, [incomingUnreadCount, selectedTeamMember?.email, setConversationSummaries, isFocused, isAppActive, loading]);

  useEffect(() => () => {
    if (unreadSeparatorDismissTimeoutRef.current) {
      clearTimeout(unreadSeparatorDismissTimeoutRef.current);
    }
  }, []);

  const estimatedItemSize = useMemo(() => {
    if (displayedMessages.length === 0) return 112;

    const rawHeights = displayedMessages.map((message: any) => {
      const id = String(message.id);
      const pos = messagePositions[id];
      const height = pos?.height;
      return typeof height === 'number' && height > 0 ? height : 0;
    });

    const positiveHeights = rawHeights.filter((value) => value > 0).sort((a, b) => a - b);
    if (!positiveHeights.length) {
      return 128;
    }
    const median = positiveHeights.length % 2
      ? positiveHeights[(positiveHeights.length - 1) / 2]
      : Math.round((positiveHeights[positiveHeights.length / 2 - 1] + positiveHeights[positiveHeights.length / 2]) / 2);
    const percentile75 = positiveHeights[Math.min(positiveHeights.length - 1, Math.floor(positiveHeights.length * 0.75))];
    const estimate = Math.max(median, percentile75);
    return Math.max(72, Math.min(280, estimate));
  }, [displayedMessages, messagePositions]);

  const estimatedListSize = useMemo(() => {
    return {
      height: Math.max(600, Math.round(screenData.height || Dimensions.get('window').height || 800)),
      width: Math.max(360, Math.round(screenData.width || Dimensions.get('window').width || 400)),
    };
  }, [screenData.height, screenData.width]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }

    const pending = notificationService.getPendingChatNavigationTarget();
    if (!pending) {
      return;
    }

    const normalize = (value?: string | null) =>
      typeof value === 'string' ? value.trim().toLowerCase() : undefined;

    const ownEmail = normalize(effectiveUser?.email ?? null);
    let targetEmail = normalize(pending.senderEmail ?? null);

    if (!targetEmail && typeof pending.chatId === 'string') {
      const parts = pending.chatId.split('_').map(part => part.trim().toLowerCase());
      if (parts.length > 0) {
        targetEmail = parts.find(part => part && part !== ownEmail) || parts[0];
      }
    }

    if (!targetEmail) {
      notificationService.consumePendingChatNavigationTarget();
      return;
    }

    const matchInTeamMembers = teamMembers.find(member =>
      normalize(member.email) === targetEmail
    );

    const matchInChatInfo = matchInTeamMembers
      ? matchInTeamMembers
      : teamMembersWithChatInfo.find((member: any) =>
          normalize(member.email) === targetEmail
        );

    if (matchInChatInfo) {
      setSelectedTeamMember(matchInChatInfo as TeamMember);
      notificationService.consumePendingChatNavigationTarget();
    }
  }, [isFocused, teamMembers, teamMembersWithChatInfo, effectiveUser?.email]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }

    const targetEmail = typeof searchParams.senderEmail === 'string'
      ? searchParams.senderEmail.trim().toLowerCase()
      : '';

    if (!targetEmail) {
      return;
    }

    const normalize = (value?: string | null) =>
      typeof value === 'string' ? value.trim().toLowerCase() : undefined;

    const match = teamMembers.find(member => normalize(member.email) === targetEmail)
      || teamMembersWithChatInfo.find((member: any) => normalize(member.email) === targetEmail);

    if (!match) {
      return;
    }

    setSelectedTeamMember(match as TeamMember);
    router.replace('/(tabs)/chat');
  }, [isFocused, router, searchParams.senderEmail, teamMembers, teamMembersWithChatInfo]);

  // Wrapper for notifications to keep previous calls working
  const sendMessageNotification = useCallback(
    async (
      text: string,
      isSpecial: boolean = false,
      sticker?: { url: string; name?: string },
      gif?: { url: string; thumbnailUrl?: string }
    ) => {
      try {
        const senderEmail = effectiveUser?.email;
        const recipientEmail = selectedTeamMember?.email;
        if (!senderEmail || !recipientEmail) return;
        const msg = {
          id: undefined,
          text,
          sender: senderEmail,
          recipientId: recipientEmail,
          timestamp: new Date().toISOString(),
          isSpecial,
          sticker: sticker ? { url: sticker.url, name: sticker.name || 'Sticker' } : undefined,
          gif: gif ? { url: gif.url, thumbnailUrl: gif.thumbnailUrl } : undefined,
          delivered: false,
          read: false,
        } as any;
        await notificationService.sendSmartChatNotification(
          msg,
          recipientEmail,
          senderEmail,
          { currentChatPartner: recipientEmail }
        );
      } catch (e) {
        // Non-fatal
        logger.warn('sendMessageNotification failed:', e);
      }
    },
    [selectedTeamMember?.email, effectiveUser?.email]
  );

  const activeChatSyncRef = useRef<number>(0);

  const syncActiveChatPartnerState = useCallback(
    (force: boolean = false) => {
      const partnerEmail = selectedTeamMember?.email ?? null;
      const partnerId = selectedTeamMember?.id ?? null;
      const partnerName = selectedTeamMember?.name ?? null;
      const isActive = Boolean(partnerEmail && isFocused && isAppActive);

      if (!isActive) {
        return;
      }

      const now = Date.now();
      const throttleWindow = Platform.OS === 'web' ? 10000 : userActiveRef.current ? 20000 : 60000;
      if (!force && now - activeChatSyncRef.current < throttleWindow) {
        return;
      }

      activeChatSyncRef.current = now;

      notificationService
        .setActiveChatPartner(partnerEmail, {
          partnerId,
          partnerName,
          isActive,
        })
        .catch(error => {
          logger.debug('Failed to sync active chat partner state', error);
        });
    },
    [isFocused, isAppActive, selectedTeamMember?.email, selectedTeamMember?.id, selectedTeamMember?.name]
  );

  useEffect(() => {
    const partnerEmail = selectedTeamMember?.email ?? null;
    const partnerId = selectedTeamMember?.id ?? null;
    const partnerName = selectedTeamMember?.name ?? null;

    if (!isFocused) {
      notificationService
        .setActiveChatPartner(null, {
          partnerId: null,
          partnerName: null,
          isActive: false,
        })
        .catch(error => {
          logger.debug('Failed to clear active chat partner state', error);
        });
      return;
    }

    if (!partnerEmail) {
      notificationService
        .setActiveChatPartner(null, {
          partnerId: null,
          partnerName: null,
          isActive: false,
        })
        .catch(error => {
          logger.debug('Failed to clear active chat partner state', error);
        });
      return;
    }

    notificationService
      .setActiveChatPartner(partnerEmail, {
        partnerId,
        partnerName,
        isActive: true,
      })
      .catch(error => {
        logger.debug('Failed to sync active chat partner state', error);
      });

    notificationService.clearChatNotificationsForSender(partnerEmail).catch(error => {
      logger.debug('Failed to clear chat notifications for active chat', error);
    });

    activeChatSyncRef.current = Date.now();
  }, [isFocused, selectedTeamMember?.email, selectedTeamMember?.id, selectedTeamMember?.name]);

  useEffect(() => {
    if (!isFocused || !selectedTeamMember?.email || !isAppActive) {
      return;
    }

    const presenceGraceMs = 120000;
    const idleDuration = Date.now() - lastUserActivityAt;
    const recentlyActive = isUserActiveInChat || idleDuration < presenceGraceMs;

    if (!recentlyActive) {
      return;
    }

    const intervalMs = Platform.OS === 'web' ? 15000 : (isUserActiveInChat ? 30000 : 60000);
    syncActiveChatPartnerState(true);
    const interval = setInterval(() => {
      syncActiveChatPartnerState(false);
    }, intervalMs);

    let watchdogTimeout: ReturnType<typeof setTimeout> | null = null;
    if (!isUserActiveInChat && idleDuration < presenceGraceMs) {
      const remaining = Math.max(presenceGraceMs - idleDuration, 0);
      watchdogTimeout = setTimeout(() => {
        setPresenceIdleTick((tick) => tick + 1);
      }, remaining + 50);
    }

    return () => {
      clearInterval(interval);
      if (watchdogTimeout) {
        clearTimeout(watchdogTimeout);
      }
    };
  }, [
    isFocused,
    selectedTeamMember?.email,
    syncActiveChatPartnerState,
    isAppActive,
    isUserActiveInChat,
    lastUserActivityAt,
    presenceIdleTick,
  ]);

  // Track user activity to keep active chat heartbeat fresh and prevent notifications during active chat usage
  useEffect(() => {
    if (!selectedTeamMember) {
      setIsUserActiveInChat(false);
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }
      userActiveRef.current = false;
      return;
    }

    const markUserActive = () => {
      const nowTs = Date.now();
      lastUserActivityRef.current = nowTs;
      setLastUserActivityAt(nowTs);
      setIsUserActiveInChat(true);
      userActiveRef.current = true;
      syncActiveChatPartnerState(false);

      // Clear existing timeout
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }

      // Set user as inactive after 30 seconds of no activity
      userActivityTimeoutRef.current = setTimeout(() => {
        userActiveRef.current = false;
        setIsUserActiveInChat(false);
        const inactiveAt = Date.now();
        lastUserActivityRef.current = inactiveAt;
        setLastUserActivityAt(inactiveAt);
        setPresenceIdleTick((tick) => tick + 1);
      }, 30000);
    };

    markUserActive();

    // Add event listeners for user activity (only on web)
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];

      activityEvents.forEach(event => {
        document.addEventListener(event, markUserActive, true);
      });

      return () => {
        if (userActivityTimeoutRef.current) {
          clearTimeout(userActivityTimeoutRef.current);
        }

        activityEvents.forEach(event => {
          document.removeEventListener(event, markUserActive, true);
        });
      };
    }

    return () => {
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }
      userActiveRef.current = false;
      const resetTs = Date.now();
      lastUserActivityRef.current = resetTs;
      setLastUserActivityAt(resetTs);
      setPresenceIdleTick((tick) => tick + 1);
    };
  }, [selectedTeamMember, syncActiveChatPartnerState]);

  // Reset activity state when switching chats
  useEffect(() => {
    setIsUserActiveInChat(false);
    if (userActivityTimeoutRef.current) {
      clearTimeout(userActivityTimeoutRef.current);
    }
    userActiveRef.current = false;
    const resetTs = Date.now();
    lastUserActivityRef.current = resetTs;
    setLastUserActivityAt(resetTs);
    setPresenceIdleTick((tick) => tick + 1);
  }, [selectedTeamMember?.id]);

  useEffect(() => {
    return () => {
      notificationService.setActiveChatPartner(null, { isActive: false }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    return () => {
      stopAnchorStabilization();
    };
  }, [stopAnchorStabilization]);

  useEffect(() => {
    return () => {
      if (scrollToBottomRetryTimeoutRef.current) {
        clearTimeout(scrollToBottomRetryTimeoutRef.current);
        scrollToBottomRetryTimeoutRef.current = null;
      }
    };
  }, []);

  // Removed keyboard sticker tip behavior per request

  const formatLastMessageTime = useCallback((timestamp: string): string => {
    try {
      const messageDate = new Date(timestamp);
      const now = new Date();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const messageDay = new Date(messageDate);
      messageDay.setHours(0, 0, 0, 0);

      const diffInDays = Math.floor((today.getTime() - messageDay.getTime()) / (1000 * 60 * 60 * 24));

      if (diffInDays === 0) {
        // Today - show time
        return messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (diffInDays === 1) {
        // Yesterday
        return 'Yesterday';
      } else if (diffInDays <= 6) {
        // This week - show day name
        return messageDate.toLocaleDateString([], { weekday: 'short' });
      } else {
        // Older - show date
        return messageDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
    } catch (error) {
      return '';
    }
  }, []);

  const buildSummaryMap = useCallback((records: Record<string, ConversationSummary>) => {
    const targetTenantId = activeTenant?.id?.trim();
    if (!targetTenantId) {
      return new Map();
    }

    return new Map(
      Object.entries(records || {})
        .filter(([, summary]) => summary?.tenantId?.trim() === targetTenantId)
        .map(([email, summary]) => [email.toLowerCase(), summary])
    );
  }, [activeTenant?.id]);

  const refreshChatSummaries = useCallback(async () => {
    if (!effectiveUser?.email || !activeTenant?.id) {
      setConversationSummaries(new Map());
      setIsLoadingChatInfo(false);
      return;
    }

    setIsLoadingChatInfo(true);
    try {
      await chatService.rebuildConversationSummariesForUser(effectiveUser.email).catch((error) => {
        logger.warn('Failed to rebuild conversation summaries before refresh', error);
      });
      const records = await chatService.getConversationSummaries(effectiveUser.email);
      setConversationSummaries(buildSummaryMap(records));
    } catch (error) {
      logger.warn('Failed to refresh conversation summaries', error);
    } finally {
      setIsLoadingChatInfo(false);
    }
  }, [effectiveUser?.email, activeTenant?.id, buildSummaryMap]);

  useEffect(() => {
    const isForegroundInteractive = Boolean(isFocused && isAppActive);
    const shouldRefresh = shouldRefreshChatSummariesOnForegroundResume({
      isFocused,
      isAppActive,
      wasForegroundInteractive: wasForegroundInteractiveRef.current,
      hasUserEmail: Boolean(effectiveUser?.email),
      hasTenantId: Boolean(activeTenant?.id),
      now: Date.now(),
      lastForegroundRefreshAt: lastForegroundRefreshAtRef.current,
    });
    wasForegroundInteractiveRef.current = isForegroundInteractive;

    if (!shouldRefresh) {
      return;
    }

    lastForegroundRefreshAtRef.current = Date.now();

    void refreshChatSummaries();

    if (selectedTeamMember?.id) {
      reconnectChat();
    }
  }, [
    isFocused,
    isAppActive,
    effectiveUser?.email,
    activeTenant?.id,
    selectedTeamMember?.id,
    refreshChatSummaries,
    reconnectChat,
  ]);

  const loadTenantTeamMembers = useCallback(async () => {
    const requestId = ++tenantMembersRequestIdRef.current;

    if (!activeTenant?.id) {
      if (tenantMembersRequestIdRef.current === requestId) {
        tenantRosterRef.current = [];
        setTeamMembers([]);
        setTeamMembersError(null);
        setTeamMembersLoading(false);
        presenceSnapshotRef.current = new Map();
      }
      return;
    }

    setTeamMembersLoading(true);
    setTeamMembersError(null);

    try {
      const memberships = await tenantService.getActiveMembershipsForTenant(activeTenant.id);
      if (tenantMembersRequestIdRef.current !== requestId) {
        return;
      }

      const normalizedMembers: TeamMember[] = memberships
        .filter((membership) => typeof membership.email === 'string' && membership.email.trim().length > 0)
        .map((membership) => {
          const normalizedEmail = membership.email.trim().toLowerCase();
          const localPart = normalizedEmail.split('@')[0] || normalizedEmail;
          const derivedName = (membership.displayName?.trim() || localPart)
            .replace(/[._-]+/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
          const initials = derivedName.charAt(0).toUpperCase() || 'U';

          return {
            id: normalizedEmail,
            name: derivedName,
            email: normalizedEmail,
            avatar: initials,
            role: membership.role === 'owner' || membership.role === 'admin' ? 'admin' : 'user',
            tenantRole: membership.role,
            photoURL: undefined,
            customImageURL: undefined,
          } satisfies TeamMember;
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      tenantRosterRef.current = normalizedMembers;
      const filteredPresence = buildPresenceSnapshotForRoster(normalizedMembers);
      presenceSnapshotRef.current = filteredPresence;
      setTeamMembers(mergeRosterWithPresence(normalizedMembers, filteredPresence));
    } catch (error) {
      logger.warn('Chat: failed to load tenant members', { error, tenantId: activeTenant?.id });
      if (tenantMembersRequestIdRef.current !== requestId) {
        return;
      }
      tenantRosterRef.current = [];
      setTeamMembers([]);
      setTeamMembersError('Unable to load team members. Pull to refresh to try again.');
      presenceSnapshotRef.current = new Map();
    } finally {
      if (tenantMembersRequestIdRef.current === requestId) {
        setTeamMembersLoading(false);
      }
    }
  }, [activeTenant?.id, buildPresenceSnapshotForRoster, mergeRosterWithPresence]);

  useEffect(() => {
    loadTenantTeamMembers();
  }, [loadTenantTeamMembers]);

  useEffect(() => {
    const unsubscribe = authService.onTeamMembersChange((members) => {
      const presenceMap = new Map<string, TeamMember>();
      members.forEach((member) => {
        const key = member.email?.toLowerCase?.();
        if (!key) {
          return;
        }
        presenceMap.set(key, { ...member, email: key, id: key });
      });

      rawPresenceSnapshotRef.current = presenceMap;
      const filtered = buildPresenceSnapshotForRoster(tenantRosterRef.current);
      presenceSnapshotRef.current = filtered;
      setTeamMembers(mergeRosterWithPresence(tenantRosterRef.current, filtered));
    });

    return () => {
      try {
        unsubscribe?.();
      } catch {}
    };
  }, [buildPresenceSnapshotForRoster, mergeRosterWithPresence]);

  // Subscribe to conversation summaries for the current user
  useEffect(() => {
    if (!effectiveUser?.email || !activeTenant?.id) {
      setConversationSummaries(new Map());
      setIsLoadingChatInfo(false);
      return;
    }

    let isActive = true;
    setIsLoadingChatInfo(true);

    const bootstrap = async () => {
      try {
        await chatService.rebuildConversationSummariesForUser(effectiveUser.email);
      } catch (error) {
        if (isActive) {
          logger.warn('Failed to rebuild conversation summaries', error);
        }
      }

      try {
        const records = await chatService.getConversationSummaries(effectiveUser.email);
        if (isActive) {
          setConversationSummaries(buildSummaryMap(records));
        }
      } catch (error) {
        if (isActive) {
          logger.warn('Failed to fetch conversation summaries', error);
        }
      } finally {
        if (isActive) {
          setIsLoadingChatInfo(false);
        }
      }
    };

    void bootstrap();

    const unsubscribe = chatService.onConversationSummariesChange(
      effectiveUser.email,
      (records) => {
        if (!isActive) return;
        setConversationSummaries(buildSummaryMap(records));
      }
    );

    return () => {
      isActive = false;
      unsubscribe?.();
    };
  }, [effectiveUser?.email, activeTenant?.id, buildSummaryMap]);

  // Merge team member list with latest conversation summaries
  useEffect(() => {
    if (teamMembers.length === 0) {
      setTeamMembersWithChatInfo([]);
      return;
    }

    const merged = teamMembers.map((member) => {
      const emailKey = (member.email || '').toLowerCase();
      const summary = conversationSummaries.get(emailKey);

      let lastMessage: TeamMemberWithChatInfo['lastMessage'] | null = null;
      let lastMessageTime = '';
      if (summary?.lastMessage) {
        lastMessage = {
          text: summary.lastMessage.text,
          timestamp: summary.lastMessage.timestamp,
          isOwnMessage: summary.lastMessage.isOwnMessage,
          delivered: summary.lastMessage.delivered,
          read: summary.lastMessage.read,
        };
        lastMessageTime = formatLastMessageTime(summary.lastMessage.timestamp);
      }

      return {
        ...member,
        unreadCount: summary?.unreadCount ?? 0,
        lastMessage,
        lastMessageTime,
        summaryUpdatedAt: summary?.updatedAt,
        pinnedSerial: pinnedChats[chatPreferencesService.sanitizeEmailKey(member.email)] || undefined,
      };
    });

    setTeamMembersWithChatInfo(merged);
  }, [teamMembers, conversationSummaries, pinnedChats, formatLastMessageTime]);

  // Reactions are stored on the message record and streamed via chat realtime updates.
  // Derive a local Map keyed by message id for existing UI rendering.
  useEffect(() => {
    if (!selectedTeamMember?.id) {
      setLocalMessageReactions(() => new Map());
      return;
    }

    const next = new Map<string, { [key: string]: Set<string> }>();
    if (!Array.isArray(messages) || messages.length === 0) {
      setLocalMessageReactions(() => next);
      return;
    }

    messages.forEach((msg: any) => {
      const messageId = msg?.id != null ? String(msg.id) : '';
      if (!messageId) {
        return;
      }

      if (shouldKeepOptimisticReactions(messageId)) {
        const optimistic = messageReactionsRef.current.get(messageId) ?? {};
        next.set(messageId, optimistic);
        return;
      }

      const raw = msg?.reactions;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return;
      }

      const sets: { [key: string]: Set<string> } = {};
      Object.entries(raw as Record<string, any>).forEach(([reactionType, users]) => {
        if (Array.isArray(users) && users.length > 0) {
          sets[reactionType] = new Set(users.filter((u: any) => typeof u === 'string'));
        }
      });

      if (Object.keys(sets).length > 0) {
        next.set(messageId, sets);
      }
    });

    setLocalMessageReactions(() => next);

    reactionOptimisticUntilRef.current.forEach((until, messageId) => {
      if (until <= Date.now() || !next.has(messageId)) {
        reactionOptimisticUntilRef.current.delete(messageId);
      }
    });
  }, [messages, selectedTeamMember?.id, shouldKeepOptimisticReactions]);

  // Typing indicator derived from presence system (Firestore typingTo).
  useEffect(() => {
    if (!effectiveUserEmail || !selectedTeamMember?.email) {
      setIsTyping(false);
      return;
    }

    if (!isAppActive || !isUserActiveInChat) {
      setIsTyping(false);
      return;
    }

    const typingTo = String(selectedTeamMember.typingTo || '').toLowerCase().trim();
    const isTypingNow = typingTo.length > 0 && typingTo === effectiveUserEmail.toLowerCase().trim();
    setIsTyping(isTypingNow);
  }, [effectiveUserEmail, selectedTeamMember?.email, selectedTeamMember?.typingTo, isAppActive, isUserActiveInChat]);

  // Detect new messages for animations
  useEffect(() => {
    if (!messages || messages.length === 0) {
      setPreviousMessageIds(new Set());
      setAnimatedMessages(new Set()); // Clear animations when no messages
      return;
    }

    const currentMessageIds = new Set(messages.map(msg => msg.id).filter((id): id is string => id !== undefined));
    const newMessageIds = new Set<string>();

    // Find messages that are in current set but not in previous set
    for (const id of currentMessageIds) {
      if (!previousMessageIds.has(id)) {
        newMessageIds.add(id);
      }
    }

    // Add new messages to animated set (but only if we had previous messages to compare with)
    // This prevents animations during initial load
    if (previousMessageIds.size > 0 && newMessageIds.size > 0) {
      setAnimatedMessages(prev => {
        const updated = new Set(prev);
        newMessageIds.forEach(id => updated.add(id));
        return updated;
      });

      // Clear animated messages after animation completes
      setTimeout(() => {
        setAnimatedMessages(prev => {
          const updated = new Set(prev);
          newMessageIds.forEach(id => updated.delete(id));
          return updated;
        });
      }, 1000); // 1 second should be enough for animation
    }

    setPreviousMessageIds(currentMessageIds);
  }, [messages]);

  // Use useMemo to properly handle filtering when user or teamMembers change
  const filteredTeamMembers = useMemo(() => {
    const getRecencyTs = (member: TeamMemberWithChatInfo): number => {
      const summaryTime = member.summaryUpdatedAt ? new Date(member.summaryUpdatedAt).getTime() : 0;
      const messageTime = member.lastMessage?.timestamp ? new Date(member.lastMessage.timestamp).getTime() : 0;
      return Math.max(summaryTime, messageTime);
    };

    const withPin = teamMembersWithChatInfo.map((m: any) => ({
      ...m,
      pinnedSerial: pinnedChats[chatPreferencesService.sanitizeEmailKey(m.email)] || undefined,
    }));
    return withPin
      .filter(member => {
        if (!effectiveUser?.email) {
          return true; // If no user email, don't filter anyone out yet
        }
        const shouldExclude = member.email === effectiveUser.email || member.id === effectiveUser.email;
        return !shouldExclude;
      })
      .filter(member => {
        const q = searchQuery.toLowerCase().trim();
        if (!q) {
          return true;
        }
        const name = (member.name || '').toLowerCase();
        const email = (member.email || '').toLowerCase();
        return name.includes(q) || email.includes(q);
      })
  .sort((a: any, b: any) => {
    // Pinned chats first by serial asc
    const aPin = a.pinnedSerial ?? 0;
    const bPin = b.pinnedSerial ?? 0;
    if (aPin && bPin && aPin !== bPin) return aPin - bPin;
    if (aPin && !bPin) return -1;
    if (!aPin && bPin) return 1;
    // Then by summary recency (most recent first), then by unread count, then by name.
        const aTime = getRecencyTs(a);
        const bTime = getRecencyTs(b);
        if (aTime !== bTime) return bTime - aTime;

        const aUnread = a.unreadCount || 0;
        const bUnread = b.unreadCount || 0;
        if (aUnread !== bUnread) return bUnread - aUnread;

        return a.name.localeCompare(b.name);
    });
  }, [effectiveUser?.email, teamMembersWithChatInfo, pinnedChats, searchQuery]);

  // Helper function to get date for a message
  const getMessageDate = (msg: any, previousMsg?: any): string => {
    // Always calculate the date for this message, regardless of separators
    try {
      const msgDate = new Date(msg.timestamp);
      const now = new Date();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const msgDay = new Date(msgDate);
      msgDay.setHours(0, 0, 0, 0);
      
      const diffInDays = Math.floor((today.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24));
      
      if (diffInDays === 0) return 'Today';
      if (diffInDays === 1) return 'Yesterday';
      if (diffInDays <= 6) return msgDate.toLocaleDateString([], { weekday: 'long' });
      if (msgDate.getFullYear() === now.getFullYear()) {
        return msgDate.toLocaleDateString([], {
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        });
      }
      return msgDate.toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });
    } catch (error) {
      return 'Today'; // Fallback
    }
  };

  const scrollToBottom = (animated: boolean = true, delay: number = 100, skipAutoFlag: boolean = false) => {
    if (scrollToBottomRetryTimeoutRef.current) {
      clearTimeout(scrollToBottomRetryTimeoutRef.current);
      scrollToBottomRetryTimeoutRef.current = null;
    }

    if (!skipAutoFlag) {
      isAutoScrollingRef.current = true;
    }

    const MAX_SCROLL_ATTEMPTS = 8;
    const BOTTOM_GAP_THRESHOLD = 12;
    const bottomBuffer = bottomVisibilityPadding;
    const effectiveBottomThreshold = bottomBuffer + BOTTOM_GAP_THRESHOLD;

    const runScroll = (attempt: number) => {
      const list = flatListRef.current as any;
      const useAnimated = attempt === 0 ? animated : false;

      const contentH = contentHeightRef.current || 0;
      const layoutH = layoutHeightRef.current || 0;
      const targetOffset = Math.max(0, contentH - layoutH);

      if (list?.scrollToOffset) {
        list.scrollToOffset({ offset: targetOffset, animated: useAnimated });
      } else if (list?.scrollToEnd) {
        list.scrollToEnd({ animated: useAnimated });
      } else if (scrollViewRef.current?.scrollTo) {
        scrollViewRef.current.scrollTo({ y: targetOffset, animated: useAnimated });
      } else if (scrollViewRef.current?.scrollToEnd) {
        scrollViewRef.current.scrollToEnd({ animated: useAnimated });
      }

      const settleDelay = useAnimated ? 200 : 80;

      scrollToBottomRetryTimeoutRef.current = setTimeout(() => {
        const contentH = contentHeightRef.current || 0;
        const layoutH = layoutHeightRef.current || 0;
        const currentOffset = lastScrollOffsetRef.current || 0;
        const distanceFromBottom = Math.max(0, contentH - layoutH - currentOffset);

        if (distanceFromBottom <= effectiveBottomThreshold || isAtBottomRef.current) {
          scrollToBottomRetryTimeoutRef.current = null;
          isAtBottomRef.current = true;
          if (anchoredTargetRef.current?.type === 'bottom') {
            stopAnchorStabilization();
          }
          if (!skipAutoFlag) {
            setTimeout(() => {
              isAutoScrollingRef.current = false;
            }, useAnimated ? 300 : 120);
          }
          return;
        }

        if (attempt + 1 >= MAX_SCROLL_ATTEMPTS) {
          scrollToBottomRetryTimeoutRef.current = null;
          if (!skipAutoFlag) {
            isAutoScrollingRef.current = false;
          }
          return;
        }

        runScroll(attempt + 1);
      }, settleDelay);
    };

    scrollToBottomRetryTimeoutRef.current = setTimeout(() => runScroll(0), Math.max(0, delay));
  };

  const scheduleScrollToBottom = (
    options?: {
      animated?: boolean;
      delay?: number;
      skipAutoFlag?: boolean;
    }
  ) => {
    const { animated = true, delay = 100, skipAutoFlag = false } = options ?? {};
    const run = () => scrollToBottom(animated, delay, skipAutoFlag);

    if (InteractionManager?.runAfterInteractions) {
      InteractionManager.runAfterInteractions(run);
      return;
    }

    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
      return;
    }

    setTimeout(run, 0);
  };

  const scrollToMessage = (messageId: string, animated: boolean = false) => {
    if (!flatListRef.current) return false;

    const index = displayedMessages.findIndex((m: any) => m.id === messageId);
    if (index === -1) return false;

    try {
      (flatListRef.current as any).scrollToIndex({
        index,
        animated,
        viewPosition: 0.3, // Show message at 30% from top
      });
      onScrollFailAttemptsRef.current = 0;
      return true;
    } catch (error) {
      logger.warn('Failed to scroll to message:', error);
      return false;
    }
  };

  const markAutoScroll = useCallback((duration: number = 260) => {
    isAutoScrollingRef.current = true;
    setTimeout(() => {
      isAutoScrollingRef.current = false;
    }, duration);
  }, []);

  const ensureAnchorPosition = useCallback(() => {
    const anchor = anchoredTargetRef.current;
    if (!anchor) return;
    if (userInteractedRef.current) {
      stopAnchorStabilization();
      return;
    }
    const startedAt = lastAnchoredAtRef.current || 0;
    if (startedAt && Date.now() - startedAt >= STABILIZE_MS) {
      stopAnchorStabilization();
      return;
    }
    if (anchor.type === 'bottom') {
      scrollToBottom(false, 0);
      isAtBottomRef.current = true;
    } else if (anchor.type === 'message' && anchor.id) {
      markAutoScroll();
      scrollToMessage(anchor.id, false);
    }
  }, [STABILIZE_MS, markAutoScroll, scrollToBottom, scrollToMessage, stopAnchorStabilization]);

  const beginAnchorStabilization = useCallback(
    (target: { type: 'bottom' | 'message'; id?: string }, options?: { skipImmediate?: boolean }) => {
      stopAnchorStabilization();
      anchoredTargetRef.current = target;
      userInteractedRef.current = false;
      lastAnchoredAtRef.current = Date.now();
      setIsInitialAnchorSettled(false);

      if (!options?.skipImmediate) {
        ensureAnchorPosition();
      }

      stabilizationTimeoutRef.current = setTimeout(() => {
        stopAnchorStabilization();
      }, STABILIZE_MS);
    },
    [STABILIZE_MS, ensureAnchorPosition, stopAnchorStabilization]
  );

  const tryAnchorToBottom = (force: boolean = false) => {
    if (hasAnchoredInitialScrollRef.current && !force) {
      pendingInitialAnchorRef.current = false;
      if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] skip bottom (already anchored)');
      return false;
    }

    const contentH = contentHeightRef.current || 0;
    const layoutH = layoutHeightRef.current || 0;
    if (contentH <= 0 || layoutH <= 0) {
      pendingInitialAnchorRef.current = true;
      if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] defer bottom (layout pending)', { contentH, layoutH });
      return false;
    }

    hasAnchoredInitialScrollRef.current = true;
    pendingInitialAnchorRef.current = false;
    onScrollFailAttemptsRef.current = 0;
    beginAnchorStabilization({ type: 'bottom' });
    if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] anchored to bottom');
    return true;
  };

  const scheduleScrollToUnread = (messageId: string | null | undefined) => {
    if (!messageId) return;
    if (scrollToUnreadAttemptedRef.current) return;

    pendingInitialAnchorRef.current = true;
    const contentH = contentHeightRef.current || 0;
    const layoutH = layoutHeightRef.current || 0;
    if (contentH <= 0 || layoutH <= 0) {
      pendingInitialAnchorRef.current = true;
      return;
    }

    requestAnimationFrame(() => {
      markAutoScroll();
      const success = scrollToMessage(String(messageId), false);
      if (success) {
        scrollToUnreadAttemptedRef.current = true;
        hasAnchoredInitialScrollRef.current = true;
        pendingInitialAnchorRef.current = false;
        onScrollFailAttemptsRef.current = 0;
        beginAnchorStabilization({ type: 'message', id: String(messageId) }, { skipImmediate: true });
        if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] anchored to first unread', { messageId });
      } else {
        pendingInitialAnchorRef.current = true;
        if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] failed to anchor to unread (will retry)', { messageId });
      }
    });
  };

  useEffect(() => {
    const prev = prevSettlementRef.current;
    prevSettlementRef.current = isInitialAnchorSettled;

    const conversationId = selectedTeamMember?.id || selectedTeamMember?.email || 'unknown';
    if (prev === isInitialAnchorSettled && prev !== null) {
      return;
    }

    if (!isInitialAnchorSettled) {
      const reason: 'initial' | 'refresh' =
        renderTraceRef.current && renderTraceRef.current.conversationId === conversationId
          ? 'refresh'
          : 'initial';
      const startedAt = Date.now();
      const profile = concurrencyProfileRef.current;
      renderTraceRef.current = { startedAt, conversationId, reason, profile };
      logger.metric('chat.render.trace.start', {
        conversationId,
        reason,
        messageCount: displayedMessagesRef.current?.length ?? 0,
      });
      if (!profile) {
        chatCacheService
          .getTelemetryContext()
          .then((resolvedProfile) => {
            concurrencyProfileRef.current = resolvedProfile;
            const active = renderTraceRef.current;
            if (active && active.startedAt === startedAt) {
              active.profile = resolvedProfile;
            }
          })
          .catch((error) => {
            logger.warn('chat.render.trace.profileResolveError', { error });
          });
      }
      return;
    }

    const activeTrace = renderTraceRef.current;
    if (!activeTrace) {
      return;
    }
    const durationMs = Date.now() - activeTrace.startedAt;
    const profile = activeTrace.profile || concurrencyProfileRef.current;
    logger.metric('chat.render.trace.complete', {
      conversationId: activeTrace.conversationId,
      reason: activeTrace.reason,
      durationMs,
      messageCount: displayedMessagesRef.current?.length ?? 0,
      hydrationConcurrency: profile?.hydration,
      downloadConcurrency: profile?.downloads,
      deviceType: profile?.deviceType ?? null,
      totalMemoryBytes: profile?.totalMemory ?? null,
    });
    renderTraceRef.current = null;
  }, [isInitialAnchorSettled, selectedTeamMember?.id, selectedTeamMember?.email]);

  // Handle scroll to update sticky date header (optimized to reduce re-renders)
  const handleScroll = (event: any) => {
    const scrollY = event.nativeEvent.contentOffset.y;
    lastScrollOffsetRef.current = scrollY;
    if (!isAutoScrollingRef.current) {
      userInteractedRef.current = true;
      stopAnchorStabilization();
    }
    
    // Clear existing timeout and set scrolling to true
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    // Only update scrolling state if it actually changed
    if (!isScrolling) {
      setIsScrolling(true);
    }
    
    // Early exit for shallow scrolls to reduce state updates
    if (scrollY <= 50) {
      if (stickyDateVisible) {
        setStickyDateVisible(false);
      }
      // Set timer to turn off scrolling
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 200);
      return;
    }
    
    if (scrollY <= 50) {
      if (stickyDateVisible) {
        setStickyDateVisible(false);
      }
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 200);
      return;
    }

    const displayed = displayedMessagesRef.current;
    const topInfo = topVisibleMessageRef.current;
    let currentDate = '';
    if (displayed && displayed.length && topInfo?.id) {
      const idx = displayed.findIndex((m: any) => m && String(m.id) === String(topInfo.id));
      if (idx >= 0) {
        const msg = displayed[idx];
        const prev = idx > 0 ? displayed[idx - 1] : undefined;
        currentDate = getMessageDate(msg, prev);
      }
    }

    if (currentDate) {
      if (currentDate !== stickyDateText) {
        setStickyDateText(currentDate);
      }
      if (!stickyDateVisible) {
        setStickyDateVisible(true);
      }
    } else if (stickyDateVisible) {
      setStickyDateVisible(false);
    }

    // Set timer to turn off scrolling and hide header
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
      if (stickyDateVisible) {
        setStickyDateVisible(false);
      }
    }, 1500); // Hide after 1.5 seconds of no scrolling
  };

  useEffect(() => {
    if (!messages || messages.length === 0) return;
    if (hasAnchoredInitialScrollRef.current) return;

    if (firstUnreadMessageId && !scrollToUnreadAttemptedRef.current) {
      scheduleScrollToUnread(firstUnreadMessageId);
      return;
    }

    pendingInitialAnchorRef.current = true;
    tryAnchorToBottom();
  }, [messages, firstUnreadMessageId, selectedTeamMember?.id]);

  useEffect(() => {
    if (!messages || messages.length === 0) {
      lastTailIdRef.current = null;
      setUnseenCount(0);
      setShowScrollToBottom(false);
      setShowNewDivider(false);
      setNewDividerMessageId(null);
      hasAnchoredInitialScrollRef.current = false;
      pendingInitialAnchorRef.current = false;
      scrollToUnreadAttemptedRef.current = false;
      pendingPrependAnchorRef.current = null;
      onScrollFailAttemptsRef.current = 0;
      setIsInitialAnchorSettled(true);
      return;
    }

    const lastId = messages[messages.length - 1]?.id ?? null;
    if (!lastId) return;

    if (lastTailIdRef.current === null) {
      lastTailIdRef.current = lastId;
      if (!hasAnchoredInitialScrollRef.current && !scrollToUnreadAttemptedRef.current) {
        pendingInitialAnchorRef.current = true;
        tryAnchorToBottom();
      }
      return;
    }

    if (lastId === lastTailIdRef.current) {
      return;
    }

    if (isAtBottomRef.current) {
      lastTailIdRef.current = lastId;
      setUnseenCount(0);
      setShowScrollToBottom(false);
      setShowNewDivider(false);
      setNewDividerMessageId(null);
      scheduleScrollToBottom({ animated: true, delay: 140 });
      return;
    }

    const prevId = lastTailIdRef.current;
    const idx = messages.findIndex((m: any) => m?.id === prevId);
    const additional = idx >= 0 ? Math.max(0, messages.length - (idx + 1)) : 1;
    setUnseenCount((c) => c + additional);
    setShowScrollToBottom(true);
    const firstNewId = idx >= 0 ? (messages[idx + 1]?.id ?? lastId) : lastId;
    if (firstNewId) {
      setNewDividerMessageId(firstNewId);
      setShowNewDivider(true);
    }
    lastTailIdRef.current = lastId;
  }, [messages]);

  // Auto scroll to bottom when typing indicator appears/disappears
  useEffect(() => {
    if (!isTyping) return;
    if (!selectedTeamMember) return;
    if (isAtBottomRef.current) {
      scheduleScrollToBottom();
    }
  }, [isTyping, selectedTeamMember?.id]);

  // Cleanup scroll timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (soundTimeoutRef.current) {
        clearTimeout(soundTimeoutRef.current);
      }
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }
    };
  }, []);

  // Ensure initial anchoring runs when the chat changes or on first focus for that chat.
  // Do NOT force re-anchoring on subsequent focuses of the same chat (prevents unexpected jumps).
  const lastAnchoredChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isFocused) return;
    if (!selectedTeamMember) return;
    const chatKey = String(selectedTeamMember.id || selectedTeamMember.email || '');
    const alreadyAnchoredSameChat =
      lastAnchoredChatIdRef.current === chatKey && hasAnchoredInitialScrollRef.current;
    if (alreadyAnchoredSameChat) return;

    // Mark this chat as the current anchored target and reset guards
    lastAnchoredChatIdRef.current = chatKey;
    hasAnchoredInitialScrollRef.current = false;
    pendingInitialAnchorRef.current = true;
    scrollToUnreadAttemptedRef.current = false;
    onScrollFailAttemptsRef.current = 0;

    // Attempt anchor on next tick once layout/content sizes are known
    setTimeout(() => {
      if (firstUnreadMessageId) {
        scheduleScrollToUnread(firstUnreadMessageId);
      } else {
        tryAnchorToBottom();
      }
    }, 0);
  }, [isFocused, selectedTeamMember?.id, selectedTeamMember?.email, firstUnreadMessageId]);

  useEffect(() => {
    if (prevLoadingMoreRef.current && !loadingMore) {
      if (shouldUseManualAnchorPreservation && pendingPrependAnchorRef.current) {
        restorePrependAnchorIfNeeded();
      }
    }
    prevLoadingMoreRef.current = loadingMore;
  }, [loadingMore, restorePrependAnchorIfNeeded, shouldUseManualAnchorPreservation]);

  useEffect(() => {
    if (!selectedTeamMember?.email || !effectiveUser?.email || !isFocused || !isAppActive) {
      return;
    }

    const timer = setTimeout(() => {
      queueConversationReceiptSync({ requestConversationDelivered: true });
    }, 250);

    return () => clearTimeout(timer);
  }, [selectedTeamMember?.email, effectiveUser?.email, isFocused, isAppActive, queueConversationReceiptSync]);

  // Smart unread separator management - mirror live unread state of conversation
  useEffect(() => {
    if (!selectedTeamMember?.email || !effectiveUser?.email) {
      hasAcknowledgedUnreadRef.current = false;
      if (unreadSeparatorDismissTimeoutRef.current) {
        clearTimeout(unreadSeparatorDismissTimeoutRef.current);
        unreadSeparatorDismissTimeoutRef.current = null;
      }
      setShowUnreadSeparator(false);
      setUnreadSeparatorMessageId(null);
      return;
    }

    if (firstUnreadMessageId) {
      if (unreadSeparatorDismissTimeoutRef.current) {
        clearTimeout(unreadSeparatorDismissTimeoutRef.current);
        unreadSeparatorDismissTimeoutRef.current = null;
      }
      setUnreadSeparatorMessageId(firstUnreadMessageId);
      setShowUnreadSeparator(true);
      hasAcknowledgedUnreadRef.current = false;
    } else if (hasAcknowledgedUnreadRef.current && incomingUnreadCountRef.current === 0) {
      scheduleUnreadSeparatorDismiss(320);
    }
  }, [firstUnreadMessageId, selectedTeamMember?.email, effectiveUser?.email, scheduleUnreadSeparatorDismiss]);

  useEffect(() => {
    if (!selectedTeamMember?.email || !effectiveUser?.email) {
      previousIncomingUnreadRef.current = incomingUnreadCount;
      return;
    }

    const previousCount = previousIncomingUnreadRef.current;
    previousIncomingUnreadRef.current = incomingUnreadCount;

    if (!teamMembers.length) {
      return;
    }

    if (incomingUnreadCount === 0 && hasAcknowledgedUnreadRef.current) {
      scheduleUnreadSeparatorDismiss(320);
    }

    if (incomingUnreadCount > previousCount) {
      hasAcknowledgedUnreadRef.current = false;
      if (unreadSeparatorDismissTimeoutRef.current) {
        clearTimeout(unreadSeparatorDismissTimeoutRef.current);
        unreadSeparatorDismissTimeoutRef.current = null;
      }
      setShowUnreadSeparator(true);
      if (firstUnreadMessageId) {
        setUnreadSeparatorMessageId(firstUnreadMessageId);
      }
    }

  }, [incomingUnreadCount, selectedTeamMember?.email, effectiveUser?.email, teamMembers, scheduleUnreadSeparatorDismiss, firstUnreadMessageId]);

  // Reset separator when switching chats
  useEffect(() => {
    stopAnchorStabilization();
    setShowUnreadSeparator(false);
    setUnreadSeparatorMessageId(null);
    setShowNewDivider(false);
    setNewDividerMessageId(null);
    hasAcknowledgedUnreadRef.current = false;
    incomingUnreadCountRef.current = 0;
    previousIncomingUnreadRef.current = 0;
    if (unreadSeparatorDismissTimeoutRef.current) {
      clearTimeout(unreadSeparatorDismissTimeoutRef.current);
      unreadSeparatorDismissTimeoutRef.current = null;
    }
    hasAnchoredInitialScrollRef.current = false; // ensure next chat anchors once
    pendingInitialAnchorRef.current = false;
    scrollToUnreadAttemptedRef.current = false;
    onScrollFailAttemptsRef.current = 0;
  pendingPrependAnchorRef.current = null;
    setIsInitialAnchorSettled(false);
    // Reset layout/measurement state so new chat anchors after fresh measurements
    contentHeightRef.current = 0;
    layoutHeightRef.current = 0;
    lastScrollOffsetRef.current = 0;
    isAtBottomRef.current = true;
    topVisibleMessageRef.current = null;
    setMessagePositions({});
    displayedMessagesRef.current = [];
    lastTailIdRef.current = null;
  // Clear animation states when switching chats
    setAnimatedMessages(new Set());
    setPreviousMessageIds(new Set());
    globalAnimatedMessages.current.clear(); // Clear global animation tracking
    
    // Reset input height when switching chats (but not when sending messages)
    setInputHeight(40);
    setLastTypingHeight(40);
    
    // Manually hide keyboard when switching chats
    Keyboard.dismiss();
    
    // Note: We DON'T clear reactions when switching chats anymore
    // Reactions are global and should persist across chat switches
  }, [selectedTeamMember?.id]);

  // Helper function to clear input field without affecting keyboard
  const clearInputField = useCallback(() => {
    logger.debug('clearInputField called, Platform:', Platform.OS);
    
    // CRITICAL FIX: Clear state first, then let React re-render, then force native sync
    setEditingMessageInfo(null);
    setMessage('');
    latestMessageRef.current = '';
    setShowSpecialCommand(false);
    setIsComposingSpecial(false);
    setInputHeight(40);
    setLastTypingHeight(40);

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    if (effectiveUserEmail && selectedMemberEmail) {
      chatService.setTypingStatus(effectiveUserEmail, selectedMemberEmail, false);
    }
    
    // Use setTimeout to ensure state update has propagated before native clearing
    setTimeout(() => {
      // Try to clear the mobile input using ref method AFTER state update
      if (Platform.OS !== 'web' && mobileInputRef.current) {
        logger.debug('Attempting to clear mobile input via ref');
        mobileInputRef.current.clearInput();
      }
      logger.debug('Message state cleared');
    }, 0); // Immediate but after state update
  }, [effectiveUserEmail, selectedMemberEmail]);

  const beginEditingMessage = useCallback(
    (message: any) => {
      if (!message || !message.id) {
        return;
      }
      if (!canEditMessage(message)) {
        Toast.show({
          type: 'info',
          text1: 'Cannot Edit',
          text2: 'Only plain text messages without attachments can be edited.',
          position: 'top',
        });
        return;
      }

      const textValue = typeof message.text === 'string' ? message.text : '';
      logger.info?.('Chat: begin editing message', {
        messageId: message.id,
        length: textValue.length,
        platform: Platform.OS,
      });
      setEditingMessageInfo({ id: normalizeMessageId(message.id), originalText: textValue });
      setMessage(textValue);
      latestMessageRef.current = textValue;

      if (Platform.OS !== 'web') {
        try {
          mobileInputRef.current?.syncValueFromParent?.(textValue);
        } catch (syncError) {
          logger.debug('Failed to sync mobile input value during edit', { syncError });
        }
      }

      setTimeout(() => {
        try {
          if (Platform.OS === 'web') {
            textInputRef.current?.focus?.();
          } else if (mobileInputRef.current) {
            mobileInputRef.current.focusInput?.();
          } else {
            // @ts-ignore focus may exist on custom input
            richTextInputRef.current?.focus?.();
          }
        } catch (focusError) {
          logger.debug('Failed to focus input after starting edit', { focusError });
        }
      }, 0);
    },
    [canEditMessage]
  );

  const cancelEditingMessage = useCallback(() => {
    if (!editingMessageInfo) {
      return;
    }
    clearInputField();
  }, [editingMessageInfo, clearInputField]);

  const performDeleteMessage = useCallback(
    async (message: any) => {
      if (!message || !message.id) {
        return;
      }
      if (isMessageActionPending(message.id)) {
        return;
      }
      if (isOffline) {
        Toast.show({
          type: 'info',
          text1: 'Offline',
          text2: 'Reconnect to remove messages.',
          position: 'top',
        });
        return;
      }

      markMessageActionPending(message.id);
      try {
        await deleteChatMessage(message.id);
        if (editingMessageInfo?.id === normalizeMessageId(message.id)) {
          clearInputField();
        }
        Toast.show({
          type: 'success',
          text1: 'Message deleted',
          position: 'top',
        });
      } catch (error: any) {
        let text2 = 'Failed to delete message. Please try again.';
        if (error instanceof ChatMessageActionError) {
          switch (error.code) {
            case 'too_old':
              text2 = 'You can no longer delete this message.';
              break;
            case 'not_authorized':
            case 'not_allowed':
              text2 = 'You are not allowed to delete this message.';
              break;
            case 'already_deleted':
              text2 = 'This message is already removed.';
              break;
          }
        }
        Toast.show({
          type: 'error',
          text1: 'Delete failed',
          text2,
          position: 'top',
        });
      } finally {
        clearMessageActionPending(message.id);
        setDeleteConfirmState((prev) => {
          if (prev.message && prev.message.id === message.id) {
            return { visible: false, message: null };
          }
          return prev;
        });
      }
    },
    [
      isMessageActionPending,
      isOffline,
      deleteChatMessage,
      editingMessageInfo,
      clearInputField,
      markMessageActionPending,
      clearMessageActionPending,
      setDeleteConfirmState,
    ]
  );

  const confirmDeleteMessage = useCallback(
    (message: any) => {
      if (!message || !message.id) {
        return;
      }

      setDeleteConfirmState({ visible: true, message });
    },
    [setDeleteConfirmState]
  );

  const deleteConfirmationPreview = useMemo(() => {
    const target = deleteConfirmState.message;
    if (!target) {
      return null;
    }

    if (typeof target.text === 'string') {
      const trimmed = target.text.trim();
      if (trimmed.length > 0) {
        const snippet = trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
        return `Preview: "${snippet}"`;
      }
    }

    if (target.gif) {
      return 'GIF message will be removed.';
    }

    if (target.sticker) {
      return 'Sticker message will be removed.';
    }

    if (Array.isArray(target.attachments) && target.attachments.length > 0) {
      const count = target.attachments.length;
      return count === 1 ? 'Includes 1 attachment.' : `Includes ${count} attachments.`;
    }

    if (target.fileName) {
      return `Attachment: ${String(target.fileName).trim() || 'File'}.`;
    }

    return null;
  }, [deleteConfirmState.message]);

  const pendingDeleteId = deleteConfirmState.message?.id;
  const isDeletePending = pendingDeleteId ? isMessageActionPending(pendingDeleteId) : false;

  // Handle rich content from mobile input
  const handleRichContentFromMobile = useCallback(async (items: any[]) => {
    if (!items || items.length === 0) return;
    if (!selectedTeamMember || !effectiveUser?.email) return;

    // Optimistic render: create pending media entries immediately and process in background
    for (const it of items) {
      try {
        const fileUri: string | undefined = it?.fileUri || it?.uri;
        const fileName: string | undefined = it?.fileName || it?.name;
        const mime: string | undefined = it?.mimeType || it?.type;
        if (!fileUri) continue;

        const guessedExt = (mime && mime.split('/')[1]) || (fileName?.split('.').pop()) || 'bin';
        const isGif = (mime || '').toLowerCase().includes('gif') || /\.gif$/i.test(fileName || '') || guessedExt.toLowerCase() === 'gif';

        const tempId = `pm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const pendingItem: PendingMediaItem = {
          id: tempId,
          kind: isGif ? 'gif' : 'sticker',
          previewUri: fileUri,
          width: it?.width,
          height: it?.height,
          nameOrTitle: isGif ? (it?.title || 'GIF') : (it?.name || 'Sticker'),
          timestamp: new Date().toISOString(),
          recipientId: selectedTeamMember.id,
          sender: effectiveUser.email,
          status: 'sending',
          mime,
          source: 'keyboard',
        };
        setPendingMedia(prev => new Map(prev).set(tempId, pendingItem));

        // Background upload + send
        (async () => {
          try {
            const isHttp = /^https?:\/\//i.test(fileUri);
            const isContent = /^content:\/\//i.test(fileUri);
            let finalUrl = fileUri;
            if (!isHttp) {
              // Derive a sensible filename
              const name = `kb_${Date.now()}.${guessedExt}`;
              const uploadMime = mime || (isGif ? 'image/gif' : 'image/png');
              // Convert content:// to a temp file is handled inside uploadFile expectations
              const { url } = await chatService.uploadFile(
                fileUri,
                name,
                uploadMime,
                {
                  senderEmail: effectiveUser.email,
                  recipientEmail: selectedTeamMember.email || selectedTeamMember.id,
                },
                (progress) => {
                  setPendingMedia(prev => {
                    const next = new Map(prev);
                    const cur = next.get(tempId);
                    if (cur && cur.status === 'sending') {
                      next.set(tempId, { ...cur, progress });
                    }
                    return next;
                  });
                }
              );
              finalUrl = url;
            }

            if (isGif) {
              await sendGif({ url: finalUrl, source: 'keyboard' } as any, selectedTeamMember.id);
            } else {
              await sendSticker({ url: finalUrl, name: 'Keyboard Sticker', pack: 'keyboard' } as any, selectedTeamMember.id);
            }

            // Remove pending once the real message is sent and will arrive via listener
            setPendingMedia(prev => {
              const next = new Map(prev);
              next.delete(tempId);
              return next;
            });
          } catch (error) {
            attachmentUploadCancelMap.current.delete(tempId);
            // Mark as failed so user sees an error state
            setPendingMedia(prev => {
              const next = new Map(prev);
              const cur = next.get(tempId);
              if (cur) next.set(tempId, { ...cur, status: 'failed' });
              return next;
            });
            Toast.show({ type: 'error', text1: 'Send Failed', text2: 'Could not send media from keyboard', position: 'top' });
          }
        })();
      } catch (err) {
        logger.error('Error staging keyboard media:', err);
      }
    }
    // Do not force auto-scroll; only anchor if user is already at bottom
    if (isAtBottomRef.current) {
      scheduleScrollToBottom({ animated: true, delay: 150 });
    } else {
      setShowScrollToBottom(true);
    }
  }, [selectedTeamMember, effectiveUser?.email, sendGif, sendSticker]);

  const trimmedMessageValue = useMemo(() => {
    if (typeof message !== 'string') {
      return '';
    }
    return message.trim();
  }, [message]);

  const normalizeMessageValue = useCallback((value?: string | null) => {
    if (typeof value !== 'string') {
      return '';
    }
    return value.replace(/\s+/g, ' ').trim();
  }, []);

  const normalizedCurrentMessage = useMemo(() => normalizeMessageValue(message), [message, normalizeMessageValue]);

  const normalizedOriginalMessage = useMemo(
    () => normalizeMessageValue(editingMessageInfo?.originalText ?? ''),
    [editingMessageInfo?.originalText, normalizeMessageValue]
  );

  const hasEditedMessageChanged = useMemo(() => {
    if (!editingMessageInfo) {
      return true;
    }
    return normalizedCurrentMessage.length > 0 && normalizedCurrentMessage !== normalizedOriginalMessage;
  }, [editingMessageInfo, normalizedCurrentMessage, normalizedOriginalMessage]);

  const editingPreviewText = useMemo(() => {
    if (!editingMessageInfo?.originalText) {
      return '';
    }

    const normalized = editingMessageInfo.originalText.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }

    return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
  }, [editingMessageInfo]);

  const canAttemptSend = useMemo(() => {
    if (!trimmedMessageValue) return false;
    if (!selectedTeamMember) return false;
    if (processingKeyboardMedia) return false;
    if (editingMessageInfo) {
      return hasEditedMessageChanged;
    }
    return true;
  }, [trimmedMessageValue, selectedTeamMember, processingKeyboardMedia, editingMessageInfo, hasEditedMessageChanged]);

  const handleSendMessage = useCallback(async () => {
    if (sendInFlightRef.current) {
      return;
    }

    const trimmedMessage = trimmedMessageValue;

    if (editingMessageInfo) {
      if (!trimmedMessage) {
        Toast.show({
          type: 'info',
          text1: 'Empty Message',
          text2: 'Edited message cannot be empty.',
          position: 'top',
        });
        return;
      }

      if (!hasEditedMessageChanged) {
        cancelEditingMessage();
        return;
      }

      if (isOffline) {
        Toast.show({
          type: 'info',
          text1: 'Offline',
          text2: 'Reconnect to update messages.',
          position: 'top',
        });
        return;
      }

      sendInFlightRef.current = true;
      setIsSendingMessage(true);

      try {
        await editChatMessage(editingMessageInfo.id, trimmedMessage);
        Toast.show({
          type: 'success',
          text1: 'Message updated',
          position: 'top',
        });
        clearInputField();
      } catch (error: any) {
        let text2 = 'Failed to edit message. Please try again.';
        if (error instanceof ChatMessageActionError) {
          switch (error.code) {
            case 'too_old':
              text2 = 'You can no longer edit this message.';
              break;
            case 'not_authorized':
            case 'not_allowed':
              text2 = 'You are not allowed to edit this message.';
              break;
            case 'already_deleted':
              text2 = 'This message has already been removed.';
              break;
          }
        }
        Toast.show({
          type: 'error',
          text1: 'Edit failed',
          text2,
          position: 'top',
        });
        setMessage(trimmedMessage);
        latestMessageRef.current = trimmedMessage;
      } finally {
        sendInFlightRef.current = false;
        setIsSendingMessage(false);
      }

      return;
    }

    if (!canAttemptSend) {
      return;
    }

    const recipient = selectedTeamMember;
    if (!recipient) {
      return;
    }

    if (isOffline) {
      const tempId = `pending_${Date.now()}_${Math.random()}`;
      const pendingMessage: PendingMessage = {
        id: tempId,
        text: trimmedMessage,
        timestamp: new Date().toISOString(),
        recipientId: recipient.id,
        sender: effectiveUser?.email || user?.email || '',
      };

      setPendingMessages((prev) => {
        const next = new Map(prev);
        next.set(tempId, pendingMessage);
        return next;
      });

      try {
        await PendingMessageStorage.addPendingMessage(tempId, pendingMessage);
      } catch (error) {
        logger.error('Failed to save pending message to storage:', error);
      }

      clearInputField();

      Toast.show({
        type: 'info',
        text1: 'Message Queued',
        text2: 'You are offline. Your message will be sent when you reconnect.',
        position: 'top',
      });

      return;
    }

    sendInFlightRef.current = true;
    setIsSendingMessage(true);
    const originalMessage = message;
    const wasShowingSpecialCommand = showSpecialCommand;
    const wasComposingSpecial = isComposingSpecial;

    clearInputField();
    // Immediately clear the spinner for snappy UI while the send continues in background
    setIsSendingMessage(false);

    try {
      if (effectiveUserEmail && selectedMemberEmail) {
        chatService.setTypingStatus(effectiveUserEmail, selectedMemberEmail, false);
      }

      let messageText = trimmedMessage;
      let isSpecialMessage = false;

      if (messageText.startsWith('/special ')) {
        messageText = messageText.replace('/special ', '').trim();
        isSpecialMessage = true;
      }

      if (!isSpecialMessage) {
        const rich = await handleRichTextInput(messageText);
        if (rich.type === 'sticker' && typeof rich.content === 'object') {
          await handleStickerSelect(rich.content);
          if (isAtBottomRef.current) {
              scheduleScrollToBottom();
          } else {
            setShowScrollToBottom(true);
            setUnseenCount((c) => c + 1);
          }
          return;
        }
      }

      if (!messageText) {
        Toast.show({
          type: 'info',
          text1: 'Empty Message',
          text2: 'Please enter a message after /special command.',
          position: 'top',
        });
        setMessage(originalMessage);
        latestMessageRef.current = originalMessage;
        setShowSpecialCommand(wasShowingSpecialCommand);
        setIsComposingSpecial(wasComposingSpecial);
        return;
      }

      await sendMessage(messageText, isSpecialMessage, recipient.id);

      void sendMessageNotification(messageText, isSpecialMessage);

      if (isSpecialMessage) {
        Toast.show({
          type: 'success',
          text1: '⭐ Special Message Sent',
          text2: 'Your special message has been delivered!',
          position: 'top',
        });
      }

      if (isAtBottomRef.current) {
        scheduleScrollToBottom({ animated: true, delay: 150 });
      } else {
        setShowScrollToBottom(true);
        setUnseenCount((c) => c + 1);
      }
    } catch (error) {
      if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending message', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending another message.`,
          position: 'top',
        });
        setMessage(originalMessage);
        latestMessageRef.current = originalMessage;
        setShowSpecialCommand(wasShowingSpecialCommand);
        setIsComposingSpecial(wasComposingSpecial);
        return;
      }

      logger.error('Error sending message:', error);
      Toast.show({
        type: 'error',
        text1: 'Send Failed',
        text2: 'Failed to send message. Please try again.',
        position: 'top',
      });
      setMessage(originalMessage);
      latestMessageRef.current = originalMessage;
      setShowSpecialCommand(wasShowingSpecialCommand);
      setIsComposingSpecial(wasComposingSpecial);
    } finally {
      sendInFlightRef.current = false;
      // No need to restore spinner here; user can continue typing next message
    }
  }, [
    sendInFlightRef,
    trimmedMessageValue,
    editingMessageInfo,
    cancelEditingMessage,
    isOffline,
    canAttemptSend,
    selectedTeamMember,
    effectiveUser?.email,
    user?.email,
    clearInputField,
    editChatMessage,
    setMessage,
    message,
    showSpecialCommand,
    isComposingSpecial,
    effectiveUserEmail,
    selectedMemberEmail,
    handleRichTextInput,
    handleStickerSelect,
    isAtBottomRef,
    scrollToBottom,
    sendMessage,
    sendMessageNotification,
    hasEditedMessageChanged,
  ]);

  const handleTyping = useCallback((text: string) => {
    if (text === latestMessageRef.current) {
      return;
    }

    // Only update input; conversion to sticker happens on send
    setMessage(text);
    latestMessageRef.current = text;
    
    // Check for /special command
    if (text.startsWith('/special')) {
      if (text === '/special') {
        setShowSpecialCommand(true);
        setIsComposingSpecial(false);
      } else if (text.startsWith('/special ')) {
        setShowSpecialCommand(false);
        setIsComposingSpecial(true);
      } else {
        setShowSpecialCommand(false);
        setIsComposingSpecial(false);
      }
    } else {
      setShowSpecialCommand(false);
      setIsComposingSpecial(false);
    }
    
    // Calculate height based on text content for better responsiveness
    const lineHeight = 20; // Approximate line height
    const padding = 20; // Top and bottom padding
    const lines = text.split('\n').length;
    const estimatedHeight = Math.max(40, Math.min(120, (lines * lineHeight) + padding));
    setInputHeight(estimatedHeight);
    
    // Remember the height when user is actively typing (non-empty text)
    // Reset to minimum height if user manually clears all text
    if (text.trim().length > 0) {
      setLastTypingHeight(estimatedHeight);
    } else if (text.length === 0) {
      setLastTypingHeight(40);
    }

    if (!effectiveUserEmail || !selectedMemberEmail) {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      return;
    }
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    chatService.setTypingStatus(effectiveUserEmail, selectedMemberEmail, true);

    typingTimeoutRef.current = setTimeout(() => {
      chatService.setTypingStatus(effectiveUserEmail, selectedMemberEmail, false);
      typingTimeoutRef.current = null;
    }, 1000);
  }, [effectiveUserEmail, selectedMemberEmail]);

  // Handle special command selection
  const handleSpecialCommandSelect = useCallback(() => {
    setMessage('/special ');
    latestMessageRef.current = '/special ';
    setShowSpecialCommand(false);
    setIsComposingSpecial(true);
  }, []);

  const resetFilePreviewModal = useCallback(() => {
    setFilePreviewVisible(false);
    setSelectedFiles([]);
    selectedFilesRef.current = [];
    setSkippedPreviewFiles([]);
  }, []);

  // Android hardware back handling: close overlays first, otherwise go from chat detail back to chat list
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (emojiPickerVisible) { closeEmojiPicker(); return true; }
        if (stickerGifPickerVisible) { closeStickerGifPicker(); return true; }
        if (attachmentModalVisible) { closeAttachmentModal(); return true; }
        if (imageViewerVisible) { setImageViewerVisible(false); return true; }
        if (filePreviewVisible) { resetFilePreviewModal(); return true; }
        if (chatProfileModalVisible) { setChatProfileModalVisible(false); return true; }
        if (selectedTeamMember) { Keyboard.dismiss(); setSelectedTeamMember(null); return true; }
        return false;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => sub.remove();
    }, [
      emojiPickerVisible,
      stickerGifPickerVisible,
      attachmentModalVisible,
      imageViewerVisible,
      filePreviewVisible,
      chatProfileModalVisible,
      selectedTeamMember,
      closeStickerGifPicker,
      closeAttachmentModal,
      closeEmojiPicker,
      resetFilePreviewModal,
    ])
  );

  // Handle input height change for auto-expanding text input (secondary fallback)
  const handleInputSizeChange = (event: any) => {
    const { height } = event.nativeEvent.contentSize;
    const newHeight = Math.max(40, Math.min(120, height)); // Min 40px, max 120px
    setInputHeight(newHeight);
    
    // If the input has content, remember this height
    // Reset to minimum height if user manually clears all text
    if (message.trim().length > 0) {
      setLastTypingHeight(newHeight);
    } else if (message.length === 0) {
      // User manually cleared input - reset to minimum height
      setLastTypingHeight(40);
    }
  };

  const buildWebDroppedFiles = useCallback(async (droppedFiles: any): Promise<any[]> => {
    const items = Array.from(droppedFiles || []);
    const mapped = await Promise.all(
      items.map(async (file: any) => {
        if (!file) {
          return null;
        }

        const fileName = String(file?.name || 'file');
        const mimeType = String(file?.type || '');
        const isLikelyImage =
          mimeType.toLowerCase().startsWith('image/') ||
          /\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif|tif|tiff|ico)$/i.test(fileName);

        const objectUrl =
          typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : null;

        let previewUri: string | null = null;
        if (isLikelyImage && typeof FileReader !== 'undefined') {
          try {
            previewUri = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            });
          } catch {
            previewUri = null;
          }
        }

        const uri = objectUrl || previewUri;
        if (typeof uri !== 'string' || uri.length === 0) {
          return null;
        }

        return {
          uri,
          previewUri: previewUri || undefined,
          name: fileName,
          fileName,
          type: mimeType,
          mimeType,
          fileSize: file?.size,
          size: file?.size,
          lastModified: Number(file?.lastModified || 0) || undefined,
        };
      })
    );

    return mapped.filter((entry): entry is any => Boolean(entry));
  }, []);

  const getPreviewFileIdentity = useCallback((file: any) => {
    const fileName = String(file?.fileName || file?.name || '').trim().toLowerCase();
    const fileSize = Number(file?.fileSize || file?.size || 0);
    const lastModified = Number(file?.lastModified || 0);
    return `${fileName}|${fileSize}|${lastModified}`;
  }, []);

  const previewSelectedFiles = useCallback((files: any[], initialSkipped: string[] = []) => {
    if (!Array.isArray(files) || files.length === 0) {
      const normalizedInitial = Array.from(new Set((initialSkipped || []).filter(Boolean))).slice(0, MAX_SKIPPED_PREVIEW_ITEMS);
      setSkippedPreviewFiles(normalizedInitial);
      if (normalizedInitial.length > 0) {
        setFilePreviewVisible(true);
      }
      return;
    }

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const oversizedFiles = files.filter((file) => {
      const fileSize = file?.fileSize || file?.size || 0;
      return fileSize > MAX_FILE_SIZE;
    });

    const allowedFiles = files.filter((file) => {
      const fileSize = file?.fileSize || file?.size || 0;
      return fileSize <= MAX_FILE_SIZE;
    });

    const skippedEntries: string[] = [...(initialSkipped || [])];

    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles
        .map((file) => file?.fileName || file?.name || 'Unknown file')
        .join(', ');
      skippedEntries.push(
        ...oversizedFiles.map((file) => `[Too large] ${file?.fileName || file?.name || 'Unknown file'}`)
      );
      Toast.show({
        type: 'error',
        text1: 'File Too Large',
        text2: `The following file(s) exceed the 50 MB limit: ${fileNames}`,
        position: 'top',
      });
    }

    const currentSelected = selectedFilesRef.current || [];
    const existing = new Set(currentSelected.map((file: any) => getPreviewFileIdentity(file)));
    const skippedNames: string[] = [];
    const toAdd: any[] = [];

    for (const file of allowedFiles) {
      const fileName = String(file?.fileName || file?.name || 'Unknown file');
      const dedupeKey = getPreviewFileIdentity(file);
      if (existing.has(dedupeKey)) {
        skippedNames.push(fileName);
        continue;
      }
      existing.add(dedupeKey);
      toAdd.push(file);
    }

    const addedCount = toAdd.length;
    const nextSelected = addedCount > 0 ? [...currentSelected, ...toAdd] : currentSelected;
    setSelectedFiles(nextSelected);
    selectedFilesRef.current = nextSelected;

    skippedEntries.push(...skippedNames.map((name) => `[Duplicate] ${name}`));
    const normalizedSkipped = Array.from(new Set(skippedEntries.filter(Boolean))).slice(0, MAX_SKIPPED_PREVIEW_ITEMS);
    setSkippedPreviewFiles(normalizedSkipped);

    if (addedCount > 0 || normalizedSkipped.length > 0) {
      setFilePreviewVisible(true);
    }
  }, [MAX_SKIPPED_PREVIEW_ITEMS, getPreviewFileIdentity]);

  const groupedSkippedPreviewFiles = useMemo(() => {
    const groups: Record<'folder' | 'duplicate' | 'tooLarge' | 'other', string[]> = {
      folder: [],
      duplicate: [],
      tooLarge: [],
      other: [],
    };

    for (const rawEntry of skippedPreviewFiles) {
      const entry = String(rawEntry || '').trim();
      if (!entry) {
        continue;
      }
      const match = entry.match(/^\[(.*?)\]\s*(.*)$/);
      const label = (match?.[1] || '').toLowerCase();
      const value = (match?.[2] || entry).trim();

      if (label === 'folder') {
        groups.folder.push(value);
      } else if (label === 'duplicate') {
        groups.duplicate.push(value);
      } else if (label === 'too large') {
        groups.tooLarge.push(value);
      } else {
        groups.other.push(entry);
      }
    }

    return groups;
  }, [skippedPreviewFiles]);

  const handleChatPageDragOver = useCallback((event: any) => {
    if (Platform.OS !== 'web' || !selectedTeamMember) {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!isChatDropActive) {
      setIsChatDropActive(true);
    }
  }, [isChatDropActive, selectedTeamMember]);

  const handleChatPageDragLeave = useCallback((event: any) => {
    if (Platform.OS !== 'web') {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setIsChatDropActive(false);
  }, []);

  const handleChatPageDrop = useCallback(async (event: any) => {
    if (Platform.OS !== 'web') {
      return;
    }

    event?.preventDefault?.();
    event?.stopPropagation?.();
    setIsChatDropActive(false);

    if (!selectedTeamMember) {
      Toast.show({
        type: 'info',
        text1: 'Select a Chat',
        text2: 'Choose a team member before dropping files.',
        position: 'top',
      });
      return;
    }

    if (isOffline) {
      Toast.show({
        type: 'info',
        text1: 'Offline',
        text2: 'You cannot send files while offline. Please reconnect to the internet and try again.',
        position: 'top',
      });
      return;
    }

    const folderNames = Array.from(event?.nativeEvent?.dataTransfer?.items || event?.dataTransfer?.items || [])
      .map((item: any) => item?.webkitGetAsEntry?.())
      .filter((entry: any) => Boolean(entry?.isDirectory))
      .map((entry: any) => String(entry?.name || 'Folder'));

    if (folderNames.length > 0) {
      const message = 'Folder upload is not supported in chat. Please drop files directly.';
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(message);
      } else {
        Alert.alert('Folder Not Supported', message);
      }
      Toast.show({
        type: 'error',
        text1: 'Folder Not Supported',
        text2: message,
        position: 'top',
      });
      const skippedFolders = folderNames.map((name) => `[Folder] ${name}`);
      previewSelectedFiles([], skippedFolders);
      return;
    }

    const droppedFiles = event?.nativeEvent?.dataTransfer?.files || event?.dataTransfer?.files;
    if (!droppedFiles || droppedFiles.length === 0) {
      return;
    }

    const files = await buildWebDroppedFiles(droppedFiles);

    previewSelectedFiles(files);
  }, [buildWebDroppedFiles, isOffline, previewSelectedFiles, selectedTeamMember]);

  useEffect(() => {
    if (!selectedTeamMember) {
      setIsChatDropActive(false);
    }
  }, [selectedTeamMember]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !isFocused) {
      return;
    }

    const markDragging = (event: any) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (!selectedTeamMember) {
        return;
      }
      setIsChatDropActive(true);
      if (event?.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    };

    const clearDragging = (event: any) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (!selectedTeamMember) {
        return;
      }
      setIsChatDropActive(false);
    };

    const handleWindowDrop = async (event: any) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (!selectedTeamMember) {
        Toast.show({
          type: 'info',
          text1: 'Select a Chat',
          text2: 'Choose a team member before dropping files.',
          position: 'top',
        });
        return;
      }
      setIsChatDropActive(false);

      const folderNames = Array.from(event?.dataTransfer?.items || [])
        .map((item: any) => item?.webkitGetAsEntry?.())
        .filter((entry: any) => Boolean(entry?.isDirectory))
        .map((entry: any) => String(entry?.name || 'Folder'));

      if (folderNames.length > 0) {
        const message = 'Folder upload is not supported in chat. Please drop files directly.';
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
          window.alert(message);
        } else {
          Alert.alert('Folder Not Supported', message);
        }
        Toast.show({
          type: 'error',
          text1: 'Folder Not Supported',
          text2: message,
          position: 'top',
        });
        const skippedFolders = folderNames.map((name) => `[Folder] ${name}`);
        previewSelectedFiles([], skippedFolders);
        return;
      }

      if (isOffline) {
        Toast.show({
          type: 'info',
          text1: 'Offline',
          text2: 'You cannot send files while offline. Please reconnect to the internet and try again.',
          position: 'top',
        });
        return;
      }

      const droppedFiles = event?.dataTransfer?.files;
      if (!droppedFiles || droppedFiles.length === 0) {
        return;
      }

      const files = await buildWebDroppedFiles(droppedFiles);

      previewSelectedFiles(files);
    };

    window.addEventListener('dragenter', markDragging);
    window.addEventListener('dragover', markDragging);
    window.addEventListener('dragleave', clearDragging);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragenter', markDragging);
      window.removeEventListener('dragover', markDragging);
      window.removeEventListener('dragleave', clearDragging);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [buildWebDroppedFiles, isFocused, isOffline, previewSelectedFiles, selectedTeamMember]);

  const handleFileSelection = async (type: 'image' | 'camera' | 'document' | 'video' | 'videoCamera') => {
  closeAttachmentModal();
    
    // Check if offline
    if (isOffline) {
      Toast.show({
          type: 'info',
        text1: 'Offline',
        text2: 'You cannot send files while offline. Please reconnect to the internet and try again.',
        position: 'top',
      });
      return;
    }

    try {
      let result = null;
      
      if (type === 'image') {
        result = await MediaPickerUtil.selectImage(true); // Allow multiple selection
      } else if (type === 'camera') {
        result = await MediaPickerUtil.captureImageNoEdit();
      } else if (type === 'video') {
        result = await MediaPickerUtil.selectVideo(true); // Allow multiple selection
      } else if (type === 'videoCamera') {
        result = await MediaPickerUtil.captureVideo();
      } else if (type === 'document') {
        result = await MediaPickerUtil.selectDocument('*/*', true); // Allow multiple selection
      }
      
      // Handle both expo image picker format and web format
      if (result && selectedTeamMember) {
        const resultObj = result as any;
        let files: any[] = [];
        
        // Check if it's expo format (has 'canceled' property)
        if (resultObj.canceled === false && resultObj.assets && resultObj.assets.length > 0) {
          files = resultObj.assets;
        }
        // Check if it's document picker format (has 'type' property)
        else if (resultObj.type === 'success') {
          if (resultObj.files) {
            // Multiple files from web
            files = resultObj.files;
          } else {
            // Single file
            files = [{
              uri: resultObj.uri,
              name: resultObj.name,
              fileName: resultObj.name,
              mimeType: resultObj.mimeType,
              fileSize: resultObj.size
            }];
          }
        }
        // Check if it's web format (has uri directly)
        else if (resultObj.uri) {
          files = [resultObj];
        }
        
        if (files.length > 0) {
          previewSelectedFiles(files);
        }
      }
    } catch (error: any) {
      // Show error toast for camera capture on web, do not fallback to image selection
      if (
        typeof error?.message === 'string' &&
        error.message.includes('Camera capture is not available on web')
      ) {
        Toast.show({
          type: 'error',
          text1: 'Camera Not Available',
          text2: 'Camera capture is not available on web. Please use image selection instead.',
          position: 'top',
        });
        return;
      }
      
      // Special handling for different error types
      if (error.message?.includes('Permission')) {
        Toast.show({
          type: 'error',
          text1: 'Permission Required',
          text2: `Permission to access ${type === 'camera' ? 'camera' : type === 'image' ? 'photo library' : 'files'} is required.`,
          position: 'top',
        });
        return;
      }
      
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: error?.message || 'An error occurred while selecting file.',
        position: 'top',
      });
    }
  };

  const handleSendWithFiles = async () => {
    if (!selectedTeamMember || selectedFiles.length === 0) return;
    
    setIsUploading(true);
    setUploadProgress(0);
  const tempId = `pa_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
      // Create optimistic pending attachment bubble
      setPendingAttachments(prev => {
        const next = new Map(prev);
        next.set(tempId, {
          id: tempId,
          files: selectedFiles.map(f => ({
            uri: f.uri,
            fileName: f.fileName || f.name || 'file',
            fileType: f.mimeType || 'application/octet-stream',
            fileSize: f.fileSize || f.size,
          })),
          messageText: message.trim(),
          recipientId: selectedTeamMember.id,
          sender: effectiveUser?.email || '',
          status: 'sending',
          progress: 0,
          cancelable: false,
          cancelRequested: false,
          failureReason: undefined,
        });
        return next;
      });

      // Prepare files for batch upload
      const filesToUpload = selectedFiles.map(file => ({
        uri: file.uri,
        fileName: file.fileName || file.name || 'file',
        fileType: file.mimeType || 'application/octet-stream',
        fileSize: file.fileSize || file.size,
      }));

      // Upload all files in a single message with progress tracking
      await sendMessageWithFiles(
        message.trim(), // Send the message text with all files
        filesToUpload,
        selectedTeamMember.id,
        (progress) => {
          setUploadProgress(progress);
          // Update optimistic per-bubble overlay progress
          setPendingAttachments(prev => {
            const next = new Map(prev);
            const cur = next.get(tempId);
            if (cur && cur.status === 'sending') {
              next.set(tempId, { ...cur, progress });
            }
            return next;
          });
        },
        {
          registerCancel: (cancelFn) => {
            attachmentUploadCancelMap.current.set(tempId, cancelFn);
            setPendingAttachments(prev => {
              const next = new Map(prev);
              const cur = next.get(tempId);
              if (cur) {
                next.set(tempId, { ...cur, cancelable: true, cancelRequested: false });
              }
              return next;
            });
          },
        }
      );
      
      // Clear message and files after sending
      clearInputField(); // Use helper function to clear input
      resetFilePreviewModal();
      attachmentUploadCancelMap.current.delete(tempId);
      setPendingAttachments(prev => {
        const next = new Map(prev);
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            status: 'finalizing',
            progress: 100,
            cancelable: false,
            cancelRequested: false,
          });
        } else {
          next.delete(tempId);
        }
        return next;
      });

      scheduleAttachmentFinalizeCleanup(tempId);
      attachmentUploadCancelMap.current.delete(tempId);
      
      Toast.show({
        type: 'success',
        text1: 'Files Sent',
        text2: `Successfully sent ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`,
        position: 'top',
      });
      
    } catch (error) {
  clearAttachmentFinalizeTimer(tempId);
  attachmentUploadCancelMap.current.delete(tempId);
      // Mark pending optimistic bubble as failed
      setPendingAttachments(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) {
          next.set(tempId, {
            ...cur,
            status: 'failed',
            progress: 0,
            cancelable: false,
            cancelRequested: false,
            failureReason: error instanceof ChatUploadCanceledError ? 'canceled' : 'error',
          });
        }
        return next;
      });

      if (error instanceof ChatUploadCanceledError) {
        logger.info('Attachment upload canceled by user', { tempId });
        Toast.show({
          type: 'info',
          text1: 'Upload Canceled',
          text2: 'Attachment upload was canceled.',
          position: 'top',
        });
      } else if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending files', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending more files.`,
          position: 'top',
        });
      } else {
        logger.error('Error sending files:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'Failed to send files. Please try again.',
          position: 'top',
        });
      }
    } finally {
      attachmentUploadCancelMap.current.delete(tempId);
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const markNetworkError = useCallback((url: string) => {
    if (!url || !/^https?:\/\//i.test(url)) {
      return;
    }
    setNetworkErrorUrls(prev => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const clearNetworkError = useCallback((url: string) => {
    if (!url) return;
    setNetworkErrorUrls(prev => {
      if (!prev.has(url)) return prev;
      const next = new Set(prev);
      next.delete(url);
      return next;
    });
  }, []);

  const getDownloadKey = useCallback((url?: string) => (url || '').trim(), []);

  const handleDownloadFile = async (fileUrl: string, fileName: string, localHint?: string) => {
    const downloadKey = getDownloadKey(fileUrl);
    if (!downloadKey) return;

    if (downloadingUrlsRef.current.has(downloadKey)) {
      Toast.show({
        type: 'info',
        text1: 'Download in progress',
        text2: 'Please wait for the current download to finish.',
        position: 'top',
      });
      return;
    }

    downloadingUrlsRef.current.add(downloadKey);
    setDownloadState(downloadKey, { isDownloading: true, progress: 0 });

    // Show starting download toast notification immediately
    Toast.show({
      type: 'info',
      text1: 'Starting download, please wait...',
      text2: `Preparing ${fileName} for download`,
      position: 'top',
    });

    try {
      let effectiveUrl = fileUrl;
      const trimmedHint = localHint?.trim();
      const safeLocalHint =
        trimmedHint && trimmedHint.startsWith('file://') && !trimmedHint.toLowerCase().includes('/chat-media-previews/')
          ? trimmedHint
          : undefined;
      effectiveUrl = await chatCacheService.getMediaForDownload(fileUrl, fileName, safeLocalHint, 'high');

      if (Platform.OS === 'web') {
        // For web, check if URL is accessible first
        const isLocalWebUrl = effectiveUrl.startsWith('blob:') || effectiveUrl.startsWith('data:');
        if (!isLocalWebUrl) {
          const availability = await FileDownloadUtil.checkFileAvailability(effectiveUrl, { timeoutMs: 5000 });
          if (availability === 'missing') {
            setBrokenFileUrls(prev => new Set([...prev, fileUrl]));
            clearNetworkError(fileUrl);
            Toast.show({
              type: 'error',
              text1: 'File Not Available',
              text2: 'This file has been deleted or is no longer accessible.',
              position: 'top',
            });
            return;
          }
        }
        
        // Use the new download utility that handles CORS properly
        await FileDownloadUtil.downloadFileWithProgress(effectiveUrl, fileName, (percent) => {
          setDownloadState(downloadKey, { isDownloading: true, progress: percent });
        });

        clearNetworkError(fileUrl);
        
        Toast.show({
          type: 'success',
          text1: 'Download Started',
          text2: `Downloading ${fileName}...`,
          position: 'top',
        });
      } else {
        // For mobile, load Expo modules lazily to avoid bundling on web
        const FileSystem = require('expo-file-system') as typeof import('expo-file-system');
        const Sharing = require('expo-sharing') as typeof import('expo-sharing');

        const isLocalFile = effectiveUrl.startsWith('file://');
        const downloadPath = isLocalFile
          ? effectiveUrl
          : `${FileSystem.documentDirectory}${fileName}`;
        const downloadResult = isLocalFile
          ? { status: 200, uri: effectiveUrl }
          : await FileSystem.createDownloadResumable(
              effectiveUrl,
              downloadPath,
              {},
              (progress) => {
                const total = progress.totalBytesExpectedToWrite;
                if (!total || total <= 0) {
                  return;
                }
                const pct = Math.floor((progress.totalBytesWritten / total) * 100);
                const bounded = Math.max(0, Math.min(99, pct));
                setDownloadState(downloadKey, { isDownloading: true, progress: bounded });
              }
            ).downloadAsync();

        if (!downloadResult) {
          throw new Error('Download failed');
        }

        if (downloadResult.status !== 200) {
          throw new Error('Download failed');
        }

        setDownloadState(downloadKey, { isDownloading: true, progress: 100 });

        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
          clearNetworkError(fileUrl);
          Toast.show({
            type: 'success',
            text1: 'Saved to device',
            text2: `File stored at ${downloadResult.uri}`,
            position: 'top',
          });
          return;
        }

        await Sharing.shareAsync(downloadResult.uri);
        clearNetworkError(fileUrl);
        Toast.show({
          type: 'success',
          text1: 'Download Complete',
          text2: `Downloaded ${fileName}`,
          position: 'top',
        });
      }
    } catch (error) {
      logger.error('Download error:', error);
      let availability: 'ok' | 'missing' | 'unknown' = 'unknown';
      if (Platform.OS === 'web') {
        availability = await FileDownloadUtil.checkFileAvailability(fileUrl, { timeoutMs: 5000 });
      }

      if (availability === 'missing') {
        setBrokenFileUrls(prev => new Set([...prev, fileUrl]));
        clearNetworkError(fileUrl);
        Toast.show({
          type: 'error',
          text1: 'File Not Available',
          text2: 'This file has been deleted or is no longer accessible.',
          position: 'top',
        });
        return;
      }

      markNetworkError(fileUrl);
      Alert.alert(
        'Network Error',
        'Unable to reach the file. Check your connection and try again.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Retry', onPress: () => handleDownloadFile(fileUrl, fileName, localHint) },
        ]
      );
    } finally {
      downloadingUrlsRef.current.delete(downloadKey);
      clearDownloadState(downloadKey);
    }
  };

  const handleImageView = async (imageUri: string, remoteUrl?: string, fileName?: string) => {
    const key = remoteUrl || imageUri;
    if (key && brokenFileUrls.has(key)) {
      Toast.show({
        type: 'error',
        text1: 'Image Not Available',
        text2: 'This image has been deleted or is no longer accessible.',
        position: 'top',
      });
      return;
    }

  const trimmedUri = typeof imageUri === 'string' ? imageUri.trim() : '';
  const initialUri = trimmedUri || remoteUrl;
    if (!initialUri) {
      return;
    }

    if (remoteUrl && !remoteUrl.startsWith('file://')) {
      setLastViewedRemoteImage(remoteUrl);
    } else {
      setLastViewedRemoteImage(undefined);
    }

    setSelectedImageUri(initialUri);
    setImageViewerVisible(true);

    if (!remoteUrl) {
      return;
    }

    const safeLocalHint =
      trimmedUri && trimmedUri.startsWith('file://') && !trimmedUri.toLowerCase().includes('/chat-media-previews/')
        ? trimmedUri
        : undefined;

    try {
      const localUri = await chatCacheService.getMediaForDownload(remoteUrl, fileName, safeLocalHint, 'high');
      if (localUri && localUri !== initialUri) {
        setSelectedImageUri(localUri);
      }
    } catch (error) {
      logger.warn('Failed to prepare image for viewer', error);
    }
  };

  const handleImageError = async (fileUrl: string) => {
    if (!fileUrl || fileUrl.startsWith('file://') || fileUrl.startsWith('blob:') || fileUrl.startsWith('data:')) {
      return;
    }

    const availability = await FileDownloadUtil.checkFileAvailability(fileUrl, { timeoutMs: 5000 });
    if (availability === 'missing') {
      setBrokenFileUrls(prev => new Set([...prev, fileUrl]));
      clearNetworkError(fileUrl);
      return;
    }

    if (availability === 'unknown') {
      markNetworkError(fileUrl);
    }
  };

  // Handle sticker selection and sending
  async function handleStickerSelect(sticker: {
    url: string;
    name: string;
    pack?: string;
    width?: number;
    height?: number;
  }) {
    if (!selectedTeamMember || !effectiveUser?.email) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Please select a team member to send sticker to.',
        position: 'top',
      });
      return;
    }

    // Optimistic pending sticker
    const tempId = `pm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      setPendingMedia(prev => new Map(prev).set(tempId, {
        id: tempId,
        kind: 'sticker',
        previewUri: sticker.url,
        width: sticker.width,
        height: sticker.height,
        nameOrTitle: sticker.name,
        timestamp: new Date().toISOString(),
        recipientId: selectedTeamMember.id,
        sender: effectiveUser.email,
        status: 'sending',
        source: 'picker',
      }));

      await sendSticker(sticker, selectedTeamMember.id);
      // Remove pending on success
      setPendingMedia(prev => {
        const next = new Map(prev);
        next.delete(tempId);
        return next;
      });
      
      // Send notification to recipient for sticker
      await sendMessageNotification('Sent a sticker', false, sticker);
      
      Toast.show({
        type: 'success',
        text1: '🎯 Sticker Sent',
        text2: `Sent "${sticker.name}" sticker to ${selectedTeamMember.name}`,
        position: 'top',
      });

      // Only scroll if user is at bottom
      if (isAtBottomRef.current) {
        scheduleScrollToBottom();
      } else {
        setShowScrollToBottom(true);
        setUnseenCount((c) => c + 1);
      }
    } catch (error) {
      // Mark pending as failed
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, status: 'failed' });
        return next;
      });

      if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending sticker', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending another sticker.`,
          position: 'top',
        });
      } else {
        logger.error('Error sending sticker:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'Failed to send sticker. Please try again.',
          position: 'top',
        });
      }
    }
  }

  // Handle GIF selection and sending
  const handleGifSelect = async (gif: {
    url: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    title?: string;
    source?: string;
  }) => {
    if (!selectedTeamMember || !effectiveUser?.email) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Please select a team member to send GIF to.',
        position: 'top',
      });
      return;
    }

    // Optimistic pending GIF
    const tempId = `pm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      setPendingMedia(prev => new Map(prev).set(tempId, {
        id: tempId,
        kind: 'gif',
        previewUri: gif.url,
        width: gif.width,
        height: gif.height,
        nameOrTitle: gif.title || 'GIF',
        timestamp: new Date().toISOString(),
        recipientId: selectedTeamMember.id,
        sender: effectiveUser.email,
        status: 'sending',
        source: 'picker',
      }));

      await sendGif(gif, selectedTeamMember.id);
      // Remove pending on success
      setPendingMedia(prev => {
        const next = new Map(prev);
        next.delete(tempId);
        return next;
      });
      
      // Send notification to recipient for GIF
      await sendMessageNotification('Sent a GIF', false, undefined, gif);
      
      Toast.show({
        type: 'success',
        text1: '📹 GIF Sent',
        text2: `Sent "${gif.title || 'GIF'}" to ${selectedTeamMember.name}`,
        position: 'top',
      });

      // Only scroll if user is at bottom
      if (isAtBottomRef.current) {
        scheduleScrollToBottom();
      } else {
        setShowScrollToBottom(true);
        setUnseenCount((c) => c + 1);
      }
    } catch (error) {
      // Mark pending as failed
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, status: 'failed' });
        return next;
      });

      if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending GIF', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending another GIF.`,
          position: 'top',
        });
      } else {
        logger.error('Error sending GIF:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'Failed to send GIF. Please try again.',
          position: 'top',
        });
      }
    }
  };

  // Process keyboard-provided URI into a chat message (GIF/image/sticker)
  const processKeyboardMediaUri = async (uri: string, mime?: string) => {
    if (!selectedTeamMember || !effectiveUser?.email) return;

    try {
      const kind = detectMediaTypeFromUri(uri, mime);

      if (kind === 'gif') {
        const isHttp = /^https?:\/\//i.test(uri) || uri.startsWith('content://');
        let finalUrl = uri;
        if (!isHttp) {
          const name = `kb_${Date.now()}.gif`;
          const uploaded = await chatService.uploadFile(
            uri,
            name,
            mime || 'image/gif',
            {
              senderEmail: effectiveUser.email,
              recipientEmail: selectedTeamMember.email || selectedTeamMember.id,
            }
          );
          finalUrl = uploaded.url;
        }
        const gif = { url: finalUrl, source: 'keyboard' } as const;
        await sendGif(gif, selectedTeamMember.id);
        await sendMessageNotification('Sent a GIF', false, undefined, gif as any);
        return;
      }

      if (kind === 'sticker') {
        const isHttp = /^https?:\/\//i.test(uri) || uri.startsWith('content://');
        let finalUrl = uri;
        if (!isHttp) {
          const ext = (mime && mime.split('/')[1]) || 'png';
          const name = `kb_${Date.now()}.${ext}`;
          const uploaded = await chatService.uploadFile(
            uri,
            name,
            mime || 'image/png',
            {
              senderEmail: effectiveUser.email,
              recipientEmail: selectedTeamMember.email || selectedTeamMember.id,
            }
          );
          finalUrl = uploaded.url;
        }
        const sticker = { url: finalUrl, name: 'Keyboard Sticker', pack: 'keyboard' } as const;
        await sendSticker(sticker as any, selectedTeamMember.id);
        await sendMessageNotification('Sent a sticker', false, sticker as any);
        return;
      }

      const ext = (mime && mime.split('/')[1]) || 'jpg';
      const name = `kb_${Date.now()}.${ext}`;
      const isHttp = /^https?:\/\//i.test(uri) || uri.startsWith('content://');
      let finalUrl = uri;
      if (!isHttp) {
        const uploaded = await chatService.uploadFile(
          uri,
          name,
          mime || 'image/jpeg',
          {
            senderEmail: effectiveUser.email,
            recipientEmail: selectedTeamMember.email || selectedTeamMember.id,
          }
        );
        finalUrl = uploaded.url;
      }
      const sticker = { url: finalUrl, name: 'Keyboard Sticker', pack: 'keyboard' } as const;
      await sendSticker(sticker as any, selectedTeamMember.id);
      await sendMessageNotification('Sent a sticker', false, sticker as any);
    } catch (error) {
      if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending keyboard media', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending more media.`,
          position: 'top',
        });
      } else {
        logger.error('Error processing keyboard media send:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'Failed to send media. Please try again.',
          position: 'top',
        });
      }
    }
  };

  // Check if a file URL is accessible (for web platform)
  const checkFileAvailability = async (fileUrl: string) => {
    if (Platform.OS !== 'web') return 'ok';
    return FileDownloadUtil.checkFileAvailability(fileUrl, { timeoutMs: 5000 });
  };

  // Validate file URLs when messages change (optimized to reduce console spam)
  useEffect(() => {
    if (Platform.OS === 'web' && messages.length > 0 && selectedTeamMember && effectiveUser?.email) {
      const validateFiles = async () => {
        // Only check files that haven't been checked recently
        const now = Date.now();
        
        // Filter messages to only include the current conversation
        const userEmail = effectiveUser.email.toLowerCase();
        const recipientEmail = selectedTeamMember.email.toLowerCase();
        
        const conversationMessages = messages.filter(msg => {
          const senderLower = msg.sender.toLowerCase();
          const recipientIdLower = (msg.recipientId || '').toLowerCase();
          const fromMeToThem = senderLower === userEmail && recipientIdLower === recipientEmail;
          const fromThemToMe = senderLower === recipientEmail && recipientIdLower === userEmail;
          return fromMeToThem || fromThemToMe;
        });
        
        const fileUrls = conversationMessages
          .flatMap(msg => {
            if (!Array.isArray(msg.attachments)) {
              return [];
            }
            return msg.attachments
              .map(att => att?.url)
              .filter((url): url is string => typeof url === 'string' && url.length > 0 && !brokenFileUrls.has(url));
          })
          .filter(url => {
            // Skip validation if checked within last 5 minutes
            const lastChecked = fileValidationCache.get(url);
            if (lastChecked && (now - lastChecked) < 300000) return false;
            return true;
          })
          .filter((url, index, self) => self.indexOf(url) === index); // Remove duplicates

        if (fileUrls.length === 0) return;

        // Process in smaller batches to avoid overwhelming the network
        const batchSize = 3;
        const brokenUrls: string[] = [];
        
        for (let i = 0; i < fileUrls.length; i += batchSize) {
          const batch = fileUrls.slice(i, i + batchSize);
          
          const results = await Promise.allSettled(
            batch.map(async (url) => {
              const availability = await checkFileAvailability(url);
              if (availability !== 'unknown') {
                fileValidationCache.set(url, now); // Cache ok/missing checks
              }
              return { url, availability };
            })
          );

          results.forEach(result => {
            if (result.status !== 'fulfilled') return;
            if (result.value.availability === 'missing') {
              brokenUrls.push(result.value.url);
              return;
            }
            if (result.value.availability === 'ok') {
              clearNetworkError(result.value.url);
            }
          });

          // Small delay between batches to be nice to the server
          if (i + batchSize < fileUrls.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        if (brokenUrls.length > 0) {
          setBrokenFileUrls(prev => new Set([...prev, ...brokenUrls]));
        }
      };

      // Debounce the validation to avoid too many requests
      const timeout = setTimeout(validateFiles, 2000);
      return () => clearTimeout(timeout);
    }
  }, [messages, brokenFileUrls, selectedTeamMember?.email, effectiveUser?.email, clearNetworkError]);

  const removeSelectedFile = (index: number) => {
    const newFiles = selectedFiles.filter((_, i) => i !== index);
    setSelectedFiles(newFiles);
    selectedFilesRef.current = newFiles;
    if (newFiles.length === 0) {
      resetFilePreviewModal();
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // Animated wrapper component for messages
  const AnimatedMessageWrapper = React.memo(function AnimatedMessageWrapper({
    children, 
    isNewMessage, 
    messageId,
    isIncomingMessage = false 
  }: { 
    children: React.ReactNode; 
    isNewMessage: boolean; 
    messageId: string;
    isIncomingMessage?: boolean;
  }) {
    const fadeAnim = useRef(new Animated.Value(1)).current; // Start as visible
    const slideAnim = useRef(new Animated.Value(0)).current; // Start in position
    const scaleAnim = useRef(new Animated.Value(1)).current; // Start at normal size

    useEffect(() => {
      // Check if this message should be animated
      if (isNewMessage && !globalAnimatedMessages.current.has(messageId)) {
        globalAnimatedMessages.current.add(messageId);
        
        // Reset animation values for entrance animation
        fadeAnim.setValue(0);
        slideAnim.setValue(50);
        scaleAnim.setValue(0.8);
        
        // Only play sound for incoming messages (not your own messages)
        if (isIncomingMessage && isFocused) {
          playMessageSound();
        }
        
        // Animate the message entrance
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 450,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 350,
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]).start();
      }
    }, [isNewMessage, messageId, fadeAnim, slideAnim, scaleAnim, isIncomingMessage, isFocused]);

    return (
      <Animated.View
        style={{
          opacity: fadeAnim,
          transform: [
            { translateY: slideAnim },
            { scale: scaleAnim }
          ],
        }}
      >
        {children}
      </Animated.View>
    );
  });

  AnimatedMessageWrapper.displayName = 'AnimatedMessageWrapper';

  const MessageRow = React.memo(({ item }: { item: any }) => {
    const messageId = typeof item?.id === 'string' ? item.id : String(item?.id ?? '');
    const uiState = useMessageUiState(messageId);
    const renderedMessage = renderMessage(item, uiState.reactions, uiState.isEditing);
    if (typeof renderedMessage === 'string') {
      logger.warn('⚠️ renderMessage returned string:', JSON.stringify(renderedMessage));
      logger.warn('⚠️ Message object:', JSON.stringify(item, null, 2));
      return null;
    }
    return renderedMessage;
  });

  MessageRow.displayName = 'MessageRow';

  const renderMessage = (
    msg: any,
    reactionsOverride?: { [key: string]: Set<string> },
    isEditingOverride?: boolean
  ) => {
    // Defensive check for message validity
    if (!msg || !msg.id) {
      logger.warn('Invalid message object:', msg);
      return null;
    }
    
    // Use effectiveUser for proper message alignment
    const msgSenderLower = (msg.sender || '').toLowerCase().trim();
    const userEmailLower = (effectiveUser?.email || '').toLowerCase().trim();
    const isOwnMessage = msgSenderLower === userEmailLower;

    // Simple animation state check (no useMemo in render functions)
    const isNewMessage = animatedMessages.has(msg.id);
    const actionPending = isMessageActionPending(msg.id);
    const wasEdited = Boolean((msg.editCount && msg.editCount > 0) || msg.editedAt);
    const isEditingTarget = typeof isEditingOverride === 'boolean'
      ? isEditingOverride
      : editingMessageInfo?.id === normalizeMessageId(msg.id);
    const pendingOverlay = actionPending ? (
      <View
        style={[
          styles.messagePendingOverlay,
          { backgroundColor: isOwnMessage ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.25)', pointerEvents: 'none' },
        ]}
      >
        <ActivityIndicator size="small" color="#ffffff" />
        <Text style={styles.messagePendingText}>Removing…</Text>
      </View>
    ) : null;

    const hasAttachmentContent = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    const attachmentsHydrating = !hasAttachmentContent && (
      Boolean(msg.hasAttachments) ||
      (typeof msg.attachmentCount === 'number' && msg.attachmentCount > 0)
    );
    const shouldRenderAttachmentSection = hasAttachmentContent || attachmentsHydrating;
    const attachmentHydrationLabel = (() => {
      if (!attachmentsHydrating) {
        return '';
      }
      const count = typeof msg.attachmentCount === 'number' ? msg.attachmentCount : null;
      if (count && count > 0) {
        return `Loading ${count} attachment${count > 1 ? 's' : ''}...`;
      }
      return 'Loading attachments...';
    })();
    const skeletonBackgroundColor = isOwnMessage ? 'rgba(255, 255, 255, 0.12)' : theme.surface;
    const skeletonBorderColor = isOwnMessage ? 'rgba(255, 255, 255, 0.25)' : theme.border;
    const skeletonTextColor = isOwnMessage ? 'rgba(255, 255, 255, 0.95)' : theme.text;
    const skeletonSubtextColor = isOwnMessage ? 'rgba(255, 255, 255, 0.7)' : theme.textSecondary;

    if (msg.deleted) {
      const deletedTimestamp = msg.deletedAt || msg.timestamp;
      const deletedBubbleThemeStyle = isDarkMode
        ? styles.deletedMessageBubbleOwn
        : styles.deletedMessageBubbleFriend;
      const deletedMessageTextThemeStyle = isDarkMode
        ? styles.deletedMessageTextOwn
        : { color: theme.textSecondary };
      const deletedTimestampThemeStyle = isDarkMode
        ? styles.ownMessageTime
        : [styles.friendMessageTime, { color: theme.textSecondary }];
      const deletedIconColor = isDarkMode ? 'rgba(255, 255, 255, 0.75)' : theme.textSecondary;

      return (
        <AnimatedMessageWrapper
          key={`deleted-${msg.id}`}
          isNewMessage={isNewMessage}
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
        >
          <View
            key={`deleted-view-${msg.id}`}
            style={[
              styles.messageContainer,
              isOwnMessage ? styles.ownMessage : styles.friendMessage,
              styles.deletedMessageContainer,
            ]}
          >
            <View
              style={[
                styles.deletedMessageBubble,
                deletedBubbleThemeStyle,
              ]}
            >
              <View style={styles.deletedMessageContent}>
                <Trash2
                  size={16}
                  color={deletedIconColor}
                  style={{ marginRight: 6 }}
                />
                <Text
                  style={[
                    styles.deletedMessageText,
                    deletedMessageTextThemeStyle,
                  ]}
                >
                  Message removed
                </Text>
              </View>
              <Text
                style={[
                  styles.deletedMessageTime,
                  deletedTimestampThemeStyle,
                ]}
              >
                {formatMessageTimestamp(deletedTimestamp)}
              </Text>
            </View>
          </View>
        </AnimatedMessageWrapper>
      );
    }
    
    if (msg.isSpecial) {
      const senderName = isOwnMessage ? 'You' : selectedTeamMember?.name || 'Someone';
      
      return (
        <AnimatedMessageWrapper 
          key={`special-${msg.id}`}
          isNewMessage={isNewMessage} 
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
        >
          <View key={msg.id} style={styles.specialMessageContainer}>
            <View
              style={[
                styles.specialMessageBubble,
                styles.messageActionAnchor,
                { backgroundColor: theme.surface, borderColor: theme.warning },
              ]}
            >
              <View style={styles.specialMessageHeader}>
                <Star size={20} color={theme.warning} />
                <Text style={[styles.specialMessageTitle, { color: theme.warning }]}>
                  Special Message from {senderName || 'Unknown User'}
                </Text>
                <Star size={20} color={theme.warning} />
              </View>
              <StyledText
                text={(() => {
                  const safeText = String(msg.text || '');
                  // Prevent periods or empty text from being rendered
                  if (!safeText || safeText.trim() === '.' || safeText.trim().length === 0) {
                    return 'Special message';
                  }
                  return safeText;
                })()}
                style={[styles.specialMessageText, { color: theme.text }]}
                linkStyle={{
                  color: theme.primary,
                  fontWeight: '600'
                }}
              />
              <Text style={[styles.specialMessageTime, { color: theme.textSecondary }]}>
                {formatMessageTimestamp(msg.timestamp)}
              </Text>
              <View style={styles.specialReactions}>
                <TouchableOpacity 
                  style={[
                    styles.reactionButton, 
                    { backgroundColor: theme.background },
                    shouldGlow(msg.id, 'heart') && styles.glowingReaction
                  ]}
                  onPress={() => handleReaction(msg.id, 'heart')}
                >
                  <Heart 
                    size={20} 
                    color={getReactionStatus(msg.id, 'heart').hasUserReacted ? '#ef4444' : theme.textSecondary}
                  />
                  {getReactionStatus(msg.id, 'heart', reactionsOverride).count > 0 && (
                    <Text style={[styles.reactionCount, { color: theme.text }]}>
                      {getReactionStatus(msg.id, 'heart', reactionsOverride).count}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[
                    styles.reactionButton, 
                    { backgroundColor: theme.background },
                    shouldGlow(msg.id, 'star') && styles.glowingReaction
                  ]}
                  onPress={() => handleReaction(msg.id, 'star')}
                >
                  <Star 
                    size={20} 
                    color={getReactionStatus(msg.id, 'star').hasUserReacted ? '#fbbf24' : theme.textSecondary}
                  />
                  {getReactionStatus(msg.id, 'star', reactionsOverride).count > 0 && (
                    <Text style={[styles.reactionCount, { color: theme.text }]}>
                      {getReactionStatus(msg.id, 'star', reactionsOverride).count}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[
                    styles.reactionButton, 
                    { backgroundColor: theme.background },
                    shouldGlow(msg.id, 'smile', reactionsOverride) && styles.glowingReaction
                  ]}
                  onPress={() => handleReaction(msg.id, 'smile')}
                >
                  <Smile 
                    size={20} 
                    color={getReactionStatus(msg.id, 'smile', reactionsOverride).hasUserReacted ? '#1e1c1cff' : theme.textSecondary}
                  />
                  {getReactionStatus(msg.id, 'smile', reactionsOverride).count > 0 && (
                    <Text style={[styles.reactionCount, { color: theme.text }]}>
                      {getReactionStatus(msg.id, 'smile', reactionsOverride).count}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
              
              {/* Profile pictures of users who reacted */}
              <View style={styles.reactionProfilePics}>
                {['heart', 'star', 'smile']
                  .filter((reactionType) => {
                    const reactionStatus = getReactionStatus(
                      msg.id,
                      reactionType as 'heart' | 'star' | 'smile',
                      reactionsOverride
                    );
                    return reactionStatus.count > 0;
                  })
                  .map((reactionType) => {
                  const reactionStatus = getReactionStatus(
                    msg.id,
                    reactionType as 'heart' | 'star' | 'smile',
                    reactionsOverride
                  );
                  
                  return (
                    <View key={reactionType} style={styles.reactionTypeContainer}>
                      <View style={styles.reactionIcon}>
                        {reactionType === 'heart' ? <Heart size={12} color="#ef4444" /> : reactionType === 'star' ? <Star size={12} color="#fbbf24" /> : reactionType === 'smile' ? <Smile size={12} color="#8b5cf6" /> : null}
                      </View>
                      <View style={styles.profilePicsRow}>
                        {Array.isArray(reactionStatus.users) && reactionStatus.users
                          .slice(0, 3)
                          .filter((userEmail) => userEmail && typeof userEmail === 'string')
                          .map((userEmail, index) => {
                          // Find the team member for this email
                          const teamMember = teamMembers.find(member => 
                            member.email && member.email.toLowerCase() === userEmail.toLowerCase()
                          );
                          const profileUrl = getProfilePictureURL(teamMember);
                          
                          return (
                            <View 
                              key={`${userEmail}-${index}`} 
                              style={[
                                styles.miniProfilePic,
                                { marginLeft: index > 0 ? -6 : 0 }
                              ]}
                            >
                              {profileUrl ? (
                                <Image 
                                  source={{ uri: profileUrl }} 
                                  style={styles.miniProfilePicImage}
                                />
                              ) : (
                                <View style={[styles.miniProfilePicPlaceholder, { backgroundColor: theme.primary }]}>
                                  <Text style={styles.miniProfilePicText}>
                                    {(() => {
                                      const rawName = teamMember?.name || userEmail || 'U';
                                      const safeName = String(rawName).trim();
                                      if (!safeName) return 'U';
                                      const firstChar = safeName.charAt(0).toUpperCase();
                                      // Ensure we never return problematic characters like periods
                                      if (/^[A-Z0-9]$/i.test(firstChar)) {
                                        return firstChar;
                                      }
                                      return 'U';
                                    })()}
                                  </Text>
                                </View>
                              )}
                            </View>
                          );
                        })}
                        {reactionStatus.count > 3 && (
                          <View style={[styles.miniProfilePic, styles.miniProfilePicMore]}>
                            <Text style={[styles.miniProfilePicText, { color: theme.text }]}>
                              +{reactionStatus.count - 3}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          </View>
        </AnimatedMessageWrapper>
      );
    }

    // Handle sticker messages
    if (msg.sticker) {
      return (
        <AnimatedMessageWrapper 
          key={`sticker-${msg.id}`}
          isNewMessage={isNewMessage} 
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
        >
          <View
            key={msg.id}
            style={[
              styles.messageContainer,
              isOwnMessage ? styles.ownMessage : styles.friendMessage,
            ]}
          >
            <TouchableOpacity
              style={[
                styles.stickerContainer,
                styles.messageActionAnchor,
                isOwnMessage ? styles.ownSticker : styles.friendSticker
              ]}
              onLongPress={(event) => handleMessageLongPress(msg.id, event)}
              onPress={() => {
                const now = Date.now();
                const lastTap = msg.lastTap || 0;
                const timeDiff = now - lastTap;
                
                if (timeDiff < 300) {
                  // Double tap detected - add reaction and prevent image view
                  handleQuickReaction(msg.id);
                  msg.lastTap = 0; // Reset to prevent triple tap issues
                } else {
                  // Single tap - set timestamp and delay image view to check for double tap
                  msg.lastTap = now;
                  setTimeout(() => {
                    // Do not open stickers in full screen per request
                  }, 300);
                }
              }}
              delayLongPress={500}
              disabled={actionPending}
            >
              {(() => {
                const originalUrl = msg.sticker.url;
                const displayUrl = Platform.OS === 'web' ? originalUrl : (stickerUrlMap.get(originalUrl) || originalUrl);
                const isBroken = brokenFileUrls.has(displayUrl);
                const isSystemNoUrl = (msg.sticker.pack === 'system' && !originalUrl);
                return isBroken || isSystemNoUrl;
              })() ? (
                // Show emoji text for system emoji stickers or placeholder for broken stickers
                msg.sticker.pack === 'system' ? (
                  <View style={styles.emojiStickerContainer}>
                    <Text style={[
                      styles.emojiStickerText,
                      {
                        fontSize: Math.min(msg.sticker.width || 100, 100) * 0.8, // Scale emoji based on size
                      }
                    ]}>
                      {msg.sticker.name}
                    </Text>
                  </View>
                ) : (
                  <View style={[styles.deletedStickerPlaceholder, { backgroundColor: theme.background, borderColor: theme.border }]}>
                    <AlertCircle size={32} color={theme.textSecondary} />
                    <Text style={[styles.deletedStickerText, { color: theme.textSecondary }]}>
                      Sticker unavailable
                    </Text>
                  </View>
                )
              ) : (
                (() => {
                  const originalUrl = msg.sticker.url;
                  const displayUrl = Platform.OS === 'web' ? originalUrl : (stickerUrlMap.get(originalUrl) || originalUrl);
                  return (
                    <ProgressiveImage
                      uri={displayUrl}
                      style={[
                        styles.stickerImage,
                        {
                          width: Math.min(msg.sticker.width || 200, 200),
                          height: Math.min(msg.sticker.height || 200, 200),
                        },
                      ]}
                      resizeMode="contain"
                      onError={async () => {
                        if (Platform.OS !== 'web') {
                          const alt = await resolveNativeSafeStickerUrl(originalUrl);
                          if (alt && alt !== displayUrl) return;
                        }
                        handleImageError(displayUrl);
                      }}
                    />
                  );
                })()
              )}
              
              {/* Sticker timestamp and status */}
              <View style={[
                styles.stickerFooter,
                isOwnMessage ? styles.ownStickerFooter : styles.friendStickerFooter
              ]}>
                <Text style={[
                  styles.stickerTime,
                  { color: theme.textSecondary }
                ]}>
                  {formatMessageTimestamp(msg.timestamp)}
                </Text>
                {/* Show status ticks only for own stickers */}
                {isOwnMessage && (
                  <MessageStatusTicks 
                    delivered={msg.delivered}
                    deliveredAt={msg.deliveredAt}
                    read={msg.read}
                    readAt={msg.readAt}
                    color={theme.textSecondary}
                    size={12}
                    theme={isDarkMode ? 'dark' : 'light'}
                  />
                )}
              </View>
              {pendingOverlay}
            </TouchableOpacity>
            
            {/* Sticker reactions display */}
            {getAllReactions(msg.id, reactionsOverride).length > 0 && (
              <View style={[
                styles.messageReactions,
                isOwnMessage ? { alignSelf: 'flex-end' } : { alignSelf: 'flex-start' }
              ]}>
                {getAllReactions(msg.id, reactionsOverride).filter(reaction => reaction && reaction.emoji).map((reaction, index) => (
                  <TouchableOpacity
                    key={index}
                    style={[
                      styles.messageReactionButton,
                      { backgroundColor: theme.background, borderColor: theme.border },
                      reaction.hasUserReacted && [styles.selectedMessageReaction, { backgroundColor: theme.primary + '20', borderColor: theme.primary }]
                    ]}
                    onPress={() => handleReaction(msg.id, reaction.emoji)}
                  >
                    <Text style={styles.messageReactionEmoji}>{reaction.emoji ? String(reaction.emoji) : '❤️'}</Text>
                    <Text style={[styles.messageReactionCount, { color: reaction.hasUserReacted ? theme.primary : theme.textSecondary }]}>
                      {Number(reaction.count || 0)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </AnimatedMessageWrapper>
      );
    }

    // Handle GIF messages (similar to stickers)
    if (msg.gif) {
      return (
        <AnimatedMessageWrapper 
          key={`gif-${msg.id}`}
          isNewMessage={isNewMessage} 
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
        >
          <View
            key={msg.id}
            style={[
              styles.messageContainer,
              isOwnMessage ? styles.ownMessage : styles.friendMessage,
            ]}
          >
            <TouchableOpacity
              style={[
                styles.stickerContainer,
                styles.messageActionAnchor,
                isOwnMessage ? styles.ownSticker : styles.friendSticker
              ]}
              onLongPress={(event) => handleMessageLongPress(msg.id, event)}
              onPress={() => {
                const now = Date.now();
                const lastTap = msg.lastTap || 0;
                const timeDiff = now - lastTap;
                
                if (timeDiff < 300) {
                  // Double tap detected - add reaction and prevent image view
                  handleQuickReaction(msg.id);
                  msg.lastTap = 0; // Reset to prevent triple tap issues
                } else {
                  // Single tap - set timestamp and delay image view to check for double tap
                  msg.lastTap = now;
                  setTimeout(() => {
                    // Do not open GIFs in full screen per request
                  }, 300);
                }
              }}
              delayLongPress={500}
              disabled={actionPending}
            >
              {brokenFileUrls.has(msg.gif.url) ? (
                // Show placeholder for broken/missing GIFs
                <View style={[styles.deletedStickerPlaceholder, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <AlertCircle size={32} color={theme.textSecondary} />
                  <Text style={[styles.deletedStickerText, { color: theme.textSecondary }]}>
                    GIF unavailable
                  </Text>
                </View>
              ) : (
                (() => {
                  const originalUrl = msg.gif.url;
                  const displayUrl = Platform.OS === 'web' ? originalUrl : (gifUrlMap.get(originalUrl) || originalUrl);
                  return (
                    <ProgressiveImage
                      uri={displayUrl}
                      style={[
                        styles.stickerImage,
                        {
                          width: Math.min(msg.gif.width || 200, 200),
                          height: Math.min(msg.gif.height || 200, 200),
                        },
                      ]}
                      resizeMode="contain"
                      onError={async () => {
                        if (Platform.OS !== 'web') {
                          const alt = await resolveOptimizedGifUrl(originalUrl);
                          if (alt && alt !== displayUrl) return;
                        }
                        handleImageError(originalUrl);
                      }}
                    />
                  );
                })()
              )}
              
              {/* GIF timestamp and status */}
              <View style={[
                styles.stickerFooter,
                isOwnMessage ? styles.ownStickerFooter : styles.friendStickerFooter
              ]}>
                <Text style={[
                  styles.stickerTime,
                  { color: theme.textSecondary }
                ]}>
                  {formatMessageTimestamp(msg.timestamp)}
                </Text>
                {/* Show status ticks only for own GIFs */}
                {isOwnMessage && (
                  <MessageStatusTicks 
                    delivered={msg.delivered}
                    deliveredAt={msg.deliveredAt}
                    read={msg.read}
                    readAt={msg.readAt}
                    color={theme.textSecondary}
                    size={12}
                    theme={isDarkMode ? 'dark' : 'light'}
                  />
                )}
              </View>
              {pendingOverlay}
            </TouchableOpacity>
            
            {/* GIF reactions display */}
            {getAllReactions(msg.id, reactionsOverride).length > 0 && (
              <View style={[
                styles.messageReactions,
                isOwnMessage ? { alignSelf: 'flex-end' } : { alignSelf: 'flex-start' }
              ]}>
                {getAllReactions(msg.id, reactionsOverride).filter(reaction => reaction && reaction.emoji).map((reaction, index) => (
                  <TouchableOpacity
                    key={index}
                    style={[
                      styles.messageReactionButton,
                      { backgroundColor: theme.background, borderColor: theme.border },
                      reaction.hasUserReacted && [styles.selectedMessageReaction, { backgroundColor: theme.primary + '20', borderColor: theme.primary }]
                    ]}
                    onPress={() => handleReaction(msg.id, reaction.emoji)}
                  >
                    <Text style={styles.messageReactionEmoji}>{reaction.emoji ? String(reaction.emoji) : '❤️'}</Text>
                    <Text style={[styles.messageReactionCount, { color: reaction.hasUserReacted ? theme.primary : theme.textSecondary }]}>
                      {Number(reaction.count || 0)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </AnimatedMessageWrapper>
      );
    }

    // Regular text messages
    return (
      <AnimatedMessageWrapper 
        key={`message-${msg.id}`}
        isNewMessage={isNewMessage} 
        messageId={msg.id}
        isIncomingMessage={!isOwnMessage}
      >
        <View
          key={msg.id}
          style={[
            styles.messageContainer,
            isOwnMessage ? styles.ownMessage : styles.friendMessage,
          ]}
        >
          <TouchableOpacity
            style={[
              styles.messageBubble,
              styles.messageActionAnchor,
              isOwnMessage
                ? [styles.ownBubble, { backgroundColor: theme.primary }]
                : [
                    styles.friendBubble,
                    { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
                  ],
              isEditingTarget && {
                borderWidth: 2,
                borderColor: isOwnMessage ? 'rgba(255, 255, 255, 0.7)' : theme.primary,
              },
              isEditingTarget && styles.editingMessageGlow,
            ]}
            onLongPress={(event) => handleMessageLongPress(msg.id, event)}
            onPress={() => {
              // Double tap for quick heart reaction
              const now = Date.now();
              const lastTap = msg.lastTap || 0;
              if (now - lastTap < 300) {
                handleQuickReaction(msg.id);
              }
              msg.lastTap = now;
            }}
            delayLongPress={500}
            disabled={actionPending}
          >
            {isEditingTarget && (
              <View style={styles.editingTag}>
                <Edit3 size={14} color="#ffffff" />
                <Text style={styles.editingTagText}>Editing</Text>
              </View>
            )}
            {/* File attachments */}
            {shouldRenderAttachmentSection && (
              <View style={styles.fileContainer}>
                {attachmentsHydrating && (
                  <View style={[styles.attachmentSkeleton, { backgroundColor: skeletonBackgroundColor, borderColor: skeletonBorderColor }]}>
                    <ActivityIndicator size="small" color={theme.primary} />
                    <View style={{ marginLeft: 12 }}>
                      <Text style={[styles.attachmentSkeletonText, { color: skeletonTextColor }]}>{attachmentHydrationLabel}</Text>
                      <Text style={[styles.attachmentSkeletonSubtext, { color: skeletonSubtextColor }]}>Large files may take a moment to appear.</Text>
                    </View>
                  </View>
                )}

                {hasAttachmentContent && (
                  <>
                    {/* Handle new multiple attachments format */}
                    {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (msg.attachments as HydratedAttachment[]).map((attachment, index: number) => (
                      <View
                        key={index}
                        style={{
                          marginBottom: index < msg.attachments.length - 1 ? 8 : 0,
                          width: '100%',
                          alignItems: 'stretch',
                        }}
                      >
                        {brokenFileUrls.has(attachment.url) ? (
                          // Show placeholder for deleted/missing files
                          <View style={[styles.deletedFileAttachment, { backgroundColor: theme.background, borderColor: theme.border }]}>
                            <AlertCircle size={24} color={theme.textSecondary} />
                            <View style={styles.fileInfo}>
                              <Text style={[styles.fileName, { color: theme.textSecondary }]} numberOfLines={1}>
                                {(() => {
                                  const safeFileName = String(attachment.fileName || 'File').trim();
                                  // Ensure file names don't start with problematic characters
                                  if (!safeFileName || safeFileName === '.' || safeFileName.length === 0) return 'File';
                                  return safeFileName;
                                })()}
                              </Text>
                              <Text style={[styles.fileSize, { color: theme.textSecondary }]}> 
                                File no longer available
                              </Text>
                            </View>
                          </View>
                        ) : isVideoFile(attachment.fileType, attachment.fileName) ? (
                          <FileViewer
                            fileUrl={attachment.resolvedUrl || attachment.url}
                            fileName={attachment.fileName || 'Video File'}
                            fileType={attachment.fileType}
                            fileSize={attachment.fileSize}
                            onDownload={() => handleDownloadFile(attachment.url, attachment.fileName, attachment.resolvedUrl)}
                            downloadKey={getDownloadKey(attachment.url)}
                            remoteFileUrl={attachment.url}
                            // Use FileViewer's built-in ShareModal
                          />
                        ) : isImageFile(attachment.fileType, attachment.fileName) ? (
                          <TouchableOpacity onPress={() => { void handleImageView(attachment.resolvedUrl || attachment.url, attachment.url, attachment.fileName); }}>
                            <ProgressiveImage
                              uri={attachment.resolvedUrl || attachment.url}
                              style={styles.imageAttachment}
                              onError={() => handleImageError(attachment.url)}
                            />
                            <View style={styles.imageOverlay}>
                              <Eye size={20} color="#ffffff" />
                            </View>
                          </TouchableOpacity>
                        ) : (
                          <FileViewer
                            fileUrl={attachment.resolvedUrl || attachment.url}
                            fileName={attachment.fileName}
                            fileType={attachment.fileType}
                            fileSize={attachment.fileSize}
                            onDownload={() => handleDownloadFile(attachment.url, attachment.fileName, attachment.resolvedUrl)}
                            downloadKey={getDownloadKey(attachment.url)}
                            remoteFileUrl={attachment.url}
                            // Use FileViewer's built-in ShareModal
                          />
                        )}
                        {networkErrorUrls.has(attachment.url) && !brokenFileUrls.has(attachment.url) && (
                          <View style={[styles.networkErrorAttachment, { backgroundColor: theme.background, borderColor: theme.border }]}>
                            <View style={styles.networkErrorInfo}>
                              <AlertCircle size={16} color={theme.textSecondary} />
                              <Text style={[styles.networkErrorText, { color: theme.textSecondary }]}>Network error. Tap retry.</Text>
                            </View>
                            <TouchableOpacity
                              style={[styles.networkErrorRetryButton, { borderColor: theme.primary }]}
                              onPress={() => handleDownloadFile(attachment.url, attachment.fileName || 'File', attachment.resolvedUrl)}
                            >
                              <RotateCcw size={14} color={theme.primary} />
                              <Text style={[styles.networkErrorRetryText, { color: theme.primary }]}>Retry</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    ))}
                  </>
                )}
              </View>
            )}
            
            {/* Message text */}
            {msg.text && typeof msg.text === 'string' && msg.text.trim().length > 0 && (
              <StyledText
                text={(() => {
                  const safeText = String(msg.text || '');
                  // Prevent periods or problematic text from being rendered
                  if (!safeText || safeText.trim() === '.' || safeText.trim().length === 0) {
                    return 'Message';
                  }
                  return safeText;
                })()}
                style={[
                  styles.messageText,
                  isOwnMessage ? styles.ownMessageText : [styles.friendMessageText, { color: theme.text }]
                ]}
                linkStyle={{
                  color: isOwnMessage ? 'rgba(255, 255, 255, 0.9)' : theme.primary,
                  fontWeight: '600'
                }}
              />
            )}
            
            {/* Message timestamp and status */}
            <View style={[
              styles.messageFooter,
              isOwnMessage ? styles.ownMessageFooter : styles.friendMessageFooter
            ]}>
              {wasEdited && (
                <Text
                  style={[
                    styles.messageMeta,
                    isOwnMessage ? styles.messageMetaOwn : styles.messageMetaFriend,
                  ]}
                >
                  Edited
                </Text>
              )}
              <Text style={[
                styles.messageTime,
                isOwnMessage ? styles.ownMessageTime : [styles.friendMessageTime, { color: theme.textSecondary }]
              ]}>
                {formatMessageTimestamp(msg.timestamp)}
              </Text>
              {/* Show status ticks only for own messages */}
              {isOwnMessage && (
                <MessageStatusTicks 
                  delivered={msg.delivered}
                  deliveredAt={msg.deliveredAt}
                  read={msg.read}
                  readAt={msg.readAt}
                  color={isOwnMessage ? 'rgba(255, 255, 255, 0.7)' : theme.textSecondary}
                  size={12}
                  theme={isDarkMode ? 'dark' : 'light'}
                />
              )}
            </View>
            {pendingOverlay}
          </TouchableOpacity>
          
          {/* Message reactions display */}
          {getAllReactions(msg.id, reactionsOverride).length > 0 && (
            <View style={[
              styles.messageReactions,
              isOwnMessage ? { alignSelf: 'flex-end' } : { alignSelf: 'flex-start' }
            ]}>
              {getAllReactions(msg.id, reactionsOverride).filter(reaction => reaction && reaction.emoji).map((reaction, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.messageReactionButton,
                    { backgroundColor: theme.background, borderColor: theme.border },
                    reaction.hasUserReacted && [styles.selectedMessageReaction, { backgroundColor: theme.primary + '20', borderColor: theme.primary }]
                  ]}
                  onPress={() => handleReaction(msg.id, reaction.emoji)}
                >
                  <Text style={styles.messageReactionEmoji}>{reaction.emoji ? String(reaction.emoji) : '❤️'}</Text>
                  <Text style={[styles.messageReactionCount, { color: reaction.hasUserReacted ? theme.primary : theme.textSecondary }]}>
                    {Number(reaction.count || 0)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </AnimatedMessageWrapper>
    );
  };

  const renderMessageItem = useCallback(
    ({ item, index }: { item: any; index: number }) => {
      const previousMsg = index > 0 ? displayedMessages[index - 1] : undefined;
      const dateSeparator = getChatDateSeparator(item.timestamp, previousMsg?.timestamp);

      const shouldShowUnreadSeparator = showUnreadSeparator && unreadSeparatorMessageId === item.id;
      const shouldShowNewDivider = showNewDivider && newDividerMessageId === item.id && !shouldShowUnreadSeparator;

      return (
        <View
          onLayout={(event) => {
            const { y, height } = event.nativeEvent.layout;
            const currentDate = getMessageDate(item, previousMsg);
            if (item.id) {
              const messageId = String(item.id);
              const newPosition = { y, height, date: currentDate || '' };
              setMessagePositions(prev => {
                const existingPosition = prev[messageId];
                if (
                  existingPosition &&
                  existingPosition.y === newPosition.y &&
                  existingPosition.height === newPosition.height &&
                  existingPosition.date === newPosition.date
                ) {
                  return prev;
                }
                const next = { ...prev };
                next[messageId] = newPosition;
                return next;
              });
            }
          }}
        >
          {dateSeparator && typeof dateSeparator === 'string' && dateSeparator.trim().length > 0 && (
            <View style={styles.dateSeparatorContainer}>
              <View style={[styles.dateSeparatorLine, { backgroundColor: theme.border }]} />
              <Text style={[styles.dateSeparatorText, { backgroundColor: theme.background, color: theme.textSecondary }]}>
                {(() => {
                  const safeDate = String(dateSeparator).trim();
                  if (!safeDate || safeDate === '.' || safeDate.length === 0) return 'Today';
                  return safeDate;
                })()}
              </Text>
              <View style={[styles.dateSeparatorLine, { backgroundColor: theme.border }]} />
            </View>
          )}

          {shouldShowUnreadSeparator && unreadSeparatorMessageId && (
            <View style={styles.dateSeparatorContainer}>
              <View style={[styles.dateSeparatorLine, { backgroundColor: isDarkMode ? '#FF4444' : '#FF0000' }]} />
              <Text style={[styles.dateSeparatorText, { backgroundColor: theme.background, color: isDarkMode ? '#FF4444' : '#FF0000', fontWeight: '600' }]}> 
                Unread messages
              </Text>
              <View style={[styles.dateSeparatorLine, { backgroundColor: isDarkMode ? '#FF4444' : '#FF0000' }]} />
            </View>
          )}

          {shouldShowNewDivider && (
            <View style={styles.dateSeparatorContainer}>
              <View style={[styles.dateSeparatorLine, { backgroundColor: theme.primary }]} />
              <Text style={[styles.dateSeparatorText, { backgroundColor: theme.background, color: theme.primary, fontWeight: '600' }]}> 
                New messages
              </Text>
              <View style={[styles.dateSeparatorLine, { backgroundColor: theme.primary }]} />
            </View>
          )}

          <MessageRow item={item} />
        </View>
      );
    },
    [
      displayedMessages,
      getMessageDate,
      getChatDateSeparator,
      isDarkMode,
      newDividerMessageId,
      showNewDivider,
      showUnreadSeparator,
      unreadSeparatorMessageId,
      theme.border,
      theme.background,
      theme.textSecondary,
      theme.primary,
    ]
  );

  // Retry a failed pending media item (re-uploads if needed and re-sends)
  const retryPendingMedia = useCallback(async (tempId: string) => {
    if (isOffline) {
      Toast.show({ type: 'info', text1: 'Offline', text2: 'Reconnect to retry media.', position: 'top' });
      return;
    }

    const item = pendingMedia.get(tempId);
    if (!item || !selectedTeamMember) return;
    try {
      // Mark as sending
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, status: 'sending' });
        return next;
      });

      const uri = item.previewUri;
      const isHttp = /^https?:\/\//i.test(uri);
      const guessedExt = (item.mime && item.mime.split('/')[1]) || (uri.split('?')[0].split('#')[0].split('.').pop() || 'bin');
      let finalUrl = uri;
      if (!isHttp) {
        const name = `${item.source === 'keyboard' ? 'kb' : 'pick'}_${Date.now()}.${guessedExt}`;
        const uploadMime = item.mime || (item.kind === 'gif' ? 'image/gif' : 'image/png');
        const { url } = await chatService.uploadFile(
          uri,
          name,
          uploadMime,
          {
            senderEmail: item.sender || effectiveUser?.email,
            recipientEmail: selectedTeamMember.email || selectedTeamMember.id,
          },
          (progress) => {
            setPendingMedia(prev => {
              const next = new Map(prev);
              const cur = next.get(tempId);
              if (cur && cur.status === 'sending') {
                next.set(tempId, { ...cur, progress });
              }
              return next;
            });
          }
        );
        finalUrl = url;
      }

      if (item.kind === 'gif') {
        await sendGif({ url: finalUrl, source: item.source || 'keyboard' } as any, selectedTeamMember.id);
      } else {
        await sendSticker({ url: finalUrl, name: item.nameOrTitle || 'Sticker', pack: 'keyboard' } as any, selectedTeamMember.id);
      }

      // Remove pending on success
      setPendingMedia(prev => {
        const next = new Map(prev);
        next.delete(tempId);
        return next;
      });
    } catch (err) {
      logger.error('Retry send failed:', err);
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, status: 'failed' });
        return next;
      });
      Toast.show({ type: 'error', text1: 'Retry Failed', text2: 'Could not resend media', position: 'top' });
    }
  }, [isOffline, pendingMedia, selectedTeamMember, sendGif, sendSticker]);

  const retryPendingAttachment = useCallback(
    async (tempId: string) => {
      if (isOffline) {
        Toast.show({ type: 'info', text1: 'Offline', text2: 'Reconnect to retry attachments.', position: 'top' });
        return;
      }

      const entry = pendingAttachments.get(tempId);
      if (!entry || !selectedTeamMember || entry.recipientId !== selectedTeamMember.id) {
        return;
      }

      clearAttachmentFinalizeTimer(tempId);

      attachmentUploadCancelMap.current.delete(tempId);

      setPendingAttachments((prev) => {
        const next = new Map(prev);
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            status: 'sending',
            progress: 0,
            cancelable: false,
            cancelRequested: false,
            failureReason: undefined,
          });
        }
        return next;
      });

      try {
        await sendMessageWithFiles(
          entry.messageText,
          entry.files,
          entry.recipientId,
          (progress) => {
            setPendingAttachments((prev) => {
              const next = new Map(prev);
              const current = next.get(tempId);
              if (current && current.status === 'sending') {
                next.set(tempId, { ...current, progress });
              }
              return next;
            });
          },
          {
            registerCancel: (cancelFn) => {
              attachmentUploadCancelMap.current.set(tempId, cancelFn);
              setPendingAttachments((prev) => {
                const next = new Map(prev);
                const current = next.get(tempId);
                if (current) {
                  next.set(tempId, { ...current, cancelable: true, cancelRequested: false });
                }
                return next;
              });
            },
          }
        );

        setPendingAttachments((prev) => {
          const next = new Map(prev);
          const current = next.get(tempId);
          if (current) {
            next.set(tempId, {
              ...current,
              status: 'finalizing',
              progress: 100,
              cancelable: false,
              cancelRequested: false,
            });
          }
          return next;
        });

        scheduleAttachmentFinalizeCleanup(tempId);
        attachmentUploadCancelMap.current.delete(tempId);

        Toast.show({ type: 'success', text1: 'Files Sent', text2: 'Attachment message delivered.', position: 'top' });
      } catch (error) {
        clearAttachmentFinalizeTimer(tempId);
        attachmentUploadCancelMap.current.delete(tempId);
        if (error instanceof ChatUploadCanceledError) {
          logger.info('Attachment upload retry canceled by user', { tempId });
        } else {
          logger.error('Retry attachment send failed:', error);
        }
        setPendingAttachments((prev) => {
          const next = new Map(prev);
          const current = next.get(tempId);
          if (current) {
            next.set(tempId, {
              ...current,
              status: 'failed',
              cancelable: false,
              cancelRequested: false,
              failureReason: error instanceof ChatUploadCanceledError ? 'canceled' : 'error',
            });
          }
          return next;
        });
        if (error instanceof ChatUploadCanceledError) {
          Toast.show({ type: 'info', text1: 'Upload Canceled', text2: 'Attachment upload was canceled.', position: 'top' });
        } else {
          Toast.show({ type: 'error', text1: 'Retry Failed', text2: 'Could not resend attachments.', position: 'top' });
        }
      } finally {
        clearAttachmentFinalizeTimer(tempId);
        attachmentUploadCancelMap.current.delete(tempId);
      }
    },
    [clearAttachmentFinalizeTimer, isOffline, pendingAttachments, scheduleAttachmentFinalizeCleanup, selectedTeamMember, sendMessageWithFiles]
  );

  const cancelPendingAttachment = useCallback(async (tempId: string) => {
    const cancelFn = attachmentUploadCancelMap.current.get(tempId);
    if (!cancelFn) {
      return;
    }

    attachmentUploadCancelMap.current.delete(tempId);
    setPendingAttachments((prev) => {
      const next = new Map(prev);
      const current = next.get(tempId);
      if (current && current.status === 'sending') {
        next.set(tempId, {
          ...current,
          cancelRequested: true,
          cancelable: false,
        });
      }
      return next;
    });

    try {
      await cancelFn();
    } catch (error) {
      logger.warn('Cancel pending attachment failed', error);
    }
  }, []);

  // Render pending rich media (stickers/GIFs) with a clock icon until sent
  const renderPendingMedia = (tempId: string, item: PendingMediaItem) => {
    if (!selectedTeamMember || item.recipientId !== selectedTeamMember.id) return null;
    const isSticker = item.kind === 'sticker';
    const size = {
      width: Math.min(item.width || 200, 200),
      height: Math.min(item.height || 200, 200),
    };
    return (
      <View key={tempId} style={[styles.messageContainer, styles.ownMessage]}>
        <View style={[styles.stickerContainer, styles.ownSticker]}>
          {isSticker && (!item.previewUri || item.previewUri.trim().length === 0) ? (
            <View style={styles.emojiStickerContainer}>
              <Text style={[
                styles.emojiStickerText,
                { fontSize: Math.min(item.width || 100, 100) * 0.8 }
              ]}>
                {item.nameOrTitle || '🙂'}
              </Text>
            </View>
          ) : (
            <Image
              source={{ uri: item.previewUri }}
              style={[styles.stickerImage, size]}
              resizeMode="contain"
            />
          )}
          {/* Upload/progress overlay for pending media */}
          {item.status === 'sending' && typeof item.progress === 'number' && (
            <View
              style={{
                position: 'absolute',
                left: 8,
                right: 8,
                bottom: 8,
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderRadius: 8,
                backgroundColor: 'rgba(0,0,0,0.5)'
              }}
            >
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                Uploading... {Math.round(item.progress)}%
              </Text>
              <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 4, marginTop: 4 }}>
                <View style={{ height: 4, width: `${Math.max(0, Math.min(100, item.progress))}%`, backgroundColor: '#fff', borderRadius: 4 }} />
              </View>
            </View>
          )}

          <View style={[styles.stickerFooter, styles.ownStickerFooter, { alignItems: 'center' }]}>
            <Text style={[styles.stickerTime, { color: theme.textSecondary }]}>
              {item.status === 'sending' ? 'Sending...' : 'Failed'}
            </Text>
            {item.status === 'sending' ? (
              <Clock size={12} color={theme.textSecondary} />
            ) : (
              <AlertCircle size={12} color={theme.error} />
            )}
            {item.status === 'failed' && (
              <TouchableOpacity
                onPress={() => retryPendingMedia(tempId)}
                disabled={isOffline}
                style={{
                  marginLeft: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: theme.background,
                  borderWidth: 1,
                  borderColor: theme.border,
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: isOffline ? 0.6 : 1,
                }}
              >
                <Text style={{ color: theme.primary, fontWeight: '600' }}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  // Render pending file attachments message (optimistic bubble)
  const renderPendingAttachments = (tempId: string, item: PendingAttachmentItem) => {
    if (!selectedTeamMember || item.recipientId !== selectedTeamMember.id) return null;
    return (
      <View key={tempId} style={[styles.messageContainer, styles.ownMessage]}>        
        <View style={[styles.messageBubble, styles.ownBubble, { backgroundColor: theme.primary }]}>          
          {item.messageText ? (
            <StyledText
              text={item.messageText}
              style={[styles.messageText, styles.ownMessageText]}
              linkStyle={{ color: 'rgba(255,255,255,0.9)', fontWeight: '600' }}
            />
          ) : null}
          <View style={{ marginTop: item.messageText ? 8 : 0 }}>
            {item.files.map((f, idx) => (
              <View key={idx} style={{ marginBottom: idx < item.files.length - 1 ? 8 : 0 }}>
                <View style={[styles.deletedFileAttachment, { backgroundColor: theme.background, borderColor: theme.border }]}> 
                  <View style={styles.fileInfo}>
                    <Text style={[styles.fileName, { color: theme.text }]} numberOfLines={1}>{f.fileName}</Text>
                    <Text style={[styles.fileSize, { color: theme.textSecondary }]}>
                      {f.fileType.replace('/',' · ')}{f.fileSize ? ` · ${formatFileSize(f.fileSize)}` : ''}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
          {/* Upload/progress overlay */}
          {item.status === 'sending' && (
            <View style={{ marginTop: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' }}>
                  {item.cancelRequested ? 'Canceling...' : `Uploading... ${Math.round(item.progress)}%`}
                </Text>
                {item.cancelable && !item.cancelRequested && (
                  <TouchableOpacity
                    onPress={() => cancelPendingAttachment(tempId)}
                    style={{
                      marginLeft: 10,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 8,
                      backgroundColor: 'rgba(255,255,255,0.15)',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel upload"
                  >
                    <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>Cancel</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 4, marginTop: 4 }}>
                <View
                  style={{
                    height: 4,
                    width: `${Math.max(0, Math.min(100, item.progress))}%`,
                    backgroundColor: '#fff',
                    borderRadius: 4,
                  }}
                />
              </View>
            </View>
          )}
          {item.status === 'finalizing' && (
            <View style={{ marginTop: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' }}>
                  Finishing up...
                </Text>
                <CheckCircle2 size={14} color={'#fff'} />
              </View>
              <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 4, marginTop: 4 }}>
                <View style={{ height: 4, width: '100%', backgroundColor: '#fff', borderRadius: 4 }} />
              </View>
            </View>
          )}
          {item.status === 'failed' && (
            <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center' }}>
              <AlertCircle size={14} color={'#fff'} />
              <Text style={{ marginLeft: 6, color: 'rgba(255,255,255,0.9)' }}>
                {item.failureReason === 'canceled' ? 'Canceled' : 'Failed'}
              </Text>
              <TouchableOpacity
                onPress={() => retryPendingAttachment(tempId)}
                disabled={isOffline}
                style={{
                  marginLeft: 10,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: 'rgba(255,255,255,0.15)',
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: isOffline ? 0.6 : 1,
                }}
              >
                <RotateCcw size={12} color={'#fff'} />
                <Text style={{ marginLeft: 4, color: '#fff', fontWeight: '600' }}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  };



  const renderAttachmentModal = () => (
    <Modal
      visible={attachmentModalVisible}
      transparent
      animationType="fade"
  onRequestClose={closeAttachmentModal}
    >
      <Pressable 
        style={styles.attachmentModalOverlay}
  onPress={closeAttachmentModal}
      >
        <View style={[styles.attachmentModal, { backgroundColor: theme.surface }]}>
          <Text style={[styles.attachmentModalTitle, { color: theme.text }]}>Send Attachment</Text>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={() => handleFileSelection('image')}
          >
            <ImageIcon size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Photo Library</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={() => handleFileSelection('camera')}
          >
            <Camera size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Camera</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={() => handleFileSelection('video')}
          >
            <Play size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Video Library</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={() => handleFileSelection('videoCamera')}
          >
            <Camera size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Record Video</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={styles.attachmentOption}
            onPress={() => handleFileSelection('document')}
          >
            <FileIcon size={24} color={theme.primary} />
            <Text style={[styles.attachmentOptionText, { color: theme.text }]}>Document</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );

  const renderFilePreviewModal = () => (
    <Modal
      visible={filePreviewVisible}
      transparent
      animationType="slide"
      onRequestClose={resetFilePreviewModal}
    >
      <View style={styles.filePreviewOverlay}>
        <SafeAreaView style={styles.filePreviewContainer}>
          <View style={[styles.filePreviewHeader, { backgroundColor: theme.surface }]}>
            <Text style={[styles.filePreviewTitle, { color: theme.text }]}>
              Preview Files ({selectedFiles.length})
            </Text>
            <TouchableOpacity
              onPress={resetFilePreviewModal}
              style={styles.closeButton}
            >
              <X size={24} color={theme.text} />
            </TouchableOpacity>
          </View>

          {skippedPreviewFiles.length > 0 && (
            <View style={{ marginHorizontal: 20, marginTop: 10, backgroundColor: '#FFFBEB', borderColor: '#F59E0B', borderWidth: 1, borderRadius: 8, padding: 10 }}>
              <Text style={{ color: '#92400E', fontWeight: '600', fontSize: 13, marginBottom: 4 }}>
                Skipped while adding files ({skippedPreviewFiles.length})
              </Text>
              <ScrollView style={{ maxHeight: 140 }} nestedScrollEnabled>
                {groupedSkippedPreviewFiles.folder.length > 0 && (
                  <>
                    <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 2, marginBottom: 2 }}>
                      Folders ({groupedSkippedPreviewFiles.folder.length})
                    </Text>
                    {groupedSkippedPreviewFiles.folder.map((entry, idx) => (
                      <Text key={`folder_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
                {groupedSkippedPreviewFiles.duplicate.length > 0 && (
                  <>
                    <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 6, marginBottom: 2 }}>
                      Duplicates ({groupedSkippedPreviewFiles.duplicate.length})
                    </Text>
                    {groupedSkippedPreviewFiles.duplicate.map((entry, idx) => (
                      <Text key={`duplicate_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
                {groupedSkippedPreviewFiles.tooLarge.length > 0 && (
                  <>
                    <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 6, marginBottom: 2 }}>
                      Too Large ({groupedSkippedPreviewFiles.tooLarge.length})
                    </Text>
                    {groupedSkippedPreviewFiles.tooLarge.map((entry, idx) => (
                      <Text key={`too_large_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
                {groupedSkippedPreviewFiles.other.length > 0 && (
                  <>
                    <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 6, marginBottom: 2 }}>
                      Other ({groupedSkippedPreviewFiles.other.length})
                    </Text>
                    {groupedSkippedPreviewFiles.other.map((entry, idx) => (
                      <Text key={`other_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                        • {entry}
                      </Text>
                    ))}
                  </>
                )}
              </ScrollView>
            </View>
          )}

          <ScrollView
            style={styles.filePreviewContent}
            contentContainerStyle={{ paddingBottom: Platform.select({ web: 0, default: 20 }) }}
          >
            {selectedFiles.map((file, index) => {
              const mimeType = String(file.mimeType || file.type || file.fileType || '').toLowerCase();
              const safePreviewName = (() => {
                const candidate = String(file.fileName || file.name || 'Unknown file').trim();
                if (!candidate || candidate === '.') {
                  return 'Unknown file';
                }
                return candidate;
              })();
              const fileSizeValue = file.fileSize || file.size;
              const isImage = isImageFile(mimeType, safePreviewName);
              const isVideo = isVideoFile(mimeType, safePreviewName);
              const previewImageUri = String(file.previewUri || file.uri || '');
              const thumbnailUri = file.thumbnail || file.preview || file.poster || null;

              return (
                <View key={index} style={[styles.filePreviewItem, { backgroundColor: theme.background }]}>
                  <View style={[styles.filePreviewInfo, isVideo ? styles.filePreviewInfoVideo : null]}>
                    {isImage && previewImageUri ? (
                      <Image source={{ uri: previewImageUri }} style={styles.previewImage} />
                    ) : isVideo ? (
                      <View style={styles.videoPreviewContainer}>
                        <VideoPlayer
                          uri={file.uri}
                          fileName={safePreviewName}
                          thumbnailUrl={thumbnailUri || undefined}
                          style={styles.videoPreviewPlayer}
                          maxHeight={140}
                          controlVariant="minimal"
                        />
                      </View>
                    ) : (
                      <View style={styles.fileIconContainer}>
                        <FileIcon size={32} color={theme.primary} />
                      </View>
                    )}
                    <View style={styles.filePreviewDetails}>
                      <Text style={[styles.previewFileName, { color: theme.text }]} numberOfLines={2}>
                        {safePreviewName}
                      </Text>
                      {fileSizeValue ? (
                        <Text style={[styles.previewFileSize, { color: theme.textSecondary }]}>
                          {formatFileSize(fileSizeValue)}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={() => removeSelectedFile(index)}
                    style={styles.removeFileButton}
                  >
                    <Trash2 size={20} color={theme.error} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>

          <View style={[styles.filePreviewFooter, { backgroundColor: theme.surface }]}>
            <TextInput
              style={[styles.previewMessageInput, { 
                backgroundColor: theme.background, 
                borderColor: theme.border,
                color: theme.text 
              }]}
              value={message}
              onChangeText={setMessage}
              placeholder="Add a message (optional)..."
              placeholderTextColor={theme.textSecondary}
              multiline
              numberOfLines={3}
              maxLength={500}
            />
            
            {isUploading ? (
              <View style={styles.uploadProgressContainer}>
                <Text style={[styles.uploadProgressText, { color: theme.text }]}>
                  Uploading... {Math.round(uploadProgress)}%
                </Text>
                <View style={[styles.progressBar, { backgroundColor: theme.border }]}>
                  <View 
                    style={[
                      styles.progressFill, 
                      { 
                        backgroundColor: theme.primary,
                        width: `${uploadProgress}%`
                      }
                    ]} 
                  />
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.sendFilesButton, { backgroundColor: theme.primary }]}
                onPress={handleSendWithFiles}
                disabled={selectedFiles.length === 0}
              >
                <Send size={20} color="#ffffff" />
                <Text style={styles.sendFilesButtonText}>
                  Send {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );

  const ImageViewerDownloadButton = React.memo(
    ({ sourceUri, localHint }: { sourceUri: string; localHint?: string }) => {
      const downloadKey = getDownloadKey(sourceUri);
      const downloadState = useDownloadState(downloadKey);
      const normalizedProgress = Math.max(0, Math.min(100, Math.round(downloadState.progress ?? 0)));
      const downloadLabel = downloadState.isDownloading
        ? `Downloading ${normalizedProgress}%`
        : 'Download';

      return (
        <TouchableOpacity
          style={[styles.imageViewerActionButton, { opacity: downloadState.isDownloading ? 0.7 : 1 }]}
          onPress={() => {
            const derived = normalizeSharedFileName({ fileUrl: sourceUri, fileName: '' });
            const downloadName = derived && derived !== 'file' ? derived : 'image.jpg';
            handleDownloadFile(sourceUri, downloadName, localHint);
          }}
          disabled={downloadState.isDownloading}
        >
          <Download size={20} color="#ffffff" />
          <Text style={styles.imageViewerButtonText}>{downloadLabel}</Text>
        </TouchableOpacity>
      );
    }
  );

  const renderImageViewerModal = () => {
    const sourceUri = lastViewedRemoteImage || selectedImageUri;

    return (
      <Modal
        visible={imageViewerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setImageViewerVisible(false)}
      >
        <View style={styles.imageViewerOverlay}>
          <TouchableOpacity
            style={styles.imageViewerCloseButton}
            onPress={() => setImageViewerVisible(false)}
          >
            <X size={30} color="#ffffff" />
          </TouchableOpacity>
          {brokenFileUrls.has(selectedImageUri) ? (
            <View style={styles.brokenImageContainer}>
              <AlertCircle size={64} color="#ffffff" />
              <Text style={styles.brokenImageText}>
                Image no longer available
              </Text>
              <Text style={styles.brokenImageSubtext}>
                This image has been deleted or is no longer accessible
              </Text>
            </View>
          ) : (
            <View style={styles.imageViewerContent}>
              <ProgressiveImage
                uri={selectedImageUri}
                style={styles.fullScreenImage}
                resizeMode="contain"
                onError={() => handleImageError(lastViewedRemoteImage || selectedImageUri)}
              />
              {networkErrorUrls.has(lastViewedRemoteImage || selectedImageUri) && (
                <TouchableOpacity
                  style={styles.imageRetryBadge}
                  onPress={() => {
                    const retryUri = lastViewedRemoteImage || selectedImageUri;
                    clearNetworkError(retryUri);
                    setSelectedImageUri(retryUri);
                  }}
                >
                  <RotateCcw size={14} color="#ffffff" />
                  <Text style={styles.imageRetryText}>Retry</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          {!brokenFileUrls.has(selectedImageUri) && networkErrorUrls.has(lastViewedRemoteImage || selectedImageUri) && (
            <View style={[styles.imageViewerNetworkError, { backgroundColor: 'rgba(0, 0, 0, 0.55)', borderColor: 'rgba(255, 255, 255, 0.2)' }]}> 
              <View style={styles.networkErrorInfo}>
                <AlertCircle size={16} color="#ffffff" />
                <Text style={[styles.networkErrorText, { color: '#ffffff' }]}>Network error. Tap retry.</Text>
              </View>
              <TouchableOpacity
                style={[styles.networkErrorRetryButton, { borderColor: '#ffffff' }]}
                onPress={() => {
                  const retryUri = lastViewedRemoteImage || selectedImageUri;
                  clearNetworkError(retryUri);
                  setSelectedImageUri(retryUri);
                }}
              >
                <RotateCcw size={14} color="#ffffff" />
                <Text style={[styles.networkErrorRetryText, { color: '#ffffff' }]}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          {/* Action buttons positioned at the bottom with proper spacing */}
          {!brokenFileUrls.has(selectedImageUri) && (
            <View style={styles.imageViewerButtonContainer}>
              <ImageViewerDownloadButton sourceUri={sourceUri} localHint={selectedImageUri} />
              <TouchableOpacity
                style={styles.imageViewerActionButton}
                onPress={() => setShowImageShareModal(true)}
              >
                <Share size={20} color="#ffffff" />
                <Text style={styles.imageViewerButtonText}>Share</Text>
              </TouchableOpacity>
            </View>
          )}
          <ShareModal
            visible={showImageShareModal}
            onClose={() => setShowImageShareModal(false)}
            fileUrl={lastViewedRemoteImage || selectedImageUri}
            fileName={(() => {
              const src = lastViewedRemoteImage || selectedImageUri;
              const derived = normalizeSharedFileName({ fileUrl: src, fileName: '' });
              return derived && derived !== 'file' ? derived : 'image.jpg';
            })()}
            onDownload={() => {
              const src = lastViewedRemoteImage || selectedImageUri;
              const derived = normalizeSharedFileName({ fileUrl: src, fileName: '' });
              const downloadName = derived && derived !== 'file' ? derived : 'image.jpg';
              handleDownloadFile(src, downloadName, selectedImageUri);
            }}
          />
        </View>
      </Modal>
    );
  };

  // Emoji picker modal for message reactions
  const renderEmojiPickerModal = () => {
    const fallbackMessage = selectedMessageForReaction
      ? (messages || []).find((m: any) => m && m.id === selectedMessageForReaction) || null
      : null;
    const targetMessage = selectedMessageForAction ?? fallbackMessage;

    const extraActions = (() => {
      if (!targetMessage) return [];
      const actions: { label: string; onPress: () => void; icon?: React.ReactNode; variant?: 'default' | 'primary' | 'danger'; disabled?: boolean }[] = [];

      if (canEditMessage(targetMessage)) {
        actions.push({
          label: 'Edit',
          onPress: () => {
            closeEmojiPicker();
            beginEditingMessage(targetMessage);
          },
          icon: <Edit3 size={16} color="#ffffff" />,
          variant: 'primary',
        });
      }

      if (canDeleteMessage(targetMessage)) {
        const pending = isMessageActionPending(targetMessage.id);
        actions.push({
          label: pending ? 'Deleting…' : 'Delete',
          onPress: () => {
            closeEmojiPicker();
            confirmDeleteMessage(targetMessage);
          },
          icon: <Trash2 size={16} color="#ffffff" />,
          variant: 'danger',
          disabled: pending,
        });
      }

      return actions;
    })();

    return (
      <EnhancedEmojiPicker
        visible={emojiPickerVisible}
        onClose={closeEmojiPicker}
        onEmojiSelect={(emoji) => {
          if (selectedMessageForReaction) {
            handleReaction(selectedMessageForReaction, emoji);
          }
          closeEmojiPicker();
        }}
        position={reactionPickerPosition}
        selectedMessageId={selectedMessageForReaction}
        getReactionStatus={getReactionStatus}
        theme={theme}
        copyText={(() => {
          try {
            if (!selectedMessageForReaction) return undefined;
            const msg = (messages || []).find((m: any) => m && m.id === selectedMessageForReaction);
            const txt = msg && typeof msg.text === 'string' ? msg.text : '';
            return txt && txt.trim().length > 0 ? txt : undefined;
          } catch {
            return undefined;
          }
        })()}
        extraActions={extraActions}
      />
    );
  };

  // Animated Typing Indicator Component
  const AnimatedTypingIndicator: React.FC<{ color: string }> = ({ color }) => {
    const dot1 = useRef(new Animated.Value(0)).current;
    const dot2 = useRef(new Animated.Value(0)).current;
    const dot3 = useRef(new Animated.Value(0)).current;

    useEffect(() => {
      const animateDot = (animatedValue: Animated.Value, delay: number) => {
        return Animated.loop(
          Animated.sequence([
            Animated.delay(delay),
            Animated.timing(animatedValue, {
              toValue: 1,
              duration: 500,
              useNativeDriver: Platform.OS !== 'web',
            }),
            Animated.timing(animatedValue, {
              toValue: 0,
              duration: 500,
              useNativeDriver: Platform.OS !== 'web',
            }),
          ])
        );
      };

      const animation = Animated.parallel([
        animateDot(dot1, 0),
        animateDot(dot2, 200),
        animateDot(dot3, 400),
      ]);

      animation.start();

      return () => animation.stop();
    }, [dot1, dot2, dot3]);

    const dotStyle = (animatedValue: Animated.Value) => ({
      opacity: animatedValue,
      transform: [
        {
          scale: animatedValue.interpolate({
            inputRange: [0, 1],
            outputRange: [0.5, 1],
          }),
        },
      ],
    });

    return (
      <View style={styles.typingIndicatorSmall}>
        <Animated.View style={[styles.typingDot, { backgroundColor: color }, dotStyle(dot1)]} />
        <Animated.View style={[styles.typingDot, { backgroundColor: color }, dotStyle(dot2)]} />
        <Animated.View style={[styles.typingDot, { backgroundColor: color }, dotStyle(dot3)]} />
      </View>
    );
  };

  // Update selected team member when team members list changes (for real-time status updates)
  useEffect(() => {
    if (selectedTeamMember && teamMembers.length > 0) {
      const updatedMember = teamMembers.find(member => member.id === selectedTeamMember.id);
      if (updatedMember) {
        // Check if any relevant properties have changed
        const hasStatusChanged = (
          updatedMember.isOnline !== selectedTeamMember.isOnline ||
          updatedMember.typingTo !== selectedTeamMember.typingTo ||
          updatedMember.lastSeen !== selectedTeamMember.lastSeen ||
          updatedMember.photoURL !== selectedTeamMember.photoURL ||
          updatedMember.customImageURL !== selectedTeamMember.customImageURL
        );
        
        if (hasStatusChanged) {
          setSelectedTeamMember(updatedMember);
        }
      }
    }
  }, [teamMembers, selectedTeamMember]);

  // Retry pending messages when back online
  const retryPendingMessages = async () => {
    if (pendingMessages.size === 0 || isOffline) return;

    const messagesToRetry = Array.from(pendingMessages.entries());
    const successfulMessages: string[] = [];

    for (const [tempId, pendingMsg] of messagesToRetry) {
      try {
        await sendMessage(
          pendingMsg.text,
          false,
          pendingMsg.recipientId
        );
        successfulMessages.push(tempId);
      } catch (error) {
        logger.error('❌ Failed to retry message:', tempId, error);
        // Keep failed messages in pending queue
      }
    }

    // Remove successfully sent messages from both state and storage
    if (successfulMessages.length > 0) {
      
      setPendingMessages(prev => {
        const newMap = new Map(prev);
        successfulMessages.forEach(id => newMap.delete(id));
        return newMap;
      });

      try {
        // Remove from persistent storage
        await PendingMessageStorage.removePendingMessages(successfulMessages);
      } catch (error) {
        logger.error('❌ Failed to remove messages from storage:', error);
      }

      if (successfulMessages.length === messagesToRetry.length) {
        Toast.show({
          type: 'success',
          text1: 'Messages Sent',
          text2: 'All pending messages have been sent successfully.',
          position: 'top',
        });
      } else {
        Toast.show({
          type: 'info',
          text1: 'Partial Success',
          text2: `${successfulMessages.length} of ${messagesToRetry.length} messages were sent. Others will retry automatically.`,
          position: 'top',
        });
      }
    }
  };

  const retryPendingMessage = useCallback(
    async (tempId: string) => {
      if (isOffline) {
        Toast.show({ type: 'info', text1: 'Offline', text2: 'Reconnect to retry this message.', position: 'top' });
        return;
      }

      const pendingMsg = pendingMessages.get(tempId) as PendingMessage | undefined;
      if (!pendingMsg || !selectedTeamMember || pendingMsg.recipientId !== selectedTeamMember.id) {
        return;
      }

      setRetryingPendingMessages((prev) => {
        if (prev.has(tempId)) return prev;
        const next = new Set(prev);
        next.add(tempId);
        return next;
      });

      try {
        await sendMessage(pendingMsg.text, false, pendingMsg.recipientId);

        setPendingMessages((prev) => {
          const next = new Map(prev);
          next.delete(tempId);
          return next;
        });

        try {
          await PendingMessageStorage.removePendingMessage(tempId);
        } catch (error) {
          logger.warn('Failed to remove pending message after retry:', error);
        }

        Toast.show({ type: 'success', text1: 'Message Sent', text2: 'Pending message delivered.', position: 'top' });
      } catch (error) {
        logger.error('Retry pending message failed:', error);
        Toast.show({ type: 'error', text1: 'Retry Failed', text2: 'Could not resend this message.', position: 'top' });
      } finally {
        setRetryingPendingMessages((prev) => {
          if (!prev.has(tempId)) return prev;
          const next = new Set(prev);
          next.delete(tempId);
          return next;
        });
      }
    },
    [isOffline, pendingMessages, selectedTeamMember, sendMessage]
  );

  // Effect to retry pending messages when connection is restored
  useEffect(() => {
  if (!isOffline && pendingMessages.size > 0) {
      // Wait a moment for connection to stabilize
      const timer = setTimeout(() => {
        retryPendingMessages();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isOffline, pendingMessages.size]);

  // Render pending messages with visual indicators
  const renderPendingMessage = (tempId: string, pendingMsg: PendingMessage) => {
    // Only show pending messages for the currently selected team member
    if (!selectedTeamMember || pendingMsg.recipientId !== selectedTeamMember.id) return null;
  const isRetrying = retryingPendingMessages.has(tempId);
  const statusLabel = isRetrying ? 'Retrying...' : isOffline ? 'Sending...' : 'Failed';
    
    return (
      <View key={tempId} style={[
        styles.messageContainer,
        styles.ownMessage
      ]}>
        <View style={[
          styles.messageBubble,
          styles.ownBubble,
          { backgroundColor: theme.primary, opacity: 0.7 }
        ]}>
          <StyledText
            text={(() => {
              const safeText = String(pendingMsg.text || '');
              // Prevent periods or problematic text from being rendered in pending messages
              if (!safeText || safeText.trim() === '.' || safeText.trim().length === 0) {
                return 'Sending message...';
              }
              return safeText;
            })()}
            style={[
              styles.messageText,
              styles.ownMessageText
            ]}
            linkStyle={{
              color: 'rgba(255, 255, 255, 0.9)',
              fontWeight: '600'
            }}
          />
          
          <View style={[styles.messageFooter, styles.ownMessageFooter]}>
            <Text style={[
              styles.messageTime,
              styles.ownMessageTime,
              { color: 'rgba(255, 255, 255, 0.85)' }
            ]}>
              {statusLabel}
            </Text>
            <View style={{ marginLeft: 6 }}>
              {isRetrying ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : isOffline ? (
                <Clock size={12} color="rgba(255, 255, 255, 0.85)" />
              ) : (
                <AlertCircle size={12} color={theme.error} />
              )}
            </View>
            {!isOffline && (
              <TouchableOpacity
                onPress={() => retryPendingMessage(tempId)}
                disabled={isRetrying}
                style={{
                  marginLeft: 10,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: 'rgba(255,255,255,0.15)',
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: isRetrying ? 0.6 : 1,
                }}
              >
                <RotateCcw size={12} color="#ffffff" />
                <Text style={{ marginLeft: 4, color: '#ffffff', fontWeight: '600' }}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  // Load pending messages when component mounts or team member changes
  useEffect(() => {
    const loadPendingMessages = async () => {
      if (selectedTeamMember && (effectiveUser?.email || user?.email)) {
        const senderEmail = effectiveUser?.email || user?.email || '';
        
        const storedPendingMessages = await PendingMessageStorage.getPendingMessagesForRecipient(
          selectedTeamMember.id,
          senderEmail
        );
        
        setPendingMessages(storedPendingMessages);
      } else {
        setPendingMessages(new Map<string, PendingMessage>());
      }
    };

    loadPendingMessages();
  }, [selectedTeamMember, effectiveUser?.email, user?.email]);

  // Also load pending messages on initial mount regardless of other dependencies
  useEffect(() => {
    const loadInitialPendingMessages = async () => {
      // Load all pending messages and let the filtering happen in render
      const allPendingMessages = await PendingMessageStorage.loadPendingMessages();
      
      // Only set if we have a selected team member and user
      if (selectedTeamMember && (effectiveUser?.email || user?.email)) {
        const senderEmail = effectiveUser?.email || user?.email || '';
        const filteredMessages = new Map<string, PendingMessage>();
        
        for (const [id, message] of allPendingMessages.entries()) {
          if (message.recipientId === selectedTeamMember.id && message.sender === senderEmail) {
            filteredMessages.set(id, message);
          }
        }
        
        setPendingMessages(filteredMessages);
      }
    };

    loadInitialPendingMessages();
  }, []); // Run only once on mount

  // Safe early return after all hooks/effects are registered
  if (tenantLoading && !activeTenant?.id) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}> 
        <View style={[styles.container, styles.centered]}> 
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading chat…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (tenantUnavailable) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}> 
        <TenantSelectionEmptyState
          title="No coaching center selected"
          description="Use Settings → Coaching centers to choose, create, or join a workspace before messaging."
          primaryActionLabel="Open Settings"
          onPrimaryAction={() => router.push('/(tabs)/settings')}
        />
      </SafeAreaView>
    );
  }

  if (!selectedTeamMember && showOfflineLoadingChat) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}> 
        {/* Header */}
        <View style={[styles.header, { backgroundColor: theme.background, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}> 
          <Text allowFontScaling={false} style={[styles.headerTitle, { color: theme.text }]}>Messages</Text>
        </View>
        <View style={[styles.container, styles.centered]}> 
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading chat…</Text>
          {!!offlineHintChat && (
            <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 8 }]}>{offlineHintChat}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Main render function - show user list or chat view
  if (!selectedTeamMember) {
    // Show loading screen when auth is loading or when we have user but no team members loaded yet
    if (authLoading || teamMembersLoading) {
      return (
        <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
          {/* Header */}
          <View style={[styles.header, { backgroundColor: theme.background, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
            <Text allowFontScaling={false} style={[styles.headerTitle, { color: theme.text }]}>Messages</Text>
          </View>
          
          {/* Loading Content */}
          <View style={[styles.container, styles.centered]}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>
              {authLoading ? 'Authenticating...' : 'Loading team members...'}
            </Text>
          </View>
        </SafeAreaView>
      );
    }
    
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        {/* Header */}
  <View style={[styles.header, { backgroundColor: theme.background, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
          <Text allowFontScaling={false} style={[styles.headerTitle, { color: theme.text }]}>Messages</Text>
        </View>

        {/* Team Members List */}
        <View style={[styles.searchContainer, { backgroundColor: theme.surface }]}
          accessibilityRole="search"
        >
          <Search size={20} color={theme.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: theme.text }]}
            placeholder="Search team members..."
            placeholderTextColor={theme.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

        <RNFlatList
          data={filteredTeamMembers}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            return (
            <TouchableOpacity
              style={[styles.userListItem, { backgroundColor: theme.background }]}
              onPress={() => {
                setSelectedTeamMember(item);
                // Auto-focus input when selecting a chat
                setTimeout(() => {
                  if (Platform.OS === 'ios' && textInputRef.current) {
                    textInputRef.current.focus();
                  } else if (Platform.OS === 'android' && richTextInputRef.current) {
                    try {
                      richTextInputRef.current.focus?.();
                    } catch (e) {
                      logger.debug('Android focus not available');
                    }
                  }
                }, 500); // Delay to ensure chat is loaded
              }}
              activeOpacity={0.7}
              onLongPress={() => {
                setLongPressedMember(item);
                setUserListOptionsVisible(true);
              }}
              delayLongPress={500}
            >
              <View style={[styles.userAvatar, { backgroundColor: theme.primary }]}>
                {getProfilePictureURL(item) ? (
                  <Image 
                    source={{ uri: getProfilePictureURL(item) }} 
                    style={styles.userAvatarImage}
                  />
                ) : (
                  <Text style={styles.userAvatarText}>
                    {(() => {
                      const rawName = item.name || 'U';
                      const safeName = String(rawName).trim();
                      if (!safeName) return 'U';
                      const firstChar = safeName.charAt(0).toUpperCase();
                      // Ensure we never return problematic characters like periods
                      if (/^[A-Z0-9]$/i.test(firstChar)) {
                        return firstChar;
                      }
                      return 'U';
                    })()}
                  </Text>
                )}
                {/* Online status indicator */}
                {item.isOnline !== undefined && item.lastSeen && (
                  <View style={[styles.onlineIndicator, { backgroundColor: item.isOnline ? theme.success : theme.error }]} />
                )}
              </View>

              {/* User Info */}
              <View style={styles.userInfo}>
                <View style={styles.userHeaderRow}>
                  <Text style={[styles.userName, { color: theme.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={styles.chatMetaContainer}>
                    {item.pinnedSerial ? (
                      <View style={[styles.pinnedBadge, { backgroundColor: theme.primary + '20' }]}>
                        <Star size={12} color={theme.primary} />
                        <Text style={[styles.pinnedText, { color: theme.primary }]}>{item.pinnedSerial}</Text>
                      </View>
                    ) : null}
                    {/* Last message time */}
                    {item.lastMessageTime && typeof item.lastMessageTime === 'string' && item.lastMessageTime.trim().length > 0 && (
                      <Text style={[
                        styles.lastMessageTime, 
                        { color: (item.unreadCount && item.unreadCount > 0) ? theme.primary : theme.textSecondary }
                      ]}>
                        {item.lastMessageTime}
                      </Text>
                    )}
                    <TenantRoleBadge role={(item as any)?.tenantRole ?? null} style={{ marginLeft: 6 }} />
                  </View>
                </View>
                
                <View style={styles.userStatusRow}>
                  {item.typingTo && item.typingTo === effectiveUserEmail ? (
                    <View style={styles.typingIndicatorSmall}>
                      <AnimatedTypingIndicator color={theme.primary} />
                      <Text style={[styles.userStatus, { color: theme.primary, fontStyle: 'italic', marginLeft: 8 }]}>
                        typing...
                      </Text>
                    </View>
                  ) : item.lastMessage ? (
                    <View style={styles.lastMessageContainer}>
                      {/* Show status ticks for own messages */}
                      {item.lastMessage.isOwnMessage && (
                        <MessageStatusTicks 
                          delivered={item.lastMessage.delivered}
                          deliveredAt={null}
                          read={item.lastMessage.read}
                          readAt={null}
                          color={theme.textSecondary}
                          size={12}
                          theme={isDarkMode ? 'dark' : 'light'}
                        />
                      )}
                      <Text 
                        style={[
                          styles.lastMessageText,
                          // Make unread messages bold for recipient (when it's NOT own message and has unread count)
                          (!item.lastMessage.isOwnMessage && item.unreadCount && item.unreadCount > 0) ? {
                            fontWeight: 'bold',
                            color: theme.text, // Use primary text color for unread messages
                            fontFamily: 'Inter-Bold', // Use bold font family if available
                          } : {
                            color: theme.textSecondary,
                            fontFamily: 'Inter-Regular',
                          }
                        ]} 
                        numberOfLines={1}
                      >
                        {(() => {
                          const safeMessageText = String(item.lastMessage.text || '📎 Attachment').trim();
                          // Ensure message text isn't just a period or empty
                          if (!safeMessageText || safeMessageText === '.' || safeMessageText.length === 0) return '📎 Attachment';
                          return safeMessageText;
                        })()}
                      </Text>
                    </View>
                  ) : (() => {
                    const presenceLabel = formatOnlineStatus(item.isOnline, item.lastSeen);
                    if (!presenceLabel) return null;
                    return (
                      <Text style={[styles.userStatus, { color: theme.textSecondary }]} numberOfLines={1}>
                        {presenceLabel}
                      </Text>
                    );
                  })()}
                </View>
              </View>

              {/* Right side - Unread count */}
              <View style={styles.userListRight}>
                {item.unreadCount && item.unreadCount > 0 ? (
                  <View style={[styles.unreadBadge, { backgroundColor: theme.primary }]}>
                    <Text style={styles.unreadCount}>
                      {item.unreadCount > 99 ? '99+' : item.unreadCount}
                    </Text>
                  </View>
                ) : (
                  <MessageCircle size={20} color={theme.textSecondary} />
                )}
              </View>
            </TouchableOpacity>
          );
          }}
          style={styles.usersList}
          showsVerticalScrollIndicator={false}
          refreshing={isLoadingChatInfo || teamMembersLoading}
          onRefresh={() => {
            void Promise.all([refreshChatSummaries(), loadTenantTeamMembers()]);
          }}
          ListEmptyComponent={() => (
            <View style={styles.emptyUsersList}>
              <MessageCircle size={48} color={teamMembersError ? theme.error : theme.textSecondary} />
              <Text
                style={[styles.emptyUsersText, { color: teamMembersError ? theme.error : theme.text }]}
              >
                {teamMembersError ?? 'No team members found'}
              </Text>
              <Text style={[styles.emptyUsersSubtext, { color: theme.textSecondary }]}> 
                {teamMembersError
                  ? 'Pull to refresh or check your connection.'
                  : searchQuery.trim().length > 0
                    ? 'Try a different search or clear your query'
                    : 'Team members will appear here when they sign in'}
              </Text>
            </View>
          )}
        />
        <OptionModal
          visible={userListOptionsVisible && !!longPressedMember}
          onClose={() => { setUserListOptionsVisible(false); setLongPressedMember(null); }}
          title={longPressedMember?.name || 'Chat options'}
          actions={(() => {
            if (!longPressedMember || !user?.email) return [];
            const key = chatPreferencesService.sanitizeEmailKey(longPressedMember.email);
            const isPinned = !!pinnedChats[key];
            return [
              {
                text: isPinned ? 'Unpin chat' : 'Pin chat',
                onPress: async () => {
                  try {
                    if (isPinned) await chatPreferencesService.unpinChat(user.email, longPressedMember.email);
                    else await chatPreferencesService.pinChat(user.email, longPressedMember.email);
                  } catch (e) {
                    Toast.show({ type: 'error', text1: 'Failed to update pin' });
                  }
                },
                style: 'primary',
                icon: <Star size={16} color={'#ffffff'} />,
              },
            ] as any;
          })()}
        />
      </SafeAreaView>
    );
  }

  // Chat View - When user is selected
  if (loading || showOfflineLoadingChat) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={[styles.container, styles.centered]}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading messages...</Text>
          {!!offlineHintChat && (
            <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 8 }]}>{offlineHintChat}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={[styles.container, styles.centered]}>
          <Text style={[styles.errorText, { color: theme.error }]}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView 
      style={[styles.container, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      {...(Platform.OS === 'web'
        ? ({
            onDragOver: handleChatPageDragOver,
            onDragLeave: handleChatPageDragLeave,
            onDrop: handleChatPageDrop,
          } as any)
        : {})}
    >
  {/* Header with User Selection */}
  <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
        <TouchableOpacity 
          onPress={() => {
            Keyboard.dismiss(); // Manually hide keyboard when going back
            setSelectedTeamMember(null);
          }} 
          style={styles.backButton}
        >
          <ArrowLeft size={24} color={theme.text} />
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={styles.friendInfo}
          onPress={() => setChatProfileModalVisible(true)}
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
      {(() => {
        const rawName = selectedTeamMember?.name || 'T';
        const safeName = String(rawName).trim();
        if (!safeName) return 'T';
        const firstChar = safeName.charAt(0).toUpperCase();
        // Ensure we never return problematic characters like periods
        if (/^[A-Z0-9]$/i.test(firstChar)) {
          return firstChar;
        }
        return 'T';
      })()}
    </Text>
  )}
</View>

          <View>
            <View style={styles.friendNameRow}>
              <Text allowFontScaling={false} style={[styles.friendName, { color: theme.text }]}> 
                {selectedTeamMember?.name || 'Select Team Member'}
              </Text>
              {!!selectedTeamMember && (
                <TenantRoleBadge role={(selectedTeamMember as any)?.tenantRole ?? null} style={{ marginLeft: 8 }} />
              )}
            </View>
            <View style={styles.friendStatusContainer}>
              {selectedTeamMember?.isOnline !== undefined && selectedTeamMember?.lastSeen && (
                <View style={[
                  styles.statusDot,
                  { backgroundColor: selectedTeamMember.isOnline ? theme.success : theme.textSecondary }
                ]} />
              )}
              <Text allowFontScaling={false} style={[styles.friendStatus, { color: theme.textSecondary }]}>
                {isTyping ? (
                  <Text allowFontScaling={false} style={{ color: theme.primary, fontStyle: 'italic' }}>
                    typing...
                  </Text>
                ) : (
                  formatOnlineStatus(selectedTeamMember?.isOnline, selectedTeamMember?.lastSeen)
                )}
              </Text>
              {isTyping && (
                <AnimatedTypingIndicator color={theme.primary} />
              )}
            </View>
          </View>
        </TouchableOpacity>

      </View>

      {/* Messages */}
      <View style={styles.messagesWrapper}>
        {/* Sticky Date Header */}
        {stickyDateVisible && (
          <View style={[styles.stickyDateHeader, { backgroundColor: 'transparent', pointerEvents: 'none' }]}> 
            <View style={[styles.stickyDateContainer, { 
              backgroundColor: theme.surface, 
              borderColor: theme.border,
              ...(Platform.OS === 'web' ? {} : { shadowColor: theme.text })
            }]}> 
              <Text style={[styles.stickyDateText, { color: theme.textSecondary }]}> 
                {(() => {
                  const safeDate = typeof stickyDateText === 'string' ? stickyDateText.trim() : '';
                  if (!safeDate || safeDate === '.' || safeDate.length === 0) return 'Today';
                  return safeDate;
                })()}
              </Text>
            </View>
          </View>
        )}
        
        <View
          style={[styles.messagesContainer, !isInitialAnchorSettled && styles.messagesContainerHidden]}
        >
          <FlashList
            ref={flatListRef}
            key={selectedTeamMember?.id || selectedTeamMember?.email || 'chat'}
            data={displayedMessages}
            estimatedItemSize={estimatedItemSize}
            keyExtractor={getMessageKey}
            estimatedListSize={estimatedListSize}
            drawDistance={Math.max(estimatedListSize.height * 2, 1600)}
            onViewableItemsChanged={onViewableItemsChangedRef.current}
            viewabilityConfig={viewabilityConfigRef.current}
            getItemType={getMessageItemType}
            overrideItemLayout={overrideMessageLayout}
            renderItem={({ item, index }) => {
                const previousMsg = index > 0 ? displayedMessages[index - 1] : undefined;
                const dateSeparator = getChatDateSeparator(item.timestamp, previousMsg?.timestamp);

                const shouldShowUnreadSeparator = showUnreadSeparator && unreadSeparatorMessageId === item.id;
                  // New messages divider (only if not showing unread separator at same spot)
                  const shouldShowNewDivider = showNewDivider && newDividerMessageId === item.id && !shouldShowUnreadSeparator;

                return (
                  <View
                    onLayout={(event) => {
                      const { y, height } = event.nativeEvent.layout;
                      const currentDate = getMessageDate(item, previousMsg);
                      if (item.id) {
                        const messageId = String(item.id);
                        const newPosition = { y, height, date: currentDate || '' };
                        setMessagePositions(prev => {
                          const existingPosition = prev[messageId];
                          if (existingPosition &&
                              existingPosition.y === newPosition.y &&
                              existingPosition.height === newPosition.height &&
                              existingPosition.date === newPosition.date) {
                            return prev;
                          }
                          const next = { ...prev };
                          next[messageId] = newPosition;
                          return next;
                        });
                      }
                    }}
                  >
                    {dateSeparator && typeof dateSeparator === 'string' && dateSeparator.trim().length > 0 && (
                      <View style={styles.dateSeparatorContainer}>
                        <View style={[styles.dateSeparatorLine, { backgroundColor: theme.border }]} />
                        <Text style={[styles.dateSeparatorText, { backgroundColor: theme.background, color: theme.textSecondary }]}>
                          {(() => {
                            const safeDate = String(dateSeparator).trim();
                            if (!safeDate || safeDate === '.' || safeDate.length === 0) return 'Today';
                            return safeDate;
                          })()}
                        </Text>
                        <View style={[styles.dateSeparatorLine, { backgroundColor: theme.border }]} />
                      </View>
                    )}

                    {shouldShowUnreadSeparator && unreadSeparatorMessageId && (
                      <View style={styles.dateSeparatorContainer}>
                        <View style={[styles.dateSeparatorLine, { backgroundColor: isDarkMode ? '#FF4444' : '#FF0000' }]} />
                        <Text style={[styles.dateSeparatorText, { backgroundColor: theme.background, color: isDarkMode ? '#FF4444' : '#FF0000', fontWeight: '600' }]}>
                          Unread messages
                        </Text>
                        <View style={[styles.dateSeparatorLine, { backgroundColor: isDarkMode ? '#FF4444' : '#FF0000' }]} />
                      </View>
                    )}
                    {shouldShowNewDivider && (
                      <View style={styles.dateSeparatorContainer}>
                        <View style={[styles.dateSeparatorLine, { backgroundColor: theme.primary }]} />
                        <Text style={[styles.dateSeparatorText, { backgroundColor: theme.background, color: theme.primary, fontWeight: '600' }]}>
                          New messages
                        </Text>
                        <View style={[styles.dateSeparatorLine, { backgroundColor: theme.primary }]} />
                      </View>
                    )}

                    <MessageRow item={item} />
                  </View>
                );
              }}
            contentContainerStyle={StyleSheet.flatten([
              styles.messagesContent,
              { paddingBottom: bottomVisibilityPadding },
            ])}
            showsVerticalScrollIndicator={false}
            onScroll={(e) => {
            handleScroll(e);
            try {
              const y = e.nativeEvent.contentOffset?.y ?? 0;
              const contentH = e.nativeEvent.contentSize?.height ?? 0;
              const layoutH = e.nativeEvent.layoutMeasurement?.height ?? 0;
              const bottomBuffer = bottomVisibilityPadding;
              const distanceFromBottom = Math.max(0, contentH - (y + layoutH));
              const nearBottomThreshold = bottomBuffer + 32;
              const nearBottom = distanceFromBottom <= nearBottomThreshold;
              isAtBottomRef.current = nearBottom;
              if (nearBottom) {
                setShowScrollToBottom(false);
                setUnseenCount(0);
                setShowNewDivider(false);
                setNewDividerMessageId(null);
              } else {
                // Always show the FAB when user is not at the bottom
                setShowScrollToBottom(true);
              }
            } catch {}
          }}
            scrollEventThrottle={32}
            onContentSizeChange={(_w, h) => {
            contentHeightRef.current = h;
            if (shouldUseManualAnchorPreservation && pendingPrependAnchorRef.current) {
              restorePrependAnchorIfNeeded();
              if (pendingPrependAnchorRef.current) return;
            }
            if (anchoredTargetRef.current) {
              ensureAnchorPosition();
              if (anchoredTargetRef.current) return;
            }
            if (hasAnchoredInitialScrollRef.current) return;

            if (firstUnreadMessageId && !scrollToUnreadAttemptedRef.current) {
              scheduleScrollToUnread(firstUnreadMessageId);
            } else if (pendingInitialAnchorRef.current) {
              tryAnchorToBottom();
            }
          }}
            onLayout={(e) => {
            layoutHeightRef.current = e.nativeEvent.layout.height;
            if (shouldUseManualAnchorPreservation && pendingPrependAnchorRef.current) {
              restorePrependAnchorIfNeeded();
              if (pendingPrependAnchorRef.current) return;
            }
            if (anchoredTargetRef.current) {
              ensureAnchorPosition();
              if (anchoredTargetRef.current) return;
            }
            if (hasAnchoredInitialScrollRef.current) return;

            if (firstUnreadMessageId && !scrollToUnreadAttemptedRef.current) {
              scheduleScrollToUnread(firstUnreadMessageId);
            } else if (pendingInitialAnchorRef.current) {
              tryAnchorToBottom();
            }
          }}
            maintainVisibleContentPosition={maintainVisibleContentPositionConfig}
            ListHeaderComponent={(
              <View style={{ alignItems: 'center', marginVertical: 8 }}>
                {loadingMore ? (
                  <ActivityIndicator color={theme.primary} size="small" />
                ) : reachedConversationStart ? (
                  <Text style={{ color: theme.textSecondary }}>
                    {"You're at the beginning of this conversation"}
                  </Text>
                ) : null}
              </View>
            )}
            ListFooterComponent={(
              <View>
                {/* Optimistic pending media (stickers/GIFs) */}
                {pendingMedia && Array.from(pendingMedia.entries()).map(([tempId, item]) => {
                  if (!tempId || !item) return null;
                  const rendered = renderPendingMedia(tempId, item);
                  if (typeof rendered === 'string') return null;
                  return rendered;
                })}

                {/* Offline pending text messages */}
                {pendingMessages && Array.from(pendingMessages.entries()).map(([tempId, pendingMsg]) => {
                  if (!tempId || !pendingMsg) return null;
                  const renderedPending = renderPendingMessage(tempId, pendingMsg);
                  if (typeof renderedPending === 'string') {
                    logger.warn('⚠️ renderPendingMessage returned string:', JSON.stringify(renderedPending));
                    return null;
                  }
                  return renderedPending;
                })}

                {/* Optimistic pending file attachments */}
                {pendingAttachments && Array.from(pendingAttachments.entries()).map(([tempId, item]) => {
                  if (!tempId || !item) return null;
                  const rendered = renderPendingAttachments(tempId, item);
                  if (typeof rendered === 'string') return null;
                  return rendered;
                })}

                {/* Typing indicator */}
                {isTyping && selectedTeamMember && (
                  <View style={[styles.typingIndicator, { backgroundColor: theme.surface }]}> 
                    <View style={[styles.typingDots, { backgroundColor: theme.primary }]}> 
                      <Text style={styles.typingText}> 
                        {(() => {
                          const rawName = selectedTeamMember?.name || 'Someone';
                          const safeName = typeof rawName === 'string' ? rawName.trim() : 'Someone';
                          if (!safeName || safeName === '.' || safeName.length === 0) return 'Someone';
                          return safeName;
                        })()} is typing...
                      </Text>
                    </View>
                  </View>
                )}

                {/* Add extra padding at bottom to ensure typing indicator is visible */}
                <View style={{ height: 20 }} />
              </View>
            )}
            ListEmptyComponent={(() => {
              const hasPending =
                (pendingMedia && pendingMedia.size > 0) ||
                (pendingMessages && pendingMessages.size > 0) ||
                (pendingAttachments && pendingAttachments.size > 0);
              const hasLoadError = Boolean(error);
              const shouldDeferEmptyState =
                loading ||
                loadingMore ||
                !selectedTeamMember ||
                hasMore ||
                hasLoadError;

              if (hasPending || shouldDeferEmptyState) {
                if (selectedTeamMember && hasLoadError) {
                  if (showReconnectFallback) {
                    return (
                      <View style={styles.emptyState}>
                        <View style={[styles.reconnectCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                          <Text style={[styles.reconnectTitle, { color: theme.text }]}>Couldn't load messages</Text>
                          <Text style={[styles.reconnectSubtext, { color: theme.textSecondary }]}>
                            {isOffline
                              ? "You're offline right now. Reconnect to the internet, then try again."
                              : 'Please check your connection and try reconnecting.'}
                          </Text>
                          <TouchableOpacity
                            onPress={handleManualReconnect}
                            activeOpacity={0.85}
                            style={[styles.reconnectButton, { backgroundColor: theme.primary }]}
                          >
                            <Text style={styles.reconnectButtonText}>Reconnect</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  }
                  return (
                    <View style={styles.emptyState}>
                      <ActivityIndicator color={theme.primary} size="small" />
                      <Text style={[styles.reconnectHintText, { color: theme.textSecondary }]}>Trying to reconnect…</Text>
                    </View>
                  );
                }
                return null;
              }
              return (
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyStateText, { color: theme.text }]}> 
                    {(() => {
                      const safeText = selectedTeamMember ? 'No messages yet' : 'Select a team member';
                      if (typeof safeText !== 'string' || safeText.trim() === '.' || safeText.trim().length === 0) {
                        return 'No messages';
                      }
                      return safeText;
                    })()}
                  </Text>
                  <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}> 
                    {(() => {
                      const safeName = (() => {
                        if (!selectedTeamMember) return '';
                        const rawName = selectedTeamMember.name;
                        if (typeof rawName !== 'string') return 'someone';
                        const trimmed = rawName.trim();
                        if (!trimmed || trimmed === '.' || trimmed.length === 0) return 'someone';
                        return trimmed;
                      })();
                      const safeSubtext = selectedTeamMember 
                        ? `Start a conversation with ${safeName}!`
                        : 'Choose a team member from the list to start chatting';
                      if (
                        typeof safeSubtext !== 'string' ||
                        safeSubtext.trim() === '.' ||
                        safeSubtext.trim().length === 0 ||
                        React.isValidElement(safeSubtext)
                      ) {
                        return <Text style={{ color: theme.textSecondary }}>Start a conversation!</Text>;
                      }
                      return safeSubtext;
                    })()}
                  </Text>
                </View>
              );
            })()}
          />
        </View>
        {!isInitialAnchorSettled && (
          <View style={[styles.loadingOverlay, { backgroundColor: theme.background, pointerEvents: 'auto' }]}>
            <ActivityIndicator size="large" color={theme.primary} />
          </View>
        )}
        {showScrollToBottom && (
          <TouchableOpacity
            onPress={() => {
              setUnseenCount(0);
              setShowScrollToBottom(false);
                setShowNewDivider(false);
                setNewDividerMessageId(null);
              scrollToBottom();
            }}
            activeOpacity={0.8}
            style={{
              position: 'absolute',
              right: 12,
              bottom: 12 + Math.max(0, (inputHeight || 40) - 40),
              backgroundColor: theme.surface,
              borderColor: theme.border,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: 20,
              paddingHorizontal: 12,
              paddingVertical: 10,
              flexDirection: 'row',
              alignItems: 'center',
              shadowColor: '#000',
              shadowOpacity: 0.1,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 2 },
              elevation: 2,
            }}
          >
            <ChevronDown size={18} color={theme.text} />
            {unseenCount > 0 && (
              <View style={{
                marginLeft: 8,
                minWidth: 22,
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 10,
                backgroundColor: theme.primary,
              }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>{unseenCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Special Command Suggestion */}
      {Platform.OS === 'web' && showSpecialCommand && (
        <View style={[styles.commandSuggestion, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity 
            style={[styles.commandOption, { backgroundColor: theme.background }]}
            onPress={handleSpecialCommandSelect}
          >
            <Star size={20} color={theme.warning} />
            <View style={styles.commandOptionText}>
              <Text style={[styles.commandOptionTitle, { color: theme.text }]}>Send Special Message</Text>
              <Text style={[styles.commandOptionDescription, { color: theme.textSecondary }]}>
                Send a highlighted message with special styling
              </Text>
            </View>
            <View style={[styles.commandBadge, { backgroundColor: theme.warning }]}>
              <Text style={styles.commandBadgeText}>⭐</Text>
            </View>
          </TouchableOpacity>
        </View>
      )}

      {/* Special Message Indicator */}
      {isComposingSpecial && (
        <View style={[styles.specialIndicator, { backgroundColor: theme.warning }]}>
          <Star size={16} color="#ffffff" />
          <Text style={styles.specialIndicatorText}>Composing Special Message</Text>
          <TouchableOpacity 
            onPress={() => {
              clearInputField(); // Use helper function to clear input
            }}
            style={styles.specialIndicatorClose}
          >
            <X size={16} color="#ffffff" />
          </TouchableOpacity>
        </View>
      )}

      {/* Formatting Guide */}
      {showFormattingGuide && (
        <View style={[styles.formattingGuide, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
          <View style={styles.formattingHeader}>
            <Text style={[styles.formattingTitle, { color: theme.text }]}>Text Formatting</Text>
            <TouchableOpacity onPress={hideFormattingGuide}>
              <X size={18} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
          
          {/* Quick format buttons */}
          {Platform.OS === 'web' && (
            <View style={styles.quickFormatButtons}>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={() => {
                  const newText = message + '***extra bold***';
                  setMessage(newText);
                }}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, fontWeight: '900' }]}>B+</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={() => {
                  const newText = message + '**bold**';
                  setMessage(newText);
                }}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, fontWeight: 'bold' }]}>B</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={() => {
                  const newText = message + '*italic*';
                  setMessage(newText);
                }}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, fontStyle: 'italic' }]}>I</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={() => {
                  const newText = message + '__underline__';
                  setMessage(newText);
                }}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, textDecorationLine: 'underline' }]}>U</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={() => {
                  const newText = message + '~~strike~~';
                  setMessage(newText);
                }}
              >
                <Text style={[styles.quickFormatButtonText, { color: theme.text, textDecorationLine: 'line-through' }]}>S</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: theme.background }]}
                onPress={() => {
                  const newText = message + '`code`';
                  setMessage(newText);
                }}
              >
                <Text style={[styles.quickFormatButtonText, { 
                  color: theme.text, 
                  fontFamily: 'monospace' 
                }]}>{'<>'}</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickFormatButton, { backgroundColor: '#FFF7CC', borderColor: '#FFD24C' }]}
                onPress={() => {
                  const newText = message + '/special';
                  setMessage(newText);
                }}
              >
                <Text style={[styles.quickFormatButtonText, { color: '#B8860B', fontWeight: 'bold' }]}>⭐</Text>
              </TouchableOpacity>
            </View>
          )}
          
          <View style={styles.formattingOptions}>
            <View style={[styles.formattingRow, { flexDirection: 'row', alignItems: 'center' }]}> 
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>***extra bold***</Text>
              <Text style={[styles.formattingResult, { color: theme.text, fontWeight: '900', fontSize: 16 }]}>extra bold</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>**bold text**</Text>
              <Text style={[styles.formattingResult, { color: theme.text, fontWeight: 'bold' }]}>bold text</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>*italic text*</Text>
              <Text style={[styles.formattingResult, { color: theme.text, fontStyle: 'italic' }]}>italic text</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>__underline__</Text>
              <Text style={[styles.formattingResult, { color: theme.text, textDecorationLine: 'underline' }]}>underline</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>~~strikethrough~~</Text>
              <Text style={[styles.formattingResult, { color: theme.text, textDecorationLine: 'line-through' }]}>strikethrough</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>`code text`</Text>
              <Text style={[styles.formattingResult, {
                color: theme.text,
                fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                backgroundColor: theme.background,
                paddingHorizontal: 4,
                paddingVertical: 1,
                borderRadius: 3,
                alignSelf: 'flex-start'
              }]}>code text</Text>
            </View>
            <View style={styles.formattingRow}>
              <Text style={[styles.formattingExample, { color: theme.textSecondary }]}>/special</Text>
              <Text style={[styles.formattingResult, {
                color: '#FFD700',
                fontWeight: 'bold',
                backgroundColor: 'rgba(255, 215, 0, 0.2)',
                paddingHorizontal: 4,
                paddingVertical: 1,
                borderRadius: 3,
                borderWidth: 1,
                borderColor: '#FFD700',
                alignSelf: 'flex-start'
              }]}>✨special text✨</Text>
            </View>
          </View>
        </View>
      )}
      {/* Input Area - Mobile vs Web */}
      {editingMessageInfo && (
        <View
          style={[
            styles.editingBanner,
            {
              borderColor: theme.primary,
              backgroundColor: isDarkMode ? theme.primary + '33' : theme.primary + '18',
            },
          ]}
        >
          <Edit3 size={16} color={theme.primary} style={styles.editingBannerIcon} />
          <View style={styles.editingBannerCopy}>
            <Text style={[styles.editingBannerTitle, { color: theme.primary }]}>Editing message</Text>
            <Text
              style={[
                styles.editingBannerDescription,
                { color: editingPreviewText ? theme.text : theme.textSecondary },
              ]}
              numberOfLines={1}
            >
              {editingPreviewText || 'Make your changes below'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.editingBannerClose, { borderColor: theme.primary }]}
            onPress={cancelEditingMessage}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Cancel editing"
          >
            <X size={14} color={theme.primary} />
            <Text style={[styles.editingBannerCloseText, { color: theme.primary }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
      {Platform.OS === 'web' ? (
        /* Web Input (Original) */
        <View style={[styles.inputContainer, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
          <View style={[styles.inputWrapper, { backgroundColor: theme.background, borderColor: theme.border }]}>
            <TouchableOpacity 
              style={styles.attachButton}
              onPress={openAttachmentModal}
            >
              <Paperclip size={20} color={theme.primary} />
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={styles.stickerButton}
              onPress={openStickerGifPicker}
            >
              <Smile size={20} color={theme.primary} />
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.formattingButton, showFormattingGuide && { backgroundColor: theme.primary + '20' }]}
              onPress={toggleFormattingGuide}
            >
              <Edit3 size={18} color={showFormattingGuide ? theme.primary : theme.textSecondary} />
            </TouchableOpacity>
            {Platform.OS === 'web' ? (
              <TextInput
                ref={textInputRef}
                style={[styles.textInput, { color: theme.text, height: inputHeight }]}
                value={message}
                onChangeText={handleTyping}
                onContentSizeChange={handleInputSizeChange}
                underlineColorAndroid="transparent"
                placeholder={
                  (() => {
                    if (isOffline) return 'Offline - messages will be queued';
                    if (isComposingSpecial) return 'Type your special message here...';
                    if (isSmallScreen) return 'Message';
                    const rawName = selectedTeamMember?.name || 'team member';
                    const safeName = typeof rawName === 'string' ? rawName.trim() : 'team member';
                    if (!safeName || safeName === '.' || safeName.length === 0) return 'Message team member...';
                    return `Message ${safeName}...`;
                  })()
                }
                placeholderTextColor={isOffline ? theme.warning : theme.textSecondary}
                multiline={true}
                numberOfLines={1}
                textAlignVertical="top"
                maxLength={500}
                editable={!!selectedTeamMember}
                blurOnSubmit={false}
                enablesReturnKeyAutomatically={false}
                returnKeyType="send"
                onSubmitEditing={handleSendMessage}
              />
            ) : (
              <RichEditText
                // @ts-ignore - RichEditText ref handling
                ref={richTextInputRef}
                style={[styles.textInput, { color: theme.text, height: inputHeight }]}
                value={message}
                onChangeText={handleTyping}
                onContentSizeChange={handleInputSizeChange}
                underlineColorAndroid="transparent"
                placeholder={
                  (() => {
                    if (processingKeyboardMedia) return 'Processing media from keyboard...';
                    if (isOffline) return 'Offline - messages will be queued';
                    if (isComposingSpecial) return 'Type your special message here...';
                    if (isSmallScreen) return 'Message';
                    const rawName = selectedTeamMember?.name || 'team member';
                    const safeName = typeof rawName === 'string' ? rawName.trim() : 'team member';
                    if (!safeName || safeName === '.' || safeName.length === 0) return 'Message team member...';
                    return `Message ${safeName}...`;
                  })()
                }
                placeholderTextColor={processingKeyboardMedia ? theme.primary : (isOffline ? theme.warning : theme.textSecondary)}
                multiline={true}
                numberOfLines={1}
                textAlignVertical="top"
                maxLength={500}
                editable={!!selectedTeamMember && !processingKeyboardMedia}
                blurOnSubmit={false}
                enablesReturnKeyAutomatically={false}
                returnKeyType="send"
                onSubmitEditing={handleSendMessage}
                onRichContent={handleRichContentFromMobile}
              />
            )}
            
            {/* Format Preview */}
            {message && typeof message === 'string' && message.trim().length > 0 && (message.includes('***') || message.includes('**') || message.includes('*') || message.includes('__') || message.includes('~~') || message.includes('`')) && !message.includes('/special') && (
              <View style={[styles.formatPreview, { backgroundColor: theme.background, borderColor: theme.border }]}>
                <Text style={[styles.formatPreviewLabel, { color: theme.textSecondary }]}>Preview:</Text>
                <StyledText
                  text={(() => {
                    const safeMessage = String(message || '');
                    // Prevent periods or problematic text from being rendered in preview
                    if (!safeMessage || safeMessage.trim() === '.' || safeMessage.trim().length === 0) {
                      return 'Message preview';
                    }
                    return safeMessage;
                  })()}
                  style={[styles.formatPreviewText, { color: theme.text }]}
                  linkStyle={{ color: theme.primary }}
                />
              </View>
            )}
            
            <TouchableOpacity 
              style={[
                styles.sendButton,
                {
                  backgroundColor: canAttemptSend
                    ? (isOffline
                        ? theme.warning
                        : isComposingSpecial
                          ? theme.warning
                          : theme.primary)
                    : theme.border,
                }
              ]}
              onPress={handleSendMessage}
              disabled={!canAttemptSend}
            >
              {isOffline && canAttemptSend ? (
                <Clock size={20} color="#ffffff" />
              ) : isComposingSpecial && canAttemptSend ? (
                <Star size={20} color="#ffffff" />
              ) : (
                <Send size={20} color={canAttemptSend ? '#ffffff' : theme.textSecondary} />
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        /* Mobile Input (New Component) */
        <MobileChatInput
          ref={mobileInputRef}
          message={message}
          onMessageChange={handleTyping}
          onSendMessage={handleSendMessage}
          onAttachmentPress={openAttachmentModal}
          onStickerPress={openStickerGifPicker}
          selectedTeamMember={selectedTeamMember}
          isOffline={isOffline}
          isComposingSpecial={isComposingSpecial}
          processingKeyboardMedia={processingKeyboardMedia}
          onRichContent={handleRichContentFromMobile}
          showFormattingGuide={showFormattingGuide}
          onFormattingToggle={toggleFormattingGuide}
          maxLength={500}
          isSendingMessage={isSendingMessage}
          canSend={canAttemptSend}
        />
      )}

      {Platform.OS === 'web' && isChatDropActive && selectedTeamMember && (
        <View pointerEvents="none" style={styles.chatDropOverlay}>
          <View style={[styles.chatDropCard, { backgroundColor: theme.surface, borderColor: theme.primary }]}> 
            <FileIcon size={26} color={theme.primary} />
            <Text style={[styles.chatDropTitle, { color: theme.text }]}>Drop files to send</Text>
            <Text style={[styles.chatDropSubtitle, { color: theme.textSecondary }]}>Files will open in preview before sending</Text>
          </View>
        </View>
      )}

      {/* Modals */}
      {renderAttachmentModal()}
      {renderFilePreviewModal()}
      {renderImageViewerModal()}
  {renderEmojiPickerModal()}

      <ConfirmationModal
        visible={deleteConfirmState.visible}
        onClose={() => setDeleteConfirmState({ visible: false, message: null })}
        title="Delete message?"
        message="This will remove the message for everyone in the conversation."
        confirmText={isDeletePending ? 'Deleting…' : 'Delete'}
        cancelText="Cancel"
        confirmStyle="destructive"
        confirmDisabled={isDeletePending}
        confirmLoading={isDeletePending}
        cancelDisabled={isDeletePending}
        autoCloseOnConfirm={false}
        statusMessage={deleteConfirmationPreview || undefined}
        statusType="error"
        icon={<Trash2 size={28} color={theme.error} />}
        onConfirm={() => {
          const target = deleteConfirmState.message;
          if (target) {
            void performDeleteMessage(target);
          } else {
            setDeleteConfirmState({ visible: false, message: null });
          }
        }}
      />

  {/* Sticker and GIF Picker (Mobile) */}
  <StickerGifPickerMobile
    visible={stickerGifPickerVisible}
    onClose={closeStickerGifPicker}
    onSelectSticker={handleStickerSelect}
    onSelectGif={handleGifSelect}
  />
      
      {/* Chat Profile Modal */}
      <ChatProfileModal
        visible={chatProfileModalVisible}
        onClose={() => setChatProfileModalVisible(false)}
        teamMember={selectedTeamMember}
        theme={theme}
      />

    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  errorText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  
  // User List View Styles
  headerTitle: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
  },
  headerButton: {
    padding: 8,
  },
  userListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  userHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  userStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userListArrow: {
    marginLeft: 'auto',
    paddingLeft: 16,
  },
  adminBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    marginLeft: 8,
  },
  adminBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter-Bold',
  },
  
  // Chat View Styles
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
  moreButton: {
    padding: 8,
  },
  messagesContainer: {
    flex: 1,
    minHeight: 8,
    width: '100%',
    alignSelf: 'stretch',
  },
  messagesContainerHidden: {
    opacity: 0,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: Platform.OS === 'web' ? 8 : 6,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
  },
  searchInput: {
    flex: 1,
    marginLeft: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    paddingVertical: Platform.OS === 'ios' ? 0 : 2,
    height: Platform.OS === 'ios' ? 28 : 34,
  },
  messagesContent: {
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  messageContainer: {
    marginBottom: 16,
  },
  ownMessage: {
    alignItems: 'flex-end',
  },
  friendMessage: {
    alignItems: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
  },
  messageActionAnchor: {
    position: 'relative',
  },
  editingMessageGlow: {
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 0 3px rgba(59, 130, 246, 0.2)' }
      : {
          shadowColor: 'rgba(59, 130, 246, 0.7)',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.3,
          shadowRadius: 6,
          elevation: 5,
        }),
  },
  editingTag: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.5)',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    marginBottom: 8,
  },
  editingTagText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  messagePendingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  messagePendingText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 6,
  },
  ownBubble: {
    borderBottomRightRadius: 4,
  },
  friendBubble: {
    borderBottomLeftRadius: 4,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 1,
      },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    }),
  },
  messageText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    lineHeight: 22,
  },
  ownMessageText: {
    color: '#ffffff',
  },
  friendMessageText: {
    // Color will be set dynamically
  },
  messageMeta: {
    fontSize: 11,
    fontFamily: 'Inter-Medium',
    marginRight: 6,
  },
  messageMetaOwn: {
    color: 'rgba(255, 255, 255, 0.8)',
  },
  messageMetaFriend: {
    color: 'rgba(110, 118, 129, 1)',
  },
  messageTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  ownMessageTime: {
    color: 'rgba(255, 255, 255, 0.7)',
    textAlign: 'right',
  },
  friendMessageTime: {
    // Color will be set dynamically
  },

  deletedMessageContainer: {
    width: '100%',
  },
  deletedMessageBubble: {
    maxWidth: '75%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: 'dashed',
    opacity: 0.9,
  },
  deletedMessageBubbleOwn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.4)',
  },
  deletedMessageBubbleFriend: {
    backgroundColor: 'rgba(229, 231, 235, 0.35)',
    borderColor: 'rgba(148, 163, 184, 0.6)',
  },
  deletedMessageContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  deletedMessageText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  deletedMessageTextOwn: {
    color: 'rgba(255, 255, 255, 0.85)',
  },
  deletedMessageTime: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
    marginTop: 6,
  },
  
  // File attachment styles
  fileContainer: {
    marginBottom: 8,
  },
  attachmentSkeleton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  attachmentSkeletonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  attachmentSkeletonSubtext: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  imageAttachment: {
    width: 200,
    height: 150,
    borderRadius: 12,
  },
  fileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 4,
  },
  deletedFileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    opacity: 0.6,
  },
  networkErrorAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginTop: 6,
    borderWidth: 1,
    alignSelf: 'stretch',
  },
  networkErrorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  networkErrorText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 8,
  },
  networkErrorRetryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    marginLeft: 10,
  },
  networkErrorRetryText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  fileInfo: {
    flex: 1,
    marginLeft: 12,
  },
  fileName: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  fileSize: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  downloadButton: {
    padding: 8,
  },
  usersList: {
    flex: 1,
    paddingTop: 8,
  },
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  userAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  userAvatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: 22,
  },
  userAvatarText: {
    fontSize: 16,
    fontFamily: 'Poppins-Bold',
    color: '#ffffff',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
  },
  userEmail: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  roleIndicator: {
    fontSize: 12,
    fontFamily: 'Inter-Bold',
    marginTop: 2,
  },
  userStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  selectedIndicator: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Poppins-Bold',
  },
  
  // WhatsApp-style chat list styles
  chatMetaContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lastMessageTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  pinnedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 6,
  },
  pinnedText: {
    fontSize: 11,
    marginLeft: 4,
    fontFamily: 'Inter-Bold',
  },
  lastMessageContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  lastMessageStatus: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginRight: 4,
  },
  lastMessageText: {
    fontSize: 14,
    flex: 1,
  },
  userListRight: {
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadCount: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Bold',
  },
  
  // Attachment modal styles
  attachmentModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  attachmentModal: {
    margin: 20,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 4,
      },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 8,
    }),
  },
  attachmentModalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 20,
  },
  attachmentOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    width: '100%',
  },
  attachmentOptionText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginLeft: 16,
  },
  
  // Special message styles
  specialMessageContainer: {
    marginBottom: 24,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  specialMessageBubble: {
    borderRadius: 24,
    padding: 20,
    marginHorizontal: 8,
    borderWidth: 2,
    minWidth: '90%',
    position: 'relative',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 8px 24px rgba(251, 191, 36, 0.3), 0 4px 12px rgba(251, 191, 36, 0.2)'
    } : {
      shadowColor: '#fbbf24',
      shadowOffset: {
        width: 0,
        height: 8,
      },
      shadowOpacity: 0.3,
      shadowRadius: 24,
      elevation: 12,
    }),
  },
  specialMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  specialMessageTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-Bold',
    marginHorizontal: 8,
  },
  specialMessageText: {
    fontSize: 20,
    fontFamily: 'Poppins-Medium',
    lineHeight: 30,
    textAlign: 'center',
    marginBottom: 16,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  specialMessageTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginBottom: 16,
  },
  specialReactions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
  },
  reactionButton: {
    padding: 8,
    borderRadius: 12,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
  },
  reconnectHintText: {
    marginTop: 10,
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  reconnectCard: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  reconnectTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 6,
    textAlign: 'center',
  },
  reconnectSubtext: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 12,
  },
  reconnectButton: {
    minHeight: 38,
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reconnectButtonText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
  },
  emptyStateText: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 8,
  },
  emptyStateSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
  },
  emptyUsersList: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  emptyUsersText: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyUsersSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  inputContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    minHeight: 64,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 24,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderWidth: 1,
    minHeight: 48,
    position: 'relative',
  },
  attachButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  stickerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  formattingButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    minHeight: 40,
    maxHeight: 120,
    paddingVertical: 10,
    paddingHorizontal: 12,
    textAlignVertical: 'top',
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  refreshButton: {
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  refreshButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  typingIndicator: {
    padding: 16,
    marginHorizontal: 20,
    marginBottom: 16,
    marginTop: 8,
    borderRadius: 12,
    alignSelf: 'flex-start',
    maxWidth: '80%',
  },
  typingDots: {
    padding: 12,
    borderRadius: 8,
  },
  typingText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    color: '#ffffff',
    fontStyle: 'italic',
  },
  typingIndicatorSmall: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  typingDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginRight: 2,
  },
  friendStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pendingMessagesContainer: {
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  editingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  editingBannerIcon: {
    marginRight: 10,
  },
  editingBannerCopy: {
    flex: 1,
  },
  editingBannerTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  editingBannerDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  editingBannerClose: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    marginLeft: 12,
  },
  editingBannerCloseText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  
  // New styles for image overlay
  imageOverlay: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 16,
    padding: 4,
  },
  
  // File preview modal styles
  filePreviewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
  },
  filePreviewContainer: {
    flex: 1,
  },
  filePreviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  filePreviewTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  closeButton: {
    padding: 8,
  },
  filePreviewContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  filePreviewItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    borderRadius: 12,
    elevation: 2,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)'
    } : {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
    }),
  },
  filePreviewInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  previewImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
    marginRight: 12,
  },
  fileIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  filePreviewDetails: {
    flex: 1,
  },
  previewFileName: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginBottom: 4,
  },
  previewFileSize: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  removeFileButton: {
    padding: 8,
    marginLeft: 8,
  },
  filePreviewFooter: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  previewMessageInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    maxHeight: 100,
    textAlignVertical: 'top',
  },
  uploadProgressContainer: {
    marginVertical: 16,
  },
  uploadProgressText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
    marginBottom: 8,
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  sendFilesButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  sendFilesButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 8,
  },
  
  // Image viewer modal styles
  imageViewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerContent: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerCloseButton: {
    position: 'absolute',
    top: 60,
    right: 20,
    zIndex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 20,
    padding: 10,
  },
  fullScreenImage: {
    width: '100%',
    height: '100%',
  },
  imageRetryBadge: {
    position: 'absolute',
    bottom: 110,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  imageRetryText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  imageViewerButtonContainer: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
  },
  imageViewerActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
  },
  imageViewerNetworkError: {
    position: 'absolute',
    top: 110,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  imageViewerButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginLeft: 8,
  },
  // Keep old styles for backward compatibility
  imageViewerDownloadButton: {
    position: 'absolute',
    bottom: 60,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
  },
  imageViewerDownloadText: {
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginLeft: 8,
  },
  brokenImageContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  brokenImageText: {
    color: '#ffffff',
    fontSize: 20,
    fontFamily: 'Inter-SemiBold',
    marginTop: 16,
    textAlign: 'center',
  },
  brokenImageSubtext: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  videoPreviewContainer: {
    width: 160,
    borderRadius: 8,
    overflow: 'hidden',
    marginRight: 12,
    flexShrink: 0,
  },
  videoPreviewPlayer: {
    marginVertical: 0,
  },
  filePreviewInfoVideo: {
    alignItems: 'flex-start',
  },
  
  // Date separator styles
  dateSeparatorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    paddingHorizontal: 16,
  },
  dateSeparatorLine: {
    flex: 1,
    height: 1,
    opacity: 0.3,
  },
  dateSeparatorText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    textAlign: 'center',
    marginHorizontal: 8,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  
  // Messages wrapper
  messagesWrapper: {
    flex: 1,
    position: 'relative',
  },
  chatDropOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000,
    backgroundColor: 'rgba(0, 0, 0, 0.12)',
  },
  chatDropCard: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingHorizontal: 22,
    paddingVertical: 16,
    minWidth: 260,
    alignItems: 'center',
  },
  chatDropTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 8,
  },
  chatDropSubtitle: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  
  // Sticky date header styles
  stickyDateHeader: {
    position: 'absolute',
    top: 8,
    left: 0,
    right: 0,
    zIndex: 1000,
    alignItems: 'center',
  },
  stickyDateContainer: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.15)'
    } : {
      shadowOffset: {
        width: 0,
        height: 2,
      },
      shadowOpacity: 0.15,
      shadowRadius: 4,
    }),
    elevation: 4,
    opacity: 0.92,
    maxWidth: 200,
  },
  stickyDateText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    textAlign: 'center',
  },
  
  // Message footer styles for timestamp and ticks
  messageFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  ownMessageFooter: {
    justifyContent: 'flex-end',
  },
  friendMessageFooter: {
    justifyContent: 'flex-start',
  },
  
  // Special command suggestion styles
  commandSuggestion: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 2,
      },
      shadowOpacity: 0.1,
      shadowRadius: 8,
      elevation: 4,
    }),
  },
  commandOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
  },
  commandOptionText: {
    flex: 1,
    marginLeft: 12,
  },
  commandOptionTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 2,
  },
  commandOptionDescription: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 18,
  },
  commandBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 8,
  },
  commandBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter-Bold',
    color: '#ffffff',
  },
  
  // Special message indicator styles
  specialIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  specialIndicatorText: {
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
    color: '#ffffff',
    flex: 1,
    textAlign: 'center',
  },
  specialIndicatorClose: {
    padding: 4,
  },
  
  // Sticker and GIF message styles
  stickerContainer: {
    padding: 8,
    borderRadius: 16,
    backgroundColor: 'transparent',
  // Constrain width like text bubbles so content doesn't span full width
  maxWidth: '80%',
  // Center media/text within the sticker container by default
  alignItems: 'center',
  },
  ownSticker: {
  // Ensure the entire sticker block sits on the right and its inner content aligns right
  alignSelf: 'flex-end',
  alignItems: 'flex-end',
  },
  friendSticker: {
    alignSelf: 'flex-start',
  },
  stickerImage: {
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  stickerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    paddingHorizontal: 4,
  },
  ownStickerFooter: {
    alignSelf: 'flex-end',
  },
  friendStickerFooter: {
    alignSelf: 'flex-start',
  },
  stickerTime: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },
  deletedStickerPlaceholder: {
    width: 120,
    height: 120,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
  },
  deletedStickerText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
    textAlign: 'center',
  },
  emojiStickerContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
    minHeight: 80,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  emojiStickerText: {
    fontFamily: Platform.OS === 'ios' ? 'AppleColorEmoji' : 'NotoColorEmoji',
    textAlign: 'center',
    lineHeight: undefined, // Let the system handle emoji line height
  },
  
  // Formatting guide styles
  formattingGuide: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  formattingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  formattingTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  formattingOptions: {
    gap: 8,
  },
  quickFormatButtons: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    justifyContent: 'center',
  },
  quickFormatButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.1)',
  },
  quickFormatButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  formattingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  formattingExample: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  formattingResult: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  
  // Format preview styles
  formatPreview: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 8,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    zIndex: 1000,
    elevation: 10,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 4,
      },
      shadowOpacity: 0.15,
      shadowRadius: 12,
    }),
  },
  formatPreviewLabel: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  formatPreviewText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  // Reaction system styles
  glowingReaction: {
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 20px rgba(59, 130, 246, 0.8), 0 0 40px rgba(59, 130, 246, 0.4)'
    } : {
      shadowColor: '#3b82f6',
      shadowOffset: {
        width: 0,
        height: 0,
      },
      shadowOpacity: 0.8,
      shadowRadius: 10,
      elevation: 20,
    }),
    borderWidth: 2,
    borderColor: '#3b82f6',
  },
  reactionCount: {
    fontSize: 10,
    fontFamily: 'Inter-Medium',
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#ef4444',
    color: '#ffffff',
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
    minWidth: 16,
    textAlign: 'center',
  },
  reactionProfilePics: {
    marginTop: 12,
    alignItems: 'center',
  },
  reactionTypeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 12,
  },
  reactionIcon: {
    marginRight: 6,
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profilePicsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniProfilePic: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ffffff',
    overflow: 'hidden',
  },
  miniProfilePicImage: {
    width: '100%',
    height: '100%',
  },
  miniProfilePicPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniProfilePicText: {
    fontSize: 8,
    fontFamily: 'Inter-Bold',
    color: '#ffffff',
  },
  miniProfilePicMore: {
    backgroundColor: '#6b7280',
  },

  // Message reaction display styles
  messageReactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
    paddingHorizontal: 8,
  },
  messageReactionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 4,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  selectedMessageReaction: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderColor: '#3b82f6',
  },
  messageReactionEmoji: {
    fontSize: 14,
    marginRight: 4,
  },
  messageReactionCount: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
});
