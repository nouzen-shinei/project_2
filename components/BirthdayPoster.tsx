import React, { useContext, useEffect, useMemo, useState } from 'react';
import { View, Image, Pressable, useWindowDimensions } from 'react-native';
import { Asset } from 'expo-asset';
import { BirthdayContext } from './BirthdayProvider';
import { X } from 'lucide-react-native';

// Screen size will be read dynamically via useWindowDimensions

export default function BirthdayPoster() {
  const ctx = useContext(BirthdayContext);
  const screen = useWindowDimensions();

  const isPosterOpen = !!ctx?.isPosterOpen;
  const closePoster = ctx?.closePoster ?? (() => {});
  // (Removed BirthdayPoster render debug log)

  // NOTE: Using an existing repo asset to avoid missing-file errors.
  // Replace the require path below with your desired image (e.g. '../assets/images/birthday-celebration.jpg') after adding it.
  const moduleRef = require('../assets/images/1756410296.png');
  const [natural, setNatural] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Resolve natural dimensions in a cross-platform way
  useEffect(() => {
    let mounted = true;
    const asset = Asset.fromModule(moduleRef);
    // If dimensions are already known, use them; otherwise try to download
    if (asset.width && asset.height) {
      if (mounted) setNatural({ w: asset.width, h: asset.height });
    } else {
      asset.downloadAsync().finally(() => {
        if (mounted) setNatural({ w: asset.width ?? 0, h: asset.height ?? 0 });
      });
    }
    return () => {
      mounted = false;
    };
  }, [moduleRef]);

  // Calculate display size to always show the whole image:
  // - Preserve aspect ratio
  // - Fit inside screen with margins (no cropping)
  // - Do not upscale beyond native resolution (keeps "full resolution")
  const { displayWidth, displayHeight, horizontalMargin } = useMemo(() => {
    const naturalW = natural.w;
    const naturalH = natural.h;
    // Ensure a comfortable horizontal margin on small screens.
    // Use at least 24px margin each side, or 6% of screen width whichever is larger.
    const marginH = Math.max(24, Math.round(screen.width * 0.06));
    const maxW = Math.max(0, screen.width - marginH * 2);
    const maxH = Math.max(0, screen.height * 0.86);

    if (naturalW > 0 && naturalH > 0) {
      // Scale to fit but never above 1 (no upscaling)
      const scale = Math.min(maxW / naturalW, maxH / naturalH, 1);
      return {
        displayWidth: Math.round(naturalW * scale),
        displayHeight: Math.round(naturalH * scale),
        horizontalMargin: marginH,
      };
    }
    // Fallback if dimensions are unknown (web edge cases)
    return {
      displayWidth: Math.round(maxW),
      displayHeight: Math.round(maxH),
      horizontalMargin: Math.max(24, Math.round(screen.width * 0.06)),
    };
  }, [screen.width, screen.height, natural.w, natural.h]);

  return (
  !isPosterOpen ? null : (
  <View
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(8,8,12,0.75)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 10000,
      }}
    >
  {/* Close (moved inside the image container below so it sits on the image) */}

      <View
        style={{
          width: displayWidth,
          height: displayHeight,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: '#000',
          shadowColor: '#000',
          shadowOpacity: 0.35,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 10 },
          elevation: 6,
          marginHorizontal: horizontalMargin,
        }}
      >
        {/* Close button anchored inside the image */}
        <Pressable
          onPress={closePoster}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            backgroundColor: 'rgba(0,0,0,0.45)',
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
        >
          <X size={18} color="#fff" />
        </Pressable>
        <Image
          source={moduleRef}
          resizeMode="contain"
          style={{ width: '100%', height: '100%' }}
          accessible
          accessibilityLabel="Birthday celebration image"
        />
      </View>
    </View>
    )
  );
}
