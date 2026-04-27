<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Tag from 'primevue/tag';
import Message from 'primevue/message';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { api, ApiError } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

/**
 * Members of a single organization. Owners + admins can invite, change
 * roles, toggle the "restricted" flag, and remove members. Editors see
 * the list but the action buttons are disabled.
 *
 * Routes:
 *   GET    /api/organizations/:orgId/members
 *   POST   /api/organizations/:orgId/members         { email, role, restricted, wrappedDek }
 *   PUT    /api/organizations/:orgId/members/:id     { role, restricted }
 *   DELETE /api/organizations/:orgId/members/:id
 */

interface Props {
  orgId: string;
}

const props = defineProps<Props>();
const router = useRouter();
const auth = useAuthStore();
const confirm = useConfirm();
const toast = useToast();

interface Member {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'editor';
  restricted: boolean;
  wrappedDek: string | null;
}

const members = ref<Member[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    members.value = await api<Member[]>(`/api/organizations/${props.orgId}/members`);
  } catch (err) {
    // 403 here means the URL's :orgId points at an org the current
    // user isn't a member of — typically a stale localStorage selection
    // from a previous session. Bounce to / so AdminLayout's load() can
    // pick a valid org for them. Avoids a confusing "HTTP 403" toast on
    // a fresh sign-in.
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

// "Am I admin?" — derived from the loaded list. Drives whether we
// show the Invite button + per-row action menu.
const myMember = computed(
  () => members.value.find((m) => m.userId === auth.userId) ?? null,
);
const canManage = computed(
  () => myMember.value?.role === 'owner' || myMember.value?.role === 'admin',
);

// ---- Invite dialog ----

const inviteOpen = ref(false);
const inviteEmail = ref('');
const inviteRole = ref<'admin' | 'editor'>('editor');
const inviteRestricted = ref(false);
const inviteBusy = ref(false);
const inviteError = ref<string | null>(null);

const roleOptions = [
  { label: 'Admin', value: 'admin' },
  { label: 'Editor', value: 'editor' },
];

function openInvite() {
  inviteEmail.value = '';
  inviteRole.value = 'editor';
  inviteRestricted.value = false;
  inviteError.value = null;
  inviteOpen.value = true;
}

async function submitInvite() {
  inviteError.value = null;
  inviteBusy.value = true;
  try {
    const created = await api<Member>(
      `/api/organizations/${props.orgId}/members`,
      {
        method: 'POST',
        body: {
          email: inviteEmail.value.trim(),
          role: inviteRole.value,
          // restricted only applies to Editor; server clamps anyway.
          restricted: inviteRole.value === 'editor' && inviteRestricted.value,
          wrappedDek: '',
        },
      },
    );
    members.value = [...members.value, created];
    toast.add({
      severity: 'success',
      summary: 'Invited',
      detail: `${created.email} is now an ${created.role}.`,
      life: 3500,
    });
    inviteOpen.value = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      inviteError.value = 'No user with that email — they need to sign up first.';
    } else if (err instanceof ApiError && err.status === 409) {
      inviteError.value = 'Already a member of this organization.';
    } else {
      inviteError.value = err instanceof Error ? err.message : 'invite_failed';
    }
  } finally {
    inviteBusy.value = false;
  }
}

// ---- Edit row (role / restricted) ----

async function setRole(m: Member, newRole: 'admin' | 'editor') {
  // Owner role isn't toggleable here — we don't want to accidentally
  // remove the last owner. The server accepts the request but the UI
  // limits it.
  try {
    await api(`/api/organizations/${props.orgId}/members/${m.id}`, {
      method: 'PUT',
      body: {
        role: newRole,
        // Reset restricted on promotion to Admin (server enforces too).
        restricted: newRole === 'editor' ? m.restricted : false,
      },
    });
    m.role = newRole;
    if (newRole !== 'editor') m.restricted = false;
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not update role',
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  }
}

async function setRestricted(m: Member, value: boolean) {
  if (m.role !== 'editor') return;
  try {
    await api(`/api/organizations/${props.orgId}/members/${m.id}`, {
      method: 'PUT',
      body: { role: m.role, restricted: value },
    });
    m.restricted = value;
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not update restriction',
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  }
}

function confirmRemove(m: Member) {
  confirm.require({
    header: 'Remove member?',
    message:
      `Remove ${m.email} from this organization? They lose all access immediately. ` +
      `Re-invite anytime to restore.`,
    acceptLabel: 'Remove',
    rejectLabel: 'Cancel',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await api(`/api/organizations/${props.orgId}/members/${m.id}`, {
          method: 'DELETE',
        });
        members.value = members.value.filter((x) => x.id !== m.id);
        toast.add({
          severity: 'success',
          summary: 'Removed',
          detail: `${m.email} no longer has access.`,
          life: 3500,
        });
      } catch (err) {
        toast.add({
          severity: 'error',
          summary: 'Could not remove',
          detail: err instanceof Error ? err.message : String(err),
          life: 5000,
        });
      }
    },
  });
}

