import { logger } from '@/lib/logger';
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  Image,
  ActivityIndicator,
  Modal,
  FlatList,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { 
  User, 
  Phone, 
  Mail, 
  MapPin, 
  Calendar, 
  GraduationCap, 
  TrendingUp, 
  Edit3,
  Save,
  X,
  ArrowLeft,
  MessageCircle,
  Shield,
  Users,
  AlertTriangle,
} from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { useTheme } from '../../hooks/useTheme';
import useFees from '../../hooks/useFees';
import { useAttendance } from '../../hooks/useAttendance';
import { Student } from '../../types';
import { studentService } from '../../services/studentService';
import { MediaPickerUtil } from '../../lib/mediaPickerUtil';
import { uploadBlobViaBackend } from '../../services/backendStorageUploadService';
import { formatDateToString } from '../../lib/utils';
import { chatService } from '../../services/chatService';
import { useTenant } from '../../hooks/useTenantContext';

export default function StudentProfile() {
  const { id, edit } = useLocalSearchParams<{ id: string; edit?: string }>();
  const router = useRouter();
  const { theme } = useTheme();
  const { fees, loading: feesLoading } = useFees();
  const { activeTenant } = useTenant();
  
  // Attendance hook for calculated attendance percentage
  const { 
    attendanceRecords, 
    loading: attendanceLoading, 
    getAttendancePercentage 
  } = useAttendance(id ? [id] : []);
  
  const [student, setStudent] = useState<Student | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [editedStudent, setEditedStudent] = useState<Student | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  // Simple form error state for inline validation messages
  const [errors, setErrors] = useState<{
    name?: string;
    grade?: string;
    phone?: string;
    parentName?: string;
    parentContact?: string;
    monthlyFee?: string;
    feeDueDate?: string;
    email?: string;
    parentEmail?: string;
    parentWhatsApp?: string;
    emergencyContact?: string;
  }>({});

  // Allow deep-link / navigation to open directly in edit mode.
  useEffect(() => {
    if (String(edit || '') === '1') {
      setIsEditing(true);
    }
  }, [edit]);

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

  // Helper function to get correct amount for a fee record
  const getCorrectFeeAmount = (record: any): number => {
    if (record.monthFeeAmounts && record.monthsCovered) {
      // Use sum of individual month amounts for consolidated fees
      return record.monthsCovered.reduce((sum: number, month: string) => 
        sum + (record.monthFeeAmounts?.[month] || 0), 0);
    }
    // Fallback to stored amount
    return record.amount || 0;
  };

  // Helper function to calculate fee totals for the student
  const calculateFeeInfo = () => {
    if (!id || !fees || feesLoading) {
      return { totalFees: 0, feesPaid: 0, outstanding: 0 };
    }

    const studentFees = fees.filter(fee => fee.studentId === id);
    
    const totalFees = studentFees.reduce((sum, fee) => sum + getCorrectFeeAmount(fee), 0);
    const feesPaid = studentFees.reduce((sum, fee) => sum + (fee.paidAmount || 0), 0);
    const outstanding = totalFees - feesPaid;

    return { totalFees, feesPaid, outstanding };
  };

  useEffect(() => {
    loadStudent();
  }, [id, activeTenant?.id]);

  const loadStudent = async () => {
    try {
      if (!id || !activeTenant?.id) {
        setStudent(null);
        setEditedStudent(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      const studentData = await studentService.getStudentById(activeTenant.id, id);
      setStudent(studentData);
      setEditedStudent(studentData);
    } catch (error) {
      logger.error('Error loading student:', error);
      Alert.alert('Error', 'Failed to load student details');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditedStudent(student);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedStudent(student);
    setSelectedImage(null);
  };

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
      
      const tenantId = (activeTenant?.id || student?.tenantId || '').trim();
      if (!tenantId) {
        throw new Error('Select a coaching center before uploading student profile images.');
      }

      const timestamp = Date.now();
      const fileName = `student_profile_${timestamp}.jpg`;
      
      let blob: Blob;
      if (imageUri.startsWith('data:')) {
        const response = await fetch(imageUri);
        blob = await response.blob();
      } else {
        const response = await fetch(imageUri);
        blob = await response.blob();
      }
      
      const result = await uploadBlobViaBackend({
        tenantId,
        purpose: 'studentProfile',
        blob,
        contentType: blob.type || 'image/jpeg',
        filename: fileName,
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
          setSelectedImage(imageUri);
        }
      }
    } catch (error) {
      logger.error('Error selecting image:', error);
      Alert.alert('Error', 'Failed to select image. Please try again.');
    }
  };

  const validateForm = (): boolean => {
    if (!editedStudent) return false;
    // Build errors like Add Student form
    const nextErrors: typeof errors = {};

    const phoneRegex = /^[\+]?[0-9\s\-()]{10,}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Required fields
    if (!editedStudent.name?.trim()) {
      nextErrors.name = 'Student name is required';
    }
    if (!editedStudent.grade?.trim()) {
      nextErrors.grade = 'Grade is required';
    }
    if (!editedStudent.phone?.trim()) {
      nextErrors.phone = 'Student phone number is required';
    } else if (!phoneRegex.test(editedStudent.phone)) {
      nextErrors.phone = 'Please enter a valid phone number';
    }
    if (!editedStudent.parentName?.trim()) {
      nextErrors.parentName = 'Parent/Guardian name is required';
    }
    if (!editedStudent.parentContact?.trim()) {
      nextErrors.parentContact = 'Parent contact number is required';
    } else if (!phoneRegex.test(editedStudent.parentContact)) {
      nextErrors.parentContact = 'Please enter a valid phone number';
    }
    if (!editedStudent.monthlyFee || editedStudent.monthlyFee <= 0) {
      nextErrors.monthlyFee = 'Monthly fee is required and must be greater than 0';
    }
    if (!editedStudent.feeDueDate || editedStudent.feeDueDate < 1 || editedStudent.feeDueDate > 31) {
      nextErrors.feeDueDate = 'Fee due date is required and must be between 1 and 31';
    }

    // Optional field validations
    if (editedStudent.email && !emailRegex.test(editedStudent.email)) {
      nextErrors.email = 'Please enter a valid email address';
    }
    if (editedStudent.parentEmail && !emailRegex.test(editedStudent.parentEmail)) {
      nextErrors.parentEmail = 'Please enter a valid parent email address';
    }
    if (editedStudent.parentWhatsApp && !phoneRegex.test(editedStudent.parentWhatsApp)) {
      nextErrors.parentWhatsApp = 'Please enter a valid WhatsApp number';
    }
    if (editedStudent.emergencyContact && !phoneRegex.test(editedStudent.emergencyContact)) {
      nextErrors.emergencyContact = 'Please enter a valid emergency contact number';
    }

    setErrors(nextErrors);
    const isValid = Object.keys(nextErrors).length === 0;
    if (!isValid) {
      Alert.alert('Validation Error', 'Please fix the errors below and try again.');
    }
    return isValid;
  };

  const handleSave = async () => {
    try {
      if (!editedStudent || !validateForm()) return;
      if (!activeTenant?.id) {
        Alert.alert('Select Coaching Center', 'Please select a coaching center before saving changes.');
        return;
      }
      
      setSaving(true);
      
      let updatedData = { ...editedStudent };
      
      // Upload new profile image if selected
      if (selectedImage) {
        const existingImageUrl = editedStudent.profileImageUrl;
        const uploadedUrl = await uploadProfileImage(selectedImage, existingImageUrl);
        if (uploadedUrl) {
          updatedData.profileImageUrl = uploadedUrl;
        }
      }
      
      // Check if fee due date has changed
      const feeDueDateChanged = student?.feeDueDate !== editedStudent.feeDueDate;
      
      logger.debug('🔄 Fee due date change check:', {
        original: student?.feeDueDate,
        new: editedStudent.feeDueDate,
        changed: feeDueDateChanged
      });
      
      await studentService.updateStudent(activeTenant.id, editedStudent.id, updatedData);
      
      // Update fee records if fee due date changed
      if (feeDueDateChanged && editedStudent.feeDueDate) {
        try {
          logger.debug('🔄 Fee due date changed, updating pending fee records...');
          
          // Show info toast that fee updates are starting
          Toast.show({
            type: 'info',
            text1: '🔄 Updating Fee Records',
            text2: 'Updating due dates for pending fees...',
            position: 'top',
            visibilityTime: 2000,
          });
          
          const updatedFeesCount = await studentService.updateStudentFeeDueDates(
            activeTenant.id,
            editedStudent.id, 
            editedStudent.feeDueDate
          );
          
          // Show success toast for fee updates
          Toast.show({
            type: 'success',
            text1: '📅 Existing Fee Due Dates Updated',
            text2: updatedFeesCount > 0 ? 
              `Updated ${updatedFeesCount} existing pending fees` : 
              'No pending fees found to update',
            position: 'top',
            visibilityTime: 3000,
          });
          
        } catch (feeUpdateError) {
          logger.warn('⚠️ Failed to update fee records:', feeUpdateError);
          
          // Show warning toast for fee update failure
          Toast.show({
            type: 'error',
            text1: '⚠️ Fee Update Warning',
            text2: 'Student updated but fee records may need manual update',
            position: 'top',
            visibilityTime: 4000,
          });
          
          // Don't throw here as student update was successful
        }
      }
      
      setStudent(updatedData);
      setIsEditing(false);
      setSelectedImage(null);
      
      // Show success message with fee update info if applicable
      if (feeDueDateChanged && editedStudent.feeDueDate) {
        Alert.alert(
          'Success', 
          'Student details updated successfully! Due dates for existing pending fees have been updated. No new fees were created.'
        );
      } else {
        Alert.alert('Success', 'Student details updated successfully');
      }
      
    } catch (error) {
      logger.error('Error saving student:', error);
      Alert.alert('Error', 'Failed to save changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: keyof Student, value: any) => {
    if (!editedStudent) return;
    setEditedStudent({ ...editedStudent, [field]: value });
    // Clear specific field errors on change
    if (
      field === 'name' ||
      field === 'grade' ||
      field === 'phone' ||
      field === 'parentName' ||
      field === 'parentContact' ||
      field === 'monthlyFee' ||
      field === 'feeDueDate' ||
      field === 'email' ||
      field === 'parentEmail' ||
      field === 'parentWhatsApp' ||
      field === 'emergencyContact'
    ) {
      setErrors(prev => ({ ...prev, [field]: undefined } as any));
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

  if (loading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading student details...</Text>
      </View>
    );
  }

  if (!student) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <Text style={[styles.errorText, { color: theme.error }]}>Student not found</Text>
        <TouchableOpacity 
          style={[styles.backButton, { backgroundColor: theme.primary }]} 
          onPress={() => router.back()}
        >
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const displayStudent = isEditing ? editedStudent : student;
  const displayImage = selectedImage || displayStudent?.profileImageUrl;
  const formErrorMessages = Object.values(errors).filter((message): message is string => !!message);
  const hasFormErrors = formErrorMessages.length > 0;
  const firstFormError = formErrorMessages[0];

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.surface }]}>
        <TouchableOpacity 
          style={styles.headerButton} 
          onPress={isEditing ? handleCancelEdit : () => router.back()}
        >
          {isEditing ? (
            <X size={24} color={theme.textSecondary} />
          ) : (
            <ArrowLeft size={24} color={theme.text} />
          )}
        </TouchableOpacity>
        
        <Text style={[styles.headerTitle, { color: theme.text }]}>Student Profile</Text>
        
        <TouchableOpacity 
          style={styles.headerButton} 
          onPress={isEditing ? (isSaving ? undefined : handleSave) : handleEdit}
          disabled={isSaving}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : isEditing ? (
            <Save size={24} color={theme.primary} />
          ) : (
            <Edit3 size={24} color={theme.primary} />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={{
          paddingBottom: Platform.select({ web: 20, default: 20 }),
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Image Section */}
        <View style={[styles.profileSection, { backgroundColor: theme.surface }]}>
          <View style={styles.profileImageContainer}>
            {displayImage ? (
              <Image source={{ uri: displayImage }} style={styles.profileImage} />
            ) : (
              <View style={[styles.profileImagePlaceholder, { backgroundColor: `${theme.primary}15` }]}>
                <User size={60} color={theme.primary} />
              </View>
            )}
            
            {isEditing && (
              <TouchableOpacity 
                style={[styles.editImageButton, { backgroundColor: theme.primary }]}
                onPress={handleSelectProfileImage}
                disabled={isUploadingImage}
              >
                <Edit3 size={16} color="#ffffff" />
              </TouchableOpacity>
            )}
          </View>
          
          <View style={styles.profileInfo}>
            {isEditing ? (
              <>
                <TextInput
                  style={[
                    styles.editableTitle, 
                    { color: theme.text, borderBottomColor: errors.name ? theme.error : theme.border }
                  ]}
                  value={editedStudent?.name || ''}
                  onChangeText={(text) => updateField('name', text)}
                  placeholder="Student Name"
                  placeholderTextColor={theme.textSecondary}
                />
                {!!errors.name && (
                  <Text style={[styles.fieldErrorText, { color: theme.error }]}>{errors.name}</Text>
                )}
              </>
            ) : (
              <Text style={[styles.profileName, { color: theme.text }]}>{displayStudent?.name}</Text>
            )}
            
            <View style={[styles.statusBadge, { 
              backgroundColor: displayStudent?.status === 'active' ? theme.success + '20' : 
                              displayStudent?.status === 'suspended' ? theme.warning + '20' : theme.error + '20' 
            }]}>
              {isEditing ? (
                <StatusSelector
                  selectedStatus={editedStudent?.status || 'active'}
                  onSelect={(status) => updateField('status', status)}
                  theme={theme}
                />
              ) : (
                <Text style={[styles.statusText, { 
                  color: displayStudent?.status === 'active' ? theme.success : 
                         displayStudent?.status === 'suspended' ? theme.warning : theme.error 
                }]}>
                  {displayStudent?.status?.toUpperCase()}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Quick Stats */}
        <View style={[styles.statsSection, { backgroundColor: theme.surface }]}>
          <View style={styles.statItem}>
            <TrendingUp size={20} color={theme.primary} />
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Performance</Text>
            {isEditing ? (
              <PerformanceSelector
                selectedPerformance={editedStudent?.performance || 'Good'}
                onSelect={(performance) => updateField('performance', performance)}
                theme={theme}
              />
            ) : (
              <Text style={[styles.statValue, { color: getPerformanceColor(displayStudent?.performance || 'Good') }]}>
                {displayStudent?.performance || 'Good'}
              </Text>
            )}
          </View>
          
          <View style={styles.statItem}>
            <Calendar size={20} color={theme.primary} />
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Attendance</Text>
            <Text style={[styles.statValue, { color: theme.success }]}>
              {id ? (getAttendancePercentage(id) ?? displayStudent?.attendance ?? 0) : (displayStudent?.attendance ?? 0)}%
            </Text>
          </View>
        </View>

        {/* Personal Information */}
        <View style={[styles.section, { backgroundColor: theme.surface }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Personal Information</Text>
          
          <InfoField
            icon={<GraduationCap size={20} color={theme.textSecondary} />}
            label="Grade"
            value={displayStudent?.grade || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('grade', text)}
            theme={theme}
            errorText={isEditing ? errors.grade : undefined}
          />
          
          <InfoField
            icon={<Mail size={20} color={theme.textSecondary} />}
            label="Email"
            value={displayStudent?.email || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('email', text)}
            theme={theme}
            keyboardType="email-address"
            errorText={isEditing ? errors.email : undefined}
          />
          
          <InfoField
            icon={<Phone size={20} color={theme.textSecondary} />}
            label="Phone"
            value={displayStudent?.phone || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('phone', text)}
            theme={theme}
            keyboardType="phone-pad"
            errorText={isEditing ? errors.phone : undefined}
          />
          
          {/* Date of Birth with calendar picker */}
          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Calendar size={20} color={theme.textSecondary} />
            </View>
            <View style={styles.infoContent}>
              <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Date of Birth</Text>
              {isEditing ? (
                <DatePicker
                  selectedDate={editedStudent?.dateOfBirth || ''}
                  onSelect={(date: string) => {
                    updateField('dateOfBirth', date);
                  }}
                  theme={theme}
                  placeholder="Select date of birth"
                  allowFutureDates={false}
                />
              ) : (
                <Text style={[styles.infoValue, { color: theme.text }]}>
                  {displayStudent?.dateOfBirth ? new Date(displayStudent.dateOfBirth).toLocaleDateString('en-US', { 
                    year: 'numeric', 
                    month: 'short', 
                    day: 'numeric' 
                  }) : 'No date of birth provided'}
                </Text>
              )}
            </View>
          </View>
          
          <InfoField
            icon={<MapPin size={20} color={theme.textSecondary} />}
            label="Address"
            value={displayStudent?.address || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('address', text)}
            theme={theme}
            multiline
          />
        </View>

        {/* Parent/Guardian Information */}
        <View style={[styles.section, { backgroundColor: theme.surface }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Parent/Guardian Information</Text>
          
          <InfoField
            icon={<User size={20} color={theme.textSecondary} />}
            label="Parent Name"
            value={displayStudent?.parentName || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('parentName', text)}
            theme={theme}
            errorText={isEditing ? errors.parentName : undefined}
          />
          
          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Users size={20} color={theme.textSecondary} />
            </View>
            <View style={styles.infoContent}>
              <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Relationship</Text>
              {isEditing ? (
                <RelationshipSelector
                  selectedRelation={editedStudent?.parentRelation || 'Parent'}
                  onSelect={(relation) => updateField('parentRelation', relation)}
                  theme={theme}
                />
              ) : (
                <Text style={[styles.infoValue, { color: theme.text }]}>
                  {displayStudent?.parentRelation || 'Parent'}
                </Text>
              )}
            </View>
          </View>
          
          <InfoField
            icon={<Phone size={20} color={theme.textSecondary} />}
            label="Parent Contact"
            value={displayStudent?.parentContact || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('parentContact', text)}
            theme={theme}
            keyboardType="phone-pad"
            errorText={isEditing ? errors.parentContact : undefined}
          />
          
          <InfoField
            icon={<Mail size={20} color={theme.textSecondary} />}
            label="Parent Email"
            value={displayStudent?.parentEmail || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('parentEmail', text)}
            theme={theme}
            keyboardType="email-address"
            errorText={isEditing ? errors.parentEmail : undefined}
          />
          
          <InfoField
            icon={<MessageCircle size={20} color={theme.success} />}
            label="WhatsApp"
            value={displayStudent?.parentWhatsApp || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('parentWhatsApp', text)}
            theme={theme}
            keyboardType="phone-pad"
            errorText={isEditing ? errors.parentWhatsApp : undefined}
          />
          
          <InfoField
            icon={<Shield size={20} color={theme.error} />}
            label="Emergency Contact"
            value={displayStudent?.emergencyContact || ''}
            isEditing={isEditing}
            onChangeText={(text) => updateField('emergencyContact', text)}
            theme={theme}
            keyboardType="phone-pad"
            errorText={isEditing ? errors.emergencyContact : undefined}
          />
        </View>

        {/* Academic Information */}
        <View style={[styles.section, { backgroundColor: theme.surface }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Academic Information</Text>
          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Calendar size={20} color={theme.textSecondary} />
            </View>
            <View style={styles.infoContent}>
              <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Joined Date</Text>
              {isEditing ? (
                <DatePicker
                  selectedDate={editedStudent?.joinDate || editedStudent?.enrollmentDate || ''}
                  onSelect={(date: string) => updateField('joinDate', date)}
                  theme={theme}
                  placeholder="Select joined date"
                  allowFutureDates={false}
                />
              ) : (
                <Text style={[styles.infoValue, { color: theme.text }]}> 
                  {(displayStudent?.joinDate || displayStudent?.enrollmentDate) ? new Date(displayStudent?.joinDate || displayStudent?.enrollmentDate).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                  }) : 'No joined date provided'}
                </Text>
              )}
            </View>
          </View>
          
          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <GraduationCap size={20} color={theme.textSecondary} />
            </View>
            <View style={styles.infoContent}>
              <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Subjects</Text>
              {isEditing ? (
                <SubjectEditor
                  subjects={editedStudent?.subjects || []}
                  onSubjectsChange={(subjects) => updateField('subjects', subjects)}
                  theme={theme}
                />
              ) : (
                <View style={styles.subjectsContainer}>
                  {(displayStudent?.subjects || []).map((subject, index) => (
                    <View key={index} style={[styles.subjectTag, { backgroundColor: theme.background }]}>
                      <Text style={[styles.subjectText, { color: theme.textSecondary }]}>{subject}</Text>
                    </View>
                  ))}
                  {(!displayStudent?.subjects || displayStudent.subjects.length === 0) && (
                    <Text style={[styles.infoValue, { color: theme.textSecondary }]}>No subjects assigned</Text>
                  )}
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Fee Information */}
        <View style={[styles.section, { backgroundColor: theme.surface }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Fee Information</Text>
          
          {(() => {
            const feeInfo = calculateFeeInfo();
            return (
              <View>
                <View style={styles.feeRow}>
                  <Text style={[styles.feeLabel, { color: theme.textSecondary }]}>Monthly Fee</Text>
                  {isEditing ? (
                    <TextInput
                      style={[styles.editableFeeValue, { color: theme.success, borderBottomColor: errors.monthlyFee ? theme.error : theme.border }]}
                      value={editedStudent?.monthlyFee?.toString() || '0'}
                      onChangeText={(text) => updateField('monthlyFee', parseInt(text) || 0)}
                      keyboardType="numeric"
                      placeholder="0"
                      placeholderTextColor={theme.textSecondary}
                    />
                  ) : (
                    <Text style={[styles.feeValue, { color: theme.success }]}>
                      ₹{(displayStudent?.monthlyFee || 0).toLocaleString()}
                    </Text>
                  )}
                </View>
                {isEditing && !!errors.monthlyFee && (
                  <Text style={[styles.fieldErrorText, { color: theme.error, textAlign: 'right', marginBottom: 6 }]}>{errors.monthlyFee}</Text>
                )}
                
                <View style={styles.feeRow}>
                  <Text style={[styles.feeLabel, { color: theme.textSecondary }]}>Total Fees</Text>
                  <Text style={[styles.feeValue, { color: theme.text }]}>
                    ₹{feeInfo.totalFees.toLocaleString()}
                  </Text>
                </View>

                <View style={styles.feeRow}>
                  <Text style={[styles.feeLabel, { color: theme.textSecondary }]}>Fee Due Date</Text>
                  {isEditing ? (
                    <View style={styles.editableFeeContainer}>
                      <TextInput
                        style={[styles.editableFeeValue, { color: theme.warning, borderBottomColor: errors.feeDueDate ? theme.error : theme.border }]}
                        value={editedStudent?.feeDueDate ? editedStudent.feeDueDate.toString() : ''}
                        onChangeText={(text) => {
                          if (text === '') {
                            updateField('feeDueDate', undefined);
                          } else {
                            const day = parseInt(text);
                            if (!isNaN(day)) {
                              updateField('feeDueDate', Math.min(Math.max(day, 1), 31));
                            }
                          }
                        }}
                        keyboardType="numeric"
                        placeholder="1"
                        placeholderTextColor={theme.textSecondary}
                      />
                      <Text style={[styles.feeHelperText, { color: theme.textSecondary }]}>
                        (1-31)
                      </Text>
                    </View>
                  ) : (
                    <Text style={[styles.feeValue, { color: theme.warning }]}>
                      {displayStudent?.feeDueDate ? 
                        `${displayStudent.feeDueDate}${getOrdinalSuffix(displayStudent.feeDueDate)} of every month` : 
                        'No due date set'
                      }
                    </Text>
                  )}
                </View>
                {isEditing && !!errors.feeDueDate && (
                  <Text style={[styles.fieldErrorText, { color: theme.error, textAlign: 'right', marginBottom: 6 }]}>{errors.feeDueDate}</Text>
                )}
                
                <View style={styles.feeRow}>
                  <Text style={[styles.feeLabel, { color: theme.textSecondary }]}>Fees Paid</Text>
                  <Text style={[styles.feeValue, { color: theme.primary }]}>
                    ₹{feeInfo.feesPaid.toLocaleString()}
                  </Text>
                </View>
                
                <View style={styles.feeRow}>
                  <Text style={[styles.feeLabel, { color: theme.textSecondary }]}>Outstanding</Text>
                  <Text style={[styles.feeValue, { color: theme.error }]}>
                    ₹{feeInfo.outstanding.toLocaleString()}
                  </Text>
                </View>
                
                {displayStudent?.lastPaymentDate && (
                  <View style={styles.feeRow}>
                    <Text style={[styles.feeLabel, { color: theme.textSecondary }]}>Last Payment</Text>
                    <Text style={[styles.feeValue, { color: theme.textSecondary }]}>
                      {new Date(displayStudent.lastPaymentDate).toLocaleDateString()}
                    </Text>
                  </View>
                )}
              </View>
            );
          })()}
        </View>

        {isEditing && (
          <View style={styles.editActionsWrapper}>
            {hasFormErrors && (
              <View
                style={[
                  styles.inlineErrorContainer,
                  { backgroundColor: theme.error + '10', borderColor: theme.error + '40' },
                ]}
              >
                <AlertTriangle size={20} color={theme.error} />
                <Text style={[styles.inlineErrorText, { color: theme.error }]}>
                  {firstFormError || 'Please resolve the highlighted errors before saving.'}
                </Text>
              </View>
            )}

            <View style={styles.editActions}>
              <TouchableOpacity 
                style={[styles.cancelButton, { backgroundColor: theme.background, borderColor: theme.border }]}
                onPress={handleCancelEdit}
              >
                <X size={20} color={theme.textSecondary} />
                <Text style={[styles.cancelButtonText, { color: theme.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.saveButton, { backgroundColor: theme.primary }]}
                onPress={handleSave}
                disabled={isSaving}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Save size={20} color="#ffffff" />
                )}
                <Text style={styles.saveButtonText}>
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// Helper component for editable info fields
interface InfoFieldProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  isEditing: boolean;
  onChangeText: (text: string) => void;
  theme: any;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  multiline?: boolean;
  errorText?: string;
}

function InfoField({ icon, label, value, isEditing, onChangeText, theme, keyboardType = 'default', multiline = false, errorText }: InfoFieldProps) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoIcon}>
        {icon}
      </View>
      <View style={styles.infoContent}>
        <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>{label}</Text>
        {isEditing ? (
          <TextInput
            style={[
              styles.editableInput, 
              { 
                color: theme.text, 
                borderBottomColor: errorText ? theme.error : theme.border,
                minHeight: multiline ? 60 : 40 
              }
            ]}
            value={value}
            onChangeText={onChangeText}
            placeholder={`Enter ${label.toLowerCase()}`}
            placeholderTextColor={theme.textSecondary}
            keyboardType={keyboardType}
            multiline={multiline}
          />
        ) : (
          <Text style={[styles.infoValue, { color: theme.text }]}>
            {value || `No ${label.toLowerCase()} provided`}
          </Text>
        )}
        {!!errorText && isEditing && (
          <Text style={[styles.fieldErrorText, { color: theme.error }]}>{errorText}</Text>
        )}
      </View>
    </View>
  );
}

// Performance Selector Component
interface PerformanceSelectorProps {
  selectedPerformance: string;
  onSelect: (performance: string) => void;
  theme: any;
}

function PerformanceSelector({ selectedPerformance, onSelect, theme }: PerformanceSelectorProps) {
  const [showOptions, setShowOptions] = useState(false);
  const performanceOptions = ['Excellent', 'Very Good', 'Good', 'Average', 'Needs Improvement'];

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

  return (
    <View>
      <TouchableOpacity
        style={[styles.performanceSelector, { 
          borderColor: theme.border, 
          backgroundColor: theme.surface,
          borderWidth: 2,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
        }]}
        onPress={() => setShowOptions(!showOptions)}
      >
        <Text style={[styles.statValue, { color: getPerformanceColor(selectedPerformance) }]}>
          {selectedPerformance} ↓
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
            <View style={[styles.performanceOptionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.optionsHeader, { color: theme.text }]}>Select Performance</Text>
              {performanceOptions.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.performanceOptionModal, { 
                    backgroundColor: option === selectedPerformance ? theme.primary + '20' : 'transparent' 
                  }]}
                  onPress={() => {
                    onSelect(option);
                    setShowOptions(false);
                  }}
                >
                  <Text style={[styles.performanceOptionText, { color: getPerformanceColor(option) }]}>
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

// Subject Editor Component
interface SubjectEditorProps {
  subjects: string[];
  onSubjectsChange: (subjects: string[]) => void;
  theme: any;
}

function SubjectEditor({ subjects, onSubjectsChange, theme }: SubjectEditorProps) {
  const [newSubject, setNewSubject] = useState('');

  const addSubject = () => {
    if (newSubject.trim() && !subjects.includes(newSubject.trim())) {
      onSubjectsChange([...subjects, newSubject.trim()]);
      setNewSubject('');
    }
  };

  const removeSubject = (index: number) => {
    onSubjectsChange(subjects.filter((_, i) => i !== index));
  };

  return (
    <View style={styles.subjectEditorContainer}>
      <View style={styles.subjectsContainer}>
        {subjects.map((subject, index) => (
          <View key={index} style={[styles.editableSubjectTag, { backgroundColor: theme.background }]}>
            <Text style={[styles.subjectText, { color: theme.textSecondary }]}>{subject}</Text>
            <TouchableOpacity
              style={styles.removeSubjectButton}
              onPress={() => removeSubject(index)}
            >
              <X size={14} color={theme.error} />
            </TouchableOpacity>
          </View>
        ))}
      </View>
      
      <View style={styles.addSubjectContainer}>
        <TextInput
          style={[styles.subjectInput, { color: theme.text, borderColor: theme.border }]}
          value={newSubject}
          onChangeText={setNewSubject}
          placeholder="Add subject..."
          placeholderTextColor={theme.textSecondary}
          onSubmitEditing={addSubject}
        />
        <TouchableOpacity
          style={[styles.addSubjectButton, { backgroundColor: theme.primary }]}
          onPress={addSubject}
        >
          <Text style={styles.addSubjectButtonText}>Add</Text>
        </TouchableOpacity>
      </View>
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
    <View>
      <TouchableOpacity
        style={[styles.statusSelector, { 
          borderColor: theme.border, 
          backgroundColor: theme.surface,
          borderWidth: 2,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
        }]}
        onPress={() => setShowOptions(!showOptions)}
      >
        <Text style={[styles.statusText, { color: getStatusColor(selectedStatus) }]}>
          {selectedStatus.toUpperCase()} ↓
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
            <View style={[styles.statusOptionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.optionsHeader, { color: theme.text }]}>Select Status</Text>
              {statusOptions.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.statusOptionModal, { 
                    backgroundColor: option === selectedStatus ? theme.primary + '20' : 'transparent' 
                  }]}
                  onPress={() => {
                    onSelect(option);
                    setShowOptions(false);
                  }}
                >
                  <Text style={[styles.statusOptionText, { color: getStatusColor(option) }]}>
                    {option.toUpperCase()}
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
            onPress={() => {
              setShowOptions(false);
              setShowMonthPicker(false);
              setShowYearPicker(false);
            }}
          >
            <View 
              style={[styles.datePickerModal, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onTouchStart={(e) => e.stopPropagation()}
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
                    style={[styles.monthYearButton, { borderColor: theme.border, backgroundColor: theme.background }]}
                    onPress={() => {
                      setShowMonthPicker(!showMonthPicker);
                      setShowYearPicker(false);
                    }}
                  >
                    <Text style={[styles.monthYearButtonText, { color: theme.text }]}>
                      {months[currentMonth.getMonth()]}
                    </Text>
                    <Text style={[styles.dropdownArrow, { color: theme.textSecondary }]}>▼</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity 
                    style={[styles.monthYearButton, { borderColor: theme.border, backgroundColor: theme.background }]}
                    onPress={() => {
                      setShowYearPicker(!showYearPicker);
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
                      style={[styles.pickerCloseButton, { backgroundColor: theme.error }]}
                      onPress={() => setShowMonthPicker(false)}
                    >
                      <Text style={[styles.pickerCloseText, { color: '#ffffff' }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={months}
                    keyExtractor={(item, index) => index.toString()}
                    style={[styles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={styles.pickerScrollContent}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={true}
                    keyboardShouldPersistTaps="handled"
                    bounces={true}
                    renderItem={({ item: month, index }) => (
                      <TouchableOpacity
                        style={[
                          styles.pickerItem,
                          { 
                            backgroundColor: index === currentMonth.getMonth() ? theme.primary + '20' : theme.surface,
                            borderBottomColor: theme.border 
                          }
                        ]}
                        onPress={() => handleMonthSelect(index)}
                        activeOpacity={0.7}
                      >
                        <Text style={[
                          styles.pickerItemText, 
                          { 
                            color: index === currentMonth.getMonth() ? theme.primary : theme.text,
                            fontWeight: index === currentMonth.getMonth() ? '600' : '400'
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
                      style={[styles.pickerCloseButton, { backgroundColor: theme.error }]}
                      onPress={() => setShowYearPicker(false)}
                    >
                      <Text style={[styles.pickerCloseText, { color: '#ffffff' }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={generateYearRange()}
                    keyExtractor={(item) => item.toString()}
                    style={[styles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={styles.pickerScrollContent}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={true}
                    keyboardShouldPersistTaps="handled"
                    bounces={true}
                    renderItem={({ item: year }) => (
                      <TouchableOpacity
                        style={[
                          styles.pickerItem,
                          { 
                            backgroundColor: year === currentMonth.getFullYear() ? theme.primary + '20' : theme.surface,
                            borderBottomColor: theme.border 
                          }
                        ]}
                        onPress={() => handleYearSelect(year)}
                        activeOpacity={0.7}
                      >
                        <Text style={[
                          styles.pickerItemText, 
                          { 
                            color: year === currentMonth.getFullYear() ? theme.primary : theme.text,
                            fontWeight: year === currentMonth.getFullYear() ? '600' : '400'
                          }
                        ]}>
                          {year}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {/* Days of week - only show when no picker is open */}
              {!showMonthPicker && !showYearPicker && (
                <View>
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
    <View>
      <TouchableOpacity
        style={[styles.relationshipSelector, { 
          borderColor: theme.border, 
          backgroundColor: theme.surface,
          borderWidth: 1,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
        }]}
        onPress={() => setShowOptions(!showOptions)}
      >
        <Text style={[styles.infoValue, { color: theme.text }]}>
          {selectedRelation} ↓
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
            <View style={[styles.relationshipOptionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.optionsHeader, { color: theme.text }]}>Select Relationship</Text>
              {relationshipOptions.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.relationshipOptionModal, { 
                    backgroundColor: option === selectedRelation ? theme.primary + '20' : 'transparent' 
                  }]}
                  onPress={() => {
                    onSelect(option);
                    setShowOptions(false);
                  }}
                >
                  <Text style={[styles.relationshipOptionText, { color: theme.text }]}>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingTop: 60,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  headerButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  profileSection: {
    padding: 20,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  profileImageContainer: {
    position: 'relative',
    marginBottom: 16,
  },
  profileImage: {
    width: 120,
    height: 120,
    borderRadius: 60,
  },
  profileImagePlaceholder: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  editImageButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileInfo: {
    alignItems: 'center',
  },
  profileName: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  editableTitle: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
    borderBottomWidth: 1,
    paddingBottom: 4,
    minWidth: 200,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statsSection: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 20,
    marginHorizontal: 20,
    marginTop: 20,
    borderRadius: 12,
  },
  statItem: {
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 12,
    marginTop: 4,
    marginBottom: 2,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '600',
  },
  section: {
    margin: 20,
    marginBottom: 0,
    padding: 20,
    borderRadius: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  infoIcon: {
    marginRight: 12,
    marginTop: 2,
  },
  infoContent: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 14,
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 16,
    fontWeight: '500',
  },
  editableInput: {
    fontSize: 16,
    fontWeight: '500',
    borderBottomWidth: 1,
    paddingBottom: 4,
    paddingTop: 4,
  },
  fieldErrorText: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '500',
  },
  subjectsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  subjectTag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  subjectText: {
    fontSize: 12,
    fontWeight: '500',
  },
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  feeLabel: {
    fontSize: 14,
  },
  feeValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  editActionsWrapper: {
    padding: 20,
    gap: 12,
  },
  editActions: {
    flexDirection: 'row',
    gap: 12,
  },
  inlineErrorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  inlineErrorText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  cancelButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  saveButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    gap: 8,
  },
  saveButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  backButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  backButtonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  editableStatValue: {
    fontSize: 16,
    fontWeight: '600',
    borderBottomWidth: 1,
    paddingBottom: 4,
    paddingTop: 4,
    textAlign: 'center',
    minWidth: 60,
  },
  performanceSelectorContainer: {
    position: 'relative',
    alignItems: 'center',
  },
  performanceSelector: {
    borderBottomWidth: 1,
    paddingVertical: 4,
    paddingHorizontal: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  performanceOptions: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: 8,
    zIndex: 1000,
    marginTop: 4,
  },
  performanceOption: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  performanceOptionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  editableFeeValue: {
    fontSize: 16,
    fontWeight: '600',
    borderBottomWidth: 1,
    paddingBottom: 4,
    paddingTop: 4,
    textAlign: 'right',
    minWidth: 80,
  },
  subjectEditorContainer: {
    gap: 12,
  },
  editableSubjectTag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 8,
  },
  removeSubjectButton: {
    padding: 2,
  },
  addSubjectContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  subjectInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  addSubjectButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addSubjectButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  statusSelectorContainer: {
    position: 'relative',
    alignItems: 'center',
  },
  statusSelector: {
    borderBottomWidth: 1,
    paddingVertical: 4,
    paddingHorizontal: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  statusOptions: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: 8,
    zIndex: 1000,
    marginTop: 4,
  },
  statusOption: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  statusOptionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  performanceOptionsModal: {
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
  statusOptionsModal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    minWidth: 180,
    maxWidth: 220,
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
  optionsHeader: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 16,
  },
  performanceOptionModal: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
    alignItems: 'center',
  },
  statusOptionModal: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
    alignItems: 'center',
  },
  relationshipSelector: {
    borderBottomWidth: 1,
    paddingVertical: 4,
    paddingHorizontal: 8,
    minWidth: 120,
    alignItems: 'flex-start',
  },
  relationshipOptionsModal: {
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
  relationshipOptionModal: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
    alignItems: 'center',
  },
  relationshipOptionText: {
    fontSize: 14,
    fontWeight: '500',
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
  editableFeeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  feeHelperText: {
    fontSize: 11,
    fontStyle: 'italic',
  },
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
});
