<script setup lang="ts">
/**
 * URL query parameter editor.
 *
 * Same row layout as KeyValueList ([toggle] [key] [value] [delete])
 * but with two extras:
 *
 *  - **Presets per row.** Each param row can define an allowed-value
 *    list. When that list is non-empty the value cell renders as a
 *    Select instead of a free-text input — saves the user from
 *    re-typing enum-like params (e.g. `kind=tick_data_mismatch | …`)
 *    every time.
 *  - **Preset CRUD in a popover.** A small ⋯ icon on each row opens
 *    an inline editor where the user can add/remove/clear preset
 *    values. The same popover is the only place where you "promote"
 *    a free-text param to a preset-backed one.
 *
 * The preset list lives on the QueryParam row itself (stored with
 * the request), not on a project-level registry. Simpler model for
 * v1; can be lifted to project scope later if reuse across requests
 * is requested.
 */
import { computed, nextTick, ref } from 'vue';
import Checkbox from 'primevue/checkbox';
import Button from 'primevue/button';
import Popover from 'primevue/popover';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import VarInputText from './VarInputText.vue';
import type { QueryParam } from '@aelvory/core';

const model = defineModel<QueryParam[]>({ required: true });

function update(index: number, patch: Partial<QueryParam>) {
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

// --- preset popover state ---
//
// PrimeVue Popover is a singleton-per-instance ref; we keep ONE
// popover and open it against whichever row's "⋯" was clicked, so we
// can reuse the same DOM node for every row. `editingIndex` tracks
// the row currently being edited.
const popoverRef = ref<InstanceType<typeof Popover> | null>(null);
const editingIndex = ref<number | null>(null);
const newPresetValue = ref('');

const editingParam = computed<QueryParam | null>(() => {
  if (editingIndex.value == null) return null;
  return model.value?.[editingIndex.value] ?? null;
});

function openPresets(event: Event, index: number) {
  editingIndex.value = index;
  newPresetValue.value = '';
  // Wait a tick so the popover content sees the updated `editingParam`
  // before measuring its size.
  nextTick(() => popoverRef.value?.show(event));
}

function addPreset() {
  const idx = editingIndex.value;
  const v = newPresetValue.value.trim();
  if (idx == null || !v) return;
  const param = model.value?.[idx];
  if (!param) return;
  const existing = param.presets ?? [];
  if (existing.includes(v)) {
    newPresetValue.value = '';
    return;
  }
  update(idx, { presets: [...existing, v] });
  newPresetValue.value = '';
}

function removePreset(value: string) {
  const idx = editingIndex.value;
  if (idx == null) return;
  const param = model.value?.[idx];
  if (!param) return;
  const next = (param.presets ?? []).filter((p) => p !== value);
  update(idx, { presets: next.length ? next : undefined });
}

function clearAllPresets() {
  const idx = editingIndex.value;
  if (idx == null) return;
  update(idx, { presets: undefined });
}

// Value-cell options model: when the user picks an existing preset,
// we set the row's `value` to it. When they pick the "custom" entry,
// we keep whatever value is currently in there (so the user can keep
// editing manually).
//
// `__custom__` is the sentinel for the "type your own" choice; chosen
// because no legitimate preset would start with two underscores +
// "custom".
const CUSTOM_OPTION_VALUE = '__custom__';
function selectOptions(presets: string[]): { label: string; value: string }[] {
  return [
    ...presets.map((p) => ({ label: p, value: p })),
    { label: '(custom)', value: CUSTOM_OPTION_VALUE },
  ];
}
function valueSelectModel(param: QueryParam): string {
  // If the param's current value is one of the presets, show it
  // selected; otherwise treat it as a custom freeform value.
  if ((param.presets ?? []).includes(param.value)) return param.value;
  return CUSTOM_OPTION_VALUE;
}
function onValueSelect(index: number, picked: string) {
  if (picked === CUSTOM_OPTION_VALUE) {
    // No value change — just leaves the freeform input active.
    return;
  }
  update(index, { value: picked });
}
</script>

<template>
  <div class="qp-list">
    <div
      v-for="(item, idx) in model"
      :key="idx"
      class="qp-row"
    >
      <Checkbox
        :model-value="item.enabled"
        binary
        @update:model-value="(v) => update(idx, { enabled: !!v })"
      />
      <VarInputText
        :model-value="item.key"
        placeholder="Key"
        class="qp-input"
        @update:model-value="(v: string | undefined) => update(idx, { key: v ?? '' })"
      />
      <!--
        Value cell.
        - With presets defined: row is [Select preset] + [VarInputText for the
          actual value]. Picking a preset overwrites the value; picking "(custom)"
          leaves whatever's in the input so the user keeps editing.
        - Without presets: just the free-text input.
      -->
      <div class="qp-value-cell">
        <Select
          v-if="(item.presets?.length ?? 0) > 0"
          :model-value="valueSelectModel(item)"
          :options="selectOptions(item.presets ?? [])"
          option-label="label"
          option-value="value"
          class="qp-preset-select"
          @update:model-value="(v: string) => onValueSelect(idx, v)"
        />
        <VarInputText
          :model-value="item.value"
          placeholder="Value"
          class="qp-input qp-value-input"
          @update:model-value="(v: string | undefined) => update(idx, { value: v ?? '' })"
        />
      </div>
      <Button
        icon="pi pi-list"
        text
        severity="secondary"
        size="small"
        :title="(item.presets?.length ?? 0) > 0 ? `${item.presets!.length} presets` : 'Manage presets'"
        aria-label="Manage presets"
        @click="(e) => openPresets(e, idx)"
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
        label="Add param"
        icon="pi pi-plus"
        text
        size="small"
        @click="add"
      />
      <span v-if="!(model?.length)" class="hint">
        Add a query parameter — appended to the URL at send time, e.g.
        <code>?kind=tick_data_mismatch&amp;type=lite</code>
      </span>
    </div>

    <Popover ref="popoverRef" class="preset-popover">
      <div v-if="editingParam" class="preset-editor">
        <div class="preset-header">
          <strong>Presets for "{{ editingParam.key || '(unnamed param)' }}"</strong>
          <span class="hint">
            Define allowed values for this parameter — they'll show up as
            a dropdown next to the value field.
          </span>
        </div>
        <ul v-if="(editingParam.presets?.length ?? 0) > 0" class="preset-list">
          <li v-for="p in editingParam.presets" :key="p" class="preset-row">
            <span class="preset-val">{{ p }}</span>
            <Button
              icon="pi pi-times"
              text
              severity="secondary"
              size="small"
              aria-label="Remove preset"
              @click="removePreset(p)"
            />
          </li>
        </ul>
        <p v-else class="empty-presets">No presets yet.</p>
        <div class="preset-add">
          <InputText
            v-model="newPresetValue"
            placeholder="Add a value"
            class="preset-add-input"
            @keydown.enter.prevent="addPreset"
          />
          <Button
            label="Add"
            icon="pi pi-plus"
            size="small"
            :disabled="!newPresetValue.trim()"
            @click="addPreset"
          />
        </div>
        <div v-if="(editingParam.presets?.length ?? 0) > 0" class="preset-footer">
          <Button
            label="Clear all presets"
            icon="pi pi-trash"
            text
            size="small"
            severity="danger"
            @click="clearAllPresets"
          />
        </div>
      </div>
    </Popover>
  </div>
</template>

<style scoped>
.qp-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0;
}
.qp-row {
  display: grid;
  grid-template-columns: auto 1fr 2fr auto auto;
  gap: 0.4rem;
  align-items: center;
}
.qp-input {
  font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.82rem;
}
.qp-value-cell {
  display: flex;
  gap: 0.3rem;
  align-items: stretch;
  min-width: 0;
}
.qp-preset-select {
  flex: 0 0 auto;
  min-width: 8rem;
  max-width: 14rem;
}
.qp-value-input {
  flex: 1 1 auto;
  min-width: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-top: 0.25rem;
}
.hint {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.76rem;
}
.hint code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
  font-size: 0.76rem;
}
.preset-popover {
  width: 320px;
}
.preset-editor {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.preset-header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.preset-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  max-height: 220px;
  overflow-y: auto;
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.4rem;
  background: var(--p-content-hover-background, #f3f4f6);
  border-radius: 3px;
}
.preset-val {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.82rem;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-presets {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.78rem;
  margin: 0;
}
.preset-add {
  display: flex;
  gap: 0.3rem;
}
.preset-add-input {
  flex: 1;
}
.preset-footer {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--p-content-border-color, #e5e7eb);
  padding-top: 0.4rem;
}
</style>
