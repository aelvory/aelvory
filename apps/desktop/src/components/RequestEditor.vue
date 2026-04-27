<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import UrlBar from './UrlBar.vue';
import KeyValueList from './KeyValueList.vue';
import BodyPanel from './BodyPanel.vue';
import AuthPanel from './AuthPanel.vue';
import ResponseViewer from './ResponseViewer.vue';
import VariablesPopover from './VariablesPopover.vue';
import ScriptsPanel from './ScriptsPanel.vue';
import { useTabsStore, type RequestTab } from '@/stores/tabs';
import { useCollectionsStore } from '@/stores/collections';
import { useEnvironmentsStore } from '@/stores/environments';
import { execute } from '@/services/runner';
import { effectiveAuth } from '@/services/variables';
import { provideVariableNames } from '@/composables/variables';
import { runPreScript, runPostScript } from '@/services/scriptRunner';

const props = defineProps<{ tab: RequestTab }>();

const tabs = useTabsStore();
const collections = useCollectionsStore();
const environments = useEnvironmentsStore();

const activePanel = ref<string>('headers');

const method = computed({
  get: () => props.tab.request.method,
  set: (v) => {
    props.tab.request.method = v;
    tabs.markDirty(props.tab.id);
  },
});
const url = computed({
  get: () => props.tab.request.url,
  set: (v) => {
    props.tab.request.url = v;
    tabs.markDirty(props.tab.id);
  },
});
const headers = computed({
  get: () => props.tab.request.headers,
  set: (v) => {
    props.tab.request.headers = v;
    tabs.markDirty(props.tab.id);
  },
});
const body = computed({
  get: () => props.tab.request.body,
  set: (v) => {
    props.tab.request.body = v;
    tabs.markDirty(props.tab.id);
  },
});
const auth = computed({
  get: () => props.tab.request.auth,
  set: (v) => {
    props.tab.request.auth = v;
    tabs.markDirty(props.tab.id);
  },
});

const preScript = computed({
  get: () => props.tab.preScript,
  set: (v) => {
    props.tab.preScript = v ?? '';
    props.tab.scriptsDirty = true;
  },
});
const postScript = computed({
  get: () => props.tab.postScript,
  set: (v) => {
    props.tab.postScript = v ?? '';
    props.tab.scriptsDirty = true;
  },
});

const ancestorChain = computed(() =>
  collections.ancestorChain(props.tab.request.collectionId),
);

const availableVarNames = computed<string[]>(() => {
  const names = new Set<string>();
  for (const k of Object.keys(environments.activeVariables)) names.add(k);
  for (const c of ancestorChain.value) {
    for (const v of collections.variablesFor(c.id)) {
      names.add(v.key);
    }
  }
  return [...names].sort();
});
provideVariableNames(availableVarNames);

const inheritedAuth = computed(() => {
  const own = props.tab.request.auth;
  if (own && own.type !== 'none') return null;
  const fallback = effectiveAuth(props.tab.request, ancestorChain.value);
  if (!fallback) return null;
  const source = [...ancestorChain.value]
    .reverse()
    .find((c) => c.auth && c.auth.type !== 'none');
  return source ? { type: fallback.type, sourceName: source.name } : null;
});

const saving = ref(false);
const isDirty = computed(() => props.tab.dirty || props.tab.scriptsDirty);

async function loadScriptsIfNeeded() {
  if (props.tab.scriptsLoaded) return;
  try {
    const scripts = await collections.loadScripts(
      props.tab.request.collectionId,
      props.tab.request.id,
    );
    for (const s of scripts) {
      if (s.phase === 'pre') props.tab.preScript = s.source;
      else if (s.phase === 'post') props.tab.postScript = s.source;
    }
  } catch {
    /* ignore — scripts may simply not exist yet */
  } finally {
    props.tab.scriptsLoaded = true;
    props.tab.scriptsDirty = false;
  }
}

onMounted(loadScriptsIfNeeded);
watch(() => props.tab.id, loadScriptsIfNeeded);

async function save() {
  saving.value = true;
  try {
    if (props.tab.dirty) {
      const updated = await collections.updateRequest(props.tab.request);
      tabs.refreshRequest(props.tab.id, updated);
    }
    if (props.tab.scriptsDirty) {
      await Promise.all([
        collections.saveScript(
          props.tab.request.collectionId,
          props.tab.request.id,
          'pre',
          props.tab.preScript,
        ),
        collections.saveScript(
          props.tab.request.collectionId,
          props.tab.request.id,
          'post',
          props.tab.postScript,
        ),
      ]);
      props.tab.scriptsDirty = false;
    }
  } finally {
    saving.value = false;
  }
}

async function applyEnvUpdates(updates: { key: string; value: string }[]) {
  if (!updates.length) return;
  const activeEnvId = environments.activeEnvId;
  if (!activeEnvId) return;
  await Promise.all(
    updates.map((u) =>
      environments.upsertVariable(activeEnvId, u.key, u.value, false),
    ),
  );
}

