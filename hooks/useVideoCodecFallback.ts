// Feature: video-transcoding-compatibility

import { useState, useEffect, useRef, useCallback } from 'react';
import { collection, query, where, limit, onSnapshot } from 'firebase/firestore';
import { Platform } from 'react-native';

import { firestore } from '@/config/firebase';
import { canPlayCodec } from '@/utils/codecDetector';
import { isVideoTranscodeEnabled } from '@/lib/videoTranscodeConfig';
import { logger } from '@/lib/logger';
import { runtimeEndpoints } from '@/services/runtimeEndpoints';
import { internalTokenManager } from '@/services/internalTokenManager';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Represents the current phase of the codec-fallback state machine.
 *
 * idle       → initial state; codec check has not run yet
 * checking   → proactive: evaluating canPlayCodec before load
 * swapping   → transcodedUri is available; swapping source to H.264
 * requesting → calling POST /video/request-transcode (no transcodedUri available)
 * polling    → waiting for Firestore videoTranscodes status: 'done'
 * done       → swap completed successfully
 * timeout    → 60s elapsed without a 'done' document arriving
 * error      → the transcoded URL also failed (Requirement 1.7), or transcoding
 *              is disabled and the browser reported it cannot decode the source
 *
 * Note: an unsupported codec detected on mount does NOT reach 'error'. See the
 * mount effect below — capability detection is advisory, so the hook stays
 * 'idle' and waits for a real UnsupportedCodecError from the <video> element.
 */
export type FallbackPhase =
  | 'idle'
  | 'checking'
  | 'swapping'
  | 'requesting'
  | 'polling'
  | 'done'
  | 'timeout'
  | 'error';

export interface UseVideoCodecFallbackOptions {
  /** The original video URI (H.265/HEVC source). */
  uri: string;
  /** Pre-resolved H.264 URL, if the server already has a transcoded copy. */
  transcodedUri?: string;
  /** Tenant identifier required for on-demand transcode requests. */
  tenantId: string;
  /**
   * Called when the hook has resolved a playable URI.
   * @param resolvedUri  The H.264 URL to load.
   * @param seekTo       The playback position (in seconds) to seek to after load.
   */
  onSourceResolved: (resolvedUri: string, seekTo: number) => void;
  /** Called to show or hide a spinner overlay. */
  onSpinnerChange: (visible: boolean) => void;
  /** Called when the fallback reaches a permanent error state. */
  onPermanentError: (message: string) => void;
  /** Called when the 60-second polling timeout expires. */
  onTimeoutError: () => void;
}

// ─── Firestore collection ─────────────────────────────────────────────────────

const VIDEO_TRANSCODES_COLLECTION = 'videoTranscodes';
/**
 * Hard cap on a single polling session, fixed by requirements — do not change
 * this without changing requirements.md first.
 *
 * Requirement 1.2: "poll the `videoTranscodes` Firestore collection at
 *   3-second intervals for up to 60 seconds".
 * Requirement 1.5: "WHEN an active polling session reaches the 60-second
 *   timeout ... render a retry button that ... starts a new 60-second polling
 *   session from the beginning".
 *
 * This was previously 120_000 to give slow single-CPU transcodes more headroom.
 * That drifted from both criteria above; the retry button (Requirement 1.5) is
 * the sanctioned way to grant a slow job more time, not a longer first session.
 */
