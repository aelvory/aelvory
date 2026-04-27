/**
 * Type shims for PrimeVue subpath imports that don't ship `.d.ts`
 * files alongside their `.mjs` modules.
 *
 * Why this is needed: PrimeVue 4's `primevue/toasteventbus` is a
 * functional event bus exposed as a default export; it works at runtime
 * (the `<Toast />` component subscribes to it from inside the dialog),
 * but the package's `exports` map doesn't surface a type definition for
 * this subpath. Without this shim, vue-tsc fails strict builds.
 *
 * The runtime API surface we use is tiny — `emit('add', msg)` —
 * so we declare just that. If we ever start calling `on`/`off` here,
 * extend this declaration in lockstep.
 */
declare module 'primevue/toasteventbus' {
  /** Single-token event name we emit. PrimeVue's `<Toast />` listens for this. */
  type ToastEvent = 'add' | 'remove' | 'remove-group' | 'remove-all-groups';

  interface ToastEventBus {
    emit(event: ToastEvent, payload?: unknown): void;
    on(event: ToastEvent, handler: (payload: unknown) => void): void;
    off(event: ToastEvent, handler: (payload: unknown) => void): void;
  }

  const ToastEventBus: ToastEventBus;
  export default ToastEventBus;
}
