/**
 * Auth store for the admin SPA. Persists the bearer token in
 * localStorage so a refresh keeps the session, and decodes the JWT to
 * pull the user's id + display name without an extra `/api/auth/me`
 * round-trip.
 *
 * Sign-in / sign-up POST directly to the API (no `useApi` because it
 * needs to set the token from the response). After that, every request
 * goes through the api() helper which reads the token from this store.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

const STORAGE_KEY = 'aelvory.web.auth';
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

interface PersistedAuth {
  accessToken: string | null;
  refreshToken: string | null;
  email: string | null;
  displayName: string | null;
  userId: string | null;
}

const DEFAULT: PersistedAuth = {
  accessToken: null,
  refreshToken: null,
  email: null,
  displayName: null,
  userId: null,
};

function loadPersisted(): PersistedAuth {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT, ...(JSON.parse(raw) as object) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT };
}

interface JwtClaims {
  sub?: string;
  email?: string;
  name?: string;
  unique_name?: string;
  display_name?: string;
}

function decodeJwt(token: string): JwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as JwtClaims;
  } catch {
    return null;
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const useAuthStore = defineStore('auth', () => {
  const initial = loadPersisted();

  const accessToken = ref<string | null>(initial.accessToken);
  const refreshToken = ref<string | null>(initial.refreshToken);
  const email = ref<string | null>(initial.email);
  const displayName = ref<string | null>(initial.displayName);
  const userId = ref<string | null>(initial.userId);

  const isAuthenticated = computed(() => !!accessToken.value);

  function persist() {
    try {
      const state: PersistedAuth = {
        accessToken: accessToken.value,
        refreshToken: refreshToken.value,
        email: email.value,
        displayName: displayName.value,
        userId: userId.value,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  function setTokens(res: TokenResponse, fallbackEmail: string, fallbackName?: string) {
    accessToken.value = res.accessToken;
    refreshToken.value = res.refreshToken;
    const claims = decodeJwt(res.accessToken);
    const newUserId = claims?.sub ?? null;
    // If a previous session left tokens behind for a *different* user
    // and we never went through signOut, the orgs-store's persisted
    // "current org" still belongs to that user. Clear it on identity
    // change so the next page load doesn't redirect into a 403.
    if (userId.value && newUserId && userId.value !== newUserId) {
      try {
        localStorage.removeItem('aelvory.web.currentOrg');
      } catch {
        /* ignore */
      }
    }
    userId.value = newUserId;
    email.value = claims?.email ?? fallbackEmail;
    displayName.value =
      claims?.name ?? claims?.display_name ?? claims?.unique_name ?? fallbackName ?? fallbackEmail;
    persist();
  }

  async function signIn(emailVal: string, password: string): Promise<void> {
    const trimmed = emailVal.trim();
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: trimmed, password }),
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* */
      }
      const error = (body as { error?: string } | null)?.error ?? 'sign_in_failed';
      throw new Error(error);
    }
    const tokens = (await res.json()) as TokenResponse;
    setTokens(tokens, trimmed);
  }

  async function signUp(emailVal: string, password: string, name: string): Promise<void> {
    const trimmed = emailVal.trim();
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: trimmed, password, displayName: name }),
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* */
      }
      const error = (body as { error?: string } | null)?.error ?? 'sign_up_failed';
      throw new Error(error);
    }
    const tokens = (await res.json()) as TokenResponse;
    setTokens(tokens, trimmed, name);
  }

  /**
   * Attempt a refresh-token round-trip. Returns true on success. The
   * api() helper calls this once on a 401 before giving up and signing
   * the user out.
   */
  async function tryRefresh(): Promise<boolean> {
    if (!refreshToken.value) return false;
    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken.value }),
      });
      if (!res.ok) return false;
      const tokens = (await res.json()) as TokenResponse;
      accessToken.value = tokens.accessToken;
      refreshToken.value = tokens.refreshToken;
      persist();
      return true;
    } catch {
      return false;
    }
  }

  function signOut(): void {
    accessToken.value = null;
    refreshToken.value = null;
    email.value = null;
    displayName.value = null;
    userId.value = null;
    persist();
    // Drop the orgs-store's persisted "last selected org" too — if the
    // next sign-in is a different account (or this same account after
    // a server-side reset wiped the org), inheriting the stale id
    // would 403 on the very first /members call. The orgs store
    // itself reads this key at init, so removing it here is enough
    // to stop the next session from picking it up.
    try {
      localStorage.removeItem('aelvory.web.currentOrg');
    } catch {
      /* ignore */
    }
  }

  return {
    accessToken,
    refreshToken,
    email,
    displayName,
    userId,
    isAuthenticated,
    signIn,
    signUp,
    tryRefresh,
    signOut,
  };
});
