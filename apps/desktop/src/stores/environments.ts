import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { ApiEnvironment, Variable } from '@aelvory/core';
import { api } from '@/api/client';
import { useSyncStore } from '@/stores/sync';

export const useEnvironmentsStore = defineStore('environments', () => {
  const environments = ref<ApiEnvironment[]>([]);
  const activeEnvId = ref<string | null>(null);
  const variablesByEnv = ref<Record<string, Variable[]>>({});
  const currentProjectId = ref<string | null>(null);

  // Re-fetch on cross-device sync. See collections.ts for the full
  // rationale — same idea: SignalR-driven pulls write to local SQLite,
  // we re-read so the UI shows the new envs/vars without a reload.
  const sync = useSyncStore();
  watch(
    () => sync.dataVersion,
    async () => {
      if (!currentProjectId.value) return;
      const prevActive = activeEnvId.value;
      await loadForProject(currentProjectId.value);
      // Preserve the user's selected env across the refresh if it
      // still exists; loadForProject defaults to the first one.
      if (prevActive && environments.value.some((e) => e.id === prevActive)) {
        activeEnvId.value = prevActive;
        if (!variablesByEnv.value[prevActive]) await loadVariables(prevActive);
      }
    },
  );

  const activeEnv = computed(
    () => environments.value.find((e) => e.id === activeEnvId.value) ?? null,
  );

  const activeVariables = computed<Record<string, string>>(() => {
    if (!activeEnvId.value) return {};
    const vars = variablesByEnv.value[activeEnvId.value] ?? [];
    const out: Record<string, string> = {};
    for (const v of vars) {
      // Until E2EE is wired up, a "secret" var is just a UI-masked plaintext
      // value — it still resolves. When real ciphertext arrives, callers will
      // need to decrypt before populating this context.
      if (v.value !== null) out[v.key] = v.value;
    }
    return out;
  });

  async function loadForProject(projectId: string) {
    currentProjectId.value = projectId;
    const next = await api<ApiEnvironment[]>(
      `/api/projects/${projectId}/environments`,
    );
    // Content-equality guard — see workspace.ts / collections.ts
    // for the full rationale. Without this, every dataVersion bump
    // (SignalR push, focus sync, post-write debounce) replaces the
    // ref with an identical-content array and re-renders every
    // env-bound component.
    if (JSON.stringify(next) !== JSON.stringify(environments.value)) {
      environments.value = next;
    }
    if (!activeEnvId.value) {
      activeEnvId.value = environments.value[0]?.id ?? null;
    }
    if (activeEnvId.value) await loadVariables(activeEnvId.value);
  }

  async function loadVariables(envId: string) {
    if (!currentProjectId.value) return;
    const vars = await api<Variable[]>(
      `/api/projects/${currentProjectId.value}/environments/${envId}/variables`,
    );
    const existing = variablesByEnv.value[envId];
    if (JSON.stringify(existing) === JSON.stringify(vars)) return;
    variablesByEnv.value = { ...variablesByEnv.value, [envId]: vars };
  }

  async function setActiveEnvironment(id: string | null) {
    activeEnvId.value = id;
    if (id && !variablesByEnv.value[id]) await loadVariables(id);
  }

  async function createEnvironment(name: string): Promise<ApiEnvironment> {
    if (!currentProjectId.value) throw new Error('no_project');
    const env = await api<ApiEnvironment>(
      `/api/projects/${currentProjectId.value}/environments`,
      { method: 'POST', body: { name } },
    );
    environments.value.push(env);
    variablesByEnv.value[env.id] = [];
    if (!activeEnvId.value) activeEnvId.value = env.id;
    return env;
  }

  async function updateEnvironment(id: string, name: string): Promise<ApiEnvironment> {
    if (!currentProjectId.value) throw new Error('no_project');
    const env = await api<ApiEnvironment>(
      `/api/projects/${currentProjectId.value}/environments/${id}`,
      { method: 'PUT', body: { name } },
    );
    const idx = environments.value.findIndex((e) => e.id === id);
    if (idx !== -1) environments.value[idx] = env;
    return env;
  }

  async function deleteEnvironment(id: string): Promise<void> {
    if (!currentProjectId.value) throw new Error('no_project');
    await api(
      `/api/projects/${currentProjectId.value}/environments/${id}`,
      { method: 'DELETE' },
    );
    environments.value = environments.value.filter((e) => e.id !== id);
    const next = { ...variablesByEnv.value };
    delete next[id];
    variablesByEnv.value = next;
    if (activeEnvId.value === id) {
      activeEnvId.value = environments.value[0]?.id ?? null;
    }
  }

  async function upsertVariable(
    envId: string,
    key: string,
    value: string | null,
    isSecret: boolean,
  ): Promise<Variable> {
    if (!currentProjectId.value) throw new Error('no_project');
    const v = await api<Variable>(
      `/api/projects/${currentProjectId.value}/environments/${envId}/variables`,
      {
        method: 'POST',
        body: { key, value, isSecret, ciphertext: null, nonce: null, keyId: null },
      },
    );
    const list = [...(variablesByEnv.value[envId] ?? [])];
    const idx = list.findIndex((x) => x.key === key);
    if (idx === -1) list.push(v);
    else list[idx] = v;
    variablesByEnv.value = { ...variablesByEnv.value, [envId]: list };
    return v;
  }

  /**
   * Duplicate an environment, copying every variable (including
   * secrets) into a new env with the picked name. Convenient when
   * cloning dev → staging or per-customer config sets.
   *
   * Variables are recreated via upsertVariable so their reactive
   * cache stays consistent and any server-side validation runs again
   * (the server may decide to wrap secrets differently per env).
   *
   * Pulls source variables fresh from the server before copying — if
   * we cloned from the local cache, partially-loaded envs would
   * silently lose values. Slightly more network but worth it.
   */
  async function cloneEnvironment(srcId: string, newName: string): Promise<ApiEnvironment> {
    if (!currentProjectId.value) throw new Error('no_project');
    const src = environments.value.find((e) => e.id === srcId);
    if (!src) throw new Error('source_env_not_found');

    // Always fetch — local cache might be empty for an env the user
    // never opened in the EnvironmentsDialog.
    const srcVars = await api<Variable[]>(
      `/api/projects/${currentProjectId.value}/environments/${srcId}/variables`,
    );

    const dst = await createEnvironment(newName);

    for (const v of srcVars) {
      // Skip empty rows — createEnvironment yields an empty list and
      // we want the clone to mirror the source's content, not pad
      // it with `{ key: '', value: '' }` placeholders.
      if (!v.key) continue;
      await upsertVariable(dst.id, v.key, v.value ?? null, v.isSecret);
    }
    return dst;
  }

  async function deleteVariable(envId: string, variableId: string): Promise<void> {
    if (!currentProjectId.value) throw new Error('no_project');
    await api(
      `/api/projects/${currentProjectId.value}/environments/${envId}/variables/${variableId}`,
      { method: 'DELETE' },
    );
    const list = variablesByEnv.value[envId] ?? [];
    variablesByEnv.value = {
      ...variablesByEnv.value,
      [envId]: list.filter((x) => x.id !== variableId),
    };
  }

  function reset() {
    environments.value = [];
    activeEnvId.value = null;
    variablesByEnv.value = {};
    currentProjectId.value = null;
  }

  return {
    environments,
    activeEnvId,
    activeEnv,
    variablesByEnv,
    activeVariables,
    loadForProject,
    loadVariables,
    setActiveEnvironment,
    createEnvironment,
    cloneEnvironment,
    updateEnvironment,
    deleteEnvironment,
    upsertVariable,
    deleteVariable,
    reset,
  };
});
