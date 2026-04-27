<script setup lang="ts">
import { computed } from 'vue';
import Select from 'primevue/select';
import Button from 'primevue/button';
import CodeEditor, { type CodeLanguage } from './CodeEditor.vue';
import VarTextarea from './VarTextarea.vue';
import type { RequestBody } from '@aelvory/core';

const model = defineModel<RequestBody | null>({ required: true });

const types = [
  { label: 'None', value: 'none' },
  { label: 'Raw (JSON)', value: 'raw-json' },
  { label: 'Raw (Text)', value: 'raw-text' },
  { label: 'Raw (XML)', value: 'raw-xml' },
  { label: 'Form URL-encoded', value: 'form' },
];

const selected = computed({
  get(): string {
    if (!model.value || model.value.type === 'none') return 'none';
    if (model.value.type === 'raw') {
      const ct = (model.value.contentType ?? '').toLowerCase();
      if (ct.includes('xml')) return 'raw-xml';
      if (ct.includes('text')) return 'raw-text';
      return 'raw-json';
    }
    if (model.value.type === 'form') return 'form';
    return 'none';
  },
  set(v: string) {
    switch (v) {
      case 'none':
        model.value = null;
        break;
      case 'raw-json':
        model.value = {
          type: 'raw',
          raw: model.value?.raw ?? '',
          contentType: 'application/json',
        };
        break;
      case 'raw-text':
        model.value = {
          type: 'raw',
          raw: model.value?.raw ?? '',
          contentType: 'text/plain',
        };
        break;
      case 'raw-xml':
        model.value = {
          type: 'raw',
          raw: model.value?.raw ?? '',
          contentType: 'application/xml',
        };
        break;
      case 'form':
        model.value = {
          type: 'form',
          raw: model.value?.raw ?? '',
          contentType: 'application/x-www-form-urlencoded',
        };
        break;
    }
  },
});

const raw = computed({
  get: () => model.value?.raw ?? '',
  set: (v: string | undefined) => {
    if (model.value) {
      model.value = { ...model.value, raw: v ?? '' };
    }
  },
});

const editorLanguage = computed<CodeLanguage>(() => {
  if (selected.value === 'raw-json') return 'json';
  if (selected.value === 'raw-xml') return 'xml';
  return 'text';
});

const useCodeEditor = computed(() => selected.value !== 'form' && selected.value !== 'none');

function prettyJson() {
  try {
    raw.value = JSON.stringify(JSON.parse(raw.value || '{}'), null, 2);
  } catch {
    /* ignore */
  }
}

const isJson = computed(() => selected.value === 'raw-json');
</script>

<template>
  <div class="body-panel">
    <div class="controls">
      <Select
        v-model="selected"
        :options="types"
        option-label="label"
        option-value="value"
        class="type-select"
      />
      <Button
        v-if="isJson"
        label="Format"
        size="small"
        severity="secondary"
        text
        @click="prettyJson"
      />
    </div>

    <CodeEditor
      v-if="useCodeEditor"
      v-model="raw"
      :language="editorLanguage"
      min-height="260px"
    />
    <VarTextarea
      v-else-if="selected === 'form'"
      v-model="raw"
      rows="10"
      class="body-textarea"
      spellcheck="false"
      placeholder="key1=value1&key2=value2"
      auto-resize
    />
    <p v-else class="muted">This request has no body.</p>
  </div>
</template>

<style scoped>
.body-panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0;
}
.controls {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.type-select {
  min-width: 200px;
}
.body-textarea {
  width: 100%;
  font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.82rem;
  min-height: 200px;
}
.muted {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.85rem;
  padding: 0.5rem 0;
}
</style>
