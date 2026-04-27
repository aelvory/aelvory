<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import Message from 'primevue/message';
import AuthPanel from './AuthPanel.vue';
import { useTabsStore, type CollectionTab } from '@/stores/tabs';
import { useCollectionsStore } from '@/stores/collections';
import { useWorkspaceStore } from '@/stores/workspace';
import { useEnvironmentsStore } from '@/stores/environments';
import { provideVariableNames } from '@/composables/variables';
import { useDeletions } from '@/composables/deletions';

const props = defineProps<{ tab: CollectionTab }>();

const tabs = useTabsStore();
const collections = useCollectionsStore();
const workspace = useWorkspaceStore();
const environments = useEnvironmentsStore();
const { confirmDeleteCollection } = useDeletions();

function onDelete() {
  confirmDeleteCollection(props.tab.collection.id);
}

const activePanel = ref<string>('auth');

// Variables available when editing this collection's auth field:
// env vars + every ancestor's vars + this collection's own vars.
const availableVarNames = computed<string[]>(() => {
  const names = new Set<string>();
  for (const k of Object.keys(environments.activeVariables)) names.add(k);
  const chain = collections.ancestorChain(props.tab.collection.id);
  for (const c of chain) {
    for (const v of collections.variablesFor(c.id)) {
      names.add(v.key);
    }
  }
  return [...names].sort();
});
provideVariableNames(availableVarNames);

const auth = computed({
  get: () => props.tab.collection.auth ?? null,
  set: (v) => {
    props.tab.collection.auth = v;
    tabs.markDirty(props.tab.id);
  },
});

interface EditableRow {
  id: string | null;
  key: string;
  value: string;
  isSecret: boolean;
  originalKey: string | null;
  saving: boolean;
}

const rows = ref<EditableRow[]>([]);

function loadRows() {
  const vars = collections.variablesFor(props.tab.id);
  rows.value = vars.map((v) => ({
    id: v.id,
    key: v.key,
    value: v.value ?? '',
    isSecret: v.isSecret,
    originalKey: v.key,
    saving: false,
  }));
}

loadRows();
watch(() => props.tab.id, loadRows);
watch(
  () => collections.variablesFor(props.tab.id),
  (vars) => {
    // merge in server-side refreshed vars but keep pending (unsaved) rows
    const savedIds = new Set(vars.map((v) => v.id));
    const pending = rows.value.filter((r) => r.id === null || !savedIds.has(r.id));
    rows.value = [
      ...vars.map((v) => ({
        id: v.id,
        key: v.key,
        value: v.value ?? '',
        isSecret: v.isSecret,
        originalKey: v.key,
        saving: false,
      })),
      ...pending,
    ];
  },
);

async function saveVariable(row: EditableRow) {
  if (!row.key.trim() || row.saving) return;
  if (row.originalKey && row.originalKey !== row.key && row.id) {
    row.saving = true;
    try {
      await collections.deleteCollectionVariable(props.tab.id, row.id);
      row.id = null;
    } finally {
      row.saving = false;
    }
  }
  row.saving = true;
  try {
    const v = await collections.upsertCollectionVariable(
      props.tab.id,
      row.key.trim(),
      row.value,
      row.isSecret,
    );
    row.id = v.id;
    row.originalKey = v.key;
  } finally {
    row.saving = false;
  }
}

async function deleteVariable(row: EditableRow) {
  if (row.id) {
    await collections.deleteCollectionVariable(props.tab.id, row.id);
  }
  rows.value = rows.value.filter((r) => r !== row);
}

function addVariable() {
  rows.value = [
    ...rows.value,
    { id: null, key: '', value: '', isSecret: false, originalKey: null, saving: false },
  ];
}

const saving = ref(false);

async function save() {
  if (!workspace.currentProjectId) return;
  saving.value = true;
  try {
    const updated = await collections.updateCollection(
      workspace.currentProjectId,
      props.tab.collection,
    );
    tabs.refreshCollection(props.tab.id, updated);
  } finally {
    saving.value = false;
  }
}

