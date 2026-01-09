import { logger } from '@/lib/logger';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
// Internal token manager for short‑lived backend-issued tokens.
// Updated to use secure Firebase ID token -> /auth/bridge exchange for production.
// Dev fallback: if EXPO_PUBLIC_INTERNAL_TOKEN_DEV_SECRET is set we still hit /internal/auth/issue
// (ONLY for local development). Never ship that dev secret in production builds.
// The bridge endpoint returns { token, expiresIn?, expiresAt? }.
// We compute expiresAt if only expiresIn provided and refresh slightly early.

// Strategy precedence:
// 1. If dev secret present (EXPO_PUBLIC_INTERNAL_TOKEN_DEV_SECRET) use legacy /internal/auth/issue.
// 2. Else if Firebase user signed in, obtain ID token and POST to /auth/bridge with both Authorization
//    bearer and body { firebaseIdToken } for forward/backward compatibility.
// 3. Else: cannot obtain internal token yet (user not authenticated) -> return undefined.

// This module purposefully does NOT import heavy Firebase modules synchronously at bundle time in web
// environments that tree-shake; we lazily import the auth instance from config/firebase.

// Edge cases handled:
// - Concurrent refresh calls collapse into single network call.
// - Expiry skew: refresh 10s before actual expiry.
// - Network / server failure returns undefined (caller can attempt again or surface auth error).

import { auth as firebaseAuth } from '../config/firebase';

interface IssueResponse { token: string; expiresIn?: number; expiresAt?: number }

class InternalTokenManager {
  // Default base URL for backwards compatibility when callers don't pass one
  private defaultBaseUrl?: string;
  // Per-base cache and single-flight state
  private cache = new Map<string, { current?: { token: string; expiresAt: number }; refreshing?: Promise<string | undefined> }>();
  private debug = (process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true');
  private log(...args:any[]){ if(this.debug) logger.debug('[auth-debug]', ...args); }

  setBaseUrl(url: string) { this.defaultBaseUrl = url; }

  private isValid(entry?: { token: string; expiresAt: number }) {
    if (!entry) return false;
    // Refresh a little early (10s skew) to avoid race near expiry
    return Date.now() + 10000 < entry.expiresAt;
  }

  async getToken(baseUrl?: string): Promise<string | undefined> {
    const base = baseUrl || this.defaultBaseUrl;
    if (!base) return undefined;
    const slot = this.cache.get(base);
    if (slot && this.isValid(slot.current)) return slot.current!.token;
    return await this.refresh(base);
  }

  // Explicitly drop the cached token (e.g., after a 401) so the next call re-mints it
  invalidate(baseUrl?: string) {
    const base = baseUrl || this.defaultBaseUrl;
    this.log('invalidate called');
    if (base) this.cache.delete(base);
  }

  // Allow callers to request a fresh token even if one is cached (rarely needed)
  async forceRefresh(baseUrl?: string): Promise<string | undefined> {
    const base = baseUrl || this.defaultBaseUrl;
    if (!base) return undefined;
    this.invalidate(base);
    return await this.refresh(base);
  }

  private async refresh(baseUrl: string): Promise<string | undefined> {
    this.log('refresh start', { baseUrl });
    // single-flight per base
    const existing = this.cache.get(baseUrl)?.refreshing;
    if (existing) return await existing;
    const flight = (async () => {
      try {
      const devSecret = (process.env.EXPO_PUBLIC_INTERNAL_TOKEN_DEV_SECRET || '').trim();

      let data: IssueResponse | undefined;

      if (devSecret) {
        // Legacy dev flow
        this.log('using dev secret flow');
        const headers: Record<string,string> = { 'X-Internal-Secret': devSecret };
        const res = await fetch(`${baseUrl}/internal/auth/issue`, { method: 'POST', headers });
        this.log('dev issue status', res.status);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          maybeShowMaintenanceAlertFromRaw(res.status, text);
          return undefined;
        }
        data = await res.json();
      } else {
        // Production flow via Firebase ID token bridge using imported firebaseAuth.
        // Wait for user to be available (up to ~3s) with short polling
        let user = firebaseAuth?.currentUser;
        if (!user) {
          this.log('no currentUser, waiting for auth state');
          user = await new Promise<any | undefined>(resolve => {
            let settled = false;
            try {
              const unsub = (firebaseAuth as any)?.onAuthStateChanged?.((u: any) => {
                if (!settled) { settled = true; unsub && unsub(); resolve(u || undefined); }
              });
            } catch { /* ignore */ }
            setTimeout(()=>{ if(!settled){ settled = true; resolve(undefined); } }, 2000);
          });
          // If still undefined, try a simple poll loop for another 1s
          if(!user){ for(let i=0;i<10;i++){ await new Promise(r=>setTimeout(r,100)); if(firebaseAuth?.currentUser){ user=firebaseAuth.currentUser; break; } } }
        }
        if (!user){ this.log('no currentUser after extended wait'); return undefined; }
        let idToken = await user.getIdToken(/* forceRefresh */ false);
        if(!idToken){ this.log('empty idToken'); return undefined; }
        this.log('got idToken', { len: idToken.length, email: user.email });
        let headers: Record<string,string> = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` };
        let body = JSON.stringify({ firebaseIdToken: idToken });
        let res = await fetch(`${baseUrl}/auth/bridge`, { method: 'POST', headers, body });
        this.log('bridge status', res.status);
        if(!res.ok){
          try {
            const txt = await res.text();
            maybeShowMaintenanceAlertFromRaw(res.status, txt);
            this.log('bridge body', txt.slice(0,200));
          } catch {}
        }
        if (!res.ok) {
          // Try once more with a forced token refresh
          this.log('bridge retry with forced token refresh');
          try { idToken = await user.getIdToken(true); } catch {}
          headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` };
          body = JSON.stringify({ firebaseIdToken: idToken });
          res = await fetch(`${baseUrl}/auth/bridge`, { method: 'POST', headers, body });
          this.log('bridge status (retry)', res.status);
          if(!res.ok) {
            const txt = await res.text().catch(() => '');
            maybeShowMaintenanceAlertFromRaw(res.status, txt);
            return undefined;
          }
        }
        data = await res.json();
      }

      if (!data) return undefined;
      const expiresAt = data.expiresAt || (data.expiresIn ? Date.now() + data.expiresIn * 1000 : Date.now() + 240000);
      const slot = this.cache.get(baseUrl) || {};
      slot.current = { token: data.token, expiresAt };
      this.cache.set(baseUrl, slot);
      this.log('token acquired', { ttlMs: expiresAt-Date.now(), baseUrl });
      return slot.current.token;
    } catch {
      this.log('refresh exception');
      return undefined;
    } finally {
      const slot = this.cache.get(baseUrl) || {};
      delete slot.refreshing;
      this.cache.set(baseUrl, slot);
      this.log('refresh end');
    }
    })();
    const slot = this.cache.get(baseUrl) || {};
    slot.refreshing = flight;
    this.cache.set(baseUrl, slot);
    return await flight;
  }
}

export const internalTokenManager = new InternalTokenManager();
