<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import Select from 'primevue/select';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { useAuthStore } from '@/stores/auth';
import { useOrgsStore } from '@/stores/orgs';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const orgs = useOrgsStore();
const confirm = useConfirm();
const toast = useToast();

onMounted(async () => {
  if (!orgs.loaded) await orgs.load();
});

/**
 * Whenever the URL's :orgId param changes (user clicked a different
 * org in the switcher, or browser back), keep the store in sync. The
 * other direction (selector changes the URL) lives in onSelectOrg.
 */
watch(
  () => route.params.orgId,
  (orgId) => {
    if (typeof orgId === 'string' && orgId !== orgs.currentOrgId) {
      orgs.setCurrent(orgId);
    }
  },
  { immediate: true },
);

const navItems = computed(() => {
  const orgId = orgs.currentOrgId;
  if (!orgId) return [];
  return [
    { label: 'Members', icon: 'pi pi-users', name: 'org-members', params: { orgId } },
    { label: 'Projects', icon: 'pi pi-folder-open', name: 'org-projects', params: { orgId } },
  ];
});

const isActive = (name: string) => route.matched.some((r) => r.name === name);

function onSelectOrg(orgId: string | null) {
  if (!orgId) return;
  orgs.setCurrent(orgId);
  // Stay on the same kind of page (members vs projects) when switching
  // orgs, falling back to members.
  const target = isActive('org-projects') ? 'org-projects' : 'org-members';
  router.push({ name: target, params: { orgId } });
}

function go(name: string) {
  if (!orgs.currentOrgId) return;
  router.push({ name, params: { orgId: orgs.currentOrgId } });
}

function onSignOut() {
  auth.signOut();
  router.push('/signin');
}

// ---- Org create / rename / delete ----
//
// Server endpoints:
//   POST   /api/organizations            { name }     — anyone can create (becomes Owner)
//   PUT    /api/organizations/{id}       { name }     — Owner/Admin only
//   DELETE /api/organizations/{id}                    — Owner of Team-kind only
// UI gates mirror those rules using `orgs.isCurrentOrgAdmin` and
// `orgs.isCurrentOrgDeletable`.

const createOpen = ref(false);
const createName = ref('');
const createBusy = ref(false);
const createError = ref<string | null>(null);

function openCreate() {
  createName.value = '';
  createError.value = null;
  createOpen.value = true;
}

async function submitCreate() {
  const name = createName.value.trim();
  if (!name) {
    createError.value = 'Name is required.';
    return;
  }
  createBusy.value = true;
  createError.value = null;
  try {
    const created = await orgs.createOrg(name);
    createOpen.value = false;
    toast.add({
      severity: 'success',
      summary: 'Organization created',
      detail: `"${created.name}" is ready.`,
      life: 3000,
    });
    // Land in the new org's Members page so the user sees they're
    // already an Owner there and can start inviting.
    router.push({ name: 'org-members', params: { orgId: created.id } });
  } catch (err) {
    createError.value = err instanceof Error ? err.message : 'create_failed';
  } finally {
    createBusy.value = false;
  }
}

const renameOpen = ref(false);
const renameInput = ref('');
const renameBusy = ref(false);
const renameError = ref<string | null>(null);

function openRename() {
  if (!orgs.currentOrg) return;
  renameInput.value = orgs.currentOrg.name;
  renameError.value = null;
  renameOpen.value = true;
}

async function submitRename() {
  const id = orgs.currentOrgId;
  if (!id) return;
  const name = renameInput.value.trim();
  if (!name) {
    renameError.value = 'Name is required.';
    return;
  }
  renameBusy.value = true;
  renameError.value = null;
  try {
    await orgs.updateOrg(id, name);
    renameOpen.value = false;
    toast.add({
      severity: 'success',
      summary: 'Renamed',
      detail: `Organization is now "${name}".`,
      life: 3000,
    });
  } catch (err) {
    renameError.value = err instanceof Error ? err.message : 'rename_failed';
  } finally {
    renameBusy.value = false;
  }
}

