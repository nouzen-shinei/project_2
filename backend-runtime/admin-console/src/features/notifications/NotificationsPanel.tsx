import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { SectionCard } from '../../components/SectionCard';
import {
  getDailyQuoteStatus,
  testBirthday,
  triggerBirthday,
  triggerDailyQuotes,
  proxyExpoPush,
  sendTeamMembershipEvent,
} from '../../lib/apiClient';
import { useConfigStore, type ConfigState } from '../../store/configStore';

const dailySchema = z.object({
  timeOfDay: z.enum(['morning', 'evening', 'immediate', 'auto']).optional(),
  targetEmails: z.string().optional(),
  dryRun: z.boolean().optional(),
  reason: z.string().optional(),
  now: z.string().optional(),
});

type DailyForm = z.infer<typeof dailySchema>;

const birthdaySchema = z.object({
  emails: z.string().optional(),
  deviceIds: z.string().optional(),
  dryRun: z.boolean().optional(),
  forceSend: z.boolean().optional(),
  skipWhatsApp: z.boolean().optional(),
  suppressStateUpdates: z.boolean().optional(),
  reason: z.string().optional(),
  now: z.string().optional(),
});

type BirthdayForm = z.infer<typeof birthdaySchema>;

const pushSchema = z.object({
  to: z.string().min(1),
  title: z.string().optional(),
  body: z.string().optional(),
  dataJson: z.string().optional(),
  dryRun: z.boolean().optional(),
});

type PushForm = z.infer<typeof pushSchema>;

const teamSchema = z.object({
  action: z.enum(['added', 'removed', 'role_changed']),
  targetEmail: z.string().email(),
  targetRole: z.enum(['user', 'admin']).optional(),
  previousRole: z.enum(['user', 'admin']).optional(),
  displayName: z.string().optional(),
  reason: z.string().optional(),
  initiatedFrom: z.enum(['web', 'mobile', 'system']).optional(),
  actorName: z.string().optional(),
});

type TeamForm = z.infer<typeof teamSchema>;

