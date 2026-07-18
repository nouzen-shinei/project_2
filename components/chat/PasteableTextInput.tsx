import { forwardRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { logger } from '@/lib/logger';
import type { KeyboardMediaCandidate } from '@/lib/chatKeyboardMediaSend';

export interface PasteableTextInputProps extends TextInputProps {
  /**
   * Fired when media (image/video) is inserted via the device keyboard (Android
   * `commitContent` — e.g. the Gboard GIF button) or the OS clipboard (paste).
   * The parent is responsible for validating + sending.
   */
  onKeyboardMedia?: (candidate: KeyboardMediaCandidate) => void;
}

interface PastedFileLike {
  fileName?: string | null;
  fileSize?: number | null;
  type?: string | null;
  uri?: string | null;
  // Android paste origin tagged by the patched native module: "keyboard"
  // (commitContent — GIF/sticker keyboards) or "clipboard" (OS clipboard paste).
  source?: string | null;
}

// Optional native dependency, resolved by Metro at build time once installed
// (`@mattermost/react-native-paste-input`; RN 0.79 / New Architecture only).
// Loaded through a guarded require so that:
//   (a) type-checking a checkout without the dep installed does not fail, and
//   (b) if the module is missing or throws we transparently fall back to the
//       plain RN TextInput — the composer must never break because of this
//       optional enhancement.
let PasteInput: any = null;
try {
  // @ts-ignore optional native dependency (present after `npm install`)
  PasteInput = require('@mattermost/react-native-paste-input')?.default ?? null;
} catch {
  PasteInput = null;
}

// Escape hatch: set EXPO_PUBLIC_DISABLE_NATIVE_MEDIA_PASTE=true to force the
// plain-TextInput fallback without a code change (e.g. if a future RN upgrade
// regresses the native module).
const NATIVE_PASTE_DISABLED = process.env.EXPO_PUBLIC_DISABLE_NATIVE_MEDIA_PASTE === 'true';

/**
 * A drop-in `TextInput` replacement that additionally surfaces pasted / keyboard
 * media via `onKeyboardMedia`. On native it uses
 * `@mattermost/react-native-paste-input` when available; otherwise it renders a
 * plain `TextInput`. The ref is `TextInput`-compatible in both cases.
 *
 * Web uses a separate implementation (`PasteableTextInput.web.tsx`) that renders
 * a plain `TextInput`; web paste is handled by the composer's document listener.
 */
export const PasteableTextInput = forwardRef<TextInput, PasteableTextInputProps>(
  function PasteableTextInput({ onKeyboardMedia, ...props }, ref) {
    const useNativePaste = !!PasteInput && !NATIVE_PASTE_DISABLED && typeof onKeyboardMedia === 'function';

    if (!useNativePaste) {
      return <TextInput ref={ref} {...props} />;
    }

    const handlePaste = (error: string | null | undefined, files: PastedFileLike[]) => {
      if (error) {
        logger.warn('[chat] paste-input onPaste error', error);
        return;
      }
      const list = Array.isArray(files) ? files : [];
      // Prefer the first image/video; fall back to the first item that has a uri.
      const media =
        list.find((f) => {
          const t = (f?.type || '').toLowerCase();
          return !!f?.uri && (t.startsWith('image/') || t.startsWith('video/'));
        }) || list.find((f) => !!f?.uri);
      if (!media?.uri) {
        return;
      }
      onKeyboardMedia?.({
        uri: media.uri,
        mimeType: media.type ?? null,
        fileName: media.fileName ?? null,
        fileSize: typeof media.fileSize === 'number' ? media.fileSize : null,
        source: media.source ?? null,
      });
    };

    return <PasteInput ref={ref} {...props} onPaste={handlePaste} disableCopyPaste={false} />;
  }
);