const POLL_TIMEOUT_MS = 60_000;

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Orchestrates the full H.264 fallback flow on web.
 *
 * Phase transitions:
 *   idle
 *     → (mount, canPlayCodec('h265') === false, transcodedUri present) → swapping → done
 *     → (mount, canPlayCodec('h265') === false, no transcodedUri) → idle (stays put;
 *        the reactive onCodecError path below drives any transition)
 *     → (onCodecError, transcodedUri present) → swapping → done
 *     → (onCodecError, no transcodedUri) → requesting → polling → done | timeout
 *     → (timeout, retry()) → polling (fresh 60s)
 *     → (onSwapTargetError) → error
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */
export function useVideoCodecFallback(options: UseVideoCodecFallbackOptions): {
  phase: FallbackPhase;
  /** Call when useWebVideoPlayer reports UnsupportedCodecError. */
  onCodecError: (currentTimeAtError: number) => void;
  /** Call when the swap-target source also fails to play. */
  onSwapTargetError: () => void;
  /** Start a fresh 60-second polling session (used by the retry button). */
  retry: () => void;
  /** The resolved source URI to pass to useWebVideoPlayer. */
  activeUri: string;
} {
  const {
    uri,
    transcodedUri,
    tenantId,
    onSourceResolved,
    onSpinnerChange,
    onPermanentError,
    onTimeoutError,
  } = options;

  const [phase, setPhase] = useState<FallbackPhase>('idle');
  // Start empty — not uri. VideoPlayerLoaded's useEffect([codecActiveUri]) would
  // immediately call setWebResolvedUri(uri) if this started as uri, bypassing the
  // empty-string guard that prevents HEAD requests to deleted H.265 originals.
  // activeUri is populated only when performSwap resolves a real playable URL.
  const [activeUri, setActiveUri] = useState<string>('');

  // Keep stable refs for callbacks so closures inside effects stay current.
  const onSourceResolvedRef = useRef(onSourceResolved);
  const onSpinnerChangeRef = useRef(onSpinnerChange);
  const onPermanentErrorRef = useRef(onPermanentError);
  const onTimeoutErrorRef = useRef(onTimeoutError);

  useEffect(() => { onSourceResolvedRef.current = onSourceResolved; }, [onSourceResolved]);
  useEffect(() => { onSpinnerChangeRef.current = onSpinnerChange; }, [onSpinnerChange]);
  useEffect(() => { onPermanentErrorRef.current = onPermanentError; }, [onPermanentError]);
  useEffect(() => { onTimeoutErrorRef.current = onTimeoutError; }, [onTimeoutError]);

  // Stable ref for the playback position recorded at the moment of the codec error.
  const recordedCurrentTimeRef = useRef<number>(0);

  // Stable ref used to cancel the Firestore listener and timeout from within effects.
  const pollingCleanupRef = useRef<(() => void) | null>(null);
  const timeoutHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Set to true when the backend tells us VIDEO_TRANSCODE_ENABLED=false.
  // Prevents re-requesting a transcode after the first disabled response
  // and routes the subsequent codec error to the permanent-error path.
  const transcodeKnownDisabledRef = useRef(false);

  // ── Helper: swap to transcodedUri immediately ────────────────────────────

  const performSwap = useCallback(
    (resolvedUrl: string, seekTo: number) => {
      setPhase('swapping');
      setActiveUri(resolvedUrl);
      // onSourceResolved triggers the caller to update useWebVideoPlayer's resolvedUri.
      onSourceResolvedRef.current(resolvedUrl, seekTo);
      setPhase('done');
      onSpinnerChangeRef.current(false);
    },
    [],
  );

  // ── Helper: cancel any active poll ───────────────────────────────────────

  const cancelPolling = useCallback(() => {
    if (timeoutHandleRef.current !== null) {
      clearTimeout(timeoutHandleRef.current);
      timeoutHandleRef.current = null;
    }
    if (pollingCleanupRef.current) {
      pollingCleanupRef.current();
      pollingCleanupRef.current = null;
    }
  }, []);

  // ── Helper: start Firestore polling ──────────────────────────────────────

  const startPolling = useCallback(
    (seekTo: number) => {
      cancelPolling();
      setPhase('polling');
      onSpinnerChangeRef.current(true);

      const q = query(
        collection(firestore, VIDEO_TRANSCODES_COLLECTION),
        where('originalUrl', '==', uri),
        limit(1),
      );

      // Note on Requirement 1.2's "3-second intervals": there is no interval
      // constant here by design. This uses a Firestore realtime listener
      // (onSnapshot) instead of a fixed-cadence re-query, so updates arrive as
      // soon as the document changes — never later than a 3-second poll would
      // have delivered them. Only the 60-second cap below is a real constant.

      // 60-second hard timeout (Requirement 1.2 / 1.5 — see POLL_TIMEOUT_MS).
      const timeoutHandle = setTimeout(() => {
        cancelPolling();
        setPhase('timeout');
        onSpinnerChangeRef.current(false);
        onTimeoutErrorRef.current();
        logger.warn?.('[useVideoCodecFallback] polling timed out after 60s', { uri });
      }, POLL_TIMEOUT_MS);

      timeoutHandleRef.current = timeoutHandle;

      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          if (snapshot.empty) {
            return; // Still waiting.
          }
          const doc = snapshot.docs[0];
          const data = doc.data();
          // Act on transcodedUrl presence regardless of status field.
          // The status field can be 'error' (stale from a failed retry of the
          // already-deleted original) while transcodedUrl is valid and playable.
          if (typeof data?.transcodedUrl === 'string' && data.transcodedUrl.length > 0) {
            cancelPolling();
            performSwap(data.transcodedUrl, seekTo);
          }
          // No transcodedUrl yet — keep waiting until timeout.
        },
        (err) => {
          logger.warn?.('[useVideoCodecFallback] Firestore snapshot error', err);
          // Don't cancel — keep the timeout running so the user sees the timeout message.
        },
      );

      pollingCleanupRef.current = () => {
        clearTimeout(timeoutHandle);
        unsubscribe();
      };
    },
    [uri, cancelPolling, performSwap],
  );

  // ── Helper: call POST /video/request-transcode ────────────────────────────

  const requestTranscode = useCallback(
    async (seekTo: number) => {
      setPhase('requesting');
      onSpinnerChangeRef.current(true);

      try {
        const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
        if (!baseUrl) {
          throw new Error('Backend URL not configured');
        }

        const token = await internalTokenManager.getToken(baseUrl);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(`${baseUrl}/video/request-transcode`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ originalUrl: uri, tenantId }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          logger.warn?.('[useVideoCodecFallback] request-transcode HTTP error', {
            status: response.status,
            body: text.slice(0, 200),
          });
          throw new Error(`request-transcode failed: ${response.status}`);
        }

        const data: { status: string; transcodedUrl?: string } = await response.json();

        // Backend transcoding is disabled (VIDEO_TRANSCODE_ENABLED=false).
        // Don't error immediately — the browser may be able to decode the original
        // directly (e.g. Chrome on macOS 13+ plays H.265 via VideoToolbox even
        // though canPlayType incorrectly reports "" for hvc1).
        // Mark the disabled state and load the original URI. If the browser truly
        // cannot decode it, useWebVideoPlayer fires onUnsupportedCodec →
        // handleCodecError → onCodecError hits the transcodeKnownDisabledRef guard
        // and shows the permanent error then.
        if (data.status === 'disabled') {
          transcodeKnownDisabledRef.current = true;
          onSpinnerChangeRef.current(false);
          setPhase('idle');
          setActiveUri(uri);
          onSourceResolvedRef.current(uri, seekTo);
          return;
        }

        // Short-circuit: server says job is already done.
        if (data.status === 'done' && typeof data.transcodedUrl === 'string') {
          onSpinnerChangeRef.current(false);
          performSwap(data.transcodedUrl, seekTo);
          return;
        }

        // Job is processing (or freshly scheduled) — start polling.
        startPolling(seekTo);
      } catch (err) {
        logger.warn?.('[useVideoCodecFallback] request-transcode network error', err);
        onSpinnerChangeRef.current(false);
        setPhase('error');
        onPermanentErrorRef.current('Video playback failed. Try downloading the file.');
      }
    },
    [uri, tenantId, performSwap, startPolling],
  );

  // ── Proactive codec check on mount (web only) ─────────────────────────────

  useEffect(() => {
    // Only run on web; on native the fallback is never triggered (Requirement 1.8).
    if (Platform.OS !== 'web') {
      return;
    }

    setPhase('checking');

    const h265Supported = canPlayCodec('h265');

    if (h265Supported) {
      // Browser can decode H.265; no action needed.
      setPhase('idle');
      return;
    }

    // H.265 is not supported.
    const effectiveTranscodedUri =
      typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
        ? transcodedUri.trim()
        : undefined;

    if (effectiveTranscodedUri) {
      // Proactive swap: load the H.264 version directly (Requirement 5.4).
      performSwap(effectiveTranscodedUri, 0);
    } else {
      // canPlayType returned "" but this does NOT mean the browser definitely
      // cannot decode H.265. Chrome 107+ on macOS 13+ decodes H.265 via
      // VideoToolbox but canPlayType incorrectly reports "" for hvc1.
      // Stay idle and let the <video> element try to load the original URI.
      // If it truly cannot decode it, useWebVideoPlayer fires onUnsupportedCodec
      // which calls onCodecError → requestTranscode → polling (reactive path).
      setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty — runs once on mount only.

  // ── Cleanup polling on unmount ────────────────────────────────────────────

  useEffect(() => {
    return () => {
      cancelPolling();
    };
  }, [cancelPolling]);

  // ─── Public handlers ───────────────────────────────────────────────────────

  /**
   * Called by useWebVideoPlayer when it detects an UnsupportedCodecError.
   * Requirement 1.8: only responds on web (native should never call this, but guard anyway).
   */
  const onCodecError = useCallback(
    (currentTimeAtError: number) => {
      if (Platform.OS !== 'web') {
        return;
      }

      recordedCurrentTimeRef.current = currentTimeAtError;

      const effectiveTranscodedUri =
        typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
          ? transcodedUri.trim()
          : undefined;

      if (effectiveTranscodedUri) {
        // Requirement 1.1: swap immediately to the pre-resolved H.264 URI.
        performSwap(effectiveTranscodedUri, currentTimeAtError);
      } else if (!isVideoTranscodeEnabled() || transcodeKnownDisabledRef.current) {
        // Transcoding is disabled (client-side flag) OR the backend already told us
        // it's disabled. The browser truly cannot decode this format.
        cancelPolling();
        setPhase('error');
        onSpinnerChangeRef.current(false);
        onPermanentErrorRef.current("This video format can't be played in this browser.");
      } else {
        // Requirement 1.3: request on-demand transcoding, then poll.
        void requestTranscode(currentTimeAtError);
      }
    },
    [transcodedUri, performSwap, requestTranscode, cancelPolling],
  );

  /**
   * Called when the swap-target source (transcodedUri) also fails to play.
   * Requirement 1.7: transition to error phase with a permanent error message.
   */
  const onSwapTargetError = useCallback(() => {
    cancelPolling();
    setPhase('error');
    onSpinnerChangeRef.current(false);
    onPermanentErrorRef.current('Video playback failed. Try downloading the file.');
  }, [cancelPolling]);

  /**
   * Re-requests the transcode status from the backend and either swaps
   * immediately (if already done) or starts a fresh polling session.
   * Using requestTranscode instead of startPolling gives instant feedback:
   * the backend now returns the existing transcodedUrl even when
   * status is stale 'error'.
   */
  const retry = useCallback(() => {
    void requestTranscode(recordedCurrentTimeRef.current);
  }, [requestTranscode]);

  return {
    phase,
    onCodecError,
    onSwapTargetError,
    retry,
    activeUri,
  };
}
