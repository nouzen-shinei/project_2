import { getTemplateLanguage } from './wabaTemplateConstants';

export interface FeeReminderTemplatePayload {
  tenantId?: string;
  tenantName?: string;
  to: string; parentName?: string; studentName: string; amount: number; dueDate: string;
  greeting?: string;
  // Legacy single string note (English). For backward compatibility if structured notes not provided.
  customNotes?: string;
  // New optional per-language notes; if provided these take precedence over customNotes for that language.
  customNotesEnglish?: string | null;
  customNotesHindi?: string | null;
  teacherName?: string; coachingName?: string;
  selectedLanguage?: 'english'|'hindi'|'both'; languageOrder?: 'english-first'|'hindi-first';
}
export interface CustomMessageQueuePayload {
  tenantId?: string;
  tenantName?: string;
  to: string; message: string; teacherName?: string; coachingName?: string;
  selectedLanguage?: 'english'|'hindi'|'both'; languageOrder?: 'english-first'|'hindi-first';
  englishMessage?: string; hindiMessage?: string;
}

export interface BirthdayGreetingPayload {
  tenantId?: string;
  tenantName?: string;
  to: string;
  displayName: string;
  coachingName?: string;
  language?: 'english'|'hindi'|'bilingual_en_hi';
  mediaUrl?: string | null;
}

export interface PaymentConfirmationQueuePayload {
  tenantId?: string;
  tenantName?: string;
  to: string; parentName?: string; studentName: string; amount: number; paymentDate: string;
  greeting?: string; additionalNote?: string; teacherName?: string; coachingName?: string;
  selectedLanguage?: 'english'|'hindi'|'both'; languageOrder?: 'english-first'|'hindi-first';
}

export function buildFeeReminderTemplate(p: FeeReminderTemplatePayload) {
  const bilingual = p.selectedLanguage === 'both';
  const order = p.languageOrder || 'english-first';
  const templateName = bilingual
    ? (order === 'english-first' ? 'fee_due_reminder_extended_bilingual_en_hi' : 'fee_due_reminder_extended_bilingual_hi_en')
    : (p.selectedLanguage === 'hindi' ? 'fee_due_reminder_extended_hi' : 'fee_due_reminder_extended');
  const language = getTemplateLanguage(templateName);
  const dueDateFmt = formatDueDate(p.dueDate);

  const parentNameEn = p.parentName || 'Parent';
  const parentNameHi = p.parentName || 'अभिभावक';
  const studentName = p.studentName || 'Student';
  const amountTxt = formatAmount(p.amount);
  const rawEn = (p.customNotesEnglish ?? p.customNotes) || '';
  const rawHi = (p.customNotesHindi ?? p.customNotes) || '';
  const noteEn = rawEn.trim() ? rawEn.replace(/\n/g, ', ').trim() : 'No additional note';
  const noteHi = rawHi.trim() ? rawHi.replace(/\n/g, ', ').trim() : 'कोई अतिरिक्त नोट नहीं';
  // Honor a caller-provided greeting for the English block (fallback "Dear");
  // Hindi always uses "प्रिय". Matches buildPaymentConfirmationTemplate.
  const greetEn = (p.greeting || 'Dear').trim() || 'Dear';
  // Use '-' when a specific signature line is disabled / not provided
  const teacher = p.teacherName ? p.teacherName : '-';
  const teacherHi = p.teacherName ? p.teacherName : '-';
  const coaching = resolveCoachingName(p);
  const coachingHi = coaching;

  function englishBlock(): string[] {
    // fee_due_reminder_extended (English) placeholders 1..8
    return [greetEn, parentNameEn, studentName, amountTxt, dueDateFmt, noteEn, teacher, coaching];
  }
  function hindiBlock(): string[] {
    // fee_due_reminder_extended_hi (Hindi) placeholders 1..8
    return ['प्रिय', parentNameHi, studentName, amountTxt, dueDateFmt, noteHi, teacherHi, coachingHi];
  }

  if (bilingual) {
    // en_hi template expects English block first (1..8) then Hindi (9..16)
    // hi_en template expects Hindi first (1..8) then English (9..16)
    const params = order === 'english-first'
      ? [...englishBlock(), ...hindiBlock()]
      : [...hindiBlock(), ...englishBlock()];
    return { templateName, language, parameters: params };
  }
  if (p.selectedLanguage === 'hindi') {
    return { templateName, language, parameters: hindiBlock() };
  }
  return { templateName, language, parameters: englishBlock() };
}

export function buildCustomMessageTemplate(p: CustomMessageQueuePayload) {
  const bilingual = p.selectedLanguage === 'both';
  const order = p.languageOrder || 'english-first';
  const templateName = bilingual
    ? (order === 'english-first' ? 'custom_message_with_signature_bilingual_en_hi' : 'custom_message_with_signature_bilingual_hi_en')
    : (p.selectedLanguage === 'hindi' ? 'custom_message_with_signature_hi_new' : 'custom_message_with_signature');
  const language = getTemplateLanguage(templateName);

  const engMsg = (p.englishMessage || p.message || '').replace(/\n/g, ', ').trim();
  const hinMsg = (p.hindiMessage || p.message || '').replace(/\n/g, ', ').trim();
  // For custom messages treat each signature line independently; use '-' if missing
  const teacher = p.teacherName ? p.teacherName : '-';
  const coaching = resolveCoachingName(p);

  // Single language templates (English or Hindi) each have 3 placeholders: message, teacher, coaching
  if (!bilingual) {
    const msg = p.selectedLanguage === 'hindi' ? hinMsg : engMsg;
    return { templateName, language, parameters: [msg, teacher, coaching] };
  }

  // Bilingual templates have 6 placeholders: first block (1-3) second block (4-6)
  const enBlock = [engMsg, teacher, coaching];
  const hiBlock = [hinMsg, teacher, coaching];
  const params = order === 'english-first' ? [...enBlock, ...hiBlock] : [...hiBlock, ...enBlock];
  return { templateName, language, parameters: params };
}

