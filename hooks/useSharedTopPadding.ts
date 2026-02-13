import { useContext, useMemo } from 'react';
import { Platform } from 'react-native';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';

type SharedTopPaddingOptions = {
  minPadding?: number;
  extraPadding?: number;
  webPadding?: number;
};

export const useSharedTopPadding = (options?: SharedTopPaddingOptions) => {
  const insets = useContext(SafeAreaInsetsContext) ?? ({ top: 0, bottom: 0, left: 0, right: 0 } as EdgeInsets);
  const minPadding = options?.minPadding ?? 60;
  const extraPadding = options?.extraPadding ?? 0;
  const webPadding = options?.webPadding ?? 16;

  return useMemo(() => {
    if (Platform.OS === 'web') {
      return webPadding;
    }
    return Math.max(minPadding, insets.top + extraPadding);
  }, [extraPadding, insets.top, minPadding, webPadding]);
};
