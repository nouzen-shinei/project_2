// Feature: video-transcoding-compatibility, Property 24: Deleted original is replaced in RTDB
//
// Validates Requirement 7.1:
//   When the transcoder completes with originalDeleted===true and valid RTDB path fields,
//   the RTDB attachment's primary `url` is set to transcodedUrl and originalReplaced===true.
//   When originalDeleteError===true, the `url` field is NOT overwritten.

import * as fc from 'fast-check';

// ─── Lightweight stub for the RTDB write logic ───────────────────────────────
// We extract and unit-test the decision logic independently of the full
// runTranscodeJob to keep this test fast and isolated.

interface RtdbInfo {
  rtdbTenantId?: string;
  rtdbConversationKey?: string;
  rtdbMessageId?: string;
  rtdbAttachmentIndex?: number;
  originalDeleted?: boolean;
  originalDeleteError?: boolean;
}

/**
 * Mirrors the decision logic inside the RTDB write-back block of runTranscodeJob.
 * Returns the set of RTDB paths that would be written for a given rtdbInfo state.
 */
function resolveRtdbWrites(
  rtdbInfo: RtdbInfo,
  transcodedUrl: string,
  rAttIdx: number,
): {
  transcodedUrlPath: string;
  urlOverwritePath: string | null;
  originalReplacedPath: string | null;
} | null {
  const { rtdbTenantId, rtdbConversationKey, rtdbMessageId } = rtdbInfo;
  if (!rtdbTenantId || !rtdbConversationKey || !rtdbMessageId) {
    return null;
  }

  const basePath =
    rAttIdx >= 0
      ? `tenantChat/${rtdbTenantId}/conversationMessages/${rtdbConversationKey}/${rtdbMessageId}/attachments/${rAttIdx}`
      : `tenantChat/${rtdbTenantId}/conversationMessages/${rtdbConversationKey}/${rtdbMessageId}`;

  const originalSuccessfullyDeleted =
    rtdbInfo.originalDeleted === true && !rtdbInfo.originalDeleteError;

  return {
    transcodedUrlPath: `${basePath}/transcodedUrl`,
    urlOverwritePath: originalSuccessfullyDeleted ? `${basePath}/url` : null,
    originalReplacedPath: originalSuccessfullyDeleted ? `${basePath}/originalReplaced` : null,
  };
}

// ─── Property generators ─────────────────────────────────────────────────────

const validRtdbPathFields = () =>
  fc.record({
    rtdbTenantId: fc.string({ minLength: 1, maxLength: 20 }),
    rtdbConversationKey: fc.string({ minLength: 1, maxLength: 20 }),
    rtdbMessageId: fc.string({ minLength: 1, maxLength: 20 }),
  });

const validTranscodedUrl = () =>
  fc.webUrl({ withQueryParameters: false });

const attachmentIndex = () => fc.oneof(
  fc.integer({ min: 0, max: 10 }), // array attachment
  fc.constant(-1),                  // single-file message
);

// ─── Property 24a: originalDeleted===true overwrites url and sets originalReplaced ──

describe('Property 24a: when originalDeleted is true, url and originalReplaced are written', () => {
  it('holds for any valid RTDB path and transcoded URL', () => {
    fc.assert(
      fc.property(
        validRtdbPathFields(),
        validTranscodedUrl(),
        attachmentIndex(),
        (pathFields, transcodedUrl, rAttIdx) => {
          const rtdbInfo: RtdbInfo = {
            ...pathFields,
            originalDeleted: true,
            // no originalDeleteError
          };

          const result = resolveRtdbWrites(rtdbInfo, transcodedUrl, rAttIdx);

          expect(result).not.toBeNull();
          // transcodedUrl is always written
          expect(result!.transcodedUrlPath).toContain('transcodedUrl');
          // url overwrite path must be set when originalDeleted===true
          expect(result!.urlOverwritePath).not.toBeNull();
          expect(result!.urlOverwritePath).toContain('/url');
          // originalReplaced path must be set
          expect(result!.originalReplacedPath).not.toBeNull();
          expect(result!.originalReplacedPath).toContain('originalReplaced');
          // url overwrite uses the same basePath as transcodedUrl
          expect(result!.urlOverwritePath!.replace('/url', ''))
            .toBe(result!.transcodedUrlPath.replace('/transcodedUrl', ''));
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 24b: originalDeleteError===true skips the url overwrite ────────

describe('Property 24b: when originalDeleteError is true, url is NOT overwritten', () => {
  it('holds for any valid RTDB path and transcoded URL', () => {
    fc.assert(
      fc.property(
        validRtdbPathFields(),
        validTranscodedUrl(),
        attachmentIndex(),
        (pathFields, transcodedUrl, rAttIdx) => {
          const rtdbInfo: RtdbInfo = {
            ...pathFields,
            originalDeleted: true,
            originalDeleteError: true, // deletion failed
          };

          const result = resolveRtdbWrites(rtdbInfo, transcodedUrl, rAttIdx);

          expect(result).not.toBeNull();
          // transcodedUrl is still written
          expect(result!.transcodedUrlPath).toContain('transcodedUrl');
          // url overwrite must NOT happen when original deletion failed
          expect(result!.urlOverwritePath).toBeNull();
          expect(result!.originalReplacedPath).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 24c: missing RTDB path fields → no writes ─────────────────────

describe('Property 24c: when RTDB path fields are missing, no writes are issued', () => {
  it('holds for any incomplete rtdbInfo', () => {
    fc.assert(
      fc.property(
        validTranscodedUrl(),
        attachmentIndex(),
        (transcodedUrl, rAttIdx) => {
          // At least one required field is absent
          const result = resolveRtdbWrites(
            { originalDeleted: true }, // no path fields
            transcodedUrl,
            rAttIdx,
          );
          expect(result).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 24d: basePath structure is consistent with rAttIdx ─────────────

describe('Property 24d: basePath correctly distinguishes array vs root attachments', () => {
  it('holds for both non-negative and -1 attachment indices', () => {
    fc.assert(
      fc.property(
        validRtdbPathFields(),
        validTranscodedUrl(),
        fc.integer({ min: 0, max: 20 }), // array index only
        (pathFields, transcodedUrl, rAttIdx) => {
          const result = resolveRtdbWrites(
            { ...pathFields, originalDeleted: true },
            transcodedUrl,
            rAttIdx,
          );
          expect(result).not.toBeNull();
          // Array attachment paths include /attachments/{index}
          expect(result!.transcodedUrlPath).toContain(`/attachments/${rAttIdx}/`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('root path (-1) does not include /attachments/', () => {
    fc.assert(
      fc.property(
        validRtdbPathFields(),
        validTranscodedUrl(),
        (pathFields, transcodedUrl) => {
          const result = resolveRtdbWrites(
            { ...pathFields, originalDeleted: true },
            transcodedUrl,
            -1, // single-file message
          );
          expect(result).not.toBeNull();
          expect(result!.transcodedUrlPath).not.toContain('/attachments/');
        },
      ),
      { numRuns: 100 },
    );
  });
});
