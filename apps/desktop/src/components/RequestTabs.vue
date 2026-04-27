<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ContextMenu from 'primevue/contextmenu';
import type { MenuItem } from 'primevue/menuitem';
import { useTabsStore, type Tab } from '@/stores/tabs';

const tabs = useTabsStore();
const { t } = useI18n();

const cm = ref<InstanceType<typeof ContextMenu> | null>(null);
const menuTargetId = ref<string | null>(null);

const menuItems = computed<MenuItem[]>(() => {
  const id = menuTargetId.value;
  if (!id) return [];
  const idx = tabs.tabs.findIndex((t) => t.id === id);
  const total = tabs.tabs.length;
  const isOnly = total === 1;

  const tab = tabs.tabs[idx];
  return [
    {
      label: tab?.pinned ? t('tabs.unpin') : t('tabs.pin'),
      icon: tab?.pinned ? 'pi pi-bookmark-fill' : 'pi pi-bookmark',
      command: () => tabs.togglePin(id),
    },
    { separator: true },
    {
      label: t('tabs.close'),
      icon: 'pi pi-times',
      command: () => tabs.close(id),
    },
    {
      label: t('tabs.closeOthers'),
      icon: 'pi pi-window-minimize',
      disabled: isOnly,
      command: () => tabs.closeOthers(id),
    },
    {
      label: t('tabs.closeToRight'),
      icon: 'pi pi-angle-double-right',
      disabled: idx === -1 || idx >= total - 1,
      command: () => tabs.closeToRight(id),
    },
    {
      label: t('tabs.closeToLeft'),
      icon: 'pi pi-angle-double-left',
      disabled: idx <= 0,
      command: () => tabs.closeToLeft(id),
    },
    { separator: true },
    {
      label: t('tabs.closeAll'),
      icon: 'pi pi-times-circle',
      command: () => tabs.closeAll(),
    },
  ];
});

function onContext(e: MouseEvent, id: string) {
  menuTargetId.value = id;
  cm.value?.show(e);
}

function label(t: Tab): string {
  if (t.kind === 'request') return t.request.name;
  if (t.kind === 'collection') return t.collection.name;
  if (t.kind === 'websocket') return t.request.name;
  return t.title;
}

function methodLabel(t: Tab): string | null {
  if (t.kind === 'request') return t.request.method;
  if (t.kind === 'websocket') return 'WS';
  return null;
}

function methodCls(t: Tab): string[] {
  if (t.kind === 'request') {
    return ['method-tag', `method-${t.request.method.toLowerCase()}`];
  }
  if (t.kind === 'websocket') {
    return ['method-tag', 'method-ws'];
  }
  return ['method-tag', 'method-other'];
}
</script>

<template>
  <div v-if="tabs.tabs.length" class="tab-bar">
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === tabs.activeId }"
      @click="tabs.setActive(tab.id)"
      @contextmenu.prevent="onContext($event, tab.id)"
      @mousedown.middle.prevent="tabs.close(tab.id)"
    >
      <span v-if="tab.kind === 'collection'" class="ind">
        <i class="pi pi-folder" />
      </span>
      <span v-else-if="tab.kind === 'curl'" class="ind curl-ind">
        <i class="pi pi-terminal" />
      </span>
      <span v-else :class="methodCls(tab)">{{ methodLabel(tab) }}</span>
      <span class="tab-name">{{ label(tab) }}</span>
      <span v-if="tab.dirty" class="dirty">•</span>
      <!-- When pinned, show a pin icon in place of the close button.
           Clicking it unpins (matches VSCode). The full close action
           is still available via context menu / middle-click. -->
      <button
        v-if="tab.pinned"
        class="pin-btn"
        :aria-label="t('tabs.unpin')"
        :title="t('tabs.unpin')"
        @click.stop="tabs.togglePin(tab.id)"
      >
        <i class="pi pi-bookmark-fill" />
      </button>
      <button
        v-else
        class="close-btn"
        :aria-label="t('tabs.closeTab')"
        @click.stop="tabs.close(tab.id)"
      >×</button>
    </div>

    <ContextMenu ref="cm" :model="menuItems" />
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  background: var(--p-content-hover-background, #f9fafb);
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  border-right: 1px solid var(--p-content-border-color, #e5e7eb);
  cursor: pointer;
  font-size: 0.82rem;
  max-width: 220px;
  user-select: none;
  flex-shrink: 0;
}
.tab:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.tab.active {
  background: var(--p-content-background, white);
  border-bottom: 2px solid var(--p-primary-500, #3b82f6);
  margin-bottom: -1px;
}
.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.method-tag {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  min-width: 2.5rem;
  text-align: left;
}
.method-get { color: #16a34a; }
.method-post { color: #ca8a04; }
.method-put { color: #2563eb; }
.method-patch { color: #9333ea; }
.method-delete { color: #dc2626; }
.method-head, .method-options, .method-other { color: #6b7280; }
/* WebSocket tabs share the same badge slot as HTTP method, so the
   tab list lines up visually whether you have HTTP or WS open.
   Teal matches the tree's WS badge for consistency. */
.method-ws { color: #0891b2; }
.ind {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.75rem;
}
.curl-ind {
  color: var(--p-primary-500, #3b82f6);
}
.dirty {
  color: var(--p-primary-500, #3b82f6);
  font-size: 1rem;
  line-height: 1;
}
.close-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 1.1rem;
  color: var(--p-text-muted-color, #9ca3af);
  padding: 0 0.25rem;
  border-radius: 3px;
  line-height: 1;
}
.close-btn:hover {
  background: var(--p-content-hover-background, #e5e7eb);
  color: var(--p-text-color, #111827);
}
.pin-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 0.78rem;
  color: var(--p-primary-color, #3b82f6);
  padding: 0 0.25rem;
  border-radius: 3px;
  line-height: 1;
}
.pin-btn:hover {
  background: var(--p-content-hover-background, #e5e7eb);
}
</style>
