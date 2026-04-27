<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCollectionsStore } from '@/stores/collections';
import { useWorkspaceStore } from '@/stores/workspace';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { storeToRefs } from 'pinia';
import { useDeletions } from '@/composables/deletions';
import { prompt } from '@/composables/prompt';
import type { ApiRequest, Collection } from '@aelvory/core';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import TreeNodeItem, {
  type TreeNodeData,
  type MovePayload,
} from './TreeNodeItem.vue';
import ImportDialog from './ImportDialog.vue';

const collections = useCollectionsStore();
const workspace = useWorkspaceStore();
const tabs = useTabsStore();
const ui = useUiStore();
const { importOpen } = storeToRefs(ui);
const { confirmDeleteCollection, confirmDeleteRequest } = useDeletions();
const { t } = useI18n();

/**
 * Per-project collapse state, persisted to localStorage. Keyed by project
 * so collapse choices in one project don't leak into another. Stored as
 * an array of collection ids (the collapsed ones); everything not in the
 * set is expanded.
 */
const collapsed = reactive(new Set<string>());
const search = ref('');

function storageKey(projectId: string): string {
  return `aelvory.tree-collapsed.${projectId}`;
}

function loadCollapsed(projectId: string | null) {
  collapsed.clear();
  if (!projectId) return;
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === 'string') collapsed.add(id);
    }
  } catch {
    /* corrupt entry — ignore */
  }
}

function persistCollapsed(projectId: string | null) {
  if (!projectId) return;
  try {
    if (collapsed.size === 0) {
      localStorage.removeItem(storageKey(projectId));
    } else {
      localStorage.setItem(storageKey(projectId), JSON.stringify([...collapsed]));
    }
  } catch {
    /* quota / private mode — ignore */
  }
}

// Hydrate when the active project changes (also fires `immediate` so the
// initial mount loads from storage).
watch(
  () => workspace.currentProjectId,
  (id) => loadCollapsed(id),
  { immediate: true },
);

// Persist on every collapse-state change. Watching the Set directly is
// enough — Vue's reactivity catches add/delete/clear.
watch(
  collapsed,
  () => persistCollapsed(workspace.currentProjectId),
  { deep: true },
);

const fullTree = computed<TreeNodeData[]>(() => {
  const byParent = new Map<string | null, Collection[]>();
  for (const c of collections.collections) {
    const key = c.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }

  function build(parentId: string | null): TreeNodeData[] {
    const list = (byParent.get(parentId) ?? []).slice();
    list.sort((a, b) => a.sortIndex - b.sortIndex);
    return list.map((c) => ({
      id: c.id,
      name: c.name,
      kind: 'collection' as const,
      collection: c,
      children: [
        ...build(c.id),
        ...collections.requestsFor(c.id).map<TreeNodeData>((r) => ({
          id: r.id,
          name: r.name,
          kind: 'request' as const,
          method: r.method,
          children: [],
          request: r,
        })),
      ],
    }));
  }

  return build(null);
});

/**
 * Returns a pruned copy of the tree containing only nodes whose name
 * matches `q` or have a matching descendant. Returns null when nothing
 * matches. Runs over an already-built tree, so it inherits sortIndex
 * ordering for free.
 */
function pruneTree(nodes: TreeNodeData[], q: string): TreeNodeData[] {
  const needle = q.toLowerCase();
  const out: TreeNodeData[] = [];
  for (const n of nodes) {
    const selfMatch = n.name.toLowerCase().includes(needle);
    const filteredChildren =
      n.children.length > 0 ? pruneTree(n.children, needle) : [];
    if (selfMatch || filteredChildren.length > 0) {
      out.push({ ...n, children: filteredChildren });
    }
  }
  return out;
}

const tree = computed<TreeNodeData[]>(() => {
  const q = search.value.trim();
  if (!q) return fullTree.value;
  return pruneTree(fullTree.value, q);
});

const isFiltering = computed(() => search.value.trim().length > 0);

/**
 * When filtering, force-expand every collection on a path to a match so
 * the user can actually see the hits. We pass an "effective" collapsed
 * set to TreeNodeItem that strips out any ids in the visible filtered
 * tree.
 */
const effectiveCollapsed = computed<Set<string>>(() => {
  if (!isFiltering.value) return collapsed;
  const visible = new Set<string>();
  function walk(nodes: TreeNodeData[]) {
    for (const n of nodes) {
      if (n.kind === 'collection') visible.add(n.id);
      walk(n.children);
    }
  }
  walk(tree.value);
  // Clone the user's manual set, then drop any visible-in-filter ids.
  const next = new Set(collapsed);
  for (const id of visible) next.delete(id);
  return next;
});

function clearSearch() {
  search.value = '';
}

async function addRootCollection() {
  if (!workspace.currentProjectId) return;
  const name = await prompt({
    title: t('prompt.newCollectionTitle'),
    label: t('tree.collectionName'),
    placeholder: t('tree.newCollectionPlaceholder'),
  });
  if (!name) return;
  const c = await collections.createCollection(workspace.currentProjectId, name);
  tabs.openCollection(c);
}

