<script setup lang="ts">
import { ref } from 'vue';
import Textarea from 'primevue/textarea';
import VarAutocomplete from './VarAutocomplete.vue';

const model = defineModel<string | undefined>();
// See VarInputText.vue for why we mirror this inline rather than import.
type Booleanish = boolean | 'true' | 'false';

defineProps<{
  placeholder?: string;
  spellcheck?: Booleanish;
  rows?: string | number;
  autoResize?: boolean;
}>();

const emit = defineEmits<{
  keydown: [e: KeyboardEvent];
  blur: [e: FocusEvent];
}>();

const areaRef = ref<any>(null);
const autocompleteRef = ref<InstanceType<typeof VarAutocomplete> | null>(null);

function getEl(): HTMLTextAreaElement | null {
  const el = areaRef.value;
  if (!el) return null;
  return (el.$el ?? el) as HTMLTextAreaElement;
}

function scheduleUpdate() {
  autocompleteRef.value?.updateFromCursor();
}

function onKeyDown(e: KeyboardEvent) {
  const handled = autocompleteRef.value?.handleKey(e);
  if (!handled) emit('keydown', e);
}

function onBlur(e: FocusEvent) {
  setTimeout(() => autocompleteRef.value?.close(), 150);
  emit('blur', e);
}
</script>

<template>
  <Textarea
    ref="areaRef"
    v-model="model"
    :placeholder="placeholder"
    :spellcheck="spellcheck"
    :rows="rows"
    :auto-resize="autoResize"
    @input="scheduleUpdate"
    @click="scheduleUpdate"
    @keyup.up="scheduleUpdate"
    @keyup.down="scheduleUpdate"
    @keyup.left="scheduleUpdate"
    @keyup.right="scheduleUpdate"
    @keyup.home="scheduleUpdate"
    @keyup.end="scheduleUpdate"
    @keydown="onKeyDown"
    @blur="onBlur"
  />
  <VarAutocomplete
    ref="autocompleteRef"
    :get-element="getEl"
    :get-value="() => model ?? ''"
    :set-value="(v) => { model = v; }"
  />
</template>
