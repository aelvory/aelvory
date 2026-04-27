/**
 * Cross-cutting UI state that more than one component (or the native
 * menu) needs to read or toggle:
 *
 *   - Dialog visibility (settings, import, about). These used to be
 *     local refs scattered across components, but the native menu now
 *     wants to open them too — easier with one store than 5 prop chains.
 *   - Sidebar collapsed state.
 *   - Webview zoom factor.
 *
 * Sidebar + zoom are persisted to `localStorage`; dialogs are session-only.
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

const STORAGE_KEY = 'aelvory.ui';

interface PersistedUi {
  sidebarCollapsed: boolean;
  zoom: number;
}

const DEFAULTS: PersistedUi = {
  sidebarCollapsed: false,
  zoom: 1.0,
};

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

function load(): PersistedUi {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedUi>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function applyZoom(z: number) {
  if (typeof document === 'undefined') return;
  // CSS `zoom` works in Chromium-based webviews (Tauri on Windows /
  // macOS uses WebView2 / WKWebView; Linux's webkit2gtk has weaker
  // support but doesn't error). Modern enough for our user base.
  (document.documentElement.style as unknown as { zoom: string }).zoom = String(z);
}

export const useUiStore = defineStore('ui', () => {
  const initial = load();

  const sidebarCollapsed = ref<boolean>(initial.sidebarCollapsed);
  const zoom = ref<number>(initial.zoom);

  // Session-only dialog flags. Components bind their visibility models
  // here so the menu (or any future caller) can flip them.
  const settingsOpen = ref(false);
  const importOpen = ref(false);
  const aboutOpen = ref(false);

  /**
   * Optional preload for the import dialog. When the VSCode
   * extension's "Open in Aelvory" command (or the desktop's drag-
   * drop handler in a future iteration) wants to feed file content
   * straight in, it sets this and flips `importOpen`. ImportDialog
   * watches and pre-fills tab + textarea on open. Cleared by the
   * dialog's `close()` so a manual reopen starts blank.
   */
  const importPreload = ref<{
    content: string;
    format: 'openapi' | 'postman' | 'insomnia' | 'har';
    filename?: string;
  } | null>(null);

  function openImportWith(payload: {
    content: string;
    format: 'openapi' | 'postman' | 'insomnia' | 'har';
    filename?: string;
  }) {
    importPreload.value = payload;
    importOpen.value = true;
  }

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sidebarCollapsed: sidebarCollapsed.value,
          zoom: zoom.value,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  watch([sidebarCollapsed, zoom], () => {
    persist();
    applyZoom(zoom.value);
  });

  // Apply persisted zoom on init (the watch above doesn't run for the
  // initial value).
  applyZoom(zoom.value);

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  function zoomIn() {
    zoom.value = Math.round(clamp(zoom.value + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
  }

  function zoomOut() {
    zoom.value = Math.round(clamp(zoom.value - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
  }

  function zoomReset() {
    zoom.value = 1.0;
  }

  function openSettings() {
    settingsOpen.value = true;
  }
  function openImport() {
    importOpen.value = true;
  }
  function openAbout() {
    aboutOpen.value = true;
  }

  return {
    sidebarCollapsed,
    zoom,
    settingsOpen,
    importOpen,
    importPreload,
    aboutOpen,
    toggleSidebar,
    zoomIn,
    zoomOut,
    zoomReset,
    openSettings,
    openImport,
    openImportWith,
    openAbout,
  };
});