async function addFolder(parentId: string) {
  if (!workspace.currentProjectId) return;
  const name = await prompt({
    title: t('prompt.newFolderTitle'),
    label: t('tree.folderName'),
    placeholder: t('tree.newFolderPlaceholder'),
  });
  if (!name) return;
  const c = await collections.createCollection(
    workspace.currentProjectId,
    name,
    parentId,
  );
  tabs.openCollection(c);
}

async function addRequest(collectionId: string) {
  const name = await prompt({
    title: t('prompt.newRequestTitle'),
    label: t('tree.requestName'),
    placeholder: t('tree.newRequestPlaceholder'),
  });
  if (!name) return;
  const r = await collections.createRequest(collectionId, { name });
  tabs.openRequest(r);
}

/**
 * Create a WebSocket-kind request. Same prompt as a regular HTTP
 * request but the created entity has `kind: 'ws'` and a wss://
 * placeholder URL — `tabs.openRequest` dispatches to the WS editor
 * via the kind branch.
 */
async function addWebSocket(collectionId: string) {
  const name = await prompt({
    title: 'New WebSocket',
    label: t('tree.requestName'),
    placeholder: 'e.g. realtime feed',
  });
  if (!name) return;
  const r = await collections.createRequest(collectionId, {
    name,
    kind: 'ws',
    // Sensible default — easy to point at any echo / dev server
    // and confirm the editor works without typing anything.
    url: 'wss://echo.websocket.events',
  });
  tabs.openRequest(r);
}

function openRequest(r: ApiRequest) {
  tabs.openRequest(r);
}

function openCollection(c: Collection) {
  tabs.openCollection(c);
}

function toggleCollapse(id: string) {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
}

function onDeleteCollection(id: string) {
  confirmDeleteCollection(id, () => {
    collapsed.delete(id);
  });
}

function onDeleteRequest(r: ApiRequest) {
  confirmDeleteRequest(r);
}

async function onRename(
  id: string,
  kind: 'request' | 'collection',
  newName: string,
) {
  if (!workspace.currentProjectId) return;
  if (kind === 'collection') {
    const col = collections.findById(id);
    if (!col) return;
    await collections.updateCollection(workspace.currentProjectId, {
      ...col,
      name: newName,
    });
  } else {
    // Find request across all collections
    for (const reqs of Object.values(collections.requestsByCollection)) {
      const r = reqs.find((x) => x.id === id);
      if (r) {
        await collections.updateRequest({ ...r, name: newName });
        return;
      }
    }
  }
}

// Find the parent collection id of a request
function parentOfRequest(requestId: string): string | null {
  for (const [collId, reqs] of Object.entries(collections.requestsByCollection)) {
    if (reqs.some((r) => r.id === requestId)) return collId;
  }
  return null;
}

// Index of a collection among its siblings
function collectionSiblingIndex(id: string, parentId: string | null): number {
  const siblings = collections.collections
    .filter((c) => (c.parentId ?? null) === parentId && c.id !== id)
    .sort((a, b) => a.sortIndex - b.sortIndex);
  return siblings.findIndex((c) => c.id === id);
}

// Index of a request within its collection
function requestIndex(requestId: string, collectionId: string): number {
  const reqs = collections.requestsFor(collectionId);
  return reqs.findIndex((r) => r.id === requestId);
}

async function onMove(payload: MovePayload) {
  const { draggedId, draggedKind, targetId, targetKind, position } = payload;
  if (!workspace.currentProjectId) return;

  if (draggedKind === 'collection') {
    // Determine new parent + position
    const target = collections.findById(targetId);
    if (!target) return;

    let newParentId: string | null;
    let newSortIndex: number;

    if (position === 'into' && targetKind === 'collection') {
      newParentId = targetId;
      // append at end
      const siblings = collections.collections.filter(
        (c) => c.parentId === targetId && c.id !== draggedId,
      );
      newSortIndex = siblings.length;
    } else {
      // before/after: become sibling in target's parent
      if (targetKind === 'collection') {
        newParentId = target.parentId ?? null;
        const sibs = collections.collections
          .filter((c) => (c.parentId ?? null) === newParentId && c.id !== draggedId)
          .sort((a, b) => a.sortIndex - b.sortIndex);
        const targetIdx = sibs.findIndex((c) => c.id === targetId);
        newSortIndex = position === 'before' ? targetIdx : targetIdx + 1;
      } else {
        // target is a request: folders and requests live alongside visually
        // but semantically a folder can only be sibling of other folders in the
        // target request's parent collection (which is NOT a folder container).
        // Disallow: folder can't drop before/after a request.
        return;
      }
    }

    // Silently skip no-op moves (same parent, same effective position)
    const dragged = collections.findById(draggedId);
    if (
      dragged &&
      (dragged.parentId ?? null) === newParentId &&
      dragged.sortIndex === newSortIndex
    ) {
      return;
    }

    await collections.moveCollection(draggedId, newParentId, newSortIndex);
    return;
  }

  // Moving a request
  let draggedRequest: ApiRequest | null = null;
  for (const reqs of Object.values(collections.requestsByCollection)) {
    const r = reqs.find((x) => x.id === draggedId);
    if (r) {
      draggedRequest = r;
      break;
    }
  }
  if (!draggedRequest) return;

  let newCollectionId: string;
  let newSortIndex: number;

  if (position === 'into' && targetKind === 'collection') {
    newCollectionId = targetId;
    const siblingReqs = collections.requestsFor(targetId).filter(
      (r) => r.id !== draggedId,
    );
    newSortIndex = siblingReqs.length;
  } else if (targetKind === 'request') {
    const parent = parentOfRequest(targetId);
    if (!parent) return;
    newCollectionId = parent;
    const sibs = collections
      .requestsFor(parent)
      .filter((r) => r.id !== draggedId);
    const targetIdx = sibs.findIndex((r) => r.id === targetId);
    newSortIndex = position === 'before' ? targetIdx : targetIdx + 1;
  } else {
    // Request dropped before/after a collection — disallow
    return;
  }

  await collections.moveRequest(draggedRequest, newCollectionId, newSortIndex);
}

