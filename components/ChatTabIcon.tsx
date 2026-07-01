/**
 * ChatTabIcon
 *
 * A memoized tab-bar icon that renders a red notification dot when there
 * are unread messages. Designed to be resource-efficient across all
 * platforms (iOS, Android, web / all browsers):
 *
 *  • `React.memo` — skips re-render entirely when `size`, `color`, and
 *    `hasUnread` are all unchanged. The tab bar renders on every navigation
 *    event, so the memo guard matters.
 *
 *  • `StyleSheet.create` — styles are registered once at module load and
 *    referenced by integer ids on native, and compiled to stable CSS class
 *    names by react-native-web. No object allocation per render.
 *
 *  • The dot is `position: 'absolute'` with no JS animation or polling.
 *    It is toggled purely by conditional rendering (`hasUnread && …`),
 *    which lets the React reconciler add / remove a single leaf node with
 *    no layout-affecting changes to the icon itself.
 *
 *  • `pointerEvents="none"` on the dot ensures it never consumes touch /
 *    click events — the tab bar's underlying pressable keeps full hit area.
 *
 *  • `badgeBorderColor` defaults to white but should be set to the tab bar's
 *    background colour so the ring appears to "cut out" from the surface,
 *    matching the native platform badge convention.
 */

import React, { memo } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { MessageCircle } from 'lucide-react-native';

// ─── Constants ────────────────────────────────────────────────────────────────

const DOT_DIAMETER = 8;
const DOT_BORDER = 1.5;
// Position the dot so it sits at the icon's top-right corner and slightly
// overhangs the edge — the same visual convention used by iOS and Android.
const DOT_OFFSET_TOP = -2;
const DOT_OFFSET_RIGHT = -3;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatTabIconProps {
  /** Icon render size passed by the tab navigator (typically 24). */
  size: number;
  /** Active / inactive tint colour passed by the tab navigator. */
  color: string;
  /** Show the red unread dot when true. */
  hasUnread: boolean;
  /**
   * Border colour for the dot ring. Should match the tab bar's background
   * so the ring looks like a cut-out. Defaults to white which works for
   * light tab bars and most dark tab bars.
   */
  badgeBorderColor?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

function ChatTabIconBase({
  size,
  color,
  hasUnread,
  badgeBorderColor = '#FFFFFF',
}: ChatTabIconProps) {
  return (
    <View style={styles.container}>
      <MessageCircle size={size} color={color} />

      {hasUnread && (
        <View
          // Keeps the dot completely outside the touch / pointer event chain.
          // On React Native this is the prop; on web react-native-web forwards
          // it as the CSS `pointer-events: none` property.
          pointerEvents="none"
          style={[
            styles.dot,
            // Apply the border colour as a dynamic style so it can be themed.
            // Only one extra object is allocated when hasUnread is true, and
            // React Native batches it with the static StyleSheet reference.
            { borderColor: badgeBorderColor },
          ]}
          // Accessibility: the dot is purely decorative; the unread state is
          // already communicated by the tab label / screen reader context.
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      )}
    </View>
  );
}

export const ChatTabIcon = memo(ChatTabIconBase);

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    // No explicit width/height — the container shrinks to the icon's natural
    // size so absolute children are positioned relative to the icon bounds.
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: DOT_OFFSET_TOP,
    right: DOT_OFFSET_RIGHT,
    width: DOT_DIAMETER,
    height: DOT_DIAMETER,
    borderRadius: DOT_DIAMETER / 2,
    backgroundColor: '#EF4444',
    borderWidth: DOT_BORDER,
    // borderColor is applied dynamically via the badgeBorderColor prop so
    // the ring blends with any tab bar background colour.

    // On web, guarantee the dot renders above any stacking context inside
    // the tab bar without affecting layout of sibling elements.
    ...Platform.select({
      web: {
        // `zIndex` is valid in RN web StyleSheet and maps directly to CSS.
        zIndex: 1,
      },
    }),
  },
});
