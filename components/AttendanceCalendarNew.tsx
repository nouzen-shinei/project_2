import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Calendar, ChevronLeft, ChevronRight, X, Save, Users, User, Edit3, Eye, AlertCircle } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { formatDateToString } from '../lib/utils';
import Toast from 'react-native-toast-message';
import ConfirmationModal from './ConfirmationModal';

const { width: screenWidth } = Dimensions.get('window');

export interface AttendanceRecord {
  id: string;
  studentId: string;
  date: string; // YYYY-MM-DD format
  status: 'present' | 'absent' | 'late' | 'excused';
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Student {
  id: string;
  name: string;
  grade: string;
  status: 'active' | 'inactive' | 'suspended';
}

interface AttendanceCalendarProps {
  visible: boolean;
  onClose: () => void;
  student?: Student; // If provided, shows individual student view
  students?: Student[]; // If provided, shows all students view
  attendanceRecords: AttendanceRecord[];
  onSaveAttendance: (records: AttendanceRecord[]) => Promise<void>;
  mode?: 'individual' | 'all'; // Toggle between individual and all students view
  showModeToggle?: boolean; // Whether to show the individual/all toggle
}

export default function AttendanceCalendar({
  visible,
  onClose,
  student,
  students = [],
  attendanceRecords,
  onSaveAttendance,
  mode = 'individual',
  showModeToggle = true
}: AttendanceCalendarProps) {
  const { theme } = useTheme();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [studentViewMode, setStudentViewMode] = useState<'individual' | 'all'>(mode);
  const [displayMode, setDisplayMode] = useState<'list' | 'calendar'>('calendar');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedDayStudents, setSelectedDayStudents] = useState<{present: Student[], absent: Student[]}>({
    present: [],
    absent: []
  });
  const [modifiedRecords, setModifiedRecords] = useState<AttendanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [dayDetailsModalVisible, setDayDetailsModalVisible] = useState(false);
  
  // Confirmation modal states
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [discardAction, setDiscardAction] = useState<'cancel' | 'toggle'>('cancel');

  // Filter active students with case-insensitive comparison
  const activeStudents = students.filter(s => 
    s.status.toLowerCase() === 'active'
  );

  const displayStudents = studentViewMode === 'all' ? activeStudents : (student ? [student] : []);

  useEffect(() => {
    if (visible) {
      setModifiedRecords([]);
      setSelectedDate(null);
      setSelectedDayStudents({ present: [], absent: [] });
      setStudentViewMode(mode);
      setDisplayMode('calendar');
      setIsEditMode(false); // Start in view mode
      setDayDetailsModalVisible(false);
    }
  }, [visible, mode]);

  // Helper functions
  const formatDate = (date: Date): string => {
    return formatDateToString(date);
  };

  const isToday = (date: Date): boolean => {
    const today = new Date();
    return formatDate(date) === formatDate(today);
  };

  const isFutureDate = (date: Date): boolean => {
    const today = new Date();
    const dateString = formatDate(date);
    const todayString = formatDate(today);
    return dateString > todayString;
  };

  const getAttendanceStatus = (studentId: string, date: string): 'present' | 'absent' | 'late' | 'excused' => {
    // First check modified records (recent changes) - these take priority
    const modifiedRecord = modifiedRecords.find(r => r.studentId === studentId && r.date === date);
    if (modifiedRecord) {
      return modifiedRecord.status;
    }
    
    // Then check existing attendance records
    const existingRecord = attendanceRecords.find(r => r.studentId === studentId && r.date === date);
    if (existingRecord) {
      return existingRecord.status;
    }
    
    // If no record exists, default to 'absent' instead of null
    return 'absent';
  };

