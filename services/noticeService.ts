import { logger } from '@/lib/logger';
import { Notice } from '../types/notice';
import { deviceTrackingService } from './deviceTrackingService';
import type { DeviceNotificationFanoutResult, DeviceTenantFilterOptions } from './deviceTrackingService';
import { tenantService } from './tenantService';
import type { TenantMembershipRole } from '../types/tenant';

interface DispatchSummary {
  recipients: number;
  devices: number;
  success: number;
  failed: number;
}

class NoticeService {
  private async getTenantFilterOptions(explicitTenantId?: string | null): Promise<DeviceTenantFilterOptions | undefined> {
    try {
      const tenantId = explicitTenantId?.trim() || (await tenantService.getCachedSelectedTenant());
      if (!tenantId) {
        return undefined;
      }
      return {
        tenantId,
        includeUntagged: false,
      };
    } catch (error) {
      logger.warn('[noticeService] Unable to resolve tenant filter options', error);
      return undefined;
    }
  }

  async notifyNewNotice(notice: Notice): Promise<void> {
    try {
      logger.debug('[noticeService] Starting broadcast for notice', {
        noticeId: notice.id,
        priority: notice.priority,
      });

      const tenantFilterOptions = await this.getTenantFilterOptions(notice.tenantId);
      if (!tenantFilterOptions?.tenantId) {
        logger.warn('[noticeService] Missing tenant context for notice broadcast; aborting', {
          noticeId: notice.id,
        });
        return;
      }

      const recipients = await this.resolveRecipients(notice, tenantFilterOptions);
      if (recipients.length === 0) {
        logger.warn('[noticeService] No recipients resolved for notice broadcast', {
          noticeId: notice.id,
        });
        return;
      }

      logger.debug('[noticeService] Resolved notice recipients', {
        noticeId: notice.id,
        totalRecipients: recipients.length,
      });

      const summary: DispatchSummary = {
        recipients: 0,
        devices: 0,
        success: 0,
        failed: 0,
      };

      // Per-recipient push delivery is delegated to the backend Fanout_Endpoint
      // (`POST /notifications/fanout`) via the `sendNotificationToUser` bridge,
      // which resolves the recipient's devices SERVER-SIDE. The client never
      // reads another user's `user_devices` tree (Req 7.1/7.3/7.5).
      for (const email of recipients) {
        try {
          const dispatch = await this.dispatchNoticeViaServerFanout(email, notice, tenantFilterOptions);
          if (dispatch.deliverableDeviceCount > 0) {
            summary.recipients++;
          }
          summary.devices += dispatch.deliverableDeviceCount;
          summary.success += dispatch.success;
          summary.failed += dispatch.failed;
        } catch (error) {
          logger.warn('[noticeService] Failed to process devices for recipient', {
            email,
            error,
          });
        }
      }

      logger.debug('[noticeService] Notice broadcast complete', {
        noticeId: notice.id,
        ...summary,
      });
    } catch (error) {
      logger.error('[noticeService] Failed to broadcast notice', error);
    }
  }

  private async resolveRecipients(_notice: Notice, tenantFilterOptions?: DeviceTenantFilterOptions): Promise<string[]> {
    try {
      const resolved = new Set<string>();

      const targetRoles: TenantMembershipRole[] | undefined = Array.isArray(_notice.targetTenantRoles)
        ? (_notice.targetTenantRoles as TenantMembershipRole[])
        : undefined;
      const roleScoped = Boolean(targetRoles && targetRoles.length > 0);

      let membershipEmails: string[] = [];
      let membershipLoadSucceeded = false;

      if (tenantFilterOptions?.tenantId) {
        try {
          const memberships = await tenantService.getActiveMembershipsForTenant(tenantFilterOptions.tenantId);
          membershipLoadSucceeded = true;

          const filtered = roleScoped
            ? memberships.filter((membership) => {
                const role = membership.role as TenantMembershipRole | undefined;
                return role ? targetRoles!.includes(role) : false;
              })
            : memberships;

          membershipEmails = filtered
            .map((membership) => membership.email?.toLowerCase?.())
            .filter((email): email is string => Boolean(email));
        } catch (error) {
          logger.warn('[noticeService] Failed to load tenant memberships for recipients', error);
        }
      }

      membershipEmails.forEach((email) => resolved.add(email));

      if (_notice.createdByEmail) {
        resolved.add(_notice.createdByEmail.toLowerCase());
      }

      if (resolved.size === 0) {
        if (roleScoped && !membershipLoadSucceeded) {
          // We can't safely infer tenant roles from device tracking. Be conservative and avoid notifying everyone.
          logger.warn('[noticeService] Role-scoped notice broadcast blocked due to missing membership roles', {
            noticeId: _notice.id,
            tenantId: tenantFilterOptions?.tenantId,
            targetTenantRoles: targetRoles,
          });
          return _notice.createdByEmail ? [_notice.createdByEmail.toLowerCase()] : [];
        }

        try {
          const users = await deviceTrackingService.getAllUsers(tenantFilterOptions);
          users
            .map((user) => user.email?.toLowerCase?.())
            .filter((email): email is string => Boolean(email))
            .forEach((email) => resolved.add(email));

          logger.debug('[noticeService] Fallback recipients resolved from device tracking', {
            count: resolved.size,
          });
        } catch (fallbackError) {
          logger.warn('[noticeService] Fallback recipient resolution failed', fallbackError);
        }
      }

      const recipients = Array.from(resolved);
      return recipients;
    } catch (error) {
      logger.warn('[noticeService] Unable to resolve recipients for notice', error);
      return [];
    }
  }

