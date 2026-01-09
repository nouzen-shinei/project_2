import { logger } from '@/lib/logger';
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  Image,
  Platform,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import { Plus, Search, MoveVertical as MoreVertical, User, Phone, Mail, MessageCircle, Calendar, BookOpen, TrendingUp, Clock, Camera, Upload, ChevronUp, ChevronDown, Users, Trash2, Download, Edit3 } from 'lucide-react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
import { ref, deleteObject, listAll } from 'firebase/storage';
import { collection, query, where, getDocs, deleteDoc, doc } from 'firebase/firestore';
import { storage , firestore } from '../../config/firebase';
import { MediaPickerUtil } from '../../lib/mediaPickerUtil';
import useStudents from '../../hooks/useStudents';
import { useAttendance } from '../../hooks/useAttendance';
import AttendanceCalendar from '../../components/AttendanceCalendarNew';
import type { Student } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useBirthdays } from '../../components/BirthdayProvider';
import { useAuth } from '../../hooks/useAuthUnified';
import { useRouter } from 'expo-router';
import Toast from 'react-native-toast-message';
import { formatDateToString } from '../../lib/utils';
import { chatService } from '../../services/chatService';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';
import { useTenant } from '@/hooks/useTenantContext';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import { uploadBlobViaBackend } from '../../services/backendStorageUploadService';
import UsageAlertInlineBanner from '@/components/UsageAlertInlineBanner';
import { useActiveUsageAlerts } from '@/hooks/useActiveUsageAlerts';
import { tryPresentModalAlert } from '@/services/modalAlertService';

const buildNewStudentTemplate = (tenantId: string): Omit<Student, 'id'> => ({
  tenantId,
  name: '',
  email: '',
  phone: '',
  grade: '',
  enrolledCourses: [],
  feesPaid: 0,
  totalFees: 0,
  parentName: '',
  parentPhone: '',
  parentEmail: '',
  parentContact: '',
  parentWhatsApp: '',
  parentRelation: 'Parent',
  address: '',
  dateOfBirth: '',
  emergencyContact: '',
  enrollmentDate: new Date().toISOString(),
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  subjects: [],
  attendance: 100,
  performance: 'Good',
  monthlyFee: 0,
  feeDueDate: 1,
  joinDate: formatDateToString(new Date()),
  order: 0,
});

