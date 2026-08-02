import type { SendChatMessageInput } from '../chatMessageWriter';

export type BackgroundUploadMediaKind = 'sticker' | 'gif' | 'attachment';

export interface BuildBackgroundUploadChatMessageArgs {
  mediaKind: BackgroundUploadMediaKind;
  url: string;
  /**
   * The STORAGE name (the `filename` query param, sanitized). Used as the display
   * name only when `displayName` is absent, which is what keeps every
   * already-deployed caller byte-identical.
   */
  filename: string;
  /**
   * The human-visible name, from the `displayName` query param (upload-idempotency
   * spec). Present when the caller sends a DETERMINISTIC `filename` for the object
   * path — the native background transport derives its filename from the send's
   * `clientMsgId`, so without this the recipient would see `pick_pm_…_a1b2c3.jpg`
   * instead of the file they picked.
   *
   * Absent/blank ⇒ `filename` is used, so this parameter cannot change the output
   * for a caller that does not send it.
   */
  displayName?: string;
  contentType: string;
  bytes: number;
  safeExt: string;
  senderEmail: string;
  recipientId: string;
  tenantId: string;
  clientMsgId?: string;
  text?: string;
}

/**
 * Build the `sendChatMessage` input for a Phase-2 background upload that also
 * creates its chat message server-side (so the message exists even if the app is
 * killed before the upload completes).
 *
 * Pure + isolated (only a type-only import) so the mapping — `mediaKind` ->
 * sticker / gif / attachment payload — is unit-testable without the Express /
 * Firebase route harness. Idempotency is carried by `clientMsgId` (the writer
 * upserts on it), so a resumed/re-driven send never duplicates the message.
 */
export function buildBackgroundUploadChatMessageInput(
  args: BuildBackgroundUploadChatMessageArgs
): SendChatMessageInput {
  const base: SendChatMessageInput = {
    senderEmail: args.senderEmail,
    recipientEmail: args.recipientId,
    tenantId: args.tenantId,
    clientMsgId: args.clientMsgId,
    text: args.text || '',
  };

  // The one user-visible name for this upload: `displayName` when the caller sent
  // one, else the storage name. `||` (not `??`) so an empty-string `displayName`
  // behaves exactly like an absent one and still reaches the `'Sticker'` /
  // `file.{ext}` fallbacks below.
  const visibleName = args.displayName || args.filename;

  if (args.mediaKind === 'sticker') {
    return { ...base, sticker: { url: args.url, name: visibleName || 'Sticker' } };
  }
  if (args.mediaKind === 'gif') {
    return { ...base, gif: { url: args.url } };
  }
  return {
    ...base,
    attachments: [
      {
        url: args.url,
        fileName: visibleName || `file.${args.safeExt}`,
        fileType: args.contentType,
        fileSize: args.bytes,
      },
    ],
  };
}
