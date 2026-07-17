import { logger } from '@/lib/logger';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Modal,
  Alert,
  TextInput,
  Platform,
  Image,
  ActivityIndicator,
  InteractionManager,
  useWindowDimensions, // added for responsive header
} from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import { Calendar, DollarSign, CircleAlert as AlertCircle, CircleCheck as CheckCircle, Clock, Send, Filter, Download, Eye, EyeOff, Users, X, Trash2, Upload, FileText, Plus, ChevronDown, Info, Mail, MessageSquare, Phone, Bell, Check, Search, Camera } from 'lucide-react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Linking from 'expo-linking';
import * as IntentLauncher from 'expo-intent-launcher';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as XLSX from 'xlsx';
import { MediaPickerUtil } from '@/lib/mediaPickerUtil';
import { reconcileTenantStorageUsageViaBackend, uploadBlobViaBackend, deleteStorageObjectViaBackend } from '../../services/backendStorageUploadService';
import { maybeShowStorageLimitReachedAlert } from '../../services/storageLimitAlert';
import { getFirestore as getFirestoreClient, doc as docClient, setDoc as setDocClient, deleteDoc as deleteDocClient, collection as collectionClient } from 'firebase/firestore';
import { storage } from '../../config/firebase';
import { useRouter } from 'expo-router';
import useFees, { type FeeRecord } from '../../hooks/useFees';
import useStudents from '../../hooks/useStudents';
import { useTheme } from '../../hooks/useTheme';
import { useBirthdays } from '../../components/BirthdayProvider';
import { useAuth } from '../../hooks/useAuthUnified'; // Add useAuth import
import Toast from 'react-native-toast-message';
import { notificationService } from '../../services/notificationService';
import { formatDateToString } from '../../lib/utils';
import { getMimeTypeFromFileName } from '../../lib/fileUtils';
import { useReminderHistory } from '../../hooks/useReminderHistory';
import { useTenant } from '../../hooks/useTenantContext';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import { normalizePhoneNumber as normalizePhoneE164 } from '../../services/phoneUtil';
import { reminderHistoryService } from '../../services/reminderHistoryService';
import ReminderHistoryViewer from '../../components/ReminderHistoryViewer';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';
import { useEasedUploadProgress } from '@/hooks/useEasedUploadProgress';
import FeeHistory from '../../components/FeeHistory';

// Define Student interface directly in the component to test
interface Student {
  id: string;
  name: string;
  email: string;
  phone: string;
  grade: string;
  enrolledCourses: string[];
  feesPaid: number;
  totalFees: number;
  lastPaymentDate?: string;
  parentName?: string;
  parentPhone?: string;
  parentEmail?: string;
  parentContact?: string;
  parentWhatsApp?: string;
  address?: string;
  dateOfBirth?: string;
  emergencyContact?: string;
  enrollmentDate: string;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  updatedAt: string;
  subjects?: string[];
  attendance?: number;
  performance?: string;
  monthlyFee?: number;
  joinDate?: string;
  feeDueDate?: number; // Day of the month (1-31) when fee is due
}

const parseMonthString = (value: string | null | undefined) => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{4})-(\d{1,2})/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  return { year, month } as const;
};

const normalizeMonthString = (value: string | null | undefined) => {
  const parsed = parseMonthString(value);
  if (!parsed) {
    return null;
  }

  const { year, month } = parsed;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
};

const monthStringToIndex = (value: string | null | undefined) => {
  const parsed = parseMonthString(value);
  if (!parsed) {
    return null;
  }

  return parsed.year * 12 + (parsed.month - 1);
};

const indexToMonthString = (index: number) => {
  if (!Number.isInteger(index) || index < 0) {
    return '';
  }

  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;

  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
};

const hasDueDatePassedForMonthIndex = (
  targetIndex: number,
  currentIndex: number,
  dueDay: number,
  referenceDate: Date
) => {
  if (!Number.isInteger(targetIndex) || !Number.isInteger(currentIndex)) {
    return false;
  }

  if (targetIndex < currentIndex) {
    return true;
  }

  if (targetIndex > currentIndex) {
    return false;
  }

  const safeDueDay = Math.min(Math.max(dueDay || 1, 1), 31);
  return referenceDate.getDate() >= safeDueDay;
};

type InteractionTask = ReturnType<typeof InteractionManager.runAfterInteractions>;
type AnimationFrameTask = ReturnType<typeof requestAnimationFrame>;

type ReceiptGroupItem = {
  receipt: any;
  originalIndex: number;
  uploadedAtDate: Date | null;
};

type ReceiptGroup = {
  key: string;
  label: string;
  timestamp: number;
  items: ReceiptGroupItem[];
};

const safeDateFromUnknown = (value: any): Date | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (value && typeof value === 'object') {
    if (typeof (value as any).toDate === 'function') {
      const date = (value as any).toDate();
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
    }

    if (typeof (value as any).seconds === 'number') {
      const milliseconds = (value as any).seconds * 1000 + Math.floor(((value as any).nanoseconds || 0) / 1_000_000);
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  return null;
};

const formatReceiptMonthLabel = (date: Date | null) => {
  if (!date) {
    return 'Unknown Date';
  }

  return date.toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
};

const formatReceiptDateLabel = (date: Date | null) => {
  if (!date) {
    return 'Uploaded date unavailable';
  }

  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const RECEIPT_ANDROID_VIEW_INTENT = 'android.intent.action.VIEW';
const RECEIPT_FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const RECEIPT_FLAG_ACTIVITY_NEW_TASK = 0x10000000;

const RECEIPT_MIME_EXTENSION_MAP: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'application/rtf': 'rtf',
};

const sanitizeReceiptFileName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');

const inferReceiptExtension = (fileName?: string, mimeType?: string) => {
  if (fileName) {
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot !== -1 && lastDot < fileName.length - 1) {
      return fileName.slice(lastDot + 1);
    }
  }

  const normalizedMime = (mimeType || '').toLowerCase();
  if (normalizedMime && RECEIPT_MIME_EXTENSION_MAP[normalizedMime]) {
    return RECEIPT_MIME_EXTENSION_MAP[normalizedMime];
  }

  return 'bin';
};

const buildReceiptDownloadFileName = (receipt: any) => {
  const rawName = receipt?.fileName || `receipt_${Date.now()}`;
  const base = rawName.replace(/\.[^.]+$/, '');
  const sanitizedBase = sanitizeReceiptFileName(base) || 'receipt';
  const extension = inferReceiptExtension(receipt?.fileName, receipt?.type);
  return `${sanitizedBase}.${extension}`;
};

export default function Fees() {
  const { theme } = useTheme();
  const sharedTopPadding = useSharedTopPadding();
  const { width } = useWindowDimensions(); // get screen width
  const isSmallScreen = width < 600; // threshold for small screens
  const isNativePlatform = Platform.OS !== 'web';
  const isFocused = useIsFocused();
  const recordsScrollRef = useRef<any>(null);
  const filtersScrollRef = useRef<any>(null);
  const [recordsScrollEnabled, setRecordsScrollEnabled] = useState(true);

  const router = useRouter();
  const { user } = useAuth(); // Add useAuth hook
  const { activeTenant, loading: tenantLoading } = useTenant();
  const tenantId = activeTenant?.id ?? null;
  const tenantUnavailable = !tenantLoading && !tenantId;
  const { fees, loading, error, markAsPaid, updateFeeRecord, addFeeRecord, deleteFeeRecord, deletePaymentRecord } = useFees();
  
  const resolvedTeacherName = (user?.displayName && user.displayName.trim()) ? user.displayName.trim() : undefined;
  const resolvedCoachingName = useMemo(() => {
    const tenantName = (activeTenant?.name || '').trim();
    return tenantName || 'S.S Tuition Classes';
  }, [activeTenant?.name]);
  
  // Ref to prevent rapid successive auto-fee checks
  const lastAutoCheckRef = useRef<number>(0);
  const AUTO_CHECK_COOLDOWN = 5000; // 5 seconds cooldown between checks
  const MAX_AUTO_FEE_BACKLOG_MONTHS = 12; // Catch up up to 12 months of missed automatic fees
  const { students: studentList, loading: studentsLoading } = useStudents();
  const students = studentList as Student[];
  // Quick lookup by studentId for filters/search
  const studentMap = useMemo(() => {
    const map: Record<string, Student> = {} as any;
    for (const s of students) map[s.id] = s;
    return map;
  }, [students]);
  const feeCoverageMap = useMemo(() => {
    const map = new Map<string, Set<string>>();

    const addCoverage = (studentId: string, month: string | null | undefined) => {
      if (!studentId) {
        return;
      }
      const normalizedMonth = normalizeMonthString(month);
      if (!normalizedMonth) {
        return;
      }
      if (!map.has(studentId)) {
        map.set(studentId, new Set<string>());
      }
      map.get(studentId)!.add(normalizedMonth);
    };

    fees.forEach((fee: any) => {
      const studentId = fee?.studentId;
      if (!studentId) {
        return;
      }

      if (Array.isArray(fee?.monthsCovered) && fee.monthsCovered.length > 0) {
        fee.monthsCovered.forEach((month: string) => addCoverage(studentId, month));
      } else if (typeof fee?.dueDate === 'string' && fee.dueDate.length >= 7) {
        addCoverage(studentId, fee.dueDate.substring(0, 7));
      }
    });

    return map;
  }, [fees]);
  const runtimeCoverageRef = useRef<Map<string, Set<string>>>(new Map());
  useEffect(() => {
    runtimeCoverageRef.current = new Map();
  }, [fees]);

  const markRuntimeCoverage = useCallback((studentId: string, month: string | null | undefined) => {
    const normalizedMonth = normalizeMonthString(month);
    if (!studentId || !normalizedMonth) {
      return;
    }

    if (!runtimeCoverageRef.current.has(studentId)) {
      runtimeCoverageRef.current.set(studentId, new Set());
    }
    runtimeCoverageRef.current.get(studentId)!.add(normalizedMonth);
  }, []);

  const isMonthCovered = useCallback((studentId: string | undefined, month: string | null | undefined) => {
    if (!studentId || !month) {
      return false;
    }

    const normalizedMonth = normalizeMonthString(month);
    if (!normalizedMonth) {
      return false;
    }

    const baseCoverage = feeCoverageMap.get(studentId);
    if (baseCoverage?.has(normalizedMonth)) {
      return true;
    }

    const runtimeCoverage = runtimeCoverageRef.current.get(studentId);
    return runtimeCoverage?.has(normalizedMonth) ?? false;
  }, [feeCoverageMap]);
  const { getStudentHistory, canViewAllReminders } = useReminderHistory({ autoload: false });
  // Call all hooks at the top-level before any conditional returns
  const {
    headerCompensation,
    celebrants,
    overlaySeen,
    hasCelebration,
    isPosterOpen,
  } = useBirthdays();
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);
  const isBirthdayOverlayActive = useMemo(() => {
    if (!hasCelebration || overlaySeen) {
      return false;
    }

    const normalizedEmail = user?.email?.toLowerCase();
    if (!normalizedEmail) {
      return false;
    }

    return celebrants.some((celebrant) => (celebrant.email || '').toLowerCase() === normalizedEmail);
  }, [hasCelebration, overlaySeen, celebrants, user?.email]);
  
  // Add component-level loading state to prevent expensive operations during initial load
  const [componentLoading, setComponentLoading] = useState(true);

  // Centralized offline-aware loading gate (prevents zeroed UI on cold offline start)
  const { showLoading: showOfflineLoadingFees, offlineHint: offlineHintFees } = useOfflineDataGate(
    [fees, students],
    [loading]
  );
  // Don't early return here; do it later after all hooks are declared to keep hook order consistent
  
  const [selectedFilter, setSelectedFilter] = useState('All');
  const [hidePaidFees, setHidePaidFees] = useState(false);
  // Search state with debouncing
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showPaymentMethodModal, setShowPaymentMethodModal] = useState(false);
  const [showReminderChannelModal, setShowReminderChannelModal] = useState(false);
  const [showPaymentLanguageModal, setShowPaymentLanguageModal] = useState(false);
  const [showLanguageOrderModal, setShowLanguageOrderModal] = useState(false);
  const [confirmingPayment, setConfirmingPayment] = useState(false);
  const [showFeeDetailsModal, setShowFeeDetailsModal] = useState(false);
  const [showAddFeeModal, setShowAddFeeModal] = useState(false);
  const [showDueMonthModal, setShowDueMonthModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeletingFee, setIsDeletingFee] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [selectedFee, setSelectedFee] = useState<any>(null);
  const [sortBy, setSortBy] = useState<'date' | 'amount' | 'student'>('date');

  const AUTO_FEE_MODAL_IDLE_DELAY = 1500; // ms delay before showing approval modal after idle
  
  // Receipt-related states
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [showReceiptUpload, setShowReceiptUpload] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<string | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const easedUploadProgress = useEasedUploadProgress(uploadProgress, {
    isActive: uploadingReceipt,
    smoothingPerSecond: 9,
    minStepPercent: 0.12,
    completionSnapThresholdPercent: 99.2,
    nearCompletionBoostStartPercent: 96,
    nearCompletionBoostMultiplier: 1.3,
  });
  const [selectedFiles, setSelectedFiles] = useState<any[]>([]);
  const selectedReceiptFilesRef = useRef<any[]>([]);
  const [isReceiptDropActive, setIsReceiptDropActive] = useState(false);
  const [skippedReceiptFiles, setSkippedReceiptFiles] = useState<string[]>([]);
  const MAX_SKIPPED_RECEIPT_ITEMS = 30;
  const [receiptModalError, setReceiptModalError] = useState<string | null>(null);
  const [showDeleteReceiptModal, setShowDeleteReceiptModal] = useState(false);
  const [receiptToDelete, setReceiptToDelete] = useState<{index: number, receipt: any} | null>(null);
  const [deletingReceipt, setDeletingReceipt] = useState(false);
  const [openingReceiptUrl, setOpeningReceiptUrl] = useState<string | null>(null);

  const groupedReceipts = useMemo<ReceiptGroup[]>(() => {
    if (!selectedFee?.receipts || selectedFee.receipts.length === 0) {
      return [];
    }

    const groupMap = new Map<string, ReceiptGroup>();

    selectedFee.receipts.forEach((receipt: any, index: number) => {
      const uploadedAtDate = safeDateFromUnknown(receipt?.uploadedAt);
      const key = uploadedAtDate
        ? `${uploadedAtDate.getFullYear()}-${(uploadedAtDate.getMonth() + 1).toString().padStart(2, '0')}`
        : 'unknown';
      const label = formatReceiptMonthLabel(uploadedAtDate);

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key,
          label,
          timestamp: uploadedAtDate ? uploadedAtDate.getTime() : Number.NEGATIVE_INFINITY,
          items: [],
        });
      }

      groupMap.get(key)!.items.push({
        receipt,
        originalIndex: index,
        uploadedAtDate,
      });
    });

    const sortedGroups = Array.from(groupMap.values()).sort((a, b) => {
      if (a.timestamp === b.timestamp) {
        return b.key.localeCompare(a.key);
      }
      return b.timestamp - a.timestamp;
    });

    sortedGroups.forEach(group => {
      group.items.sort((a, b) => {
        const aTime = a.uploadedAtDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bTime = b.uploadedAtDate?.getTime() ?? Number.NEGATIVE_INFINITY;

        if (aTime === bTime) {
          return a.originalIndex - b.originalIndex;
        }

        return bTime - aTime;
      });
    });

    return sortedGroups;
  }, [selectedFee?.receipts]);

  const resetReceiptUploadModalState = useCallback(() => {
    setSelectedFiles([]);
    selectedReceiptFilesRef.current = [];
    setSkippedReceiptFiles([]);
    setIsReceiptDropActive(false);
  }, []);

  const getReceiptFileIdentity = useCallback((file: any) => {
    const fileName = String(file?.name || file?.fileName || '').trim().toLowerCase();
    const fileSize = Number(file?.size || file?.fileSize || 0);
    const lastModified = Number(file?.lastModified || 0);
    return `${fileName}|${fileSize}|${lastModified}`;
  }, []);

  const groupedSkippedReceiptFiles = useMemo(() => {
    const groups: Record<'folder' | 'duplicate' | 'tooLarge' | 'unsupported' | 'other', string[]> = {
      folder: [],
      duplicate: [],
      tooLarge: [],
      unsupported: [],
      other: [],
    };

    for (const rawEntry of skippedReceiptFiles) {
      const entry = String(rawEntry || '').trim();
      if (!entry) continue;
      const match = entry.match(/^\[(.*?)\]\s*(.*)$/);
      const label = (match?.[1] || '').toLowerCase();
      const value = (match?.[2] || entry).trim();

      if (label === 'folder') groups.folder.push(value);
      else if (label === 'duplicate') groups.duplicate.push(value);
      else if (label === 'too large') groups.tooLarge.push(value);
      else if (label === 'unsupported') groups.unsupported.push(value);
      else groups.other.push(entry);
    }

    return groups;
  }, [skippedReceiptFiles]);
  
  // Payment deletion states
  const [showDeletePaymentModal, setShowDeletePaymentModal] = useState(false);
  const [paymentToDelete, setPaymentToDelete] = useState<{paymentId: string, payment: any, feeId: string} | null>(null);
  const [deletingPayment, setDeletingPayment] = useState(false);
  const [showDownloadConfirmModal, setShowDownloadConfirmModal] = useState(false);
  // Payment History inline view state
  const [showPaymentHistory, setShowPaymentHistory] = useState(false);

  useEffect(() => {
    if (!showAddFeeModal) {
      setShowDueMonthModal(false);
    }
  }, [showAddFeeModal]);

  // Helper: format ISO timestamps to readable local date-time for UI
  const formatPaidTimestamp = useCallback((value: any): string => {
    try {
      if (!value) return '';
      const date: Date = (value && typeof value === 'object' && value.toDate)
        ? value.toDate()
        : new Date(value);
      if (isNaN(date.getTime())) return String(value);
      return date.toLocaleString('en-IN', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return String(value ?? '');
    }
  }, []);
  
  // Reminder history states
  const [feeReminderHistory, setFeeReminderHistory] = useState<any[]>([]);
  const [loadingReminderHistory, setLoadingReminderHistory] = useState(false);
  const [studentReminders, setStudentReminders] = useState<{ [studentId: string]: any }>({});
  // New: full count of reminders for the student (not capped at 50)
  const [studentTotalReminderCount, setStudentTotalReminderCount] = useState<number | null>(null);
  
  // Custom toast states for proper z-index layering
  const [showCustomToast, setShowCustomToast] = useState(false);
  const [customToastData, setCustomToastData] = useState<{
    type: 'info' | 'success' | 'error';
    title: string;
    message: string;
    duration?: number;
  } | null>(null);
  
  // Auto fee approval states
  const [showAutoFeeApprovalModal, setShowAutoFeeApprovalModal] = useState(false);
  const [pendingAutoFeeActions, setPendingAutoFeeActions] = useState<{
    id: string,
    type: 'create' | 'update',
    student: any,
    currentMonth: string,
    monthlyFee: number,
    existingFee?: any,
    rejectionKey: string,
    date: string
  }[]>([]);
  const [rejectedAutoFeeActions, setRejectedAutoFeeActions] = useState<Set<string>>(new Set());
  const [isProcessingApproveAll, setIsProcessingApproveAll] = useState(false);
  const [isProcessingRejectAll, setIsProcessingRejectAll] = useState(false);
  const [autoFeeModalRequested, setAutoFeeModalRequested] = useState(false);
  const autoFeeModalDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFeeModalInteractionRef = useRef<InteractionTask | null>(null);
  const autoFeeModalAnimationFrameRef = useRef<AnimationFrameTask | null>(null);

  const clearAutoFeeModalDelay = useCallback(() => {
    if (autoFeeModalDelayRef.current) {
      clearTimeout(autoFeeModalDelayRef.current);
      autoFeeModalDelayRef.current = null;
    }
    if (autoFeeModalInteractionRef.current) {
      autoFeeModalInteractionRef.current.cancel?.();
      autoFeeModalInteractionRef.current = null;
    }
    if (autoFeeModalAnimationFrameRef.current !== null) {
      cancelAnimationFrame(autoFeeModalAnimationFrameRef.current);
      autoFeeModalAnimationFrameRef.current = null;
    }
  }, []);

  const openAutoFeeApprovalModal = useCallback(() => {
    clearAutoFeeModalDelay();

    if (Platform.OS === 'web') {
      setShowAutoFeeApprovalModal(true);
      return;
    }

    autoFeeModalInteractionRef.current = InteractionManager.runAfterInteractions(() => {
      autoFeeModalAnimationFrameRef.current = requestAnimationFrame(() => {
        setShowAutoFeeApprovalModal(true);
        autoFeeModalAnimationFrameRef.current = null;
      });
      autoFeeModalInteractionRef.current = null;
    });
  }, [clearAutoFeeModalDelay]);

  // Storage keys for persistence
  const PENDING_APPROVALS_KEY = 'pendingAutoFeeActions';
  const REJECTED_APPROVALS_KEY = 'rejectedAutoFeeActions';
  const REMINDER_PREFS_KEY = 'paymentReminderPrefs';

  type ReminderPrefs = {
    reminderChannel: 'whatsapp' | 'sms';
    selectedLanguage: 'english' | 'hindi' | 'both';
    languageOrder: 'english-first' | 'hindi-first';
  };

  const isValidReminderPrefs = (prefs: any): prefs is ReminderPrefs => {
    return (
      prefs &&
      (prefs.reminderChannel === 'whatsapp' || prefs.reminderChannel === 'sms') &&
      (prefs.selectedLanguage === 'english' || prefs.selectedLanguage === 'hindi' || prefs.selectedLanguage === 'both') &&
      (prefs.languageOrder === 'english-first' || prefs.languageOrder === 'hindi-first')
    );
  };

  const defaultReminderPrefs: ReminderPrefs = {
    reminderChannel: 'whatsapp',
    selectedLanguage: 'english',
    languageOrder: 'english-first',
  };

  const [reminderPrefs, setReminderPrefs] = useState<ReminderPrefs>(defaultReminderPrefs);

  const loadReminderPrefs = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(REMINDER_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isValidReminderPrefs(parsed)) {
          setReminderPrefs(parsed);
        }
      }
    } catch (e) {
      logger.warn('Failed to load reminder prefs', e);
    }
  }, []);

  const saveReminderPrefs = useCallback(async (prefs: ReminderPrefs) => {
    try {
      await AsyncStorage.setItem(REMINDER_PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      logger.warn('Failed to save reminder prefs', e);
    }
  }, []);

  useEffect(() => {
    loadReminderPrefs();
  }, [loadReminderPrefs]);

  // Storage utility functions
  const loadPendingApprovals = async () => {
    try {
      const storedPending = await AsyncStorage.getItem(PENDING_APPROVALS_KEY);
      const storedRejected = await AsyncStorage.getItem(REJECTED_APPROVALS_KEY);
      
      if (storedPending) {
        const parsedPending = JSON.parse(storedPending);
        
        // Deduplicate stored pending actions
        const deduplicatedPending = parsedPending.filter((action: any, index: number) => {
          return parsedPending.findIndex((a: any) => 
            a.student?.id === action.student?.id && 
            a.currentMonth === action.currentMonth &&
            a.type === action.type
          ) === index;
        });
        
        logger.debug(`Loaded ${parsedPending.length} pending actions, deduplicated to ${deduplicatedPending.length}`);
        setPendingAutoFeeActions(deduplicatedPending);
        
        // Save back the deduplicated version
        if (deduplicatedPending.length !== parsedPending.length) {
          await savePendingApprovals(deduplicatedPending);
        }
      }
      
      if (storedRejected) {
        setRejectedAutoFeeActions(new Set(JSON.parse(storedRejected)));
      }
    } catch (error) {
      logger.error('Error loading pending approvals:', error);
    }
  };

  const savePendingApprovals = useCallback(async (actions: any[]) => {
    try {
      await AsyncStorage.setItem(PENDING_APPROVALS_KEY, JSON.stringify(actions));
    } catch (error) {
      logger.error('Error saving pending approvals:', error);
    }
  }, []);

  const saveRejectedApprovals = useCallback(async (rejectedSet: Set<string>) => {
    try {
      await AsyncStorage.setItem(REJECTED_APPROVALS_KEY, JSON.stringify(Array.from(rejectedSet)));
    } catch (error) {
      logger.error('Error saving rejected approvals:', error);
    }
  }, []);

  // Load stored data on component mount
  useEffect(() => {
    loadPendingApprovals();
  }, []);

  // Keep pending auto-fee actions in sync with the latest student data (name, fee, due date)
  useEffect(() => {
    if (studentsLoading || !pendingAutoFeeActions.length) {
      return;
    }

    let changed = false;
    const updatedActions: typeof pendingAutoFeeActions = [];

    pendingAutoFeeActions.forEach(action => {
      const studentId = action.student?.id;
      if (!studentId) {
        changed = true;
        logger.warn('Removing automatic fee action without a student reference', {
          actionId: action.id,
        });
        return;
      }

      const latestStudent = studentMap[studentId];
      if (!latestStudent) {
        changed = true;
        logger.info('Dropping automatic fee action because student record no longer exists', {
          actionId: action.id,
          studentId,
        });
        return;
      }

      if (isMonthCovered(studentId, action.currentMonth)) {
        changed = true;
        logger.debug('Dropping automatic fee action because target month is already covered', {
          actionId: action.id,
          studentId,
          month: action.currentMonth,
        });
        return;
      }

      const resolvedMonthlyFee = typeof latestStudent.monthlyFee === 'number'
        ? latestStudent.monthlyFee
        : typeof latestStudent.totalFees === 'number'
          ? latestStudent.totalFees
          : action.monthlyFee;

      const hasNameChanged = action.student?.name !== latestStudent.name;
      const hasDueDateChanged = action.student?.feeDueDate !== latestStudent.feeDueDate;
      const hasMonthlyFeeChanged = typeof resolvedMonthlyFee === 'number' && resolvedMonthlyFee !== action.monthlyFee;

      if (!hasNameChanged && !hasDueDateChanged && !hasMonthlyFeeChanged) {
        updatedActions.push(action);
        return;
      }

      changed = true;
      updatedActions.push({
        ...action,
        student: {
          ...action.student,
          ...latestStudent,
        },
        monthlyFee: typeof resolvedMonthlyFee === 'number' ? resolvedMonthlyFee : action.monthlyFee,
      });
    });

    if (changed) {
      setPendingAutoFeeActions(updatedActions);
      (async () => {
        try {
          await savePendingApprovals(updatedActions);
        } catch (err) {
          logger.error('Failed to persist refreshed pending auto fee actions:', err);
        }
      })();
    }
  }, [studentMap, pendingAutoFeeActions, savePendingApprovals, studentsLoading, isMonthCovered]);

  const visiblePendingAutoFeeActions = useMemo(() => {
    if (!pendingAutoFeeActions.length) {
      return pendingAutoFeeActions;
    }

    if (studentsLoading) {
      return pendingAutoFeeActions;
    }

    return pendingAutoFeeActions.filter(action => {
      const studentId = action.student?.id;
      if (!studentId) {
        return false;
      }
      if (!studentMap[studentId]) {
        return false;
      }
      if (isMonthCovered(studentId, action.currentMonth)) {
        return false;
      }
      return true;
    });
  }, [pendingAutoFeeActions, studentMap, studentsLoading, isMonthCovered]);

  const hasVisiblePendingAutoFees = visiblePendingAutoFeeActions.length > 0;
  const disableBulkActions = !hasVisiblePendingAutoFees || isProcessingApproveAll || isProcessingRejectAll;
  const disableApproveAll = disableBulkActions;
  const disableRejectAll = disableBulkActions;

  // Custom toast function that shows above modals
  const showCustomToastMessage = (type: 'info' | 'success' | 'error', title: string, message: string, duration: number = 3000) => {
    setCustomToastData({ type, title, message, duration });
    setShowCustomToast(true);
    
    // Auto-hide after duration
    setTimeout(() => {
      setShowCustomToast(false);
      setCustomToastData(null);
    }, duration);
  };

  // Download receipt file (image/pdf) using Linking or FileSystem
  const handleDownloadReceipt = async (receiptUrl: string, fileName: string) => {
    // Show toast notification for download start
    showCustomToastMessage('info', 'Starting download, please wait...', `Downloading ${fileName}`, 2000);

    try {
      if (Platform.OS === 'web') {
        // Fetch the file as blob and create object URL for download
        const response = await fetch(receiptUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        
        // Create an anchor element and trigger download
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName || 'receipt';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up the object URL
        window.URL.revokeObjectURL(url);
        
        // Show success toast for web
        showCustomToastMessage('success', 'Download Complete!', `${fileName} has been downloaded`, 3000);
        return;
      }
      // For Expo/React Native, use FileSystem
      const downloadResumable = FileSystem.createDownloadResumable(
        receiptUrl,
        FileSystem.documentDirectory + fileName
      );
      const downloadResult = await downloadResumable.downloadAsync();
      if (downloadResult && downloadResult.uri) {
        await Linking.openURL(downloadResult.uri);
        
        // Show success toast for mobile
        showCustomToastMessage('success', 'Download Complete!', `${fileName} has been downloaded`, 3000);
      } else {
        throw new Error('Download failed');
      }
    } catch (error) {
      logger.error('Error downloading receipt:', error);
      Alert.alert('Error', 'Failed to download receipt.');
    }
  };
  
  // Payment form state
  const [paymentForm, setPaymentForm] = useState({
    method: '',
    amount: '',
    date: '',
    paidBy: '',
    accountDetails: '',
    transactionId: '',
    notes: '',
    isPartial: false,
    paymentType: 'full', // 'full' or 'individual'
    selectedMonths: [] as string[], // For individual month payments
  monthlyAmount: '',
  // New: optional reminder controls in Mark as Paid modal
  sendReminder: false,
  reminderChannel: 'whatsapp' as 'whatsapp' | 'sms',
  // Language selection for confirmations
  selectedLanguage: 'english' as 'english' | 'hindi' | 'both',
  languageOrder: 'english-first' as 'english-first' | 'hindi-first',
  });

  const paymentMethodOptions = useMemo(
    () => [
      { label: 'Cash', value: 'cash' },
      { label: 'Bank Transfer', value: 'bank_transfer' },
      { label: 'UPI', value: 'upi' },
      { label: 'Credit Card', value: 'credit_card' },
      { label: 'Debit Card', value: 'debit_card' },
      { label: 'Cheque', value: 'cheque' },
    ],
    [],
  );

  const reminderChannelOptions = useMemo(
    () => [
      { label: 'WhatsApp', value: 'whatsapp' as const },
      { label: 'SMS', value: 'sms' as const },
    ],
    [],
  );

  const paymentLanguageOptions = useMemo(
    () => [
      { label: 'English', value: 'english' as const },
      { label: 'Hindi', value: 'hindi' as const },
      { label: 'Both', value: 'both' as const },
    ],
    [],
  );

  const languageOrderOptions = useMemo(
    () => [
      { label: 'English first', value: 'english-first' as const },
      { label: 'Hindi first', value: 'hindi-first' as const },
    ],
    [],
  );

  const paymentMethodLabel = useMemo(() => {
    return paymentMethodOptions.find(option => option.value === paymentForm.method)?.label ?? '';
  }, [paymentForm.method, paymentMethodOptions]);

  const reminderChannelLabel = useMemo(() => {
    return reminderChannelOptions.find(option => option.value === paymentForm.reminderChannel)?.label ?? '';
  }, [paymentForm.reminderChannel, reminderChannelOptions]);

  const paymentLanguageLabel = useMemo(() => {
    return paymentLanguageOptions.find(option => option.value === paymentForm.selectedLanguage)?.label ?? '';
  }, [paymentForm.selectedLanguage, paymentLanguageOptions]);

  const languageOrderLabel = useMemo(() => {
    return languageOrderOptions.find(option => option.value === paymentForm.languageOrder)?.label ?? '';
  }, [paymentForm.languageOrder, languageOrderOptions]);

  // Payment message preview (WhatsApp or SMS) honoring language and order
  const paymentMessagePreview = useMemo(() => {
    try {
      if (!paymentForm.sendReminder || !selectedFee) return '';
      const student = selectedFee?.studentId ? students.find(s => s.id === selectedFee.studentId) : undefined;
      const studentName = selectedFee?.studentName || 'Student';
      const parentEn = (student?.parentName?.trim()) || 'Parent';
      const parentHi = (student?.parentName?.trim()) || 'अभिभावक';
      const amtNum = parseFloat(paymentForm.amount || '0');
      const amt = `₹${(isNaN(amtNum) ? 0 : amtNum).toLocaleString()}`;
      const dateStr = paymentForm.date || formatDateToString(new Date());
  const noteEn = paymentForm.notes?.trim() || 'No additional note';
  const noteHi = paymentForm.notes?.trim() || 'कोई अतिरिक्त नोट नहीं';
  const smsNote = paymentForm.notes?.trim() || '';
      const teacher = resolvedTeacherName || '-';
      const coaching = resolvedCoachingName;

      // Build blocks matching template line breaks exactly
  const enLinesWhatsApp = [
        `Payment received – Dear ${parentEn}, we have received payment of ${amt} for ${studentName} on ${dateStr}.`,
        `Additional note: ${noteEn}.`,
        `Thank you for your payment!`,
        `Regards,`,
        `${teacher}`,
        `${coaching}`,
        `Have a nice day!`,
      ];
      const hiLinesWhatsApp = [
        `भुगतान प्राप्त – प्रिय ${parentHi}, हमें ${studentName} के लिए ${dateStr} को ${amt} का भुगतान प्राप्त हुआ है।`,
        `अतिरिक्त नोट: ${noteHi}।`,
        `आपके भुगतान के लिए धन्यवाद!`,
        `सादर,`,
        `${teacher}`,
        `${coaching}`,
        `आपका दिन शुभ हो!`,
      ];

  // SMS format: no prefix; include note conditionally (only once in bilingual)
  const enLinesSMS = [
        `Dear ${parentEn}, we have received payment of ${amt} for ${studentName} on ${dateStr}.`,
        ...(smsNote ? [`Additional note: ${smsNote}.`] : []),
        `Thank you for your payment!`,
        `Regards,`,
        `${teacher}`,
        `${coaching}`,
        `Have a nice day!`,
      ];
      const hiLinesSMS = [
        `प्रिय ${parentHi}, हमें ${studentName} के लिए ${dateStr} को ${amt} का भुगतान प्राप्त हुआ है।`,
        ...(smsNote ? [`अतिरिक्त नोट: ${smsNote}।`] : []),
        `आपके भुगतान के लिए धन्यवाद!`,
        `सादर,`,
        `${teacher}`,
        `${coaching}`,
        `आपका दिन शुभ हो!`,
      ];

      // Build final preview with single note in bilingual
      const channelIsWA = paymentForm.reminderChannel === 'whatsapp';
      const enArr = channelIsWA ? enLinesWhatsApp : enLinesSMS;
      const hiArr = channelIsWA ? hiLinesWhatsApp : hiLinesSMS;
      const stripNote = (lines: string[]) => lines.filter(l => !l.startsWith('Additional note:') && !l.startsWith('अतिरिक्त नोट'));
      if (paymentForm.selectedLanguage === 'hindi') return hiArr.join('\n');
      if (paymentForm.selectedLanguage === 'both') {
        const englishFirst = paymentForm.languageOrder === 'english-first';
        // Combined bilingual Additional note line between blocks
        const combinedNote = paymentForm.notes?.trim() || (channelIsWA ? 'No additional note' : '');
        const first = englishFirst ? stripNote(enArr) : stripNote(hiArr);
        const second = englishFirst ? stripNote(hiArr) : stripNote(enArr);
        const middle = combinedNote ? `\n\nAdditional note/अतिरिक्त नोट: ${combinedNote}.\n\n` : '\n\n';
        return `${first.join('\n')}${middle}${second.join('\n')}`;
      }
      return enArr.join('\n');
    } catch {
      return '';
    }
  }, [paymentForm.sendReminder, paymentForm.reminderChannel, paymentForm.selectedLanguage, paymentForm.languageOrder, paymentForm.amount, paymentForm.date, paymentForm.notes, selectedFee, students, resolvedTeacherName, resolvedCoachingName]);

  // Fee edit form state
  const [feeEditForm, setFeeEditForm] = useState({
    studentName: '',
    amount: '',
    dueDate: '',
    monthlyFee: '',
    type: 'tuition',
    description: '',
    status: 'pending',
    paidAmount: '',
    paidDate: '',
    method: ''
  });

  // Enable Update button only when something actually changed
  const isFeeDirty = useMemo(() => {
    if (!selectedFee) return false;
    const originalMonthly = selectedFee.monthlyFeeAmount || (
      selectedFee.monthsCovered && selectedFee.monthsCovered.length > 1
        ? Math.round((Number(selectedFee.amount) || 0) / selectedFee.monthsCovered.length)
        : Number(selectedFee.amount) || 0
    );

    const descChanged = (feeEditForm.description || '').trim() !== (selectedFee.description || '').trim();
    const dueChanged = (feeEditForm.dueDate || '') !== (selectedFee.dueDate || '');
    const monthlyChanged = (parseFloat(feeEditForm.monthlyFee || '0') || 0) !== (Number(originalMonthly) || 0);

    return descChanged || dueChanged || monthlyChanged;
  }, [selectedFee, feeEditForm.description, feeEditForm.dueDate, feeEditForm.monthlyFee]);

  const getCurrentMonth = useCallback(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // getMonth() is 0-based
    return `${year}-${month.toString().padStart(2, '0')}`;
  }, []);

  // Add fee form state
  const [addFeeForm, setAddFeeForm] = useState({
    studentId: '',
    studentName: '',
    amount: '',
    dueMonth: getCurrentMonth(), // Use helper function for consistency
    type: 'tuition',
    description: '',
    isPastDue: false
  });

  // Individual month fees state - tracks fee amount for each month in a consolidated fee
  const [monthFeeAmounts, setMonthFeeAmounts] = useState<{ [month: string]: string }>({});
  const [showIndividualMonthEditor, setShowIndividualMonthEditor] = useState(false);
  const [showStudentSelectModal, setShowStudentSelectModal] = useState(false);
  const [studentSearchQuery, setStudentSearchQuery] = useState('');
  const filteredStudents = useMemo(() => {
    const normalizedQuery = studentSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return students;
    }

    const strippedQuery = normalizedQuery.replace(/\s+/g, '');
    return students.filter(student => {
      const name = (student.name || '').toLowerCase();
      const email = (student.email || '').toLowerCase();
      const grade = (student.grade || '').toLowerCase();
      const phone = (student.phone || '').replace(/\s+/g, '');
      const parentName = (student.parentName || '').toLowerCase();

      return (
        name.includes(normalizedQuery) ||
        email.includes(normalizedQuery) ||
        grade.includes(normalizedQuery) ||
        phone.includes(strippedQuery) ||
        parentName.includes(normalizedQuery)
      );
    });
  }, [studentSearchQuery, students]);

  useEffect(() => {
    if (!showStudentSelectModal) {
      setStudentSearchQuery('');
    }
  }, [showStudentSelectModal]);

  // Add fee modal states
  const [canEditAmount, setCanEditAmount] = useState(false);
  const [showOverwriteWarning, setShowOverwriteWarning] = useState(false);
  const [existingFee, setExistingFee] = useState<any>(null);
  
  // Confirmation modal states
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);

  // Defer offline early return until after all hooks are declared
  const [confirmationData, setConfirmationData] = useState<{
    title: string;
    message: string;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void | Promise<void>;
    confirmButtonText?: string;
    cancelButtonText?: string | null;
    confirmButtonColor?: string;
  } | null>(null);

  // Date picker states
  const [datePickerMode, setDatePickerMode] = useState<'date' | 'time'>('date');

  // Form validation states
  const [formErrors, setFormErrors] = useState<{
    amount?: string;
    date?: string;
    method?: string;
    paidBy?: string;
    selectedMonths?: string;
  }>({});

  // Payment details expansion states
  const [expandedPayments, setExpandedPayments] = useState<{ [key: string]: boolean }>({});

  // Track other modals to know when the UI is idle
  const blockingModalOpen = useMemo(() => {
    return (
      showPaymentModal ||
      showPaymentMethodModal ||
      showReminderChannelModal ||
      showPaymentLanguageModal ||
      showLanguageOrderModal ||
      showFeeDetailsModal ||
      showAddFeeModal ||
      showDueMonthModal ||
      showStudentSelectModal ||
      showDeleteModal ||
      showInfoModal ||
      showCalendarModal ||
      showReceiptModal ||
      showReceiptUpload ||
      showDeleteReceiptModal ||
      showDeletePaymentModal ||
      showDownloadConfirmModal ||
      showConfirmationModal ||
      isBirthdayOverlayActive ||
      isPosterOpen
    );
  }, [
    showPaymentModal,
    showPaymentMethodModal,
    showReminderChannelModal,
    showPaymentLanguageModal,
    showLanguageOrderModal,
    showFeeDetailsModal,
    showAddFeeModal,
    showDueMonthModal,
    showStudentSelectModal,
    showDeleteModal,
    showInfoModal,
    showCalendarModal,
    showReceiptModal,
    showReceiptUpload,
    showDeleteReceiptModal,
    showDeletePaymentModal,
    showDownloadConfirmModal,
    showConfirmationModal,
    isBirthdayOverlayActive,
    isPosterOpen,
  ]);

  const autoFeeModalIdle = useMemo(() => {
    return (
      !loading &&
      !componentLoading &&
      !studentsLoading &&
      !blockingModalOpen &&
      !showPaymentHistory &&
      isFocused
    );
  }, [
    loading,
    componentLoading,
    studentsLoading,
    blockingModalOpen,
    showPaymentHistory,
    isFocused,
  ]);

  useEffect(() => {
    if (!autoFeeModalRequested) {
      clearAutoFeeModalDelay();
      return;
    }

    if (!hasVisiblePendingAutoFees) {
      clearAutoFeeModalDelay();
      setAutoFeeModalRequested(false);
      return;
    }

    if (!autoFeeModalIdle || showAutoFeeApprovalModal) {
      clearAutoFeeModalDelay();
      return;
    }

    if (!autoFeeModalDelayRef.current) {
      autoFeeModalDelayRef.current = setTimeout(() => {
        autoFeeModalDelayRef.current = null;
        if (!showAutoFeeApprovalModal && hasVisiblePendingAutoFees) {
          logger.debug('Auto fee approval modal shown after idle grace period');
            openAutoFeeApprovalModal();
        }
      }, AUTO_FEE_MODAL_IDLE_DELAY);
    }

    return () => {
      clearAutoFeeModalDelay();
    };
  }, [
    autoFeeModalRequested,
    autoFeeModalIdle,
    showAutoFeeApprovalModal,
    hasVisiblePendingAutoFees,
    clearAutoFeeModalDelay,
    openAutoFeeApprovalModal,
  ]);

  useEffect(() => {
    if (showAutoFeeApprovalModal && autoFeeModalRequested) {
      clearAutoFeeModalDelay();
      setAutoFeeModalRequested(false);
    }
  }, [showAutoFeeApprovalModal, autoFeeModalRequested, clearAutoFeeModalDelay]);

  useEffect(() => {
    return () => {
      clearAutoFeeModalDelay();
    };
  }, [clearAutoFeeModalDelay]);

  // Helper function to get all payment transactions
  const getPaymentTransactions = (fee: any) => {
    const transactions: any[] = [];
    
    if (!fee) return transactions;

    // Handle multiple payments stored in paymentDetails
    if (fee.paymentDetails && typeof fee.paymentDetails === 'object') {
      let hasStructuredPayments = false;
      
      // First, collect all structured payments
      Object.entries(fee.paymentDetails).forEach(([key, payment]: [string, any]) => {
        if (key.startsWith('payment_') && payment && typeof payment === 'object') {
          transactions.push({
            id: key,
            ...payment,
            isMultiplePayment: true
          });
          hasStructuredPayments = true;
        }
      });

      // If there are structured payments, we should not create a legacy payment
      // because the individual amounts are tracked in each structured payment
      if (!hasStructuredPayments) {
        // Only create legacy payment if no structured payments exist AND there's meaningful payment data
        const legacyPayment = fee.paymentDetails;
        if (legacyPayment.paidBy || legacyPayment.accountDetails || legacyPayment.transactionId || legacyPayment.notes || legacyPayment.paymentDate) {
          // Only add if there's actually a meaningful amount
          if (fee.paidAmount && fee.paidAmount > 0) {
            transactions.push({
              id: 'legacy_payment',
              paidBy: legacyPayment.paidBy || 'Unknown',
              accountDetails: legacyPayment.accountDetails,
              transactionId: legacyPayment.transactionId,
              notes: legacyPayment.notes,
              paymentDate: legacyPayment.paymentDate || fee.paidDate,
              amount: fee.paidAmount,
              method: legacyPayment.method || fee.method,
              type: 'general_payment', // Treat legacy payments as general payments
              isMultiplePayment: false
            });
          }
        }
      }
    }

    // If no payment details at all but has basic payment info, create a basic transaction
    // Only if there's actually a meaningful payment amount
    if (transactions.length === 0 && fee.paidAmount > 0 && (fee.paidDate || fee.method)) {
      transactions.push({
        id: 'legacy_payment',
        paidBy: 'Unknown',
        paymentDate: fee.paidDate,
        amount: fee.paidAmount,
        method: fee.method,
        type: 'general_payment', // Treat legacy payments as general payments
        isMultiplePayment: false
      });
    }

    const resolvePaymentDateMs = (value: any) => {
      if (!value) return Number.NEGATIVE_INFINITY;
      try {
        const date: Date = (value && typeof value === 'object' && value.toDate)
          ? value.toDate()
          : new Date(value);
        const ts = date?.getTime?.();
        return typeof ts === 'number' && !Number.isNaN(ts) ? ts : Number.NEGATIVE_INFINITY;
      } catch {
        return Number.NEGATIVE_INFINITY;
      }
    };

    // Sort transactions by date (newest first)
    return transactions.sort((a, b) => resolvePaymentDateMs(b.paymentDate) - resolvePaymentDateMs(a.paymentDate));
  };

  // Helper function to toggle payment expansion
  const togglePaymentExpansion = (paymentId: string) => {
    setExpandedPayments(prev => ({
      ...prev,
      [paymentId]: !prev[paymentId]
    }));
  };

  // Helper function to prepare payment details for storage
  const preparePaymentDetails = (existingPaymentDetails: any, newPayment: any): { details: any; paymentKey: string } => {
    // If existingPaymentDetails has legacy format (direct properties), preserve only structured payments
    const existingStructuredPayments: any = {};
    
    if (existingPaymentDetails && typeof existingPaymentDetails === 'object') {
      // Extract only the structured payments (payment_* keys)
      Object.entries(existingPaymentDetails).forEach(([key, value]) => {
        if (key.startsWith('payment_') && value && typeof value === 'object') {
          existingStructuredPayments[key] = value;
        }
      });
    }

    // Add the new payment
    const paymentKey = `payment_${Date.now()}`;
    existingStructuredPayments[paymentKey] = newPayment;

    return { details: existingStructuredPayments, paymentKey };
  };

  // Helper function to calculate remaining amount for a specific month
  const getRemainingAmountForMonth = (fee: any, month: string) => {
    if (!fee?.monthsCovered || fee.monthsCovered.length === 0) {
      return 0;
    }

    const normalizeOrFallback = (value: string) => normalizeMonthString(value) || value;
    const monthEntries = fee.monthsCovered.map((coveredMonth: string) => ({
      original: coveredMonth,
      normalized: normalizeOrFallback(coveredMonth),
    }));
    const sortedEntries = [...monthEntries].sort((a, b) => a.normalized.localeCompare(b.normalized));
    const targetMonth = normalizeOrFallback(month);
    const targetEntry = sortedEntries.find(entry => entry.normalized === targetMonth);

    const resolveMonthlyFeeAmount = (entry: { original: string; normalized: string }) => {
      if (fee.monthFeeAmounts) {
        if (fee.monthFeeAmounts[entry.original] !== undefined) {
          return fee.monthFeeAmounts[entry.original];
        }
        if (fee.monthFeeAmounts[entry.normalized] !== undefined) {
          return fee.monthFeeAmounts[entry.normalized];
        }
      }

      if (typeof fee.monthlyFeeAmount === 'number' && !Number.isNaN(fee.monthlyFeeAmount)) {
        return fee.monthlyFeeAmount;
      }

      const monthCount = Array.isArray(fee.monthsCovered) && fee.monthsCovered.length > 0
        ? fee.monthsCovered.length
        : 1;
      return monthCount > 0 ? (fee.amount || 0) / monthCount : 0;
    };

    const monthlyFeeAmount = targetEntry ? resolveMonthlyFeeAmount(targetEntry) : 0;

    const transactions = getPaymentTransactions(fee);
    const explicitPaymentsByMonth = new Map<string, number>();

    transactions.forEach(transaction => {
      if (!transaction?.amount || !Array.isArray(transaction.monthsPaid) || transaction.monthsPaid.length === 0) {
        return;
      }
      const amountPerMonth = transaction.amount / transaction.monthsPaid.length;
      transaction.monthsPaid.forEach((coveredMonth: string) => {
        const normalizedMonth = normalizeOrFallback(coveredMonth);
        const existing = explicitPaymentsByMonth.get(normalizedMonth) || 0;
        explicitPaymentsByMonth.set(normalizedMonth, existing + amountPerMonth);
      });
    });

    const generalPayments = transactions.filter(t => !t.monthsPaid || t.monthsPaid.length === 0);
    const totalGeneralPayments = generalPayments.reduce((sum, t) => sum + (t.amount || 0), 0);
    const specificPaymentsForMonth = explicitPaymentsByMonth.get(targetMonth) || 0;

    const monthIndex = sortedEntries.findIndex(entry => entry.normalized === targetMonth);
    if (monthIndex === -1) {
      return Math.max(0, monthlyFeeAmount - specificPaymentsForMonth);
    }

    let remainingGeneralPayment = totalGeneralPayments;
    let allocatedToThisMonth = 0;

    for (let i = 0; i <= monthIndex && remainingGeneralPayment > 0; i++) {
      const entry = sortedEntries[i];
      const currentMonthFeeAmount = resolveMonthlyFeeAmount(entry);
      const specificPaidForCurrentMonth = explicitPaymentsByMonth.get(entry.normalized) || 0;
      const remainingForCurrentMonth = Math.max(0, currentMonthFeeAmount - specificPaidForCurrentMonth);

      if (remainingForCurrentMonth <= 0) {
        continue;
      }

      if (i === monthIndex) {
        allocatedToThisMonth = Math.min(remainingGeneralPayment, remainingForCurrentMonth);
      } else {
        const applied = Math.min(remainingGeneralPayment, remainingForCurrentMonth);
        remainingGeneralPayment -= applied;
      }
    }

    const totalPaidForThisMonth = allocatedToThisMonth + specificPaymentsForMonth;
    return Math.max(0, monthlyFeeAmount - totalPaidForThisMonth);
  };

  // Helper function to check month payment status
  const getMonthPaymentStatus = (fee: any, month: string) => {
    // Get the fee amount for this specific month - use individual amounts if available
    let monthlyFeeAmount;
    if (fee.monthFeeAmounts && fee.monthFeeAmounts[month]) {
      monthlyFeeAmount = fee.monthFeeAmounts[month];
    } else {
      // Fallback to old logic for backward compatibility
      monthlyFeeAmount = fee.monthlyFeeAmount || (fee.amount / fee.monthsCovered.length);
    }
    
    const remainingAmount = getRemainingAmountForMonth(fee, month);
    
    if (remainingAmount === 0) {
      return 'paid';
    } else if (remainingAmount < monthlyFeeAmount) {
      return 'partial';
    } else {
      return 'unpaid';
    }
  };

  // Helper function to get months covered by a general payment
  // Helper function to get all actually paid months (including auto-distributed)
  const getAllPaidMonths = (fee: any): { month: string; status: 'full' | 'partial' }[] => {
    if (!fee.monthsCovered || fee.monthsCovered.length <= 1) {
      return (fee.paidMonths || []).map((month: string) => ({ month, status: 'full' as const }));
    }

    const paidMonthsMap = new Map<string, 'full' | 'partial'>();
    
    // Add explicitly paid months (always full payment)
    if (fee.paidMonths) {
      fee.paidMonths.forEach((month: string) => paidMonthsMap.set(month, 'full'));
    }
    
    // Add months covered by general payments
    const transactions = getPaymentTransactions(fee);
    const generalPayments = transactions.filter(t => !t.monthsPaid || t.monthsPaid.length === 0);
    
    generalPayments.forEach(payment => {
      if (payment.amount && payment.paymentDate) {
  const coveredMonths = getMonthsCoveredByGeneralPayment(fee, payment.amount, payment.paymentDate, payment.id);
        coveredMonths.forEach(({ month, status }) => {
          // Only update if we don't already have a 'full' status for this month
          const currentStatus = paidMonthsMap.get(month);
          if (!currentStatus || (currentStatus === 'partial' && status === 'full')) {
            paidMonthsMap.set(month, status);
          }
        });
      }
    });
    
    // Convert map to array and sort
    return Array.from(paidMonthsMap.entries())
      .map(([month, status]) => ({ month, status }))
      .sort((a, b) => a.month.localeCompare(b.month));
  };

  // Helper function to get count of actually paid months
  const getActuallyPaidMonthsCount = (fee: any): number => {
    return getAllPaidMonths(fee).filter(({ status }) => status === 'full').length;
  };

  // Helper function to get payment statistics
  const getPaymentStatistics = (fee: any) => {
    const allPaidMonths = getAllPaidMonths(fee);
    const fullyPaidCount = allPaidMonths.filter(({ status }) => status === 'full').length;
    const partiallyPaidCount = allPaidMonths.filter(({ status }) => status === 'partial').length;
    const totalMonths = fee.monthsCovered ? fee.monthsCovered.length : 0;
    const remainingMonths = totalMonths - fullyPaidCount - partiallyPaidCount;
    
    return {
      fullyPaidCount,
      partiallyPaidCount,
      totalMonths,
      remainingMonths,
      allPaidMonths
    };
  };

  const getMonthsCoveredByGeneralPayment = (
    fee: any,
    paymentAmount: number,
    paymentDate: string,
    paymentId?: string
  ) => {
    if (!fee?.monthsCovered || fee.monthsCovered.length === 0) {
      return [] as { month: string; label: string; amount: number; status: 'full' | 'partial' }[];
    }

    const normalizeOrFallback = (value: string) => normalizeMonthString(value) || value;
    const resolvePaymentTimestamp = (value: string | undefined) => {
      const timestamp = new Date(value || '').getTime();
      return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
    };
    const resolvePaymentSequence = (id: string | undefined) => {
      if (typeof id !== 'string') {
        return Number.NEGATIVE_INFINITY;
      }
      const match = /payment_(\d+)/.exec(id);
      return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
    };

    const currentPaymentTimestamp = resolvePaymentTimestamp(paymentDate);
    const currentPaymentSequence = resolvePaymentSequence(paymentId);

    const monthEntries = fee.monthsCovered.map((coveredMonth: string) => ({
      original: coveredMonth,
      normalized: normalizeOrFallback(coveredMonth),
    }));
    const sortedEntries = [...monthEntries].sort((a, b) => a.normalized.localeCompare(b.normalized));

    const resolveMonthlyFeeAmount = (entry: { original: string; normalized: string }) => {
      if (fee.monthFeeAmounts) {
        if (fee.monthFeeAmounts[entry.original] !== undefined) {
          return fee.monthFeeAmounts[entry.original];
        }
        if (fee.monthFeeAmounts[entry.normalized] !== undefined) {
          return fee.monthFeeAmounts[entry.normalized];
        }
      }

      if (typeof fee.monthlyFeeAmount === 'number' && !Number.isNaN(fee.monthlyFeeAmount)) {
        return fee.monthlyFeeAmount;
      }

      const monthCount = Array.isArray(fee.monthsCovered) && fee.monthsCovered.length > 0
        ? fee.monthsCovered.length
        : 1;
      return monthCount > 0 ? (fee.amount || 0) / monthCount : 0;
    };

    const transactions = getPaymentTransactions(fee);
    const explicitPaymentsBefore = new Map<string, number>();

    const addExplicitPayment = (monthKey: string, amount: number) => {
      if (amount <= 0) {
        return;
      }
      const existing = explicitPaymentsBefore.get(monthKey) || 0;
      explicitPaymentsBefore.set(monthKey, existing + amount);
    };

    const hasValidCurrentTimestamp = currentPaymentTimestamp !== Number.NEGATIVE_INFINITY;

    transactions.forEach(transaction => {
      if (!transaction?.amount || !Array.isArray(transaction.monthsPaid) || transaction.monthsPaid.length === 0) {
        return;
      }

      const transactionTimestamp = resolvePaymentTimestamp(transaction.paymentDate);
      const transactionSequence = resolvePaymentSequence(transaction.id);

      let includePayment = false;
      if (!hasValidCurrentTimestamp) {
        if (currentPaymentSequence === Number.NEGATIVE_INFINITY) {
          includePayment = true;
        } else {
          includePayment = transactionSequence < currentPaymentSequence;
        }
      } else {
        if (transactionTimestamp < currentPaymentTimestamp) {
          includePayment = true;
        } else if (transactionTimestamp === currentPaymentTimestamp) {
          if (currentPaymentSequence === Number.NEGATIVE_INFINITY) {
            includePayment = String(transaction.id || '') < String(paymentId || '');
          } else {
            includePayment = transactionSequence < currentPaymentSequence;
          }
        }
      }

      if (!includePayment) {
        return;
      }

      const amountPerMonth = transaction.amount / transaction.monthsPaid.length;
      transaction.monthsPaid.forEach((coveredMonth: string) => {
        const normalizedMonth = normalizeOrFallback(coveredMonth);
        addExplicitPayment(normalizedMonth, amountPerMonth);
      });
    });

    const remainingDueByMonth = new Map<string, number>();
    sortedEntries.forEach(entry => {
      const monthlyAmount = resolveMonthlyFeeAmount(entry);
      const explicitlyPaid = explicitPaymentsBefore.get(entry.normalized) || 0;
      remainingDueByMonth.set(entry.normalized, Math.max(0, monthlyAmount - explicitlyPaid));
    });

    const generalPayments = transactions.filter(t => !t.monthsPaid || t.monthsPaid.length === 0);
    const priorGeneralPayments = generalPayments
      .filter(payment => {
        if (!payment?.amount) {
          return false;
        }
        if (paymentId && payment.id === paymentId) {
          return false;
        }

        const paymentTimestamp = resolvePaymentTimestamp(payment.paymentDate);
        const paymentSequence = resolvePaymentSequence(payment.id);

        if (paymentTimestamp < currentPaymentTimestamp) {
          return true;
        }

        if (paymentTimestamp === currentPaymentTimestamp) {
          if (currentPaymentSequence === Number.NEGATIVE_INFINITY) {
            return String(payment.id || '') < String(paymentId || '');
          }
          return paymentSequence < currentPaymentSequence;
        }

        return false;
      })
      .sort((a, b) => {
        const timestampDiff = resolvePaymentTimestamp(a.paymentDate) - resolvePaymentTimestamp(b.paymentDate);
        if (timestampDiff !== 0) {
          return timestampDiff;
        }
        const sequenceDiff = resolvePaymentSequence(a.id) - resolvePaymentSequence(b.id);
        if (sequenceDiff !== 0) {
          return sequenceDiff;
        }
        return String(a.id || '').localeCompare(String(b.id || ''));
      });

    const applyGeneralPayment = (amount: number) => {
      let remaining = amount;
      for (const entry of sortedEntries) {
        if (remaining <= 0) {
          break;
        }
        const monthKey = entry.normalized;
        const due = remainingDueByMonth.get(monthKey) || 0;
        if (due <= 0) {
          continue;
        }
        const applied = Math.min(remaining, due);
        remainingDueByMonth.set(monthKey, Math.max(0, due - applied));
        remaining -= applied;
      }
    };

    priorGeneralPayments.forEach(payment => {
      applyGeneralPayment(payment.amount || 0);
    });

    let remainingPayment = paymentAmount;
    const coveredMonths: { month: string; label: string; amount: number; status: 'full' | 'partial' }[] = [];

    for (const entry of sortedEntries) {
      if (remainingPayment <= 0) {
        break;
      }

      const monthKey = entry.normalized;
      const monthLabel = generateMonthOptions.find((m: { value: string; label: string }) => m.value === monthKey)?.label || monthKey;
      const dueBeforePayment = remainingDueByMonth.get(monthKey) || 0;

      if (dueBeforePayment <= 0) {
        continue;
      }

      const applied = Math.min(remainingPayment, dueBeforePayment);
  const status = applied >= dueBeforePayment - 0.01 ? 'full' : 'partial';

      coveredMonths.push({
        month: monthKey,
        label: monthLabel,
        amount: applied,
        status,
      });

      remainingDueByMonth.set(monthKey, Math.max(0, dueBeforePayment - applied));
      remainingPayment -= applied;
    }

    return coveredMonths;
  };

  // Optimized automatic fee creation with better debouncing and conditions
  useEffect(() => {
    // Skip if data is not ready or component is still loading
    if (loading || componentLoading || students.length === 0) {
      return;
    }

    // More aggressive cooldown to prevent excessive calls
    const timeoutId = setTimeout(() => {
      const checkAndCreateAutomaticFees = async () => {
        // Prevent rapid successive checks with longer cooldown
        const now = Date.now();
        if (now - lastAutoCheckRef.current < AUTO_CHECK_COOLDOWN * 2) { // Double the cooldown
          logger.debug('Auto fee check skipped - too soon since last check');
          return;
        }
        lastAutoCheckRef.current = now;

        const today = new Date();
        const currentMonth = getCurrentMonth();
        const currentMonthIndex = monthStringToIndex(currentMonth);

        if (currentMonthIndex === null) {
          logger.warn('Auto fee check: Unable to determine current month index', { currentMonth });
          return;
        }

        const backlogLowerBoundIndex = Math.max(0, currentMonthIndex - (MAX_AUTO_FEE_BACKLOG_MONTHS - 1));

        const actionsToApprove: {
          id: string,
          type: 'create' | 'update',
          student: any,
          currentMonth: string,
          monthlyFee: number,
          existingFee?: any,
          rejectionKey: string,
          date: string
        }[] = [];

        for (const student of students) {
          const dueDay = student.feeDueDate || 1;
          const studentFees = fees.filter((fee: any) => fee.studentId === student.id);

          const coveredMonths = new Set<string>();
          for (const fee of studentFees) {
            if (Array.isArray(fee.monthsCovered) && fee.monthsCovered.length > 0) {
              fee.monthsCovered.forEach((month: string) => {
                const normalized = normalizeMonthString(month);
                if (normalized) {
                  coveredMonths.add(normalized);
                }
              });
            } else if (typeof fee.dueDate === 'string') {
              const normalized = normalizeMonthString(fee.dueDate.substring(0, 7));
              if (normalized) {
                coveredMonths.add(normalized);
              }
            }
          }

          const coveredIndexes = Array.from(coveredMonths)
            .map(monthStringToIndex)
            .filter((index): index is number => index !== null)
            .sort((a, b) => a - b);

          const lastCoveredIndex = coveredIndexes.length > 0 ? coveredIndexes[coveredIndexes.length - 1] : null;

          let startIndex = lastCoveredIndex !== null ? lastCoveredIndex + 1 : currentMonthIndex;

          if (lastCoveredIndex === null && currentMonthIndex > 0) {
            startIndex = currentMonthIndex - 1;
          }

          if (student.joinDate) {
            const joinMonth = student.joinDate.substring(0, 7);
            const joinIndex = monthStringToIndex(joinMonth);
            if (joinIndex !== null) {
              startIndex = Math.max(startIndex, joinIndex);
            }
          }

          startIndex = Math.max(startIndex, backlogLowerBoundIndex);
          startIndex = Math.min(startIndex, currentMonthIndex);

          if (startIndex > currentMonthIndex) {
            continue;
          }

          const sortedExistingFees = studentFees
            .slice()
            .sort((a: any, b: any) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime());
          const mostRecentFee = sortedExistingFees[0];

          for (let monthIndex = startIndex; monthIndex <= currentMonthIndex; monthIndex++) {
            const targetMonth = indexToMonthString(monthIndex);

            if (coveredMonths.has(targetMonth)) {
              continue;
            }

            if (isMonthCovered(student.id, targetMonth)) {
              continue;
            }

            if (!hasDueDatePassedForMonthIndex(monthIndex, currentMonthIndex, dueDay, today)) {
              continue;
            }

            const [targetYear, targetMonthNumber] = targetMonth.split('-').map(Number);
            const rejectionKey = `auto_fee_${student.id}_${targetMonth}`;
            const legacyRejectionKey = `auto_fee_${student.id}_${targetYear}_${(targetMonthNumber || 1) - 1}`;

            if (rejectedAutoFeeActions.has(rejectionKey) || rejectedAutoFeeActions.has(legacyRejectionKey)) {
              continue;
            }

            const existingPendingAction = pendingAutoFeeActions.find(action =>
              action.student?.id === student.id && action.currentMonth === targetMonth
            );

            if (existingPendingAction) {
              continue;
            }

            const existingFeeForTargetMonth = studentFees.find((fee: any) =>
              typeof fee.dueDate === 'string' && fee.dueDate.startsWith(targetMonth)
            );
            const existingConsolidatedFee = studentFees.find((fee: any) =>
              Array.isArray(fee.monthsCovered) && fee.monthsCovered.includes(targetMonth)
            );

            if (existingFeeForTargetMonth || existingConsolidatedFee) {
              continue;
            }

            const monthlyFee = typeof student.monthlyFee === 'number'
              ? student.monthlyFee
              : typeof student.totalFees === 'number'
                ? student.totalFees
                : 1000;

            if (studentFees.length === 0) {
              actionsToApprove.push({
                id: `create_${student.id}_${targetMonth}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                type: 'create',
                student,
                currentMonth: targetMonth,
                monthlyFee,
                rejectionKey,
                date: new Date().toISOString()
              });
            } else {
              const baseFee = mostRecentFee || studentFees[0];
              actionsToApprove.push({
                id: `update_${student.id}_${targetMonth}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                type: 'update',
                student,
                currentMonth: targetMonth,
                monthlyFee,
                existingFee: baseFee,
                rejectionKey,
                date: new Date().toISOString()
              });
            }
          }
        }

        // Show approval modal if there are actions to approve
        if (actionsToApprove.length > 0) {
          logger.debug(`Auto fee check: Found ${actionsToApprove.length} new actions to approve`);
          
          // Deduplicate pending actions before adding new ones
          const allActions = [...pendingAutoFeeActions, ...actionsToApprove];
          const deduplicatedActions = allActions.filter((action, index, array) => {
            return array.findIndex(a => 
              a.student.id === action.student.id && 
              a.currentMonth === action.currentMonth &&
              a.type === action.type
            ) === index;
          });
          
          logger.debug(`Auto fee check: After deduplication ${deduplicatedActions.length} actions remain`);
          
          // Only update if we have genuinely new actions
          if (deduplicatedActions.length > pendingAutoFeeActions.length) {
            setPendingAutoFeeActions(deduplicatedActions);
            await savePendingApprovals(deduplicatedActions);
            if (!showAutoFeeApprovalModal && !autoFeeModalRequested) {
              logger.debug('Auto fee approval modal request queued until idle');
              setAutoFeeModalRequested(true);
            }
          } else {
            logger.debug('Auto fee check: No new unique actions to add');
          }
        } else {
          logger.debug('Auto fee check: No new actions needed');
        }
      };

      checkAndCreateAutomaticFees();
    }, 2000); // Increased debounce to 2 seconds

    return () => clearTimeout(timeoutId);
  }, [
    students,
    fees,
    loading,
    componentLoading,
    pendingAutoFeeActions.length,
    rejectedAutoFeeActions.size,
    isMonthCovered,
    showAutoFeeApprovalModal,
    autoFeeModalRequested,
  ]); // More specific dependencies

  // Memoized helper function to generate month options (expensive operation)
  const generateMonthOptions = useMemo(() => {
    const months = [];
    const currentDate = new Date();
    
    // Generate 36 months: 24 past + current + 11 future
    for (let i = -24; i <= 11; i++) {
      // Fix timezone issue by using UTC dates consistently
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + i;
      
      // Create date in local timezone, then format properly
      const monthDate = new Date(year, month, 1);
      const monthYear = monthDate.getFullYear();
      const monthNum = monthDate.getMonth() + 1; // getMonth() is 0-based
      
      const monthValue = `${monthYear}-${monthNum.toString().padStart(2, '0')}`;
      const monthLabel = monthDate.toLocaleDateString('en-US', { 
        month: 'long', 
        year: 'numeric' 
      });
      months.push({ value: monthValue, label: monthLabel });
    }
    
    return months;
  }, []); // Empty dependency array since this rarely changes

  const addFeeMonthOptions = useMemo(() => {
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;
    const currentMonthIndex = currentYear * 12 + currentMonth;
    const maxAllowedIndex = currentMonthIndex; // Temporarily disable future month selection

    return generateMonthOptions.filter(({ value }) => {
      const [yearStr, monthStr] = value.split('-');
      const year = Number(yearStr);
      const month = Number(monthStr);

      if (Number.isNaN(year) || Number.isNaN(month)) {
        return true;
      }

      const optionIndex = year * 12 + month;
      return optionIndex <= maxAllowedIndex;
    });
  }, [generateMonthOptions]);

  const dueMonthLabel = useMemo(() => {
    const match = addFeeMonthOptions.find(option => option.value === addFeeForm.dueMonth);
    return match?.label || '';
  }, [addFeeForm.dueMonth, addFeeMonthOptions]);

  const dueMonthPlaceholder = useMemo(() => {
    return addFeeMonthOptions.length === 0 ? 'No months available' : 'Select due month';
  }, [addFeeMonthOptions.length]);

  const dueMonthListRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    if (!showDueMonthModal) {
      return;
    }

    if (addFeeMonthOptions.length === 0) {
      return;
    }

    const fallbackIndex = addFeeMonthOptions.length - 1;
    const selectedIndex = addFeeMonthOptions.findIndex(option => option.value === addFeeForm.dueMonth);
    const effectiveIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;

    if (effectiveIndex < 0) {
      return;
    }

    const estimatedRowHeight = 56;
    const scrollTargetY = Math.max(effectiveIndex * estimatedRowHeight - estimatedRowHeight, 0);

    requestAnimationFrame(() => {
      dueMonthListRef.current?.scrollTo({ y: scrollTargetY, animated: false });
    });
  }, [showDueMonthModal, addFeeForm.dueMonth, addFeeMonthOptions]);

  // Helper function to get current month
  // Helper function to calculate months to create based on selected month and current situation
  const calculateMonthsToCreate = useCallback((startMonth: string, studentId: string) => {
    if (!startMonth) {
      return [];
    }

    const currentMonth = getCurrentMonth();

    // Future months are temporarily disabled
    if (startMonth > currentMonth) {
      return [];
    }

    const [startYear, startMonthNum] = startMonth.split('-').map(Number);
    const [currentYear, currentMonthNum] = currentMonth.split('-').map(Number);

    if (!Number.isFinite(startYear) || !Number.isFinite(startMonthNum)) {
      return [];
    }

    // Get student's due date to determine if current month should be included
    const student = students.find(s => s.id === studentId);
    const dueDay = student?.feeDueDate || 1;
    const today = new Date();
    const currentDay = today.getDate();

    const monthsToCreate: string[] = [];

    if (startMonth === currentMonth) {
      monthsToCreate.push(startMonth);
    } else {
      let year = startYear;
      let month = startMonthNum;

      while (year < currentYear || (year === currentYear && month < currentMonthNum)) {
        const monthValue = `${year}-${month.toString().padStart(2, '0')}`;
        monthsToCreate.push(monthValue);

        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }

      // Add current month only if due date has passed
      if (year === currentYear && month === currentMonthNum && currentDay >= dueDay) {
        const monthValue = `${year}-${month.toString().padStart(2, '0')}`;
        monthsToCreate.push(monthValue);
      }
    }

    return monthsToCreate;
  }, [getCurrentMonth, students]);

  const collectExistingMonthsForStudent = useCallback((studentId: string) => {
    if (!studentId) {
      return new Set<string>();
    }

    const months = new Set<string>();

    fees
      .filter(fee => fee.studentId === studentId)
      .forEach(fee => {
        if (Array.isArray(fee.monthsCovered) && fee.monthsCovered.length > 0) {
          fee.monthsCovered.forEach((month: string) => {
            const normalized = normalizeMonthString(month);
            if (normalized) {
              months.add(normalized);
            }
          });
        }

        if (Array.isArray(fee.paidMonths) && fee.paidMonths.length > 0) {
          fee.paidMonths.forEach((month: string) => {
            const normalized = normalizeMonthString(month);
            if (normalized) {
              months.add(normalized);
            }
          });
        }

        if (fee.dueDate) {
          const dueMonth = normalizeMonthString(String(fee.dueDate).substring(0, 7));
          if (dueMonth) {
            months.add(dueMonth);
          }
        }
      });

    return months;
  }, [fees]);

  // Helper function to initialize individual month fees when student or month changes
  const initializeMonthFees = useCallback((months: string[], defaultAmount: string) => {
    const newMonthFees: { [month: string]: string } = {};
    months.forEach(month => {
      newMonthFees[month] = defaultAmount || '';
    });
    setMonthFeeAmounts(newMonthFees);
  }, [setMonthFeeAmounts]);

  // Helper function to calculate total amount from individual month fees
  const calculateTotalFromMonthFees = () => {
    return Object.values(monthFeeAmounts).reduce((sum, amount) => {
      return sum + (parseFloat(amount) || 0);
    }, 0);
  };

  const showConfirmationCancelButton = confirmationData?.cancelButtonText !== null && confirmationData?.cancelButtonText !== '';
  const isSingleConfirmationButton = !showConfirmationCancelButton;
  const confirmationCancelButtonText = confirmationData?.cancelButtonText ?? 'Cancel';
  const confirmationConfirmButtonText = confirmationData?.confirmButtonText ?? 'Confirm';

  useEffect(() => {
    if (!addFeeForm.dueMonth) {
      return;
    }

    const isAllowed = addFeeMonthOptions.some(option => option.value === addFeeForm.dueMonth);
    if (!isAllowed) {
      const fallbackMonth = addFeeMonthOptions[addFeeMonthOptions.length - 1]?.value ?? '';

      setAddFeeForm(prev => ({
        ...prev,
        dueMonth: fallbackMonth,
      }));

      if (fallbackMonth && addFeeForm.studentId) {
        const months = calculateMonthsToCreate(fallbackMonth, addFeeForm.studentId);
        initializeMonthFees(months, addFeeForm.amount);
      }
    }
  }, [
    addFeeForm.dueMonth,
    addFeeForm.studentId,
    addFeeForm.amount,
    addFeeMonthOptions,
    calculateMonthsToCreate,
    initializeMonthFees,
  ]);

  // Helper function to close Add Fee modal and reset all form state
  const closeAddFeeModal = () => {
    setShowAddFeeModal(false);
    setShowDueMonthModal(false);
    setShowStudentSelectModal(false);
    setStudentSearchQuery('');
    resetAddFeeForm();
  };

  // Helper function to calculate due date from month
  const calculateDueDateFromMonth = (month: string, studentId?: string) => {
    if (!month) return '';
    const [year, monthNum] = month.split('-');
    
    // Get student's preferred due date
    let dueDay = 1; // Default to 1st if no feeDueDate specified
    if (studentId) {
      const student = students.find(s => s.id === studentId);
      dueDay = student?.feeDueDate || 1;
    }
    
    // Ensure due day is valid for the month
    const maxDaysInMonth = new Date(parseInt(year), parseInt(monthNum), 0).getDate();
    const validDueDay = Math.min(dueDay, maxDaysInMonth);
    
    return `${year}-${monthNum}-${validDueDay.toString().padStart(2, '0')}`;
  };

  const handleSelectDueMonth = (value: string) => {
    setAddFeeForm(prev => ({ ...prev, dueMonth: value }));

    if (addFeeForm.studentId) {
      const existing = checkExistingFee(addFeeForm.studentId, value);
      setExistingFee(existing);
    } else {
      setExistingFee(null);
    }

    if (addFeeForm.studentId && value) {
      const months = calculateMonthsToCreate(value, addFeeForm.studentId);
      initializeMonthFees(months, addFeeForm.amount);
    } else {
      setMonthFeeAmounts({});
    }

    setShowDueMonthModal(false);
  };

  // Helper function to check for existing fee
  const checkExistingFee = (studentId: string, month: string) => {
    if (!studentId) return null;
    
    // Check if student has ANY existing fees, regardless of month
    return fees.find(fee => fee.studentId === studentId);
  };

  // Helper function to calculate amount based on student's monthly fee
  const calculateAmountForStudent = (studentId: string) => {
    const student = students.find(s => s.id === studentId);
    return student?.monthlyFee?.toString() || student?.totalFees?.toString() || '1000';
  };

  const handleStudentSelection = (value: string) => {
    const selectedStudent = students.find(student => student.id === value);
    const amountString = value ? calculateAmountForStudent(value) : '';

    setAddFeeForm(prev => ({
      ...prev,
      studentId: value,
      studentName: selectedStudent?.name || '',
      amount: amountString,
    }));

    setCanEditAmount(false);

    if (value && addFeeForm.dueMonth) {
      const months = calculateMonthsToCreate(addFeeForm.dueMonth, value);
      initializeMonthFees(months, amountString);
    } else {
      setMonthFeeAmounts({});
    }

    if (value) {
      const existing = checkExistingFee(value, addFeeForm.dueMonth);
      setExistingFee(existing);
    } else {
      setExistingFee(null);
    }
  };

  // Memoized helper functions to prevent unnecessary re-computations
  const categorizeFee = useCallback((fee: any) => {
    if (fee.status === 'paid') return 'paid';
    
    const today = new Date();
    const dueDate = new Date(fee.dueDate);
    const daysDiff = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Check for partial payment in consolidated fees (including auto-distributed payments)
    if (fee.monthsCovered && fee.monthsCovered.length > 1) {
      const actuallyPaidMonthsCount = getActuallyPaidMonthsCount(fee);
      if (actuallyPaidMonthsCount >= fee.monthsCovered.length) return 'paid';
      if (actuallyPaidMonthsCount > 0) return 'partial';
    }
    
    // Check for regular partial payment
    if (fee.paidAmount && fee.paidAmount > 0 && fee.paidAmount < fee.amount) return 'partial';
    
    // Check date-based categories
    if (daysDiff > 30) return 'overdue';
    if (daysDiff >= 0) return 'unpaid'; // Changed from > 0 to >= 0 to include today
    return 'pending';
  }, []);

  const getCorrectFeeAmount = useCallback((fee: any) => {
    if (fee.monthFeeAmounts && fee.monthsCovered) {
      // Use sum of individual month amounts for consolidated fees
      return fee.monthsCovered.reduce((sum: number, month: string) => 
        sum + (fee.monthFeeAmounts?.[month] || 0), 0);
    }
    // Fallback to stored amount
    return fee.amount || 0;
  }, []);

  // Optimized helper function with memoization to count fees by category
  const getFeesCountByCategory = useCallback((category: string) => {
    if (category === 'All') {
      return fees.length;
    }
    
    // Use a more efficient filter approach
    let count = 0;
    for (let i = 0; i < fees.length; i++) {
      const recordCategory = categorizeFee(fees[i]);
      if (recordCategory === category) {
        count++;
      }
    }
    return count;
  }, [fees.length, categorizeFee]); // Memoize based on fees length and categorize function

  const resolveStudentForAction = (action: (typeof pendingAutoFeeActions)[number]) => {
    const studentId = action.student?.id;
    if (!studentId) {
      return undefined;
    }
    return studentMap[studentId];
  };

  const resolveMonthlyFeeForAction = (action: (typeof pendingAutoFeeActions)[number], student: Student | undefined) => {
    const possibleValues = [
      student?.monthlyFee,
      student?.totalFees,
      action.monthlyFee,
      (action.existingFee as any)?.monthlyFeeAmount,
      (action.existingFee as any)?.amount,
    ];

    const numericValue = possibleValues.find(value => typeof value === 'number' && !Number.isNaN(value));
    return typeof numericValue === 'number' ? numericValue : 1000;
  };

  type AutoFeeProcessResult = {
    status: 'created' | 'updated' | 'fallback-created' | 'skipped';
    feeId?: string;
    feeSnapshot?: any;
  };

  const processCreateAutoFeeAction = async (
    action: (typeof pendingAutoFeeActions)[number],
    student: Student,
    monthLabel?: string
  ): Promise<AutoFeeProcessResult> => {
    if (!student?.id) {
      throw new Error('Missing student reference for automatic fee creation');
    }

    const studentId = student.id;
    if (isMonthCovered(studentId, action.currentMonth)) {
      logger.info('Skipping automatic fee creation because month is already covered', {
        studentId,
        month: action.currentMonth,
        actionId: action.id,
      });
      return { status: 'skipped' };
    }

    const effectiveStudentName = student.name || action.student?.name || 'Student';
    const monthKey = normalizeMonthString(action.currentMonth) || action.currentMonth;
    const effectiveMonthLabel = monthLabel || generateMonthOptions.find(m => m.value === monthKey)?.label || monthKey;
    const resolvedMonthlyFee = resolveMonthlyFeeForAction(action, student);
    const dueDate = calculateDueDateFromMonth(monthKey, studentId);

    const newFeeData = {
      studentId,
      studentName: effectiveStudentName,
      amount: resolvedMonthlyFee,
      dueDate,
      type: 'tuition' as 'tuition' | 'registration' | 'materials' | 'other',
      description: `Monthly tuition fee for ${effectiveMonthLabel} (auto-created on due date)`,
      status: 'pending' as 'pending' | 'paid' | 'overdue',
      paidAmount: 0,
      monthsCovered: [monthKey],
      monthlyFeeAmount: resolvedMonthlyFee,
      monthFeeAmounts: { [monthKey]: resolvedMonthlyFee },
      paidMonths: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

  const newFeeId = await addFeeRecord(newFeeData, 'automatic', user?.displayName || 'Unknown User');
  const newFeeSnapshot = { ...newFeeData, id: newFeeId };
    markRuntimeCoverage(studentId, monthKey);

    Toast.show({
      type: 'info',
      text1: 'Automatic Fee Created',
      text2: `Created ${effectiveMonthLabel} fee for ${effectiveStudentName} (₹${resolvedMonthlyFee.toLocaleString()})`,
      position: 'top',
      visibilityTime: 3000,
    });

    return { status: 'created', feeId: newFeeId, feeSnapshot: newFeeSnapshot };
  };

  const processUpdateAutoFeeAction = async (
    action: (typeof pendingAutoFeeActions)[number],
    student: Student,
    monthLabel?: string
  ): Promise<AutoFeeProcessResult> => {
    if (!student?.id) {
      throw new Error('Missing student reference for automatic fee update');
    }

    const studentId = student.id;
    const effectiveMonthLabel = monthLabel || generateMonthOptions.find(m => m.value === action.currentMonth)?.label || action.currentMonth;

    const latestFeeFromStore = action.existingFee?.id
      ? fees.find(fee => fee.id === action.existingFee?.id)
      : undefined;

    const effectiveFee = latestFeeFromStore || action.existingFee;

    if (!effectiveFee) {
      logger.warn('Auto fee update fallback to creation because existing fee was not found', {
        actionId: action.id,
        feeId: action.existingFee?.id,
      });

      const fallbackResult = await processCreateAutoFeeAction({ ...action, type: 'create', existingFee: undefined }, student, monthLabel);
      if (fallbackResult.status === 'created') {
        return { status: 'fallback-created', feeId: fallbackResult.feeId, feeSnapshot: fallbackResult.feeSnapshot };
      }
      return fallbackResult;
    }

    const monthKey = normalizeMonthString(action.currentMonth) || action.currentMonth;

    if (isMonthCovered(studentId, monthKey)) {
      logger.info('Skipping automatic fee update because month is already covered', {
        studentId,
        month: monthKey,
        actionId: action.id,
        feeId: effectiveFee.id,
      });
      return { status: 'skipped', feeId: effectiveFee.id, feeSnapshot: effectiveFee };
    }

    const existingMonthsRaw = Array.isArray(effectiveFee.monthsCovered) && effectiveFee.monthsCovered.length > 0
      ? [...effectiveFee.monthsCovered]
      : effectiveFee.dueDate
        ? [String(effectiveFee.dueDate).substring(0, 7)]
        : [];

    const existingMonths = existingMonthsRaw
      .map(normalizeMonthString)
      .filter((value): value is string => Boolean(value));

    if (existingMonths.includes(monthKey)) {
      Toast.show({
        type: 'info',
        text1: 'Month Already Included',
        text2: `${effectiveMonthLabel} is already part of ${student?.name || effectiveFee.studentName || 'the student'}'s fee record`,
        position: 'top',
        visibilityTime: 3000,
      });
      return { status: 'skipped', feeId: effectiveFee.id, feeSnapshot: effectiveFee };
    }

    const newMonthsCovered = [...existingMonths, monthKey]
      .map(value => normalizeMonthString(value) || value)
      .filter((value, index, array) => array.indexOf(value) === index)
      .sort();
  const existingMonthFeeAmounts = effectiveFee.monthFeeAmounts || {};
    const normalizedExistingAmounts = Object.entries(existingMonthFeeAmounts).reduce((acc, [month, amount]) => {
      const normalizedMonth = normalizeMonthString(month) || month;
      const numericAmount = typeof amount === 'number' ? amount : Number(amount);
      acc[normalizedMonth] = Number.isFinite(numericAmount) ? numericAmount : 0;
      return acc;
    }, {} as Record<string, number>);

    const newMonthFeeAmounts: Record<string, number> = { ...normalizedExistingAmounts };
    const resolvedMonthlyFee = resolveMonthlyFeeForAction(action, student);

    newMonthsCovered.forEach(month => {
      if (!newMonthFeeAmounts[month]) {
        if (month === monthKey) {
          newMonthFeeAmounts[month] = resolvedMonthlyFee;
        } else {
          const originalValue = normalizedExistingAmounts[month];
          newMonthFeeAmounts[month] = typeof originalValue === 'number' ? originalValue : resolvedMonthlyFee;
        }
      }
    });

    const newTotalAmount = Object.values(newMonthFeeAmounts).reduce((sum, amount) => sum + Number(amount || 0), 0);
    const earliestMonth = newMonthsCovered[0];
    const newDueDate = calculateDueDateFromMonth(earliestMonth, studentId);

    const firstMonthLabel = generateMonthOptions.find(m => m.value === newMonthsCovered[0])?.label || earliestMonth;
    const lastMonthLabel = generateMonthOptions.find(m => m.value === newMonthsCovered[newMonthsCovered.length - 1])?.label || newMonthsCovered[newMonthsCovered.length - 1];
    const effectiveStudentName = student.name || effectiveFee.studentName || 'Student';
    const consolidatedDescription = newMonthsCovered.length > 1
      ? `Consolidated tuition fees for ${newMonthsCovered.length} months (${firstMonthLabel} to ${lastMonthLabel}). Individual month fees may vary. Updated with ${effectiveMonthLabel} by ${user?.displayName || 'Unknown User'}.`
      : `Monthly tuition fee for ${firstMonthLabel}. Updated by ${user?.displayName || 'Unknown User'}.`;

  const shouldDowngradeStatus = effectiveFee.status === 'paid';

    await updateFeeRecord(effectiveFee.id!, {
      amount: newTotalAmount,
      dueDate: newDueDate,
      description: consolidatedDescription,
      monthsCovered: newMonthsCovered,
      monthlyFeeAmount: Math.round(newTotalAmount / newMonthsCovered.length),
      monthFeeAmounts: newMonthFeeAmounts,
      paidMonths: effectiveFee.paidMonths || [],
      studentName: effectiveStudentName,
      updatedAt: new Date().toISOString(),
      ...(shouldDowngradeStatus ? { status: 'partial' as const } : {}),
    });
    markRuntimeCoverage(studentId, monthKey);

    const updatedSnapshot = {
      id: effectiveFee.id,
      ...effectiveFee,
      amount: newTotalAmount,
      dueDate: newDueDate,
      description: consolidatedDescription,
      monthsCovered: newMonthsCovered,
      monthlyFeeAmount: Math.round(newTotalAmount / newMonthsCovered.length),
      monthFeeAmounts: newMonthFeeAmounts,
      paidMonths: effectiveFee.paidMonths || [],
      studentName: effectiveStudentName,
      updatedAt: new Date().toISOString(),
      ...(shouldDowngradeStatus ? { status: 'partial' as const } : {}),
    };

    Toast.show({
      type: 'success',
      text1: 'Fee Updated',
      text2: `Added ${effectiveMonthLabel} to existing fee for ${effectiveStudentName}. Total: ₹${newTotalAmount.toLocaleString()} (${newMonthsCovered.length} months)`,
      position: 'top',
      visibilityTime: 4000,
    });

    return { status: 'updated', feeId: updatedSnapshot.id, feeSnapshot: updatedSnapshot };
  };

  // Auto fee approval functions
  const handleApproveAutoFees = async () => {
    if (isProcessingApproveAll || isProcessingRejectAll) {
      return;
    }

    const totalActions = pendingAutoFeeActions.length;

    if (totalActions === 0) {
      setShowAutoFeeApprovalModal(false);
      return;
    }

    if (studentsLoading) {
      Toast.show({
        type: 'info',
        text1: 'Student Data Loading',
        text2: 'Please wait for the latest student list before approving fees.',
        position: 'top',
        visibilityTime: 3000,
      });
      return;
    }

    setIsProcessingApproveAll(true);

    const processedActionIds: string[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let fallbackCreatedCount = 0;
    let skippedCount = 0;
    let failureCount = 0;
  let missingStudentCount = 0;

  const createdFeeMap = new Map<string, { id: string; snapshot?: any }>();

    try {
      for (const action of pendingAutoFeeActions) {
        const monthLabel = generateMonthOptions.find(m => m.value === action.currentMonth)?.label;
        const resolvedStudent = resolveStudentForAction(action);

        if (!resolvedStudent) {
          missingStudentCount += 1;
          processedActionIds.push(action.id);
          logger.info('Skipping automatic fee approval because student record is missing', {
            actionId: action.id,
            studentId: action.student?.id,
          });
          continue;
        }

        if (isMonthCovered(resolvedStudent.id, action.currentMonth)) {
          skippedCount += 1;
          processedActionIds.push(action.id);
          logger.info('Skipping automatic fee approval because month is already covered', {
            actionId: action.id,
            studentId: resolvedStudent.id,
            month: action.currentMonth,
          });
          continue;
        }

        try {
          const cachedFeeEntry = createdFeeMap.get(resolvedStudent.id);
          const normalizedMonth = normalizeMonthString(action.currentMonth);

          let result: AutoFeeProcessResult;

          if (cachedFeeEntry && normalizedMonth) {
            const overrideAction = {
              ...action,
              type: 'update' as const,
              existingFee: { ...(cachedFeeEntry.snapshot ?? action.existingFee ?? {}), id: cachedFeeEntry.id },
            };
            result = await processUpdateAutoFeeAction(overrideAction, resolvedStudent, monthLabel);
          } else if (action.type === 'create') {
            result = await processCreateAutoFeeAction(action, resolvedStudent, monthLabel);
          } else {
            if (!cachedFeeEntry && action.existingFee?.id) {
              createdFeeMap.set(resolvedStudent.id, { id: action.existingFee.id, snapshot: action.existingFee });
            }
            result = await processUpdateAutoFeeAction(action, resolvedStudent, monthLabel);
          }

          if (result.feeId) {
            const fallbackSnapshot = cachedFeeEntry?.snapshot ?? action.existingFee;
            createdFeeMap.set(resolvedStudent.id, { id: result.feeId, snapshot: result.feeSnapshot ?? fallbackSnapshot });
          }

          switch (result.status) {
            case 'created':
              createdCount += 1;
              break;
            case 'updated':
              updatedCount += 1;
              break;
            case 'fallback-created':
              fallbackCreatedCount += 1;
              createdCount += 1;
              break;
            case 'skipped':
              skippedCount += 1;
              break;
            default:
              break;
          }

          processedActionIds.push(action.id);
        } catch (actionError) {
          failureCount += 1;
          logger.error('Failed to process automatic fee action:', actionError, { actionId: action.id });
        }
      }
    } finally {
      const remainingActions = pendingAutoFeeActions.filter(action => !processedActionIds.includes(action.id));
      setPendingAutoFeeActions(remainingActions);
      try {
        await savePendingApprovals(remainingActions);
      } catch (persistError) {
        logger.error('Failed to persist remaining auto fee approvals after bulk approval', persistError);
      }

      if (remainingActions.length === 0) {
        setShowAutoFeeApprovalModal(false);
      } else if (failureCount > 0 || skippedCount > 0) {
        openAutoFeeApprovalModal();
      }

      if (missingStudentCount > 0) {
        Toast.show({
          type: 'info',
          text1: 'Student Removed',
          text2: `${missingStudentCount} approval${missingStudentCount === 1 ? '' : 's'} skipped because the student record no longer exists`,
          position: 'top',
          visibilityTime: 3000,
        });
      }

      const successCount = createdCount + updatedCount;

      if (successCount > 0) {
        const parts = [] as string[];
        if (createdCount > 0) {
          parts.push(`${createdCount} new`);
        }
        if (updatedCount > 0) {
          parts.push(`${updatedCount} updated`);
        }
        if (fallbackCreatedCount > 0) {
          parts.push(`${fallbackCreatedCount} recreated`);
        }

        Toast.show({
          type: 'success',
          text1: 'Auto Fees Processed',
          text2: `Completed ${successCount} approval${successCount === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}`,
          position: 'top',
          visibilityTime: 3000,
        });
      }

      if (skippedCount > 0) {
        Toast.show({
          type: 'info',
          text1: 'Some Auto Fees Skipped',
          text2: `${skippedCount} item${skippedCount === 1 ? ' was' : 's were'} already up to date`,
          position: 'top',
          visibilityTime: 3000,
        });
      }

      if (failureCount > 0) {
        Toast.show({
          type: 'error',
          text1: 'Auto Fee Processing Issues',
          text2: `Could not process ${failureCount} approval${failureCount === 1 ? '' : 's'}. Please review and retry.`,
          position: 'top',
          visibilityTime: 4000,
        });
      }

      setIsProcessingApproveAll(false);
    }
  };

  const handleRejectAutoFees = async () => {
    if (isProcessingRejectAll || isProcessingApproveAll) {
      return;
    }

    if (pendingAutoFeeActions.length === 0) {
      setShowAutoFeeApprovalModal(false);
      return;
    }

    setIsProcessingRejectAll(true);

    try {
      // Add all pending actions' rejection keys to rejected set
      const updatedRejectedSet = new Set(rejectedAutoFeeActions);
      pendingAutoFeeActions.forEach(action => {
        updatedRejectedSet.add(action.rejectionKey);
      });
      
      // Update state and storage
      setRejectedAutoFeeActions(updatedRejectedSet);
      await saveRejectedApprovals(updatedRejectedSet);
      
      // Clear pending actions and close modal
      setPendingAutoFeeActions([]);
      await savePendingApprovals([]);
      setShowAutoFeeApprovalModal(false);
      
      Toast.show({
        type: 'info',
        text1: 'Auto Fees Rejected',
        text2: `Rejected ${pendingAutoFeeActions.length} automatic fee updates. They won't appear again.`,
        position: 'top',
        visibilityTime: 3000,
      });
    } catch (error) {
      logger.error('Failed to reject automatic fees:', error);
      Toast.show({
        type: 'error',
        text1: 'Auto Fee Rejection Failed',
        text2: 'Could not save rejection preferences',
        position: 'top',
        visibilityTime: 3000,
      });
    } finally {
      setIsProcessingRejectAll(false);
    }
  };

  // Individual approve/reject functions for enhanced control
  const handleApproveIndividualAutoFee = async (actionId: string) => {
    try {
      const actionToApprove = pendingAutoFeeActions.find(action => action.id === actionId);
      if (!actionToApprove) return;

      if (studentsLoading) {
        Toast.show({
          type: 'info',
          text1: 'Student Data Loading',
          text2: 'Please wait for the latest student list before approving fees.',
          position: 'top',
          visibilityTime: 3000,
        });
        return;
      }

      const resolvedStudent = resolveStudentForAction(actionToApprove);
      const monthLabel = generateMonthOptions.find(m => m.value === actionToApprove.currentMonth)?.label;

      if (!resolvedStudent) {
        const updatedPendingActions = pendingAutoFeeActions.filter(action => action.id !== actionId);
        setPendingAutoFeeActions(updatedPendingActions);
        await savePendingApprovals(updatedPendingActions);

        if (updatedPendingActions.length === 0) {
          setShowAutoFeeApprovalModal(false);
        }

        Toast.show({
          type: 'info',
          text1: 'Student Removed',
          text2: `${actionToApprove.student?.name || 'Student'} is no longer in the student list. Nothing to approve.`,
          position: 'top',
          visibilityTime: 3000,
        });
        return;
      }

      let result: AutoFeeProcessResult;

      if (actionToApprove.type === 'create') {
        result = await processCreateAutoFeeAction(actionToApprove, resolvedStudent, monthLabel);
      } else {
        result = await processUpdateAutoFeeAction(actionToApprove, resolvedStudent, monthLabel);
      }

      const remainingPendingActions = pendingAutoFeeActions.filter(action => action.id !== actionId);

      const normalizedPendingActions = (result.feeId && result.status !== 'skipped')
        ? remainingPendingActions.map(action => {
            if (action.student?.id === resolvedStudent.id) {
              return {
                ...action,
                type: 'update' as const,
                existingFee: {
                  ...(result.feeSnapshot ?? action.existingFee ?? {}),
                  id: result.feeId,
                },
              };
            }
            return action;
          })
        : remainingPendingActions;

      setPendingAutoFeeActions(normalizedPendingActions);
      await savePendingApprovals(normalizedPendingActions);

      if (normalizedPendingActions.length === 0) {
        setShowAutoFeeApprovalModal(false);
      }

      const studentName = resolvedStudent.name || actionToApprove.student?.name || 'Student';

      if (result.status === 'skipped') {
        Toast.show({
          type: 'info',
          text1: 'Approval Not Needed',
          text2: `${monthLabel} fee for ${studentName} was already up to date`,
          position: 'top',
          visibilityTime: 3000,
        });
      } else {
        Toast.show({
          type: 'success',
          text1: 'Fee Approved',
          text2: `Approved ${monthLabel} fee for ${studentName}`,
          position: 'top',
          visibilityTime: 3000,
        });
      }

    } catch (error) {
      logger.error('Failed to approve individual auto fee:', error);
      Toast.show({
        type: 'error',
        text1: 'Approval Failed',
        text2: 'Could not process the approval',
        position: 'top',
        visibilityTime: 3000,
      });
    }
  };

  const handleRejectIndividualAutoFee = async (actionId: string) => {
    try {
      const actionToReject = pendingAutoFeeActions.find(action => action.id === actionId);
      if (!actionToReject) return;

      // Add rejection key to rejected set
      const updatedRejectedSet = new Set(rejectedAutoFeeActions);
      updatedRejectedSet.add(actionToReject.rejectionKey);
      
      setRejectedAutoFeeActions(updatedRejectedSet);
      await saveRejectedApprovals(updatedRejectedSet);

      // Remove from pending actions
      const updatedPendingActions = pendingAutoFeeActions.filter(action => action.id !== actionId);
      setPendingAutoFeeActions(updatedPendingActions);
      await savePendingApprovals(updatedPendingActions);

      // Close modal if no more pending actions
      if (updatedPendingActions.length === 0) {
        setShowAutoFeeApprovalModal(false);
      }

      const monthLabel = generateMonthOptions.find(m => m.value === actionToReject.currentMonth)?.label;
      Toast.show({
        type: 'info',
        text1: 'Fee Rejected',
        text2: `Rejected ${monthLabel} fee for ${actionToReject.student.name}. Won't appear again.`,
        position: 'top',
        visibilityTime: 3000,
      });

    } catch (error) {
      logger.error('Failed to reject individual auto fee:', error);
      Toast.show({
        type: 'error',
        text1: 'Rejection Failed',
        text2: 'Could not save rejection preference',
        position: 'top',
        visibilityTime: 3000,
      });
    }
  };

  const filters = [
    { key: 'All', label: 'All', color: '#6B7280' },
    { key: 'paid', label: 'Paid', color: '#10B981' },
    { key: 'partial', label: 'Partial', color: '#F59E0B' },
    { key: 'pending', label: 'Pending', color: '#3B82F6' },
    { key: 'unpaid', label: 'Unpaid', color: '#EF4444' },
    { key: 'overdue', label: 'Overdue', color: '#DC2626' }
  ];

  // Sort and group fees by month
  const sortAndGroupFees = (fees: any[]) => {
    const grouped: { [key: string]: any[] } = {};
    
    fees.forEach(fee => {
      let month;
      if (selectedFilter === 'overdue') {
        // For overdue items, group by the month they were originally due
        month = new Date(fee.dueDate).toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long' 
        }) + ' (Overdue)';
      } else {
        month = new Date(fee.dueDate).toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long' 
        });
      }
      if (!grouped[month]) grouped[month] = [];
      grouped[month].push(fee);
    });

    // Sort months for overdue section (oldest first)
    const sortedMonths = Object.keys(grouped).sort((a, b) => {
      const dateA = new Date(a.replace(' (Overdue)', ''));
      const dateB = new Date(b.replace(' (Overdue)', ''));
      if (selectedFilter === 'overdue') {
        return dateA.getTime() - dateB.getTime(); // Oldest overdue first
      }
      return dateB.getTime() - dateA.getTime(); // Most recent first for others
    });

    // Sort each group based on sortBy
    sortedMonths.forEach(month => {
      grouped[month].sort((a, b) => {
        switch (sortBy) {
          case 'amount':
            return b.amount - a.amount;
          case 'student':
            return a.studentName.localeCompare(b.studentName);
          case 'date':
          default:
            if (selectedFilter === 'overdue') {
              return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(); // Oldest due first for overdue
            }
            return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
        }
      });
    });

    // Return grouped data in sorted month order
    const result: { [key: string]: any[] } = {};
    sortedMonths.forEach(month => {
      result[month] = grouped[month];
    });

    return result;
  };

  // Optimized expensive calculations to prevent unnecessary re-computations
  const filteredRecords = useMemo(() => {
    if (selectedFilter === 'All') {
      return fees;
    }
    
    // Batch filter operations to reduce iterations
    const filtered = fees.filter(record => {
      const category = categorizeFee(record);
      return category === selectedFilter;
    });
    
    return filtered;
  }, [fees, selectedFilter, categorizeFee]);

  // Apply hide paid fees filter when "All" is selected - optimized
  const finalFilteredRecords = useMemo(() => {
    if (selectedFilter !== 'All' || !hidePaidFees) {
      return filteredRecords;
    }
    
    return filteredRecords.filter(record => {
      const category = categorizeFee(record);
      return category !== 'paid';
    });
  }, [filteredRecords, selectedFilter, hidePaidFees, categorizeFee]);

  // Apply search filter on top of other filters
  const searchFilteredRecords = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return finalFilteredRecords;
    return finalFilteredRecords.filter(record => {
      const student = studentMap[record.studentId];
      const statusStr = categorizeFee(record).toLowerCase();
      const amountStr = String(getCorrectFeeAmount(record));
      const dueStr = String(record.dueDate || '').toLowerCase();
      const haystack = [
        record.studentName,
        student?.parentName,
        student?.parentPhone,
        student?.parentEmail,
        student?.grade,
        ...(student?.subjects || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      // Numeric-only comparison for amounts if user typed digits
      const qDigits = q.replace(/[^0-9]/g, '');
      const amountMatch = qDigits.length > 0 ? amountStr.includes(qDigits) : false;

      return (
        haystack.includes(q) ||
        statusStr.includes(q) ||
        dueStr.includes(q) ||
        amountMatch
      );
    });
  }, [finalFilteredRecords, debouncedSearch, studentMap, categorizeFee, getCorrectFeeAmount]);

  const groupedRecords = useMemo(() => {
    return sortAndGroupFees(searchFilteredRecords);
  }, [searchFilteredRecords, sortBy]);

  // Memoized monthly fee data calculation
  const monthlyFeeData = useMemo(() => {
    const monthlyData: { [month: string]: { collected: number; pending: number; total: number } } = {};
    
    fees.forEach(fee => {
      const feeDate = new Date(fee.dueDate);
      const monthKey = `${feeDate.getFullYear()}-${(feeDate.getMonth() + 1).toString().padStart(2, '0')}`;
      
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { collected: 0, pending: 0, total: 0 };
      }
      
      const feeAmount = getCorrectFeeAmount(fee);
      const category = categorizeFee(fee);
      
      monthlyData[monthKey].total += feeAmount;
      
      if (category === 'paid') {
        monthlyData[monthKey].collected += feeAmount;
      } else if (category === 'partial') {
        const paidAmount = fee.paidAmount || 0;
        monthlyData[monthKey].collected += paidAmount;
        monthlyData[monthKey].pending += (feeAmount - paidAmount);
      } else {
        monthlyData[monthKey].pending += feeAmount;
      }
    });
    
    // Convert to array format expected by calendar modal
    return Object.entries(monthlyData)
      .sort(([a], [b]) => b.localeCompare(a)) // Sort by month descending (newest first)
      .map(([monthKey, data]) => {
        const [year, month] = monthKey.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1);
        const monthLabel = date.toLocaleDateString('en-US', { 
          month: 'long', 
          year: 'numeric' 
        });
        
        return {
          key: monthKey,
          month: monthLabel,
          collected: data.collected,
          pending: data.pending,
          total: data.total
        };
      });
  }, [fees]);

  // Removed getMonthlyFeeData function - now memoized as monthlyFeeData above

  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setExpandedMonths(prev => {
      const next: Record<string, boolean> = {};
      monthlyFeeData.forEach((month, index) => {
        next[month.key] = prev[month.key] ?? index === 0;
      });
      return next;
    });
  }, [monthlyFeeData]);

  const toggleMonthCard = useCallback((monthKey: string) => {
    setExpandedMonths(prev => ({
      ...prev,
      [monthKey]: !prev[monthKey],
    }));
  }, []);

  

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return '#10B981'; // Green
      case 'partial':
        return '#F59E0B'; // Amber
      case 'pending':
        return '#3B82F6'; // Blue
      case 'unpaid':
        return '#EF4444'; // Red
      case 'overdue':
        return '#DC2626'; // Dark Red
      default:
        return theme.textSecondary;
    }
  };

  const getFilterColor = (filterKey: string) => {
    const filter = filters.find(f => f.key === filterKey);
    return filter ? filter.color : theme.textSecondary;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'paid':
        return CheckCircle;
      case 'partial':
        return Clock;
      case 'unpaid':
        return AlertCircle;
      case 'overdue':
        return AlertCircle;
      case 'pending':
        return Clock;
      default:
        return Clock;
    }
  };

  // Persisted reminder preferences handlers
  const handleChangeReminderChannel = useCallback((value: 'whatsapp' | 'sms') => {
    setPaymentForm(prev => ({ ...prev, reminderChannel: value }));
    const updated: ReminderPrefs = {
      reminderChannel: value,
      selectedLanguage: paymentForm.selectedLanguage,
      languageOrder: paymentForm.languageOrder,
    };
    setReminderPrefs(updated);
    saveReminderPrefs(updated);
  }, [paymentForm.selectedLanguage, paymentForm.languageOrder, saveReminderPrefs]);

  const handleChangeSelectedLanguage = useCallback((value: 'english' | 'hindi' | 'both') => {
    setPaymentForm(prev => ({ ...prev, selectedLanguage: value }));
    const updated: ReminderPrefs = {
      reminderChannel: paymentForm.reminderChannel,
      selectedLanguage: value,
      languageOrder: paymentForm.languageOrder,
    };
    setReminderPrefs(updated);
    saveReminderPrefs(updated);
  }, [paymentForm.reminderChannel, paymentForm.languageOrder, saveReminderPrefs]);

  const handleChangeLanguageOrder = useCallback((value: 'english-first' | 'hindi-first') => {
    setPaymentForm(prev => ({ ...prev, languageOrder: value }));
    const updated: ReminderPrefs = {
      reminderChannel: paymentForm.reminderChannel,
      selectedLanguage: paymentForm.selectedLanguage,
      languageOrder: value,
    };
    setReminderPrefs(updated);
    saveReminderPrefs(updated);
  }, [paymentForm.reminderChannel, paymentForm.selectedLanguage, saveReminderPrefs]);

  const handleSendReminder = (fee: any) => {
    // Navigate to reminders page with the selected fee data
    router.push({
      pathname: '/reminders',
      params: {
        feeId: fee.id,
        studentId: fee.studentId,
        studentName: fee.studentName,
        amount: fee.amount.toString(),
        dueDate: fee.dueDate
      }
    });
  };

  // Load reminder history for the selected fee
  const loadFeeReminderHistory = async (fee: any) => {
    if (!fee?.studentId) return;
    if (!tenantId) {
      setFeeReminderHistory([]);
      setStudentTotalReminderCount(null);
      setLoadingReminderHistory(false);
      return;
    }
    
    try {
      setLoadingReminderHistory(true);
      // Fetch latest reminders for display (limited)
      const history = await getStudentHistory(fee.studentId, 50, 'all');
      // Also fetch the full count for the student (across all users)
      try {
        const total = await reminderHistoryService.getReminderCount(tenantId, canViewAllReminders ? null : (user?.uid || null), { studentId: fee.studentId });
        setStudentTotalReminderCount(total);
      } catch {
        // getReminderCount only throws on permission-denied; the service already
        // logged it (quietly for an expected all-scope denial, loudly for an
        // unexpected self-scoped one). Just hide the count for this student.
        setStudentTotalReminderCount(null);
      }
      
      // Filter reminders that are related to this fee based on date and amount
      const feeRelatedReminders = history.filter(reminder => {
        // Check if reminder is for the same student and has similar fee information
        if (reminder.studentId !== fee.studentId) return false;
        
        // Check if the reminder amount matches this fee
        if (reminder.amount && fee.amount && reminder.amount === fee.amount) return true;
        
        // Check if the reminder was sent around the due date of this fee
        if (fee.dueDate && reminder.dueDate) {
          const reminderDueDate = new Date(reminder.dueDate);
          const feeDueDate = new Date(fee.dueDate);
          const daysDiff = Math.abs(reminderDueDate.getTime() - feeDueDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysDiff <= 7) return true; // Within a week of the due date
        }
        
        // If no specific matching criteria, include all reminders for this student
        // as they might be related to this fee
        return true;
      });
      
      setFeeReminderHistory(feeRelatedReminders);
    } catch (error) {
      logger.error('Error loading fee reminder history:', error);
      setFeeReminderHistory([]);
  setStudentTotalReminderCount(null);
    } finally {
      setLoadingReminderHistory(false);
    }
  };

  // Cache for student reminders to avoid repeated database calls
  const reminderCache = useRef<{ [studentId: string]: { data: any, timestamp: number } }>({});
  const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

  // Optimized function to get the latest reminder with caching
  const getLatestReminderForStudent = useCallback(async (studentId: string): Promise<any | null> => {
    try {
      const now = Date.now();
      const cached = reminderCache.current[studentId];
      
      // Return cached data if it's still valid
      if (cached && (now - cached.timestamp) < CACHE_DURATION) {
        return cached.data;
      }
      
  const history = await getStudentHistory(studentId, 5, 'all'); // Get latest 5 reminders across all users
      let latestReminder = null;
      
      if (history.length > 0) {
        // Return the most recent reminder
        latestReminder = history[0];
      }
      
      // Cache the result
      reminderCache.current[studentId] = {
        data: latestReminder,
        timestamp: now
      };
      
      return latestReminder;
    } catch (error) {
      logger.error('Error getting latest reminder:', error);
      return null;
    }
  }, [getStudentHistory]);

  // Format reminder date to a readable string
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

  // Optimized callback with better batching to prevent unnecessary re-renders and API calls
  const loadStudentReminders = useCallback(async () => {
    try {
      const uniqueStudentIds = [...new Set(fees.map(fee => fee.studentId))];
      
      // Skip if no students or if we're already loading
      if (uniqueStudentIds.length === 0) {
        return;
      }
      
      // Filter out students that already have fresh cache
      const now = Date.now();
      const studentsNeedingReminders = uniqueStudentIds.filter(studentId => {
        const cached = reminderCache.current[studentId];
        return !cached || (now - cached.timestamp) > CACHE_DURATION;
      });
      
      if (studentsNeedingReminders.length === 0) {
        logger.debug('All student reminders are cached and fresh');
        return;
      }
      
      logger.debug(`Loading reminders for ${studentsNeedingReminders.length} students (${uniqueStudentIds.length - studentsNeedingReminders.length} cached)`);
      
      // Larger batch size to reduce total number of requests
      const BATCH_SIZE = 5; // Increased from 3 to 5
      const reminderMap: { [studentId: string]: any } = { ...studentReminders }; // Start with existing data
      
      for (let i = 0; i < studentsNeedingReminders.length; i += BATCH_SIZE) {
        const batch = studentsNeedingReminders.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (studentId) => {
          const latestReminder = await getLatestReminderForStudent(studentId);
          return { studentId, latestReminder };
        });
        
        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(({ studentId, latestReminder }) => {
          reminderMap[studentId] = latestReminder;
        });
        
        // Smaller delay between batches
        if (i + BATCH_SIZE < studentsNeedingReminders.length) {
          await new Promise(resolve => setTimeout(resolve, 50)); // Reduced from 100ms to 50ms
        }
      }
      
      setStudentReminders(reminderMap);
    } catch (error) {
      logger.error('Error loading student reminders:', error);
    }
  }, [fees.length, getLatestReminderForStudent]); // Minimal dependencies

  // Optimized reminder loading with better throttling and conditional loading
  useEffect(() => {
    // Skip if not ready or no fees
    if (fees.length === 0 || componentLoading || loading) return;
    
    // More aggressive debounce to prevent excessive API calls
    const timeoutId = setTimeout(() => {
      // Only load reminders if we don't have fresh cached data
      const now = Date.now();
      const shouldLoadReminders = Object.keys(studentReminders).length === 0 || 
        Object.values(reminderCache.current).some(cache => (now - cache.timestamp) > CACHE_DURATION);
      
      if (shouldLoadReminders) {
        logger.debug('Loading student reminders (optimized and throttled)');
        loadStudentReminders();
      } else {
        logger.debug('Skipping reminder load - fresh cache available');
      }
    }, 2000); // Increased debounce to 2 seconds
    
    return () => clearTimeout(timeoutId);
  }, [fees.length, componentLoading, loading]); // Removed loadStudentReminders from dependencies to prevent loops

  // Receipt upload and management functions
  const uploadReceiptToStorage = async (
    uri: string,
    feeId: string,
    fileName: string,
    onProgress?: (progress: number, bytesTotal?: number) => void,
  ): Promise<string> => {
    try {
      if (!tenantId) {
        throw new Error('Select a coaching center before uploading receipts.');
      }
      const response = await fetch(uri);
      const blob = await response.blob();
      
      // Check file size limit (20 MB = 20 * 1024 * 1024 bytes)
      const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
      if (blob.size > MAX_FILE_SIZE) {
        throw new Error(`File "${fileName}" exceeds the 20 MB limit. Please choose a smaller file.`);
      }

      // Preflight storage quota for single receipt uploads as well.
      try {
        const quota = await reconcileTenantStorageUsageViaBackend({ tenantId });
        if (Number.isFinite(quota?.bytes) && Number.isFinite(quota?.limitBytes)) {
          const wouldUse = (quota.bytes || 0) + blob.size;
          if (wouldUse > quota.limitBytes) {
            throw new Error(
              JSON.stringify({
                error: 'storage_limit_reached',
                usedBytes: quota.bytes,
                limitBytes: quota.limitBytes,
                incrementBytes: blob.size,
              }),
            );
          }
        }
      } catch (quotaError) {
        // If this was the structured storage_limit_reached error, rethrow.
        if (maybeShowStorageLimitReachedAlert(quotaError, 'fees.receiptSinglePreflight')) {
          throw quotaError;
        }
        logger.warn('Failed to preflight storage quota; proceeding with upload attempt.', quotaError);
      }
      
      const result = await uploadBlobViaBackend({
        tenantId,
        purpose: 'receipt',
        blob,
        contentType: blob.type || 'application/octet-stream',
        filename: fileName,
        feeId,
        suppressStorageLimitAlert: true,
        onProgress: (p) => {
          try {
            onProgress?.(p, blob.size);
          } catch {
            // ignore
          }
        },
      });
      return result.url;
    } catch (error) {
      logger.error('Error uploading receipt:', error);
      throw error;
    }
  };

  const deleteReceiptFromStorage = async (receiptUrl: string) => {
    try {
      // Server-mediated delete (security-rules-hardening M1): client deleteObject
      // is disabled in storage.rules; the backend resolves the object path from the
      // URL and verifies it is under this tenant's `receipts/{tenantId}/…` prefix.
      if (!tenantId) {
        throw new Error('Select a coaching center before deleting receipts.');
      }
      await deleteStorageObjectViaBackend({ tenantId, target: receiptUrl });
      logger.debug('Successfully deleted receipt from storage');
    } catch (error) {
      logger.error('Error deleting receipt from storage:', error);
      throw error;
    }
  };

  const pickReceiptImage = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'We need camera roll permission to upload receipt images.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const fileSize = (asset as any).fileSize || (asset as any).size || 0;
        
        // Check file size limit (20 MB = 20 * 1024 * 1024 bytes)
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
        if (fileSize > MAX_FILE_SIZE) {
          Alert.alert(
            'File Too Large',
            'The selected image exceeds the 20 MB limit. Please choose a smaller file.',
            [{ text: 'OK' }]
          );
          return null;
        }
        
        return {
          uri: asset.uri,
          name: `receipt_${Date.now()}.jpg`,
          type: 'image/jpeg'
        };
      }
    } catch (error) {
      logger.error('Error picking image:', error);
      Alert.alert('Error', 'Failed to pick image');
    }
    return null;
  };

  const pickReceiptDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'image/*',
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const fileSize = (asset as any).fileSize || (asset as any).size || 0;
        
        // Check file size limit (20 MB = 20 * 1024 * 1024 bytes)
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
        if (fileSize > MAX_FILE_SIZE) {
          Alert.alert(
            'File Too Large',
            `The selected file "${asset.name}" exceeds the 20 MB limit. Please choose a smaller file.`,
            [{ text: 'OK' }]
          );
          return null;
        }
        
        return {
          uri: asset.uri,
          name: asset.name,
          type: asset.mimeType || 'application/pdf'
        };
      }
    } catch (error) {
      logger.error('Error picking document:', error);
      Alert.alert('Error', 'Failed to pick document');
    }
    return null;
  };

  const handleUploadReceipt = async (type: 'image' | 'document' | 'unified') => {
    if (!selectedFee) return;
    
    logger.debug('handleUploadReceipt called with type:', type); // Debug log
    
    try {
      if (type === 'unified') {
        logger.debug('Opening unified file picker directly'); // Debug log
        await selectFiles('documents'); // Use documents picker which supports both images and PDFs
        return;
      }

      // Legacy single file selection for backward compatibility
      setUploadingReceipt(true);
      let fileInfo = null;
      
      if (type === 'image') {
        fileInfo = await pickReceiptImage();
      } else {
        fileInfo = await pickReceiptDocument();
      }

      if (!fileInfo) {
        setUploadingReceipt(false);
        return;
      }

      setUploadProgress(0);
      const receiptUrl = await uploadReceiptToStorage(fileInfo.uri, selectedFee.id, fileInfo.name, (p) => {
        setUploadProgress(Math.max(0, Math.min(100, p)));
      });
      
      // Update the fee record with receipt URL
      const existingReceipts = selectedFee.receipts || [];
      const updatedReceipts = [...existingReceipts, {
        url: receiptUrl,
        fileName: fileInfo.name,
        uploadedAt: new Date().toISOString(),
        type: fileInfo.type
      }];

      await updateFeeRecord(selectedFee.id, {
        receipts: updatedReceipts
      } as any);

      // Update the selectedFee state
      setSelectedFee({
        ...selectedFee,
        receipts: updatedReceipts
      });

      Toast.show({
        type: 'success',
        text1: 'Receipt Uploaded Successfully!',
        text2: `${fileInfo.name} has been uploaded`,
        position: 'top',
        visibilityTime: 3000,
      });

      setShowReceiptUpload(false);
    } catch (error) {
      logger.error('Error uploading receipt:', error);
      if (maybeShowStorageLimitReachedAlert(error, 'fees.uploadReceipt')) {
        return;
      }
      Alert.alert('Error', 'Failed to upload receipt. Please try again.');
    } finally {
      setUploadingReceipt(false);
      setUploadProgress(0);
    }
  };

  // Function to handle adding more receipts directly from receipt modal
  const handleAddMoreReceipts = async () => {
    if (!selectedFee) return;

    try {
      let result: any;
      
      // Use documents picker which supports both images and PDFs
      result = await DocumentPicker.getDocumentAsync({
        type: [
          'image/*',
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ],
        multiple: true,
        copyToCacheDirectory: true,
      });

      logger.debug('File picker result:', result); // Debug log

      if (!result.canceled && result.assets) {
        const newFiles = result.assets.map((asset: any) => ({
          uri: asset.uri,
          name: asset.fileName || asset.name || `receipt_${Date.now()}.jpg`,
          type: asset.type || asset.mimeType || 'image/jpeg',
          size: asset.fileSize || asset.size
        }));
        
        logger.debug('Processed new files:', newFiles); // Debug log
        
        // Check file size limit (20 MB = 20 * 1024 * 1024 bytes)
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
        const oversizedFiles = newFiles.filter((file: any) => {
          const fileSize = file.size || 0;
          return fileSize > MAX_FILE_SIZE;
        });

        if (oversizedFiles.length > 0) {
          const fileNames = oversizedFiles.map((file: any) => file.name).join(', ');
          Alert.alert(
            'File Too Large',
            `The following file(s) exceed the 20 MB limit: ${fileNames}`,
            [{ text: 'OK' }]
          );
          return;
        }
        
        // Check for duplicates against existing receipts
        const existingReceipts = selectedFee.receipts || [];
        const filteredNewFiles = newFiles.filter((newFile: any) => {
          return !existingReceipts.some((existingReceipt: any) => 
            existingReceipt.fileName === newFile.name
          );
        });
        
        if (filteredNewFiles.length < newFiles.length) {
          const duplicateCount = newFiles.length - filteredNewFiles.length;
          setReceiptModalError(
            `${duplicateCount} file(s) with the same name already exist and have been skipped.`
          );
          // Auto-clear the error after 5 seconds
          setTimeout(() => setReceiptModalError(null), 9000);
        } else {
          // Clear any existing error if all files were added successfully
          setReceiptModalError(null);
        }

        if (filteredNewFiles.length === 0) {
          return; // All files were duplicates
        }

        setUploadingReceipt(true);
        setUploadProgress(0);

        try {
          const uploadedReceipts = [];

          // Preflight storage quota: if insufficient, fail the entire batch before uploading anything.
          const resolvedSizes = await Promise.all(
            filteredNewFiles.map(async (file: any) => {
              const direct = Number(file?.size);
              if (Number.isFinite(direct) && direct > 0) return direct;
              try {
                const info = await FileSystem.getInfoAsync(file?.uri);
                const infoSize = Number((info as any)?.size);
                if ((info as any)?.exists && Number.isFinite(infoSize) && infoSize > 0) return infoSize;
              } catch {
                // ignore
              }
              try {
                const resp = await fetch(file?.uri);
                const blob = await resp.blob();
                const blobSize = Number(blob?.size);
                if (Number.isFinite(blobSize) && blobSize > 0) return blobSize;
              } catch {
                // ignore
              }
              return 1;
            }),
          );
          const sizes = resolvedSizes.map((sz) => (Number.isFinite(sz) && sz > 0 ? sz : 1));
          const totalBytes = sizes.reduce((sum: number, sz: number) => sum + sz, 0) || filteredNewFiles.length || 1;

          try {
            if (tenantId) {
              const quota = await reconcileTenantStorageUsageViaBackend({ tenantId });
              if (Number.isFinite(quota?.bytes) && Number.isFinite(quota?.limitBytes)) {
                const wouldUse = (quota.bytes || 0) + totalBytes;
                if (wouldUse > quota.limitBytes) {
                  maybeShowStorageLimitReachedAlert(
                    {
                      error: 'storage_limit_reached',
                      usedBytes: quota.bytes,
                      limitBytes: quota.limitBytes,
                      incrementBytes: totalBytes,
                    },
                    'fees.receiptsBatchPreflight',
                  );
                  return;
                }
              }
            }
          } catch (quotaError) {
            logger.warn('Failed to preflight storage quota; proceeding with upload attempt.', quotaError);
          }
          let completedBytes = 0;
          
          for (let i = 0; i < filteredNewFiles.length; i++) {
            const file = filteredNewFiles[i];
            const fileBytes = sizes[i] ?? 1;
            setUploadProgress(Math.max(0, Math.min(100, (completedBytes / totalBytes) * 100)));

            const downloadURL = await uploadReceiptToStorage(file.uri, selectedFee.id, file.name, (p) => {
              const currentUploaded = (Math.max(0, Math.min(100, p)) / 100) * fileBytes;
              const overall = ((completedBytes + currentUploaded) / totalBytes) * 100;
              setUploadProgress(Math.max(0, Math.min(100, overall)));
            });

            completedBytes += fileBytes;
            setUploadProgress(Math.max(0, Math.min(100, (completedBytes / totalBytes) * 100)));
            
            uploadedReceipts.push({
              url: downloadURL,
              fileName: file.name,
              uploadedAt: new Date().toISOString(),
              type: file.type,
              uploadedByName: resolvedTeacherName || user?.email || 'Unknown uploader'
            });
          }

          // Update fee record with new receipts
          const allReceipts = [...existingReceipts, ...uploadedReceipts];
          
          await updateFeeRecord(selectedFee.id, {
            receipts: allReceipts
          } as any);

          // Update the selectedFee state
          setSelectedFee({
            ...selectedFee,
            receipts: allReceipts
          });

          Toast.show({
            type: 'success',
            text1: 'Receipts Added',
            text2: `${uploadedReceipts.length} receipt(s) added successfully`,
            position: 'top',
            visibilityTime: 3000,
          });

        } catch (error) {
          logger.error('Error uploading receipts:', error);
          if (maybeShowStorageLimitReachedAlert(error, 'fees.uploadReceipts')) {
            return;
          }
          Alert.alert('Error', 'Failed to upload receipts');
        } finally {
          setUploadingReceipt(false);
          setUploadProgress(0);
        }
      } else {
        logger.debug('File selection was canceled or no assets found');
      }
    } catch (error) {
      logger.error('Error selecting files:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      Alert.alert('Error', 'Failed to select files: ' + errorMessage);
    }
  };

  const addFilesToReceiptSelection = useCallback((incomingFiles: any[], initialSkipped: string[] = []) => {
    if (!Array.isArray(incomingFiles) || incomingFiles.length === 0) {
      const normalized = Array.from(new Set((initialSkipped || []).filter(Boolean))).slice(0, MAX_SKIPPED_RECEIPT_ITEMS);
      setSkippedReceiptFiles(normalized);
      return;
    }

    const newFiles = incomingFiles
      .map((asset: any) => ({
        uri: asset?.uri,
        name: asset?.fileName || asset?.name || `receipt_${Date.now()}.jpg`,
        type: asset?.type || asset?.mimeType || 'image/jpeg',
        size: asset?.fileSize || asset?.size,
        lastModified: Number(asset?.lastModified || 0) || undefined,
      }))
      .filter((file: any) => typeof file?.uri === 'string' && file.uri.length > 0);

    if (newFiles.length === 0) {
      const normalized = Array.from(new Set((initialSkipped || []).filter(Boolean))).slice(0, MAX_SKIPPED_RECEIPT_ITEMS);
      setSkippedReceiptFiles(normalized);
      return;
    }

    const allowedMimeTypes = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    const allowedExtensions = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx']);
    const skippedEntries: string[] = [...(initialSkipped || [])];
    const unsupportedNames: string[] = [];
    const supportedFiles = newFiles.filter((file: any) => {
      const mime = String(file?.type || '').toLowerCase();
      const fileName = String(file?.name || 'Unknown file');
      if (mime.startsWith('image/')) {
        return true;
      }
      if (allowedMimeTypes.has(mime)) {
        return true;
      }
      const name = fileName.toLowerCase();
      const ext = name.includes('.') ? name.split('.').pop() || '' : '';
      const supported = allowedExtensions.has(ext);
      if (!supported) {
        unsupportedNames.push(fileName);
      }
      return supported;
    });

    if (unsupportedNames.length > 0) {
      skippedEntries.push(...unsupportedNames.map((name) => `[Unsupported] ${name}`));
    }

    if (supportedFiles.length === 0) {
      const normalized = Array.from(new Set(skippedEntries.filter(Boolean))).slice(0, MAX_SKIPPED_RECEIPT_ITEMS);
      setSkippedReceiptFiles(normalized);
      return;
    }

    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
    const oversizedFiles = supportedFiles.filter((file: any) => {
      const fileSize = file.size || 0;
      return fileSize > MAX_FILE_SIZE;
    });

    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles.map((file: any) => file.name).join(', ');
      skippedEntries.push(...oversizedFiles.map((file: any) => `[Too large] ${file.name || 'Unknown file'}`));
      Alert.alert(
        'File Too Large',
        `The following file(s) exceed the 20 MB limit: ${fileNames}`,
        [{ text: 'OK' }]
      );
    }

    const allowedFiles = supportedFiles.filter((file: any) => {
      const fileSize = file.size || 0;
      return fileSize <= MAX_FILE_SIZE;
    });

    const currentSelected = selectedReceiptFilesRef.current || [];
    const existing = new Set(currentSelected.map((file: any) => getReceiptFileIdentity(file)));
    const duplicateNames: string[] = [];
    const toAdd: any[] = [];

    for (const file of allowedFiles) {
      const dedupeKey = getReceiptFileIdentity(file);
      if (existing.has(dedupeKey)) {
        duplicateNames.push(String(file?.name || 'Unknown file'));
        continue;
      }
      existing.add(dedupeKey);
      toAdd.push(file);
    }

    if (duplicateNames.length > 0) {
      skippedEntries.push(...duplicateNames.map((name) => `[Duplicate] ${name}`));
    }

    const nextSelected = toAdd.length > 0 ? [...currentSelected, ...toAdd] : currentSelected;
    setSelectedFiles(nextSelected);
    selectedReceiptFilesRef.current = nextSelected;
    logger.debug('Updated selected files:', nextSelected);

    const normalizedSkipped = Array.from(new Set(skippedEntries.filter(Boolean))).slice(0, MAX_SKIPPED_RECEIPT_ITEMS);
    setSkippedReceiptFiles(normalizedSkipped);
  }, [MAX_SKIPPED_RECEIPT_ITEMS, getReceiptFileIdentity]);

  const handleReceiptDropAreaDragOver = useCallback((event: any) => {
    if (Platform.OS !== 'web' || !showReceiptUpload || uploadingReceipt) {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!isReceiptDropActive) {
      setIsReceiptDropActive(true);
    }
  }, [isReceiptDropActive, showReceiptUpload, uploadingReceipt]);

  const handleReceiptDropAreaDragEnter = useCallback((event: any) => {
    if (Platform.OS !== 'web' || !showReceiptUpload || uploadingReceipt) {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!isReceiptDropActive) {
      setIsReceiptDropActive(true);
    }
  }, [isReceiptDropActive, showReceiptUpload, uploadingReceipt]);

  const handleReceiptDropAreaDragLeave = useCallback((event: any) => {
    if (Platform.OS !== 'web') {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setIsReceiptDropActive(false);
  }, []);

  const handleReceiptDropAreaDrop = useCallback((event: any) => {
    if (Platform.OS !== 'web' || !showReceiptUpload || uploadingReceipt) {
      return;
    }

    event?.preventDefault?.();
    event?.stopPropagation?.();
    setIsReceiptDropActive(false);

    const droppedItems = event?.nativeEvent?.dataTransfer?.items || event?.dataTransfer?.items;
    const folderNames = Array.from(droppedItems || [])
      .map((item: any) => item?.webkitGetAsEntry?.())
      .filter((entry: any) => Boolean(entry?.isDirectory))
      .map((entry: any) => String(entry?.name || 'Folder'));

    if (folderNames.length > 0) {
      const folderMessage = 'Folder upload is not supported. Please drop files directly.';
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(folderMessage);
      } else {
        Alert.alert('Folder Not Supported', folderMessage);
      }
      addFilesToReceiptSelection([], folderNames.map((name) => `[Folder] ${name}`));
      return;
    }

    const droppedFiles = event?.nativeEvent?.dataTransfer?.files || event?.dataTransfer?.files;
    if (!droppedFiles || droppedFiles.length === 0) {
      return;
    }

    const normalized = Array.from(droppedFiles).map((file: any) => {
      const objectUrl =
        typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : null;
      return {
        uri: objectUrl,
        name: file?.name,
        fileName: file?.name,
        type: file?.type,
        mimeType: file?.type,
        fileSize: file?.size,
        size: file?.size,
      };
    });

    addFilesToReceiptSelection(normalized);
  }, [addFilesToReceiptSelection, showReceiptUpload, uploadingReceipt]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !showReceiptUpload) {
      return;
    }

    const blockAndMarkDrag = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsReceiptDropActive(true);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    };

    const blockDragLeave = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsReceiptDropActive(false);
    };

    const handleWindowDrop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsReceiptDropActive(false);

      const folderNames = Array.from(event.dataTransfer?.items || [])
        .map((item: any) => item?.webkitGetAsEntry?.())
        .filter((entry: any) => Boolean(entry?.isDirectory))
        .map((entry: any) => String(entry?.name || 'Folder'));

      if (folderNames.length > 0) {
        const folderMessage = 'Folder upload is not supported. Please drop files directly.';
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
          window.alert(folderMessage);
        } else {
          Alert.alert('Folder Not Supported', folderMessage);
        }
        addFilesToReceiptSelection([], folderNames.map((name) => `[Folder] ${name}`));
        return;
      }

      const droppedFiles = event.dataTransfer?.files;
      if (!droppedFiles || droppedFiles.length === 0) {
        return;
      }
      const normalized = Array.from(droppedFiles).map((file: any) => {
        const objectUrl =
          typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : null;
        return {
          uri: objectUrl,
          name: file?.name,
          fileName: file?.name,
          type: file?.type,
          mimeType: file?.type,
          fileSize: file?.size,
          size: file?.size,
        };
      });
      addFilesToReceiptSelection(normalized);
    };

    window.addEventListener('dragenter', blockAndMarkDrag);
    window.addEventListener('dragover', blockAndMarkDrag);
    window.addEventListener('dragleave', blockDragLeave);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragenter', blockAndMarkDrag);
      window.removeEventListener('dragover', blockAndMarkDrag);
      window.removeEventListener('dragleave', blockDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [addFilesToReceiptSelection, showReceiptUpload]);

  const handleTakeReceiptPhoto = useCallback(async () => {
    try {
      const result = await MediaPickerUtil.captureImage();
      if (result.canceled || !result.assets?.length) return;
      addFilesToReceiptSelection(result.assets);
    } catch (err) {
      logger.warn('Fees: receipt photo capture failed', err);
    }
  }, [addFilesToReceiptSelection]);

  const selectFiles = async (source: 'gallery' | 'documents') => {
    try {
      let result: any;

      switch (source) {
        case 'gallery':
          // Request media library permissions
          const mediaPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (mediaPermission.status !== 'granted') {
            Alert.alert('Permission Denied', 'We need photo library permission to select images.');
            return;
          }
          
          result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: false,
            quality: 0.8,
            allowsMultipleSelection: true,
          });
          break;
          
        case 'documents':
          result = await DocumentPicker.getDocumentAsync({
            type: [
              'image/*',
              'application/pdf',
              'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ],
            multiple: true,
            copyToCacheDirectory: true,
          });
          break;
      }

      logger.debug('File picker result:', result); // Debug log

      if (!result.canceled && result.assets) {
        logger.debug('Processed new files from picker:', result.assets); // Debug log
        addFilesToReceiptSelection(result.assets);
      } else {
        logger.debug('File selection was canceled or no assets found');
      }
    } catch (error) {
      logger.error('Error selecting files:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      Alert.alert('Error', 'Failed to select files: ' + errorMessage);
    }
  };

  const removeSelectedFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const confirmUploadFiles = async () => {
    if (selectedFiles.length === 0) return;

    setUploadingReceipt(true);
    setUploadProgress(0);

    try {
      const uploadedReceipts = [];

      // Preflight storage quota: if insufficient, fail the entire batch before uploading anything.
      const resolvedSizes = await Promise.all(
        selectedFiles.map(async (file: any) => {
          const direct = Number(file?.size);
          if (Number.isFinite(direct) && direct > 0) return direct;
          try {
            const info = await FileSystem.getInfoAsync(file?.uri);
            const infoSize = Number((info as any)?.size);
            if ((info as any)?.exists && Number.isFinite(infoSize) && infoSize > 0) return infoSize;
          } catch {
            // ignore
          }
          try {
            const resp = await fetch(file?.uri);
            const blob = await resp.blob();
            const blobSize = Number(blob?.size);
            if (Number.isFinite(blobSize) && blobSize > 0) return blobSize;
          } catch {
            // ignore
          }
          return 1;
        }),
      );
      const sizes = resolvedSizes.map((sz) => (Number.isFinite(sz) && sz > 0 ? sz : 1));
      const totalBytes = sizes.reduce((sum: number, sz: number) => sum + sz, 0) || selectedFiles.length || 1;

      try {
        if (tenantId) {
          const quota = await reconcileTenantStorageUsageViaBackend({ tenantId });
          if (Number.isFinite(quota?.bytes) && Number.isFinite(quota?.limitBytes)) {
            const wouldUse = (quota.bytes || 0) + totalBytes;
            if (wouldUse > quota.limitBytes) {
              maybeShowStorageLimitReachedAlert(
                {
                  error: 'storage_limit_reached',
                  usedBytes: quota.bytes,
                  limitBytes: quota.limitBytes,
                  incrementBytes: totalBytes,
                },
                'fees.receiptsBatchPreflight',
              );
              return;
            }
          }
        }
      } catch (quotaError) {
        logger.warn('Failed to preflight storage quota; proceeding with upload attempt.', quotaError);
      }
      let completedBytes = 0;
      
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        const fileBytes = sizes[i] ?? 1;
        setUploadProgress(Math.max(0, Math.min(100, (completedBytes / totalBytes) * 100)));

        const downloadURL = await uploadReceiptToStorage(file.uri, selectedFee.id, file.name, (p) => {
          const currentUploaded = (Math.max(0, Math.min(100, p)) / 100) * fileBytes;
          const overall = ((completedBytes + currentUploaded) / totalBytes) * 100;
          setUploadProgress(Math.max(0, Math.min(100, overall)));
        });

        completedBytes += fileBytes;
        setUploadProgress(Math.max(0, Math.min(100, (completedBytes / totalBytes) * 100)));
        
        uploadedReceipts.push({
          url: downloadURL,
          fileName: file.name,
          uploadedAt: new Date().toISOString(),
          type: file.type,
          uploadedByName: resolvedTeacherName || user?.email || 'Unknown uploader'
        });
      }

      // Update fee record with new receipts
      const existingReceipts = selectedFee?.receipts || [];
      const allReceipts = [...existingReceipts, ...uploadedReceipts];
      
      await updateFeeRecord(selectedFee.id, {
        receipts: allReceipts
      } as any);

      // Update the selectedFee state
      setSelectedFee({
        ...selectedFee,
        receipts: allReceipts
      });

      Toast.show({
        type: 'success',
        text1: 'Receipts Uploaded',
        text2: `${uploadedReceipts.length} receipt(s) uploaded successfully`,
        position: 'top',
        visibilityTime: 3000,
      });

      resetReceiptUploadModalState();
      setShowReceiptUpload(false); // Close the upload modal after successful upload
    } catch (error) {
      logger.error('Error uploading receipts:', error);
      if (maybeShowStorageLimitReachedAlert(error, 'fees.uploadReceipts')) {
        return;
      }
      Alert.alert('Error', 'Failed to upload receipts');
    } finally {
      setUploadingReceipt(false);
      setUploadProgress(0);
    }
  };

  // Helper function to check if a file can be previewed in the modal
  const canPreviewFile = (receipt: any): boolean => {
    if (!receipt) return false;
    
    // Check by file extension
    const fileName = receipt.fileName || '';
    const extension = fileName.toLowerCase().split('.').pop();
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
    
    // Also check by MIME type if available
    const mimeType = receipt.type || '';
    const isImageMimeType = mimeType.startsWith('image/');
    
    return imageExtensions.includes(extension || '') || isImageMimeType;
  };

  const handleViewReceipt = (receiptUrl: string) => {
    setSelectedReceipt((current) => {
      if (current === receiptUrl) {
        return null;
      }
      return receiptUrl;
    });
    setShowReceiptModal(true);
  };

  const canOpenReceiptExternally = useCallback((receipt: any) => {
    if (!isNativePlatform) {
      return false;
    }
    return Boolean(receipt?.url && !canPreviewFile(receipt));
  }, [isNativePlatform]);

  const handleOpenReceiptExternally = useCallback(async (receipt: any) => {
    if (!receipt?.url) {
      Alert.alert('Receipt unavailable', 'This receipt does not have a downloadable file.');
      return;
    }

    if (!isNativePlatform) {
      Alert.alert('Not supported', 'Opening this file type is only supported on the mobile app.');
      return;
    }

    setOpeningReceiptUrl(receipt.url);

    try {
      const downloadDirectory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (!downloadDirectory) {
        throw new Error('No writable directory available for downloading receipts');
      }

      const fileName = buildReceiptDownloadFileName(receipt);
      const targetPath = `${downloadDirectory}${fileName}`;

      try {
        await FileSystem.deleteAsync(targetPath, { idempotent: true });
      } catch (cleanupError) {
        logger.warn('Failed to clean cached receipt file', cleanupError);
      }

      const downloadResult = await FileSystem.downloadAsync(receipt.url, targetPath);
      const mimeType = receipt.type || getMimeTypeFromFileName(receipt.fileName || '') || 'application/octet-stream';

      if (Platform.OS === 'android') {
        const contentUri = await FileSystem.getContentUriAsync(downloadResult.uri);
        try {
          await IntentLauncher.startActivityAsync(RECEIPT_ANDROID_VIEW_INTENT, {
            data: contentUri,
            type: mimeType,
            flags: RECEIPT_FLAG_GRANT_READ_URI_PERMISSION | RECEIPT_FLAG_ACTIVITY_NEW_TASK,
          });
        } catch (intentError) {
          logger.warn('Receipt intent launch failed, falling back to Linking', intentError);
          await Linking.openURL(contentUri);
        }
        return;
      }

      await Linking.openURL(downloadResult.uri);
    } catch (error) {
      logger.error('Error opening receipt document:', error);
      Alert.alert('Error', 'Unable to open this receipt on your device.');
    } finally {
      setOpeningReceiptUrl(null);
    }
  }, [isNativePlatform]);

  const handleDeleteReceipt = async (receiptIndex: number) => {
    if (!selectedFee) return;

    logger.debug('Delete receipt called for index:', receiptIndex); // Debug log
    logger.debug('Selected fee receipts:', selectedFee.receipts); // Debug log

    const receipts = selectedFee.receipts || [];
    const receiptToDeleteData = receipts[receiptIndex];
    
    if (receiptToDeleteData) {
      setReceiptToDelete({ index: receiptIndex, receipt: receiptToDeleteData });
      setShowDeleteReceiptModal(true);
    } else {
      logger.error('Receipt not found at index:', receiptIndex);
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Receipt not found',
        position: 'top',
        visibilityTime: 3000,
      });
    }
  };

  const confirmDeleteReceipt = async () => {
    if (!selectedFee || !receiptToDelete) return;

    setDeletingReceipt(true); // Start loading state
    
    try {
      const receipts = selectedFee.receipts || [];
      const receiptData = receiptToDelete.receipt;
      const receiptIndex = receiptToDelete.index;
      
      logger.debug('Receipt to delete:', receiptData); // Debug log
      
      // Delete from Firebase Storage first
      logger.debug('Deleting from storage...'); // Debug log
      await deleteReceiptFromStorage(receiptData.url);
      
      // Update fee record in Firestore
      logger.debug('Updating fee record...'); // Debug log
      const updatedReceipts = receipts.filter((_: any, index: number) => index !== receiptIndex);
      await updateFeeRecord(selectedFee.id, {
        receipts: updatedReceipts
      } as any);

      // Update the selectedFee state to reflect the change
      logger.debug('Updating local state...'); // Debug log
      setSelectedFee({
        ...selectedFee,
        receipts: updatedReceipts
      });

      logger.debug('Receipt deletion completed successfully'); // Debug log
      
      // Close the delete modal and reset state
      setShowDeleteReceiptModal(false);
      setReceiptToDelete(null);
      
      // Show success toast notification
      Toast.show({
        type: 'success',
        text1: 'Receipt Deleted Successfully!',
        text2: 'The receipt has been permanently removed',
        position: 'top',
        visibilityTime: 3000,
      });
      
      // Keep the receipt modal open so user can continue managing receipts
      
    } catch (error) {
      logger.error('Error deleting receipt:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      Toast.show({
        type: 'error',
        text1: 'Delete Failed',
        text2: 'Failed to delete receipt: ' + errorMessage,
        position: 'top',
        visibilityTime: 4000,
      });
      
      // Close the delete modal on error
      setShowDeleteReceiptModal(false);
      setReceiptToDelete(null);
    } finally {
      setDeletingReceipt(false); // End loading state
    }
  };

  const handleMarkAsPaid = (fee: any) => {
    // Get the latest fee data from the fees array to ensure we have the most up-to-date payment transactions
    const latestFee = fees.find(f => f.id === fee.id) || fee;
    
    const category = categorizeFee(latestFee);
    const isPartial = category === 'partial';
    const correctAmount = getCorrectFeeAmount(latestFee);
    const remainingAmount = correctAmount - (latestFee.paidAmount || 0);
    
    setSelectedFee(latestFee);
    setPaymentForm({
      method: '',
      amount: isPartial ? remainingAmount.toString() : correctAmount.toString(),
      date: formatDateToString(new Date()),
      paidBy: '',
      accountDetails: '',
      transactionId: '',
      notes: '',
      isPartial,
      paymentType: 'full',
      selectedMonths: [],
  monthlyAmount: latestFee.monthlyFeeAmount ? latestFee.monthlyFeeAmount.toString() : '',
  sendReminder: false, // unchecked by default
  reminderChannel: reminderPrefs.reminderChannel,
  selectedLanguage: reminderPrefs.selectedLanguage,
  languageOrder: reminderPrefs.languageOrder,
    });
    // Clear any previous form errors
    setFormErrors({});
    setShowPaymentModal(true);
  };

  const handleFeeClick = (fee: any) => {
    // Get the latest fee data from the fees array to ensure we have the most up-to-date payment transactions
    const latestFee = fees.find(f => f.id === fee.id) || fee;
    
    setSelectedFee(latestFee);
    // Calculate monthly fee from total amount and months covered
    const monthlyFee = latestFee.monthlyFeeAmount || (latestFee.monthsCovered && latestFee.monthsCovered.length > 1 ? Math.round(latestFee.amount / latestFee.monthsCovered.length) : latestFee.amount);
    
    // Load reminder history for this fee
    loadFeeReminderHistory(latestFee);
    
    setFeeEditForm({
      studentName: latestFee.studentName,
      amount: latestFee.amount.toString(),
      dueDate: latestFee.dueDate,
      monthlyFee: monthlyFee.toString(),
      type: latestFee.type || 'tuition',
      description: latestFee.description || '',
      status: latestFee.status || categorizeFee(latestFee),
      paidAmount: latestFee.paidAmount?.toString() || '',
      paidDate: latestFee.paidDate || '',
      method: latestFee.method || ''
    });
    setShowFeeDetailsModal(true);
  };

  // Form validation function
  const validatePaymentForm = () => {
    const errors: { [key: string]: string } = {};
    
    // Validate amount
    if (!paymentForm.amount) {
      errors.amount = 'Payment amount is required';
    } else {
      const amount = parseFloat(paymentForm.amount);
      if (isNaN(amount) || amount <= 0) {
        errors.amount = 'Please enter a valid amount';
      }
    }
    
    // Validate date
    if (!paymentForm.date) {
      errors.date = 'Payment date is required';
    } else {
      const selectedDate = new Date(paymentForm.date);
      const today = new Date();
      today.setHours(23, 59, 59, 999); // End of today
      
      if (selectedDate > today) {
        errors.date = 'Payment date cannot be in the future';
      }
    }
    
    // Validate payment method
    if (!paymentForm.method) {
      errors.method = 'Payment method is required';
    }
    
    // Validate paid by
    if (!paymentForm.paidBy) {
      errors.paidBy = 'Please specify who made the payment';
    }
    
    // Validate individual months selection for consolidated fees
    if (paymentForm.paymentType === 'individual' && 
        selectedFee?.monthsCovered && 
        selectedFee.monthsCovered.length > 1 &&
        (!paymentForm.selectedMonths || paymentForm.selectedMonths.length === 0)) {
      errors.selectedMonths = 'Please select at least one month to pay for';
    }
    
    return errors;
  };

  // Clear form errors when user starts typing
  const clearFieldError = (fieldName: string) => {
    if (formErrors[fieldName as keyof typeof formErrors]) {
      setFormErrors(prev => ({ ...prev, [fieldName]: undefined }));
    }
  };

  const performPaymentSubmit = async () => {
    // Prevent double submission
    if (confirmingPayment) return;

    if (!selectedFee || !paymentForm.amount) {
      Alert.alert('Error', 'Please fill in required fields');
      return;
    }

    setConfirmingPayment(true);
    try {
      const paymentAmount = parseFloat(paymentForm.amount);

      // Normalize method and compute shared fields
      const normalizeMethod = (m?: string) => (m ? String(m).toLowerCase().replace(/[^a-z0-9]/g, '') : undefined);
      const methodNormalized = normalizeMethod(paymentForm.method);

      // Use end-user chosen date with current time to ensure ISO timestamp
      const isoAtDay = new Date(paymentForm.date + 'T' + new Date().toTimeString().split(' ')[0]).toISOString();
      const dbClient = getFirestoreClient();

      if (paymentForm.paymentType === 'individual' && selectedFee.monthsCovered && selectedFee.monthsCovered.length > 1) {
        // Handle individual month payment for consolidated fees
        if (!paymentForm.selectedMonths || paymentForm.selectedMonths.length === 0) {
          Alert.alert('Error', 'Please select at least one month to pay for');
          return;
        }

        // Calculate expected amount based on remaining amounts for selected months
        const expectedAmount = paymentForm.selectedMonths.reduce((sum, month) => {
          return sum + getRemainingAmountForMonth(selectedFee, month);
        }, 0);

        if (Math.abs(paymentAmount - expectedAmount) > 0.01) {
          Alert.alert('Error', `Payment amount should be ₹${expectedAmount.toLocaleString()} for ${paymentForm.selectedMonths.length} month(s) (remaining amounts)`);
          return;
        }

        // Update the existing fee to mark selected months as paid
        const existingPaidMonths = selectedFee.paidMonths || [];
        const newPaidMonths = [...new Set([...existingPaidMonths, ...paymentForm.selectedMonths])];
        const newPaidAmount = (selectedFee.paidAmount || 0) + paymentAmount;
        const newStatus = newPaidMonths.length >= selectedFee.monthsCovered.length ? 'paid' : 'partial';

        // Update fee document
        const pp1 = preparePaymentDetails(selectedFee.paymentDetails, {
          paidBy: paymentForm.paidBy,
          accountDetails: paymentForm.accountDetails,
          transactionId: paymentForm.transactionId,
          notes: paymentForm.notes,
          paymentDate: isoAtDay,
          amount: paymentAmount,
          monthsPaid: paymentForm.selectedMonths,
          method: paymentForm.method,
          type: 'individual_months'
        });

        await updateFeeRecord(selectedFee.id!, {
          paidAmount: newPaidAmount,
          paidMonths: newPaidMonths,
          status: newStatus,
          paidDate: newStatus === 'paid' ? isoAtDay : selectedFee.paidDate,
          method: paymentForm.method,
          paymentDetails: pp1.details
        });

        // Write to dedicated payments subcollection for exact paymentDate filtering
        try {
          const paymentDocRef = docClient(dbClient, 'fees', selectedFee.id!, 'payments', pp1.paymentKey);
          const basePayload: any = {
            tenantId,
            feeId: selectedFee.id!,
            studentId: selectedFee.studentId,
            studentName: selectedFee.studentName,
            amount: paymentAmount,
            method: paymentForm.method,
            paymentDate: isoAtDay,
            monthsPaid: paymentForm.selectedMonths,
            type: 'individual',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          if (methodNormalized) basePayload.methodNormalized = methodNormalized;
          if (paymentForm.transactionId && paymentForm.transactionId.trim()) basePayload.transactionId = paymentForm.transactionId.trim();
          if (paymentForm.accountDetails && paymentForm.accountDetails.trim()) basePayload.accountDetails = paymentForm.accountDetails.trim();
          if (paymentForm.notes && paymentForm.notes.trim()) basePayload.notes = paymentForm.notes.trim();
          if (paymentForm.paidBy && paymentForm.paidBy.trim()) basePayload.paidBy = paymentForm.paidBy.trim();
          await setDocClient(paymentDocRef, basePayload);
        } catch (e) {
          logger.warn('Failed to write payments subdocument (individual):', e);
        }

        Toast.show({
          type: 'success',
          text1: 'Payment Recorded Successfully!',
          text2: `Paid ₹${paymentAmount.toLocaleString()} for ${paymentForm.selectedMonths.length} month(s)`,
          position: 'top',
          visibilityTime: 3000,
        });
      } else {
        // Handle regular full/partial payment (general payment distributed chronologically)
        const totalAmount = selectedFee.amount;
        const paidAmount = selectedFee.paidAmount || 0;
        const remainingAmount = totalAmount - paidAmount;

        if (paymentAmount > remainingAmount) {
          Alert.alert('Error', 'Payment amount cannot exceed remaining balance');
          return;
        }

        const newPaidAmount = paidAmount + paymentAmount;
        const newStatus = newPaidAmount >= totalAmount ? 'paid' : 'pending';

        const pp2 = preparePaymentDetails(selectedFee.paymentDetails, {
          paidBy: paymentForm.paidBy,
          accountDetails: paymentForm.accountDetails,
          transactionId: paymentForm.transactionId,
          notes: paymentForm.notes,
          paymentDate: isoAtDay,
          amount: paymentAmount,
          method: paymentForm.method,
          type: 'general_payment'
          // Note: No monthsPaid field means this will be distributed chronologically
        });

        await updateFeeRecord(selectedFee.id!, {
          paidAmount: newPaidAmount,
          status: newStatus,
          paidDate: paymentAmount >= remainingAmount ? isoAtDay : selectedFee.paidDate,
          method: paymentForm.method,
          paymentDetails: pp2.details
        });

        // Write to dedicated payments subcollection (general)
        try {
          const paymentDocRef = docClient(dbClient, 'fees', selectedFee.id!, 'payments', pp2.paymentKey);
          const basePayload: any = {
            tenantId,
            feeId: selectedFee.id!,
            studentId: selectedFee.studentId,
            studentName: selectedFee.studentName,
            amount: paymentAmount,
            method: paymentForm.method,
            paymentDate: isoAtDay,
            type: 'general',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          if (methodNormalized) basePayload.methodNormalized = methodNormalized;
          if (paymentForm.transactionId && paymentForm.transactionId.trim()) basePayload.transactionId = paymentForm.transactionId.trim();
          if (paymentForm.accountDetails && paymentForm.accountDetails.trim()) basePayload.accountDetails = paymentForm.accountDetails.trim();
          if (paymentForm.notes && paymentForm.notes.trim()) basePayload.notes = paymentForm.notes.trim();
          if (paymentForm.paidBy && paymentForm.paidBy.trim()) basePayload.paidBy = paymentForm.paidBy.trim();
          await setDocClient(paymentDocRef, basePayload);
        } catch (e) {
          logger.warn('Failed to write payments subdocument (general):', e);
        }

        Toast.show({
          type: 'success',
          text1: 'Payment Recorded Successfully!',
          text2: `Paid ₹${paymentAmount.toLocaleString()} for ${selectedFee.studentName}`,
          position: 'top',
          visibilityTime: 3000,
        });
      }

      // Optionally notify parents after marking paid (payment received confirmation)
      if (paymentForm.sendReminder && selectedFee?.studentId) {
        if (!tenantId) {
          Alert.alert('Select Coaching Center', 'Please select a coaching center before sending reminders.');
        } else {
          try {
            const student = students.find(s => s.id === selectedFee.studentId);
            const amountForMessage = paymentAmount; // confirmation should reflect actual paid amount
            const paymentDateStr = paymentForm.date || formatDateToString(new Date());
            const parentPhone = student?.parentContact || student?.parentPhone || '';
            const parentWhatsApp = student?.parentWhatsApp || parentPhone;
            const teacherNameForSig = resolvedTeacherName;
            const coachingNameForSig = resolvedCoachingName;

            if (paymentForm.reminderChannel === 'whatsapp' && parentWhatsApp) {
              // Save pending history entry for WhatsApp
              const parentLabelWA = student?.parentName?.trim() || (paymentForm.selectedLanguage === 'hindi' ? 'अभिभावक' : 'Parent');
              let savedReminderId: string | null = null;
              try {
                savedReminderId = await reminderHistoryService.saveReminder({
                  tenantId,
                  userId: user?.uid || 'unknown',
                  studentId: selectedFee.studentId,
                  studentName: selectedFee.studentName,
                  parentName: parentLabelWA,
                  parentContact: parentWhatsApp || '',
                  parentEmail: student?.parentEmail || undefined,
                  reminderType: 'whatsapp',
                  status: 'pending',
                  message: paymentMessagePreview || '',
                  amount: amountForMessage,
                  dueDate: paymentDateStr,
                  feeCategories: selectedFee?.type || selectedFee?.description ? [
                    `${selectedFee?.type || 'tuition'}${selectedFee?.description ? ' - ' + selectedFee.description : ''}`
                  ] : [],
                  settings: {
                    useCustomMessage: false,
                    useCustomNotes: !!(paymentForm.notes && paymentForm.notes.trim()),
                    language: paymentForm.selectedLanguage,
                    coachingName: coachingNameForSig,
                    teacherName: teacherNameForSig,
                  },
                  metadata: { deliveryStatus: 'pending' },
                } as any);
              } catch (e) {
                logger.warn('Failed to save reminder history (WhatsApp pre-send). Proceeding to send.', e);
              }

              const waOk = await notificationService.sendSmartWhatsAppPaymentReceived({
                tenantId,
                to: parentWhatsApp,
                parentName: student?.parentName,
                studentName: selectedFee.studentName,
                amount: amountForMessage,
                paymentDate: paymentDateStr,
                greeting: 'Dear', // default greeting per requirement
                // Leave undefined when empty so the backend applies the
                // language-correct default (English "No additional note" /
                // Hindi "कोई अतिरिक्त नोट नहीं") per the selected template.
                additionalNote: paymentForm.notes?.trim() || undefined,
                teacherName: teacherNameForSig,
                coachingName: coachingNameForSig,
                selectedLanguage: paymentForm.selectedLanguage,
                languageOrder: paymentForm.languageOrder,
              });

              // Update reminder history status based on result
              if (savedReminderId) {
                await reminderHistoryService.updateReminderStatus(
                  tenantId,
                  savedReminderId,
                  waOk ? 'success' : 'failed',
                  waOk ? undefined : 'WhatsApp send failed',
                  { deliveryStatus: waOk ? 'sent' : 'failed' }
                );
              }
            } else if (paymentForm.reminderChannel === 'sms' && parentPhone) {
              // SMS confirmation: use reminder settings for signature lines
              const teacher = teacherNameForSig || '-';
              const coaching = coachingNameForSig || 'S.S Tuition Classes';
              const parentEn = student?.parentName?.trim() || 'Parent';
              const parentHi = student?.parentName?.trim() || 'अभिभावक';
              const smsNote = paymentForm.notes?.trim() || '';
              const amt = `₹${amountForMessage.toLocaleString()}`;
              const studentName = selectedFee.studentName;

              const enLinesSMS = [
                `Dear ${parentEn}, we have received payment of ${amt} for ${studentName} on ${paymentDateStr}.`,
                ...(smsNote ? [`Additional note: ${smsNote}.`] : []),
                `Thank you for your payment!`,
                `Regards,`,
                `${teacher}`,
                `${coaching}`,
                `Have a nice day!`,
              ];
              const hiLinesSMS = [
                `प्रिय ${parentHi}, हमें ${studentName} के लिए ${paymentDateStr} को ${amt} का भुगतान प्राप्त हुआ है।`,
                ...(smsNote ? [`अतिरिक्त नोट: ${smsNote}।`] : []),
                `आपके भुगतान के लिए धन्यवाद!`,
                `सादर,`,
                `${teacher}`,
                `${coaching}`,
                `आपका दिन शुभ हो!`,
              ];

              // Build SMS with single combined note placed between language blocks
              const enBlockSMS = enLinesSMS.join('\n');
              const hiBlockSMS = hiLinesSMS.join('\n');
              const stripNote = (text: string) => text.split('\n').filter(l => !l.startsWith('Additional note:') && !l.startsWith('अतिरिक्त नोट')).join('\n');

              let finalSmsMessage = enBlockSMS; // default English
              if (paymentForm.selectedLanguage === 'hindi') {
                finalSmsMessage = hiBlockSMS;
              } else if (paymentForm.selectedLanguage === 'both') {
                const englishFirst = paymentForm.languageOrder === 'english-first';
                const first = englishFirst ? stripNote(enBlockSMS) : stripNote(hiBlockSMS);
                const second = englishFirst ? stripNote(hiBlockSMS) : stripNote(enBlockSMS);
                const middle = smsNote ? `\n\nAdditional note/अतिरिक्त नोट: ${smsNote}.\n\n` : `\n\n`;
                finalSmsMessage = `${first}${middle}${second}`;
              }

              const smsTo = normalizePhoneE164(parentPhone);

              // Save pending history entry for SMS
              const parentLabelSMS = student?.parentName?.trim() || (paymentForm.selectedLanguage === 'hindi' ? 'अभिभावक' : 'Parent');
              let savedReminderId: string | null = null;
              try {
                savedReminderId = await reminderHistoryService.saveReminder({
                  tenantId,
                  userId: user?.uid || 'unknown',
                  studentId: selectedFee.studentId,
                  studentName: selectedFee.studentName,
                  parentName: parentLabelSMS,
                  parentContact: parentPhone || '',
                  parentEmail: student?.parentEmail || undefined,
                  reminderType: 'sms',
                  status: 'pending',
                  message: finalSmsMessage,
                  amount: amountForMessage,
                  dueDate: paymentDateStr,
                  feeCategories: selectedFee?.type || selectedFee?.description ? [
                    `${selectedFee?.type || 'tuition'}${selectedFee?.description ? ' - ' + selectedFee.description : ''}`
                  ] : [],
                  settings: {
                    useCustomMessage: false,
                    useCustomNotes: !!(paymentForm.notes && paymentForm.notes.trim()),
                    language: paymentForm.selectedLanguage,
                    coachingName: coachingNameForSig,
                    teacherName: teacherNameForSig,
                  },
                  metadata: { deliveryStatus: 'pending' },
                } as any);
              } catch (e) {
                logger.warn('Failed to save reminder history (SMS pre-send). Proceeding to send.', e);
              }

              const smsOk = await notificationService.sendSMSReminder({ tenantId, to: smsTo, message: finalSmsMessage });

              // Update reminder history status accordingly
              if (savedReminderId) {
                await reminderHistoryService.updateReminderStatus(
                  tenantId,
                  savedReminderId,
                  smsOk ? 'success' : 'failed',
                  smsOk ? undefined : 'SMS send failed',
                  { deliveryStatus: smsOk ? 'sent' : 'failed' }
                );
              }
            }
          } catch (e) {
            logger.warn('Failed to send optional fee reminder after payment', e);
            // Mark reminder as failed if we created a history entry
            // Note: If savedReminderId isn't accessible in this scope due to earlier errors, this will be a no-op
            try {
              // Attempt a best-effort: we can't retrieve the id here without refactor
            } catch {}
          }
        }
      }

      setShowPaymentModal(false);
    } catch (error) {
      logger.error('Error recording payment:', error);
      Alert.alert('Error', 'Failed to record payment');
    } finally {
      setConfirmingPayment(false);
    }
  };

  const handlePaymentSubmit = async () => {
    // Prevent double submission
    if (confirmingPayment) return;

    // Validate form before showing confirmation
    const errors = validatePaymentForm();
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    if (!selectedFee || !paymentForm.amount) {
      Alert.alert('Error', 'Please fill in required fields');
      return;
    }

    const parsedAmount = parseFloat(paymentForm.amount);
    const amountLabel = Number.isFinite(parsedAmount) ? `₹${parsedAmount.toLocaleString()}` : paymentForm.amount;
    const studentLabel = selectedFee.studentName || 'this student';
    const warning = "Once recorded, a payment can't be edited later. If needed, you can only delete the payment record.";

    setConfirmationData({
      title: 'Confirm payment?',
      message: `${warning}\n\nRecord ${amountLabel} for ${studentLabel}?`,
      confirmButtonText: 'Confirm Payment',
      cancelButtonText: 'Cancel',
      confirmButtonColor: theme.success,
      onConfirm: async () => {
        setShowConfirmationModal(false);
        await performPaymentSubmit();
      },
      onCancel: () => {
        setShowConfirmationModal(false);
      },
    });
    setShowConfirmationModal(true);
  };

  const handleFeeUpdate = async () => {
    if (!selectedFee || !feeEditForm.dueDate) {
      Alert.alert('Error', 'Please fill in required fields');
      return;
    }

    try {
      // Update the fee record with new values (amount is not editable, so we don't update it)
      await updateFeeRecord(selectedFee.id!, {
        dueDate: feeEditForm.dueDate,
        description: feeEditForm.description,
        monthlyFeeAmount: parseFloat(feeEditForm.monthlyFee),
      });

      Toast.show({
        type: 'success',
        text1: 'Fee Updated Successfully!',
        text2: `Updated fee for ${feeEditForm.studentName}`,
        position: 'top',
        visibilityTime: 3000,
      });
      setShowFeeDetailsModal(false);
    } catch (error) {
      logger.error('Error updating fee:', error);
      Alert.alert('Error', 'Failed to update fee');
    }
  };

  const handleDeleteFee = (fee: any) => {
    // Get the latest fee data from the fees array to ensure we have the most up-to-date payment transactions
    const latestFee = fees.find(f => f.id === fee.id) || fee;
    setSelectedFee(latestFee);
    setIsDeletingFee(false);
    setShowDeleteModal(true);
  };

  const confirmDeleteFee = async () => {
    if (!selectedFee || isDeletingFee) return;
    setIsDeletingFee(true);
    
    try {
      // Pass current user info for attribution
      const deletedBy = user?.displayName || user?.email?.split('@')[0] || 'Unknown User';
      await deleteFeeRecord(selectedFee.id, deletedBy, 'Fee deleted');
      Toast.show({
        type: 'success',
        text1: 'Fee Deleted Successfully!',
        text2: 'The fee record has been permanently removed',
        position: 'top',
        visibilityTime: 3000,
      });
      setShowDeleteModal(false);
      setSelectedFee(null);
    } catch (error) {
      logger.error('Error deleting fee:', error);
      Toast.show({
        type: 'error',
        text1: 'Delete Failed',
        text2: 'Failed to delete the fee record. Please try again.',
        position: 'top',
        visibilityTime: 3000,
      });
    } finally {
      setIsDeletingFee(false);
    }
  };

  const handleDeletePayment = (paymentId: string, payment: any, feeId: string) => {
    setPaymentToDelete({ paymentId, payment, feeId });
    setShowDeletePaymentModal(true);
  };

  const confirmDeletePayment = async () => {
    if (!paymentToDelete) return;
    
    setDeletingPayment(true);
    try {
      const result = await deletePaymentRecord(paymentToDelete.feeId, paymentToDelete.paymentId);
      
      // Optimistically update the selected fee locally to reflect deletion immediately
      setExpandedPayments(prev => {
        const clone = { ...prev };
        delete clone[paymentToDelete.paymentId];
        return clone;
      });

      setSelectedFee((prev: any) => {
        if (!prev || prev.id !== paymentToDelete.feeId) {
          // Fallback to the fresh fee from store if available
          const storeFee = fees.find(f => f.id === paymentToDelete.feeId);
          return storeFee || prev;
        }

        const paymentDetails = { ...(prev.paymentDetails || {}) };
        delete (paymentDetails as any)[paymentToDelete.paymentId];

        // Recompute paidAmount and paidMonths from remaining payments
        let newPaidAmount = 0;
        let newPaidMonths: string[] = [];
        let latestPaymentTs = Number.NEGATIVE_INFINITY;
        let latestPaymentDateValue: any = undefined;
        let latestPaymentMethodValue: any = undefined;
        Object.values(paymentDetails as any).forEach((p: any) => {
          if (p && p.amount) {
            const amt = typeof p.amount === 'string' ? Number(p.amount) : p.amount;
            if (Number.isFinite(amt)) newPaidAmount += amt;
          }
          if (p && Array.isArray(p.monthsPaid)) newPaidMonths.push(...p.monthsPaid);

          const rawDate = p?.paymentDate;
          if (rawDate) {
            const parsed = (typeof rawDate === 'object' && typeof rawDate?.toDate === 'function')
              ? rawDate.toDate()
              : new Date(rawDate);
            const ts = parsed instanceof Date ? parsed.getTime() : Number.NaN;
            if (!Number.isNaN(ts) && ts > latestPaymentTs) {
              latestPaymentTs = ts;
              latestPaymentDateValue = rawDate;
              latestPaymentMethodValue = p?.method;
            }
          }
        });
        newPaidMonths = Array.from(new Set(newPaidMonths));

        const resolvedNewPaidAmount = result?.newPaidAmount ?? newPaidAmount;
        const resolvedNewStatus = result?.newStatus ?? (resolvedNewPaidAmount >= (prev.amount || 0)
          ? 'paid'
          : resolvedNewPaidAmount > 0
            ? 'partial'
            : 'pending');
        const shouldClearAllPaymentMeta = resolvedNewPaidAmount === 0;
        const shouldClearPaidDate = resolvedNewStatus !== 'paid';

        return {
          ...prev,
          paymentDetails,
          paidAmount: resolvedNewPaidAmount,
          paidMonths: newPaidMonths,
          status: resolvedNewStatus,
          paidDate: shouldClearPaidDate ? null : (latestPaymentDateValue ?? prev.paidDate),
          method: shouldClearAllPaymentMeta ? null : (latestPaymentMethodValue ?? prev.method),
          paymentMethod: shouldClearAllPaymentMeta ? null : (latestPaymentMethodValue ?? prev.paymentMethod),
          updatedAt: new Date().toISOString(),
        };
      });
      
      showCustomToastMessage(
        'success', 
        'Payment Deleted Successfully!', 
        `Deleted payment of ₹${paymentToDelete.payment.amount?.toLocaleString() || '0'}. New total: ₹${(result?.newPaidAmount ?? 0).toLocaleString()}`
      );
      
      setShowDeletePaymentModal(false);
      setPaymentToDelete(null);
    } catch (error) {
      logger.error('Error deleting payment:', error);
      showCustomToastMessage('error', 'Delete Failed', 'Failed to delete payment record');
    } finally {
      setDeletingPayment(false);
    }
  };

  const handleAddFee = async () => {
    if (!addFeeForm.studentId || !addFeeForm.amount || !addFeeForm.dueMonth) {
      Alert.alert('Error', 'Please fill in required fields');
      return;
    }

    // Validate individual month fees if the editor is enabled
    if (showIndividualMonthEditor) {
      const months = calculateMonthsToCreate(addFeeForm.dueMonth, addFeeForm.studentId);
      const hasEmptyFees = months.some(month => !monthFeeAmounts[month] || parseFloat(monthFeeAmounts[month]) <= 0);
      if (hasEmptyFees) {
        Alert.alert('Error', 'Please enter a valid amount for all months');
        return;
      }
    }

    try {
      const selectedStudent = students.find(s => s.id === addFeeForm.studentId);
      if (!selectedStudent) {
        Alert.alert('Error', 'Selected student not found');
        return;
      }

      const currentMonth = getCurrentMonth();
      const selectedMonth = addFeeForm.dueMonth;

      if (selectedMonth > currentMonth) {
        Alert.alert(
          'Future Month Disabled',
          'Adding fees for future months is temporarily disabled. Please select the current month or an earlier month.',
        );
        return;
      }
      
      // Check for existing fees for this student
      const existingFees = fees.filter(fee => fee.studentId === addFeeForm.studentId);
      const dueFees = existingFees.filter(fee => fee.status !== 'paid');
      const paidFees = existingFees.filter(fee => fee.status === 'paid');

      // Determine if any new months need to be created or extended
      const requestedMonthsRaw = calculateMonthsToCreate(selectedMonth, selectedStudent.id);
      let normalizedRequestedMonths = Array.from(new Set(
        requestedMonthsRaw
          .map(month => normalizeMonthString(month) || month)
          .filter((value): value is string => Boolean(value))
      ));

      const normalizedSelectedMonth = normalizeMonthString(selectedMonth);
      if (normalizedSelectedMonth && normalizedRequestedMonths.length === 0) {
        normalizedRequestedMonths = [normalizedSelectedMonth];
      }

      const existingMonthsForStudent = collectExistingMonthsForStudent(selectedStudent.id);
      const monthsPendingCreation = normalizedRequestedMonths.filter(month => !existingMonthsForStudent.has(month));

      if (normalizedRequestedMonths.length > 0 && monthsPendingCreation.length === 0) {
        const monthLabels = normalizedRequestedMonths.map(month =>
          generateMonthOptions.find(m => m.value === month)?.label || month
        );
        const monthSummary = monthLabels.length > 1
          ? `${monthLabels[0]} to ${monthLabels[monthLabels.length - 1]}`
          : monthLabels[0] || 'the selected months';

        Toast.show({
          type: 'info',
          text1: 'No new months to add',
          text2: `${selectedStudent.name} already has fees recorded for ${monthSummary}.`,
          position: 'top',
          visibilityTime: 3500,
        });
        return;
      }

      // New logic based on user requirements:
      
      // Case 3: If only paid fees exist, extend the most recent paid fee (mirroring auto-approval behavior)
      if (paidFees.length > 0 && dueFees.length === 0) {
        await handleExtendPaidFee(paidFees, selectedStudent, selectedMonth);
        return;
      }

      // Case 1 & 2: If there are existing due fees, check if current month is included
      if (dueFees.length > 0) {
        // If user selected a future month, always create separately (never consolidate with existing)
        if (selectedMonth > currentMonth) {
          await handleCreateNewFee(selectedStudent, selectedMonth);
          return;
        }

        // Check if any existing fee covers the current month
        const currentMonthCovered = dueFees.some(fee => {
          // Check both regular fees with dueDate in current month and consolidated fees covering current month
          const feeMonth = fee.dueDate.substring(0, 7); // Extract YYYY-MM from dueDate
          const monthsCovered = fee.monthsCovered || [];
          return feeMonth === currentMonth || monthsCovered.includes(currentMonth);
        });

        if (currentMonthCovered) {
          // Case 2: Current month is already included, check for overlapping ranges
          await handleUpdateCurrentMonthFeeWithOverlapCheck(dueFees, currentMonth, selectedMonth, selectedStudent);
          return;
        } else {
          // Case 1: Current month not included, check for future fees and discontinuous coverage
          await handleAddCurrentMonthWithContinuityCheck(dueFees, currentMonth, selectedMonth, selectedStudent);
          return;
        }
      }

      // Fallback: No existing fees, create new fee structure
      await handleCreateNewFee(selectedStudent, selectedMonth);

    } catch (error) {
      logger.error('Error in handleAddFee:', error);
      Alert.alert('Error', 'Failed to create fee records. Please try again.');
    }
  };

  const handleCreateNewFee = async (selectedStudent: any, selectedMonth: string) => {
    // Calculate months from selected month to current month (considering due dates)
    const startMonth = selectedMonth;
    const currentMonth = getCurrentMonth();

    if (startMonth > currentMonth) {
      Alert.alert(
        'Future Month Disabled',
        'Adding fees for future months is temporarily disabled. Please select the current month or an earlier month.',
      );
      return;
    }
    
    const [startYear, startMonthNum] = startMonth.split('-').map(Number);
    const [currentYear, currentMonthNum] = currentMonth.split('-').map(Number);
    
    // Get student's due date to determine if current month should be included
    const dueDay = selectedStudent?.feeDueDate || 1;
    const today = new Date();
    const currentDay = today.getDate();
    
    const monthsToCreate: string[] = [];
    
    // If selected month is current month, always create it (user explicitly selected it)
    if (startMonth === currentMonth) {
      monthsToCreate.push(startMonth);
    }
    // If selected month is in the past, create fees from that month to current month (conditionally)
    else {
      let year = startYear;
      let month = startMonthNum;
      
      while (year < currentYear || (year === currentYear && month < currentMonthNum)) {
        const monthValue = `${year}-${month.toString().padStart(2, '0')}`;
        monthsToCreate.push(monthValue);
        
        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
      
      // Add current month only if due date has passed
      if (year === currentYear && month === currentMonthNum && currentDay >= dueDay) {
        const monthValue = `${year}-${month.toString().padStart(2, '0')}`;
        monthsToCreate.push(monthValue);
      }
    }

    // If no months to create, show error
    if (monthsToCreate.length === 0) {
      Alert.alert('Error', 'No fees to create. The due date for the current month has not passed yet.');
      return;
    }

    // Show confirmation with different messaging for future vs past months
    const monthLabel = generateMonthOptions.find(m => m.value === startMonth)?.label;
    const isMultipleMonths = monthsToCreate.length > 1;
    const lastMonth = monthsToCreate[monthsToCreate.length - 1];
    const lastMonthLabel = lastMonth ? generateMonthOptions.find(m => m.value === lastMonth)?.label : monthLabel;
    const totalAmount = monthsToCreate.length * parseFloat(addFeeForm.amount);
    
    let message;
    if (isMultipleMonths) {
      message = `This will create a consolidated fee of ₹${totalAmount.toLocaleString()} for ${monthsToCreate.length} months (${monthLabel} to ${lastMonthLabel}). Continue?`;
    } else {
      message = `This will create a fee of ₹${parseFloat(addFeeForm.amount).toLocaleString()} for ${monthLabel}. Continue?`;
    }
    
    // Show custom confirmation modal
    setConfirmationData({
      title: 'Create New Fee?',
      message: message,
      onConfirm: () => {
        setShowConfirmationModal(false);
        createSingleFeeFromMonths(monthsToCreate, selectedStudent, []);
      },
      onCancel: () => {
        setShowConfirmationModal(false);
      },
      confirmButtonText: 'Create Fee',
      cancelButtonText: 'Cancel'
    });
    setShowConfirmationModal(true);
  };

  const handleAddCurrentMonthWithContinuityCheck = async (existingDueFees: any[], currentMonth: string, selectedMonth: string, selectedStudent: any) => {
    try {
      const monthsToCreate = calculateMonthsToCreate(selectedMonth, selectedStudent.id);
      const earlierMonths = monthsToCreate.filter(month => month !== currentMonth);

      // Check if there are future fees that would create discontinuous coverage
      const futureFees = existingDueFees.filter(fee => {
        const feeMonth = fee.dueDate.substring(0, 7);
        const monthsCovered = fee.monthsCovered || [];
        // Check if fee starts in the future or covers future months
        return feeMonth > currentMonth || monthsCovered.some((month: string) => month > currentMonth);
      });

      if (futureFees.length > 0) {
        // Show warning about discontinuous coverage
        const futureMonths = futureFees.map(fee => {
          const feeMonth = fee.dueDate.substring(0, 7);
          const monthsCovered = fee.monthsCovered || [];
          return monthsCovered.length > 0 ? monthsCovered : [feeMonth];
        }).flat().sort();

        const firstFutureMonth = futureMonths[0];
        const firstFutureMonthLabel = generateMonthOptions.find(m => m.value === firstFutureMonth)?.label;
        const currentMonthLabel = generateMonthOptions.find(m => m.value === currentMonth)?.label;

        setConfirmationData({
          title: 'Discontinuous Fee Coverage Detected',
          message: `Adding ${currentMonthLabel} to existing future fees (starting from ${firstFutureMonthLabel}) will create discontinuous month coverage. This is not recommended.\n\nRecommended actions:\n• Create a separate fee for ${currentMonthLabel}\n• Delete future fees and create a continuous range\n\nDo you want to create a separate fee for ${currentMonthLabel} instead?`,
          confirmButtonText: 'Create Fee',
          cancelButtonText: 'Cancel',
          onConfirm: async () => {
            setShowConfirmationModal(false);
            // Create separate fee for current month only
            await handleCreateNewFee(selectedStudent, currentMonth);
          },
          onCancel: () => {
            setShowConfirmationModal(false);
          }
        });
        setShowConfirmationModal(true);
        return;
      }

      if (earlierMonths.length > 0) {
        const ignoredMonthLabels = earlierMonths.map(month =>
          generateMonthOptions.find(m => m.value === month)?.label || month
        );
        const currentMonthLabel = generateMonthOptions.find(m => m.value === currentMonth)?.label || currentMonth;

        setConfirmationData({
          title: 'Month Range Limitation',
          message: `You're trying to add earlier months to this consolidated fee, but only the current month (${currentMonthLabel}) can be added.\n\nIgnored months: ${ignoredMonthLabels.join(', ')}\n\nTo backfill earlier months:\n• Delete the existing consolidated fee\n• Create a new fee with your desired range\n\nDo you want to add only ${currentMonthLabel}?`,
          confirmButtonText: 'Add Month',
          cancelButtonText: 'Cancel',
          onConfirm: async () => {
            setShowConfirmationModal(false);
            await handleAddCurrentMonthToExisting(existingDueFees, currentMonth, selectedStudent);
          },
          onCancel: () => {
            setShowConfirmationModal(false);
          },
        });
        setShowConfirmationModal(true);
        return;
      }

      // No future fees, proceed with normal logic
      await handleAddCurrentMonthToExisting(existingDueFees, currentMonth, selectedStudent);
      
    } catch (error) {
      logger.error('Error in handleAddCurrentMonthWithContinuityCheck:', error);
      Alert.alert('Error', 'Failed to process fee request. Please try again.');
    }
  };

  const handleUpdateCurrentMonthFeeWithOverlapCheck = async (existingDueFees: any[], currentMonth: string, selectedMonth: string, selectedStudent: any) => {
    try {
      // If user selected a future month, redirect to create new fee logic instead
      if (selectedMonth > currentMonth) {
        // This is a future month selection, should create a separate fee
        await handleCreateNewFee(selectedStudent, selectedMonth);
        return;
      }

      // Check if user is trying to update a range that extends beyond current month
      const monthsToCreate = calculateMonthsToCreate(selectedMonth, selectedStudent.id);
      const overlappingMonths = monthsToCreate.filter(month => month !== currentMonth);

      if (overlappingMonths.length > 0) {
        // Show warning about ignored months
        const currentMonthLabel = generateMonthOptions.find(m => m.value === currentMonth)?.label || currentMonth;
        const currentMonthAlreadyCovered = existingDueFees.some(fee => {
          const feeMonth = fee?.dueDate?.substring?.(0, 7);
          const coveredMonths: string[] = Array.isArray(fee?.monthsCovered) ? fee.monthsCovered : [];
          return feeMonth === currentMonth || coveredMonths.includes(currentMonth);
        });

        const ignoredMonthsSet = new Set(overlappingMonths);
        if (currentMonthAlreadyCovered) {
          ignoredMonthsSet.add(currentMonth);
        }

        const ignoredMonthLabels = Array.from(ignoredMonthsSet).map(month =>
          generateMonthOptions.find(m => m.value === month)?.label || month
        );

        const introMessage = currentMonthAlreadyCovered
          ? `This consolidated fee already includes ${currentMonthLabel}. Earlier months can't be added to an existing consolidated fee.`
          : `You're trying to update multiple months, but only the current month (${currentMonthLabel}) can be adjusted in this consolidated fee.`;

        const guidanceSections = [
          introMessage,
          `Ignored months: ${ignoredMonthLabels.length > 0 ? ignoredMonthLabels.join(', ') : 'None'}`,
          'To backfill earlier months:\n• Delete the existing consolidated fee\n• Create a new fee with your desired range'
        ];

        if (!currentMonthAlreadyCovered) {
          guidanceSections.push(`Do you want to update only ${currentMonthLabel}?`);
        }

        const confirmationConfig: any = {
          title: 'Month Range Limitation',
          message: guidanceSections.join('\n\n')
        };

        if (currentMonthAlreadyCovered) {
          confirmationConfig.confirmButtonText = 'Close';
          confirmationConfig.onConfirm = () => {
            setShowConfirmationModal(false);
          };
          confirmationConfig.cancelButtonText = null;
        } else {
          confirmationConfig.confirmButtonText = 'Update Month';
          confirmationConfig.cancelButtonText = 'Cancel';
          confirmationConfig.onConfirm = async () => {
            setShowConfirmationModal(false);
            // Proceed with updating only current month
            await handleUpdateCurrentMonthFee(existingDueFees, currentMonth, selectedStudent);
          };
          confirmationConfig.onCancel = () => {
            setShowConfirmationModal(false);
          };
        }

        setConfirmationData(confirmationConfig);
        setShowConfirmationModal(true);
        return;
      }

      // No overlapping months, proceed with normal logic
      await handleUpdateCurrentMonthFee(existingDueFees, currentMonth, selectedStudent);
      
    } catch (error) {
      logger.error('Error in handleUpdateCurrentMonthFeeWithOverlapCheck:', error);
      Alert.alert('Error', 'Failed to process fee request. Please try again.');
    }
  };

  const handleAddCurrentMonthToExisting = async (existingDueFees: any[], currentMonth: string, selectedStudent: any) => {
    try {
      // Find the most recent due fee (likely the consolidated one)
      const latestFee = existingDueFees.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      
      if (!latestFee) {
        Alert.alert('Error', 'No due fees found to update');
        return;
      }

      const currentMonthLabel = generateMonthOptions.find(m => m.value === currentMonth)?.label;
      const newMonthlyAmount = parseFloat(addFeeForm.amount);
      
      // Show confirmation
      setConfirmationData({
        title: 'Add Current Month?',
        message: `This will add ${currentMonthLabel} (₹${newMonthlyAmount.toLocaleString()}) to the existing fee. Continue?`,
        confirmButtonText: 'Add Month',
        cancelButtonText: 'Cancel',
        onConfirm: async () => {
          setShowConfirmationModal(false);
          
          // Update the existing fee to include current month
          const updatedMonthsCovered = [...(latestFee.monthsCovered || []), currentMonth];
          const updatedMonthFeeAmounts = {
            ...(latestFee.monthFeeAmounts || {}),
            [currentMonth]: newMonthlyAmount
          };
          const newTotalAmount = latestFee.amount + newMonthlyAmount;
          
          await updateFeeRecord(latestFee.id, {
            amount: newTotalAmount,
            monthsCovered: updatedMonthsCovered,
            monthFeeAmounts: updatedMonthFeeAmounts,
            description: `${latestFee.description || 'Consolidated fee'} - Updated to include ${currentMonthLabel}`,
            updatedAt: new Date().toISOString()
          });

          // Close modal and show success
          setShowAddFeeModal(false);
          resetAddFeeForm();
          
          Toast.show({
            type: 'success',
            text1: 'Month Added Successfully!',
            text2: `Added ${currentMonthLabel} (₹${newMonthlyAmount.toLocaleString()}) to existing fee. New total: ₹${newTotalAmount.toLocaleString()}`,
            position: 'top',
            visibilityTime: 4000,
          });
        },
        onCancel: () => {
          setShowConfirmationModal(false);
        }
      });
      setShowConfirmationModal(true);
      
    } catch (error) {
      logger.error('Error adding current month to existing fee:', error);
      Alert.alert('Error', 'Failed to add current month to existing fee. Please try again.');
    }
  };

  const handleExtendPaidFee = async (existingPaidFees: any[], selectedStudent: any, selectedMonth: string) => {
    try {
      const targetFee = existingPaidFees
        .slice()
        .sort((a, b) => {
          const getTimestamp = (value: any) => {
            const source = value?.updatedAt || value?.createdAt;
            return source ? new Date(source).getTime() : 0;
          };
          return getTimestamp(b) - getTimestamp(a);
        })[0];

      if (!targetFee) {
        await handleCreateNewFee(selectedStudent, selectedMonth);
        return;
      }

      const monthsToAdd = calculateMonthsToCreate(selectedMonth, selectedStudent.id);

      if (monthsToAdd.length === 0) {
        Alert.alert('No Months to Add', 'The selected range does not produce any new months to add.');
        return;
      }

      const existingMonthsRaw = Array.isArray(targetFee.monthsCovered) && targetFee.monthsCovered.length > 0
        ? [...targetFee.monthsCovered]
        : targetFee.dueDate
          ? [String(targetFee.dueDate).substring(0, 7)]
          : [];

      const existingMonths = existingMonthsRaw
        .map(normalizeMonthString)
        .filter((value): value is string => Boolean(value));

      const uniqueExistingMonths = Array.from(new Set(existingMonths)).sort();
      const newMonths = monthsToAdd.filter(month => !uniqueExistingMonths.includes(month));

      if (newMonths.length === 0) {
        const studentName = selectedStudent.name || 'Student';
        Toast.show({
          type: 'info',
          text1: 'Months Already Covered',
          text2: `${studentName} already has these months recorded. Nothing to update.`,
          position: 'top',
          visibilityTime: 3000,
        });
        return;
      }

      if (showIndividualMonthEditor) {
        const hasInvalidAmounts = newMonths.some(month => {
          const amount = parseFloat(monthFeeAmounts[month] || '0');
          return !Number.isFinite(amount) || amount <= 0;
        });

        if (hasInvalidAmounts) {
          Alert.alert('Invalid Amounts', 'Please provide valid amounts for each month you want to add.');
          return;
        }
      }

      const normalizedExistingAmounts = Object.entries(targetFee.monthFeeAmounts || {}).reduce((acc, [month, amount]) => {
        const normalizedMonth = normalizeMonthString(month) || month;
        const numericAmount = typeof amount === 'number' ? amount : Number(amount);
        if (normalizedMonth) {
          acc[normalizedMonth] = Number.isFinite(numericAmount) ? numericAmount : 0;
        }
        return acc;
      }, {} as Record<string, number>);

      if (uniqueExistingMonths.length > 0 && Object.keys(normalizedExistingAmounts).length === 0) {
        const baseAmount = (() => {
          if (typeof targetFee.monthlyFeeAmount === 'number') {
            return targetFee.monthlyFeeAmount;
          }
          const total = Number(targetFee.amount || 0);
          return uniqueExistingMonths.length > 0 && Number.isFinite(total)
            ? total / uniqueExistingMonths.length
            : total;
        })();

        uniqueExistingMonths.forEach(month => {
          normalizedExistingAmounts[month] = Number.isFinite(baseAmount) ? baseAmount : 0;
        });
      }

      const updatedMonthsCovered = Array.from(new Set([...uniqueExistingMonths, ...newMonths]))
        .map(value => normalizeMonthString(value) || value)
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort();

      const updatedMonthFeeAmounts: Record<string, number> = { ...normalizedExistingAmounts };
      const defaultAmount = parseFloat(addFeeForm.amount) || 0;

      for (const month of newMonths) {
        const resolvedAmount = showIndividualMonthEditor
          ? parseFloat(monthFeeAmounts[month] || addFeeForm.amount || '0')
          : defaultAmount;

        if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
          Alert.alert('Invalid Amount', `Please provide a valid amount for ${month}.`);
          return;
        }

        updatedMonthFeeAmounts[month] = resolvedAmount;
      }

      const newTotalAmount = Object.values(updatedMonthFeeAmounts).reduce((sum, amount) => sum + Number(amount || 0), 0);
      const earliestMonth = updatedMonthsCovered[0];
      const newDueDate = calculateDueDateFromMonth(earliestMonth, selectedStudent.id);
      const firstMonthLabel = generateMonthOptions.find(m => m.value === updatedMonthsCovered[0])?.label || updatedMonthsCovered[0];
      const lastMonthLabel = generateMonthOptions.find(m => m.value === updatedMonthsCovered[updatedMonthsCovered.length - 1])?.label || updatedMonthsCovered[updatedMonthsCovered.length - 1];
      const addedMonthLabels = newMonths.map(month => generateMonthOptions.find(m => m.value === month)?.label || month).join(', ');
      const studentName = selectedStudent.name || targetFee.studentName || 'Student';
      const shouldDowngradeStatus = targetFee.status === 'paid';
      const confirmationMessage = newMonths.length === 1
        ? `This will add ${addedMonthLabels} to the existing fee for ${studentName}. The total will change to ₹${newTotalAmount.toLocaleString()}. Continue?`
        : `This will add ${addedMonthLabels} to the existing fee for ${studentName}. The consolidated fee will now cover ${updatedMonthsCovered.length} months (${firstMonthLabel} to ${lastMonthLabel}) with a total of ₹${newTotalAmount.toLocaleString()}. Continue?`;

      setConfirmationData({
        title: 'Extend Existing Fee?',
        message: confirmationMessage,
        confirmButtonText: 'Extend Fee',
        cancelButtonText: 'Cancel',
        onConfirm: async () => {
          setShowConfirmationModal(false);

          await updateFeeRecord(targetFee.id, {
            amount: newTotalAmount,
            dueDate: newDueDate,
            description: updatedMonthsCovered.length > 1
              ? `Consolidated tuition fees for ${updatedMonthsCovered.length} months (${firstMonthLabel} to ${lastMonthLabel}). Updated manually to include ${addedMonthLabels}.`
              : `Monthly tuition fee for ${firstMonthLabel}. Updated manually to include ${addedMonthLabels}.`,
            monthsCovered: updatedMonthsCovered,
            monthFeeAmounts: updatedMonthFeeAmounts,
            monthlyFeeAmount: Math.round(newTotalAmount / updatedMonthsCovered.length),
            studentName,
            paidMonths: targetFee.paidMonths || [],
            updatedAt: new Date().toISOString(),
            ...(shouldDowngradeStatus ? { status: 'partial' as const } : {}),
          });

          setShowAddFeeModal(false);
          resetAddFeeForm();

          Toast.show({
            type: 'success',
            text1: 'Fee Extended',
            text2: `Added ${addedMonthLabels} to existing fee. New total: ₹${newTotalAmount.toLocaleString()}`,
            position: 'top',
            visibilityTime: 4000,
          });
        },
        onCancel: () => {
          setShowConfirmationModal(false);
        },
      });
      setShowConfirmationModal(true);
    } catch (error) {
      logger.error('Error extending paid fee:', error);
      Alert.alert('Error', 'Failed to update the existing fee. Please try again.');
    }
  };

  const handleUpdateCurrentMonthFee = async (existingDueFees: any[], currentMonth: string, selectedStudent: any) => {
    try {
      // Find the fee that covers the current month
      const currentMonthFee = existingDueFees.find(fee => {
        const feeMonth = fee.dueDate.substring(0, 7);
        const monthsCovered = fee.monthsCovered || [];
        return feeMonth === currentMonth || monthsCovered.includes(currentMonth);
      });
      
      if (!currentMonthFee) {
        Alert.alert('Error', 'Current month fee not found');
        return;
      }

      const currentMonthLabel = generateMonthOptions.find(m => m.value === currentMonth)?.label;
      const newMonthlyAmount = parseFloat(addFeeForm.amount);
      const isConsolidatedFee = currentMonthFee.monthsCovered && currentMonthFee.monthsCovered.length > 1;
      
      if (isConsolidatedFee) {
        // Update only the current month amount in consolidated fee
        const oldCurrentMonthAmount = currentMonthFee.monthFeeAmounts?.[currentMonth] || 0;
        const amountDifference = newMonthlyAmount - oldCurrentMonthAmount;
        const newTotalAmount = currentMonthFee.amount + amountDifference;
        
        setConfirmationData({
          title: 'Update Current Month Fee?',
          message: `This will update ${currentMonthLabel} fee from ₹${oldCurrentMonthAmount.toLocaleString()} to ₹${newMonthlyAmount.toLocaleString()} in the consolidated fee. Total will change from ₹${currentMonthFee.amount.toLocaleString()} to ₹${newTotalAmount.toLocaleString()}. Continue?`,
          confirmButtonText: 'Update Fee',
          cancelButtonText: 'Cancel',
          onConfirm: async () => {
            setShowConfirmationModal(false);
            
            const updatedMonthFeeAmounts = {
              ...(currentMonthFee.monthFeeAmounts || {}),
              [currentMonth]: newMonthlyAmount
            };
            
            await updateFeeRecord(currentMonthFee.id, {
              amount: newTotalAmount,
              monthFeeAmounts: updatedMonthFeeAmounts,
              description: `${currentMonthFee.description || 'Consolidated fee'} - Updated ${currentMonthLabel} amount`,
              updatedAt: new Date().toISOString()
            });

            // Close modal and show success
            setShowAddFeeModal(false);
            resetAddFeeForm();
            
            Toast.show({
              type: 'success',
              text1: 'Current Month Updated!',
              text2: `Updated ${currentMonthLabel} fee to ₹${newMonthlyAmount.toLocaleString()}. New total: ₹${newTotalAmount.toLocaleString()}`,
              position: 'top',
              visibilityTime: 4000,
            });
          },
          onCancel: () => {
            setShowConfirmationModal(false);
          }
        });
        setShowConfirmationModal(true);
        
      } else {
        // Update the entire fee amount for single month fee
        setConfirmationData({
          title: 'Update Fee Amount?',
          message: `This will update the fee amount from ₹${currentMonthFee.amount.toLocaleString()} to ₹${newMonthlyAmount.toLocaleString()} for ${currentMonthLabel}. Continue?`,
          confirmButtonText: 'Update Amount',
          cancelButtonText: 'Cancel',
          onConfirm: async () => {
            setShowConfirmationModal(false);
            
            await updateFeeRecord(currentMonthFee.id, {
              amount: newMonthlyAmount,
              description: addFeeForm.description || `Updated monthly fee for ${currentMonthLabel}`,
              updatedAt: new Date().toISOString()
            });

            // Close modal and show success
            setShowAddFeeModal(false);
            resetAddFeeForm();
            
            Toast.show({
              type: 'success',
              text1: 'Fee Updated Successfully!',
              text2: `Updated ${currentMonthLabel} fee to ₹${newMonthlyAmount.toLocaleString()}`,
              position: 'top',
              visibilityTime: 4000,
            });
          },
          onCancel: () => {
            setShowConfirmationModal(false);
          }
        });
        setShowConfirmationModal(true);
      }
      
    } catch (error) {
      logger.error('Error updating current month fee:', error);
      Alert.alert('Error', 'Failed to update current month fee. Please try again.');
    }
  };

  const resetAddFeeForm = () => {
    setAddFeeForm({
      studentId: '',
      studentName: '',
      amount: '',
      dueMonth: getCurrentMonth(),
      type: 'tuition',
      description: '',
      isPastDue: false
    });
    setCanEditAmount(false);
    setMonthFeeAmounts({});
    setShowIndividualMonthEditor(false);
    setShowOverwriteWarning(false);
    setExistingFee(null);
  };

  const createSingleFeeFromMonths = async (monthsToCreate: string[], selectedStudent: any, existingFeesToDelete: any[]) => {
    try {
      // Delete specified existing fees only (not all fees)
      for (let i = 0; i < existingFeesToDelete.length; i++) {
        const existingFee = existingFeesToDelete[i];
        try {
          const deletedBy = user?.displayName || user?.email?.split('@')[0] || 'Unknown User';
          await deleteFeeRecord(existingFee.id, deletedBy, 'Consolidating fees');
        } catch (deleteError) {
          logger.error(`Failed to delete fee ${existingFee.id}:`, deleteError);
          throw deleteError;
        }
      }

      // Calculate total amount for all months - use individual fees if available
      const totalAmount = showIndividualMonthEditor 
        ? calculateTotalFromMonthFees()
        : monthsToCreate.length * parseFloat(addFeeForm.amount);
        
      // Calculate individual month fee amounts object
      const monthFeeAmountsData: { [month: string]: number } = {};
      if (showIndividualMonthEditor) {
        monthsToCreate.forEach(month => {
          monthFeeAmountsData[month] = parseFloat(monthFeeAmounts[month] || '0');
        });
      } else {
        const uniformAmount = parseFloat(addFeeForm.amount);
        monthsToCreate.forEach(month => {
          monthFeeAmountsData[month] = uniformAmount;
        });
      }
      
      // Use the first month as the due date (starting month) so it appears in the correct month section
      const firstMonth = monthsToCreate[0];
      const dueDate = calculateDueDateFromMonth(firstMonth, addFeeForm.studentId);
      
      // Check if this consolidated fee is overdue or future
      const today = new Date();
      const dueDateObj = new Date(dueDate);
      const isPastDue = dueDateObj < today;
      const isFuture = firstMonth > getCurrentMonth();

      // Create description that shows the range of months
      const firstMonthLabel = generateMonthOptions.find(m => m.value === monthsToCreate[0])?.label;
      const lastMonth = monthsToCreate[monthsToCreate.length - 1];
      const lastMonthLabel = generateMonthOptions.find(m => m.value === lastMonth)?.label;
      const isMultipleMonths = monthsToCreate.length > 1;
      
      const averageFee = totalAmount / monthsToCreate.length;
      let description;
      
      if (isFuture) {
        description = `Future monthly tuition fee for ${firstMonthLabel}. Payment due by ${dueDate}.`;
      } else if (isMultipleMonths) {
        description = showIndividualMonthEditor
          ? `Consolidated tuition fees for ${monthsToCreate.length} months (${firstMonthLabel} to ${lastMonthLabel}) with individual amounts. Total: ₹${totalAmount.toLocaleString()}. Payment due by ${dueDate}.`
          : `Consolidated tuition fees for ${monthsToCreate.length} months (${firstMonthLabel} to ${lastMonthLabel}) at ₹${averageFee.toLocaleString()}/month. Payment due by ${dueDate}.`;
      } else {
        description = `Monthly tuition fee for ${firstMonthLabel}. Payment due by ${dueDate}.`;
      }

      const newFeeData = {
        studentId: addFeeForm.studentId,
        studentName: selectedStudent.name,
        amount: totalAmount,
        dueDate: dueDate,
        type: addFeeForm.type as 'tuition' | 'registration' | 'materials' | 'other',
        description: addFeeForm.description || description,
        status: (isFuture ? 'pending' : (isPastDue ? 'overdue' : 'pending')) as 'pending' | 'paid' | 'overdue',
        paidAmount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Add metadata about the months covered
        monthsCovered: monthsToCreate,
        monthlyFeeAmount: isMultipleMonths ? averageFee : parseFloat(addFeeForm.amount), // Keep for backward compatibility
        monthFeeAmounts: monthFeeAmountsData, // New field for individual month amounts
        paidMonths: [] // Initialize as empty array to show payment status fields
      };
      
      try {
        // This is a manual fee creation, so use current user
        const createdBy = user?.displayName || user?.email?.split('@')[0] || 'Unknown User';
        await addFeeRecord(newFeeData, createdBy);
      } catch (createError) {
        logger.error(`Failed to create consolidated fee:`, createError);
        throw createError;
      }

      // Close modal and reset form immediately after successful creation
      setShowAddFeeModal(false);
      resetAddFeeForm();
      
      // Show success message
      const successMessage = isFuture 
        ? `Created future fee of ₹${totalAmount.toLocaleString()} for ${selectedStudent.name} for ${firstMonthLabel}. This fee will become due when the month arrives.${existingFeesToDelete.length > 0 ? ' Overwrote previous fees.' : ''}`
        : isMultipleMonths 
          ? `Created consolidated fee of ₹${totalAmount.toLocaleString()} for ${selectedStudent.name} covering ${monthsToCreate.length} months (${firstMonthLabel} to ${lastMonthLabel}).${existingFeesToDelete.length > 0 ? ` Overwrote ${existingFeesToDelete.length} existing fees.` : ''}`
          : `Created fee of ₹${totalAmount.toLocaleString()} for ${selectedStudent.name} for ${firstMonthLabel}.${existingFeesToDelete.length > 0 ? ' Overwrote previous fees.' : ''}`;

      Toast.show({
        type: 'success',
        text1: 'Fee Created Successfully!',
        text2: successMessage,
        position: 'top',
        visibilityTime: 4000,
      });

    } catch (error) {
      logger.error('Error in createSingleFeeFromMonths:', error);
      Alert.alert('Error', 'Failed to create fee record. Please try again.');
    }
  };

  const createFeesFromSelectedMonth = async (monthsToCreate: string[], selectedStudent: any, existingFees: any[]) => {
    try {
      // Delete ALL existing fees for this student first
      for (let i = 0; i < existingFees.length; i++) {
        const existingFee = existingFees[i];
        try {
          const deletedBy = user?.displayName || user?.email?.split('@')[0] || 'Unknown User';
          await deleteFeeRecord(existingFee.id, deletedBy, 'Creating new fee structure');
        } catch (deleteError) {
          logger.error(`Failed to delete fee ${existingFee.id}:`, deleteError);
          throw deleteError;
        }
      }

      // Create new fees for all months
      const createdFees = [];
      for (let i = 0; i < monthsToCreate.length; i++) {
        const month = monthsToCreate[i];
        
        const dueDate = calculateDueDateFromMonth(month, addFeeForm.studentId);
        const today = new Date();
        const dueDateObj = new Date(dueDate);
        const isPastDue = dueDateObj < today;

        const newFeeData = {
          studentId: addFeeForm.studentId,
          studentName: selectedStudent.name,
          amount: parseFloat(addFeeForm.amount),
          dueDate: dueDate,
          type: addFeeForm.type as 'tuition' | 'registration' | 'materials' | 'other',
          description: addFeeForm.description || `Monthly tuition fee for ${month}`,
          status: (isPastDue ? 'overdue' : 'pending') as 'pending' | 'paid' | 'overdue',
          paidAmount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        try {
          // This is a manual fee creation, so use current user
          const createdBy = user?.displayName || user?.email?.split('@')[0] || 'Unknown User';
          await addFeeRecord(newFeeData, createdBy);
          createdFees.push(month);
        } catch (createError) {
          logger.error(`Failed to create fee for month ${month}:`, createError);
          throw createError;
        }
      }

      // Close modal and reset form immediately after successful creation
      setShowAddFeeModal(false);
      setShowOverwriteWarning(false);
      setExistingFee(null);
      
      // Reset form
      setAddFeeForm({
        studentId: '',
        studentName: '',
        amount: '',
        dueMonth: getCurrentMonth(), // Use helper function consistently
        type: 'tuition',
        description: '',
        isPastDue: false
      });
      setCanEditAmount(false);
      setMonthFeeAmounts({});
      setShowIndividualMonthEditor(false);
      
      // Show success message
      const isMultipleMonths = createdFees.length > 1;
      const monthLabel = generateMonthOptions.find(m => m.value === monthsToCreate[0])?.label;
      const lastMonth = monthsToCreate[monthsToCreate.length - 1];
      const lastMonthLabel = lastMonth ? generateMonthOptions.find(m => m.value === lastMonth)?.label : monthLabel;
      
      setTimeout(() => {
        Alert.alert(
          'Success!', 
          isMultipleMonths 
            ? `Created ${createdFees.length} fee records for ${selectedStudent.name} from ${monthLabel} to ${lastMonthLabel}.${existingFees.length > 0 ? ` Overwrote ${existingFees.length} existing fees.` : ''}`
            : `Created fee record for ${selectedStudent.name} for ${monthLabel}.${existingFees.length > 0 ? ' Overwrote all existing fees.' : ''}`,
          [{ text: 'OK' }]
        );
      }, 100);

    } catch (error) {
      logger.error('Error in createFeesFromSelectedMonth:', error);
      Alert.alert('Error', 'Failed to create some fee records. Please try again.');
    }
  };

  // Removed duplicate getCorrectFeeAmount function - using the memoized version above

  // Optimized summary calculations with proper memoization
  const { totalAmount, paidAmount, pendingAmount, collectedThisMonth } = useMemo(() => {
    const now = new Date();
    const isInCurrentMonth = (dateStr?: string | null) => {
      if (!dateStr) return false;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return false;
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    };

    const total = fees.reduce((sum, record) => sum + getCorrectFeeAmount(record), 0);
    const paid = fees.reduce((sum, record) => {
      const category = categorizeFee(record);
      if (category === 'paid') {
        return sum + getCorrectFeeAmount(record);
      } else if (category === 'partial') {
        return sum + (record.paidAmount || 0);
      }
      return sum;
    }, 0);
    const pending = total - paid;

    // Only count payments actually made this calendar month
    const thisMonthPaid = fees.reduce((sum, record) => {
      const details = record.paymentDetails as any;

      // Structured payments (payment_* keys) — sum only those in current month
      if (details && typeof details === 'object') {
        const paymentKeys = Object.keys(details).filter(
          (k) => k.startsWith('payment_') && details[k] && typeof details[k] === 'object'
        );
        if (paymentKeys.length > 0) {
          return sum + paymentKeys.reduce((acc, key) => {
            const p = details[key];
            const pd = p?.paymentDate || p?.date;
            const amt = Number(p?.amount) || 0;
            return acc + (isInCurrentMonth(pd) ? amt : 0);
          }, 0);
        }
      }

      // Legacy fully-paid fee with paidDate in current month
      if (record.status === 'paid' && isInCurrentMonth(record.paidDate)) {
        return sum + getCorrectFeeAmount(record);
      }

      // Legacy partial payment made in current month
      const legacyPaymentDate = (details && details.paymentDate) || record.paidDate;
      if ((record.paidAmount || 0) > 0 && isInCurrentMonth(legacyPaymentDate)) {
        return sum + (record.paidAmount || 0);
      }

      return sum;
    }, 0);

    return { totalAmount: total, paidAmount: paid, pendingAmount: pending, collectedThisMonth: thisMonthPaid };
  }, [fees, getCorrectFeeAmount, categorizeFee]);

  const createFeeButtonState = useMemo(() => {
    if (!addFeeForm.studentId) {
      return { label: 'Select student', disabled: true };
    }

    if (!addFeeForm.dueMonth) {
      return { label: 'Select due month', disabled: true };
    }

    const monthsToCreateRaw = calculateMonthsToCreate(addFeeForm.dueMonth, addFeeForm.studentId);
    let normalizedMonths = Array.from(new Set(
      monthsToCreateRaw
        .map(month => normalizeMonthString(month) || month)
        .filter((value): value is string => Boolean(value))
    ));

    const normalizedSelected = normalizeMonthString(addFeeForm.dueMonth);
    if (normalizedSelected && normalizedMonths.length === 0) {
      normalizedMonths = [normalizedSelected];
    }

    if (normalizedMonths.length === 0) {
      return { label: 'No payable months yet', disabled: true };
    }

    const existingMonths = collectExistingMonthsForStudent(addFeeForm.studentId);
    const monthsPending = normalizedMonths.filter(month => !existingMonths.has(month));

    if (showIndividualMonthEditor) {
      const monthsToValidate = (monthsPending.length > 0 ? monthsPending : normalizedMonths);
      const invalidAmounts = monthsToValidate.some(month => {
        const rawAmount = monthFeeAmounts[month] ?? monthFeeAmounts[normalizeMonthString(month) || month] ?? addFeeForm.amount;
        const amount = typeof rawAmount === 'number' ? rawAmount : parseFloat(rawAmount ?? '0');
        return !Number.isFinite(amount) || amount <= 0;
      });

      if (invalidAmounts) {
        return { label: 'Enter valid amounts', disabled: true };
      }
    } else {
      const baseAmount = parseFloat(addFeeForm.amount || '0');
      if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
        return { label: 'Enter monthly fee', disabled: true };
      }
    }

    if (monthsPending.length === 0) {
      return { label: 'No new months to add', disabled: true };
    }

    const baseMonthlyAmount = parseFloat(addFeeForm.amount || '0') || 0;
    const totalAmount = showIndividualMonthEditor
      ? monthsPending.reduce((sum, month) => {
          const amount = parseFloat(monthFeeAmounts[month] || addFeeForm.amount || '0') || 0;
          return sum + amount;
        }, 0)
      : monthsPending.length * baseMonthlyAmount;

    if (monthsPending.length > 1 && Number.isFinite(totalAmount) && totalAmount > 0) {
      return {
        label: `Create Fee (₹${totalAmount.toLocaleString()})`,
        disabled: false,
      };
    }

    return { label: 'Create Fee', disabled: false };
  }, [
    addFeeForm.dueMonth,
    addFeeForm.studentId,
    addFeeForm.amount,
    showIndividualMonthEditor,
    monthFeeAmounts,
    calculateMonthsToCreate,
    collectExistingMonthsForStudent,
  ]);

  // Optimized component loading with faster initialization
  useEffect(() => {
    const timer = setTimeout(() => {
      setComponentLoading(false);
    }, 100); // Reduce delay from 300ms to 100ms for faster loading
    
    return () => clearTimeout(timer);
  }, []);

  // Safe early return for offline gate after all hooks/effects
  if (showOfflineLoadingFees) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading fees…</Text>
        {!!offlineHintFees && (
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 8 }]}>{offlineHintFees}</Text>
        )}
      </View>
    );
  }

  if (tenantUnavailable) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <TenantSelectionEmptyState
          title="No coaching center selected"
          description="Head to Settings → Coaching centers to choose, create, or join a workspace before managing fees."
          primaryActionLabel="Open Settings"
          onPrimaryAction={() => router.push('/(tabs)/settings')}
        />
      </View>
    );
  }

  // Early return for loading states to prevent expensive calculations
  if (loading || componentLoading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading fees...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <AlertCircle size={48} color={theme.error} />
        <Text style={[styles.errorText, { color: theme.error, marginTop: 16, textAlign: 'center' }]}>{error}</Text>
      </View>
    );
  }

  // Excel download function with comprehensive fee data
  const handleDownloadPress = () => {
    setShowDownloadConfirmModal(true);
  };

  const handleConfirmDownload = async () => {
    setShowDownloadConfirmModal(false);
    await handleDownloadExcel();
  };

  const handleCancelDownload = () => {
    setShowDownloadConfirmModal(false);
  };

  const handleDownloadExcel = async () => {
    try {
      
      showCustomToastMessage('info', 'Generating Excel Report', 'Preparing comprehensive fee report...', 2000);

      // Helper functions for data formatting
      const formatArray = (arr: any[] | undefined) => {
        if (!arr || arr.length === 0) return 'N/A';
        return arr.join(', ');
      };

      const formatBoolean = (val: boolean | undefined) => val ? 'Yes' : 'No';

      const formatDate = (date: string | undefined) => {
        if (!date) return 'N/A';
        return new Date(date).toLocaleDateString();
      };

      const formatCurrency = (amount: number | undefined) => {
        return amount ? `₹${amount.toLocaleString()}` : '₹0';
      };

      // Get correct fee amount considering consolidated fees
      // Prepare comprehensive fee data with all student information (matching actual file structure)
      const excelData = fees.map((fee, index) => {
        const student = students.find(s => s.id === fee.studentId);
        const feeAmount = getCorrectFeeAmount(fee);
        const remainingAmount = feeAmount - (fee.paidAmount || 0);
        const paymentCount = fee.paidAmount && fee.paidAmount > 0 ? 1 : 0;
        const receiptsInfo = fee.paymentDetails ? '1 receipt(s) attached' : 'No receipts';
        
        return {
          'Sr. No.': index + 1,
          'Student Name': student?.name || 'Unknown',
          'Student Grade': student?.grade || 'N/A',
          'Student Phone': student?.phone || 'N/A',
          'Parent Name': student?.parentName || 'N/A',
          'Parent Phone': student?.parentContact || student?.parentPhone || 'N/A',
          'Parent Email': student?.parentEmail || 'N/A',
          'Fee Type': fee.type === 'tuition' ? 'Tuition' :
                     fee.type === 'registration' ? 'Registration' :
                     fee.type === 'materials' ? 'Materials' :
                     fee.type === 'other' ? 'Other' : 'Tuition',
          'Description': fee.description || 'N/A',
          'Total Amount (₹)': feeAmount,
          'Paid Amount (₹)': fee.paidAmount || 0,
          'Remaining Amount (₹)': remainingAmount,
          'Status': fee.status === 'paid' ? 'Paid' :
                   fee.status === 'partial' ? 'Partial' :
                   fee.status === 'pending' ? 'Pending' :
                   remainingAmount === 0 ? 'Paid' :
                   fee.paidAmount && fee.paidAmount > 0 ? 'Partial' : 'Unpaid',
          'Due Date': formatDate(fee.dueDate),
          'Payment Date': fee.paidDate ? formatDate(fee.paidDate) : 'Not paid',
          'Payment Methods': fee.paymentMethod || fee.method || 'N/A',
          'Months Covered': formatArray(fee.monthsCovered),
          'Months Paid': formatArray(fee.paidMonths),
          'Payment Count': paymentCount,
          'Monthly Fee (₹)': fee.monthlyFeeAmount || student?.monthlyFee || 0,
          'Receipts': receiptsInfo,
          'Created Date': formatDate(fee.createdAt),
          'Last Updated': formatDate(fee.updatedAt),
          'Enrollment Date': formatDate(student?.enrollmentDate),
          'Student Status': student?.status || 'active',
          
          // Additional comprehensive fields (extended data)
          'Fee ID': fee.id,
          'Student ID': student?.id || 'N/A',
          'Student Email': student?.email || 'N/A',
          'Date of Birth': formatDate(student?.dateOfBirth),
          'Address': student?.address || 'N/A',
          'Emergency Contact': student?.emergencyContact || 'N/A',
          'Parent Contact': student?.parentContact || 'N/A',
          'Parent WhatsApp': student?.parentWhatsApp || 'N/A',
          'Enrolled Courses': formatArray(student?.enrolledCourses),
          'Subjects': formatArray(student?.subjects),
          'Attendance': student?.attendance ? `${student.attendance}%` : 'N/A',
          'Performance': student?.performance || 'N/A',
          'Payment Efficiency': remainingAmount === 0 ? '100%' : `${Math.round(((fee.paidAmount || 0) / feeAmount) * 100)}%`,
          'Fee Due Day of Month': student?.feeDueDate || 'N/A',
          'Days Overdue': fee.dueDate && new Date(fee.dueDate) < new Date() ? 
            Math.ceil((new Date().getTime() - new Date(fee.dueDate).getTime()) / (1000 * 60 * 60 * 24)) : 0,
          'Is Consolidated Fee': formatBoolean(fee.monthsCovered && fee.monthsCovered.length > 1),
          'Months Covered Count': fee.monthsCovered?.length || 1,
          'Payment Details - Paid By': fee.paymentDetails?.paidBy || 'N/A',
          'Payment Details - Transaction ID': fee.paymentDetails?.transactionId || 'N/A',
          'Payment Details - Account Details': fee.paymentDetails?.accountDetails || 'N/A',
          'Payment Details - Notes': fee.paymentDetails?.notes || 'N/A',
          'Created By': fee.createdBy || 'N/A',
          'Approved By': fee.approvedBy || 'N/A',
          'Join Date': formatDate(student?.joinDate),
          'Total Fees': formatCurrency(student?.totalFees),
          'Fees Paid': formatCurrency(student?.feesPaid),
          'Last Student Payment Date': formatDate(student?.lastPaymentDate)
        };
      });
      // Map month codes to human-readable labels for Excel export
      const monthLabelMap: Record<string, string> = Object.fromEntries(
        generateMonthOptions.map(opt => [opt.value, opt.label])
      );
      // Create detailed payment transactions from all payment history (matching actual file structure)
      const paymentTransactions = fees.flatMap((fee) => {
        const student = students.find((s) => s.id === fee.studentId);
        // Pull payment records from DB using helper
        const payments = getPaymentTransactions(fee) || [];
        return payments.map((payment: any) => {
          // Use monthsPaid field from DB
          const paymentType = payment.monthsPaid && payment.monthsPaid.length > 0
            ? 'individual_months'
            : 'general_payment';
          return {
            // Use transaction key as ID
            'Transaction ID': payment.id || 'N/A',
            'Student Name': student?.name || 'Unknown',
            'Fee Description': fee.description || 'N/A',
            'Payment Amount (₹)': payment.amount || 0,
            // Prefer stored paymentDate over date
            'Payment Date': payment.paymentDate
              ? new Date(payment.paymentDate).toISOString()
              : payment.date
                ? new Date(payment.date).toISOString()
                : 'N/A',
            'Payment Method': payment.method || 'N/A',
            'Paid By': payment.paidBy || 'N/A',
            'Transaction ID/Ref': payment.transactionId || 'N/A',
            'Account Details': payment.accountDetails || 'N/A',
            'Months Paid For': payment.monthsPaid && payment.monthsPaid.length > 0
              ? payment.monthsPaid.map((m: string) => monthLabelMap[m] || m).join(', ')
              : 'General Payment',
            'Notes': payment.notes || '',
            // Use stored type if available
            'Payment Type': payment.type || paymentType
          };
        });
      });

      // Create executive summary
      const totalFees = fees.length;
      const totalAmount = fees.reduce((sum, fee) => sum + getCorrectFeeAmount(fee), 0);
      const totalPaid = fees.reduce((sum, fee) => sum + (fee.paidAmount || 0), 0);
      const totalPending = totalAmount - totalPaid;
      const totalStudents = students.length;
      const feesWithPayments = fees.filter(f => f.paidAmount && f.paidAmount > 0).length;

      // Create comprehensive executive summary (restored original format + ALL missing fields)
      const summary = [
        { 'Category': 'Overview', 'Metric': 'Total Students', 'Value': totalStudents, 'Percentage': '100%' },
        { 'Category': 'Overview', 'Metric': 'Total Fee Records', 'Value': totalFees, 'Percentage': 'N/A' },
        { 'Category': 'Financial', 'Metric': 'Total Amount Due (₹)', 'Value': totalAmount, 'Percentage': '100%' },
        { 'Category': 'Financial', 'Metric': 'Total Amount Collected (₹)', 'Value': totalPaid, 'Percentage': `${Math.round((totalPaid / totalAmount) * 100)}%` },
        { 'Category': 'Financial', 'Metric': 'Total Outstanding (₹)', 'Value': totalPending, 'Percentage': `${Math.round((totalPending / totalAmount) * 100)}%` },
        { 'Category': 'Financial', 'Metric': 'Collection Rate (%)', 'Value': Math.round((totalPaid / totalAmount) * 100), 'Percentage': 'N/A' },
        { 'Category': 'Financial', 'Metric': 'Average Fee Amount (₹)', 'Value': Math.round(totalAmount / totalFees), 'Percentage': 'N/A' },
        { 'Category': 'Status', 'Metric': 'Paid Fees', 'Value': fees.filter(f => f.status === 'paid' || (f.paidAmount && f.paidAmount >= getCorrectFeeAmount(f))).length, 'Percentage': `${Math.round((fees.filter(f => f.status === 'paid' || (f.paidAmount && f.paidAmount >= getCorrectFeeAmount(f))).length / totalFees) * 100)}%` },
        { 'Category': 'Status', 'Metric': 'Partial Fees', 'Value': fees.filter(f => f.status === 'partial' || (f.paidAmount && f.paidAmount > 0 && f.paidAmount < getCorrectFeeAmount(f))).length, 'Percentage': `${Math.round((fees.filter(f => f.status === 'partial' || (f.paidAmount && f.paidAmount > 0 && f.paidAmount < getCorrectFeeAmount(f))).length / totalFees) * 100)}%` },
        { 'Category': 'Status', 'Metric': 'Pending Fees', 'Value': fees.filter(f => f.status === 'pending' && (!f.paidAmount || f.paidAmount === 0)).length, 'Percentage': `${Math.round((fees.filter(f => f.status === 'pending' && (!f.paidAmount || f.paidAmount === 0)).length / totalFees) * 100)}%` },
        { 'Category': 'Status', 'Metric': 'Unpaid Fees', 'Value': fees.filter(f => !f.paidAmount || f.paidAmount === 0).length, 'Percentage': `${Math.round((fees.filter(f => !f.paidAmount || f.paidAmount === 0).length / totalFees) * 100)}%` },
        { 'Category': 'Status', 'Metric': 'Overdue Fees', 'Value': fees.filter(f => f.dueDate && new Date(f.dueDate) < new Date() && (!f.paidAmount || f.paidAmount < getCorrectFeeAmount(f))).length, 'Percentage': `${Math.round((fees.filter(f => f.dueDate && new Date(f.dueDate) < new Date() && (!f.paidAmount || f.paidAmount < getCorrectFeeAmount(f))).length / totalFees) * 100)}%` },
        { 'Category': 'Operations', 'Metric': 'Fees with Payments', 'Value': feesWithPayments, 'Percentage': `${Math.round((feesWithPayments / totalFees) * 100)}%` },
        { 'Category': 'Operations', 'Metric': 'Total Transactions', 'Value': paymentTransactions.length, 'Percentage': 'N/A' }
      ];

      // Create comprehensive student summary (restored original format + new fields)
      const studentSummary = students.map(student => {
        const studentFees = fees.filter(f => f.studentId === student.id);
        const studentTotalDue = studentFees.reduce((sum, fee) => sum + getCorrectFeeAmount(fee), 0);
        const studentTotalPaid = studentFees.reduce((sum, fee) => sum + (fee.paidAmount || 0), 0);
        const studentOutstanding = studentTotalDue - studentTotalPaid;

        return {
          'Student ID': student.id,
          'Student Name': student.name,
          'Grade': student.grade || 'N/A',
          'Phone': student.phone || 'N/A',
          'Email': student.email || 'N/A',
          'DOB': formatDate(student.dateOfBirth),
          'Address': student.address || 'N/A',
          'Emergency Contact': student.emergencyContact || 'N/A',
          'Parent Name': student.parentName || 'N/A',
          'Parent Phone': student.parentContact || student.parentPhone || 'N/A',
          'Parent Email': student.parentEmail || 'N/A',
          'Parent Contact': student.parentContact || 'N/A',
          'Parent WhatsApp': student.parentWhatsApp || 'N/A',
          'Enrolled Courses': formatArray(student.enrolledCourses),
          'Subjects': formatArray(student.subjects),
          'Attendance': student.attendance ? `${student.attendance}%` : 'N/A',
          'Performance': student.performance || 'N/A',
          'Total Fee Records': studentFees.length,
          'Total Amount Due (₹)': studentTotalDue,
          'Total Amount Paid (₹)': studentTotalPaid,
          'Outstanding Amount (₹)': studentOutstanding,
          'Payment Efficiency': studentTotalDue > 0 ? `${Math.round((studentTotalPaid / studentTotalDue) * 100)}%` : '0%',
          'Monthly Fee (₹)': student.monthlyFee || 0,
          'Fee Due Date': student.feeDueDate || 'N/A',
          'Status': student.status || 'active',
          'Enrollment Date': formatDate(student.enrollmentDate),
          'Join Date': formatDate(student.joinDate),
          'Created Date': formatDate(student.createdAt),
          'Last Updated': formatDate(student.updatedAt),
          'Last Payment Date': formatDate(studentFees.find(f => f.paidDate)?.paidDate) || 'Never',
          'Total Fees (System)': formatCurrency(student.totalFees),
          'Fees Paid (System)': formatCurrency(student.feesPaid)
        };
      });

      // Create workbook and add sheets
      const wb = XLSX.utils.book_new();

      // Add executive summary sheet
      const summaryWS = XLSX.utils.json_to_sheet(summary);
      summaryWS['!cols'] = [{ wch: 25 }, { wch: 25 }, { wch: 20 }, { wch: 15 }];
      XLSX.utils.book_append_sheet(wb, summaryWS, 'Executive Summary');

      // Add comprehensive fee details sheet
      const feeDetailsWS = XLSX.utils.json_to_sheet(excelData);
      // Set column widths for readability
      const feeDetailsCols = Array(65).fill(0).map((_, i) => ({ wch: i < 5 ? 15 : i < 20 ? 20 : 25 }));
      feeDetailsWS['!cols'] = feeDetailsCols;
      XLSX.utils.book_append_sheet(wb, feeDetailsWS, 'Fee Details');

      // Add comprehensive student summary sheet
      const studentSummaryWS = XLSX.utils.json_to_sheet(studentSummary);
      const studentCols = Array(30).fill(0).map(() => ({ wch: 20 }));
      studentSummaryWS['!cols'] = studentCols;
      XLSX.utils.book_append_sheet(wb, studentSummaryWS, 'Student Summary');

      // Add payment transactions sheet
      const paymentWS = XLSX.utils.json_to_sheet(paymentTransactions);
      const paymentCols = Array(12).fill(0).map(() => ({ wch: 20 }));
      paymentWS['!cols'] = paymentCols;
      XLSX.utils.book_append_sheet(wb, paymentWS, 'Payment Transactions');

      // Generate file
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      const currentDate = new Date();
      const dateStr = currentDate.toISOString().split('T')[0];
      const timeStr = currentDate.toTimeString().split(' ')[0].replace(/:/g, '-');
      const fileName = `Comprehensive_Fee_Report_${dateStr}_${timeStr}.xlsx`;

      if (Platform.OS === 'web') {
        // For web platform
        const binaryString = atob(wbout);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = window.URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        
        showCustomToastMessage('success', 'Excel Downloaded!', 
          `${fileName} with ${excelData.length} fee records has been downloaded successfully`, 4000);
      } else {
        // For mobile platforms
        const fileUri = FileSystem.documentDirectory + fileName;
        await FileSystem.writeAsStringAsync(fileUri, wbout, {
          encoding: FileSystem.EncodingType.Base64,
        });

        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: 'Save Comprehensive Fee Report',
            UTI: 'com.microsoft.excel.xlsx'
          });
          showCustomToastMessage('success', 'Excel Generated!', 
            `${fileName} with ${excelData.length} fee records is ready to share`, 4000);
        } else {
          showCustomToastMessage('success', 'Excel Report Generated!', 
            `Saved to: ${fileUri}`, 4000);
        }
      }

    } catch (error) {
      logger.error('Error generating Excel file:', error);
      showCustomToastMessage('error', 'Export Failed', 'Could not generate Excel file. Please try again.', 3000);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: theme.surface, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
        <Text allowFontScaling={false} style={[styles.title, { color: theme.text }]}>  
          {isSmallScreen ? 'Fee' : 'Fee Management'}
        </Text>
        <View style={styles.headerActions}>
          {/* Auto Fee Approval Notification Bell */}
          <TouchableOpacity 
            style={[styles.notificationButton, { backgroundColor: `${theme.primary}15`, borderColor: theme.primary }]}
            onPress={() => {
              if (studentsLoading) {
                Toast.show({
                  type: 'info',
                  text1: 'Student Data Loading',
                  text2: 'Please wait for the latest student list before reviewing auto fees.',
                  position: 'top',
                  visibilityTime: 2500,
                });
                return;
              }

              openAutoFeeApprovalModal();
            }}
          >
            <Bell size={16} color={theme.primary} />
            {pendingAutoFeeActions.length > 0 && (
              <View style={[styles.notificationBadge, { backgroundColor: '#ef4444' }]}>
                <Text allowFontScaling={false} style={styles.notificationBadgeText}>{pendingAutoFeeActions.length}</Text>
              </View>
            )}
          </TouchableOpacity>
          
          {/* Payment History */}
          <TouchableOpacity
            accessibilityLabel="Payment History"
            accessibilityRole="button"
            style={[styles.infoButton, { backgroundColor: `${theme.primary}15`, borderColor: theme.primary }]}
            onPress={() => setShowPaymentHistory(true)}
          >
            <Clock size={16} color={theme.primary} />
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.infoButton, { backgroundColor: `${theme.primary}15`, borderColor: theme.primary }]}
            onPress={() => setShowInfoModal(true)}
          >
            <Info size={16} color={theme.primary} />
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.addFeeButton, { backgroundColor: `${theme.primary}15`, borderColor: theme.primary }]}
            onPress={() => setShowAddFeeModal(true)}
            accessibilityLabel="Add Fee"
            accessibilityRole="button"
          >
            <Text allowFontScaling={false} style={[styles.addFeeText, { color: theme.primary }]}>+ Add Fee</Text>
          </TouchableOpacity>
          {Platform.OS === 'web' && (
            <TouchableOpacity 
              style={styles.downloadButton}
              onPress={handleDownloadPress}
            >
              <Download size={20} color={theme.primary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Payment History Overlay */}
      {showPaymentHistory && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }}>
          <FeeHistory onClose={() => setShowPaymentHistory(false)} />
        </View>
      )}

  {/* Summary & Records.
      The summary scrolls away while the filter/search/sort header stays
      pinned via stickyHeaderIndices={[1]} (the summary is child 0, the
      filter header is child 1). */}
  <GHScrollView
    ref={recordsScrollRef as any}
    style={styles.recordsList}
    contentContainerStyle={[styles.recordsContent, { paddingBottom: 120 }]}
    showsVerticalScrollIndicator={false}
    scrollEnabled={recordsScrollEnabled}
    nestedScrollEnabled
    stickyHeaderIndices={[1]}
  >
    <View style={styles.summarySection}>
      <View style={styles.summaryContainer}>
        <TouchableOpacity
          style={[styles.summaryCard, { backgroundColor: theme.surface }]}
          onPress={() => setShowCalendarModal(true)}
          activeOpacity={0.9}
        >
          <Text style={[styles.summaryAmount, { color: theme.success }]}>₹{collectedThisMonth.toLocaleString()}</Text>
          <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>Collected This Month</Text>
          <View style={[styles.summaryIcon, { backgroundColor: `${theme.success}15` }] }>
            <CheckCircle size={20} color={theme.success} />
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.summaryCard, { backgroundColor: theme.surface }]}
          onPress={() => setShowCalendarModal(true)}
          activeOpacity={0.9}
        >
          <Text style={[styles.summaryAmount, { color: theme.error }]}>₹{pendingAmount.toLocaleString()}</Text>
          <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>Pending Amount</Text>
          <View style={[styles.summaryIcon, { backgroundColor: `${theme.error}15` }] }>
            <AlertCircle size={20} color={theme.error} />
          </View>
        </TouchableOpacity>
      </View>
    </View>

      {/* Filter Tabs (pinned sticky header) */}
      <View
        style={[
          styles.filterHeader,
          {
            paddingVertical: 0,
            marginTop: 4,
            marginBottom: 8,
            backgroundColor: theme.background,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.border,
            zIndex: 5,
          },
        ]}
      >
    {/* Filter Tabs Row */}
    <View style={{ width: '100%', marginBottom: 6 }}>
      <GHScrollView
        ref={filtersScrollRef as any}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ 
          minHeight: Platform.select({ web: 48, default: 34 }),
          maxHeight: Platform.select({ web: 52, default: 38 }),
          marginTop: 0, 
          marginBottom: 0
        }}
        contentContainerStyle={{ 
          alignItems: 'center', 
          paddingVertical: Platform.select({ web: 4, default: 1 }),
          paddingRight: 8,
          minHeight: Platform.select({ web: 48, default: 34 })
        }}
        nestedScrollEnabled
        disallowInterruption
        onStartShouldSetResponderCapture={() => true}
        onMoveShouldSetResponderCapture={() => true}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onTouchStart={() => {
          setRecordsScrollEnabled(false);
          recordsScrollRef.current?.setNativeProps?.({ scrollEnabled: false });
        }}
        onTouchEnd={() => {
          recordsScrollRef.current?.setNativeProps?.({ scrollEnabled: true });
          setRecordsScrollEnabled(true);
        }}
        onTouchCancel={() => {
          recordsScrollRef.current?.setNativeProps?.({ scrollEnabled: true });
          setRecordsScrollEnabled(true);
        }}
        onScrollBeginDrag={() => {
          setRecordsScrollEnabled(false);
          recordsScrollRef.current?.setNativeProps?.({ scrollEnabled: false });
        }}
        onScrollEndDrag={() => {
          recordsScrollRef.current?.setNativeProps?.({ scrollEnabled: true });
          setRecordsScrollEnabled(true);
        }}
        onMomentumScrollEnd={() => {
          recordsScrollRef.current?.setNativeProps?.({ scrollEnabled: true });
          setRecordsScrollEnabled(true);
        }}
      >
        {filters.map((filter) => (
          <TouchableOpacity
            key={filter.key}
            style={[
              styles.filterTab,
              {
                backgroundColor: selectedFilter === filter.key ? filter.color : theme.background,
                borderColor: filter.color,
                borderWidth: selectedFilter === filter.key ? 0 : 1,
                paddingHorizontal: Platform.select({ web: isSmallScreen ? 16 : 14, default: 10 }),
                paddingVertical: Platform.select({ web: isSmallScreen ? 10 : 9, default: 5 }),
                borderRadius: Platform.select({ web: 18, default: 14 }),
                marginRight: Platform.select({ web: 10, default: 8 }),
                minHeight: Platform.select({ web: 38, default: 28 }),
                justifyContent: 'center',
                alignItems: 'center',
              },
              selectedFilter === filter.key && styles.activeFilterTab,
            ]}
            onPress={() => setSelectedFilter(filter.key)}
          >
            <Text style={[
              styles.filterText,
              { 
                color: selectedFilter === filter.key ? '#ffffff' : filter.color, 
                fontWeight: isSmallScreen ? '500' : '400',
                fontSize: Platform.select({ web: isSmallScreen ? 13 : 14, default: 11 }),
              }
            ]}>
              {filter.label} ({getFeesCountByCategory(filter.key)})
            </Text>
          </TouchableOpacity>
        ))}
      </GHScrollView>
    </View>

    {/* Search box */}
    <View style={{ width: '100%', marginBottom: 4 }}>
      <View style={[styles.searchContainer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
        <Search size={18} color={theme.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: theme.text }]}
          placeholder="Search by student, parent, grade, subject, amount, due date, or status"
          placeholderTextColor={theme.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} accessibilityLabel="Clear search">
            <X size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        )}
      </View>
    </View>

    {/* Sort / Hide Paid Row */}
    <View style={{ 
      width: '100%', 
      flexDirection: 'row', 
      alignItems: 'center', 
      marginTop: 0,
      marginBottom: 5, 
      justifyContent: 'space-between',
      minHeight: 44,
    }}>
      <TouchableOpacity
        style={[styles.sortButton, { 
          backgroundColor: theme.surface, 
          borderColor: theme.border,
          paddingHorizontal: 10,
          paddingVertical: 6,
          minHeight: 30,
          borderRadius: 8
        }]}
        onPress={() => {
          const options = ['date', 'amount', 'student'] as const;
          const currentIndex = options.indexOf(sortBy);
          const nextIndex = (currentIndex + 1) % options.length;
          setSortBy(options[nextIndex]);
        }}
      >
        <Filter size={14} color={theme.primary} />
        <Text style={[styles.sortText, { 
          color: theme.primary, 
          fontSize: isSmallScreen ? 11 : 12,
          marginLeft: 4
        }]}> 
          Sort by {sortBy === 'date' ? 'Date' : sortBy === 'amount' ? 'Amount' : 'Student'}
        </Text>
      </TouchableOpacity>

      {selectedFilter === 'All' && (
        <TouchableOpacity
          style={[styles.inlineToggleButton, { 
            paddingHorizontal: 8,
            paddingVertical: 8,
            minHeight: 36,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8
          }]}
          onPress={() => setHidePaidFees(!hidePaidFees)}
        >
          <Text style={[styles.inlineToggleText, { 
            color: theme.text,
            fontSize: isSmallScreen ? 12 : 13
          }]}> 
            {hidePaidFees ? 'Show Paid' : 'Hide Paid'}
          </Text>
          <View style={[styles.smallToggleSwitch, { 
            backgroundColor: hidePaidFees ? theme.primary : theme.border
          }]}> 
            <View style={[styles.smallToggleThumb, { 
              backgroundColor: '#ffffff',
              transform: [{ translateX: hidePaidFees ? 14 : 2 }]
            }]} />
          </View>
        </TouchableOpacity>
      )}
    </View>
  </View>

  {/* Fee Records */}
        {Object.keys(groupedRecords).length > 0 ? (
          Object.entries(groupedRecords).map(([month, records]) => {
            const isOverdue = month.includes('(Overdue)');
            const cleanMonth = month.replace(' (Overdue)', '');
            const displayMonth = isOverdue ? `Since ${cleanMonth}` : cleanMonth;
            const overdueCount = isOverdue ? records.length : 0;
            const totalOverdueAmount = isOverdue ? records.reduce((sum, record) => {
              // Calculate correct amount for overdue calculation
              const recordAmount = record.monthFeeAmounts && record.monthsCovered 
                ? record.monthsCovered.reduce((sum: number, month: string) => 
                    sum + (record.monthFeeAmounts?.[month] || 0), 0)
                : record.amount;
              return sum + (recordAmount - (record.paidAmount || 0));
            }, 0) : 0;

            return (
              <View key={month} style={styles.monthGroup}>
                <View style={[styles.monthHeaderContainer, isOverdue && { backgroundColor: `${getStatusColor('overdue')}10`, padding: 12, borderRadius: 8, borderLeftWidth: 4, borderLeftColor: getStatusColor('overdue') }]}>
                  <Text style={[styles.monthHeader, { color: isOverdue ? getStatusColor('overdue') : theme.text }]}> 
                    {displayMonth}
                    {isOverdue && (
                      <Text style={[styles.overdueIndicator, { color: getStatusColor('overdue') }]}> 
                        {' '}(Overdue)
                      </Text>
                    )}
                  </Text>
                  {isOverdue && (
                    <View style={styles.overdueStats}>
                      <Text style={[styles.overdueStatsText, { color: getStatusColor('overdue') }]}>
                        {overdueCount} items • ₹{totalOverdueAmount.toLocaleString()} pending
                      </Text>
                    </View>
                  )}
                </View>
                {records.map((record) => {
                  const category = categorizeFee(record);
                  const StatusIcon = getStatusIcon(category);
                  const statusColor = getStatusColor(category);
                  const student = studentMap[record.studentId];

                  return (
                    <TouchableOpacity 
                      key={record.id} 
                      style={[styles.recordCard, { backgroundColor: theme.surface }]}
                      onPress={() => handleFeeClick(record)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.recordHeader}>
                        <View style={styles.studentInfo}>
                          <View style={styles.studentNameRow}>
                            <Text style={[styles.studentName, { color: theme.text }]}>{record.studentName}</Text>
                            {record.monthsCovered && record.monthsCovered.length > 1 && (
                              <View style={[styles.consolidatedBadge, { backgroundColor: `${theme.primary}15`, borderColor: theme.primary }]}>
                                <Text style={[styles.consolidatedText, { color: theme.primary }]}>
                                  {record.monthsCovered.length} months
                                </Text>
                              </View>
                            )}
                          </View>
                          <View style={styles.subjectsRow}>
                            {(student?.subjects || []).map((subject: string, index: number) => (
                              <Text key={index} style={[styles.subjectTag, { color: theme.primary, backgroundColor: `${theme.primary}15` }]}>
                                {subject}
                              </Text>
                            ))}
                          </View>
                        </View>
                        <View style={styles.amountContainer}>
                          <Text style={[styles.amount, { color: theme.text }]}>
                            ₹{(() => {
                              // Calculate correct amount for display
                              if (record.monthFeeAmounts && record.monthsCovered) {
                                // Use sum of individual month amounts for consolidated fees
                                return record.monthsCovered.reduce((sum: number, month: string) => 
                                  sum + (record.monthFeeAmounts?.[month] || 0), 0
                                ).toLocaleString();
                              }
                              // Fallback to stored amount
                              return record.amount.toLocaleString();
                            })()}
                          </Text>
                          {(record.paidAmount || 0) > 0 && category === 'partial' && (
                            <Text style={[styles.paidAmount, { color: theme.success }]}>
                              Paid: ₹{record.paidAmount.toLocaleString()}
                            </Text>
                          )}
                          <View style={[styles.statusContainer, { backgroundColor: `${statusColor}15` }]}>
                            <StatusIcon size={12} color={statusColor} />
                            <Text style={[styles.statusText, { color: statusColor }]}>
                              {category.charAt(0).toUpperCase() + category.slice(1)}
                            </Text>
                          </View>
                        </View>
                      </View>

                      <View style={styles.recordDetails}>
                        {(() => {
                          const latestTx = getPaymentTransactions(record)[0];
                          const latestAmount = latestTx?.amount;
                          const latestAmountNum = typeof latestAmount === 'number'
                            ? latestAmount
                            : typeof latestAmount === 'string'
                              ? Number(latestAmount)
                              : NaN;
                          const hasLatestAmount = Number.isFinite(latestAmountNum) && latestAmountNum > 0;
                          const hasLatestPaymentDate = !!latestTx?.paymentDate;
                          const hasLatestMethod = typeof latestTx?.method === 'string' && latestTx.method.trim().length > 0;

                          if ((record.paidAmount || 0) <= 0 || (!hasLatestPaymentDate && !hasLatestMethod)) {
                            return null;
                          }

                          return (
                            <>
                              {hasLatestPaymentDate && (
                                <View style={styles.detailItem}>
                                  <CheckCircle size={14} color={theme.success} />
                                  <Text style={[styles.detailText, { color: theme.textSecondary }]}>
                                    Last payment:{' '}
                                    {hasLatestAmount ? `₹${latestAmountNum.toLocaleString()} • ` : ''}
                                    {formatPaidTimestamp(latestTx.paymentDate)}
                                  </Text>
                                </View>
                              )}
                              {hasLatestMethod && (
                                <View style={styles.detailItem}>
                                  <DollarSign size={14} color={theme.primary} />
                                  <Text style={[styles.detailText, { color: theme.textSecondary }]}>via {latestTx.method}</Text>
                                </View>
                              )}
                            </>
                          );
                        })()}
                        <View style={styles.detailItem}>
                          <Calendar size={14} color={theme.textSecondary} />
                          <Text style={[styles.detailText, { color: theme.textSecondary }]}>Due: {record.dueDate}</Text>
                        </View>
                        {record.monthsCovered && record.monthsCovered.length > 1 && (
                          <View style={styles.detailItem}>
                            <Calendar size={14} color={theme.primary} />
                            <Text style={[styles.detailText, { color: theme.primary }]}>
                              Covers {record.monthsCovered.length} months: {
                                (() => {
                                  const firstMonth = generateMonthOptions.find(m => m.value === record.monthsCovered[0])?.label;
                                  const lastMonth = generateMonthOptions.find(m => m.value === record.monthsCovered[record.monthsCovered.length - 1])?.label;
                                  return `${firstMonth} to ${lastMonth}`;
                                })()
                              }
                            </Text>
                          </View>
                        )}
                        {((record.monthlyFeeAmount && record.monthsCovered && record.monthsCovered.length > 1) || 
                          (record.monthFeeAmounts && record.monthsCovered && record.monthsCovered.length > 1)) && (
                          <View style={styles.detailItem}>
                            <DollarSign size={14} color={theme.textSecondary} />
                            <Text style={[styles.detailText, { color: theme.textSecondary }]}>
                              {record.monthFeeAmounts ? (
                                `Individual amounts: ${record.monthsCovered.sort().map((month: string) => `₹${record.monthFeeAmounts[month]?.toLocaleString() || '0'}`).join(', ')}`
                              ) : (
                                `₹${record.monthlyFeeAmount.toLocaleString()}/month × ${record.monthsCovered.length} months`
                              )}
                            </Text>
                          </View>
                        )}
                        {isOverdue && (
                          <View style={styles.detailItem}>
                            <AlertCircle size={14} color={getStatusColor('overdue')} />
                            <Text style={[styles.detailText, { color: getStatusColor('overdue') }]}>
                              {Math.floor((new Date().getTime() - new Date(record.dueDate).getTime()) / (1000 * 60 * 60 * 24))} days overdue
                            </Text>
                          </View>
                        )}
                        {record.status === 'paid' && record.paidDate && (
                          <View style={styles.detailItem}>
                            <CheckCircle size={14} color={theme.success} />
                            <Text style={[styles.detailText, { color: theme.textSecondary }]}>Paid in full: {formatPaidTimestamp(record.paidDate)}</Text>
                          </View>
                        )}
                        {(() => {
                          const latestReminder = studentReminders[record.studentId];
                          if (latestReminder) {
                            const reminderIcon = latestReminder.reminderType === 'email' ? Mail :
                                               latestReminder.reminderType === 'sms' ? MessageSquare :
                                               latestReminder.reminderType === 'whatsapp' ? MessageSquare :
                                               latestReminder.reminderType === 'voice' ? Phone : Send;
                            const IconComponent = reminderIcon;
                            const statusColor = latestReminder.status === 'success' ? theme.success :
                                              latestReminder.status === 'failed' ? theme.error : theme.warning;
                            
                            return (
                              <View style={styles.detailItem}>
                                <IconComponent size={14} color={statusColor} />
                                <Text style={[styles.detailText, { color: theme.textSecondary }]}>
                                  {latestReminder.reminderType?.toUpperCase()} {latestReminder.status} • {formatReminderDate(latestReminder.createdAt)}
                                </Text>
                              </View>
                            );
                          } else if (record.lastReminder) {
                            // Fallback to legacy reminder info
                            return (
                              <View style={styles.detailItem}>
                                <Send size={14} color={theme.warning} />
                                <Text style={[styles.detailText, { color: theme.textSecondary }]}>Last reminder: {record.lastReminder}</Text>
                              </View>
                            );
                          }
                          return null;
                        })()}
                      </View>

                      <View style={[styles.actionButtons, { borderTopColor: theme.border }]}>
                        {/* Receipt buttons - only show for paid or partial fees */}
                        {(category === 'paid' || category === 'partial') && (
                          <>
                            {record.receipts && record.receipts.length > 0 ? (
                              <TouchableOpacity
                                style={[styles.actionButton, { backgroundColor: `${theme.success}15` }]}
                                onPress={(e) => {
                                  e.stopPropagation();
                                  const latestFee = fees.find(f => f.id === record.id) || record;
                                  setSelectedFee(latestFee);
                                  setSelectedReceipt(null);
                                  setShowReceiptModal(true);
                                }}
                              >
                                <Eye size={16} color={theme.success} />
                                {category !== 'partial' && (
                                  <Text style={[styles.actionButtonText, { color: theme.success }]}>
                                    View Receipt ({record.receipts.length})
                                  </Text>
                                )}
                              </TouchableOpacity>
                            ) : (
                              <TouchableOpacity
                                style={[styles.actionButton, { backgroundColor: `${theme.primary}15` }]}
                                onPress={(e) => {
                                  e.stopPropagation();
                                  const latestFee = fees.find(f => f.id === record.id) || record;
                                  setSelectedFee(latestFee);
                                  setShowReceiptUpload(true);
                                }}
                              >
                                <Upload size={16} color={theme.primary} />
                                {category !== 'partial' && (
                                  <Text style={[styles.actionButtonText, { color: theme.primary }]}>Upload Receipt</Text>
                                )}
                              </TouchableOpacity>
                            )}
                          </>
                        )}

                        {category !== 'paid' && (
                          <>
                            <TouchableOpacity
                              style={[styles.actionButton, { backgroundColor: theme.background }]}
                              onPress={(e) => {
                                e.stopPropagation();
                                handleSendReminder(record);
                              }}
                            >
                              <Send size={16} color={theme.primary} />
                              {category !== 'partial' && (
                                <Text style={[styles.actionButtonText, { color: theme.primary }]}>Send Reminder</Text>
                              )}
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.actionButton, styles.paidButton, { backgroundColor: `${theme.success}15` }]}
                              onPress={(e) => {
                                e.stopPropagation();
                                handleMarkAsPaid(record);
                              }}
                            >
                              <CheckCircle size={16} color={theme.success} />
                              {category !== 'partial' && (
                                <Text style={[styles.actionButtonText, { color: theme.success }]}> 
                                  Mark Paid
                                </Text>
                              )}
                            </TouchableOpacity>
                          </>
                        )}

                        <TouchableOpacity
                          style={[styles.actionButton, { backgroundColor: theme.background, opacity: isDeletingFee ? 0.6 : 1 }]}
                          onPress={(e) => {
                            e.stopPropagation();
                            handleDeleteFee(record);
                          }}
                          disabled={isDeletingFee}
                        >
                          <Trash2 size={16} color="#EF4444" />
                          {category !== 'partial' && (
                            <Text style={[styles.actionButtonText, { color: "#EF4444" }]}>Delete</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            );
          })
        ) : (
          <View style={[styles.emptyState, { backgroundColor: theme.surface }]}>
            <Text style={[styles.emptyStateText, { color: theme.text }]}>No fee records found</Text>
            <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}>Fee records will appear here once students are added</Text>
          </View>
        )}
  </GHScrollView>

      {/* Add Fee Modal */}
      <Modal
        visible={showAddFeeModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => closeAddFeeModal()}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Add New Fee</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => closeAddFeeModal()}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 20, default: 40 }),
            }}
          >
            <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: theme.text }]}>Student *</Text>
              <View style={[styles.pickerContainer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                <TouchableOpacity
                  style={[
                    styles.customPickerButton,
                    styles.studentSelectorButton,
                    { backgroundColor: theme.surface },
                  ]}
                  onPress={() => setShowStudentSelectModal(true)}
                >
                  <View style={styles.studentSelectorContent}>
                    <Text style={[styles.customPickerLabel, { color: theme.textSecondary }]}>Student</Text>
                    <Text
                      style={[
                        styles.customPickerValue,
                        { color: addFeeForm.studentId ? theme.text : theme.textSecondary },
                      ]}
                      numberOfLines={1}
                    >
                      {addFeeForm.studentName || 'Select a student'}
                    </Text>
                  </View>
                  <ChevronDown size={18} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: theme.text }]}>Due Month *</Text>
              <View
                style={[styles.pickerContainer, { borderColor: theme.border, backgroundColor: theme.surface, pointerEvents: 'box-none' }]}
              >
                <TouchableOpacity
                  style={[
                    styles.customPickerButton,
                    {
                      backgroundColor: theme.surface,
                      opacity: addFeeMonthOptions.length === 0 ? 0.6 : 1,
                    },
                  ]}
                  onPress={() => setShowDueMonthModal(true)}
                  disabled={addFeeMonthOptions.length === 0}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.customPickerLabel, { color: theme.textSecondary }]}>Due Month</Text>
                    <Text style={[styles.customPickerValue, { color: dueMonthLabel ? theme.text : theme.textSecondary }]}>
                      {dueMonthLabel || dueMonthPlaceholder}
                    </Text>
                  </View>
                  <ChevronDown size={18} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.inputGroup}>
              <View style={styles.amountHeader}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Monthly Fee *</Text>
                {addFeeForm.amount && (
                  <TouchableOpacity
                    style={[styles.editAmountButton, { borderColor: theme.primary }]}
                    onPress={() => setCanEditAmount(!canEditAmount)}
                  >
                    <Text style={[styles.editAmountText, { color: theme.primary }]}>
                      {canEditAmount ? 'Lock Monthly Fee' : 'Edit Monthly Fee'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={[
                  styles.textInput, 
                  { 
                    color: canEditAmount ? theme.text : theme.textSecondary, 
                    borderColor: theme.border, 
                    backgroundColor: canEditAmount ? theme.surface : theme.surface + '50' 
                  }
                ]}
                value={addFeeForm.amount}
                onChangeText={(value: string) => {
                  if (canEditAmount) {
                    setAddFeeForm(prev => ({ ...prev, amount: value }));
                  }
                }}
                placeholder="Monthly fee will be calculated automatically"
                placeholderTextColor={theme.textSecondary}
                keyboardType="numeric"
                editable={canEditAmount}
              />
              {!canEditAmount && addFeeForm.amount && (
                <Text style={[styles.helperText, { color: theme.textSecondary }]}>
                  Monthly fee calculated from student’s monthly fee (will be used for each month)
                </Text>
              )}
            </View>

            {/* Individual Month Fee Editor */}
            {addFeeForm.studentId && addFeeForm.dueMonth && (() => {
              const months = calculateMonthsToCreate(addFeeForm.dueMonth, addFeeForm.studentId);
              return months.length > 1 ? (
                <View style={styles.inputGroup}>
                  <View style={styles.amountHeader}>
                    <Text style={[styles.inputLabel, { color: theme.text }]}>
                      Individual Month Fees ({months.length} months)
                    </Text>
                    <TouchableOpacity
                      style={[styles.editAmountButton, { borderColor: theme.primary }]}
                      onPress={() => {
                        if (!showIndividualMonthEditor) {
                          // Initialize with current amount for all months
                          initializeMonthFees(months, addFeeForm.amount);
                        }
                        setShowIndividualMonthEditor(!showIndividualMonthEditor);
                      }}
                    >
                      <Text style={[styles.editAmountText, { color: theme.primary }]}>
                        {showIndividualMonthEditor ? 'Use Same Amount for All' : 'Edit Individual Amounts'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  
                  {showIndividualMonthEditor ? (
                    <View style={styles.monthFeeEditor}>
                      {months.map((month) => {
                        const monthLabel = generateMonthOptions.find(m => m.value === month)?.label;
                        return (
                          <View key={month} style={styles.monthFeeRow}>
                            <View style={styles.monthFeeLabel}>
                              <Text style={[styles.monthFeeLabelText, { color: theme.text }]}>
                                {monthLabel}
                              </Text>
                            </View>
                            <View style={styles.monthFeeInput}>
                              <TextInput
                                style={[
                                  styles.textInput,
                                  styles.monthFeeInputField,
                                  { 
                                    color: theme.text, 
                                    borderColor: theme.border, 
                                    backgroundColor: theme.surface 
                                  }
                                ]}
                                value={monthFeeAmounts[month] || ''}
                                onChangeText={(value: string) => {
                                  setMonthFeeAmounts(prev => ({
                                    ...prev,
                                    [month]: value
                                  }));
                                }}
                                placeholder="Amount"
                                placeholderTextColor={theme.textSecondary}
                                keyboardType="numeric"
                              />
                            </View>
                          </View>
                        );
                      })}
                      <View style={styles.monthFeeSummary}>
                        <Text style={[styles.monthFeeSummaryText, { color: theme.textSecondary }]}>
                          Total: ₹{calculateTotalFromMonthFees().toLocaleString()}
                        </Text>
                      </View>
                    </View>
                  ) : (
                    <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                      <Text style={[{ color: theme.textSecondary }]}>
                        Using ₹{parseFloat(addFeeForm.amount || '0').toLocaleString()} for each month
                        {months.length > 1 ? ` (Total: ₹${(parseFloat(addFeeForm.amount || '0') * months.length).toLocaleString()})` : ''}
                      </Text>
                    </View>
                  )}
                </View>
              ) : null;
            })()}

            <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: theme.text }]}>Description</Text>
              <TextInput
                style={[styles.textInput, styles.multilineInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]}
                value={addFeeForm.description}
                onChangeText={(value: string) => setAddFeeForm(prev => ({ ...prev, description: value }))}
                placeholder={`Monthly fees${addFeeForm.studentName ? ` for ${addFeeForm.studentName}` : ``} (fees from selected month up to due date)`}
                placeholderTextColor={theme.textSecondary}
                multiline
                numberOfLines={3}
              />
            </View>

            {addFeeForm.studentId && addFeeForm.amount && addFeeForm.dueMonth && (
              <View style={[styles.feePreview, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.previewTitle, { color: theme.text }]}>Fee Preview</Text>
                
                {(() => {
                  const startMonth = addFeeForm.dueMonth;
                  const currentMonth = getCurrentMonth();
                  const baseMonthlyAmount = parseFloat(addFeeForm.amount) || 0;

                  const generatedMonths = calculateMonthsToCreate(startMonth, addFeeForm.studentId);
                  const isFutureMonth = startMonth > currentMonth;
                  let previewMonths = isFutureMonth ? [startMonth] : [...generatedMonths];

                  const getMonthLabel = (value: string | undefined) => {
                    if (!value) return '—';
                    return generateMonthOptions.find(option => option.value === value)?.label || value;
                  };

                  const existingFeesForStudent = addFeeForm.studentId
                    ? fees.filter(fee => fee.studentId === addFeeForm.studentId)
                    : [];
                  const existingMonthsForStudent = addFeeForm.studentId
                    ? collectExistingMonthsForStudent(addFeeForm.studentId)
                    : new Set<string>();
                  const dueFees = existingFeesForStudent.filter(fee => fee.status !== 'paid');
                  const paidFees = existingFeesForStudent.filter(fee => fee.status === 'paid');
                  const hasOnlyPaidFees = paidFees.length > 0 && dueFees.length === 0 && !isFutureMonth;

                  const defaultDueDate = previewMonths.length > 0
                    ? calculateDueDateFromMonth(previewMonths[0], addFeeForm.studentId)
                    : '';
                  const defaultIsMultiple = previewMonths.length > 1;

                  let totalAmount = showIndividualMonthEditor
                    ? calculateTotalFromMonthFees()
                    : previewMonths.length * baseMonthlyAmount;
                  if (!Number.isFinite(totalAmount)) {
                    totalAmount = 0;
                  }

                  let totalAmountSuffix = '';
                  let dueDatePreview = defaultDueDate;
                  let isMultipleMonths = defaultIsMultiple;
                  let monthLabel = getMonthLabel(previewMonths[0] ?? startMonth);
                  let lastMonthLabel = isMultipleMonths
                    ? getMonthLabel(previewMonths[previewMonths.length - 1])
                    : monthLabel;
                  let statusText = '';
                  let statusColor = theme.warning;
                  let noticeText: string | null = null;
                  let monthlyAmountValue: string | null = null;
                  let breakdownEntries: { month: string; amount: number; isNew?: boolean; label: string }[];

                  const now = new Date();

                  const paidPreview = (() => {
                    if (!hasOnlyPaidFees) return null;

                    const targetFee = paidFees
                      .slice()
                      .sort((a, b) => {
                        const timestamp = (fee: any) => {
                          const source = fee?.updatedAt || fee?.createdAt;
                          return source ? new Date(source).getTime() : 0;
                        };
                        return timestamp(b) - timestamp(a);
                      })[0];

                    if (!targetFee) return null;

                    const existingMonthsRaw = Array.isArray(targetFee.monthsCovered) && targetFee.monthsCovered.length > 0
                      ? [...targetFee.monthsCovered]
                      : targetFee.dueDate
                        ? [String(targetFee.dueDate).substring(0, 7)]
                        : [];

                    const existingMonths = existingMonthsRaw
                      .map(normalizeMonthString)
                      .filter((value): value is string => Boolean(value));
                    const uniqueExistingMonths = Array.from(new Set(existingMonths)).sort();

                    const normalizedExistingAmounts = Object.entries(targetFee.monthFeeAmounts || {}).reduce((acc, [month, amount]) => {
                      const normalizedMonth = normalizeMonthString(month) || month;
                      const numericAmount = typeof amount === 'number' ? amount : Number(amount);
                      if (normalizedMonth) {
                        acc[normalizedMonth] = Number.isFinite(numericAmount) ? numericAmount : 0;
                      }
                      return acc;
                    }, {} as Record<string, number>);

                    if (uniqueExistingMonths.length > 0 && Object.keys(normalizedExistingAmounts).length === 0) {
                      const inferredBase = (() => {
                        if (typeof targetFee.monthlyFeeAmount === 'number') {
                          return targetFee.monthlyFeeAmount;
                        }
                        const storedTotal = Number(targetFee.amount || 0);
                        return uniqueExistingMonths.length > 0 && Number.isFinite(storedTotal)
                          ? storedTotal / uniqueExistingMonths.length
                          : storedTotal;
                      })();

                      uniqueExistingMonths.forEach(month => {
                        normalizedExistingAmounts[month] = Number.isFinite(inferredBase) ? Number(inferredBase) : 0;
                      });
                    }

                    const candidateNewMonths = generatedMonths.filter(month => !uniqueExistingMonths.includes(month));

                    const updatedMonthFeeAmounts: Record<string, number> = { ...normalizedExistingAmounts };
                    const newMonthAmounts: Record<string, number> = {};

                    candidateNewMonths.forEach(month => {
                      const resolvedAmount = showIndividualMonthEditor
                        ? parseFloat(monthFeeAmounts[month] || addFeeForm.amount || '0')
                        : baseMonthlyAmount;

                      newMonthAmounts[month] = Number.isFinite(resolvedAmount) && resolvedAmount > 0
                        ? resolvedAmount
                        : 0;
                      updatedMonthFeeAmounts[month] = newMonthAmounts[month];
                    });

                    const updatedMonthsCovered = Array.from(new Set([...uniqueExistingMonths, ...candidateNewMonths]))
                      .map(value => normalizeMonthString(value) || value)
                      .filter((value, index, array) => array.indexOf(value) === index)
                      .sort();

                    const previousTotal = Object.values(normalizedExistingAmounts).reduce((sum, value) => sum + Number(value || 0), 0);
                    const addedTotal = Object.values(newMonthAmounts).reduce((sum, value) => sum + Number(value || 0), 0);
                    const combinedTotal = Object.values(updatedMonthFeeAmounts).reduce((sum, value) => sum + Number(value || 0), 0);

                    return {
                      targetFee,
                      updatedMonthsCovered,
                      updatedMonthFeeAmounts,
                      existingMonths: uniqueExistingMonths,
                      newMonths: candidateNewMonths,
                      previousTotal,
                      addedTotal,
                      combinedTotal,
                      addedMonthLabels: candidateNewMonths.map(month => getMonthLabel(month)),
                    };
                  })();

                  if (paidPreview) {
                    previewMonths = paidPreview.updatedMonthsCovered.length > 0 ? paidPreview.updatedMonthsCovered : previewMonths;
                    isMultipleMonths = previewMonths.length > 1;
                    monthLabel = getMonthLabel(previewMonths[0] ?? startMonth);
                    lastMonthLabel = isMultipleMonths
                      ? getMonthLabel(previewMonths[previewMonths.length - 1])
                      : monthLabel;

                    totalAmount = paidPreview.combinedTotal;
                    totalAmountSuffix = paidPreview.previousTotal > 0
                      ? ` (was ₹${paidPreview.previousTotal.toLocaleString()})`
                      : '';
                    dueDatePreview = previewMonths.length > 0
                      ? calculateDueDateFromMonth(previewMonths[0], addFeeForm.studentId)
                      : '';

                    const targetStatus = paidPreview.targetFee.status;
                    if (paidPreview.newMonths.length === 0) {
                      statusText = 'All selected months are already recorded. No changes will be made.';
                      statusColor = theme.textSecondary;
                    } else if (targetStatus === 'paid') {
                      statusText = 'Existing paid fee will be extended and marked partial.';
                      statusColor = theme.warning;
                    } else {
                      statusText = 'Existing fee will be extended to include the new months.';
                      statusColor = theme.warning;
                    }

                    monthlyAmountValue = !showIndividualMonthEditor && paidPreview.newMonths.length > 0
                      ? `₹${baseMonthlyAmount.toLocaleString()} (applied to ${paidPreview.newMonths.length} new ${paidPreview.newMonths.length === 1 ? 'month' : 'months'})`
                      : null;

                    breakdownEntries = previewMonths.map(month => ({
                      month,
                      amount: Number(paidPreview.updatedMonthFeeAmounts[month] || 0),
                      isNew: paidPreview.newMonths.includes(month),
                      label: getMonthLabel(month),
                    }));

                    noticeText = paidPreview.newMonths.length === 0
                      ? 'ℹ️ Selected months are already covered by the latest paid fee.'
                      : `ℹ️ Existing paid fee will be extended to include ${paidPreview.addedMonthLabels.join(', ')}.`;
                  } else {
                    breakdownEntries = previewMonths.map(month => {
                      const normalizedMonth = normalizeMonthString(month) || month;
                      return {
                        month,
                        amount: parseFloat(monthFeeAmounts[month] || addFeeForm.amount || '0') || 0,
                        label: getMonthLabel(month),
                        isNew: !existingMonthsForStudent.has(normalizedMonth),
                      };
                    });
                  }

                  if (!paidPreview) {
                    const normalizedPreviewMonths = Array.from(new Set(
                      previewMonths
                        .map(month => normalizeMonthString(month) || month)
                        .filter((value): value is string => Boolean(value))
                    ));

                    const allMonthsAlreadyCovered = normalizedPreviewMonths.length > 0 &&
                      normalizedPreviewMonths.every(month => existingMonthsForStudent.has(month));

                    if (allMonthsAlreadyCovered) {
                      totalAmount = 0;
                      totalAmountSuffix = ' (already recorded)';
                      statusText = 'All selected months are already recorded. No changes will be made.';
                      statusColor = theme.textSecondary;
                      noticeText = 'ℹ️ These months are already part of existing fees. Nothing new will be created.';
                      monthlyAmountValue = null;
                    } else {
                      if (previewMonths.length === 0) {
                        statusText = 'No payable months yet. The due date has not passed.';
                        statusColor = theme.textSecondary;
                      } else if (isFutureMonth) {
                        statusText = 'Future fee will be created separately.';
                        statusColor = theme.warning;
                      } else {
                        const dueDateForStatus = previewMonths.length > 0
                          ? new Date(calculateDueDateFromMonth(previewMonths[0], addFeeForm.studentId))
                          : null;
                        statusColor = dueDateForStatus && dueDateForStatus < now ? theme.error : theme.warning;
                        statusText = isMultipleMonths
                          ? 'Single consolidated fee will be created.'
                          : 'Single monthly fee will be created.';
                      }

                      if (!showIndividualMonthEditor && isMultipleMonths) {
                        monthlyAmountValue = `₹${baseMonthlyAmount.toLocaleString()}`;
                      }

                      noticeText = (() => {
                        if (isFutureMonth) {
                          return '⚠️ Future fee will be created as a separate record to maintain clear month organization';
                        }

                        if (dueFees.length > 0) {
                          const currentMonthCovered = dueFees.some(fee => {
                            const feeMonth = fee.dueDate.substring(0, 7);
                            const monthsCovered = fee.monthsCovered || [];
                            return feeMonth === currentMonth || monthsCovered.includes(currentMonth);
                          });

                          if (currentMonthCovered) {
                            return isMultipleMonths
                              ? '⚠️ Current month fee will be updated; overlapping months may be skipped if already recorded.'
                              : '⚠️ Current month fee will be updated with the new amount.';
                          }

                          return isMultipleMonths
                            ? '⚠️ Current month will be added to the existing fee structure.'
                            : '⚠️ Current month will be added to the existing fee.';
                        }

                        if (existingFeesForStudent.length > 0) {
                          return isMultipleMonths
                            ? '⚠️ Single consolidated fee will be created for all selected months.'
                            : '⚠️ New monthly fee will be created.';
                        }

                        return isMultipleMonths
                          ? '⚠️ Single consolidated fee will be created for all selected months.'
                          : '⚠️ New monthly fee will be created.';
                      })();
                    }
                  }

                  const monthSummaryText = (() => {
                    if (previewMonths.length === 0) {
                      return 'No months available yet';
                    }

                    if (isMultipleMonths) {
                      const monthsCountText = `${previewMonths.length} month${previewMonths.length === 1 ? '' : 's'}`;
                      return `${monthLabel} to ${lastMonthLabel} (${monthsCountText})`;
                    }

                    return monthLabel;
                  })();

                  const dueDateText = dueDatePreview || (previewMonths.length > 0
                    ? calculateDueDateFromMonth(previewMonths[0], addFeeForm.studentId)
                    : '—');
                  return (
                    <View>
                      <View style={styles.previewRow}>
                        <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>Student:</Text>
                        <Text style={[styles.previewValue, { color: theme.text }]}>{addFeeForm.studentName}</Text>
                      </View>
                      <View style={styles.previewRow}>
                        <Text style={[styles.previewLabel, { color: theme.textSecondary }]}> 
                          {isMultipleMonths ? 'Months:' : 'Month:'}
                        </Text>
                        <Text style={[styles.previewValue, { color: theme.text }]}>{monthSummaryText}</Text>
                      </View>

                      {showIndividualMonthEditor && isMultipleMonths && breakdownEntries.length > 0 ? (
                        <View style={styles.previewRow}>
                          <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>Individual Fees:</Text>
                          <View style={{ flex: 1 }}>
                            {breakdownEntries.map(entry => {
                              const normalizedEntryMonth = normalizeMonthString(entry.month) || entry.month;
                              const suffix = entry.isNew
                                ? ' (new)'
                                : existingMonthsForStudent.has(normalizedEntryMonth)
                                  ? ' (existing)'
                                  : '';
                              return (
                                <Text
                                  key={entry.month}
                                  style={[
                                    styles.previewValue,
                                    {
                                      color: theme.text,
                                      fontSize: 12,
                                      textAlign: 'right',
                                    },
                                  ]}
                                >
                                  {`${entry.label}: ₹${Number(entry.amount || 0).toLocaleString()}${suffix}`}
                                </Text>
                              );
                            })}
                          </View>
                        </View>
                      ) : (
                        <View style={styles.previewRow}>
                          <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>Monthly fee amount:</Text>
                          <Text style={[styles.previewValue, { color: theme.text }]}>{monthlyAmountValue}</Text>
                        </View>
                      )}

                      <View style={[styles.previewRow, { borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 8, marginTop: 8 }]}>
                        <Text style={[styles.previewLabel, { color: theme.text, fontWeight: 'bold' }]}>Total Amount:</Text>
                        <Text style={[styles.previewValue, { color: theme.primary, fontWeight: 'bold', fontSize: 16 }]}>
                          ₹{Number(totalAmount || 0).toLocaleString()}
                          {totalAmountSuffix}
                        </Text>
                      </View>

                      <View style={styles.previewRow}>
                        <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>Due Date:</Text>
                        <Text style={[styles.previewValue, { color: theme.text }]}>
                          {dueDateText}
                        </Text>
                      </View>

                      <View style={styles.previewRow}>
                        <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>Status:</Text>
                        <Text style={[styles.previewValue, { color: statusColor }]}>
                          {statusText}
                        </Text>
                      </View>

                      {noticeText && (
                        <View style={[styles.overwriteNotice, { backgroundColor: theme.warning + '20', borderColor: theme.warning }]}> 
                          <Text style={[styles.overwriteText, { color: theme.warning }]}>
                            {noticeText}
                          </Text>
                        </View>
                      )}
                    </View>
                  );
                })()}
              </View>
            )}
          </ScrollView>

          <View style={[styles.modalFooter, { borderTopColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.modalButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => closeAddFeeModal()}
            >
              <Text style={[styles.buttonText, { color: theme.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modalButton,
                styles.submitButton,
                {
                  backgroundColor: createFeeButtonState.disabled ? theme.primary + '66' : theme.primary,
                  opacity: createFeeButtonState.disabled ? 0.7 : 1,
                },
              ]}
              onPress={handleAddFee}
              disabled={createFeeButtonState.disabled}
            >
              <Text style={[styles.buttonText, { color: 'white' }]}>
                {createFeeButtonState.label}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showDueMonthModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDueMonthModal(false)}
      >
        <View style={styles.dueMonthModalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowDueMonthModal(false)}>
            <View style={styles.dueMonthModalBackdrop} />
          </TouchableWithoutFeedback>

          <View style={[styles.dueMonthModalContainer, { backgroundColor: theme.surface }]}>
            <View style={[styles.dueMonthModalHandle, { backgroundColor: theme.border }]} />
            <View style={styles.dueMonthModalHeader}>
              <Text style={[styles.dueMonthModalTitle, { color: theme.text }]}>Select Due Month</Text>
              <TouchableOpacity
                style={styles.dueMonthModalCloseButton}
                onPress={() => setShowDueMonthModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {addFeeMonthOptions.length === 0 ? (
              <View style={styles.dueMonthEmptyState}>
                <Text style={[styles.dueMonthEmptyTitle, { color: theme.text }]}>No months available</Text>
                <Text style={[styles.dueMonthEmptyMessage, { color: theme.textSecondary }]}>
                  Adjust student settings or try again later.
                </Text>
              </View>
            ) : (
              <ScrollView
                ref={dueMonthListRef}
                style={styles.dueMonthOptionsList}
                contentContainerStyle={styles.dueMonthOptionsContent}
                showsVerticalScrollIndicator={false}
              >
                {addFeeMonthOptions.map(option => {
                  const isSelected = option.value === addFeeForm.dueMonth;

                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[
                        styles.dueMonthOption,
                        {
                          borderColor: isSelected ? theme.primary : theme.border,
                          backgroundColor: isSelected ? theme.primary + '10' : theme.surface,
                        },
                      ]}
                      onPress={() => handleSelectDueMonth(option.value)}
                    >
                      <Text style={[styles.dueMonthOptionLabel, { color: theme.text }]}>
                        {option.label}
                      </Text>
                      {isSelected && <Check size={18} color={theme.primary} />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        visible={showStudentSelectModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowStudentSelectModal(false)}
      >
        <View style={styles.studentModalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowStudentSelectModal(false)}>
            <View style={styles.studentModalBackdrop} />
          </TouchableWithoutFeedback>

          <View style={[styles.studentModalContainer, { backgroundColor: theme.surface }]}> 
            <View style={styles.studentModalHeader}>
              <Text style={[styles.studentModalTitle, { color: theme.text }]}>Select Student</Text>
              <TouchableOpacity
                style={styles.studentModalCloseButton}
                onPress={() => setShowStudentSelectModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={[styles.studentSearchContainer, { borderColor: theme.border, backgroundColor: theme.background }]}> 
              <Search size={16} color={theme.textSecondary} style={styles.studentSearchIcon} />
              <TextInput
                style={[styles.studentSearchInput, { color: theme.text }]}
                placeholder="Search by name, grade, or contact"
                placeholderTextColor={theme.textSecondary}
                value={studentSearchQuery}
                onChangeText={setStudentSearchQuery}
                autoFocus
              />
            </View>

            <ScrollView
              style={styles.studentList}
              contentContainerStyle={styles.studentListContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {studentsLoading ? (
                <View style={styles.studentLoadingState}>
                  <ActivityIndicator color={theme.primary} />
                  <Text style={[styles.studentLoadingText, { color: theme.textSecondary }]}>Loading students…</Text>
                </View>
              ) : filteredStudents.length === 0 ? (
                <View style={styles.studentEmptyState}>
                  <Text style={[styles.studentEmptyTitle, { color: theme.text }]}>No students found</Text>
                  <Text style={[styles.studentEmptyMessage, { color: theme.textSecondary }]}>Try a different search term.</Text>
                </View>
              ) : (
                filteredStudents.map(student => {
                  const isSelected = addFeeForm.studentId === student.id;
                  return (
                    <TouchableOpacity
                      key={student.id}
                      style={[
                        styles.studentOption,
                        {
                          borderColor: isSelected ? theme.primary : theme.border,
                          backgroundColor: isSelected ? theme.primary + '10' : theme.surface,
                        },
                      ]}
                      onPress={() => {
                        handleStudentSelection(student.id);
                        setShowStudentSelectModal(false);
                        setStudentSearchQuery('');
                      }}
                    >
                      <View style={styles.studentOptionInfo}>
                        <Text style={[styles.studentOptionName, { color: theme.text }]} numberOfLines={1}>
                          {student.name || 'Unnamed Student'}
                        </Text>
                        <View style={styles.studentOptionMetaRow}>
                          {student.grade ? (
                            <Text style={[styles.studentOptionMeta, { color: theme.textSecondary }]}>Grade {student.grade}</Text>
                          ) : null}
                          {student.phone ? (
                            <Text style={[styles.studentOptionMeta, { color: theme.textSecondary }]}>
                              {student.phone}
                            </Text>
                          ) : null}
                        </View>
                        {student.parentName ? (
                          <Text style={[styles.studentOptionMeta, { color: theme.textSecondary }]} numberOfLines={1}>
                            Parent: {student.parentName}
                          </Text>
                        ) : null}
                      </View>
                      {isSelected ? <Check size={18} color={theme.primary} /> : null}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Payment Modal */}
      <Modal
        visible={showPaymentModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowPaymentModal(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              {paymentForm.isPartial ? 'Pay Remaining Amount' : 'Mark as Paid'}
            </Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowPaymentModal(false)}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 20 }),
            }}
          >
            <View style={[styles.feeInfo, { borderBottomColor: theme.border }]}>
              <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Student</Text>
              <Text style={[styles.infoValue, { color: theme.text }]}>{selectedFee?.studentName}</Text>
              
              <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Total Amount</Text>
              <Text style={[styles.infoValue, { color: theme.text }]}>₹{selectedFee ? getCorrectFeeAmount(selectedFee).toLocaleString() : '0'}</Text>
              
              {paymentForm.isPartial && (
                <View>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Already Paid</Text>
                  <Text style={[styles.infoValue, { color: theme.success }]}>₹{selectedFee?.paidAmount?.toLocaleString()}</Text>
                  
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Remaining Amount</Text>
                  <Text style={[styles.infoValue, { color: theme.warning }]}>
                    ₹{selectedFee ? (getCorrectFeeAmount(selectedFee) - (selectedFee.paidAmount || 0)).toLocaleString() : '0'}
                  </Text>
                </View>
              )}
            </View>

            {/* Payment Type Selection for Consolidated Fees */}
            {selectedFee?.monthsCovered && selectedFee.monthsCovered.length > 1 && (
              <View style={[styles.formSection, { borderTopColor: theme.border }]}>
                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.text }]}>Payment Type *</Text>
                  <View style={styles.paymentTypeContainer}>
                    <TouchableOpacity
                      style={[
                        styles.paymentTypeOption,
                        { 
                          backgroundColor: paymentForm.paymentType === 'full' ? theme.primary : theme.surface,
                          borderColor: paymentForm.paymentType === 'full' ? theme.primary : theme.border
                        }
                      ]}
                      onPress={() => {
                        setPaymentForm(prev => ({ 
                          ...prev, 
                          paymentType: 'full',
                          selectedMonths: [],
                          amount: prev.isPartial ? ((selectedFee?.amount || 0) - (selectedFee?.paidAmount || 0)).toString() : selectedFee?.amount.toString()
                        }));
                      }}
                    >
                      <Text style={[
                        styles.paymentTypeText,
                        { color: paymentForm.paymentType === 'full' ? 'white' : theme.text }
                      ]}>
                        Pay Full Amount
                      </Text>
                    </TouchableOpacity>
                    
                    <TouchableOpacity
                      style={[
                        styles.paymentTypeOption,
                        { 
                          backgroundColor: paymentForm.paymentType === 'individual' ? theme.primary : theme.surface,
                          borderColor: paymentForm.paymentType === 'individual' ? theme.primary : theme.border
                        }
                      ]}
                      onPress={() => {
                        setPaymentForm(prev => ({ 
                          ...prev, 
                          paymentType: 'individual',
                          selectedMonths: [],
                          amount: ''
                        }));
                      }}
                    >
                      <Text style={[
                        styles.paymentTypeText,
                        { color: paymentForm.paymentType === 'individual' ? 'white' : theme.text }
                      ]}>
                        Pay Individual Months
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Individual Month Selection */}
                {paymentForm.paymentType === 'individual' && (
                  <View style={styles.inputGroup}>
                    <Text style={[styles.inputLabel, { color: theme.text }]}>Select Months to Pay *</Text>
                    <View style={styles.monthSelection}>
                      {selectedFee.monthsCovered.map((month: string) => {
                        const isSelected = paymentForm.selectedMonths.includes(month);
                        const monthLabel = generateMonthOptions.find(m => m.value === month)?.label;
                        const remainingAmount = getRemainingAmountForMonth(selectedFee, month);
                        const paymentStatus = getMonthPaymentStatus(selectedFee, month);
                        const isPaid = paymentStatus === 'paid';
                        const isPartiallyPaid = paymentStatus === 'partial';
                        
                        return (
                          <TouchableOpacity
                            key={month}
                            style={[
                              styles.monthOption,
                              {
                                backgroundColor: isPaid 
                                  ? theme.success + '20'
                                  : isSelected 
                                    ? theme.primary + '20'
                                    : isPartiallyPaid
                                      ? theme.warning + '10'
                                      : theme.surface,
                                borderColor: isPaid 
                                  ? theme.success
                                  : isSelected 
                                    ? theme.primary
                                    : isPartiallyPaid
                                      ? theme.warning
                                      : theme.border,
                                opacity: isPaid ? 0.6 : 1
                              }
                            ]}
                            onPress={() => {
                              if (isPaid) return; // Don't allow selecting already paid months
                              
                              const newSelectedMonths = isSelected
                                ? paymentForm.selectedMonths.filter(m => m !== month)
                                : [...paymentForm.selectedMonths, month];
                              
                              // Calculate total amount based on remaining amounts for selected months
                              const totalAmount = newSelectedMonths.reduce((sum, selectedMonth) => {
                                return sum + getRemainingAmountForMonth(selectedFee, selectedMonth);
                              }, 0);
                              
                              setPaymentForm(prev => ({
                                ...prev,
                                selectedMonths: newSelectedMonths,
                                amount: totalAmount.toString()
                              }));
                              
                              // Clear selectedMonths error if months are selected
                              if (newSelectedMonths.length > 0) {
                                clearFieldError('selectedMonths');
                              }
                            }}
                            disabled={isPaid}
                          >
                            <Text style={[
                              styles.monthOptionText,
                              { 
                                color: isPaid 
                                  ? theme.success
                                  : isSelected 
                                    ? theme.primary
                                    : theme.text
                              }
                            ]}>
                              {monthLabel}
                              {isPaid ? ' ✓' : ''}
                              {isPartiallyPaid ? ' (Partial)' : ''}
                            </Text>
                            <Text style={[
                              styles.monthAmountText,
                              { 
                                color: isPaid 
                                  ? theme.success
                                  : isSelected 
                                    ? theme.primary
                                    : isPartiallyPaid
                                      ? theme.warning
                                      : theme.textSecondary
                              }
                            ]}>
                              {isPaid ? '₹0' : `₹${remainingAmount.toLocaleString()}`}
                              {isPartiallyPaid && !isPaid && (
                                <Text style={[{ fontSize: 12, color: theme.textSecondary }]}>
                                  {' '}remaining
                                </Text>
                              )}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    
                    {paymentForm.selectedMonths.length > 0 && (
                      <Text style={[styles.selectionSummary, { color: theme.textSecondary }]}>
                        Selected: {paymentForm.selectedMonths.length} month(s) - ₹{parseFloat(paymentForm.amount || '0').toLocaleString()}
                      </Text>
                    )}
                    {formErrors.selectedMonths && (
                      <Text style={[styles.errorText, { color: '#EF4444' }]}>
                        {formErrors.selectedMonths}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            )}

            <View style={[styles.formSection, { borderTopColor: theme.border }]}>
              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Payment Amount *</Text>
                <TextInput
                  style={[
                    styles.textInput, 
                    { 
                      color: theme.text, 
                      borderColor: formErrors.amount ? '#EF4444' : theme.border, 
                      backgroundColor: paymentForm.paymentType === 'individual' ? theme.background : theme.surface,
                      opacity: paymentForm.paymentType === 'individual' ? 0.7 : 1
                    }
                  ]}
                  value={paymentForm.amount}
                  onChangeText={(value: string) => {
                    setPaymentForm(prev => ({ ...prev, amount: value }));
                    clearFieldError('amount');
                  }}
                  placeholder={paymentForm.isPartial ? 
                    `₹${((selectedFee?.amount || 0) - (selectedFee?.paidAmount || 0)).toLocaleString()}` : 
                    `₹${selectedFee?.amount.toLocaleString()}`
                  }
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="numeric"
                  editable={paymentForm.paymentType !== 'individual'}
                />
                {formErrors.amount && (
                  <Text style={[styles.errorText, { color: '#EF4444' }]}>
                    {formErrors.amount}
                  </Text>
                )}
                {paymentForm.paymentType === 'individual' && (
                  <Text style={[
                    { 
                      color: theme.textSecondary, 
                      fontSize: 12, 
                      marginTop: 4,
                      fontStyle: 'italic'
                    }
                  ]}>
                    Amount is automatically calculated based on selected months
                  </Text>
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Payment Method *</Text>
                <View style={[
                  styles.pickerContainer, 
                  { 
                    borderColor: formErrors.method ? '#EF4444' : theme.border, 
                    backgroundColor: theme.surface 
                  }
                ]}>
                  <TouchableOpacity
                    style={[
                      styles.customPickerButton,
                      { backgroundColor: theme.surface },
                    ]}
                    onPress={() => setShowPaymentMethodModal(true)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.customPickerLabel, { color: theme.textSecondary }]}>
                        Payment Method
                      </Text>
                      <Text
                        style={[
                          styles.customPickerValue,
                          { color: paymentForm.method ? theme.text : theme.textSecondary },
                        ]}
                      >
                        {paymentMethodLabel || 'Select payment method'}
                      </Text>
                    </View>
                    <ChevronDown size={18} color={theme.textSecondary} />
                  </TouchableOpacity>
                </View>
                {formErrors.method && (
                  <Text style={[styles.errorText, { color: '#EF4444' }]}>
                    {formErrors.method}
                  </Text>
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Payment Date *</Text>
                <DatePicker
                  selectedDate={paymentForm.date}
                  onSelect={(date) => {
                    setPaymentForm(prev => ({ ...prev, date }));
                    // Clear date error if it exists
                    if (formErrors.date) {
                      setFormErrors(prev => ({ ...prev, date: undefined }));
                    }
                  }}
                  theme={theme}
                  placeholder="Select payment date"
                  allowFutureDates={false}
                />
                {formErrors.date && (
                  <Text style={[styles.errorText, { color: '#EF4444' }]}>
                    {formErrors.date}
                  </Text>
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Paid By *</Text>
                <TextInput
                  style={[
                    styles.textInput, 
                    { 
                      color: theme.text, 
                      borderColor: formErrors.paidBy ? '#EF4444' : theme.border, 
                      backgroundColor: theme.surface 
                    }
                  ]}
                  value={paymentForm.paidBy}
                  onChangeText={(value: string) => {
                    setPaymentForm(prev => ({ ...prev, paidBy: value }));
                    clearFieldError('paidBy');
                  }}
                  placeholder="Name of the person who paid"
                  placeholderTextColor={theme.textSecondary}
                />
                <Text style={[styles.helperText, { color: theme.textSecondary }]}>This is for records only and will not be shown to parents.</Text>
                {formErrors.paidBy && (
                  <Text style={[styles.errorText, { color: '#EF4444' }]}>
                    {formErrors.paidBy}
                  </Text>
                )}
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Account Details</Text>
                <TextInput
                  style={[styles.textInput, styles.multilineInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]}
                  value={paymentForm.accountDetails}
                  onChangeText={(value: string) => setPaymentForm(prev => ({ ...prev, accountDetails: value }))}
                  placeholder="Account number, UPI ID, transaction ID, etc."
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  numberOfLines={3}
                />
                <Text style={[styles.helperText, { color: theme.textSecondary }]}>This is for records only and will not be shown to parents.</Text>
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Notes</Text>
                <TextInput
                  style={[styles.textInput, styles.multilineInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]}
                  value={paymentForm.notes}
                  onChangeText={(value: string) => setPaymentForm(prev => ({ ...prev, notes: value }))}
                  placeholder="Additional notes about the payment"
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  numberOfLines={3}
                />
                <Text style={[styles.helperText, { color: theme.textSecondary }]}>This note will be shared with parents in the confirmation message.</Text>
              </View>

              {/* Optional: Send reminder to parents */}
              <View style={styles.inputGroup}>
                <TouchableOpacity
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: paymentForm.sendReminder }}
                  onPress={() => {
                    const turningOff = paymentForm.sendReminder;
                    setPaymentForm(prev => ({ ...prev, sendReminder: !prev.sendReminder }));
                    if (turningOff) {
                      setShowReminderChannelModal(false);
                      setShowPaymentLanguageModal(false);
                      setShowLanguageOrderModal(false);
                    }
                  }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      borderWidth: 1,
                      borderColor: theme.border,
                      backgroundColor: paymentForm.sendReminder ? theme.primary : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {paymentForm.sendReminder ? <Check size={16} color={'#fff'} /> : null}
                  </View>
                  <Text style={[{ color: theme.text }]}>Send payment confirmation to parent</Text>
                </TouchableOpacity>

                {paymentForm.sendReminder && (
                  <View style={{ marginTop: 12 }}>
                    <Text style={[styles.inputLabel, { color: theme.text }]}>Reminder Channel</Text>
                    <View style={[styles.pickerContainer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                      <TouchableOpacity
                        style={[
                          styles.customPickerButton,
                          { backgroundColor: theme.surface },
                        ]}
                        onPress={() => setShowReminderChannelModal(true)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.customPickerLabel, { color: theme.textSecondary }]}>Reminder Channel</Text>
                          <Text style={[styles.customPickerValue, { color: theme.text }]}>
                            {reminderChannelLabel || 'Select channel'}
                          </Text>
                        </View>
                        <ChevronDown size={18} color={theme.textSecondary} />
                      </TouchableOpacity>
                    </View>

                    {/* Language selector */}
                    <Text style={[styles.inputLabel, { color: theme.text, marginTop: 12 }]}>Language</Text>
                    <View style={[styles.pickerContainer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                      <TouchableOpacity
                        style={[
                          styles.customPickerButton,
                          { backgroundColor: theme.surface },
                        ]}
                        onPress={() => setShowPaymentLanguageModal(true)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.customPickerLabel, { color: theme.textSecondary }]}>Language</Text>
                          <Text style={[styles.customPickerValue, { color: theme.text }]}>
                            {paymentLanguageLabel || 'Select language'}
                          </Text>
                        </View>
                        <ChevronDown size={18} color={theme.textSecondary} />
                      </TouchableOpacity>
                    </View>

                    {/* Language order when both selected */}
                    {paymentForm.selectedLanguage === 'both' && (
                      <View style={{ marginTop: 12 }}>
                        <Text style={[styles.inputLabel, { color: theme.text }]}>Language Order</Text>
                        <View style={[styles.pickerContainer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                          <TouchableOpacity
                            style={[
                              styles.customPickerButton,
                              { backgroundColor: theme.surface },
                            ]}
                            onPress={() => setShowLanguageOrderModal(true)}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.customPickerLabel, { color: theme.textSecondary }]}>Language Order</Text>
                              <Text style={[styles.customPickerValue, { color: theme.text }]}>
                                {languageOrderLabel || 'Select order'}
                              </Text>
                            </View>
                            <ChevronDown size={18} color={theme.textSecondary} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}

                    {/* Preview */}
                    {paymentMessagePreview ? (
                      <View style={{ marginTop: 16 }}>
                        <Text style={[styles.inputLabel, { color: theme.text }]}>Preview</Text>
                        <View style={{ padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
                          <Text style={{ color: theme.text }}>{paymentMessagePreview}</Text>
                        </View>
                        <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 8 }]}>Teacher/Coaching shown here follow your Reminder Settings. You can edit them in Reminders.</Text>
                      </View>
                    ) : null}
                  </View>
                )}
              </View>
            </View>
          </ScrollView>

          <View style={[styles.modalFooter, { borderTopColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.modalButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => setShowPaymentModal(false)}
            >
              <Text style={[styles.buttonText, { color: theme.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modalButton,
                styles.submitButton,
                { backgroundColor: theme.success, opacity: confirmingPayment ? 0.7 : 1 }
              ]}
              onPress={handlePaymentSubmit}
              disabled={confirmingPayment}
            >
              {confirmingPayment ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <ActivityIndicator size="small" color="white" />
                  <Text style={[styles.buttonText, { color: 'white', marginLeft: 8 }]}>Recording…</Text>
                </View>
              ) : (
                <Text style={[styles.buttonText, { color: 'white' }]}>Confirm Payment</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showPaymentMethodModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPaymentMethodModal(false)}
      >
        <View style={styles.dueMonthModalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowPaymentMethodModal(false)}>
            <View style={styles.dueMonthModalBackdrop} />
          </TouchableWithoutFeedback>

          <View style={[styles.dueMonthModalContainer, { backgroundColor: theme.surface }]}>
            <View style={[styles.dueMonthModalHandle, { backgroundColor: theme.border }]} />
            <View style={styles.dueMonthModalHeader}>
              <Text style={[styles.dueMonthModalTitle, { color: theme.text }]}>Select Payment Method</Text>
              <TouchableOpacity
                style={styles.dueMonthModalCloseButton}
                onPress={() => setShowPaymentMethodModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.dueMonthOptionsList}
              contentContainerStyle={styles.dueMonthOptionsContent}
              showsVerticalScrollIndicator={false}
            >
              {paymentMethodOptions.map(option => {
                const isSelected = option.value === paymentForm.method;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.dueMonthOption,
                      {
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary + '10' : theme.surface,
                      },
                    ]}
                    onPress={() => {
                      setPaymentForm(prev => ({ ...prev, method: option.value }));
                      clearFieldError('method');
                      setShowPaymentMethodModal(false);
                    }}
                  >
                    <Text style={[styles.dueMonthOptionLabel, { color: theme.text }]}>
                      {option.label}
                    </Text>
                    {isSelected ? <Check size={18} color={theme.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showReminderChannelModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowReminderChannelModal(false)}
      >
        <View style={styles.dueMonthModalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowReminderChannelModal(false)}>
            <View style={styles.dueMonthModalBackdrop} />
          </TouchableWithoutFeedback>

          <View style={[styles.dueMonthModalContainer, { backgroundColor: theme.surface }]}>
            <View style={[styles.dueMonthModalHandle, { backgroundColor: theme.border }]} />
            <View style={styles.dueMonthModalHeader}>
              <Text style={[styles.dueMonthModalTitle, { color: theme.text }]}>Select Reminder Channel</Text>
              <TouchableOpacity
                style={styles.dueMonthModalCloseButton}
                onPress={() => setShowReminderChannelModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.dueMonthOptionsList}
              contentContainerStyle={styles.dueMonthOptionsContent}
              showsVerticalScrollIndicator={false}
            >
              {reminderChannelOptions.map(option => {
                const isSelected = option.value === paymentForm.reminderChannel;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.dueMonthOption,
                      {
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary + '10' : theme.surface,
                      },
                    ]}
                    onPress={() => {
                      handleChangeReminderChannel(option.value);
                      setShowReminderChannelModal(false);
                    }}
                  >
                    <Text style={[styles.dueMonthOptionLabel, { color: theme.text }]}>
                      {option.label}
                    </Text>
                    {isSelected ? <Check size={18} color={theme.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showPaymentLanguageModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPaymentLanguageModal(false)}
      >
        <View style={styles.dueMonthModalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowPaymentLanguageModal(false)}>
            <View style={styles.dueMonthModalBackdrop} />
          </TouchableWithoutFeedback>

          <View style={[styles.dueMonthModalContainer, { backgroundColor: theme.surface }]}>
            <View style={[styles.dueMonthModalHandle, { backgroundColor: theme.border }]} />
            <View style={styles.dueMonthModalHeader}>
              <Text style={[styles.dueMonthModalTitle, { color: theme.text }]}>Select Language</Text>
              <TouchableOpacity
                style={styles.dueMonthModalCloseButton}
                onPress={() => setShowPaymentLanguageModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.dueMonthOptionsList}
              contentContainerStyle={styles.dueMonthOptionsContent}
              showsVerticalScrollIndicator={false}
            >
              {paymentLanguageOptions.map(option => {
                const isSelected = option.value === paymentForm.selectedLanguage;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.dueMonthOption,
                      {
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary + '10' : theme.surface,
                      },
                    ]}
                    onPress={() => {
                      handleChangeSelectedLanguage(option.value);
                      setShowPaymentLanguageModal(false);
                    }}
                  >
                    <Text style={[styles.dueMonthOptionLabel, { color: theme.text }]}>
                      {option.label}
                    </Text>
                    {isSelected ? <Check size={18} color={theme.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showLanguageOrderModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLanguageOrderModal(false)}
      >
        <View style={styles.dueMonthModalRoot}>
          <TouchableWithoutFeedback onPress={() => setShowLanguageOrderModal(false)}>
            <View style={styles.dueMonthModalBackdrop} />
          </TouchableWithoutFeedback>

          <View style={[styles.dueMonthModalContainer, { backgroundColor: theme.surface }]}>
            <View style={[styles.dueMonthModalHandle, { backgroundColor: theme.border }]} />
            <View style={styles.dueMonthModalHeader}>
              <Text style={[styles.dueMonthModalTitle, { color: theme.text }]}>Select Language Order</Text>
              <TouchableOpacity
                style={styles.dueMonthModalCloseButton}
                onPress={() => setShowLanguageOrderModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.dueMonthOptionsList}
              contentContainerStyle={styles.dueMonthOptionsContent}
              showsVerticalScrollIndicator={false}
            >
              {languageOrderOptions.map(option => {
                const isSelected = option.value === paymentForm.languageOrder;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.dueMonthOption,
                      {
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary + '10' : theme.surface,
                      },
                    ]}
                    onPress={() => {
                      handleChangeLanguageOrder(option.value);
                      setShowLanguageOrderModal(false);
                    }}
                  >
                    <Text style={[styles.dueMonthOptionLabel, { color: theme.text }]}>
                      {option.label}
                    </Text>
                    {isSelected ? <Check size={18} color={theme.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Fee Edit Modal */}
      <Modal
        visible={showFeeDetailsModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowFeeDetailsModal(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Fee Details</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowFeeDetailsModal(false)}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 25 }),
            }}
          >
            {/* Basic Fee Information */}
            <View style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Basic Information</Text>
              
              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Student Name</Text>
                <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                  <Text style={[{ color: theme.textSecondary }]}>{feeEditForm.studentName}</Text>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Monthly Fee</Text>
                <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                  <Text style={[{ color: theme.textSecondary }]}>₹{parseFloat(feeEditForm.monthlyFee || '0').toLocaleString()}</Text>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Amount</Text>
                <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                  <Text style={[{ color: theme.textSecondary }]}>₹{parseFloat(feeEditForm.amount || '0').toLocaleString()}</Text>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Due Date</Text>
                <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                  <Text style={[{ color: theme.textSecondary }]}>{feeEditForm.dueDate}</Text>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Description</Text>
                <TextInput
                  style={[styles.textInput, styles.multilineInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]}
                  value={feeEditForm.description}
                  onChangeText={(value: string) => setFeeEditForm(prev => ({ ...prev, description: value }))}
                  placeholder="Fee description"
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  numberOfLines={3}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Status</Text>
                <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                  <Text style={[{ color: theme.textSecondary }]}>
                    {selectedFee ? categorizeFee(selectedFee).charAt(0).toUpperCase() + categorizeFee(selectedFee).slice(1) : 'Unknown'}
                    <Text style={[{ color: theme.textSecondary, fontSize: 12 }]}> (automatically calculated)</Text>
                  </Text>
                </View>
              </View>
            </View>

            {/* Consolidated Fee Information */}
            {selectedFee?.monthsCovered && selectedFee.monthsCovered.length > 1 && (
              <View style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Consolidated Fee Details</Text>
                
                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.text }]}>Months Covered</Text>
                  <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center', minHeight: 60 }]}>
                    <Text style={[{ color: theme.textSecondary }]}>
                      {selectedFee.monthsCovered.map((month: string) => {
                        const monthLabel = generateMonthOptions.find(m => m.value === month)?.label;
                        return monthLabel;
                      }).join(', ')}
                    </Text>
                  </View>
                </View>

                {selectedFee.monthsCovered && (
                  <View style={styles.inputGroup}>
                    <Text style={[styles.inputLabel, { color: theme.text }]}>Paid Months</Text>
                    <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center', minHeight: 60 }]}>
                      {(() => {
                        const allPaidMonths = getAllPaidMonths(selectedFee);
                        return allPaidMonths.length > 0 ? (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                            {allPaidMonths.map(({ month, status }) => {
                              const monthLabel = generateMonthOptions.find(m => m.value === month)?.label;
                              return (
                                <View key={month} style={{
                                  paddingHorizontal: 8,
                                  paddingVertical: 4,
                                  borderRadius: 6,
                                  backgroundColor: status === 'full' ? theme.success + '15' : theme.warning + '15',
                                  borderWidth: 1,
                                  borderColor: status === 'full' ? theme.success + '30' : theme.warning + '30'
                                }}>
                                  <Text style={{
                                    color: status === 'full' ? theme.success : theme.warning,
                                    fontSize: 13,
                                    fontWeight: '500'
                                  }}>
                                    {monthLabel}
                                    {status === 'partial' && (
                                      <Text style={{ fontSize: 11, fontWeight: '400' }}> (partial)</Text>
                                    )}
                                  </Text>
                                </View>
                              );
                            })}
                          </View>
                        ) : (
                          <Text style={[{ color: theme.textSecondary }]}>
                            No months paid yet
                          </Text>
                        );
                      })()}
                    </View>
                  </View>
                )}

                {selectedFee.monthsCovered && (
                  <View style={styles.inputGroup}>
                    <Text style={[styles.inputLabel, { color: theme.text }]}>Payment Status</Text>
                    <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                      <Text style={[{ color: theme.textSecondary }]}>
                        {(() => {
                          const stats = getPaymentStatistics(selectedFee);
                          let statusText = `${stats.fullyPaidCount} of ${stats.totalMonths} months fully paid`;
                          
                          if (stats.partiallyPaidCount > 0) {
                            statusText += `, ${stats.partiallyPaidCount} partially paid`;
                          }
                          
                          return statusText;
                        })()}
                        {(() => {
                          const stats = getPaymentStatistics(selectedFee);
                          return stats.remainingMonths > 0 ? (
                            <Text style={[{ color: theme.warning }]}>
                              {' '}({stats.remainingMonths} remaining)
                            </Text>
                          ) : null;
                        })()}
                      </Text>
                    </View>
                  </View>
                )}

                {(selectedFee.monthlyFeeAmount || selectedFee.monthFeeAmounts) && (
                  <View style={styles.inputGroup}>
                    <Text style={[styles.inputLabel, { color: theme.text }]}>Fee Amount Details</Text>
                    <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center', minHeight: 60 }]}>
                      {selectedFee.monthFeeAmounts ? (
                        <View>
                          <Text style={[{ color: theme.textSecondary, marginBottom: 8 }]}>Individual Month Fees:</Text>
                          {selectedFee.monthsCovered.map((month: string) => {
                            const monthLabel = generateMonthOptions.find(m => m.value === month)?.label;
                            const amount = selectedFee.monthFeeAmounts[month];
                            return (
                              <Text key={month} style={[{ color: theme.text, fontSize: 14 }]}>
                                {monthLabel}: ₹{amount.toLocaleString()}
                              </Text>
                            );
                          })}
                          <Text style={[{ color: theme.textSecondary, marginTop: 8, fontWeight: 'bold' }]}>
                            Total: ₹{Object.values(selectedFee.monthFeeAmounts).reduce((sum: number, amount: any) => sum + (Number(amount) || 0), 0).toLocaleString()}
                          </Text>
                        </View>
                      ) : (
                        <Text style={[{ color: theme.textSecondary }]}>
                          ₹{selectedFee.monthlyFeeAmount.toLocaleString()} × {selectedFee.monthsCovered.length} months = ₹{getCorrectFeeAmount(selectedFee).toLocaleString()}
                        </Text>
                      )}
                    </View>
                  </View>
                )}
              </View>
            )}

            {/* Payment Information */}
            {(() => {
              const transactions = getPaymentTransactions(selectedFee);
              const hasMeaningfulPayments = (selectedFee?.paidAmount && selectedFee.paidAmount > 0) || transactions.length > 0;
              
              return hasMeaningfulPayments ? (
                <View style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.sectionTitle, { color: theme.text }]}>Payment History</Text>
                  
                  {/* Total Paid Amount Summary */}
                  {selectedFee?.paidAmount && selectedFee.paidAmount > 0 && (
                    <View style={styles.inputGroup}>
                      <Text style={[styles.inputLabel, { color: theme.text }]}>Total Paid Amount</Text>
                      <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                        <Text style={[{ color: theme.success, fontWeight: '600' }]}>
                          ₹{selectedFee.paidAmount.toLocaleString()}
                          {(() => {
                            const correctAmount = getCorrectFeeAmount(selectedFee);
                            return selectedFee.paidAmount < correctAmount && (
                              <Text style={[{ color: theme.textSecondary, fontWeight: 'normal' }]}>
                                {' '}(Remaining: ₹{(correctAmount - selectedFee.paidAmount).toLocaleString()})
                              </Text>
                            );
                          })()}
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Individual Payment Transactions */}
                  {(() => {
                    if (transactions.length === 0) return null;

                    return (
                      <View style={styles.inputGroup}>
                        <Text style={[styles.inputLabel, { color: theme.text, marginBottom: 8 }]}>
                          Payment Transactions ({transactions.length})
                        </Text>
                      <ScrollView 
                        style={{ maxHeight: 300 }} 
                        showsVerticalScrollIndicator={true}
                        nestedScrollEnabled={true}
                      >
                      {transactions.map((transaction, index) => (
                        <View key={transaction.id} style={[
                          styles.paymentTransactionCard, 
                          { 
                            borderColor: theme.border, 
                            backgroundColor: theme.surface,
                            marginBottom: 8
                          }
                        ]}>
                          {/* Transaction Header */}
                          <TouchableOpacity
                            style={styles.paymentTransactionHeader}
                            onPress={() => togglePaymentExpansion(transaction.id)}
                            activeOpacity={0.7}
                          >
                            <View style={styles.paymentTransactionSummary}>
                              <View style={styles.paymentTransactionTitle}>
                                <Text style={[styles.paymentTransactionAmount, { color: theme.success }]}>
                                  ₹{transaction.amount ? transaction.amount.toLocaleString() : '0'}
                                </Text>
                                <Text style={[styles.paymentTransactionDate, { color: theme.textSecondary }]}>
                                  {transaction.paymentDate ? (() => {
                                    const paymentDate = new Date(transaction.paymentDate);
                                    const dateStr = paymentDate.toLocaleDateString('en-US', {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric'
                                    });
                                    const timeStr = paymentDate.toLocaleTimeString('en-US', {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                      hour12: true
                                    });
                                    return `${dateStr} at ${timeStr}`;
                                  })() : 'Date not recorded'}
                                </Text>
                              </View>
                              <View style={styles.paymentTransactionMeta}>
                                <Text style={[styles.paymentTransactionMethod, { color: theme.textSecondary }]}>
                                  {transaction.method || selectedFee?.method || 'Method not specified'}
                                </Text>
                                {transaction.monthsPaid && transaction.monthsPaid.length > 0 ? (
                                  <Text style={[styles.paymentTransactionMonths, { color: theme.primary }]}>
                                    {transaction.monthsPaid.length} month{transaction.monthsPaid.length > 1 ? 's' : ''}
                                  </Text>
                                ) : (
                                  <Text style={[styles.paymentTransactionMonths, { color: theme.warning }]}>
                                    Auto-Distributed
                                  </Text>
                                )}
                              </View>
                            </View>
                            <View style={styles.expandButton}>
                              <TouchableOpacity
                                style={[styles.deletePaymentButton, { backgroundColor: theme.error + '15' }]}
                                onPress={(e) => {
                                  e.stopPropagation();
                                  handleDeletePayment(transaction.id, transaction, selectedFee.id);
                                }}
                                activeOpacity={0.7}
                              >
                                <Trash2 size={16} color={theme.error} />
                              </TouchableOpacity>
                              <ChevronDown 
                                size={20} 
                                color={theme.textSecondary}
                                style={{
                                  transform: [{ rotate: expandedPayments[transaction.id] ? '180deg' : '0deg' }]
                                }}
                              />
                            </View>
                          </TouchableOpacity>

                          {/* Expanded Transaction Details */}
                          {expandedPayments[transaction.id] && (
                            <View style={[styles.paymentTransactionDetails, { borderTopColor: theme.border }]}>
                              {transaction.paidBy && (
                                <View style={styles.paymentDetailRow}>
                                  <Text style={[styles.paymentDetailLabel, { color: theme.textSecondary }]}>Paid By:</Text>
                                  <Text style={[styles.paymentDetailValue, { color: theme.text }]}>{transaction.paidBy}</Text>
                                </View>
                              )}

                              {transaction.paymentDate && (
                                <View style={styles.paymentDetailRow}>
                                  <Text style={[styles.paymentDetailLabel, { color: theme.textSecondary }]}>Payment Date:</Text>
                                  <Text style={[styles.paymentDetailValue, { color: theme.text }]}>
                                    {(() => {
                                      const paymentDate = new Date(transaction.paymentDate);
                                      const dateStr = paymentDate.toLocaleDateString('en-US', {
                                        weekday: 'long',
                                        year: 'numeric',
                                        month: 'long',
                                        day: 'numeric'
                                      });
                                      const timeStr = paymentDate.toLocaleTimeString('en-US', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: true
                                      });
                                      return `${dateStr} at ${timeStr}`;
                                    })()}
                                  </Text>
                                </View>
                              )}

                              {transaction.transactionId && (
                                <View style={styles.paymentDetailRow}>
                                  <Text style={[styles.paymentDetailLabel, { color: theme.textSecondary }]}>Transaction ID:</Text>
                                  <Text style={[styles.paymentDetailValue, { color: theme.text, fontFamily: 'monospace' }]}>
                                    {transaction.transactionId}
                                  </Text>
                                </View>
                              )}

                              {transaction.accountDetails && (
                                <View style={styles.paymentDetailRow}>
                                  <Text style={[styles.paymentDetailLabel, { color: theme.textSecondary }]}>Account Details:</Text>
                                  <Text style={[styles.paymentDetailValue, { color: theme.text }]}>{transaction.accountDetails}</Text>
                                </View>
                              )}

                              {/* Show months covered - either specific or auto-distributed */}
                              {(() => {
                                if (transaction.monthsPaid && transaction.monthsPaid.length > 0) {
                                  // Specific month payment
                                  return (
                                    <View style={styles.paymentDetailRow}>
                                      <Text style={[styles.paymentDetailLabel, { color: theme.textSecondary }]}>Months Paid:</Text>
                                      <Text style={[styles.paymentDetailValue, { color: theme.primary }]}>
                                        {transaction.monthsPaid.map((month: string) => {
                                          const monthLabel = generateMonthOptions.find(m => m.value === month)?.label;
                                          return monthLabel;
                                        }).join(', ')}
                                      </Text>
                                    </View>
                                  );
                                } else if (transaction.type === 'general_payment' || !transaction.monthsPaid) {
                                  // General payment - show auto-distribution
                                  const coveredMonths = getMonthsCoveredByGeneralPayment(
                                    selectedFee,
                                    transaction.amount || 0,
                                    transaction.paymentDate || '',
                                    transaction.id
                                  );
                                  
                                  if (coveredMonths.length > 0) {
                                    return (
                                      <View style={[styles.paymentDetailRow, isSmallScreen && { flexDirection: 'column' }]}>
                                        <Text
                                          style={[
                                            styles.paymentDetailLabel,
                                            { color: theme.textSecondary },
                                            isSmallScreen && { flex: 0, marginBottom: 6 },
                                          ]}
                                        >
                                          Auto-Distributed To:
                                        </Text>
                                        <View
                                          style={[
                                            isSmallScreen ? { width: '100%' } : { flex: 2 },
                                            { flexDirection: 'column' },
                                          ]}
                                        >
                                          {coveredMonths.map(({ month, label, amount, status }, index) => (
                                            <View
                                              key={month}
                                              style={{
                                                flexDirection: 'row',
                                                justifyContent: isSmallScreen ? 'space-between' : 'flex-start',
                                                alignItems: 'center',
                                                paddingHorizontal: 8,
                                                paddingVertical: 4,
                                                backgroundColor:
                                                  status === 'full' ? theme.success + '15' : theme.warning + '15',
                                                borderRadius: 6,
                                                borderWidth: 1,
                                                borderColor:
                                                  status === 'full' ? theme.success + '30' : theme.warning + '30',
                                                alignSelf: isSmallScreen ? 'stretch' : 'flex-end',
                                                marginBottom: index === coveredMonths.length - 1 ? 0 : 4,
                                              }}
                                            >
                                              <Text
                                                style={{
                                                  fontSize: 13,
                                                  color: status === 'full' ? theme.success : theme.warning,
                                                  fontWeight: '500',
                                                  flex: isSmallScreen ? 1 : undefined,
                                                  flexShrink: 1,
                                                  marginRight: 8,
                                                }}
                                                numberOfLines={1}
                                                ellipsizeMode="tail"
                                              >
                                                {label}
                                              </Text>
                                              <Text
                                                style={{
                                                  fontSize: 12,
                                                  color: status === 'full' ? theme.success : theme.warning,
                                                  fontWeight: '600',
                                                  flexShrink: 0,
                                                  marginLeft: isSmallScreen ? 0 : 6,
                                                }}
                                              >
                                                ₹{amount.toLocaleString()}
                                                {status === 'partial' ? ' (partial)' : ''}
                                              </Text>
                                            </View>
                                          ))}
                                        </View>
                                      </View>
                                    );
                                  }
                                }
                                return null;
                              })()}

                              {transaction.notes && (
                                <View style={styles.paymentDetailRow}>
                                  <Text style={[styles.paymentDetailLabel, { color: theme.textSecondary }]}>Notes:</Text>
                                  <Text style={[styles.paymentDetailValue, { color: theme.text }]}>{transaction.notes}</Text>
                                </View>
                              )}

                              {transaction.type && (
                                <View style={styles.paymentDetailRow}>
                                  <Text style={[styles.paymentDetailLabel, { color: theme.textSecondary }]}>Type:</Text>
                                  <Text style={[styles.paymentDetailValue, { color: theme.textSecondary }]}>
                                    {transaction.type === 'individual_months' ? 'Individual Months' : 
                                     transaction.type === 'general_payment' ? 'General Payment (Auto-Distributed)' : 
                                     transaction.type === 'full_payment' ? 'General Payment' : 
                                     'Payment'}
                                  </Text>
                                </View>
                              )}
                            </View>
                          )}
                        </View>
                      ))}
                      </ScrollView>
                    </View>
                  );
                })()}
                </View>
              ) : null;
            })()}

            {/* Reminder History */}
            <View style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Reminder History</Text>
              
              {loadingReminderHistory ? (
                <View style={[styles.inputGroup, { alignItems: 'center', justifyContent: 'center', paddingVertical: 20 }]}>
                  <ActivityIndicator size="small" color={theme.primary} />
                  <Text style={[{ color: theme.textSecondary, marginTop: 8 }]}>Loading reminders...</Text>
                </View>
      ) : feeReminderHistory.length > 0 ? (
                <View>
                  <Text style={[styles.inputLabel, { color: theme.text, marginBottom: 8 }]}>
        {(studentTotalReminderCount ?? feeReminderHistory.length)} reminder{(studentTotalReminderCount ?? feeReminderHistory.length) > 1 ? 's' : ''} found for this student
        {(studentTotalReminderCount !== null && studentTotalReminderCount > feeReminderHistory.length) ? ` (showing latest ${feeReminderHistory.length})` : ''}
                  </Text>
                  <ScrollView 
                    style={{ maxHeight: 300 }} 
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={true}
                  >
                    {feeReminderHistory.map((reminder, index) => (
                      <View 
                        key={reminder.id || index} 
                        style={[
                          styles.reminderHistoryItem, 
                          { 
                            backgroundColor: theme.surface + '80', 
                            borderColor: theme.border,
                            marginBottom: 8,
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 1
                          }
                        ]}
                      >
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                    {reminder.reminderType === 'email' ? <Mail size={16} color={theme.text} /> : null}
                        {reminder.reminderType === 'sms' ? <MessageSquare size={16} color={theme.text} /> : null}
                        {reminder.reminderType === 'whatsapp' ? <MessageSquare size={16} color={theme.text} /> : null}
                        {reminder.reminderType === 'voice' ? <Phone size={16} color={theme.text} /> : null}
                            <Text style={[{ color: theme.text, fontWeight: 'bold', marginLeft: 6 }]}>
                              {reminder.reminderType?.toUpperCase()}
                            </Text>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                    {reminder.status === 'success' ? <CheckCircle size={16} color={theme.success} /> : null}
                        {reminder.status === 'failed' ? <X size={16} color={theme.error} /> : null}
                        {reminder.status === 'pending' ? <Clock size={16} color={theme.warning} /> : null}
                            <Text style={[{ 
                              color: reminder.status === 'success' ? theme.success : 
                                     reminder.status === 'failed' ? theme.error : theme.warning,
                              marginLeft: 4,
                              fontSize: 12,
                              fontWeight: 'bold'
                            }]}>
                              {reminder.status?.toUpperCase()}
                            </Text>
                          </View>
                        </View>
                        
                        <Text style={[{ color: theme.textSecondary, fontSize: 12, marginBottom: 4 }]}>
                          {(() => {
                            try {
                              const date = reminder.createdAt?.toDate ? reminder.createdAt.toDate() : new Date(reminder.createdAt);
                              return date.toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                              });
                            } catch (e) {
                              return 'Date not available';
                            }
                          })()}
                        </Text>
                        
                        {reminder.amount && (
                          <Text style={[{ color: theme.text, fontSize: 13, marginBottom: 2 }]}>
                            Amount: ₹{reminder.amount}
                          </Text>
                        )}
                        
                        {reminder.parentContact && (
                          <Text style={[{ color: theme.textSecondary, fontSize: 12, marginBottom: 2 }]}>
                            To: {reminder.parentContact}
                          </Text>
                        )}
                        
                        {reminder.errorMessage && (
                          <Text style={[{ color: theme.error, fontSize: 12, fontStyle: 'italic' }]}>
                            Error: {reminder.errorMessage}
                          </Text>
                        )}
                      </View>
                    ))}
                  </ScrollView>
                  
                  {/* Legacy reminder information from fee record */}
                  {selectedFee?.lastReminder && (
                    <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.border }}>
                      <Text style={[{ color: theme.textSecondary, fontSize: 12, fontStyle: 'italic' }]}>
                        Last reminder from fee record: {selectedFee.lastReminder}
                      </Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={[styles.inputGroup, { alignItems: 'center', justifyContent: 'center', paddingVertical: 20 }]}>
                  <Clock size={24} color={theme.textSecondary} />
                  <Text style={[{ color: theme.textSecondary, marginTop: 8, textAlign: 'center' }]}>
                    No reminders found for this student
                  </Text>
                  <Text style={[{ color: theme.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 4 }]}>
                    Reminders will appear here once sent
                  </Text>
                </View>
              )}
            </View>

            {/* System Information */}
            <View style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>System Information</Text>
              
              {selectedFee?.createdAt && (
                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.text }]}>Created At</Text>
                  <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                    <Text style={[{ color: theme.textSecondary }]}>
                      {new Date(selectedFee.createdAt).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </Text>
                  </View>
                </View>
              )}

              {selectedFee?.updatedAt && selectedFee.updatedAt !== selectedFee.createdAt && (
                <View style={styles.inputGroup}>
                  <Text style={[styles.inputLabel, { color: theme.text }]}>Last Updated</Text>
                  <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                    <Text style={[{ color: theme.textSecondary }]}>
                      {new Date(selectedFee.updatedAt).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </Text>
                  </View>
                </View>
              )}

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Fee Type</Text>
                <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                  <Text style={[{ color: theme.textSecondary }]}>
                    {selectedFee?.type ? selectedFee.type.charAt(0).toUpperCase() + selectedFee.type.slice(1) : 'Tuition'}
                  </Text>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={[styles.inputLabel, { color: theme.text }]}>Fee ID</Text>
                <View style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface + '50', justifyContent: 'center' }]}>
                  <Text style={[{ color: theme.textSecondary, fontSize: 12, fontFamily: 'monospace' }]}>{selectedFee?.id}</Text>
                </View>
              </View>
            </View>
          </ScrollView>

          <View style={[styles.modalFooter, { borderTopColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.modalButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => setShowFeeDetailsModal(false)}
            >
              <Text style={[styles.buttonText, { color: theme.textSecondary }]}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.submitButton, { backgroundColor: theme.primary, opacity: isFeeDirty ? 1 : 0.5 }]}
              onPress={handleFeeUpdate}
              disabled={!isFeeDirty}
            >
              <Text style={[styles.buttonText, { color: '#ffffff' }]}>Update Fee</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowDeleteModal(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Delete Fee</Text>
            <TouchableOpacity
              style={[styles.closeButton, isDeletingFee ? { opacity: 0.6 } : null]}
              onPress={() => {
                if (isDeletingFee) return;
                setIsDeletingFee(false);
                setShowDeleteModal(false);
              }}
              disabled={isDeletingFee}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.modalContent}>
            <View style={[styles.deleteWarningContainer, { backgroundColor: '#FEF2F2', borderColor: '#FECACA' }]}>
              <View style={styles.deleteWarningIcon}>
                <Trash2 size={48} color="#EF4444" />
              </View>
              <Text style={[styles.deleteWarningTitle, { color: '#991B1B' }]}>
                Are you sure you want to delete this fee?
              </Text>
              <Text style={[styles.deleteWarningMessage, { color: '#7F1D1D' }]}>
                This action cannot be undone. The fee record will be permanently removed from the system.
              </Text>
              <View style={styles.deleteWarningDetails}>
                <Text style={styles.deleteWarningDetail}>
                  • All recorded payments linked to this fee will also be permanently deleted.
                </Text>
                <Text style={styles.deleteWarningDetail}>
                  • Any uploaded receipts for this fee will be removed from storage.
                </Text>
              </View>
            </View>

            {selectedFee && (
              <View style={[styles.feeDetails, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.feeDetailsTitle, { color: theme.text }]}>Fee Details</Text>
                <View style={styles.feeDetailRow}>
                  <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Student:</Text>
                  <Text style={[styles.feeDetailValue, { color: theme.text }]}>{selectedFee.studentName}</Text>
                </View>
                <View style={styles.feeDetailRow}>
                  <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Amount:</Text>
                  <Text style={[styles.feeDetailValue, { color: theme.text }]}>₹{getCorrectFeeAmount(selectedFee).toLocaleString()}</Text>
                </View>
                <View style={styles.feeDetailRow}>
                  <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Due Date:</Text>
                  <Text style={[styles.feeDetailValue, { color: theme.text }]}>{selectedFee.dueDate}</Text>
                </View>
                <View style={styles.feeDetailRow}>
                  <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Status:</Text>
                  <Text style={[styles.feeDetailValue, { color: getStatusColor(categorizeFee(selectedFee)) }]}>
                    {categorizeFee(selectedFee).charAt(0).toUpperCase() + categorizeFee(selectedFee).slice(1)}
                  </Text>
                </View>
              </View>
            )}
          </View>

          <View style={[styles.modalFooter, { borderTopColor: theme.border }]}>
            <TouchableOpacity
              style={[
                styles.modalButton,
                styles.cancelButton,
                { backgroundColor: theme.surface, borderColor: theme.border, opacity: isDeletingFee ? 0.6 : 1 }
              ]}
              onPress={() => {
                if (isDeletingFee) return;
                setIsDeletingFee(false);
                setShowDeleteModal(false);
              }}
              disabled={isDeletingFee}
            >
              <Text style={[styles.buttonText, { color: theme.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modalButton,
                styles.deleteButton,
                { backgroundColor: '#EF4444', opacity: isDeletingFee ? 0.6 : 1 }
              ]}
              onPress={confirmDeleteFee}
              disabled={isDeletingFee}
            >
              {isDeletingFee ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Trash2 size={16} color="white" />
              )}
              <Text style={[styles.buttonText, { color: 'white', marginLeft: 8 }]}>
                {isDeletingFee ? 'Deleting…' : 'Delete Fee'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delete Payment Confirmation Modal */}
      <Modal
        visible={showDeletePaymentModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowDeletePaymentModal(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Delete Payment</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowDeletePaymentModal(false)}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.modalContent}>
            <View style={[styles.deleteWarningContainer, { backgroundColor: '#FEF2F2', borderColor: '#FECACA' }]}>
              <View style={styles.deleteWarningIcon}>
                <Trash2 size={48} color="#EF4444" />
              </View>
              <Text style={[styles.deleteWarningTitle, { color: '#991B1B' }]}>
                Are you sure you want to delete this payment?
              </Text>
              <Text style={[styles.deleteWarningMessage, { color: '#7F1D1D' }]}>
                This action cannot be undone. The payment record will be permanently removed and fee amounts will be recalculated.
              </Text>
            </View>

            {paymentToDelete && (
              <View style={[styles.feeDetails, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.feeDetailsTitle, { color: theme.text }]}>Payment Details</Text>
                <View style={styles.feeDetailRow}>
                  <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Amount:</Text>
                  <Text style={[styles.feeDetailValue, { color: theme.text }]}>₹{paymentToDelete.payment.amount?.toLocaleString() || '0'}</Text>
                </View>
                <View style={styles.feeDetailRow}>
                  <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Payment Date:</Text>
                  <Text style={[styles.feeDetailValue, { color: theme.text }]}>
                    {paymentToDelete.payment.paymentDate ? 
                      new Date(paymentToDelete.payment.paymentDate).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                      }) : 'Date not recorded'}
                  </Text>
                </View>
                <View style={styles.feeDetailRow}>
                  <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Method:</Text>
                  <Text style={[styles.feeDetailValue, { color: theme.text }]}>
                    {paymentToDelete.payment.method || 'Method not specified'}
                  </Text>
                </View>
                {paymentToDelete.payment.paidBy && (
                  <View style={styles.feeDetailRow}>
                    <Text style={[styles.feeDetailLabel, { color: theme.textSecondary }]}>Paid By:</Text>
                    <Text style={[styles.feeDetailValue, { color: theme.text }]}>{paymentToDelete.payment.paidBy}</Text>
                  </View>
                )}
              </View>
            )}
          </View>

          <View style={[styles.modalFooter, { borderTopColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.modalButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => setShowDeletePaymentModal(false)}
              disabled={deletingPayment}
            >
              <Text style={[styles.buttonText, { color: theme.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.deleteButton, { backgroundColor: '#EF4444', opacity: deletingPayment ? 0.6 : 1 }]}
              onPress={confirmDeletePayment}
              disabled={deletingPayment}
            >
              {deletingPayment ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Trash2 size={16} color="white" />
              )}
              <Text style={[styles.buttonText, { color: 'white', marginLeft: 8 }]}>
                {deletingPayment ? 'Deleting...' : 'Delete Payment'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delete Receipt Confirmation Modal */}
      {showDeleteReceiptModal && (
        <Modal
          visible={showDeleteReceiptModal}
          animationType="fade"
          transparent={true}
          statusBarTranslucent={true}
          hardwareAccelerated={true}
          onRequestClose={() => {
            setShowDeleteReceiptModal(false);
            setReceiptToDelete(null);
          }}
        >
          <View style={styles.deleteModalOverlay}>
            <View style={[styles.deleteModalContainer, { backgroundColor: theme.surface }]}>
              <View style={styles.deleteModalIcon}>
                <Trash2 size={32} color="#EF4444" />
              </View>
              
              <Text style={[styles.deleteModalTitle, { color: theme.text }]}>
                Delete Receipt?
              </Text>
              
              <Text style={[styles.deleteModalMessage, { color: theme.textSecondary }]}>
                Are you sure you want to delete this receipt? This action cannot be undone.
              </Text>

              {receiptToDelete && (
                <View style={[styles.deleteModalDetails, { backgroundColor: theme.background }]}>
                  <Text style={[styles.deleteModalFileName, { color: theme.text }]}>
                    {receiptToDelete.receipt.fileName}
                  </Text>
                </View>
              )}

              <View style={styles.deleteModalButtons}>
                <TouchableOpacity
                  style={[styles.deleteModalButton, styles.deleteModalCancelButton, { backgroundColor: theme.background, opacity: deletingReceipt ? 0.5 : 1 }]}
                  onPress={() => {
                    setShowDeleteReceiptModal(false);
                    setReceiptToDelete(null);
                  }}
                  disabled={deletingReceipt}
                >
                  <Text style={[styles.deleteModalButtonText, { color: theme.textSecondary }]}>Cancel</Text>
                </TouchableOpacity>
                
                <TouchableOpacity
                  style={[styles.deleteModalButton, styles.deleteModalDeleteButton, { opacity: deletingReceipt ? 0.7 : 1 }]}
                  onPress={confirmDeleteReceipt}
                  disabled={deletingReceipt}
                >
                  {deletingReceipt ? (
                    <View>
                      <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                      <Text style={styles.deleteModalButtonText}>Deleting...</Text>
                    </View>
                  ) : (
                    <Text style={styles.deleteModalButtonText}>Delete</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* Custom Confirmation Modal */}
      <Modal
        visible={showConfirmationModal}
        animationType="fade"
        transparent={true}
        onRequestClose={() => {
          if (confirmationData?.onCancel) {
            confirmationData.onCancel();
          } else if (!showConfirmationCancelButton && confirmationData?.onConfirm) {
            confirmationData.onConfirm();
          } else {
            setShowConfirmationModal(false);
          }
        }}
      >
        <View style={styles.confirmationOverlay}>
          <View style={[styles.confirmationModal, { backgroundColor: theme.surface }]}>
            <View style={styles.confirmationHeader}>
              <Text style={[styles.confirmationTitle, { color: theme.text }]}>
                {confirmationData?.title}
              </Text>
            </View>
            
            <View style={styles.confirmationContent}>
              <Text style={[styles.confirmationMessage, { color: theme.textSecondary }]}>
                {confirmationData?.message}
              </Text>
            </View>
            
            <View
              style={[
                styles.confirmationButtons,
                isSingleConfirmationButton && styles.singleConfirmationButtonContainer,
              ]}
            >
              {showConfirmationCancelButton && (
                <TouchableOpacity
                  style={[
                    styles.confirmationButton,
                    styles.cancelConfirmButton,
                    styles.confirmationButtonFlexible,
                    { borderColor: theme.border },
                  ]}
                  onPress={() => {
                    if (confirmationData?.onCancel) {
                      confirmationData.onCancel();
                    } else {
                      setShowConfirmationModal(false);
                    }
                  }}
                >
                  <Text style={[styles.confirmationButtonText, { color: theme.textSecondary }]}>{confirmationCancelButtonText}</Text>
                </TouchableOpacity>
              )}
              
              <TouchableOpacity
                style={[
                  styles.confirmationButton,
                  styles.confirmConfirmButton,
                  { backgroundColor: confirmationData?.confirmButtonColor ?? theme.primary },
                  isSingleConfirmationButton
                    ? styles.confirmationSingleButton
                    : styles.confirmationButtonFlexible,
                ]}
                onPress={() => {
                  if (confirmationData?.onConfirm) {
                    confirmationData.onConfirm();
                  } else {
                    setShowConfirmationModal(false);
                  }
                }}
              >
                <Text style={[styles.confirmationButtonText, { color: 'white' }]}>{confirmationConfirmButtonText}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Receipt Upload Modal */}
      <Modal
        visible={showReceiptUpload}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setShowReceiptUpload(false);
          resetReceiptUploadModalState();
        }}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Upload Receipt</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => {
                setShowReceiptUpload(false);
                resetReceiptUploadModalState();
              }}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 30 }),
            }}
            {...(Platform.OS === 'web'
              ? ({
                  onDragOver: handleReceiptDropAreaDragOver,
                  onDragEnter: handleReceiptDropAreaDragEnter,
                  onDrop: handleReceiptDropAreaDrop,
                } as any)
              : {})}
          >
            <Text style={[styles.modalText, { color: theme.textSecondary }]}>
              {`Upload payment receipt(s) for ${(selectedFee?.studentName ?? 'this student')}’s fee`}
            </Text>

            {skippedReceiptFiles.length > 0 && (
              <View style={{ backgroundColor: '#FFFBEB', borderColor: '#F59E0B', borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 10 }}>
                <Text style={{ color: '#92400E', fontWeight: '600', fontSize: 13, marginBottom: 4 }}>
                  Skipped while adding files ({skippedReceiptFiles.length})
                </Text>
                <ScrollView style={{ maxHeight: 140 }} nestedScrollEnabled>
                  {groupedSkippedReceiptFiles.folder.length > 0 && (
                    <>
                      <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 2, marginBottom: 2 }}>
                        Folders ({groupedSkippedReceiptFiles.folder.length})
                      </Text>
                      {groupedSkippedReceiptFiles.folder.map((entry, idx) => (
                        <Text key={`receipt_folder_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                          • {entry}
                        </Text>
                      ))}
                    </>
                  )}
                  {groupedSkippedReceiptFiles.duplicate.length > 0 && (
                    <>
                      <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 6, marginBottom: 2 }}>
                        Duplicates ({groupedSkippedReceiptFiles.duplicate.length})
                      </Text>
                      {groupedSkippedReceiptFiles.duplicate.map((entry, idx) => (
                        <Text key={`receipt_duplicate_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                          • {entry}
                        </Text>
                      ))}
                    </>
                  )}
                  {groupedSkippedReceiptFiles.tooLarge.length > 0 && (
                    <>
                      <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 6, marginBottom: 2 }}>
                        Too Large ({groupedSkippedReceiptFiles.tooLarge.length})
                      </Text>
                      {groupedSkippedReceiptFiles.tooLarge.map((entry, idx) => (
                        <Text key={`receipt_too_large_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                          • {entry}
                        </Text>
                      ))}
                    </>
                  )}
                  {groupedSkippedReceiptFiles.unsupported.length > 0 && (
                    <>
                      <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 6, marginBottom: 2 }}>
                        Unsupported ({groupedSkippedReceiptFiles.unsupported.length})
                      </Text>
                      {groupedSkippedReceiptFiles.unsupported.map((entry, idx) => (
                        <Text key={`receipt_unsupported_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                          • {entry}
                        </Text>
                      ))}
                    </>
                  )}
                  {groupedSkippedReceiptFiles.other.length > 0 && (
                    <>
                      <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12, marginTop: 6, marginBottom: 2 }}>
                        Other ({groupedSkippedReceiptFiles.other.length})
                      </Text>
                      {groupedSkippedReceiptFiles.other.map((entry, idx) => (
                        <Text key={`receipt_other_${entry}_${idx}`} style={{ color: '#B45309', fontSize: 12 }} numberOfLines={1}>
                          • {entry}
                        </Text>
                      ))}
                    </>
                  )}
                </ScrollView>
              </View>
            )}

            <View
              style={[
                styles.receiptDropZone,
                Platform.OS === 'web' && isReceiptDropActive
                  ? [styles.receiptDropZoneActive, { borderColor: theme.primary, backgroundColor: `${theme.primary}12` }]
                  : null,
              ]}
              {...(Platform.OS === 'web'
                ? ({
                    onDragEnter: handleReceiptDropAreaDragEnter,
                    onDragOver: handleReceiptDropAreaDragOver,
                    onDragLeave: handleReceiptDropAreaDragLeave,
                    onDrop: handleReceiptDropAreaDrop,
                  } as any)
                : {})}
            >
              {Platform.OS === 'web' && (
                <Text style={[styles.receiptDropHint, { color: isReceiptDropActive ? theme.primary : theme.textSecondary }]}> 
                  {isReceiptDropActive ? 'Drop files to attach receipts' : 'Tip: Drag and drop files here'}
                </Text>
              )}

              {selectedFiles.length === 0 ? (
                // Show file selection option when no files are selected
                <View style={styles.uploadOptions}>
                  <TouchableOpacity
                    style={[styles.uploadOption, { backgroundColor: theme.surface, borderColor: theme.border }]}
                    onPress={handleTakeReceiptPhoto}
                    disabled={uploadingReceipt}
                    accessibilityLabel="Take photo of receipt"
                    accessibilityRole="button"
                  >
                    <Camera size={32} color={theme.primary} />
                    <Text style={[styles.uploadOptionTitle, { color: theme.text }]}>Take Photo</Text>
                    <Text style={[styles.uploadOptionSubtitle, { color: theme.textSecondary }]}>
                      Capture a receipt with your camera
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.uploadOption, { backgroundColor: theme.surface, borderColor: theme.border }]}
                    onPress={() => handleUploadReceipt('unified')}
                    disabled={uploadingReceipt}
                  >
                    <Upload size={32} color={theme.primary} />
                    <Text style={[styles.uploadOptionTitle, { color: theme.text }]}>Select Files</Text>
                    <Text style={[styles.uploadOptionSubtitle, { color: theme.textSecondary }]}> 
                      Choose from camera, gallery, or documents
                    </Text>
                    <Text style={[styles.uploadOptionHint, { color: theme.textSecondary }]}> 
                      Supported: Images, PDFs, Word, Excel · Max 20 MB each
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                // Show selected files when files are selected
                <View>
                <View style={styles.selectedFilesHeader}>
                  <Text style={[styles.selectedFilesTitle, { color: theme.text }]}>
                    Selected Files ({selectedFiles.length})
                  </Text>
                  <TouchableOpacity
                    style={[styles.addMoreButton, { backgroundColor: `${theme.primary}15`, borderColor: theme.primary }]}
                    onPress={() => handleUploadReceipt('unified')}
                    disabled={uploadingReceipt}
                  >
                    <Plus size={16} color={theme.primary} />
                    <Text style={[styles.addMoreText, { color: theme.primary }]}>Add More</Text>
                  </TouchableOpacity>
                </View>

                <Text style={[styles.modalText, { color: theme.textSecondary, marginBottom: 16 }]}>
                  Review and confirm the files you want to upload as receipts
                </Text>

                {selectedFiles.map((file, index) => (
                  <View key={index} style={[styles.filePreviewItem, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                    <View style={styles.fileInfo}>
                      <Text style={[styles.fileName, { color: theme.text }]}>{file.name}</Text>
                      <Text style={[styles.fileSize, { color: theme.textSecondary }]}>
                        {file.size ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : 'Unknown size'}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[styles.removeFileButton, { backgroundColor: `${theme.error}15` }]}
                      onPress={() => removeSelectedFile(index)}
                    >
                      <X size={16} color={theme.error} />
                    </TouchableOpacity>
                  </View>
                ))}

                <View style={styles.previewActions}>
                  <TouchableOpacity
                    style={[styles.previewButton, styles.previewCancelButton, { borderColor: theme.border }]}
                    onPress={() => {
                      resetReceiptUploadModalState();
                    }}
                  >
                    <Text style={[styles.previewButtonText, { color: theme.textSecondary }]}>Clear All</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity
                    style={[styles.previewButton, styles.previewConfirmButton, { backgroundColor: theme.primary }]}
                    onPress={confirmUploadFiles}
                    disabled={selectedFiles.length === 0 || uploadingReceipt}
                  >
                    <Upload size={16} color="white" />
                    <Text style={[styles.previewButtonText, { color: 'white', marginLeft: 8 }]}>
                      Upload {selectedFiles.length} File{selectedFiles.length !== 1 ? 's' : ''}
                    </Text>
                  </TouchableOpacity>
                </View>
                </View>
              )}
            </View>

            {uploadingReceipt && (
              <View style={[styles.uploadingContainer, { backgroundColor: theme.surface }]}>
                <Text style={[styles.uploadingText, { color: theme.text }]}>
                  Uploading receipt{selectedFiles.length > 1 ? 's' : ''}...
                </Text>
                <View style={[styles.progressBarContainer, { backgroundColor: `${theme.primary}20` }]}>
                  <View 
                    style={[
                      styles.progressBar, 
                      {
                        backgroundColor: theme.primary,
                        width: `${easedUploadProgress}%`,
                      }
                    ]} 
                  />
                </View>
                <Text style={[styles.progressText, { color: theme.textSecondary }]}>
                  {Math.round(easedUploadProgress)}%
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Receipt Viewer Modal */}
      <Modal
        visible={showReceiptModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setShowReceiptModal(false);
          setSelectedReceipt(null); // Clear preview when closing
          setReceiptModalError(null); // Clear error when closing
        }}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Receipt</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity
                style={[styles.addMoreButton, { backgroundColor: `${theme.primary}15`, borderColor: theme.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1 }]}
                onPress={() => {
                  // Open file picker to add more receipts directly
                  handleAddMoreReceipts();
                }}
                disabled={uploadingReceipt}
              >
                <Plus size={16} color={theme.primary} />
                <Text style={[styles.addMoreText, { color: theme.primary, marginLeft: 4, fontSize: 12 }]}>
                  {uploadingReceipt ? 'Adding...' : 'Add More'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => {
                  setShowReceiptModal(false);
                  setSelectedReceipt(null); // Clear preview when closing
                  setReceiptModalError(null); // Clear error when closing
                }}
              >
                <X size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 20 }),
            }}
          >
            {/* Duplicate Receipt Error Message */}
            {receiptModalError && (
              <View style={{ backgroundColor: '#FEF2F2', borderColor: '#EF4444', borderWidth: 1, borderRadius: 8, padding: 12, marginVertical: 8, marginHorizontal: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <AlertCircle size={16} color="#EF4444" />
                    <Text style={{ color: '#EF4444', fontWeight: '600', marginLeft: 8, fontSize: 14 }}>
                      Duplicate Files Detected
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setReceiptModalError(null)}
                    style={{ padding: 4 }}
                  >
                    <X size={16} color="#EF4444" />
                  </TouchableOpacity>
                </View>
                <Text style={{ color: '#DC2626', marginTop: 4, fontSize: 13 }}>
                  {receiptModalError}
                </Text>
              </View>
            )}

            {/* Upload Progress Indicator */}
            {uploadingReceipt && (
              <View style={[{ backgroundColor: theme.surface, padding: 16, margin: 16, borderRadius: 8, borderWidth: 1, borderColor: theme.border }]}> 
                <Text style={[{ color: theme.text, fontSize: 14, fontWeight: '600', marginBottom: 8 }]}> 
                  Adding receipt(s)...
                </Text>
                <View style={[{ backgroundColor: `${theme.primary}20`, height: 8, borderRadius: 4, overflow: 'hidden' }]}> 
                  <View
                    style={[
                      { backgroundColor: theme.primary, height: '100%', borderRadius: 4 },
                      { width: `${easedUploadProgress}%` }
                    ]}
                  />
                </View>
                <Text style={[{ color: theme.textSecondary, fontSize: 12, marginTop: 4, textAlign: 'center' }]}> 
                  {Math.round(easedUploadProgress)}%
                </Text>
              </View>
            )}

            {groupedReceipts.length > 0 && (
              <View>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>
                  Receipts ({selectedFee?.receipts?.length ?? 0})
                </Text>

                {groupedReceipts.map(group => (
                  <View key={group.key} style={styles.receiptGroup}>
                    <View style={[styles.receiptGroupHeader, { borderBottomColor: theme.border }]}> 
                      <Text style={[styles.receiptGroupLabel, { color: theme.text }]}>{group.label}</Text>
                      <Text style={[styles.receiptGroupCount, { color: theme.textSecondary }]}>
                        {group.items.length} file{group.items.length === 1 ? '' : 's'}
                      </Text>
                    </View>

                    {group.items.map(({ receipt, originalIndex, uploadedAtDate }) => (
                      <View key={`${group.key}-${originalIndex}`}>
                        <View
                          style={[styles.receiptItem, { backgroundColor: theme.surface, borderColor: theme.border }]}
                        >
                          <View style={styles.receiptInfo}>
                            <Text style={[styles.receiptFileName, { color: theme.text }]}>{receipt.fileName}</Text>
                            <Text style={[styles.receiptDate, { color: theme.textSecondary }]}> 
                              Uploaded: {formatReceiptDateLabel(uploadedAtDate)}
                            </Text>
                          </View>
                          <View style={styles.receiptActions}>
                            {canPreviewFile(receipt) ? (
                              <TouchableOpacity
                                style={[styles.receiptButton, { backgroundColor: `${theme.primary}15` }]}
                                onPress={() => handleViewReceipt(receipt.url)}
                              >
                                {selectedReceipt === receipt.url ? (
                                  <EyeOff size={16} color="#EF4444" />
                                ) : (
                                  <Eye size={16} color={theme.primary} />
                                )}
                              </TouchableOpacity>
                            ) : (
                              canOpenReceiptExternally(receipt) && (
                                <TouchableOpacity
                                  style={[styles.receiptButton, { backgroundColor: `${theme.primary}15` }]}
                                  onPress={() => handleOpenReceiptExternally(receipt)}
                                  disabled={openingReceiptUrl === receipt.url}
                                >
                                  {openingReceiptUrl === receipt.url ? (
                                    <ActivityIndicator size="small" color={theme.primary} />
                                  ) : (
                                    <Eye size={16} color={theme.primary} />
                                  )}
                                </TouchableOpacity>
                              )
                            )}
                            <TouchableOpacity
                              style={[styles.receiptButton, { backgroundColor: `${theme.success || '#10B981'}15` }]}
                              onPress={() => handleDownloadReceipt(receipt.url, receipt.fileName)}
                            >
                              <Download size={16} color={theme.success || '#10B981'} />
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.receiptButton, { backgroundColor: `${theme.error}15` }]}
                              onPress={() => handleDeleteReceipt(originalIndex)}
                            >
                              <Trash2 size={16} color={theme.error} />
                            </TouchableOpacity>
                          </View>
                        </View>

                        {selectedReceipt === receipt.url && canPreviewFile(receipt) && (
                          <View style={[styles.receiptPreview, styles.inlineReceiptPreview, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                            <Image
                              source={{ uri: receipt.url }}
                              style={styles.receiptImage}
                              resizeMode="contain"
                            />
                          </View>
                        )}
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            )}

          </ScrollView>
        </View>
      </Modal>
      
      {/* Custom Toast Modal - appears above all other modals */}
      {showCustomToast && customToastData && (
        <Modal
          visible={showCustomToast}
          animationType="fade"
          transparent={true}
          statusBarTranslucent={true}
          hardwareAccelerated={true}
          onRequestClose={() => {
            setShowCustomToast(false);
            setCustomToastData(null);
          }}
        >
          <View style={styles.customToastOverlay}>
            <View style={[
              styles.customToastContainer,
              {
                backgroundColor: customToastData.type === 'info' ? '#3B82F6' : 
                                customToastData.type === 'success' ? '#10B981' : '#EF4444'
              }
            ]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.customToastTitle}>
                  {customToastData.title}
                </Text>
                <Text style={styles.customToastMessage}>
                  {customToastData.message}
                </Text>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* Fee Status Info Modal */}
      {showInfoModal && (
        <Modal
          visible={true}
          animationType="fade"
          transparent
          onRequestClose={() => setShowInfoModal(false)}
        >
          <View style={styles.infoModalOverlay}>
            <View style={[styles.infoModalContainer, { backgroundColor: theme.surface }]}>
              <View style={[styles.infoModalHeader, { borderBottomColor: theme.border }]}>
                <View style={styles.modalTitleContainer}>
                  <Info size={18} color={theme.primary} />
                  <Text style={[styles.infoModalTitle, { color: theme.text }]}>Fee Status Guide</Text>
                </View>
                <TouchableOpacity onPress={() => setShowInfoModal(false)} style={styles.closeButton}>
                  <X size={18} color={theme.text} />
                </TouchableOpacity>
              </View>
              
              <ScrollView
                style={styles.infoModalContent}
                contentContainerStyle={{
                  paddingBottom: Platform.select({ web: 0, default: 30 }),
                }}
                showsVerticalScrollIndicator={false}
              >
                <Text style={[styles.infoDescription, { color: theme.textSecondary }]}>
                  Each fee status has a specific color to help you quickly identify payment status and take appropriate action.
                </Text>
                
                <View style={styles.statusInfoContainer}>
                  {[
                    {
                      status: 'paid',
                      color: '#10B981',
                      title: '✓ Paid',
                      description: 'Payment completed successfully. No further action required for this fee period.',
                      details: 'Green indicates all payments are up to date'
                    },
                    {
                      status: 'partial',
                      color: '#F59E0B',
                      title: '⚡ Partial Payment',
                      description: 'Some amount has been paid, but a balance remains outstanding.',
                      details: 'Amber/Orange shows partial payments need completion'
                    },
                    {
                      status: 'pending',
                      color: '#3B82F6',
                      title: '⏳ Pending',
                      description: 'Fee has been created but the due date has not yet arrived. Payment is upcoming.',
                      details: 'Blue indicates upcoming fees not yet due'
                    },
                    {
                      status: 'unpaid',
                      color: '#EF4444',
                      title: '⚠️ Unpaid',
                      description: 'Payment is overdue by a few days but less than 30 days past due date.',
                      details: 'Red suggests attention is needed soon'
                    },
                    {
                      status: 'overdue',
                      color: '#DC2626',
                      title: '🚨 Overdue',
                      description: 'Payment is more than 30 days past due. Requires urgent attention and follow-up.',
                      details: 'Dark red indicates critical payment delays'
                    }
                  ].map((item, index) => (
                    <View key={index} style={[styles.statusItem, { borderColor: theme.border, backgroundColor: `${item.color}08` }]}>
                      <View style={[styles.statusIndicator, { backgroundColor: item.color }]} />
                      <View style={styles.statusDetails}>
                        <Text style={[styles.statusTitle, { color: theme.text }]}>{item.title}</Text>
                        <Text style={[styles.statusDescription, { color: theme.textSecondary }]}>
                          {item.description}
                        </Text>
                        <Text style={[styles.statusSubtitle, { color: item.color }]}>
                          {item.details}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
                
                <View style={[styles.infoNote, { backgroundColor: `${theme.primary}08`, borderColor: theme.primary }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.infoNoteTitle, { color: theme.primary }]}>
                      💡 Quick Tips
                    </Text>
                    <Text style={[styles.infoNoteText, { color: theme.textSecondary }]}>
                      • Use filters above to view specific payment statuses{'\n'}
                      • Click on any fee card to view detailed payment history{'\n'}
                      • Individual reminders can be sent via the dedicated reminders page{'\n'}
                      • Colors help you prioritize which fees need immediate attention
                    </Text>
                  </View>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {/* Calendar Modal */}
      {showCalendarModal && (
        <Modal
          visible={true}
          animationType="fade"
          transparent
          onRequestClose={() => setShowCalendarModal(false)}
        >
          <View style={styles.infoModalOverlay}>
            <View style={[styles.calendarModalContainer, { backgroundColor: theme.surface }]}>
              <View style={[styles.infoModalHeader, { borderBottomColor: theme.border }]}>
                <View style={styles.modalTitleContainer}>
                  <Text style={[styles.calendarModalTitle, { color: theme.text }]}>Monthly Fee Overview</Text>
                </View>
                <TouchableOpacity onPress={() => setShowCalendarModal(false)} style={styles.closeButton}>
                  <X size={20} color={theme.text} />
                </TouchableOpacity>
              </View>
              
              <ScrollView style={styles.infoModalContent} showsVerticalScrollIndicator={false}>
                <View style={styles.monthlyOverviewContainer}>
                  {monthlyFeeData.map((monthData: any) => {
                    const isExpanded = !!expandedMonths[monthData.key];
                    return (
                      <View
                        key={monthData.key}
                        style={[
                          styles.monthCard,
                          {
                            backgroundColor: theme.background,
                            borderColor: isExpanded ? theme.primary : theme.border,
                          },
                        ]}
                      >
                        <TouchableOpacity
                          onPress={() => toggleMonthCard(monthData.key)}
                          activeOpacity={0.7}
                          style={styles.monthCardHeader}
                        >
                          <View style={styles.monthHeaderDetails}>
                            <Text style={[styles.monthTitle, { color: theme.text, marginBottom: 0 }]}>
                              {monthData.month}
                            </Text>
                            <Text style={[styles.monthHeaderSubtitle, { color: theme.textSecondary }]}>Collected ₹{monthData.collected.toLocaleString()} · Pending ₹{monthData.pending.toLocaleString()}</Text>
                          </View>
                          <View style={styles.monthHeaderMeta}>
                            <Text style={[styles.monthHeaderTotal, { color: theme.primary }]}>₹{monthData.total.toLocaleString()}</Text>
                            <ChevronDown
                              size={16}
                              color={theme.textSecondary}
                              style={{ transform: [{ rotate: isExpanded ? '180deg' : '0deg' }] }}
                            />
                          </View>
                        </TouchableOpacity>

                        {isExpanded && (
                          <View style={styles.monthCardContent}>
                            <View style={styles.monthAmounts}>
                              <View style={styles.amountRow}>
                                <Text style={[styles.amountLabel, { color: theme.textSecondary }]}>Collected:</Text>
                                <Text style={[styles.amountValue, { color: '#10B981' }]}>₹{monthData.collected.toLocaleString()}</Text>
                              </View>

                              <View style={styles.amountRow}>
                                <Text style={[styles.amountLabel, { color: theme.textSecondary }]}>Pending:</Text>
                                <Text style={[styles.amountValue, { color: '#F59E0B' }]}>₹{monthData.pending.toLocaleString()}</Text>
                              </View>

                              <View style={[styles.amountRow, styles.totalRow, { borderTopColor: theme.border }]}>
                                <Text style={[styles.amountLabel, styles.totalLabel, { color: theme.text }]}>Total:</Text>
                                <Text style={[styles.amountValue, styles.totalValue, { color: theme.primary }]}>₹{monthData.total.toLocaleString()}</Text>
                              </View>
                            </View>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {/* Auto Fee Approval Modal */}
      {showAutoFeeApprovalModal && (
        <Modal
          visible={true}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => handleRejectAutoFees()}
        >
          <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>
                Automatic Fee Creation Approval
              </Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => setShowAutoFeeApprovalModal(false)}
              >
                <X size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.modalContent}
              contentContainerStyle={{
                paddingBottom: Platform.select({ web: 0, default: 40 }),
              }}
            >
              <View style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>
                  Fee Due Date Reached
                </Text>
                <Text style={[styles.autoFeeSectionDescription, { color: theme.textSecondary }]}>
                  The following students have reached their fee due date. You can approve/reject each individually or use the buttons below for bulk actions.
                </Text>
              </View>

              {hasVisiblePendingAutoFees ? visiblePendingAutoFeeActions.map((action) => {
                const monthLabel = generateMonthOptions.find(m => m.value === action.currentMonth)?.label;
                const resolvedStudent = action.student?.id ? studentMap[action.student.id] : undefined;
                const effectiveStudent = resolvedStudent || action.student;
                const effectiveStudentName = effectiveStudent?.name || 'Student';
                const effectiveStudentId = effectiveStudent?.id || action.student?.id;
                const resolvedMonthlyFee = typeof resolvedStudent?.monthlyFee === 'number'
                  ? resolvedStudent.monthlyFee
                  : typeof resolvedStudent?.totalFees === 'number'
                    ? resolvedStudent.totalFees
                    : action.monthlyFee;
                const amountForDisplay = typeof resolvedMonthlyFee === 'number' && !Number.isNaN(resolvedMonthlyFee)
                  ? resolvedMonthlyFee
                  : action.monthlyFee;
                const dueDateDisplay = effectiveStudentId
                  ? calculateDueDateFromMonth(action.currentMonth, effectiveStudentId)
                  : calculateDueDateFromMonth(action.currentMonth);

                return (
                  <View key={action.id} style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                    <View style={styles.studentAutoFeeInfo}>
                      <View style={styles.studentNameRow}>
                        <Text style={[styles.studentName, { color: theme.text }]}>
                          {effectiveStudentName}
                        </Text>
                        <View style={[
                          styles.actionBadge, 
                          { 
                            backgroundColor: action.type === 'create' ? `${theme.primary}15` : `${theme.warning}15`,
                            borderColor: action.type === 'create' ? theme.primary : theme.warning
                          }
                        ]}>
                          <Text style={[
                            styles.actionBadgeText, 
                            { color: action.type === 'create' ? theme.primary : theme.warning }
                          ]}>
                            {action.type === 'create' ? 'New Fee' : 'Update Fee'}
                          </Text>
                        </View>
                      </View>
                      
                      <View style={styles.autoFeeDetails}>
                        <Text style={[styles.detailText, { color: theme.textSecondary }]}>
                          Month: {monthLabel}
                        </Text>
                        <Text style={[styles.detailText, { color: theme.textSecondary }]}>
                          Amount: ₹{amountForDisplay.toLocaleString()}
                        </Text>
                        <Text style={[styles.detailText, { color: theme.textSecondary }]}>
                          Due Date: {dueDateDisplay}
                        </Text>
                        
                        {action.type === 'update' && action.existingFee && (
                          <Text style={[styles.detailText, { color: theme.primary }]}>
                            Will be added to existing consolidated fee
                          </Text>
                        )}
                      </View>

                      {/* Individual Approve/Reject Buttons */}
                      <View style={styles.individualActionButtons}>
                        <TouchableOpacity
                          style={[styles.individualButton, styles.individualRejectButton, { backgroundColor: '#fee2e2', borderColor: '#ef4444' }]}
                          onPress={() => handleRejectIndividualAutoFee(action.id)}
                        >
                          <X size={14} color="#ef4444" />
                          <Text style={[styles.individualButtonText, { color: '#ef4444' }]}>
                            Reject
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.individualButton, styles.individualApproveButton, { backgroundColor: '#dcfce7', borderColor: '#22c55e' }]}
                          onPress={() => handleApproveIndividualAutoFee(action.id)}
                        >
                          <Text style={[styles.individualButtonText, { color: '#22c55e' }]}>
                            Approve
                          </Text>
                          <Check size={14} color="#22c55e" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                );
              }) : (
                <View style={[styles.sectionContainer, { backgroundColor: theme.surface, borderColor: theme.border, alignItems: 'center' }]}> 
                  <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: `${theme.primary}12`, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                    <CheckCircle size={32} color={theme.primary} />
                  </View>
                  <Text style={[styles.sectionTitle, { color: theme.text, textAlign: 'center' }]}>You’re all caught up!</Text>
                  <Text style={[styles.autoFeeSectionDescription, { color: theme.textSecondary, textAlign: 'center', marginTop: 8 }]}>There are no automatic fee approvals waiting for review at the moment. We’ll let you know as soon as new items arrive.</Text>
                </View>
              )}

              <View style={[styles.autoFeeWarningContainer, { backgroundColor: theme.warning + '20', borderColor: theme.warning }]}>
                <Text style={[styles.autoFeeWarningText, { color: theme.warning }]}>
                  ⚠️ Note: Approved fees will be created/updated automatically. Rejected fees won’t appear again for the same month.
                  You can review and modify approved fees later if needed.
                </Text>
              </View>
            </ScrollView>

            <View style={[styles.modalFooter, { borderTopColor: theme.border }]}>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.rejectAllButton,
                  {
                    backgroundColor: '#fee2e2',
                    borderColor: '#ef4444',
                    opacity: disableRejectAll ? 0.5 : 1,
                  },
                ]}
                onPress={handleRejectAutoFees}
                disabled={disableRejectAll}
              >
                {isProcessingRejectAll ? (
                  <View style={styles.buttonContent}>
                    <ActivityIndicator size="small" color="#ef4444" />
                    <Text style={[styles.buttonText, { color: '#ef4444' }]}>Rejecting…</Text>
                  </View>
                ) : (
                  <Text style={[styles.buttonText, { color: '#ef4444' }]}>Reject All</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.submitButton,
                  { backgroundColor: theme.primary, opacity: disableApproveAll ? 0.6 : 1 },
                ]}
                onPress={handleApproveAutoFees}
                disabled={disableApproveAll}
              >
                {isProcessingApproveAll ? (
                  <View style={styles.buttonContent}>
                    <ActivityIndicator size="small" color="#ffffff" />
                    <Text style={[styles.buttonText, { color: 'white' }]}>Approving…</Text>
                  </View>
                ) : (
                  <Text style={[styles.buttonText, { color: 'white' }]}>Approve All ({visiblePendingAutoFeeActions.length})</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* Download Confirmation Modal */}
      <Modal
        visible={showDownloadConfirmModal}
        animationType="fade"
        transparent={true}
        onRequestClose={handleCancelDownload}
      >
        <View style={styles.deleteModalOverlay}>
          <View style={[styles.deleteModalContainer, { backgroundColor: theme.surface }]}>
            <View style={styles.deleteModalIcon}>
              <Text style={{ fontSize: 40 }}>📊</Text>
            </View>
            
            <Text style={[styles.deleteModalTitle, { color: theme.text }]}>
              Download Excel Report
            </Text>
            
            <Text style={[styles.deleteModalMessage, { color: theme.textSecondary }]}>
              Are you sure you want to download the comprehensive fee report?
            </Text>
            
            <View style={[styles.deleteModalDetails, { backgroundColor: theme.background }]}>
              <Text style={[styles.deleteModalFileName, { color: theme.text }]}>
                This will generate an Excel file with data for {fees.length} fee records including complete fee details, payment history, student information, and comprehensive analytics.
              </Text>
            </View>
            
            <View style={styles.deleteModalButtons}>
              <TouchableOpacity
                style={[styles.deleteModalButton, styles.deleteModalCancelButton, { backgroundColor: theme.background }]}
                onPress={handleCancelDownload}
              >
                <Text style={[styles.deleteModalButtonText, { color: theme.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.deleteModalButton, styles.deleteModalDeleteButton]}
                onPress={handleConfirmDownload}
              >
                <Text style={[styles.deleteModalButtonText, { color: 'white' }]}>Download Report</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Date Picker Component
interface DatePickerProps {
  selectedDate: string;
  onSelect: (date: string) => void;
  theme: any;
  placeholder?: string;
  allowFutureDates?: boolean;
}

function DatePicker({ selectedDate, onSelect, theme, placeholder = "Select date", allowFutureDates = true }: DatePickerProps) {
  const [showOptions, setShowOptions] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  
  const formatDate = (dateString: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  };

  const generateCalendarDays = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = new Date(firstDay);
    const endDate = new Date(lastDay);
    
    // Start from the beginning of the week
    startDate.setDate(startDate.getDate() - startDate.getDay());
    
    // End at the end of the week
    endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));
    
    const days = [];
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
      days.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return days;
  };

  const isSelectedDate = (date: Date) => {
    if (!selectedDate) return false;
    const selected = new Date(selectedDate);
    return date.toDateString() === selected.toDateString();
  };

  const isCurrentMonth = (date: Date) => {
    return date.getMonth() === currentMonth.getMonth();
  };

  const isFutureDate = (date: Date) => {
    const today = new Date();
    const dateWithoutTime = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const todayWithoutTime = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return dateWithoutTime > todayWithoutTime;
  };

  const handleDateSelect = (date: Date) => {
    // Don't allow selection if future dates are not allowed and this is a future date
    if (!allowFutureDates && isFutureDate(date)) {
      return;
    }
    
    // For payments, we can still show alert for future dates even if allowFutureDates is true
    if (allowFutureDates && isFutureDate(date)) {
      Alert.alert('Invalid Date', 'Payment date cannot be in the future');
      return;
    }
    
    // Format date properly to avoid timezone issues
    const dateString = formatDateToString(date);
    onSelect(dateString);
    setShowOptions(false);
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    const newMonth = new Date(currentMonth);
    if (direction === 'prev') {
      newMonth.setMonth(newMonth.getMonth() - 1);
    } else {
      newMonth.setMonth(newMonth.getMonth() + 1);
    }
    setCurrentMonth(newMonth);
  };

  const monthYearLabel = currentMonth.toLocaleDateString('en-US', { 
    month: 'long', 
    year: 'numeric' 
  });

  return (
    <View>
      <TouchableOpacity
        style={[styles.datePickerButton, { 
          borderColor: theme.border, 
          backgroundColor: theme.surface,
        }]}
        onPress={() => setShowOptions(!showOptions)}
      >
        <Calendar size={16} color={theme.textSecondary} />
        <Text style={[styles.datePickerText, { 
          color: selectedDate ? theme.text : theme.textSecondary 
        }]}>
          {selectedDate ? formatDate(selectedDate) : placeholder}
        </Text>
      </TouchableOpacity>
      
      {showOptions && (
        <Modal
          visible={showOptions}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setShowOptions(false)}
        >
          <TouchableOpacity 
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowOptions(false)}
          >
            <View style={[styles.datePickerModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              {/* Header */}
              <View style={styles.datePickerHeader}>
                <TouchableOpacity 
                  style={styles.monthNavButton}
                  onPress={() => navigateMonth('prev')}
                >
                  <Text style={[styles.monthNavText, { color: theme.primary }]}>‹</Text>
                </TouchableOpacity>
                
                <Text style={[styles.monthYearText, { color: theme.text }]}>
                  {monthYearLabel}
                </Text>
                
                <TouchableOpacity 
                  style={styles.monthNavButton}
                  onPress={() => navigateMonth('next')}
                >
                  <Text style={[styles.monthNavText, { color: theme.primary }]}>›</Text>
                </TouchableOpacity>
              </View>
              
              {/* Days of week */}
              <View style={styles.daysOfWeekRow}>
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                  <Text key={index} style={[styles.dayOfWeekText, { color: theme.textSecondary }]}>
                    {day}
                  </Text>
                ))}
              </View>
              
              {/* Calendar grid */}
              <View style={styles.calendarGrid}>
                {generateCalendarDays().map((date, index) => {
                  const isSelected = isSelectedDate(date);
                  const isCurrentMonthDate = isCurrentMonth(date);
                  const isFuture = isFutureDate(date);
                  const isDisabled = !allowFutureDates && isFuture;
                  
                  return (
                    <TouchableOpacity
                      key={index}
                      style={[
                        styles.calendarDay,
                        {
                          backgroundColor: isSelected ? theme.primary : 'transparent',
                          opacity: isCurrentMonthDate ? (isDisabled ? 0.3 : 1) : 0.3,
                        }
                      ]}
                      onPress={() => handleDateSelect(date)}
                      disabled={isDisabled}
                    >
                      <Text style={[
                        styles.calendarDayText,
                        {
                          color: isSelected ? '#ffffff' : (isDisabled ? theme.textSecondary : theme.text),
                          fontWeight: isSelected ? '600' : '400',
                        }
                      ]}>
                        {date.getDate()}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
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
  errorText: {
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
  title: {
    fontSize: 28,
    fontFamily: 'Poppins-Bold',
  },
  downloadButton: {
    padding: 8,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
  },
  summarySection: {
    width: '100%',
    marginTop: 20,
    gap: 12,
  },
  summaryContainer: {
    flexDirection: 'row',
    paddingHorizontal: 0,
    marginTop: 0,
    gap: 16,
  },
  summaryHeading: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '600',
  },
  summarySubheading: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
  summaryCard: {
    flex: 1,
    padding: 20,
    borderRadius: 16,
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  summaryAmount: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
    marginBottom: 4,
  },
  summaryLabel: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  summaryIcon: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterContainer: {
    paddingHorizontal: 20,
    marginTop: 24,
    marginBottom: 16,
    maxHeight: 50,
    flex: 1,
  },
  filterHeader: {
    paddingHorizontal: 0,
    marginTop: 24,
    marginBottom: 16,
  },
  sortContainer: {
    alignItems: 'flex-end',
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 5,
  },
  sortText: {
    fontSize: 11,
    fontFamily: 'Inter-Medium',
  },
  monthGroup: {
    marginBottom: 24,
  },
  monthHeader: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  monthHeaderContainer: {
    marginBottom: 12,
  },
  overdueIndicator: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  overdueStats: {
    marginTop: 4,
  },
  overdueStatsText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  filterTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 12,
    minHeight: 36,
    justifyContent: 'center',
    borderWidth: 1,
  },
  activeFilterTab: {
    // Additional styles for active tab if needed
  },
  filterText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    // Reduce vertical padding on native to shrink height while keeping web unchanged
    paddingVertical: Platform.select({ web: 10, default: 6 }),
    // Ensure the container doesn't grow too tall on mobile (leave web unchanged)
    minHeight: Platform.select({ web: undefined as any, default: 34 }),
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    // Remove extra vertical padding on native TextInput which increases height (leave web unchanged)
    paddingVertical: Platform.select({ web: undefined as any, default: 0 }),
    // Prevent unintended expansion on native while keeping web default behavior
    minHeight: Platform.select({ web: undefined as any, default: 20 }),
    // Center text vertically on Android with reduced height
    textAlignVertical: Platform.select({ android: 'center', default: undefined as any }),
  },
  recordsList: {
    flex: 1,
  },
  recordsContent: {
    paddingHorizontal: 20,
  },
  recordCard: {
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  recordHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  studentInfo: {
    flex: 1,
  },
  studentName: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    flex: 1,
  },
  studentNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  consolidatedBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 1,
    marginLeft: 8,
  },
  consolidatedText: {
    fontSize: 10,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
  },
  subjectsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  subjectTag: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 8,
    marginBottom: 3,
  },
  amountContainer: {
    alignItems: 'flex-end',
  },
  amount: {
    fontSize: 20,
    fontFamily: 'Poppins-Bold',
    marginBottom: 4,
  },
  paidAmount: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    marginBottom: 2,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  statusText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 4,
  },
  recordDetails: {
    marginBottom: 10,
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  detailText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginLeft: 8,
    lineHeight: 18,
    includeFontPadding: false,
  },
  actionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: 1,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    flex: 1,
    marginHorizontal: 4,
    justifyContent: 'center',
  },
  paidButton: {
    // Additional styles for paid button if needed
  },
  actionButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 4,
  },
  emptyState: {
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 32,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
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
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  modalTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  closeButton: {
    padding: 4,
    borderRadius: 8,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  cancelText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  feeInfo: {
    paddingBottom: 20,
    marginBottom: 20,
    borderBottomWidth: 1,
  },
  infoLabel: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    marginTop: 12,
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  formSection: {
    paddingTop: 20,
    borderTopWidth: 1,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  multilineInput: {
    height: 80,
    textAlignVertical: 'top',
  },
  pickerContainer: {
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  picker: {
    height: 50,
  },
  customPickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 12,
  },
  studentSelectorButton: {
    minHeight: 60,
  },
  studentSelectorContent: {
    flex: 1,
  },
  customPickerLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginBottom: 4,
  },
  customPickerValue: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  dateInput: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  dateText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    flex: 1,
  },
  warningText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 4,
  },
  modalFooter: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 20,
    borderTopWidth: 1,
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButton: {
    borderWidth: 1,
  },
  submitButton: {
    // No additional styles needed
  },
  buttonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  dueMonthModalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  dueMonthModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  dueMonthModalContainer: {
    marginTop: 'auto',
    width: '100%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
  },
  dueMonthModalHandle: {
    width: 48,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  dueMonthModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  dueMonthModalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  dueMonthModalCloseButton: {
    padding: 6,
    marginLeft: 12,
  },
  dueMonthOptionsList: {
    maxHeight: 400,
  },
  dueMonthOptionsContent: {
    paddingBottom: 16,
  },
  dueMonthOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  dueMonthOptionLabel: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
    flex: 1,
  },
  dueMonthEmptyState: {
    paddingVertical: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dueMonthEmptyTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 8,
  },
  dueMonthEmptyMessage: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  studentModalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  studentModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  studentModalContainer: {
    marginTop: 'auto',
    width: '100%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
  },
  studentModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  studentModalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  studentModalCloseButton: {
    padding: 6,
    marginLeft: 12,
  },
  studentSearchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  studentSearchIcon: {
    marginRight: 8,
  },
  studentSearchInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  studentList: {
    maxHeight: 420,
  },
  studentListContent: {
    paddingBottom: 20,
  },
  studentLoadingState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  studentLoadingText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  studentEmptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  studentEmptyTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 8,
  },
  studentEmptyMessage: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
  },
  studentOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
    gap: 12,
  },
  studentOptionInfo: {
    flex: 1,
  },
  studentOptionName: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 4,
  },
  studentOptionMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 4,
  },
  studentOptionMeta: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  addFeeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 8,
  },
  addFeeText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  pastDueWarning: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 4,
  },
  feePreview: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    marginTop: 20,
  },
  previewTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 12,
  },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  previewLabel: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  previewValue: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  datePickerModal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: 320,
    maxWidth: '90%',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  datePickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  datePickerTitle: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  datePickerText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    flex: 1,
  },
  selectorContainer: {
    position: 'relative',
  },
  selectorButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  selectorText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  selectorArrow: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  monthNavButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  monthNavText: {
    fontSize: 24,
    fontWeight: '600',
  },
  monthYearText: {
    fontSize: 16,
    fontWeight: '600',
  },
  daysOfWeekRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  dayOfWeekText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 4,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarDay: {
    width: '14.28%',
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
  },
  calendarDayText: {
    fontSize: 14,
  },
  deleteWarningContainer: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
    alignItems: 'center',
  },
  deleteWarningIcon: {
    marginBottom: 16,
  },
  deleteWarningTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    textAlign: 'center',
    marginBottom: 8,
  },
  deleteWarningMessage: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  deleteWarningDetails: {
    marginTop: 12,
    width: '100%',
  },
  deleteWarningDetail: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    color: '#7F1D1D',
    lineHeight: 20,
    textAlign: 'left',
  },
  feeDetails: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  feeDetailsTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 12,
  },
  feeDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  feeDetailLabel: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  feeDetailValue: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  amountHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  editAmountButton: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
  },
  editAmountText: {
    fontSize: 12,
    fontWeight: '500',
  },
  helperText: {
    fontSize: 12,
    marginTop: 4,
    fontStyle: 'italic',
  },
  warningContainer: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  warningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  warningTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  warningMessage: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 8,
  },
  existingFeeDetails: {
    backgroundColor: 'rgba(146, 64, 14, 0.1)',
    padding: 8,
    borderRadius: 4,
  },
  existingFeeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  overwriteNotice: {
    marginTop: 8,
    padding: 8,
    borderWidth: 1,
    borderRadius: 4,
  },
  overwriteText: {
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  modalText: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
    textAlign: 'center',
  },
  existingFeeInfo: {
    padding: 12,
    borderWidth: 1,
    borderRadius: 8,
    marginVertical: 12,
    alignItems: 'center',
  },
  existingFeeLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  existingFeeAmount: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  existingFeeStatus: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'capitalize',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 20,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '500',
  },
  confirmButton: {
    flex: 1,
    backgroundColor: '#EF4444',
  },
  confirmButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  
  // Custom confirmation modal styles
  confirmationOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  confirmationModal: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 12,
    padding: 0,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
  },
  confirmationHeader: {
    padding: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
  },
  confirmationTitle: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  confirmationContent: {
    padding: 20,
  },
  confirmationMessage: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  confirmationButtons: {
    flexDirection: 'row',
    padding: 20,
    paddingTop: 16,
    gap: 12,
  },
  singleConfirmationButtonContainer: {
    flexDirection: 'column',
    gap: 0,
    alignItems: 'stretch',
    width: '100%',
  },
  confirmationButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmationButtonFlexible: {
    flex: 1,
    alignSelf: 'stretch',
  },
  confirmationSingleButton: {
    width: '100%',
    alignSelf: 'stretch',
  },
  cancelConfirmButton: {
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  confirmConfirmButton: {
    // backgroundColor will be set dynamically
  },
  confirmationButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  sectionContainer: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 16,
  },
  paymentTypeContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  paymentTypeOption: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  paymentTypeText: {
    fontSize: 14,
    fontFamily: 'Poppins-Medium',
  },
  monthSelection: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  monthOption: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 120,
    alignItems: 'center',
  },
  monthOptionText: {
    fontSize: 13,
    fontFamily: 'Poppins-Medium',
    marginBottom: 2,
  },
  monthAmountText: {
    fontSize: 12,
    fontFamily: 'Poppins-Regular',
  },
  selectionSummary: {
    fontSize: 14,
    fontFamily: 'Poppins-Medium',
    marginTop: 8,
    textAlign: 'center',
  },
  // Receipt styles
  receiptGroup: {
    marginTop: 12,
    marginBottom: 20,
  },
  receiptGroupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
    marginBottom: 12,
    borderBottomWidth: 1,
  },
  receiptGroupLabel: {
    fontSize: 15,
    fontFamily: 'Poppins-SemiBold',
  },
  receiptGroupCount: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  uploadOptions: {
    flexDirection: 'column',
    gap: 16,
    marginTop: 16,
  },
  uploadOption: {
    flexDirection: 'column',
    alignItems: 'center',
    padding: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
  },
  uploadOptionTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 12,
    marginBottom: 4,
  },
  uploadOptionSubtitle: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    textAlign: 'center',
  },
  uploadOptionHint: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 6,
    textAlign: 'center',
  },
  receiptDropZone: {
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'transparent',
    padding: 10,
    marginTop: 8,
  },
  receiptDropZoneActive: {
    borderWidth: 2,
  },
  receiptDropHint: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
    marginTop: 2,
  },
  uploadingContainer: {
    marginTop: 16,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  uploadingText: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
  },
  receiptItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
  },
  receiptInfo: {
    flex: 1,
  },
  receiptFileName: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
    marginBottom: 4,
  },
  receiptDate: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
  },
  receiptActions: {
    flexDirection: 'row',
    gap: 8,
  },
  receiptButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  receiptPreview: {
    marginTop: 16,
    borderRadius: 8,
    overflow: 'hidden',
  },
  inlineReceiptPreview: {
    marginTop: 12,
    marginBottom: 16,
    borderWidth: 1,
  },
  receiptImage: {
    width: '100%',
    height: 400,
  },
  // Progress bar styles
  progressBarContainer: {
    height: 6,
    borderRadius: 3,
    marginVertical: 8,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 3,
  },
  progressText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  // File preview styles
  filePreviewItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
    marginBottom: 4,
  },
  fileSize: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  removeFileButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
    paddingBottom: 20,
  },
  previewButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    minHeight: 44,
  },
  previewCancelButton: {
    borderWidth: 1,
  },
  previewConfirmButton: {
    // backgroundColor will be set dynamically
  },
  previewButtonText: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
  },
  selectedFilesHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    marginTop: 16,
  },
  selectedFilesTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  addMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  addMoreText: {
    fontSize: 14,
    fontFamily: 'Poppins-Medium',
    marginLeft: 4,
  },
  // Delete Receipt Modal Styles
  deleteModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    elevation: 999,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  deleteModalContainer: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 32,
    margin: 20,
    maxWidth: 400,
    width: '90%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 20,
    zIndex: 100000,
  },
  deleteModalIcon: {
    marginBottom: 16,
  },
  deleteModalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    textAlign: 'center',
    marginBottom: 8,
  },
  deleteModalMessage: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  deleteModalDetails: {
    width: '100%',
    padding: 12,
    borderRadius: 8,
    marginBottom: 20,
  },
  deleteModalFileName: {
    fontSize: 14,
    fontFamily: 'Poppins-Medium',
    textAlign: 'center',
  },
  deleteModalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  deleteModalButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteModalCancelButton: {
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  deleteModalDeleteButton: {
    backgroundColor: '#EF4444',
    marginLeft: 8,
  },
  deleteModalButtonText: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
    color: 'white',
  },
  // Custom Toast Styles
  customToastOverlay: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    zIndex: 999999,
    elevation: 999,
    pointerEvents: 'none',
  },
  customToastContainer: {
    padding: 16,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.25)'
    } : {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
      elevation: 10,
    }),
  },
  customToastTitle: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    fontFamily: 'Poppins-SemiBold',
  },
  customToastMessage: {
    color: 'white',
    fontSize: 14,
    opacity: 0.9,
    marginTop: 2,
    fontFamily: 'Poppins-Regular',
  },
  // Payment Transaction Styles
  paymentTransactionCard: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  paymentTransactionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  paymentTransactionSummary: {
    flex: 1,
  },
  paymentTransactionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  paymentTransactionAmount: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  paymentTransactionDate: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  paymentTransactionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  paymentTransactionMethod: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  paymentTransactionMonths: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
  },
  expandButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    marginLeft: 8,
  },
  deletePaymentButton: {
    padding: 6,
    borderRadius: 6,
    marginRight: 8,
  },
  paymentTransactionDetails: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderTopWidth: 1,
    marginTop: -1,
  },
  paymentDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  paymentDetailLabel: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    flex: 1,
  },
  paymentDetailValue: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    flex: 2,
    textAlign: 'right',
  },
  // Individual Month Fee Editor Styles
  monthFeeEditor: {
    gap: 12,
    paddingVertical: 8,
  },
  monthFeeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  monthFeeLabel: {
    flex: 1,
  },
  monthFeeLabelText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  monthFeeInput: {
    flex: 1,
  },
  monthFeeInputField: {
    textAlign: 'right',
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  monthFeeSummary: {
    alignItems: 'flex-end',
    paddingTop: 8,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  monthFeeSummaryText: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  // Info Button and Modal Styles
  infoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 8,
  },
  // Notification Button Styles
  notificationButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 8,
    position: 'relative',
  },
  notificationBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  notificationBadgeText: {
    color: 'white',
    fontSize: 10,
    fontFamily: 'Poppins-SemiBold',
    textAlign: 'center',
  },
  infoDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginBottom: 12,
    lineHeight: 18,
  },
  statusInfoContainer: {
    gap: 6,
    marginBottom: 14,
  },
  statusItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    marginBottom: 2,
  },
  statusIndicator: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginTop: 1,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  statusDetails: {
    flex: 1,
  },
  statusTitle: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 2,
  },
  statusDescription: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    lineHeight: 16,
    marginBottom: 4,
  },
  statusSubtitle: {
    fontSize: 11,
    fontFamily: 'Inter-Medium',
    lineHeight: 14,
    fontStyle: 'italic',
  },
  infoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
  },
  infoNoteTitle: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 6,
  },
  infoNoteText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    lineHeight: 16,
    flex: 1,
  },
  // Info Modal Specific Styles
  infoModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  infoModalContainer: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  infoModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  infoModalTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  infoModalContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxHeight: 400,
  },
  toggleContainer: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  toggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  toggleSwitch: {
    width: 40,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    position: 'relative',
  },
  toggleThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    position: 'absolute',
  },
  toggleText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  inlineToggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  inlineToggleText: {
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '600',
  },
  smallToggleSwitch: {
    width: 30,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    position: 'relative',
  },
  smallToggleThumb: {
    width: 14,
    height: 14,
    borderRadius: 7,
    position: 'absolute',
  },
  // Calendar Modal Styles
  calendarModalContainer: {
    width: '100%',
    maxWidth: 500,
    maxHeight: '85%',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  calendarModalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '600',
  },
  monthlyOverviewContainer: {
    gap: 16,
  },
  monthCard: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    marginBottom: 8,
  },
  monthCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  monthHeaderDetails: {
    flex: 1,
  },
  monthHeaderSubtitle: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 4,
  },
  monthHeaderMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  monthHeaderTotal: {
    fontSize: 15,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '700',
  },
  monthCardContent: {
    marginTop: 12,
  },
  monthTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '600',
    marginBottom: 12,
  },
  monthAmounts: {
    gap: 8,
  },
  amountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  amountValue: {
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '600',
  },
  totalRow: {
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  totalLabel: {
    fontSize: 15,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '700',
  },
  totalValue: {
    fontSize: 15,
    fontFamily: 'Poppins-SemiBold',
    fontWeight: '700',
  },
  reminderHistoryItem: {
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  // Auto fee approval modal styles
  studentAutoFeeInfo: {
    gap: 8,
  },
  actionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  actionBadgeText: {
    fontSize: 12,
    fontFamily: 'Poppins-Medium',
    fontWeight: '500',
  },
  autoFeeDetails: {
    gap: 4,
    marginLeft: 8,
  },
  individualActionButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  individualButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  individualButtonText: {
    fontSize: 12,
    fontFamily: 'Poppins-Medium',
    fontWeight: '500',
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  individualApproveButton: {
    // Styling applied inline for approve button
  },
  individualRejectButton: {
    // Styling applied inline for reject button
  },
  rejectAllButton: {
    // Styling applied inline for reject all button
  },
  autoFeeWarningContainer: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 16,
  },
  autoFeeWarningText: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    lineHeight: 20,
  },
  autoFeeSectionDescription: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    lineHeight: 20,
    marginTop: 4,
  },
});