export default function Students() {
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const { activeTenant, loading: tenantLoading } = useTenant();
  const { students: studentList, loading, error, addStudent, updateStudent, deleteStudent, moveStudentUp, moveStudentDown } = useStudents();
  const students = studentList as Student[];
  const tenantId = activeTenant?.id ?? '';
  const tenantUnavailable = !tenantLoading && !tenantId;

  const {
    highlightedAlert: studentUsageAlert,
    alertCount: studentUsageAlertCount,
    monthId: studentUsageMonthId,
    loading: studentUsageAlertLoading,
    error: studentUsageAlertError,
    refresh: refreshStudentUsageAlerts,
  } = useActiveUsageAlerts(activeTenant?.id ?? null, { metrics: ['students'] });
  const shouldShowStudentUsageBanner = Boolean(
    studentUsageAlertLoading || studentUsageAlertError || studentUsageAlertCount > 0,
  );

  // Must call all hooks unconditionally before any early returns
  const { headerCompensation } = useBirthdays();
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);
  
  // Attendance hook MUST be called before any early returns to keep hook order consistent
  const studentIds = students.map(s => s.id);
  const { 
    attendanceRecords, 
    loading: attendanceLoading, 
    saveAttendanceRecords,
    getAttendancePercentage,
    getDaysPresent
  } = useAttendance(studentIds);
  
  // Centralized offline-aware loading gate (prevents zeroed UI on cold offline start)
  const { showLoading: showOfflineLoadingStudents, offlineHint: offlineHintStudents } = useOfflineDataGate(
    [students],
    [loading]
  );
  // Don't early return here; do it later after all hooks are declared to keep hook order consistent
  
  // Helper function to get ordinal suffix for numbers
  const getOrdinalSuffix = (day: number): string => {
    if (day >= 11 && day <= 13) {
      return 'th';
    }
    switch (day % 10) {
      case 1:
        return 'st';
      case 2:
        return 'nd';
      case 3:
        return 'rd';
      default:
        return 'th';
    }
  };
  
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAttendanceModal, setShowAttendanceModal] = useState(false);
  const [selectedStudentForAttendance, setSelectedStudentForAttendance] = useState<Student | null>(null);
  const [attendanceMode, setAttendanceMode] = useState<'individual' | 'all'>('individual');
  const [formErrors, setFormErrors] = useState<{[key: string]: string}>({});
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [studentToDelete, setStudentToDelete] = useState<Student | null>(null);
  const [isDeletingStudent, setIsDeletingStudent] = useState(false);
  const [showDownloadConfirmModal, setShowDownloadConfirmModal] = useState(false);
  const [subjectsInputText, setSubjectsInputText] = useState('');
  const [newStudent, setNewStudent] = useState<Omit<Student, 'id'>>(() => buildNewStudentTemplate(tenantId));

  // Sync subjects input text with newStudent.subjects when modal opens or subjects change externally
  useEffect(() => {
    if (showAddModal && newStudent.subjects) {
      setSubjectsInputText(newStudent.subjects.join(', '));
    }
  }, [showAddModal, newStudent.subjects]);

  useEffect(() => {
    setNewStudent((prev) => (prev.tenantId === tenantId ? prev : { ...prev, tenantId }));
  }, [tenantId]);

  const filteredStudents = students.filter(student =>
    student.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    student.grade.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (student.subjects || []).some(subject => 
      subject.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  const performanceOptions = ['Excellent', 'Very Good', 'Good', 'Average', 'Needs Improvement'];

  const uploadProfileImage = async (imageUri: string, existingImageUrl?: string): Promise<string | null> => {
    try {
      setIsUploadingImage(true);
      
      // Delete old profile image if it exists
      if (existingImageUrl) {
        try {
          await chatService.deleteProfilePicture(existingImageUrl);
          logger.debug('Old student profile picture deleted successfully');
        } catch (deleteError) {
          logger.warn('Failed to delete old student profile picture:', deleteError);
          // Continue with upload even if deletion fails
        }
      }
      
      if (!tenantId) {
        throw new Error('Select a coaching center before uploading student profile images.');
      }
      
      // Convert image URI to blob for upload
      let blob: Blob;
      if (imageUri.startsWith('data:')) {
        // Handle base64 data URLs
        const response = await fetch(imageUri);
        blob = await response.blob();
      } else {
        // Handle file URIs
        const response = await fetch(imageUri);
        blob = await response.blob();
      }

      const timestamp = Date.now();
      const filename = `student_profile_${timestamp}.jpg`;
      const result = await uploadBlobViaBackend({
        tenantId,
        purpose: 'studentProfile',
        blob,
        contentType: blob.type || 'image/jpeg',
        filename,
      });

      return result.url;
    } catch (error) {
      logger.error('Error uploading profile image:', error);
      Alert.alert('Upload Error', 'Failed to upload profile image. Please try again.');
      return null;
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleSelectProfileImage = async () => {
    try {
      const result = await MediaPickerUtil.selectImageNoEdit();
      
      if (result && typeof result === 'object' && 'canceled' in result) {
        const typedResult = result as any;
        if (!typedResult.canceled && typedResult.assets && typedResult.assets.length > 0) {
          const imageUri = typedResult.assets[0].uri;
          setProfileImage(imageUri);
        }
      }
    } catch (error) {
      logger.error('Error selecting image:', error);
      Alert.alert('Error', 'Failed to select image. Please try again.');
    }
  };

  const getPerformanceColor = (performance: string) => {
    switch (performance) {
      case 'Excellent':
        return theme.success;
      case 'Very Good':
        return theme.primary;
      case 'Good':
        return theme.warning;
      case 'Average':
        return '#8B4513'; // Saddle brown
      case 'Needs Improvement':
        return theme.error;
      default:
        return theme.textSecondary;
    }
  };

  const validateForm = () => {
    const errors: {[key: string]: string} = {};
    
    // Required fields validation
    if (!newStudent.name.trim()) {
      errors.name = 'Student name is required';
    }
    
    if (!newStudent.grade.trim()) {
      errors.grade = 'Grade is required';
    }
    
    if (!newStudent.phone?.trim()) {
      errors.phone = 'Student phone number is required';
    } else if (!/^[\+]?[0-9\s\-()]{10,}$/.test(newStudent.phone)) {
      errors.phone = 'Please enter a valid phone number';
    }
    
    if (!newStudent.parentContact?.trim()) {
      errors.parentContact = 'Parent contact number is required';
    } else if (!/^[\+]?[0-9\s\-()]{10,}$/.test(newStudent.parentContact)) {
      errors.parentContact = 'Please enter a valid phone number';
    }
    
    if (!newStudent.parentName?.trim()) {
      errors.parentName = 'Parent/Guardian name is required';
    }
    
    if (!newStudent.monthlyFee || newStudent.monthlyFee <= 0) {
      errors.monthlyFee = 'Monthly fee is required and must be greater than 0';
    }
    
    if (!newStudent.feeDueDate || newStudent.feeDueDate < 1 || newStudent.feeDueDate > 31) {
      errors.feeDueDate = 'Fee due date is required and must be between 1 and 31';
    }
    
    // Optional field validations
    if (newStudent.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newStudent.email)) {
      errors.email = 'Please enter a valid email address';
    }
    
    if (newStudent.parentEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newStudent.parentEmail)) {
      errors.parentEmail = 'Please enter a valid parent email address';
    }
    
    if (newStudent.parentWhatsApp && !/^[\+]?[0-9\s\-()]{10,}$/.test(newStudent.parentWhatsApp)) {
      errors.parentWhatsApp = 'Please enter a valid WhatsApp number';
    }
    
    if (newStudent.emergencyContact && !/^[\+]?[0-9\s\-()]{10,}$/.test(newStudent.emergencyContact)) {
      errors.emergencyContact = 'Please enter a valid emergency contact number';
    }
    
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleAddStudent = async () => {
    try {
      // Prevent multiple submissions
      if (isAddingStudent) return;

      if (!tenantId) {
        Alert.alert('Select Coaching Center', 'Please select a coaching center before adding students.');
        return;
      }
      
      if (!validateForm()) {
        Alert.alert('Validation Error', 'Please fix the errors below and try again.');
        return;
      }

      setIsAddingStudent(true);

      let profileImageUrl = '';
      
      // Upload profile image if selected
      if (profileImage) {
        profileImageUrl = await uploadProfileImage(profileImage) || '';
      }

      // Create student data with profile image URL
      const studentData = {
        ...newStudent,
        tenantId,
        profileImageUrl,
      };

      await addStudent(studentData);
      setShowAddModal(false);
      resetForm();
      
      // Show success toast
      Toast.show({
        type: 'success',
        text1: '✅ Student Added',
        text2: `${newStudent.name} has been added successfully!`,
        position: 'top',
        visibilityTime: 3000,
      });
      
      Alert.alert('Success', 'Student added successfully!');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || '');
      const isStudentLimit = /student[_\s-]?limit[_\s-]?reached/i.test(message) || /student limit reached/i.test(message);

      if (isStudentLimit) {
        // Prefer a dedicated warning modal for plan limits.
        const cleaned = message
          .replace(/^Failed to add student:\s*/i, '')
          .trim();

        tryPresentModalAlert({
          title: 'Student limit reached',
          message: cleaned || 'You have reached the student limit for your plan. Remove inactive students or upgrade to add more.',
          variant: 'warning',
          buttons: [{ text: 'OK', style: 'primary' }],
        });
        return;
      }

      // Show error toast
      Toast.show({
        type: 'error',
        text1: '❌ Failed to Add Student',
        text2: 'Please try again or check your connection',
        position: 'top',
        visibilityTime: 3000,
      });
      
      Alert.alert('Error', 'Failed to add student. Please try again.');
    } finally {
      setIsAddingStudent(false);
    }
  };

  const resetForm = () => {
    setNewStudent(buildNewStudentTemplate(tenantId));
    setFormErrors({});
    setProfileImage(null);
    setSubjectsInputText('');
    setIsAddingStudent(false);
  };

  const handleMoveStudentUp = async (studentId: string) => {
    try {
      await moveStudentUp(studentId);
    } catch (err) {
      Alert.alert('Error', 'Failed to move student up. Please try again.');
    }
  };

  const handleMoveStudentDown = async (studentId: string) => {
    try {
      await moveStudentDown(studentId);
    } catch (err) {
      Alert.alert('Error', 'Failed to move student down. Please try again.');
    }
  };

  // Delete handlers
  const handleDeletePress = (student: Student) => {
    setStudentToDelete(student);
    setShowDeleteModal(true);
  };

  const deleteStudentCompletely = async (studentId: string, studentName: string) => {
    logger.debug(`🗑️ Starting complete deletion for student: ${studentName} (${studentId})`);
    
    // Show starting toast
    Toast.show({
      type: 'info',
      text1: '🗑️ Deleting Student',
      text2: `Removing ${studentName} and all related data...`,
      position: 'top',
      visibilityTime: 3000,
    });
    
    const deletionResults = {
      student: false,
      attendance: 0,
      fees: 0,
      profileImage: false,
      receipts: 0,
      errors: [] as string[]
    };

    try {
      // First, get all fee records for this student to find receipt folders
      let studentFeeIds: string[] = [];
      try {
        logger.debug('🗑️ Finding fee records for student...');
        const feesQuery = query(
          collection(firestore, 'fees'),
          where('studentId', '==', studentId)
        );
        const feesSnapshot = await getDocs(feesQuery);
        studentFeeIds = feesSnapshot.docs.map(doc => doc.id);
        logger.debug(`🗑️ Found ${studentFeeIds.length} fee records with IDs:`, studentFeeIds);
      } catch (error) {
        logger.warn('🗑️ Error getting fee records for receipt deletion:', error);
        deletionResults.errors.push(`Fee records query failed: ${error}`);
      }

      // 1. Delete student profile image from storage
      try {
        logger.debug('🗑️ Searching for profile images...');
        const profileImageRef = ref(storage, `student_profiles`);
        const profileList = await listAll(profileImageRef);
        
        logger.debug(`🗑️ Found ${profileList.items.length} files in student_profiles folder`);
        
        // Get student data to access profile image URL
        const student = students.find(s => s.id === studentId);
        
        for (const item of profileList.items) {
          logger.debug(`🗑️ Checking file: ${item.name}`);
          
          let shouldDelete = false;
          
          // Method 1: Check by student ID
          if (item.name.includes(studentId)) {
            shouldDelete = true;
            logger.debug(`🗑️ Match by student ID: ${studentId}`);
          }
          
          // Method 2: Check by student name variations
          if (!shouldDelete) {
            const nameVariations = [
              studentName.toLowerCase(),
              studentName.toLowerCase().replace(/\s+/g, '_'),
              studentName.toLowerCase().replace(/\s+/g, '-'),
              studentName.toLowerCase().replace(/\s+/g, ''),
              studentName.replace(/\s+/g, '_'),
              studentName.replace(/\s+/g, '-'),
              studentName.replace(/\s+/g, '')
            ];
            
            shouldDelete = nameVariations.some(variation => 
              item.name.toLowerCase().includes(variation)
            );
            if (shouldDelete) {
              logger.debug(`🗑️ Match by name variation`);
            }
          }
          
          // Method 3: If student has profile URL, extract filename and match
          if (!shouldDelete && student?.profileImageUrl) {
            try {
              const url = student.profileImageUrl;
              // Try different URL pattern matches
              const patterns = [
                /student_profiles%2F([^?&]+)/,
                /student_profiles\/([^?&]+)/,
                /\/([^\/]+)\?/
              ];
              
              for (const pattern of patterns) {
                const match = url.match(pattern);
                if (match) {
                  const fileName = decodeURIComponent(match[1]);
                  if (item.name === fileName) {
                    shouldDelete = true;
                    logger.debug(`🗑️ Match by profile URL filename: ${fileName}`);
                    break;
                  }
                }
              }
            } catch (urlError) {
              logger.warn(`🗑️ URL parsing error: ${urlError}`);
            }
          }
          
          if (shouldDelete) {
            try {
              await deleteObject(item);
              deletionResults.profileImage = true;
              logger.debug(`🗑️ ✅ Deleted profile image: ${item.name}`);
            } catch (deleteError) {
              logger.warn(`🗑️ Failed to delete ${item.name}:`, deleteError);
            }
          }
        }
      } catch (error) {
        logger.warn('🗑️ ❌ Error deleting profile images:', error);
        deletionResults.errors.push(`Profile image deletion failed: ${error}`);
      }

      // 2. Delete receipt files from storage using fee IDs and student name matching
      try {
        logger.debug('🗑️ Searching for receipts...');
        const receiptsRef = ref(storage, `receipts`);
        const receiptsList = await listAll(receiptsRef);
        
        logger.debug(`🗑️ Found ${receiptsList.items.length} folders in receipts directory`);
        
        // Method 1: Delete by fee IDs (primary method)
        for (const feeId of studentFeeIds) {
          try {
            const feeReceiptsRef = ref(storage, `receipts/${feeId}`);
            const feeReceiptsList = await listAll(feeReceiptsRef);
            logger.debug(`🗑️ Found ${feeReceiptsList.items.length} receipts in fee folder: ${feeId}`);
            
            for (const receiptItem of feeReceiptsList.items) {
              try {
                await deleteObject(receiptItem);
                deletionResults.receipts++;
                logger.debug(`🗑️ ✅ Deleted receipt: ${receiptItem.name} from fee folder: ${feeId}`);
              } catch (deleteError) {
                logger.warn(`🗑️ Failed to delete receipt ${receiptItem.name}:`, deleteError);
              }
            }
          } catch (error) {
            logger.warn(`🗑️ No receipts found for fee ID: ${feeId}`, error);
          }
        }
        
        // Method 2: Also check for receipts that might be stored by student name (fallback)
        for (const folderItem of receiptsList.items) {
          logger.debug(`🗑️ Checking receipt folder/file: ${folderItem.name}`);
          
          let shouldDelete = false;
          
          // Check by student ID
          if (folderItem.name.includes(studentId)) {
            shouldDelete = true;
            logger.debug(`🗑️ Receipt match by student ID: ${studentId}`);
          }
          
          // Check by student name variations
          if (!shouldDelete) {
            const nameVariations = [
              studentName.toLowerCase(),
              studentName.toLowerCase().replace(/\s+/g, '_'),
              studentName.toLowerCase().replace(/\s+/g, '-'),
              studentName.toLowerCase().replace(/\s+/g, ''),
              studentName.replace(/\s+/g, '_'),
              studentName.replace(/\s+/g, '-'),
              studentName.replace(/\s+/g, '')
            ];
            
            shouldDelete = nameVariations.some(variation => 
              folderItem.name.toLowerCase().includes(variation)
            );
            if (shouldDelete) {
              logger.debug(`🗑️ Receipt match by name variation`);
            }
          }
          
          if (shouldDelete) {
            try {
              await deleteObject(folderItem);
              deletionResults.receipts++;
              logger.debug(`🗑️ ✅ Deleted receipt: ${folderItem.name}`);
            } catch (deleteError) {
              logger.warn(`🗑️ Failed to delete receipt ${folderItem.name}:`, deleteError);
            }
          }
        }
        
        logger.debug(`🗑️ Total receipts deleted: ${deletionResults.receipts}`);
      } catch (error) {
        logger.warn('🗑️ ❌ Error deleting receipts:', error);
        deletionResults.errors.push(`Receipt files deletion failed: ${error}`);
      }

      // 3. Delete attendance records
      try {
        logger.debug('🗑️ Deleting attendance records...');
        const attendanceQuery = query(
          collection(firestore, 'attendance'),
          where('studentId', '==', studentId)
        );
        const attendanceSnapshot = await getDocs(attendanceQuery);
        
        for (const docSnap of attendanceSnapshot.docs) {
          await deleteDoc(doc(firestore, 'attendance', docSnap.id));
          deletionResults.attendance++;
          logger.debug(`🗑️ ✅ Deleted attendance record: ${docSnap.id}`);
        }
      } catch (error) {
        logger.error('🗑️ ❌ Error deleting attendance records:', error);
        deletionResults.errors.push(`Attendance records deletion failed: ${error}`);
      }

      // 4. Delete fee records
      try {
        logger.debug('🗑️ Deleting fee records...');
        const feesQuery = query(
          collection(firestore, 'fees'),
          where('studentId', '==', studentId)
        );
        const feesSnapshot = await getDocs(feesQuery);
        
        for (const docSnap of feesSnapshot.docs) {
          await deleteDoc(doc(firestore, 'fees', docSnap.id));
          deletionResults.fees++;
          logger.debug(`🗑️ ✅ Deleted fee record: ${docSnap.id}`);
        }
      } catch (error) {
        logger.error('🗑️ ❌ Error deleting fee records:', error);
        deletionResults.errors.push(`Fee records deletion failed: ${error}`);
      }

      // 5. Finally delete the student record itself
      try {
        logger.debug('🗑️ Deleting student record...');
        await deleteStudent(studentId);
        deletionResults.student = true;
        logger.debug(`🗑️ ✅ Deleted student record: ${studentId}`);
      } catch (error) {
        logger.error('🗑️ ❌ Error deleting student record:', error);
        deletionResults.errors.push(`Student record deletion failed: ${error}`);
        throw error; // This is critical, so we throw
      }

      return deletionResults;
    } catch (error) {
      logger.error('🗑️ ❌ Error in complete student deletion:', error);
      throw error;
    }
  };

  const handleConfirmDelete = async () => {
    if (!studentToDelete || isDeletingStudent) return;
    
    try {
      setIsDeletingStudent(true);
      logger.debug(`🗑️ Starting deletion process for: ${studentToDelete.name}`);
      
      const results = await deleteStudentCompletely(studentToDelete.id, studentToDelete.name);
      
      setShowDeleteModal(false);
      setStudentToDelete(null);
      
      // Create detailed success message
      const deletionSummary = [
        `✅ Student record: ${results.student ? 'Deleted' : 'Failed'}`,
        `📊 Attendance records: ${results.attendance} deleted`,
        `💰 Fee records: ${results.fees} deleted`,
        `🖼️ Profile image: ${results.profileImage ? 'Deleted' : 'None found'}`,
        `🧾 Receipt files: ${results.receipts} deleted`
      ];

      const warningMessage = results.errors.length > 0 
        ? `\n\n⚠️ Some issues occurred:\n${results.errors.join('\n')}`
        : '';

      // Show success toast
      Toast.show({
        type: 'success',
        text1: '🗑️ Student Deleted Successfully',
        text2: `${studentToDelete.name} and all related data removed`,
        position: 'top',
        visibilityTime: 4000,
      });
    } catch (err) {
      logger.error('🗑️ Delete operation failed:', err);
      
      // Show error toast
      Toast.show({
        type: 'error',
        text1: '❌ Deletion Failed',
        text2: `Failed to delete ${studentToDelete.name} completely`,
        position: 'top',
        visibilityTime: 4000,
      });
    } finally {
      setIsDeletingStudent(false);
    }
  };

  const handleCancelDelete = () => {
    setShowDeleteModal(false);
    setStudentToDelete(null);
  };

  // Attendance handlers
  const handleOpenAttendanceModal = (student?: Student, mode: 'individual' | 'all' = 'individual') => {
    logger.debug('Opening attendance modal:', {
      mode,
      student: student?.name,
      totalStudents: students.length,
      activeStudents: students.filter(s => s.status === 'active').length
    });
    setSelectedStudentForAttendance(student || null);
    setAttendanceMode(mode);
    setShowAttendanceModal(true);
  };

  const handleCloseAttendanceModal = () => {
    setShowAttendanceModal(false);
    setSelectedStudentForAttendance(null);
  };

  const handleSaveAttendance = async (records: any[]) => {
    try {
      await saveAttendanceRecords(records);
    } catch (err) {
      throw err; // Re-throw to let the calendar component handle the error display
    }
  };

  // Now it's safe to early-return the offline gate after all hooks are declared
  if (showOfflineLoadingStudents) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading students…</Text>
        {!!offlineHintStudents && (
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 8 }]}>{offlineHintStudents}</Text>
        )}
      </View>
    );
  }

  if (tenantUnavailable) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <TenantSelectionEmptyState
          title="No coaching center selected"
          description="Use Settings → Coaching centers to choose, create, or join a workspace before managing students."
          primaryActionLabel="Open Settings"
          onPrimaryAction={() => router.push('/(tabs)/settings')}
        />
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading students...</Text>
        <Text style={[styles.loadingText, { color: theme.textSecondary, fontSize: 12, marginTop: 10 }]}>
          User: {user?.email || 'Not signed in'}
        </Text>
        <Text style={[styles.loadingText, { color: theme.textSecondary, fontSize: 12 }]}>
          Authorized: {user?.isAuthorized ? 'Yes' : 'No'}
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <Text style={[styles.errorText, { color: theme.error }]}>{error}</Text>
      </View>
    );
  }

  // Download confirmation handlers
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

  // Excel download function for students data
  const handleDownloadExcel = async () => {
    try {
      
      // Show loading toast
      Toast.show({
        type: 'info',
        text1: '📊 Generating Excel Report',
        text2: 'Preparing comprehensive student data...',
        position: 'top',
        visibilityTime: 2000,
      });

      // Helper functions for data formatting
      const formatArray = (arr: any[] | undefined) => {
        if (!arr || arr.length === 0) return 'N/A';
        return arr.join(', ');
      };

      const formatDate = (date: string | undefined) => {
        if (!date) return 'N/A';
        return new Date(date).toLocaleDateString();
      };

      const formatCurrency = (amount: number | undefined) => {
        return amount ? `₹${amount.toLocaleString()}` : '₹0';
      };

      // Prepare comprehensive student data
      const excelData = students.map((student, index) => ({
        'Sr. No.': index + 1,
        'Student ID': student.id,
        'Student Name': student.name,
        'Email': student.email || 'N/A',
        'Phone': student.phone || 'N/A',
        'Grade/Class': student.grade || 'N/A',
        'Date of Birth': formatDate(student.dateOfBirth),
        'Address': student.address || 'N/A',
        'Emergency Contact': student.emergencyContact || 'N/A',
        'Parent Name': student.parentName || 'N/A',
        'Parent Phone': student.parentContact || student.parentPhone || 'N/A',
        'Parent Email': student.parentEmail || 'N/A',
        'Parent Contact': student.parentContact || 'N/A',
        'Parent WhatsApp': student.parentWhatsApp || 'N/A',
        'Enrolled Courses': formatArray(student.enrolledCourses),
        'Subjects': formatArray(student.subjects),
        'Monthly Fee': formatCurrency(student.monthlyFee),
        'Fee Due Date': student.feeDueDate || 'N/A',
        'Total Fees': formatCurrency(student.totalFees),
        'Fees Paid': formatCurrency(student.feesPaid),
        'Outstanding Amount': formatCurrency((student.totalFees || 0) - (student.feesPaid || 0)),
        'Last Payment Date': formatDate(student.lastPaymentDate),
        'Attendance': `${getAttendancePercentage(student.id) ?? student.attendance ?? 0}% (${getDaysPresent(student.id).present}/${getDaysPresent(student.id).total} days)`,
        'Performance': student.performance || 'N/A',
        'Status': student.status || 'active',
        'Enrollment Date': formatDate(student.enrollmentDate),
        'Join Date': formatDate(student.joinDate),
        'Created Date': formatDate(student.createdAt),
        'Last Updated': formatDate(student.updatedAt),
        'Created By': student.createdBy || 'N/A'
      }));

      // Create summary statistics
      const totalStudents = students.length;
      const activeStudents = students.filter(s => s.status === 'active').length;
      const inactiveStudents = students.filter(s => s.status === 'inactive').length;
      const suspendedStudents = students.filter(s => s.status === 'suspended').length;
      const totalFees = students.reduce((sum, s) => sum + (s.totalFees || 0), 0);
      const totalFeesPaid = students.reduce((sum, s) => sum + (s.feesPaid || 0), 0);
      const totalOutstanding = totalFees - totalFeesPaid;
      // Calculate average attendance using the calculated percentages
      const calculatedAttendances = students.map(s => getAttendancePercentage(s.id) ?? s.attendance ?? 0).filter(a => a > 0);
      const averageAttendance = calculatedAttendances.length > 0 
        ? calculatedAttendances.reduce((sum, a) => sum + a, 0) / calculatedAttendances.length 
        : 0;

      const summary = [
        { 'Category': 'Overview', 'Metric': 'Total Students', 'Value': totalStudents, 'Percentage': '100%' },
        { 'Category': 'Status', 'Metric': 'Active Students', 'Value': activeStudents, 'Percentage': `${Math.round((activeStudents / totalStudents) * 100)}%` },
        { 'Category': 'Status', 'Metric': 'Inactive Students', 'Value': inactiveStudents, 'Percentage': `${Math.round((inactiveStudents / totalStudents) * 100)}%` },
        { 'Category': 'Status', 'Metric': 'Suspended Students', 'Value': suspendedStudents, 'Percentage': `${Math.round((suspendedStudents / totalStudents) * 100)}%` },
        { 'Category': 'Financial', 'Metric': 'Total Fees Due', 'Value': formatCurrency(totalFees), 'Percentage': '100%' },
        { 'Category': 'Financial', 'Metric': 'Total Fees Collected', 'Value': formatCurrency(totalFeesPaid), 'Percentage': `${Math.round((totalFeesPaid / totalFees) * 100)}%` },
        { 'Category': 'Financial', 'Metric': 'Total Outstanding', 'Value': formatCurrency(totalOutstanding), 'Percentage': `${Math.round((totalOutstanding / totalFees) * 100)}%` },
        { 'Category': 'Academic', 'Metric': 'Average Attendance', 'Value': `${Math.round(averageAttendance)}%`, 'Percentage': 'N/A' },
        { 'Category': 'Academic', 'Metric': 'Students with Good Performance', 'Value': students.filter(s => s.performance === 'Excellent' || s.performance === 'Good').length, 'Percentage': 'N/A' }
      ];

      // Create grade-wise breakdown
      const gradeBreakdown = students.reduce((acc: any, student) => {
        const grade = student.grade || 'Unknown';
        if (!acc[grade]) {
          acc[grade] = { count: 0, totalFees: 0, feesPaid: 0, avgAttendance: 0, attendanceCount: 0 };
        }
        acc[grade].count++;
        acc[grade].totalFees += student.totalFees || 0;
        acc[grade].feesPaid += student.feesPaid || 0;
        const calculatedAttendance = getAttendancePercentage(student.id) ?? student.attendance ?? 0;
        if (calculatedAttendance > 0) {
          acc[grade].avgAttendance += calculatedAttendance;
          acc[grade].attendanceCount++;
        }
        return acc;
      }, {});

      const gradeData = Object.entries(gradeBreakdown).map(([grade, data]: [string, any]) => ({
        'Grade/Class': grade,
        'Student Count': data.count,
        'Total Fees': formatCurrency(data.totalFees),
        'Fees Collected': formatCurrency(data.feesPaid),
        'Outstanding': formatCurrency(data.totalFees - data.feesPaid),
        'Collection Rate': data.totalFees > 0 ? `${Math.round((data.feesPaid / data.totalFees) * 100)}%` : '0%',
        'Average Attendance': data.attendanceCount > 0 ? `${Math.round(data.avgAttendance / data.attendanceCount)}%` : 'N/A'
      }));

      // Create workbook and add sheets
      const wb = XLSX.utils.book_new();

      // Add summary sheet
      const summaryWS = XLSX.utils.json_to_sheet(summary);
      summaryWS['!cols'] = [{ wch: 25 }, { wch: 25 }, { wch: 20 }, { wch: 15 }];
      XLSX.utils.book_append_sheet(wb, summaryWS, 'Summary');

      // Add detailed student data sheet
      const studentsWS = XLSX.utils.json_to_sheet(excelData);
      const studentsCols = Array(30).fill(0).map(() => ({ wch: 20 }));
      studentsWS['!cols'] = studentsCols;
      XLSX.utils.book_append_sheet(wb, studentsWS, 'Student Details');

      // Add grade breakdown sheet
      const gradeWS = XLSX.utils.json_to_sheet(gradeData);
      const gradeCols = Array(7).fill(0).map(() => ({ wch: 18 }));
      gradeWS['!cols'] = gradeCols;
      XLSX.utils.book_append_sheet(wb, gradeWS, 'Grade-wise Analysis');

      // Generate file
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      const currentDate = new Date();
      const dateStr = currentDate.toISOString().split('T')[0];
      const timeStr = currentDate.toTimeString().split(' ')[0].replace(/:/g, '-');
      const fileName = `Student_Report_${dateStr}_${timeStr}.xlsx`;

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
        
        Toast.show({
          type: 'success',
          text1: '📊 Excel Downloaded!',
          text2: `${fileName} with ${students.length} student records downloaded successfully`,
          position: 'top',
          visibilityTime: 4000,
        });
      } else {
        // For mobile platforms
        const fileUri = FileSystem.documentDirectory + fileName;
        await FileSystem.writeAsStringAsync(fileUri, wbout, {
          encoding: FileSystem.EncodingType.Base64,
        });

        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: 'Save Student Report',
            UTI: 'com.microsoft.excel.xlsx'
          });
          Toast.show({
            type: 'success',
            text1: '📊 Excel Generated!',
            text2: `${fileName} with ${students.length} student records is ready to share`,
            position: 'top',
            visibilityTime: 4000,
          });
        } else {
          Toast.show({
            type: 'success',
            text1: '📊 Excel Report Generated!',
            text2: `Saved to: ${fileUri}`,
            position: 'top',
            visibilityTime: 4000,
          });
        }
      }

    } catch (error) {
      logger.error('Error generating Excel file:', error);
      Toast.show({
        type: 'error',
        text1: '❌ Export Failed',
        text2: 'Could not generate Excel file. Please try again.',
        position: 'top',
        visibilityTime: 3000,
      });
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Header */}
  <View style={[styles.header, { backgroundColor: theme.surface, paddingTop: Math.max(0, 60 - effectiveHeaderComp) }]}>
  <Text allowFontScaling={false} style={[styles.title, { color: theme.text }]}>Students</Text>
        <View style={styles.headerButtons}>
          {Platform.OS === 'web' && (
            <TouchableOpacity 
              style={[styles.downloadButton, { backgroundColor: theme.surface, borderColor: theme.primary }]}
              onPress={handleDownloadPress}
            >
              <Download size={20} color={theme.primary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity 
            style={[styles.attendanceButton, { backgroundColor: theme.surface, borderColor: theme.primary }]}
            onPress={() => handleOpenAttendanceModal(undefined, 'all')}
          >
            <Calendar size={20} color={theme.primary} />
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.addButton, { backgroundColor: theme.primary }]}
            onPress={() => setShowAddModal(true)}
          >
            <Plus size={24} color="#ffffff" />
          </TouchableOpacity>
        </View>
      </View>

      {shouldShowStudentUsageBanner && (
        <UsageAlertInlineBanner
          alert={studentUsageAlert}
          totalAlerts={studentUsageAlertCount}
          loading={studentUsageAlertLoading}
          error={studentUsageAlertError}
          monthLabel={studentUsageMonthId}
          onPress={() => router.push('/(tabs)/usage')}
          onRefresh={refreshStudentUsageAlerts}
        />
      )}

      {/*
        Scroll container:
        - Stats scroll away
        - Search bar stays sticky at top
      */}
      <ScrollView
        style={styles.studentsList}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[1]}
      >
        {/* Student Statistics (scrolls away) */}
        <View style={[styles.statsContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.statCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statNumber, { color: theme.success }]}>
              {students.filter(s => s.status === 'active').length}
            </Text>
            <Text style={[styles.statsLabel, { color: theme.textSecondary }]}>Active</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statNumber, { color: theme.warning }]}>
              {students.filter(s => s.status === 'suspended').length}
            </Text>
            <Text style={[styles.statsLabel, { color: theme.textSecondary }]}>Suspended</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statNumber, { color: theme.error }]}>
              {students.filter(s => s.status === 'inactive').length}
            </Text>
            <Text style={[styles.statsLabel, { color: theme.textSecondary }]}>Inactive</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statNumber, { color: theme.primary }]}>
              {students.length}
            </Text>
            <Text style={[styles.statsLabel, { color: theme.textSecondary }]}>Total</Text>
          </View>
        </View>

        {/* Search Bar (sticky) */}
        <View
          style={[
            styles.searchStickyWrapper,
            {
              backgroundColor: theme.background,
            },
          ]}
        >
          <View style={[styles.searchContainer, { backgroundColor: theme.surface }]}>
            <Search size={20} color={theme.textSecondary} style={styles.searchIcon} />
            <TextInput
              style={[styles.searchInput, { color: theme.text }]}
              placeholder="Search students..."
              placeholderTextColor={theme.textSecondary}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
        </View>

        {/* Search Info */}
        {searchQuery.length > 0 && (
          <View style={[styles.searchInfo, { backgroundColor: theme.background }]}>
            <Text style={[styles.searchInfoText, { color: theme.textSecondary }]}>
              Found {filteredStudents.length} student{filteredStudents.length !== 1 ? 's' : ''} • Clear search to reorder students
            </Text>
          </View>
        )}

        {/* Students List */}
        {filteredStudents.length > 0 ? (
          filteredStudents.map((student, index) => (
            <TouchableOpacity 
              key={student.id} 
              style={[styles.studentCard, { backgroundColor: theme.surface }]}
              onPress={() => router.push(`/student-profile/${student.id}`)}
            >
              <View style={styles.studentHeader}>
                <View style={styles.studentInfo}>
                  <View style={[styles.avatarContainer, { backgroundColor: `${theme.primary}15` }]}>
                    {student.profileImageUrl ? (
                      <Image
                        source={{ uri: student.profileImageUrl }}
                        style={styles.studentAvatarImage}
                      />
                    ) : (
                      <User size={20} color={theme.primary} />
                    )}
                  </View>

                  <View style={styles.studentDetails}>
                    <View style={styles.studentNameRow}>
                      <Text style={[styles.studentName, { color: theme.text }]}>{student.name}</Text>
                      <View
                        style={[
                          styles.statusIndicator,
                          {
                            backgroundColor:
                              student.status === 'active'
                                ? theme.success + '20'
                                : student.status === 'suspended'
                                  ? theme.warning + '20'
                                  : theme.error + '20',
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.statusIndicatorText,
                            {
                              color:
                                student.status === 'active'
                                  ? theme.success
                                  : student.status === 'suspended'
                                    ? theme.warning
                                    : theme.error,
                            },
                          ]}
                        >
                          {student.status.charAt(0).toUpperCase() + student.status.slice(1)}
                        </Text>
                      </View>
                      <View style={[styles.orderIndicator, { backgroundColor: theme.primary }]}>
                        <Text style={styles.orderText}>{index + 1}</Text>
                      </View>
                    </View>

                    <View style={styles.gradeStatusRow}>
                      <Text style={[styles.studentGrade, { color: theme.textSecondary }]}>{student.grade}</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.actionButtons}>
                  <TouchableOpacity 
                    style={[
                      styles.moveButton, 
                      { 
                        backgroundColor: (index === 0 || searchQuery.length > 0) ? theme.background : theme.surface,
                        borderColor: (index === 0 || searchQuery.length > 0) ? theme.border : theme.primary,
                        opacity: (index === 0 || searchQuery.length > 0) ? 0.5 : 1
                      }
                    ]}
                    onPress={(e) => {
                      e.stopPropagation();
                      handleMoveStudentUp(student.id);
                    }}
                    disabled={index === 0 || searchQuery.length > 0}
                  >
                    <ChevronUp 
                      size={16} 
                      color={(index === 0 || searchQuery.length > 0) ? theme.textSecondary : theme.primary} 
                    />
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={[
                      styles.moveButton, 
                      { 
                        backgroundColor: (index === filteredStudents.length - 1 || searchQuery.length > 0) ? theme.background : theme.surface,
                        borderColor: (index === filteredStudents.length - 1 || searchQuery.length > 0) ? theme.border : theme.primary,
                        opacity: (index === filteredStudents.length - 1 || searchQuery.length > 0) ? 0.5 : 1
                      }
                    ]}
                    onPress={(e) => {
                      e.stopPropagation();
                      handleMoveStudentDown(student.id);
                    }}
                    disabled={index === filteredStudents.length - 1 || searchQuery.length > 0}
                  >
                    <ChevronDown 
                      size={16} 
                      color={(index === filteredStudents.length - 1 || searchQuery.length > 0) ? theme.textSecondary : theme.primary} 
                    />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.subjectsContainer}>
                {(student.subjects || []).map((subject, index) => (
                  <View key={index} style={[styles.subjectTag, { backgroundColor: theme.background }]}>
                    <Text style={[styles.subjectText, { color: theme.textSecondary }]}>{subject}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.studentStats}>
                <TouchableOpacity 
                  style={styles.statItem}
                  onPress={(e) => {
                    e.stopPropagation();
                    handleOpenAttendanceModal(student, 'individual');
                  }}
                >
                  <View style={styles.statIcon}>
                    <Calendar size={16} color={theme.primary} />
                  </View>
                  <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Attendance</Text>
                  <View style={styles.attendanceValueContainer}>
                    <Text style={[styles.statValue, { color: theme.primary }]}>
                      {getAttendancePercentage(student.id) ?? student.attendance ?? 0}%
                    </Text>
                    <Text style={[styles.attendanceDays, { color: theme.textSecondary }]}>
                      ({getDaysPresent(student.id).present}/{getDaysPresent(student.id).total} days)
                    </Text>
                  </View>
                </TouchableOpacity>
                <View style={styles.statItem}>
                  <View style={styles.statIcon}>
                    <TrendingUp size={16} color={theme.textSecondary} />
                  </View>
                  <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Performance</Text>
                  <Text style={[styles.statValue, { color: getPerformanceColor(student.performance || 'Good') }]}>
                    {student.performance || 'Good'}
                  </Text>
                </View>
              </View>

              <View style={styles.contactInfo}>
                <View style={styles.contactItem}>
                  <Phone size={14} color={theme.textSecondary} />
                  <Text style={[styles.contactText, { color: theme.textSecondary }]}>{student.parentContact}</Text>
                </View>
                {student.parentEmail && (
                  <View style={styles.contactItem}>
                    <Mail size={14} color={theme.textSecondary} />
                    <Text style={[styles.contactText, { color: theme.textSecondary }]}>{student.parentEmail}</Text>
                  </View>
                )}
                {student.parentWhatsApp && (
                  <View style={styles.contactItem}>
                    <MessageCircle size={14} color={theme.success} />
                    <Text style={[styles.contactText, { color: theme.textSecondary }]}>{student.parentWhatsApp}</Text>
                  </View>
                )}
              </View>

              <View style={[styles.feeInfo, { borderTopColor: theme.border }]}>
                <View style={styles.feeInfoRow}>
                  <View style={styles.feeDetails}>
                    <Text style={[styles.monthlyFee, { color: theme.success }]}>Monthly Fee: ₹{(student.monthlyFee || 0).toLocaleString()}</Text>
                    {student.feeDueDate && (
                      <Text style={[styles.dueDateText, { color: theme.warning }]}>Due: {student.feeDueDate}{getOrdinalSuffix(student.feeDueDate)} of every month</Text>
                    )}
                    <Text style={[styles.joinDate, { color: theme.textSecondary }]}>Joined: {new Date(student.joinDate || student.enrollmentDate).toLocaleDateString()}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 0 }}>
                    <TouchableOpacity
                      style={[
                        styles.deleteButtonSmall,
                        {
                          backgroundColor: theme.surface,
                          borderColor: theme.primary,
                          opacity: isDeletingStudent ? 0.5 : 1,
                        },
                      ]}
                      onPress={(e) => {
                        e.stopPropagation();
                        router.push(`/student-profile/${student.id}?edit=1`);
                      }}
                      disabled={isDeletingStudent}
                    >
                      <Edit3 size={14} color={theme.primary} />
                    </TouchableOpacity>

                    <TouchableOpacity 
                      style={[
                        styles.deleteButtonSmall, 
                        { 
                          backgroundColor: theme.surface,
                          borderColor: theme.error,
                          opacity: isDeletingStudent ? 0.5 : 1
                        }
                      ]}
                      onPress={(e) => {
                        e.stopPropagation();
                        handleDeletePress(student);
                      }}
                      disabled={isDeletingStudent}
                    >
                      <Trash2 
                        size={14} 
                        color={theme.error} 
                      />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          ))
        ) : (
          <View style={[styles.emptyState, { backgroundColor: theme.surface }]}>
            <Text style={[styles.emptyStateText, { color: theme.text }]}>No students found</Text>
            <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}>Add your first student to get started</Text>
          </View>
        )}
      </ScrollView>

      {/* Add Student Modal */}
      <Modal
        visible={showAddModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!isAddingStudent) {
            setShowAddModal(false);
            resetForm();
          }
        }}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
            <TouchableOpacity 
              onPress={() => {
                if (!isAddingStudent) {
                  setShowAddModal(false);
                  resetForm();
                }
              }}
              disabled={isAddingStudent}
              style={[
                { opacity: isAddingStudent ? 0.5 : 1 }
              ]}
            >
              <Text style={[
                styles.cancelText, 
                { color: isAddingStudent ? theme.textSecondary : theme.textSecondary }
              ]}>
                Cancel
              </Text>
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Add Student</Text>
            <TouchableOpacity 
              onPress={handleAddStudent}
              disabled={isAddingStudent}
              style={[
                styles.saveButton,
                { 
                  opacity: isAddingStudent ? 0.6 : 1,
                  backgroundColor: isAddingStudent ? theme.textSecondary : 'transparent',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6
                }
              ]}
            >
              {isAddingStudent && (
                <ActivityIndicator 
                  size="small" 
                  color="#ffffff" 
                />
              )}
              <Text style={[
                styles.saveText, 
                { 
                  color: isAddingStudent ? '#ffffff' : theme.primary,
                  fontFamily: isAddingStudent ? 'Inter-Medium' : 'Inter-SemiBold'
                }
              ]}>
                {isAddingStudent ? 'Saving...' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>
          
          <ScrollView
            style={styles.modalContent}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 10 }),
            }}
          >
            {/* Profile Picture Section */}
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Profile Picture</Text>
            </View>
            
            <View style={styles.profilePictureContainer}>
              <TouchableOpacity 
                style={[styles.profilePictureButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={handleSelectProfileImage}
                disabled={isUploadingImage}
              >
                {profileImage ? (
                  <Image source={{ uri: profileImage }} style={styles.profilePicturePreview} />
                ) : (
                  <View style={styles.profilePicturePlaceholder}>
                    <Camera size={32} color={theme.textSecondary} />
                    <Text style={[styles.profilePictureText, { color: theme.textSecondary }]}>
                      {isUploadingImage ? 'Uploading...' : 'Add Profile Picture'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
              {profileImage && (
                <TouchableOpacity 
                  style={[styles.removeImageButton, { backgroundColor: theme.error }]}
                  onPress={() => setProfileImage(null)}
                >
                  <Text style={styles.removeImageText}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Student Information Section */}
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Student Information</Text>
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Student Name *</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.name ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="Enter student name"
                placeholderTextColor={theme.textSecondary}
                value={newStudent.name}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, name: text});
                  if (formErrors.name) {
                    setFormErrors({...formErrors, name: ''});
                  }
                }}
              />
              {formErrors.name && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.name}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Student Email</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.email ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="student@email.com"
                placeholderTextColor={theme.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                value={newStudent.email}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, email: text});
                  if (formErrors.email) {
                    setFormErrors({...formErrors, email: ''});
                  }
                }}
              />
              {formErrors.email && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.email}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Student Phone *</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.phone ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="+91 9876543210"
                placeholderTextColor={theme.textSecondary}
                keyboardType="phone-pad"
                value={newStudent.phone}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, phone: text});
                  if (formErrors.phone) {
                    setFormErrors({...formErrors, phone: ''});
                  }
                }}
              />
              {formErrors.phone && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.phone}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Grade *</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.grade ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="e.g., 10th Grade"
                placeholderTextColor={theme.textSecondary}
                value={newStudent.grade}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, grade: text});
                  if (formErrors.grade) {
                    setFormErrors({...formErrors, grade: ''});
                  }
                }}
              />
              {formErrors.grade && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.grade}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Date of Birth</Text>
              <DatePicker
                selectedDate={newStudent.dateOfBirth || ''}
                onSelect={(date: string) => setNewStudent({...newStudent, dateOfBirth: date})}
                theme={theme}
                placeholder="Select date of birth"
                allowFutureDates={false}
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Subjects</Text>
              
              {/* Subjects Input Field with Add Button */}
              <View style={styles.subjectsInputContainer}>
                <TextInput
                  style={[styles.subjectsInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]}
                  placeholder="Mathematics, Physics, Chemistry (comma separated)"
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  numberOfLines={1}
                  value={subjectsInputText}
                  onChangeText={(text) => {
                    // Allow user to type freely including commas and spaces
                    setSubjectsInputText(text);
                  }}
                  onBlur={() => {
                    // Process subjects when user finishes typing (on blur)
                    if (subjectsInputText.trim().length > 0) {
                      const subjectsArray = subjectsInputText.split(',').map(s => s.trim()).filter(s => s.length > 0);
                      setNewStudent({
                        ...newStudent, 
                        subjects: subjectsArray
                      });
                    }
                  }}
                  onSubmitEditing={() => {
                    // Process subjects when user presses done/enter
                    if (subjectsInputText.trim().length > 0) {
                      const subjectsArray = subjectsInputText.split(',').map(s => s.trim()).filter(s => s.length > 0);
                      setNewStudent({
                        ...newStudent, 
                        subjects: subjectsArray
                      });
                    }
                  }}
                  returnKeyType="done"
                  blurOnSubmit={true}
                />
                <TouchableOpacity 
                  style={[
                    styles.addSubjectsButton, 
                    { 
                      backgroundColor: subjectsInputText.trim().length > 0 ? theme.primary : theme.border,
                      opacity: subjectsInputText.trim().length > 0 ? 1 : 0.5
                    }
                  ]}
                  onPress={() => {
                    if (subjectsInputText.trim().length > 0) {
                      const subjectsArray = subjectsInputText.split(',').map(s => s.trim()).filter(s => s.length > 0);
                      setNewStudent({
                        ...newStudent, 
                        subjects: subjectsArray
                      });
                      setSubjectsInputText(''); // Clear input after adding
                    }
                  }}
                  disabled={subjectsInputText.trim().length === 0}
                >
                  <Text style={[
                    styles.addSubjectsButtonText, 
                    { color: subjectsInputText.trim().length > 0 ? '#ffffff' : theme.textSecondary }
                  ]}>
                    Add
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.helperText, { color: theme.textSecondary }]}>
                Separate multiple subjects with commas (e.g., Math, Science, English)
              </Text>
              
              {/* Display current subjects as tags */}
              {newStudent.subjects && newStudent.subjects.length > 0 && (
                <View style={[styles.subjectsPreview, { borderColor: theme.border, backgroundColor: theme.background }]}>
                  <Text style={[styles.subjectsPreviewLabel, { color: theme.textSecondary }]}>
                    Subjects to be added ({newStudent.subjects.length}):
                  </Text>
                  <View style={styles.subjectsContainer}>
                    {newStudent.subjects.map((subject, index) => (
                      <View 
                        key={index} 
                        style={[styles.subjectTag, { backgroundColor: theme.primary + '20' }]}
                      >
                        <Text style={[styles.subjectText, { color: theme.primary }]}>
                          {subject}
                        </Text>
                        <TouchableOpacity
                          onPress={() => {
                            // Remove this subject from the array
                            const currentSubjects = newStudent.subjects || [];
                            const updatedSubjects = currentSubjects.filter((_, i) => i !== index);
                            setNewStudent({
                              ...newStudent,
                              subjects: updatedSubjects
                            });
                          }}
                          style={styles.removeSubjectButton}
                        >
                          <Text style={[styles.removeSubjectText, { color: theme.primary }]}>×</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Performance Status</Text>
              <View style={styles.performanceContainer}>
                {performanceOptions.map((option) => (
                  <TouchableOpacity
                    key={option}
                    style={[
                      styles.performanceOption,
                      {
                        backgroundColor: newStudent.performance === option ? getPerformanceColor(option) : theme.surface,
                        borderColor: newStudent.performance === option ? getPerformanceColor(option) : theme.border,
                      }
                    ]}
                    onPress={() => setNewStudent({...newStudent, performance: option})}
                  >
                    <Text style={[
                      styles.performanceOptionText,
                      {
                        color: newStudent.performance === option ? '#ffffff' : getPerformanceColor(option)
                      }
                    ]}>
                      {option}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Student Status</Text>
              <StatusSelector
                selectedStatus={newStudent.status}
                onSelect={(status) => setNewStudent({...newStudent, status})}
                theme={theme}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Joined Date</Text>
              <DatePicker
                selectedDate={newStudent.joinDate || ''}
                onSelect={(date: string) => setNewStudent({...newStudent, joinDate: date})}
                theme={theme}
                placeholder="Select join date"
                allowFutureDates={false}
              />
            </View>

            {/* Parent/Guardian Information Section */}
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Parent/Guardian Information</Text>
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Parent/Guardian Name *</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.parentName ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="Enter parent/guardian name"
                placeholderTextColor={theme.textSecondary}
                value={newStudent.parentName || ''}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, parentName: text});
                  if (formErrors.parentName) {
                    setFormErrors({...formErrors, parentName: ''});
                  }
                }}
              />
              {formErrors.parentName && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.parentName}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Relationship</Text>
              <RelationshipSelector
                selectedRelation={newStudent.parentRelation || 'Parent'}
                onSelect={(relation) => setNewStudent({...newStudent, parentRelation: relation})}
                theme={theme}
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Parent Contact *</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.parentContact ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="+91 9876543210"
                placeholderTextColor={theme.textSecondary}
                keyboardType="phone-pad"
                value={newStudent.parentContact || ''}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, parentContact: text});
                  if (formErrors.parentContact) {
                    setFormErrors({...formErrors, parentContact: ''});
                  }
                }}
              />
              {formErrors.parentContact && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.parentContact}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Parent Email</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.parentEmail ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="parent@email.com"
                placeholderTextColor={theme.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                value={newStudent.parentEmail || ''}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, parentEmail: text});
                  if (formErrors.parentEmail) {
                    setFormErrors({...formErrors, parentEmail: ''});
                  }
                }}
              />
              {formErrors.parentEmail && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.parentEmail}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Parent WhatsApp</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.parentWhatsApp ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="+91 9876543210 (for WhatsApp reminders)"
                placeholderTextColor={theme.textSecondary}
                keyboardType="phone-pad"
                value={newStudent.parentWhatsApp || ''}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, parentWhatsApp: text});
                  if (formErrors.parentWhatsApp) {
                    setFormErrors({...formErrors, parentWhatsApp: ''});
                  }
                }}
              />
              {formErrors.parentWhatsApp && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.parentWhatsApp}</Text>
              )}
            </View>

            {/* Additional Information Section */}
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Additional Information</Text>
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Address</Text>
              <TextInput
                style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text, minHeight: 80 }]}
                placeholder="Enter student's address"
                placeholderTextColor={theme.textSecondary}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
                value={newStudent.address || ''}
                onChangeText={(text) => setNewStudent({...newStudent, address: text})}
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Emergency Contact</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.emergencyContact ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="+91 9876543210 (emergency contact)"
                placeholderTextColor={theme.textSecondary}
                keyboardType="phone-pad"
                value={newStudent.emergencyContact || ''}
                onChangeText={(text) => {
                  setNewStudent({...newStudent, emergencyContact: text});
                  if (formErrors.emergencyContact) {
                    setFormErrors({...formErrors, emergencyContact: ''});
                  }
                }}
              />
              {formErrors.emergencyContact && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.emergencyContact}</Text>
              )}
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Monthly Fee *</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.monthlyFee ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="2500"
                placeholderTextColor={theme.textSecondary}
                keyboardType="numeric"
                value={(newStudent.monthlyFee || 0).toString()}
                onChangeText={(text) => {
                  setNewStudent({
                    ...newStudent, 
                    monthlyFee: parseInt(text) || 0
                  });
                  if (formErrors.monthlyFee) {
                    setFormErrors({...formErrors, monthlyFee: ''});
                  }
                }}
              />
              {formErrors.monthlyFee && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.monthlyFee}</Text>
              )}
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.labelText, { color: theme.text }]}>Fee Due Date (Day of Month) *</Text>
              <TextInput
                style={[
                  styles.input, 
                  { 
                    backgroundColor: theme.surface, 
                    borderColor: formErrors.feeDueDate ? theme.error : theme.border, 
                    color: theme.text 
                  }
                ]}
                placeholder="1"
                placeholderTextColor={theme.textSecondary}
                keyboardType="numeric"
                value={newStudent.feeDueDate ? newStudent.feeDueDate.toString() : ''}
                onChangeText={(text) => {
                  if (text === '') {
                    setNewStudent({
                      ...newStudent, 
                      feeDueDate: undefined
                    });
                  } else {
                    const day = parseInt(text);
                    if (!isNaN(day)) {
                      setNewStudent({
                        ...newStudent, 
                        feeDueDate: Math.min(Math.max(day, 1), 31) // Clamp between 1-31
                      });
                    }
                  }
                  if (formErrors.feeDueDate) {
                    setFormErrors({...formErrors, feeDueDate: ''});
                  }
                }}
              />
              <Text style={[styles.helperText, { color: theme.textSecondary }]}>
                Enter a number between 1-31 (e.g., 5 for 5th of every month)
              </Text>
              {formErrors.feeDueDate && (
                <Text style={[styles.errorText, { color: theme.error }]}>{formErrors.feeDueDate}</Text>
              )}
            </View>

            {/* Required fields note */}
            <View style={styles.requiredNote}>
              <Text style={[styles.requiredNoteText, { color: theme.textSecondary }]}>
                * Required fields
              </Text>
            </View>
            
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        transparent={true}
        animationType="fade"
        onRequestClose={handleCancelDelete}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.deleteConfirmationModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.deleteModalHeader}>
              <Text style={[styles.deleteModalTitle, { color: theme.error }]}>
                {isDeletingStudent ? '🗑️ Deleting Student...' : '⚠️ Delete Student'}
              </Text>
            </View>
            
            <View style={styles.deleteModalContent}>
              {isDeletingStudent ? (
                <View style={styles.deletingStateContainer}>
                  <Text style={[styles.deletingStateText, { color: theme.textSecondary }]}>
                    Please wait while we permanently delete all data for{' '}
                    <Text style={[styles.deleteModalStudentName, { color: theme.text }]}>
                      {studentToDelete?.name}
                    </Text>
                    ...
                  </Text>
                  <Text style={[styles.deletingStateSubtext, { color: theme.warning }]}>
                    ⏳ This may take a few moments to complete
                  </Text>
                </View>
              ) : (
                <View>
                  <Text style={[styles.deleteModalText, { color: theme.textSecondary }]}>
                    Are you sure you want to permanently delete{' '}
                    <Text style={[styles.deleteModalStudentName, { color: theme.text }]}>
                      {studentToDelete?.name}
                    </Text>
                    ?
                  </Text>
                  
                  <View style={[styles.deleteWarningBox, { backgroundColor: theme.error + '10', borderColor: theme.error + '30' }]}>
                    <Text style={[styles.deleteWarningTitle, { color: theme.error }]}>
                      🗑️ This will permanently delete ALL data:
                    </Text>
                    <Text style={[styles.deleteWarningList, { color: theme.textSecondary }]}>
                      • Student profile and personal information{'\n'}
                      • All attendance records and history{'\n'}
                      • All fee records and payment history{'\n'}
                      • Profile pictures from cloud storage{'\n'}
                      • Receipt files and documents{'\n'}
                      • Any other associated data
                    </Text>
                  </View>
                  
                  <Text style={[styles.deleteModalWarning, { color: theme.error }]}>
                    ⚠️ This action cannot be undone and all data will be lost forever!
                  </Text>
                </View>
              )}
            </View>
            
            <View style={[styles.deleteModalButtons, { borderTopWidth: 1, borderTopColor: theme.border }]}> 
              <TouchableOpacity 
                style={[
                  styles.deleteModalButton, 
                  styles.cancelButton, 
                  { 
                    backgroundColor: theme.background, 
                    borderColor: theme.border,
                    borderRightWidth: 1,
                    borderRightColor: theme.border,
                    opacity: isDeletingStudent ? 0.5 : 1
                  }
                ]}
                onPress={handleCancelDelete}
                disabled={isDeletingStudent}
              >
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[
                  styles.deleteModalButton, 
                  styles.confirmDeleteButton, 
                  { 
                    backgroundColor: isDeletingStudent ? theme.textSecondary : theme.error,
                    opacity: isDeletingStudent ? 0.7 : 1
                  }
                ]}
                onPress={handleConfirmDelete}
                disabled={isDeletingStudent}
              >
                <Text style={[styles.confirmDeleteButtonText, { 
                  color: '#ffffff',
                  fontSize: isDeletingStudent ? 14 : 16 
                }]}>
                  {isDeletingStudent ? '🗑️ Deleting...' : 'Delete Everything'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Download Confirmation Modal */}
      <Modal
        visible={showDownloadConfirmModal}
        animationType="fade"
        transparent={true}
        onRequestClose={handleCancelDownload}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.deleteConfirmationModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.deleteModalHeader}>
              <Text style={[styles.deleteModalTitle, { color: theme.text }]}>📊 Download Excel Report</Text>
            </View>
            
            <View style={styles.deleteModalContent}>
              <Text style={[styles.deleteModalText, { color: theme.text }]}>
                Are you sure you want to download the comprehensive student report?
              </Text>
              <Text style={[styles.deleteModalText, { color: theme.textSecondary, fontSize: 14, marginTop: 12 }]}>
                This will generate an Excel file with data for <Text style={[styles.deleteModalStudentName, { color: theme.primary }]}>{students.length} students</Text> including:
              </Text>
              <View style={[styles.deleteWarningBox, { backgroundColor: `${theme.primary}10`, borderColor: `${theme.primary}30` }]}>
                <Text style={[styles.deleteWarningList, { color: theme.text }]}>
                  • Personal information and contact details{'\n'}
                  • Academic performance and attendance data{'\n'}
                  • Fee details and payment history{'\n'}
                  • Parent information and emergency contacts{'\n'}
                  • Grade-wise summary and statistics
                </Text>
              </View>
            </View>
            
            <View style={[styles.deleteModalButtons, { borderTopWidth: 1, borderTopColor: theme.border }]}> 
              <TouchableOpacity
                style={[styles.deleteModalButton, styles.cancelButton, { borderRightWidth: 1, borderRightColor: theme.border }]}
                onPress={handleCancelDownload}
              >
                <Text style={[styles.cancelButtonText, { color: theme.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.deleteModalButton, { backgroundColor: theme.primary }]}
                onPress={handleConfirmDownload}
              >
                <Text style={[styles.confirmDeleteButtonText]}>Download Report</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Attendance Calendar Modal */}
      <AttendanceCalendar
        visible={showAttendanceModal}
        onClose={handleCloseAttendanceModal}
        student={selectedStudentForAttendance || undefined}
        students={students}
        attendanceRecords={attendanceRecords}
        onSaveAttendance={handleSaveAttendance}
        mode={attendanceMode}
        showModeToggle={selectedStudentForAttendance !== null}
      />
    </View>
  );
}

