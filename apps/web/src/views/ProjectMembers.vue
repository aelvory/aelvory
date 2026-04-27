<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { api, ApiError } from '@/services/api';

/**
 * Per-project access management. Only meaningful for restricted
 * Editors — owners/admins/unrestricted Editors see every project
 * already, no grant rows needed.
 *
 * Routes:
 *   GET    /api/projects/:projectId/members
 *   POST   /api/projects/:projectId/members  { userId }
 *   DELETE /api/projects/:projectId/members/:grantId
 *
 * We pull the org's member list to build the "add user" picker — the
 * server expects a userId, so we resolve from email/displayName here.
 */

interface Props {
  orgId: string;
  projectId: string;
}
const props = defineProps<Props>();
const router = useRouter();
const confirm = useConfirm();
const toast = useToast();

interface OrgMember {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'editor';
  restricted: boolean;
}

interface Grant {
  id: string;
  projectId: string;
  userId: string;
  email: string;
  displayName: string;
  grantedBy: string;
  grantedAt: string;
}

interface Project {
  id: string;
  name: string;
}

const project = ref<Project | null>(null);
const grants = ref<Grant[]>([]);
const orgMembers = ref<OrgMember[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const [proj, list, mems] = await Promise.all([
      api<Project>(`/api/organizations/${props.orgId}/projects/${props.projectId}`),
      api<Grant[]>(`/api/projects/${props.projectId}/members`),
      api<OrgMember[]>(`/api/organizations/${props.orgId}/members`),
    ]);
    project.value = proj;
    grants.value = list;
    orgMembers.value = mems;
  } catch (err) {
    // 403 here means the user is not Owner/Admin in this org. The
    // server enforces the same gate as the UI on OrgProjects.vue (the
    // Access button is hidden for Editors), so this branch fires only
    // on direct-URL navigation / bookmark / back-button. Friendly
    // copy beats a raw "HTTP 403".
    if (err instanceof ApiError && err.status === 403) {
      loadError.value =
        'Only owners and admins can manage per-project access. Ask an admin if you need to change grants here.';
    } else {
      loadError.value = err instanceof Error ? err.message : 'load_failed';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => [props.orgId, props.projectId], load);

/**
 * Restricted Editors are the only members for whom these grants matter.
 * Surface them prominently — granting access to non-restricted members
 * is a no-op (they already see everything) and the server rejects with
 * "not_org_member" only if they aren't members at all.
 */
const candidates = computed<OrgMember[]>(() => {
  const granted = new Set(grants.value.map((g) => g.userId));
  return orgMembers.value
    .filter((m) => m.role === 'editor' && m.restricted && !granted.has(m.userId))
    .sort((a, b) => a.email.localeCompare(b.email));
});

const allRestrictedCount = computed(
  () => orgMembers.value.filter((m) => m.role === 'editor' && m.restricted).length,
);

// ---- Add grant dialog ----

const grantOpen = ref(false);
const selectedUserId = ref<string | null>(null);
const grantBusy = ref(false);
const grantError = ref<string | null>(null);

function openGrant() {
  selectedUserId.value = null;
  grantError.value = null;
  grantOpen.value = true;
}

async function submitGrant() {
  if (!selectedUserId.value) return;
  grantError.value = null;
  grantBusy.value = true;
  try {
    const created = await api<Grant>(`/api/projects/${props.projectId}/members`, {
      method: 'POST',
      body: { userId: selectedUserId.value },
    });
    grants.value = [...grants.value, created];
    toast.add({
      severity: 'success',
      summary: 'Access granted',
      detail: `${created.email} can now see this project.`,
      life: 3500,
    });
    grantOpen.value = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      grantError.value = 'That user isn\'t a member of this organization.';
    } else if (err instanceof ApiError && err.status === 409) {
      grantError.value = 'That user already has access.';
    } else {
      grantError.value = err instanceof Error ? err.message : 'grant_failed';
    }
  } finally {
    grantBusy.value = false;
  }
}

function confirmRevoke(g: Grant) {
  confirm.require({
    header: 'Revoke access?',
    message:
      `Revoke ${g.email}'s access to this project? They lose visibility ` +
      `and won't sync any of its data.`,
    acceptLabel: 'Revoke',
    rejectLabel: 'Cancel',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await api(`/api/projects/${props.projectId}/members/${g.id}`, {
          method: 'DELETE',
        });
        grants.value = grants.value.filter((x) => x.id !== g.id);
        toast.add({
          severity: 'success',
          summary: 'Revoked',
          detail: `${g.email} no longer has access.`,
          life: 3500,
        });
      } catch (err) {
        toast.add({
          severity: 'error',
          summary: 'Could not revoke',
          detail: err instanceof Error ? err.message : String(err),
          life: 5000,
        });
      }
    },
  });
}

