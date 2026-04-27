/**
 * Imperative replacement for `window.prompt()`. Returns a Promise that
 * resolves with the user's input or `null` if they cancelled.
 *
 * Usage:
 *   import { prompt } from '@/composables/prompt';
 *   const name = await prompt({ title: 'New collection', label: 'Name' });
 *   if (name) await collections.create(name);
 *
 * The dialog itself lives in <PromptDialog />, mounted once in App.vue.
 * Internal state (visible flag, current request) is module-level so the
 * imperative API and the rendered component share it.
 */
import { ref } from 'vue';

export interface PromptOptions {
  /** Header on the dialog. */
  title: string;
  /** Label rendered above the input. Optional. */
  label?: string;
  /** Pre-fills the input. Useful for "rename" flows. */
  default?: string;
  /** Helper text under the input. Optional. */
  hint?: string;
  /** Placeholder when the input is empty. Optional. */
  placeholder?: string;
  /** Label for the confirm button. Default "OK". */
  confirmLabel?: string;
  /** Label for the cancel button. Default "Cancel". */
  cancelLabel?: string;
}

interface ActiveRequest extends Required<Pick<PromptOptions, 'title'>> {
  label: string;
  defaultValue: string;
  hint: string;
  placeholder: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Wrapped resolver — idempotent, only fires once. */
  resolve: (value: string | null) => void;
}

const visible = ref(false);
const active = ref<ActiveRequest | null>(null);

export function prompt(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const wrap = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    active.value = {
      title: opts.title,
      label: opts.label ?? '',
      defaultValue: opts.default ?? '',
      hint: opts.hint ?? '',
      placeholder: opts.placeholder ?? '',
      confirmLabel: opts.confirmLabel ?? 'OK',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      resolve: wrap,
    };
    visible.value = true;
  });
}

/**
 * Internal — only PromptDialog.vue should reach in here. Exported as a
 * function (not direct ref export) so callers don't accidentally mutate.
 */
export function _promptInternals() {
  return { visible, active };
}
