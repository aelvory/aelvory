<script setup lang="ts">
import { computed, ref } from 'vue';
import Popover from 'primevue/popover';
import Button from 'primevue/button';
import type { Collection, Variable } from '@aelvory/core';
import { useEnvironmentsStore } from '@/stores/environments';

const props = defineProps<{
  ancestorChain: Collection[];
  collectionVariables: Record<string, Variable[]>;
}>();

const environments = useEnvironmentsStore();
const panel = ref();

interface Row {
  key: string;
  value: string;
  source: string;
  effective: boolean;
}

const rows = computed<Row[]>(() => {
  const map = new Map<string, Row>();

  // Env vars first (base layer)
  for (const [k, v] of Object.entries(environments.activeVariables)) {
    map.set(k, {
      key: k,
      value: v,
      source: environments.activeEnv?.name ?? 'environment',
      effective: true,
    });
  }

  // Ancestor collection vars override (root first, deepest wins)
  for (const c of props.ancestorChain) {
    const vars = props.collectionVariables[c.id] ?? [];
    for (const v of vars) {
      if (v.value !== null) {
        map.set(v.key, {
          key: v.key,
          value: v.isSecret ? '••••••' + v.value.slice(-2) : v.value,
          source: c.name,
          effective: true,
        });
      }
    }
  }

  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
});

function toggle(ev: Event) {
  panel.value?.toggle(ev);
}

defineExpose({ toggle });
</script>

<template>
  <Button
    icon="pi pi-at"
    size="small"
    severity="secondary"
    text
    :label="`Vars (${rows.length})`"
    title="Show variables in scope"
    @click="toggle"
  />
  <Popover ref="panel">
    <div class="vars-pop">
      <div class="pop-header">
        Variables in scope
        <span v-if="environments.activeEnv" class="env-pill">env: {{ environments.activeEnv.name }}</span>
        <span v-else class="env-pill muted">no env</span>
      </div>
      <div v-if="!rows.length" class="empty">
        No variables defined. Add them in the environment picker (gear icon)
        or on an ancestor collection's Variables tab.
      </div>
      <table v-else class="vars-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" :class="{ 'not-effective': !row.effective }">
            <td class="k">{{ row.key }}</td>
            <td class="v" :title="row.value">{{ row.value }}</td>
            <td class="s">{{ row.source }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </Popover>
</template>

<style scoped>
.vars-pop {
  min-width: 360px;
  max-width: 520px;
  max-height: 420px;
  overflow: auto;
}
.pop-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0 0.5rem;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #6b7280);
}
.env-pill {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
  background: var(--p-highlight-background, #dbeafe);
  color: var(--p-primary-700, #1d4ed8);
  padding: 0.1rem 0.4rem;
  border-radius: 2px;
}
.env-pill.muted {
  background: var(--p-content-hover-background, #f3f4f6);
  color: var(--p-text-muted-color, #6b7280);
}
.empty {
  padding: 0.5rem 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color, #6b7280);
}
.vars-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.vars-table th {
  text-align: left;
  padding: 0.3rem 0.4rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #6b7280);
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
}
.vars-table td {
  padding: 0.25rem 0.4rem;
  vertical-align: top;
  border-bottom: 1px solid var(--p-content-border-color, #f3f4f6);
}
.k {
  font-family: 'SF Mono', Consolas, monospace;
  font-weight: 500;
  white-space: nowrap;
}
.v {
  font-family: 'SF Mono', Consolas, monospace;
  word-break: break-all;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.s {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.76rem;
  white-space: nowrap;
}
.not-effective {
  opacity: 0.5;
  font-style: italic;
}
</style>
