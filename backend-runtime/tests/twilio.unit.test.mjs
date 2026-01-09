import assert from 'assert';
import { describe, it, after, before } from 'node:test';

process.env.TWILIO_ACCOUNT_SID = 'ACXXXX';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_PHONE_NUMBER = '+15551234567';

let twilio;

describe('twilio module', () => {
  before(async () => {
    let callCount = 0;
    twilio = await import('../dist/twilio.js');
    twilio.setFetchForTests(async (url, init) => {
      callCount++;
      if(init?.method==='POST' && url.includes('/Messages.json')) {
        return { ok: true, json: async ()=>({ sid: 'SM123' }) };
      }
      if(init?.method==='POST' && url.includes('/Calls.json')) {
        if(callCount===1) return { ok: false, text: async ()=> 'first' };
        return { ok: true, json: async ()=>({ sid: 'CA123' }) };
      }
      return { ok: true, json: async ()=>({}) };
    });
  });
  after(()=>{});

  it('sendSMS success', async () => {
    const res = await twilio.sendSMS({ to: '9998887777', message: 'Hi' });
    assert.equal(res.success, true);
  });
  it('voice call fallback triggers', async () => {
    const res = await twilio.sendVoiceCall({ to: '9998887777', message: 'Hello', language: 'english' });
    assert.equal(res.success, true);
  });
});
