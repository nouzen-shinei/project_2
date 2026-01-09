import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { SectionCard } from '../../components/SectionCard';
import { sendSms, sendVoiceCall } from '../../lib/apiClient';

const smsSchema = z.object({
  to: z.string().min(5),
  message: z.string().min(1),
});

type SmsForm = z.infer<typeof smsSchema>;

const voiceSchema = z.object({
  to: z.string().min(5),
  message: z.string().min(1),
  language: z.enum(['english', 'hindi', 'both']).optional(),
  voice: z.string().optional(),
  hindiVoice: z.string().optional(),
  englishVoice: z.string().optional(),
  pauseSeconds: z.coerce.number().int().min(1).max(60).optional(),
});

type VoiceForm = z.infer<typeof voiceSchema>;

export function TwilioPanel() {
  const smsForm = useForm<SmsForm>({ resolver: zodResolver(smsSchema) });
  const voiceForm = useForm<VoiceForm>({ resolver: zodResolver(voiceSchema) });

  return (
    <SectionCard title="Twilio Bridge" description="Send SMS or launch a voice call using stored server credentials.">
      <div className="form-grid">
        <form
          onSubmit={smsForm.handleSubmit(async (payload: SmsForm) => {
            try {
              await sendSms(payload);
              smsForm.reset();
            } catch (err: any) {
              alert(err?.message || 'SMS failed');
            }
          })}
        >
          <h3>SMS</h3>
          <label>
            To
            <input {...smsForm.register('to')} />
          </label>
          <label>
            Message
            <textarea className="textarea" {...smsForm.register('message')} />
          </label>
          <button className="primary-button" type="submit">Send SMS</button>
        </form>

        <form
          onSubmit={voiceForm.handleSubmit(async (payload: VoiceForm) => {
            try {
              await sendVoiceCall(payload);
            } catch (err: any) {
              alert(err?.message || 'Voice call failed');
            }
          })}
        >
          <h3>Voice Call</h3>
          <label>
            To
            <input {...voiceForm.register('to')} />
          </label>
          <label>
            Script / message
            <textarea className="textarea" {...voiceForm.register('message')} />
          </label>
          <label>
            Language
            <select {...voiceForm.register('language')}>
              <option value="">auto</option>
              <option value="english">english</option>
              <option value="hindi">hindi</option>
              <option value="both">both</option>
            </select>
          </label>
          <label>
            Voice preset
            <input {...voiceForm.register('voice')} placeholder="Polly.Aditi" />
          </label>
          <label>
            Hindi voice override
            <input {...voiceForm.register('hindiVoice')} />
          </label>
          <label>
            English voice override
            <input {...voiceForm.register('englishVoice')} />
          </label>
          <label>
            Pause seconds
            <input type="number" {...voiceForm.register('pauseSeconds', { valueAsNumber: true })} />
          </label>
          <button className="primary-button" type="submit">Start call</button>
        </form>
      </div>
    </SectionCard>
  );
}
