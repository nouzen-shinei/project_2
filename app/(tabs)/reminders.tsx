import { logger } from '@/lib/logger';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import { isAppForeground } from '@/hooks/useAppForeground';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  ActivityIndicator,
  Switch,
  Dimensions,
} from 'react-native';
import {
  Send,
  Users,
  Mail,
  MessageSquare,
  PhoneCall,
  CheckCircle,
  AlertCircle,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Settings,
  History,
  Clock,
} from 'lucide-react-native';
import { FontAwesome } from '@expo/vector-icons';
import { useTheme } from '../../hooks/useTheme';
import { useRouter } from 'expo-router';
import { useBirthdays } from '../../components/BirthdayProvider';
import { useStudents } from '../../hooks/useStudents';
import { useAuth } from '../../hooks/useAuthUnified';
import { useReminderSettings } from '../../hooks/useReminderSettings';
import { useGlobalReminderChannels } from '../../hooks/useGlobalReminderChannels';
import { useTenant } from '../../hooks/useTenantContext';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import UsageAlertInlineBanner from '@/components/UsageAlertInlineBanner';
import { useActiveUsageAlerts } from '@/hooks/useActiveUsageAlerts';
import { useTenantUsageSummary } from '@/hooks/useTenantUsageSummary';
import type { UsageAlertRecord } from '@/types/usage';
import { usageAnalyticsService, ReminderBatchSendError } from '@/services/usageAnalyticsService';
import useFees from '../../hooks/useFees';
import { whatsappQueueClient } from '../../services/whatsappQueueClient';
import ReminderHistoryViewer from '../../components/ReminderHistoryViewer';
import { Student, FeeRecord } from '../../types';
import { formatDateToString } from '../../lib/utils';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';

interface ReminderType {
  id: string;
  name: string;
  icon: React.ReactNode;
  color: string;
  description: string;
}

interface SendStatus {
  studentId: string;
  type: string;
  status: 'pending' | 'queued' | 'success' | 'failed' | 'skipped';
  message?: string;
}

type SendabilityQuickFilter =
  | null
  | 'missing-email'
  | 'invalid-email'
  | 'missing-phone'
  | 'missing-whatsapp'
  | 'custom-empty'
  | 'disabled-channel';

