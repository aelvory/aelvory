import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

/**
 * Mirror of the server's Organization shape — kept inline rather than
 * imported from `@aelvory/core` so the web SPA doesn't accidentally
 * reach into desktop-specific code paths. Matches OrganizationDto on
 * the server.
 */
export interface OrgSummary {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  ownerId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const CURRENT_ORG_KEY = 'aelvory.web.currentOrg';

/**
 * Slim view of the caller's membership in the current org. Used by
 * the sidebar to gate the Rename / Delete buttons. Only the role +
 * restricted flag are needed here — full <c>MemberDto</c> would drag
 * in email/displayName for every other member, none of which the
 * sidebar uses.
 */
interface MyMember {
  role: 'owner' | 'admin' | 'editor';
  restricted: boolean;
}

interface MemberRow {
  id: string;
  userId: string;
  role: 'owner' | 'admin' | 'editor';
  restricted: boolean;
}

export const useOrgsStore = defineStore('orgs', () => {
  const orgs = ref<OrgSummary[]>([]);
  const currentOrgId = ref<string | null>(localStorage.getItem(CURRENT_ORG_KEY));
  const loading = ref(false);
  const loaded = ref(false);

  /**
   * The caller's own membership in the currently-selected org. Refreshed
   * on every <see cref="currentOrgId"/> change so role-gated UI in the
   * sidebar (Rename / Delete buttons) reflects the org you're actually
   * looking at, not the one you signed in to.
   */
  const currentMyMember = ref<MyMember | null>(null);

  const currentOrg = computed(
    () => orgs.value.find((o) => o.id === currentOrgId.value) ?? null,
  );

  /** True when the caller is an Owner or Admin of the current org. */
  const isCurrentOrgAdmin = computed(
    () =>
      currentMyMember.value?.role === 'owner' ||
      currentMyMember.value?.role === 'admin',
  );

  /**
   * True when the caller can DELETE the current org. Server enforces:
   * must be Owner AND the org must be Kind=Team (Personal orgs are
   * undeletable by design — they're auto-created at register and tied
   * to the user's identity). UI mirrors that to avoid showing a
   * button that would 404 on click.
   */
  const isCurrentOrgDeletable = computed(
    () =>
      currentMyMember.value?.role === 'owner' &&
      currentOrg.value?.kind === 'team',
  );

  async function load(): Promise<void> {
    loading.value = true;
    try {
      orgs.value = await api<OrgSummary[]>('/api/organizations');
      loaded.value = true;

      // Stale current-org id (e.g. user removed from org) — pick first
      // available. Otherwise leave selection alone.
      if (currentOrgId.value && !orgs.value.some((o) => o.id === currentOrgId.value)) {
        currentOrgId.value = null;
      }
      if (!currentOrgId.value && orgs.value.length > 0) {
        setCurrent(orgs.value[0].id);
      }
    } finally {
      loading.value = false;
    }
  }

  function setCurrent(id: string | null): void {
    currentOrgId.value = id;
    if (id) localStorage.setItem(CURRENT_ORG_KEY, id);
    else localStorage.removeItem(CURRENT_ORG_KEY);
  }

  /**
   * Refresh <see cref="currentMyMember"/> by hitting the org's member
   * list and finding the caller's row. Cheap (a single API call) and
   * runs once per org switch, not per render.
   */
  async function refreshCurrentMyMember(): Promise<void> {
    const id = currentOrgId.value;
    if (!id) {
      currentMyMember.value = null;
      return;
    }
    try {
      const auth = useAuthStore();
      const members = await api<MemberRow[]>(`/api/organizations/${id}/members`);
      const me = members.find((m) => m.userId === auth.userId);
      currentMyMember.value = me
        ? { role: me.role, restricted: me.restricted }
        : null;
    } catch {
      // 403/404 → user lost access to this org. Clear the role so
      // the gated buttons hide; the OrgMembers page itself has its
      // own 403→/ bounce so the user lands somewhere usable.
      currentMyMember.value = null;
    }
  }

  watch(currentOrgId, () => void refreshCurrentMyMember(), { immediate: true });

  /**
   * Create a new Team-kind organization. The current user becomes
   * Owner server-side; we set it as the active org so the immediate
   * navigation lands in the new workspace.
   */
  async function createOrg(name: string): Promise<OrgSummary> {
    const created = await api<OrgSummary>('/api/organizations', {
      method: 'POST',
      body: { name },
    });
    orgs.value = [...orgs.value, created];
    setCurrent(created.id);
    return created;
  }

  async function updateOrg(id: string, name: string): Promise<OrgSummary> {
    const updated = await api<OrgSummary>(`/api/organizations/${id}`, {
      method: 'PUT',
      body: { name },
    });
    const idx = orgs.value.findIndex((o) => o.id === id);
    if (idx >= 0) orgs.value[idx] = updated;
    return updated;
  }

  /**
   * Soft-delete on the server (sets DeletedAt). We mirror that locally
   * by dropping the row from the list — the user effectively won't see
   * it anymore. If they were viewing it, fall back to the first
   * remaining org so the layout doesn't end up pointing at nothing.
   */
  async function deleteOrg(id: string): Promise<void> {
    await api(`/api/organizations/${id}`, { method: 'DELETE' });
    orgs.value = orgs.value.filter((o) => o.id !== id);
    if (currentOrgId.value === id) {
      setCurrent(orgs.value[0]?.id ?? null);
    }
  }

  return {
    orgs,
    currentOrgId,
    currentOrg,
    currentMyMember,
    isCurrentOrgAdmin,
    isCurrentOrgDeletable,
    loading,
    loaded,
    load,
    setCurrent,
    refreshCurrentMyMember,
    createOrg,
    updateOrg,
    deleteOrg,
  };
});
