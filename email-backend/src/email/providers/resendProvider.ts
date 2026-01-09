import { EmailPayload, EmailProvider, ProviderResult } from '../types.js';

const apiKey = process.env.RESEND_API_KEY;
const domain = process.env.RESEND_DOMAIN;

export const resendProvider: EmailProvider = {
  name: 'resend',
  async send(payload: EmailPayload): Promise<ProviderResult> {
    if(!apiKey || !domain) return { success:false, errorType:'config', errorMessage:'RESEND config missing' };
    try {
    // Ensure From domain is verified with Resend; if payload.fromEmail domain differs, use noreply@RESEND_DOMAIN
  const fromName = payload.fromName || 'Tuition Management';
    const fromDomain = (payload.fromEmail||'').split('@')[1];
    const usePayloadFrom = fromDomain && fromDomain.toLowerCase() === String(domain).toLowerCase();
    const usePlus = process.env.FROM_PLUS_THREAD_SPLIT === '1';
  const tagLenRaw = Number(process.env.FROM_PLUS_TAG_LEN || '6');
  const tagLen = Math.max(2, Math.min(20, isNaN(tagLenRaw)?6:tagLenRaw));
    let baseFrom = usePayloadFrom && payload.fromEmail ? payload.fromEmail : `noreply@${domain}`;
    if(usePlus){
      const at = baseFrom.indexOf('@');
      if(at>0){
        const local = baseFrom.slice(0, at).replace(/\+.*/, '');
    const token = (payload.metadata?.entityId ? String(payload.metadata.entityId) : Math.random().toString(36).slice(2,10)).replace(/[^A-Za-z0-9]/g,'').slice(0, tagLen) || 'x';
        const dom = baseFrom.slice(at+1);
        baseFrom = `${local}+${token}@${dom}`;
      }
    }
    const fromAddress = `${fromName} <${baseFrom}>`;
    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
      from: fromAddress,
          to: [payload.to],
          reply_to: payload.replyTo,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
      headers: { ...(payload.headers||{}), 'X-Template-Version': payload.metadata?.templateVersion, 'X-Template-Kind': payload.metadata?.kind, ...(payload.replyTo? { 'Reply-To': payload.replyTo }: {}) }
        })
      });
      if(!resp.ok){
        const t = await resp.text();
        const transient = /timeout|temporarily|rate/i.test(t);
        return { success:false, errorType: transient?'transient':'permanent', errorMessage: t, transient };
      }
      const json = await resp.json();
      return { success:true, id: json.id };
    } catch(e:any){
      const msg = e?.message || 'resend_error';
      const transient = true; // network errors -> retry
      return { success:false, errorType:'transient', errorMessage: msg, transient };
    }
  }
};
