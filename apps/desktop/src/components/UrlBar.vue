<script setup lang="ts">
import Select from 'primevue/select';
import Button from 'primevue/button';
import VarInputText from './VarInputText.vue';
import { computed } from 'vue';

const props = defineProps<{
  method: string;
  url: string;
  running: boolean;
}>();

const emit = defineEmits<{
  'update:method': [value: string];
  'update:url': [value: string];
  send: [];
}>();

const methods = [
  { label: 'GET', value: 'GET' },
  { label: 'POST', value: 'POST' },
  { label: 'PUT', value: 'PUT' },
  { label: 'PATCH', value: 'PATCH' },
  { label: 'DELETE', value: 'DELETE' },
  { label: 'HEAD', value: 'HEAD' },
  { label: 'OPTIONS', value: 'OPTIONS' },
];

const urlModel = computed({
  get: () => props.url,
  set: (v) => emit('update:url', v ?? ''),
});

function onMethod(v: string) {
  emit('update:method', v);
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    emit('send');
  }
}
</script>

<template>
  <div class="url-bar">
    <Select
      :model-value="props.method"
      :options="methods"
      option-label="label"
      option-value="value"
      class="method-select"
      @update:model-value="onMethod"
    />
    <VarInputText
      v-model="urlModel"
      placeholder="https://api.example.com/..."
      class="url-input"
      spellcheck="false"
      @keydown="onKeyDown"
    />
    <Button
      label="Send"
      severity="primary"
      :loading="props.running"
      @click="emit('send')"
    />
  </div>
</template>

<style scoped>
.url-bar {
  display: flex;
  gap: 0.4rem;
  align-items: stretch;
}
.method-select {
  min-width: 120px;
}
.url-input {
  flex: 1;
  font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.85rem;
}
</style>
