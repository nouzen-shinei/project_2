import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import crypto from 'crypto';
import { EmailPayload, EmailProvider, ProviderResult } from '../types.js';

const region = process.env.AWS_SES_REGION || process.env.SES_REGION;
const defaultSource = process.env.SES_SENDER_EMAIL;

const client = new SESv2Client({ region });

export const sesProvider: EmailProvider = {
  name: 'ses',
  async send(payload: EmailPayload): Promise<ProviderResult> {
  const baseSource = payload.fromEmail || defaultSource;
  if(!region || !baseSource) return { success:false, errorType:'config', errorMessage:'SES missing region/source' };
    const usePlus = process.env.FROM_PLUS_THREAD_SPLIT === '1';
    const fromName = payload.fromName || process.env.SES_SENDER_NAME || 'Tuition Management';
    const tagLenRaw = Number(process.env.FROM_PLUS_TAG_LEN || '6');
    const tagLen = Math.max(2, Math.min(20, isNaN(tagLenRaw)?6:tagLenRaw));
    let source = baseSource;
    if(usePlus){
      const at = baseSource.indexOf('@');
      if(at>0){
        const local = baseSource.slice(0, at).replace(/\+.*/, '');
        const domain = baseSource.slice(at+1);
        const token = (payload.metadata?.entityId ? String(payload.metadata.entityId) : crypto.randomBytes(4).toString('hex')).replace(/[^A-Za-z0-9]/g,'').slice(0, tagLen) || 'x';
        source = `${local}+${token}@${domain}`;
      }
    }
    try {
      const cmd = new SendEmailCommand({
        // Include display name for better UX in clients
        FromEmailAddress: fromName ? `${fromName} <${source}>` : source,
  ReplyToAddresses: payload.replyTo ? [payload.replyTo] : undefined,
        EmailTags: payload.metadata?.entityId ? [{ Name: 'entityId', Value: String(payload.metadata.entityId) }] : undefined,
        // Custom headers are supported via the Simple headers? SESv2 Simple doesn’t allow arbitrary headers directly.
        // We can embed X- headers at the top of HTML/text if crucial, but here we rely on Message-Id from provider.
        Destination: { ToAddresses: [payload.to] },
        Content: {
          Simple: {
            Subject: { Data: payload.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: payload.html, Charset: 'UTF-8' },
              Text: { Data: payload.text, Charset: 'UTF-8' }
            }
          }
        }
      });
      const r = await client.send(cmd);
      return { success: true, id: r.MessageId };
    } catch(e:any){
      const msg = e?.name || e?.message || 'error';
      const transient = /Throttling|Timeout|ServiceUnavailable|InternalFailure/.test(msg);
      return { success:false, errorType: transient?'transient':'permanent', errorMessage: msg, transient };
    }
  }
};
