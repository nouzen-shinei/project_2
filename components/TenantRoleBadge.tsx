import React, { memo, useMemo } from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { getRoleBadgeConfig } from '@/lib/roleBadges';

type TenantRoleBadgeProps = {
  role?: string | null;
  style?: StyleProp<ViewStyle>;
  labelMode?: 'display' | 'label';
};

function TenantRoleBadgeInner({ role, style, labelMode = 'display' }: TenantRoleBadgeProps) {
  const config = useMemo(() => getRoleBadgeConfig(role ?? null), [role]);
  if (!config) {
    return null;
  }

  const text = labelMode === 'label' ? config.label : config.displayLabel;

  return (
    <View style={[styles.badge, { backgroundColor: config.backgroundColor }, style]}>
      <Text style={[styles.text, { color: config.textColor }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Mirrors Settings' pill badge styling for consistency.
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  text: {
    fontSize: 10,
    fontFamily: 'Inter-SemiBold',
  },
});

export default memo(TenantRoleBadgeInner);
