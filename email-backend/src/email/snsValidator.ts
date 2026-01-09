import crypto from 'crypto';
import fetch from 'node-fetch';
import pino from 'pino';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Minimal SNS signature validation for Notification & SubscriptionConfirmation
// Only used if SNS_VALIDATE_SIGNATURE=1

function buildStringToSign(msg: any){
  // According to AWS docs: different order for Notification vs SubscriptionConfirmation
  if(msg.Type === 'Notification'){
    return [
      'Message', msg.Message,
      'MessageId', msg.MessageId,
      msg.Subject ? 'Subject' : undefined, msg.Subject ? msg.Subject : undefined,
      'Timestamp', msg.Timestamp,
      'TopicArn', msg.TopicArn,
      'Type', msg.Type
    ].filter(Boolean).join('\n') + '\n';
  } else if(msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation'){
    return [
      'Message', msg.Message,
      'MessageId', msg.MessageId,
      'SubscribeURL', msg.SubscribeURL,
      'Timestamp', msg.Timestamp,
      'Token', msg.Token,
      'TopicArn', msg.TopicArn,
      'Type', msg.Type
    ].join('\n') + '\n';
  }
  return '';
}

export async function validateSnsSignature(body: any): Promise<boolean> {
  if(!body || !body.Signature || !body.SigningCertURL) return false;
  try {
    const res = await fetch(body.SigningCertURL);
    if(!res.ok) return false;
    const pem = await res.text();
    const stringToSign = buildStringToSign(body);
    if(!stringToSign) return false;
    const verifier = crypto.createVerify('sha1');
    verifier.update(stringToSign, 'utf8');
    return verifier.verify(pem, body.Signature, 'base64');
  } catch(e:any){
    logger.warn({ msg:'sns_sig_validate_error', err:e?.message });
    return false;
  }
}

export async function maybeAutoConfirm(body: any){
  if(body?.Type === 'SubscriptionConfirmation' && body.SubscribeURL && process.env.SNS_AUTO_CONFIRM==='1'){
    try {
      const res = await fetch(body.SubscribeURL);
      if(res.ok){ logger.info({ msg:'sns_sub_confirmed'}); }
    } catch(e:any){ logger.warn({ msg:'sns_sub_confirm_error', err:e?.message }); }
  }
}