import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { runtimeEndpoints } from './runtimeEndpoints';
import type { NoticeFormData } from '../types/notice';
import type { TenantMembershipRole } from '../types/tenant';

export class NoticeBackendError extends Error {
  code: string;
  status?: number;
  /** Extra fields from the error body, e.g. `limit`/`used` for notice_post_limit_reached. */
  details: Record<string, unknown>;

  constructor(code: string, message?: string, options: { status?: number; details?: Record<string, unknown> } = {}) {
    super(message || code);
    this.name = 'NoticeBackendError';
    this.code = code;
    this.status = options.status;
    this.details = options.details ?? {};
  }
}

/** This month's notice-post allowance. `limit`/`remaining` are null when the plan has no limit. */
export interface NoticePostQuota {
  monthId: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  resetsAt?: string;
}

export interface CreatedNotice {
  id: string;
  createdByRole: TenantMembershipRole;
  createdByName: string;
  createdByEmail: string;
  quota?: Omit<NoticePostQuota, 'resetsAt'>;
}

export function isNoticePostLimitError(error: unknown): error is NoticeBackendError {
  return error instanceof NoticeBackendError && error.code === 'notice_post_limit_reached';
}

function resolveBackendBaseUrl(): string {
  const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
  if (!baseUrl) {
    throw new NoticeBackendError(
      'backend_unavailable',
      'Backend API base URL missing. Configure Firestore appSettings/runtimeEndpoints.apiBaseUrl to enable notices.',
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

/** Sends an authenticated request, retrying once with a fresh token on 401. */
async function sendAuthed(
  baseUrl: string,
  url: string,
  init: { method: string; body?: string },
): Promise<Response> {
  const buildInit = async (): Promise<RequestInit> => {
    const headers = await buildAuthHeaders(baseUrl);
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return { method: init.method, headers, body: init.body };
  };

  let response = await fetch(url, await buildInit());
  if (response.status === 401) {
    await internalTokenManager.forceRefresh(baseUrl);
    response = await fetch(url, await buildInit());
  }
  return response;
}

async function throwForResponse(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  maybeShowMaintenanceAlertFromRaw(response.status, text);
  const parsed = await parseJsonOrText(text);
  const code = typeof parsed?.error === 'string' ? parsed.error : `http_${response.status}`;
  const details = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  throw new NoticeBackendError(code, undefined, { status: response.status, details });
}

function tenantNoticesUrl(baseUrl: string, tenantId: string): string {
  return `${baseUrl}/tenants/${encodeURIComponent(tenantId)}/notices`;
}

function requireTenantId(value: string): string {
  const tenantId = (value || '').trim();
  if (!tenantId) throw new NoticeBackendError('tenant_required', 'Tenant id is required.');
  return tenantId;
}

class NoticeBackendClient {
  /**
   * Posts a notice. The server enforces the plan's monthly notice-post limit
   * and rejects with NoticeBackendError('notice_post_limit_reached') carrying
   * `details.limit` / `details.used`.
   */
  async createNotice(args: { tenantId: string; notice: NoticeFormData; createdByName?: string }): Promise<CreatedNotice> {
    const tenantId = requireTenantId(args.tenantId);
    const baseUrl = resolveBackendBaseUrl();
    // tenantId / createdByRole on the form are ignored: the server uses the
    // URL tenant and the caller's membership role.
    const { tenantId: _ignoredTenantId, createdByRole: _ignoredRole, ...notice } = args.notice;
    const response = await sendAuthed(baseUrl, tenantNoticesUrl(baseUrl, tenantId), {
      method: 'POST',
      body: JSON.stringify({ ...notice, createdByName: args.createdByName }),
    });
    if (!response.ok) {
      await throwForResponse(response);
    }
    const body = (await response.json().catch(() => null)) as CreatedNotice | null;
    if (!body || typeof body.id !== 'string' || !body.id) {
      throw new NoticeBackendError('invalid_response', 'Notice create response missing id.', { status: response.status });
    }
    return body;
  }

  async getNoticeQuota(args: { tenantId: string }): Promise<NoticePostQuota> {
    const tenantId = requireTenantId(args.tenantId);
    const baseUrl = resolveBackendBaseUrl();
    const response = await sendAuthed(baseUrl, `${tenantNoticesUrl(baseUrl, tenantId)}/quota`, { method: 'GET' });
    if (!response.ok) {
      await throwForResponse(response);
    }
    const body = (await response.json().catch(() => null)) as NoticePostQuota | null;
    if (!body || typeof body.used !== 'number') {
      throw new NoticeBackendError('invalid_response', 'Notice quota response malformed.', { status: response.status });
    }
    return body;
  }

  async deleteNotice(args: { tenantId: string; noticeId: string }): Promise<void> {
    const tenantId = requireTenantId(args.tenantId);
    const noticeId = (args.noticeId || '').trim();
    if (!noticeId) throw new NoticeBackendError('notice_required', 'Notice id is required.');

    const baseUrl = resolveBackendBaseUrl();
    const url = `${tenantNoticesUrl(baseUrl, tenantId)}/${encodeURIComponent(noticeId)}`;
    const response = await sendAuthed(baseUrl, url, { method: 'DELETE' });
    if (!response.ok) {
      await throwForResponse(response);
    }
  }
}

export const noticeBackendClient = new NoticeBackendClient();
