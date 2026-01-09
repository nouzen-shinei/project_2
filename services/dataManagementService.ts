import { logger } from '@/lib/logger';
import type { Tenant, TenantMembership } from '@/types';
// TODO: Fix studentService import issue - temporarily using dynamic import
// import { studentService } from './studentService';
import { firebaseAuthService } from './firebaseAuthService';
import { internalTokenManager } from './internalTokenManager';
import { runtimeEndpoints } from './runtimeEndpoints';
import { tenantService } from './tenantService';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { getFirestore, collection, addDoc } from 'firebase/firestore';

export interface ExportData {
  version: string;
  exportDate: string;
  exportedBy: string;
  tenant?: TenantExportMetadata | null;
  metadata: {
    totalStudents: number;
    totalFees: number;
    totalAttendance: number;
    totalDevices: number;
    totalNotifications: number;
    totalMembers: number;
    appVersion: string;
  };
  students: any[];
  fees: any[];
  attendance: any[];
  deviceTracking: any[];
  quotesNotifications: any[];
  memberships: ExportedTenantMembership[];
  settings: {
    isDarkMode: boolean;
    notifications: boolean;
    emailReminders: boolean;
    smsReminders: boolean;
    whatsappReminders: boolean;
    specialMessages: boolean;
  };
  profile: any;
  authorizedEmails: string[];
  dashboardData: {
    notifications: any[];
    stats: any;
    recentActivity: any[];
  };
  appConfiguration: any;
}

export interface ImportResult {
  success: boolean;
  message: string;
  errors: string[];
  imported: {
    students: number;
    fees: number;
    attendance: number;
    deviceTracking: number;
    quotesNotifications: number;
    settings: boolean;
    profile: boolean;
    authorizedEmails: number;
    dashboardData: boolean;
  };
}

export interface TenantExportMetadata {
  id: string;
  name?: string;
  code?: string;
  slug?: string;
  status?: Tenant['status'];
  billingTier?: Tenant['billingTier'];
  defaultCurrency?: Tenant['defaultCurrency'];
  timezone?: Tenant['timezone'];
  quotas?: Tenant['quotas'];
  membershipCounts?: Tenant['membershipCounts'];
}

export interface ExportedTenantMembership {
  email: string;
  role: TenantMembership['role'];
  status: TenantMembership['status'];
  displayName?: string | null;
  userId?: string;
}

interface BackendTenantExportResponse {
  meta?: {
    version?: string;
    tenantId?: string;
    generatedAt?: string;
    exportedBy?: string | null;
    collections?: string[];
    format?: string;
  };
  statistics?: {
    datasetCounts?: Record<string, number>;
    totalDocuments?: number;
  };
  students?: any[];
  fees?: any[];
  attendance?: any[];
  deviceTracking?: any[];
  quotes?: any[];
  [collection: string]: unknown;
}

class DataManagementService {
  private backendBaseUrl?: string;

  private sanitizeBaseUrl(value: string): string {
    return value.replace(/\/+$/, '');
  }

  private resolveBackendBaseUrl(): string {
    const fromRemote = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (fromRemote) {
      if (this.backendBaseUrl !== fromRemote) {
        this.backendBaseUrl = fromRemote;
        internalTokenManager.setBaseUrl(fromRemote);
      }
      return fromRemote;
    }

    if (this.backendBaseUrl) {
      return this.backendBaseUrl;
    }

    throw new Error(
      'Backend export API unavailable. Set Firestore appSettings/runtimeEndpoints.apiBaseUrl (or notificationsApiBaseUrl / wabaApiBaseUrl / chatApiBaseUrl) to enable tenant exports.',
    );
  }

  private describeBackendExportError(code: string): string {
    switch (code) {
      case 'tenant_role_insufficient':
        return 'You need staff or admin access to export this coaching center.';
      case 'tenant_membership_required':
      case 'tenant_required':
        return 'Select a coaching center before exporting data.';
      case 'tenant_mismatch':
        return 'You do not have permission to export that coaching center.';
      case 'tenant_guard_missing':
      case 'tenant_check_failed':
        return 'Unable to verify your coaching center membership. Please try again.';
      case 'unauthorized':
      case 'not_authorized':
        return 'Please sign in again to export data.';
      default:
        return 'Unable to export data right now. Please try again in a moment.';
    }
  }