const DEFAULT_BIRTHDAY_IMAGE_URL = process.env.BIRTHDAY_WHATSAPP_IMAGE_URL?.trim();

export function buildBirthdayGreetingTemplate(p: BirthdayGreetingPayload): {
  templateName: string;
  language: string;
  parameters: any[];
  headerParameters?: any[];
} {
  const language = p.language || 'bilingual_en_hi';
  const coaching = resolveCoachingName(p);
  const display = p.displayName || 'Friend';
  const mediaSource = (p.mediaUrl ?? DEFAULT_BIRTHDAY_IMAGE_URL)?.trim();
  const headerParameters = mediaSource
    ? [{
        type: 'image',
        image: /^https?:\/\//i.test(mediaSource) ? { link: mediaSource } : { id: mediaSource },
      }]
    : undefined;

  if (language === 'english') {
    return {
      templateName: 'birthday_greeting_en',
      language: 'en_US',
      parameters: [display, coaching],
      headerParameters,
    };
  }

  if (language === 'hindi') {
    return {
      templateName: 'birthday_greeting_hi',
      language: 'hi_IN',
      parameters: [display, coaching],
      headerParameters,
    };
  }

  return {
    templateName: 'birthday_greeting_bilingual_en_hi',
    language: 'en_US',
    parameters: [display, coaching, display, coaching],
    headerParameters,
  };
}

export function buildPaymentConfirmationTemplate(p: PaymentConfirmationQueuePayload){
  const bilingual = p.selectedLanguage === 'both';
  const order = p.languageOrder || 'english-first';
  const templateName = bilingual
    ? (order === 'english-first' ? 'fee_payment_received_confirmation_bilingual_en_hi' : 'fee_payment_received_confirmation_bilingual_hi_en')
    : (p.selectedLanguage === 'hindi' ? 'fee_payment_received_confirmation_hi' : 'fee_payment_received_confirmation');
  const language = getTemplateLanguage(templateName);

  const amountTxt = formatAmount(p.amount);
  const dateTxt = formatDueDate(p.paymentDate);
  const studentName = p.studentName || 'Student';
  const parentEn = p.parentName || 'Parent';
  const parentHi = p.parentName || 'अभिभावक';
  const greetEn = (p.greeting || 'Dear').trim();
  const greetHi = greetEn.toLowerCase().startsWith('dear') ? 'प्रिय' : 'प्रिय';
  const noteEn = (p.additionalNote || 'No additional note').replace(/\n/g, ', ').trim();
  const noteHi = (p.additionalNote || 'कोई अतिरिक्त नोट नहीं').replace(/\n/g, ', ').trim();
  const teacher = p.teacherName ? p.teacherName : '-';
  const coaching = resolveCoachingName(p);

  function englishBlock(): string[] {
    // Placeholders 1..8
    return [greetEn, parentEn, studentName, amountTxt, dateTxt, noteEn, teacher, coaching];
  }
  function hindiBlock(): string[] {
    // Placeholders 1..8
    return [greetHi, parentHi, studentName, amountTxt, dateTxt, noteHi, teacher, coaching];
  }

  if (bilingual) {
    // Place the Additional note once between the two language blocks
    const en = englishBlock();
    const hi = hindiBlock();
    // Remove note from both blocks to move it between blocks
    en.splice(5, 1); // remove EN note (index 5)
    hi.splice(5, 1); // remove HI note (index 5)
    const combinedNote = noteEn; // keep English text for the combined note as agreed
    if (order === 'english-first') {
      const params = [...en, combinedNote, ...hi];
      return { templateName, language, parameters: params };
    } else {
      const params = [...hi, combinedNote, ...en];
      return { templateName, language, parameters: params };
    }
  }
  if (p.selectedLanguage === 'hindi') return { templateName, language, parameters: hindiBlock() };
  return { templateName, language, parameters: englishBlock() };
}

function formatAmount(a: number) { return `₹${a.toLocaleString()}`; }
function formatDueDate(raw: string) { try { const d = new Date(raw); if (isNaN(d.getTime())) return raw; const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'][d.getMonth()]; return `${d.getDate()} ${m} ${d.getFullYear()}`; } catch { return raw; } }
function resolveCoachingName(payload: { coachingName?: string; tenantName?: string }): string {
  const explicit = typeof payload.coachingName === 'string' ? payload.coachingName.trim() : '';
  if (explicit) {
    return explicit;
  }
  const tenant = typeof payload.tenantName === 'string' ? payload.tenantName.trim() : '';
  return tenant || '-';
}
