<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import { useConfirm } from 'primevue/useconfirm';
import { useEnvironmentsStore } from '@/stores/environments';
import { prompt } from '@/composables/prompt';

const { t } = useI18n();

const visible = defineModel<boolean>({ required: true });
const environments = useEnvironmentsStore();
const confirm = useConfirm();

interface EditableRow {
  id: string | null;
  key: string;
  value: string;
  isSecret: boolean;
  originalKey: string | null;
  saving: boolean;
}

const selectedEnvId = ref<string | null>(null);
const nameDraft = ref('');
const rows = ref<EditableRow[]>([]);

// Inline-create UI state. When `creating` is true, the env list
// shows a row with an InputText instead of stacking a PromptDialog
// modal on top of this one (modals-over-modals look cluttered and
// trap focus oddly). Press Enter or click confirm to create; Esc
// or blur with empty value to cancel.
const creating = ref(false);
const newName = ref('');
const newNameInput = ref<InstanceType<typeof InputText> | null>(null);

watch(
  () => visible.value,
  (v) => {
    if (v) {
      selectedEnvId.value = environments.activeEnvId ?? environments.environments[0]?.id ?? null;
      loadEnv();
    }
  },
);

watch(selectedEnvId, loadEnv);

async function loadEnv() {
  const id = selectedEnvId.value;
  if (!id) {
    rows.value = [];
    nameDraft.value = '';
    return;
  }
  const env = environments.environments.find((e) => e.id === id);
  nameDraft.value = env?.name ?? '';
  if (!environments.variablesByEnv[id]) {
    await environments.loadVariables(id);
  }
  const vars = environments.variablesByEnv[id] ?? [];
  rows.value = vars.map((v) => ({
    id: v.id,
    key: v.key,
    value: v.value ?? '',
    isSecret: v.isSecret,
    originalKey: v.key,
    saving: false,
  }));
}

async function saveName() {
  const id = selectedEnvId.value;
  if (!id) return;
  const env = environments.environments.find((e) => e.id === id);
  if (!env || env.name === nameDraft.value.trim() || !nameDraft.value.trim()) return;
  await environments.updateEnvironment(id, nameDraft.value.trim());
}

async function saveRow(row: EditableRow) {
  const id = selectedEnvId.value;
  if (!id) return;
  if (!row.key.trim() || row.saving) return;

  // If key was renamed, delete the old variable first.
  if (row.originalKey && row.originalKey !== row.key && row.id) {
    row.saving = true;
    try {
      await environments.deleteVariable(id, row.id);
      row.id = null;
    } finally {
      row.saving = false;
    }
  }

  row.saving = true;
  try {
    const v = await environments.upsertVariable(id, row.key.trim(), row.value, row.isSecret);
    row.id = v.id;
    row.originalKey = v.key;
  } finally {
    row.saving = false;
  }
}

async function deleteRow(row: EditableRow) {
  const id = selectedEnvId.value;
  if (!id) return;
  if (row.id) {
    await environments.deleteVariable(id, row.id);
  }
  rows.value = rows.value.filter((r) => r !== row);
}

function addRow() {
  rows.value = [
    ...rows.value,
    { id: null, key: '', value: '', isSecret: false, originalKey: null, saving: false },
  ];
}

function startCreate() {
  creating.value = true;
  newName.value = '';
  // Focus on next tick — the input element doesn't exist until the
  // v-if flips and Vue patches the DOM.
  setTimeout(() => {
    const el = (newNameInput.value as unknown as { $el?: HTMLElement } | null)?.$el;
    const input = el?.tagName === 'INPUT' ? (el as HTMLInputElement) : el?.querySelector('input');
    input?.focus();
  }, 0);
}

function cancelCreate() {
  creating.value = false;
  newName.value = '';
}

async function confirmCreate() {
  const name = newName.value.trim();
  if (!name) {
    cancelCreate();
    return;
  }
  creating.value = false;
  newName.value = '';
  const env = await environments.createEnvironment(name);
  selectedEnvId.value = env.id;
}

/**
 * Duplicate the currently-selected environment. Names the copy
 * "<source> (copy)", or "<source> (copy 2)", "(copy 3)", … to avoid
 * a UNIQUE-name collision when the user duplicates the same env
 * multiple times in a row.
 */
async function cloneEnv() {
  const id = selectedEnvId.value;
  if (!id) return;
  const src = environments.environments.find((e) => e.id === id);
  if (!src) return;

  const existingNames = new Set(environments.environments.map((e) => e.name));
  let candidate = `${src.name} (copy)`;
  let n = 2;
  while (existingNames.has(candidate)) {
    candidate = `${src.name} (copy ${n++})`;
  }

  const newEnv = await environments.cloneEnvironment(id, candidate);
  selectedEnvId.value = newEnv.id;
}

function deleteEnv() {
  const id = selectedEnvId.value;
  if (!id) return;
  const env = environments.environments.find((e) => e.id === id);
  if (!env) return;
  confirm.require({
    header: 'Delete environment',
    message: `Delete "${env.name}" and all its variables? This cannot be undone.`,
    acceptLabel: 'Delete',
    rejectLabel: 'Cancel',
    acceptClass: 'p-button-danger',
    accept: async () => {
      await environments.deleteEnvironment(id);
      selectedEnvId.value = environments.environments[0]?.id ?? null;
    },
  });
}

