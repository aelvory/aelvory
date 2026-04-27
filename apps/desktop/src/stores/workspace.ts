import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { Organization, Project } from '@aelvory/core';
import { api } from '@/api/client';
import { useSyncStore } from '@/stores/sync';

/**
 * Workspace navigation state. Phase 1 of the multi-tenant rework
 * dropped the Team layer — the hierarchy is now Organization → Project.
 *
 * Old API surface (createTeam, currentTeamId, etc.) was retained as
 * a thin compatibility shim for a release window so callers don't all
 * break at once. Today the shims are gone; everything goes
 * straight from org to project.
 *
 * Selection persistence: `currentOrgId` + `currentProjectId` are
 * stored in localStorage so a restart lands the user back where they
 * left off. The persisted ids are validated at bootstrap (and at
 * every dataVersion bump) — if the org/project no longer exists
 * (deleted, user removed from it, server reset), we fall back to
 * the first available rather than showing an empty workspace.
 */
const STORAGE_KEY = 'aelvory.workspace';

interface PersistedWorkspace {
  currentOrgId: string | null;
  currentProjectId: string | null;
}

function loadPersisted(): PersistedWorkspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedWorkspace>;
      return {
        currentOrgId: typeof parsed.currentOrgId === 'string' ? parsed.currentOrgId : null,
        currentProjectId:
          typeof parsed.currentProjectId === 'string' ? parsed.currentProjectId : null,
      };
    }
  } catch {
    /* ignore corrupt localStorage */
  }
  return { currentOrgId: null, currentProjectId: null };
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const initial = loadPersisted();

  const organizations = ref<Organization[]>([]);
  const currentOrgId = ref<string | null>(initial.currentOrgId);
  const projects = ref<Project[]>([]);
  const currentProjectId = ref<string | null>(initial.currentProjectId);

  // Persist on every selection change. The watcher only fires AFTER
  // the initial ref creation, so re-reading what we just loaded is
  // a no-op (no spurious write).
  watch([currentOrgId, currentProjectId], () => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          currentOrgId: currentOrgId.value,
          currentProjectId: currentProjectId.value,
        }),
      );
    } catch {
      /* ignore quota errors etc. — selection persistence is
         a nice-to-have, not load-bearing. */
    }
  });

  const currentOrg = computed(
    () => organizations.value.find((o) => o.id === currentOrgId.value) ?? null,
  );

  const currentProject = computed(
    () => projects.value.find((p) => p.id === currentProjectId.value) ?? null,
  );

  /**
   * Initial workspace setup. Resolves the persisted selection
   * against actual data:
   *   - persisted org id still exists → keep it
   *   - persisted org id is gone (org deleted, user removed,
   *     server reset) → fall back to the first available
   *   - same logic per project, scoped to the resolved org
   * Avoids the "blank workspace because the saved id pointed at
   * something that no longer exists" failure mode.
   */
  async function bootstrap() {
    await loadOrganizations();
    await resolveSelection();
  }

  /**
   * Validate the current org/project ids against the loaded org +
   * project lists, falling back to the first available when stale.
   * Called at bootstrap and after every dataVersion bump (so a
   * server-side delete propagating in via SyncEntries doesn't leave
   * the UI pointing at a ghost).
   *
   * Mutates `currentOrgId` / `currentProjectId` only when the
   * resolved value differs from the current — cuts down on
   * unnecessary watch fires (and the resulting localStorage writes).
   */
  async function resolveSelection() {
    let nextOrgId = currentOrgId.value;
    if (nextOrgId && !organizations.value.some((o) => o.id === nextOrgId)) {
      nextOrgId = null;
    }
    if (!nextOrgId && organizations.value.length) {
      nextOrgId = organizations.value[0].id;
    }
    if (nextOrgId !== currentOrgId.value) {
      currentOrgId.value = nextOrgId;
      // Project selection always refers to the current org, so
      // clear it when the org changes — the next branch picks a
      // sensible default after loadProjects.
      currentProjectId.value = null;
    }
    if (!currentOrgId.value) {
      if (projects.value.length > 0) projects.value = [];
      return;
    }
    await loadProjects();

    let nextProjectId = currentProjectId.value;
    if (nextProjectId && !projects.value.some((p) => p.id === nextProjectId)) {
      nextProjectId = null;
    }
    if (!nextProjectId && projects.value.length) {
      nextProjectId = projects.value[0].id;
    }
    if (nextProjectId !== currentProjectId.value) {
      currentProjectId.value = nextProjectId;
    }
  }

  // Auto-refresh on cross-device sync. When the sync engine writes new
  // orgs/projects/etc. into local SQLite (manual sync, debounced
  // post-write, or — most importantly — a SignalR-driven realtime
  // pull triggered by another device's push), the in-memory list here
  // would otherwise stay stale until the next page reload. Watching
  // `sync.dataVersion` and re-fetching keeps the UI live without
  // paying the cost of a full reload (lost focus, lost tab state).
  //
  // Set up at store creation (not inside `bootstrap`) so the watcher
  // is wired regardless of whether the user signs in on app start or
  // later — bootstrap only runs once.
  //
  // Re-runs the same validate-then-fallback logic so a server-side
  // org/project deletion arriving via SyncEntry tombstone unsticks
  // a stale selection.
  const sync = useSyncStore();
  watch(
    () => sync.dataVersion,
    async () => {
      await loadOrganizations();
      await resolveSelection();
    },
  );

  /**
   * Load orgs from local SQLite. Only mutates the reactive ref if
   * the new data actually differs from the current — Vue's
   * reactivity is reference-based, so blindly replacing with a
   * fresh-but-identical array would re-trigger every watcher and
   * every component binding to <c>organizations</c>, causing a
   * full re-render of the workspace tree even when nothing
   * changed. The dataVersion-driven auto-refresh fires on every
   * sync run; without this guard the UI flickers visibly even on
   * steady-state syncs (no real data delta on the wire).
   *
   * JSON-stringify diff is fine here — order is stable
   * (handlers.ts uses ORDER BY) and the data is small (tens of
   * rows typical, sub-ms to serialize).
   */
  async function loadOrganizations() {
    const next = await api<Organization[]>('/api/organizations');
    if (JSON.stringify(next) !== JSON.stringify(organizations.value)) {
      organizations.value = next;
    }
  }

  async function loadProjects() {
    if (!currentOrgId.value) {
      if (projects.value.length > 0) projects.value = [];
      return;
    }
    const next = await api<Project[]>(
      `/api/organizations/${currentOrgId.value}/projects`,
    );
    if (JSON.stringify(next) !== JSON.stringify(projects.value)) {
      projects.value = next;
    }
  }

  async function selectOrganization(id: string) {
    currentOrgId.value = id;
    currentProjectId.value = null;
    await loadProjects();
    if (projects.value.length) {
      selectProject(projects.value[0].id);
    }
  }

  function selectProject(id: string) {
    currentProjectId.value = id;
  }

  async function createProject(name: string) {
    if (!currentOrgId.value) throw new Error('no_org');
    const project = await api<Project>(
      `/api/organizations/${currentOrgId.value}/projects`,
      { method: 'POST', body: { name, description: null } },
    );
    projects.value.push(project);
    return project;
  }

  async function renameProject(id: string, name: string): Promise<Project> {
    if (!currentOrgId.value) throw new Error('no_org');
    const updated = await api<Project>(
      `/api/organizations/${currentOrgId.value}/projects/${id}`,
      { method: 'PUT', body: { name, description: null } },
    );
    const idx = projects.value.findIndex((p) => p.id === id);
    if (idx !== -1) projects.value[idx] = updated;
    return updated;
  }

  async function deleteProject(id: string) {
    if (!currentOrgId.value) throw new Error('no_org');
    await api(
      `/api/organizations/${currentOrgId.value}/projects/${id}`,
      { method: 'DELETE' },
    );
    projects.value = projects.value.filter((p) => p.id !== id);
    if (currentProjectId.value === id) {
      currentProjectId.value = null;
      if (projects.value.length) {
        selectProject(projects.value[0].id);
      }
    }
  }

  return {
    organizations,
    currentOrgId,
    projects,
    currentProjectId,
    currentOrg,
    currentProject,
    bootstrap,
    loadOrganizations,
    loadProjects,
    selectOrganization,
    selectProject,
    createProject,
    renameProject,
    deleteProject,
  };
});
