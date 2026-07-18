import { forwardRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import type { KeyboardMediaCandidate } from '@/lib/chatKeyboardMediaSend';

export interface PasteableTextInputProps extends TextInputProps {
  onKeyboardMedia?: (candidate: KeyboardMediaCandidate) => void;
}

/**
 * Web variant: renders a plain `TextInput`. Clipboard paste on web is handled by
 * the composer's document-level `paste` listener (see `MobileChatInput`), so this
 * wrapper intentionally ignores `onKeyboardMedia` and keeps a `TextInput`-identical
 * surface. Metro resolves this file for the web bundle, which also keeps the
 * native-only `@mattermost/react-native-paste-input` dependency out of web builds.
 */
export const PasteableTextInput = forwardRef<TextInput, PasteableTextInputProps>(
  function PasteableTextInput(props, ref) {
    const { onKeyboardMedia, ...rest } = props;
    void onKeyboardMedia;
    return <TextInput ref={ref} {...rest} />;
  }
);
