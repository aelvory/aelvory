<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Message from 'primevue/message';
import { api, ApiError } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

interface Props {
  orgId: string;
}
const props = defineProps<Props>();
const router = useRouter();
const auth = useAuthStore();

interface Project {
  id: string;
  organizationId: string;
  // Null when the project's sync payload is end-to-end encrypted — the
  // server can't read the name, only confirm the project exists.
  name: string | null;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** True when the payload is E2EE and the server couldn't read it. */
  encrypted: boolean;
  /**
   * True only when a canonical Projects row also exists. The Access
   * (project-member grant) flow anchors on that row, so it's only
   * offered for manageable projects; desktop-origin (sync-only)
   * projects are list-only here.
   */
  manageable: boolean;
}

interface Member {
  id: string;
  userId: string;
  role: 'owner' | 'admin' | 'editor';
  restricted: boolean;
}

interface ProjectStats {
  projectId: string;
  collectionCount: number;
  requestCount: number;
  environmentCount: number;
  variableCount: number;
}

const projects = ref<Project[]>([]);
const myMember = ref<Member | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

/**
 * Project id → counts. Stored as a Map for O(1) per-row lookup in the
 * template. Defaulted to all-zero if a project's stats haven't loaded
 * yet (or failed) so the UI never shows blanks — empty projects look
 * like zero-zero, which is exactly what they are.
 */
const statsByProjectId = ref<Map<string, ProjectStats>>(new Map());

const ZERO_STATS: Omit<ProjectStats, 'projectId'> = {
  collectionCount: 0,
  requestCount: 0,
  environmentCount: 0,
  variableCount: 0,
};

function statsFor(projectId: string): Omit<ProjectStats, 'projectId'> {
  return statsByProjectId.value.get(projectId) ?? ZERO_STATS;
}

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    // Three parallel calls. Stats is on its own endpoint (rather than
    // baked into List) because the desktop's sign-in reconciliation
    // hits List on every sign-in and doesn't need counts — keeping it
    // separate keeps that path cheap.
    const [list, members, stats] = await Promise.all([
      // `/projects/all` reads from the sync log, so projects created on
      // the desktop (which never reach the canonical Projects table) show
      // up too. The plain `/projects` endpoint is canonical-only and used
      // by the desktop reconcile — don't switch to it here.
      api<Project[]>(`/api/organizations/${props.orgId}/projects/all`),
      api<Member[]>(`/api/organizations/${props.orgId}/members`),
      // Stats can fail in isolation (e.g. a server hiccup) without
      // breaking the page — treat missing stats as zeros and let the
      // user see at least the project list. Catch swallows here so
      // the outer try/catch doesn't take the whole page down.
      api<ProjectStats[]>(`/api/organizations/${props.orgId}/projects/stats`).catch(
        () => [] as ProjectStats[],
      ),
    ]);
    projects.value = list;
    myMember.value = members.find((m) => m.userId === auth.userId) ?? null;
    statsByProjectId.value = new Map(stats.map((s) => [s.projectId, s]));
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      router.replace({ path: '/' });
      return;
    }
    loadError.value = err instanceof Error ? err.message : 'load_failed';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.orgId, load);

/**
 * Owner/Admin gate. Used for access management (granting/revoking
 * ProjectMembers) — the server enforces the same role check on
 * `/api/projects/{id}/members` (see ProjectMembersController.IsAdminAsync).
 * Surfacing the button to an Editor would just cough up a 403 on click.
 */
const isOrgAdmin = computed(
  () => myMember.value?.role === 'owner' || myMember.value?.role === 'admin',
);