const parentName = computed(() => {
  const pid = props.tab.collection.parentId;
  if (!pid) return null;
  const p = collections.findById(pid);
  return p?.name ?? null;
});

const breadcrumb = computed(() => {
  const chain = collections.ancestorChain(props.tab.collection.id);
  return chain.map((c) => c.name).join(' / ');
});

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
        <i class="pi pi-folder folder-icon" />
        <input
          v-model="props.tab.collection.name"
          class="name-input"
          @input="tabs.markDirty(props.tab.id)"
        />
        <span v-if="props.tab.dirty" class="dirty">•</span>
      </div>
      <div class="breadcrumb">{{ breadcrumb }}</div>
      <div class="spacer" />
      <Button
        icon="pi pi-trash"
        severity="danger"
        text
        size="small"
        label="Delete"
        @click="onDelete"
      />
      <Button
        label="Save"
        icon="pi pi-save"
        size="small"
        severity="secondary"
        :loading="saving"
        :disabled="!props.tab.dirty"
        @click="save"
      />
    </div>

    <Message severity="info" :closable="false" class="inherit-note">
      Auth and variables defined here are inherited by all requests and folders
      nested under this collection, unless overridden at a deeper level.
    </Message>

    <Tabs v-model:value="activePanel" class="panels">
      <TabList>
        <Tab value="auth">Auth</Tab>
        <Tab value="variables">Variables ({{ rows.length }})</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="auth">
          <p v-if="parentName" class="hint">
            Parent folder: <strong>{{ parentName }}</strong>. Set type to "No Auth"
            to inherit from it.
          </p>
          <AuthPanel v-model="auth" />
        </TabPanel>

        <TabPanel value="variables">
          <table class="vars-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th class="secret-col">Secret</th>
                <th class="actions-col"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in rows" :key="idx">
                <td>
                  <InputText
                    v-model="row.key"
                    class="cell-input"
                    placeholder="variable_name"
                    @blur="saveVariable(row)"
                  />
                </td>
                <td>
                  <InputText
                    v-model="row.value"
                    class="cell-input"
                    :type="row.isSecret ? 'password' : 'text'"
                    placeholder="value"
                    @blur="saveVariable(row)"
                  />
                </td>
                <td class="secret-col">
                  <Checkbox
                    v-model="row.isSecret"
                    binary
                    @update:model-value="saveVariable(row)"
                  />
                </td>
                <td class="actions-col">
                  <Button
                    icon="pi pi-times"
                    text
                    severity="secondary"
                    size="small"
                    @click="deleteVariable(row)"
                  />
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="4" class="empty">No collection variables yet.</td>
              </tr>
            </tbody>
          </table>
          <Button
            icon="pi pi-plus"
            label="Add variable"
            text
            size="small"
            @click="addVariable"
          />
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
}
.name {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.folder-icon {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 1rem;
}
.name-input {
  border: none;
  background: transparent;
  font-size: 1rem;
  font-weight: 500;
  width: 280px;
  outline: none;
}
.name-input:focus {
  border-bottom: 1px solid var(--p-primary-400, #60a5fa);
}
.dirty {
  color: var(--p-primary-500, #3b82f6);
  font-size: 1.2rem;
}
.breadcrumb {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.78rem;
  margin-left: 0.5rem;
}
.spacer {
  flex: 1;
}
.inherit-note {
  margin: 0.75rem 0.75rem 0 0.75rem;
  font-size: 0.82rem;
}
.panels {
  flex: 1;
  padding: 0.5rem 0.75rem;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.hint {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.82rem;
  margin-bottom: 0.5rem;
}
.vars-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}
.vars-table th {
  text-align: left;
  padding: 0.4rem 0.5rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #6b7280);
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
}
.vars-table td {
  padding: 0.25rem 0.35rem;
  border-bottom: 1px solid var(--p-content-border-color, #f3f4f6);
  vertical-align: middle;
}
.cell-input {
  width: 100%;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.82rem;
}
.secret-col,
.actions-col {
  width: 1%;
  white-space: nowrap;
  text-align: center;
}
.empty {
  padding: 0.75rem;
  text-align: center;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.82rem;
}
</style>