  const updateAttendance = (studentId: string, date: string, status: 'present' | 'absent' | 'late' | 'excused') => {
    // Only allow updates in edit mode
    if (!isEditMode) return;
    
    const existingIndex = modifiedRecords.findIndex(r => r.studentId === studentId && r.date === date);
    const newRecord: AttendanceRecord = {
      id: `temp-${Date.now()}-${studentId}`,
      studentId,
      date,
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let updatedRecords;
    if (existingIndex >= 0) {
      updatedRecords = [...modifiedRecords];
      updatedRecords[existingIndex] = { ...updatedRecords[existingIndex], status, updatedAt: new Date().toISOString() };
    } else {
      updatedRecords = [...modifiedRecords, newRecord];
    }
    
    setModifiedRecords(updatedRecords);
  };

  // Calendar view helper functions
  const getDateAttendancePercentage = (date: Date): number => {
    const dateString = formatDate(date);
    
    // For individual view, only calculate for the selected student
    if (studentViewMode === 'individual' && student) {
      const status = getAttendanceStatus(student.id, dateString);
      return (status === 'present' || status === 'late') ? 100 : 0;
    }
    
    // For all students view, calculate percentage
    const presentCount = activeStudents.filter(studentItem => {
      const status = getAttendanceStatus(studentItem.id, dateString);
      return status === 'present' || status === 'late';
    }).length;
    
    const percentage = activeStudents.length > 0 ? Math.round((presentCount / activeStudents.length) * 100) : 0;
    
    return percentage;
  };

  const getAttendanceColorByPercentage = (percentage: number): string => {
    // For individual view, use simple present/absent colors
    if (studentViewMode === 'individual') {
      return percentage === 100 ? theme.success : theme.error;
    }
    
    // For all students view, use graduated colors
    if (percentage >= 90) return theme.success; // Green
    if (percentage >= 75) return theme.warning; // Yellow/Orange
    if (percentage >= 50) return '#F97316'; // Orange
    return theme.error; // Red
  };

  const updateSelectedDayStudents = (dateString: string) => {
    const present: Student[] = [];
    const absent: Student[] = [];
    
    activeStudents.forEach(student => {
      const status = getAttendanceStatus(student.id, dateString);
      if (status === 'present' || status === 'late') {
        present.push(student);
      } else {
        // If status is absent or excused, put in absent list
        absent.push(student);
      }
    });
    
    setSelectedDayStudents({ present, absent });
  };

  const handleDaySelect = (date: Date) => {
    const dateString = formatDate(date);
    setSelectedDate(dateString);
    updateSelectedDayStudents(dateString);
    setDayDetailsModalVisible(true);
  };

  const toggleStudentAttendance = (studentId: string, date: string) => {
    // Only allow updates in edit mode
    if (!isEditMode) return;
    
    const currentStatus = getAttendanceStatus(studentId, date);
    const newStatus = (currentStatus === 'present' || currentStatus === 'late') ? 'absent' : 'present';
    
    // Update attendance record
    updateAttendance(studentId, date, newStatus);
    
    // Update the selected day students list immediately for modal
    if (selectedDate === date) {
      const present: Student[] = [];
      const absent: Student[] = [];
      
      activeStudents.forEach(student => {
        let status;
        if (student.id === studentId) {
          // Use the new status for the toggled student
          status = newStatus;
        } else {
          // Get status normally for other students
          status = getAttendanceStatus(student.id, date);
        }
        
        if (status === 'present' || status === 'late') {
          present.push(student);
        } else {
          absent.push(student);
        }
      });
      
      setSelectedDayStudents({ present, absent });
    }
    
    // Force re-render of calendar by triggering state update
    setTimeout(() => {
      setCurrentDate(new Date(currentDate)); // Trigger re-render without changing the actual date
    }, 50);
  };

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();

    const days = [];
    
    // Add empty cells for days before the first day of the month
    for (let i = 0; i < startingDayOfWeek; i++) {
      days.push(null);
    }
    
    // Add all days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      days.push(new Date(year, month, day));
    }
    
