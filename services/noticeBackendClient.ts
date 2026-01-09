import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { runtimeEndpoints } from './runtimeEndpoints';

export class NoticeBackendError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'NoticeBackendError';
    this.code = code;
  }
}

function resolveBackendBaseUrl(): string {
  const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
  if (!baseUrl) {
    throw new NoticeBackendError(
      'backend_unavailable',
      'Backend API base URL missing. Configure Firestore appSettings/runtimeEndpoints.apiBaseUrl to enable notice deletes.',
    );
  }

  internalTokenManager.setBaseUrl(baseUrl);
  return baseUrl;
}

async function buildAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = await internalTokenManager.getToken(baseUrl);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function parseJsonOrText(text: string): Promise<any> {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

class NoticeBackendClient {
  async deleteNotice(args: { tenantId: string; noticeId: string }): Promise<void> {
    const tenantId = (args.tenantId || '').trim();
    const noticeId = (args.noticeId || '').trim();
    if (!tenantId) throw new NoticeBackendError('tenant_required', 'Tenant id is required.');
    if (!noticeId) throw new NoticeBackendError('notice_required', 'Notice id is required.');

    const baseUrl = resolveBackendBaseUrl();
    const url = `${baseUrl}/tenants/${encodeURIComponent(tenantId)}/notices/${encodeURIComponent(noticeId)}`;

    let headers = await buildAuthHeaders(baseUrl);
    let response = await fetch(url, { method: 'DELETE', headers });

    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await buildAuthHeaders(baseUrl);
      response = await fetch(url, { method: 'DELETE', headers });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      maybeShowMaintenanceAlertFromRaw(response.status, text);
      const parsed = await parseJsonOrText(text);
      const code = typeof parsed?.error === 'string' ? parsed.error : `http_${response.status}`;
      throw new NoticeBackendError(code);
    }
  }
}

export const noticeBackendClient = new NoticeBackendClient();
