<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterView } from 'vue-router';
import ConfirmDialog from 'primevue/confirmdialog';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { useSyncStore } from '@/stores/sync';
import PromptDialog from '@/components/PromptDialog.vue';

const toast = useToast();
const sync = useSyncStore();
const { t } = useI18n();

/**
 * Surface push conflicts after every sync. The server returns
 * `pushed.conflicts` for any local row whose UpdatedAt was strictly
 * older than the server's — meaning another device already shipped a
 * newer version of that row, so our push for it was rejected. The next
 * pull (which sync() always does) will pull that newer version down,
 * but we show a toast so the user understands their local edit lost.
 */
watch(
  () => sync.lastResult,
  (result, prev) => {
    if (!result || result === prev) return;
    const conflicts = result.pushed.conflicts;
    if (conflicts.length === 0) return;
    const sample = conflicts.slice(0, 3).map((c) => c.entityType).join(', ');
    const more =
      conflicts.length > 3
        ? t('toast.syncConflictsMore', { count: conflicts.length - 3 })
        : '';
    toast.add({
      severity: 'warn',
      // vue-i18n@9 picks the right plural form from `named.count`
      // automatically when the source message uses `|` separators, so
      // we don't pass count as a separate positional argument.
      summary: t('toast.syncConflictsTitle', { count: conflicts.length }),
      detail: t('toast.syncConflictsDetail', { types: sample, more }),
      life: 8000,
    });
  },
);

/** Surface non-conflict sync errors as a toast too. */
watch(
  () => sync.lastError,
  (err) => {
    if (!err) return;
    toast.add({
      severity: 'error',
      summary: t('toast.syncFailedTitle'),
      detail: err,
      life: 6000,
    });
  },
);
</script>

<template>
  <RouterView />
  <ConfirmDialog />
  <Toast position="bottom-right" />
  <PromptDialog />
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  /* PrimeVue exposes these CSS variables once a theme is installed;
     swapping the `.dark` class on <html> (see composables/theme.ts)
     re-resolves them to the dark palette. Falling back to the
     traditional white/black pair keeps things sane during the brief
     window before the theme is loaded. */
  background: var(--p-content-background, #ffffff);
  color: var(--p-text-color, #111111);
}

/* When VSCode hosts the webview, prefer its color tokens so the app
   visually matches the surrounding editor chrome instead of looking
   like a foreign panel. The vscode-* body classes are added by the
   host; the variables are exposed by VSCode's webview shell. We only
   apply this in the VSCode case to avoid changing the Tauri build's
   look. */
body.vscode-dark,
body.vscode-light,
body.vscode-high-contrast,
body.vscode-high-contrast-light {
  background: var(--vscode-editor-background, var(--p-content-background));
  color: var(--vscode-editor-foreground, var(--p-text-color));
}
</style>
