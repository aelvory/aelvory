<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Password from 'primevue/password';
import Message from 'primevue/message';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { useSettingsStore } from '@/stores/settings';
import { useSyncStore } from '@/stores/sync';
import { isTauriEnv, isBrowserEnv } from '@/api/mode';
import { exportAll, importAll } from '@/localdb/backup';
import {
  wipeAelvoryLocalStorage,
  wipeAllLocalData,
  wipeLegacyIndexedDb,
} from '@/localdb/wipe';
import { syncRealtime } from '@/services/syncRealtime';
import { saveJsonFile } from '@/services/files';
import { LOCALES, LOCALE_NAMES } from '@/i18n';

const visible = defineModel<boolean>({ required: true });
const settings = useSettingsStore();
const sync = useSyncStore();
const confirm = useConfirm();
const toast = useToast();
const { t } = useI18n();

/**
 * Language picker options. The "auto" entry maps to settings.language=''
 * which triggers OS-language detection at runtime. Native names (e.g.
 * "Deutsch", "中文") are intentionally rendered in their own script —
 * users picking a language they speak will recognise it instantly.
 */
const languageOptions = computed(() => [
  { value: '', label: t('language.auto') },
  ...LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] })),
]);

/**
 * Theme picker. 'auto' delegates to the host (VSCode body class > OS
 * prefers-color-scheme); 'light' / 'dark' force the picked palette.
 */
const themeOptions = computed(() => [
  { value: 'auto' as const, label: t('settings.themeAuto') },
  { value: 'light' as const, label: t('settings.themeLight') },
  { value: 'dark' as const, label: t('settings.themeDark') },
]);
const themeMode = computed({
  get: () => settings.themeMode,
  set: (v) => {
    settings.themeMode = v;
  },
});

const userAgent = computed({
  get: () => settings.userAgent,
  set: (v) => {
    settings.userAgent = v ?? '';
  },
});

const timeoutMs = computed({
  get: () => settings.timeoutMs,
  set: (v) => {
    settings.timeoutMs = typeof v === 'number' && v > 0 ? v : 60_000;
  },
});

const inTauri = isTauriEnv();
// User-Agent can be set in any host that owns the network stack (Tauri's
// plugin-http or the VSCode extension host's Node fetch). Only the bare
// browser runtime can't override UA — fetch in a browser respects the
// browser's UA per spec. Show the warning ONLY for that case.
const inBrowser = isBrowserEnv();

// --- Storage status ---
const storagePersistent = ref<boolean | null>(null);
const storageEstimate = ref<{ usage?: number; quota?: number } | null>(null);

async function refreshStorage() {
  if (typeof navigator !== 'undefined' && 'storage' in navigator) {
    try {
      storagePersistent.value = (await navigator.storage.persisted?.()) ?? null;
      storageEstimate.value = (await navigator.storage.estimate?.()) ?? null;
    } catch {
      /* ignore */
    }
  }
}

onMounted(refreshStorage);

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function requestPersist() {
  if (typeof navigator !== 'undefined' && 'storage' in navigator) {
    try {
      await navigator.storage.persist?.();
      await refreshStorage();
    } catch {
      /* ignore */
    }
  }
}

// --- Backup / Restore ---
const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);

async function onExport() {
  busy.value = true;
  try {
    const data = await exportAll();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await saveJsonFile({
      defaultFilename: `aelvory-backup-${ts}.json`,
      content: JSON.stringify(data, null, 2),
    });
    if (result === null) return; // user cancelled the dialog
    toast.add({
      severity: 'success',
      summary: t('toast.backupExportedTitle'),
      detail: t('toast.backupExportedDetail', { path: result }),
      life: 5000,
    });
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: t('toast.exportFailedTitle'),
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  } finally {
    busy.value = false;
  }
}

function triggerImport() {
  fileInput.value?.click();
}

