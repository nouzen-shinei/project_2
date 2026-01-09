"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WABA_TEMPLATE_LANG = void 0;
exports.getTemplateLanguage = getTemplateLanguage;
// Centralized mapping of template names to language codes
// Helps avoid drift between service, queues, and documentation.
exports.WABA_TEMPLATE_LANG = {
    fee_due_reminder_extended: 'en_IN',
    fee_due_reminder_extended_hi: 'hi',
    fee_due_reminder_extended_bilingual_en_hi: 'en_US',
    fee_due_reminder_extended_bilingual_hi_en: 'en_US',
    custom_message_with_signature: 'en_US',
    custom_message_with_signature_hi_new: 'hi',
    custom_message_with_signature_bilingual_en_hi: 'en_US',
    custom_message_with_signature_bilingual_hi_en: 'en_US',
};
function getTemplateLanguage(templateName, fallback = 'en_US') {
    return exports.WABA_TEMPLATE_LANG[templateName] || fallback;
}
//# sourceMappingURL=wabaTemplateConstants.js.map