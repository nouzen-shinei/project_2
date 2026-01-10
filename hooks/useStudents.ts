import { logger } from '@/lib/logger';
import { useState, useEffect } from 'react';
import { studentService, Student, CreateStudentData, UpdateStudentData } from '../services/studentService';
import { useAuth } from './useAuthUnified';
import { useTenant } from './useTenantContext';

const DEFAULT_MAX_STUDENTS = 200;

function useStudents() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Get current user for attribution
  const { user } = useAuth();
  const { activeTenant, loading: tenantLoading } = useTenant();

  useEffect(() => {
    if (tenantLoading) {
      setLoading(true);
      setError(null);
      return () => undefined;
    }

    if (!activeTenant?.id) {
      setStudents([]);
      setLoading(false);
      setError('No coaching center selected');
      return () => undefined;
    }

    setLoading(true);
    setError(null);
    const unsubscribe = studentService.subscribeToStudents(
      activeTenant.id,
      (studentsData) => {
        setStudents(studentsData);
        setLoading(false);
        setError(null);
      },
      (err) => {
        logger.error('📚 useStudents: Error:', err);
        setError(err.message);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [activeTenant?.id, tenantLoading]);

  const addStudent = async (studentData: CreateStudentData): Promise<string> => {
    try {
      if (!activeTenant?.id) {
        throw new Error('Select a coaching center before adding students');
      }
      const studentLimit = activeTenant.quotas?.maxStudents ?? DEFAULT_MAX_STUDENTS;
      if (students.length >= studentLimit) {
        throw new Error(
          `Student limit reached for this plan (${studentLimit}). Remove inactive records or upgrade to add more students.`,
        );
      }
      // Pass current user info for attribution
      const createdBy = user?.displayName || user?.email?.split('@')[0] || 'Unknown User';
      return await studentService.addStudent(activeTenant.id, studentData, createdBy);
    } catch (err) {
      logger.error('Failed to add student:', err);
      throw err;
    }
  };

  const updateStudent = async (id: string, updates: UpdateStudentData) => {
    try {
      if (!activeTenant?.id) {
        throw new Error('Select a coaching center before updating students');
      }
      await studentService.updateStudent(activeTenant.id, id, updates);
    } catch (err) {
      logger.error('Failed to update student:', err);
      throw err;
    }
  };

  const deleteStudent = async (id: string) => {
    try {
      if (!activeTenant?.id) {
        throw new Error('Select a coaching center before deleting students');
      }
      await studentService.deleteStudent(activeTenant.id, id);
    } catch (err) {
      logger.error('Failed to delete student:', err);
      throw err;
    }
  };

  const moveStudentUp = async (id: string) => {
    try {
      if (!activeTenant?.id) {
        throw new Error('Select a coaching center before reordering students');
      }
      await studentService.moveStudentUp(activeTenant.id, id);
    } catch (err) {
      logger.error('Failed to move student up:', err);
      throw err;
    }
  };

  const moveStudentDown = async (id: string) => {
    try {
      if (!activeTenant?.id) {
        throw new Error('Select a coaching center before reordering students');
      }
      await studentService.moveStudentDown(activeTenant.id, id);
    } catch (err) {
      logger.error('Failed to move student down:', err);
      throw err;
    }
  };

  return {
    students,
    loading,
    error,
    addStudent,
    updateStudent,
    deleteStudent,
    moveStudentUp,
    moveStudentDown,
  };
}

export default useStudents;
export { useStudents };
export type { Student, CreateStudentData, UpdateStudentData };