async function send() {
  if (props.tab.running) return;
  const t = props.tab;

  t.running = true;
  t.testResults = [];
  t.scriptLogs = [];
  t.scriptError = null;

  try {
    // Pre-request script
    const pre = runPreScript(t.preScript, {
      request: t.request,
      env: { ...environments.activeVariables },
    });
    t.scriptLogs = [...pre.logs];
    if (pre.error) t.scriptError = `[pre] ${pre.error}`;
    await applyEnvUpdates(pre.envUpdates);

    // HTTP
    const response = await execute(t.request, {
      envVars: environments.activeVariables,
      ancestorChain: ancestorChain.value,
      variablesByCollection: collections.variablesByCollection,
    });
    t.response = response;
    t.lastRunAt = Date.now();

    // Post-response script
    const post = runPostScript(t.postScript, {
      request: t.request,
      response,
      env: { ...environments.activeVariables },
    });
    t.testResults = post.tests;
    t.scriptLogs = [...t.scriptLogs, ...post.logs];
    if (post.error) {
      t.scriptError =
        (t.scriptError ? t.scriptError + ' / ' : '') + `[post] ${post.error}`;
    }
    await applyEnvUpdates(post.envUpdates);
  } finally {
    t.running = false;
  }
}

watch(
  () => props.tab.id,
  () => {
    activePanel.value = 'headers';
  },
);

function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
}
</script>

<template>
  <div class="editor" @keydown="onKeyDown">
    <div class="header">
      <div class="name">
        <input
          v-model="props.tab.request.name"
          class="name-input"
          @input="tabs.markDirty(props.tab.id)"
        />
        <span v-if="isDirty" class="dirty">•</span>
      </div>
      <div class="spacer" />
      <VariablesPopover
        :ancestor-chain="ancestorChain"
        :collection-variables="collections.variablesByCollection"
      />
      <Button
        label="Save"
        icon="pi pi-save"
        size="small"
        severity="secondary"
        :loading="saving"
        :disabled="!isDirty"
        @click="save"
      />
    </div>

    <div class="url-wrap">
      <UrlBar
        v-model:method="method"
        v-model:url="url"
        :running="props.tab.running"
        @send="send"
      />
    </div>

    <Splitter layout="vertical" class="editor-body" :gutter-size="4">
      <SplitterPanel :size="55" :min-size="20">
        <Tabs v-model:value="activePanel" class="ed-tabs">
          <TabList>
            <Tab value="headers">Headers</Tab>
            <Tab value="body">Body</Tab>
            <Tab value="auth">
              Auth
              <i v-if="inheritedAuth" class="pi pi-arrow-down-left inherit-ind" title="Inheriting auth from parent" />
            </Tab>
            <Tab value="scripts">
              Scripts
              <span
                v-if="props.tab.preScript.trim() || props.tab.postScript.trim()"
                class="dot"
                title="This request has scripts"
              />
            </Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="headers">
              <KeyValueList v-model="headers" />
            </TabPanel>
            <TabPanel value="body">
              <BodyPanel v-model="body" />
            </TabPanel>
            <TabPanel value="auth">
              <p v-if="inheritedAuth" class="inherit-note">
                Inheriting <strong>{{ inheritedAuth.type }}</strong> auth from
                <strong>{{ inheritedAuth.sourceName }}</strong>. Select a type
                below to override.
              </p>
              <AuthPanel v-model="auth" />
            </TabPanel>
            <TabPanel value="scripts">
              <ScriptsPanel v-model:pre="preScript" v-model:post="postScript" />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </SplitterPanel>
      <SplitterPanel :size="45" :min-size="20">
        <ResponseViewer
          :response="props.tab.response"
          :running="props.tab.running"
          :test-results="props.tab.testResults"
          :script-logs="props.tab.scriptLogs"
          :script-error="props.tab.scriptError"
        />
      </SplitterPanel>
    </Splitter>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
}
.name {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.name-input {
  border: none;
  background: transparent;
  font-size: 0.95rem;
  font-weight: 500;
  width: 300px;
  outline: none;
}
.name-input:focus {
  border-bottom: 1px solid var(--p-primary-400, #60a5fa);
}
.dirty {
  color: var(--p-primary-500, #3b82f6);
  font-size: 1.2rem;
}
.spacer {
  flex: 1;
}
.url-wrap {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
}
.editor-body {
  flex: 1;
  min-height: 0;
}
.ed-tabs {
  padding: 0 0.75rem;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/*
 * Push the flex-1 + scroll behaviour into PrimeVue's internal
 * elements. Without this, .ed-tabs has the right shape but its
 * <TabPanels> child is sized intrinsically and content (long
 * header lists, big script editor, JSON body) overflows the
 * splitter pane and gets clipped invisibly.
 *
 * `min-height: 0` on the panels container is the magic that lets
 * `overflow-y: auto` actually trigger inside a flex column —
 * without it, the panels grow to fit content and never scroll.
 */
.ed-tabs :deep(.p-tabpanels) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 0.5rem;
}
.ed-tabs :deep(.p-tabpanel) {
  /* Each panel renders only when active; let it size to content
     and scroll via the parent .p-tabpanels. */
  height: auto;
}
.inherit-ind {
  font-size: 0.7rem;
  color: var(--p-primary-500, #3b82f6);
  margin-left: 0.3rem;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--p-primary-500, #3b82f6);
  margin-left: 0.35rem;
  vertical-align: middle;
}
.inherit-note {
  margin: 0 0 0.75rem 0;
  padding: 0.5rem 0.75rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-left: 3px solid var(--p-primary-400, #60a5fa);
  color: var(--p-text-muted-color, #4b5563);
  font-size: 0.82rem;
  border-radius: 3px;
}
</style>
