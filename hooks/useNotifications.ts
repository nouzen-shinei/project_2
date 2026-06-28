import { logger } from '@/lib/logger';
import { useEffect, useCallback, useState, useRef } from 'react';
import { useForegroundInterval } from '@/hooks/useAppForeground';
import { notificationService } from '../services/notificationService';
import { useAuth } from './useAuthUnified';
import { ChatMessage, chatService } from '../services/chatService';
import { Platform } from 'react-native';
import type { DeviceTenantFilterOptions } from '../services/deviceTrackingService';
import { tenantService } from '@/services/tenantService';

export const useNotifications = () => {
  const { user } = useAuth();
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [teamMembers, setTeamMembers] = useState<any[]>([]);
  const teamMembersRef = useRef<any[]>([]);
  const messageTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const processedMessagesRef = useRef<Set<string>>(new Set());
  const lastProcessedTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    notificationService.checkInitialNotificationResponse().catch((error) => {
      logger.warn('Failed to check initial notification response:', error);
    });
  }, []);

  useEffect(() => {
    teamMembersRef.current = teamMembers;
  }, [teamMembers]);

  // Resolve the active tenant id. Foreground-gated and lengthened (was a 5s
  // global AsyncStorage poll) so it neither drains battery nor backlogs while
  // the app is backgrounded. Runs once immediately on mount/resume.
  const syncTenantId = useCallback(async () => {
    try {
      if (!user?.email) {
        setActiveTenantId(null);
        return;
      }

      const tenantId = await tenantService.getCachedSelectedTenant();
      setActiveTenantId(tenantId);
    } catch (error) {
      logger.warn('useNotifications: failed to resolve active tenant id', error);
      setActiveTenantId(null);
    }
  }, [user?.email]);

  useForegroundInterval(() => {
    void syncTenantId();
  }, 15000);

  // Initialize notification service
  useEffect(() => {
    const initializeNotifications = async () => {
      try {
        // Add delay to ensure auth service has loaded authorized emails
        // This prevents the device tracking service from running security checks
        // before the authorized emails are loaded from Firestore
        logger.debug('🔔 Initializing notifications service...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (user?.email) {
          notificationService.setCurrentUser(user.email);
        }

        const enabled = await notificationService.areNotificationsEnabled();
        if (!enabled) {
          logger.debug('🔕 Notifications disabled by user preference; skipping initialization.');
          return;
        }

        await notificationService.initialize(user?.email);
        logger.debug('✅ Notifications service initialized');

  await notificationService.checkInitialNotificationResponse(true);
      } catch (error) {
        logger.error('Failed to initialize notifications:', error);
      }
    };

    if (user?.email) {
      initializeNotifications();
    }
    
    // Cleanup on unmount or user change
    return () => {
      if (user?.email) {
        notificationService.cleanup().catch(console.error);
      }
    };
  }, [user?.email]);

  // Load team members for global chat notifications. Foreground-gated so it
  // stops refetching memberships while backgrounded. A request id guards
  // against stale responses when the active tenant changes mid-flight.
  const loadMembersRequestIdRef = useRef(0);
  const loadMembers = useCallback(async () => {
    if (!user?.email || !activeTenantId) {
      setTeamMembers([]);
      return;
    }

    const requestId = ++loadMembersRequestIdRef.current;

    try {
      const memberships = await tenantService.getActiveMembershipsForTenant(activeTenantId);
      if (loadMembersRequestIdRef.current !== requestId) return;

      const members = memberships.map((membership) => {
        const normalizedEmail = String(membership.email || '').toLowerCase();
        const rawName = String(membership.displayName || normalizedEmail.split('@')[0] || 'User');
        const name = rawName
          .replace(/[._-]+/g, ' ')
          .replace(/\b\w/g, (letter) => letter.toUpperCase());

        return {
          id: normalizedEmail,
          email: normalizedEmail,
          name,
          role: membership.role,
        };
      });

      setTeamMembers(members);
    } catch (error) {
      logger.warn('useNotifications: failed to load tenant members', {
        error,
        tenantId: activeTenantId,
      });
      if (loadMembersRequestIdRef.current === requestId) {
        setTeamMembers([]);
      }
    }
  }, [user?.email, activeTenantId]);

  useForegroundInterval(() => {
    void loadMembers();
  }, 30000, { enabled: Boolean(user?.email && activeTenantId) });

  // Clear cached members when there is no user/tenant (the interval above is
  // disabled in that state, so it cannot clear them itself).
  useEffect(() => {
    if (!user?.email || !activeTenantId) {
      setTeamMembers([]);
    }
  }, [user?.email, activeTenantId]);

  // Global chat message listener for incoming message notifications
  // This handles notifications when OTHER people send messages TO you
  useEffect(() => {
    if (!user?.email) return;

    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    const setupListener = async () => {
      const enabled = await notificationService.areNotificationsEnabled();
      if (!enabled || cancelled) {
        logger.debug('Notifications disabled; skipping chat listener registration.');
        return;
      }

      const chatEnabled = await notificationService.areChatNotificationsEnabled();
      if (!chatEnabled || cancelled) {
        logger.debug('Chat notifications disabled; skipping chat listener registration.');
        return;
      }

      const userEmailLower = user.email.toLowerCase();

      unsubscribe = chatService.onMessagesChange(user.email, (messages: ChatMessage[]) => {
        if (!notificationService.getNotificationsEnabledStatus()) {
          return;
        }

        if (!notificationService.getChatNotificationsEnabledStatus()) {
          return;
        }

        const messageTimeouts = messageTimeoutsRef.current;
        const processedMessages = processedMessagesRef.current;

        // Only process messages received in the last 5 seconds to avoid app launch burst
        const now = Date.now();
        const timeSinceLastProcess = now - lastProcessedTimeRef.current;
        const isInitialLoad = timeSinceLastProcess > 3000;

        const incomingMessages = messages.filter((msg: ChatMessage) => {
          if (!msg?.sender || !msg?.recipientId) {
            return false;
          }
          const senderLower = msg.sender.toLowerCase();
          const recipientLower = msg.recipientId.toLowerCase();
          return recipientLower === userEmailLower && senderLower !== userEmailLower;
        });

        const recentIncomingMessages = incomingMessages.filter((msg: ChatMessage) => {
          if (!msg.timestamp || !msg.id) return false;

          if (processedMessages.has(msg.id)) {
            return false;
          }

          const messageTime = new Date(msg.timestamp).getTime();
          const messageAge = now - messageTime;

          if (messageAge < 0) {
            return false;
          }

          // Only process very recent messages (within 5 seconds)
          const isRecent = messageAge < 5000;
          if (!isRecent) {
            return false;
          }

          // Skip if initial load and message is older than 10 seconds
          if (isInitialLoad && messageAge > 10000) {
            return false;
          }

          // Has meaningful content
          const hasContent = msg.text || msg.sticker || msg.gif || (msg.attachments && msg.attachments.length > 0);
          return Boolean(hasContent);
        });

        if (recentIncomingMessages.length > 0) {
          lastProcessedTimeRef.current = now;
        }

        recentIncomingMessages.forEach((msg: ChatMessage) => {
          if (!msg.id) {
            return;
          }

          processedMessages.add(msg.id);

          if (!messageTimeouts.has(msg.id)) {
            const timeoutId = setTimeout(() => {
              messageTimeouts.delete(msg.id!);

              if (!notificationService.getNotificationsEnabledStatus()) {
                processedMessages.delete(msg.id!);
                return;
              }

              if (!notificationService.getChatNotificationsEnabledStatus()) {
                processedMessages.delete(msg.id!);
                return;
              }

              const membersSnapshot = teamMembersRef.current;
              const senderMember = membersSnapshot.find(member => 
                member.email?.toLowerCase() === msg.sender.toLowerCase()
              );

              const isAppFocused = Platform.OS === 'web'
                ? (typeof document !== 'undefined' && document.hasFocus())
                : true;
              const isTabVisible = Platform.OS === 'web'
                ? (typeof document !== 'undefined' && document.visibilityState === 'visible')
                : true;

              notificationService.sendSmartChatNotification(msg, user.email, user.email, {
                isCurrentChatActive: false,
                currentChatPartner: undefined,
                isAppFocused,
                isTabVisible,
                skipNativeLocal: true
              }, senderMember?.name).catch(error => {
                logger.warn('Failed to send global notification for message:', msg.id, error);
              });
            }, 1500);

            messageTimeouts.set(msg.id, timeoutId);
          }
        });

        if (processedMessages.size > 200) {
          const idsToKeep = Array.from(processedMessages).slice(-200);
          processedMessages.clear();
          idsToKeep.forEach(id => processedMessages.add(id));
        }
      });
    };

    setupListener();

    return () => {
      cancelled = true;

      const messageTimeouts = messageTimeoutsRef.current;
      messageTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
      messageTimeouts.clear();

      processedMessagesRef.current.clear();
      lastProcessedTimeRef.current = Date.now();

      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [user?.email]);

  // Function to send team chat notification (between teachers)
  const sendTeamChatNotification = useCallback(async (
    message: ChatMessage, 
    recipientEmail: string
  ) => {
    if (!user?.email) return;
    
    try {
      await notificationService.sendTeamChatNotification(
        message, 
        recipientEmail, 
        user.email
      );
    } catch (error) {
      logger.error('Failed to send team chat notification:', error);
    }
  }, [user?.email]);

  // Function to send payment notifications
  const sendFeePaymentReceived = useCallback(async (
    studentName: string, 
    amount: number,
    paymentMethod: string
  ) => {
    try {
      await notificationService.sendFeePaymentReceived(studentName, amount, paymentMethod);
    } catch (error) {
      logger.error('Failed to send payment notification:', error);
    }
  }, []);

  // Function to send new student enrollment notifications
  const sendNewStudentEnrolled = useCallback(async (
    studentName: string, 
    grade: string, 
    subjects: string[]
  ) => {
    try {
      await notificationService.sendNewStudentEnrolled(studentName, grade, subjects);
    } catch (error) {
      logger.error('Failed to send enrollment notification:', error);
    }
  }, []);

  // Function to send overdue fee alerts for teachers
  const sendOverdueFeeTeacherAlert = useCallback(async (
    studentName: string, 
    amount: number, 
    daysPastDue: number
  ) => {
    try {
      await notificationService.sendOverdueFeeTeacherAlert(studentName, amount, daysPastDue);
    } catch (error) {
      logger.error('Failed to send overdue fee alert:', error);
    }
  }, []);

  // Function to send reminder sent confirmation
  const sendReminderSentConfirmation = useCallback(async (
    reminderType: string,
    studentCount: number,
    successCount: number,
    failedCount: number
  ) => {
    try {
      await notificationService.sendReminderSentConfirmation(
        reminderType, 
        studentCount, 
        successCount, 
        failedCount
      );
    } catch (error) {
      logger.error('Failed to send reminder confirmation:', error);
    }
  }, []);

  // Function to send reminder failure alert
  const sendReminderFailureAlert = useCallback(async (
    failedCount: number,
    reminderType: string,
    errorDetails: string
  ) => {
    try {
      await notificationService.sendReminderFailureAlert(failedCount, reminderType, errorDetails);
    } catch (error) {
      logger.error('Failed to send reminder failure alert:', error);
    }
  }, []);

  // Function to send daily collection summary
  const sendDailyCollectionSummary = useCallback(async (
    totalCollected: number,
    paymentsCount: number,
    pendingCount: number
  ) => {
    try {
      await notificationService.sendDailyCollectionSummary(
        totalCollected, 
        paymentsCount, 
        pendingCount
      );
    } catch (error) {
      logger.error('Failed to send daily summary:', error);
    }
  }, []);

  // Function to send data backup notification
  const sendDataBackupComplete = useCallback(async (
    success: boolean,
    message?: string
  ) => {
    try {
      await notificationService.sendBackupNotification(success, message);
    } catch (error) {
      logger.error('Failed to send backup notification:', error);
    }
  }, []);

  // Function to schedule daily fee review
  const scheduleDailyFeeReview = useCallback(async () => {
    try {
      await notificationService.scheduleDailyFeeReview();
    } catch (error) {
      logger.error('Failed to schedule daily fee review:', error);
    }
  }, []);

  // Function to schedule weekly reminder review
  const scheduleWeeklyReminderReview = useCallback(async () => {
    try {
      await notificationService.scheduleWeeklyReminderReview();
    } catch (error) {
      logger.error('Failed to schedule weekly reminder review:', error);
    }
  }, []);

  // Admin notification functions
  const sendAdminNotificationToUser = useCallback(async (
    targetEmail: string,
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    onlineOnly: boolean = true,
    options?: DeviceTenantFilterOptions,
  ) => {
    try {
      return await notificationService.sendAdminNotificationToUser(targetEmail, notification, onlineOnly, options);
    } catch (error) {
      logger.error('Failed to send admin notification to user:', error);
      return { success: 0, failed: 1 };
    }
  }, []);

  const sendAdminNotificationToDevice = useCallback(async (
    targetEmail: string,
    deviceId: string,
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    options?: DeviceTenantFilterOptions
  ) => {
    try {
      return await notificationService.sendAdminNotificationToDevice(targetEmail, deviceId, notification, options);
    } catch (error) {
      logger.error('Failed to send admin notification to device:', error);
      return false;
    }
  }, []);

  const sendBulkAdminNotifications = useCallback(async (
    targetUsers: string[],
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    onlineOnly: boolean = true,
    tenantOptions?: { tenantId?: string; tenantName?: string }
  ) => {
    try {
      return await notificationService.sendBulkAdminNotifications(targetUsers, notification, onlineOnly, tenantOptions);
    } catch (error) {
      logger.error('Failed to send bulk admin notifications:', error);
      return { totalSuccess: 0, totalFailed: targetUsers.length, results: [] };
    }
  }, []);

  const sendBulkAdminNotificationsToDevices = useCallback(async (
    targets: Array<{ email: string; deviceId: string }>,
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    tenantOptions?: { tenantId?: string; tenantName?: string }
  ) => {
    try {
      return await notificationService.sendBulkAdminNotificationsToDevices(targets, notification, tenantOptions);
    } catch (error) {
      logger.error('Failed to send bulk admin notifications to devices:', error);
      return { totalSuccess: 0, totalFailed: targets.length, results: [], failureReasons: {} };
    }
  }, []);

  const getAllUsersWithDevices = useCallback(
    async (
      memberEmails: string[],
      includeCurrentUser: boolean = true,
      options?: DeviceTenantFilterOptions
    ) => {
      try {
        return await notificationService.getAllUsersWithDevices(memberEmails, includeCurrentUser, options);
      } catch (error) {
        logger.error('Failed to get all users with devices:', error);
        return [];
      }
    },
    []
  );

  const getUserDevices = useCallback(
    async (userEmail: string, options?: DeviceTenantFilterOptions) => {
      try {
        return await notificationService.getUserDevices(userEmail, options);
      } catch (error) {
        logger.error('Failed to get user devices:', error);
        return [];
      }
    },
    []
  );

  const checkUserOnlineStatus = useCallback(async (userEmail: string) => {
    try {
      return await notificationService.checkUserOnlineStatus(userEmail);
    } catch (error) {
      logger.error('Failed to check user online status:', error);
      return false;
    }
  }, []);

  return {
    sendTeamChatNotification,
    sendFeePaymentReceived,
    sendNewStudentEnrolled,
    sendOverdueFeeTeacherAlert,
    sendReminderSentConfirmation,
    sendReminderFailureAlert,
    sendDailyCollectionSummary,
    sendDataBackupComplete,
    scheduleDailyFeeReview,
    scheduleWeeklyReminderReview,
    // Admin notification functions
    sendAdminNotificationToUser,
    sendAdminNotificationToDevice,
    sendBulkAdminNotifications,
    sendBulkAdminNotificationsToDevices,
    getAllUsersWithDevices,
    getUserDevices,
    checkUserOnlineStatus,
  };
};