async function onImportFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const text = await file.text();
  confirm.require({
    header: t('settings.importConfirmHeader'),
    message: t('settings.importConfirmMessage'),
    acceptLabel: t('settings.importConfirmAccept'),
    rejectLabel: t('common.cancel'),
    acceptClass: 'p-button-danger',
    accept: async () => {
      busy.value = true;
      try {
        const stats = await importAll(text, { replaceExisting: true });
        toast.add({
          severity: 'success',
          summary: 'Imported',
          detail: `${stats.rowsImported} rows across ${stats.tables.length} tables. Reloading…`,
          life: 3000,
        });
        await refreshStorage();
        setTimeout(() => window.location.reload(), 600);
      } catch (err) {
        toast.add({
          severity: 'error',
          summary: 'Import failed',
          detail: err instanceof Error ? err.message : String(err),
          life: 6000,
        });
      } finally {
        busy.value = false;
      }
    },
  });
}

/**
 * Hard reset of local state — every row in every user-data table,
 * plus the `aelvory.*` localStorage keys (sync token, settings,
 * collapse, language, ...). Schema stays in place so migrations
 * don't replay. Caller must reload after.
 */
function onResetLocalData() {
  confirm.require({
    header: t('settings.resetLocalDataConfirmHeader'),
    message: t('settings.resetLocalDataConfirmMessage'),
    acceptLabel: t('settings.resetLocalDataConfirmAccept'),
    rejectLabel: t('common.cancel'),
    acceptClass: 'p-button-danger',
    accept: async () => {
      busy.value = true;
      try {
        // Order matters: SignalR-driven pulls and the post-write debounce
        // both write to the same SQLite connection we're about to clear.
        // 1) signOut() flips auth state — scheduler watchers will
        //    eventually tear down, but asynchronously.
        // 2) syncRealtime.stop() awaits the actual disconnect so no
        //    `Changed` callback fires mid-wipe.
        // 3) Small yield gives any already-queued microtask sync run a
        //    chance to finish (or short-circuit on missing token) before
        //    we acquire the writer lock.
        sync.signOut();
        await syncRealtime.stop();
        await new Promise((r) => setTimeout(r, 50));
        await wipeAllLocalData();
        // Legacy IndexedDB has to go too — otherwise the Dexie-import
        // path re-seeds SQLite from it on next boot and the wipe
        // appears to "undo itself" (lingering pre-SQLite-migration
        // workspaces and projects).
        await wipeLegacyIndexedDb();
        wipeAelvoryLocalStorage();
        toast.add({
          severity: 'success',
          summary: t('settings.resetLocalDataDoneTitle'),
          detail: t('settings.resetLocalDataDoneDetail'),
          life: 2500,
        });
        // Brief delay so the toast renders before reload swallows it.
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        toast.add({
          severity: 'error',
          summary: t('settings.resetLocalDataFailedTitle'),
          detail: err instanceof Error ? err.message : String(err),
          life: 6000,
        });
      } finally {
        busy.value = false;
      }
    },
  });
}

// --- Sync ---
const authMode = ref<'signin' | 'signup'>('signin');
const authEmail = ref('');
const authPassword = ref('');
const authName = ref('');
const authBusy = ref(false);
const authError = ref<string | null>(null);

// --- Sync server URL (runtime override) ---
// We mirror the persisted override in a local ref so users can edit
// freely without every keystroke triggering a sign-out prompt. Only
// when they click "Apply" do we commit + maybe sign-out.
const serverUrlInput = ref<string>(settings.syncServerUrl);
const serverUrlError = ref<string | null>(null);

const effectiveServerUrl = computed(() => settings.effectiveSyncUrl());

const serverUrlDirty = computed(() => {
  return (serverUrlInput.value.trim().replace(/\/+$/, '') !== settings.syncServerUrl);
});