function openAccess(p: Project) {
  router.push({
    name: 'project-members',
    params: { orgId: props.orgId, projectId: p.id },
  });
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Projects</h1>
        <p class="page-sub">
          A read-only view of every project in this organization, including
          those created in the desktop app. Projects are the unit of access:
          restricted Editors only see the ones you grant them via the
          <strong>Access</strong> button.
        </p>
      </div>
    </header>

    <Message
      v-if="loadError"
      severity="error"
      :closable="false"
      class="msg"
    >{{ loadError }}</Message>

    <DataTable :value="projects" :loading="loading" strip-rows data-key="id">
      <Column field="name" header="Name">
        <template #body="{ data }">
          <span v-if="data.encrypted" class="locked" title="End-to-end encrypted — the server can't read this project's name">
            <i class="pi pi-lock" /> Encrypted project
          </span>
          <span v-else>{{ data.name }}</span>
        </template>
      </Column>
      <Column field="description" header="Description">
        <template #body="{ data }">
          <span v-if="data.description">{{ data.description }}</span>
          <span v-else class="muted-inline">—</span>
        </template>
      </Column>
      <Column header="Content" style="width: 320px">
        <template #body="{ data }">
          <!--
            Inline metric chips. Counts come from the per-org stats
            endpoint and surface what's actually been pushed into each
            project — collections, requests, environments, variables.
            Zero-counts still render so the user can see "this project
            is empty" at a glance instead of guessing whether stats
            failed to load.
          -->
          <div class="metric-row">
            <span
              class="metric"
              :title="`${statsFor(data.id).collectionCount} collection${
                statsFor(data.id).collectionCount === 1 ? '' : 's'
              }`"
            >
              <i class="pi pi-folder" />
              {{ statsFor(data.id).collectionCount }}
            </span>
            <span
              class="metric"
              :title="`${statsFor(data.id).requestCount} request${
                statsFor(data.id).requestCount === 1 ? '' : 's'
              }`"
            >
              <i class="pi pi-send" />
              {{ statsFor(data.id).requestCount }}
            </span>
            <span
              class="metric"
              :title="`${statsFor(data.id).environmentCount} environment${
                statsFor(data.id).environmentCount === 1 ? '' : 's'
              }`"
            >
              <i class="pi pi-cog" />
              {{ statsFor(data.id).environmentCount }}
            </span>
            <span
              class="metric"
              :title="`${statsFor(data.id).variableCount} variable${
                statsFor(data.id).variableCount === 1 ? '' : 's'
              }`"
            >
              <i class="pi pi-tag" />
              {{ statsFor(data.id).variableCount }}
            </span>
          </div>
        </template>
      </Column>
      <Column header="" style="width: 160px">
        <template #body="{ data }">
          <div class="row-actions">
            <!--
              Access (project-member grants) anchors on the canonical
              Projects row, which desktop-origin projects don't have. Gate
              on `manageable` so we never surface a button that would 404;
              show a "synced from desktop" hint instead so the row doesn't
              look broken.
            -->
            <Button
              v-if="isOrgAdmin && data.manageable"
              icon="pi pi-users"
              label="Access"
              size="small"
              text
              severity="secondary"
              @click="openAccess(data)"
            />
            <span
              v-else-if="isOrgAdmin && !data.manageable"
              class="view-only"
              title="Created in the desktop app — it lives in the sync log, not the admin database, so per-project access can't be managed here."
            >
              <i class="pi pi-cloud" /> synced from desktop
            </span>
          </div>
        </template>
      </Column>
      <template #empty>
        <span v-if="!loading">No projects yet.</span>
      </template>
    </DataTable>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 1.25rem; }
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.page-title { margin: 0; font-size: 1.4rem; font-weight: 600; }
.page-sub {
  margin: 0.2rem 0 0;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.88rem;
  max-width: 60ch;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.metric-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.metric {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-muted-color, #6b7280);
  background: var(--p-surface-100, #f3f4f6);
  border-radius: 999px;
  cursor: default;
}
.metric i {
  font-size: 0.72rem;
  opacity: 0.8;
}
.muted-inline {
  color: var(--p-text-muted-color, #9ca3af);
  font-size: 0.85rem;
}
.locked {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--p-text-muted-color, #6b7280);
  font-style: italic;
}
.locked i {
  font-size: 0.78rem;
}
.view-only {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #9ca3af);
}
.view-only i {
  font-size: 0.72rem;
}
.msg { font-size: 0.82rem; margin-top: 0.5rem; }
</style>
