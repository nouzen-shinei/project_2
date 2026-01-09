import { describe, it, expect, vi } from 'vitest';

describe('quotaPoller', () => {
  it('polls SES quota and updates gauges', async () => {
    process.env.AWS_SES_REGION = 'test-region';
    // Fresh module instances so poller picks up region
    vi.resetModules();
    vi.mock('@aws-sdk/client-ses', () => {
      return {
        SESClient: class { async send(_cmd: any){ return { Max24HourSend: 2000, SentLast24Hours: 50, MaxSendRate: 20 }; } },
        GetSendQuotaCommand: class {}
      };
    });
    const mod: any = await import('../quotaPoller.js');
    // Wait a tick for initial poll() (invoked at module load) to resolve
    await new Promise(r=>setTimeout(r,20));
    const snapshot = mod.getLastQuota();
    expect(snapshot.max24h).toBe(2000);
    expect(snapshot.sent24h).toBe(50);
    expect(snapshot.maxRate).toBe(20);
    // Wait until gauges populated
    const waitMetric = async (getter: ()=>Promise<any>) => {
      const deadline = Date.now()+500;
      while(Date.now()<deadline){
        const g = await getter();
        if(g.values && g.values.length>0) return g.values[0].value;
        await new Promise(r=>setTimeout(r,10));
      }
      return undefined;
    };
    const g1 = await waitMetric(()=>mod.sesMax24HourSend.get());
    const g2 = await waitMetric(()=>mod.sesSentLast24Hours.get());
    const g3 = await waitMetric(()=>mod.sesMaxSendRate.get());
    expect(g1).toBe(2000);
    expect(g2).toBe(50);
    expect(g3).toBe(20);
  });
});