function isValidServerUrl(v: string): boolean {
  if (!v) return true; // empty = use default, valid
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function applyServerUrl() {
  serverUrlError.value = null;
  const candidate = serverUrlInput.value.trim();
  if (!isValidServerUrl(candidate)) {
    serverUrlError.value = t('settings.serverUrlInvalid');
    return;
  }

  const before = settings.effectiveSyncUrl();
  // Commit speculatively to compute the new effective URL
  const willChange = settings.setSyncServerUrl(candidate);
  // If nothing changed, we're done.
  if (!willChange) {
    toast.add({
      severity: 'info',
      summary: t('toast.settingsServerUrlUnchanged'),
      detail: t('toast.settingsServerUrlUnchangedDetail'),
      life: 3000,
    });
    return;
  }

  // If the user is signed in, changing the URL means switching to a
  // different server / account / dataset. Force a sign-out so we don't
  // mix tokens or push local data to the wrong place.
  if (sync.isSignedIn) {
    // Roll back the speculative commit while we ask. If they cancel we
    // want the input to look unchanged.
    settings.setSyncServerUrl(before === settings.defaults.envSyncUrl ? '' : before);
    confirm.require({
      header: t('settings.serverUrlChangeHeader'),
      message: t('settings.serverUrlChangeMessage', {
        from: before,
        to: candidate || settings.defaults.envSyncUrl,
      }),
      acceptLabel: t('settings.serverUrlChangeAccept'),
      rejectLabel: t('common.cancel'),
      acceptClass: 'p-button-danger',
      accept: () => {
        settings.setSyncServerUrl(candidate);
        sync.signOut();
        toast.add({
          severity: 'success',
          summary: t('toast.settingsServerUrlSwitched'),
          detail: t('toast.settingsServerUrlSwitchedDetail'),
          life: 4000,
        });
      },
      reject: () => {
        // Restore the input to match the (untouched) saved value.
        serverUrlInput.value = settings.syncServerUrl;
      },
    });
    return;
  }

  toast.add({
    severity: 'success',
    summary: t('toast.settingsServerUrlUpdated'),
    detail: t('toast.settingsServerUrlUpdatedDetail', { url: settings.effectiveSyncUrl() }),
    life: 3000,
  });
}

function resetServerUrl() {
  serverUrlInput.value = '';
  serverUrlError.value = null;
}

const passphraseInput = ref('');
const passphraseBusy = ref(false);
const passphraseError = ref<string | null>(null);

async function doAuth() {
  authError.value = null;
  authBusy.value = true;
  try {
    if (authMode.value === 'signin') {
      await sync.signIn(authEmail.value, authPassword.value);
    } else {
      await sync.signUp(authEmail.value, authPassword.value, authName.value);
    }
    authPassword.value = '';
    sync.setEnabled(true);
    toast.add({
      severity: 'success',
      summary: t('toast.signedInTitle'),
      detail: t('toast.signedInDetail'),
      life: 4000,
    });
  } catch (err) {
    authError.value = err instanceof Error ? err.message : t('settings.couldNotSignIn');
  } finally {
    authBusy.value = false;
  }
}

function doSignOut() {
  confirm.require({
    header: t('settings.signOutHeader'),
    message: t('settings.signOutMessage'),
    acceptLabel: t('settings.signOut'),
    rejectLabel: t('common.cancel'),
    accept: () => sync.signOut(),
  });
}

function onToggleEnabled(v: boolean) {
  if (v && !sync.isSignedIn) return;
  sync.setEnabled(v);
}

function onToggleE2ee(v: boolean) {
  sync.setE2eeEnabled(v);
  if (!v) {
    passphraseInput.value = '';
    passphraseError.value = null;
  }
}

async function unlockE2ee() {
  passphraseError.value = null;
  if (!passphraseInput.value) {
    passphraseError.value = t('settings.passphraseRequired');
    return;
  }
  passphraseBusy.value = true;
  try {
    await sync.unlockWithPassphrase(passphraseInput.value);
    passphraseInput.value = '';
    toast.add({
      severity: 'success',
      summary: t('toast.e2eeUnlockedTitle'),
      detail: t('toast.e2eeUnlockedDetail'),
      life: 3000,
    });
  } catch (err) {
    passphraseError.value = err instanceof Error ? err.message : t('settings.couldNotSignIn');
  } finally {
    passphraseBusy.value = false;
  }
}

async function doSyncNow() {
  try {
    await sync.sync();
    const r = sync.lastResult;
    if (r) {
      toast.add({
        severity: 'success',
        summary: t('toast.syncedTitle'),
        detail: t('toast.syncedDetail', {
          pushed: r.pushed.accepted,
          pulled: r.pulled.entries.length,
          applied: r.appliedLocally,
        }),
        life: 4000,
      });
      if (r.appliedLocally > 0) {
        setTimeout(() => window.location.reload(), 600);
      }
    }
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: t('toast.syncFailedTitle'),
      detail: err instanceof Error ? err.message : String(err),
      life: 6000,
    });
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="t('settings.title')"
    :style="{ width: '640px', maxWidth: '95vw' }"
  >
    <div class="settings-body">
      <section>
        <h3>{{ t('settings.sectionRequests') }}</h3>
        <label for="ua">{{ t('settings.userAgentLabel') }}</label>
        <InputText
          id="ua"
          v-model="userAgent"
          class="w-full"
          :placeholder="settings.defaults.userAgent"
        />
        <p class="hint">{{ t('settings.userAgentHint') }}</p>
        <Message
          v-if="inBrowser"
          severity="warn"
          :closable="false"
          class="hint-msg"
        >{{ t('settings.userAgentBrowserWarning') }}</Message>

        <label for="timeout" class="mt">{{ t('settings.timeoutLabel') }}</label>
        <InputNumber
          id="timeout"
          v-model="timeoutMs"
          class="w-full"
          :min="1000"
          :max="600000"
          :step="1000"
          show-buttons
        />

        <div class="toggle-row mt">
          <label for="ignoreCerts" class="toggle-label">
            {{ t('settings.ignoreCertsLabel') }}
          </label>
          <ToggleSwitch
            input-id="ignoreCerts"
            v-model="settings.ignoreCerts"
          />
        </div>
        <p class="hint">{{ t('settings.ignoreCertsHint') }}</p>
        <Message
          v-if="settings.ignoreCerts"
          severity="warn"
          :closable="false"
          class="hint-msg"
        >{{ t('settings.ignoreCertsWarning') }}</Message>
        <Message
          v-if="inBrowser"
          severity="info"
          :closable="false"
          class="hint-msg"
        >{{ t('settings.ignoreCertsBrowserWarning') }}</Message>
      </section>

      <section>
        <h3>{{ t('settings.sectionAppearance') }}</h3>
        <label for="theme">{{ t('settings.themeLabel') }}</label>
        <Select
          id="theme"
          v-model="themeMode"
          :options="themeOptions"
          option-label="label"
          option-value="value"
          class="w-full"
        />
        <p class="hint">{{ t('settings.themeHint') }}</p>

        <label for="lang" class="mt">{{ t('language.label') }}</label>
        <Select
          id="lang"
          v-model="settings.language"
          :options="languageOptions"
          option-label="label"
          option-value="value"
          class="w-full"
        />
      </section>

      <section>
        <h3>{{ t('settings.sectionLocalData') }}</h3>
        <p class="hint">{{ t('settings.localDataHint') }}</p>
        <div class="status">
          <div class="status-row">
            <span class="label" :title="t('settings.webviewStorageTooltip')">
              {{ t('settings.webviewStorage') }}
            </span>
            <span :class="['pill', storagePersistent === true ? 'ok' : 'warn']">
              {{
                storagePersistent === true
                  ? t('settings.storagePersistent')
                  : storagePersistent === false
                    ? t('settings.storageBestEffort')
                    : t('settings.storageUnknown')
              }}
            </span>
            <Button
              v-if="storagePersistent !== true"
              :label="t('settings.requestPersistence')"
              size="small"
              severity="secondary"
              text
              :title="t('settings.requestPersistenceTooltip')"
              @click="requestPersist"
            />
          </div>
          <div class="status-row">
            <span class="label" :title="t('settings.webviewUsedTooltip')">
              {{ t('settings.webviewUsed') }}
            </span>
            <span>
              {{ fmtBytes(storageEstimate?.usage) }}
              <span class="muted-inline">of {{ fmtBytes(storageEstimate?.quota) }}</span>
            </span>
          </div>
        </div>
        <div class="data-actions">
          <Button
            :label="t('settings.exportBackup')"
            icon="pi pi-download"
            severity="secondary"
            :loading="busy"
            @click="onExport"
          />
          <Button
            :label="t('settings.importBackup')"
            icon="pi pi-upload"
            severity="secondary"
            :loading="busy"
            @click="triggerImport"
          />
          <input
            ref="fileInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            @change="onImportFile"
          />
        </div>

        <!--
          Reset local data — the destructive escape hatch for switching
          servers / accounts on the same machine. Visually separated and
          secondary-styled so it doesn't compete with Export/Import for
          attention.
        -->
        <div class="reset-row">
          <p class="hint">{{ t('settings.resetLocalDataHint') }}</p>
          <Button
            :label="t('settings.resetLocalData')"
            icon="pi pi-exclamation-triangle"
            severity="danger"
            text
            size="small"
            :loading="busy"
            @click="onResetLocalData"
          />
        </div>
      </section>

      <section>
        <div class="sync-head">
          <h3>{{ t('settings.sectionSync') }}</h3>
          <ToggleSwitch
            :model-value="sync.enabled"
            :disabled="!sync.isSignedIn"
            @update:model-value="onToggleEnabled"
          />
        </div>
        <p class="hint">{{ t('settings.syncOptional') }}</p>

        <label for="sync-url" class="mt">{{ t('settings.serverUrlLabel') }}</label>
        <InputText
          id="sync-url"
          v-model="serverUrlInput"
          class="w-full"
          :placeholder="settings.defaults.envSyncUrl"
          spellcheck="false"
          autocomplete="off"
        />
        <div class="server-url-row">
          <span class="hint-inline">
            {{ t('settings.serverUrlEffective') }} <code>{{ effectiveServerUrl }}</code>
            <span v-if="!settings.syncServerUrl" class="muted-inline">
              {{ t('settings.serverUrlBuiltInDefault') }}
            </span>
          </span>
          <span class="server-url-actions">
            <Button
              v-if="settings.syncServerUrl"
              :label="t('settings.serverUrlUseDefault')"
              size="small"
              text
              severity="secondary"
              @click="resetServerUrl"
            />
            <Button
              :label="t('common.apply')"
              :disabled="!serverUrlDirty"
              size="small"
              @click="applyServerUrl"
            />
          </span>
        </div>
        <Message
          v-if="serverUrlError"
          severity="error"
          :closable="false"
          class="hint-msg"
        >{{ serverUrlError }}</Message>
        <p class="hint">{{ t('settings.serverUrlHint') }}</p>

        <template v-if="!sync.isSignedIn">
          <div class="auth-form">
            <div class="tab-bar">
              <button
                type="button"
                :class="['tab-btn', { active: authMode === 'signin' }]"
                @click="authMode = 'signin'"
              >{{ t('settings.signIn') }}</button>
              <button
                type="button"
                :class="['tab-btn', { active: authMode === 'signup' }]"
                @click="authMode = 'signup'"
              >{{ t('settings.signUp') }}</button>
            </div>

            <label>{{ t('settings.email') }}</label>
            <InputText v-model="authEmail" type="email" autocomplete="email" class="w-full" />

            <template v-if="authMode === 'signup'">
              <label>{{ t('settings.displayName') }}</label>
              <InputText v-model="authName" class="w-full" />
            </template>

            <label>{{ t('settings.password') }}</label>
            <Password
              v-model="authPassword"
              :feedback="authMode === 'signup'"
              toggle-mask
              :input-style="{ width: '100%' }"
              style="width: 100%"
            />

            <Message v-if="authError" severity="error" :closable="false" class="hint-msg">
              {{ authError }}
            </Message>

            <Button
              :label="authMode === 'signin' ? 'Sign in' : 'Create account'"
              :loading="authBusy"
              @click="doAuth"
            />
          </div>
        </template>

        <template v-else>
          <div class="signed-in-info">
            <span class="label">{{ t('settings.signedInAs') }}</span>
            <strong>{{ sync.email }}</strong>
            <Button
              icon="pi pi-sign-out"
              text
              size="small"
              severity="secondary"
              :label="t('settings.signOut')"
              @click="doSignOut"
            />
          </div>

          <div class="e2ee-row">
            <ToggleSwitch
              :model-value="sync.e2eeEnabled"
              @update:model-value="onToggleE2ee"
            />
            <div class="e2ee-info">
              <div class="e2ee-label">{{ t('settings.e2eeLabel') }}</div>
              <div class="hint">{{ t('settings.e2eeHint') }}</div>
            </div>
          </div>

          <div
            v-if="sync.enabled && sync.e2eeEnabled && !sync.derivedKey"
            class="passphrase-form"
          >
            <label>{{ t('settings.passphraseLabel') }}</label>
            <Password
              v-model="passphraseInput"
              :feedback="false"
              toggle-mask
              :input-style="{ width: '100%' }"
              style="width: 100%"
            />
            <Message
              v-if="passphraseError"
              severity="error"
              :closable="false"
              class="hint-msg"
            >{{ passphraseError }}</Message>
            <Button
              :label="t('settings.unlock')"
              icon="pi pi-key"
              size="small"
              :loading="passphraseBusy"
              @click="unlockE2ee"
            />
            <p class="hint">{{ t('settings.passphraseHint') }}</p>
          </div>

          <div class="sync-actions">
            <Button
              :label="t('settings.syncNow')"
              icon="pi pi-sync"
              :loading="sync.syncing"
              :disabled="!sync.canSync"
              @click="doSyncNow"
            />
            <span v-if="sync.lastSyncAt" class="hint-inline">
              {{ t('settings.lastSync', { when: new Date(sync.lastSyncAt).toLocaleString() }) }}
            </span>
          </div>

          <Message v-if="sync.lastError" severity="error" :closable="false" class="hint-msg">
            {{ sync.lastError }}
          </Message>

          <p v-if="sync.needsPassphrase" class="hint">
            {{ t('settings.needsPassphrase') }}
          </p>
        </template>
      </section>
    </div>

    <template #footer>
      <Button
        :label="t('settings.resetDefaults')"
        text
        severity="secondary"
        @click="settings.resetDefaults"
      />
      <Button :label="t('common.close')" @click="visible = false" />
    </template>
  </Dialog>
</template>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
section {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
h3 {
  margin: 0 0 0.35rem;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color, #6b7280);
}
label {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--p-text-color, #111827);
  margin-top: 0.3rem;
}
.mt { margin-top: 0.75rem; }
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.toggle-label {
  flex: 1;
  font-size: 0.9rem;
}
.w-full { width: 100%; }
.hint {
  margin: 0.2rem 0 0 0;
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #6b7280);
  line-height: 1.4;
}
.hint-inline {
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #6b7280);
}
.hint code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
  font-size: 0.76rem;
}
.hint-msg { margin-top: 0.4rem; font-size: 0.8rem; }
.status {
  background: var(--p-content-hover-background, #f9fafb);
  padding: 0.6rem 0.75rem;
  border-radius: 4px;
  font-size: 0.82rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.5rem;
}
.status-row { display: flex; align-items: center; gap: 0.5rem; }
.label { color: var(--p-text-muted-color, #6b7280); min-width: 8rem; }
.pill {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
}
.pill.ok { background: rgba(22, 163, 74, 0.15); color: #16a34a; }
.pill.warn { background: rgba(202, 138, 4, 0.15); color: #ca8a04; }
.muted-inline { color: var(--p-text-muted-color, #9ca3af); }
.data-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}
.reset-row {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px dashed var(--p-content-border-color, #e5e7eb);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
}
.reset-row .hint { margin: 0; }
.hidden { display: none; }
.sync-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.75rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-radius: 4px;
  margin-top: 0.5rem;
}
.tab-bar { display: flex; gap: 0.25rem; margin-bottom: 0.25rem; }
.tab-btn {
  background: transparent;
  border: 1px solid transparent;
  border-bottom: 1px solid var(--p-content-border-color, #d1d5db);
  padding: 0.3rem 0.6rem;
  font-size: 0.82rem;
  cursor: pointer;
  color: var(--p-text-muted-color, #6b7280);
}
.tab-btn.active {
  border: 1px solid var(--p-content-border-color, #d1d5db);
  border-bottom-color: transparent;
  background: var(--p-content-background, white);
  color: var(--p-text-color, #111827);
  font-weight: 500;
}
.signed-in-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-radius: 4px;
  font-size: 0.85rem;
  margin-top: 0.4rem;
}
.e2ee-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-radius: 4px;
}
.e2ee-info { flex: 1; }
.e2ee-label {
  font-weight: 500;
  font-size: 0.85rem;
  color: var(--p-text-color, #111827);
}
.passphrase-form {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.5rem;
  padding: 0.75rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-radius: 4px;
}
.sync-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}
.server-url-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.3rem;
  flex-wrap: wrap;
}
.server-url-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.hint-inline code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
  font-size: 0.78rem;
}
</style>
