import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type {
  Collection,
  ApiRequest,
  RequestKind,
  AuthConfig,
  Header,
  RequestBody,
  Variable,
  Script,
  ScriptPhase,
} from '@aelvory/core';
import { api } from '@/api/client';
import { useSyncStore } from '@/stores/sync';

export interface CreateRequestPayload {
  name: string;
  kind?: RequestKind;
  method?: string;
  url?: string;
  headers?: Header[];
  body?: RequestBody | null;
  auth?: AuthConfig | null;
}

export const useCollectionsStore = defineStore('collections', () => {
  const collections = ref<Collection[]>([]);
  const requestsByCollection = ref<Record<string, ApiRequest[]>>({});
  const variablesByCollection = ref<Record<string, Variable[]>>({});
  const currentProjectId = ref<string | null>(null);
  const loading = ref(false);

  // Re-fetch the current project's tree whenever sync writes new data
  // into local SQLite (manual sync, debounced post-write, or — most
  // importantly — a SignalR-driven realtime pull triggered by another
  // device's push). Watch is set up once at store init; the no-op
  // path covers "sync bumped but we have no project loaded yet."
  const sync = useSyncStore();
  watch(
    () => sync.dataVersion,
    () => {
      if (currentProjectId.value) {
        void loadForProject(currentProjectId.value);
      }
    },
  );

  async function loadForProject(projectId: string) {
    loading.value = true;
    currentProjectId.value = projectId;
    try {
      const nextCollections = await api<Collection[]>(
        `/api/projects/${projectId}/collections`,
      );
      const reqs: Record<string, ApiRequest[]> = {};
      const vars: Record<string, Variable[]> = {};
      await Promise.all(
        nextCollections.map(async (c) => {
          const [rList, vList] = await Promise.all([
            api<ApiRequest[]>(`/api/collections/${c.id}/requests`),
            api<Variable[]>(`/api/projects/${projectId}/collections/${c.id}/variables`),
          ]);
          reqs[c.id] = rList;
          vars[c.id] = vList;
        }),
      );

      // Content-equality guard for each ref. This loader runs on
      // every sync.dataVersion bump (so SignalR-pushed changes
      // appear in the tree without a reload), which means it fires
      // a LOT — every push echo, every focus-driven sync, every
      // realtime Changed broadcast. Replacing the refs with fresh
      // arrays even when content is identical re-triggers every
      // bound component and every keyed v-for, causing the visible
      // "flicker" on the editing device. Stringify-compare is
      // robust because the local SQLite handlers use ORDER BY,
      // so identical content serializes identically. The cost is
      // a few KB of string allocation per sync — well under a ms
      // for typical workspaces, and zero re-render work if the
      // data really hasn't changed.
      if (JSON.stringify(nextCollections) !== JSON.stringify(collections.value)) {
        collections.value = nextCollections;
      }
      if (JSON.stringify(reqs) !== JSON.stringify(requestsByCollection.value)) {
        requestsByCollection.value = reqs;
      }
      if (JSON.stringify(vars) !== JSON.stringify(variablesByCollection.value)) {
        variablesByCollection.value = vars;
      }
    } finally {
      loading.value = false;
    }
  }

  function requestsFor(collectionId: string): ApiRequest[] {
    return requestsByCollection.value[collectionId] ?? [];
  }

  function variablesFor(collectionId: string): Variable[] {
    return variablesByCollection.value[collectionId] ?? [];
  }

  function findById(id: string): Collection | null {
    return collections.value.find((c) => c.id === id) ?? null;
  }

  function ancestorChain(collectionId: string): Collection[] {
    const byId = new Map(collections.value.map((c) => [c.id, c]));
    const chain: Collection[] = [];
    let current = byId.get(collectionId);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain;
  }

  async function createCollection(
    projectId: string,
    name: string,
    parentId: string | null = null,
  ) {
    const collection = await api<Collection>(
      `/api/projects/${projectId}/collections`,
      {
        method: 'POST',
        body: {
          name,
          parentId,
          sortIndex: collections.value.filter((c) => c.parentId === parentId).length,
          auth: null,
        },
      },
    );
    collections.value.push(collection);
    requestsByCollection.value[collection.id] = [];
    variablesByCollection.value[collection.id] = [];
    return collection;
  }

  async function updateCollection(
    projectId: string,
    collection: Collection,
  ): Promise<Collection> {
    const updated = await api<Collection>(
      `/api/projects/${projectId}/collections/${collection.id}`,
      {
        method: 'PUT',
        body: { name: collection.name, auth: collection.auth ?? null },
      },
    );
    const idx = collections.value.findIndex((c) => c.id === updated.id);
    if (idx !== -1) collections.value[idx] = updated;
    return updated;
  }

  async function moveCollection(
    id: string,
    newParentId: string | null,
    newSortIndex: number,
  ) {
    if (!currentProjectId.value) throw new Error('no_project');
    await api(
      `/api/projects/${currentProjectId.value}/collections/${id}/move`,
      { method: 'POST', body: { newParentId, newSortIndex } },
    );
    // Backend rebalances siblings — pull fresh state rather than try to mirror it
    await loadForProject(currentProjectId.value);
  }

  async function moveRequest(
    request: ApiRequest,
    newCollectionId: string,
    newSortIndex: number,
  ) {
    if (!currentProjectId.value) throw new Error('no_project');
    await api(
      `/api/collections/${request.collectionId}/requests/${request.id}/move`,
      { method: 'POST', body: { newCollectionId, newSortIndex } },
    );
    await loadForProject(currentProjectId.value);
  }

  async function deleteCollection(projectId: string, collectionId: string) {
    await api(
      `/api/projects/${projectId}/collections/${collectionId}`,
      { method: 'DELETE' },
    );
    const toRemove = new Set<string>([collectionId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of collections.value) {
        if (c.parentId && toRemove.has(c.parentId) && !toRemove.has(c.id)) {
          toRemove.add(c.id);
          grew = true;
        }
      }
    }
    collections.value = collections.value.filter((c) => !toRemove.has(c.id));
    for (const id of toRemove) {
      delete requestsByCollection.value[id];
      delete variablesByCollection.value[id];
    }
  }

  async function upsertCollectionVariable(
    collectionId: string,
    key: string,
    value: string | null,
    isSecret: boolean,
  ): Promise<Variable> {
    if (!currentProjectId.value) throw new Error('no_project');
    const v = await api<Variable>(
      `/api/projects/${currentProjectId.value}/collections/${collectionId}/variables`,
      {
        method: 'POST',
        body: { key, value, isSecret, ciphertext: null, nonce: null, keyId: null },
      },
    );
    const list = [...(variablesByCollection.value[collectionId] ?? [])];
    const idx = list.findIndex((x) => x.key === key);
    if (idx === -1) list.push(v);
    else list[idx] = v;
    variablesByCollection.value = {
      ...variablesByCollection.value,
      [collectionId]: list,
    };
    return v;
  }

  async function deleteCollectionVariable(
    collectionId: string,
    variableId: string,
  ): Promise<void> {
    if (!currentProjectId.value) throw new Error('no_project');
    await api(
      `/api/projects/${currentProjectId.value}/collections/${collectionId}/variables/${variableId}`,
      { method: 'DELETE' },
    );
    const list = variablesByCollection.value[collectionId] ?? [];
    variablesByCollection.value = {
      ...variablesByCollection.value,
      [collectionId]: list.filter((x) => x.id !== variableId),
    };
  }

  async function createRequest(
    collectionId: string,
    payload: CreateRequestPayload,
  ): Promise<ApiRequest> {
    const request = await api<ApiRequest>(
      `/api/collections/${collectionId}/requests`,
      {
        method: 'POST',
        body: {
          name: payload.name,
          kind: payload.kind ?? 'http',
          method: payload.method ?? 'GET',
          url: payload.url ?? 'https://httpbin.org/get',
          headers: payload.headers ?? [],
          body: payload.body ?? null,
          auth: payload.auth ?? null,
        },
      },
    );
    const list = requestsByCollection.value[collectionId] ?? [];
    list.push(request);
    requestsByCollection.value = {
      ...requestsByCollection.value,
      [collectionId]: list,
    };
    return request;
  }

  async function updateRequest(request: ApiRequest): Promise<ApiRequest> {
    const updated = await api<ApiRequest>(
      `/api/collections/${request.collectionId}/requests/${request.id}`,
      {
        method: 'PUT',
        body: {
          name: request.name,
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body,
          auth: request.auth,
        },
      },
    );
    const list = requestsByCollection.value[request.collectionId] ?? [];
    const idx = list.findIndex((r) => r.id === request.id);
    if (idx !== -1) list[idx] = updated;
    return updated;
  }

  async function deleteRequest(request: ApiRequest) {
    await api(
      `/api/collections/${request.collectionId}/requests/${request.id}`,
      { method: 'DELETE' },
    );
    const list = requestsByCollection.value[request.collectionId] ?? [];
    requestsByCollection.value = {
      ...requestsByCollection.value,
      [request.collectionId]: list.filter((r) => r.id !== request.id),
    };
  }

  async function loadScripts(
    collectionId: string,
    requestId: string,
  ): Promise<Script[]> {
    return await api<Script[]>(
      `/api/collections/${collectionId}/requests/${requestId}/scripts`,
    );
  }

  async function saveScript(
    collectionId: string,
    requestId: string,
    phase: ScriptPhase,
    source: string,
  ): Promise<Script> {
    return await api<Script>(
      `/api/collections/${collectionId}/requests/${requestId}/scripts`,
      {
        method: 'PUT',
        body: { phase, source },
      },
    );
  }

  function reset() {
    collections.value = [];
    requestsByCollection.value = {};
    variablesByCollection.value = {};
    currentProjectId.value = null;
  }

  return {
    collections,
    requestsByCollection,
    variablesByCollection,
    currentProjectId,
    loading,
    loadForProject,
    requestsFor,
    variablesFor,
    findById,
    ancestorChain,
    createCollection,
    updateCollection,
    moveCollection,
    moveRequest,
    deleteCollection,
    upsertCollectionVariable,
    deleteCollectionVariable,
    createRequest,
    updateRequest,
    deleteRequest,
    loadScripts,
    saveScript,
    reset,
  };
});
