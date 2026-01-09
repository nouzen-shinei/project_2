import fetch from 'node-fetch';
import crypto from 'crypto';

// Lightweight Twilio helpers moved server-side to keep credentials private.
// Environment variables (server only):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER

interface SMSPayload { to: string; message: string }
interface VoiceCallPayload {
  to: string;
  message: string;
  language?: 'english' | 'hindi' | 'both';
  voice?: string;
  hindiVoice?: string;
  englishVoice?: string;
  pauseSeconds?: number;
}

// Allow test override of fetch implementation
let _fetch: any = fetch as any;
export function setFetchForTests(fn: any){ _fetch = fn; }

function twilioCreds() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const fromNumber = process.env.TWILIO_PHONE_NUMBER || '';
  return { accountSid, authToken, fromNumber };
}

function authHeader(a: string, b: string) {
  const raw = `${a}:${b}`;
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

// Shared phone normalization logic (mirrors app/services/phoneUtil.ts)
function normalizePhoneNumber(phone: string): string {
  if (!phone) return '';
  const digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.startsWith('91') && digitsOnly.length === 12) return `+${digitsOnly}`;
  if (digitsOnly.length === 10) return `+91${digitsOnly}`;
  if (phone.startsWith('+')) return phone;
  return `+${digitsOnly}`;
}

export async function sendSMS(payload: SMSPayload) {
  try {
    const { accountSid, authToken, fromNumber } = twilioCreds();
    if (!accountSid || !authToken || !fromNumber) {
      return { success: false, error: 'twilio_not_configured' };
    }
    const to = normalizePhoneNumber(payload.to);
  const res = await _fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(accountSid, authToken),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ From: fromNumber, To: to, Body: payload.message }).toString()
    });
    if (!res.ok) {
      const txt = await safeText(res);
      return { success: false, error: txt.slice(0, 500) };
    }
    const data: any = await res.json();
    return { success: true, sid: data.sid };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

function escapeXml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mapVoiceId(id: string | undefined, fallback: { voice: string; language: string }): { voice: string; language: string } {
  if (!id) return fallback;
  const norm = id.toLowerCase();
  switch (norm) {
    // English (India) – Google
    case 'google-en-in-standard-a': return { voice: 'Google.en-IN-Standard-A', language: 'en-IN' };
    case 'google-en-in-standard-b': return { voice: 'Google.en-IN-Standard-B', language: 'en-IN' };
    case 'google-en-in-standard-c': return { voice: 'Google.en-IN-Standard-C', language: 'en-IN' };
    case 'google-en-in-standard-d': return { voice: 'Google.en-IN-Standard-D', language: 'en-IN' };
    case 'google-en-in-standard-e': return { voice: 'Google.en-IN-Standard-E', language: 'en-IN' };
    case 'google-en-in-standard-f': return { voice: 'Google.en-IN-Standard-F', language: 'en-IN' };
    // English (India) – Polly
    case 'polly-raveena': return { voice: 'Polly.Raveena', language: 'en-IN' };
    case 'polly-aditi': return { voice: 'Polly.Aditi', language: 'en-IN' }; // bilingual (English variant)
    // Hindi (India) – Google
    case 'google-hi-in-standard-a': return { voice: 'Google.hi-IN-Standard-A', language: 'hi-IN' };
    case 'google-hi-in-standard-b': return { voice: 'Google.hi-IN-Standard-B', language: 'hi-IN' };
    case 'google-hi-in-standard-c': return { voice: 'Google.hi-IN-Standard-C', language: 'hi-IN' };
    case 'google-hi-in-standard-d': return { voice: 'Google.hi-IN-Standard-D', language: 'hi-IN' };
    case 'google-hi-in-standard-e': return { voice: 'Google.hi-IN-Standard-E', language: 'hi-IN' };
    case 'google-hi-in-standard-f': return { voice: 'Google.hi-IN-Standard-F', language: 'hi-IN' };
    // Hindi (India) – Polly
    case 'polly-aditi-hi': return { voice: 'Polly.Aditi', language: 'hi-IN' };
  }
  return fallback;
}

