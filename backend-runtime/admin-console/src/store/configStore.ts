import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AuthMode = 'auto' | 'token' | 'master' | 'none';

export interface ConfigState {
  baseUrl: string;
  masterKey: string;
  bearerToken: string;
  rememberSecret: boolean;
  lastIssuedTokenExpiry?: number;
  setBaseUrl: (url: string) => void;
  setMasterKey: (secret: string) => void;
  setBearerToken: (token: string, expiresAt?: number) => void;
  setRememberSecret: (remember: boolean) => void;
  resetState: () => void;
}

const storeName = 'backend-runtime-console';

export const useConfigStore = create<ConfigState>()(
  persist<ConfigState, [], [], Partial<ConfigState>>(
    (set) => ({
      baseUrl: '',
      masterKey: '',
      bearerToken: '',
      rememberSecret: false,
      lastIssuedTokenExpiry: undefined,
      setBaseUrl: (baseUrl: string) => set({ baseUrl }),
      setMasterKey: (masterKey: string) => set({ masterKey }),
      setBearerToken: (bearerToken: string, expiresAt?: number) =>
        set({ bearerToken, lastIssuedTokenExpiry: expiresAt }),
      setRememberSecret: (rememberSecret: boolean) =>
        set({ rememberSecret, ...(rememberSecret ? {} : { masterKey: '' }) }),
      resetState: () => set({ baseUrl: '', masterKey: '', bearerToken: '', rememberSecret: false, lastIssuedTokenExpiry: undefined }),
    }),
    {
      name: storeName,
      partialize: (state: ConfigState) => ({
        baseUrl: state.baseUrl,
        bearerToken: state.bearerToken,
        rememberSecret: state.rememberSecret,
        lastIssuedTokenExpiry: state.lastIssuedTokenExpiry,
        ...(state.rememberSecret ? { masterKey: state.masterKey } : {}),
      }),
    },
  ),
);

export function resolveBaseUrl(): string {
  const candidate = useConfigStore.getState().baseUrl.trim();
  if (!candidate) {
    throw new Error('Set a backend URL first');
  }
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    return candidate.replace(/\/$/, '');
  }
  return `https://${candidate.replace(/\/$/, '')}`;
}

export function resolveAuthHeader(preferred: AuthMode = 'auto'): string | null {
  const { bearerToken, masterKey } = useConfigStore.getState();
  if (preferred === 'none') {
    return null;
  }
  if (preferred === 'token') {
    return bearerToken ? `Bearer ${bearerToken}` : null;
  }
  if (preferred === 'master') {
    return masterKey ? `Bearer ${masterKey}` : null;
  }
  if (masterKey) {
    return `Bearer ${masterKey}`;
  }
  if (bearerToken) {
    return `Bearer ${bearerToken}`;
  }
  return null;
}
