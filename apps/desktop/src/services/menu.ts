/**
 * Bridge between the native menu (built in src-tauri/src/lib.rs) and the
 * webview-side Pinia stores. Each custom menu item emits a `menu` event
 * with the item id; this module dispatches that id into the right
 * action.
 *
 * Two cross-cutting concerns this module handles consistently:
 *   1. User feedback — every menu action toasts a result (success or
 *      failure) so the user can tell their click did something. This
 *      matters because menu-triggered actions don't have the usual
 *      visual cues (no button "loading" state, no inline confirmation).
 *   2. Save dialogs — file-saving goes through `saveJsonFile`, which
 *      uses the native Tauri save dialog instead of relying on the
 *      browser's `<a download>` trick. The latter silently no-ops when
 *      triggered from a menu event because the webview doesn't see a
 *      user-activation context.
 */
import { watch } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriEnv } from '@/runtime/environment';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { useWorkspaceStore } from '@/stores/workspace';
import { useCollectionsStore } from '@/stores/collections';
import { useEnvironmentsStore } from '@/stores/environments';
import { useSyncStore } from '@/stores/sync';
import { exportAll } from '@/localdb/backup';
import { saveJsonFile } from './files';
import { toast } from './toast';
import { prompt } from '@/composables/prompt';
import { i18n } from '@/i18n';

/**
 * Pull a translation outside of a Vue component (this module isn't a
 * component). Wraps `i18n.global.t` so call sites stay symmetric with
 * `useI18n().t` in components.
 */
const t = (key: string, named?: Record<string, unknown>) =>
  i18n.global.t(key, named ?? {});

let unlisten: UnlistenFn | null = null;
let localeWatching = false;

export async function installMenuHandlers(): Promise<void> {
  if (!isTauriEnv()) return;
  if (unlisten) return; // idempotent — survives HMR

  unlisten = await listen<string>('menu', (event) => {
    void handle(event.payload);
  });

  // Push translated menu titles into Rust now (so the user's chosen
  // locale replaces the English fallback the setup() hook installed)
  // and again every time the locale changes.
  await applyMenuTranslations();
  if (!localeWatching) {
    localeWatching = true;
    watch(i18n.global.locale, () => {
      void applyMenuTranslations();
    });
  }
}

/**
 * Send the current locale's menu titles to the Rust side, which
 * rebuilds the native menu and atomically swaps it in. Quiet on
 * failure — a stale menu is bad UX but not fatal.
 */
export async function applyMenuTranslations(): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_menu_strings', {
      strings: {
        file: t('menu.file'),
        edit: t('menu.edit'),
        view: t('menu.view'),
        workspace: t('menu.workspace'),
        help: t('menu.help'),
        newCurlTab: t('menu.newCurlTab'),
        newCollection: t('menu.newCollection'),
        import: t('menu.import'),
        export: t('menu.export'),
        settings: t('menu.settings'),
        toggleSidebar: t('menu.toggleSidebar'),
        zoomIn: t('menu.zoomIn'),
        zoomOut: t('menu.zoomOut'),
        zoomReset: t('menu.zoomReset'),
        syncNow: t('menu.syncNow'),
        newEnvironment: t('menu.newEnvironment'),
        documentation: t('menu.documentation'),
        about: t('menu.about'),
      },
    });
  } catch (err) {
    console.warn('[menu] failed to apply translations:', err);
  }
}

async function handle(id: string): Promise<void> {
  // Lazy-resolve stores per call. Pinia is set up by main.ts before this
  // listener could fire, but resolving inside the handler keeps each
  // case independent and avoids holding stale store references across a
  // Pinia reset (e.g. in tests).
  const ui = useUiStore();
  const tabs = useTabsStore();
  const workspace = useWorkspaceStore();
  const collections = useCollectionsStore();
  const environments = useEnvironmentsStore();
  const sync = useSyncStore();

  switch (id) {
    case 'file.new_curl':
      tabs.openCurl();
      return;

    case 'file.new_collection': {
      if (!workspace.currentProjectId) {
        toast({
          severity: 'warn',
          summary: t('toast.noProjectSelectedTitle'),
          detail: t('toast.noProjectForCollection'),
        });
        return;
      }
      const name = await prompt({
        title: t('prompt.newCollectionTitle'),
        label: t('tree.collectionName'),
        placeholder: t('tree.newCollectionPlaceholder'),
      });
      if (!name) return;
      const c = await collections.createCollection(workspace.currentProjectId, name);
      tabs.openCollection(c);
      return;
    }

    case 'file.import':
      ui.openImport();
      return;

    case 'file.export': {
      try {
        const data = await exportAll();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const result = await saveJsonFile({
          defaultFilename: `aelvory-backup-${ts}.json`,
          content: JSON.stringify(data, null, 2),
        });
        if (result === null) return; // user cancelled the save dialog
        toast({
          severity: 'success',
          summary: t('toast.backupExportedTitle'),
          detail: t('toast.backupExportedDetail', { path: result }),
          life: 5000,
        });
      } catch (err) {
        toast({
          severity: 'error',
          summary: t('toast.exportFailedTitle'),
          detail: err instanceof Error ? err.message : String(err),
          life: 6000,
        });
      }
      return;
    }

    case 'file.settings':
      ui.openSettings();
      return;

    case 'view.toggle_sidebar':
      ui.toggleSidebar();
      return;
    case 'view.zoom_in':
      ui.zoomIn();
      return;
    case 'view.zoom_out':
      ui.zoomOut();
      return;
    case 'view.zoom_reset':
      ui.zoomReset();
      return;

    case 'workspace.sync': {
      // Mirror the SettingsDialog "Sync now" feedback: a success toast
      // with the push/pull tally, or an error toast on failure. Reload
      // when the pull pulled new data (matches the dialog behavior).
      try {
        await sync.sync();
        const r = sync.lastResult;
        if (r) {
          toast({
            severity: 'success',
            summary: t('toast.syncedTitle'),
            detail: t('toast.syncedDetail', {
              pushed: r.pushed.accepted,
              pulled: r.pulled.entries.length,
              applied: r.appliedLocally,
            }),
          });
          if (r.appliedLocally > 0) {
            setTimeout(() => window.location.reload(), 600);
          }
        }
      } catch (err) {
        toast({
          severity: 'error',
          summary: t('toast.syncFailedTitle'),
          detail: err instanceof Error ? err.message : String(err),
          life: 6000,
        });
      }
      return;
    }

    case 'workspace.new_environment': {
      if (!workspace.currentProjectId) {
        toast({
          severity: 'warn',
          summary: t('toast.noProjectSelectedTitle'),
          detail: t('toast.noProjectForEnvironment'),
        });
        return;
      }
      const name = await prompt({
        title: t('prompt.newEnvironmentTitle'),
        label: t('prompt.environmentName'),
        placeholder: t('prompt.environmentNamePlaceholder'),
      });
      if (!name) return;
      await environments.createEnvironment(name);
      toast({
        severity: 'success',
        summary: t('toast.envCreatedTitle'),
        detail: t('toast.envCreatedDetail', { name }),
      });
      return;
    }

    case 'help.docs': {
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl('https://github.com/aelvory');
      } catch {
        /* ignore — opener plugin is best-effort */
      }
      return;
    }

    case 'help.about':
      ui.openAbout();
      return;

    default:
      // Predefined items (Quit, Copy, etc.) never reach this handler;
      // unknown ids only mean we added a menu entry without wiring it
      // here. Surface in console for the dev who forgot.
      console.warn(`[menu] no handler for "${id}"`);
  }
}
