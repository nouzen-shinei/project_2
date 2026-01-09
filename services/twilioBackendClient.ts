import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';
import { maybeEmitBillingPastDueFromRaw } from '@/lib/billingPastDue';
import { runtimeEndpoints } from './runtimeEndpoints';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';

interface SMSPayload {
  tenantId: string;
  to: string;
  message: string;
  quotaBatchId?: string;
  historyId?: string;
  history?: any;
}
interface VoiceCallPayload {
  tenantId: string;
  to: string;
  message: string;
  language?: 'english' | 'hindi' | 'both';
  voice?: string;
  hindiVoice?: string;
  englishVoice?: string;
  pauseSeconds?: number;
  quotaBatchId?: string;
  historyId?: string;
  history?: any;
}

class TwilioBackendClient {
  private debug = (process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true');

  private getBaseUrl(): string | undefined {
    const s = runtimeEndpoints.getSnapshot();
    const baseUrl = s.wabaApiBaseUrl || runtimeEndpoints.getPreferredBackendBaseUrl();
    if (baseUrl) {
      internalTokenManager.setBaseUrl(baseUrl);
    }
    return baseUrl;
  }

  private requireBase(): string {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      throw new Error(
        'Backend URL not configured. Set Firestore appSettings/runtimeEndpoints.apiBaseUrl (or wabaApiBaseUrl) to enable Twilio sending.',
      );
    }
    return baseUrl;
  }

  private async headers(baseUrl: string){
    const h: Record<string,string> = { 'Content-Type': 'application/json' };
    const token = await internalTokenManager.getToken(baseUrl);
    if(token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }
  async sendSMS(payload: SMSPayload): Promise<boolean> {
    try {
      const baseUrl = this.requireBase();
      let res = await fetch(`${baseUrl}/twilio/sms`, { method:'POST', headers: await this.headers(baseUrl), body: JSON.stringify(payload) });
      if(res.status===401){ await internalTokenManager.forceRefresh(baseUrl); res = await fetch(`${baseUrl}/twilio/sms`, { method:'POST', headers: await this.headers(baseUrl), body: JSON.stringify(payload) }); }
      if(!res.ok){
        const body = await res.text().catch(() => '');
        maybeShowMaintenanceAlertFromRaw(res.status, body);
        maybeEmitBillingPastDueFromRaw(res.status, body);
        if(this.debug) logger.debug('[twilio-sms-error]', body);
        return false;
      }
      const data = await res.json();
      return data.success === true;
    } catch(e){ logger.error('Twilio SMS client error', e); return false; }
  }
  async sendVoiceCall(payload: VoiceCallPayload): Promise<boolean> {
    try {
      const baseUrl = this.requireBase();
      let res = await fetch(`${baseUrl}/twilio/voice-call`, { method:'POST', headers: await this.headers(baseUrl), body: JSON.stringify(payload) });
      if(res.status===401){ await internalTokenManager.forceRefresh(baseUrl); res = await fetch(`${baseUrl}/twilio/voice-call`, { method:'POST', headers: await this.headers(baseUrl), body: JSON.stringify(payload) }); }
      if(!res.ok){
        const body = await res.text().catch(() => '');
        maybeShowMaintenanceAlertFromRaw(res.status, body);
        maybeEmitBillingPastDueFromRaw(res.status, body);
        if(this.debug) logger.debug('[twilio-voice-error]', body);
        return false;
      }
      const data = await res.json();
      return data.success === true;
    } catch(e){ logger.error('Twilio voice client error', e); return false; }
  }
  formatFeeReminderMessage(studentName: string, amount: number, dueDate: string, teacherName: string){
    return `Dear Parent,\n\nThis is a friendly reminder that ${studentName}'s tuition fee of ₹${amount.toLocaleString()} is due on ${dueDate}.\n\nPlease make the payment at your earliest convenience to avoid any disruption in classes.\n\nFor any queries, feel free to contact me.\n\nBest regards,\n${teacherName}\n\nThank you for your cooperation! 🙏`;
  }
  formatPaymentConfirmationMessage(studentName: string, amount: number, teacherName: string){
    return `Dear Parent,\n\nThank you for the payment! ✅\n\nWe have received ₹${amount.toLocaleString()} for ${studentName}'s tuition fee.\n\nPayment confirmed and recorded successfully.\n\nBest regards,\n${teacherName}\n\nThank you for your prompt payment! 🙏`;
  }
}

export const twilioBackendClient = new TwilioBackendClient();
export type { SMSPayload as SMSMessage, VoiceCallPayload as VoiceCallMessage };
