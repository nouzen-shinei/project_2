import React, { useEffect } from 'react';
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { AlertCircle } from 'lucide-react-native';

type SubmitFailedContentProps = {
  /** Short label shown inside the button, e.g. "Failed to save". */
  label: string;
  /** `shake` from `useSubmitFailure`. */
  shake: Animated.Value;
  /** Text style of the button's normal label, so size and font match. */
  textStyle?: StyleProp<TextStyle>;
  /** Icon and text colour. Defaults to white for filled buttons. */
  color?: string;
  iconSize?: number;
};

/**
 * Label for a submit button in its failed state: alert icon plus a short
 * message, shaken once by `useSubmitFailure`. Only the content moves, so the
 * button keeps its size and position. The label is announced to screen readers
 * when it appears.
 */
export function SubmitFailedContent({
  label,
  shake,
  textStyle,
  color = '#ffffff',
  iconSize = 18,
}: SubmitFailedContentProps) {
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(label);
  }, [label]);

  return (
    <Animated.View style={[styles.row, { transform: [{ translateX: shake }] }]}>
      <AlertCircle size={iconSize} color={color} />
      <Text style={[textStyle, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});

export default SubmitFailedContent;