function collapseAll() {
  for (const c of collections.collections) collapsed.add(c.id);
}

function expandAll() {
  collapsed.clear();
}
</script>

<template>
  <div class="tree">
    <div class="tree-header">
      <span>{{ t('tree.header') }}</span>
      <div class="header-actions">
        <Button
          v-if="workspace.currentProjectId && collections.collections.length"
          icon="pi pi-angle-double-down"
          text
          size="small"
          severity="secondary"
          :title="t('tree.expandAll')"
          :aria-label="t('tree.expandAll')"
          @click="expandAll"
        />
        <Button
          v-if="workspace.currentProjectId && collections.collections.length"
          icon="pi pi-angle-double-up"
          text
          size="small"
          severity="secondary"
          :title="t('tree.collapseAll')"
          :aria-label="t('tree.collapseAll')"
          @click="collapseAll"
        />
        <Button
          v-if="workspace.currentProjectId"
          icon="pi pi-download"
          text
          size="small"
          severity="secondary"
          :title="t('tree.import')"
          :aria-label="t('tree.import')"
          @click="importOpen = true"
        />
        <Button
          v-if="workspace.currentProjectId"
          icon="pi pi-plus"
          text
          size="small"
          :aria-label="t('tree.newCollection')"
          @click="addRootCollection"
        />
      </div>
    </div>

    <div
      v-if="workspace.currentProjectId && collections.collections.length"
      class="search-row"
    >
      <i class="pi pi-search search-icon" />
      <InputText
        v-model="search"
        :placeholder="t('tree.filterPlaceholder')"
        size="small"
        class="search-input"
      />
      <Button
        v-if="isFiltering"
        icon="pi pi-times"
        text
        rounded
        size="small"
        severity="secondary"
        class="search-clear"
        :title="t('tree.clearFilter')"
        :aria-label="t('tree.clearFilter')"
        @click="clearSearch"
      />
    </div>
    <div v-if="collections.loading" class="empty">{{ t('common.loading') }}</div>
    <div v-else-if="!workspace.currentProjectId" class="empty">
      {{ t('tree.emptyNoProject') }}
    </div>
    <div
      v-else-if="!fullTree.length"
      class="empty"
    >
      {{ t('tree.emptyNoCollections') }}
    </div>
    <div v-else-if="isFiltering && !tree.length" class="empty">
      {{ t('tree.noMatches', { query: search }) }}
    </div>
    <ul v-else class="node-list">
      <TreeNodeItem
        v-for="node in tree"
        :key="node.id"
        :node="node"
        :depth="0"
        :active-id="tabs.activeId"
        :collapsed="effectiveCollapsed"
        @open-request="openRequest"
        @open-collection="openCollection"
        @add-request="addRequest"
        @add-websocket="addWebSocket"
        @add-folder="addFolder"
        @delete-request="onDeleteRequest"
        @delete-collection="onDeleteCollection"
        @toggle-collapse="toggleCollapse"
        @rename="onRename"
        @move="onMove"
      />
    </ul>
    <ImportDialog v-model="importOpen" />
  </div>
</template>

<style scoped>
.tree {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color, #6b7280);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 0.1rem;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  position: relative;
}
.search-icon {
  position: absolute;
  left: 0.85rem;
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #9ca3af);
  pointer-events: none;
}
.search-input {
  flex: 1;
  font-size: 0.82rem;
  padding-left: 1.5rem;
}
.search-clear :deep(.p-button-icon) {
  font-size: 0.72rem;
}
.empty {
  padding: 0.75rem;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.8rem;
}
.node-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
</style>
