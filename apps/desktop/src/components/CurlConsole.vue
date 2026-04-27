<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Message from 'primevue/message';
import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import ResponseViewer from './ResponseViewer.vue';
import CurlHistoryPanel from './CurlHistoryPanel.vue';
import { parseCurl, type ApiRequest } from '@aelvory/core';
import { useTabsStore, type CurlTab } from '@/stores/tabs';
import { useCurlHistoryStore } from '@/stores/curlHistory';
import { useCollectionsStore } from '@/stores/collections';
import { useEnvironmentsStore } from '@/stores/environments';
import { useWorkspaceStore } from '@/stores/workspace';
import { execute } from '@/services/runner';

const props = defineProps<{ tab: CurlTab }>();

const tabs = useTabsStore();
const history = useCurlHistoryStore();
const collections = useCollectionsStore();
const environments = useEnvironmentsStore();
const workspace = useWorkspaceStore();

const historyOpen = ref(true);
const saveDialogOpen = ref(false);
const saveName = ref('');
const saveCollectionId = ref<string | null>(null);
const saveError = ref<string | null>(null);

interface ParsedPreview {
  method: string;
  url: string;
  headers: number;
  hasBody: boolean;
  hasAuth: boolean;
  warnings: string[];
}

const parsedPreview = computed<ParsedPreview | null>(() => {
  if (!props.tab.command.trim()) {
    props.tab.parseError = null;
    return null;
  }
  try {
    const p = parseCurl(props.tab.command);
    props.tab.parseError = null;
    return {
      method: p.method,
      url: p.url,
      headers: p.headers.length,
      hasBody: !!p.body,
      hasAuth: !!p.auth,
      warnings: p.warnings,
    };
  } catch (err) {
    props.tab.parseError = err instanceof Error ? err.message : 'parse failed';
    return null;
  }
});

const collectionOptions = computed(() => {
  return collections.collections.map((c) => {
    const chain = collections
      .ancestorChain(c.id)
      .map((x) => x.name)
      .join(' / ');
    return { label: chain, value: c.id };
  });
});

function syntheticRequest(): ApiRequest {
  const parsed = parseCurl(props.tab.command);
  return {
    id: '',
    collectionId: '',
    name: 'curl',
    kind: 'http',
    method: parsed.method,
    url: parsed.url,
    headers: parsed.headers,
    body: parsed.body,
    auth: parsed.auth,
    sortIndex: 0,
    version: 0,
    createdAt: '',
    updatedAt: '',
  };
}

async function send() {
  if (!props.tab.command.trim() || props.tab.running) return;
  let req: ApiRequest;
  try {
    req = syntheticRequest();
  } catch (err) {
    props.tab.parseError = err instanceof Error ? err.message : 'parse failed';
    return;
  }

  const historyEntry = history.add({
    command: props.tab.command,
    method: req.method,
    url: req.url,
  });

  props.tab.running = true;
  try {
    const res = await execute(req, {
      envVars: environments.activeVariables,
      ancestorChain: [],
      variablesByCollection: {},
    });
    props.tab.response = res;
    props.tab.lastRunAt = Date.now();
    history.update(historyEntry.id, {
      status: res.status,
      durationMs: res.durationMs,
    });
  } finally {
    props.tab.running = false;
  }
}

function onCommandInput(v: string) {
  props.tab.command = v;
  if (!props.tab.dirty) tabs.markDirty(props.tab.id);
}

function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    send();
  }
}

function loadFromHistory(command: string) {
  // Replace current tab's command so the user can tweak + re-run in place.
  props.tab.command = command;
  props.tab.parseError = null;
  props.tab.response = null;
  props.tab.lastRunAt = null;
}

function spawnFromHistory(command: string) {
  tabs.openCurl(command);
}

function openSaveDialog() {
  if (!parsedPreview.value) return;
  if (!workspace.currentProjectId) {
    saveError.value = 'Select a project first to save the request.';
    saveDialogOpen.value = true;
    return;
  }
  if (!collections.collections.length) {
    saveError.value = 'Create a collection in this project first.';
    saveDialogOpen.value = true;
    return;
  }
  saveName.value = `${parsedPreview.value.method} ${parsedPreview.value.url}`.slice(0, 60);
  saveCollectionId.value = collections.collections[0].id;
  saveError.value = null;
  saveDialogOpen.value = true;
}

async function saveAsRequest() {
  if (!saveCollectionId.value || !saveName.value.trim()) return;
  let parsed;
  try {
    parsed = parseCurl(props.tab.command);
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'parse failed';
    return;
  }
  const created = await collections.createRequest(saveCollectionId.value, {
    name: saveName.value.trim(),
    method: parsed.method,
    url: parsed.url,
    headers: parsed.headers,
    body: parsed.body,
    auth: parsed.auth,
  });
  saveDialogOpen.value = false;
  tabs.close(props.tab.id);
  tabs.openRequest(created);
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(props.tab.command);
  } catch {
    /* ignore */
  }
}

