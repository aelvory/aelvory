/**
 * Watches the Pinia stores that feed the VSCode activity-bar sidebar
 * and pushes a fresh status payload to the extension host whenever
 * any of them changes.
 *
 * Stays a no-op outside the VSCode runtime (the bridge helper itself
 * gates on `isVSCodeEnv()`, so the watcher cost in Tauri is one
 * extra `watch()` call doing nothing).
 *
 * What we report:
 *   - Workspace: "<org name> / <project name>" or "<org name>" or empty.
 *     Pulled from the workspace store's currentOrg / currentProject
 *     computeds.
 *   - lastSyncIso: the sync store's `lastSyncAt` ref. Stays null
 *     until the first successful sync.
 *   - account: signed-in user's email, or display name as fallback.
 *
 * Debouncing: Pinia store mutations during a single sync can fire
 * many watchers in quick succession. We coalesce into a single push
 * via a microtask schedule so the host gets one status update per
 * tick instead of three or four.
 */

import { watch } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import { useSyncStore } from '@/stores/sync';
import { useAuthStore } from '@/stores/auth';
import { vsPushSidebarStatus, type SidebarStatus } from './vscodeBridge';
import { isVSCodeEnv } from '@/runtime/environment';

let installed = false;

export function installSidebarStatusReporter(): void {
  if (installed) return;
  installed = true;
  if (!isVSCodeEnv()) return;

  const workspace = useWorkspaceStore();
  const sync = useSyncStore();
  const auth = useAuthStore();

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const orgName = workspace.currentOrg?.name?.trim();
      const projectName = workspace.currentProject?.name?.trim();
      const status: SidebarStatus = {
        workspace:
          orgName && projectName
            ? `${orgName} / ${projectName}`
            : orgName || '',
        lastSyncIso: sync.lastSyncAt ?? undefined,
        account: auth.user?.email || auth.user?.displayName || '',
      };
      void vsPushSidebarStatus(status);
    });
  };

  // Initial push so the host sees current state right away (the
  // sidebar is rendered as soon as the user clicks the activity-bar
  // icon, possibly before any store mutates).
  schedule();

  // Watch each input the status depends on. `() => x` getters are
  // necessary because Pinia exposes refs/computeds via plain
  // properties on the store proxy; passing the store directly would
  // miss reactivity for those derived properties.
  watch(() => workspace.currentOrg?.id, schedule);
  watch(() => workspace.currentOrg?.name, schedule);
  watch(() => workspace.currentProject?.id, schedule);
  watch(() => workspace.currentProject?.name, schedule);
  watch(() => sync.lastSyncAt, schedule);
  watch(() => auth.user?.id, schedule);
  watch(() => auth.user?.email, schedule);
}
