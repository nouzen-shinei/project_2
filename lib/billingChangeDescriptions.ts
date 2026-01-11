import type { BillingHistoryChange } from '@/services/billingService';

export type BillingChangeDescription = { title: string; subtitle?: string };

type DescribeBillingChangeOptions = {
  context?: 'history' | 'plan';
  formatAmountInr?: (amountInr: number) => string;
  formatBillingDate?: (value?: string) => string | null;
};

function defaultFormatAmountInr(amountInr: number): string {
  if (!Number.isFinite(amountInr)) return '₹0';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amountInr);
  } catch {
    return `₹${Math.round(amountInr)}`;
  }
}

function defaultFormatBillingDate(value?: string): string | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return value;
  }
}

export function describeBillingChange(entry: BillingHistoryChange, options: DescribeBillingChangeOptions = {}): BillingChangeDescription {
  const meta = entry.metadata || {};
  const action = entry.action;
  const context = options.context ?? 'history';
  const formatAmountInr = options.formatAmountInr ?? defaultFormatAmountInr;
  const formatBillingDate = options.formatBillingDate ?? defaultFormatBillingDate;

  if (action === 'billing_plan_override') {
    const before = (meta as any)?.beforeBilling;
    const after = (meta as any)?.afterBilling;
    const fromPlan = typeof before?.planId === 'string' ? String(before.planId) : '';
    const toPlan = typeof after?.planId === 'string' ? String(after.planId) : '';
    const fromLabel = fromPlan ? fromPlan.toUpperCase() : 'Unknown';
    const toLabel = toPlan ? toPlan.toUpperCase() : 'Unknown';
    return { title: 'Plan updated', subtitle: `${fromLabel} → ${toLabel}` };
  }

  if (action === 'billing_downgrade_to_free_scheduled') {
    const fromPlanId = typeof (meta as any)?.fromPlanId === 'string' ? String((meta as any).fromPlanId) : '';
    const effectiveAt = typeof (meta as any)?.effectiveAt === 'string' ? String((meta as any).effectiveAt) : '';
    const date = formatBillingDate(effectiveAt) || 'End of cycle';
    const fromLabel = fromPlanId ? fromPlanId.toUpperCase() : 'PAID';
    return { title: 'Downgrade scheduled', subtitle: `${fromLabel} → FREE • ${date}` };
  }

  if (action === 'billing_downgrade_to_free') {
    const mode = typeof (meta as any)?.mode === 'string' ? String((meta as any).mode) : '';
    const modeSuffix = mode === 'immediate' ? ' (immediate)' : '';

    if (context === 'plan') {
      return { title: `Switched to Free${modeSuffix}` };
    }

    const fromPlanId = typeof (meta as any)?.fromPlanId === 'string' ? String((meta as any).fromPlanId) : '';
    const fromLabel = fromPlanId ? fromPlanId.toUpperCase() : 'PAID';
    return { title: `Switched to Free${modeSuffix}`, subtitle: `${fromLabel} → FREE` };
  }

  if (action === 'billing_checkout_started') {
    const planId = typeof (meta as any)?.planId === 'string' ? String((meta as any).planId) : '';
    const provider = typeof (meta as any)?.provider === 'string' ? String((meta as any).provider) : '';
    const parts = [planId ? `Plan: ${planId.toUpperCase()}` : null, provider ? `Provider: ${provider}` : null].filter(Boolean);
    return { title: 'Checkout started', subtitle: parts.length ? parts.join(' • ') : undefined };
  }

  if (action === 'billing_subscription_authenticated') {
    return { title: 'Provider event: subscription authenticated', subtitle: 'Mandate/auth step • Payment may be captured later' };
  }
  if (action === 'billing_subscription_activated') {
    return { title: 'Provider event: subscription activated', subtitle: 'Not a payment confirmation' };
  }
  if (action === 'billing_subscription_charged') {
    return { title: 'Provider event: subscription charged', subtitle: 'Payment may be captured separately' };
  }
  if (action === 'billing_subscription_pending') {
    return { title: 'Subscription payment pending' };
  }
  if (action === 'billing_subscription_failed') {
    return { title: 'Subscription payment failed' };
  }
  if (action === 'billing_subscription_halted') {
    return { title: 'Subscription halted' };
  }
  if (action === 'billing_subscription_cancelled') {
    return { title: 'Subscription cancelled' };
  }
  if (action === 'billing_subscription_completed') {
    return { title: 'Subscription completed' };
  }

  if (action === 'billing_subscription_payment_failed') {
    const parts: string[] = [];
    const amountInr = typeof (meta as any)?.amountInr === 'number' ? (meta as any).amountInr : null;
    if (amountInr && Number.isFinite(amountInr)) parts.push(`Amount: ${formatAmountInr(amountInr)}`);
    const method = typeof (meta as any)?.method === 'string' ? String((meta as any).method) : '';
    if (method) parts.push(`Method: ${method.toUpperCase()}`);
    const code = typeof (meta as any)?.errorCode === 'string' ? String((meta as any).errorCode) : '';
    if (code) parts.push(`Code: ${code}`);
    return { title: 'Subscription payment failed', subtitle: parts.length ? parts.join(' • ') : undefined };
  }

  if (action === 'billing_subscription_payment_captured') {
    const parts: string[] = [];
    const amountInr = typeof (meta as any)?.amountInr === 'number' ? (meta as any).amountInr : null;
    if (amountInr && Number.isFinite(amountInr)) parts.push(`Amount: ${formatAmountInr(amountInr)}`);
    const method = typeof (meta as any)?.method === 'string' ? String((meta as any).method) : '';
    if (method) parts.push(`Method: ${method.toUpperCase()}`);
    return { title: 'Payment captured', subtitle: parts.length ? parts.join(' • ') : undefined };
  }

  return { title: 'Plan updated', subtitle: action };
}
