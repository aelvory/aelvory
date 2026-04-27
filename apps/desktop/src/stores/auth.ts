import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { ensureLocalUser } from '@/localdb/seed';
import { tableGet, tablePut } from '@/localdb/generic';
import type { LUser } from '@/localdb/schema';

interface UserDto {
  id: string;
  email: string;
  displayName: string;
  publicKey?: string | null;
}

const LOCAL_SESSION_TOKEN = 'local-session';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserDto | null>(null);
  // Tokens kept for compatibility with existing code paths that read them.
  // In fully-local mode they're sentinel values — the dispatcher doesn't
  // check them.
  const accessToken = ref<string | null>(null);
  const refreshToken = ref<string | null>(null);
  const bootstrapError = ref<string | null>(null);
  const isLocalUser = ref<boolean>(true);

  const isAuthenticated = computed(() => !!user.value);

  async function ensureSession(): Promise<boolean> {
    bootstrapError.value = null;
    try {
      const u = await ensureLocalUser();
      user.value = {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        publicKey: u.publicKey,
      };
      accessToken.value = LOCAL_SESSION_TOKEN;
      refreshToken.value = LOCAL_SESSION_TOKEN;
      return true;
    } catch (err) {
      // Tauri plugin errors arrive as plain strings (not Error instances)
      // because they cross the JS<->Rust IPC boundary. Normalize so the
      // user sees something actionable instead of "local_db_unavailable".
      let msg: string;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else msg = JSON.stringify(err);
      bootstrapError.value = `local_db_unavailable: ${msg}`;
      console.error('[auth] ensureSession failed:', err);
      return false;
    }
  }

  async function updateDisplayName(name: string) {
    if (!user.value) return;
    const existing = await tableGet<LUser>('users', user.value.id);
    if (!existing) return;
    existing.displayName = name.trim() || existing.displayName;
    await tablePut('users', existing);
    user.value = {
      id: existing.id,
      email: existing.email,
      displayName: existing.displayName,
      publicKey: existing.publicKey,
    };
  }

  /**
   * No-op in local-first mode. The local identity + all data must survive
   * across app launches without surprise wipes. Kept for API compatibility
   * with older call sites; safe to call.
   */
  function logout() {
    /* no-op — stable desktop app: never wipe local state */
  }

  // Legacy stubs — kept so older call sites don't break. In local-only
  // mode they're no-ops (future: could hook into a sync endpoint).
  async function login(_email: string, _password: string) {
    await ensureSession();
  }
  async function register(_email: string, _password: string, _name: string) {
    await ensureSession();
  }
  async function tryRefresh(): Promise<boolean> {
    return true;
  }
  async function fetchMe() {
    /* no-op */
  }

  return {
    user,
    accessToken,
    refreshToken,
    isAuthenticated,
    isLocalUser,
    bootstrapError,
    ensureSession,
    updateDisplayName,
    logout,
    login,
    register,
    tryRefresh,
    fetchMe,
  };
});