function backToProjects() {
  router.push({ name: 'org-projects', params: { orgId: props.orgId } });
}
</script>

<template>
  <div class="page">
    <Button
      icon="pi pi-arrow-left"
      label="Back to Projects"
      text
      severity="secondary"
      class="back"
      @click="backToProjects"
    />

    <header class="page-head">
      <div>
        <h1 class="page-title">
          Access
          <span class="muted-inline">·</span>
          <span class="proj-name">{{ project?.name ?? '…' }}</span>
        </h1>
        <p class="page-sub">
          Restricted Editors need an explicit grant here to see this
          project. Owners, admins, and unrestricted Editors see all
          projects — they don't appear in this list.
        </p>
      </div>
      <Button
        icon="pi pi-user-plus"
        label="Grant access"
        :disabled="candidates.length === 0"
        @click="openGrant"
      />
    </header>

    <Message
      v-if="loadError"
      severity="error"
      :closable="false"
      class="msg"
    >{{ loadError }}</Message>

    <Message
      v-if="!loading && allRestrictedCount === 0"
      severity="info"
      :closable="false"
      class="msg"
    >
      No restricted Editors in this organization. Mark a member as
      restricted in the Members tab first, then grant them access here.
    </Message>

    <DataTable :value="grants" :loading="loading" strip-rows data-key="id">
      <Column field="email" header="Email" />
      <Column field="displayName" header="Name" />
      <Column header="Granted" style="width: 200px">
        <template #body="{ data }">
          <span class="muted-inline">
            {{ new Date(data.grantedAt).toLocaleString() }}
          </span>
        </template>
      </Column>
      <Column header="" style="width: 60px">
        <template #body="{ data }">
          <Button
            icon="pi pi-trash"
            text
            rounded
            severity="secondary"
            class="danger-btn"
            aria-label="Revoke access"
            @click="confirmRevoke(data)"
          />
        </template>
      </Column>
      <template #empty>
        <span v-if="!loading">
          No grants yet. Click "Grant access" to share this project with a
          restricted Editor.
        </span>
      </template>
    </DataTable>

    <Dialog
      v-model:visible="grantOpen"
      modal
      header="Grant project access"
      :style="{ width: '460px' }"
    >
      <div class="form">
        <p class="muted-inline small">
          Pick a restricted Editor to grant access to
          <strong>{{ project?.name ?? 'this project' }}</strong>.
        </p>

        <label class="lbl">User</label>
        <Select
          v-model="selectedUserId"
          :options="candidates"
          option-label="email"
          option-value="userId"
          placeholder="Select a restricted Editor"
          class="full"
        >
          <template #option="{ option }">
            <div class="opt">
              <span>{{ option.email }}</span>
              <Tag value="restricted" severity="warn" />
            </div>
          </template>
        </Select>

        <p v-if="candidates.length === 0" class="muted-inline small">
          Every restricted Editor already has access. Add a new
          restricted Editor in the Members tab to grant access.
        </p>

        <Message
          v-if="grantError"
          severity="error"
          :closable="false"
          class="msg"
        >{{ grantError }}</Message>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="grantOpen = false" />
        <Button
          label="Grant"
          :loading="grantBusy"
          :disabled="!selectedUserId"
          @click="submitGrant"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 1.25rem; }
.back { align-self: flex-start; padding: 0; }
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.page-title {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.proj-name {
  font-weight: 500;
  color: var(--p-text-color, #111827);
}
.page-sub {
  margin: 0.2rem 0 0;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.88rem;
  max-width: 60ch;
}
.muted-inline {
  color: var(--p-text-muted-color, #9ca3af);
  font-size: 0.85rem;
}
.muted-inline.small { font-size: 0.78rem; }
.danger-btn:hover {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
}
.form { display: flex; flex-direction: column; gap: 0.5rem; }
.lbl {
  font-size: 0.82rem;
  font-weight: 500;
  margin-top: 0.4rem;
}
.full { width: 100%; }
.opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
}
.msg { font-size: 0.82rem; margin-top: 0.5rem; }
</style>
