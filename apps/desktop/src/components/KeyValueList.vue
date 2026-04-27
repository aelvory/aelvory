<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Checkbox from 'primevue/checkbox';
import Button from 'primevue/button';
import VarInputText from './VarInputText.vue';
import VarTextarea from './VarTextarea.vue';
import type { Header } from '@aelvory/core';

const model = defineModel<Header[]>({ required: true });

const bulkMode = ref(false);
const bulkText = ref('');

function toBulk(list: Header[]): string {
  return list
    .filter((h) => h.key.trim().length > 0 || h.value.trim().length > 0)
    .map((h) => `${h.enabled ? '' : '//'}${h.key}: ${h.value}`)
    .join('\n');
}

function parseBulk(text: string): Header[] {
  const out: Header[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let enabled = true;
    let line = trimmed;
    if (line.startsWith('//')) {
      enabled = false;
      line = line.slice(2).trimStart();
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    out.push({ key, value, enabled });
  }
  return out;
}

function update(index: number, patch: Partial<Header>) {
  const next = [...(model.value ?? [])];
  next[index] = { ...next[index], ...patch };
  model.value = next;
}

function add() {
  model.value = [
    ...(model.value ?? []),
    { key: '', value: '', enabled: true },
  ];
}

function remove(index: number) {
  model.value = (model.value ?? []).filter((_, i) => i !== index);
}

function enterBulkMode() {
  bulkText.value = toBulk(model.value ?? []);
  bulkMode.value = true;
}

function exitBulkMode() {
  model.value = parseBulk(bulkText.value);
  bulkMode.value = false;
}

function onBulkBlur() {
  if (bulkMode.value) {
    model.value = parseBulk(bulkText.value);
  }
}

// If the model changes externally while we're NOT in bulk mode, do nothing —
// the table view reflects it. If we ARE in bulk mode and the model changes
// from elsewhere (rare), we re-serialize so they stay in sync.
watch(
  () => model.value,
  (v) => {
    if (bulkMode.value) {
      const currentFromModel = toBulk(v ?? []);
      // Only overwrite if it actually changed (avoid cursor resets)
      if (currentFromModel !== bulkText.value) {
        bulkText.value = currentFromModel;
      }
    }
  },
);

const itemCount = computed(() =>
  (model.value ?? []).filter((h) => h.key.trim() || h.value.trim()).length,
);
</script>

<template>
  <div class="kv-list">
    <template v-if="!bulkMode">
      <div
        v-for="(item, idx) in model"
        :key="idx"
        class="kv-row"
      >
        <Checkbox
          :model-value="item.enabled"
          binary
          @update:model-value="(v) => update(idx, { enabled: !!v })"
        />
        <VarInputText
          :model-value="item.key"
          placeholder="Key"
          class="kv-input"
          @update:model-value="(v: string | undefined) => update(idx, { key: v ?? '' })"
        />
        <VarInputText
          :model-value="item.value"
          placeholder="Value"
          class="kv-input"
          @update:model-value="(v: string | undefined) => update(idx, { value: v ?? '' })"
        />
        <Button
          icon="pi pi-times"
          text
          severity="secondary"
          size="small"
          aria-label="Remove"
          @click="remove(idx)"
        />
      </div>
      <div class="toolbar">
        <Button
          label="Add"
          icon="pi pi-plus"
          text
          size="small"
          @click="add"
        />
        <Button
          label="Bulk edit"
          icon="pi pi-list"
          text
          size="small"
          severity="secondary"
          @click="enterBulkMode"
        />
      </div>
    </template>

    <template v-else>
      <VarTextarea
        v-model="bulkText"
        rows="10"
        class="bulk-textarea"
        spellcheck="false"
        placeholder="Key: Value
Authorization: Bearer {{token}}
// Disabled-Header: will not be sent"
        @blur="onBulkBlur"
      />
      <div class="toolbar">
        <span class="hint">
          One header per line. Use <code>//</code> at the start to disable a line.
        </span>
        <Button
          label="Key-value edit"
          icon="pi pi-table"
          text
          size="small"
          @click="exitBulkMode"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.kv-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0;
}
.kv-row {
  display: grid;
  grid-template-columns: auto 1fr 1fr auto;
  gap: 0.4rem;
  align-items: center;
}
.kv-input {
  font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.82rem;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-top: 0.25rem;
}
.bulk-textarea {
  font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.82rem;
  width: 100%;
  min-height: 180px;
}
.hint {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.76rem;
  margin-right: auto;
}
.hint code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
  font-size: 0.76rem;
}
</style>
