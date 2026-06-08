/**
 * CameraCapture.web.tsx
 *
 * Professional browser camera UI — photo capture, video recording,
 * file-picker fallback. Camera restarts automatically when the user
 * cancels out of the OS file picker without selecting anything.
 */

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { useWebCamera } from '@/hooks/useWebCamera';
import { useRecordingTimer } from '@/hooks/useRecordingTimer';
import { logger } from '@/lib/logger';
import type { CameraCaptureProps } from '@/types/camera';

// ── Keyframes + interaction styles injected once ──────────────────────────
const STYLE_ID = 'cc-web-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes cc-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.7)} }
    @keyframes cc-flash { 0%{opacity:.85} 100%{opacity:0} }
    @keyframes cc-sup   { from{transform:translateY(100%);opacity:0} to{transform:translateY(0);opacity:1} }
    @keyframes cc-fin   { from{opacity:0} to{opacity:1} }
    .cc-btn:focus-visible           { outline: 2px solid #fff; outline-offset: 2px; }
    .cc-btn:active                  { transform: scale(0.92) !important; }
    .cc-pill:hover                  { background: rgba(255,255,255,0.26) !important; }
    .cc-shutter:hover:not(:disabled){ transform: scale(1.06); }
    .cc-record:hover:not(:disabled) { transform: scale(1.06); }
    .cc-side-btn:hover              { background: rgba(255,255,255,0.24) !important; }
  `;
  document.head.appendChild(s);
}

const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

function isMobile() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= 640;
}

// ── Frosted pill button (top-bar controls) ────────────────────────────────
function PillBtn({
  label, onClick, children, size = 44, disabled = false,
}: { label: string; onClick: () => void; children: React.ReactNode; size?: number; disabled?: boolean }) {
  return (
    <button
      className="cc-btn cc-pill"
      type="button"
      aria-label={label}
      tabIndex={0}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault(); e.stopPropagation(); onClick();
        }
      }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: size / 2,
        background: 'rgba(255,255,255,0.18)',
        border: '1.5px solid rgba(255,255,255,0.38)',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: '#fff', padding: 0,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        transition: 'background .15s, transform .1s',
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0, position: 'relative', zIndex: 2,
      }}
    >
      {children}
    </button>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────
const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
    <path d="M1.5 1.5L13.5 13.5M13.5 1.5L1.5 13.5" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
  </svg>
);

// Flip-camera icon: two overlapping camera outlines with a swap arrow
const FlipCamIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
    {/* Camera body */}
    <rect x="2" y="6" width="18" height="13" rx="2.5" stroke="white" strokeWidth="1.6"/>
    {/* Lens */}
    <circle cx="11" cy="12.5" r="3.5" stroke="white" strokeWidth="1.6"/>
    {/* Viewfinder bump */}
    <path d="M7.5 6V5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
    {/* Flip arrows — top-right corner */}
    <path d="M17 2.5 L19.5 5 L17 7.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M5 2.5 L2.5 5 L5 7.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M19.5 5 H14" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M2.5 5 H8" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const PhotoIcon = ({ color = 'white' }: { color?: string }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="1" y="3" width="16" height="12" rx="2" stroke={color} strokeWidth="1.5"/>
    <circle cx="9" cy="9" r="3" stroke={color} strokeWidth="1.5"/>
    <path d="M5 3.5L6.5 1.5H11.5L13 3.5" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const VideoIcon = ({ color = 'white' }: { color?: string }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="1" y="4" width="11" height="10" rx="2" stroke={color} strokeWidth="1.5"/>
    <path d="M12 7L17 5V13L12 11V7Z" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>
);

const FolderIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M2 5C2 4.448 2.448 4 3 4H7L9 6H15C15.552 6 16 6.448 16 7V14C16 14.552 15.552 15 15 15H3C2.448 15 2 14.552 2 14V5Z"
      stroke="white" strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>
);

// ── Main component ─────────────────────────────────────────────────────────
function CameraCapture({
  mode, onCapture, onCancel, webVideoMaxDurationSeconds,
}: CameraCaptureProps) {

  const effectiveMaxDuration = useMemo(() => {
    const v = webVideoMaxDurationSeconds;
    if (typeof v !== 'number' || v <= 0) return 60;
    if (v > 3600) return 3600;
    return Math.floor(v);
  }, [webVideoMaxDurationSeconds]);

  const [captureMode, setCaptureMode] = useState<'photo' | 'video'>(
    mode === 'video' ? 'video' : 'photo',
  );
  const [flashOverlay, setFlashOverlay] = useState(false);
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null);
  const [mobile,       setMobile]       = useState(isMobile);
  const [streamPaused, setStreamPaused] = useState(false);

  const videoRef     = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const fn = () => setMobile(isMobile());
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  const {
    stream, isRecording, deviceIds, error: streamError,
    startStream, stopStream, capturePhoto, startRecording, stopRecording, discardRecording, switchCamera,
  } = useWebCamera();

  const autoStopRef = useRef<() => void>(() => {});
  const timer = useRecordingTimer({
    maxSeconds: effectiveMaxDuration,
    onExpire: useCallback(() => autoStopRef.current(), []),
  });

  useEffect(() => {
    startStream();
    return () => { stopStream(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream ?? null;
    if (stream) v.play().catch(() => {});
  }, [stream]);

  // ── Capture handlers ──────────────────────────────────────────────────────
  const handleShutter = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !stream) return;
    try {
      const { uri, fileSize } = await capturePhoto(v);
      setFlashOverlay(true);
      setTimeout(() => setFlashOverlay(false), 220);
      setTimeout(() => onCapture({ type: 'photo', uri, fileType: 'image/jpeg', fileSize }), 80);
    } catch (e) {
      logger.error('CameraCapture.web: photo capture failed', e);
      setErrorMsg('Failed to capture photo. Please try again.');
    }
  }, [stream, capturePhoto, onCapture]);

  const handleRecord = useCallback(() => {
    if (!stream) return;
    timer.reset();
    timer.start();
    startRecording((result) => {
      timer.stop();
      onCapture({
        type: 'video', uri: result.uri, fileType: result.fileType,
        duration: parseFloat(result.duration.toFixed(3)), fileSize: result.fileSize,
      });
    });
  }, [stream, timer, startRecording, onCapture]);

  const handleStop = useCallback(() => { stopRecording(); }, [stopRecording]);
  autoStopRef.current = handleStop;

  const handleCancel = useCallback(() => {
    discardRecording();
    stopStream();
    onCancel();
  }, [discardRecording, stopStream, onCancel]);

  const handleSwitch = useCallback(async () => {
    try { await switchCamera(); } catch { /* silent */ }
  }, [switchCamera]);

  // ── Mode switch — only discards recording, does NOT change the mode ───────
  const handleDiscardRecording = useCallback(() => {
    discardRecording();
    timer.stop();
    timer.reset();
  }, [discardRecording, timer]);

  // ── Mode switch from tabs (top bar) — discards + switches ────────────────
  const handleModeSwitch = useCallback((newMode: 'photo' | 'video') => {
    discardRecording();
    timer.stop();
    timer.reset();
    setCaptureMode(newMode);
  }, [discardRecording, timer]);

  // ── File picker — discards recording, pauses stream, restarts on cancel ───
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (focusTimerRef.current) { clearTimeout(focusTimerRef.current); focusTimerRef.current = null; }
      const file = e.target.files?.[0];
      if (!file) {
        if (streamPaused) { setStreamPaused(false); startStream(); }
        return;
      }
      const uri = URL.createObjectURL(file);
      const isVideo = file.type.startsWith('video/');
      onCapture({ type: isVideo ? 'video' : 'photo', uri, fileType: file.type, fileName: file.name, fileSize: file.size });
    },
    [onCapture, streamPaused, startStream],
  );

  const handleFilePicker = useCallback(() => {
    discardRecording();   // silently discard — no onCapture callback fired
    timer.stop();
    timer.reset();
    stopStream();
    setStreamPaused(true);

    const onFocus = () => {
      focusTimerRef.current = setTimeout(() => {
        setStreamPaused(false);
        startStream();
      }, 500);
      window.removeEventListener('focus', onFocus);
    };
    window.addEventListener('focus', onFocus);
    setTimeout(() => fileInputRef.current?.click(), 80);
  }, [discardRecording, stopStream, startStream]);

  useEffect(() => () => {
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') { e.preventDefault(); handleCancel(); }
      if (e.key === ' ' && !isRecording && (captureMode === 'photo' || mode === 'photo') && stream) {
        e.preventDefault(); handleShutter();
      }
      if ((e.key === 'r' || e.key === 'R') && !isRecording && (captureMode === 'video' || mode === 'video') && stream) {
        e.preventDefault(); handleRecord();
      }
      if ((e.key === 's' || e.key === 'S') && isRecording) { e.preventDefault(); handleStop(); }
      if ((e.key === 'm' || e.key === 'M') && mode === 'photo-video') {
        e.preventDefault();
        if (isRecording) {
          handleDiscardRecording();
        } else {
          handleModeSwitch(captureMode === 'photo' ? 'video' : 'photo');
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRecording, captureMode, mode, stream, handleCancel, handleShutter, handleRecord, handleStop, handleModeSwitch, handleDiscardRecording]);

  // ── Layout values ─────────────────────────────────────────────────────────
  const cameraReady = !!stream && !streamError;
  const showTabs    = mode === 'photo-video';
  const showShutter = (mode === 'photo' || (mode === 'photo-video' && captureMode === 'photo')) && !isRecording;
  const showRecord  = (mode === 'video' || (mode === 'photo-video' && captureMode === 'video')) && !isRecording;
  const showStop    = isRecording;

  // Main button size
  const btnSz  = mobile ? 80 : 74;
  // Side button size (mode-switch, files)
  const sideSz = mobile ? 56 : 52;
  // Bottom bar: enough for btnSz + paddingBottom + a little breathing room
  const barH   = mobile ? btnSz + 52 : btnSz + 36;
  const topH   = mobile ? 88 : 64;

  const fileAccept = mode === 'photo' ? 'image/*' : mode === 'video' ? 'video/*' : 'image/*,video/*';

  const otherMode = captureMode === 'photo' ? 'video' : 'photo';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      role="dialog" aria-label="Camera capture" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483647,
        background: '#000', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', pointerEvents: 'all',
        animation: 'cc-fin 180ms ease',
      }}
    >
      <input
        ref={fileInputRef} type="file" accept={fileAccept}
        onChange={handleFileChange}
        onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
        style={{ display: 'none' }} aria-hidden="true" tabIndex={-1}
      />

      {/* Live video — pointerEvents:none so clicks always reach controls */}
      <video ref={videoRef} autoPlay muted playsInline
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover', pointerEvents: 'none', zIndex: 1,
        }}
      />

      {/* Dim overlay while file picker is open */}
      {streamPaused && !stream && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.75)',
          zIndex: 2, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ color: 'rgba(255,255,255,.5)', fontSize: 14, fontFamily: FONT }}>
            Waiting for file selection…
          </span>
        </div>
      )}

      {/* Photo flash */}
      {flashOverlay && (
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, background: '#fff',
          animation: 'cc-flash 220ms ease-out forwards',
          pointerEvents: 'none', zIndex: 50,
        }} />
      )}

      {/* Recording timer badge */}
      {isRecording && (
        <div
          aria-live="polite"
          aria-label={`Recording: ${timer.formattedElapsed}`}
          style={{
            position: 'absolute', top: topH + 8,
            left: '50%', transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: 7,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 20, padding: '5px 13px',
            zIndex: 100, whiteSpace: 'nowrap',
          }}
        >
          <div aria-hidden="true" style={{
            width: 9, height: 9, borderRadius: '50%', background: '#ff3b30',
            animation: 'cc-pulse 1s ease-in-out infinite', flexShrink: 0,
          }} />
          <span style={{ color: '#fff', fontSize: 13, fontFamily: FONT, fontWeight: 700, letterSpacing: .6 }}>
            {timer.formattedElapsed}
          </span>
          <span style={{ color: 'rgba(255,255,255,.5)', fontSize: 12, fontFamily: FONT }}>
            / {timer.formattedRemaining}
          </span>
        </div>
      )}

      {/* ── Top bar ── */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: topH,
        paddingTop: mobile ? 44 : 14,
        paddingLeft: 14, paddingRight: 14, paddingBottom: 8,
        display: 'flex', flexDirection: 'row',
        alignItems: 'center', justifyContent: 'space-between',
        background: 'linear-gradient(to bottom,rgba(0,0,0,.65) 0%,rgba(0,0,0,0) 100%)',
        zIndex: 100, pointerEvents: 'all',
      }}>
        <PillBtn label="Close camera (Esc)" onClick={handleCancel}>
          <CloseIcon />
        </PillBtn>

        {/* Centre: tabs (photo-video, not recording) or plain label */}
        {showTabs && !isRecording ? (
          <div role="tablist" aria-label="Capture mode" style={{
            display: 'flex', flexDirection: 'row',
            background: 'rgba(255,255,255,0.12)',
            border: '1px solid rgba(255,255,255,0.22)',
            borderRadius: 22, padding: 3, gap: 2,
          }}>
            {(['photo', 'video'] as const).map((m) => {
              const active = captureMode === m;
              return (
                <button
                  key={m} role="tab" type="button"
                  aria-selected={active} aria-label={`${m} mode`}
                  tabIndex={active ? 0 : -1} className="cc-btn"
                  onClick={(e) => { e.stopPropagation(); handleModeSwitch(m); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleModeSwitch(m); }
                    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                      e.preventDefault(); handleModeSwitch(m === 'photo' ? 'video' : 'photo');
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '5px 14px', borderRadius: 18, border: 'none', cursor: 'pointer',
                    fontSize: 13, fontFamily: FONT, fontWeight: 600,
                    transition: 'background .15s, color .15s',
                    background: active ? '#fff' : 'transparent',
                    color: active ? '#111' : 'rgba(255,255,255,.75)',
                    boxShadow: active ? '0 1px 6px rgba(0,0,0,.25)' : 'none',
                  }}
                >
                  {m === 'photo'
                    ? <PhotoIcon color={active ? '#111' : 'white'} />
                    : <VideoIcon color={active ? '#111' : 'white'} />}
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{
            color: isRecording ? '#ff3b30' : '#fff',
            fontSize: 14, fontFamily: FONT, fontWeight: 700,
            letterSpacing: .4, textShadow: '0 1px 6px rgba(0,0,0,.6)',
            pointerEvents: 'none',
          }}>
            {isRecording ? '● REC'
              : mode === 'photo' ? 'Photo'
              : mode === 'video' ? 'Video'
              : captureMode === 'photo' ? 'Photo' : 'Video'}
          </div>
        )}

        {/* Flip camera — only shown when ≥2 devices */}
        {deviceIds.length >= 2
          ? <PillBtn label="Flip camera" onClick={handleSwitch}><FlipCamIcon /></PillBtn>
          : <div style={{ width: 44 }} />}
      </div>

      {/* ── Bottom control bar ── */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        height: barH,
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
        borderTop: '1px solid rgba(255,255,255,0.13)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'flex-start',
        paddingTop: mobile ? 14 : 10,
        paddingBottom: mobile ? 28 : 12,
        gap: 6,
        zIndex: 100, pointerEvents: 'all',
        animation: 'cc-sup 220ms ease',
        boxSizing: 'border-box',
      }}>

        {/* Button row */}
        <div style={{
          display: 'flex', flexDirection: 'row',
          alignItems: 'center', justifyContent: 'center',
          gap: mobile ? 20 : 28,
          width: '100%',
          paddingLeft: 16, paddingRight: 16,
          boxSizing: 'border-box',
        }}>

          {/* ── Mode switch side button (photo-video only, always enabled) ── */}
          {mode === 'photo-video' && (
            <button
              type="button"
              className="cc-btn cc-side-btn"
              aria-label={isRecording
                ? 'Discard recording (M)'
                : `Switch to ${otherMode} mode (M)`}
              onClick={(e) => {
                e.stopPropagation();
                if (isRecording) {
                  handleDiscardRecording();
                } else {
                  handleModeSwitch(otherMode);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (isRecording) { handleDiscardRecording(); } else { handleModeSwitch(otherMode); }
                }
              }}
              style={{
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 4,
                width: sideSz, height: sideSz, borderRadius: '50%',
                background: isRecording
                  ? 'rgba(255,59,48,0.22)'
                  : 'rgba(255,255,255,0.15)',
                border: isRecording
                  ? '1.5px solid rgba(255,59,48,0.5)'
                  : '1.5px solid rgba(255,255,255,0.3)',
                backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
                cursor: 'pointer',
                transition: 'background .15s, border-color .15s, transform .1s',
                flexShrink: 0, position: 'relative', zIndex: 2,
              }}
            >
              {isRecording ? (
                // Cancel/discard icon — X mark
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2 2L14 14M14 2L2 14" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
                </svg>
              ) : (
                otherMode === 'photo' ? <PhotoIcon /> : <VideoIcon />
              )}
              <span style={{
                color: 'rgba(255,255,255,.8)', fontSize: 8,
                fontFamily: FONT, fontWeight: 700, letterSpacing: .3, lineHeight: 1,
              }}>
                {isRecording ? 'Discard' : (otherMode.charAt(0).toUpperCase() + otherMode.slice(1))}
              </span>
            </button>
          )}

          {/* Shutter */}
          {showShutter && (
            <button
              type="button" className="cc-btn cc-shutter"
              aria-label="Take photo (Space)" aria-disabled={!cameraReady}
              disabled={!cameraReady}
              onClick={(e) => { e.stopPropagation(); handleShutter(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleShutter(); } }}
              style={{
                width: btnSz, height: btnSz, borderRadius: '50%',
                background: '#fff',
                border: '4px solid rgba(255,255,255,0.5)',
                boxShadow: '0 0 0 3px rgba(255,255,255,0.35), 0 4px 20px rgba(0,0,0,0.4)',
                cursor: cameraReady ? 'pointer' : 'not-allowed',
                opacity: cameraReady ? 1 : 0.45,
                transition: 'opacity .2s, transform .12s, box-shadow .15s',
                flexShrink: 0, position: 'relative', zIndex: 2,
              }}
            />
          )}

          {/* Record */}
          {showRecord && (
            <button
              type="button" className="cc-btn cc-record"
              aria-label="Start recording (R)" aria-disabled={!cameraReady}
              disabled={!cameraReady}
              onClick={(e) => { e.stopPropagation(); handleRecord(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRecord(); } }}
              style={{
                width: btnSz, height: btnSz, borderRadius: '50%',
                background: '#ff3b30',
                border: '4px solid rgba(255,59,48,0.4)',
                boxShadow: '0 0 0 3px rgba(255,59,48,0.3), 0 4px 20px rgba(255,59,48,0.5)',
                cursor: cameraReady ? 'pointer' : 'not-allowed',
                opacity: cameraReady ? 1 : 0.45,
                transition: 'opacity .2s, transform .12s',
                flexShrink: 0, position: 'relative', zIndex: 2,
              }}
            />
          )}

          {/* Stop recording */}
          {showStop && (
            <button
              type="button" className="cc-btn"
              aria-label="Stop recording (S)"
              onClick={(e) => { e.stopPropagation(); handleStop(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleStop(); } }}
              style={{
                width: btnSz, height: btnSz, borderRadius: '50%',
                background: '#fff', border: '4px solid rgba(255,255,255,0.4)',
                boxShadow: '0 0 0 3px rgba(255,255,255,0.3), 0 4px 20px rgba(0,0,0,0.4)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'transform .12s',
                flexShrink: 0, position: 'relative', zIndex: 2,
              }}
            >
              <div aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 7, background: '#ff3b30' }} />
            </button>
          )}

          {/* File picker — discards recording if active */}
          <button
            type="button" className="cc-btn cc-side-btn"
            aria-label={`Choose from files${isRecording ? ' — discards recording' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleFilePicker(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleFilePicker(); } }}
            style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 4,
              width: sideSz, height: sideSz, borderRadius: '50%',
              background: 'rgba(255,255,255,0.15)',
              border: '1.5px solid rgba(255,255,255,0.32)',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
              cursor: 'pointer',
              transition: 'background .15s, transform .1s',
              flexShrink: 0, position: 'relative', zIndex: 2,
            }}
          >
            <FolderIcon />
            <span style={{
              color: 'rgba(255,255,255,.8)', fontSize: 8,
              fontFamily: FONT, fontWeight: 700, letterSpacing: .3, lineHeight: 1,
            }}>
              Files
            </span>
          </button>
        </div>

        {/* Keyboard hints (desktop only) */}
        {!mobile && (
          <div style={{
            color: 'rgba(255,255,255,.28)', fontSize: 10,
            fontFamily: FONT, letterSpacing: .3, pointerEvents: 'none',
            marginTop: 2,
          }}>
            {isRecording
              ? 'S — stop  ·  M — switch (discards)  ·  Esc — close'
              : (captureMode === 'photo' || mode === 'photo')
                ? 'Space — photo  ·  M — switch mode  ·  Esc — close'
                : 'R — record  ·  M — switch mode  ·  Esc — close'}
          </div>
        )}
      </div>

      {/* Error toast */}
      {errorMsg && (
        <div
          role="alert" aria-live="assertive"
          style={{
            position: 'absolute', bottom: barH + 12, left: 16, right: 16,
            background: 'rgba(160,0,0,0.9)',
            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,100,100,0.3)',
            borderRadius: 12, padding: '11px 14px',
            display: 'flex', alignItems: 'center', gap: 10,
            zIndex: 110, animation: 'cc-sup 180ms ease',
          }}
        >
          <span style={{ color: '#fff', flex: 1, fontSize: 13, fontFamily: FONT }}>{errorMsg}</span>
          <button type="button" className="cc-btn"
            aria-label="Dismiss error"
            onClick={(e) => { e.stopPropagation(); setErrorMsg(null); }}
            style={{ background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.25)', borderRadius: 8, color: '#fff', cursor: 'pointer', fontSize: 14, padding: '3px 8px', flexShrink: 0 }}
          >✕</button>
        </div>
      )}

      {/* Stream error overlay */}
      {streamError && (
        <div
          role="alertdialog" aria-label="Camera access error"
          style={{
            position: 'absolute', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.93)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: 32, gap: 20, animation: 'cc-fin 200ms ease',
          }}
        >
          <div style={{ width: 68, height: 68, borderRadius: 34, background: 'rgba(255,59,48,0.12)', border: '1.5px solid rgba(255,59,48,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30 }}>📷</div>
          <div style={{ textAlign: 'center', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ color: '#fff', fontSize: 18, fontWeight: 700, fontFamily: FONT, margin: 0 }}>Camera access required</p>
            <p style={{ color: 'rgba(255,255,255,.6)', fontSize: 13, fontFamily: FONT, margin: 0, lineHeight: 1.55 }}>
              Click the lock icon in the address bar → Site settings → Camera → Allow, then reload.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 260 }}>
            <button type="button" className="cc-btn"
              aria-label="Choose file instead"
              onClick={(e) => { e.stopPropagation(); handleFilePicker(); }}
              style={{ padding: '11px 0', background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.25)', borderRadius: 12, color: '#fff', cursor: 'pointer', fontSize: 14, fontFamily: FONT, fontWeight: 600 }}
            >Choose from files instead</button>
            <button type="button" className="cc-btn"
              aria-label="Close"
              onClick={(e) => { e.stopPropagation(); handleCancel(); }}
              style={{ padding: '11px 0', background: '#fff', border: 'none', borderRadius: 12, color: '#111', cursor: 'pointer', fontSize: 14, fontFamily: FONT, fontWeight: 600 }}
            >Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

export { CameraCapture };
