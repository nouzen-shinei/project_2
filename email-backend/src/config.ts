export interface ConfigValidationResult {
  provider: string;
  missing: string[];
  warnings: string[];
  timestamp: number;
}

export function validateConfig(): ConfigValidationResult {
  const provider = process.env.EMAIL_PROVIDER_PRIMARY || 'ses';
  const missing: string[] = [];
  const warnings: string[] = [];

  if(provider === 'ses') {
    if(!process.env.AWS_SES_REGION) missing.push('AWS_SES_REGION');
    if(!process.env.SES_SENDER_EMAIL) missing.push('SES_SENDER_EMAIL');
    if(!process.env.AWS_ACCESS_KEY_ID) missing.push('AWS_ACCESS_KEY_ID');
    if(!process.env.AWS_SECRET_ACCESS_KEY) missing.push('AWS_SECRET_ACCESS_KEY');
    else if(process.env.AWS_SECRET_ACCESS_KEY?.endsWith('/')) warnings.push('AWS_SECRET_ACCESS_KEY_trailing_slash');
  }
  if(process.env.EMAIL_PROVIDER_FALLBACK === 'resend') {
    if(!process.env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
    if(!process.env.RESEND_DOMAIN) missing.push('RESEND_DOMAIN');
  }
  if(!process.env.INTERNAL_API_KEY) warnings.push('INTERNAL_API_KEY_missing (auth disabled)');
  if(!process.env.PERSIST_DIR) warnings.push('PERSIST_DIR_missing (stores in-memory only)');

  return { provider, missing, warnings, timestamp: Date.now() };
}

let cached: ConfigValidationResult = validateConfig();
export function getConfigStatus(){ return cached; }
// Revalidate every 5 minutes in case of env injection (mainly for container reloads)
setInterval(()=>{ cached = validateConfig(); }, 300_000).unref();