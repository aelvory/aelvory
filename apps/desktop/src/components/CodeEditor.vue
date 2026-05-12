<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { javascript } from '@codemirror/lang-javascript';
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { useVariableNames } from '@/composables/variables';

export type CodeLanguage = 'json' | 'xml' | 'text' | 'javascript';

const props = withDefaults(
  defineProps<{
    language?: CodeLanguage;
    readonly?: boolean;
    minHeight?: string;
    placeholder?: string;
  }>(),
  { language: 'text', readonly: false, minHeight: '200px' },
);

const model = defineModel<string | undefined>();
const host = ref<HTMLDivElement | null>(null);
const vars = useVariableNames();

const languageCompartment = new Compartment();
const readonlyCompartment = new Compartment();
const themeCompartment = new Compartment();

let view: EditorView | null = null;
let applyingExternal = false;
let themeObserver: MutationObserver | null = null;

/**
 * Build a CodeMirror theme that pulls colors from our PrimeVue
 * tokens. The tokens flip light/dark via the `.dark` class on
 * <html>; the theme reconfigures via `themeCompartment` whenever
 * that class toggles.
 *
 * The `dark: true` flag in the second arg is critical: CodeMirror
 * uses it to pick its built-in defaults for any rules we DON'T
 * override (selection range outline, autocomplete dropdown chrome,
 * etc.). Without it, even with our color overrides, those bits
 * stay light.
 */
function buildTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--p-content-background)',
        color: 'var(--p-text-color)',
      },
      '.cm-scroller': { fontFamily: "'SF Mono', Consolas, monospace" },
      '.cm-content': {
        fontSize: '0.82rem',
        caretColor: 'var(--p-text-color)',
      },
      '.cm-focused': { outline: 'none' },
      // Line-number gutter — was inheriting CodeMirror's hardcoded
      // light scheme (white bg, dark digits) regardless of our
      // .dark class. Now uses tokens that flip.
      '.cm-gutters': {
        backgroundColor: 'var(--p-content-hover-background)',
        color: 'var(--p-text-muted-color)',
        border: 'none',
      },
      // Active-line highlight — CodeMirror's drawSelection layer
      // sits at z-index -2, so a SOLID background on .cm-activeLine
      // (which renders on top at z-index 0) covers any selection
      // rectangle drawn on the same line. We use a low-alpha
      // overlay instead so a selected region on the active line is
      // still visible — the line-highlight tints, doesn't hide.
      //
      // Hardcoded rgba instead of var() because the PrimeVue
      // content-hover-background tokens are opaque solid colors.
      '.cm-activeLine': {
        backgroundColor: dark
          ? 'rgba(255, 255, 255, 0.04)'
          : 'rgba(0, 0, 0, 0.04)',
      },
      // The gutter cell on the active line is fine to keep opaque —
      // no selection is ever drawn there, so the higher contrast is
      // a useful "you are here" indicator with no downside.
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--p-content-hover-background)',
        color: 'var(--p-text-color)',
      },
      // Text selection — third attempt at this. CodeMirror draws
      // selection rectangles via `.cm-selectionBackground` divs
      // inside `.cm-selectionLayer`. Two things bit us before:
      //
      //   1. Single-line selections were rendering via native
      //      browser ::selection instead of the drawn layer, so my
      //      `.cm-selectionBackground` rules only kicked in on
      //      multi-line drags.
      //   2. CodeMirror's baseTheme / Aura's emerald-tinted defaults
      //      were winning the cascade against my selectors that
      //      weren't strong enough.
      //
      // Fix: every selection-related selector AND `!important`
      // everywhere. Hardcoded brighter colors (#1e6091 dark = a
      // saturated blue with high contrast against any dark
      // editor background, NOT the subtle #264f78 VSCode uses;
      // that turned out too faint here). Same shade for focused
      // and unfocused — the cursor presence is enough of a focus
      // indicator without changing the highlight too.
      '&.cm-editor .cm-selectionBackground, & .cm-selectionLayer > *, &.cm-editor.cm-focused .cm-selectionBackground': {
        background: (dark ? '#1e6091' : '#9cc7f5') + ' !important',
      },
      // Native ::selection covers single-line drags that bypass
      // the drawn layer plus any non-content nodes (placeholder
      // text, line numbers if selectable, etc).
      '.cm-content ::selection, .cm-line ::selection, & ::selection': {
        background: (dark ? '#1e6091' : '#9cc7f5') + ' !important',
        color: 'inherit !important',
      },
      // Autocomplete dropdown — without this, the popover stays
      // white-on-dark in dark mode.
      '.cm-tooltip': {
        backgroundColor: 'var(--p-content-background)',
        color: 'var(--p-text-color)',
        border: '1px solid var(--p-content-border-color)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        color: 'var(--p-text-color)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--p-highlight-background)',
        color: 'var(--p-text-color)',
      },
    },
    { dark },
  );
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