watch(
  () => props.tab.id,
  () => {
    saveDialogOpen.value = false;
  },
);
</script>

<template>
  <div class="curl-console" @keydown="onKeyDown">
    <Splitter class="split" :gutter-size="4">
      <SplitterPanel :size="historyOpen ? 75 : 100" :min-size="40">
        <div class="main">
          <div class="toolbar">
            <Button
              label="Send"
              icon="pi pi-send"
              :loading="props.tab.running"
              :disabled="!parsedPreview"
              @click="send"
            />
            <Button
              label="Save as request"
              icon="pi pi-save"
              severity="secondary"
              text
              :disabled="!parsedPreview"
              @click="openSaveDialog"
            />
            <Button
              icon="pi pi-copy"
              severity="secondary"
              text
              size="small"
              title="Copy command"
              :disabled="!props.tab.command"
              @click="copyCommand"
            />
            <div class="spacer" />
            <Button
              :icon="historyOpen ? 'pi pi-angle-right' : 'pi pi-history'"
              severity="secondary"
              text
              size="small"
              :label="historyOpen ? 'Hide history' : 'History'"
              @click="historyOpen = !historyOpen"
            />
          </div>

          <Textarea
            :model-value="props.tab.command"
            placeholder="Paste a curl command. Ctrl+Enter to send."
            class="command-input"
            spellcheck="false"
            auto-resize
            rows="6"
            @update:model-value="onCommandInput"
          />

          <Message
            v-if="props.tab.parseError"
            severity="error"
            :closable="false"
            class="parse-msg"
          >
            {{ props.tab.parseError }}
          </Message>
          <div v-else-if="parsedPreview" class="parse-preview">
            <span :class="['m', `m-${parsedPreview.method.toLowerCase()}`]">
              {{ parsedPreview.method }}
            </span>
            <span class="url">{{ parsedPreview.url }}</span>
            <span class="badges">
              <span class="badge">{{ parsedPreview.headers }} headers</span>
              <span v-if="parsedPreview.hasBody" class="badge">body</span>
              <span v-if="parsedPreview.hasAuth" class="badge">auth</span>
            </span>
          </div>
          <Message
            v-if="parsedPreview?.warnings.length"
            severity="warn"
            :closable="false"
            class="parse-msg"
          >
            <ul class="warn-list">
              <li v-for="(w, i) in parsedPreview.warnings" :key="i">{{ w }}</li>
            </ul>
          </Message>

          <div class="response-wrap">
            <ResponseViewer
              :response="props.tab.response"
              :running="props.tab.running"
            />
          </div>
        </div>
      </SplitterPanel>
      <SplitterPanel v-if="historyOpen" :size="25" :min-size="15">
        <CurlHistoryPanel
          @load="loadFromHistory"
          @spawn="spawnFromHistory"
        />
      </SplitterPanel>
    </Splitter>

    <Dialog
      v-model:visible="saveDialogOpen"
      modal
      header="Save as request"
      :style="{ width: '480px' }"
    >
      <div class="save-form">
        <Message
          v-if="saveError"
          severity="warn"
          :closable="false"
        >{{ saveError }}</Message>
        <template v-else>
          <label>Name</label>
          <InputText v-model="saveName" class="w-full" />

          <label>Collection</label>
          <Select
            v-model="saveCollectionId"
            :options="collectionOptions"
            option-label="label"
            option-value="value"
            placeholder="Pick a collection"
            class="w-full"
          />
        </template>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          text
          severity="secondary"
          @click="saveDialogOpen = false"
        />
        <Button
          label="Save"
          :disabled="!!saveError || !saveName.trim() || !saveCollectionId"
          @click="saveAsRequest"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.curl-console {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.split {
  flex: 1;
  min-height: 0;
}
.main {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0.75rem;
  gap: 0.6rem;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.spacer {
  flex: 1;
}
.command-input {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.82rem;
  min-height: 120px;
  max-height: 260px;
}
.parse-msg {
  font-size: 0.82rem;
}
.warn-list {
  margin: 0;
  padding-left: 1rem;
}
.parse-preview {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 0.5rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-radius: 4px;
  font-size: 0.82rem;
}
.m {
  font-weight: 700;
  font-size: 0.7rem;
  text-transform: uppercase;
  min-width: 3rem;
}
.m-get { color: #16a34a; }
.m-post { color: #ca8a04; }
.m-put { color: #2563eb; }
.m-patch { color: #9333ea; }
.m-delete { color: #dc2626; }
.m-head, .m-options { color: #6b7280; }
.url {
  font-family: 'SF Mono', Consolas, monospace;
  word-break: break-all;
  flex: 1;
}
.badges {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}
.badge {
  font-size: 0.7rem;
  color: var(--p-text-muted-color, #6b7280);
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.1rem 0.4rem;
  border-radius: 2px;
}
.response-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--p-content-border-color, #e5e7eb);
}
.save-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.save-form label {
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #6b7280);
}
.w-full {
  width: 100%;
}
</style>
