// Centralized mapping of template names to language codes
// Helps avoid drift between service, queues, and documentation.
export const WABA_TEMPLATE_LANG: Record<string, string> = {
  fee_due_reminder_extended: 'en_IN',
  fee_due_reminder_extended_hi: 'hi',
  fee_due_reminder_extended_bilingual_en_hi: 'en_US',
  fee_due_reminder_extended_bilingual_hi_en: 'en_US',
  custom_message_with_signature: 'en_US',
  custom_message_with_signature_hi_new: 'hi',
  custom_message_with_signature_bilingual_en_hi: 'en_US',
  custom_message_with_signature_bilingual_hi_en: 'en_US',
  // Payment received confirmation templates
  fee_payment_received_confirmation: 'en_IN',
  fee_payment_received_confirmation_bilingual_en_hi: 'en_US',
  fee_payment_received_confirmation_bilingual_hi_en: 'en_US',
  fee_payment_received_confirmation_hi: 'hi',
};

export function getTemplateLanguage(templateName: string, fallback: string = 'en_US') {
  return WABA_TEMPLATE_LANG[templateName] || fallback;
}
