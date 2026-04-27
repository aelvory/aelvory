import { inject, provide, ref, type InjectionKey, type Ref } from 'vue';

const KEY: InjectionKey<Ref<string[]>> = Symbol('aelvory-var-names');

const FALLBACK = ref<string[]>([]);

/**
 * Provide the list of variable names available in the current scope.
 * Typically called by RequestEditor / CollectionEditor / CurlConsole with
 * a computed that merges env + ancestor collection variables.
 */
export function provideVariableNames(vars: Ref<string[]>): void {
  provide(KEY, vars);
}

/**
 * Consume the current scope's variable names. Returns an empty list if
 * nothing was provided, so using a Var* input outside a scope is safe.
 */
export function useVariableNames(): Ref<string[]> {
  return inject(KEY, FALLBACK);
}
