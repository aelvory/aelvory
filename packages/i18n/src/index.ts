/**
 * Shared i18n surface for every Aelvory front-end (desktop, web SPA,
 * VSCode extension webview, Astro marketing site). The English locale
 * is authoritative — its keys define the schema, every other locale
 * fills in the same shape. Missing keys fall back to English at runtime.
 *
 * Marketing copy (long-form pages, blog) lives in apps/marketing and is
 * NOT part of this package — content shape differs from the app UI.
 */

import en from './locales/en.json';
import de from './locales/de.json';
import es from './locales/es.json';
import zh from './locales/zh.json';

export type Locale = 'en' | 'de' | 'es' | 'zh';

export const LOCALES: readonly Locale[] = ['en', 'de', 'es', 'zh'] as const;

/** Native names — shown in the language picker. Always rendered in their own script. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  zh: '中文',
};

/** Shape of the message tree, derived from English. */
export type MessageSchema = typeof en;

/** Pre-loaded message bundles keyed by locale. */
export const messages: Record<Locale, MessageSchema> = {
  en,
  de: de as MessageSchema,
  es: es as MessageSchema,
  zh: zh as MessageSchema,
};

/**
 * Resolve a locale from a browser/OS language tag (e.g. `de-CH`, `zh-Hans-CN`).
 * Returns null if no supported language matches; caller decides the fallback.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase().split(/[-_]/)[0];
  if (lower === 'en') return 'en';
  if (lower === 'de') return 'de';
  if (lower === 'es') return 'es';
  if (lower === 'zh') return 'zh';
  return null;
}
