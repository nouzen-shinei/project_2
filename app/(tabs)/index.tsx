import { logger } from '@/lib/logger';
import { isPermissionDeniedError } from '@/lib/firestoreErrors';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Dimensions,
  Modal,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Users, CreditCard, CircleAlert as AlertCircle, Plus, Bell, Mail, MessageSquare, Phone, CheckCircle, XCircle, Clock, Trash2, FileText } from 'lucide-react-native';
import { router } from 'expo-router';
import useStudents from '../../hooks/useStudents';
import useFees from '../../hooks/useFees';
import { useReminderHistory } from '../../hooks/useReminderHistory';
import { useAuth } from '../../hooks/useAuthUnified';
import { useNotices } from '../../hooks/useNotices';
import type { Student } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { notificationService } from '../../services/notificationService';
import NoticeModal from '../../components/NoticeModal';
import { useBirthdays } from '../../components/BirthdayProvider';
import { LinearGradient } from 'expo-linear-gradient';
import SkeletonBar, { SkeletonCircle, SkeletonRow, SkeletonCard } from '../../components/Skeleton';
import { reminderHistoryService } from '../../services/reminderHistoryService';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import { useTenant } from '../../hooks/useTenantContext';
import UsageAlertInlineBanner from '@/components/UsageAlertInlineBanner';
import { useActiveUsageAlerts } from '@/hooks/useActiveUsageAlerts';

