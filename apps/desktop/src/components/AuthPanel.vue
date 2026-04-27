<script setup lang="ts">
import { computed } from 'vue';
import Select from 'primevue/select';
import Password from 'primevue/password';
import VarInputText from './VarInputText.vue';
import type { AuthConfig } from '@aelvory/core';

const model = defineModel<AuthConfig | null>({ required: true });

/**
 * UI-level auth selector. Maps the dropdown value to the persisted
 * shape on disk:
 *   - 'inherit' → model = null. The runner's `effectiveAuth` walks
 *     ancestor collections and uses the first non-none auth. This
 *     is the default for new requests.
 *   - 'none'    → model = { type: 'none', config: {} }. Explicit
 *     override that suppresses inheritance (anyone above us in the
 *     tree defining auth is ignored).
 *   - any other → model = { type, config }. Specific auth scheme.
 */
const types = [
  { label: 'Inherit from parent', value: 'inherit' },
  { label: 'No Auth', value: 'none' },
  { label: 'Bearer Token', value: 'bearer' },
  { label: 'Basic Auth', value: 'basic' },
  { label: 'API Key', value: 'apikey' },
];

const selected = computed({
  get: () => (model.value === null ? 'inherit' : model.value.type),
  set: (v: string) => {
    if (v === 'inherit') {
      model.value = null;
    } else if (v === 'none') {
      model.value = { type: 'none', config: {} };
    } else {
      model.value = {
        type: v as AuthConfig['type'],
        config: model.value?.type === v ? model.value.config : {},
      };
    }
  },
});

function updateConfig(patch: Record<string, unknown>) {
  if (!model.value) return;
  model.value = {
    ...model.value,
    config: { ...(model.value.config ?? {}), ...patch },
  };
}

const bearerToken = computed({
  get: () => String(model.value?.config?.token ?? ''),
  set: (v) => updateConfig({ token: v }),
});

const basicUser = computed({
  get: () => String(model.value?.config?.username ?? ''),
  set: (v) => updateConfig({ username: v }),
});
const basicPass = computed({
  get: () => String(model.value?.config?.password ?? ''),
  set: (v) => updateConfig({ password: v }),
});

const apiKeyKey = computed({
  get: () => String(model.value?.config?.key ?? ''),
  set: (v) => updateConfig({ key: v }),
});
const apiKeyValue = computed({
  get: () => String(model.value?.config?.value ?? ''),
  set: (v) => updateConfig({ value: v }),
});
const apiKeyWhere = computed({
  get: () => String(model.value?.config?.in ?? 'header'),
  set: (v) => updateConfig({ in: v }),
});
</script>

<template>
  <div class="auth-panel">
    <div class="row">
      <label>Type</label>
      <Select
        v-model="selected"
        :options="types"
        option-label="label"
        option-value="value"
        class="type-select"
      />
    </div>

    <div v-if="selected === 'bearer'" class="fields">
      <label>Token</label>
      <VarInputText
        v-model="bearerToken"
        placeholder="Bearer token"
        class="input"
      />
    </div>

    <div v-else-if="selected === 'basic'" class="fields">
      <label>Username</label>
      <VarInputText v-model="basicUser" class="input" />
      <label>Password</label>
      <Password
        v-model="basicPass"
        :feedback="false"
        toggle-mask
        input-class="input"
      />
    </div>

    <div v-else-if="selected === 'apikey'" class="fields">
      <label>Key</label>
      <VarInputText v-model="apiKeyKey" class="input" />
      <label>Value</label>
      <VarInputText v-model="apiKeyValue" class="input" />
      <label>Add to</label>
      <Select
        v-model="apiKeyWhere"
        :options="[
          { label: 'Header', value: 'header' },
          { label: 'Query param', value: 'query' },
        ]"
        option-label="label"
        option-value="value"
        class="type-select"
      />
    </div>

    <div v-else class="muted">No authentication will be applied.</div>
  </div>
</template>

<style scoped>
.auth-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.5rem 0;
}
.row,
.fields {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 0.5rem 0.75rem;
  align-items: center;
}
.type-select {
  width: 240px;
}
.input {
  font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.82rem;
}
label {
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #6b7280);
}
.muted {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.85rem;
}
</style>
