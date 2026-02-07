import React from 'react';
import { ActivityIndicator, View, StyleProp, ViewStyle } from 'react-native';
import Pdf from 'react-native-pdf';

interface PdfNativeRendererProps {
  uri: string;
  style?: StyleProp<ViewStyle>;
  loadingColor?: string;
  onError?: (error: unknown) => void;
}

export function PdfNativeRenderer({
  uri,
  style,
  loadingColor = '#6B7280',
  onError,
}: PdfNativeRendererProps) {
  return (
    <Pdf
      source={{ uri, cache: true }}
      style={style}
      renderActivityIndicator={() => (
        <View style={[{ alignItems: 'center', justifyContent: 'center' }, style]}>
          <ActivityIndicator size="small" color={loadingColor} />
        </View>
      )}
      onError={onError}
    />
  );
}
