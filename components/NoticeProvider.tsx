import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useNotices } from '../hooks/useNotices';
import { useAuth } from '../hooks/useAuthUnified';
import { Notice } from '../types/notice';
import NoticePopup from './NoticePopup';
import { useBirthdays } from './BirthdayProvider';
import { inviteOverlayStore } from '../lib/inviteOverlayStore';

interface NoticeContextType {
  showNoticeModal: () => void;
}

const NoticeContext = createContext<NoticeContextType | undefined>(undefined);

export const useNoticeContext = () => {
  const context = useContext(NoticeContext);
  if (!context) {
    throw new Error('useNoticeContext must be used within a NoticeProvider');
  }
  return context;
};

interface NoticeProviderProps {
  children: ReactNode;
  enabled?: boolean;
}

export const NoticeProvider: React.FC<NoticeProviderProps> = ({ children, enabled = true }) => {
  const { user } = useAuth();
  const { getPendingNotices, markNoticeAsViewed, loading } = useNotices();
  const [pendingNotices, setPendingNotices] = useState<Notice[]>([]);
  const [showPopup, setShowPopup] = useState(false);
  const [hasCheckedOnStartup, setHasCheckedOnStartup] = useState(false);
  const [isCheckingNotices, setIsCheckingNotices] = useState(false);
  const [isAppFullyLoaded, setIsAppFullyLoaded] = useState(false);
  const { overlaySeen, isPosterOpen, celebrants, hasCelebration } = useBirthdays();
  const [inviteOverlayActive, setInviteOverlayActive] = useState<boolean>(() => Boolean(inviteOverlayStore.getToken()));

  const isMyBirthday = useMemo(() => {
    if (!user?.email) return false;
    const userEmail = user.email.toLowerCase();
    return celebrants.some((c) => (c.email || '').toLowerCase() === userEmail);
  }, [user?.email, celebrants]);

  const isBirthdayOverlayOpen = useMemo(() => {
    if (!hasCelebration) return false;
    if (!isMyBirthday) return false;
    return !overlaySeen;
  }, [hasCelebration, isMyBirthday, overlaySeen]);

  const noticeBlockedByBirthdayFlow = isBirthdayOverlayOpen || isPosterOpen;
  const modalBlocked = noticeBlockedByBirthdayFlow || inviteOverlayActive;

  useEffect(() => {
    const unsubscribe = inviteOverlayStore.subscribe((token) => {
      setInviteOverlayActive(Boolean(token));
    });
    return unsubscribe;
  }, []);

  // Check for pending notices on app startup only
  const checkPendingNotices = useCallback(() => {
    if (!enabled || !user || loading || !isAppFullyLoaded || hasCheckedOnStartup || showPopup || isCheckingNotices) {
      return;
    }

    setIsCheckingNotices(true);
    
    const pending = getPendingNotices();
    
    if (pending.length > 0) {
      setPendingNotices(pending);
      if (!modalBlocked) {
        setShowPopup(true);
      }
    }
    
    // Mark that we've checked on this startup (regardless of whether notices were found)
    setHasCheckedOnStartup(true);
    setIsCheckingNotices(false);
  }, [
    user,
    loading,
    getPendingNotices,
    hasCheckedOnStartup,
    showPopup,
    isCheckingNotices,
    isAppFullyLoaded,
    modalBlocked,
  ]);

  // Handle app state changes (disabled - only show on true startup)
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      // Completely disabled app state notice checks - only show on app startup
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [user, hasCheckedOnStartup]);

  // Reset check flag when user changes (logout/login)
  useEffect(() => {
    if (!enabled) {
      // If disabled, ensure we never show notice UI on non-dashboard routes.
      setShowPopup(false);
      setPendingNotices([]);
      return;
    }

    if (!user) {
      setHasCheckedOnStartup(false);
      setShowPopup(false);
      setPendingNotices([]);
      setIsCheckingNotices(false);
      setIsAppFullyLoaded(false);
    }
  }, [enabled, user]);

  // Check pending notices when loading completes and app is fully ready
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!loading && user && !hasCheckedOnStartup && !isCheckingNotices) {
      setTimeout(() => {
        setIsAppFullyLoaded(true);
      }, 2000); // Wait 2 seconds to ensure app is fully interactive
    }
  }, [enabled, loading, user, hasCheckedOnStartup, isCheckingNotices]);

  // Check notices when app is fully loaded
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (isAppFullyLoaded && !hasCheckedOnStartup && !showPopup) {
      setTimeout(() => {
        // Double-check conditions before executing
        if (!hasCheckedOnStartup && !showPopup) {
          checkPendingNotices();
        }
      }, 500); // Small additional delay for final check
    }
  }, [enabled, isAppFullyLoaded, hasCheckedOnStartup, showPopup, checkPendingNotices]);

  // Removed backup check - only show notices on startup

  const handleClosePopup = async () => {
    // Don't mark notices as viewed here - let NoticePopup handle it
    // This way only actually viewed notices get marked, not skipped ones
    setShowPopup(false);
    setPendingNotices([]);
  };

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!modalBlocked && pendingNotices.length > 0 && !showPopup) {
      setShowPopup(true);
    }
  }, [enabled, modalBlocked, pendingNotices.length, showPopup]);

  const showNoticeModal = () => {
    // This will be handled by the dashboard component
    // Just providing the context interface
  };

  const noticeVisible = enabled && showPopup && !modalBlocked;

  return (
    <NoticeContext.Provider value={{ showNoticeModal }}>
      {children}
      <NoticePopup
        visible={noticeVisible}
        onClose={handleClosePopup}
        notices={pendingNotices}
      />
    </NoticeContext.Provider>
  );
};
