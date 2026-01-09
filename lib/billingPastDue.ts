export type BillingPastDueEvent = {
  error: 'billing_past_due';
  status?: string;
  graceUntil?: string | null;
  tenantId?: string;
};

type Listener = (event: BillingPastDueEvent) => void;

const listeners = new Set<Listener>();
let lastEmitAt = 0;

export function onBillingPastDue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitBillingPastDue(event: BillingPastDueEvent): void {
  const now = Date.now();
  // Avoid spamming the UI if multiple requests fail at once.
  if (now - lastEmitAt < 2500) {
    return;
  }
  lastEmitAt = now;
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
}

export function maybeEmitBillingPastDueFromParsed(status: number, parsed: any): BillingPastDueEvent | null {
  if (status !== 402) {
    return null;
  }
  const error = typeof parsed?.error === 'string' ? parsed.error : '';
  if (error !== 'billing_past_due') {
    return null;
  }
  const evt: BillingPastDueEvent = {
    error: 'billing_past_due',
    status: typeof parsed?.status === 'string' ? parsed.status : undefined,
    graceUntil: typeof parsed?.graceUntil === 'string' ? parsed.graceUntil : (parsed?.graceUntil === null ? null : undefined),
    tenantId: typeof parsed?.tenantId === 'string' ? parsed.tenantId : undefined,
  };
  emitBillingPastDue(evt);
  return evt;
}

export function maybeEmitBillingPastDueFromRaw(status: number, rawBody: string | null | undefined): BillingPastDueEvent | null {
  if (status !== 402) {
    return null;
  }
  const text = typeof rawBody === 'string' ? rawBody.trim() : '';
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return maybeEmitBillingPastDueFromParsed(status, parsed);
  } catch {
    return null;
  }
}
