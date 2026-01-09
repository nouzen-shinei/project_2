import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { attendanceService } from '../services/attendanceService';
import { formatDateToString } from '../lib/utils';
import type { AttendanceRecord } from '../types';
import { useTenant } from './useTenantContext';

export function useAttendance(studentIds: string[] = []) {
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { activeTenant, loading: tenantLoading } = useTenant();
  const tenantId = activeTenant?.id;

  const ensureTenant = useCallback(() => {
    if (!tenantId) {
      throw new Error('Select a coaching center to manage attendance');
    }
    return tenantId;
  }, [tenantId]);

  const studentIdsKey = useMemo(() => studentIds.join(','), [studentIds]);

  // Fetch attendance records for given student IDs
  const fetchAttendance = useCallback(async (ids: string[] = studentIds) => {
    if (ids.length === 0) return;
    if (!tenantId) {
      setAttendanceRecords((prev) => (prev.length === 0 ? prev : []));
      setError(tenantLoading ? null : 'No coaching center selected');
      return;
    }
    
    try {
      setLoading(true);
      setError(null);
      const records = await attendanceService.getMultipleStudentsAttendance(tenantId, ids);
      setAttendanceRecords(records);
    } catch (err) {
      logger.error('Error fetching attendance:', err);
      setError('Failed to fetch attendance records');
    } finally {
      setLoading(false);
    }
  }, [studentIdsKey, tenantId, tenantLoading]);

  // Fetch attendance for a specific date range
  const fetchAttendanceByDateRange = useCallback(async (
    ids: string[],
    startDate: string,
    endDate: string
  ) => {
    const scopedTenantId = ensureTenant();
    try {
      setLoading(true);
      setError(null);
      const records = await attendanceService.getAttendanceByDateRange(scopedTenantId, ids, startDate, endDate);
      setAttendanceRecords(records);
    } catch (err) {
      logger.error('Error fetching attendance by date range:', err);
      setError('Failed to fetch attendance records');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [ensureTenant]);

  // Save attendance records
  const saveAttendanceRecords = useCallback(async (records: Omit<AttendanceRecord, 'id' | 'tenantId'>[]) => {
    try {
      const scopedTenantId = ensureTenant();
      setLoading(true);
      setError(null);
      await attendanceService.batchSaveAttendanceRecords(scopedTenantId, records);
      
      // Refresh attendance records after saving
      await fetchAttendance();
    } catch (err) {
      logger.error('Error saving attendance records:', err);
      setError('Failed to save attendance records');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [ensureTenant, fetchAttendance]);

  // Save a single attendance record
  const saveAttendanceRecord = useCallback(async (record: Omit<AttendanceRecord, 'id' | 'tenantId'>) => {
    try {
      const scopedTenantId = ensureTenant();
      setLoading(true);
      setError(null);
      await attendanceService.saveAttendanceRecord(scopedTenantId, record);
      
      // Refresh attendance records after saving
      await fetchAttendance();
    } catch (err) {
      logger.error('Error saving attendance record:', err);
      setError('Failed to save attendance record');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [ensureTenant, fetchAttendance]);

  // Delete attendance record
  const deleteAttendanceRecord = useCallback(async (recordId: string) => {
    try {
      const scopedTenantId = ensureTenant();
      setLoading(true);
      setError(null);
      await attendanceService.deleteAttendanceRecord(scopedTenantId, recordId);
      
      // Refresh attendance records after deletion
      await fetchAttendance();
    } catch (err) {
      logger.error('Error deleting attendance record:', err);
      setError('Failed to delete attendance record');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [ensureTenant, fetchAttendance]);

  // Calculate attendance percentage for a student
  const getAttendancePercentage = useCallback((studentId: string): number => {
    // Get all days from start of current month up to today (inclusive)
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const daysToCount = [];
    
    // Generate all dates from start of month to today (inclusive)
    // Use local date to avoid timezone issues
    const currentDay = new Date(startOfMonth);
    const todayDay = today.getDate();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    
    while (currentDay.getMonth() === currentMonth && currentDay.getDate() <= todayDay) {
      daysToCount.push(formatDateToString(currentDay));
      currentDay.setDate(currentDay.getDate() + 1);
    }
    
    if (daysToCount.length === 0) return 0;
    
    // Count present days using the same logic as the attendance calendar
    const presentCount = daysToCount.filter(date => {
      const record = attendanceRecords.find(r => r.studentId === studentId && r.date === date);
      // If record exists, check its status; if not, it defaults to absent
      const status = record ? record.status : 'absent';
      return status === 'present' || status === 'late';
    }).length;
    
    return Math.round((presentCount / daysToCount.length) * 100);
  }, [attendanceRecords]);

    // Get number of days present for a student
  const getDaysPresent = useCallback((studentId: string): { present: number, total: number } => {
    // Get all days from start of current month up to today (inclusive)
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const daysToCount = [];
    
    // Generate all dates from start of month to today (inclusive)
    // Use local date to avoid timezone issues
    const currentDay = new Date(startOfMonth);
    const todayDay = today.getDate();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    
    while (currentDay.getMonth() === currentMonth && currentDay.getDate() <= todayDay) {
      daysToCount.push(formatDateToString(currentDay));
      currentDay.setDate(currentDay.getDate() + 1);
    }
    
    if (daysToCount.length === 0) return { present: 0, total: 0 };
    
    // Count present days using the same logic as the attendance calendar
    const presentCount = daysToCount.filter(date => {
      const record = attendanceRecords.find(r => r.studentId === studentId && r.date === date);
      // If record exists, check its status; if not, it defaults to absent
      const status = record ? record.status : 'absent';
      return status === 'present' || status === 'late';
    }).length;
    
    return { present: presentCount, total: daysToCount.length };
  }, [attendanceRecords]);

  // Get attendance summary for all students
  const getAttendanceSummary = useCallback(async (ids: string[] = studentIds) => {
    try {
      const scopedTenantId = ensureTenant();
      setLoading(true);
      setError(null);
      return await attendanceService.getAttendanceSummary(scopedTenantId, ids);
    } catch (err) {
      logger.error('Error getting attendance summary:', err);
      setError('Failed to get attendance summary');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [studentIds, ensureTenant]);

  // Get attendance record for specific student and date
  const getAttendanceRecord = useCallback((studentId: string, date: string): AttendanceRecord | null => {
    return attendanceRecords.find(record => 
      record.studentId === studentId && record.date === date
    ) || null;
  }, [attendanceRecords]);

  // Initial fetch when component mounts or studentIds change
  useEffect(() => {
    if (tenantLoading) {
      return;
    }

    if (studentIds.length > 0 && tenantId) {
      fetchAttendance(studentIds);
    } else if (!tenantId) {
      setAttendanceRecords([]);
    }
  }, [studentIdsKey, tenantId, tenantLoading, fetchAttendance]);

  return {
    attendanceRecords,
    loading,
    error,
    fetchAttendance,
    fetchAttendanceByDateRange,
    saveAttendanceRecords,
    saveAttendanceRecord,
    deleteAttendanceRecord,
    getAttendancePercentage,
    getDaysPresent,
    getAttendanceSummary,
    getAttendanceRecord,
  };
}
