import { SESClient, GetSendQuotaCommand } from '@aws-sdk/client-ses';
import { Gauge } from 'prom-client';
import { registry } from './metrics.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export const sesMax24HourSend = new Gauge({ name:'ses_max_24_hour_send', help:'SES max 24 hour send' });
export const sesSentLast24Hours = new Gauge({ name:'ses_sent_last_24_hours', help:'SES sent last 24 hours' });
export const sesMaxSendRate = new Gauge({ name:'ses_max_send_rate', help:'SES max send rate per second' });
registry.registerMetric(sesMax24HourSend);
registry.registerMetric(sesSentLast24Hours);
registry.registerMetric(sesMaxSendRate);

let lastQuota: any = null;
export function getLastQuota(){ return lastQuota; }

const region = process.env.AWS_SES_REGION;
let client: SESClient | undefined;
if(region) client = new SESClient({ region });

async function poll(){
  if(!client){ return; }
  try {
    const data = await client.send(new GetSendQuotaCommand({}));
    lastQuota = {
      max24h: data.Max24HourSend,
      sent24h: data.SentLast24Hours,
      maxRate: data.MaxSendRate,
      ts: Date.now()
    };
    if(typeof data.Max24HourSend === 'number') sesMax24HourSend.set(data.Max24HourSend);
    if(typeof data.SentLast24Hours === 'number') sesSentLast24Hours.set(data.SentLast24Hours);
    if(typeof data.MaxSendRate === 'number') sesMaxSendRate.set(data.MaxSendRate);
  } catch(e:any){
    logger.warn({ msg:'quota_poll_error', err: e?.message });
  }
}

setInterval(poll, 300_000).unref(); // every 5 min
poll().catch(()=>{});
