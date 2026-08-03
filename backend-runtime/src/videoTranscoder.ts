/**
 * videoTranscoder.ts
 *
 * Server-side video transcoding: HEVC/H.265 (including 10-bit HDR/Dolby Vision)
 * → H.264/AAC 8-bit (universally compatible with all browsers and devices).
 *
 * Architecture: fire-and-forget async task inside the Express backend process.
 * The HTTP response is sent to the client before transcoding begins.
 * Results are written to Firestore for the client to pick up.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import * as admin from 'firebase-admin';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TranscodeJob {
  originalPath: string;
  bucketName: string;
  originalUrl: string;
  contentType: string;
  /** Tenant identifier — required for quota operations and document attribution. */
  tenantId: string;
  /**
   * Content identity of the bytes stored at `originalPath` by the request that
   * scheduled this job (`videoContentIdentity(body)`), or `undefined` when the
   * scheduler does not have the bytes.
   *
   * This is the discriminator that separates "the same logical upload retried"
   * from "different bytes written to the same deterministic path" — see
   * `decideTranscodeReuse`. `POST /video/request-transcode` deliberately passes
   * nothing here: it holds no bytes, and the original may already be deleted, so
   * there is nothing it could hash.
   *
   * Object `generation` is NOT usable for this: every write bumps it, including a
   * byte-identical retry, so comparing generations would classify an ordinary
   * retry as a content change and re-transcode it — destroying exactly the
   * idempotency the upload-idempotency feature exists to provide.
   */
  originalContentHash?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TRANSCODE_COLLECTION = 'videoTranscodes';

/** MIME types that always need re-encoding (container or codec issues). */
const NEEDS_TRANSCODE_MIME = new Set([
  'video/quicktime',  // .mov — iPhone default, may be HEVC
  'video/x-msvideo',  // .avi
  'video/x-matroska', // .mkv
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 40);
}

function buildTranscodeStoragePath(originalPath: string): string {
  const ext = path.extname(originalPath);
  const base = originalPath.slice(0, originalPath.length - ext.length);
  return `${base}_h264.mp4`;
}

