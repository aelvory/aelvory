/**
 * Desktop's vue-i18n setup.
 *
 * Resolution order for the active locale:
 *   1. The user's explicit choice in Settings (settings.language).
 *   2. Tauri/browser-reported OS language (`navigator.language` etc.).
 *   3. English fallback.
 *
 * Translation message bundles live in `@aelvory/i18n` so the upcoming
 * web SPA, marketing site, and VSCode extension webview can all import
 * the same JSON files. The desktop only adds locale wiring on top.
 */

import { createI18n } from 'vue-i18n';
import {
  LOCALES,
  matchLocale,
  messages,
  type Locale,
  type MessageSchema,
} from '@aelvory/i18n';

export type { Locale } from '@aelvory/i18n';
export { LOCALES, LOCALE_NAMES } from '@aelvory/i18n';

/**
 * Read the OS / browser language(s) and pick the first supported match.
 * `navigator.languages` is preferred when available — it's an ordered
 * list of the user's preferences rather than the single primary one.
 */
export function detectOsLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const tags: readonly string[] = [
    ...(navigator.languages ?? []),
    navigator.language ?? '',
  ];
  for (const tag of tags) {
    const m = matchLocale(tag);
    if (m) return m;
  }
  return 'en';
}

/**
 * The third generic (`false`) explicitly opts into Composition-API
 * typing — without it, vue-i18n's type defaults to legacy mode, which
 * makes `i18n.global.locale` a plain string instead of a writable Ref
 * and breaks `i18n.global.locale.value = …` plus `watch(i18n.global.locale, …)`.
 */
export const i18n = createI18n<{ message: MessageSchema }, Locale, false>({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages,
  // Suppress noisy "Not found" warnings for un-translated keys —
  // missing keys correctly fall back to English at runtime; we don't
  // need a console line every time.
  missingWarn: false,
  fallbackWarn: false,
});

/** Apply a locale to vue-i18n + the document's lang attribute. */
export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', locale);
  }
}

/**
 * Resolve and apply the effective locale based on the settings store.
 * Call this once after Pinia is registered. Re-runs whenever the user
 * changes their preference; the watcher lives in the settings store.
 */
export function applyLocaleFromSettings(explicit: Locale | null): Locale {
  const target = explicit ?? detectOsLocale();
  setLocale(target);
  return target;
}

/** True if the given string is a supported locale code. */
export function isSupportedLocale(code: string | null | undefined): code is Locale {
  return !!code && (LOCALES as readonly string[]).includes(code);
}