    return days;
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    const newDate = new Date(currentDate);
    if (direction === 'prev') {
      newDate.setMonth(newDate.getMonth() - 1);
    } else {
      newDate.setMonth(newDate.getMonth() + 1);
    }
    setCurrentDate(newDate);
    setSelectedDate(null); // Clear selection when changing months
  };

  const getAttendanceColor = (status: string) => {
    switch (status) {
      case 'present':
        return theme.success;
      case 'absent':
        return theme.error;
      case 'late':
        return theme.warning;
      case 'excused':
        return theme.primary;
      default:
        return theme.error; // Default to absent color
    }
  };

  const getStatusSymbol = (status: string) => {
    switch (status) {
      case 'present':
        return '✓';
      case 'absent':
        return '✗';
      case 'late':
        return '⌚';
      case 'excused':
        return 'E';
      default:
        return '✗'; // Default to absent symbol
    }
  };

  const handleSave = async () => {
    try {
      setIsLoading(true);
      await onSaveAttendance(modifiedRecords);
      setModifiedRecords([]);
      setIsEditMode(false); // Return to view mode after saving
      Toast.show({
        type: 'success',
        text1: '✅ Attendance Saved',
        text2: 'Attendance records saved successfully',
        position: 'top',
        visibilityTime: 3000,
      });
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: '❌ Save Failed',
        text2: 'Failed to save attendance records',
        position: 'top',
        visibilityTime: 3000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditToggle = () => {
    if (isEditMode && modifiedRecords.length > 0) {
      // If there are unsaved changes, confirm before canceling edit mode
      setDiscardAction('toggle');
      setShowDiscardModal(true);
    } else {
      setIsEditMode(!isEditMode);
    }
  };

  const handleCancel = () => {
    if (isLoading) return;
    if (modifiedRecords.length > 0) {
      // If there are unsaved changes, confirm before canceling
      setDiscardAction('cancel');
      setShowDiscardModal(true);
    } else {
      setIsEditMode(false);
    }
  };

  const handleDiscardConfirm = () => {
    setModifiedRecords([]);
    setIsEditMode(false);
    setShowDiscardModal(false);
  };

  const days = getDaysInMonth(currentDate);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 15,
      borderBottomWidth: 1,
    },
    closeButton: {
      padding: 5,
    },
    headerCenter: {
      flex: 1,
      alignItems: 'center',
    },
    title: {
      fontSize: 18,
      fontWeight: 'bold',
    },
    subtitle: {
      fontSize: 14,
      marginTop: 2,
    },
    saveButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 15,
      paddingVertical: 8,
      borderRadius: 8,
    },
    editButton: {
      backgroundColor: '#007AFF',
    },
    saveButtonActive: {
      backgroundColor: '#34C759',
    },
    cancelButton: {
      backgroundColor: '#FF9500',
    },
    headerActionDisabled: {
      opacity: 0.5,
    },
    saveButtonText: {
      color: '#ffffff',
      marginLeft: 5,
      fontWeight: '600',
    },
    toggleContainer: {
      padding: 15,
    },
    modeToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 10,
      borderRadius: 8,
    },
    toggleLabel: {
      fontSize: 14,
      fontWeight: '600',
      marginRight: 10,
    },
    modeButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 6,
      borderWidth: 1,
      marginRight: 8,
    },
    modeButtonText: {
      fontSize: 14,
      fontWeight: '500',
      marginLeft: 6,
    },
    calendarHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 15,
    },
    navButton: {
      padding: 10,
      borderRadius: 8,
    },
    monthText: {
      fontSize: 18,
      fontWeight: 'bold',
    },
    daysHeader: {
      flexDirection: 'row',
      paddingVertical: 10,
    },
    dayHeaderText: {
      flex: 1,
      textAlign: 'center',
      fontSize: 14,
      fontWeight: '600',
    },
    content: {
      flex: 1,
      paddingHorizontal: 20,
    },
    calendarGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    dayCell: {
      width: `${100/7}%`,
      aspectRatio: 1,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 0.5,
      position: 'relative',
    },
    todayCell: {
      borderWidth: 2,
      borderColor: '#007AFF',
    },
    disabledCell: {
      opacity: 0.3,
      backgroundColor: '#f5f5f5',
    },
    selectedCell: {
      backgroundColor: '#007AFF20',
    },
    dayNumber: {
      fontSize: 16,
      fontWeight: '500',
      marginBottom: 4,
    },
    todayText: {
      color: '#007AFF',
      fontWeight: 'bold',
    },
    selectedText: {
      color: '#007AFF',
      fontWeight: 'bold',
    },
    percentageIndicator: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 10,
      minWidth: 30,
    },
    percentageText: {
      color: '#ffffff',
      fontSize: 10,
      fontWeight: 'bold',
      textAlign: 'center',
    },
    selectedDayDetails: {
      margin: 15,
      padding: 15,
      borderRadius: 8,
    },
    selectedDayTitle: {
      fontSize: 16,
      fontWeight: 'bold',
      marginBottom: 15,
    },
    studentSection: {
      marginBottom: 15,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      marginBottom: 8,
    },
    studentItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 12,
      borderRadius: 8,
      marginBottom: 8,
    },
    studentName: {
      fontSize: 16,
      fontWeight: '500',
      flex: 1,
    },
    statusBadge: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 15,
    },
    statusText: {
      color: '#ffffff',
      fontSize: 12,
      fontWeight: '600',
    },
    listDayContainer: {
      marginBottom: 20,
      padding: 15,
      borderRadius: 8,
    },
    listDayTitle: {
      fontSize: 16,
      fontWeight: 'bold',
      marginBottom: 12,
    },
    attendanceToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      borderBottomWidth: 1,
    },
    attendanceButton: {
      paddingHorizontal: 15,
      paddingVertical: 8,
      borderRadius: 20,
      minWidth: 80,
      alignItems: 'center',
    },
    attendanceButtonText: {
      color: '#ffffff',
      fontSize: 14,
      fontWeight: '600',
    },
    summaryContainer: {
      padding: 20,
      borderTopWidth: 1,
    },
    summaryText: {
      fontSize: 14,
      textAlign: 'center',
    },
    viewModeOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.05)',
      zIndex: 1,
    },
    editModeIndicator: {
      paddingVertical: 6,
      paddingHorizontal: 8,
      borderRadius: 4,
      marginHorizontal: 15,
      marginBottom: 10,
    },
    editModeText: {
      fontSize: 11,
      fontWeight: '600',
      textAlign: 'center',
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    dayDetailsModal: {
      backgroundColor: '#ffffff',
      margin: 20,
      borderRadius: 15,
      padding: 20,
      maxHeight: '80%',
      width: '90%',
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 20,
      paddingBottom: 15,
      borderBottomWidth: 1,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: 'bold',
      flex: 1,
    },
    modalCloseButton: {
      padding: 5,
    },
  });

  if (activeStudents.length === 0 && !student) {
    return (
      <Modal visible={visible} animationType="slide" transparent>
        <View style={[{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }]}>
          <View style={[{ backgroundColor: theme.surface, padding: 20, borderRadius: 15, margin: 20 }]}>
            <Text style={[{ color: theme.text, fontSize: 16, textAlign: 'center' }]}>
              No active students found
            </Text>
            <TouchableOpacity 
              style={[{ marginTop: 15, padding: 10, backgroundColor: theme.primary, borderRadius: 8 }]}
              onPress={onClose}
            >
              <Text style={[{ color: '#ffffff', textAlign: 'center', fontWeight: '600' }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <View>
      <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}>
        <View style={[styles.container, { backgroundColor: theme.surface, marginTop: 50, borderTopLeftRadius: 20, borderTopRightRadius: 20 }]}>
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <TouchableOpacity
              onPress={() => {
                if (!isLoading) onClose();
              }}
              style={[styles.closeButton, isLoading && styles.headerActionDisabled]}
              disabled={isLoading}
            >
              <X size={24} color={theme.text} />
            </TouchableOpacity>
            
            <View style={styles.headerCenter}>
              <Text style={[styles.title, { color: theme.text }]}>
                {studentViewMode === 'individual' ? `${student?.name || 'Student'} Attendance` : 'Class Attendance'}
              </Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </Text>
            </View>

            {/* Edit/Save Button */}
            {!isEditMode ? (
              <TouchableOpacity 
                style={[styles.saveButton, styles.editButton]} 
                onPress={handleEditToggle}
              >
                <Edit3 size={20} color="#ffffff" />
                <Text style={styles.saveButtonText}>Edit</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity 
                  style={[styles.saveButton, styles.cancelButton, isLoading && styles.headerActionDisabled]} 
                  onPress={handleCancel}
                  disabled={isLoading}
                >
                  <X size={20} color="#ffffff" />
                  <Text style={styles.saveButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[styles.saveButton, styles.saveButtonActive]} 
                  onPress={handleSave} 
                  disabled={isLoading || modifiedRecords.length === 0}
                >
                  <Save size={20} color="#ffffff" />
                  <Text style={styles.saveButtonText}>
                    {isLoading ? 'Saving...' : `Save (${modifiedRecords.length})`}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Mode Toggles */}
          <View style={[styles.toggleContainer, { backgroundColor: theme.background }]}>
            {/* Edit Mode Indicator */}
            {isEditMode && (
              <View style={[styles.editModeIndicator, { backgroundColor: '#34C759' }]}>
                <Text style={[styles.editModeText, { color: '#ffffff' }]}>
                  EDIT MODE - Click to modify attendance
                </Text>
              </View>
            )}
            
            {!isEditMode && (
              <View style={[styles.editModeIndicator, { backgroundColor: theme.primary }]}>
                <Text style={[styles.editModeText, { color: '#ffffff' }]}>
                  VIEW MODE - Click Edit to make changes
                </Text>
              </View>
            )}

            {/* Student View Toggle - Only show when showModeToggle is true */}
            {showModeToggle && (students.length > 0 || studentViewMode === 'all') && (
              <View style={[styles.modeToggle, { marginBottom: 10 }]}>
                <Text style={[styles.toggleLabel, { color: theme.textSecondary }]}>View:</Text>
                <TouchableOpacity
                  style={[
                    styles.modeButton,
                    {
                      backgroundColor: studentViewMode === 'individual' ? theme.primary : 'transparent',
                      borderColor: theme.primary,
                    }
                  ]}
                  onPress={() => setStudentViewMode('individual')}
                >
                  <User size={16} color={studentViewMode === 'individual' ? '#ffffff' : theme.primary} />
                  <Text style={[
                    styles.modeButtonText,
                    { color: studentViewMode === 'individual' ? '#ffffff' : theme.primary }
                  ]}>
                    Individual
                  </Text>
                </TouchableOpacity>
                
                <TouchableOpacity
                  style={[
                    styles.modeButton,
                    {
                      backgroundColor: studentViewMode === 'all' ? theme.primary : 'transparent',
                      borderColor: theme.primary,
                    }
                  ]}
                  onPress={() => setStudentViewMode('all')}
                >
                  <Users size={16} color={studentViewMode === 'all' ? '#ffffff' : theme.primary} />
                  <Text style={[
                    styles.modeButtonText,
                    { color: studentViewMode === 'all' ? '#ffffff' : theme.primary }
                  ]}>
                    All Students
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Display Mode Toggle - Always show */}
            <View style={styles.modeToggle}>
              <Text style={[styles.toggleLabel, { color: theme.textSecondary }]}>Display:</Text>
              <TouchableOpacity
                style={[
                  styles.modeButton,
                  {
                    backgroundColor: displayMode === 'calendar' ? theme.primary : 'transparent',
                    borderColor: theme.primary,
                  }
                ]}
                onPress={() => {
                  setDisplayMode('calendar');
                  setSelectedDate(null);
                }}
              >
                <Calendar size={16} color={displayMode === 'calendar' ? '#ffffff' : theme.primary} />
                <Text style={[
                  styles.modeButtonText,
                  { color: displayMode === 'calendar' ? '#ffffff' : theme.primary }
                ]}>
                  Calendar View
                </Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[
                  styles.modeButton,
                  {
                    backgroundColor: displayMode === 'list' ? theme.primary : 'transparent',
                    borderColor: theme.primary,
                  }
                ]}
                onPress={() => {
                  setDisplayMode('list');
                  setSelectedDate(null);
                }}
              >
                <Text style={[
                  styles.modeButtonText,
                  { color: displayMode === 'list' ? '#ffffff' : theme.primary }
                ]}>
                  List View
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Calendar Navigation */}
          <View style={[styles.calendarHeader, { backgroundColor: theme.surface }]}>
            <TouchableOpacity 
              style={[styles.navButton, { backgroundColor: theme.background }]}
              onPress={() => navigateMonth('prev')}
            >
              <ChevronLeft size={20} color={theme.text} />
            </TouchableOpacity>
            
            <Text style={[styles.monthText, { color: theme.text }]}>
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </Text>
            
            <TouchableOpacity 
              style={[styles.navButton, { backgroundColor: theme.background }]}
              onPress={() => navigateMonth('next')}
            >
              <ChevronRight size={20} color={theme.text} />
            </TouchableOpacity>
          </View>

          {/* Days Header - Only show for calendar view */}
          {displayMode === 'calendar' && (
            <View style={[styles.daysHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, borderBottomWidth: 1 }]}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <Text key={day} style={[styles.dayHeaderText, { color: theme.textSecondary }]}>
                  {day}
                </Text>
              ))}
            </View>
          )}

          {/* Content */}
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {displayMode === 'calendar' ? (
              // Calendar Grid View
              <View>
                {/* Instructions for individual mode */}
                {studentViewMode === 'individual' && student && (
                  <View style={{ padding: 10, backgroundColor: theme.background, borderRadius: 8, marginBottom: 15, borderColor: theme.border, borderWidth: 1 }}>
                    <Text style={{ color: theme.textSecondary, fontSize: 14, textAlign: 'center' }}>
                      {isEditMode 
                        ? `💡 Click on any day to toggle attendance for ${student.name}`
                        : `📊 View attendance for ${student.name}. Click Edit to make changes.`
                      }
                    </Text>
                  </View>
                )}
                
                <View style={[styles.calendarGrid, { position: 'relative' }]}>
                  {days.map((day: Date | null, index: number) => (
                    <TouchableOpacity
                      key={index}
                      style={[
                        styles.dayCell,
                        { borderColor: theme.border },
                        day && isToday(day) && styles.todayCell,
                        day && isFutureDate(day) && styles.disabledCell, // Add disabled styling for future dates
                        selectedDate === (day ? formatDate(day) : null) && styles.selectedCell
                      ]}
                      onPress={() => {
                        if (day && !isFutureDate(day)) { // Prevent selection of future dates
                          if (studentViewMode === 'individual' && student) {
                            // In individual mode, toggle attendance directly only in edit mode
                            if (isEditMode) {
                              const dateString = formatDate(day);
                              toggleStudentAttendance(student.id, dateString);
                            }
                          } else {
                            // In all students mode, always allow day selection
                            handleDaySelect(day);
                          }
                        }
                      }}
                      disabled={!day || isFutureDate(day)} // Disable future dates
                    >
                      {day && (
                        <View>
                          <Text style={[
                            styles.dayNumber,
                            { color: theme.text },
                            isToday(day) && styles.todayText,
                            isFutureDate(day) && { color: theme.textSecondary, opacity: 0.5 }, // Make future dates look disabled
                            selectedDate === formatDate(day) && styles.selectedText
                          ]}>
                            {day.getDate()}
                          </Text>
                          {/* Attendance percentage indicator */}
                          {(() => {
                            const percentage = getDateAttendancePercentage(day);
                            const color = getAttendanceColorByPercentage(percentage);
                            return (
                              <View style={[
                                styles.percentageIndicator,
                                { backgroundColor: color }
                              ]}>
                                <Text style={styles.percentageText}>
                                  {studentViewMode === 'individual' 
                                    ? (percentage === 100 ? 'P' : 'A')
                                    : `${percentage}%`
                                  }
                                </Text>
                              </View>
                            );
                          })()}
                        </View>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Day Details Modal */}
                <Modal
                  visible={dayDetailsModalVisible}
                  animationType="fade"
                  transparent
                  onRequestClose={() => setDayDetailsModalVisible(false)}
                >
                  <View style={styles.modalOverlay}>
                    <View style={[styles.dayDetailsModal, { backgroundColor: theme.surface }]}>
                      {/* Modal Header */}
                      <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
                        <Text style={[styles.modalTitle, { color: theme.text }]}>
                          {selectedDate ? new Date(selectedDate + 'T12:00:00').toDateString() : ''}
                        </Text>
                        <TouchableOpacity 
                          style={styles.modalCloseButton}
                          onPress={() => setDayDetailsModalVisible(false)}
                        >
                          <X size={24} color={theme.text} />
                        </TouchableOpacity>
                      </View>

                      {/* Modal Content */}
                      <ScrollView showsVerticalScrollIndicator={false}>
                        {/* Edit Mode Indicator in Modal */}
                        <View style={[styles.editModeIndicator, { backgroundColor: isEditMode ? '#34C759' : theme.primary, marginHorizontal: 0, marginBottom: 15 }]}>
                          <Text style={[styles.editModeText, { color: '#ffffff' }]}>
                            {isEditMode 
                              ? 'EDIT MODE - Click to toggle attendance'
                              : 'VIEW MODE - Click Edit to make changes'
                            }
                          </Text>
                        </View>

                        {/* Present Students */}
                        <View style={styles.studentSection}>
                          <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>
                            Present ({selectedDayStudents.present.length})
                          </Text>
                          {selectedDayStudents.present.map(student => (
                            <TouchableOpacity
                              key={student.id}
                              style={[
                                styles.studentItem, 
                                { backgroundColor: theme.background, borderColor: theme.border, borderWidth: 1 },
                                !isEditMode && { opacity: 0.7 }
                              ]}
                              onPress={() => {
                                if (isEditMode && selectedDate) {
                                  toggleStudentAttendance(student.id, selectedDate);
                                }
                              }}
                              disabled={!isEditMode}
                            >
                              <Text style={[styles.studentName, { color: theme.text }]}>
                                {student.name}
                              </Text>
                              <View style={[styles.statusBadge, { backgroundColor: theme.success }]}>
                                <Text style={styles.statusText}>Present</Text>
                              </View>
                            </TouchableOpacity>
                          ))}
                        </View>

                        {/* Absent Students */}
                        <View style={styles.studentSection}>
                          <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>
                            Absent ({selectedDayStudents.absent.length})
                          </Text>
                          {selectedDayStudents.absent.map(student => (
                            <TouchableOpacity
                              key={student.id}
                              style={[
                                styles.studentItem, 
                                { backgroundColor: theme.background, borderColor: theme.border, borderWidth: 1 },
                                !isEditMode && { opacity: 0.7 }
                              ]}
                              onPress={() => {
                                if (isEditMode && selectedDate) {
                                  toggleStudentAttendance(student.id, selectedDate);
                                }
                              }}
                              disabled={!isEditMode}
                            >
                              <Text style={[styles.studentName, { color: theme.text }]}>
                                {student.name}
                              </Text>
                              <View style={[styles.statusBadge, { backgroundColor: theme.error }]}>
                                <Text style={styles.statusText}>Absent</Text>
                              </View>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </ScrollView>
                    </View>
                  </View>
                </Modal>

                {/* Instructions for all students mode */}
                {studentViewMode === 'all' && (
                  <View style={{ padding: 10, backgroundColor: theme.background, borderRadius: 8, marginTop: 15, borderColor: theme.border, borderWidth: 1 }}>
                    <Text style={{ color: theme.textSecondary, fontSize: 14, textAlign: 'center' }}>
                      📅 Click on any day to view attendance details for all students
                    </Text>
                  </View>
                )}

                {/* Selected Day Details - Only for All Students mode */}
                {/* This section is now replaced by the modal above */}
              </View>
            ) : (
              // List View (Original functionality)
              <View>
                {days.filter(day => day !== null).map((day: Date) => {
                  const dateString = formatDate(day);
                  const isTodayDay = isToday(day);
                  
                  return (
                    <View key={dateString} style={[
                      styles.listDayContainer,
                      { backgroundColor: theme.background, borderColor: theme.border, borderWidth: 1 },
                      isTodayDay && { borderColor: theme.primary, borderWidth: 2 }
                    ]}>
                      <Text style={[styles.listDayTitle, { color: theme.text }]}>
                        {day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                        {isTodayDay ? ' (Today)' : ''}
                      </Text>
                      
                      {displayStudents.map(studentItem => {
                        const status = getAttendanceStatus(studentItem.id, dateString);
                        
                        return (
                          <View
                            key={studentItem.id}
                            style={[
                              styles.attendanceToggle, 
                              { borderBottomColor: theme.border },
                              !isEditMode && { opacity: 0.7 }
                            ]}
                          >
                            <Text style={[{ color: theme.text, fontSize: 16, flex: 1 }]}>
                              {studentItem.name}
                            </Text>
                            <TouchableOpacity
                              style={[
                                styles.attendanceButton,
                                { backgroundColor: getAttendanceColor(status) },
                                !isEditMode && { opacity: 0.8 }
                              ]}
                              onPress={() => {
                                if (isEditMode) {
                                  const newStatus = status === 'present' ? 'absent' : 'present';
                                  updateAttendance(studentItem.id, dateString, newStatus);
                                }
                              }}
                              disabled={!isEditMode}
                            >
                              <Text style={styles.attendanceButtonText}>
                                {status === 'present' ? 'Present' : 
                                 status === 'late' ? 'Late' : 
                                 status === 'excused' ? 'Excused' : 'Absent'}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                    </View>
                  );
                })}
              </View>
            )}
          </ScrollView>

          {/* Summary */}
          {studentViewMode === 'individual' && student && (
            <View style={[styles.summaryContainer, { borderTopColor: theme.border }]}>
              <Text style={[styles.summaryText, { color: theme.textSecondary }]}>
                Attendance Rate: {(() => {
                  // Get all days from start of month up to today (inclusive)
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
                    daysToCount.push(formatDate(currentDay));
                    currentDay.setDate(currentDay.getDate() + 1);
                  }
                  
                  // Count present days using the same logic as display
                  const presentCount = daysToCount.filter(date => {
                    const status = getAttendanceStatus(student.id, date);
                    return status === 'present' || status === 'late';
                  }).length;
                  
                  const totalDays = daysToCount.length;
                  const percentage = totalDays > 0 ? Math.round((presentCount / totalDays) * 100) : 0;
                  return `${percentage}% (${presentCount}/${totalDays} days)`;
                })()}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Modal>

    <ConfirmationModal
      visible={showDiscardModal}
      onClose={() => setShowDiscardModal(false)}
      title="Unsaved Changes"
      message="You have unsaved changes. Do you want to discard them?"
      confirmText="Discard"
      cancelText="Keep Editing"
      onConfirm={handleDiscardConfirm}
      confirmStyle="destructive"
      icon={<AlertCircle size={32} color="#F56565" />}
    />
    </View>
  );
}