function splitCsv(value?: string) {
  if (!value) return undefined;
  const entries = value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

export function NotificationsPanel() {
  const enabled = useConfigStore((state: ConfigState) => Boolean(state.baseUrl));
  const [tenantId, setTenantId] = useState('');
  const dailyForm = useForm<DailyForm>({ resolver: zodResolver(dailySchema) });
  const birthdayForm = useForm<BirthdayForm>({ resolver: zodResolver(birthdaySchema) });
  const pushForm = useForm<PushForm>({ resolver: zodResolver(pushSchema) });
  const teamForm = useForm<TeamForm>({ resolver: zodResolver(teamSchema), defaultValues: { action: 'added' } });
  const statusQuery = useQuery({ queryKey: ['daily-status'], queryFn: getDailyQuoteStatus, staleTime: 30_000, enabled });
  const requireTenantId = (): string | null => {
    const value = tenantId.trim();
    if (!value) {
      alert('Set a tenant ID before using these notification tools.');
      return null;
    }
    return value;
  };

  return (
    <SectionCard
      title="Notifications & Broadcasts"
      description="Manual triggers for quotes, birthdays, Expo push, and team membership digest."
    >
      <div className="form-grid" style={{ marginBottom: '1rem' }}>
        <label>
          Tenant ID
          <input value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="tenant_123" />
        </label>
        <p className="muted">All actions below will include this tenant scope.</p>
      </div>
      <form
        className="form-grid"
        onSubmit={dailyForm.handleSubmit(async (payload: DailyForm) => {
          try {
            const tenant = requireTenantId();
            if (!tenant) return;
            await triggerDailyQuotes({
              tenantId: tenant,
              timeOfDay: payload.timeOfDay,
              targetEmails: splitCsv(payload.targetEmails),
              dryRun: payload.dryRun,
              reason: payload.reason,
              now: payload.now,
            });
            dailyForm.reset();
          } catch (err: any) {
            alert(err?.message || 'Daily quote trigger failed');
          }
        })}
      >
        <h3>Daily Quotes</h3>
        <label>
          Time of day
          <select {...dailyForm.register('timeOfDay')} defaultValue="">
            <option value="">auto</option>
            <option value="morning">morning</option>
            <option value="evening">evening</option>
            <option value="immediate">immediate</option>
          </select>
        </label>
        <label>
          Target emails (comma/newline separated)
          <textarea className="textarea" {...dailyForm.register('targetEmails')} />
        </label>
        <label>
          Reason
          <input {...dailyForm.register('reason')} placeholder="manual_trigger" />
        </label>
        <label>
          Override now (ISO)
          <input {...dailyForm.register('now')} placeholder="2025-11-20T05:45:00Z" />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" {...dailyForm.register('dryRun')} /> Dry run
        </label>
        <button className="primary-button" type="submit">Trigger quotes</button>
      </form>
      {statusQuery.data && (
        <p className="muted">
          Status: last run {statusQuery.data.lastRunAt ? new Date(statusQuery.data.lastRunAt).toLocaleString() : 'unknown'} • next{' '}
          {statusQuery.data.nextRunAt ? new Date(statusQuery.data.nextRunAt).toLocaleString() : '—'}
        </p>
      )}

      <hr style={{ opacity: 0.2 }} />
      <div className="form-grid" style={{ gap: '1.2rem' }}>
        <form
          onSubmit={birthdayForm.handleSubmit(async (payload: BirthdayForm) => {
            try {
              const tenant = requireTenantId();
              if (!tenant) return;
              await triggerBirthday({
                tenantId: tenant,
                emails: splitCsv(payload.emails),
                deviceIds: splitCsv(payload.deviceIds),
                dryRun: payload.dryRun,
                forceSend: payload.forceSend,
                skipWhatsApp: payload.skipWhatsApp,
                suppressStateUpdates: payload.suppressStateUpdates,
                reason: payload.reason,
                now: payload.now,
              });
              birthdayForm.reset();
            } catch (err: any) {
              alert(err?.message || 'Birthday trigger failed');
            }
          })}
        >
          <h3>Birthday Trigger</h3>
          <label>
            Emails
            <textarea className="textarea" {...birthdayForm.register('emails')} />
          </label>
          <label>
            Device IDs
            <textarea className="textarea" {...birthdayForm.register('deviceIds')} />
          </label>
          <label>
            Reason
            <input {...birthdayForm.register('reason')} placeholder="manual_trigger" />
          </label>
          <label>
            Override now (ISO)
            <input {...birthdayForm.register('now')} />
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" {...birthdayForm.register('dryRun')} /> Dry run
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" {...birthdayForm.register('forceSend')} /> Force send
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" {...birthdayForm.register('skipWhatsApp')} /> Skip WhatsApp
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" {...birthdayForm.register('suppressStateUpdates')} /> Suppress state updates
          </label>
          <button className="primary-button" type="submit">Trigger birthday job</button>
        </form>

        <form
          onSubmit={birthdayForm.handleSubmit(async (payload: BirthdayForm) => {
            try {
              const tenant = requireTenantId();
              if (!tenant) return;
              await testBirthday({
                tenantId: tenant,
                emails: splitCsv(payload.emails),
                deviceIds: splitCsv(payload.deviceIds),
                reason: payload.reason,
              });
            } catch (err: any) {
              alert(err?.message || 'Birthday test failed');
            }
          })}
        >
          <h3>Birthday Test Blast</h3>
          <p className="muted">Uses forceSend + skipWhatsApp overrides automatically.</p>
          <label>
            Emails / Device IDs reused from left form
          </label>
          <button className="primary-button" type="submit">Send test</button>
        </form>
      </div>

      <hr style={{ opacity: 0.2 }} />
      <form
        className="form-grid"
        onSubmit={pushForm.handleSubmit(async (payload: PushForm) => {
          try {
            const tenant = requireTenantId();
            if (!tenant) return;
            let data: Record<string, unknown> | undefined;
            if (payload.dataJson) {
              try {
                data = JSON.parse(payload.dataJson);
              } catch {
                throw new Error('Invalid JSON payload for data field');
              }
            }
            const multiTarget = payload.to.includes(',') || payload.to.includes('\n');
            const computedTo = multiTarget ? splitCsv(payload.to) ?? payload.to.trim() : payload.to.trim();
            const targets = Array.isArray(computedTo) ? computedTo : [computedTo];
            const baseMessage = {
              title: payload.title,
              body: payload.body,
              data,
            };
            const messages = targets.map((to) => ({ ...baseMessage, to }));
            if (payload.dryRun || messages.length > 1) {
              await proxyExpoPush({ tenantId: tenant, messages, ...(payload.dryRun ? { dryRun: true } : {}) });
            } else {
              await proxyExpoPush({ tenantId: tenant, ...baseMessage, to: targets[0] });
            }
            pushForm.reset();
          } catch (err: any) {
            alert(err?.message || 'Push proxy failed');
          }
        })}
      >
        <h3>Expo Push Proxy</h3>
        <label>
          To (token or comma/newline list)
          <textarea className="textarea" {...pushForm.register('to')} />
        </label>
        <label>
          Title
          <input {...pushForm.register('title')} />
        </label>
        <label>
          Body
          <textarea className="textarea" {...pushForm.register('body')} />
        </label>
        <label>
          Data JSON
          <textarea className="textarea" {...pushForm.register('dataJson')} placeholder='{"foo":"bar"}' />
        </label>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" {...pushForm.register('dryRun')} /> Dry run
        </label>
        <button className="primary-button" type="submit">Send push</button>
      </form>

      <hr style={{ opacity: 0.2 }} />
      <form
        className="form-grid"
        onSubmit={teamForm.handleSubmit(async (payload: TeamForm) => {
          try {
            const tenant = requireTenantId();
            if (!tenant) return;
            await sendTeamMembershipEvent({
              tenantId: tenant,
              action: payload.action,
              targetEmail: payload.targetEmail,
              targetRole: payload.targetRole,
              previousRole: payload.previousRole,
              metadata: {
                displayName: payload.displayName,
                reason: payload.reason,
                initiatedFrom: payload.initiatedFrom,
                actorName: payload.actorName,
              },
            });
            teamForm.reset({ action: 'added' });
          } catch (err: any) {
            alert(err?.message || 'Team membership dispatch failed');
          }
        })}
      >
        <h3>Team Membership Notification</h3>
        <label>
          Action
          <select {...teamForm.register('action')}>
            <option value="added">added</option>
            <option value="removed">removed</option>
            <option value="role_changed">role_changed</option>
          </select>
        </label>
        <label>
          Target email
          <input {...teamForm.register('targetEmail')} />
        </label>
        <label>
          Target role
          <select {...teamForm.register('targetRole')}>
            <option value="">--</option>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          Previous role
          <select {...teamForm.register('previousRole')}>
            <option value="">--</option>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          Display name
          <input {...teamForm.register('displayName')} />
        </label>
        <label>
          Actor name
          <input {...teamForm.register('actorName')} />
        </label>
        <label>
          Initiated from
          <select {...teamForm.register('initiatedFrom')}>
            <option value="">--</option>
            <option value="web">web</option>
            <option value="mobile">mobile</option>
            <option value="system">system</option>
          </select>
        </label>
        <label>
          Reason
          <input {...teamForm.register('reason')} />
        </label>
        <button className="primary-button" type="submit">Dispatch event</button>
      </form>
    </SectionCard>
  );
}
