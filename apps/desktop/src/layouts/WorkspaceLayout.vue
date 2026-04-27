<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import { useCollectionsStore } from '@/stores/collections';
import { useEnvironmentsStore } from '@/stores/environments';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { storeToRefs } from 'pinia';
import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import Select from 'primevue/select';
import Button from 'primevue/button';
import CollectionTree from '@/components/CollectionTree.vue';
import EnvironmentPicker from '@/components/EnvironmentPicker.vue';
import SettingsDialog from '@/components/SettingsDialog.vue';
import AboutDialog from '@/components/AboutDialog.vue';
import { useDeletions } from '@/composables/deletions';
import { prompt } from '@/composables/prompt';

const auth = useAuthStore();
const workspace = useWorkspaceStore();
const collections = useCollectionsStore();
const environments = useEnvironmentsStore();
const tabs = useTabsStore();
const ui = useUiStore();
const { settingsOpen, aboutOpen, sidebarCollapsed } = storeToRefs(ui);
const { confirmDeleteProject } = useDeletions();
const { t } = useI18n();

/**
 * Re-open this project's pinned tabs after collections + envs are
 * loaded. The tabs store records pinned RequestTab/CollectionTab
 * with a projectId so we only restore those that match.
 */
function restorePinsForProject(projectId: string | null) {
  tabs.setProjectContext(projectId);
  tabs.restorePinned({
    projectId,
    findRequest: (id: string) => {
      for (const list of Object.values(collections.requestsByCollection)) {
        const r = list.find((x) => x.id === id);
        if (r) return r;
      }
      return null;
    },
    findCollection: (id: string) => collections.collections.find((c) => c.id === id) ?? null,
  });
}

onMounted(async () => {
  if (auth.isAuthenticated) {
    await workspace.bootstrap();
    // Initial load: the watcher below uses `immediate: false` so it
    // won't fire when bootstrap() resolves with a project id that
    // was already set from persisted localStorage (no value change).
    // Trigger the load explicitly here for that first-paint case.
    if (workspace.currentProjectId) {
      await Promise.all([
        collections.loadForProject(workspace.currentProjectId),
        environments.loadForProject(workspace.currentProjectId),
      ]);
      restorePinsForProject(workspace.currentProjectId);
    } else {
      // No project — still restore any global (curl) pinned tabs.
      restorePinsForProject(null);
    }
  }
});

watch(
  () => workspace.currentProjectId,
  async (projectId, prev) => {
    if (projectId === prev) return;
    // Force-close everything (incl. pinned) — pinned tabs from the
    // previous project would point at collections that are about to
    // be reset. We re-open the current project's pinned tabs after
    // the new collections finish loading below.
    tabs.closeAll(true);
    collections.reset();
    environments.reset();
    if (projectId) {
      await Promise.all([
        collections.loadForProject(projectId),
        environments.loadForProject(projectId),
      ]);
    }
    restorePinsForProject(projectId);
  },
  { immediate: false },
);

async function addProject() {
  const name = await prompt({
    title: t('prompt.newProjectTitle'),
    label: t('tree.projectName'),
    placeholder: t('tree.projectNamePlaceholder'),
  });
  if (!name) return;
  const project = await workspace.createProject(name);
  workspace.selectProject(project.id);
}

function openCurlTab() {
  tabs.openCurl();
}

function onDeleteProject() {
  if (workspace.currentProjectId) confirmDeleteProject(workspace.currentProjectId);
}

async function renameProject() {
  const project = workspace.currentProject;
  if (!project) return;
  const newName = await prompt({
    title: t('rename.project'),
    label: t('rename.newName'),
    default: project.name,
    confirmLabel: t('common.rename'),
  });
  if (!newName || newName === project.name) return;
  await workspace.renameProject(project.id, newName);
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <Select
        v-if="workspace.organizations.length"
        :model-value="workspace.currentOrgId"
        :options="workspace.organizations"
        option-label="name"
        option-value="id"
        size="small"
        class="picker"
        @update:model-value="(v) => workspace.selectOrganization(v)"
      />

      <div class="picker-group">
        <Select
          v-if="workspace.projects.length"
          :model-value="workspace.currentProjectId"
          :options="workspace.projects"
          option-label="name"
          option-value="id"
          size="small"
          class="picker"
          @update:model-value="(v) => workspace.selectProject(v)"
        />
        <Button
          v-if="workspace.currentOrgId"
          icon="pi pi-plus"
          text
          size="small"
          severity="secondary"
          :label="workspace.projects.length ? undefined : t('topbar.newProject')"
          :title="workspace.projects.length ? t('topbar.newProject') : undefined"
          :aria-label="t('topbar.newProject')"
          @click="addProject"
        />
        <Button
          v-if="workspace.currentProjectId"
          icon="pi pi-pencil"
          text
          size="small"
          severity="secondary"
          :title="t('topbar.renameProject', { name: workspace.currentProject?.name ?? '' })"
          :aria-label="t('rename.project')"
          @click="renameProject"
        />
        <Button
          v-if="workspace.currentProjectId"
          icon="pi pi-trash"
          text
          size="small"
          severity="secondary"
          class="danger-btn"
          :title="t('topbar.deleteProject', { name: workspace.currentProject?.name ?? '' })"
          :aria-label="t('common.delete')"
          @click="onDeleteProject"
        />
      </div>

      <div class="spacer" />

      <Button
        icon="pi pi-terminal"
        :label="t('topbar.curl')"
        size="small"
        severity="secondary"
        text
        :title="t('topbar.newCurlConsole')"
        @click="openCurlTab"
      />

      <EnvironmentPicker v-if="workspace.currentProjectId" />

      <Button
        icon="pi pi-cog"
        text
        size="small"
        severity="secondary"
        :title="t('topbar.settings')"
        :aria-label="t('topbar.settings')"
        @click="settingsOpen = true"
      />

      <Button
        v-if="auth.user"
        icon="pi pi-user"
        :label="auth.user.displayName"
        text
        size="small"
        severity="secondary"
        class="user-btn"
        :title="t('topbar.accountTooltip')"
        :aria-label="t('topbar.account')"
        @click="settingsOpen = true"
      />
    </header>

    <SettingsDialog v-model="settingsOpen" />
    <AboutDialog v-model="aboutOpen" />

    <!--
      Sidebar toggle: when collapsed we render the content full-width
      instead of trying to drive the Splitter to size 0 (Splitter doesn't
      cope well with that). Swapping the wrapper is cleaner and keeps
      the splitter sizes meaningful when the user expands again.
    -->
    <Splitter v-if="!sidebarCollapsed" class="body" :gutter-size="4">
      <SplitterPanel :size="22" :min-size="14">
        <CollectionTree />
      </SplitterPanel>
      <SplitterPanel :size="78" :min-size="40">
        <main class="content">
          <slot />
        </main>
      </SplitterPanel>
    </Splitter>
    <main v-else class="content body-full">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  height: 48px;
  flex-shrink: 0;
}
.picker-group {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}
.picker {
  min-width: 140px;
  max-width: 200px;
}
.spacer {
  flex: 1;
}
.user-btn :deep(.p-button-label) {
  font-size: 0.82rem;
  font-weight: 400;
}
.body {
  flex: 1;
  min-height: 0;
}
.body-full {
  flex: 1;
  min-height: 0;
  height: auto;
}
.content {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.danger-btn:hover {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.1);
}
</style>
