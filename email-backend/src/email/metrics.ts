import { Counter, Histogram, Registry, Gauge } from 'prom-client';

export const registry = new Registry();

export const emailSendTotal = new Counter({ name:'email_send_total', help:'Total email send attempts', labelNames:['provider','result','fallback'] });
export const emailSuppressedTotal = new Counter({ name:'email_suppressed_total', help:'Emails suppressed and not sent' });
export const emailLatency = new Histogram({ name:'email_send_latency_ms', help:'Latency of successful provider sends', buckets:[25,50,100,200,400,800,1600,3200], labelNames:['provider'] });
export const emailRetryEnqueued = new Counter({ name:'email_retry_enqueued_total', help:'Emails enqueued for retry' });
export const emailRetryAttempt = new Counter({ name:'email_retry_attempt_total', help:'Retry attempts performed' });
export const emailRetryGiveup = new Counter({ name:'email_retry_giveup_total', help:'Retries exhausted/given up' });
export const emailRetryQueueSize = new Gauge({ name:'email_retry_queue_size', help:'Current retry queue length' });
export const idempotentReplayTotal = new Counter({ name:'idempotent_replay_total', help:'Idempotent cache replay responses' });
export const idempotentStoreSize = new Gauge({ name:'idempotent_store_size', help:'Current idempotent cache size' });
export const suppressionStoreSize = new Gauge({ name:'suppression_store_size', help:'Current suppression list size' });
export const suppressionAddedTotal = new Counter({ name:'suppression_added_total', help:'Suppressions added', labelNames:['reason'] });
export const providerCircuitState = new Gauge({ name:'provider_circuit_state', help:'Circuit breaker state per provider (0=closed,1=open)', labelNames:['provider'] });
/**
 * Helper to read a single gauge/counter value with exact label match.
 */
export async function getMetricValue(name: string, labels: Record<string,string> = {}): Promise<number | undefined> {
	// Prefer direct metric access when available
	const metric: any = name === 'provider_circuit_state' ? providerCircuitState : (registry as any).getSingleMetric?.(name);
	if(!metric || !metric.get) return undefined;
	const data = metric.get();
	const match = data?.values?.find((v: any)=>{
		const ls = v.labels || {};
		return Object.keys(labels).every(k=> String(ls[k])===String(labels[k]));
	});
	if(match && typeof match.value === 'number') return match.value as number;
	// Fallback: parse registry text exposition
	try {
		const text = (registry as any).metrics ? (await (registry as any).metrics()) : '';
		const parts: string[] = [];
		for(const [k,v] of Object.entries(labels)) parts.push(`${k}="${v}"`);
		const lbl = parts.join(',');
		const rx = new RegExp(`^${name}\\{[^}]*${lbl}[^}]*\\}\\s+([0-9.]+)`, 'm');
		const m = text.match(rx);
		if(m) return Number(m[1]);
	} catch {}
		return undefined;
}

	export function getProviderCircuitState(provider: string): Promise<number | undefined> {
		return getMetricValue('provider_circuit_state', { provider });
}
export const adminRequestsTotal = new Counter({ name:'admin_requests_total', help:'Total admin endpoint requests', labelNames:['route'] });
export const adminRateLimitedTotal = new Counter({ name:'admin_rate_limited_total', help:'Admin requests rejected due to rate limit', labelNames:['route'] });

registry.registerMetric(emailSendTotal);
registry.registerMetric(emailSuppressedTotal);
registry.registerMetric(emailLatency);
registry.registerMetric(emailRetryEnqueued);
registry.registerMetric(emailRetryAttempt);
registry.registerMetric(emailRetryGiveup);
registry.registerMetric(emailRetryQueueSize);
registry.registerMetric(idempotentReplayTotal);
registry.registerMetric(idempotentStoreSize);
registry.registerMetric(suppressionStoreSize);
registry.registerMetric(suppressionAddedTotal);
registry.registerMetric(providerCircuitState);
registry.registerMetric(adminRequestsTotal);
registry.registerMetric(adminRateLimitedTotal);
