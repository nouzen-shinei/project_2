import { RenderInput, RenderOutput } from './types.js';

function formatAmount(amount?: string){
  if(!amount || amount === '0') return 'Amount pending';
  const num = parseFloat(amount);
  if(Number.isNaN(num)) return amount;
  return `₹${num.toLocaleString('en-IN')}`;
}

function formatDate(d?: string){
  if(!d) return 'as soon as possible';
  try { return new Date(d).toLocaleDateString('en-IN', { year:'numeric', month:'long', day:'numeric' }); } catch { return 'as soon as possible'; }
}

export function renderEmail(input: RenderInput): RenderOutput {
  const hasEnglish = !!(input.messages.en && input.messages.en.trim());
  const hasHindi = !!(input.messages.hi && input.messages.hi.trim());
  const englishFirst = input.order === 'english-first';
  const both = hasEnglish && hasHindi;
  const showLabels = both && input.showLabels !== false;

  const sections: string[] = [];
  function block(label: string, body: string){
    return `<div style=\"margin:12px 0;\">${showLabels ? `<div style=\"font-weight:600; margin-bottom:4px; font-size:14px;\">${label}</div>`:''}<div style=\"white-space:pre-wrap; line-height:1.5; font-size:15px; color:#374151;\">${body}</div></div>`;
  }

  const pushEnglish = ()=> sections.push(block('Message (English)', escapeHtml(input.messages.en!.trim())));
  const pushHindi = ()=> sections.push(block('संदेश (हिंदी)', escapeHtml(input.messages.hi!.trim())));

  if(hasEnglish && hasHindi){
    if(englishFirst){ pushEnglish(); pushHindi(); } else { pushHindi(); pushEnglish(); }
  } else if(hasEnglish){ pushEnglish(); } else if(hasHindi){ pushHindi(); }

  let intro = '';
  if(input.kind === 'fee') {
    intro = `<p style=\"margin:0 0 16px; font-size:15px; color:#374151;\">This is a friendly reminder that the tuition fee for <strong>${escapeHtml(input.studentName)}</strong> is due.</p>`;
  } else {
    intro = `<p style=\"margin:0 0 12px; font-size:15px; color:#374151;\">This message concerns <strong>${escapeHtml(input.studentName)}</strong>.</p>`;
  }

  const paymentBox = input.kind === 'fee' ? `
    <div style=\"background:#f3f4f6; border-left:4px solid #2563eb; padding:16px; border-radius:6px; margin:16px 0; font-size:14px; color:#374151;\">
      <div><strong>Student:</strong> ${escapeHtml(input.studentName)}</div>
      <div><strong>Amount Due:</strong> <span style=\"color:#dc2626; font-weight:600;\">${formatAmount(input.amount)}</span></div>
      <div><strong>Due Date:</strong> ${formatDate(input.dueDate)}</div>
    </div>` : '';

  const html = `<!DOCTYPE html><html><body style=\"font-family:Arial,Helvetica,sans-serif; background:#f9fafb; padding:0; margin:0;\">
    <div style=\"max-width:640px; margin:0 auto; padding:24px;\">
      <div style=\"background:#ffffff; padding:32px; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.04);\">
        <h2 style=\"text-align:center; color:#2563eb; margin:0 0 24px; font-size:22px;\">${input.kind === 'fee' ? 'Fee Reminder' : 'Message'}</h2>
        ${intro}
        ${paymentBox}
        ${sections.join('\n') || '<p style=\"font-size:14px; color:#6b7280;\">(No message content provided)</p>'}
        <div style=\"margin-top:32px; border-top:1px solid #e5e7eb; padding-top:16px; font-size:12px; color:#6b7280;\">Tuition Management Team</div>
      </div>
    </div>
  </body></html>`;

  const textParts: string[] = [];
  if(input.kind === 'fee') textParts.push(`Fee Reminder for ${input.studentName}`);
  else textParts.push(`Message about ${input.studentName}`);
  if(hasEnglish) textParts.push(`EN:\n${input.messages.en!.trim()}`);
  if(hasHindi) textParts.push(`HI:\n${input.messages.hi!.trim()}`);
  const text = textParts.join('\n\n');

  const subject = input.kind === 'fee' ? `Fee Reminder - ${input.studentName}` : `Message - ${input.studentName}`;

  return { subject, html, text, meta: { hasEnglish, hasHindi, englishFirst } };
}

function escapeHtml(s: string){
  return s.replace(/[&<>"]/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c] as string));
}
