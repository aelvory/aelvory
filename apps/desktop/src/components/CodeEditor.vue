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

let view: EditorView | null = null;
let applyingExternal = false;

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
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-scroller': { fontFamily: "'SF Mono', Consolas, monospace" },
      '.cm-content': { fontSize: '0.82rem' },
      '.cm-focused': { outline: 'none' },
    }),
  ];
}

onMounted(() => {
  if (!host.value) return;
  const state = EditorState.create({
    doc: model.value ?? '',
    extensions: buildExtensions(),
  });
  view = new EditorView({ state, parent: host.value });
});

onUnmounted(() => {
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
