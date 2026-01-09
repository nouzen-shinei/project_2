export const WABA_TEMPLATE_LANG: Record<string,string> = {
  fee_due_reminder_extended: 'en_IN',
  fee_due_reminder_extended_hi: 'hi',
  fee_due_reminder_extended_bilingual_en_hi: 'en_US',
  fee_due_reminder_extended_bilingual_hi_en: 'en_US',
  custom_message_with_signature: 'en_US',
  custom_message_with_signature_hi_new: 'hi',
  custom_message_with_signature_bilingual_en_hi: 'en_US',
  custom_message_with_signature_bilingual_hi_en: 'en_US',
  // Payment received confirmations
  fee_payment_received_confirmation: 'en_US',
  fee_payment_received_confirmation_hi: 'hi',
  fee_payment_received_confirmation_bilingual_en_hi: 'en_US',
  fee_payment_received_confirmation_bilingual_hi_en: 'en_US'
};
export function getTemplateLanguage(name: string, fallback = 'en_US') { return WABA_TEMPLATE_LANG[name] || fallback; }
