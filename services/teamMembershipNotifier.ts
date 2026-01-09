import { logger } from '@/lib/logger';
import type { TenantMembershipRole } from '@/types';
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { runtimeEndpoints } from './runtimeEndpoints';

export type TeamMembershipChangeAction = 'added' | 'removed' | 'role_changed';

type NotifierRole = TenantMembershipRole | 'user';

export interface TeamMembershipChangePayload {
  tenantId: string;
  tenantName?: string;
  action: TeamMembershipChangeAction;
  targetEmail: string;
  targetRole?: NotifierRole;
  previousRole?: NotifierRole;
  metadata?: {
    displayName?: string;
    reason?: string;
    initiatedFrom?: 'web' | 'mobile' | 'system';
    actorName?: string;
  };
}

class TeamMembershipNotifier {
  private readonly endpoint = '/notifications/team-membership';
  private readonly debug =
    process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true';

  private getBaseUrl(): string | undefined {
    const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (baseUrl) {
      internalTokenManager.setBaseUrl(baseUrl);
    }
    return baseUrl;
  }

  private requireBaseUrl(): string {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      throw new Error(
        'Backend URL not configured. Set Firestore appSettings/runtimeEndpoints.apiBaseUrl (or notificationsApiBaseUrl / wabaApiBaseUrl / chatApiBaseUrl).',
      );
    }
    return baseUrl;
  }

  private async buildHeaders(baseUrl?: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!baseUrl) {
      return headers;
    }

    const token = await internalTokenManager.getToken(baseUrl);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async notifyChange(payload: TeamMembershipChangePayload): Promise<void> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      if (this.debug) {
        logger.debug('[team-membership] Base URL missing, skipping notification payload', payload);
      }
      return;
    }

    const tenantId = payload.tenantId?.trim();
    if (!tenantId) {
      logger.warn('[team-membership] Missing tenantId, skipping notification payload');
      return;
    }
    const payloadWithTenant: TeamMembershipChangePayload = { ...payload, tenantId };

    try {
      let response = await fetch(`${baseUrl}${this.endpoint}`, {
        method: 'POST',
        headers: await this.buildHeaders(baseUrl),
        body: JSON.stringify(payloadWithTenant),
      });

      if (response.status === 401) {
        await internalTokenManager.forceRefresh(baseUrl);
        response = await fetch(`${baseUrl}${this.endpoint}`, {
          method: 'POST',
          headers: await this.buildHeaders(baseUrl),
          body: JSON.stringify(payloadWithTenant),
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        maybeShowMaintenanceAlertFromRaw(response.status, errorText);
        throw new Error(errorText || 'team_membership_notification_failed');
      }

      if (this.debug) {
        logger.debug('[team-membership] Notification recorded', payloadWithTenant);
      }
    } catch (error) {
      logger.warn('[team-membership] Failed to record membership change', error);
    }
  }
}

export const teamMembershipNotifier = new TeamMembershipNotifier();
