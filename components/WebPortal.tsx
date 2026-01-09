import React, { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { createPortal } from 'react-dom';

export default function WebPortal({
  children,
  active = true,
}: {
  children: React.ReactNode;
  active?: boolean;
}) {
  const [mounted, setMounted] = useState(false);

  const container = useMemo(() => {
    if (!active) {
      return null;
    }
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return null;
    }

    let el = document.getElementById('global-alert-portal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'global-alert-portal';
      // Highest practical z-index so alerts appear above any other overlays.
      el.style.position = 'fixed';
      el.style.inset = '0';
      el.style.zIndex = '2147483647';
      el.style.pointerEvents = 'none';
      document.body.appendChild(el);
    }

    return el;
  }, [active]);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!active) {
    return null;
  }

  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  if (!mounted || !container) {
    return null;
  }

  // Only mounted when active; wrapper intentionally spans viewport.
  return createPortal(<div style={{ pointerEvents: 'auto', height: '100%' }}>{children}</div>, container);
}