export default function SendReminders() {
  const { theme } = useTheme();
  const router = useRouter();
  const { headerCompensation } = useBirthdays();
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);
  const sharedTopPadding = useSharedTopPadding();
  const { students, loading: studentsLoading } = useStudents();
  const { fees } = useFees();
  const { user } = useAuth();
  const { activeTenant, loading: tenantLoading } = useTenant();
  const { policy: globalReminderPolicy } = useGlobalReminderChannels();
  const { 
    settings: reminderSettings, // Saved settings for actual reminders
    localSettings, // Local settings for UI display
    updateLocalSetting, 
    saveSettings, 
    discardChanges, 
    hasUnsavedChanges, 
    saving, 
    loading: settingsLoading 
  } = useReminderSettings();
  const tenantId = activeTenant?.id ?? null;
  const {
    usageSummary,
    loading: usageSummaryLoading,
    error: usageSummaryError,
    refresh: refreshUsageSummary,
    lastUpdated: usageSummaryLastUpdated,
  } = useTenantUsageSummary(tenantId);
  const effectivePlanLimits = useMemo(() => {
    return usageSummary?.planLimits ?? null;
  }, [usageSummary?.planLimits]);

  const reminderLimitByType = useMemo(() => {
    if (!effectivePlanLimits) {
      return {
        email: null,
        sms: null,
        whatsapp: null,
        voice: null,
      } as const;
    }
    return {
      email: effectivePlanLimits.reminders.email,
      sms: effectivePlanLimits.reminders.sms,
      whatsapp: effectivePlanLimits.reminders.whatsapp,
      voice: effectivePlanLimits.reminders.voice,
    } as const;
  }, [effectivePlanLimits]);

  const reminderTotalLimit = useMemo(() => {
    const total = (effectivePlanLimits as any)?.reminders?.total;
    return typeof total === 'number' && Number.isFinite(total) ? total : null;
  }, [effectivePlanLimits]);

  const reminderUsedByType = useMemo(() => {
    const r = usageSummary?.reminders;
    return {
      email: typeof r?.email === 'number' ? r.email : 0,
      sms: typeof r?.sms === 'number' ? r.sms : 0,
      whatsapp: typeof r?.whatsapp === 'number' ? r.whatsapp : 0,
      voice: typeof r?.voice === 'number' ? r.voice : 0,
    } as const;
  }, [usageSummary?.reminders]);

  const reminderEffectiveUsedByType = useMemo(() => {
    const r = usageSummary?.reminders;
    const sent = {
      email: typeof r?.email === 'number' ? r.email : 0,
      sms: typeof r?.sms === 'number' ? r.sms : 0,
      whatsapp: typeof r?.whatsapp === 'number' ? r.whatsapp : 0,
      voice: typeof r?.voice === 'number' ? r.voice : 0,
    };
    const inFlight = {
      email: typeof (r as any)?.inFlight?.email === 'number' ? (r as any).inFlight.email : 0,
      sms: typeof (r as any)?.inFlight?.sms === 'number' ? (r as any).inFlight.sms : 0,
      whatsapp: typeof (r as any)?.inFlight?.whatsapp === 'number' ? (r as any).inFlight.whatsapp : 0,
      voice: typeof (r as any)?.inFlight?.voice === 'number' ? (r as any).inFlight.voice : 0,
    };
    const reserved = {
      email: typeof (r as any)?.reserved?.email === 'number' ? (r as any).reserved.email : 0,
      sms: typeof (r as any)?.reserved?.sms === 'number' ? (r as any).reserved.sms : 0,
      whatsapp: typeof (r as any)?.reserved?.whatsapp === 'number' ? (r as any).reserved.whatsapp : 0,
      voice: typeof (r as any)?.reserved?.voice === 'number' ? (r as any).reserved.voice : 0,
    };

    return {
      email: sent.email + inFlight.email + reserved.email,
      sms: sent.sms + inFlight.sms + reserved.sms,
      whatsapp: sent.whatsapp + inFlight.whatsapp + reserved.whatsapp,
      voice: sent.voice + inFlight.voice + reserved.voice,
    } as const;
  }, [usageSummary?.reminders]);

  const reminderTotalUsed = useMemo(() => {
    const total = (usageSummary as any)?.reminders?.effectiveUsed;
    if (typeof total === 'number' && Number.isFinite(total)) {
      return total;
    }
    return (
      reminderEffectiveUsedByType.email +
      reminderEffectiveUsedByType.sms +
      reminderEffectiveUsedByType.whatsapp +
      reminderEffectiveUsedByType.voice
    );
  }, [usageSummary, reminderEffectiveUsedByType]);

  const reminderTotalRemaining = useMemo(() => {
    if (typeof reminderTotalLimit !== 'number' || !Number.isFinite(reminderTotalLimit) || reminderTotalLimit <= 0) {
      return null;
    }
    return Math.max(0, reminderTotalLimit - reminderTotalUsed);
  }, [reminderTotalLimit, reminderTotalUsed]);

  const localReminderUsageThresholdAlert = useMemo<UsageAlertRecord | null>(() => {
    if (typeof reminderTotalRemaining !== 'number' || !Number.isFinite(reminderTotalRemaining)) {
      return null;
    }
    if (typeof reminderTotalLimit !== 'number' || !Number.isFinite(reminderTotalLimit) || reminderTotalLimit <= 0) {
      return null;
    }
    if (typeof reminderTotalUsed !== 'number' || !Number.isFinite(reminderTotalUsed) || reminderTotalUsed < 0) {
      return null;
    }

    const warningThreshold =
      typeof (effectivePlanLimits as any)?.warningThreshold === 'number' && Number.isFinite((effectivePlanLimits as any).warningThreshold)
        ? (effectivePlanLimits as any).warningThreshold
        : null;
    const criticalThreshold =
      typeof (effectivePlanLimits as any)?.criticalThreshold === 'number' && Number.isFinite((effectivePlanLimits as any).criticalThreshold)
        ? (effectivePlanLimits as any).criticalThreshold
        : 1;

    const ratio = reminderTotalLimit > 0 ? reminderTotalUsed / reminderTotalLimit : 0;
    const isCritical = reminderTotalRemaining <= 0 || ratio >= criticalThreshold;
    const isWarning = !isCritical && warningThreshold !== null && ratio >= warningThreshold;

    if (!isCritical && !isWarning) {
      return null;
    }

    return {
      id: isCritical ? 'local_reminders_total_exhausted' : 'local_reminders_near_limit',
      metric: 'reminders',
      type: isCritical ? 'critical' : 'warning',
      value: reminderTotalUsed,
      limit: reminderTotalLimit,
      ratio,
      createdAt: new Date().toISOString(),
      metadata: {
        source: isCritical ? 'local_total_remaining_0' : 'local_warning_threshold',
        ...(warningThreshold !== null ? { warningThreshold } : {}),
        ...(typeof criticalThreshold === 'number' ? { criticalThreshold } : {}),
      },
    };
  }, [effectivePlanLimits, reminderTotalLimit, reminderTotalRemaining, reminderTotalUsed]);
  const {
    highlightedAlert: reminderUsageAlert,
    alertCount: reminderAlertCount,
    monthId: reminderUsageMonthId,
    loading: reminderUsageAlertLoading,
    error: reminderUsageAlertError,
    refresh: refreshReminderAlerts,
  } = useActiveUsageAlerts(tenantId, { metrics: ['reminders'] });

  const resolvedUsageBannerAlert = reminderUsageAlert ?? localReminderUsageThresholdAlert;
  const resolvedUsageBannerCount = reminderAlertCount > 0 ? reminderAlertCount : resolvedUsageBannerAlert ? 1 : 0;
  const shouldShowUsageBanner = Boolean(reminderUsageAlertLoading || reminderUsageAlertError || resolvedUsageBannerAlert);
  const tenantUnavailable = !tenantLoading && !tenantId;
  
  const [selectedStudents, setSelectedStudents] = useState<Set<string>>(new Set());
  const [reminderTypes, setReminderTypes] = useState<Set<string>>(new Set(['email']));
  const [customMessage, setCustomMessage] = useState('');
  const [customMessageHindi, setCustomMessageHindi] = useState('');
  const [customMessageEnglish, setCustomMessageEnglish] = useState('');
  const [useCustomMessage, setUseCustomMessage] = useState(false);
  const [customNotes, setCustomNotes] = useState('');
  const [customNotesHindi, setCustomNotesHindi] = useState('');
  const [customNotesEnglish, setCustomNotesEnglish] = useState('');
  const [useCustomNotes, setUseCustomNotes] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sendStatuses, setSendStatuses] = useState<SendStatus[]>([]);
  const [waJobIds, setWaJobIds] = useState<Map<string, string>>(new Map()); // key: studentId_type (whatsapp) -> jobId
  const [historyIdByKey, setHistoryIdByKey] = useState<Map<string, string>>(new Map()); // key: studentId_type -> historyId
  const [polling, setPolling] = useState(false);
  const [historyPolling, setHistoryPolling] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showQuotaBlockModal, setShowQuotaBlockModal] = useState(false);
  const [quotaBlockData, setQuotaBlockData] = useState<
    | null
    | {
        kind?: 'quota' | 'channels';
        title: string;
        description: string;
        lines: {
          type: 'email' | 'sms' | 'whatsapp' | 'voice';
          label: string;
          needed: number;
          remaining: number;
          used: number;
          limit: number;
        }[];
        selectedStudents: number;
      }
  >(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'overdue' | 'unpaid' | 'partial'>('all');
  const [sendabilityQuickFilter, setSendabilityQuickFilter] = useState<SendabilityQuickFilter>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [previewStudentIndex, setPreviewStudentIndex] = useState(0);
  const [screenWidth, setScreenWidth] = useState(Dimensions.get('window').width);
  // Centralized offline-aware loading gate (prevents zeroed UI on cold offline start)
  const { showLoading: showOfflineLoadingReminders, offlineHint: offlineHintReminders } = useOfflineDataGate(
    [students, fees],
    [studentsLoading, settingsLoading]
  );
  // Defer early return until after all hooks are declared (inserted further below)

  // Update screen width on dimension changes
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setScreenWidth(window.width);
    });
    return () => subscription?.remove();
  }, []);

  // Extract settings from persistent store
  const {
    addGreetings,
    useCustomGreetings,
    customGreetingsEnglish,
    customGreetingsHindi,
    selectedLanguage,
    englishVoice,
    hindiVoice,
    languageOrder,
  } = reminderSettings;

  const tenantEnabledChannels = useMemo(() => {
    const raw = (reminderSettings as any)?.enabledChannels;
    return {
      email: raw?.email !== false,
      sms: raw?.sms !== false,
      whatsapp: raw?.whatsapp !== false,
      voice: raw?.voice !== false,
    } as const;
  }, [reminderSettings]);

  const globalEnabledChannels = useMemo(() => {
    const raw = (globalReminderPolicy as any)?.enabledChannels;
    return {
      email: raw?.email !== false,
      sms: raw?.sms !== false,
      whatsapp: raw?.whatsapp !== false,
      voice: raw?.voice !== false,
    } as const;
  }, [globalReminderPolicy]);

  const enabledChannels = useMemo(() => {
    return {
      email: globalEnabledChannels.email && tenantEnabledChannels.email,
      sms: globalEnabledChannels.sms && tenantEnabledChannels.sms,
      whatsapp: globalEnabledChannels.whatsapp && tenantEnabledChannels.whatsapp,
      voice: globalEnabledChannels.voice && tenantEnabledChannels.voice,
    } as const;
  }, [globalEnabledChannels, tenantEnabledChannels]);

  const effectiveChannelMessages = useMemo(() => {
    const tenantMsgs = ((reminderSettings as any)?.channelMessages ?? {}) as any;
    const globalMsgs = ((globalReminderPolicy as any)?.channelMessages ?? {}) as any;

    const pick = (key: 'email' | 'sms' | 'whatsapp' | 'voice') => {
      const tenantVal = typeof tenantMsgs?.[key] === 'string' ? tenantMsgs[key].trim() : '';
      if (tenantVal) return tenantVal;
      const globalVal = typeof globalMsgs?.[key] === 'string' ? globalMsgs[key].trim() : '';
      return globalVal || '';
    };

    return {
      email: pick('email'),
      sms: pick('sms'),
      whatsapp: pick('whatsapp'),
      voice: pick('voice'),
    } as const;
  }, [globalReminderPolicy, reminderSettings]);
  const resolvedCoachingName = useMemo(() => {
    if (!reminderSettings.showCoachingName) {
      return '';
    }
    const baseName = (activeTenant?.name || '').trim();
    const fallbackName = baseName || 'S.S Tuition Classes';
    if (reminderSettings.useCustomCoachingName) {
      const custom = reminderSettings.customCoachingName?.trim();
      if (custom) {
        return custom;
      }
    }
    return fallbackName;
  }, [activeTenant?.name, reminderSettings.showCoachingName, reminderSettings.useCustomCoachingName, reminderSettings.customCoachingName]);
  const resolvedTeacherName = user?.displayName?.trim() || undefined;

  // Ensure previewStudentIndex stays within bounds when selectedStudents changes
  useEffect(() => {
    if (selectedStudents.size > 0 && previewStudentIndex >= selectedStudents.size) {
      setPreviewStudentIndex(Math.max(0, selectedStudents.size - 1));
    }
  }, [selectedStudents.size, previewStudentIndex]);

  // Debug modal state changes
  useEffect(() => {
    logger.debug('Status modal state changed:', showStatusModal);
  }, [showStatusModal]);

  useEffect(() => {
    logger.debug('isSending state changed:', isSending);
  }, [isSending]);

  useEffect(() => {
    logger.debug('isProcessing state changed:', isProcessing);
  }, [isProcessing]);

  // Defer offline early-return until after all hooks are declared

  // Poll WhatsApp job statuses while there are queued jobs
  useEffect(() => {
    if (!tenantId) return;
    const queuedKeys = sendStatuses.filter(s => s.type === 'whatsapp' && s.status === 'queued').map(s => `${s.studentId}_${s.type}`);
    if (!queuedKeys.length) {
      if (polling) setPolling(false);
      return; // nothing to poll
    }
    let cancelled = false;
    if (!polling) setPolling(true);

    const poll = async () => {
      // Skip network work while the app/tab is backgrounded so status polling
      // does not pile up requests that all fire on resume. The interval resumes
      // automatically on the next tick once foregrounded.
      if (!isAppForeground()) return;
      try {
        const jobIds: string[] = [];
        queuedKeys.forEach(k => { const id = waJobIds.get(k); if (id) jobIds.push(id); });
        if (!jobIds.length) return;
        const res = await whatsappQueueClient.getMultipleJobStatus(jobIds, tenantId);
        if (cancelled || !res?.jobs) return;
        const statusMap: Record<string,string> = {};
        res.jobs.forEach((j: any) => { statusMap[j.id] = j.status; });

        let anyRemainingQueued = false;
        setSendStatuses(prev => prev.map(s => {
          if (s.type !== 'whatsapp') return s;
          if (s.status === 'queued') {
            const jobId = waJobIds.get(`${s.studentId}_${s.type}`);
            if (jobId && statusMap[jobId]) {
              if (statusMap[jobId] === 'success') return { ...s, status: 'success', message: 'Delivered (queued)' };
              if (statusMap[jobId] === 'failed') return { ...s, status: 'failed', message: 'Failed after queue' };
              if (statusMap[jobId] === 'processing') return { ...s, status: 'queued', message: 'Processing...' };
              // Job is no longer tracked by the backend (e.g., queue was reset /
              // restarted). Treat as terminal so the modal doesn't poll forever;
              // the authoritative outcome remains in reminderHistory.
              if (statusMap[jobId] === 'unknown') return { ...s, status: 'failed', message: 'Send status unavailable' };
            }
            // Still queued
            anyRemainingQueued = true;
          }
          return s;
        }));
        if (!anyRemainingQueued) setPolling(false);
      } catch (e) {
        logger.warn('Polling error', e);
      }
    };

    // Initial immediate poll then interval
    poll();
    const interval = setInterval(poll, 4000); // 4s interval to reduce load
    return () => { cancelled = true; clearInterval(interval); };
  }, [sendStatuses.filter(s => s.type === 'whatsapp' && s.status === 'queued').length, waJobIds, polling, tenantId]);

  // Poll reminderHistory statuses (email/sms/voice) via backend while there are queued/pending sends.
  // This avoids Firestore client listeners but still updates the Sending Status modal.
  useEffect(() => {
    if (!tenantId) return;
    if (!showStatusModal) {
      if (historyPolling) setHistoryPolling(false);
      return;
    }
    const active = sendStatuses.filter(
      (s) => s.type !== 'whatsapp' && (s.status === 'queued' || s.status === 'pending'),
    );
    if (!active.length) {
      if (historyPolling) setHistoryPolling(false);
      return;
    }

    const ids = Array.from(
      new Set(
        active
          .map((s) => historyIdByKey.get(`${s.studentId}_${s.type}`))
          .filter(Boolean) as string[],
      ),
    );

    if (!ids.length) {
      if (historyPolling) setHistoryPolling(false);
      return;
    }

    let cancelled = false;
    if (!historyPolling) setHistoryPolling(true);

    const poll = async () => {
      // Skip network work while backgrounded; resumes on the next tick.
      if (!isAppForeground()) return;
      try {
        const res = await usageAnalyticsService.getReminderHistoryStatuses(tenantId, ids);
        if (cancelled || !res?.results) return;
        const byHistoryId = new Map(res.results.map((r) => [r.historyId, r] as const));

        let anyRemaining = false;
        setSendStatuses((prev) =>
          prev.map((s) => {
            if (s.type === 'whatsapp') return s;
            if (s.status !== 'queued' && s.status !== 'pending') return s;
            const historyId = historyIdByKey.get(`${s.studentId}_${s.type}`);
            if (!historyId) {
              anyRemaining = true;
              return s;
            }
            const updated = byHistoryId.get(historyId);
            if (!updated) {
              anyRemaining = true;
              return s;
            }

            if (updated.status === 'queued' || updated.status === 'pending') {
              anyRemaining = true;
            }

            return {
              ...s,
              status: updated.status,
              message: updated.message || s.message,
            };
          }),
        );

        if (!anyRemaining) setHistoryPolling(false);
      } catch (e) {
        logger.warn('History status polling error', e);
      }
    };

    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    showStatusModal,
    sendStatuses.filter((s) => s.type !== 'whatsapp' && (s.status === 'queued' || s.status === 'pending')).length,
    historyIdByKey,
    historyPolling,
    tenantId,
  ]);

  const manualRefreshQueued = useCallback(async () => {
    if (!tenantId) return;
    const queuedStatuses = sendStatuses.filter(s => s.type === 'whatsapp' && s.status === 'queued');
    const jobIds = queuedStatuses.map(s => waJobIds.get(`${s.studentId}_${s.type}`)).filter(Boolean) as string[];
    if (!jobIds.length) return;
    try {
      const res = await whatsappQueueClient.getMultipleJobStatus(jobIds, tenantId);
      if (!res?.jobs) return;
      const statusMap: Record<string,string> = {};
      res.jobs.forEach((j: any) => { statusMap[j.id] = j.status; });
      setSendStatuses(prev => prev.map(s => {
        if (s.type === 'whatsapp' && s.status === 'queued') {
          const jobId = waJobIds.get(`${s.studentId}_${s.type}`);
          if (jobId && statusMap[jobId]) {
            if (statusMap[jobId] === 'success') return { ...s, status: 'success', message: 'Delivered (queued)' };
            if (statusMap[jobId] === 'failed') return { ...s, status: 'failed', message: 'Failed after queue' };
            if (statusMap[jobId] === 'processing') return { ...s, message: 'Processing...' };
          }
        }
        return s;
      }));
    } catch (e) {
      logger.warn('Manual refresh error', e);
    }
  }, [sendStatuses, waJobIds, tenantId]);

  useEffect(() => {
    if (!sendStatuses.length || !tenantId) return;
    const hasActive = sendStatuses.some((s) => s.status === 'pending' || s.status === 'queued');
    if (hasActive) return;

    refreshUsageSummary().catch((e) => logger.warn('Usage summary refresh after send completion failed', e));
    refreshReminderAlerts().catch((e) => logger.warn('Usage alert refresh after send completion failed', e));
  }, [sendStatuses, tenantId, refreshUsageSummary, refreshReminderAlerts]);

  // Helper functions to get appropriate custom messages based on language
  // Note: WhatsApp newline formatting is handled by backend (converts \n to commas)
  const getCustomMessageForLanguage = useCallback((_messageType: 'sms' | 'whatsapp' | 'voice' | 'email') => {
    if (!useCustomMessage) return null;
    
    if (selectedLanguage === 'both') {
      // For "both" languages, combine both messages based on order
      const englishMsg = customMessageEnglish.trim();
      const hindiMsg = customMessageHindi.trim();
      
      if (!englishMsg && !hindiMsg) return null;
      
      let combined = '';
      if (languageOrder === 'english-first') {
        if (englishMsg) combined += englishMsg;
        if (hindiMsg) combined += (combined ? '\n\n' : '') + hindiMsg;
      } else {
        if (hindiMsg) combined += hindiMsg;
        if (englishMsg) combined += (combined ? '\n\n' : '') + englishMsg;
      }
      return combined || null;
    } else {
      // For single language, use the appropriate field
      return customMessage.trim() || null;
    }
  }, [useCustomMessage, selectedLanguage, customMessage, customMessageEnglish, customMessageHindi, languageOrder]);

  // Returns a merged string for legacy usages (email/SMS/body previews)
  const getCustomNotesForLanguage = useCallback((): string | null => {
    if (!useCustomNotes) return null;
    if (selectedLanguage === 'both') {
      const englishNotes = customNotesEnglish.trim();
      const hindiNotes = customNotesHindi.trim();
      if (!englishNotes && !hindiNotes) return null;
      if (languageOrder === 'english-first') {
        return [englishNotes, hindiNotes].filter(Boolean).join('\n\n') || null;
      } else {
        return [hindiNotes, englishNotes].filter(Boolean).join('\n\n') || null;
      }
    }
    return customNotes.trim() || null;
  }, [useCustomNotes, selectedLanguage, customNotes, customNotesEnglish, customNotesHindi, languageOrder]);

  // New structured accessor (not yet wired to backend) for future bilingual placeholder mapping
  const getStructuredCustomNotes = useCallback(() => {
    if (!useCustomNotes) return null;
    if (selectedLanguage === 'both') {
      return {
        english: customNotesEnglish.trim() || null,
        hindi: customNotesHindi.trim() || null,
        order: languageOrder as 'english-first' | 'hindi-first'
      };
    }
    return {
      [selectedLanguage]: customNotes.trim() || null
    } as { english?: string | null; hindi?: string | null };
  }, [useCustomNotes, selectedLanguage, customNotes, customNotesEnglish, customNotesHindi, languageOrder]);

  const reminderTypeOptions: ReminderType[] = [
    {
      id: 'email',
      name: 'Email',
      icon: <Mail size={20} color="#ffffff" />,
      color: '#007AFF',
      description: 'Professional email reminders with detailed formatting',
    },
    {
      id: 'sms',
      name: 'SMS',
      icon: <MessageSquare size={20} color="#ffffff" />,
      color: '#34C759',
      description: 'Quick text message reminders',
    },
    {
      id: 'whatsapp',
      name: 'WhatsApp',
      icon: <FontAwesome name="whatsapp" size={20} color="#ffffff" />,
      color: '#25D366',
      description: 'WhatsApp messages with rich formatting',
    },
    {
      id: 'voice',
      name: 'Voice Call',
      icon: <PhoneCall size={20} color="#ffffff" />,
      color: '#25D366',
      description: 'Automated voice call reminders with multi-language support',
    },
  ];

  const effectiveHideDisabledReminderTypes = useMemo(() => {
    const tenantFlag = (reminderSettings as any)?.hideDisabledReminderTypes;
    if (typeof tenantFlag === 'boolean') return tenantFlag;
    const globalFlag = (globalReminderPolicy as any)?.hideDisabledReminderTypes;
    if (typeof globalFlag === 'boolean') return globalFlag;
    return false;
  }, [reminderSettings, globalReminderPolicy]);

  const visibleReminderTypeOptions = useMemo(() => {
    if (!effectiveHideDisabledReminderTypes) {
      return reminderTypeOptions;
    }

    return reminderTypeOptions.filter((opt) => {
      if (opt.id === 'email') return enabledChannels.email;
      if (opt.id === 'sms') return enabledChannels.sms;
      if (opt.id === 'whatsapp') return enabledChannels.whatsapp;
      if (opt.id === 'voice') return enabledChannels.voice;
      return false;
    });
  }, [reminderTypeOptions, enabledChannels, effectiveHideDisabledReminderTypes]);

  const anyReminderChannelEnabled = useMemo(() => {
    return enabledChannels.email || enabledChannels.sms || enabledChannels.whatsapp || enabledChannels.voice;
  }, [enabledChannels]);

  // Ensure selected reminder types never include admin-disabled channels.
  useEffect(() => {
    setReminderTypes((prev) => {
      const next = new Set(prev);
      if (!enabledChannels.email) next.delete('email');
      if (!enabledChannels.sms) next.delete('sms');
      if (!enabledChannels.whatsapp) next.delete('whatsapp');
      if (!enabledChannels.voice) next.delete('voice');

      // If nothing remains, pick the first enabled channel as a sensible default.
      if (next.size === 0) {
        if (enabledChannels.email) next.add('email');
        else if (enabledChannels.whatsapp) next.add('whatsapp');
        else if (enabledChannels.sms) next.add('sms');
        else if (enabledChannels.voice) next.add('voice');
      }
      return next;
    });
  }, [enabledChannels.email, enabledChannels.sms, enabledChannels.whatsapp, enabledChannels.voice]);

  // Helper function to get correct amount for a fee record
  const getCorrectFeeAmount = useCallback((record: FeeRecord): number => {
    if (record.monthFeeAmounts && record.monthsCovered) {
      // Use sum of individual month amounts for consolidated fees
      return record.monthsCovered.reduce((sum: number, month: string) => 
        sum + (record.monthFeeAmounts?.[month] || 0), 0);
    }
    // Fallback to stored amount
    return record.amount || 0;
  }, []);

  // Helper function to categorize fee status (matching fees page logic)
  const categorizeFee = useCallback((fee: FeeRecord) => {
    if (fee.status === 'paid') return 'paid';
    
    const today = new Date();
    const dueDate = new Date(fee.dueDate);
    const daysDiff = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Check for partial payment
    if (fee.paidAmount && fee.paidAmount > 0 && fee.paidAmount < fee.amount) return 'partial';
    
    // Check date-based categories
    if (daysDiff > 30) return 'overdue';
    if (daysDiff >= 0) return 'unpaid'; // Due date has passed but within 30 days
    return 'pending'; // Due date hasn't arrived yet
  }, []);

  // Filter students based on search and filter type
  const filteredStudents = useMemo(() => {
    return students.filter(student => {
      // Only show active students
      if (student.status !== 'active') return false;

      const matchesSearch = student.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           student.parentName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           student.parentContact?.includes(searchQuery) ||
                           student.parentPhone?.includes(searchQuery) ||
                           student.parentEmail?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           student.parentWhatsApp?.includes(searchQuery);
      
      if (!matchesSearch) return false;

  // When custom message is enabled, include all active students matching search
  if (useCustomMessage) return true;

      // Filter for students with due fees (exclude 'paid' and 'pending' statuses)
      const studentFees = fees.filter((fee: FeeRecord) => {
        const category = categorizeFee(fee);
        return fee.studentId === student.id && 
               category !== 'paid' && 
               category !== 'pending';
      });

      // If no due fees, don't show the student
      if (studentFees.length === 0) return false;

      if (filterType === 'all') return true;
      
      if (filterType === 'overdue') {
        return studentFees.some((fee: FeeRecord) => categorizeFee(fee) === 'overdue');
      }
      if (filterType === 'unpaid') {
        return studentFees.some((fee: FeeRecord) => categorizeFee(fee) === 'unpaid');
      }
      if (filterType === 'partial') {
        return studentFees.some((fee: FeeRecord) => categorizeFee(fee) === 'partial');
      }
      
      return true;
    });
  }, [students, searchQuery, filterType, fees, categorizeFee, useCustomMessage]);

  // Helper function to get student counts for each category
  const getCategoryCounts = useCallback(() => {
    // Get all active students with due fees (ignoring current filter selection)
    const allEligibleStudents = students.filter(student => {
      // Only show active students
      if (student.status !== 'active') return false;

      const matchesSearch = student.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           student.parentName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           student.parentContact?.includes(searchQuery) ||
                           student.parentPhone?.includes(searchQuery) ||
                           student.parentEmail?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           student.parentWhatsApp?.includes(searchQuery);
      
      if (!matchesSearch) return false;

      // Filter for students with due fees (exclude 'paid' and 'pending' statuses)
      const studentFees = fees.filter((fee: FeeRecord) => {
        const category = categorizeFee(fee);
        return fee.studentId === student.id && 
               category !== 'paid' && 
               category !== 'pending';
      });

      // If no due fees, don't count the student
      return studentFees.length > 0;
    });

    const counts = {
      all: allEligibleStudents.length,
      unpaid: 0,
      partial: 0,
      overdue: 0,
    };

    allEligibleStudents.forEach(student => {
      const studentFees = fees.filter((fee: FeeRecord) => {
        const category = categorizeFee(fee);
        return fee.studentId === student.id && 
               category !== 'paid' && 
               category !== 'pending';
      });

      const hasUnpaid = studentFees.some((fee: FeeRecord) => categorizeFee(fee) === 'unpaid');
      const hasPartial = studentFees.some((fee: FeeRecord) => categorizeFee(fee) === 'partial');
      const hasOverdue = studentFees.some((fee: FeeRecord) => categorizeFee(fee) === 'overdue');

      if (hasUnpaid) counts.unpaid++;
      if (hasPartial) counts.partial++;
      if (hasOverdue) counts.overdue++;
    });

    return counts;
  }, [students, searchQuery, fees, categorizeFee]);

  // PERF: compute the category counts ONCE per render (memoized) instead of
  // re-running the O(students × fees) scan once per filter chip (was 4×/render).
  const categoryCounts = useMemo(() => getCategoryCounts(), [getCategoryCounts]);

  const getStudentFeeInfo = useCallback((student: Student) => {
    const studentFees = fees.filter((fee: FeeRecord) => {
      const category = categorizeFee(fee);
      return fee.studentId === student.id && 
             category !== 'paid' && 
             category !== 'pending';
    });
    const totalDue = studentFees.reduce((sum: number, fee: FeeRecord) => {
      const correctAmount = getCorrectFeeAmount(fee);
      return sum + (correctAmount - (fee.paidAmount || 0));
    }, 0);
    const overdueCount = studentFees.filter((fee: FeeRecord) => categorizeFee(fee) === 'overdue').length;
    
    // Get the earliest due date from overdue/partial/unpaid fees
    const earliestDueDate = studentFees.length > 0 
      ? studentFees.reduce((earliest, fee) => {
          return new Date(fee.dueDate) < new Date(earliest) ? fee.dueDate : earliest;
        }, studentFees[0].dueDate)
      : formatDateToString(new Date()); // fallback to today if no fees
    
    return { totalDue, overdueCount, fees: studentFees, earliestDueDate };
  }, [fees, getCorrectFeeAmount, categorizeFee]);

  // Helper function to get detailed fee breakdown for display
  const getDetailedFeeInfo = useCallback((student: Student) => {
    const studentFees = fees.filter((fee: FeeRecord) => {
      const category = categorizeFee(fee);
      return fee.studentId === student.id && 
             category !== 'paid' && 
             category !== 'pending';
    });

    if (studentFees.length === 0) return null;

    // Group fees by category
    const categorizedFees = {
      overdue: studentFees.filter(fee => categorizeFee(fee) === 'overdue'),
      unpaid: studentFees.filter(fee => categorizeFee(fee) === 'unpaid'),
      partial: studentFees.filter(fee => categorizeFee(fee) === 'partial')
    };

    const breakdown: {category: string, amount: number, details?: string, color: string}[] = [];

    // Add overdue fees
    if (categorizedFees.overdue.length > 0) {
      const overdueAmount = categorizedFees.overdue.reduce((sum, fee) => {
        const correctAmount = getCorrectFeeAmount(fee);
        return sum + (correctAmount - (fee.paidAmount || 0));
      }, 0);
      breakdown.push({
        category: 'Overdue',
        amount: overdueAmount,
        details: `${categorizedFees.overdue.length} fee(s)`,
        color: theme.error
      });
    }

    // Add unpaid fees
    if (categorizedFees.unpaid.length > 0) {
      const unpaidAmount = categorizedFees.unpaid.reduce((sum, fee) => {
        const correctAmount = getCorrectFeeAmount(fee);
        return sum + (correctAmount - (fee.paidAmount || 0));
      }, 0);
      breakdown.push({
        category: 'Unpaid',
        amount: unpaidAmount,
        details: `${categorizedFees.unpaid.length} fee(s)`,
        color: theme.primary
      });
    }

    // Add partial fees with detailed breakdown
    if (categorizedFees.partial.length > 0) {
      categorizedFees.partial.forEach(fee => {
        const totalAmount = getCorrectFeeAmount(fee);
        const paidAmount = fee.paidAmount || 0;
        const remainingAmount = totalAmount - paidAmount;
        
        breakdown.push({
          category: 'Partial',
          amount: remainingAmount,
          details: `₹${paidAmount.toLocaleString()} paid of ₹${totalAmount.toLocaleString()}`,
          color: theme.warning
        });
      });
    }

    return breakdown;
  }, [fees, getCorrectFeeAmount, categorizeFee, theme]);

  const isValidParentEmail = useCallback((value?: string | null) => {
    const v = (value || '').trim();
    if (!v) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }, []);

  const canSendToStudent = useCallback((student: Student, type: string) => {

    switch (type) {
      case 'email':
        return isValidParentEmail(student.parentEmail);
      case 'sms':
      case 'voice':
        return !!(student.parentContact || student.parentPhone);
      case 'whatsapp':
        return !!student.parentWhatsApp;
      default:
        return false;
    }
  }, [isValidParentEmail]);

  const displayedStudents = useMemo(() => {
    if (!sendabilityQuickFilter) {
      return filteredStudents;
    }

    // Sendability shortcuts are scoped to planned reminders from selected students.
    if (selectedStudents.size === 0) {
      return filteredStudents;
    }

    const selectedTypes = Array.from(reminderTypes).filter(
      (t): t is 'email' | 'sms' | 'whatsapp' | 'voice' => t === 'email' || t === 'sms' || t === 'whatsapp' || t === 'voice',
    );
    if (!selectedTypes.length) {
      return filteredStudents;
    }

    if (sendabilityQuickFilter === 'custom-empty') {
      const globalCustomEmpty = useCustomMessage
        ? selectedLanguage === 'both'
          ? !(customMessageEnglish || '').trim() && !(customMessageHindi || '').trim()
          : !customMessage.trim()
        : false;
      if (!globalCustomEmpty) {
        return filteredStudents;
      }
      return filteredStudents.filter((student) => selectedStudents.has(student.id));
    }

    if (sendabilityQuickFilter === 'disabled-channel') {
      const hasDisabledSelectedChannel = selectedTypes.some((type) => {
        if (type === 'email') return !enabledChannels.email;
        if (type === 'sms') return !enabledChannels.sms;
        if (type === 'whatsapp') return !enabledChannels.whatsapp;
        return !enabledChannels.voice;
      });
      if (!hasDisabledSelectedChannel) {
        return filteredStudents;
      }
      return filteredStudents.filter((student) => selectedStudents.has(student.id));
    }

    if (sendabilityQuickFilter === 'missing-email') {
      return filteredStudents.filter((student) => {
        if (!selectedStudents.has(student.id)) return false;
        const emailSelectedAndEnabled = selectedTypes.includes('email') && enabledChannels.email;
        if (!emailSelectedAndEnabled) return false;
        return !(student.parentEmail || '').trim();
      });
    }

    if (sendabilityQuickFilter === 'invalid-email') {
      return filteredStudents.filter((student) => {
        if (!selectedStudents.has(student.id)) return false;
        const emailSelectedAndEnabled = selectedTypes.includes('email') && enabledChannels.email;
        if (!emailSelectedAndEnabled) return false;
        const trimmedEmail = (student.parentEmail || '').trim();
        return !!trimmedEmail && !isValidParentEmail(trimmedEmail);
      });
    }

    if (sendabilityQuickFilter === 'missing-phone') {
      return filteredStudents.filter((student) => {
        if (!selectedStudents.has(student.id)) return false;
        const phoneChannelSelectedAndEnabled =
          (selectedTypes.includes('sms') && enabledChannels.sms) ||
          (selectedTypes.includes('voice') && enabledChannels.voice);
        if (!phoneChannelSelectedAndEnabled) return false;
        return !(student.parentContact || student.parentPhone);
      });
    }

    if (sendabilityQuickFilter === 'missing-whatsapp') {
      return filteredStudents.filter((student) => {
        if (!selectedStudents.has(student.id)) return false;
        const whatsappSelectedAndEnabled = selectedTypes.includes('whatsapp') && enabledChannels.whatsapp;
        if (!whatsappSelectedAndEnabled) return false;
        return !student.parentWhatsApp;
      });
    }

    return filteredStudents;
  }, [
    sendabilityQuickFilter,
    filteredStudents,
    reminderTypes,
    selectedStudents,
    useCustomMessage,
    selectedLanguage,
    customMessage,
    customMessageEnglish,
    customMessageHindi,
    enabledChannels.email,
    enabledChannels.sms,
    enabledChannels.whatsapp,
    enabledChannels.voice,
    canSendToStudent,
    isValidParentEmail,
  ]);

  // PERF (P15): precompute each displayed student's fee summary once per render
  // (memoized on the inputs that actually affect it) instead of running two
  // `fees.filter(...)` passes per row inside the roster `.map` — which re-ran the
  // O(students × fees) scan on every unrelated re-render (selecting a student,
  // opening a modal, typing a custom message).
  const feeInfoByStudentId = useMemo(() => {
    const map = new Map<
      string,
      { feeInfo: ReturnType<typeof getStudentFeeInfo>; detailedFeeInfo: ReturnType<typeof getDetailedFeeInfo> }
    >();
    for (const student of displayedStudents) {
      map.set(student.id, {
        feeInfo: getStudentFeeInfo(student),
        detailedFeeInfo: getDetailedFeeInfo(student),
      });
    }
    return map;
  }, [displayedStudents, getStudentFeeInfo, getDetailedFeeInfo]);

  // Utility function to normalize phone numbers
  const normalizePhoneNumber = useCallback((phone: string): string => {
    if (!phone) return '';
    
    // Remove all non-digit characters
    const digitsOnly = phone.replace(/\D/g, '');
    
    // If it starts with 91, add +
    if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
      return `+${digitsOnly}`;
    }
    
    // If it's 10 digits, add +91
    if (digitsOnly.length === 10) {
      return `+91${digitsOnly}`;
    }
    
    // If it already has + at the beginning, return as is
    if (phone.startsWith('+')) {
      return phone;
    }
    
    // For other cases, return with +91 prefix
    return `+91${digitsOnly}`;
  }, []);

  // Get normalized parent contact for sending
  const getParentContact = useCallback((student: Student): string => {
    const contact = student.parentContact || student.parentPhone || '';
    return normalizePhoneNumber(contact);
  }, [normalizePhoneNumber]);

  const getDefaultMessage = useCallback((student: Student) => {
    const feeInfo = getStudentFeeInfo(student);
    // Helper to format due date (short month form) without heavy localization
    const formatDueDate = (raw: string) => {
      try {
        const d = new Date(raw);
        if (isNaN(d.getTime())) return raw;
        return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      } catch { return raw; }
    };
    
    // Helper function to generate message in a specific language
    const structuredNotes = getStructuredCustomNotes();
    const mergedNotes = getCustomNotesForLanguage();
    const generateMessage = (lang: 'english' | 'hindi') => {
      let message = '';
      
      // Add greetings if enabled
      if (addGreetings) {
        if (useCustomGreetings) {
          // Use custom greetings
          if (lang === 'hindi' && customGreetingsHindi.trim()) {
            message += customGreetingsHindi.trim() + ', ';
          } else if (lang === 'english' && customGreetingsEnglish.trim()) {
            message += customGreetingsEnglish.trim() + ', ';
          } else {
            // Fallback to default if custom greeting is empty
            message += lang === 'hindi' ? 'प्रिय अभिभावक, ' : 'Dear Parent, ';
          }
        } else {
          // Use default greetings
          message += lang === 'hindi' ? 'प्रिय अभिभावक, ' : 'Dear Parent, ';
        }
      } else {
        message += lang === 'hindi' ? 'प्रिय अभिभावक, ' : 'Dear Parent, ';
      }
      
      // Main message content
      if (feeInfo.totalDue > 0) {
        const dueDateFormatted = formatDueDate(feeInfo.earliestDueDate);
        if (lang === 'hindi') {
          message += `यह एक अनुस्मारक है कि ${student.name} की ट्यूशन फीस ₹${feeInfo.totalDue.toLocaleString()} देय है जिसकी अंतिम तिथि ${dueDateFormatted} है। कृपया अपनी सुविधा के अनुसार भुगतान करें। धन्यवाद!`;
        } else {
          message += `this is a reminder that ${student.name}'s tuition fee of ₹${feeInfo.totalDue.toLocaleString()} is due on ${dueDateFormatted}. Please make the payment at your earliest convenience. Thank you!`;
        }
      } else {
        if (lang === 'hindi') {
          message += `यह ${student.name} की ट्यूशन के संबंध में एक अनुस्मारक है। किसी भी प्रश्न के लिए कृपया हमसे संपर्क करें। धन्यवाद!`;
        } else {
          message += `this is a reminder regarding ${student.name}'s tuition. Please contact us for any queries. Thank you!`;
        }
      }
      
      // Insert additional note AFTER body and BEFORE teacher/coaching
      if (selectedLanguage === 'both') {
        if (structuredNotes) {
          if (lang === 'english' && 'english' in structuredNotes && structuredNotes.english?.trim()) {
            message += `\n\nAdditional note: ${structuredNotes.english.trim()}`;
          } else if (lang === 'hindi' && 'hindi' in structuredNotes && structuredNotes.hindi?.trim()) {
            message += `\n\nअतिरिक्त नोट: ${structuredNotes.hindi.trim()}`;
          }
        } else if (mergedNotes) {
          if (lang === 'english') message += `\n\nAdditional note: ${mergedNotes}`; // fallback only in first (english) block
        }
      } else if (mergedNotes) {
        if (lang === 'hindi') message += `\n\nअतिरिक्त नोट: ${mergedNotes}`; else message += `\n\nAdditional note: ${mergedNotes}`;
      }

      // Add teacher name (always include if available)
      if (resolvedTeacherName) {
        if (lang === 'hindi') {
          message += `\n\nशिक्षक: ${resolvedTeacherName}`;
        } else {
          message += `\n\nTeacher: ${resolvedTeacherName}`;
        }
      }
      
      // Add coaching name (always)
      if (resolvedCoachingName) {
        message += `\n\n${resolvedCoachingName}`;
      }
      
      return message;
    };
    
    // Generate combined output (notes already inserted per block)
    let finalMessage = '';
    if (selectedLanguage === 'both') {
      const englishMessage = generateMessage('english');
      const hindiMessage = generateMessage('hindi');
      finalMessage = languageOrder === 'english-first'
        ? englishMessage + '\n\n' + hindiMessage
        : hindiMessage + '\n\n' + englishMessage;
    } else {
      finalMessage = generateMessage(selectedLanguage);
    }
    return finalMessage;
  }, [getStudentFeeInfo, getCustomNotesForLanguage, getStructuredCustomNotes, addGreetings, useCustomGreetings, customGreetingsEnglish, customGreetingsHindi, selectedLanguage, languageOrder, resolvedTeacherName, resolvedCoachingName]);

  const getVoiceMessage = useCallback((student: Student) => {
    const feeInfo = getStudentFeeInfo(student);
    const formatDueDate = (raw: string) => {
      try {
        const d = new Date(raw);
        if (isNaN(d.getTime())) return raw;
        return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      } catch { return raw; }
    };
    
    // Helper function to generate voice message in a specific language
    const generateVoiceMessage = (lang: 'english' | 'hindi') => {
      let message = '';
      const defaultGreeting = () => {
        // Always use parent salutation now for both custom and non-custom
  return lang === 'hindi' ? 'प्रिय अभिभावक, ' : 'Dear parent, ';
      };
      // Add greetings if enabled
      if (addGreetings) {
        if (useCustomGreetings) {
          if (lang === 'hindi' && customGreetingsHindi.trim()) {
            message += customGreetingsHindi.trim() + ', ';
          } else if (lang === 'english' && customGreetingsEnglish.trim()) {
            message += customGreetingsEnglish.trim() + ', ';
          } else {
            message += defaultGreeting();
          }
        } else {
          message += defaultGreeting();
        }
      } else {
        message += defaultGreeting();
      }
      
      // Main message content
      if (feeInfo.totalDue > 0) {
        const dueDateFormatted = formatDueDate(feeInfo.earliestDueDate);
        if (lang === 'hindi') {
          message += `यह एक अनुस्मारक है कि ${student.name} की ट्यूशन फीस ${feeInfo.totalDue} रुपये देय है जिसकी अंतिम तिथि ${dueDateFormatted} है। कृपया अपनी सुविधा के अनुसार भुगतान करें। धन्यवाद।`;
        } else {
          message += `this is a reminder that ${student.name}'s tuition fee of rupees ${feeInfo.totalDue} is due on ${dueDateFormatted}. Please make the payment at your earliest convenience. Thank you.`;
        }
      } else {
        if (lang === 'hindi') {
          message += `यह ${student.name} की ट्यूशन के संबंध में एक अनुस्मारक है। किसी भी प्रश्न के लिए कृपया हमसे संपर्क करें। धन्यवाद।`;
        } else {
          message += `this is a reminder regarding ${student.name}'s tuition. Please contact us for any queries. Thank you.`;
        }
      }
      
      // Add teacher name (always include if available)
      if (resolvedTeacherName) {
        if (lang === 'hindi') {
          message += ` शिक्षक ${resolvedTeacherName} की ओर से।`;
        } else {
          message += ` From teacher ${resolvedTeacherName}.`;
        }
      }
      
      // Add coaching name (always)
      if (resolvedCoachingName) {
        if (lang === 'hindi') {
          message += ` ${resolvedCoachingName} की ओर से।`;
        } else {
          message += ` From ${resolvedCoachingName}.`;
        }
      }
      
      return message;
    };
    
    // Build base (including custom notes if any) then append day wish when using custom message mode
    let finalMessage = '';
    if (selectedLanguage === 'both') {
      const hindiMessage = generateVoiceMessage('hindi');
      const englishMessage = generateVoiceMessage('english');
      finalMessage = languageOrder === 'english-first'
        ? englishMessage + '\n\n' + hindiMessage
        : hindiMessage + '\n\n' + englishMessage;
    } else {
      finalMessage = generateVoiceMessage(selectedLanguage);
    }

    const customNotesText = getCustomNotesForLanguage();
    if (customNotesText) finalMessage += ` Additional note: ${customNotesText}`;

    // Append "Have a nice day" (and Hindi equivalent) only for custom message mode so default template style unchanged
    if (useCustomMessage) {
      if (selectedLanguage === 'both') {
        const wishEn = 'Have a nice day!';
        const wishHi = 'आपका दिन शुभ हो!';
        finalMessage += languageOrder === 'english-first'
          ? `\n${wishEn}\n${wishHi}`
          : `\n${wishHi}\n${wishEn}`;
      } else if (selectedLanguage === 'hindi') {
        finalMessage += '\nआपका दिन शुभ हो!';
      } else {
        finalMessage += '\nHave a nice day!';
      }
    }
    return finalMessage;
  }, [getStudentFeeInfo, getCustomNotesForLanguage, addGreetings, useCustomGreetings, customGreetingsEnglish, customGreetingsHindi, selectedLanguage, languageOrder, englishVoice, hindiVoice, resolvedTeacherName, resolvedCoachingName, useCustomMessage]);

  const handleSelectAll = useCallback(() => {
    if (displayedStudents.length > 0 && displayedStudents.every((s) => selectedStudents.has(s.id))) {
      setSelectedStudents(new Set());
    } else {
      setSelectedStudents(new Set(displayedStudents.map((s) => s.id)));
    }
  }, [selectedStudents, displayedStudents]);

  const handleSelectStudent = useCallback((studentId: string) => {
    const newSelected = new Set(selectedStudents);
    if (newSelected.has(studentId)) {
      newSelected.delete(studentId);
    } else {
      newSelected.add(studentId);
    }
    setSelectedStudents(newSelected);
  }, [selectedStudents]);

  const handleReminderTypeToggle = useCallback((typeId: string) => {
    if (
      (typeId === 'email' && !enabledChannels.email) ||
      (typeId === 'sms' && !enabledChannels.sms) ||
      (typeId === 'whatsapp' && !enabledChannels.whatsapp) ||
      (typeId === 'voice' && !enabledChannels.voice)
    ) {
      const msg =
        (typeId === 'email' && effectiveChannelMessages.email) ||
        (typeId === 'sms' && effectiveChannelMessages.sms) ||
        (typeId === 'whatsapp' && effectiveChannelMessages.whatsapp) ||
        (typeId === 'voice' && effectiveChannelMessages.voice) ||
        '';
      Alert.alert(
        'Channel Disabled',
        msg || 'This reminder channel has been disabled by an admin for your coaching center.',
      );
      return;
    }
    const newTypes = new Set(reminderTypes);
    if (newTypes.has(typeId)) {
      newTypes.delete(typeId);
    } else {
      newTypes.add(typeId);
    }
    setReminderTypes(newTypes);
  }, [reminderTypes, enabledChannels, effectiveChannelMessages]);

  // When turning off custom message, clear any prior selection (to avoid selecting students without pending fees)
  const handleCustomMessageToggle = useCallback((value: boolean) => {
    setUseCustomMessage(value);
    if (!value) {
      // Clearing selection as requested
      setSelectedStudents(new Set());
    }
  }, []);

  const handleCancel = useCallback(() => {
    // Reset all form states to initial values immediately without confirmation
    setSelectedStudents(new Set());
    setReminderTypes(new Set(['email']));
    setCustomMessage('');
    setCustomMessageHindi('');
    setCustomMessageEnglish('');
    setUseCustomMessage(false);
    setCustomNotes('');
    setCustomNotesHindi('');
    setCustomNotesEnglish('');
    setUseCustomNotes(false);
    setSendabilityQuickFilter(null);
    setSendStatuses([]);
    setPreviewStudentIndex(0);
  }, [selectedStudents.size, reminderTypes, useCustomMessage, customMessage, customMessageHindi, customMessageEnglish, useCustomNotes, customNotes, customNotesHindi, customNotesEnglish]);

  const validateSending = useCallback(() => {
    if (!anyReminderChannelEnabled) {
      const pieces: string[] = [];
      if (effectiveChannelMessages.email) pieces.push(`Email: ${effectiveChannelMessages.email}`);
      if (effectiveChannelMessages.sms) pieces.push(`SMS: ${effectiveChannelMessages.sms}`);
      if (effectiveChannelMessages.whatsapp) pieces.push(`WhatsApp: ${effectiveChannelMessages.whatsapp}`);
      if (effectiveChannelMessages.voice) pieces.push(`Voice: ${effectiveChannelMessages.voice}`);
      Alert.alert(
        'Reminders Disabled',
        pieces.length
          ? `All reminder channels are currently disabled.\n\n${pieces.join('\n')}`
          : 'All reminder channels are currently disabled for your coaching center.',
      );
      return false;
    }

    if (selectedStudents.size === 0) {
      Alert.alert('No Students Selected', 'Please select at least one student to send reminders to.');
      return false;
    }
    
    if (reminderTypes.size === 0) {
      Alert.alert('No Reminder Type Selected', 'Please select at least one reminder type.');
      return false;
    }

    const disabledSelected: string[] = [];
    if (reminderTypes.has('email') && !enabledChannels.email) disabledSelected.push('Email');
    if (reminderTypes.has('sms') && !enabledChannels.sms) disabledSelected.push('SMS');
    if (reminderTypes.has('whatsapp') && !enabledChannels.whatsapp) disabledSelected.push('WhatsApp');
    if (reminderTypes.has('voice') && !enabledChannels.voice) disabledSelected.push('Voice');
    if (disabledSelected.length) {
      const reasonLines: string[] = [];
      if (reminderTypes.has('email') && !enabledChannels.email && effectiveChannelMessages.email) {
        reasonLines.push(`Email: ${effectiveChannelMessages.email}`);
      }
      if (reminderTypes.has('sms') && !enabledChannels.sms && effectiveChannelMessages.sms) {
        reasonLines.push(`SMS: ${effectiveChannelMessages.sms}`);
      }
      if (reminderTypes.has('whatsapp') && !enabledChannels.whatsapp && effectiveChannelMessages.whatsapp) {
        reasonLines.push(`WhatsApp: ${effectiveChannelMessages.whatsapp}`);
      }
      if (reminderTypes.has('voice') && !enabledChannels.voice && effectiveChannelMessages.voice) {
        reasonLines.push(`Voice: ${effectiveChannelMessages.voice}`);
      }
      Alert.alert(
        'Channel Disabled',
        reasonLines.length
          ? `These channels are disabled: ${disabledSelected.join(', ')}.\n\n${reasonLines.join('\n')}`
          : `These channels are disabled by admin settings: ${disabledSelected.join(', ')}. Please deselect them.`
      );
      return false;
    }

    return true;
  }, [anyReminderChannelEnabled, selectedStudents, reminderTypes, enabledChannels, effectiveChannelMessages]);

  const computePlannedReminderNeeds = useCallback(() => {
    const selectedStudentObjects = students.filter(s => selectedStudents.has(s.id));
    const needs: Record<'email' | 'sms' | 'whatsapp' | 'voice', number> = {
      email: 0,
      sms: 0,
      whatsapp: 0,
      voice: 0,
    };

    // Mirror the existing send loop behavior: if custom message is enabled but empty,
    // reminders are skipped (no backend call, so no quota needed).
    let customContentEmpty = false;
    if (useCustomMessage) {
      if (selectedLanguage === 'both') {
        const en = (customMessageEnglish || '').trim();
        const hi = (customMessageHindi || '').trim();
        customContentEmpty = !en && !hi;
      } else {
        customContentEmpty = !customMessage.trim();
      }
    }

    for (const student of selectedStudentObjects) {
      for (const type of reminderTypes) {
        if (type !== 'email' && type !== 'sms' && type !== 'whatsapp' && type !== 'voice') continue;
        if (!canSendToStudent(student, type)) continue;
        if (useCustomMessage && customContentEmpty) continue;
        needs[type]++;
      }
    }

    return {
      selectedStudentObjects,
      needs,
      customContentEmpty,
    };
  }, [students, selectedStudents, reminderTypes, canSendToStudent, useCustomMessage, selectedLanguage, customMessage, customMessageEnglish, customMessageHindi]);

  const runQuotaPreflightOrShowModal = useCallback(() => {
    // Best-effort client-side preflight.
    // If we don't have a usage snapshot, allow proceeding and rely on server-side reservation.
    if (usageSummaryLoading || usageSummaryError || !usageSummary) {
      return true;
    }

    const { needs } = computePlannedReminderNeeds();
    const typeLabels: Record<'email' | 'sms' | 'whatsapp' | 'voice', string> = {
      email: 'Email',
      sms: 'SMS',
      whatsapp: 'WhatsApp',
      voice: 'Voice',
    };

    const selectedTypes = Array.from(reminderTypes).filter(
      (t): t is 'email' | 'sms' | 'whatsapp' | 'voice' => t === 'email' || t === 'sms' || t === 'whatsapp' || t === 'voice',
    );

    const lines = selectedTypes.map((type) => {
      const limitRaw = reminderLimitByType[type];
      const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? limitRaw : 0;
      const used = reminderEffectiveUsedByType[type];
      const hasFiniteLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
      const remaining = hasFiniteLimit ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY;
      return {
        type,
        label: typeLabels[type],
        needed: needs[type],
        remaining,
        used,
        limit,
      };
    });

    const insufficient = lines.filter((l) => Number.isFinite(l.remaining) && l.needed > l.remaining);
    if (insufficient.length > 0) {
      setQuotaBlockData({
        kind: 'quota',
        title: 'Not enough reminder quota',
        description:
          'This send would exceed your remaining monthly limits. To prevent partial sending, please reduce selected students or disable the channels that are over quota.',
        lines,
        selectedStudents: selectedStudents.size,
      });
      setShowQuotaBlockModal(true);
      return false;
    }

    return true;
  }, [usageSummaryLoading, usageSummaryError, usageSummary, computePlannedReminderNeeds, reminderLimitByType, reminderEffectiveUsedByType, reminderTypes, selectedStudents.size]);

  const sendabilitySummary = useMemo(() => {
    if (selectedStudents.size === 0 || reminderTypes.size === 0) {
      return null;
    }

    const selectedStudentObjects = students.filter((s) => selectedStudents.has(s.id));
    const selectedTypes = Array.from(reminderTypes);

    const globalCustomEmpty = useCustomMessage
      ? selectedLanguage === 'both'
        ? !(customMessageEnglish || '').trim() && !(customMessageHindi || '').trim()
        : !customMessage.trim()
      : false;

    let valid = 0;
    let blockedMissingEmail = 0;
    let blockedInvalidEmail = 0;
    let blockedMissingPhone = 0;
    let blockedMissingWhatsApp = 0;
    let blockedCustomEmpty = 0;
    let blockedDisabledChannel = 0;
    let blockedUnsupported = 0;

    for (const student of selectedStudentObjects) {
      for (const type of selectedTypes) {
        const supported = type === 'email' || type === 'sms' || type === 'whatsapp' || type === 'voice';
        if (!supported) {
          blockedUnsupported += 1;
          continue;
        }

        const channelEnabled =
          (type === 'email' && enabledChannels.email) ||
          (type === 'sms' && enabledChannels.sms) ||
          (type === 'whatsapp' && enabledChannels.whatsapp) ||
          (type === 'voice' && enabledChannels.voice);
        if (!channelEnabled) {
          blockedDisabledChannel += 1;
          continue;
        }

        if (type === 'email') {
          const trimmedEmail = (student.parentEmail || '').trim();
          if (!trimmedEmail) {
            blockedMissingEmail += 1;
            continue;
          }
          if (!isValidParentEmail(trimmedEmail)) {
            blockedInvalidEmail += 1;
            continue;
          }
        }

        if ((type === 'sms' || type === 'voice') && !(student.parentContact || student.parentPhone)) {
          blockedMissingPhone += 1;
          continue;
        }

        if (type === 'whatsapp' && !student.parentWhatsApp) {
          blockedMissingWhatsApp += 1;
          continue;
        }

        if (useCustomMessage && globalCustomEmpty) {
          blockedCustomEmpty += 1;
          continue;
        }

        valid += 1;
      }
    }

    const blockedNoContact =
      blockedMissingEmail + blockedInvalidEmail + blockedMissingPhone + blockedMissingWhatsApp;

    const totalPlanned =
      valid + blockedNoContact + blockedCustomEmpty + blockedDisabledChannel + blockedUnsupported;

    return {
      totalPlanned,
      valid,
      blockedNoContact,
      blockedMissingEmail,
      blockedInvalidEmail,
      blockedMissingPhone,
      blockedMissingWhatsApp,
      blockedCustomEmpty,
      blockedDisabledChannel,
      blockedUnsupported,
    };
  }, [
    selectedStudents,
    reminderTypes,
    students,
    useCustomMessage,
    selectedLanguage,
    customMessage,
    customMessageEnglish,
    customMessageHindi,
    enabledChannels.email,
    enabledChannels.sms,
    enabledChannels.whatsapp,
    enabledChannels.voice,
    canSendToStudent,
    isValidParentEmail,
  ]);

  useEffect(() => {
    if (!sendabilityQuickFilter) return;

    if (!sendabilitySummary) {
      setSendabilityQuickFilter(null);
      return;
    }

    if (sendabilityQuickFilter === 'missing-email' && sendabilitySummary.blockedMissingEmail === 0) {
      setSendabilityQuickFilter(null);
      return;
    }
    if (sendabilityQuickFilter === 'invalid-email' && sendabilitySummary.blockedInvalidEmail === 0) {
      setSendabilityQuickFilter(null);
      return;
    }
    if (sendabilityQuickFilter === 'missing-phone' && sendabilitySummary.blockedMissingPhone === 0) {
      setSendabilityQuickFilter(null);
      return;
    }
    if (sendabilityQuickFilter === 'missing-whatsapp' && sendabilitySummary.blockedMissingWhatsApp === 0) {
      setSendabilityQuickFilter(null);
      return;
    }
    if (sendabilityQuickFilter === 'custom-empty' && sendabilitySummary.blockedCustomEmpty === 0) {
      setSendabilityQuickFilter(null);
      return;
    }
    if (sendabilityQuickFilter === 'disabled-channel' && sendabilitySummary.blockedDisabledChannel === 0) {
      setSendabilityQuickFilter(null);
    }
  }, [sendabilityQuickFilter, sendabilitySummary]);

  const humanizeSendErrorMessage = useCallback((raw?: string): string => {
    const code = (raw || '').trim();
    if (!code) return 'Failed to send';

    const lower = code.toLowerCase();
    if (lower.includes('twilio') && (lower.includes('credit') || lower.includes('balance') || lower.includes('funds'))) {
      return 'Insufficient Twilio credits. Please contact support.';
    }
    if (lower.includes('insufficient') && (lower.includes('credit') || lower.includes('balance') || lower.includes('funds'))) {
      return 'Insufficient provider credits. Please contact support.';
    }
    if (lower.includes('missing_fields') || lower.includes('validation_failed')) {
      return 'Some required reminder details are missing. Please review the selected channels and contacts.';
    }
    if (lower.includes('reminder_limit_reached')) {
      return 'Monthly reminder limit reached for one or more selected channels.';
    }
    if (lower.includes('reminder_quota_reservation_missing')) {
      return 'Reminder quota reservation was not found. Please retry the batch.';
    }
    if (lower.includes('reminder_quota_reservation_expired')) {
      return 'Reminder quota reservation expired. Please retry sending.';
    }
    if (lower.includes('reminder_quota_reservation_exhausted')) {
      return 'No reserved reminder quota is left for this batch. Please retry.';
    }
    if (lower.includes('email_backend_not_configured')) {
      return 'Email backend is not configured right now.';
    }
    if (lower.includes('email_send_failed')) {
      return 'Email sending failed. Please try again in a moment.';
    }
    if (lower.includes('send_failed')) {
      return 'Provider send failed. Please try again.';
    }
    return code.replace(/_/g, ' ');
  }, []);

  const getBatchSendErrorUi = useCallback(
    (error: unknown): { title: string; message: string } => {
      if (error instanceof ReminderBatchSendError) {
        if (error.code === 'validation_failed') {
          const issues = Array.isArray((error as any)?.details?.issues) ? (error as any).details.issues : [];
          const details = issues
            .slice(0, 3)
            .map((issue: any) => {
              const path = Array.isArray(issue?.path) ? issue.path.join('.') : '';
              const msg = typeof issue?.message === 'string' ? issue.message : 'Invalid value';
              if (path.includes('history.parentEmail')) {
                return 'Parent email is invalid. Update student email or deselect Email channel.';
              }
              if (path.includes('email.to_email')) {
                return 'Recipient email is invalid. Please correct the parent email.';
              }
              return path ? `${path}: ${msg}` : msg;
            })
            .join('\n');

          return {
            title: 'Invalid Reminder Payload',
            message: details
              ? `Some reminder details were invalid:\n${details}`
              : 'Some reminder details were invalid. Please review your selected channels and contacts.',
          };
        }

        return {
          title: 'Reminder Send Failed',
          message: humanizeSendErrorMessage(error.code),
        };
      }

      if (error instanceof Error) {
        const msg = error.message || '';
        if (msg.includes('At least one reminder item is required')) {
          return {
            title: 'Nothing To Send',
            message:
              'No valid reminders could be created for the selected students/channels. Check contact details and custom message content.',
          };
        }

        return {
          title: 'Reminder Send Failed',
          message: humanizeSendErrorMessage(msg),
        };
      }

      return {
        title: 'Reminder Send Failed',
        message: 'Unable to send reminders due to an unexpected error. Please try again.',
      };
    },
    [humanizeSendErrorMessage],
  );

  const sendReminders = useCallback(async () => {
    logger.debug('sendReminders function called');
    
    try {
      if (!validateSending()) {
        logger.debug('Validation failed');
        setIsSending(false);
        setShowStatusModal(false);
        return;
      }

      if (!user?.uid) {
        logger.error('User not authenticated');
        setIsSending(false);
        setShowStatusModal(false);
        return;
      }

      if (!tenantId) {
        Alert.alert('Select Coaching Center', 'Please select a coaching center before sending reminders.');
        setIsSending(false);
        setShowStatusModal(false);
        return;
      }

      logger.debug('Starting to send reminders...');
      setSendStatuses([]);
      setHistoryIdByKey(new Map());

      const selectedStudentObjects = students.filter(s => selectedStudents.has(s.id));
      logger.debug('Selected students:', selectedStudentObjects.length);

      // Generate unique batch ID
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const batchSettings = {
        useCustomMessage,
        useCustomNotes,
        language: selectedLanguage,
        coachingName: resolvedCoachingName,
        teacherName: resolvedTeacherName,
      };

      const makeHistoryId = (studentId: string, type: string) => {
        // Deterministic id for idempotency across retries/crashes.
        // Include tenantId to avoid cross-tenant collisions.
        const t = (tenantId || '').trim();
        return `${t}_${batchId}_${studentId}_${type}`;
      };

      const buildHistoryPayload = (student: Student, type: string, messageText: string) => {
        const feeInfo = getStudentFeeInfo(student);
        const rawParentEmail = (student.parentEmail || '').trim();
        const safeParentEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawParentEmail) ? rawParentEmail : undefined;
        return {
          tenantId,
          userId: user.uid,
          studentId: student.id,
          studentName: student.name,
          parentName: student.parentName || 'Parent',
          parentContact: getParentContact(student),
          parentEmail: safeParentEmail,
          reminderType: type,
          message: messageText,
          amount: feeInfo.totalDue,
          dueDate: feeInfo.earliestDueDate,
          feeCategories: feeInfo.fees.map((fee: FeeRecord) => `${fee.type} - ${fee.description || 'Fee'}`),
          settings: batchSettings,
          senderName: batchSettings.teacherName,
          batchId,
          metadata: { deliveryStatus: 'pending' },
        };
      };

      // Build batch items + initial statuses
      const initialStatuses: SendStatus[] = [];
      const batchItems: Record<string, any>[] = [];
      const historyIdMap = new Map<string, string>();

      const globalCustomEmpty = useCustomMessage
        ? selectedLanguage === 'both'
          ? !(customMessageEnglish || '').trim() && !(customMessageHindi || '').trim()
          : !customMessage.trim()
        : false;

      for (const student of selectedStudentObjects) {
        for (const type of reminderTypes) {
          if (!canSendToStudent(student, type)) {
            initialStatuses.push({ studentId: student.id, type, status: 'failed', message: `No parent ${type} contact available` });
            continue;
          }

          if (useCustomMessage && globalCustomEmpty) {
            initialStatuses.push({ studentId: student.id, type, status: 'skipped', message: 'skipped cuz message was empty' });
            continue;
          }

          if (type !== 'email' && type !== 'sms' && type !== 'whatsapp' && type !== 'voice') {
            initialStatuses.push({ studentId: student.id, type, status: 'failed', message: 'Unsupported reminder type' });
            continue;
          }

          const historyId = makeHistoryId(student.id, type);
          historyIdMap.set(`${student.id}_${type}`, historyId);

          if (type === 'email') {
            const feeInfo = getStudentFeeInfo(student);
            const coachingName = resolvedCoachingName;
            const validParentEmail = (student.parentEmail || '').trim();
            const safeParentEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(validParentEmail) ? validParentEmail : '';
            if (!safeParentEmail) {
              initialStatuses.push({ studentId: student.id, type, status: 'failed', message: 'Missing or invalid parent email' });
              continue;
            }

            if (useCustomMessage) {
              const englishFirst = languageOrder === 'english-first';
              const history = buildHistoryPayload(student, type, getCustomMessageForLanguage('email') || '');
              batchItems.push({
                type: 'email',
                studentId: student.id,
                historyId,
                history,
                email: {
                  template: 'custom_message_bilingual',
                  to_email: safeParentEmail,
                  to_name: student.parentName || 'Parent',
                  subject: `Message - ${student.parentName || 'Parent'}`,
                  student_name: student.name,
                  amount: feeInfo.totalDue.toString(),
                  due_date: feeInfo.earliestDueDate,
                  from_name: resolvedTeacherName || resolvedCoachingName || 'Tuition Management System',
                  teacher_email: user?.email || undefined,
                  coaching_name: coachingName,
                  show_coaching_name: true,
                  show_teacher_name: !!resolvedTeacherName,
                  teacher_name: resolvedTeacherName || '',
                  selectedLanguage,
                  languageOrder,
                  custom_message_english: customMessageEnglish || customMessage,
                  custom_message_hindi: customMessageHindi || customMessage,
                  english_first: englishFirst,
                  tenantId,
                },
              });
            } else {
              const message = getDefaultMessage(student);
              const history = buildHistoryPayload(student, type, message || '');
              batchItems.push({
                type: 'email',
                studentId: student.id,
                historyId,
                history,
                email: {
                  template: 'fee_reminder',
                  to_email: safeParentEmail,
                  to_name: student.parentName || 'Parent',
                  student_name: student.name,
                  amount: feeInfo.totalDue.toString(),
                  due_date: feeInfo.earliestDueDate,
                  teacher_name: resolvedTeacherName || '',
                  teacher_email: user?.email || undefined,
                  from_name: resolvedTeacherName || resolvedCoachingName || 'Tuition Management System',
                  coaching_name: coachingName,
                  show_coaching_name: true,
                  show_teacher_name: !!resolvedTeacherName,
                  custom_notes: undefined,
                  custom_message: undefined,
                  tenantId,
                },
              });
            }
          }

          if (type === 'sms') {
            const smsPhone = getParentContact(student);
            let finalSmsMessage = '';

            if (useCustomMessage) {
              const teacherLine = resolvedTeacherName || '-';
              const coachingLine = resolvedCoachingName || '-';
              if (selectedLanguage === 'both') {
                const enMsg = (customMessageEnglish || '').trim() || customMessage.trim();
                const hiMsg = (customMessageHindi || '').trim() || customMessage.trim();
                const buildBlock = (lang: 'english' | 'hindi', raw: string) => {
                  const greetingLine = lang === 'hindi' ? 'प्रिय अभिभावक' : 'Dear Parent';
                  const body = raw.trim();
                  const regardsWord = lang === 'hindi' ? 'सादर,' : 'Regards,';
                  const dayWish = lang === 'hindi' ? 'आपका दिन शुभ हो!' : 'Have a nice day!';
                  return `${greetingLine}\n${body}\n${regardsWord}\n${teacherLine}\n${coachingLine}\n${dayWish}`;
                };
                const englishBlock = buildBlock('english', enMsg || 'Dear');
                const hindiBlock = buildBlock('hindi', hiMsg || 'प्रिय');
                finalSmsMessage =
                  languageOrder === 'english-first'
                    ? `${englishBlock}\n\n${hindiBlock}`
                    : `${hindiBlock}\n\n${englishBlock}`;
              } else if (selectedLanguage === 'hindi') {
                const hiMsg = (customMessageHindi || '').trim() || customMessage.trim();
                finalSmsMessage = `प्रिय अभिभावक\n${hiMsg.trim() || 'प्रिय'}\nसादर,\n${teacherLine}\n${coachingLine}\nआपका दिन शुभ हो!`;
              } else {
                const enMsg = (customMessageEnglish || '').trim() || customMessage.trim();
                finalSmsMessage = `Dear Parent\n${enMsg.trim() || 'Dear'}\nRegards,\n${teacherLine}\n${coachingLine}\nHave a nice day!`;
              }
            } else {
              finalSmsMessage = getDefaultMessage(student);
            }

            const history = buildHistoryPayload(student, type, finalSmsMessage);
            batchItems.push({ type: 'sms', studentId: student.id, to: smsPhone, message: finalSmsMessage, historyId, history });
          }

          if (type === 'whatsapp') {
            const whatsappPhone = normalizePhoneNumber(student.parentWhatsApp!);
            const feeInfoForTemplate = getStudentFeeInfo(student);
            const coachingResolved = resolvedCoachingName || undefined;
            const teacherResolved = resolvedTeacherName || undefined;

            if (!useCustomMessage && feeInfoForTemplate && feeInfoForTemplate.totalDue > 0) {
              const customNotesText = getCustomNotesForLanguage();
              const greeting = addGreetings
                ? useCustomGreetings && customGreetingsEnglish.trim()
                  ? customGreetingsEnglish.trim()
                  : 'Dear'
                : 'Dear';
              const structuredNotes = getStructuredCustomNotes();
              const history = buildHistoryPayload(
                student,
                type,
                `Fee reminder: ₹${feeInfoForTemplate.totalDue.toLocaleString()} due on ${feeInfoForTemplate.earliestDueDate}`
              );
              batchItems.push({
                type: 'whatsapp',
                kind: 'fee',
                studentId: student.id,
                to: whatsappPhone,
                parentName: student.parentName,
                studentName: student.name,
                amount: feeInfoForTemplate.totalDue,
                dueDate: feeInfoForTemplate.earliestDueDate,
                greeting,
                customNotes: customNotesText || undefined,
                customNotesEnglish: structuredNotes && 'english' in structuredNotes ? structuredNotes.english : undefined,
                customNotesHindi: structuredNotes && 'hindi' in structuredNotes ? structuredNotes.hindi : undefined,
                teacherName: teacherResolved,
                coachingName: coachingResolved,
                selectedLanguage,
                languageOrder,
                historyId,
                history,
              });
            } else {
              const combinedMsg = useCustomMessage ? (getCustomMessageForLanguage('whatsapp') || '') : getDefaultMessage(student);
              const history = buildHistoryPayload(student, type, combinedMsg);
              batchItems.push({
                type: 'whatsapp',
                kind: 'custom',
                studentId: student.id,
                to: whatsappPhone,
                message: combinedMsg,
                englishMessage: selectedLanguage === 'both' ? (customMessageEnglish || '').trim() || undefined : undefined,
                hindiMessage: selectedLanguage === 'both' ? (customMessageHindi || '').trim() || undefined : undefined,
                teacherName: teacherResolved,
                coachingName: coachingResolved,
                selectedLanguage,
                languageOrder,
                historyId,
                history,
              });
            }
          }

          if (type === 'voice') {
            const voicePhone = getParentContact(student);
            const voiceLanguage = selectedLanguage;
            const baseVoiceMessage = useCustomMessage ? (getCustomMessageForLanguage('voice') || '') : getVoiceMessage(student);
            let finalVoiceMessage = baseVoiceMessage;

            if (!useCustomMessage) {
              if (selectedLanguage === 'both') {
                const wishEn = 'Have a nice day!';
                const wishHi = 'आपका दिन शुभ हो!';
                if (!finalVoiceMessage.includes(wishEn) && !finalVoiceMessage.includes(wishHi)) {
                  finalVoiceMessage += languageOrder === 'english-first' ? `\n${wishEn}\n${wishHi}` : `\n${wishHi}\n${wishEn}`;
                }
              } else if (selectedLanguage === 'hindi') {
                if (!finalVoiceMessage.includes('आपका दिन शुभ हो!')) finalVoiceMessage += '\nआपका दिन शुभ हो!';
              } else {
                if (!finalVoiceMessage.includes('Have a nice day!')) finalVoiceMessage += '\nHave a nice day!';
              }
            }

            if (useCustomMessage) {
              const teacherLine = resolvedTeacherName || '';
              const coachingLine = resolvedCoachingName || '';
              const buildGreeting = (lang: 'english' | 'hindi') => (lang === 'hindi' ? 'प्रिय अभिभावक,' : 'Dear parent,');
              const buildBlock = (lang: 'english' | 'hindi', raw: string) => {
                const trimmed = (raw || '').trim();
                if (!trimmed) return null;
                const thankYouLine =
                  lang === 'hindi'
                    ? `धन्यवाद।${teacherLine ? ` शिक्षक ${teacherLine} की ओर से।` : ''}${coachingLine ? ` ${coachingLine} की ओर से।` : ''}`
                    : `Thank you.${teacherLine ? ` From teacher ${teacherLine}.` : ''}${coachingLine ? ` From ${coachingLine}.` : ''}`;
                return [buildGreeting(lang), trimmed, thankYouLine].join('\n');
              };

              if (selectedLanguage === 'both') {
                const en = buildBlock('english', customMessageEnglish || customMessage);
                const hi = buildBlock('hindi', customMessageHindi || customMessage);
                const blocks: string[] = [];
                if (languageOrder === 'english-first') {
                  if (en) blocks.push(en);
                  if (hi) blocks.push(hi);
                } else {
                  if (hi) blocks.push(hi);
                  if (en) blocks.push(en);
                }
                finalVoiceMessage = blocks.join('\n\n');
                if (finalVoiceMessage) {
                  const hasEn = !!en;
                  const hasHi = !!hi;
                  if (hasEn && hasHi) finalVoiceMessage += `\n\nHave a nice day!\nआपका दिन शुभ हो!`;
                  else if (hasEn) finalVoiceMessage += `\n\nHave a nice day!`;
                  else if (hasHi) finalVoiceMessage += `\n\nआपका दिन शुभ हो!`;
                }
              } else if (selectedLanguage === 'hindi') {
                const hi = buildBlock('hindi', customMessageHindi || customMessage);
                finalVoiceMessage = hi ? `${hi}\n\nआपका दिन शुभ हो!` : '';
              } else {
                const en = buildBlock('english', customMessageEnglish || customMessage);
                finalVoiceMessage = en ? `${en}\n\nHave a nice day!` : '';
              }
            }

            const history = buildHistoryPayload(student, type, finalVoiceMessage);
            batchItems.push({
              type: 'voice',
              studentId: student.id,
              to: voicePhone,
              message: finalVoiceMessage,
              language: voiceLanguage,
              voice: voiceLanguage === 'hindi' ? hindiVoice : englishVoice,
              hindiVoice,
              englishVoice,
              historyId,
              history,
            });
          }

          initialStatuses.push({ studentId: student.id, type, status: 'pending' });
        }
      }

      setHistoryIdByKey(new Map(historyIdMap));

      setSendStatuses(initialStatuses);

      if (batchItems.length === 0) {
        setIsSending(false);
        const failedCount = initialStatuses.filter((s) => s.status === 'failed').length;
        const skippedCount = initialStatuses.filter((s) => s.status === 'skipped').length;
        const reasons = new Set(initialStatuses.map((s) => s.message).filter(Boolean) as string[]);
        const topReasons = Array.from(reasons).slice(0, 3).map((r) => `- ${humanizeSendErrorMessage(r)}`).join('\n');

        Alert.alert(
          'Nothing To Send',
          `${failedCount + skippedCount} reminder attempt(s) were filtered out before sending.${topReasons ? `\n\n${topReasons}` : ''}`,
        );
        return;
      }

      try {
        const resp = await usageAnalyticsService.sendReminderBatch(tenantId, batchId, batchItems);
        const byKey = new Map<string, (typeof resp.results)[number]>();
        resp.results.forEach((r) => byKey.set(`${r.studentId}_${r.type}`, r));

        setSendStatuses((prev) =>
          prev.map((s) => {
            const key = `${s.studentId}_${s.type}`;
            const r = byKey.get(key);
            if (!r) return s;
            if (s.status === 'skipped') return s;
            return {
              ...s,
              status: r.status,
              message:
                r.message
                  ? humanizeSendErrorMessage(r.message)
                  : r.status === 'success'
                    ? 'Sent successfully'
                    : r.status === 'queued'
                      ? 'Queued for send'
                      : 'Failed to send',
            };
          })
        );

        // Capture WhatsApp job ids for polling
        resp.results.forEach((r) => {
          if (r.type === 'whatsapp' && r.jobId) {
            setWaJobIds((prev) => new Map(prev).set(`${r.studentId}_whatsapp`, r.jobId!));
          }
        });

        await Promise.all([
          refreshUsageSummary().catch((e) => logger.warn('Usage summary refresh after batch send failed', e)),
          refreshReminderAlerts().catch((e) => logger.warn('Usage alert refresh after batch send failed', e)),
        ]);
      } catch (error) {
        logger.error('Batch send failed', error);
        setIsSending(false);
        setShowStatusModal(false);

        if (error instanceof ReminderBatchSendError) {
          if (error.code === 'reminder_channels_disabled') {
            const disabled = Array.isArray((error as any)?.details?.disabled)
              ? ((error as any).details.disabled as Array<'email' | 'sms' | 'whatsapp' | 'voice'>)
              : [];
            const labels: Record<'email' | 'sms' | 'whatsapp' | 'voice', string> = {
              email: 'Email',
              sms: 'SMS',
              whatsapp: 'WhatsApp',
              voice: 'Voice',
            };

            const channelMessages = ((error as any)?.details?.channelMessages ?? {}) as Partial<
              Record<'email' | 'sms' | 'whatsapp' | 'voice', string>
            >;

            const disabledLabels = disabled.map((k) => labels[k]).filter(Boolean);
            const reasonLines = disabled
              .map((k) => {
                const msg = (channelMessages as any)?.[k];
                const trimmed = typeof msg === 'string' ? msg.trim() : '';
                return trimmed ? `${labels[k]}: ${trimmed}` : '';
              })
              .filter(Boolean);

            setQuotaBlockData({
              kind: 'channels',
              title: 'Channel Disabled',
              description:
                disabledLabels.length || reasonLines.length
                  ? `This send was blocked because one or more reminder channels are disabled.\n\nDisabled: ${
                      disabledLabels.length ? disabledLabels.join(', ') : 'Unknown'
                    }${reasonLines.length ? `\n\n${reasonLines.join('\n')}` : ''}`
                  : 'This send was blocked because one or more reminder channels are disabled.',
              lines: [],
              selectedStudents: selectedStudents.size,
            });
            setShowQuotaBlockModal(true);
            return;
          }
          if (error.code === 'reminder_limit_reached') {
            const { needs } = computePlannedReminderNeeds();
            const selectedTypes = Array.from(reminderTypes).filter(
              (t): t is 'email' | 'sms' | 'whatsapp' | 'voice' =>
                t === 'email' || t === 'sms' || t === 'whatsapp' || t === 'voice',
            );

            const typeLabels: Record<'email' | 'sms' | 'whatsapp' | 'voice', string> = {
              email: 'Email',
              sms: 'SMS',
              whatsapp: 'WhatsApp',
              voice: 'Voice',
            };

            const lines = selectedTypes.map((type) => {
              const limitRaw = reminderLimitByType[type];
              const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? limitRaw : 0;
              const used = reminderEffectiveUsedByType[type];
              const hasFiniteLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
              const remaining = hasFiniteLimit ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY;
              return { type, label: typeLabels[type], needed: needs[type], remaining, used, limit };
            });

            setQuotaBlockData({
              kind: 'quota',
              title: 'Not enough reminder quota',
              description:
                'This send would exceed your remaining monthly limits (verified by server). To prevent partial sending, reduce selected students or disable the channels that are over quota.',
              lines,
              selectedStudents: selectedStudents.size,
            });
            setShowQuotaBlockModal(true);
            return;
          }
        }

        const ui = getBatchSendErrorUi(error);
        Alert.alert(ui.title, ui.message);
        return;
      }

      logger.debug('All reminders processed');
      setIsSending(false);
    } catch (error) {
      logger.error('Error in sendReminders:', error);
      setIsSending(false);
      setShowStatusModal(false);
      Alert.alert('Error', 'An unexpected error occurred while sending reminders.');
    }
  }, [
    selectedStudents,
    reminderTypes,
    students,
    useCustomMessage,
    getCustomMessageForLanguage,
    getCustomNotesForLanguage,
    validateSending,
    canSendToStudent,
    getDefaultMessage,
    getVoiceMessage,
    getStudentFeeInfo,
    user?.uid,
    selectedLanguage,
    useCustomNotes,
    resolvedCoachingName,
    resolvedTeacherName,
    tenantId,
    computePlannedReminderNeeds,
    reminderLimitByType,
    reminderEffectiveUsedByType,
    humanizeSendErrorMessage,
    getBatchSendErrorUi,
    refreshUsageSummary,
    refreshReminderAlerts,
  ]);

  const getStatusSummary = () => {
    const successful = sendStatuses.filter(s => s.status === 'success').length;
    const failed = sendStatuses.filter(s => s.status === 'failed').length;
    const pending = sendStatuses.filter(s => s.status === 'pending').length;
    const queued = sendStatuses.filter(s => s.status === 'queued').length;
  const skipped = sendStatuses.filter(s => s.status === 'skipped').length;
  return { successful, failed, pending, queued, skipped, total: sendStatuses.length };
  };

  // Safe early-return for offline gate after all hooks/effects
  if (showOfflineLoadingReminders) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={{ fontSize: 16, color: theme.textSecondary, marginTop: 16 }}>Loading reminders…</Text>
        {!!offlineHintReminders && (
          <Text style={{ fontSize: 14, color: theme.textSecondary, marginTop: 8 }}>{offlineHintReminders}</Text>
        )}
      </View>
    );
  }

  if (tenantLoading && !tenantId) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={{ fontSize: 16, color: theme.textSecondary, marginTop: 16 }}>Loading reminders…</Text>
      </View>
    );
  }

  if (tenantUnavailable) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <TenantSelectionEmptyState
          title="No coaching center selected"
          description="Choose a coaching center from Settings before sending reminders."
          primaryActionLabel="Open Settings"
          onPrimaryAction={() => router.push('/(tabs)/settings')}
        />
      </View>
    );
  }

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      paddingHorizontal: 20,
      paddingTop: 60,
      paddingBottom: 20,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerContent: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    headerButtons: {
      flexDirection: 'row',
      gap: 10,
    },
    settingsButton: {
      padding: 8,
      borderRadius: 8,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
    },
    title: {
      fontSize: 28,
      fontWeight: 'bold',
      color: theme.text,
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 16,
      color: theme.textSecondary,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.surface,
      borderRadius: 12,
      marginHorizontal: 20,
      marginVertical: 15,
      paddingHorizontal: 15,
      borderWidth: 1,
      borderColor: theme.border,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 12,
      color: theme.text,
      fontSize: 16,
    },
    filterContainer: {
      flexDirection: 'row',
      flexWrap: 'nowrap',
      paddingRight: 10,
    },
    filterScroll: {
      marginTop: 10,
    },
    filterButton: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1,
      minWidth: 72,
      alignItems: 'center',
      marginRight: 10,
    },
    filterButtonText: {
      fontSize: 13,
      fontWeight: '600',
    },
    section: {
      margin: 20,
      padding: 20,
      backgroundColor: theme.surface,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: theme.border,
    },
    sectionTitle: {
      fontSize: 18,
      fontWeight: 'bold',
      color: theme.text,
      marginBottom: 15,
    },
    reminderTypesGrid: {
      gap: 12,
    },
    reminderTypeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 15,
      borderRadius: 12,
      borderWidth: 2,
    },
    reminderTypeIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 15,
    },
    reminderTypeContent: {
      flex: 1,
    },
    reminderTypeName: {
      fontSize: 16,
      fontWeight: '600',
      marginBottom: 4,
    },
    reminderTypeDescription: {
      fontSize: 14,
      opacity: 0.7,
    },
    messageSection: {
      gap: 15,
    },
    customMessageToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    toggleLabel: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.text,
    },
    messageInput: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 12,
      padding: 15,
      color: theme.text,
      fontSize: 16,
      textAlignVertical: 'top',
      minHeight: 100,
      backgroundColor: theme.background,
    },
    studentsList: {
      gap: 10,
    },
    studentCard: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 15,
      borderRadius: 12,
      borderWidth: 1,
    },
    studentInfo: {
      flex: 1,
      marginLeft: 15,
    },
    studentName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.text,
    },
    studentDetails: {
      fontSize: 14,
      color: theme.textSecondary,
      marginTop: 4,
    },
    studentWarningRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 8,
    },
    studentWarningChip: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: `${theme.error}66`,
      backgroundColor: `${theme.error}1A`,
    },
    studentWarningText: {
      fontSize: 11,
      fontWeight: '700',
      color: theme.error,
      letterSpacing: 0.2,
      textTransform: 'uppercase',
    },
    feeInfo: {
      fontSize: 12,
      marginTop: 4,
      fontWeight: '600',
      lineHeight: 16,
    },
    availableTypes: {
      flexDirection: 'row',
      marginTop: 8,
      gap: 8,
    },
    typeIndicator: {
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    selectAllContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 15,
      paddingHorizontal: 5,
    },
    selectAllText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.text,
    },
    selectedCount: {
      fontSize: 14,
      color: theme.textSecondary,
    },
    sendButton: {
      margin: 20,
      marginTop: 5,
      padding: 18,
      borderRadius: 15,
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 10,
    },
    sendButtonText: {
      color: '#ffffff',
      fontSize: 16,
      fontWeight: 'bold',
    },
    previewButton: {
      margin: 20,
      marginTop: 0,
      marginBottom: 0,
      padding: 15,
      borderRadius: 12,
      alignItems: 'center',
      borderWidth: 2,
      borderColor: theme.primary,
    },
    previewButtonText: {
      color: theme.primary,
      fontSize: 16,
      fontWeight: '600',
    },
    cancelButton: {
      margin: 20,
      marginTop: 0,
      marginBottom: 0,
      padding: 15,
      borderRadius: 12,
      alignItems: 'center',
      borderWidth: 2,
      borderColor: theme.textSecondary,
      backgroundColor: theme.background,
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 8,
    },
    cancelButtonText: {
      color: theme.textSecondary,
      fontSize: 16,
      fontWeight: '600',
    },
    buttonContainer: {
      flexDirection: 'row',
      gap: 10,
      marginHorizontal: 20,
      marginBottom: 5,
    },
    buttonFlex: {
      flex: 1,
      margin: 0,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    statusModal: {
      backgroundColor: theme.surface,
      borderRadius: 15,
      padding: 20,
      margin: 20,
      maxHeight: '80%',
      width: '90%',
    },
    statusHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 20,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      paddingBottom: 15,
    },
    statusTitle: {
      fontSize: 18,
      fontWeight: 'bold',
      color: theme.text,
    },
    statusSummary: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      marginBottom: 20,
      padding: 15,
      backgroundColor: theme.background,
      borderRadius: 12,
    },
    summaryItem: {
      alignItems: 'center',
    },
    summaryNumber: {
      fontSize: 20,
      fontWeight: 'bold',
      marginBottom: 4,
    },
    summaryLabel: {
      fontSize: 12,
      color: theme.textSecondary,
    },
    statusItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 15,
      borderRadius: 8,
      marginBottom: 8,
    },
    statusBadge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      marginLeft: 10,
      alignSelf: 'flex-start',
    },
    statusBadgeText: {
      color: '#ffffff',
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    statusStudent: {
      flex: 1,
      marginLeft: 10,
    },
    statusStudentName: {
      fontSize: 14,
      fontWeight: '600',
    },
    statusType: {
      fontSize: 12,
      color: theme.textSecondary,
      marginTop: 2,
    },
    skippedBadge: {
      backgroundColor: '#f39c12',
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 12,
      marginLeft: 8,
      alignSelf: 'flex-start'
    },
    skippedBadgeText: {
      color: '#fff',
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.5,
      textTransform: 'uppercase'
    },
    closeButton: {
      padding: 5,
    },
    emptyState: {
      alignItems: 'center',
      padding: 40,
    },
    emptyStateText: {
      fontSize: 16,
      color: theme.textSecondary,
      textAlign: 'center',
      marginTop: 10,
    },
    navigationHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 15,
      paddingVertical: 12,
      backgroundColor: theme.background,
      borderRadius: 12,
      marginBottom: 15,
      borderWidth: 1,
      borderColor: theme.border,
    },
    navButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      gap: 6,
    },
    navButtonText: {
      fontSize: 14,
      fontWeight: '600',
    },
    studentCounter: {
      alignItems: 'center',
      paddingHorizontal: 20,
    },
    counterText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.text,
    },
    languageOptions: {
      gap: 12,
    },
    languageOption: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 15,
      borderRadius: 12,
      borderWidth: 2,
    },
  });

  if (studentsLoading || settingsLoading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.emptyStateText, { marginTop: 20 }]}>
          {studentsLoading ? 'Loading students...' : 'Loading settings...'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onTouchStart={(e) => e.stopPropagation()}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: theme.surface, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
        <View style={styles.headerContent}>
          <View>
            <Text allowFontScaling={false} style={styles.title}>Send Reminders</Text>
            {screenWidth > 600 && (
              <Text allowFontScaling={false} style={styles.subtitle}>Send fee reminders via multiple channels</Text>
            )}
          </View>
          <View style={styles.headerButtons}>
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={() => setShowHistoryModal(true)}
            >
              <History size={24} color={theme.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={() => setShowSettingsModal(true)}
            >
              <Settings size={24} color={theme.text} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {shouldShowUsageBanner && (
          <UsageAlertInlineBanner
            alert={resolvedUsageBannerAlert}
            totalAlerts={resolvedUsageBannerCount}
            loading={reminderUsageAlertLoading}
            error={reminderUsageAlertError}
            monthLabel={reminderUsageMonthId}
            onPress={() => router.push('/(tabs)/usage')}
            onRefresh={refreshReminderAlerts}
          />
        )}
  {/* ...search moved below, just before Students Selection... */}

        {/* Reminder Types */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Reminder Types</Text>
          <Text style={[styles.statusType, { marginTop: -8, marginBottom: 12 }]}>
            Total remaining: {reminderTotalRemaining ?? '—'} / {reminderTotalLimit ?? '—'} this month
          </Text>

          <View style={styles.reminderTypesGrid}>
            {visibleReminderTypeOptions.map((type) => {
              const typeId = type.id as 'email' | 'sms' | 'whatsapp' | 'voice';
              const channelEnabled =
                (typeId === 'email' && enabledChannels.email) ||
                (typeId === 'sms' && enabledChannels.sms) ||
                (typeId === 'whatsapp' && enabledChannels.whatsapp) ||
                (typeId === 'voice' && enabledChannels.voice);

              const limit = reminderLimitByType[typeId];
              const used = reminderUsedByType[typeId];
              const hasFiniteLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
              const remaining = hasFiniteLimit ? Math.max(0, limit - used) : null;

              return (
                <TouchableOpacity
                  key={type.id}
                  style={[
                    styles.reminderTypeCard,
                    {
                      opacity: channelEnabled ? 1 : 0.55,
                      backgroundColor: reminderTypes.has(type.id) ? `${type.color}15` : theme.background,
                      borderColor: reminderTypes.has(type.id) ? type.color : theme.border,
                    },
                  ]}
                  onPress={() => handleReminderTypeToggle(type.id)}
                >
                  <View style={[styles.reminderTypeIcon, { backgroundColor: type.color }]}>{type.icon}</View>
                  <View style={styles.reminderTypeContent}>
                    <Text
                      style={[
                        styles.reminderTypeName,
                        {
                          color: reminderTypes.has(type.id)
                            ? type.color
                            : channelEnabled
                              ? theme.text
                              : theme.textSecondary,
                        },
                      ]}
                    >
                      {type.name}
                    </Text>
                    <Text
                      style={[
                        styles.reminderTypeDescription,
                        {
                          color: reminderTypes.has(type.id)
                            ? type.color
                            : channelEnabled
                              ? theme.textSecondary
                              : theme.textSecondary,
                        },
                      ]}
                    >
                      {type.description}
                    </Text>

                    {channelEnabled ? (
                      <Text
                        style={[
                          styles.reminderTypeDescription,
                          { color: reminderTypes.has(type.id) ? type.color : theme.textSecondary, marginTop: 6 },
                        ]}
                      >
                        {hasFiniteLimit
                          ? `Available: ${remaining} / ${limit} this month`
                          : `Available: Unlimited this month`}
                      </Text>
                    ) : (
                      <Text
                        style={[
                          styles.reminderTypeDescription,
                          { color: theme.textSecondary, marginTop: 6 },
                        ]}
                      >
                        {(() => {
                          const msg = effectiveChannelMessages[typeId];
                          return msg ? msg : 'Disabled by admin settings';
                        })()}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Custom Message */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Message</Text>
          <View style={styles.messageSection}>
            <View style={styles.customMessageToggle}>
              <Text style={styles.toggleLabel}>Use custom message</Text>
              <Switch
                value={useCustomMessage}
                onValueChange={handleCustomMessageToggle}
                trackColor={{ false: theme.border, true: `${theme.primary}50` }}
                thumbColor={useCustomMessage ? theme.primary : theme.textSecondary}
              />
            </View>
            
            {useCustomMessage && (
              <View>
                {selectedLanguage === 'both' ? (
                  <View style={{ gap: 15, marginTop: 10 }}>
                    <View>
                      <Text style={[styles.toggleLabel, { marginBottom: 8, fontSize: 14 }]}>
                        Custom Message (English)
                      </Text>
                      <TextInput
                        style={styles.messageInput}
                        placeholder="Enter your custom reminder message in English..."
                        placeholderTextColor={theme.textSecondary}
                        value={customMessageEnglish}
                        onChangeText={setCustomMessageEnglish}
                        multiline
                        numberOfLines={4}
                      />
                    </View>
                    
                    <View>
                      <Text style={[styles.toggleLabel, { marginBottom: 8, fontSize: 14 }]}>
                        Custom Message (Hindi)
                      </Text>
                      <TextInput
                        style={styles.messageInput}
                        placeholder="अपना कस्टम रिमाइंडर मैसेज हिंदी में दर्ज करें..."
                        placeholderTextColor={theme.textSecondary}
                        value={customMessageHindi}
                        onChangeText={setCustomMessageHindi}
                        multiline
                        numberOfLines={4}
                      />
                    </View>
                    
                    <Text style={[styles.reminderTypeDescription, { fontSize: 12, color: theme.textSecondary, fontStyle: 'italic' }]}>
                      💡 Both messages will be used based on your language order preference
                    </Text>
                  </View>
                ) : (
                  <TextInput
                    style={styles.messageInput}
                    placeholder={
                      selectedLanguage === 'hindi' 
                        ? "अपना कस्टम रिमाइंडर मैसेज दर्ज करें..." 
                        : "Enter your custom reminder message..."
                    }
                    placeholderTextColor={theme.textSecondary}
                    value={customMessage}
                    onChangeText={setCustomMessage}
                    multiline
                    numberOfLines={4}
                  />
                )}
              </View>
            )}
          </View>
        </View>

        {/* Custom Notes */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Additional Notes</Text>
          <View style={styles.messageSection}>
            <View style={styles.customMessageToggle}>
              <Text style={[styles.toggleLabel, { opacity: useCustomMessage ? 0.5 : 1 }]}>Add custom notes to all reminders</Text>
              <Switch
                value={useCustomNotes}
                onValueChange={setUseCustomNotes}
                trackColor={{ false: theme.border, true: `${theme.primary}50` }}
                thumbColor={useCustomNotes ? theme.primary : theme.textSecondary}
                disabled={useCustomMessage}
              />
            </View>
            
            {useCustomNotes && !useCustomMessage && (
              <View>
                {selectedLanguage === 'both' ? (
                  <View style={{ gap: 15, marginTop: 10 }}>
                    <View>
                      <Text style={[styles.toggleLabel, { marginBottom: 8, fontSize: 14 }]}>
                        Additional Notes (English)
                      </Text>
                      <TextInput
                        style={styles.messageInput}
                        placeholder="Enter additional notes in English to be included in all reminder types..."
                        placeholderTextColor={theme.textSecondary}
                        value={customNotesEnglish}
                        onChangeText={setCustomNotesEnglish}
                        multiline
                        numberOfLines={3}
                      />
                    </View>
                    
                    <View>
                      <Text style={[styles.toggleLabel, { marginBottom: 8, fontSize: 14 }]}>
                        Additional Notes (Hindi)
                      </Text>
                      <TextInput
                        style={styles.messageInput}
                        placeholder="सभी रिमाइंडर प्रकारों में शामिल किए जाने वाले अतिरिक्त नोट्स हिंदी में दर्ज करें..."
                        placeholderTextColor={theme.textSecondary}
                        value={customNotesHindi}
                        onChangeText={setCustomNotesHindi}
                        multiline
                        numberOfLines={3}
                      />
                    </View>
                    
                    <Text style={[styles.reminderTypeDescription, { fontSize: 12, color: theme.textSecondary, fontStyle: 'italic' }]}>
                      💡 Both language notes will be added to reminders based on your language order preference
                    </Text>
                  </View>
                ) : (
                  <TextInput
                    style={styles.messageInput}
                    placeholder={
                      selectedLanguage === 'hindi'
                        ? "सभी रिमाइंडर प्रकारों में शामिल किए जाने वाले अतिरिक्त नोट्स दर्ज करें..."
                        : "Enter additional notes to be included in all reminder types..."
                    }
                    placeholderTextColor={theme.textSecondary}
                    value={customNotes}
                    onChangeText={setCustomNotes}
                    multiline
                    numberOfLines={3}
                  />
                )}
              </View>
            )}
            
            {useCustomMessage && (
              <Text style={[styles.reminderTypeDescription, { fontSize: 12, marginTop: 10, color: theme.warning, fontStyle: 'italic' }]}>
                ⚠️ Additional Notes are disabled when using custom messages to avoid conflicting content
              </Text>
            )}
            
            {!useCustomMessage && (
              <Text style={[styles.reminderTypeDescription, { fontSize: 12, marginTop: 10, color: theme.textSecondary }]}>
                💡 {selectedLanguage === 'both' 
                  ? 'When "Both Languages" is selected, separate Hindi and English notes will be combined based on your language order preference' 
                  : 'Custom notes will be automatically added to all reminder types (SMS, WhatsApp, Voice, Email) when enabled'
                }
              </Text>
            )}
          </View>
        </View>

  {/* Filter Categories - hidden when custom message is enabled */}
  {!useCustomMessage && (
  <View style={styles.section}>
          <Text style={styles.sectionTitle}>Filter by Fee Status</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filterScroll}
            contentContainerStyle={styles.filterContainer}
          >
            {[
              { id: 'all', label: 'All Students', color: theme.textSecondary },
              { id: 'unpaid', label: 'Unpaid', color: theme.primary },
              { id: 'partial', label: 'Partial', color: theme.warning },
              { id: 'overdue', label: 'Overdue', color: theme.error },
            ].map(filter => {
              const counts = categoryCounts;
              const count = counts[filter.id as keyof typeof counts];
              
              return (
                <TouchableOpacity
                  key={filter.id}
                  style={[
                    styles.filterButton,
                    {
                      backgroundColor: filterType === filter.id ? filter.color : 'transparent',
                      borderColor: filter.color,
                    }
                  ]}
                  onPress={() => setFilterType(filter.id as any)}
                >
                  <Text
                    style={[
                      styles.filterButtonText,
                      { color: filterType === filter.id ? '#ffffff' : filter.color }
                    ]}
                  >
                    {filter.label} ({count})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
  )}

        {/* Search (moved here, just before Students Selection) */}
        <View style={styles.searchContainer}>
          <Search size={20} color={theme.textSecondary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name, parent, phone, email..."
            placeholderTextColor={theme.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        {/* Students Selection */}
        <View style={styles.section}>
          <View style={styles.selectAllContainer}>
            <Text style={styles.sectionTitle}>Select Students</Text>
            <TouchableOpacity onPress={handleSelectAll}>
              <Text style={styles.selectAllText}>
                {displayedStudents.length > 0 && displayedStudents.every((s) => selectedStudents.has(s.id))
                  ? 'Deselect All'
                  : 'Select All'}
              </Text>
            </TouchableOpacity>
          </View>
          
          <Text style={styles.selectedCount}>
            {selectedStudents.size} selected • {displayedStudents.length} shown
          </Text>

          <View style={styles.studentsList}>
            {displayedStudents.length === 0 ? (
              <View style={styles.emptyState}>
                <Users size={48} color={theme.textSecondary} />
                <Text style={styles.emptyStateText}>
                  {sendabilityQuickFilter
                    ? 'No students match the current sendability shortcut. Clear it to view all students.'
                    : 'No students found matching your search criteria'}
                </Text>
              </View>
            ) : (
              displayedStudents.map(student => {
                const cachedFeeInfo = feeInfoByStudentId.get(student.id);
                const detailedFeeInfo = cachedFeeInfo?.detailedFeeInfo ?? getDetailedFeeInfo(student);
                const isSelected = selectedStudents.has(student.id);
                const trimmedParentEmail = (student.parentEmail || '').trim();
                const emailSelected = reminderTypes.has('email');
                const smsSelected = reminderTypes.has('sms');
                const voiceSelected = reminderTypes.has('voice');
                const whatsappSelected = reminderTypes.has('whatsapp');
                const hasEmail = trimmedParentEmail.length > 0;
                const hasPhone = !!(student.parentContact || student.parentPhone);
                const hasWhatsApp = !!student.parentWhatsApp;
                const hasValidEmail = isValidParentEmail(trimmedParentEmail);
                const showEmailMissingWarning = emailSelected && !hasEmail;
                const showInvalidEmailWarning = emailSelected && hasEmail && !hasValidEmail;
                const showPhoneMissingWarning = (smsSelected || voiceSelected) && !hasPhone;
                const showWhatsAppMissingWarning = whatsappSelected && !hasWhatsApp;
                
                return (
                  <TouchableOpacity
                    key={student.id}
                    style={[
                      styles.studentCard,
                      {
                        backgroundColor: isSelected ? `${theme.primary}15` : theme.background,
                        borderColor: isSelected ? theme.primary : theme.border,
                      }
                    ]}
                    onPress={() => handleSelectStudent(student.id)}
                  >
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        backgroundColor: isSelected ? theme.primary : 'transparent',
                        borderWidth: 2,
                        borderColor: theme.primary,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                                              {isSelected ? <CheckCircle size={12} color="#ffffff" /> : null}
                    </View>
                    
                    <View style={styles.studentInfo}>
                      <Text style={styles.studentName}>{student.name}</Text>
                      <Text style={styles.studentDetails}>
                        {student.parentName} • {getParentContact(student)}
                                                  {student.parentEmail ? ` • ${student.parentEmail}` : ''}
                      </Text>

                      {(showEmailMissingWarning || showInvalidEmailWarning || showPhoneMissingWarning || showWhatsAppMissingWarning) && (
                        <View style={styles.studentWarningRow}>
                          {showEmailMissingWarning ? (
                            <View style={styles.studentWarningChip}>
                              <Text style={styles.studentWarningText}>Email Missing</Text>
                            </View>
                          ) : null}
                          {showInvalidEmailWarning ? (
                            <View style={styles.studentWarningChip}>
                              <Text style={styles.studentWarningText}>Invalid Email</Text>
                            </View>
                          ) : null}
                          {showPhoneMissingWarning ? (
                            <View style={styles.studentWarningChip}>
                              <Text style={styles.studentWarningText}>Phone Missing</Text>
                            </View>
                          ) : null}
                          {showWhatsAppMissingWarning ? (
                            <View style={styles.studentWarningChip}>
                              <Text style={styles.studentWarningText}>WhatsApp Missing</Text>
                            </View>
                          ) : null}
                        </View>
                      )}
                      
                      {detailedFeeInfo && detailedFeeInfo.length > 0 && (
                        <View style={{ marginTop: 8 }}>
                          {detailedFeeInfo.map((feeBreakdown, index) => (
                            <Text 
                              key={index} 
                              style={[
                                styles.feeInfo, 
                                { 
                                  color: feeBreakdown.color,
                                  marginBottom: index < detailedFeeInfo.length - 1 ? 2 : 0
                                }
                              ]}
                            >
                              {feeBreakdown.category}: ₹{feeBreakdown.amount.toLocaleString()}
                              {feeBreakdown.details ? ` (${feeBreakdown.details})` : ''}
                            </Text>
                          ))}
                        </View>
                      )}
                      
                      <View style={styles.availableTypes}>
                        {visibleReminderTypeOptions.map(type => {
                          const typeId = type.id as 'email' | 'sms' | 'whatsapp' | 'voice';
                          const channelEnabled =
                            (typeId === 'email' && enabledChannels.email) ||
                            (typeId === 'sms' && enabledChannels.sms) ||
                            (typeId === 'whatsapp' && enabledChannels.whatsapp) ||
                            (typeId === 'voice' && enabledChannels.voice);
                          const isAvailable = channelEnabled && canSendToStudent(student, type.id);
                          return (
                            <View
                              key={type.id}
                              style={[
                                styles.typeIndicator,
                                {
                                  backgroundColor: isAvailable ? type.color : theme.border,
                                }
                              ]}
                            >
                                                          {type.id === 'email' ? <Mail size={10} color={isAvailable ? '#ffffff' : theme.textSecondary} /> : null}
                            {type.id === 'sms' ? <MessageSquare size={10} color={isAvailable ? '#ffffff' : theme.textSecondary} /> : null}
                            {type.id === 'whatsapp' ? <FontAwesome name="whatsapp" size={10} color={isAvailable ? '#ffffff' : theme.textSecondary} /> : null}
                            {type.id === 'voice' ? <PhoneCall size={10} color={isAvailable ? '#ffffff' : theme.textSecondary} /> : null}
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>

      {/* Action Buttons */}
      {selectedStudents.size > 0 && reminderTypes.size > 0 ? (
        <View>
          {!!sendabilitySummary && (
            <View
              style={{
                marginHorizontal: 20,
                marginBottom: 10,
                padding: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surface,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '700', color: theme.text, marginBottom: 6 }}>
                Sendability Check
              </Text>
              <Text style={{ fontSize: 13, color: theme.textSecondary }}>
                Valid: {sendabilitySummary.valid} of {sendabilitySummary.totalPlanned} planned reminder(s)
              </Text>

              {sendabilityQuickFilter && (
                <View
                  style={{
                    marginTop: 8,
                    paddingVertical: 6,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    backgroundColor: `${theme.primary}18`,
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 12, color: theme.primary, fontWeight: '600' }}>
                    Showing students by: {sendabilityQuickFilter === 'missing-email'
                      ? 'Email Missing'
                      : sendabilityQuickFilter === 'invalid-email'
                        ? 'Invalid Email'
                        : sendabilityQuickFilter === 'missing-phone'
                          ? 'Phone Missing'
                          : sendabilityQuickFilter === 'missing-whatsapp'
                            ? 'WhatsApp Missing'
                            : sendabilityQuickFilter === 'custom-empty'
                              ? 'Empty Custom Message'
                              : 'Disabled Channel'}
                  </Text>
                  <TouchableOpacity onPress={() => setSendabilityQuickFilter(null)}>
                    <Text style={{ fontSize: 12, color: theme.primary, fontWeight: '700' }}>Clear</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {sendabilitySummary.blockedInvalidEmail > 0 && (
                  <TouchableOpacity
                    onPress={() => setSendabilityQuickFilter('invalid-email')}
                    style={{
                      borderWidth: 1,
                      borderColor: sendabilityQuickFilter === 'invalid-email' ? theme.error : theme.border,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: sendabilityQuickFilter === 'invalid-email' ? `${theme.error}18` : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: theme.textSecondary }}>
                      {sendabilitySummary.blockedInvalidEmail} Invalid Email
                    </Text>
                  </TouchableOpacity>
                )}

                {sendabilitySummary.blockedMissingEmail > 0 && (
                  <TouchableOpacity
                    onPress={() => setSendabilityQuickFilter('missing-email')}
                    style={{
                      borderWidth: 1,
                      borderColor: sendabilityQuickFilter === 'missing-email' ? theme.error : theme.border,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: sendabilityQuickFilter === 'missing-email' ? `${theme.error}18` : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: theme.textSecondary }}>
                      {sendabilitySummary.blockedMissingEmail} Email Missing
                    </Text>
                  </TouchableOpacity>
                )}

                {sendabilitySummary.blockedMissingPhone > 0 && (
                  <TouchableOpacity
                    onPress={() => setSendabilityQuickFilter('missing-phone')}
                    style={{
                      borderWidth: 1,
                      borderColor: sendabilityQuickFilter === 'missing-phone' ? theme.error : theme.border,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: sendabilityQuickFilter === 'missing-phone' ? `${theme.error}18` : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: theme.textSecondary }}>
                      {sendabilitySummary.blockedMissingPhone} Phone Missing
                    </Text>
                  </TouchableOpacity>
                )}

                {sendabilitySummary.blockedMissingWhatsApp > 0 && (
                  <TouchableOpacity
                    onPress={() => setSendabilityQuickFilter('missing-whatsapp')}
                    style={{
                      borderWidth: 1,
                      borderColor: sendabilityQuickFilter === 'missing-whatsapp' ? theme.error : theme.border,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: sendabilityQuickFilter === 'missing-whatsapp' ? `${theme.error}18` : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: theme.textSecondary }}>
                      {sendabilitySummary.blockedMissingWhatsApp} WhatsApp Missing
                    </Text>
                  </TouchableOpacity>
                )}

                {sendabilitySummary.blockedCustomEmpty > 0 && (
                  <TouchableOpacity
                    onPress={() => setSendabilityQuickFilter('custom-empty')}
                    style={{
                      borderWidth: 1,
                      borderColor: sendabilityQuickFilter === 'custom-empty' ? theme.warning : theme.border,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: sendabilityQuickFilter === 'custom-empty' ? `${theme.warning}18` : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: theme.textSecondary }}>
                      {sendabilitySummary.blockedCustomEmpty} Custom Empty
                    </Text>
                  </TouchableOpacity>
                )}

                {sendabilitySummary.blockedDisabledChannel > 0 && (
                  <TouchableOpacity
                    onPress={() => setSendabilityQuickFilter('disabled-channel')}
                    style={{
                      borderWidth: 1,
                      borderColor: sendabilityQuickFilter === 'disabled-channel' ? theme.primary : theme.border,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: sendabilityQuickFilter === 'disabled-channel' ? `${theme.primary}18` : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: theme.textSecondary }}>
                      {sendabilitySummary.blockedDisabledChannel} Channel Disabled
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}

          {/* Preview and Cancel Buttons Row */}
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.previewButton, styles.buttonFlex]}
              onPress={() => {
                setPreviewStudentIndex(0); // Reset to first student when opening preview
                setShowPreviewModal(true);
              }}
            >
              <Text style={styles.previewButtonText}>Preview Messages</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.cancelButton, styles.buttonFlex]}
              onPress={handleCancel}
            >
              <X size={18} color={theme.textSecondary} />
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
          
          {/* Send Button */}
          <TouchableOpacity
            style={[styles.sendButton, { backgroundColor: theme.primary }]}
            onPress={() => {
              if (isSending || isProcessing) {
                logger.debug('Already processing, ignoring button press');
                return false;
              }
              
              // Show confirmation modal
              setShowConfirmModal(true);
              
              return false;
            }}
            disabled={isSending || isProcessing || (sendabilitySummary?.valid ?? 0) <= 0}
            activeOpacity={0.8}
          >
            {(isSending || isProcessing) ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Send size={20} color="#ffffff" />
            )}
            <Text style={styles.sendButtonText}>
              {(isSending || isProcessing)
                ? 'Sending...'
                : (sendabilitySummary?.valid ?? 0) <= 0
                  ? 'No Valid Reminders To Send'
                  : `Send ${selectedStudents.size} Reminders`}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        // Show cancel button even when no students selected (if form has any data)
        (useCustomMessage || useCustomNotes || customMessage.trim() || customMessageHindi.trim() || 
         customMessageEnglish.trim() || customNotes.trim() || customNotesHindi.trim() || 
         customNotesEnglish.trim() || selectedStudents.size > 0 || reminderTypes.size !== 1 || 
         !reminderTypes.has('email')) && (
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={handleCancel}
          >
            <X size={18} color={theme.textSecondary} />
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        )
      )}

      {/* Status Modal */}
      <Modal
        visible={showStatusModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          if (!isSending && !isProcessing) {
            setShowStatusModal(false);
          }
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.statusModal}>
            <View style={styles.statusHeader}>
              <Text style={styles.statusTitle}>Sending Status</Text>
              {sendStatuses.some(s => s.type === 'whatsapp' && s.status === 'queued') && (
                <TouchableOpacity
                  style={[styles.closeButton, { marginRight: 8 }]}
                  onPress={manualRefreshQueued}
                  disabled={polling}
                >
                  <Text style={{ color: theme.primary, fontWeight: '600' }}>Refresh</Text>
                </TouchableOpacity>
              )}
              {(!isSending && !isProcessing) && (
                <TouchableOpacity
                  style={styles.closeButton}
                  onPress={() => setShowStatusModal(false)}
                >
                  <X size={24} color={theme.text} />
                </TouchableOpacity>
              )}
            </View>

            {sendStatuses.length > 0 && (
              <View style={styles.statusSummary}>
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryNumber, { color: theme.success }]}>
                    {getStatusSummary().successful}
                  </Text>
                  <Text style={styles.summaryLabel}>Successful</Text>
                </View>
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryNumber, { color: theme.primary }]}>
                    {getStatusSummary().queued}
                  </Text>
                  <Text style={styles.summaryLabel}>Queued</Text>
                </View>
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryNumber, { color: theme.warning }]}>
                    {getStatusSummary().pending}
                  </Text>
                  <Text style={styles.summaryLabel}>Pending</Text>
                </View>
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryNumber, { color: theme.error }]}>
                    {getStatusSummary().failed}
                  </Text>
                  <Text style={styles.summaryLabel}>Failed</Text>
                </View>
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryNumber, { color: '#f39c12' }]}>
                    {getStatusSummary().skipped}
                  </Text>
                  <Text style={styles.summaryLabel}>Skipped</Text>
                </View>
              </View>
            )}

            <ScrollView showsVerticalScrollIndicator={false}>
              {sendStatuses.map((status, index) => {
                const student = students.find(s => s.id === status.studentId);
                const typeOption = reminderTypeOptions.find(t => t.id === status.type);

                const statusLabel =
                  status.status === 'success'
                    ? 'Sent'
                    : status.status === 'failed'
                      ? 'Failed'
                      : status.status === 'queued'
                        ? 'Queued'
                        : status.status === 'skipped'
                          ? 'Skipped'
                          : 'Sending';

                const statusBadgeColor =
                  status.status === 'success'
                    ? theme.success
                    : status.status === 'failed'
                      ? theme.error
                      : status.status === 'queued'
                        ? theme.primary
                        : status.status === 'skipped'
                          ? '#f39c12'
                          : theme.warning;
                
                return (
                  <View
                    key={index}
                    style={[
                      styles.statusItem,
                      {
                        backgroundColor: 
                          status.status === 'success' ? `${theme.success}15` :
                          status.status === 'failed' ? `${theme.error}15` :
                          status.status === 'queued' ? `${theme.primary}15` :
                          status.status === 'skipped' ? '#f39c1215' :
                          `${theme.warning}15`,
                      }
                    ]}
                  >
                                          {status.status === 'success' ? <CheckCircle size={20} color={theme.success} /> : null}
                                          {status.status === 'failed' ? <AlertCircle size={20} color={theme.error} /> : null}
                                          {status.status === 'pending' ? <ActivityIndicator size={20} color={theme.warning} /> : null}
                                          {status.status === 'queued' ? <Clock size={20} color={theme.primary} /> : null}
                                          {status.status === 'skipped' ? <AlertCircle size={20} color={'#f39c12'} /> : null}
                    
                    <View style={styles.statusStudent}>
                      <Text style={[styles.statusStudentName, { color: theme.text }]}>
                        {student?.name}
                      </Text>
                      <Text style={[styles.statusType, { color: theme.textSecondary }]}>
                        {typeOption?.name} • {status.message || 'Processing...'}
                      </Text>
                    </View>

                    <View style={[styles.statusBadge, { backgroundColor: statusBadgeColor }]}>
                      <Text style={styles.statusBadgeText}>{statusLabel}</Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Confirmation Modal */}
      <Modal
        visible={showConfirmModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowConfirmModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.statusModal}>
            <View style={styles.statusHeader}>
              <Text style={styles.statusTitle}>Confirm Send Reminders</Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => setShowConfirmModal(false)}
              >
                <X size={24} color={theme.text} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ marginBottom: 20 }}>
                <Text style={[styles.sectionTitle, { marginBottom: 15 }]}>
                  Reminder Summary
                </Text>
                
                {/* Selected Students */}
                <View style={[styles.section, { margin: 0, marginBottom: 15 }]}>
                  <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 10 }]}>
                    Selected Students ({selectedStudents.size})
                  </Text>
                  <Text style={[styles.statusType, { lineHeight: 20 }]}>
                    {students.filter(s => selectedStudents.has(s.id)).map(s => s.name).join(', ')}
                  </Text>
                </View>

                {/* Selected Reminder Types */}
                <View style={[styles.section, { margin: 0, marginBottom: 15 }]}>
                  <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 10 }]}>
                    Reminder Types
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                    {Array.from(reminderTypes).map(type => {
                      const typeOption = reminderTypeOptions.find(opt => opt.id === type);
                      return (
                        <View key={type} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
                          <View style={[styles.reminderTypeIcon, { backgroundColor: typeOption?.color, marginRight: 8, width: 24, height: 24 }]}>
                                                      {type === 'email' ? <Mail size={12} color="#ffffff" /> : null}
                          {type === 'sms' ? <MessageSquare size={12} color="#ffffff" /> : null}
                          {type === 'whatsapp' ? <FontAwesome name="whatsapp" size={12} color="#ffffff" /> : null}
                          {type === 'voice' ? <PhoneCall size={12} color="#ffffff" /> : null}
                          </View>
                          <Text style={[styles.statusType, { color: theme.text }]}>
                            {typeOption?.name}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </View>

                {/* Custom Message/Notes Info */}
                {(useCustomMessage || useCustomNotes) && (
                  <View style={[styles.section, { margin: 0, marginBottom: 15 }]}>
                    <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 10 }]}>
                      Message Configuration
                    </Text>
                    {useCustomMessage && (
                      <Text style={[styles.statusType, { color: theme.text, marginBottom: 5 }]}>
                        ✅ Using custom message
                      </Text>
                    )}
                    {useCustomNotes && (
                      <Text style={[styles.statusType, { color: theme.text, marginBottom: 5 }]}>
                        ✅ Custom notes will be added to all reminders
                      </Text>
                    )}
                    {!useCustomMessage && !useCustomNotes && (
                      <Text style={[styles.statusType, { color: theme.text }]}>
                        📝 Using default reminder messages
                      </Text>
                    )}
                  </View>
                )}

                {/* Action Buttons */}
                <View style={{ flexDirection: 'row', gap: 15 }}>
                  <TouchableOpacity
                    style={[
                      styles.sendButton,
                      {
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        borderColor: theme.textSecondary,
                        flex: 1,
                        margin: 0,
                      }
                    ]}
                    onPress={() => setShowConfirmModal(false)}
                  >
                    <Text style={[styles.sendButtonText, { color: theme.textSecondary }]}>
                      Cancel
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.sendButton,
                      {
                        backgroundColor: theme.primary,
                        flex: 1,
                        margin: 0,
                      }
                    ]}
                    onPress={(event) => {
                      // Prevent any event propagation that might cause navigation
                      event?.preventDefault?.();
                      event?.stopPropagation?.();

                      // All-or-nothing quota preflight
                      const okToSend = runQuotaPreflightOrShowModal();
                      if (!okToSend) {
                        setShowConfirmModal(false);
                        return;
                      }
                      
                      logger.debug('=== CONFIRMED - STARTING SEND ===');
                      setShowConfirmModal(false);
                      setIsProcessing(true);
                      
                      // Show modal and set sending state
                      setShowStatusModal(true);
                      setIsSending(true);
                      
                      // Use requestAnimationFrame for better timing
                      requestAnimationFrame(() => {
                        sendReminders().catch((error) => {
                          logger.error('Send reminders error:', error);
                          setIsSending(false);
                          setIsProcessing(false);
                          setShowStatusModal(false);
                        }).finally(() => {
                          setIsProcessing(false);
                        });
                      });
                    }}
                  >
                    <Send size={20} color="#ffffff" />
                    <Text style={styles.sendButtonText}>
                      Send Reminders
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Quota Block Modal (all-or-nothing) */}
      <Modal
        visible={showQuotaBlockModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowQuotaBlockModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.statusModal}>
            <View style={styles.statusHeader}>
              <Text style={styles.statusTitle}>{quotaBlockData?.title || 'Quota check'}</Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => setShowQuotaBlockModal(false)}
              >
                <X size={24} color={theme.text} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ marginBottom: 20 }}>
                <Text style={[styles.statusType, { color: theme.textSecondary, lineHeight: 20, marginBottom: 12 }]}>
                  {quotaBlockData?.description || ''}
                </Text>

                {quotaBlockData?.kind !== 'channels' && !!usageSummaryLastUpdated && (
                  <Text style={[styles.statusType, { color: theme.textSecondary, marginBottom: 12 }]}>
                    Snapshot updated: {usageSummaryLastUpdated.toLocaleString()}
                  </Text>
                )}

                {quotaBlockData?.kind !== 'channels' && (quotaBlockData?.lines?.length || 0) > 0 && (
                  <View style={[styles.section, { margin: 0, marginBottom: 15 }]}>
                    <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 10 }]}>
                      Required vs Remaining (this month)
                    </Text>
                    {quotaBlockData!.lines.map((l) => {
                      const finiteRemaining = Number.isFinite(l.remaining);
                      const over = finiteRemaining && l.needed > l.remaining;
                      const remainingLabel = finiteRemaining ? String(l.remaining) : 'Unlimited';
                      const limitLabel = l.limit > 0 ? String(l.limit) : 'Unlimited';
                      return (
                        <View
                          key={l.type}
                          style={{
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            paddingVertical: 8,
                            borderBottomWidth: 1,
                            borderBottomColor: theme.border,
                          }}
                        >
                          <Text style={[styles.statusType, { color: theme.text }]}>
                            {l.label}
                          </Text>
                          <Text style={[styles.statusType, { color: over ? theme.error : theme.textSecondary }]}>
                            Need {l.needed} • Remaining {remainingLabel} (Used {l.used} / Limit {limitLabel})
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                <View style={[styles.section, { margin: 0, marginBottom: 15 }]}>
                  <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 8 }]}>
                    Next steps
                  </Text>
                  <Text style={[styles.statusType, { color: theme.textSecondary, lineHeight: 20 }]}>
                    {quotaBlockData?.kind === 'channels'
                      ? '- Deselect the disabled channels and try again\n- If needed, contact your admin to re-enable the channel'
                      : '- Reduce selected students, OR disable channels that are over quota\n- Upgrade your plan, OR wait for next month reset'}
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', gap: 15 }}>
                  <TouchableOpacity
                    style={[
                      styles.sendButton,
                      {
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        borderColor: theme.textSecondary,
                        flex: 1,
                        margin: 0,
                      },
                    ]}
                    onPress={() => setShowQuotaBlockModal(false)}
                  >
                    <Text style={[styles.sendButtonText, { color: theme.textSecondary }]}>Edit Selection</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.sendButton,
                      {
                        backgroundColor: theme.primary,
                        flex: 1,
                        margin: 0,
                      },
                    ]}
                    onPress={async () => {
                      if (quotaBlockData?.kind === 'channels') {
                        setShowQuotaBlockModal(false);
                        return;
                      }
                      if (usageSummaryError || !usageSummary) {
                        await refreshUsageSummary();
                        return;
                      }
                      setShowQuotaBlockModal(false);
                      router.push('/(tabs)/plan');
                    }}
                  >
                    <Text style={styles.sendButtonText}>
                      {quotaBlockData?.kind === 'channels'
                        ? 'Close'
                        : usageSummaryError || !usageSummary
                          ? 'Refresh Usage'
                          : 'Plan & Billing'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Preview Modal */}
      <Modal
        visible={showPreviewModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowPreviewModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.statusModal}>
            <View style={styles.statusHeader}>
              <Text style={styles.statusTitle}>Message Preview</Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => setShowPreviewModal(false)}
              >
                <X size={24} color={theme.text} />
              </TouchableOpacity>
            </View>

            {/* Navigation Controls */}
            {selectedStudents.size > 1 && (
              <View style={styles.navigationHeader}>
                <TouchableOpacity
                  style={[styles.navButton, { opacity: previewStudentIndex === 0 ? 0.5 : 1 }]}
                  onPress={() => setPreviewStudentIndex(Math.max(0, previewStudentIndex - 1))}
                  disabled={previewStudentIndex === 0}
                >
                  <ChevronLeft size={20} color={theme.primary} />
                  <Text style={[styles.navButtonText, { color: theme.primary }]}>Previous</Text>
                </TouchableOpacity>
                
                <View style={styles.studentCounter}>
                  <Text style={styles.counterText}>
                    {previewStudentIndex + 1} of {selectedStudents.size}
                  </Text>
                </View>
                
                <TouchableOpacity
                  style={[styles.navButton, { opacity: previewStudentIndex === selectedStudents.size - 1 ? 0.5 : 1 }]}
                  onPress={() => setPreviewStudentIndex(Math.min(selectedStudents.size - 1, previewStudentIndex + 1))}
                  disabled={previewStudentIndex === selectedStudents.size - 1}
                >
                  <Text style={[styles.navButtonText, { color: theme.primary }]}>Next</Text>
                  <ChevronRight size={20} color={theme.primary} />
                </TouchableOpacity>
              </View>
            )}

            <ScrollView showsVerticalScrollIndicator={false}>
              {selectedStudents.size > 0 && (() => {
                const selectedStudentsList = students.filter(s => selectedStudents.has(s.id));
                const currentStudent = selectedStudentsList[previewStudentIndex];
                
                if (!currentStudent) return null;
                
                return (
                  <View style={{ marginBottom: 20 }}>
                    <Text style={[styles.sectionTitle, { marginBottom: 10 }]}>
                      Preview for: {currentStudent.name}
                    </Text>
                    
                    {Array.from(reminderTypes).map(type => {
                      const contactAvailable = canSendToStudent(currentStudent, type);
                      const contactRequirement = type === 'email'
                        ? 'parent email ID'
                        : type === 'whatsapp'
                          ? 'parent WhatsApp number'
                          : 'parent phone number';
                      const missingContactMessage = type === 'email'
                        ? 'Parent email ID not added. Update the student profile to send email reminders.'
                        : type === 'whatsapp'
                          ? 'Parent WhatsApp number not added. Update the student profile to send WhatsApp reminders.'
                          : 'Parent phone number not added. Update the student profile to send this reminder.';
                      
                      const typeOption = reminderTypeOptions.find(t => t.id === type);
                      const feeInfo = getStudentFeeInfo(currentStudent);
                    
                      // Generate appropriate message based on type
                      let message = '';
                      let isHtmlContent = false;
                      let contactDisplay: string;
                      let messageColor = theme.text;
                      let contactColor = theme.textSecondary;

                      if (!contactAvailable) {
                        message = missingContactMessage;
                        contactDisplay = `Not available – ${contactRequirement} missing`;
                        messageColor = theme.error;
                        contactColor = theme.error;
                      } else {
                        
                      
                      if (type === 'email') {
                        // Email preview
                        const formatAmount = (amt: number) => {
                          if (!amt || amt === 0) return 'Amount pending';
                          return `₹${amt.toLocaleString('en-IN')}`;
                        };
                        
                        const formatDate = (date: string) => {
                          try {
                            return new Date(date).toLocaleDateString('en-IN', {
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric'
                            });
                          } catch {
                            return 'as soon as possible';
                          }
                        };
                        
                        const currentDate = feeInfo.earliestDueDate;
                        
                        if (useCustomMessage) {
                          // Custom message email preview (bilingual aware)
                          const parentDisplay = currentStudent.parentName || 'Parent';
                          const enRaw = (customMessageEnglish || (selectedLanguage === 'english' ? customMessage : ''))?.trim();
                          const hiRaw = (customMessageHindi || (selectedLanguage === 'hindi' ? customMessage : ''))?.trim();
                          const both = selectedLanguage === 'both';
                          const hasEn = both ? !!enRaw : (selectedLanguage === 'english' && !!(enRaw || customMessage.trim()));
                          const hasHi = both ? !!hiRaw : (selectedLanguage === 'hindi' && !!(hiRaw || customMessage.trim()));
                          const effectiveEn = enRaw || (selectedLanguage === 'english' ? customMessage.trim() : '');
                          const effectiveHi = hiRaw || (selectedLanguage === 'hindi' ? customMessage.trim() : '');
                          if (!hasEn && !hasHi) {
                            message = '';
                          } else {
                            const lines: string[] = [];
                            lines.push(`Subject: Message - ${parentDisplay}`);
                            lines.push('');
                            lines.push(`Dear ${parentDisplay},`);
                            lines.push('');
                            lines.push(`This message concerns ${currentStudent.name}.`);
                            lines.push('');
                            if (both) {
                              // When both languages selected apply ordering & conditional labels (labels only if both present)
                              const englishFirst = languageOrder === 'english-first';
                              const parts: string[] = [];
                              const enBlock = hasEn ? [hasEn && hasHi ? 'Message (English)' : null, effectiveEn].filter(Boolean).join('\n') : '';
                              const hiBlock = hasHi ? [hasEn && hasHi ? 'संदेश (हिंदी)' : null, effectiveHi].filter(Boolean).join('\n') : '';
                              if (englishFirst) {
                                if (enBlock) parts.push(enBlock);
                                if (hiBlock) parts.push(hiBlock);
                              } else {
                                if (hiBlock) parts.push(hiBlock);
                                if (enBlock) parts.push(enBlock);
                              }
                              lines.push(parts.join('\n\n'));
                            } else if (selectedLanguage === 'english') {
                              lines.push(effectiveEn);
                            } else if (selectedLanguage === 'hindi') {
                              lines.push(effectiveHi);
                            } else {
                              // Fallback single-language assumption
                              lines.push(effectiveEn || effectiveHi);
                            }
                            lines.push('');
                            lines.push('Best regards,');
                            lines.push(resolvedTeacherName || 'Tuition Management System');
                            lines.push(resolvedCoachingName);
                            message = lines.join('\n');
                            message += '\n\n---\nThis email will be sent with professional HTML formatting using the Custom Message template (labels hidden for single-language).';
                          }
                        } else {
                          // Default fee reminder email preview
                          message = `Subject: Fee Reminder - ${currentStudent.name}\n\nDear Parent/Guardian,\n\nThis is a friendly reminder that the tuition fee for ${currentStudent.name} is due.\n\nPAYMENT DETAILS:\n━━━━━━━━━━━━━━━━━━━━\nStudent: ${currentStudent.name}\nAmount Due: ${formatAmount(feeInfo.totalDue)}\nDue Date: ${formatDate(currentDate)}\n━━━━━━━━━━━━━━━━━━━━\n\n⚠️ Please ensure timely payment to avoid any inconvenience.\n\nIf you have already made the payment, please disregard this message.\n\nFor any queries, please feel free to contact us.\n\nAdditional Note: Please ensure payment is made before the next class to maintain uninterrupted learning.\n\nBest regards,\n${resolvedTeacherName || 'Tuition Management System'}\n${resolvedCoachingName}\n\n---\nThis email will be sent with professional HTML formatting including styled payment details, colors, and proper layout.`;
                        }
                        isHtmlContent = true;
                      } else if (type === 'voice') {
                        if (useCustomMessage) {
                          const teacherLine = resolvedTeacherName || '';
                          const coachingLine = resolvedCoachingName || '';
                          const buildGreeting = (lang:'english'|'hindi') => lang==='hindi' ? 'प्रिय अभिभावक,' : 'Dear parent,';
                          const buildBodyBlock = (lang:'english'|'hindi', raw:string) => {
                            const trimmed = (raw || '').trim();
                            if (!trimmed) return null;
                            const thankYouLine = lang==='hindi'
                              ? `धन्यवाद।${teacherLine ? ` शिक्षक ${teacherLine} की ओर से।` : ''}${coachingLine ? ` ${coachingLine} की ओर से।` : ''}`
                              : `Thank you.${teacherLine ? ` From teacher ${teacherLine}.` : ''}${coachingLine ? ` From ${coachingLine}.` : ''}`;
                            return [buildGreeting(lang), trimmed, thankYouLine].join('\n');
                          };
                          if (selectedLanguage === 'both') {
                            const en = buildBodyBlock('english', customMessageEnglish || customMessage);
                            const hi = buildBodyBlock('hindi', customMessageHindi || customMessage);
                            const blocks: string[] = [];
                            if (languageOrder === 'english-first') {
                              if (en) blocks.push(en);
                              if (hi) blocks.push(hi);
                            } else {
                              if (hi) blocks.push(hi);
                              if (en) blocks.push(en);
                            }
                            message = blocks.join('\n\n');
                            if (message) {
                              const hasEn = !!en;
                              const hasHi = !!hi;
                              if (hasEn && hasHi) {
                                // both blocks present -> keep both wishes in fixed order English then Hindi
                                message += `\n\nHave a nice day!\nआपका दिन शुभ हो!`;
                              } else if (hasEn) {
                                message += `\n\nHave a nice day!`;
                              } else if (hasHi) {
                                message += `\n\nआपका दिन शुभ हो!`;
                              }
                            }
                          } else if (selectedLanguage === 'hindi') {
                            const hi = buildBodyBlock('hindi', customMessageHindi || customMessage);
                            // Single Hindi: keep only Hindi wish
                            message = hi ? `${hi}\n\nआपका दिन शुभ हो!` : '';
                          } else {
                            const en = buildBodyBlock('english', customMessageEnglish || customMessage);
                            // Single English: keep only English wish
                            message = en ? `${en}\n\nHave a nice day!` : '';
                          }
                        } else {
                          // Non-custom voice preview: wrap generated base with new greeting already handled in getVoiceMessage, append day wish lines
                          message = getVoiceMessage(currentStudent);
                          if (selectedLanguage === 'both') {
                            const wishEn = 'Have a nice day!';
                            const wishHi = 'आपका दिन शुभ हो!';
                            // Only append if not already present
                            if (!message.includes(wishEn) && !message.includes(wishHi)) {
                              message += languageOrder === 'english-first' ? `\n${wishEn}\n${wishHi}` : `\n${wishHi}\n${wishEn}`;
                            }
                          } else if (selectedLanguage === 'hindi') {
                            if (!message.includes('आपका दिन शुभ हो!')) message += '\nआपका दिन शुभ हो!';
                          } else {
                            if (!message.includes('Have a nice day!')) message += '\nHave a nice day!';
                          }
                        }
                      } else { // sms or whatsapp
                        if (type === 'whatsapp' && !useCustomMessage) {
                          // Exact template body preview for fee_due_reminder_extended (+ bilingual variants)
                          const feeInfoForTemplate = getStudentFeeInfo(currentStudent);
                          const amountFmt = `₹${feeInfoForTemplate.totalDue.toLocaleString('en-IN')}`;
                          const dueDateRaw = feeInfoForTemplate.earliestDueDate;
                          const greetingEn = (addGreetings ? (useCustomGreetings && customGreetingsEnglish.trim() ? customGreetingsEnglish.trim() : 'Dear') : 'Dear').trim();
                          const parentLabelEn = 'Parent';
                          const teacherResolved = resolvedTeacherName || '-';
                          const coachingResolved = resolvedCoachingName || '-';
                          // Use structured bilingual notes so preview mirrors backend placeholder mapping
                          const structuredNotesPrev = getStructuredCustomNotes();
                          let customEn = structuredNotesPrev && 'english' in structuredNotesPrev && structuredNotesPrev.english?.trim()
                            ? structuredNotesPrev.english.trim()
                            : 'No additional note';
                          let customHi = structuredNotesPrev && 'hindi' in structuredNotesPrev && structuredNotesPrev.hindi?.trim()
                            ? structuredNotesPrev.hindi.trim()
                            : 'कोई अतिरिक्त नोट नहीं';
                          
                          // For WhatsApp preview, show comma formatting to match actual delivery
                          if (type === 'whatsapp') {
                            customEn = customEn.replace(/\n/g, ', ');
                            customHi = customHi.replace(/\n/g, ', ');
                          }
                          const hindiGreeting = (/^dear/i.test(greetingEn)) ? 'प्रिय' : greetingEn; // simple heuristic matching send logic
                          const hindiParent = 'अभिभावक';

                          const buildEnglishSegment = () => [
                            `Tuition reminder – ${greetingEn} ${parentLabelEn}, ${currentStudent.name}'s tuition fee of ${amountFmt} is due on ${dueDateRaw}.`,
                            `Additional note: ${customEn}.`,
                            'Please make the payment at your earliest convenience. Thank you!',
                            'Regards,',
                            `${teacherResolved}`,
                            `${coachingResolved}`,
                            'Have a nice day!'
                          ].join('\n');

                          const buildHindiSegment = () => [
                            `ट्यूशन अनुस्मारक – ${hindiGreeting} ${hindiParent}, ${currentStudent.name} की ट्यूशन फीस ${amountFmt} देय है जिसकी अंतिम तिथि ${dueDateRaw} है।`,
                            `अतिरिक्त नोट: ${customHi}.`,
                            'कृपया अपनी सुविधा के अनुसार भुगतान करें। धन्यवाद!',
                            'सादर,',
                            `${teacherResolved}`,
                            `${coachingResolved}`,
                            'आपका दिन शुभ हो!'
                          ].join('\n');

                          if (selectedLanguage === 'both') {
                            const englishFirst = languageOrder === 'english-first';
                            message = englishFirst
                              ? `${buildEnglishSegment()}\n\n${buildHindiSegment()}`
                              : `${buildHindiSegment()}\n\n${buildEnglishSegment()}`;
                          } else if (selectedLanguage === 'hindi') {
                            // Hindi-only template structure
                            message = buildHindiSegment();
                          } else {
                            // English-only template structure
                            message = buildEnglishSegment();
                          }
                        } else {
                          // Custom message preview (SMS or WhatsApp custom path)
                          if (useCustomMessage) {
                            const channel: 'sms'|'whatsapp' = (type === 'whatsapp') ? 'whatsapp' : 'sms';
                            const buildBlock = (lang: 'english'|'hindi', raw: string) => {
                              const trimmed = raw.trim();
                              if (!trimmed) return ''; // show empty, no fallback
                              const greetingLine = lang === 'hindi' ? 'प्रिय अभिभावक' : 'Dear Parent';
                              const isWhatsapp = channel === 'whatsapp';
                              const teacherLine = resolvedTeacherName || (isWhatsapp ? '-' : '');
                              const coachingLine = resolvedCoachingName || (isWhatsapp ? '-' : '');
                              const haveSignatureInfo = !!(teacherLine || coachingLine);
                              const regardsWord = haveSignatureInfo ? (lang === 'hindi' ? 'सादर,' : 'Regards,') : '';
                              const dayWish = lang === 'hindi' ? 'आपका दिन शुभ हो!' : 'Have a nice day!';
                              
                              // For WhatsApp, convert newlines to commas to match actual delivery format
                              const messageContent = isWhatsapp ? trimmed.replace(/\n/g, ', ') : trimmed;
                              
                              const lines = [greetingLine, messageContent];
                              if (regardsWord) lines.push(regardsWord);
                              if (teacherLine) lines.push(teacherLine);
                              if (coachingLine) lines.push(coachingLine);
                              lines.push(dayWish);
                              return lines.join('\n');
                            };
                            if (selectedLanguage === 'both') {
                              const enBlock = buildBlock('english', customMessageEnglish || customMessage);
                              const hiBlock = buildBlock('hindi', customMessageHindi || customMessage);
                              const blocks: string[] = [];
                              if (languageOrder === 'english-first') {
                                if (enBlock) blocks.push(enBlock); if (hiBlock) blocks.push(hiBlock);
                              } else { if (hiBlock) blocks.push(hiBlock); if (enBlock) blocks.push(enBlock); }
                              message = blocks.join('\n\n');
                              if (!message.trim()) {
                                message = ''; // ensure completely empty when both empty
                              }
                            } else if (selectedLanguage === 'hindi') {
                              message = buildBlock('hindi', customMessageHindi || customMessage);
                            } else {
                              message = buildBlock('english', customMessageEnglish || customMessage);
                            }
                          } else {
                            message = getDefaultMessage(currentStudent);
                          }
                        }
                        }
                        contactDisplay = type === 'email'
                          ? (currentStudent.parentEmail || 'Not available')
                          : type === 'whatsapp'
                            ? normalizePhoneNumber(currentStudent.parentWhatsApp!)
                            : getParentContact(currentStudent);
                      }

                      const showEmptyPlaceholder = contactAvailable && useCustomMessage && !message.trim();
                      
                      return (
                        <View key={type} style={[styles.section, { margin: 0, marginBottom: 15 }]}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                            <View style={[styles.reminderTypeIcon, { backgroundColor: typeOption?.color, marginRight: 10 }]}>
                              {typeOption?.icon}
                            </View>
                            <Text style={[styles.reminderTypeName, { color: theme.text }]}>
                              {typeOption?.name}{isHtmlContent ? ' (Professional HTML Format)' : ''}
                            </Text>
                          </View>
                          
                          <ScrollView 
                            style={[
                              styles.messageInput, 
                              { 
                                backgroundColor: theme.background, 
                                minHeight: isHtmlContent ? 200 : 80,
                                maxHeight: 300
                              }
                            ]}
                            showsVerticalScrollIndicator={true}
                          >
                            <Text style={{ 
                                color: messageColor,
                              fontSize: isHtmlContent ? 12 : 14,
                              fontFamily: isHtmlContent ? 'monospace' : undefined,
                              lineHeight: isHtmlContent ? 16 : 20,
                              opacity: showEmptyPlaceholder ? 0.5 : 1
                            }}>
                              {showEmptyPlaceholder ? '(empty – will be skipped)' : message}
                            </Text>
                          </ScrollView>
                          
                            <Text style={[styles.statusType, { marginTop: 5, color: contactColor }]}>
                            Sending to: {contactDisplay}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                );
              })()}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Settings Modal */}
      <Modal
        visible={showSettingsModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowSettingsModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.statusModal}>
            <View style={styles.statusHeader}>
              <Text style={styles.statusTitle}>Reminder Settings</Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => {
                  setShowSettingsModal(false);
                }}
              >
                <X size={24} color={theme.text} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ marginBottom: 20 }}>
                {/* Tip: where to change teacher and coaching names */}
                <View
                  style={{
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    borderWidth: 1,
                    borderRadius: 12,
                    padding: 12,
                    marginBottom: 16,
                  }}
                >
                  <Text style={{ color: theme.text, fontSize: 14 }}>
                    💡 Teacher name can be changed from your Profile in Settings, and Coaching name from Admin Settings.
                  </Text>
                </View>
                
                {/* Coaching and Teacher name controls removed; now managed via Admin Settings */}

                {/* Greetings Setting */}
                <View style={[styles.section, { margin: 0, marginBottom: 15 }]}>
                  <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 15 }]}>
                    Greetings
                  </Text>
                  <View style={styles.customMessageToggle}>
                    <Text style={styles.toggleLabel}>Add greetings to reminders</Text>
                    <Switch
                      value={localSettings.addGreetings}
                      onValueChange={async (value) => {
                        updateLocalSetting('addGreetings', value);
                      }}
                      trackColor={{ false: theme.border, true: `${theme.primary}50` }}
                      thumbColor={localSettings.addGreetings ? theme.primary : theme.textSecondary}
                    />
                  </View>
                  
                  {localSettings.addGreetings && (
                    <View style={{ marginTop: 15 }}>
                      <View style={styles.customMessageToggle}>
                        <Text style={styles.toggleLabel}>Use custom greetings</Text>
                        <Switch
                          value={localSettings.useCustomGreetings}
                          onValueChange={async (value) => {
                            updateLocalSetting('useCustomGreetings', value);
                          }}
                          trackColor={{ false: theme.border, true: `${theme.primary}50` }}
                          thumbColor={localSettings.useCustomGreetings ? theme.primary : theme.textSecondary}
                        />
                      </View>
                      
                      {localSettings.useCustomGreetings ? (
                        <View style={{ marginTop: 15, gap: 12 }}>
                          <View>
                            <Text style={[styles.toggleLabel, { marginBottom: 8, fontSize: 14 }]}>
                              Custom Greeting (English)
                            </Text>
                            <TextInput
                              style={[styles.messageInput, { minHeight: 50 }]}
                              placeholder="e.g., Dear Respected Parent, Good morning"
                              placeholderTextColor={theme.textSecondary}
                              value={localSettings.customGreetingsEnglish}
                              onChangeText={async (value) => {
                                updateLocalSetting('customGreetingsEnglish', value);
                              }}
                            />
                          </View>
                          
                          <View>
                            <Text style={[styles.toggleLabel, { marginBottom: 8, fontSize: 14 }]}>
                              Custom Greeting (Hindi)
                            </Text>
                            <TextInput
                              style={[styles.messageInput, { minHeight: 50 }]}
                              placeholder="e.g., आदरणीय अभिभावक, सुप्रभात"
                              placeholderTextColor={theme.textSecondary}
                              value={localSettings.customGreetingsHindi}
                              onChangeText={async (value) => {
                                updateLocalSetting('customGreetingsHindi', value);
                              }}
                            />
                          </View>
                          
                          <Text style={[styles.statusType, { fontSize: 12, color: theme.textSecondary, fontStyle: 'italic' }]}>
                            💡 Leave blank to use default greetings for that language
                          </Text>
                        </View>
                      ) : (
                        <Text style={[styles.statusType, { marginTop: 10, fontStyle: 'italic' }]}>
                          Default: Dear Parent (English), प्रिय अभिभावक (Hindi)
                        </Text>
                      )}
                    </View>
                  )}
                </View>

                {/* Language Setting */}
                <View style={[styles.section, { margin: 0, marginBottom: 20 }]}>
                  <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 15 }]}>
                    Language Selection *
                  </Text>
                  <Text style={[styles.statusType, { marginBottom: 15 }]}>
                    Choose the language for reminder messages
                  </Text>
                  
                  <View style={styles.languageOptions}>
                    {[
                      { id: 'english', label: 'English', desc: 'Send reminders in English' },
                      { id: 'hindi', label: 'Hindi', desc: 'Send reminders in Hindi' },
                      { id: 'both', label: 'Both Languages', desc: 'Send reminders in both English and Hindi' },
                    ].map(option => (
                      <TouchableOpacity
                        key={option.id}
                        style={[
                          styles.languageOption,
                          {
                            backgroundColor: localSettings.selectedLanguage === option.id ? `${theme.primary}15` : theme.background,
                            borderColor: localSettings.selectedLanguage === option.id ? theme.primary : theme.border,
                          }
                        ]}
                        onPress={() => {
                          if (localSettings.selectedLanguage !== option.id) {
                            // Reset custom message inputs when language selection changes
                            setCustomMessage('');
                            setCustomMessageEnglish('');
                            setCustomMessageHindi('');
                          }
                          updateLocalSetting('selectedLanguage', option.id as any);
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[
                            styles.reminderTypeName,
                            { 
                              color: localSettings.selectedLanguage === option.id ? theme.primary : theme.text,
                              marginBottom: 4,
                              fontSize: 16
                            }
                          ]}>
                            {option.label}
                          </Text>
                          <Text style={[
                            styles.statusType,
                            { color: localSettings.selectedLanguage === option.id ? theme.primary : theme.textSecondary }
                          ]}>
                            {option.desc}
                          </Text>
                        </View>
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            backgroundColor: localSettings.selectedLanguage === option.id ? theme.primary : 'transparent',
                            borderWidth: 2,
                            borderColor: theme.primary,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {localSettings.selectedLanguage === option.id ? <CheckCircle size={12} color="#ffffff" /> : null}
                        </View>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* Voice Selection Setting */}
                <View style={[styles.section, { margin: 0, marginBottom: 20 }]}>
                  <Text style={[styles.reminderTypeName, { color: theme.text, marginBottom: 15 }]}>
                    Voice Selection for Voice Calls
                  </Text>
                  <Text style={[styles.statusType, { marginBottom: 15 }]}>
                    Choose voice type for automated voice call reminders
                  </Text>
                  
                  {/* English Voice Selection */}
                  <View style={{ marginBottom: 20 }}>
                    <Text style={[styles.toggleLabel, { marginBottom: 12 }]}>
                      English Voice
                    </Text>
                    <View style={styles.languageOptions}>
                      {(() => {
                        // UI-only display names with correct gender; same alias per letter across languages; no provider prefixes
                        const letterGender: any = { a: 'Female', b: 'Male', c: 'Male', d: 'Female', e: 'Female', f: 'Male' };
                        const letterAliasFemale: any = { a: 'Maya', d: 'Diya', e: 'Esha' };
                        const letterAliasMale: any = { b: 'Shivam', c: 'Vishal', f: 'Vikrant' };
                        const aliasForLetter = (letter: string) => (letterGender[letter] === 'Male' ? letterAliasMale[letter] : letterAliasFemale[letter]) || 'Voice';
                        const aliasForId = (id: string) => {
                          if (id.startsWith('google-en-in-standard-')) {
                            const letter = id.slice(-1);
                            return aliasForLetter(letter);
                          }
                          if (id === 'polly-raveena') return 'Raveena';
                          if (id === 'polly-aditi') return 'Aditi';
                          return id;
                        };
                        const descForId = (id: string) => {
                          if (id.startsWith('google-en-in-standard-')) {
                            const letter = id.slice(-1);
                            const gender = letterGender[letter] || 'Female';
                            return `Indian English (${gender})`;
                          }
                          if (id === 'polly-raveena') return 'Indian English (Female)';
                          if (id === 'polly-aditi') return 'Bilingual (Female)';
                          return '';
                        };
                        const ids = [
                          'google-en-in-standard-a',
                          'google-en-in-standard-b',
                          'google-en-in-standard-c',
                          'google-en-in-standard-d',
                          'google-en-in-standard-e',
                          'google-en-in-standard-f',
                          'polly-raveena',
                          'polly-aditi',
                        ];
                        return ids.map(id => ({ id, label: aliasForId(id), desc: descForId(id) }));
                      })().map(option => (
                        <TouchableOpacity
                          key={option.id}
                          style={[
                            styles.languageOption,
                            {
                              backgroundColor: localSettings.englishVoice === option.id ? `${theme.primary}15` : theme.background,
                              borderColor: localSettings.englishVoice === option.id ? theme.primary : theme.border,
                            }
                          ]}
                          onPress={() => updateLocalSetting('englishVoice', option.id as any)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[
                              styles.reminderTypeName,
                              { 
                                color: localSettings.englishVoice === option.id ? theme.primary : theme.text,
                                marginBottom: 4,
                                fontSize: 15
                              }
                            ]}>
                              {option.label}
                            </Text>
                            <Text style={[
                              styles.statusType,
                              { color: localSettings.englishVoice === option.id ? theme.primary : theme.textSecondary }
                            ]}>
                              {option.desc}
                            </Text>
                          </View>
                          <View
                            style={{
                              width: 18,
                              height: 18,
                              borderRadius: 9,
                              backgroundColor: localSettings.englishVoice === option.id ? theme.primary : 'transparent',
                              borderWidth: 2,
                              borderColor: theme.primary,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {localSettings.englishVoice === option.id ? <CheckCircle size={10} color="#ffffff" /> : null}
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  {/* Hindi Voice Selection */}
                  <View>
                    <Text style={[styles.toggleLabel, { marginBottom: 12 }]}>
                      Hindi Voice
                    </Text>
                    <View style={styles.languageOptions}>
                      {(() => {
                        // Same alias/gender mapping as English section
                        const letterGender: any = { a: 'Female', b: 'Male', c: 'Male', d: 'Female', e: 'Female', f: 'Male' };
                        const letterAliasFemale: any = { a: 'Maya', d: 'Diya', e: 'Esha' };
                        const letterAliasMale: any = { b: 'Shivam', c: 'Vishal', f: 'Vikrant' };
                        const aliasForLetter = (letter: string) => (letterGender[letter] === 'Male' ? letterAliasMale[letter] : letterAliasFemale[letter]) || 'Voice';
                        const aliasForId = (id: string) => {
                          if (id.startsWith('google-hi-in-standard-')) {
                            const letter = id.slice(-1);
                            return aliasForLetter(letter);
                          }
                          if (id === 'polly-aditi') return 'Aditi';
                          return id;
                        };
                        const descForId = (id: string) => {
                          if (id.startsWith('google-hi-in-standard-')) {
                            const letter = id.slice(-1);
                            const gender = letterGender[letter] || 'Female';
                            return `Hindi (${gender})`;
                          }
                          if (id === 'polly-aditi') return 'Bilingual (Female)';
                          return '';
                        };
                        const ids = [
                          'google-hi-in-standard-a',
                          'google-hi-in-standard-b',
                          'google-hi-in-standard-c',
                          'google-hi-in-standard-d',
                          'google-hi-in-standard-e',
                          'google-hi-in-standard-f',
                          'polly-aditi',
                        ];
                        return ids.map(id => ({ id, label: aliasForId(id), desc: descForId(id) }));
                      })().map(option => (
                        <TouchableOpacity
                          key={option.id}
                          style={[
                            styles.languageOption,
                            {
                              backgroundColor: localSettings.hindiVoice === option.id ? `${theme.primary}15` : theme.background,
                              borderColor: localSettings.hindiVoice === option.id ? theme.primary : theme.border,
                            }
                          ]}
                          onPress={() => updateLocalSetting('hindiVoice', option.id as any)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[
                              styles.reminderTypeName,
                              { 
                                color: localSettings.hindiVoice === option.id ? theme.primary : theme.text,
                                marginBottom: 4,
                                fontSize: 15
                              }
                            ]}>
                              {option.label}
                            </Text>
                            <Text style={[
                              styles.statusType,
                              { color: localSettings.hindiVoice === option.id ? theme.primary : theme.textSecondary }
                            ]}>
                              {option.desc}
                            </Text>
                          </View>
                          <View
                            style={{
                              width: 18,
                              height: 18,
                              borderRadius: 9,
                              backgroundColor: localSettings.hindiVoice === option.id ? theme.primary : 'transparent',
                              borderWidth: 2,
                              borderColor: theme.primary,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {localSettings.hindiVoice === option.id ? <CheckCircle size={10} color="#ffffff" /> : null}
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                  
                  {/* Language Order Setting - only show when "Both Languages" is selected */}
                  {localSettings.selectedLanguage === 'both' && (
                    <View style={{ marginTop: 20 }}>
                      <Text style={[styles.toggleLabel, { marginBottom: 12 }]}>
                        Language Order for Both Languages
                      </Text>
                      <Text style={[styles.statusType, { marginBottom: 15 }]}>
                        Choose which language should be spoken first
                      </Text>
                      <View style={styles.languageOptions}>
                        {[
                          { id: 'hindi-first', label: 'Hindi First', desc: 'Hindi message first, then English' },
                          { id: 'english-first', label: 'English First', desc: 'English message first, then Hindi' },
                        ].map(option => (
                          <TouchableOpacity
                            key={option.id}
                            style={[
                              styles.languageOption,
                              {
                                backgroundColor: localSettings.languageOrder === option.id ? `${theme.primary}15` : theme.background,
                                borderColor: localSettings.languageOrder === option.id ? theme.primary : theme.border,
                              }
                            ]}
                            onPress={() => updateLocalSetting('languageOrder', option.id as any)}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={[
                                styles.reminderTypeName,
                                { 
                                  color: localSettings.languageOrder === option.id ? theme.primary : theme.text,
                                  marginBottom: 4,
                                  fontSize: 15
                                }
                              ]}>
                                {option.label}
                              </Text>
                              <Text style={[
                                styles.statusType,
                                { color: localSettings.languageOrder === option.id ? theme.primary : theme.textSecondary }
                              ]}>
                                {option.desc}
                              </Text>
                            </View>
                            <View
                              style={{
                                width: 18,
                                height: 18,
                                borderRadius: 9,
                                backgroundColor: localSettings.languageOrder === option.id ? theme.primary : 'transparent',
                                borderWidth: 2,
                                borderColor: theme.primary,
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              {localSettings.languageOrder === option.id ? <CheckCircle size={10} color="#ffffff" /> : null}
                            </View>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  )}
                  
                  <Text style={[styles.statusType, { fontSize: 12, color: theme.textSecondary, fontStyle: 'italic', marginTop: 12 }]}>
                    💡 Voice selection and language order apply to voice call reminders. The call will speak messages using the selected voices in your preferred order.
                  </Text>
                </View>

                {/* Save Button */}
                <View style={{ padding: 20, borderTopWidth: 1, borderTopColor: theme.border }}>
                  {hasUnsavedChanges ? (
                    <Text style={{ 
                      color: theme.warning || '#f59e0b', 
                      fontSize: 14, 
                      textAlign: 'center', 
                      marginBottom: 12,
                      fontWeight: '500'
                    }}>
                      You have unsaved changes
                    </Text>
                  ) : (
                    <Text style={{ 
                      color: theme.textSecondary, 
                      fontSize: 14, 
                      textAlign: 'center', 
                      marginBottom: 12,
                      fontWeight: '500'
                    }}>
                      You have not made any changes
                    </Text>
                  )}
                  
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <TouchableOpacity
                      style={[
                        styles.sendButton, 
                        { 
                          backgroundColor: 'transparent',
                          borderWidth: 1,
                          borderColor: theme.border,
                          flex: 1,
                          margin: 0
                        }
                      ]}
                      onPress={() => {
                        if (hasUnsavedChanges) {
                          discardChanges();
                        } else {
                          setShowSettingsModal(false);
                        }
                      }}
                    >
                      <Text style={[styles.sendButtonText, { color: theme.textSecondary }]}>
                        {hasUnsavedChanges ? 'Discard' : 'Close'}
                      </Text>
                    </TouchableOpacity>
                    
                    <TouchableOpacity
                      style={[
                        styles.sendButton, 
                        { 
                          backgroundColor: hasUnsavedChanges ? theme.primary : theme.border,
                          margin: 0,
                          flex: 1,
                          opacity: hasUnsavedChanges ? 1 : 0.5
                        }
                      ]}
                      onPress={async () => {
                        if (hasUnsavedChanges) {
                          const success = await saveSettings();
                          if (success) {
                            setShowSettingsModal(false);
                          }
                        }
                      }}
                      disabled={saving || !hasUnsavedChanges}
                    >
                      {saving ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <Text style={[
                          styles.sendButtonText,
                          { color: hasUnsavedChanges ? '#fff' : theme.textSecondary }
                        ]}>
                          Save Settings
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* History Modal */}
      <Modal
        visible={showHistoryModal}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowHistoryModal(false)}
      >
        <View style={{ flex: 1 }}>
          <ReminderHistoryViewer onClose={() => setShowHistoryModal(false)} />
        </View>
      </Modal>
    </View>
  );
}
