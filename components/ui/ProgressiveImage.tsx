import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ImageProps, Platform, StyleSheet, View } from 'react-native';

// Lightweight in-memory cache to remember successfully loaded URIs
const LOADED_URIS = new Set<string>();
const MAX_CACHE = 500;

export type ProgressiveImageProps = Omit<ImageProps, 'source'> & {
  uri: string;
  spinnerSize?: 'small' | 'large';
};

export const ProgressiveImage: React.FC<ProgressiveImageProps> = ({
  uri,
  style,
  resizeMode = 'cover',
  spinnerSize = 'small',
  onLoad,
  onError,
  ...rest
}) => {
  const [loading, setLoading] = useState(!LOADED_URIS.has(uri));
  const [error, setError] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    // Reset state when uri changes
    setLoading(!LOADED_URIS.has(uri));
    setError(false);
    retryRef.current = 0;
  }, [uri]);

  const handleLoad = useCallback<NonNullable<ImageProps['onLoad']>>(
    (e) => {
      if (LOADED_URIS.size > MAX_CACHE) {
        // Simple truncation when overflowing
        LOADED_URIS.clear();
      }
      LOADED_URIS.add(uri);
      setLoading(false);
      setError(false);
      onLoad?.(e);
    },
    [onLoad, uri]
  );

  const handleError = useCallback<NonNullable<ImageProps['onError']>>(
    (e) => {
      if (retryRef.current < 1) {
        // Single retry after a brief delay
        retryRef.current += 1;
        setTimeout(() => {
          setLoading(true);
          setError(false);
        }, 250);
      } else {
        setError(true);
        setLoading(false);
      }
      onError?.(e);
    },
    [onError]
  );

  return (
    <View style={style}>
      {loading && !error && (
        <View style={[StyleSheet.absoluteFillObject, styles.loaderLayer]}>
          <ActivityIndicator size={spinnerSize} color="#999" />
        </View>
      )}
      {!error ? (
        <Image
          source={{ uri, cache: Platform.OS === 'web' ? undefined : ('force-cache' as any) }}
          style={[style, loading ? { opacity: 0.7 } : null]}
          resizeMode={resizeMode as any}
          onLoad={handleLoad}
          onError={handleError}
          fadeDuration={Platform.OS === 'android' ? 100 : 0}
          {...rest}
        />
      ) : (
        <View style={[StyleSheet.absoluteFillObject, styles.errorLayer]} />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  loaderLayer: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(240,240,240,0.8)',
    borderRadius: 8,
  },
  errorLayer: {
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 8,
  },
});

export default ProgressiveImage;
