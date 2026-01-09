import { logger } from '@/lib/logger';
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { requireNativeComponent, Platform, TextInputProps, TextInput, NativeSyntheticEvent, TextInputChangeEventData, UIManager, findNodeHandle } from 'react-native';

const NativeRichEditText = Platform.OS === 'android'
  ? requireNativeComponent<any>('RichEditText')
  : null;

type RichContentItem = { uri: string; mimeType?: string; fileUri?: string; fileName?: string };

type Props = TextInputProps & {
  onRichContent?: (items: RichContentItem[]) => void;
  suppressChange?: boolean; // prevent onChangeText while clearing
};

export interface RichEditTextRef {
  clear: () => void;
  focus: () => void;
  blur: () => void;
  nativeRef: React.RefObject<any>; // Expose native ref for direct access
}

const RichEditText = forwardRef<RichEditTextRef, Props>((props, ref) => {
  const textInputRef = useRef<TextInput>(null);
  const nativeRef = useRef<any>(null);
  const isClearingRef = useRef(false);

  useImperativeHandle(ref, () => ({
    clear: () => {
  if (__DEV__) logger.debug('RichEditText: clear() called');
  isClearingRef.current = true;
      
      if (Platform.OS === 'android' && nativeRef.current) {
        try {
          if (__DEV__) logger.debug('RichEditText: Android native clear');
          // Soft clear WITHOUT blurring, to keep keyboard open
          // Step 1: Clear React state
          if (props.onChangeText) {
            props.onChangeText('');
            if (__DEV__) logger.debug('RichEditText: state -> empty');
          }
          
          // Step 2: Force native clearing while keeping focus
          if (nativeRef.current.setNativeProps) {
            // Space-sandwich: first set a single space, then empty to force IME commit
            nativeRef.current.setNativeProps({ text: ' ', selection: { start: 1, end: 1 } });
            setTimeout(() => {
              nativeRef.current?.setNativeProps?.({ text: '', selection: { start: 0, end: 0 } });
            }, 10);
            if (__DEV__) logger.debug('RichEditText: setNativeProps sandwich');
          }

          // Step 3: Ask native to drop composing text and restart input connection
          try {
            const node = findNodeHandle(nativeRef.current);
            if (node) {
              // Prefer numeric command ID when available; fallback to string
              // RN 0.69+ exposes UIManager.getViewManagerConfig
              // @ts-ignore dynamic access for compatibility
              const config = (UIManager.getViewManagerConfig?.('RichEditText')) || (UIManager as any)?.RichEditText;
              const cmd = config?.Commands?.forceClearAndRestartIme ?? 'forceClearAndRestartIme';
              UIManager.dispatchViewManagerCommand(node, cmd as any, []);
            }
          } catch {}
          
          if (nativeRef.current.clear) {
            nativeRef.current.clear();
            if (__DEV__) logger.debug('RichEditText: native clear()');
          }
          // Additional small delayed passes to defeat IME composition artifacts
      setTimeout(() => {
            if (nativeRef.current?.setNativeProps) {
              nativeRef.current.setNativeProps({ text: '', selection: { start: 0, end: 0 } });
            }
            // One more micro-pass
            setTimeout(() => {
              if (nativeRef.current?.setNativeProps) {
                nativeRef.current.setNativeProps({ text: '', selection: { start: 0, end: 0 } });
              }
              // End clearing guard shortly after
              setTimeout(() => { isClearingRef.current = false; }, 30);
            }, 50);
          }, 50);
          
        } catch (e) {
          if (__DEV__) logger.debug('RichEditText: clear failed:', e);
          isClearingRef.current = false;
        }
      } else if (textInputRef.current) {
        try {
          // iOS/fallback clearing with blur/clear/focus cycle
          textInputRef.current.blur();
          
          if (props.onChangeText) {
            props.onChangeText('');
          }
          textInputRef.current.setNativeProps({ text: '' });
          textInputRef.current.clear();
          
          setTimeout(() => {
            textInputRef.current?.focus();
          }, 50);
          
          if (__DEV__) logger.debug('RichEditText: iOS fallback clear');
          isClearingRef.current = false;
        } catch (e) {
          if (__DEV__) logger.debug('RichEditText: iOS fallback clear failed:', e);
          isClearingRef.current = false;
        }
      }
    },
    focus: () => {
      if (Platform.OS === 'android' && nativeRef.current) {
        try {
          nativeRef.current.focus?.();
        } catch (e) {
          logger.debug('Native focus not available');
        }
      } else if (textInputRef.current) {
        textInputRef.current.focus();
      }
    },
    blur: () => {
      if (Platform.OS === 'android' && nativeRef.current) {
        try {
          nativeRef.current.blur?.();
        } catch (e) {
          logger.debug('Native blur not available');
        }
      } else if (textInputRef.current) {
        textInputRef.current.blur();
      }
    },
    nativeRef: nativeRef, // Expose native ref for direct access
  }));

  if (Platform.OS !== 'android' || !NativeRichEditText) {
    // Fallback to normal TextInput on other platforms
    return <TextInput {...props} ref={textInputRef} />;
  }
  
  return (
    <NativeRichEditText
      {...props}
      ref={nativeRef}
      // Bridge native onChange to RN's onChangeText so controlled input works
      onChange={(e: NativeSyntheticEvent<TextInputChangeEventData>) => {
        props.onChange && props.onChange(e);
        const text = e?.nativeEvent?.text ?? '';
        // Suppress all onChangeText events while we're actively clearing or if parent requests suppression
        if (isClearingRef.current || props.suppressChange) return;
  props.onChangeText && props.onChangeText(text);
      }}
      onRichContent={(e: any) => {
        const items: RichContentItem[] = e?.nativeEvent?.items || [];
        props.onRichContent?.(items);
      }}
    />
  );
});

RichEditText.displayName = 'RichEditText';

export default RichEditText;