function buildTwiML(payload: VoiceCallPayload) {
  if (payload.language === 'both') {
    const parts = payload.message.split('\n\n');
    const first = parts[0] || payload.message;
    const second = parts[1] || payload.message;
    const isFirstHindi = /[\u0900-\u097F]/.test(first);
    const mappedHi = mapVoiceId(payload.hindiVoice, { voice: 'Polly.Aditi', language: 'hi-IN' });
    const mappedEn = mapVoiceId(payload.englishVoice, { voice: 'Polly.Raveena', language: 'en-IN' });
    const hindiMessage = isFirstHindi ? first : second;
    const englishMessage = isFirstHindi ? second : first;
    const pauseTag = (Number.isFinite(payload.pauseSeconds) && (payload.pauseSeconds || 0) >= 1)
      ? `<Pause length="${Math.min(60, Math.max(1, Math.floor(payload.pauseSeconds!)))}"/>`
      : '';
    return isFirstHindi ? `<Response><Say voice="${mappedHi.voice}" language="${mappedHi.language}">${escapeXml(hindiMessage)}</Say>${pauseTag}<Say voice="${mappedEn.voice}" language="${mappedEn.language}">${escapeXml(englishMessage)}</Say></Response>`
      : `<Response><Say voice="${mappedEn.voice}" language="${mappedEn.language}">${escapeXml(englishMessage)}</Say>${pauseTag}<Say voice="${mappedHi.voice}" language="${mappedHi.language}">${escapeXml(hindiMessage)}</Say></Response>`;
  }
  const target = payload.language === 'hindi'
    ? mapVoiceId(payload.voice || payload.hindiVoice, { voice: 'Polly.Aditi', language: 'hi-IN' })
    : mapVoiceId(payload.voice || payload.englishVoice, { voice: 'Polly.Raveena', language: 'en-IN' });
  return `<Response><Say voice="${target.voice}" language="${target.language}">${escapeXml(payload.message)}</Say></Response>`;
}

export async function sendVoiceCall(payload: VoiceCallPayload) {
  try {
    const { accountSid, authToken, fromNumber } = twilioCreds();
    if (!accountSid || !authToken || !fromNumber) {
      return { success: false, error: 'twilio_not_configured' };
    }
    const to = normalizePhoneNumber(payload.to);
    const twiml = buildTwiML(payload);
  const res = await _fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(accountSid, authToken),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ From: fromNumber, To: to, Twiml: twiml }).toString()
    });
    if (res.ok) {
      const data: any = await res.json();
      return { success: true, sid: data.sid };
    }
    // Attempt fallback simple TwiML
    const txt = await safeText(res);
    const fallback = `<Response><Say voice="alice">${escapeXml(payload.message)}</Say></Response>`;
  const res2 = await _fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(accountSid, authToken),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ From: fromNumber, To: to, Twiml: fallback }).toString()
    });
    if (res2.ok) {
      const data2: any = await res2.json();
      return { success: true, sid: data2.sid, fallback: true, previousError: txt.slice(0, 300) };
    }
    const txt2 = await safeText(res2);
    return { success: false, error: txt2.slice(0, 500), previousError: txt.slice(0, 300) };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

export function formatFeeReminderMessage(studentName: string, amount: number, dueDate: string, teacherName: string) {
  return `Dear Parent,\n\nThis is a friendly reminder that ${studentName}'s tuition fee of ₹${amount.toLocaleString()} is due on ${dueDate}.\n\nPlease make the payment at your earliest convenience to avoid any disruption in classes.\n\nFor any queries, feel free to contact me.\n\nBest regards,\n${teacherName}\n\nThank you for your cooperation! 🙏`;
}

export function formatPaymentConfirmationMessage(studentName: string, amount: number, teacherName: string) {
  return `Dear Parent,\n\nThank you for the payment! ✅\n\nWe have received ₹${amount.toLocaleString()} for ${studentName}'s tuition fee.\n\nPayment confirmed and recorded successfully.\n\nBest regards,\n${teacherName}\n\nThank you for your prompt payment! 🙏`;
}

async function safeText(res: any) { try { return await res.text(); } catch { return String(res.status || 'error'); } }

// (Optional) HMAC signing helper stub if future auditing required
export function signMessage(body: string) {
  if (!process.env.TWILIO_SIGNING_SECRET) return null;
  return crypto.createHmac('sha256', process.env.TWILIO_SIGNING_SECRET).update(body).digest('hex');
}

export type { SMSPayload, VoiceCallPayload };
