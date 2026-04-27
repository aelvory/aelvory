import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import Aura from '@primevue/themes/aura';
import 'primeicons/primeicons.css';

import App from './App.vue';
import { router } from './router';
import { getDb } from './localdb/db';
import { i18n } from './i18n';
import { installThemeTracker } from './composables/theme';

// Add `.dark` to <html> when the host (VSCode webview class or OS
// `prefers-color-scheme`) is in dark mode. PrimeVue's
// darkModeSelector picks it up; component CSS can too. Done before
// createApp so the very first paint already has the right palette
// — no flash of light theme on dark VSCode.
installThemeTracker();

// Kick off DB init early so migrations + Dexie import happen before the user
// can fire a request. We don't await — `getDb()` is idempotent and any handler
// that needs it will await the same promise. Errors surface in the console.
getDb().catch((err) => {
  console.error('[startup] DB init failed:', err);
});

// Best-effort: ask the OS for "persistent" storage so the IndexedDB-backed
// localStorage flag and Tauri's app-data SQLite file aren't evicted under
// pressure. Browsers gate this behind user engagement; Tauri grants it.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}

const app = createApp(App);
app.use(createPinia());
// i18n must be installed after Pinia (the locale watcher in the settings
// store kicks in on first read, which happens during app boot).
app.use(i18n);
app.use(router);
app.use(VueQueryPlugin);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.dark',
      cssLayer: false,
    },
  },
});
app.use(ConfirmationService);
app.use(ToastService);

app.mount('#app');

// Auto-sync: focus listener, debounced post-write sync, SignalR realtime.
// Must be installed after Pinia is registered above. Sign-in-triggered
// sync lives inside the sync store itself.
import('./services/syncScheduler').then(({ installSyncScheduler }) => {
  installSyncScheduler();
});

// Native menu event bridge — listens for clicks from the Rust-side menu
// (built in src-tauri/src/lib.rs) and dispatches into Pinia. No-op when
// not running inside Tauri (e.g. browser dev mode), so safe to install
// unconditionally.
import('./services/menu').then(({ installMenuHandlers }) => {
  installMenuHandlers();
});

// VSCode command bridge — when the extension host posts
// `{kind:'cmd', cmd:<x>}` (from a palette command or context menu
// invocation), trigger the matching in-app code path. Listener is
// global and only acts on `cmd` messages so it doesn't conflict
// with the db / http / fs reply listeners installed by the bridge
// transports.
//
// Supported commands today:
//   - sync.now    : equivalent to clicking the Sync Now button
//   - import      : open the import dialog with content pre-loaded
//                   (right-click .har / .yaml / .json → Open in Aelvory)
import('./runtime/environment').then(({ isVSCodeEnv }) => {
  if (!isVSCodeEnv()) return;
  window.addEventListener('message', async (event) => {
    const data = event.data as
      | {
          kind?: string;
          cmd?: string;
          format?: 'openapi' | 'postman' | 'insomnia' | 'har';
          content?: string;
          filename?: string;
        }
      | null;
    if (!data || data.kind !== 'cmd') return;

    if (data.cmd === 'sync.now') {
      const { useSyncStore } = await import('./stores/sync');
      const sync = useSyncStore();
      void sync.sync().catch(() => {
        /* error already in lastError */
      });
    } else if (
      data.cmd === 'import' &&
      typeof data.content === 'string' &&
      typeof data.format === 'string'
    ) {
      const { useUiStore } = await import('./stores/ui');
      const ui = useUiStore();
      ui.openImportWith({
        content: data.content,
        format: data.format,
        filename: data.filename,
      });
    } else if (data.cmd === 'curl.new') {
      // From the sidebar's "New curl tab" action. Mirrors what the
      // RequestTabs "+ curl" button does.
      const { useTabsStore } = await import('./stores/tabs');
      useTabsStore().openCurl();
    }
  });
});

// Activity-bar sidebar status reporter — pushes workspace / sync /
// account state to the host so the sidebar tree shows current info.
// Installed after Pinia is registered. No-op outside VSCode.
import('./services/sidebarStatus').then(({ installSidebarStatusReporter }) => {
  installSidebarStatusReporter();
});