  private async getTenantExportMetadata(tenantId: string): Promise<TenantExportMetadata | null> {
    if (!tenantId) {
      return null;
    }
    try {
      const tenant = await tenantService.getTenantById(tenantId);
      if (!tenant) {
        return null;
      }
      const { id, name, code, slug, status, billingTier, defaultCurrency, timezone, quotas, membershipCounts } = tenant;
      return { id, name, code, slug, status, billingTier, defaultCurrency, timezone, quotas, membershipCounts };
    } catch (error) {
      logger.warn('[data-export] failed to load tenant metadata', { tenantId, error });
      return null;
    }
  }

  private async getTenantMembershipSnapshot(tenantId: string): Promise<ExportedTenantMembership[]> {
    if (!tenantId) {
      return [];
    }
    try {
      const memberships = await tenantService.getActiveMembershipsForTenant(tenantId);
      const sanitized: ExportedTenantMembership[] = memberships
        .map((membership) => ({
          email: membership.email?.toLowerCase?.() ?? '',
          role: membership.role,
          status: membership.status,
          displayName: membership.displayName ?? null,
          userId: membership.userId,
        }))
        .filter((entry) => Boolean(entry.email));
      return sanitized;
    } catch (error) {
      logger.warn('[data-export] failed to load tenant memberships', { tenantId, error });
      return [];
    }
  }

