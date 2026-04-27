<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useVariableNames } from '@/composables/variables';

const props = defineProps<{
  getElement: () => HTMLInputElement | HTMLTextAreaElement | null;
  getValue: () => string;
  setValue: (v: string) => void;
}>();

const vars = useVariableNames();

const open = ref(false);
const items = ref<string[]>([]);
const selected = ref(0);
const triggerStart = ref(-1);
const pos = ref({ top: 0, left: 0 });

function updateFromCursor() {
  const el = props.getElement();
  if (!el) return close();
  const cursor = el.selectionStart ?? 0;
  const value = props.getValue();
  const upTo = value.slice(0, cursor);
  const lastOpen = upTo.lastIndexOf('{{');
  if (lastOpen === -1) return close();
  const between = upTo.slice(lastOpen + 2);
  if (between.includes('}}')) return close();

  const query = between.trim().toLowerCase();
  const source = vars.value;
  const starts: string[] = [];
  const contains: string[] = [];
  for (const v of source) {
    const lower = v.toLowerCase();
    if (lower.startsWith(query)) starts.push(v);
    else if (query && lower.includes(query)) contains.push(v);
  }
  const matches = [...starts, ...contains].slice(0, 12);

  items.value = matches;
  selected.value = 0;
  triggerStart.value = lastOpen;
  // Always open when we're inside a {{ ... context, even without matches.
  // The empty state is informative ("no vars in scope") — far better than
  // a silently non-appearing dropdown.
  open.value = true;

  const rect = el.getBoundingClientRect();
  pos.value = { top: rect.bottom + 2, left: rect.left };
}

function close() {
  if (!open.value) return;
  open.value = false;
  items.value = [];
  triggerStart.value = -1;
}

function accept(name: string) {
  const el = props.getElement();
  if (!el || triggerStart.value < 0) return;
  const value = props.getValue();
  const cursor = el.selectionStart ?? 0;
  const before = value.slice(0, triggerStart.value);
  const after = value.slice(cursor);
  const inserted = `{{${name}}}`;
  props.setValue(before + inserted + after);

  const finalPos = before.length + inserted.length;
  close();
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(finalPos, finalPos);
  });
}

function handleKey(e: KeyboardEvent): boolean {
  if (!open.value) return false;
  if (!items.value.length) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return true;
    }
    return false;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selected.value = (selected.value + 1) % items.value.length;
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    selected.value =
      (selected.value - 1 + items.value.length) % items.value.length;
    return true;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    accept(items.value[selected.value]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return true;
  }
  return false;
}

function onDocMouse(e: MouseEvent) {
  if (!open.value) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('.var-autocomplete-pop')) return;
  if (t && t === props.getElement()) return;
  close();
}

function onDocScroll() {
  if (!open.value) return;
  const el = props.getElement();
  if (!el) return close();
  const rect = el.getBoundingClientRect();
  pos.value = { top: rect.bottom + 2, left: rect.left };
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouse, true);
  document.addEventListener('scroll', onDocScroll, true);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMouse, true);
  document.removeEventListener('scroll', onDocScroll, true);
});

defineExpose({ updateFromCursor, handleKey, close });
</script>

<template>
  <Teleport v-if="open" to="body">
    <div
      class="var-autocomplete-pop"
      :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
    >
      <template v-if="items.length">
        <div
          v-for="(v, i) in items"
          :key="v"
          class="item"
          :class="{ active: i === selected }"
          @mousedown.prevent="accept(v)"
        >
          <span class="braces">{{ v }}</span>
        </div>
      </template>
      <div v-else class="empty">
        <div class="empty-title">No variables in scope</div>
        <div class="empty-hint">
          Define them in the environment picker (gear icon, top-right)
          or on a parent collection's Variables tab.
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.var-autocomplete-pop {
  position: fixed;
  z-index: 10000;
  background: var(--p-content-background, white);
  border: 1px solid var(--p-content-border-color, #e5e7eb);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  min-width: 220px;
  max-height: 240px;
  overflow-y: auto;
  padding: 0.2rem;
}
.item {
  padding: 0.3rem 0.5rem;
  cursor: pointer;
  font-size: 0.82rem;
  border-radius: 3px;
}
.item.active {
  background: var(--p-highlight-background, #dbeafe);
  color: var(--p-primary-700, #1d4ed8);
}
.item:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.item.active:hover {
  background: var(--p-highlight-background, #dbeafe);
}
.braces {
  font-family: 'SF Mono', Consolas, monospace;
}
.braces::before {
  content: '{{';
  color: var(--p-text-muted-color, #9ca3af);
}
.braces::after {
  content: '}}';
  color: var(--p-text-muted-color, #9ca3af);
}
.empty {
  padding: 0.5rem 0.6rem;
  max-width: 260px;
}
.empty-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--p-text-muted-color, #4b5563);
  margin-bottom: 0.2rem;
}
.empty-hint {
  font-size: 0.74rem;
  color: var(--p-text-muted-color, #9ca3af);
  line-height: 1.35;
}
</style>