export default function Dashboard() {
  const insets = useSafeAreaInsets();
  const sharedTopPadding = useSharedTopPadding();
  const { theme } = useTheme();
  const { hasCelebration, celebrants, isMusicPlaying, toggleMusic, headerCompensation } = useBirthdays();
  const { user } = useAuth();
  const { students: studentList, loading: studentsLoading } = useStudents();
  const students = studentList as Student[];
  const { fees, loading: feesLoading } = useFees();
  // NOTE: the dashboard uses the hook's `loading` for section skeletons and its
  // `refresh` for pull-to-refresh, so autoload stays on here (fees.tsx opts out).
  const { loading: reminderLoading, getRecentReminders, refresh: refreshReminders, canViewAllReminders } = useReminderHistory();
  const { notices } = useNotices();
  const { activeTenant, refreshTenants } = useTenant();
  const tenantId = activeTenant?.id;

  // The tenant doc is cached client-side, so an admin turning OFF the non-admin
  // "all reminders" flag isn't seen here until the tenant is re-fetched. If the
  // server denies the tenant-wide today-stats read, our cached canViewAllReminders
  // is stale — force-refresh the tenant once so it recomputes and the read clamps
  // to the caller's own reminders.
  const staleReminderFlagRefreshRef = useRef(false);
  useEffect(() => {
    staleReminderFlagRefreshRef.current = false;
  }, [tenantId, activeTenant?.settings?.allowNonAdminAllReminderHistory]);

  const {
    highlightedAlert: storageUsageAlert,
    alertCount: storageAlertCount,
    monthId: storageUsageMonthId,
    loading: storageUsageAlertLoading,
    error: storageUsageAlertError,
    refresh: refreshStorageUsageAlerts,
  } = useActiveUsageAlerts(tenantId ?? null, { metrics: ['storage'] });
  const shouldShowStorageUsageBanner = Boolean(
    storageUsageAlertLoading || storageUsageAlertError || storageAlertCount > 0,
  );
  const [recentReminders, setRecentReminders] = useState<any[]>([]);
  const [todayReminderTotals, setTodayReminderTotals] = useState<{ total: number; failed: number; pending: number }>({ total: 0, failed: 0, pending: 0 });
  const [notificationModalVisible, setNotificationModalVisible] = useState(false);
  const [recentActivities, setRecentActivities] = useState<any[]>([]);
  const [allNotifications, setAllNotifications] = useState<any[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [todayStatsLoading, setTodayStatsLoading] = useState(true);
  
  // Reminder modal states
  
  // Notice modal state
  const [showNoticeModal, setShowNoticeModal] = useState(false);
  
  // Dynamic screen dimensions that update on screen size changes
  const [screenData, setScreenData] = useState(Dimensions.get('window'));

  // Scale down header compensation to avoid excessive header shrink
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);

  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setScreenData(window);
    });

    return () => {
      subscription?.remove?.();
    };
  }, []);

  useEffect(() => {
    // Initialize notification service
    notificationService.initialize();
  }, []);

  // Load activities when reminders, fees, or students change
  useEffect(() => {
    loadRecentActivities();
  }, [recentReminders, fees, students]);

  // Load recent reminders for dashboard display
  const loadRecentReminders = useCallback(async () => {
    if (!tenantId) {
      setRecentReminders([]);
      return;
    }
    try {
      // Fetch more reminders to avoid missing any from today
      const recent = await getRecentReminders(100, 'all'); // broaden window; still capped for perf
      setRecentReminders(recent);
    } catch (error) {
      logger.error('Error loading recent reminders:', error);
    }
  }, [getRecentReminders, tenantId]);

  // Load today's reminder statistics without filters across all users
  const loadTodayReminderStats = useCallback(async ({ showLoader = false }: { showLoader?: boolean } = {}) => {
    if (!tenantId) {
      setTodayReminderTotals({ total: 0, failed: 0, pending: 0 });
      setTodayStatsLoading(false);
      return;
    }
    try {
      if (showLoader) {
        // Only surface the skeleton when explicitly requested to avoid flashing on reactive updates
        setTodayStatsLoading(true);
      }
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      // Only read across all users when authorized (mirrors the Firestore rule);
      // otherwise scope to the current user's own reminders to avoid a denied read.
      const stats = await reminderHistoryService.getReminderStatsForDateRange(
        tenantId,
        canViewAllReminders ? null : (user?.uid || null),
        start,
        end,
        { status: 'all' }
      );
      setTodayReminderTotals({
        total: stats.totalReminders,
        failed: stats.failedReminders,
        pending: stats.pendingReminders,
      });
    } catch (error) {
      // A permission-denied here is expected/benign (e.g. a non-admin's tenant-wide
      // read when the flag is off). Log at debug so it doesn't trip the global
      // auth-recovery interceptor into a reattach loop.
      // getReminderStatsForDateRange only throws on permission-denied (it swallows
      // other errors); the service logs it scope-aware (quiet for an expected
      // all-scope denial, loud for an unexpected self-scoped one). When it's the
      // expected all-scope case, our cached tenant flag is likely stale — refresh
      // once so canViewAllReminders self-corrects and the read clamps to 'mine'.
      if (isPermissionDeniedError(error) && canViewAllReminders && !staleReminderFlagRefreshRef.current) {
        staleReminderFlagRefreshRef.current = true;
        void Promise.resolve(refreshTenants?.()).catch(() => {});
      }
      setTodayReminderTotals({ total: 0, failed: 0, pending: 0 });
    } finally {
      if (showLoader) {
        setTodayStatsLoading(false);
      }
    }
  }, [tenantId, canViewAllReminders, user?.uid, refreshTenants]);

  useEffect(() => {
    loadRecentReminders();
    loadTodayReminderStats({ showLoader: true });
  }, [loadRecentReminders, loadTodayReminderStats]);

  // Refresh reminder data when fees change (new reminders might have been sent)
  useEffect(() => {
    if (fees.length > 0) {
      loadRecentReminders();
      loadTodayReminderStats();
    }
  }, [fees, loadRecentReminders, loadTodayReminderStats]);

  // Load recent activities (reminders + fee creations + student additions + fee deletions)
  const loadRecentActivities = () => {
    try {
      // Get recent students (added in last 7 days)
      const recentStudentActivities = students
        .filter(student => {
          try {
            const studentCreationDate = new Date(student.createdAt);
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            return studentCreationDate >= sevenDaysAgo;
          } catch (e) {
            return false;
          }
        })
        .map(student => ({
          id: `student-${student.id}`,
          type: 'student_added',
          studentName: student.name,
          createdAt: student.createdAt || new Date().toISOString(),
          createdBy: student.createdBy || null
        }));

      // Get recent fee deletions from students' fee history
      const recentFeeDeletions = students
        .flatMap(student => {
          const deletions = (student.feeHistory || [])
            .filter((entry: any) => entry.action === 'deleted')
            .filter((entry: any) => {
              try {
                const deletionDate = new Date(entry.performedAt);
                const sevenDaysAgo = new Date();
                sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                return deletionDate >= sevenDaysAgo;
              } catch (e) {
                return false;
              }
            })
            .map((entry: any) => ({
              id: `fee-deletion-${entry.id}`,
              type: 'fee_deleted',
              studentName: student.name,
              amount: entry.amount,
              createdAt: entry.performedAt,
              dueDate: entry.dueDate,
              description: entry.description,
              deletedBy: entry.performedBy || null,
              reason: entry.reason
            }));

          return deletions;
        });

      // Get recent fees (created in last 7 days)
      const recentFeeActivities = fees
        .filter(fee => {
          try {
            const feeCreationDate = new Date(fee.createdAt || fee.dueDate);
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            return feeCreationDate >= sevenDaysAgo;
          } catch (e) {
            return false;
          }
        })
        .map(fee => ({
          id: `fee-${fee.id}`,
          type: 'fee_created',
          studentName: fee.studentName,
          amount: fee.amount,
          createdAt: fee.createdAt || fee.dueDate,
          dueDate: fee.dueDate,
          status: fee.status,
          feeType: fee.type || 'tuition',
          createdBy: fee.createdBy || null,
          approvedBy: fee.approvedBy || null
        }));

      // Get recent reminders
      const recentReminderActivities = recentReminders.map(reminder => ({
        ...reminder,
        type: 'reminder'
      }));

      // Combine and sort by date (remove individual category limits, only limit final result)
      const allActivities = [...recentStudentActivities, ...recentFeeDeletions, ...recentFeeActivities, ...recentReminderActivities]
        .sort((a, b) => {
          const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
          const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
          return dateB.getTime() - dateA.getTime();
        })
        .slice(0, 6); // Keep only top 6 activities
      
      setRecentActivities(allActivities);
    } catch (error) {
      logger.error('Error loading recent activities:', error);
    }
  };

  // Load all notifications without time filters (for notification modal)
  const loadAllNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    try {
      // Get all students (no time filter)
      const allStudentActivities = (students || [])
        .map(student => ({
          id: `student-${student.id}`,
          type: 'student_added',
          studentName: student.name,
          createdAt: student.createdAt || new Date().toISOString(),
          createdBy: student.createdBy || null
        }));

      // Get all fee deletions from students' fee history (no time filter)
      const allFeeDeletions = (students || [])
        .flatMap(student => {
          const deletions = (student.feeHistory || [])
            .filter((entry: any) => entry.action === 'deleted')
            .map((entry: any) => ({
              id: `fee-deletion-${entry.id}`,
              type: 'fee_deleted',
              studentName: student.name,
              amount: entry.amount,
              createdAt: entry.performedAt,
              dueDate: entry.dueDate,
              description: entry.description,
              deletedBy: entry.performedBy || null,
              reason: entry.reason
            }));

          return deletions;
        });

      // Get all fees (no time filter)
      const allFeeActivities = (fees || [])
        .map(fee => ({
          id: `fee-${fee.id}`,
          type: 'fee_created',
          studentName: fee.studentName,
          amount: fee.amount,
          createdAt: fee.createdAt || fee.dueDate,
          dueDate: fee.dueDate,
          status: fee.status,
          feeType: fee.type || 'tuition',
          createdBy: fee.createdBy || null,
          approvedBy: fee.approvedBy || null
        }));

      // Get all reminders across users (no time filter)
      const reminderFeed = await getRecentReminders(200, 'all');
      const allReminderActivities = (reminderFeed || []).map(reminder => ({
        ...reminder,
        type: 'reminder'
      }));

      // Combine and sort by date, limit to 100
      const notifications = [...allStudentActivities, ...allFeeDeletions, ...allFeeActivities, ...allReminderActivities]
        .sort((a, b) => {
          const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
          const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
          return dateB.getTime() - dateA.getTime();
        })
        .slice(0, 100); // Limit to 100 most recent notifications
      
      setAllNotifications(notifications);
    } catch (error) {
      logger.error('Error loading all notifications:', error);
    } finally {
      setNotificationsLoading(false);
    }
  }, [students, fees, getRecentReminders]);

  // Format reminder date to relative time
  const formatReminderDate = (reminderDate: any): string => {
    try {
      const date = reminderDate?.toDate ? reminderDate.toDate() : new Date(reminderDate);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMinutes = Math.floor(diffMs / (1000 * 60));

      if (diffDays > 0) {
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      } else if (diffHours > 0) {
        return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      } else if (diffMinutes > 0) {
        return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
      } else {
        return 'Just now';
      }
    } catch (e) {
      return 'Unknown time';
    }
  };

  // Get reminder type icon
  const getReminderIcon = (type: string) => {
    switch (type) {
      case 'email':
        return Mail;
      case 'sms':
        return MessageSquare;
      case 'whatsapp':
        return MessageSquare;
      case 'voice':
        return Phone;
      default:
        return Bell;
    }
  };

  // Get reminder status icon
  const getReminderStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return CheckCircle;
      case 'failed':
        return XCircle;
      case 'pending':
        return Clock;
      default:
        return Clock;
    }
  };

  // Get reminder status color
  const getReminderStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return theme.success;
      case 'failed':
        return theme.error;
      case 'pending':
        return theme.warning;
      default:
        return theme.textSecondary;
    }
  };

  // Get activity icon based on type
  const getActivityIcon = (activity: any) => {
    if (activity.type === 'fee_created') {
      return CreditCard;
    }
    if (activity.type === 'fee_deleted') {
      return Trash2;
    }
    if (activity.type === 'student_added') {
      return Users;
    }
    // For reminders, use the existing logic
    return getReminderIcon(activity.reminderType);
  };

  // Get activity color based on type and status
  const getActivityColor = (activity: any) => {
    if (activity.type === 'fee_created') {
      switch (activity.status) {
        case 'paid':
          return theme.success;
        case 'overdue':
          return theme.error;
        case 'pending':
          return theme.warning;
        default:
          return theme.primary;
      }
    }
    if (activity.type === 'fee_deleted') {
      return theme.error;
    }
    if (activity.type === 'student_added') {
      return theme.success;
    }
    // For reminders, use the existing logic
    return getReminderStatusColor(activity.status);
  };

  // Format activity message
  const getActivityMessage = (activity: any) => {
    // For reminders, use first name only for privacy when mentioning parent
    const firstName = activity.studentName?.split(' ')[0] || activity.studentName;
    // For other activities, use full name
    const fullName = activity.studentName;
    
    if (activity.type === 'fee_created') {
      const feeType = activity.feeType === 'tuition' ? 'Tuition' : activity.feeType;
      const dueDate = new Date(activity.dueDate).toLocaleDateString('en-IN', { 
        day: 'numeric', 
        month: 'short' 
      });
      
      // Handle automatic vs manual fee creation
      if (activity.createdBy === 'automatic' && activity.approvedBy) {
        return `${activity.approvedBy} approved ${feeType} fee of ₹${activity.amount.toLocaleString()} for ${fullName} on due date ${dueDate}`;
      } else if (activity.createdBy === 'automatic') {
        return `System automatically created ${feeType} fee of ₹${activity.amount.toLocaleString()} for ${fullName} on due date ${dueDate}`;
      } else if (!activity.createdBy) {
        // When createdBy is missing/null, assume it's manual by current user
        const currentUser = user?.displayName || user?.email?.split('@')[0] || 'User';
        return `${currentUser} created ${feeType} fee of ₹${activity.amount.toLocaleString()} for ${fullName} on due date ${dueDate}`;
      } else {
        return `${activity.createdBy} created ${feeType} fee of ₹${activity.amount.toLocaleString()} for ${fullName} on due date ${dueDate}`;
      }
    }
    
    if (activity.type === 'fee_deleted') {
      if (!activity.deletedBy) {
        // When deletedBy is missing/null, use current user if available
        const currentUser = user?.displayName || user?.email?.split('@')[0] || 'User';
        return `${currentUser} deleted fee of ₹${activity.amount.toLocaleString()} for ${fullName}${activity.reason ? ` (${activity.reason})` : ''}`;
      } else {
        return `${activity.deletedBy} deleted fee of ₹${activity.amount.toLocaleString()} for ${fullName}${activity.reason ? ` (${activity.reason})` : ''}`;
      }
    }
    
    if (activity.type === 'student_added') {
      if (!activity.createdBy) {
        const currentUser = user?.displayName || user?.email?.split('@')[0] || 'User';
        return `New student ${fullName} added by ${currentUser}`;
      } else {
        return `New student ${fullName} added by ${activity.createdBy}`;
      }
    }
    
    // For reminders, use first name only for privacy when mentioning parent
    return `${activity.reminderType?.toUpperCase()} reminder ${activity.status} for ${firstName}'s parent`;
  };

  // Get current time-based greeting
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning!';
    if (hour < 17) return 'Good Afternoon!';
    return 'Good Evening!';
  };

  // Helper function to get correct amount for a fee record. Stable identity
  // (useCallback[]) so the memoized derivations below don't churn every render.
  const getCorrectFeeAmount = useCallback((record: any): number => {
    if (record.monthFeeAmounts && record.monthsCovered) {
      // Use sum of individual month amounts for consolidated fees
      return record.monthsCovered.reduce((sum: number, month: string) => 
        sum + (record.monthFeeAmounts?.[month] || 0), 0);
    }
    // Fallback to stored amount
    return record.amount || 0;
  }, []);

  // Calculate stats from real data
  const totalStudents = students.length;

  // PERF (P6): memoize the O(fees) summary reduction so it doesn't re-run on
  // every unrelated dashboard re-render (modal toggles, dimensions, reminder state).
  const { pendingAmount } = useMemo(() => {
    const total = fees.reduce((sum, fee) => sum + getCorrectFeeAmount(fee), 0);
    const paid = fees
      .filter(fee => fee.status === 'paid')
      .reduce((sum, fee) => sum + getCorrectFeeAmount(fee), 0) +
      fees
      .filter(fee => fee.status !== 'paid' && (fee.paidAmount || 0) > 0) // Partial payments
      .reduce((sum, fee) => sum + (fee.paidAmount || 0), 0);
    return { pendingAmount: total - paid };
  }, [fees, getCorrectFeeAmount]);

  // Helper: is date string in current month. Stable identity for the memos below.
  const isInCurrentMonth = useCallback((dateStr?: string) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }, []);

  // Calculate current-month revenue from actual payments, including partials
  const monthlyRevenue = useMemo(() => fees.reduce((sum, fee) => {
    const details = fee.paymentDetails as any;

    // If there are structured payments (payment_*), sum those in current month
    if (details && typeof details === 'object') {
      const paymentKeys = Object.keys(details).filter(k => k.startsWith('payment_') && details[k] && typeof details[k] === 'object');
      if (paymentKeys.length > 0) {
        const structuredSum = paymentKeys.reduce((acc, key) => {
          const p = details[key];
          const pd = p?.paymentDate || p?.date; // tolerate either field
          const amt = Number(p?.amount) || 0;
          return acc + (isInCurrentMonth(pd) ? amt : 0);
        }, 0);
        return sum + structuredSum;
      }
    }

    // Legacy fallback: if fully paid with a paidDate in current month, count full amount
    if (fee.status === 'paid' && isInCurrentMonth(fee.paidDate)) {
      return sum + getCorrectFeeAmount(fee);
    }

    // Legacy partial: if there's a single payment record date or paidDate in current month, count paidAmount
    const legacyPaymentDate = (details && details.paymentDate) || fee.paidDate;
    if ((fee.paidAmount || 0) > 0 && isInCurrentMonth(legacyPaymentDate)) {
      return sum + (fee.paidAmount || 0);
    }

    return sum;
  }, 0), [fees, isInCurrentMonth, getCorrectFeeAmount]);
  
  // Get current month name for better display
  const currentMonth = new Date().toLocaleDateString('en-IN', { month: 'long' });

  const stats = useMemo(() => [
    { title: 'Total Students', value: totalStudents.toString(), icon: Users, color: theme.primary },
    { title: `${currentMonth} Revenue`, value: `₹${monthlyRevenue.toLocaleString()}`, icon: CreditCard, color: theme.success },
    { title: 'Pending Fees', value: `₹${pendingAmount.toLocaleString()}`, icon: AlertCircle, color: theme.warning },
    { title: 'Reminders Today', value: todayReminderTotals.total.toString(), icon: Bell, color: theme.primary, failed: todayReminderTotals.failed, pending: todayReminderTotals.pending },
  ], [totalStudents, currentMonth, monthlyRevenue, pendingAmount, todayReminderTotals, theme]);

  // Get upcoming dues from real data + projected next month dues
  const upcomingDues = useMemo(() => {
    // Get existing fees due from tomorrow onwards
    const existingUpcomingFees = fees
      .filter(fee => {
        if (fee.status === 'paid') return false;
        
        const dueDate = new Date(fee.dueDate);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1); // Start from tomorrow
        tomorrow.setHours(0, 0, 0, 0); // Reset time to start of day
        
        // Show fees due from tomorrow onwards (including next month and beyond)
        return dueDate >= tomorrow;
      })
      .map(fee => {
        const student = students.find(s => s.id === fee.studentId);
        return {
          name: fee.studentName,
          amount: `₹${getCorrectFeeAmount(fee).toLocaleString()}`,
          dueDate: new Date(fee.dueDate).toLocaleDateString(),
          subject: (student?.subjects || []).join(', ') || 'N/A',
          type: 'existing',
          sortDate: new Date(fee.dueDate),
        };
      });

    // Generate projected fees for current month and next month
    const today = new Date();
    const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const currentMonthString = `${currentMonth.getFullYear()}-${(currentMonth.getMonth() + 1).toString().padStart(2, '0')}`;
    const nextMonthString = `${nextMonth.getFullYear()}-${(nextMonth.getMonth() + 1).toString().padStart(2, '0')}`;
    
    // Get projected current month fees for students who don't have fees for current month yet
    const projectedCurrentMonthFees = students
      .filter(student => {
        // Only active students
        if (student.status !== 'active') return false;
        
        // Check if student already has a fee for current month
        const hasCurrentMonthFee = fees.some(fee => 
          fee.studentId === student.id && 
          fee.dueDate.startsWith(currentMonthString)
        );
        
        // Check if student has consolidated fee covering current month
        const hasConsolidatedFee = fees.some(fee => 
          fee.studentId === student.id && 
          fee.monthsCovered && 
          fee.monthsCovered.includes(currentMonthString)
        );
        
        return !hasCurrentMonthFee && !hasConsolidatedFee;
      })
      .map(student => {
        const dueDay = student.feeDueDate || 1;
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth() + 1;
        
        // Ensure due day is valid for the month
        const maxDaysInMonth = new Date(year, month, 0).getDate();
        const validDueDay = Math.min(dueDay, maxDaysInMonth);
        
        const projectedDueDate = new Date(year, month - 1, validDueDay);
        const monthlyFee = student.monthlyFee || student.totalFees || 1000;
        
        // Only show if the due date is today or in the future
        if (projectedDueDate >= new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
          return {
            name: student.name,
            amount: `₹${monthlyFee.toLocaleString()}`,
            dueDate: projectedDueDate.toLocaleDateString(),
            subject: (student.subjects || []).join(', ') || 'N/A',
            type: 'projected-current',
            sortDate: projectedDueDate,
          };
        }
        return null;
      })
      .filter(Boolean);

    // Get projected next month fees for students who don't have fees for next month yet
    const projectedNextMonthFees = students
      .filter(student => {
        // Only active students
        if (student.status !== 'active') return false;
        
        // Check if student already has a fee for next month
        const hasNextMonthFee = fees.some(fee => 
          fee.studentId === student.id && 
          fee.dueDate.startsWith(nextMonthString)
        );
        
        // Check if student has consolidated fee covering next month
        const hasConsolidatedFee = fees.some(fee => 
          fee.studentId === student.id && 
          fee.monthsCovered && 
          fee.monthsCovered.includes(nextMonthString)
        );
        
        return !hasNextMonthFee && !hasConsolidatedFee;
      })
      .map(student => {
        const dueDay = student.feeDueDate || 1;
        const year = nextMonth.getFullYear();
        const month = nextMonth.getMonth() + 1;
        
        // Ensure due day is valid for the month
        const maxDaysInMonth = new Date(year, month, 0).getDate();
        const validDueDay = Math.min(dueDay, maxDaysInMonth);
        
        const projectedDueDate = new Date(year, month - 1, validDueDay);
        const monthlyFee = student.monthlyFee || student.totalFees || 1000;
        
        return {
          name: student.name,
          amount: `₹${monthlyFee.toLocaleString()}`,
          dueDate: projectedDueDate.toLocaleDateString(),
          subject: (student.subjects || []).join(', ') || 'N/A',
          type: 'projected',
          sortDate: projectedDueDate,
        };
      });

    // Combine existing, projected current month, and projected next month fees, sort by date, and limit to 6
    return [...existingUpcomingFees, ...projectedCurrentMonthFees, ...projectedNextMonthFees]
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime())
      .slice(0, 6);
  }, [students, fees, getCorrectFeeAmount]);

  const handleNotifications = () => {
    // Load all notifications (without filters) when opening modal
    void loadAllNotifications();

    // Show notification modal
    setNotificationModalVisible(true);
  };

  const handleAddStudent = () => {
    router.push('/(tabs)/students');
  };

  const handleRecordPayment = () => {
    router.push('/(tabs)/fees');
  };

  const handleSendBulkReminder = () => {
    router.push('/(tabs)/reminders');
  };

  const onRefresh = async () => {
    try {
      setRefreshing(true);
      // Refresh reminder history and recent reminders; students/fees/notices are live via snapshots
      await Promise.all([
        (async () => {
          try { await refreshReminders?.(); } catch {}
        })(),
        loadRecentReminders(),
        loadTodayReminderStats(),
      ]);
      // Recompute activities after data refresh
      loadRecentActivities();
    } finally {
      setRefreshing(false);
    }
  };

  // Centralized offline-aware gate (prevents zero-valued UI on cold offline start)
  const { showLoading, offlineHint } = useOfflineDataGate(
    [students, fees, recentReminders],
    [studentsLoading, feesLoading, reminderLoading]
  );

  // Section-level loading flags (prefer section placeholders over full-screen block)
  const isStatsLoading = studentsLoading || feesLoading || reminderLoading || todayStatsLoading || showLoading;
  const isUpcomingLoading = studentsLoading || feesLoading || showLoading;
  const isRecentRemindersLoading = reminderLoading || showLoading;
  const isRecentActivityLoading = studentsLoading || feesLoading || reminderLoading || showLoading;

  // Dynamic style function for stat cards
  const getStatCardStyle = (screenWidth: number) => ({
    width: (screenWidth - 60) / 2,
    padding: 20,
    borderRadius: 16,
    alignItems: 'center' as const,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  });

  // Dynamic style function for action cards
  const getActionCardStyle = () => ({
    flex: 1,
    padding: 20,
    borderRadius: 16,
    alignItems: 'center' as const,
    marginHorizontal: 4,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  });

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
  {/* Header */}

  <View style={[
    styles.header,
    { backgroundColor: theme.surface, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }
  ]}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text allowFontScaling={false} style={[styles.greeting, { color: theme.text }]}>{getGreeting()}</Text>
          <Text allowFontScaling={false} style={[styles.subtitle, { color: theme.textSecondary }]}>{"Here's your tuition overview"}</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity 
            style={[styles.iconButton, { backgroundColor: theme.background, borderColor: theme.border }]} 
            onPress={() => setShowNoticeModal(true)}
          >
            <FileText size={24} color={theme.textSecondary} />
            {notices.length > 0 && (
              <View style={[styles.noticeBadge, { backgroundColor: theme.error }]}>
                <Text allowFontScaling={false} style={styles.noticeBadgeText}>{notices.length > 99 ? '99+' : notices.length.toString()}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.iconButton, { backgroundColor: theme.background, borderColor: theme.border }]} 
            onPress={handleNotifications}
          >
            <Bell size={24} color={theme.textSecondary} />
            {recentActivities.length > 0 && (
              <View style={[styles.notificationBadge, { backgroundColor: theme.error }]} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, 16) + 20 }
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
            titleColor={theme.textSecondary}
            colors={[theme.primary]}
          />
        }
      >
        {/* Offline/Loading Banner */}
        {!!offlineHint && (
          <View style={[styles.banner, { backgroundColor: `${theme.warning}15`, borderColor: `${theme.warning}40` }]}>
            <Text style={[styles.bannerText, { color: theme.text }]}>{offlineHint}</Text>
          </View>
        )}

        {shouldShowStorageUsageBanner && (
          <UsageAlertInlineBanner
            alert={storageUsageAlert}
            totalAlerts={storageAlertCount}
            loading={storageUsageAlertLoading}
            error={storageUsageAlertError}
            monthLabel={storageUsageMonthId}
            onPress={() => router.push('/(tabs)/usage')}
            onRefresh={refreshStorageUsageAlerts}
          />
        )}

        {/* Birthday Card */}
        {hasCelebration && (
          <LinearGradient
            colors={[ '#FDE68A', '#FCA5A5', '#A78BFA' ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ borderRadius: 20, padding: 16, marginTop: 12, marginBottom: 16, marginHorizontal: 16 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: 'Poppins-Bold', fontSize: 18, color: '#111827', paddingHorizontal: 2 }}>🎉 Teacher Birthday</Text>
                {celebrants.map((c) => (
                  <Text key={`${c.name}-${c.date}`} style={{ fontFamily: 'Inter-Regular', color: '#111827', marginTop: 6, paddingHorizontal: 2 }}>
                    {(() => {
                      const extra = c.subjects && c.subjects.length > 0
                        ? ` — ${c.subjects.join(', ')}`
                        : (c.role ? ` — ${c.role}` : '');
                      return `Happy Birthday, ${c.name}${extra}! 🎂`;
                    })()}
                  </Text>
                ))}
              </View>
              <TouchableOpacity
                onPress={toggleMusic}
                accessibilityLabel={isMusicPlaying ? 'Pause music' : 'Play music'}
                style={{
                  paddingVertical: 10,
                  paddingHorizontal: 14,
                  borderRadius: 12,
                  backgroundColor: 'rgba(255,255,255,0.6)',
                  marginLeft: 12,
                }}
              >
                <Text style={{ fontFamily: 'Poppins-Bold', color: '#111827' }}>
                  {isMusicPlaying ? 'Pause' : 'Play'}
                </Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        )}
        
        {/* Stats Cards - 2x2 Grid */}
        <View style={styles.statsContainer}>
          {isStatsLoading ? (
            <>
              <View style={styles.statsRow}>
                {[0,1].map((i) => (
                  <SkeletonCard key={`stat-skel-top-${i}`} style={[getStatCardStyle(screenData.width), { backgroundColor: theme.surface }]}> 
                    <SkeletonCircle size={48} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                    <View style={{ marginTop: 12 }}>
                      <SkeletonRow
                        isCard
                        centerAlign
                        lines={[{ width: '60%', height: 24 }, { width: '40%', height: 12 }]}
                        baseColor={`${theme.textSecondary}15`}
                        highlightColor={`${theme.textSecondary}35`}
                      />
                    </View>
                  </SkeletonCard>
                ))}
              </View>
              <View style={styles.statsRow}>
                {[0,1].map((i) => (
                  <SkeletonCard key={`stat-skel-bot-${i}`} style={[getStatCardStyle(screenData.width), { backgroundColor: theme.surface }]}> 
                    <SkeletonCircle size={48} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                    <View style={{ marginTop: 12 }}>
                      <SkeletonRow
                        isCard
                        centerAlign
                        lines={[{ width: '60%', height: 24 }, { width: '40%', height: 12 }]}
                        baseColor={`${theme.textSecondary}15`}
                        highlightColor={`${theme.textSecondary}35`}
                      />
                    </View>
                  </SkeletonCard>
                ))}
              </View>
            </>
          ) : (
            <>
              <View style={styles.statsRow}>
                {stats.slice(0, 2).map((stat, index) => (
                  <TouchableOpacity 
                    key={index} 
                    style={[getStatCardStyle(screenData.width), { backgroundColor: theme.surface }]}
                    onPress={() => {
                      if (stat.title === 'Total Students') router.push('/(tabs)/students');
                      else if (stat.title.includes('Revenue')) router.push('/(tabs)/fees');
                    }}
                  >
                    <View style={[styles.statIcon, { backgroundColor: `${stat.color}15` }]}>
                      <stat.icon size={24} color={stat.color} />
                    </View>
                    <Text style={[styles.statValue, { color: theme.text }]}>{stat.value}</Text>
                    <Text style={[styles.statTitle, { color: theme.textSecondary }]}>{stat.title}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.statsRow}>
                {stats.slice(2, 4).map((stat, index) => (
                  <TouchableOpacity 
                    key={index + 2} 
                    style={[getStatCardStyle(screenData.width), { backgroundColor: theme.surface }]}
                    onPress={() => {
                      if (stat.title === 'Pending Fees') router.push('/(tabs)/fees');
                      else if (stat.title === 'Reminders Today') router.push('/(tabs)/reminders');
                    }}
                  >
                    <View style={[styles.statIcon, { backgroundColor: `${stat.color}15` }]}>
                      <stat.icon size={24} color={stat.color} />
                    </View>
                    {stat.title === 'Reminders Today' ? (
                      <View style={{ alignItems: 'center' }}>
                        <Text style={[styles.statValue, { color: theme.text }]}>{stat.value}</Text>
                        {(((stat.failed ?? 0) > 0) || ((stat.pending ?? 0) > 0)) && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {(stat.failed ?? 0) > 0 && (
                              <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: `${theme.error}15` }}>
                                <Text style={{ fontFamily: 'Inter-Medium', color: theme.error, fontSize: 12 }}>Failed: {stat.failed ?? 0}</Text>
                              </View>
                            )}
                            {(stat.pending ?? 0) > 0 && (
                              <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: `${theme.warning}15` }}>
                                <Text style={{ fontFamily: 'Inter-Medium', color: theme.warning, fontSize: 12 }}>Pending: {stat.pending ?? 0}</Text>
                              </View>
                            )}
                          </View>
                        )}
                      </View>
                    ) : (
                      <Text style={[styles.statValue, { color: theme.text }]}>{stat.value}</Text>
                    )}
                    <Text style={[styles.statTitle, { color: theme.textSecondary }]}>{stat.title}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
        </View>

        {/* Quick Actions */}
        <View style={styles.sectionContainer}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Quick Actions</Text>
          <View style={styles.actionsContainer}>
            <TouchableOpacity 
              style={[getActionCardStyle(), { backgroundColor: theme.surface }]}
              onPress={handleAddStudent}
            >
              <View style={[styles.actionIcon, { backgroundColor: `${theme.primary}15` }]}>
                <Plus size={20} color={theme.primary} />
              </View>
              <Text style={[styles.actionText, { color: theme.text }]}>Add Student</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[getActionCardStyle(), { backgroundColor: theme.surface }]}
              onPress={handleRecordPayment}
            >
              <View style={[styles.actionIcon, { backgroundColor: `${theme.success}15` }]}>
                <CreditCard size={20} color={theme.success} />
              </View>
              <Text style={[styles.actionText, { color: theme.text }]}>Record Payment</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[getActionCardStyle(), { backgroundColor: theme.surface }]}
              onPress={handleSendBulkReminder}
            >
              <View style={[styles.actionIcon, { backgroundColor: `${theme.warning}15` }]}>
                <Bell size={20} color={theme.warning} />
              </View>
              <Text style={[styles.actionText, { color: theme.text }]}>Send Reminder</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Upcoming Dues */}
        <View style={styles.sectionContainer}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Upcoming Dues</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/fees')}>
              <Text style={[styles.seeAllText, { color: theme.primary }]}>See All</Text>
            </TouchableOpacity>
          </View>
          {isUpcomingLoading ? (
            [0,1,2].map((i) => (
              <SkeletonCard key={`due-skel-${i}`} style={[styles.dueCard, { backgroundColor: theme.surface }]}> 
                <View style={styles.dueInfo}>
                  <View style={styles.dueNameContainer}>
                    <SkeletonRow
                      isCard
                      style={{ flex: 1 }}
                      leftIcon={false}
                      lines={[{ width: '80%', height: 16 }]}
                      baseColor={`${theme.textSecondary}15`}
                      highlightColor={`${theme.textSecondary}35`}
                    />
                    <View style={[styles.projectedBadge, { backgroundColor: `${theme.textSecondary}10` }]}><Text style={{ opacity: 0 }}>badge</Text></View>
                  </View>
                  <SkeletonBar style={[styles.skeletonBarSm, { width: '60%' }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                  <SkeletonBar style={[styles.skeletonBarXs, { width: '40%' }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                </View>
                <View style={styles.dueAmount}>
                  <SkeletonBar style={[styles.skeletonBarMd, { width: 80 }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                </View>
              </SkeletonCard>
            ))
          ) : upcomingDues.length > 0 ? (
            upcomingDues.map((due, index) => (
              <TouchableOpacity key={index} style={[styles.dueCard, { backgroundColor: theme.surface }]}>
                <View style={styles.dueInfo}>
                  <View style={styles.dueNameContainer}>
                    <Text style={[styles.dueName, { color: theme.text }]}>{due.name}</Text>
                    {(due.type === 'projected' || due.type === 'projected-current') && (
                      <View style={[styles.projectedBadge, { backgroundColor: `${theme.primary}20` }]}>
                        <Text style={[styles.projectedText, { color: theme.primary }]}>
                          {due.type === 'projected-current' ? 'This Month' : 'Next Month'}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.dueSubject, { color: theme.textSecondary }]}>{due.subject}</Text>
                  <Text style={[styles.dueDateText, { color: (due.type === 'projected' || due.type === 'projected-current') ? theme.primary : theme.warning }]}>
                    Due: {due.dueDate}
                  </Text>
                </View>
                <View style={styles.dueAmount}>
                  <Text style={[styles.dueAmountText, { color: theme.text }]}>{due.amount}</Text>
                </View>
              </TouchableOpacity>
            ))
          ) : (
            <View style={[styles.emptyState, { backgroundColor: theme.surface }]}>
              <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>No upcoming dues</Text>
            </View>
          )}
        </View>

        {/* Recent Reminders */}
        <View style={styles.sectionContainer}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent Reminders</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/reminders')}>
              <Text style={[styles.seeAllText, { color: theme.primary }]}>See All</Text>
            </TouchableOpacity>
          </View>
          {isRecentRemindersLoading ? (
            [0,1,2].map((i) => (
              <SkeletonCard key={`reminder-skel-${i}`} style={[styles.reminderCard, { backgroundColor: theme.surface }]}> 
                <View style={styles.reminderHeader}>
                  <View style={styles.reminderTypeContainer}>
                    <SkeletonCircle size={24} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} style={{ marginRight: 8 }} />
                    <SkeletonBar style={[styles.skeletonBarXs, { width: 80 }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                  </View>
                  <SkeletonBar style={[styles.skeletonBarXs, { width: 60 }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                </View>
                <View style={styles.reminderInfo}>
                  <SkeletonBar style={[styles.skeletonBarSm, { width: '50%' }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                  <SkeletonBar style={[styles.skeletonBarXs, { width: '40%', marginTop: 6 }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                  <SkeletonBar style={[styles.skeletonBarXs, { width: 100, marginTop: 6 }]} baseColor={`${theme.textSecondary}15`} highlightColor={`${theme.textSecondary}35`} />
                </View>
              </SkeletonCard>
            ))
          ) : recentReminders.length > 0 ? (
            recentReminders.slice(0, 5).map((reminder, index) => {
              const ReminderIcon = getReminderIcon(reminder.reminderType);
              const StatusIcon = getReminderStatusIcon(reminder.status);
              const statusColor = getReminderStatusColor(reminder.status);
              
              return (
                <TouchableOpacity key={reminder.id || index} style={[styles.reminderCard, { backgroundColor: theme.surface }]}>
                  <View style={styles.reminderHeader}>
                    <View style={styles.reminderTypeContainer}>
                      <View style={[styles.reminderTypeIcon, { backgroundColor: `${theme.primary}15` }]}>
                        <ReminderIcon size={16} color={theme.primary} />
                      </View>
                      <Text style={[styles.reminderType, { color: theme.text }]}>
                        {reminder.reminderType?.toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.reminderStatusContainer}>
                      <StatusIcon size={14} color={statusColor} />
                      <Text style={[styles.reminderStatus, { color: statusColor }]}>
                        {reminder.status?.toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.reminderInfo}>
                    <Text style={[styles.reminderStudent, { color: theme.text }]}>
                      {reminder.studentName}
                    </Text>
                    <Text style={[styles.reminderDetails, { color: theme.textSecondary }]}>
                      ₹{reminder.amount} • {reminder.parentContact}
                    </Text>
                    <Text style={[styles.reminderTime, { color: theme.textSecondary }]}>
                      {formatReminderDate(reminder.createdAt)}
                    </Text>
                  </View>
                  {reminder.errorMessage && (
                    <Text style={[styles.reminderError, { color: theme.error }]}>
                      Error: {reminder.errorMessage}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })
          ) : (
            <View style={[styles.emptyState, { backgroundColor: theme.surface }]}>
              <Bell size={24} color={theme.textSecondary} />
              <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>No recent reminders</Text>
              <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}>
                Reminder history will appear here
              </Text>
            </View>
          )}
        </View>

        {/* Recent Activity */}
        <View style={styles.sectionContainer}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent Activity</Text>
          {/* Show combined activities (reminders + fee creations) */}
          {isRecentActivityLoading ? (
            [0,1,2,3].map((i) => (
              <SkeletonCard key={`activity-skel-${i}`} style={[styles.activityCard, { backgroundColor: theme.surface }]}> 
                <SkeletonRow
                  isCard
                  leftIcon
                  leftIconSize={32}
                  lines={[{ width: '70%' }, { width: 120 }]}
                  baseColor={`${theme.textSecondary}15`}
                  highlightColor={`${theme.textSecondary}35`}
                />
              </SkeletonCard>
            ))
          ) : (
          recentActivities.map((activity, index) => {
            const ActivityIcon = getActivityIcon(activity);
            const activityColor = getActivityColor(activity);
            const activityMessage = getActivityMessage(activity);
            
            return (
              <View key={activity.id || `activity-${index}`} style={[styles.activityCard, { backgroundColor: theme.surface }]}>
                <View style={[
                  styles.activityIcon,
                  { backgroundColor: `${activityColor}15` }
                ]}>
                  <ActivityIcon size={16} color={activityColor} />
                </View>
                <View style={styles.activityContent}>
                  <Text style={[styles.activityMessage, { color: theme.text }]}>
                    {activityMessage}
                  </Text>
                  <Text style={[styles.activityTime, { color: theme.textSecondary }]}>
                    {formatReminderDate(activity.createdAt)}
                  </Text>
                </View>
              </View>
            );
          })
          )}
          {recentActivities.length === 0 && !isRecentActivityLoading && (
            <View style={[styles.emptyState, { backgroundColor: theme.surface }]}>
              <Bell size={24} color={theme.textSecondary} />
              <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>No recent activity</Text>
              <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}>
                Recent activity will appear here
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Notification Modal */}
      <Modal
        visible={notificationModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setNotificationModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContainer, { backgroundColor: theme.surface }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>
                Recent Notifications ({allNotifications.length >= 100 ? '100+' : allNotifications.length})
              </Text>
              <TouchableOpacity
                onPress={() => setNotificationModalVisible(false)}
                style={[styles.closeButton, { backgroundColor: theme.background }]}
              >
                <Text style={[styles.closeButtonText, { color: theme.textSecondary }]}>✕</Text>
              </TouchableOpacity>
            </View>
            
            <ScrollView
              style={styles.modalContent}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{
                paddingBottom: Platform.select({ web: 0, default: 10 }),
              }}
            >
              {notificationsLoading ? (
                <View style={styles.notificationsLoading}>
                  <ActivityIndicator size="small" color={theme.primary} />
                  <Text style={[styles.notificationsLoadingText, { color: theme.textSecondary }]}>Loading notifications…</Text>
                </View>
              ) : allNotifications.length > 0 ? (
                allNotifications.map((activity, index) => {
                  const timeAgo = formatReminderDate(activity.createdAt);
                  const ActivityIcon = getActivityIcon(activity);
                  const activityColor = getActivityColor(activity);
                  const activityMessage = getActivityMessage(activity);
                  
                  // Get status emoji
                  let status = '📋'; // Default for fee creation
                  if (activity.type === 'reminder') {
                    status = activity.status === 'success' ? '✅' : activity.status === 'failed' ? '❌' : '⏳';
                  } else if (activity.type === 'fee_created') {
                    status = activity.status === 'paid' ? '✅' : activity.status === 'overdue' ? '❌' : '📋';
                  } else if (activity.type === 'fee_deleted') {
                    status = '🗑️';
                  } else if (activity.type === 'student_added') {
                    status = '👤';
                  }
                  
                  return (
                    <View key={activity.id || index} style={[styles.notificationItem, { backgroundColor: theme.background }]}>
                      <View style={styles.notificationHeader}>
                        <View style={[styles.notificationIcon, { backgroundColor: `${activityColor}15` }]}>
                          <ActivityIcon size={16} color={activityColor} />
                        </View>
                        <Text style={[styles.notificationStatus, { color: activityColor }]}>{status}</Text>
                      </View>
                      <Text style={[styles.notificationText, { color: theme.text }]}>
                        {activityMessage}
                      </Text>
                      <Text style={[styles.notificationTime, { color: theme.textSecondary }]}>
                        {timeAgo}
                      </Text>
                    </View>
                  );
                })
              ) : (
                <View style={styles.emptyNotifications}>
                  <Bell size={32} color={theme.textSecondary} />
                  <Text style={[styles.emptyNotificationsText, { color: theme.textSecondary }]}>
                    No recent notifications available
                  </Text>
                </View>
              )}
            </ScrollView>
            
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: theme.primary }]}
                onPress={() => {
                  setNotificationModalVisible(false);
                  router.push('/(tabs)/reminders');
                }}
              >
                <Text style={styles.modalButtonText}>View All Reminders</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: theme.textSecondary }]}
                onPress={() => setNotificationModalVisible(false)}
              >
                <Text style={styles.modalButtonText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <NoticeModal
        visible={showNoticeModal}
        onClose={() => setShowNoticeModal(false)}
      />
    </View>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
  },
  greeting: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
  },
  subtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconButton: {
    padding: 12,
    marginLeft: 8,
    position: 'relative',
    borderRadius: 12,
    borderWidth: 1,
  },
  notificationBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  noticeBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  noticeBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontFamily: 'Inter-Bold',
    fontWeight: 'bold',
  },
  scrollContent: {
    paddingBottom: 20,
  },
  statsContainer: {
    paddingHorizontal: 20,
    marginTop: 20,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  statIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  statValue: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
    marginBottom: 4,
  },
  statTitle: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  sectionContainer: {
    marginTop: 32,
    paddingHorizontal: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
  },
  seeAllText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  actionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  actionText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  dueCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  dueInfo: {
    flex: 1,
  },
  dueNameContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  dueName: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    flex: 1,
  },
  projectedBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
  },
  projectedText: {
    fontSize: 10,
    fontFamily: 'Inter-Medium',
    fontWeight: 'bold',
  },
  dueSubject: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginBottom: 4,
  },
  dueDateText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  dueAmount: {
    alignItems: 'flex-end',
  },
  dueAmountText: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 8,
  },
  remindButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  remindText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    color: '#ffffff',
  },
  emptyState: {
    padding: 32,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  emptyStateText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  activityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  activityIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  activityContent: {
    flex: 1,
  },
  activityMessage: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    marginBottom: 4,
  },
  activityTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  reminderCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  reminderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  reminderTypeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reminderTypeIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  reminderType: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    fontWeight: 'bold',
  },
  reminderStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reminderStatus: {
    fontSize: 11,
    fontFamily: 'Inter-Medium',
    fontWeight: 'bold',
    marginLeft: 4,
  },
  reminderInfo: {
    marginBottom: 4,
  },
  reminderStudent: {
    fontSize: 15,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  reminderDetails: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginBottom: 2,
  },
  reminderTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  reminderError: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    fontStyle: 'italic',
    marginTop: 4,
  },
  emptyStateSubtext: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
    textAlign: 'center',
  },
  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContainer: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 0, 0, 0.1)',
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    flex: 1,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  closeButtonText: {
    fontSize: 18,
    fontFamily: 'Inter-Bold',
  },
  modalContent: {
    maxHeight: 300,
    paddingHorizontal: 20,
  },
  notificationItem: {
    padding: 16,
    marginVertical: 4,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  notificationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  notificationIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  notificationStatus: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  notificationText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    marginBottom: 4,
  },
  notificationTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  emptyNotifications: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyNotificationsText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    marginTop: 12,
    textAlign: 'center',
  },
  notificationsLoading: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  notificationsLoadingText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    marginTop: 12,
    textAlign: 'center',
  },
  modalActions: {
    flexDirection: 'row',
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0, 0, 0, 0.1)',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    color: '#ffffff',
  },
  // Loading banner and skeletons
  banner: {
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 0,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  bannerText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  skeletonBarLg: {
    height: 24,
    borderRadius: 6,
    alignSelf: 'stretch',
    marginBottom: 8,
  },
  skeletonBarMd: {
    height: 16,
    borderRadius: 6,
    alignSelf: 'stretch',
    marginBottom: 6,
  },
  skeletonBarSm: {
    height: 12,
    borderRadius: 6,
    alignSelf: 'stretch',
    marginBottom: 6,
  },
  skeletonBarXs: {
    height: 10,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
});