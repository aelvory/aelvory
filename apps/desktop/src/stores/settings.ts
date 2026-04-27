import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { applyLocaleFromSettings, isSupportedLocale, type Locale } from '@/i18n';
import { setThemeOverride } from '@/composables/theme';

const STORAGE_KEY = 'aelvory.settings';

/**
 * Theme override:
 *   - 'auto' → follow the host (VSCode body class first, then the OS
 *     `prefers-color-scheme`). Default.
 *   - 'light' / 'dark' → force the picked mode regardless of host.
 *
 * The composables/theme.ts tracker reads this and short-circuits the
 * auto-detection when a manual override is set.
 */
export type ThemeMode = 'auto' | 'light' | 'dark';

interface SettingsData {
  userAgent: string;
  timeoutMs: number;
  /** Sync server base URL (no trailing slash). Empty = "use the build-time default". */
  syncServerUrl: string;
  /**
   * UI language. Empty string = follow OS / browser language. Otherwise
   * one of the supported locale codes from @aelvory/i18n.
   */
  language: Locale | '';
  /** Light/dark/auto override. See ThemeMode for semantics. */
  themeMode: ThemeMode;
  /**
   * Skip TLS certificate verification on outgoing HTTP/WS requests.
   * Useful for local development against self-signed certs or
   * corporate CAs that aren't installed on the user's machine.
   *
   * Only honored in Tauri (via plugin-http's `danger.acceptInvalidCerts`)
   * and inside the VSCode extension host (via an undici Agent with
   * `rejectUnauthorized: false`). Bare-browser fetch always verifies
   * — there's no JS-level escape from that.
   *
   * Big footgun if left on against production: man-in-the-middle
   * attacks become invisible. We surface a prominent warning in the
   * Settings UI and never default this to true.
   */
  ignoreCerts: boolean;
}

/**
 * Build-time default for the sync URL. Resolution order:
 *   1. VITE_SYNC_URL          — explicit override at build time
 *   2. VITE_API_BASE_URL      — historical fallback
 *   3. https://eu.aelvory.com — production default for shipped builds
 *
 * The user can override at runtime via the Settings dialog (persisted
 * in localStorage); the runtime value always wins when set.
 *
 * Dev contributors who want to point at a local server pass
 * `VITE_SYNC_URL=http://localhost:5000` in their env (or .env.local) —
 * we don't auto-detect dev mode here because the runtime override is
 * the user-facing knob anyway.
 */
const ENV_DEFAULT_SYNC_URL =
  ((import.meta.env.VITE_SYNC_URL as string | undefined) ||
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
    'https://eu.aelvory.com') as string;

const DEFAULTS: SettingsData = {
  userAgent: 'Aelvory/0.0.3',
  timeoutMs: 60_000,
  syncServerUrl: '',
  language: '',
  themeMode: 'auto',
  ignoreCerts: false,
};

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'auto' || v === 'light' || v === 'dark';
}

function load(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SettingsData>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

/**
 * Strip whitespace and any trailing slashes. We don't validate scheme/host
 * here — the call site does at usage time and degrades to the env default
 * if the user typed garbage.
 */
function normalizeUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export const useSettingsStore = defineStore('settings', () => {
  const initial = load();
  const userAgent = ref<string>(initial.userAgent);
  const timeoutMs = ref<number>(initial.timeoutMs);
  const syncServerUrl = ref<string>(initial.syncServerUrl);
  // Sanitize stored value — drop unsupported codes that may have been
  // persisted by an older build.
  const language = ref<Locale | ''>(
    isSupportedLocale(initial.language) ? initial.language : '',
  );
  const themeMode = ref<ThemeMode>(
    isThemeMode(initial.themeMode) ? initial.themeMode : 'auto',
  );
  const ignoreCerts = ref<boolean>(initial.ignoreCerts === true);

  // Apply the active locale once at boot. The watcher below keeps it
  // in sync if the user changes the picker.
  applyLocaleFromSettings(language.value || null);

  // Push the persisted theme override into the tracker on boot, then
  // again on every change. The tracker handles the 'auto' case by
  // falling back to host detection (VSCode body class / prefers-color-scheme).
  setThemeOverride(themeMode.value);
  watch(themeMode, (next) => setThemeOverride(next));

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          userAgent: userAgent.value,
          timeoutMs: timeoutMs.value,
          syncServerUrl: syncServerUrl.value,
          language: language.value,
          themeMode: themeMode.value,
          ignoreCerts: ignoreCerts.value,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  watch(
    [userAgent, timeoutMs, syncServerUrl, language, themeMode, ignoreCerts],
    persist,
  );

  watch(language, (next) => {
    applyLocaleFromSettings(next || null);
  });

  function resetDefaults() {
    userAgent.value = DEFAULTS.userAgent;
    timeoutMs.value = DEFAULTS.timeoutMs;
    syncServerUrl.value = DEFAULTS.syncServerUrl;
    language.value = DEFAULTS.language;
    themeMode.value = DEFAULTS.themeMode;
    ignoreCerts.value = DEFAULTS.ignoreCerts;
  }

  /**
   * The URL the sync client should actually hit, considering both the
   * user override and the build-time default. Returns a string with no
   * trailing slash. Pure (no side effects).
   */
  function effectiveSyncUrl(): string {
    const override = normalizeUrl(syncServerUrl.value);
    if (override) return override;
    return normalizeUrl(ENV_DEFAULT_SYNC_URL);
  }

  /**
   * Set the user-facing override. Empty string clears it (back to env
   * default). Returns true if the effective URL changed as a result.
   */
  function setSyncServerUrl(input: string): boolean {
    const before = effectiveSyncUrl();
    syncServerUrl.value = normalizeUrl(input);
    return effectiveSyncUrl() !== before;
  }

  return {
    userAgent,
    timeoutMs,
    syncServerUrl,
    language,
    themeMode,
    ignoreCerts,
    resetDefaults,
    setSyncServerUrl,
    effectiveSyncUrl,
    defaults: { ...DEFAULTS, envSyncUrl: normalizeUrl(ENV_DEFAULT_SYNC_URL) },
  };
});
