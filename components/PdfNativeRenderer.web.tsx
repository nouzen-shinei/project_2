import React from 'react';
import { View, StyleProp, ViewStyle } from 'react-native';

interface PdfNativeRendererProps {
  uri: string;
  style?: StyleProp<ViewStyle>;
  loadingColor?: string;
  onError?: (error: unknown) => void;
}

export function PdfNativeRenderer({ style }: PdfNativeRendererProps) {
  return <View style={style} />;
}