function langExtension(lang: CodeLanguage) {
  if (lang === 'xml') return xml();
  if (lang === 'json') return json();
  if (lang === 'javascript') return javascript();
  return [];
}

function varCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const before = ctx.matchBefore(/\{\{[a-zA-Z0-9_\-.]*/);
  if (!before) return null;
  const query = before.text.slice(2).toLowerCase();
  const source = vars.value;
  const starts: string[] = [];
  const contains: string[] = [];
  for (const v of source) {
    const lower = v.toLowerCase();
    if (lower.startsWith(query)) starts.push(v);
    else if (query && lower.includes(query)) contains.push(v);
  }
  const matches = [...starts, ...contains].slice(0, 12);
  if (!matches.length) {
    return {
      from: before.from,
      options: [
        {
          label: 'No variables in scope',
          apply: before.text,
          type: 'text',
          detail: 'define one in env or a parent collection',
        },
      ],
      filter: false,
    };
  }
  return {
    from: before.from,
    options: matches.map((v) => ({
      label: `{{${v}}}`,
      apply: `{{${v}}}`,
      type: 'variable',
      boost: v.toLowerCase().startsWith(query) ? 1 : 0,
    })),
    filter: false,
  };
}

function buildExtensions() {
  return [
    basicSetup,
    languageCompartment.of(langExtension(props.language)),
    readonlyCompartment.of(EditorState.readOnly.of(props.readonly)),
    autocompletion({
      override: [varCompletionSource],
      activateOnTyping: true,
    }),
    EditorView.updateListener.of((update) => {
      if (applyingExternal) return;
      if (update.docChanged) {
        model.value = update.state.doc.toString();
      }
    }),
    themeCompartment.of(buildTheme(isDarkMode())),
  ];
}

onMounted(() => {
  if (!host.value) return;
  const state = EditorState.create({
    doc: model.value ?? '',
    extensions: buildExtensions(),
  });
  view = new EditorView({ state, parent: host.value });

  // Re-theme the editor when the user toggles light / dark in
  // Settings (or the OS preference changes for 'auto'). The .dark
  // class on <html> is the single source of truth — composables/
  // theme.ts adds / removes it; we just react.
  themeObserver = new MutationObserver(() => {
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(buildTheme(isDarkMode())),
    });
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
});

onUnmounted(() => {
  themeObserver?.disconnect();
  themeObserver = null;
  view?.destroy();
  view = null;
});

watch(
  () => model.value,
  (v) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if ((v ?? '') === current) return;
    applyingExternal = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: v ?? '' },
    });
    applyingExternal = false;
  },
);

watch(
  () => props.language,
  (lang) => {
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.reconfigure(langExtension(lang)),
    });
  },
);

watch(
  () => props.readonly,
  (ro) => {
    if (!view) return;
    view.dispatch({
      effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(ro)),
    });
  },
);
</script>

<template>
  <div ref="host" class="code-editor" :style="{ minHeight }" />
</template>

<style scoped>
.code-editor {
  border: 1px solid var(--p-form-field-border-color, #d1d5db);
  border-radius: 4px;
  overflow: hidden;
  background: var(--p-content-background, white);
}
.code-editor:focus-within {
  border-color: var(--p-primary-400, #60a5fa);
}
</style>
