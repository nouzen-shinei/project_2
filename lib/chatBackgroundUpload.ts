import { Platform } from 'react-native';
import { logger } from '@/lib/logger';

/**
 * Chat background upload transport (Phase 2 — kill-safe uploads).
 *
 * Wraps `rn-background-upload` (a New-Architecture TurboModule) to upload a staged
 * media file to the backend `/storage/upload` endpoint with `createMessage=1`, so
 * the transfer continues — and the chat message is created server-side — even if
 * the app is backgrounded or killed mid-upload. The optimistic bubble + durable
 * outbox from Phase 1 remain the safety net: if the app dies before completion the
 * message is still created server-side (idempotent by `clientMsgId`), and if that
 * server-side create fails the outbox re-drives it (also idempotent) on next launch.
 *
 * Fully guarded: native-only, behind the `EXPO_PUBLIC_ENABLE_BG_UPLOAD` flag, and a
 * missing/older native binary degrades to `isBackgroundUploadEnabled() === false`
 * so callers transparently fall back to the foreground upload path.
 */

export type BackgroundUploadMediaKind = 'sticker' | 'gif' | 'attachment';

// Optional native dependency, resolved through a guarded require so type-checking
// and the web bundle never depend on it.
let BgUpload: any = null;
try {
  if (Platform.OS !== 'web') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BgUpload = require('rn-background-upload');
  }
} catch {
  BgUpload = null;
}

const FLAG_ENABLED = process.env.EXPO_PUBLIC_ENABLE_BG_UPLOAD === 'true';

// Serialize native `startUpload` calls. gotev's UploadService starts a foreground
// service; on Android 12+ firing several starts in a tight burst (rapid sticker
// sends) races the service's teardown/startForeground and can trip
// ForegroundServiceStartNotAllowedException. Chaining the start calls one-at-a-time
// (each waits for the previous to settle, plus a short gap) keeps the service in a
// single, well-defined start state. This only serializes the brief START handshake,
// not the transfers themselves — gotev still uploads them concurrently once queued.
let bgStartChain: Promise<void> = Promise.resolve();
const BG_START_GAP_MS = 350;

function enqueueSerializedStart<T>(startFn: () => Promise<T>): Promise<T> {
  const run = bgStartChain.then(startFn);
  // Advance the chain regardless of success/failure, with a small settle gap so
  // the previous foreground-service start fully lands before the next begins.
  bgStartChain = run.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, BG_START_GAP_MS)),
    () => new Promise<void>((resolve) => setTimeout(resolve, BG_START_GAP_MS))
  );
  return run;
}

/** True when background upload is available: native + flag on + module present. */
export function isBackgroundUploadEnabled(): boolean {
  return (
    FLAG_ENABLED &&
    Platform.OS !== 'web' &&
    !!BgUpload &&
    typeof BgUpload.startUpload === 'function'
  );
}

export interface BackgroundUploadDiagnostics {
  /** Runtime value of `EXPO_PUBLIC_ENABLE_BG_UPLOAD` (what Metro inlined at build). */
  flagRaw: string | undefined;
  /** Whether the flag string equalled `'true'`. */
  flagEnabled: boolean;
  platform: string;
  /** The native module was resolvable via require (else the require threw/absent). */
  moduleLoaded: boolean;
  /** The module exposes a callable `startUpload` (a well-formed native binary). */
  hasStartUpload: boolean;
  /** Final gate — the value `isBackgroundUploadEnabled()` returns. */
  enabled: boolean;
}

/**
 * Report exactly why background upload is (or isn't) active. Surfaced on-device via
 * `logger.warn` before the send branch so a build where the flag wasn't inlined, or
 * where the native module failed to load, is diagnosable without a debugger/logcat.
 */
export function backgroundUploadDiagnostics(): BackgroundUploadDiagnostics {
  return {
    flagRaw: process.env.EXPO_PUBLIC_ENABLE_BG_UPLOAD,
    flagEnabled: FLAG_ENABLED,
    platform: Platform.OS,
    moduleLoaded: !!BgUpload,
    hasStartUpload: !!BgUpload && typeof BgUpload.startUpload === 'function',
    enabled: isBackgroundUploadEnabled(),
  };
}

export interface BackgroundUploadUrlParams {
  tenantId: string;
  conversationFolder: string;
  fileName: string;
  clientMsgId: string;
  recipientId: string;
  mediaKind: BackgroundUploadMediaKind;
  text?: string;
  /**
   * Optional idempotency key (see `lib/uploadKey.ts`). It matters most on THIS
   * transport: the native uploader (`rn-background-upload` / gotev) runs its own
   * internal retries entirely outside JS control, so we cannot mint or reuse a key
   * per attempt the way the foreground loops do — whatever URL we hand the native
   * layer is the URL every one of its retries replays. Without a stable `uploadKey`
   * the server derives a fresh timestamped path per attempt, so each internal retry
   * stores a separate object: the single largest source of duplicate objects in the
   * app. With it, the server resolves one deterministic path and the retries
   * overwrite instead of accumulating. Derived from the `clientMsgId`, which is
   * already stable for the whole send.
   */
  uploadKey?: string;
  /**
   * Optional human-visible name for the upload, split out of `fileName`.
   *
   * `fileName` becomes the `filename` query param, which seeds the deterministic
   * object path — so on this transport it has to be a value that is IDENTICAL on
   * every attempt (derived from the send's `clientMsgId`), not the OS-supplied
   * name. The backend used to reuse that same param as the display name of the
   * chat message it creates and of the `sharedFiles` doc, so `displayName` carries
   * the real name the user picked and the backend prefers it for every
   * user-visible label. Omitted ⇒ the backend falls back to `filename`, exactly as
   * before this parameter existed.
   */
  displayName?: string;
}

