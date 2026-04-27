<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { ApiRequest, Collection } from '@aelvory/core';
import { draggingNode } from '@/composables/treeDrag';

export interface TreeNodeData {
  id: string;
  name: string;
  kind: 'collection' | 'request';
  method?: string;
  children: TreeNodeData[];
  request?: ApiRequest;
  collection?: Collection;
}

export type DropPosition = 'before' | 'after' | 'into';

export interface MovePayload {
  draggedId: string;
  draggedKind: 'collection' | 'request';
  targetId: string;
  targetKind: 'collection' | 'request';
  position: DropPosition;
}

const props = defineProps<{
  node: TreeNodeData;
  depth: number;
  activeId: string | null;
  collapsed: Set<string>;
}>();

// Emit shape — `add-websocket` is a sibling of `add-request` so the
// parent CollectionTree can open the right kind of request without
// having to introspect a tab afterwards. Same payload (collection
// id) — only the handler differs.
const emit = defineEmits<{
  'open-request': [request: ApiRequest];
  'open-collection': [collection: Collection];
  'add-request': [collectionId: string];
  'add-websocket': [collectionId: string];
  'add-folder': [parentCollectionId: string];
  'delete-request': [request: ApiRequest];
  'delete-collection': [collectionId: string];
  'toggle-collapse': [collectionId: string];
  rename: [id: string, kind: 'request' | 'collection', newName: string];
  move: [payload: MovePayload];
}>();

const isCollapsed = computed(() => props.collapsed.has(props.node.id));

// --- Rename state ---
const renaming = ref(false);
const renameValue = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

function startRename() {
  renameValue.value = props.node.name;
  renaming.value = true;
  nextTick(() => {
    renameInput.value?.focus();
    renameInput.value?.select();
  });
}

function commitRename() {
  if (!renaming.value) return;
  const newName = renameValue.value.trim();
  renaming.value = false;
  if (newName && newName !== props.node.name) {
    emit('rename', props.node.id, props.node.kind, newName);
  }
}

function cancelRename() {
  renaming.value = false;
}

// --- Drag state ---
const dropPosition = ref<DropPosition | null>(null);

function onDragStart(e: DragEvent) {
  if (renaming.value) {
    e.preventDefault();
    return;
  }
  draggingNode.value = { id: props.node.id, kind: props.node.kind };
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', props.node.id);
  }
}

function onDragOver(e: DragEvent) {
  const dragged = draggingNode.value;
  if (!dragged) return;
  if (dragged.id === props.node.id) return; // can't drop on self

  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;

  // Folders accept into + before/after; requests only before/after.
  if (props.node.kind === 'collection') {
    if (y < h * 0.3) dropPosition.value = 'before';
    else if (y > h * 0.7) dropPosition.value = 'after';
    else dropPosition.value = 'into';
  } else {
    dropPosition.value = y < h * 0.5 ? 'before' : 'after';
  }
}

function onDragLeave(e: DragEvent) {
  // Only clear when leaving the element itself, not a child
  const related = e.relatedTarget as Node | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  dropPosition.value = null;
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  const dragged = draggingNode.value;
  const pos = dropPosition.value;
  dropPosition.value = null;
  draggingNode.value = null;
  if (!dragged || !pos) return;
  if (dragged.id === props.node.id) return;

  emit('move', {
    draggedId: dragged.id,
    draggedKind: dragged.kind,
    targetId: props.node.id,
    targetKind: props.node.kind,
    position: pos,
  });
}

function onDragEnd() {
  draggingNode.value = null;
  dropPosition.value = null;
}

function padding() {
  return `${0.5 + props.depth * 0.75}rem`;
}

function onClick() {
  if (renaming.value) return;
  if (props.node.kind === 'request' && props.node.request) {
    emit('open-request', props.node.request);
  } else if (props.node.kind === 'collection' && props.node.collection) {
    emit('open-collection', props.node.collection);
  }
}
</script>

