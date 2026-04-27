<script setup lang="ts">
import WorkspaceLayout from '@/layouts/WorkspaceLayout.vue';
import RequestTabs from '@/components/RequestTabs.vue';
import RequestEditor from '@/components/RequestEditor.vue';
import CollectionEditor from '@/components/CollectionEditor.vue';
import CurlConsole from '@/components/CurlConsole.vue';
import WebSocketEditor from '@/components/WebSocketEditor.vue';
import Button from 'primevue/button';
import { useTabsStore } from '@/stores/tabs';
import { useWorkspaceStore } from '@/stores/workspace';

const tabs = useTabsStore();
const workspace = useWorkspaceStore();
</script>

<template>
  <WorkspaceLayout>
    <RequestTabs />
    <div v-if="tabs.active?.kind === 'request'" class="editor-wrap">
      <RequestEditor :key="tabs.active.id" :tab="tabs.active" />
    </div>
    <div v-else-if="tabs.active?.kind === 'collection'" class="editor-wrap">
      <CollectionEditor :key="tabs.active.id" :tab="tabs.active" />
    </div>
    <div v-else-if="tabs.active?.kind === 'curl'" class="editor-wrap">
      <CurlConsole :key="tabs.active.id" :tab="tabs.active" />
    </div>
    <div v-else-if="tabs.active?.kind === 'websocket'" class="editor-wrap">
      <WebSocketEditor :key="tabs.active.id" :tab="tabs.active" />
    </div>
    <div v-else class="placeholder">
      <div class="placeholder-inner">
        <h2>
          {{
            workspace.currentProjectId
              ? 'Open a request, folder, or start a curl console'
              : 'Create a team and project, or use the curl console'
          }}
        </h2>
        <p class="muted">
          Click a request or folder in the tree, or open the
          <strong>Curl</strong> console in the top bar to paste a curl command.
          Use <code>Ctrl+S</code> to save and <code>Ctrl+Enter</code> to send.
        </p>
        <Button
          icon="pi pi-terminal"
          label="Open curl console"
          severity="secondary"
          @click="tabs.openCurl()"
        />
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.editor-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}
.placeholder-inner {
  max-width: 460px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: center;
}
.placeholder-inner h2 {
  font-size: 1.1rem;
  font-weight: 500;
  margin: 0;
  color: var(--p-text-muted-color, #374151);
}
.muted {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.88rem;
  margin: 0;
}
code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-size: 0.82rem;
}
</style>
