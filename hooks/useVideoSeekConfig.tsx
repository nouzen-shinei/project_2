import React, { createContext, useContext, useMemo } from 'react';

type VideoSeekConfig = {
  seekStepSeconds: number;
};

export const DEFAULT_SEEK_STEP_SECONDS = 10;

const VideoSeekConfigContext = createContext<VideoSeekConfig | undefined>(undefined);

export const useVideoSeekConfig = () => {
  const context = useContext(VideoSeekConfigContext);
  if (context) {
    return context;
  }
  return { seekStepSeconds: DEFAULT_SEEK_STEP_SECONDS };
};

interface VideoSeekProviderProps {
  children: React.ReactNode;
  seekStepSeconds?: number;
}

export const VideoSeekProvider = ({ children, seekStepSeconds }: VideoSeekProviderProps) => {
  const value = useMemo(() => {
    const resolved = Number.isFinite(seekStepSeconds ?? DEFAULT_SEEK_STEP_SECONDS)
      ? (seekStepSeconds ?? DEFAULT_SEEK_STEP_SECONDS)
      : DEFAULT_SEEK_STEP_SECONDS;
    return { seekStepSeconds: resolved };
  }, [seekStepSeconds]);

  return <VideoSeekConfigContext.Provider value={value}>{children}</VideoSeekConfigContext.Provider>;
};