function buildDownloadUrl(bucketName: string, storagePath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

// ─── Content identity (stale-transcode-record discriminator, F21) ─────────────

/**
 * The content identity of an uploaded video body: an algorithm-tagged SHA-256 of
 * the exact bytes that were stored.
 *
 * Computed over the in-memory request body rather than read back from Storage
 * metadata on purpose. GCS does expose `md5Hash` and `crc32c` on the object, and
 * `POST /storage/upload` writes with `file.save({ resumable: false })` — a simple,
 * never-composed upload — so `md5Hash` *is* present for these objects. But reading
 * it would add a Storage round trip on the upload path, and `md5Hash` is absent for
 * composite objects, so depending on it would make the discriminator conditional on
 * a property of how the bytes happened to be written. The body is already in memory
 * and is definitionally the bytes that were stored, so hashing it is both cheaper
 * and exact.
 *
 * The `sha256:` prefix is part of the stored value so a future change of algorithm
 * is self-describing rather than a silent mismatch.
 *
 * Total: any `Buffer` (including empty) yields a string; never throws.
 */
export function videoContentIdentity(bytes: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * What `runTranscodeJob` should do about an existing `videoTranscodes` document.
 *
 * `reuse` carries its reason because the two reasons are NOT the same claim:
 * `content_unchanged` is a positive match, while `content_identity_unknown` is the
 * migration posture — no content identity was recorded (or none was supplied), so
 * nothing is known and today's behaviour is preserved.
 */
export type TranscodeReuseDecision =
  | { action: 'transcode'; reason: 'no_existing_output' }
  | { action: 'reuse'; reason: 'content_unchanged' | 'content_identity_unknown' }
  | { action: 'retranscode'; reason: 'content_changed' };

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Decide whether an existing `videoTranscodes` document may be reused, or whether
 * the bytes at the original path have changed underneath it and the recorded
 * transcode is now STALE (upload-idempotency follow-up F21).
 *
 * WHY THIS EXISTS. `docId` is `sha256(originalPath)` and the upload path is
 * deterministic per `uploadKey`, so every write for one `uploadKey` targets one
 * document. `runTranscodeJob` used to return early on *any* existing
 * `transcodedUrl`, which is right for a retry and wrong for a genuinely different
 * video written to the same path: the new bytes were never transcoded, and both
 * `ChatCacheService` and `POST /video/request-transcode` kept handing out the
 * PREVIOUS video's `transcodedUrl` — which lives at a different object path
 * (`{base}_h264.mp4`) and therefore still exists and still plays. The viewer got
 * the wrong video, indefinitely, with no self-healing path.
 *
 * THE INVARIANT THIS MUST NOT BREAK. An ordinary retry of one logical upload —
 * same `uploadKey`, same bytes, first response lost — must still DEDUPE. That is
 * why the discriminator is content identity and not object `generation`: a retry
 * bumps the generation while storing byte-identical content, so a generation
 * comparison would re-transcode every retry.
 *
 * MIGRATION POSTURE. Documents written before F21 carry no `originalContentHash`,
 * and jobs scheduled by `POST /video/request-transcode` supply none. When either
 * side is absent this returns `reuse` — the pre-F21 behaviour — because the honest
 * answer is "unknown" and guessing "changed" would retroactively re-transcode every
 * existing video the first time it was touched: a self-inflicted load spike, and one
 * that would delete originals and rewrite URLs for videos that were fine. New
 * documents get the protection; old ones keep the documented gap.
 *
 * Total by construction: `existing` is Firestore data, so every field is `unknown`
 * as far as this function is concerned, and every shape falls into one branch.
 */
export function decideTranscodeReuse(
  existing: Record<string, unknown> | null | undefined,
  jobContentHash: string | undefined
): TranscodeReuseDecision {
  if (!readNonEmptyString(existing?.transcodedUrl)) {
    return { action: 'transcode', reason: 'no_existing_output' };
  }

  const recorded = readNonEmptyString(existing?.originalContentHash);
  const incoming = readNonEmptyString(jobContentHash);
  if (!recorded || !incoming) {
    return { action: 'reuse', reason: 'content_identity_unknown' };
  }

  return recorded === incoming
    ? { action: 'reuse', reason: 'content_unchanged' }
    : { action: 'retranscode', reason: 'content_changed' };
}

type VideoProbeInfo = {
  codec: string;      // e.g. 'hevc', 'h264'
  pixFmt: string;     // e.g. 'yuv420p', 'yuv420p10le'
  bitDepth: number;   // 8 or 10
};

/**
 * Probe the video stream to get codec, pixel format and bit depth.
 * Used to choose the correct ffmpeg parameters for the output.
 *
 * Silent version — returns defaults on any error (backward compat).
 */
// Run ffprobe via execFile (argv, NO shell) so a crafted file path can never be
// interpreted as a shell command (security-rules-hardening L12). Paths are always
// absolute temp paths, so they can't be mistaken for an ffprobe option either.
function runFfprobe(args: string[]): string {
  return child_process
    .execFileSync('ffprobe', args, { timeout: 15_000, encoding: 'utf8' })
    .trim();
}

function probeVideo(filePath: string): VideoProbeInfo {
  try {
    const output = runFfprobe([
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt',
      '-of', 'csv=p=0', filePath,
    ]);

    // output format: "codec_name,pix_fmt"
    const [codec, pixFmt] = output.split(',').map(s => s.trim().toLowerCase());
    // 10-bit pixel formats contain "10" in their name (yuv420p10le, yuv422p10le, etc.)
    const bitDepth = pixFmt?.includes('10') ? 10 : 8;
    return { codec: codec ?? '', pixFmt: pixFmt ?? 'yuv420p', bitDepth };
  } catch {
    return { codec: 'unknown', pixFmt: 'yuv420p', bitDepth: 8 };
  }
}

/**
 * Strict input probe — throws if ffprobe exits with a non-zero code or if
 * the output contains no video stream (empty / blank output).
 *
 * Distinct from `probeVideo` which silently returns defaults on error.
 * Used in `runTranscodeJob` to gate entry into the transcode pipeline per
 * Requirement 6.5.
 */
export function probeInputVideo(filePath: string): VideoProbeInfo {
  // Primary probe: stream-level codec and pixel format.
  // Uses -v quiet so ffprobe stderr doesn't pollute logs. execSync throws on
  // non-zero exit. An empty result means the codec is unidentifiable (not that
  // the file is absent), so we fall through to a container-level fallback.
  try {
    const output = runFfprobe([
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt',
      '-of', 'csv=p=0', filePath,
    ]);

    if (output) {
      // Take only the first line (guard against multi-stream output).
      const firstLine = output.split('\n')[0].trim();
      const parts = firstLine.split(',');
      const codec = (parts[0] ?? '').trim().toLowerCase();
      const pixFmt = (parts[1] ?? 'yuv420p').trim().toLowerCase() || 'yuv420p';
      const bitDepth = pixFmt.includes('10') ? 10 : 8;

      if (codec) {
        return { codec, pixFmt, bitDepth };
      }
      // Empty codec — fall through to fallback probe.
    }
  } catch {
    // execSync threw (non-zero exit or timeout) — fall through to fallback.
  }

  // Fallback probe: verify the file is a valid container (get duration).
  // If this succeeds but we still can't identify the codec, assume HEVC — the
  // conservative choice that triggers transcoding. Re-encoding an already-
  // compatible H.264 is harmless; skipping a HEVC that looks codec-free causes
  // playback failures on Android Chrome.
  try {
    const fallbackOutput = runFfprobe([
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
    ]);

    if (fallbackOutput) {
      console.warn(
        `[videoTranscoder] probeInputVideo: codec unidentifiable via stream probe, ` +
        `defaulting to hevc assumption for: ${filePath}`
      );
      return { codec: 'hevc', pixFmt: 'yuv420p', bitDepth: 8 };
    }
  } catch {
    // Fallback also failed — file is genuinely unreadable.
  }

  const err = new Error(`probeInputVideo: cannot read video stream from "${filePath}"`);
  (err as NodeJS.ErrnoException).code = 'PROBE_NO_VIDEO_STREAM';
  throw err;
}

/**
 * Verify the transcoded output file is a valid H.264/yuv420p/8-bit stream.
 * Throws if any of the following conditions are true:
 *   - ffprobe exits non-zero
 *   - No video stream found in output
 *   - codec !== 'h264'
 *   - pixFmt !== 'yuv420p'
 *   - bitDepth !== 8
 *
 * Returns { codec, pixFmt, bitDepth } on success.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */
export function verifyOutputFile(outputPath: string): VideoProbeInfo {
  // execFileSync throws by default on non-zero exit code
  const output = runFfprobe([
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt',
    '-of', 'csv=p=0', outputPath,
  ]);

  if (!output) {
    const err = new Error(`verifyOutputFile: no video stream found in "${outputPath}"`);
    (err as NodeJS.ErrnoException).code = 'VERIFY_NO_VIDEO_STREAM';
    throw err;
  }

  const [codec, pixFmt] = output.split(',').map(s => s.trim().toLowerCase());
  const bitDepth = pixFmt?.includes('10') ? 10 : 8;

  if (codec !== 'h264') {
    const err = new Error(`verifyOutputFile: expected codec h264, got "${codec}"`);
    (err as NodeJS.ErrnoException).code = 'VERIFY_WRONG_CODEC';
    throw err;
  }

  if (pixFmt !== 'yuv420p') {
    const err = new Error(`verifyOutputFile: expected pixFmt yuv420p, got "${pixFmt}"`);
    (err as NodeJS.ErrnoException).code = 'VERIFY_WRONG_PIX_FMT';
    throw err;
  }

  if (bitDepth !== 8) {
    const err = new Error(`verifyOutputFile: expected bitDepth 8, got ${bitDepth}`);
    (err as NodeJS.ErrnoException).code = 'VERIFY_WRONG_BIT_DEPTH';
    throw err;
  }

  return { codec, pixFmt, bitDepth };
}

function needsTranscoding(filePath: string, contentType: string, probe: VideoProbeInfo): boolean {
  // Always transcode these container types
  if (NEEDS_TRANSCODE_MIME.has(contentType)) return true;

  const { codec, bitDepth } = probe;

  // Unknown / empty codec — transcode to be safe rather than skipping.
  if (!codec || codec === 'unknown') return true;

  // HEVC (H.265): codec_name is always 'hevc' in ffprobe, but codec_tag_string
  // can be 'hvc1' or 'hev1'. The probeInputVideo function returns codec_name,
  // so 'hevc' is the expected value. 'hvc1'/'hev1' are kept as fallbacks in
  // case a future probe variant returns the tag string instead.
  if (
    codec === 'hevc' ||
    codec === 'hvc1' ||
    codec === 'hev1' ||
    codec.includes('hevc') ||
    codec.startsWith('hev')
  ) return true;

  // 10-bit H.264 is theoretically possible but rare and often unsupported in browsers
  if (codec === 'h264' && bitDepth > 8) return true;

  // H.264 8-bit in an mp4 container is already universally compatible
  return false;
}

/**
 * Transcode to H.264/AAC MP4 with proper handling of:
 * - 10-bit / HDR / Dolby Vision sources (convert to 8-bit SDR)
 * - 4K and higher resolution sources (scale down to 1080p max to prevent OOM on 1 GB servers)
 * - Odd video dimensions (scale to even numbers for libx264)
 * - Various pixel formats
 *
 * Preset `ultrafast` is intentional: compatibility transcoding prioritises
 * low memory footprint over encode efficiency. File size is acceptable because
 * the output is a browser-compat copy, not the primary archive.
 */
function transcodeToH264(inputPath: string, outputPath: string, probe: VideoProbeInfo): Promise<void> {
  return new Promise((resolve, reject) => {
    // Build video filter chain
    const filters: string[] = [];

    // Cap to 1080p (1920×1080) max — critical for OOM prevention on shared 1 GB machines.
    // 4K HEVC → H.264 at native resolution peaks at ~420 MB RSS, triggering the OOM killer.
    // force_original_aspect_ratio=decrease never upscales; the second scale pass ensures
    // even pixel dimensions required by libx264 after the aspect-ratio adjustment.
    filters.push(
      "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease"
    );
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    // Always force 8-bit yuv420p — handles 10-bit HDR/DV sources regardless of probe accuracy.
    filters.push('format=yuv420p');

    const vf = filters.join(',');

    const args = [
      '-i', inputPath,
      // Limit encoding threads to cap RSS on shared-CPU machines.
      // The semaphore ensures only one transcode runs at a time, but even
      // a single HEVC→H.264 job can spike to ~400 MB; capping threads
      // reduces the decoder/encoder frame buffer footprint.
      '-threads', '2',
      '-c:v', 'libx264',
      '-crf', '23',
      '-preset', 'ultrafast',
      // Use 'high' profile when input is 10-bit/HDR to avoid 'main' profile
      // not supporting bit depth conversion. 'high' is universally supported
      // on all modern Android/iOS devices and browsers.
      '-profile:v', 'high',
      '-level', '4.1',          // supports up to 1080p@30fps reliably
      '-pix_fmt', 'yuv420p',    // force 8-bit output — critical for mobile browsers
      '-maxrate', '4000k',
      '-bufsize', '8000k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',               // stereo audio (some sources have >2 channels)
      '-movflags', '+faststart', // moov atom at front for instant web playback
      '-vf', vf,
      '-map_metadata', '-1',    // strip HDR/color metadata that could confuse decoders
      '-map', '0:v:0',          // first video stream only
      '-map', '0:a:0?',         // first audio stream (optional — silent videos exist)
      '-y',
      outputPath,
    ];

    const proc = child_process.spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(-3000);
        reject(new Error(`ffmpeg exited with code ${code}:\n${stderr}`));
      }
    });
    proc.on('error', reject);
  });
}

