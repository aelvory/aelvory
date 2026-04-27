<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Message from 'primevue/message';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { api, ApiError } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

interface Props {
  orgId: string;
}
const props = defineProps<Props>();
const router = useRouter();
const auth = useAuthStore();
const confirm = useConfirm();
const toast = useToast();

interface Project {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
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
      api<Project[]>(`/api/organizations/${props.orgId}/projects`),
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

const canManage = computed(
  () =>
    myMember.value?.role === 'owner' ||
    myMember.value?.role === 'admin' ||
    (myMember.value?.role === 'editor' && !myMember.value.restricted),
);
/**
 * Owner/Admin gate. Used for project deletion AND access management
 * (granting/revoking ProjectMembers) — the server enforces the same
 * role check on `/api/projects/{id}/members` (see
 * ProjectMembersController.IsAdminAsync). Surfacing those buttons to
 * an Editor would just cough up a 403 on click.
 */
const isOrgAdmin = computed(
  () => myMember.value?.role === 'owner' || myMember.value?.role === 'admin',
);

// ---- Create / edit dialog ----

const editOpen = ref(false);
const editTitle = ref('');
const editingId = ref<string | null>(null);
const editName = ref('');
const editDescription = ref('');
const editBusy = ref(false);
const editError = ref<string | null>(null);

function openCreate() {
  editingId.value = null;
  editTitle.value = 'New project';
  editName.value = '';
  editDescription.value = '';
  editError.value = null;
  editOpen.value = true;
}

function openEdit(p: Project) {
  editingId.value = p.id;
  editTitle.value = `Edit ${p.name}`;
  editName.value = p.name;
  editDescription.value = p.description ?? '';
  editError.value = null;
  editOpen.value = true;
}

async function submitEdit() {
  editError.value = null;
  if (!editName.value.trim()) {
    editError.value = 'Name is required.';
    return;
  }
  editBusy.value = true;
  try {
    const body = {
      name: editName.value.trim(),
      description: editDescription.value.trim() || null,
    };
    if (editingId.value) {
      const updated = await api<Project>(
        `/api/organizations/${props.orgId}/projects/${editingId.value}`,
        { method: 'PUT', body },
      );
      const i = projects.value.findIndex((p) => p.id === updated.id);
      if (i >= 0) projects.value[i] = updated;
    } else {
      const created = await api<Project>(
        `/api/organizations/${props.orgId}/projects`,
        { method: 'POST', body },
      );
      projects.value = [...projects.value, created];
    }
    editOpen.value = false;
  } catch (err) {
    editError.value = err instanceof Error ? err.message : 'save_failed';
  } finally {
    editBusy.value = false;
  }
}

function confirmDelete(p: Project) {
  confirm.require({
    header: 'Delete project?',
    message:
      `Delete "${p.name}"? Every collection, request, environment and ` +
      `variable inside is removed for everyone with access. This can't be undone.`,
    acceptLabel: 'Delete',
    rejectLabel: 'Cancel',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await api(`/api/organizations/${props.orgId}/projects/${p.id}`, {
          method: 'DELETE',
        });
        projects.value = projects.value.filter((x) => x.id !== p.id);
        toast.add({
          severity: 'success',
          summary: 'Deleted',
          detail: `${p.name} is gone.`,
          life: 3500,
        });
      } catch (err) {
        toast.add({
          severity: 'error',
          summary: 'Could not delete',
          detail: err instanceof Error ? err.message : String(err),
          life: 5000,
        });
      }
    },
  });
}

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
          Projects are the unit of access. Restricted Editors only see
          the projects you grant them access to via the
          <strong>Access</strong> button.
        </p>
      </div>
      <Button
        v-if="canManage"
        icon="pi pi-plus"
        label="New project"
        @click="openCreate"
      />
    </header>

    <Message
      v-if="loadError"
      severity="error"
      :closable="false"
      class="msg"
    >{{ loadError }}</Message>

    <DataTable :value="projects" :loading="loading" strip-rows data-key="id">
      <Column field="name" header="Name" />
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
      <Column header="" style="width: 280px">
        <template #body="{ data }">
          <div class="row-actions">
            <Button
              v-if="isOrgAdmin"
              icon="pi pi-users"
              label="Access"
              size="small"
              text
              severity="secondary"
              @click="openAccess(data)"
            />
            <Button
              v-if="canManage"
              icon="pi pi-pencil"
              size="small"
              text
              severity="secondary"
              aria-label="Edit project"
              @click="openEdit(data)"
            />
            <Button
              v-if="isOrgAdmin"
              icon="pi pi-trash"
              size="small"
              text
              rounded
              severity="secondary"
              class="danger-btn"
              aria-label="Delete project"
              @click="confirmDelete(data)"
            />
          </div>
        </template>
      </Column>
      <template #empty>
        <span v-if="!loading">No projects yet.</span>
      </template>
    </DataTable>

    <Dialog
      v-model:visible="editOpen"
      modal
      :header="editTitle"
      :style="{ width: '460px' }"
    >
      <div class="form">
        <label class="lbl">Name</label>
        <InputText v-model="editName" autofocus />

        <label class="lbl">Description</label>
        <Textarea v-model="editDescription" rows="3" auto-resize />

        <Message
          v-if="editError"
          severity="error"
          :closable="false"
          class="msg"
        >{{ editError }}</Message>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="editOpen = false" />
        <Button
          :label="editingId ? 'Save' : 'Create'"
          :loading="editBusy"
          :disabled="!editName.trim()"
          @click="submitEdit"
        />
      </template>
    </Dialog>
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
.danger-btn:hover {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
}
.form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.lbl {
  font-size: 0.82rem;
  font-weight: 500;
  margin-top: 0.4rem;
}
.msg { font-size: 0.82rem; margin-top: 0.5rem; }
</style>
