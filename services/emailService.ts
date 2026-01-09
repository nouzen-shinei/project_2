import { logger } from '@/lib/logger';
import { Student } from '../types';
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { runtimeEndpoints } from './runtimeEndpoints';

export interface EmailConfig {
  to_email: string;
  subject: string;
  student_name: string;
  html?: string;
}

class EmailService {
  private initialized: boolean = false;

  constructor() {
    logger.debug('EmailService initialized for backend delivery');
  }

  async initialize(): Promise<boolean> {
    try {
      // Ensure auth token manager knows where to fetch /auth/bridge from
      const base = runtimeEndpoints.getPreferredBackendBaseUrl();
      if (base) {
        internalTokenManager.setBaseUrl(base);
      }
      this.initialized = true;
      logger.debug('EmailService ready for CORS-friendly email sending');
      return true;
    } catch (error) {
      logger.error('EmailService initialization failed:', error);
      return false;
    }
  }

  private async buildAuthHeaders(baseUrl: string): Promise<Record<string,string>> {
    const headers: Record<string,string> = { 'Content-Type': 'application/json' };
    // Try to obtain a short-lived internal token; wait briefly if not yet minted
    let token = await internalTokenManager.getToken(baseUrl);
    if (!token) {
      for (let i=0;i<10;i++) { // ~2s max
        await new Promise(r=>setTimeout(r,200));
        token = await internalTokenManager.getToken(baseUrl);
        if (token) break;
      }
      // If still no token, try a forced refresh once
      if (!token) {
        token = await internalTokenManager.forceRefresh(baseUrl);
      }
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  // Removed unused HTML generator used in earlier local-sending path; backend templates handle content.

  async sendFeeReminder(
    student: Student, 
    parentEmail: string, 
    amount?: string, 
    dueDate?: string, 
    fromName?: string, 
    customNotes?: string,
    customMessage?: string,
    coachingName?: string,
    showCoachingName?: boolean,
    showTeacherName?: boolean,
  teacherName?: string,
  teacherEmail?: string,
  options?: {
    tenantId?: string;
    quotaBatchId?: string;
    historyId?: string;
    history?: any;
  }
  ): Promise<boolean> {
    try {
      const base = runtimeEndpoints.requireEmailBackendBaseUrl();
      const payload = {
        template: 'fee_reminder',
        to_email: parentEmail,
        to_name: 'Parent/Guardian',
        from_name: fromName || coachingName || 'Tuition Management',
        subject: undefined as string | undefined, // subject computed server-side
        student_name: student.name,
        amount: amount || '0',
        due_date: dueDate || new Date().toISOString().split('T')[0],
        custom_notes: customNotes || '',
        custom_message: customMessage || '',
        coaching_name: coachingName || '',
        tenant_id: options?.tenantId,
        quotaBatchId: options?.quotaBatchId,
        historyId: options?.historyId,
        history: options?.history,
        show_coaching_name: !!showCoachingName,
        show_teacher_name: !!showTeacherName,
  teacher_name: teacherName || '',
  teacher_email: teacherEmail
      } as const;

      const headers = await this.buildAuthHeaders(base);
      let resp = await fetch(`${base}/email/send-template`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      // If unauthorized, invalidate token and retry once to re-mint via bridge
      if (resp.status === 401) {
        internalTokenManager.invalidate(base);
        // Force refresh to avoid reusing a stale state
        await internalTokenManager.forceRefresh(base);
        const headers2 = await this.buildAuthHeaders(base);
        resp = await fetch(`${base}/email/send-template`, {
          method: 'POST',
          headers: headers2,
          body: JSON.stringify(payload)
        });
      }
      if (!resp.ok) {
        const text = await resp.text();
        maybeShowMaintenanceAlertFromRaw(resp.status, text);
        logger.warn('Backend fee_reminder failed', text);
        return false;
      }
      logger.debug('✅ Fee reminder sent via backend');
      return true;
    } catch (error) {
      logger.error('Fee reminder send error', error);
      return false;
    }
  }

  // Removed development-only local send stub; all sends go through backend now.

  // Legacy methods for backward compatibility
  async sendEmail(templateData: any): Promise<boolean> {
    return this.sendFeeReminder(
      { name: templateData.student_name } as Student,
      templateData.to_email,
      templateData.amount,
      templateData.due_date,
      templateData.from_name,
      templateData.custom_notes,
      templateData.custom_message,
      templateData.coaching_name,
      templateData.show_coaching_name,
      templateData.show_teacher_name,
      templateData.teacher_name
    );
  }

  async sendPaymentConfirmation(templateData: any): Promise<boolean> {
    logger.debug('Payment confirmation email not implemented yet');
    return true; // Return true to not break the flow
  }

  async sendCustomMessage(templateData: any): Promise<boolean> {
    // templateData expected fields:
    // to_email, to_name, subject, student_name (optional), coaching_name, show_coaching_name,
    // show_teacher_name, teacher_name, selectedLanguage: 'english' | 'hindi' | 'both', languageOrder: 'english-first' | 'hindi-first'
    // custom_message_english, custom_message_hindi
    try {

      const english = (templateData.custom_message_english || '').trim();
      const hindi = (templateData.custom_message_hindi || '').trim();
      const selectedLanguage = templateData.selectedLanguage || 'english';
      const order = templateData.languageOrder || 'english-first';
      const englishFirst = order === 'english-first';

      // Flags to drive mustache sections
      const showEnglishBlock = selectedLanguage === 'english' || selectedLanguage === 'both';
      const showHindiBlock = selectedLanguage === 'hindi' || selectedLanguage === 'both';

      const base = runtimeEndpoints.requireEmailBackendBaseUrl();
      const payload = {
        template: 'custom_message_bilingual',
        to_email: templateData.to_email,
        to_name: templateData.to_name || 'Parent/Guardian',
        from_name: templateData.from_name || templateData.coaching_name || 'Tuition Management',
        teacher_email: templateData.teacher_email,
        reply_to: templateData.reply_to,
        subject: templateData.subject,
        student_name: templateData.student_name || '',
        coaching_name: templateData.coaching_name || '',
        tenant_id: templateData.tenant_id || templateData.tenantId,
        quotaBatchId: templateData.quotaBatchId,
        historyId: templateData.historyId,
        history: templateData.history,
        show_coaching_name: !!templateData.show_coaching_name,
        show_teacher_name: !!templateData.show_teacher_name,
        teacher_name: templateData.teacher_name || '',
        // Bilingual
        custom_message_english: showEnglishBlock ? english : '',
        custom_message_hindi: showHindiBlock ? hindi : '',
        show_english_block: showEnglishBlock && !!english,
        show_hindi_block: showHindiBlock && !!hindi,
  english_first: selectedLanguage === 'both' ? englishFirst : (selectedLanguage === 'english'),
  selectedLanguage,
  languageOrder: order
      } as any;
      const headers = await this.buildAuthHeaders(base);
  let r = await fetch(`${base}/email/send-template`, { method:'POST', headers, body: JSON.stringify(payload) });
      if (r.status === 401) {
        internalTokenManager.invalidate(base);
        await internalTokenManager.forceRefresh(base);
        const headers2 = await this.buildAuthHeaders(base);
        r = await fetch(`${base}/email/send-template`, { method:'POST', headers: headers2, body: JSON.stringify(payload) });
      }
      if(!r.ok){ const t = await r.text(); maybeShowMaintenanceAlertFromRaw(r.status, t); logger.warn('Backend custom_message failed', t); return false; }
      logger.debug('✅ Custom message email sent via backend');
      return true;
    } catch (e) {
      logger.error('Custom message email error', e);
      return false;
    }
  }

  getTemplateConfigurationGuide(): string {
    return 'Email service configured to use backend /email/send-template';
  }
}

export const emailService = new EmailService();
