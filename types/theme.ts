export interface ThemeColors {
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
  primary: string;
  border: string;
  error: string;
  success: string;
  warning: string;
  card: string;
  tabBar: string;
  tabBarActive: string;
  tabBarInactive: string;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeContextType {
  theme: ThemeColors;
  isDarkMode: boolean;
  themeMode: ThemeMode;
  toggleTheme: () => void;
  setDarkMode: (isDark: boolean) => void;
  setThemeMode: (mode: ThemeMode) => void;
}

export const lightTheme: ThemeColors = {
  background: '#f8fafc',
  surface: '#ffffff',
  text: '#1e293b',
  textSecondary: '#64748b',
  primary: '#6366f1',
  border: '#e2e8f0',
  error: '#ef4444',
  success: '#10b981',
  warning: '#f59e0b',
  card: '#ffffff',
  tabBar: '#ffffff',
  tabBarActive: '#6366f1',
  tabBarInactive: '#64748b',
};

export const darkTheme: ThemeColors = {
  background: '#0f172a',
  surface: '#1e293b',
  text: '#f1f5f9',
  textSecondary: '#94a3b8',
  primary: '#6366f1',
  border: '#334155',
  error: '#ef4444',
  success: '#10b981',
  warning: '#f59e0b',
  card: '#1e293b',
  tabBar: '#1e293b',
  tabBarActive: '#6366f1',
  tabBarInactive: '#94a3b8',
};
