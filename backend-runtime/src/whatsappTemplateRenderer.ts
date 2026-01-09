type TemplateComponents = Array<{ type: string; parameters?: Array<{ type?: string; text?: string }> }>;

const TEMPLATE_TEXT_BY_NAME: Record<string, string> = {
  fee_due_reminder_extended: `Tuition reminder – {{1}} {{2}}, {{3}}'s tuition fee of {{4}} is due on {{5}}.
Additional note:  {{6}}.
Please make the payment at your earliest convenience. Thank you!
Regards, 
{{7}}
{{8}}
Have a nice day!`,

  fee_due_reminder_extended_bilingual_en_hi: `Tuition reminder – {{1}} {{2}}, {{3}}'s tuition fee of {{4}} is due on {{5}}.
Additional note: {{6}}.
Please make the payment at your earliest convenience. Thank you!
Regards, 
{{7}}
{{8}}
Have a nice day!

ट्यूशन अनुस्मारक – {{9}} {{10}}, {{11}} की ट्यूशन फीस {{12}} देय है जिसकी अंतिम तिथि {{13}} है।
अतिरिक्त नोट: {{14}}।
कृपया अपनी सुविधा के अनुसार भुगतान करें। धन्यवाद!
सादर,
{{15}}
{{16}}
आपका दिन शुभ हो!`,

  fee_due_reminder_extended_bilingual_hi_en: `ट्यूशन अनुस्मारक – {{1}} {{2}}, {{3}} की ट्यूशन फीस {{4}} देय है जिसकी अंतिम तिथि {{5}} है।
अतिरिक्त नोट: {{6}}।
कृपया अपनी सुविधा के अनुसार भुगतान करें। धन्यवाद!
सादर, 
{{7}}
{{8}}
आपका दिन शुभ हो!

Tuition reminder – {{9}} {{10}}, {{11}}'s tuition fee of {{12}} is due on {{13}}.
Additional note: {{14}}.
Please make the payment at your earliest convenience. Thank you!
Regards, 
{{15}}
{{16}}
Have a nice day!`,

  fee_due_reminder_extended_hi: `ट्यूशन अनुस्मारक – {{1}} {{2}}, {{3}} की ट्यूशन फीस {{4}} देय है जिसकी अंतिम तिथि {{5}} है।
अतिरिक्त नोट: {{6}}।
कृपया अपनी सुविधा के अनुसार भुगतान करें। धन्यवाद!
सादर, 
{{7}}
{{8}}
आपका दिन शुभ हो!`,

  custom_message_with_signature: `Dear Parent
{{1}}
Regards, 
{{2}}
{{3}}
Have a nice day!`,

  custom_message_with_signature_bilingual_en_hi: `Dear Parent
{{1}}
Regards, 
{{2}}
{{3}}
Have a nice day!

प्रिय अभिभावक
{{4}}
सादर, 
{{5}}
{{6}}
आपका दिन शुभ हो!`,

  custom_message_with_signature_bilingual_hi_en: `प्रिय अभिभावक
{{1}}
सादर, 
{{2}}
{{3}}
आपका दिन शुभ हो!

Dear Parent
{{4}}
Regards,
{{5}}
{{6}}
Have a nice day!`,

  custom_message_with_signature_hi_new: `प्रिय अभिभावक
{{1}}
सादर,
{{2}}
{{3}}
आपका दिन शुभ हो!`,

  fee_payment_received_confirmation: `Payment received – {{1}} {{2}}, we have received payment of {{4}} for {{3}} on {{5}}.
Additional note: {{6}}.
Thank you for your payment!
Regards,
{{7}}
{{8}}
Have a nice day!`,

  fee_payment_received_confirmation_bilingual_en_hi: `Payment received – {{1}} {{2}}, we have received payment of {{4}} for {{3}} on {{5}}.
Thank you for your payment!
Regards,
{{6}}
{{7}}
Have a nice day!

Additional note/अतिरिक्त नोट: {{8}}.

भुगतान प्राप्त – {{9}} {{10}}, हमें {{11}} के लिए {{12}} का भुगतान {{13}} को प्राप्त हुआ है।
आपके भुगतान के लिए धन्यवाद!
सादर,
{{14}}
{{15}}
आपका दिन शुभ हो!`,

  fee_payment_received_confirmation_bilingual_hi_en: `भुगतान प्राप्त – {{1}} {{2}}, हमें {{3}} के लिए {{4}} का भुगतान {{5}} को प्राप्त हुआ है।
आपके भुगतान के लिए धन्यवाद!
सादर,
{{6}}
{{7}}
आपका दिन शुभ हो!

Additional note/अतिरिक्त नोट: {{8}}.

Payment received – {{9}} {{10}}, we have received payment of {{12}} for {{11}} on {{13}}.
Thank you for your payment!
Regards,
{{14}}
{{15}}
Have a nice day!`,

  fee_payment_received_confirmation_hi: `भुगतान प्राप्त – {{1}} {{2}}, हमें {{3}} के लिए {{4}} का भुगतान {{5}} को प्राप्त हुआ है।
अतिरिक्त नोट: {{6}}।
आपके भुगतान के लिए धन्यवाद!
सादर,
{{7}}
{{8}}
आपका दिन शुभ हो!`,

  birthday_greeting_bilingual_en_hi: `Happy Birthday {{1}}!
Wishing you a wonderful year ahead filled with joy and success.
Warm wishes from {{2}}.
Have an amazing day!

जन्मदिन की हार्दिक शुभकामनाएँ {{3}}!
हम आपके आने वाले वर्ष को खुशियों और सफलता से भरा हुआ होने की कामना करते हैं।
सप्रेम शुभकामनाएँ {{4}} की ओर से।
आपका दिन शानदार हो!`,
};

export function renderWhatsAppTemplateMessage(templateName: string | undefined, components: TemplateComponents | undefined): string | null {
  const name = typeof templateName === 'string' ? templateName.trim() : '';
  if (!name) return null;
  const raw = TEMPLATE_TEXT_BY_NAME[name];
  if (!raw) return null;

  const values: string[] = [];
  for (const component of components || []) {
    const parameters = Array.isArray(component?.parameters) ? component.parameters : [];
    for (const param of parameters) {
      const text = typeof (param as any)?.text === 'string' ? String((param as any).text) : '';
      values.push(text);
    }
  }

  const rendered = raw.replace(/\{\{(\d+)\}\}/g, (_match, digits) => {
    const index = Number(digits);
    if (!Number.isFinite(index) || index <= 0) return '';
    return values[index - 1] ?? '';
  });

  return rendered.trim() ? rendered : null;
}
