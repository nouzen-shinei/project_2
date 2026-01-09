import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { SectionCard } from '../../components/SectionCard';
import {
  enqueueCustomMessage,
  enqueueFeeReminder,
  enqueuePaymentConfirmation,
  fetchJobStatus,
  JobStatusEntry,
} from '../../lib/apiClient';

const reminderSchema = z.object({
  tenantId: z.string().min(2).optional(),
  to: z.string().min(5),
  studentName: z.string().min(2),
  amount: z.number().positive(),
  dueDate: z.string().min(3),
  language: z.string().optional(),
  bilingual: z.boolean().optional(),
});

type ReminderForm = z.infer<typeof reminderSchema>;

const customSchema = z.object({
  tenantId: z.string().min(2).optional(),
  to: z.string().min(5),
  message: z.string().min(1),
  language: z.string().optional(),
});

type CustomForm = z.infer<typeof customSchema>;

const paymentSchema = z.object({
  tenantId: z.string().min(2).optional(),
  to: z.string().min(5),
  studentName: z.string().min(2),
  amount: z.number().positive(),
  paymentDate: z.string().min(3),
});

type PaymentForm = z.infer<typeof paymentSchema>;

const statusSchema = z.object({
  jobId: z.string().optional(),
  jobIds: z.string().optional(),
  messageId: z.string().optional(),
  tenantId: z.string().optional(),
});

type StatusForm = z.infer<typeof statusSchema>;

export function WhatsAppPanel() {
  const reminderForm = useForm<ReminderForm>({
    resolver: zodResolver(reminderSchema),
    defaultValues: { bilingual: false },
  });
  const customForm = useForm<CustomForm>({ resolver: zodResolver(customSchema) });
  const paymentForm = useForm<PaymentForm>({ resolver: zodResolver(paymentSchema) });
  const statusForm = useForm<StatusForm>({ resolver: zodResolver(statusSchema) });
  const [statusResults, setStatusResults] = useState<JobStatusEntry[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<string[]>([]);

  const registerJob = (jobId: string | undefined) => {
    if (!jobId) return;
    setRecentJobs((prev) => [jobId, ...prev.filter((id) => id !== jobId)].slice(0, 5));
  };

  const handleStatus = statusForm.handleSubmit(async (payload: StatusForm) => {
    if (!payload.jobId && !payload.jobIds && !payload.messageId) {
      setStatusError('Enter a jobId, jobIds, or messageId');
      return;
    }
    setStatusError(null);
    try {
      const res = await fetchJobStatus(payload);
      setStatusResults(res.jobs);
    } catch (err: any) {
      setStatusError(err?.message || 'Lookup failed');
      setStatusResults(null);
    }
  });

  return (
    <SectionCard
      title="WhatsApp Queue"
      description="Enqueue reminders, custom templates, payment confirmations, and inspect job health."
    >
      <div style={{ display: 'grid', gap: '1rem' }}>
        <form
          className="form-grid"
          onSubmit={reminderForm.handleSubmit(async (payload: ReminderForm) => {
            try {
              const res = await enqueueFeeReminder(payload);
              registerJob(res.jobId);
              reminderForm.reset({ bilingual: false });
            } catch (err: any) {
              alert(err?.message || 'Failed to enqueue reminder');
            }
          })}
        >
          <h3>Fee Reminder</h3>
          <label>
            To (+91…)
            <input {...reminderForm.register('to')} />
          </label>
          <label>
            Student name
            <input {...reminderForm.register('studentName')} />
          </label>
          <label>
            Amount
            <input type="number" step="0.01" {...reminderForm.register('amount', { valueAsNumber: true })} />
          </label>
          <label>
            Due date
            <input {...reminderForm.register('dueDate')} placeholder="2025-11-30" />
          </label>
          <label>
            Language
            <input {...reminderForm.register('language')} placeholder="en_IN" />
          </label>
          <label>
            Tenant ID (optional)
            <input {...reminderForm.register('tenantId')} placeholder="tenant_123" />
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" {...reminderForm.register('bilingual')} /> Bilingual template
          </label>
          <button className="primary-button" type="submit">Enqueue</button>
        </form>

        <form
          className="form-grid"
          onSubmit={customForm.handleSubmit(async (payload: CustomForm) => {
            try {
              const res = await enqueueCustomMessage(payload);
              registerJob(res.jobId);
              customForm.reset();
            } catch (err: any) {
              alert(err?.message || 'Failed to enqueue custom message');
            }
          })}
        >
          <h3>Custom Message</h3>
          <label>
            To
            <input {...customForm.register('to')} />
          </label>
          <label>
            Message
            <textarea className="textarea" {...customForm.register('message')} />
          </label>
          <label>
            Language
            <input {...customForm.register('language')} placeholder="english" />
          </label>
          <label>
            Tenant ID (optional)
            <input {...customForm.register('tenantId')} placeholder="tenant_123" />
          </label>
          <button className="primary-button" type="submit">Enqueue</button>
        </form>

        <form
          className="form-grid"
          onSubmit={paymentForm.handleSubmit(async (payload: PaymentForm) => {
            try {
              const res = await enqueuePaymentConfirmation(payload);
              registerJob(res.jobId);
              paymentForm.reset();
            } catch (err: any) {
              alert(err?.message || 'Failed to enqueue payment confirmation');
            }
          })}
        >
          <h3>Payment Confirmation</h3>
          <label>
            To
            <input {...paymentForm.register('to')} />
          </label>
          <label>
            Student name
            <input {...paymentForm.register('studentName')} />
          </label>
          <label>
            Amount
            <input type="number" step="0.01" {...paymentForm.register('amount', { valueAsNumber: true })} />
          </label>
          <label>
            Payment date
            <input {...paymentForm.register('paymentDate')} placeholder="2025-11-19" />
          </label>
          <label>
            Tenant ID (optional)
            <input {...paymentForm.register('tenantId')} placeholder="tenant_123" />
          </label>
          <button className="primary-button" type="submit">Enqueue</button>
        </form>
      </div>

      <hr style={{ opacity: 0.2 }} />
      <form className="form-grid" onSubmit={handleStatus}>
        <h3>Job Status & Traceback</h3>
        <label>
          jobId
          <input {...statusForm.register('jobId')} placeholder="abc123" />
        </label>
        <label>
          jobIds (comma separated)
          <input {...statusForm.register('jobIds')} placeholder="a1,b2,c3" />
        </label>
        <label>
          messageId
          <input {...statusForm.register('messageId')} placeholder="wamid." />
        </label>
        <label>
          tenantId
          <input {...statusForm.register('tenantId')} placeholder="tenant_123" />
        </label>
        <button className="primary-button" type="submit">Lookup</button>
      </form>
      {statusError && <p style={{ color: '#f87171' }}>{statusError}</p>}
      {statusResults && statusResults.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Tenant</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {statusResults.map((job) => (
              <tr key={job.id}>
                <td>{job.id}</td>
                <td>{job.state ?? job.status ?? '-'}</td>
                <td>{job.attemptsMade ?? job.attempts ?? '-'}</td>
                <td>{job.tenantId ?? '—'}</td>
                <td>{job.updatedAt ? new Date(job.updatedAt).toLocaleString() : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {recentJobs.length > 0 && (
        <p className="muted">Recent jobIds: {recentJobs.join(', ')}</p>
      )}
    </SectionCard>
  );
}
