import { logger } from '@/lib/logger';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { formatTodayKey, toMonthDay } from '../config/birthdays';
import { authService } from '../hooks/useAuthUnified';

type BirthdayCelebrant = {
  name: string;
  date: string; // MM-DD
  role?: string;
  subjects?: string[];
  salutation?: 'Mr.' | 'Ms.';
  email?: string;
  photoURL?: string;
  customImageURL?: string | null;
};

type BirthdayContextType = {
  todayKey: string;
  celebrants: BirthdayCelebrant[];
  hasCelebration: boolean;
  bannerDismissed: boolean;
  overlaySeen: boolean;
  openOverlay: () => void;
  // Music controls
  isMusicPlaying: boolean;
  setMusicPlaying: (v: boolean) => void;
  toggleMusic: () => void;
  // Poster modal & confetti
  isPosterOpen: boolean;
  openPoster: () => void;
  closePoster: () => void;
  confettiBurstKey: number;
  burstConfetti: () => void;
  // Celebrate flow loader to ensure UI/assets are ready before burst
  celebrateLoading: boolean;
  startCelebrate: () => Promise<void>;
  dismissBanner: () => void;
  markOverlaySeen: () => void;
  // Header compensation (pixels) to subtract from app header while banner is visible
  headerCompensation: number;
  setHeaderCompensation: (v: number) => void;
  // Page-level flags
  suppressFab: boolean;
  setSuppressFab: (v: boolean) => void;
  resetForDebug?: () => Promise<void>;
};

export const BirthdayContext = createContext<BirthdayContextType | undefined>(undefined);

export const useBirthdays = () => {
  const ctx = useContext(BirthdayContext);
  if (!ctx) throw new Error('useBirthdays must be used within BirthdayProvider');
  return ctx;
};

export function BirthdayProvider({ children }: { children: React.ReactNode }) {
  const [todayKey, setTodayKey] = useState(formatTodayKey());
  const [celebrants, setCelebrants] = useState<BirthdayCelebrant[]>([]);
  const hasCelebration = celebrants.length > 0;
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [overlaySeen, setOverlaySeen] = useState(false);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false); // default OFF: user must press Play
  const [isPosterOpen, setPosterOpen] = useState(false);
  const [confettiBurstKey, setConfettiBurstKey] = useState(0);
  const [headerCompensation, setHeaderCompensation] = useState(0);
  const [celebrateLoading, setCelebrateLoading] = useState(false);
  const [suppressFab, setSuppressFab] = useState(false);

  // roll date key at midnight
  useEffect(() => {
    const interval = setInterval(() => {
      const next = formatTodayKey();
      if (next !== todayKey) setTodayKey(next);
    }, 60_000); // check every minute
    return () => clearInterval(interval);
  }, [todayKey]);

  // Load celebrants from Firestore team members (authorizedEmails) using authService
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Prefer real-time list if available
        const members = await authService.forceRefreshTeamMembers();
        if (cancelled) return;
        const today = todayKey; // MM-DD
        const list: BirthdayCelebrant[] = (members || [])
          .filter((m) => !!m.dateOfBirth && !!toMonthDay(m.dateOfBirth))
          .map((m) => {
            const md = toMonthDay(m.dateOfBirth!);
            const baseName = (m.name || m.email.split('@')[0]).trim();
            const displayName = m.salutation ? `${m.salutation} ${baseName}` : baseName;
            return {
              name: displayName,
              date: md as string,
              role: m.role === 'admin' ? 'Administrator' : undefined,
              salutation: m.salutation,
              subjects: Array.isArray(m.subjects) ? m.subjects : undefined,
              email: m.email,
              photoURL: m.photoURL,
              customImageURL: m.customImageURL ?? null,
            } as BirthdayCelebrant;
          })
          .filter((x) => x.date === today);
        setCelebrants(list);
      } catch (e) {
        logger.warn('BirthdayProvider: failed to load celebrants from Firestore', e);
        setCelebrants([]);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [todayKey]);

  // Session-only: allow dismiss for current run, but never persist so it returns next app open
  const dismissBanner = () => setBannerDismissed(true);

  // Session-only: once closed, don't show again until app is reopened
  const markOverlaySeen = () => setOverlaySeen(true);
  const openOverlay = () => setOverlaySeen(false);

  const resetForDebug = async () => {
    setBannerDismissed(false);
    setOverlaySeen(false);
  };

  const openPoster = () => {
    logger.debug('BirthdayProvider: openPoster called');
    setPosterOpen(true);
  };
  const closePoster = () => {
    logger.debug('BirthdayProvider: closePoster called');
    setPosterOpen(false);
  };
  const burstConfetti = () => {
    logger.debug('BirthdayProvider: burstConfetti called, new key:', confettiBurstKey + 1);
    setConfettiBurstKey((k) => k + 1);
  };

  const startCelebrate = async () => {
    // Provide a small buffer so the app can finish rendering/loading heavy assets
    if (celebrateLoading) return;
    try {
      setCelebrateLoading(true);
      // Give a short window (600ms) to ensure UI mounts and assets resolve
      await new Promise((res) => setTimeout(res, 600));
      // Trigger confetti and open the poster while keeping the overlay visible
      // until the poster is successfully opened. This prevents the overlay
      // from closing early which caused visual glitches on slow-starting apps.
      burstConfetti();
      openPoster();
      // Once poster is open, consider the overlay seen for this session
      try {
        setOverlaySeen(true);
      } catch (e) {
        // swallow
      }
    } catch (e) {
      logger.error('startCelebrate failed', e);
    } finally {
      setCelebrateLoading(false);
    }
  };

  const value: BirthdayContextType = {
    todayKey,
    celebrants,
    hasCelebration,
    bannerDismissed,
    overlaySeen,
  openOverlay,
  isMusicPlaying,
  setMusicPlaying: setIsMusicPlaying,
  toggleMusic: () => setIsMusicPlaying((p) => !p),
  isPosterOpen,
  openPoster,
  closePoster,
  confettiBurstKey,
  burstConfetti,
  celebrateLoading,
  startCelebrate,
    dismissBanner,
    markOverlaySeen,
  headerCompensation,
  setHeaderCompensation,
  suppressFab,
  setSuppressFab,
  resetForDebug,
  };

  return <BirthdayContext.Provider value={value}>{children}</BirthdayContext.Provider>;
}
