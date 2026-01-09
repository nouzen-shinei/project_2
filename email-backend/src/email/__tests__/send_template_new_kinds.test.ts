const KEY = 'test_internal_key';
process.env.INTERNAL_API_KEY = KEY;
process.env.NODE_ENV = 'test';
process.env.ASYNC_SENDS = '0';

import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { __setProviders } from '../orchestrator.js';
import type { EmailProvider } from '../types.js';
import { app } from '../../server.js';

const ORIGINAL_PUBLIC_WEB_APP_ORIGIN = process.env.PUBLIC_WEB_APP_ORIGIN;

describe('/email/send-template new template kinds', () => {
  afterAll(() => {
    process.env.PUBLIC_WEB_APP_ORIGIN = ORIGINAL_PUBLIC_WEB_APP_ORIGIN;
  });

  const decodeMustacheHtml = (html: string) =>
    html
      .replace(/&amp;/g, '&')
      .replace(/&#x26;/g, '&')
      .replace(/&#x2F;/g, '/');

  const decodeMustacheAttr = (html: string) =>
    decodeMustacheHtml(html)
      .replace(/&#x3D;/g, '=');

  it('wraps tenant_invite link as smart link with inferred deep_link', async () => {
    process.env.PUBLIC_WEB_APP_ORIGIN = 'https://tuitionmanager.app';

    let capturedHtml = '';
    const prov: EmailProvider = {
      name: 'mock',
      async send(payload: any) {
        capturedHtml = String(payload?.html || '');
        return { success: true, id: 'id-invite' };
      }
    };
    __setProviders({ mock: prov } as any);

    const resp = await request(app)
      .post('/email/send-template')
      .set('x-internal-key', KEY)
      .set('x-tenant', 'tuition')
      .send({
        template: 'tenant_invite',
        to_email: 'admin@example.com',
        to_name: 'Admin',
        tenant_name: 'Central Coaching',
        from_name: 'Central Coaching',
        subject: "You're invited to join Central Coaching",
        invite_role: 'admin',
        invite_link: 'https://tuitionmanager.app/invite/abc123'
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('success', true);

    const decoded = decodeMustacheAttr(capturedHtml);
    expect(decoded).toContain('https://tuitionmanager.app/l?');
    expect(decoded).toContain('u=https%3A%2F%2Ftuitionmanager.app%2Finvite%2Fabc123');
    expect(decoded).toContain('dl=invite%2Fabc123');
  });

  it('accepts billing_event', async () => {
    const prov: EmailProvider = { name: 'mock', async send() { return { success: true, id: 'id-0' }; } };
    __setProviders({ mock: prov } as any);

    const resp = await request(app)
      .post('/email/send-template')
      .set('x-internal-key', KEY)
      .set('x-tenant', 'tuition')
      .send({
        template: 'billing_event',
        to_email: 'owner@example.com',
        to_name: 'Owner',
        tenant_name: 'Central Coaching',
        from_name: 'Central Coaching',
        subject: 'Billing update • Central Coaching',
        summary_title: 'Subscription payment received',
        summary_body: 'Payment received for the PRO plan. Amount: ₹999.',
        action_url: 'https://admin.example.com/admin/billing'
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('success', true);
  });

  it('accepts team_membership_change', async () => {
    const prov: EmailProvider = { name: 'mock', async send() { return { success: true, id: 'id-1' }; } };
    __setProviders({ mock: prov } as any);

    const resp = await request(app)
      .post('/email/send-template')
      .set('x-internal-key', KEY)
      .set('x-tenant', 'tuition')
      .send({
        template: 'team_membership_change',
        to_email: 'admin@example.com',
        to_name: 'Admin',
        tenant_name: 'Central Coaching',
        from_name: 'Central Coaching',
        subject: 'Team role updated',
        summary_title: 'Team role updated',
        summary_body: 'Someone changed a role.',
        action: 'role_changed',
        target_email: 'user@example.com',
        previous_role: 'member',
        target_role: 'admin',
        actor_email: 'owner@example.com',
        actor_name: 'Owner',
        initiated_from: 'web'
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('success', true);
  });

  it('accepts usage_alert', async () => {
    const prov: EmailProvider = { name: 'mock', async send() { return { success: true, id: 'id-2' }; } };
    __setProviders({ mock: prov } as any);

    const resp = await request(app)
      .post('/email/send-template')
      .set('x-internal-key', KEY)
      .set('x-tenant', 'tuition')
      .send({
        template: 'usage_alert',
        to_email: 'admin@example.com',
        to_name: 'Admin',
        tenant_name: 'Central Coaching',
        from_name: 'Central Coaching',
        subject: 'Usage warning • Reminders • Central Coaching',
        threshold: 'warning',
        metric: 'reminders',
        metric_label: 'Reminders',
        current_value: '85',
        usage_limit: '100',
        usage_percentage: '85%',
        month_id: '2025-12',
        alert_url: 'https://admin.example.com/admin/usage'
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('success', true);
  });
});