/**
 * Build the `/storage/upload` URL (with the Phase-2 `createMessage` params) that
 * the backend understands. Pure + exported so the query-param contract with the
 * server route is unit-tested without any native/auth dependency.
 *
 * `uploadKey` and `displayName` are appended only when present, so a caller that
 * supplies neither produces a byte-identical URL to before those parameters
 * existed.
 */
export function buildBackgroundUploadUrl(baseUrl: string, params: BackgroundUploadUrlParams): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/storage/upload`);
  url.searchParams.set('tenantId', params.tenantId);
  url.searchParams.set('purpose', 'chat');
  url.searchParams.set('conversationFolder', params.conversationFolder);
  url.searchParams.set('filename', params.fileName);
  url.searchParams.set('createMessage', '1');
  url.searchParams.set('clientMsgId', params.clientMsgId);
  url.searchParams.set('recipientId', params.recipientId);
  url.searchParams.set('mediaKind', params.mediaKind);
  if (params.text) {
    url.searchParams.set('messageText', params.text);
  }
  if (params.uploadKey) {
    url.searchParams.set('uploadKey', params.uploadKey);
  }
  if (params.displayName) {
    url.searchParams.set('displayName', params.displayName);
  }
  return url.toString();
}

export interface BackgroundUploadHandlers {
  onProgress?: (progressPercent: number) => void;
  onCompleted?: (event: { responseCode: number; responseBody: string }) => void;
  onError?: (event: { error: string }) => void;
  onCancelled?: () => void;
}

export interface StartBackgroundUploadArgs {
  /** Stable id used as the native customUploadId + for event filtering (= pending tempId). */
  uploadId: string;
  /** Staged local file uri/path (a `file://` prefix is stripped for the native layer). */
  filePath: string;
  url: string;
  headers: Record<string, string>;
  handlers?: BackgroundUploadHandlers;
}

/**
 * Start a background upload. Returns the uploadId + an `unsubscribe` that detaches
 * the event listeners (call it once the upload reaches a terminal state). Rejects
 * if background upload isn't enabled/available — callers should fall back.
 */
export async function startChatBackgroundUpload(
  args: StartBackgroundUploadArgs
): Promise<{ uploadId: string; unsubscribe: () => void }> {
  if (!isBackgroundUploadEnabled()) {
    throw new Error('background_upload_unavailable');
  }
  const { uploadId, handlers } = args;
  const path = args.filePath.startsWith('file://')
    ? args.filePath.replace(/^file:\/\//, '')
    : args.filePath;

  const subscriptions: Array<{ remove: () => void }> = [];
  const track = (sub: unknown) => {
    if (sub && typeof (sub as { remove?: unknown }).remove === 'function') {
      subscriptions.push(sub as { remove: () => void });
    }
  };
  const unsubscribe = () => {
    subscriptions.forEach((sub) => {
      try {
        sub.remove();
      } catch {
        // best-effort
      }
    });
    subscriptions.length = 0;
  };

  if (handlers?.onProgress) {
    track(
      BgUpload.onProgress((event: any) => {
        if (event?.uploadId === uploadId || event?.id === uploadId) {
          handlers.onProgress!(Number(event?.progress) || 0);
        }
      })
    );
  }
  if (handlers?.onCompleted) {
    track(
      BgUpload.onCompleted((event: any) => {
        if (event?.id === uploadId) {
          handlers.onCompleted!({
            responseCode: Number(event?.responseCode) || 0,
            responseBody: String(event?.responseBody || ''),
          });
        }
      })
    );
  }
  if (handlers?.onError) {
    track(
      BgUpload.onError((event: any) => {
        if (event?.id === uploadId) {
          handlers.onError!({ error: String(event?.error || 'upload_error') });
        }
      })
    );
  }
  if (handlers?.onCancelled) {
    track(
      BgUpload.onCancelled((event: any) => {
        if (event?.id === uploadId) {
          handlers.onCancelled!();
        }
      })
    );
  }

  try {
    await enqueueSerializedStart(() =>
      BgUpload.startUpload({
        url: args.url,
        path,
        method: 'POST',
        type: 'raw',
        customUploadId: uploadId,
        headers: args.headers,
        notification: { enabled: true },
      })
    );
    return { uploadId, unsubscribe };
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

/** Cancel an in-flight background upload (best-effort; no-op when unavailable). */
export async function cancelChatBackgroundUpload(uploadId: string): Promise<void> {
  if (!isBackgroundUploadEnabled()) {
    return;
  }
  try {
    await BgUpload.cancelUpload(uploadId);
  } catch (error) {
    logger.warn('[chatBackgroundUpload] cancel failed', error);
  }
}