const selectedEnv = computed(
  () => environments.environments.find((e) => e.id === selectedEnvId.value) ?? null,
);
</script>

<template>
  <Dialog
    v-model:visible="visible"
    header="Environments"
    modal
    :style="{ width: '860px', maxWidth: '95vw' }"
    :content-style="{ padding: 0 }"
  >
    <div class="env-manager">
      <aside class="env-list">
        <div
          v-for="env in environments.environments"
          :key="env.id"
          class="env-item"
          :class="{ active: env.id === selectedEnvId }"
          @click="selectedEnvId = env.id"
        >
          <span class="env-name">{{ env.name }}</span>
          <span
            v-if="env.id === environments.activeEnvId"
            class="active-pill"
            title="Active environment"
          >active</span>
        </div>
        <div
          v-if="!environments.environments.length && !creating"
          class="empty"
        >
          No environments yet.
        </div>
        <div v-if="creating" class="create-row">
          <InputText
            ref="newNameInput"
            v-model="newName"
            placeholder="Environment name"
            class="create-input"
            @keydown.enter.prevent="confirmCreate"
            @keydown.esc.prevent="cancelCreate"
          />
          <Button
            icon="pi pi-check"
            severity="primary"
            size="small"
            text
            :disabled="!newName.trim()"
            @click="confirmCreate"
          />
          <Button
            icon="pi pi-times"
            severity="secondary"
            size="small"
            text
            @click="cancelCreate"
          />
        </div>
        <Button
          v-if="!creating"
          icon="pi pi-plus"
          label="New environment"
          text
          size="small"
          class="new-btn"
          @click="startCreate"
        />
      </aside>

      <section class="env-detail" v-if="selectedEnv">
        <div class="detail-header">
          <InputText
            v-model="nameDraft"
            class="name-input"
            @blur="saveName"
            @keydown.enter="saveName"
          />
          <Button
            icon="pi pi-clone"
            label="Duplicate"
            severity="secondary"
            text
            size="small"
            title="Copy this environment with all its variables"
            @click="cloneEnv"
          />
          <Button
            icon="pi pi-trash"
            label="Delete"
            severity="danger"
            text
            size="small"
            @click="deleteEnv"
          />
        </div>

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
                  @blur="saveRow(row)"
                />
              </td>
              <td>
                <InputText
                  v-model="row.value"
                  class="cell-input"
                  :type="row.isSecret ? 'password' : 'text'"
                  placeholder="value"
                  @blur="saveRow(row)"
                />
              </td>
              <td class="secret-col">
                <Checkbox
                  v-model="row.isSecret"
                  binary
                  @update:model-value="saveRow(row)"
                />
              </td>
              <td class="actions-col">
                <Button
                  icon="pi pi-times"
                  text
                  severity="secondary"
                  size="small"
                  @click="deleteRow(row)"
                />
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="4" class="empty-row">No variables yet.</td>
            </tr>
          </tbody>
        </table>

        <Button
          icon="pi pi-plus"
          label="Add variable"
          text
          size="small"
          @click="addRow"
        />

        <p class="note">
          Use <code v-pre>{{name}}</code> in URLs, headers, bodies, and auth
          to interpolate. The <strong>Secret</strong> flag currently just masks
          the value in inputs &mdash; E2EE is not wired up yet, so values are
          still stored in plaintext on the server.
        </p>
      </section>
      <section v-else class="env-detail empty-detail">
        <p>Select an environment on the left, or create a new one.</p>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
.env-manager {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 420px;
  max-height: 70vh;
}
.env-list {
  border-right: 1px solid var(--p-content-border-color, #e5e7eb);
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  overflow-y: auto;
}
.env-item {
  padding: 0.45rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
}
.env-item:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.env-item.active {
  background: var(--p-highlight-background, #dbeafe);
  color: var(--p-primary-700, #1d4ed8);
  font-weight: 500;
}
.env-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.active-pill {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-primary-600, #2563eb);
}
.empty {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.82rem;
  padding: 0.5rem;
}
.new-btn {
  justify-content: flex-start;
  margin-top: 0.5rem;
}
.create-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.35rem 0.5rem;
  margin-top: 0.5rem;
  border-radius: 4px;
  background: var(--p-content-hover-background, #f3f4f6);
}
.create-input {
  flex: 1;
  min-width: 0;
}
.env-detail {
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  overflow-y: auto;
}
.detail-header {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.name-input {
  flex: 1;
  font-size: 1rem;
  font-weight: 500;
}
.vars-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
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
.empty-row {
  padding: 0.75rem;
  text-align: center;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.82rem;
}
.note {
  margin-top: 1rem;
  padding: 0.6rem 0.75rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-radius: 4px;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.78rem;
  line-height: 1.4;
}
.note code {
  background: var(--p-content-hover-background, #e5e7eb);
  padding: 0.05rem 0.25rem;
  border-radius: 2px;
  font-size: 0.78rem;
}
.empty-detail {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.9rem;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
