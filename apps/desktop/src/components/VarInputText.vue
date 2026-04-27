<script setup lang="ts">
import { ref } from 'vue';
import InputText from 'primevue/inputtext';
import VarAutocomplete from './VarAutocomplete.vue';

// Multi-root component (the InputText + the autocomplete dropdown).
// Without `inheritAttrs: false` Vue would try to forward parent attrs
// to BOTH roots and warn; we instead route them explicitly to the
// InputText below via `v-bind="$attrs"`. This is what makes
// `<VarInputText class="url-input">` actually apply the class to the
// underlying <input> — without it, the class lands on nothing and
// any `flex: 1` / width rule appears to be ignored.
defineOptions({ inheritAttrs: false });

const model = defineModel<string | undefined>();
// `Booleanish` mirrors @vue/runtime-dom's HTML-attribute boolean type
// (boolean or the string literals 'true' | 'false'). We narrow to it so
// the value passes straight through to the underlying InputText without
// a coercion step.
type Booleanish = boolean | 'true' | 'false';

defineProps<{
  placeholder?: string;
  spellcheck?: Booleanish;
  type?: string;
}>();

const emit = defineEmits<{
  keydown: [e: KeyboardEvent];
  blur: [e: FocusEvent];
}>();

const inputRef = ref<any>(null);
const autocompleteRef = ref<InstanceType<typeof VarAutocomplete> | null>(null);

function getInputEl(): HTMLInputElement | null {
  const el = inputRef.value;
  if (!el) return null;
  return (el.$el ?? el) as HTMLInputElement;
}

function scheduleUpdate() {
  autocompleteRef.value?.updateFromCursor();
}

function onKeyDown(e: KeyboardEvent) {
  const handled = autocompleteRef.value?.handleKey(e);
  if (!handled) emit('keydown', e);
}

function onBlur(e: FocusEvent) {
  // Delay so a click on a suggestion can still resolve before close.
  setTimeout(() => autocompleteRef.value?.close(), 150);
  emit('blur', e);
}
</script>

<template>
  <InputText
    ref="inputRef"
    v-model="model"
    v-bind="$attrs"
    :placeholder="placeholder"
    :spellcheck="spellcheck"
    :type="type"
    @input="scheduleUpdate"
    @click="scheduleUpdate"
    @keyup.right="scheduleUpdate"
    @keyup.left="scheduleUpdate"
    @keyup.home="scheduleUpdate"
    @keyup.end="scheduleUpdate"
    @keydown="onKeyDown"
    @blur="onBlur"
  />
  <VarAutocomplete
    ref="autocompleteRef"
    :get-element="getInputEl"
    :get-value="() => model ?? ''"
    :set-value="(v) => { model = v; }"
  />
</template>