function confirmDelete() {
  const org = orgs.currentOrg;
  if (!org) return;
  confirm.require({
    header: `Delete "${org.name}"?`,
    message:
      `This deletes the organization, all its projects, members, and ` +
      `associated synced data. Members lose access immediately. ` +
      `This can't be undone.`,
    acceptLabel: 'Delete',
    rejectLabel: 'Cancel',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await orgs.deleteOrg(org.id);
        toast.add({
          severity: 'success',
          summary: 'Deleted',
          detail: `"${org.name}" is gone.`,
          life: 3500,
        });
        // After delete, deleteOrg() picks the next available org as
        // current (or null). Navigate there explicitly so the URL
        // matches the now-current state.
        if (orgs.currentOrgId) {
          router.push({
            name: 'org-members',
            params: { orgId: orgs.currentOrgId },
          });
        } else {
          router.push('/');
        }
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
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="logo">Aelvory</span>
        <span class="badge">Admin</span>
      </div>

      <div class="org-switch">
        <label class="lbl">Organization</label>
        <div v-if="orgs.orgs.length" class="org-switch-row">
          <Select
            :model-value="orgs.currentOrgId"
            :options="orgs.orgs"
            option-label="name"
            option-value="id"
            class="full"
            size="small"
            @update:model-value="onSelectOrg"
          />
          <Button
            v-if="orgs.isCurrentOrgAdmin"
            icon="pi pi-pencil"
            text
            size="small"
            severity="secondary"
            aria-label="Rename organization"
            @click="openRename"
          />
          <Button
            v-if="orgs.isCurrentOrgDeletable"
            icon="pi pi-trash"
            text
            size="small"
            severity="secondary"
            class="danger-btn"
            aria-label="Delete organization"
            @click="confirmDelete"
          />
        </div>
        <p v-else-if="orgs.loaded" class="muted">No organizations yet.</p>
        <p v-else class="muted">Loading…</p>
        <Button
          icon="pi pi-plus"
          label="New organization"
          text
          size="small"
          class="new-org-btn"
          @click="openCreate"
        />
      </div>

      <nav class="nav">
        <button
          v-for="item in navItems"
          :key="item.name"
          type="button"
          :class="['nav-btn', { active: isActive(item.name) }]"
          :disabled="!orgs.currentOrgId"
          @click="go(item.name)"
        >
          <i :class="item.icon" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="footer">
        <div class="user">
          <i class="pi pi-user" />
          <span class="user-name">{{ auth.displayName ?? auth.email }}</span>
        </div>
        <Button
          icon="pi pi-sign-out"
          label="Sign out"
          text
          size="small"
          severity="secondary"
          @click="onSignOut"
        />
      </div>
    </aside>

    <main class="content">
      <RouterView />
    </main>

    <Dialog
      v-model:visible="createOpen"
      modal
      header="New organization"
      :style="{ width: '400px' }"
    >
      <div class="form">
        <p class="hint">
          Creates a new team workspace. You'll be the Owner — invite
          others from the Members tab.
        </p>
        <label class="lbl">Name</label>
        <InputText
          v-model="createName"
          autofocus
          placeholder="e.g. Acme Backend"
          @keyup.enter="submitCreate"
        />
        <Message
          v-if="createError"
          severity="error"
          :closable="false"
          class="msg"
        >{{ createError }}</Message>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="createOpen = false" />
        <Button
          label="Create"
          :loading="createBusy"
          :disabled="!createName.trim()"
          @click="submitCreate"
        />
      </template>
    </Dialog>

    <Dialog
      v-model:visible="renameOpen"
      modal
      header="Rename organization"
      :style="{ width: '400px' }"
    >
      <div class="form">
        <label class="lbl">Name</label>
        <InputText
          v-model="renameInput"
          autofocus
          @keyup.enter="submitRename"
        />
        <Message
          v-if="renameError"
          severity="error"
          :closable="false"
          class="msg"
        >{{ renameError }}</Message>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="renameOpen = false" />
        <Button
          label="Save"
          :loading="renameBusy"
          :disabled="!renameInput.trim()"
          @click="submitRename"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100vh;
}
.sidebar {
  background: var(--p-surface-0, white);
  border-right: 1px solid var(--p-surface-border, #e5e7eb);
  padding: 1rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  padding: 0 0.25rem;
}
.logo {
  font-weight: 700;
  font-size: 1.05rem;
}
.badge {
  font-size: 0.65rem;
  padding: 0.05rem 0.4rem;
  background: var(--p-surface-100, #f3f4f6);
  border-radius: 999px;
  color: var(--p-text-muted-color, #6b7280);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.org-switch {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.org-switch-row {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}
.org-switch-row .full {
  flex: 1;
  min-width: 0;
}
.org-switch-row .danger-btn:hover {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
}
.new-org-btn {
  align-self: flex-start;
  padding-left: 0.25rem;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.form .lbl {
  font-size: 0.82rem;
  font-weight: 500;
  margin-top: 0.4rem;
  text-transform: none;
  letter-spacing: 0;
  color: inherit;
  padding: 0;
}
.form .hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #6b7280);
}
.msg { font-size: 0.82rem; margin-top: 0.5rem; }
.lbl {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #6b7280);
  padding: 0 0.25rem;
}
.full { width: 100%; }
.muted {
  margin: 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color, #6b7280);
  padding: 0 0.25rem;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin-top: 0.25rem;
}
.nav-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  font-size: 0.88rem;
  border: none;
  background: transparent;
  border-radius: 5px;
  cursor: pointer;
  color: var(--p-text-color, #111827);
  text-align: left;
}
.nav-btn:hover:not(:disabled) {
  background: var(--p-surface-100, #f3f4f6);
}
.nav-btn:disabled {
  color: var(--p-text-muted-color, #9ca3af);
  cursor: not-allowed;
}
.nav-btn.active {
  background: var(--p-primary-50, #eff6ff);
  color: var(--p-primary-700, #1d4ed8);
  font-weight: 500;
}
.nav-btn i {
  font-size: 0.85rem;
  width: 1rem;
  text-align: center;
}
.footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border-top: 1px solid var(--p-surface-border, #e5e7eb);
  padding-top: 0.6rem;
}
.user {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  padding: 0.25rem;
}
.user-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.content {
  overflow-y: auto;
  padding: 1.5rem 1.75rem;
}
</style>