  private async buildBackendHeaders(baseUrl: string): Promise<Record<string, string>> {
    const token = await internalTokenManager.getToken(baseUrl);
    if (!token) {
      throw new Error('Sign in again to export data. Authentication token missing.');
    }
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  private async fetchTenantExportPayload(tenantId: string): Promise<BackendTenantExportResponse> {
    const baseUrl = this.resolveBackendBaseUrl();
    const endpoint = `${baseUrl}/tenants/${tenantId}/export`;

    let headers = await this.buildBackendHeaders(baseUrl);
    let response: Response;
    try {
      response = await fetch(endpoint, { method: 'GET', headers });
    } catch (error) {
      logger.error('[data-export] backend request failed', error);
      throw new Error('Unable to reach the export service. Check your connection and try again.');
    }

    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await this.buildBackendHeaders(baseUrl);
      try {
        response = await fetch(endpoint, { method: 'GET', headers });
      } catch (error) {
        logger.error('[data-export] backend retry failed', error);
        throw new Error('Unable to reach the export service. Check your connection and try again.');
      }
    }

    const raw = await response.text();
    maybeShowMaintenanceAlertFromRaw(response.status, raw);
    let parsed: BackendTenantExportResponse | { error?: string; message?: string } | null = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        logger.error('[data-export] invalid JSON payload from backend', error);
      }
    }

    if (!response.ok) {
      const code = typeof parsed?.error === 'string' ? parsed.error : `http_${response.status}`;
      throw new Error(this.describeBackendExportError(code));
    }

    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Received malformed export payload from backend.');
    }

    return parsed as BackendTenantExportResponse;
  }
  
  /**
   * Export all application data to JSON format
   */
  async exportAllData(tenantId: string, userEmail: string): Promise<ExportData> {
    try {
      if (!tenantId) {
        throw new Error('tenantId is required to export data');
      }
      logger.debug('Starting data export for user:', userEmail);
      
      const backendPayload = await this.fetchTenantExportPayload(tenantId);
      const students = Array.isArray(backendPayload.students) ? backendPayload.students : [];
      const fees = Array.isArray(backendPayload.fees) ? backendPayload.fees : [];
      const attendance = Array.isArray(backendPayload.attendance) ? backendPayload.attendance : [];
      const deviceTracking = Array.isArray(backendPayload.deviceTracking) ? backendPayload.deviceTracking : [];
      const quotesNotifications = Array.isArray(backendPayload.quotes) ? backendPayload.quotes : [];
      const datasetCounts = backendPayload.statistics?.datasetCounts ?? {};

      const [tenantSnapshot, membershipSnapshot] = await Promise.all([
        this.getTenantExportMetadata(tenantId),
        this.getTenantMembershipSnapshot(tenantId),
      ]);
      const membershipEmails = Array.from(new Set(membershipSnapshot.map((member) => member.email)));

      logger.debug('[data-export] backend payload received', {
        tenantId,
        totalDocuments: backendPayload.statistics?.totalDocuments ?? 0,
        datasetKeys: Object.keys(datasetCounts),
      });

      // Fetch app settings
      const settingsData = await this.getAppSettings();
      
      // Fetch user profile
      const profileData = await this.getUserProfile();
      
      // Fetch dashboard data
      const dashboardData = await this.getDashboardData(students, fees);
      
      // Fetch app configuration
      const appConfiguration = await this.getAppConfiguration();

      const metadata = {
        totalStudents: typeof datasetCounts.students === 'number' ? datasetCounts.students : students.length,
        totalFees: typeof datasetCounts.fees === 'number' ? datasetCounts.fees : fees.length,
        totalAttendance: typeof datasetCounts.attendance === 'number' ? datasetCounts.attendance : attendance.length,
        totalDevices: typeof datasetCounts.deviceTracking === 'number' ? datasetCounts.deviceTracking : deviceTracking.length,
        totalNotifications: dashboardData.notifications.length,
        totalMembers: membershipSnapshot.length,
        appVersion: backendPayload.meta?.version || '1.0.0',
      };
      
      const exportData: ExportData = {
        version: backendPayload.meta?.version || '2.1.0',
        exportDate: backendPayload.meta?.generatedAt || new Date().toISOString(),
        exportedBy: backendPayload.meta?.exportedBy || userEmail,
        tenant: tenantSnapshot,
        metadata,
        students,
        fees,
        attendance,
        deviceTracking,
        quotesNotifications,
        memberships: membershipSnapshot,
        settings: settingsData,
        profile: profileData,
        authorizedEmails: membershipEmails,
        dashboardData,
        appConfiguration
      };
      
      logger.debug('Data export completed successfully via backend');
      return exportData;
      
    } catch (error) {
      logger.error('Error exporting data:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }
  
  /**
   * Import data from JSON and restore to Firestore
   */
  async importAllData(tenantId: string, importData: any, userEmail: string): Promise<ImportResult> {
    const result: ImportResult = {
      success: false,
      message: '',
      errors: [],
      imported: {
        students: 0,
        fees: 0,
        attendance: 0,
        deviceTracking: 0,
        quotesNotifications: 0,
        settings: false,
        profile: false,
        authorizedEmails: 0,
        dashboardData: false
      }
    };
    
    try {
      if (!tenantId) {
        throw new Error('tenantId is required to import data');
      }
      logger.debug('Starting data import for user:', userEmail);
      const db = getFirestore();
      
      // Validate import data structure
      const validation = this.validateImportData(importData);
      if (!validation.valid) {
        throw new Error(`Invalid import data: ${validation.errors.join(', ')}`);
      }
      
      // Import students
      if (importData.students && Array.isArray(importData.students)) {
        const baseUrl = this.resolveBackendBaseUrl();
        let headers = await this.buildBackendHeaders(baseUrl);

        for (const student of importData.students) {
          try {
            const { id, ...studentData } = student;
            let response = await fetch(`${baseUrl}/students/create`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ tenantId, studentData, createdBy: userEmail }),
            });

            if (response.status === 401) {
              await internalTokenManager.forceRefresh(baseUrl);
              headers = await this.buildBackendHeaders(baseUrl);
              response = await fetch(`${baseUrl}/students/create`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenantId, studentData, createdBy: userEmail }),
              });
            }

            if (!response.ok) {
              const msg = await response.text().catch(() => '');
              maybeShowMaintenanceAlertFromRaw(response.status, msg);
              throw new Error(msg || `HTTP ${response.status}`);
            }

            result.imported.students++;
          } catch (error) {
            result.errors.push(`Failed to import student ${student.name}: ${error}`);
          }
        }
        logger.debug(`Imported ${result.imported.students} students`);
      }
      
      // Import fee records
      if (importData.fees && Array.isArray(importData.fees)) {
        // Direct Firestore access as workaround for import issue
        for (const fee of importData.fees) {
          try {
            // Remove the id field to let Firebase generate new ones
            const { id, ...feeData } = fee;
            await addDoc(collection(db, 'fees'), {
              ...feeData,
              tenantId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            result.imported.fees++;
          } catch (error) {
            result.errors.push(`Failed to import fee record for ${fee.studentName}: ${error}`);
          }
        }
        logger.debug(`Imported ${result.imported.fees} fee records`);
      }
      
      // Import attendance records
      if (importData.attendance && Array.isArray(importData.attendance)) {
        const attendanceImportSummary = {
          successCount: 0,
          studentIds: new Set<string>(),
          dates: new Set<string>(),
        };
        for (const attendance of importData.attendance) {
          try {
            const { id, ...attendanceData } = attendance;
            await addDoc(collection(db, 'attendance'), {
              ...attendanceData,
              tenantId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            result.imported.attendance++;
            attendanceImportSummary.successCount += 1;
            if (attendance.studentId) {
              attendanceImportSummary.studentIds.add(String(attendance.studentId));
            }
            if (attendance.date) {
              attendanceImportSummary.dates.add(String(attendance.date));
            }
          } catch (error) {
            result.errors.push(`Failed to import attendance record: ${error}`);
          }
        }
        logger.debug(`Imported ${result.imported.attendance} attendance records`);
        if (attendanceImportSummary.successCount > 0) {
          await this.logAttendanceSyncAudit({
            tenantId,
            importedCount: attendanceImportSummary.successCount,
            attemptedCount: importData.attendance.length,
            studentIds: Array.from(attendanceImportSummary.studentIds),
            dates: Array.from(attendanceImportSummary.dates),
            actorEmailFallback: userEmail,
            errorCount: importData.attendance.length - attendanceImportSummary.successCount,
            source: 'data_import',
          });
        }
      }
      
      // Import device tracking records
      if (importData.deviceTracking && Array.isArray(importData.deviceTracking)) {
        for (const device of importData.deviceTracking) {
          try {
            const { id, ...deviceData } = device;
            await addDoc(collection(db, 'deviceTracking'), {
              ...deviceData,
              tenantId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            result.imported.deviceTracking++;
          } catch (error) {
            result.errors.push(`Failed to import device tracking record: ${error}`);
          }
        }
        logger.debug(`Imported ${result.imported.deviceTracking} device tracking records`);
      }
      
      // Import quotes/notifications
      if (importData.quotesNotifications && Array.isArray(importData.quotesNotifications)) {
        for (const quote of importData.quotesNotifications) {
          try {
            const { id, ...quoteData } = quote;
            await addDoc(collection(db, 'quotes'), {
              ...quoteData,
              tenantId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            result.imported.quotesNotifications++;
          } catch (error) {
            result.errors.push(`Failed to import quote/notification: ${error}`);
          }
        }
        logger.debug(`Imported ${result.imported.quotesNotifications} quotes/notifications`);
      }
      
      // Import settings
      if (importData.settings) {
        try {
          await AsyncStorage.setItem('appSettings', JSON.stringify(importData.settings));
          result.imported.settings = true;
          logger.debug('Imported app settings');
        } catch (error) {
          result.errors.push(`Failed to import settings: ${error}`);
        }
      }
      
      // Import profile
      if (importData.profile) {
        try {
          await AsyncStorage.setItem('userProfile', JSON.stringify(importData.profile));
          result.imported.profile = true;
          logger.debug('Imported user profile');
        } catch (error) {
          result.errors.push(`Failed to import profile: ${error}`);
        }
      }
      
      // Import authorized emails (only for admin)
      if (importData.authorizedEmails && Array.isArray(importData.authorizedEmails)) {
        try {
          await firebaseAuthService.updateAuthorizedEmails(importData.authorizedEmails);
          result.imported.authorizedEmails = importData.authorizedEmails.length;
          logger.debug(`Imported ${result.imported.authorizedEmails} authorized emails`);
        } catch (error) {
          result.errors.push(`Failed to import authorized emails: ${error}`);
        }
      }
      
      // Import dashboard data
      if (importData.dashboardData) {
        try {
          await AsyncStorage.setItem('dashboardData', JSON.stringify(importData.dashboardData));
          result.imported.dashboardData = true;
          logger.debug('Imported dashboard data');
        } catch (error) {
          result.errors.push(`Failed to import dashboard data: ${error}`);
        }
      }
      
      result.success = true;
      result.message = `Successfully imported data: ${result.imported.students} students, ${result.imported.fees} fee records, ${result.imported.attendance} attendance records, ${result.imported.deviceTracking} device tracking records, ${result.imported.quotesNotifications} quotes/notifications`;
      
      if (result.errors.length > 0) {
        result.message += `. ${result.errors.length} errors occurred.`;
      }
      
      logger.debug('Data import completed:', result);
      return result;
      
    } catch (error) {
      logger.error('Error importing data:', error);
      result.success = false;
      result.message = `Failed to import data: ${error}`;
      result.errors.push(String(error));
      return result;
    }
  }

  private async logAttendanceSyncAudit(options: {
    tenantId: string;
    importedCount: number;
    attemptedCount: number;
    studentIds: string[];
    dates: string[];
    actorEmailFallback?: string;
    errorCount?: number;
    source?: 'data_import' | 'manual_sync';
  }): Promise<void> {
    if (!options.tenantId || options.importedCount <= 0) {
      return;
    }
    const actor = firebaseAuthService.getCurrentUser();
    const sortedDates = options.dates.filter(Boolean).sort();
    const metadata: Record<string, unknown> = {
      source: options.source ?? 'data_import',
      importedCount: options.importedCount,
      attemptedCount: options.attemptedCount,
      errorCount: options.errorCount ?? Math.max(options.attemptedCount - options.importedCount, 0),
      studentIds: options.studentIds,
      dates: sortedDates,
    };
    if (sortedDates.length > 0) {
      metadata.dateRange = { start: sortedDates[0], end: sortedDates[sortedDates.length - 1] };
    }
    try {
      await tenantService.logAuditEvent({
        tenantId: options.tenantId,
        actorId: actor?.uid ?? 'system',
        actorEmail: actor?.email ?? options.actorEmailFallback,
        action: options.importedCount > 1 ? 'attendance_records_batch_saved' : 'attendance_record_saved',
        targetType: 'attendance',
        metadata,
      });
    } catch (error) {
      logger.debug('[data-management] attendance audit log skipped', error);
    }
  }
  
  /**
   * Validate import data structure
   */
  private validateImportData(data: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!data || typeof data !== 'object') {
      errors.push('Import data must be a valid JSON object');
      return { valid: false, errors };
    }
    
    // Check version compatibility
    if (!data.version) {
      errors.push('Missing version information');
    }
    
    // Validate students array
    if (data.students && !Array.isArray(data.students)) {
      errors.push('Students data must be an array');
    }
    
    // Validate fees array
    if (data.fees && !Array.isArray(data.fees)) {
      errors.push('Fees data must be an array');
    }
    
    // Validate each student record
    if (data.students && Array.isArray(data.students)) {
      data.students.forEach((student: any, index: number) => {
        if (!student.name) {
          errors.push(`Student at index ${index} is missing name`);
        }
        if (!student.grade) {
          errors.push(`Student at index ${index} is missing grade`);
        }
        if (!student.parentContact) {
          errors.push(`Student at index ${index} is missing parent contact`);
        }
      });
    }
    
    // Validate each fee record
    if (data.fees && Array.isArray(data.fees)) {
      data.fees.forEach((fee: any, index: number) => {
        if (!fee.studentId && !fee.studentName) {
          errors.push(`Fee record at index ${index} is missing student reference`);
        }
        if (typeof fee.amount !== 'number') {
          errors.push(`Fee record at index ${index} has invalid amount`);
        }
        if (!fee.dueDate) {
          errors.push(`Fee record at index ${index} is missing due date`);
        }
      });
    }
    
    return { valid: errors.length === 0, errors };
  }
  
  /**
   * Get current app settings
   */
  private async getAppSettings() {
    try {
      const settings = await AsyncStorage.getItem('appSettings');
      return settings ? JSON.parse(settings) : {
        isDarkMode: false,
        notifications: true,
        emailReminders: true,
        smsReminders: true,
        whatsappReminders: true,
        specialMessages: true
      };
    } catch (error) {
      logger.error('Error getting app settings:', error);
      return {};
    }
  }
  
  /**
   * Get current user profile
   */
  private async getUserProfile() {
    try {
      const profile = await AsyncStorage.getItem('userProfile');
      return profile ? JSON.parse(profile) : {};
    } catch (error) {
      logger.error('Error getting user profile:', error);
      return {};
    }
  }
  
  /**
   * Get dashboard data including notifications and stats
   */
  private async getDashboardData(students: any[], fees: any[]) {
    try {
      // Generate dashboard statistics
      const totalStudents = students.length;
      const paidFees = fees.filter(fee => fee.status === 'Paid');
      const pendingFees = fees.filter(fee => fee.status === 'Pending' || fee.status === 'Overdue');
      const monthlyRevenue = paidFees.reduce((sum, fee) => sum + fee.amount, 0);
      const pendingAmount = pendingFees.reduce((sum, fee) => sum + fee.amount, 0);
      
      // Generate recent notifications
      const notifications = [
        { 
          id: 1, 
          message: "Data export completed successfully", 
          time: new Date().toISOString(), 
          type: "system" 
        },
        ...pendingFees.slice(0, 5).map((fee, index) => ({
          id: index + 2,
          message: `Fee reminder pending for ${fee.studentName}`,
          time: new Date(fee.dueDate).toISOString(),
          type: "fee"
        }))
      ];
      
      // Generate recent activity
      const recentActivity = [
        ...fees.slice(-10).map(fee => ({
          type: 'fee',
          description: `Fee ${fee.status.toLowerCase()} for ${fee.studentName}`,
          timestamp: fee.paidDate || fee.createdAt || new Date().toISOString(),
          amount: fee.amount
        }))
      ];
      
      return {
        notifications,
        stats: {
          totalStudents,
          monthlyRevenue,
          pendingAmount,
          paidCount: paidFees.length,
          pendingCount: pendingFees.length
        },
        recentActivity
      };
    } catch (error) {
      logger.error('Error generating dashboard data:', error);
      return {
        notifications: [],
        stats: {},
        recentActivity: []
      };
    }
  }
  
  /**
   * Get app configuration
   */
  private async getAppConfiguration() {
    try {
      const config = await AsyncStorage.getItem('appConfiguration');
      return config ? JSON.parse(config) : {
        theme: 'system',
        language: 'en',
        currency: 'INR',
        dateFormat: 'DD/MM/YYYY',
        features: {
          emailReminders: true,
          smsReminders: true,
          whatsappReminders: true,
          voiceCall: true,
          bulkReminders: true,
          dataExport: true,
          dataImport: true
        }
      };
    } catch (error) {
      logger.error('Error getting app configuration:', error);
      return {};
    }
  }
  
  /**
   * Generate a formatted filename for export
   */
  generateExportFilename(prefix: string = 'tuition_data'): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    return `${prefix}_${dateStr}_${timeStr}.json`;
  }

  private backupKeyPrefix(tenantId: string): string {
    if (!tenantId) {
      throw new Error('tenantId is required for backup operations');
    }
    return `backup_${tenantId}_`;
  }

  private buildBackupKey(tenantId: string, timestamp: number = Date.now()): string {
    return `${this.backupKeyPrefix(tenantId)}${timestamp}`;
  }
  
  /**
   * Create a backup before importing new data
   */
  async createBackup(tenantId: string, userEmail: string): Promise<string> {
    try {
      const backupData = await this.exportAllData(tenantId, userEmail);
      const backupJson = JSON.stringify(backupData, null, 2);
      
      // Store backup in AsyncStorage with timestamp
      const backupKey = this.buildBackupKey(tenantId);
      await AsyncStorage.setItem(backupKey, backupJson);
      
      logger.debug('Backup created with key:', backupKey);
      return backupKey;
    } catch (error) {
      logger.error('Error creating backup:', error);
      throw error;
    }
  }
  
  /**
   * Restore from a backup
   */
  async restoreFromBackup(tenantId: string, backupKey: string, userEmail: string): Promise<ImportResult> {
    try {
      if (!backupKey.startsWith(this.backupKeyPrefix(tenantId))) {
        throw new Error('Backup not found for this coaching center');
      }
      const backupJson = await AsyncStorage.getItem(backupKey);
      if (!backupJson) {
        throw new Error('Backup not found');
      }
      
      const backupData = JSON.parse(backupJson);
      return await this.importAllData(tenantId, backupData, userEmail);
    } catch (error) {
      logger.error('Error restoring from backup:', error);
      throw error;
    }
  }
  
  /**
   * List all available backups
   */
  async listBackups(tenantId: string): Promise<Array<{ key: string; date: string; size: number }>> {
    try {
      const prefix = this.backupKeyPrefix(tenantId);
      const allKeys = await AsyncStorage.getAllKeys();
      const backupKeys = allKeys.filter(key => key.startsWith(prefix));
      
      const backups = [];
      for (const key of backupKeys) {
        try {
          const data = await AsyncStorage.getItem(key);
          if (data) {
            const timestamp = parseInt(key.replace(prefix, ''));
            backups.push({
              key,
              date: new Date(timestamp).toISOString(),
              size: new Blob([data]).size
            });
          }
        } catch (error) {
          logger.error(`Error reading backup ${key}:`, error);
        }
      }
      
      return backups.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    } catch (error) {
      logger.error('Error listing backups:', error);
      return [];
    }
  }
  
  /**
   * Delete old backups (keep only the latest 5)
   */
  async cleanupOldBackups(tenantId: string): Promise<void> {
    try {
      const backups = await this.listBackups(tenantId);
      if (backups.length > 5) {
        const oldBackups = backups.slice(5);
        const keysToDelete = oldBackups.map(backup => backup.key);
        await AsyncStorage.multiRemove(keysToDelete);
        logger.debug(`Deleted ${keysToDelete.length} old backups`);
      }
    } catch (error) {
      logger.error('Error cleaning up old backups:', error);
    }
  }
}

export const dataManagementService = new DataManagementService();
