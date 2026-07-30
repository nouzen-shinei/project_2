import type { SendChatMessageInput } from '../chatMessageWriter';

export type BackgroundUploadMediaKind = 'sticker' | 'gif' | 'attachment';

export interface BuildBackgroundUploadChatMessageArgs {
  mediaKind: BackgroundUploadMediaKind;
  url: string;
  filename: string;
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

  if (args.mediaKind === 'sticker') {
    return { ...base, sticker: { url: args.url, name: args.filename || 'Sticker' } };
  }
  if (args.mediaKind === 'gif') {
    return { ...base, gif: { url: args.url } };
  }
  return {
    ...base,
    attachments: [
      {
        url: args.url,
        fileName: args.filename || `file.${args.safeExt}`,
        fileType: args.contentType,
        fileSize: args.bytes,
      },
    ],
  };
}
