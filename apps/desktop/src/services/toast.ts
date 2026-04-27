/**
 * Toast helper that works outside Vue components.
 *
 * `useToast()` from PrimeVue requires a setup() context (it's an
 * `inject` under the hood). For code paths like the native-menu
 * dispatcher in `services/menu.ts`, we don't have one — but PrimeVue
 * exposes a singleton `ToastEventBus` we can emit to directly. The
 * `<Toast />` component mounted in App.vue subscribes to that bus, so
 * everything routes through the same UI surface.
 */
import ToastEventBus from 'primevue/toasteventbus';

export type ToastSeverity = 'success' | 'info' | 'warn' | 'error' | 'secondary' | 'contrast';

export interface ToastOptions {
  severity: ToastSeverity;
  summary: string;
  detail?: string;
  /** Auto-close timeout in ms. Default 4000. Set 0 for sticky. */
  life?: number;
}

export function toast(opts: ToastOptions): void {
  ToastEventBus.emit('add', {
    severity: opts.severity,
    summary: opts.summary,
    detail: opts.detail,
    life: opts.life ?? 4000,
  });
}