function openProjectGrants(m: Member) {
  // Per-project access is managed from a project's page; this jumps
  // there filtered by user. We don't have a "show only this user"
  // filter on the project page itself yet, so for now this just goes
  // to the projects index where the admin can drill in.
  router.push({ name: 'org-projects', params: { orgId: props.orgId } });
}

function roleSeverity(role: string): 'success' | 'info' | 'secondary' {
  if (role === 'owner') return 'success';
  if (role === 'admin') return 'info';
  return 'secondary';
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Members</h1>
        <p class="page-sub">
          People who can access this organization. Editors can be
          restricted to specific projects below.
        </p>
      </div>
      <Button
        v-if="canManage"
        icon="pi pi-user-plus"
        label="Invite member"
        @click="openInvite"
      />
    </header>

    <Message
      v-if="loadError"
      severity="error"
      :closable="false"
      class="msg"
    >{{ loadError }}</Message>

    <DataTable
      :value="members"
      :loading="loading"
      strip-rows
      data-key="id"
      class="members-table"
    >
      <Column field="email" header="Email" />
      <Column field="displayName" header="Name" />
      <Column header="Role" style="width: 200px">
        <template #body="{ data }">
          <Tag
            v-if="data.role === 'owner' || !canManage"
            :value="data.role"
            :severity="roleSeverity(data.role)"
          />
          <Select
            v-else
            :model-value="data.role"
            :options="roleOptions"
            option-label="label"
            option-value="value"
            size="small"
            @update:model-value="(v: 'admin' | 'editor') => setRole(data, v)"
          />
        </template>
      </Column>
      <Column header="Restricted to projects" style="width: 220px">
        <template #body="{ data }">
          <div v-if="data.role === 'editor' && canManage" class="row-restrict">
            <ToggleSwitch
              :model-value="data.restricted"
              @update:model-value="(v: boolean) => setRestricted(data, v)"
            />
            <Button
              v-if="data.restricted"
              icon="pi pi-folder-open"
              label="Manage"
              size="small"
              text
              severity="secondary"
              @click="openProjectGrants(data)"
            />
          </div>
          <span v-else-if="data.role !== 'editor'" class="muted-inline">—</span>
          <Tag v-else-if="data.restricted" value="restricted" severity="warn" />
          <span v-else class="muted-inline">all projects</span>
        </template>
      </Column>
      <Column header="" style="width: 60px">
        <template #body="{ data }">
          <Button
            v-if="canManage && data.userId !== auth.userId && data.role !== 'owner'"
            icon="pi pi-trash"
            text
            rounded
            severity="secondary"
            class="danger-btn"
            aria-label="Remove member"
            @click="confirmRemove(data)"
          />
        </template>
      </Column>
      <template #empty>
        <span v-if="!loading">No members yet.</span>
      </template>
    </DataTable>

    <!-- Invite dialog -->
    <Dialog
      v-model:visible="inviteOpen"
      modal
      header="Invite member"
      :style="{ width: '460px' }"
    >
      <div class="invite-form">
        <p class="muted-inline small">
          The invitee must already have an Aelvory account with this
          email. Email-based invitation links will land in a later
          release.
        </p>

        <label class="lbl">Email</label>
        <InputText v-model="inviteEmail" type="email" autocomplete="email" />

        <label class="lbl">Role</label>
        <Select
          v-model="inviteRole"
          :options="roleOptions"
          option-label="label"
          option-value="value"
        />

        <div v-if="inviteRole === 'editor'" class="restrict-row">
          <ToggleSwitch v-model="inviteRestricted" />
          <div>
            <div class="restrict-title">Restrict to specific projects</div>
            <div class="muted-inline small">
              When on, this person sees only projects you grant access
              to. Manage project access in the Projects tab.
            </div>
          </div>
        </div>

        <Message
          v-if="inviteError"
          severity="error"
          :closable="false"
          class="msg"
        >{{ inviteError }}</Message>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="inviteOpen = false" />
        <Button
          label="Send invite"
          :loading="inviteBusy"
          :disabled="!inviteEmail.trim()"
          @click="submitInvite"
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
  max-width: 56ch;
}
.members-table { font-size: 0.9rem; }
.row-restrict {
  display: flex;
  align-items: center;
  gap: 0.5rem;
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
.invite-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.lbl {
  font-size: 0.82rem;
  font-weight: 500;
  margin-top: 0.4rem;
}
.restrict-row {
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  margin-top: 0.6rem;
  padding: 0.6rem 0.7rem;
  background: var(--p-surface-50, #f9fafb);
  border-radius: 5px;
}
.restrict-title {
  font-size: 0.85rem;
  font-weight: 500;
}
.msg { font-size: 0.82rem; margin-top: 0.5rem; }
</style>