// Status Selector Component
interface StatusSelectorProps {
  selectedStatus: 'active' | 'inactive' | 'suspended';
  onSelect: (status: 'active' | 'inactive' | 'suspended') => void;
  theme: any;
}

function StatusSelector({ selectedStatus, onSelect, theme }: StatusSelectorProps) {
  const [showOptions, setShowOptions] = useState(false);
  const statusOptions: ('active' | 'inactive' | 'suspended')[] = ['active', 'inactive', 'suspended'];

  const getStatusColor = (status: 'active' | 'inactive' | 'suspended') => {
    switch (status) {
      case 'active':
        return theme.success;
      case 'suspended':
        return theme.warning;
      case 'inactive':
        return theme.error;
      default:
        return theme.textSecondary;
    }
  };

  return (
    <View style={styles.selectorContainer}>
      <TouchableOpacity
        style={[styles.selectorButton, { 
          borderColor: theme.border, 
          backgroundColor: theme.surface,
        }]}
        onPress={() => setShowOptions(!showOptions)}
      >
        <Text style={[styles.selectorText, { color: getStatusColor(selectedStatus) }]}>
          {selectedStatus.charAt(0).toUpperCase() + selectedStatus.slice(1)}
        </Text>
        <Text style={[styles.selectorArrow, { color: theme.textSecondary }]}>↓</Text>
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
            <View style={[styles.optionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.modalHeader, { color: theme.text }]}>Select Status</Text>
              {statusOptions.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.optionItem, { 
                    backgroundColor: option === selectedStatus ? theme.primary + '20' : 'transparent' 
                  }]}
                  onPress={() => {
                    onSelect(option);
                    setShowOptions(false);
                  }}
                >
                  <Text style={[styles.optionText, { color: getStatusColor(option) }]}>
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </View>
  );
}

