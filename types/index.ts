// Shared type definitions for the application

// Re-export notice types
export * from './notice';
export * from './tenant';

export interface Student {
  id: string;
  tenantId: string;
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
  parentRelation?: string;
  address?: string;
  dateOfBirth?: string;
  emergencyContact?: string;
  profileImageUrl?: string;
  enrollmentDate: string;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  updatedAt: string;
  createdBy?: string; // User who created this student
  subjects?: string[];
  attendance?: number;
  performance?: string;
  monthlyFee?: number;
  feeDueDate?: number; // Day of the month (1-31) when fee is due
  joinDate?: string;
  order?: number;
  feeHistory?: FeeHistoryEntry[]; // Track fee deletions and modifications
}

export interface FeeHistoryEntry {
  id: string;
  action: 'created' | 'deleted' | 'modified';
  feeId: string;
  amount: number;
  dueDate: string;
  description?: string;
  performedBy: string; // User who performed the action
  performedAt: string;
  reason?: string; // Reason for deletion/modification
}

export interface FeeRecord {
  id: string;
  tenantId: string;
  studentId: string;
  studentName: string;
  amount: number;
  paidAmount?: number; // Amount already paid (for partial payments)
  dueDate: string;
  paidDate?: string;
  status: 'pending' | 'paid' | 'overdue' | 'partial';
  type: 'tuition' | 'registration' | 'materials' | 'other';
  description?: string;
  paymentMethod?: string;
  method?: string;
  lastReminder?: string;
  monthsCovered?: string[]; // Array of months covered by this fee (for consolidated fees)
  monthlyFeeAmount?: number; // Individual monthly fee amount for consolidated fees (deprecated - use monthFeeAmounts)
  monthFeeAmounts?: { [month: string]: number }; // Individual fee amounts for each month (e.g., {"2025-01": 1000, "2025-02": 1200})
  paidMonths?: string[]; // Array of months that have been paid (for individual month payments)
  paymentDetails?: {
    paidBy?: string;
    accountDetails?: string;
    transactionId?: string;
    notes?: string;
    paymentDate?: string;
    [key: string]: any; // Allow dynamic payment history entries
  };
  createdAt: string;
  updatedAt: string;
  createdBy?: string; // User who created this fee (or "automatic" for system-generated fees)
  approvedBy?: string; // User who approved automatic fee creation (for auto-generated fees)
}

export interface AttendanceRecord {
  id: string;
  tenantId: string;
  studentId: string;
  date: string; // YYYY-MM-DD format
  status: 'present' | 'absent' | 'late' | 'excused';
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
