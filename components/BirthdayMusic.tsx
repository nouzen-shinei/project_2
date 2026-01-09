import { logger } from '@/lib/logger';
import React, { useEffect } from 'react';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { useBirthdays } from './BirthdayProvider';

export default function BirthdayMusic() {
  const { hasCelebration, isMusicPlaying } = useBirthdays();

  // Create a lightweight audio player for the local asset
  const player = useAudioPlayer(require('../assets/sounds/birthday_music.mp3'));

  // Configure global audio behavior once
  useEffect(() => {
    (async () => {
      try {
        await setAudioModeAsync({
          // iOS
          playsInSilentMode: true,
          allowsRecording: false,
          // Both
          shouldPlayInBackground: false,
          // Interruption handling
          interruptionMode: 'duckOthers', // iOS
          interruptionModeAndroid: 'duckOthers', // Android
          // Android routing
          shouldRouteThroughEarpiece: false,
        });
      } catch (e) {
        logger.warn('BirthdayMusic: failed to set audio mode', e);
      }
    })();
  }, []);

  // Keep player configured (loop + volume) and play/pause with state
  useEffect(() => {
    try {
      // Ensure desired playback settings
      if (player) {
        player.loop = true;
        player.volume = 0.45;
      }

      if (hasCelebration && isMusicPlaying) {
        player?.play();
      } else {
        player?.pause();
      }
    } catch (e) {
      logger.warn('BirthdayMusic: playback control error', e);
    }
  }, [player, hasCelebration, isMusicPlaying]);

  // useAudioPlayer cleans up automatically on unmount
  return null;
}