// Relationship Selector Component
interface RelationshipSelectorProps {
  selectedRelation: string;
  onSelect: (relation: string) => void;
  theme: any;
}

function RelationshipSelector({ selectedRelation, onSelect, theme }: RelationshipSelectorProps) {
  const [showOptions, setShowOptions] = useState(false);
  const relationshipOptions = ['Father', 'Mother', 'Guardian', 'Grandfather', 'Grandmother', 'Uncle', 'Aunt', 'Brother', 'Sister', 'Other'];

  return (
    <View style={styles.selectorContainer}>
      <TouchableOpacity
        style={[styles.selectorButton, { 
          borderColor: theme.border, 
          backgroundColor: theme.surface,
        }]}
        onPress={() => setShowOptions(!showOptions)}
      >
        <Text style={[styles.selectorText, { color: theme.text }]}>
          {selectedRelation}
        </Text>
        <Text style={[styles.selectorArrow, { color: theme.textSecondary }]}>↓</Text>
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
            <View style={[styles.optionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.modalHeader, { color: theme.text }]}>Select Relationship</Text>
              {relationshipOptions.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.optionItem, { 
                    backgroundColor: option === selectedRelation ? theme.primary + '20' : 'transparent' 
                  }]}
                  onPress={() => {
                    onSelect(option);
                    setShowOptions(false);
                  }}
                >
                  <Text style={[styles.optionText, { color: theme.text }]}>
                    {option}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      )}
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
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [showYearPicker, setShowYearPicker] = useState(false);
  
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

  const generateYearRange = () => {
    const currentYear = new Date().getFullYear();
    const years = [];
    // For birth dates, we want to show a more reasonable range
    // Start from current year and go back to 1900, then add future years for other use cases
    for (let year = currentYear; year >= 1900; year--) {
      years.push(year);
    }
    // Add a few future years for other date selections
    for (let year = currentYear + 1; year <= currentYear + 20; year++) {
      years.push(year);
    }
    return years;
  };

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

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

  const handleMonthSelect = (monthIndex: number) => {
    const newMonth = new Date(currentMonth);
    newMonth.setMonth(monthIndex);
    setCurrentMonth(newMonth);
    setShowMonthPicker(false);
  };

  const handleYearSelect = (year: number) => {
    const newMonth = new Date(currentMonth);
    newMonth.setFullYear(year);
    setCurrentMonth(newMonth);
    setShowYearPicker(false);
  };

  const scrollToCurrentYear = () => {
    // This would ideally scroll to the current year in the picker
    // Implementation would require ref to ScrollView
    return currentMonth.getFullYear();
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
          <Pressable 
            style={styles.modalOverlay}
            onPress={() => {
              setShowOptions(false);
              setShowMonthPicker(false);
              setShowYearPicker(false);
            }}
          >
            <Pressable 
              style={[styles.datePickerModal, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => {}} // Prevent closing when tapping inside modal
            >
              {/* Header */}
              <View style={styles.datePickerHeader}>
                <TouchableOpacity 
                  style={styles.monthNavButton}
                  onPress={() => navigateMonth('prev')}
                >
                  <Text style={[styles.monthNavText, { color: theme.primary }]}>‹</Text>
                </TouchableOpacity>
                
                <View style={styles.monthYearContainer}>
                  <TouchableOpacity 
                    style={[styles.monthYearButton, { borderColor: theme.border }]}
                    onPress={() => {
                      setShowMonthPicker(true);
                      setShowYearPicker(false);
                    }}
                  >
                    <Text style={[styles.monthYearButtonText, { color: theme.text }]}>
                      {currentMonth.toLocaleDateString('en-US', { month: 'long' })}
                    </Text>
                    <Text style={[styles.dropdownArrow, { color: theme.textSecondary }]}>▼</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity 
                    style={[styles.monthYearButton, { borderColor: theme.border }]}
                    onPress={() => {
                      setShowYearPicker(true);
                      setShowMonthPicker(false);
                    }}
                  >
                    <Text style={[styles.monthYearButtonText, { color: theme.text }]}>
                      {currentMonth.getFullYear()}
                    </Text>
                    <Text style={[styles.dropdownArrow, { color: theme.textSecondary }]}>▼</Text>
                  </TouchableOpacity>
                </View>
                
                <TouchableOpacity 
                  style={styles.monthNavButton}
                  onPress={() => navigateMonth('next')}
                >
                  <Text style={[styles.monthNavText, { color: theme.primary }]}>›</Text>
                </TouchableOpacity>
              </View>

              {/* Month Picker Dropdown */}
              {showMonthPicker && (
                <View style={[styles.pickerDropdown, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <View style={[styles.pickerHeader, { borderBottomColor: theme.border }]}>
                    <Text style={[styles.pickerHeaderText, { color: theme.text }]}>Select Month</Text>
                    <TouchableOpacity 
                      style={[styles.pickerCloseButton, { backgroundColor: theme.primary + '15' }]}
                      onPress={() => setShowMonthPicker(false)}
                    >
                      <Text style={[styles.pickerCloseText, { color: theme.primary }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={months}
                    keyExtractor={(item, index) => index.toString()}
                    style={[styles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={styles.pickerScrollContent}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={Platform.OS === 'android'}
                    keyboardShouldPersistTaps="handled"
                    bounces={Platform.OS === 'ios'}
                    overScrollMode={Platform.OS === 'android' ? 'always' : undefined}
                    renderItem={({ item: month, index }) => (
                      <TouchableOpacity
                        style={[
                          styles.pickerItem,
                          {
                            backgroundColor: currentMonth.getMonth() === index ? theme.primary + '20' : theme.surface
                          }
                        ]}
                        onPress={() => handleMonthSelect(index)}
                        activeOpacity={0.7}
                      >
                        <Text style={[
                          styles.pickerItemText,
                          {
                            color: currentMonth.getMonth() === index ? theme.primary : theme.text,
                            fontWeight: currentMonth.getMonth() === index ? '600' : '400'
                          }
                        ]}>
                          {month}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {/* Year Picker Dropdown */}
              {showYearPicker && (
                <View style={[styles.pickerDropdown, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <View style={[styles.pickerHeader, { borderBottomColor: theme.border }]}>
                    <Text style={[styles.pickerHeaderText, { color: theme.text }]}>Select Year</Text>
                    <TouchableOpacity 
                      style={[styles.pickerCloseButton, { backgroundColor: theme.primary + '15' }]}
                      onPress={() => setShowYearPicker(false)}
                    >
                      <Text style={[styles.pickerCloseText, { color: theme.primary }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={generateYearRange()}
                    keyExtractor={(item) => item.toString()}
                    style={[styles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={styles.pickerScrollContent}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={Platform.OS === 'android'}
                    keyboardShouldPersistTaps="handled"
                    bounces={Platform.OS === 'ios'}
                    overScrollMode={Platform.OS === 'android' ? 'always' : undefined}
                    renderItem={({ item: year }) => (
                      <TouchableOpacity
                        style={[
                          styles.pickerItem,
                          {
                            backgroundColor: currentMonth.getFullYear() === year ? theme.primary + '20' : theme.surface
                          }
                        ]}
                        onPress={() => handleYearSelect(year)}
                        activeOpacity={0.7}
                      >
                        <Text style={[
                          styles.pickerItemText,
                          {
                            color: currentMonth.getFullYear() === year ? theme.primary : theme.text,
                            fontWeight: currentMonth.getFullYear() === year ? '600' : '400'
                          }
                        ]}>
                          {year}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}
              
              {/* Calendar view - only show when not showing month/year pickers */}
              {!showMonthPicker && !showYearPicker && (
                <View>
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
                      const isDisabled = !allowFutureDates && isFutureDate(date);
                      return (
                        <TouchableOpacity
                          key={index}
                          style={[
                            styles.calendarDay,
                            {
                              backgroundColor: isSelectedDate(date) ? theme.primary : 'transparent',
                              opacity: isCurrentMonth(date) ? (isDisabled ? 0.3 : 1) : 0.3,
                            }
                          ]}
                          onPress={() => handleDateSelect(date)}
                          disabled={isDisabled}
                        >
                          <Text style={[
                            styles.calendarDayText,
                            {
                              color: isSelectedDate(date) ? '#ffffff' : 
                                     isDisabled ? theme.textSecondary : theme.text,
                              fontWeight: isSelectedDate(date) ? '600' : '400',
                            }
                          ]}>
                            {date.getDate()}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}
            </Pressable>
          </Pressable>
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
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  helperText: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
    fontStyle: 'italic',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
    marginBottom: 0, // Added margin to separate from stats
  },
  title: {
    fontSize: 28,
    fontFamily: 'Poppins-Bold',
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#6366f1',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginVertical: Platform.OS === 'web' ? 16 : 10,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  searchIcon: {
    marginRight: 12,
  },
  searchInput: {
    flex: 1,
    paddingVertical: Platform.OS === 'web' ? 16 : 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  searchInfo: {
    marginHorizontal: 20,
    marginBottom: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  searchInfoText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  studentsList: {
    flex: 1,
  },
  searchStickyWrapper: {
    width: '100%',
    zIndex: 20,
    elevation: 0,
  },
  studentCard: {
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    marginHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  studentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  studentInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  avatarContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  studentAvatarImage: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  studentDetails: {
    flex: 1,
  },
  studentNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  studentName: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    flex: 1,
  },
  orderIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  orderText: {
    fontSize: 10,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  studentGrade: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  gradeStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusIndicator: {
    paddingHorizontal: 8,
    paddingVertical: 1,
    borderRadius: 8,
    marginLeft: 8,
  },
  statusIndicatorText: {
    fontSize: 10,
    fontFamily: 'Inter-SemiBold',
  },
  moreButton: {
    padding: 8,
  },
  actionButtons: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
  },
  moveButton: {
    width: 32,
    height: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  deleteButton: {
    width: 32,
    height: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginTop: 2,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  subjectsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  subjectTag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
    marginRight: 8,
    marginBottom: 6,
  },
  subjectText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  studentStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statIcon: {
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginBottom: 2,
  },
  statValue: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  attendanceValueContainer: {
    alignItems: 'center',
  },
  attendanceDays: {
    fontSize: 10,
    fontFamily: 'Inter-Regular',
    marginTop: 1,
  },
  contactInfo: {
    marginBottom: 5,
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  contactText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginLeft: 8,
  },
  feeInfo: {
    flexDirection: 'column',
    paddingTop: 5,
    borderTopWidth: 1,
    gap: 2,
  },
  feeInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  feeDetails: {
    flex: 1,
  },
  monthlyFee: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  dueDateText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 1,
  },
  joinDate: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  deleteButtonSmall: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  emptyState: {
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 32,
    marginHorizontal: 20,
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
    paddingTop: 60,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  cancelText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  saveText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  saveButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  formGroup: {
    marginBottom: 20,
  },
  labelText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  sectionHeader: {
    marginTop: 24,
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  requiredNote: {
    marginTop: 24,
    paddingHorizontal: 4,
  },
  requiredNoteText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    fontStyle: 'italic',
  },
  profilePictureContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  profilePictureButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  profilePicturePreview: {
    width: '100%',
    height: '100%',
    borderRadius: 60,
  },
  profilePicturePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  profilePictureText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 8,
    textAlign: 'center',
  },
  removeImageButton: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
  },
  removeImageText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  performanceContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  performanceOption: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
    marginBottom: 8,
  },
  performanceOptionText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
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
  optionsModal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    minWidth: 200,
    maxWidth: 280,
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
  optionItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
  },
  optionText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  datePickerText: {
    fontSize: 16,
    fontWeight: '500',
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
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  attendanceButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    shadowColor: '#6366f1',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  downloadButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    shadowColor: '#10b981',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  statsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 8, // reduced from 20
    paddingVertical: 6, // reduced from 16
    marginTop: 10,
    marginBottom: -5, // reduced from 8
    borderRadius: 8, // reduced from 12
    marginHorizontal: 8, // reduced from 20
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1, // reduced shadow
    },
    shadowOpacity: 0.03,
    shadowRadius: 3,
    elevation: 1,
    // marginTop: 8, // less space
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6, // reduced from 12
    borderRadius: 6, // reduced from 8
    marginHorizontal: 2, // reduced from 4
  },
  statNumber: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
    marginBottom: Platform.OS === 'web' ? 1 : -7,
  },
  statsLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  deleteConfirmationModal: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 0,
    minWidth: 300,
    maxWidth: '85%',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 16,
    overflow: 'hidden',
  },
  deleteModalHeader: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  deleteModalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    textAlign: 'center',
  },
  deleteModalContent: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  deleteModalText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 8,
  },
  deleteModalStudentName: {
    fontFamily: 'Inter-SemiBold',
  },
  deleteModalWarning: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
    fontStyle: 'italic',
    marginTop: 16,
  },
  deleteWarningBox: {
    marginVertical: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  deleteWarningTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  deleteWarningList: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 20,
  },
  deleteModalButtons: {
    flexDirection: 'row',
  },
  deleteModalButton: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
  },
  cancelButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  confirmDeleteButton: {
    // No additional styles needed, inherits from deleteModalButton
  },
  confirmDeleteButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  deletingStateContainer: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  deletingStateText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 12,
  },
  deletingStateSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
    fontStyle: 'italic',
  },
  // Enhanced Date Picker Styles
  monthYearContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    justifyContent: 'center',
  },
  monthYearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 6,
    minWidth: 80,
    justifyContent: 'center',
    gap: 4,
  },
  monthYearButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  dropdownArrow: {
    fontSize: 10,
    marginLeft: 4,
  },
  pickerDropdown: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 8,
    height: 280,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  pickerScrollView: {
    flex: 1,
    height: 220,
  },
  pickerScrollContent: {
    paddingVertical: 8,
  },
  pickerItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  pickerItemText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  pickerHeaderText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  pickerCloseButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerCloseText: {
    fontSize: 12,
    fontFamily: 'Inter-Bold',
  },
  // Subjects preview styles
  subjectsPreview: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
  },
  subjectsPreviewLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginBottom: 8,
  },
  removeSubjectButton: {
    marginLeft: 6,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeSubjectText: {
    fontSize: 14,
    fontFamily: 'Inter-Bold',
    lineHeight: 16,
  },
  subjectsInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  subjectsInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    minHeight: 48, // Fixed height to match button
  },
  addSubjectsButton: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
    height: 48, // Match input height
  },
  addSubjectsButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
});