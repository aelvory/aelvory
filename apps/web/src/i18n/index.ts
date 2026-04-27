/**
 * Web admin's vue-i18n setup. Reuses the message bundles from
 * `@aelvory/i18n` (same as the desktop app) so common strings stay
 * consistent. Web-specific strings can be added there later when the
 * surface settles; for the initial build we lean on inline English to
 * keep the diff small and let the user verify the flow first.
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

function detectOsLocale(): Locale {
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

export const i18n = createI18n<{ message: MessageSchema }, Locale, false>({
  legacy: false,
  locale: detectOsLocale(),
  fallbackLocale: 'en',
  messages,
  missingWarn: false,
  fallbackWarn: false,
});

export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', locale);
  }
}
