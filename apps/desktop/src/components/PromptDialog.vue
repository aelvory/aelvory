<script setup lang="ts">
/**
 * Renders the imperative `prompt()` composable. Mounted once globally
 * (in App.vue) — never instantiated by feature code.
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import { _promptInternals } from '@/composables/prompt';

const { t } = useI18n();

const { visible, active } = _promptInternals();

const value = ref('');
const inputRef = ref<InstanceType<typeof InputText> | null>(null);

/**
 * Focus the input AFTER PrimeVue's Dialog has finished opening.
 *
 * The fight: PrimeVue's <Dialog> on open calls
 * `getFocusableElements(container)[0].focus()` if no element has
 * the `autofocus` attribute. The close button (×) is the first
 * focusable in DOM order (it's in the header, rendered before the
 * body), so without intervention it grabs focus.
 *
 * Two interventions stacked:
 *
 *   1. `autofocus` attribute on the InputText below. PrimeVue's
 *      focus-management hook checks `[autofocus]:not([disabled])`
 *      first and uses that element instead of the close button —
 *      this is the primary mechanism.
 *
 *   2. setTimeout 100 ms fallback here, only if step 1 didn't take
 *      (PrimeVue version drift, animation timing, etc.). 100 ms
 *      comfortably outlasts the default Dialog open transition
 *      (~150 ms internal); if focus has already landed on the input
 *      we skip the second focus to avoid breaking input.select().
 *
 * The earlier `requestAnimationFrame`-only approach raced PrimeVue's
 * own focus call — sometimes won, sometimes lost depending on
 * scheduler — so it appeared to fix things in dev but not reliably.
 * setTimeout with a real delay is the reliable hammer.
 */
function onShow() {
  value.value = active.value?.defaultValue ?? '';
  setTimeout(() => {
    const el = (inputRef.value as unknown as { $el?: HTMLElement } | null)?.$el;
    const input = el?.tagName === 'INPUT' ? (el as HTMLInputElement) : el?.querySelector('input');
    if (!input) return;
    if (document.activeElement !== input) {
      input.focus();
      // Select-all when prefilling — rename flow is "edit, not
      // append." Empty default → no-op.
      input.select();
    }
  }, 100);
}

function confirm() {
  const trimmed = value.value.trim();
  active.value?.resolve(trimmed.length > 0 ? trimmed : null);
  visible.value = false;
}

function cancel() {
  active.value?.resolve(null);
  visible.value = false;
}

// Dialog's `@hide` fires after Esc, outside-click, or our own close.
// Guard against double-resolve via the `settled` flag inside the
// composable's wrap fn.
function onHide() {
  active.value?.resolve(null);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    confirm();
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="active?.title ?? 'Input'"
    :style="{ width: '420px' }"
    :draggable="false"
    @show="onShow"
    @hide="onHide"
  >
    <div class="prompt-body">
      <label v-if="active?.label" class="prompt-label">{{ active.label }}</label>
      <InputText
        ref="inputRef"
        v-model="value"
        class="prompt-input"
        :placeholder="active?.placeholder"
        spellcheck="false"
        autocomplete="off"
        autofocus
        @keydown="onKeydown"
      />
      <p v-if="active?.hint" class="prompt-hint">{{ active.hint }}</p>
    </div>
    <template #footer>
      <Button
        :label="active?.cancelLabel ?? t('common.cancel')"
        severity="secondary"
        text
        @click="cancel"
      />
      <Button
        :label="active?.confirmLabel ?? t('common.ok')"
        :disabled="value.trim().length === 0"
        @click="confirm"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.prompt-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.25rem 0.25rem 0;
}
.prompt-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--p-text-color, #111827);
}
.prompt-input {
  width: 100%;
}
.prompt-hint {
  margin: 0.1rem 0 0;
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #6b7280);
  line-height: 1.4;
}
</style>