// ─── Quota helpers ───────────────────────────────────────────────────────────

/**
 * Increment the tenant's storage usage by `incrementBytes`.
 * Pass `limitBytes = 0` to skip the limit check (no cap).
 *
 * Mirrors the implementation in app.ts but lives here so the transcoder
 * module has no circular dependency on app.ts.
 */
async function reserveTenantStorageBytes(
  db: admin.firestore.Firestore,
  tenantId: string,
  incrementBytes: number,
  limitBytes: number = 0
): Promise<void> {
  const usageRef = db.collection('tenantStorageUsage').doc(tenantId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const current = snap.exists ? (snap.data() as any)?.bytes : undefined;
    const usedBytes =
      typeof current === 'number' && Number.isFinite(current) && current >= 0
        ? current
        : 0;
    if (limitBytes > 0 && usedBytes + incrementBytes > limitBytes) {
      throw new Error(
        `tenant_storage_limit_reached: limitBytes=${limitBytes} usedBytes=${usedBytes} incrementBytes=${incrementBytes}`
      );
    }
    tx.set(
      usageRef,
      {
        tenantId,
        bytes: usedBytes + incrementBytes,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/**
 * Decrement the tenant's storage usage by `decrementBytes`.
 * Floors at 0 to prevent negative values.
 */
async function releaseTenantStorageBytes(
  db: admin.firestore.Firestore,
  tenantId: string,
  decrementBytes: number
): Promise<void> {
  if (decrementBytes <= 0) return;
  const usageRef = db.collection('tenantStorageUsage').doc(tenantId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const current = snap.exists ? (snap.data() as any)?.bytes : undefined;
    const usedBytes =
      typeof current === 'number' && Number.isFinite(current) && current >= 0
        ? current
        : 0;
    const next = Math.max(0, usedBytes - decrementBytes);
    tx.set(
      usageRef,
      {
        tenantId,
        bytes: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Delete original with retry ──────────────────────────────────────────────

/**
 * Delete the original file from Storage. On first failure, waits 5 seconds
 * and retries once. If the retry also fails, records the error in Firestore
 * and logs — the job is still considered `done` since the H.264 was uploaded.
 *
 * On success, writes `{ originalDeleted: true, originalDeletedAt }` to the
 * Firestore document (Requirements 3.1, 3.4).
 */
async function deleteOriginalWithRetry(
  bucket: ReturnType<ReturnType<typeof admin.storage>['bucket']>,
  originalPath: string,
  docId: string,
  db: admin.firestore.Firestore
): Promise<void> {
  try {
    await bucket.file(originalPath).delete();
    await db.collection(TRANSCODE_COLLECTION).doc(docId).set(
      {
        originalDeleted: true,
        originalDeletedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  } catch (err) {
    // First attempt failed — wait 5 seconds and retry once (Requirement 3.4)
    await sleep(5_000);
    try {
      await bucket.file(originalPath).delete();
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set(
        {
          originalDeleted: true,
          originalDeletedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (retryErr) {
      // Both attempts failed — record error but do NOT mark job as error
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set(
        {
          originalDeleteError: true,
          originalDeleteErrorMessage: String(retryErr),
        },
        { merge: true }
      );
      console.error(
        '[videoTranscoder] failed to delete original after retry',
        retryErr
      );
    }
  }
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────
//
// A 1 GB shared-CPU Fly.io machine cannot safely run two concurrent HEVC
// transcodes. Each ffmpeg process peaks at ~400 MB RSS; two at once = OOM.
// This semaphore queues additional jobs until the active one completes.

// Read MAX_CONCURRENT_TRANSCODES from env.
// 0 = unlimited (no throttling).
// Any positive integer = exact cap per process (default: 1 to prevent OOM on 1 GB machines).
const MAX_CONCURRENT_TRANSCODES = (() => {
  const raw = (process.env.MAX_CONCURRENT_TRANSCODES ?? '').trim();
  if (!raw) return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[videoTranscoder] MAX_CONCURRENT_TRANSCODES="${raw}" is invalid — defaulting to 1`);
    return 1;
  }
  return n === 0 ? Infinity : n; // 0 = unlimited
})();
let _activeTranscodes = 0;
const _transcodeWaitQueue: Array<() => void> = [];

function acquireTranscodeSlot(): Promise<void> {
  if (_activeTranscodes < MAX_CONCURRENT_TRANSCODES) {
    _activeTranscodes++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => _transcodeWaitQueue.push(resolve));
}

function releaseTranscodeSlot(): void {
  const next = _transcodeWaitQueue.shift();
  if (next) {
    // Hand the slot directly to the next waiter (count stays the same).
    next();
  } else {
    _activeTranscodes--;
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Whether server-side video transcoding is enabled. Controlled by the
 * VIDEO_TRANSCODE_ENABLED env flag. Defaults to enabled (backward compatible);
 * only an explicit disable value turns it off. When disabled, scheduleVideoTranscode
 * is a no-op and /video/request-transcode reports { status: 'disabled' }.
 */
export function isVideoTranscodeEnabled(): boolean {
  const raw = (process.env.VIDEO_TRANSCODE_ENABLED ?? '').trim().toLowerCase();
  if (!raw) {
    return true; // default: enabled
  }
  return !['false', '0', 'no', 'off', 'disabled'].includes(raw);
}

export function scheduleVideoTranscode(job: TranscodeJob): void {
  if (!isVideoTranscodeEnabled()) {
    console.log(
      `[videoTranscoder] transcoding disabled via VIDEO_TRANSCODE_ENABLED — skipping ${job.originalPath}`
    );
    return;
  }
  setImmediate(async () => {
    try {
      await acquireTranscodeSlot();
      console.log(
        `[videoTranscoder] slot acquired (active=${_activeTranscodes}, queued=${_transcodeWaitQueue.length}): ${job.originalPath}`
      );
      await runTranscodeJob(job);
    } catch (err) {
      console.error('[videoTranscoder] unexpected error in runTranscodeJob', err);
    } finally {
      releaseTranscodeSlot();
      console.log(
        `[videoTranscoder] slot released (active=${_activeTranscodes}, queued=${_transcodeWaitQueue.length})`
      );
    }
  });
}

/**
 * Exported so the reuse/stale guard above can be asserted directly, without the
 * `setImmediate` + semaphore indirection `scheduleVideoTranscode` adds. Production
 * callers should keep using `scheduleVideoTranscode`, which is what enforces the
 * concurrency cap.
 */
export async function runTranscodeJob(job: TranscodeJob): Promise<void> {
  const { originalPath, bucketName, originalUrl, contentType, tenantId } = job;
  const docId = sha256(originalPath);
  const db = admin.firestore();
  const bucket = admin.storage().bucket(bucketName);

  const inputTmp = path.join(os.tmpdir(), `transcode_in_${docId}${path.extname(originalPath) || '.mp4'}`);
  const outputTmp = path.join(os.tmpdir(), `transcode_out_${docId}.mp4`);

  // Guard: if a transcodedUrl already exists in the document (e.g. a prior successful
  // transcode wrote it before the original was deleted), do NOT re-transcode.
  // Just repair the status field and return — prevents 404 download attempts on the
  // already-deleted original file.
  //
  // …UNLESS the bytes at `originalPath` have changed since that transcode ran
  // (upload-idempotency follow-up F21). `docId` is `sha256(originalPath)` and the
  // upload path is deterministic per `uploadKey`, so a later upload that reuses the
  // key writes NEW bytes at the SAME path while this document still claims the work
  // is done. `decideTranscodeReuse` separates that from an ordinary same-bytes retry
  // by comparing content identity; see its doc comment for why `generation` cannot
  // serve as the discriminator and for the migration posture when no identity is
  // recorded.
  const existingSnap = await db.collection(TRANSCODE_COLLECTION).doc(docId).get();
  if (existingSnap.exists) {
    const existingData = (existingSnap.data() ?? {}) as Record<string, unknown>;
    const decision = decideTranscodeReuse(existingData, job.originalContentHash);

    if (decision.action === 'reuse') {
      console.log(
        `[videoTranscoder] already transcoded (${decision.reason}), repairing status: ${originalPath}`
      );
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
        status: 'done',
        error: admin.firestore.FieldValue.delete(),
        failedAt: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      return;
    }

    if (decision.action === 'retranscode') {
      // Stale record. Clear every field that describes the PREVIOUS video before
      // falling through to a fresh transcode, so nothing keeps serving it in the
      // meantime: `ChatCacheService` reads `transcodedUrl` with no status filter, and
      // `/video/request-transcode` returns any `transcodedUrl` it finds regardless of
      // status. Leaving them in place would keep the wrong video playing for the whole
      // re-transcode window.
      //
      // `outputFileSizeBytes` of the previous output is deliberately NOT released from
      // the tenant's quota here. The new output overwrites the old one at the same
      // deterministic `{base}_h264.mp4` path, so the reserve below double-counts it
      // until the next reconcile — an OVER-count. That is the direction this module
      // already errs in (see the reserve-before-upload ordering below): an over-count
      // is a reporting blemish the reconciler clears, whereas releasing bytes for an
      // object that still exists would under-count if this transcode then failed.
      console.warn(
        `[videoTranscoder] stale transcode record for ${originalPath} — original bytes changed since the recorded transcode; re-transcoding`
      );
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
        transcodedUrl: admin.firestore.FieldValue.delete(),
        transcodedPath: admin.firestore.FieldValue.delete(),
        originalDeleted: admin.firestore.FieldValue.delete(),
        originalDeletedAt: admin.firestore.FieldValue.delete(),
        originalDeleteError: admin.firestore.FieldValue.delete(),
        originalDeleteErrorMessage: admin.firestore.FieldValue.delete(),
        outputCodec: admin.firestore.FieldValue.delete(),
        outputPixFmt: admin.firestore.FieldValue.delete(),
        outputFileSizeBytes: admin.firestore.FieldValue.delete(),
        quotaDecrementError: admin.firestore.FieldValue.delete(),
        completedAt: admin.firestore.FieldValue.delete(),
      }, { merge: true });
    }
  }

  await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
    originalPath, originalUrl, tenantId, status: 'processing',
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    // Recorded at the START of the job, not the end: this is the identity of the
    // bytes this job is about to transcode, and it is what the NEXT job compares
    // against. Written only when the scheduler supplied one — `merge: true` plus a
    // conditional spread leaves any previously recorded identity intact rather than
    // erasing it, which is what keeps a later `/video/request-transcode` re-run from
    // wiping the protection off an existing document.
    ...(job.originalContentHash ? { originalContentHash: job.originalContentHash } : {}),
  }, { merge: true });

  try {
    console.log(`[videoTranscoder] starting transcode: ${originalPath}`);

    await bucket.file(originalPath).download({ destination: inputTmp });
    console.log(`[videoTranscoder] downloaded ${originalPath}`);

    // Capture original file size before any processing (used for quota decrement later)
    const originalFileSizeBytes = fs.statSync(inputTmp).size;

    // Strict input probe — aborts job if ffprobe exits non-zero or finds no video stream.
    // Requirement 6.5: probe failure → status: 'error', error: 'probe_failed'.
    // The returned probe info is reused below for needsTranscoding / transcodeToH264,
    // so we do NOT call the silent probeVideo afterwards.
    let probe: VideoProbeInfo;
    try {
      probe = probeInputVideo(inputTmp);
    } catch (probeErr) {
      console.error(`[videoTranscoder] input probe failed for ${originalPath}`, probeErr);
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
        status: 'error',
        error: 'probe_failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    console.log(`[videoTranscoder] probe: codec=${probe.codec} pixFmt=${probe.pixFmt} bitDepth=${probe.bitDepth}`);

    if (!needsTranscoding(inputTmp, contentType, probe)) {
      console.log(`[videoTranscoder] ${originalPath} is already compatible — skipping`);
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
        status: 'skipped', transcodedUrl: originalUrl,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    await transcodeToH264(inputTmp, outputTmp, probe);
    console.log(`[videoTranscoder] transcode complete: ${originalPath}`);

    // Requirement 6.3: check output file size — < 1024 bytes is treated as a verification failure
    const outputStat = fs.statSync(outputTmp);
    const outputFileSizeBytes = outputStat.size;
    if (outputFileSizeBytes < 1024) {
      console.error(`[videoTranscoder] output file too small (${outputFileSizeBytes} bytes) for ${originalPath}`);
      try { fs.unlinkSync(outputTmp); } catch { /* ignore */ }
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
        status: 'error',
        error: 'output_verification_failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    // Requirement 6.1, 6.2, 6.4: verify output is a valid H.264/yuv420p/8-bit stream
    let outputProbe: VideoProbeInfo;
    try {
      outputProbe = verifyOutputFile(outputTmp);
    } catch (verifyErr) {
      console.error(`[videoTranscoder] output verification failed for ${originalPath}`, verifyErr);
      try { fs.unlinkSync(outputTmp); } catch { /* ignore */ }
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
        status: 'error',
        error: 'output_verification_failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    // Requirement 6.3: write output metadata to Firestore before uploading
    await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
      outputCodec: outputProbe.codec,
      outputPixFmt: outputProbe.pixFmt,
      outputFileSizeBytes,
    }, { merge: true });

    const transcodedPath = buildTranscodeStoragePath(originalPath);
    const downloadToken = (crypto as any).randomUUID?.() ?? crypto.randomBytes(16).toString('hex');

    // Requirement 3.3: increment quota for H.264 output BEFORE uploading.
    // This ensures quota never falls below true usage at any moment.
    await reserveTenantStorageBytes(db, tenantId, outputFileSizeBytes);

    // Stream directly from disk to Cloud Storage — avoids loading the entire
    // encoded file into the Node.js heap as a Buffer (was ~5–50 MB per job).
    await bucket.file(transcodedPath).save(fs.createReadStream(outputTmp), {
      resumable: false, contentType: 'video/mp4',
      metadata: { metadata: { firebaseStorageDownloadTokens: downloadToken } },
    });
    const transcodedUrl = buildDownloadUrl(bucketName, transcodedPath, downloadToken);
    console.log(`[videoTranscoder] uploaded: ${transcodedPath}`);

    // Requirement 3.1, 3.4: delete original file (with one retry on failure).
    // Also writes originalDeleted + originalDeletedAt to the Firestore doc on success.
    await deleteOriginalWithRetry(bucket, originalPath, docId, db);

    // Requirement 3.2, 3.3: decrement quota by original file size after deletion.
    // If this fails, record the discrepancy for manual reconciliation — job is still done.
    try {
      await releaseTenantStorageBytes(db, tenantId, originalFileSizeBytes);
    } catch (decrementErr) {
      console.error(
        `[videoTranscoder] quota decrement failed for ${originalPath} (tenantId=${tenantId}, bytes=${originalFileSizeBytes})`,
        decrementErr
      );
      await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
        quotaDecrementError: String(decrementErr),
      }, { merge: true }).catch(() => undefined);
    }

    await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
      originalPath, originalUrl, transcodedPath, transcodedUrl,
      status: 'done',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Clear any error/failedAt fields left over from a previous failed attempt.
      error: admin.firestore.FieldValue.delete(),
      failedAt: admin.firestore.FieldValue.delete(),
    }, { merge: true });

    // Write transcodedUrl back to the RTDB chat message (best-effort).
    // The chatMessageWriter recorded the RTDB path when the message was sent.
    // By the time transcoding completes, the message always exists.
    try {
      const rtdbInfoSnap = await db.collection(TRANSCODE_COLLECTION).doc(docId).get();
      const rtdbInfo = rtdbInfoSnap.data() as Record<string, any>;
      const rTenantId = typeof rtdbInfo?.rtdbTenantId === 'string' ? rtdbInfo.rtdbTenantId : null;
      const rConvKey = typeof rtdbInfo?.rtdbConversationKey === 'string' ? rtdbInfo.rtdbConversationKey : null;
      const rMsgId = typeof rtdbInfo?.rtdbMessageId === 'string' ? rtdbInfo.rtdbMessageId : null;
      const rAttIdx = typeof rtdbInfo?.rtdbAttachmentIndex === 'number' ? rtdbInfo.rtdbAttachmentIndex : null;

      if (rTenantId && rConvKey && rMsgId && rAttIdx !== null) {
        const rtdb = admin.database();
        // rAttIdx >= 0: attachment in the attachments[] array
        // rAttIdx === -1: single-file message — write to the message root
        const basePath = rAttIdx >= 0
          ? `tenantChat/${rTenantId}/conversationMessages/${rConvKey}/${rMsgId}/attachments/${rAttIdx}`
          : `tenantChat/${rTenantId}/conversationMessages/${rConvKey}/${rMsgId}`;
        const attachPath = `${basePath}/transcodedUrl`;

        // Attempt the write with one retry on transient failure.
        const writeWithRetry = async () => {
          try {
            await rtdb.ref(attachPath).set(transcodedUrl);
          } catch (firstErr) {
            await sleep(3_000);
            await rtdb.ref(attachPath).set(transcodedUrl); // throws on second failure
          }
        };

        await writeWithRetry();
        console.log(`[videoTranscoder] wrote transcodedUrl to RTDB ${rMsgId}[${rAttIdx >= 0 ? rAttIdx : 'root'}]`);

        // If the original was successfully deleted, overwrite the primary `url` field so
        // that every client reading attachment.url receives the H.264 copy rather than the
        // deleted original. rtdbInfo was read after the status:'done' write so it already
        // contains originalDeleted (set by deleteOriginalWithRetry at step 11).
        // Skip the overwrite when originalDeleteError is set — the original still exists.
        const originalSuccessfullyDeleted =
          rtdbInfo.originalDeleted === true && !rtdbInfo.originalDeleteError;

        if (originalSuccessfullyDeleted) {
          // Write url overwrite with one retry. Non-fatal on failure — the existing
          // transcodedUrl field and frontend guards provide defense-in-depth.
          const overwriteUrlWithRetry = async () => {
            try {
              await rtdb.ref(`${basePath}/url`).set(transcodedUrl);
              await rtdb.ref(`${basePath}/originalReplaced`).set(true);
            } catch (firstErr) {
              await sleep(3_000);
              await rtdb.ref(`${basePath}/url`).set(transcodedUrl);
              await rtdb.ref(`${basePath}/originalReplaced`).set(true); // throws on second failure
            }
          };
          await overwriteUrlWithRetry();
          console.log(
            `[videoTranscoder] overwrote canonical url in RTDB ${rMsgId}[${rAttIdx >= 0 ? rAttIdx : 'root'}]`
          );
        }
      }
    } catch (rtdbErr) {
      // Non-fatal — clients fall back to the Firestore videoTranscodes lookup.
      console.warn('[videoTranscoder] failed to write transcodedUrl to RTDB after retry', rtdbErr);
    }

    console.log(`[videoTranscoder] done: ${originalPath} → ${transcodedUrl}`);
  } catch (err) {
    console.error(`[videoTranscoder] transcode failed for ${originalPath}`, err);
    await db.collection(TRANSCODE_COLLECTION).doc(docId).set({
      originalPath, originalUrl, status: 'error',
      error: String(err),
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => undefined);
  } finally {
    for (const f of [inputTmp, outputTmp]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

export function transcodeDocId(storagePath: string): string {
  return sha256(storagePath);
}