  /**
   * Server_Fanout delivery for a single notice recipient (Stage 3; Req 7.1, 7.3,
   * 7.5). Delegates push-target resolution and delivery to the backend
   * Fanout_Endpoint via {@link deviceTrackingService.sendNotificationToUser},
   * which — under the flag — resolves the recipient's devices server-side and
   * NEVER reads the recipient's `user_devices` tree from the client.
   *
   * PARITY WITH THE RETIRED CLIENT READER (Req 7.5):
   *  - `onlineOnly: false` so BOTH online and offline eligible devices are
   *    reached, matching the legacy path which delivered to both the online and
   *    offline partitions.
   *  - The payload carries the `notice_created` Notification_Type, so the server
   *    Delivery_Filter applies the `noticeNotificationsEnabled` Per_Type_Toggle
   *    (and the master `notificationsEnabled` toggle), exactly as the legacy
   *    `sendNotificationToDeviceDetailed` did.
   *  - The server Delivery_Filter additionally honors the notice-specific
   *    hard-ban + manual/forced-logout exclusions (its `excludeBannedOrLoggedOut`
   *    path, enabled for `notice_created`), reproducing the client
   *    `evaluateDeviceEligibility` + `canAttemptRemoteNotificationDelivery`
   *    exclusions so notices reach the SAME devices as before.
   *  - Deleted devices, and mobile-token duplicates, are excluded server-side.
   *
   * DOCUMENTED RESIDUAL DEVIATIONS (the server cannot reproduce these two purely
   * client-local behaviors, and neither changes which OTHER users' devices are
   * notified):
   *  1. SENDER'S OWN CURRENT DEVICE. The legacy path suppressed delivery to the
   *     notice author's *current* device (it knew `getCurrentDeviceId()`). The
   *     server cannot know the caller's current device id, so when the author is
   *     also a recipient their current device is handled by
   *     `sendNotificationToUser`'s local Presence_Delivery (an in-app
   *     notification on web) rather than being fully suppressed. This only ever
   *     affects the author's OWN device, never another user's.
   *  2. PER-DEVICE PAYLOAD FIELDS. The legacy per-device payload embedded
   *     `data.deviceId` and `data.deliveryScope` ('online'/'offline'); with
   *     server-side resolution the fan-out is per-recipient, so those per-device
   *     fields are omitted from the notice `data`. All notice-identifying fields
   *     (`noticeId`, `priority`, audio, etc.) are preserved.
   */
  private async dispatchNoticeViaServerFanout(
    email: string,
    notice: Notice,
    tenantFilterOptions?: DeviceTenantFilterOptions
  ): Promise<{ success: number; failed: number; deliverableDeviceCount: number }> {
    const payload = this.buildRecipientNoticePayload(notice);
    const result: DeviceNotificationFanoutResult = await deviceTrackingService.sendNotificationToUser(
      email,
      payload,
      false, // onlineOnly=false → reach BOTH online and offline eligible devices
      tenantFilterOptions
    );
    return {
      success: result.success,
      failed: result.failed,
      deliverableDeviceCount: result.deliverableDeviceCount,
    };
  }

  /**
   * Build the recipient-level notice payload delegated to the Fanout_Endpoint.
   * The fan-out is per-recipient (resolution is server-side — see
   * {@link dispatchNoticeViaServerFanout}), so the payload carries NO per-device
   * `deviceId`/`deliveryScope` fields. The
   * `data.type = 'notice_created'` drives the server's notice Per_Type_Toggle +
   * ban/logout exclusion.
   */
  private buildRecipientNoticePayload(notice: Notice) {
    const data: any = {
      type: 'notice_created',
      noticeId: notice.id,
      priority: notice.priority,
      targetAudience: notice.targetAudience || ['all'],
      createdBy: notice.createdByName,
      createdByEmail: notice.createdByEmail,
      createdAt: notice.createdAt || new Date().toISOString(),
      hasAudio: Boolean(notice.audioUrl),
    };

    // Only include audioDurationMs if it's defined to prevent Firebase push errors
    if (notice.audioDurationMs !== undefined) {
      data.audioDurationMs = notice.audioDurationMs;
    }

    return {
      title: this.buildTitle(notice),
      body: this.buildBody(notice),
      data,
    };
  }

  private buildTitle(notice: Notice): string {
    const rawTitle = (notice.title || 'New Notice').trim();
    const normalized = rawTitle.toLowerCase();
    const needsPrefix = !(normalized.startsWith('notice') || normalized.startsWith('new notice'));
    const prefixed = needsPrefix ? `New Notice: ${rawTitle}` : rawTitle;
    return this.truncate(prefixed, 48);
  }

  private buildBody(notice: Notice): string {
    const content = notice.content?.trim();
    if (content) {
      return this.truncate(content, 120);
    }

    const fallback = `${notice.createdByName || 'An admin'} posted a ${(notice.priority || 'medium').toUpperCase()} priority notice.`;
    return this.truncate(fallback, 120);
  }

  private truncate(text: string, limit: number): string {
    if (!text) {
      return '';
    }

    if (text.length <= limit) {
      return text;
    }

    const shortened = text.slice(0, Math.max(limit - 3, 1)).trimEnd();
    return `${shortened}...`;
  }
}

export const noticeService = new NoticeService();