<template>
  <li
    v-if="node.kind === 'request'"
    class="node request-node"
    :class="{
      active: node.id === activeId,
      'drop-before': dropPosition === 'before',
      'drop-after': dropPosition === 'after',
    }"
    :style="{ paddingLeft: padding() }"
    :draggable="!renaming"
    @click="onClick"
    @dragstart="onDragStart"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @dragend="onDragEnd"
  >
    <!--
      Method badge. For WebSocket requests we show "WS" instead of
      the HTTP method (which is irrelevant — WS uses an HTTP/1.1
      Upgrade handshake; the "method" field on the entity is left
      at its default and not displayed). Keeps the tree readable
      at a glance: HTTP verbs vs. WS at the same column.
    -->
    <span
      v-if="node.request?.kind === 'ws'"
      class="method method-ws"
    >
      WS
    </span>
    <span
      v-else
      :class="['method', `method-${(node.method ?? 'GET').toLowerCase()}`]"
    >
      {{ node.method ?? 'GET' }}
    </span>
    <input
      v-if="renaming"
      ref="renameInput"
      v-model="renameValue"
      class="rename-input"
      @click.stop
      @keydown.enter="commitRename"
      @keydown.esc="cancelRename"
      @blur="commitRename"
    />
    <span v-else class="name" @dblclick.stop="startRename">{{ node.name }}</span>
    <button
      v-if="node.request && !renaming"
      class="action-btn danger-btn"
      title="Delete request"
      @click.stop="emit('delete-request', node.request)"
    >
      <i class="pi pi-trash" />
    </button>
  </li>
  <li v-else class="node collection-node">
    <div
      class="collection-row"
      :class="{
        active: node.id === activeId,
        'drop-before': dropPosition === 'before',
        'drop-after': dropPosition === 'after',
        'drop-into': dropPosition === 'into',
      }"
      :style="{ paddingLeft: padding() }"
      :draggable="!renaming"
      @click="onClick"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @dragend="onDragEnd"
    >
      <button
        class="chevron-btn"
        :title="isCollapsed ? 'Expand' : 'Collapse'"
        :aria-label="isCollapsed ? 'Expand folder' : 'Collapse folder'"
        @click.stop="emit('toggle-collapse', node.id)"
      >
        <i :class="isCollapsed ? 'pi pi-chevron-right' : 'pi pi-chevron-down'" />
      </button>
      <i class="pi pi-folder folder-icon" />
      <input
        v-if="renaming"
        ref="renameInput"
        v-model="renameValue"
        class="rename-input"
        @click.stop
        @keydown.enter="commitRename"
        @keydown.esc="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="name" @dblclick.stop="startRename">{{ node.name }}</span>
      <template v-if="!renaming">
        <button
          class="action-btn"
          title="New folder"
          @click.stop="emit('add-folder', node.id)"
        >
          <i class="pi pi-folder-plus" />
        </button>
        <button
          class="action-btn"
          title="New request"
          @click.stop="emit('add-request', node.id)"
        >
          <i class="pi pi-plus" />
        </button>
        <button
          class="action-btn"
          title="New WebSocket"
          @click.stop="emit('add-websocket', node.id)"
        >
          <i class="pi pi-bolt" />
        </button>
        <button
          class="action-btn danger-btn"
          title="Delete folder"
          @click.stop="emit('delete-collection', node.id)"
        >
          <i class="pi pi-trash" />
        </button>
      </template>
    </div>
    <ul v-if="node.children.length && !isCollapsed" class="node-list">
      <TreeNodeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :active-id="activeId"
        :collapsed="collapsed"
        @open-request="(r) => emit('open-request', r)"
        @open-collection="(c) => emit('open-collection', c)"
        @add-request="(id) => emit('add-request', id)"
        @add-websocket="(id) => emit('add-websocket', id)"
        @add-folder="(id) => emit('add-folder', id)"
        @delete-request="(r) => emit('delete-request', r)"
        @delete-collection="(id) => emit('delete-collection', id)"
        @toggle-collapse="(id) => emit('toggle-collapse', id)"
        @rename="(id, kind, name) => emit('rename', id, kind, name)"
        @move="(p) => emit('move', p)"
      />
    </ul>
  </li>
</template>

<style scoped>
.node {
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.node-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.collection-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.3rem 0.5rem;
  font-weight: 500;
  font-size: 0.85rem;
  border-radius: 3px;
  border-top: 2px solid transparent;
  border-bottom: 2px solid transparent;
}
.collection-row:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.collection-row.active {
  background: var(--p-highlight-background, #dbeafe);
  color: var(--p-primary-700, #1d4ed8);
}
.chevron-btn {
  border: none;
  background: transparent;
  color: var(--p-text-muted-color, #6b7280);
  cursor: pointer;
  padding: 0.1rem 0.15rem;
  margin-left: -0.3rem;
  border-radius: 2px;
  display: flex;
  align-items: center;
  line-height: 1;
}
.chevron-btn i {
  font-size: 0.7rem;
}
.chevron-btn:hover {
  background: var(--p-content-hover-background, #e5e7eb);
  color: var(--p-text-color, #111827);
}
.folder-icon {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.8rem;
}
.action-btn {
  border: none;
  background: transparent;
  color: var(--p-text-muted-color, #6b7280);
  cursor: pointer;
  padding: 0.15rem 0.3rem;
  opacity: 0;
  transition: opacity 0.15s;
  border-radius: 3px;
  display: flex;
  align-items: center;
}
.collection-row .action-btn:first-of-type {
  margin-left: auto;
}
.collection-row:hover .action-btn,
.request-node:hover .action-btn {
  opacity: 1;
}
.action-btn:hover {
  background: var(--p-content-hover-background, #e5e7eb);
  color: var(--p-text-color, #111827);
}
.danger-btn:hover {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}
.action-btn i {
  font-size: 0.78rem;
}
.request-node {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  border-top: 2px solid transparent;
  border-bottom: 2px solid transparent;
}
.request-node:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.request-node.active {
  background: var(--p-highlight-background, #dbeafe);
  color: var(--p-primary-700, #1d4ed8);
}
.request-node .action-btn {
  margin-left: auto;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.rename-input {
  flex: 1;
  border: 1px solid var(--p-primary-400, #60a5fa);
  border-radius: 3px;
  padding: 0.1rem 0.3rem;
  font-size: 0.85rem;
  font-family: inherit;
  outline: none;
  background: var(--p-content-background, white);
  color: inherit;
  min-width: 0;
}
.method {
  font-size: 0.65rem;
  font-weight: 700;
  min-width: 2.5rem;
  text-transform: uppercase;
}
.method-get { color: #16a34a; }
.method-post { color: #ca8a04; }
.method-put { color: #2563eb; }
.method-patch { color: #9333ea; }
.method-delete { color: #dc2626; }
.method-head, .method-options { color: #6b7280; }
/* WebSocket — distinct teal so it stands out from HTTP verbs in
   a long mixed list. */
.method-ws { color: #0891b2; }

/* Drag indicators */
.drop-before {
  border-top-color: var(--p-primary-500, #3b82f6);
}
.drop-after {
  border-bottom-color: var(--p-primary-500, #3b82f6);
}
.drop-into {
  background: rgba(59, 130, 246, 0.15) !important;
  box-shadow: 0 0 0 2px var(--p-primary-500, #3b82f6) inset;
}
</style>
