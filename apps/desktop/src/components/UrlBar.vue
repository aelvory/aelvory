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
  width: 100%;
  min-width: 0;
}
.method-select {
  min-width: 120px;
  flex-shrink: 0;
}

/* `.url-input` is the class we PASS to VarInputText, but the class
   actually lands on the inner <input> via `v-bind="$attrs"`. Naming
   collisions / specificity races against PrimeVue's own `.p-inputtext`
   rule (also a single-class selector) made the plain `.url-input`
   rule unreliable — sometimes won, sometimes lost depending on
   stylesheet load order. Use a :deep() escape so the rule targets
   the descendant input via a 2-class compound selector that's
   unambiguously more specific. */
:deep(.url-input.p-inputtext),
:deep(.url-input) {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.85rem;
}

/* Defensive: stop the Send button from being pushed past the right
   edge by an extreme URL (the input has min-width:0 above so it can
   shrink, but Send still needs `flex-shrink: 0` to never collapse). */
.url-bar > :deep(.p-button) {
  flex-shrink: 0;
}
</style>
