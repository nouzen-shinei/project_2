import { logger } from '@/lib/logger';
import React, { createContext, useState, useEffect } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeContextType, ThemeMode, lightTheme, darkTheme } from '../types/theme';

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: React.ReactNode;
}

const LIGHT_THEME_COLOR = '#ffffff';
const DARK_THEME_COLOR = '#1e293b';
const THEME_MEDIA_LIGHT = '(prefers-color-scheme: light)';
const THEME_MEDIA_DARK = '(prefers-color-scheme: dark)';

function upsertThemeColorMeta(content: string, media?: string) {
  if (typeof document === 'undefined') return;
  const selector = media
    ? `meta[name="theme-color"][media="${media}"]`
    : 'meta[name="theme-color"]:not([media])';
  const existing = document.head?.querySelector(selector) as HTMLMetaElement | null;
  const el = existing || document.createElement('meta');
  el.setAttribute('name', 'theme-color');
  if (media) {
    el.setAttribute('media', media);
  } else {
    el.removeAttribute('media');
  }
  el.setAttribute('content', content);
  if (!existing) document.head?.appendChild(el);
}

function removeThemeColorMediaMetas() {
  if (typeof document === 'undefined') return;
  const metas = document.head?.querySelectorAll('meta[name="theme-color"][media]');
  if (!metas) return;
  metas.forEach((meta) => {
    try {
      meta.remove();
    } catch {
      // ignore
    }
  });
}

function applyWebThemeColor(themeMode: ThemeMode, isDarkMode: boolean) {
  if (typeof document === 'undefined') return;

  const activeColor = isDarkMode ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  upsertThemeColorMeta(activeColor);

  if (themeMode === 'system') {
    upsertThemeColorMeta(LIGHT_THEME_COLOR, THEME_MEDIA_LIGHT);
    upsertThemeColorMeta(DARK_THEME_COLOR, THEME_MEDIA_DARK);
  } else {
    // Explicit app theme should win over system preference on web.
    removeThemeColorMediaMetas();
  }
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const systemColorScheme = useColorScheme();

  useEffect(() => {
    loadTheme();
  }, []);

  useEffect(() => {
    // Update isDarkMode based on themeMode
    if (themeMode === 'system') {
      setIsDarkMode(systemColorScheme === 'dark');
    } else {
      setIsDarkMode(themeMode === 'dark');
    }
  }, [themeMode, systemColorScheme]);

  // For web, reflect the current mode by toggling the `dark` class on the document element.
  // This ensures Tailwind/NativeWind "dark:" variants and CSS variables respond to the selected mode.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      if (isDarkMode) {
        root.classList.add('dark');
        root.style.colorScheme = 'dark';
      } else {
        root.classList.remove('dark');
        root.style.colorScheme = 'light';
      }

      applyWebThemeColor(themeMode, isDarkMode);
    }
  }, [themeMode, isDarkMode]);

  const loadTheme = async () => {
    try {
      const savedThemeMode = await AsyncStorage.getItem('themeMode');
      if (savedThemeMode && ['light', 'dark', 'system'].includes(savedThemeMode)) {
        setThemeModeState(savedThemeMode as ThemeMode);
      } else {
        // Migrate from old theme setting
        const savedTheme = await AsyncStorage.getItem('theme');
        if (savedTheme === 'dark') {
          setThemeModeState('dark');
        } else if (savedTheme === 'light') {
          setThemeModeState('light');
        } else {
          setThemeModeState('system');
        }
        // Clean up old setting
        await AsyncStorage.removeItem('theme');
      }
    } catch (error) {
      logger.error('Error loading theme:', error);
    }
  };

  const toggleTheme = async () => {
    const newMode: ThemeMode = themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light';
    await setThemeMode(newMode);
  };

  const setDarkMode = async (isDark: boolean) => {
    const newMode: ThemeMode = isDark ? 'dark' : 'light';
    await setThemeMode(newMode);
  };

  const setThemeMode = async (mode: ThemeMode) => {
    setThemeModeState(mode);
    try {
      await AsyncStorage.setItem('themeMode', mode);
    } catch (error) {
      logger.error('Error saving theme mode:', error);
    }
  };

  const themeData = {
    isDarkMode,
    theme: isDarkMode ? darkTheme : lightTheme,
    themeMode,
    toggleTheme,
    setDarkMode,
    setThemeMode,
  };

  return (
    <ThemeContext.Provider value={themeData}>
      {children}
    </ThemeContext.Provider>
  );
}