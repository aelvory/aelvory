<script setup lang="ts">
import { computed } from 'vue';
import Button from 'primevue/button';
import { useCurlHistoryStore } from '@/stores/curlHistory';

const history = useCurlHistoryStore();

const emit = defineEmits<{
  load: [command: string];
  spawn: [command: string];
}>();

const entries = computed(() => history.entries);

function summary(cmd: string): string {
  // Strip newlines and leading whitespace for preview
  return cmd.replace(/\s+/g, ' ').trim();
}

function statusClass(status?: number): string {
  if (!status) return 'status-err';
  if (status < 300) return 'status-ok';
  if (status < 400) return 'status-redirect';
  if (status < 500) return 'status-client-err';
  return 'status-server-err';
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
</script>

<template>
  <aside class="panel">
    <div class="header">
      <span>History</span>
      <Button
        v-if="entries.length"
        icon="pi pi-trash"
        text
        size="small"
        severity="secondary"
        title="Clear history"
        @click="history.clear"
      />
    </div>
    <div v-if="!entries.length" class="empty">
      No curl runs yet. Send a curl command to start building history.
    </div>
    <ul v-else class="list">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="entry"
        @click="emit('load', entry.command)"
      >
        <div class="row-top">
          <span v-if="entry.method" :class="['m', `m-${entry.method.toLowerCase()}`]">
            {{ entry.method }}
          </span>
          <span v-if="entry.status" :class="['status-dot', statusClass(entry.status)]">
            {{ entry.status }}
          </span>
          <span class="spacer" />
          <span class="time">{{ relativeTime(entry.timestamp) }}</span>
        </div>
        <div class="url" :title="entry.url">{{ entry.url ?? summary(entry.command) }}</div>
        <div class="row-actions">
          <Button
            icon="pi pi-external-link"
            text
            size="small"
            severity="secondary"
            title="Open in new tab"
            @click.stop="emit('spawn', entry.command)"
          />
          <Button
            icon="pi pi-times"
            text
            size="small"
            severity="secondary"
            title="Remove"
            @click.stop="history.remove(entry.id)"
          />
        </div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--p-content-border-color, #e5e7eb);
  background: var(--p-content-hover-background, #f9fafb);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #6b7280);
}
.empty {
  padding: 1rem;
  font-size: 0.82rem;
  color: var(--p-text-muted-color, #6b7280);
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  margin: 0;
  list-style: none;
}
.entry {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color, #eee);
  cursor: pointer;
  font-size: 0.8rem;
  position: relative;
}
.entry:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.entry:hover .row-actions {
  opacity: 1;
}
.row-top {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.15rem;
}
.spacer {
  flex: 1;
}
.m {
  font-weight: 700;
  font-size: 0.65rem;
  text-transform: uppercase;
  min-width: 2.5rem;
}
.m-get { color: #16a34a; }
.m-post { color: #ca8a04; }
.m-put { color: #2563eb; }
.m-patch { color: #9333ea; }
.m-delete { color: #dc2626; }
.m-head, .m-options { color: #6b7280; }
.status-dot {
  font-weight: 700;
  font-size: 0.68rem;
}
.status-ok { color: #16a34a; }
.status-redirect { color: #2563eb; }
.status-client-err { color: #ca8a04; }
.status-server-err,
.status-err { color: #dc2626; }
.time {
  color: var(--p-text-muted-color, #9ca3af);
  font-size: 0.7rem;
}
.url {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.75rem;
  color: var(--p-text-color, #111827);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-actions {
  position: absolute;
  right: 0.5rem;
  top: 0.3rem;
  opacity: 0;
  transition: opacity 0.15s;
  display: flex;
  gap: 0.2rem;
}
</style>
