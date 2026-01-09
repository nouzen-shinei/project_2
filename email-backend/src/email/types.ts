export interface BilingualMessages {
  en?: string;
  hi?: string;
}

export type LanguageOrder = 'english-first' | 'hindi-first';

export interface RenderInput {
  kind: 'fee' | 'custom';
  studentName: string;
  amount?: string;
  dueDate?: string; // ISO
  messages: BilingualMessages;
  order: LanguageOrder;
  showLabels?: boolean;
}

export interface RenderOutput {
  subject: string;
  html: string;
  text: string;
  meta: { hasEnglish: boolean; hasHindi: boolean; englishFirst: boolean };
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string,string>;
  metadata?: Record<string, any>;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
}

export interface ProviderResult {
  success: boolean;
  id?: string;
  errorType?: string;
  errorMessage?: string;
  transient?: boolean;
}

export interface EmailProvider {
  name: string;
  send(payload: EmailPayload): Promise<ProviderResult>;
}
