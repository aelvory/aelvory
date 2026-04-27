import { defineStore } from 'pinia';
import { ref, computed, markRaw } from 'vue';
import type { ApiRequest, Collection, ExecuteResponse } from '@aelvory/core';
import type { TestResult } from '@/services/scriptRunner';
import { webSocketRuntime } from '@/services/websocket';

export interface RequestTab {
  kind: 'request';
  id: string;
  request: ApiRequest;
  dirty: boolean;
  running: boolean;
  response: ExecuteResponse | null;
  lastRunAt: number | null;
  preScript: string;
  postScript: string;
  scriptsLoaded: boolean;
  scriptsDirty: boolean;
  testResults: TestResult[];
  scriptLogs: string[];
  scriptError: string | null;
  pinned: boolean;
}

export interface CollectionTab {
  kind: 'collection';
  id: string;
  collection: Collection;
  dirty: boolean;
  pinned: boolean;
}

export interface CurlTab {
  kind: 'curl';
  id: string;
  title: string;
  command: string;
  running: boolean;
  response: ExecuteResponse | null;
  parseError: string | null;
  dirty: boolean;
  lastRunAt: number | null;
  pinned: boolean;
}

/**
 * Direction of a WebSocket message in the log:
 *   - 'sent'     — composed by the user, transmitted to the server
 *   - 'received' — pushed from the server
 *   - 'system'   — local lifecycle event (connecting, disconnected,
 *                  error, server-close-with-code) so the user can
 *                  read connection state inline with traffic
 */
export type WsMessageDirection = 'sent' | 'received' | 'system';

export interface WsMessage {
  /** Auto-incrementing local id for v-for keys. */
  id: number;
  /** Wall-clock timestamp at the moment the event was observed. */
  ts: number;
  direction: WsMessageDirection;
  /** Always a string. Binary frames are surfaced as length placeholders. */
  data: string;
  /**
   * Pretty-printed JSON form, falling back to `data` for non-JSON.
   * Pre-computed at append time so the renderer never re-stringifies
   * on every paint — without this, an expanded burst of 500 messages
   * runs 500 JSON.parse + JSON.stringify pairs per frame.
   */
  pretty: string;
  /**
   * One-line summary used in the collapsed-row view. Pre-computed
   * for the same reason — burst traffic with auto-scroll otherwise
   * runs the regex+slice on every visible row per frame.
   */
  preview: string;
}

/**
 * WebSocket tab — runtime mirror of an ApiRequest with kind === 'ws'.
 * The actual WebSocket instance does NOT live here; see
 * `services/websocket.ts` for why. We keep only the user-visible
 * pieces (status, message log, composer) so Pinia's reactivity
 * stays clean.
 */
export interface WebSocketTab {
  kind: 'websocket';
  id: string;
  request: ApiRequest;
  dirty: boolean;
  /** Mirror of webSocketRuntime.status(id). Pushed in via callbacks. */
  status: 'disconnected' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';
  /** Last error string surfaced from the runtime. Cleared on reconnect. */
  lastError: string | null;
  /** Bidirectional message log. Capped at 500 entries; oldest dropped. */
  messages: WsMessage[];
  /** Live text in the send composer. Persists across send-and-clear. */
  composer: string;
  /**
   * `text` keeps the composer body verbatim; `json` pretty-prints
   * outgoing messages and parses incoming JSON for nicer rendering.
   */
  composerFormat: 'text' | 'json';
  /** Last accepted-for-send timestamp; used to throttle the send button if needed. */
  lastSentAt: number | null;
  pinned: boolean;
}

export type Tab = RequestTab | CollectionTab | CurlTab | WebSocketTab;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `curl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Persisted shape of a pinned tab (the only kind of tab that lives
 * past app restart). We store just enough to re-open the same thing
 * after the relevant collections have loaded — nothing transient
 * (no responses, message logs, dirty flags, etc).
 *
 * Curl tabs carry their command verbatim. Request / WebSocket /
 * Collection tabs only need the entity id; the actual data is
 * fetched from the server-synced collection on restore.
 */
interface PersistedPinnedTab {
  kind: 'request' | 'websocket' | 'collection' | 'curl';
  id: string;
  /** Curl-only — the command to seed the new tab with. */
  command?: string;
  /**
   * Project this tab belongs to. We only restore tabs whose project
   * is currently loaded, so opening project A doesn't suddenly try
   * to look up project B's collection ids and fail. Curl tabs have
   * no project association — `null`.
   */
  projectId: string | null;
}

const PIN_STORAGE_KEY = 'aelvory.pinnedTabs.v1';

function readPersistedPinned(): PersistedPinnedTab[] {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PersistedPinnedTab =>
        x &&
        typeof x === 'object' &&
        typeof x.id === 'string' &&
        ['request', 'websocket', 'collection', 'curl'].includes(x.kind),
    );
  } catch {
    return [];
  }
}

function writePersistedPinned(list: PersistedPinnedTab[]): void {
  try {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* localStorage full / disabled — pinning is best-effort */
  }
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([]);
  const activeId = ref<string | null>(null);

  const active = computed(
    () => tabs.value.find((t) => t.id === activeId.value) ?? null,
  );

  function openRequest(request: ApiRequest): RequestTab | WebSocketTab {
    // Dispatch by request.kind. WebSocket requests open a different
    // tab type with a different runtime model — sticking to RequestTab
    // would leave the editor unable to wire up the connection
    // lifecycle. The route-by-kind happens here (single source of
    // truth) so callers (CollectionTree, menu, openers) don't all
    // need to remember the dispatch logic.
    if (request.kind === 'ws') {
      return openWebSocket(request);
    }
    const existing = tabs.value.find((t) => t.id === request.id);
    if (existing && existing.kind === 'request') {
      activeId.value = existing.id;
      return existing;
    }
    const tab: RequestTab = {
      kind: 'request',
      id: request.id,
      request: clone(request),
      dirty: false,
      running: false,
      response: null,
      lastRunAt: null,
      preScript: '',
      postScript: '',
      scriptsLoaded: false,
      scriptsDirty: false,
      testResults: [],
      scriptLogs: [],
      scriptError: null,
      pinned: false,
    };
    tabs.value.push(tab);
    activeId.value = tab.id;
    return tab;
  }

  function openWebSocket(request: ApiRequest): WebSocketTab {
    const existing = tabs.value.find((t) => t.id === request.id);
    if (existing && existing.kind === 'websocket') {
      activeId.value = existing.id;
      return existing;
    }
    const tab: WebSocketTab = {
      kind: 'websocket',
      id: request.id,
      request: clone(request),
      dirty: false,
      status: 'disconnected',
      lastError: null,
      messages: [],
      composer: '',
      composerFormat: 'text',
      lastSentAt: null,
      pinned: false,
    };
    tabs.value.push(tab);
    activeId.value = tab.id;
    return tab;
  }

  /**
   * Mutate the WS tab's status. Called from the runtime's open /
   * close / error callbacks. Lives in the store so the reactive
   * update bubbles into the UI through the usual Pinia path.
   */
  function setWsStatus(id: string, status: WebSocketTab['status'], lastError: string | null = null) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.kind !== 'websocket') return;
    tab.status = status;
    if (lastError !== null) tab.lastError = lastError;
  }

  /** Counter so v-for keys are stable and unique even on rapid bursts. */
  let wsMessageSeq = 0;

  const MAX_WS_MESSAGES = 500;

  /**
   * Build a fully-decorated WsMessage. Pretty / preview are computed
   * once here and cached on the object — together with `markRaw`
   * below, this means Vue doesn't proxy each entry and the renderer
   * never re-formats during scroll/expand.
   */
  function makeWsMessage(direction: WsMessageDirection, data: string): WsMessage {
    wsMessageSeq++;
    let pretty = data;
    if ((direction === 'received' || direction === 'sent') && data) {
      try {
        pretty = JSON.stringify(JSON.parse(data), null, 2);
      } catch {
        /* not JSON — keep raw */
      }
    }
    const flat = data.replace(/\s+/g, ' ').trim();
    const preview = flat.length <= 120 ? flat : flat.slice(0, 117) + '…';
    // markRaw: messages are immutable after creation, so we don't
    // want Vue to deep-proxy them. Saves ~3-5x reactivity overhead
    // per push at burst rates.
    return markRaw({
      id: wsMessageSeq,
      ts: Date.now(),
      direction,
      data,
      pretty,
      preview,
    });
  }

  function appendWsMessage(
    id: string,
    direction: WsMessageDirection,
    data: string,
  ) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.kind !== 'websocket') return;
    tab.messages.push(makeWsMessage(direction, data));
    // Cap the log so a chatty server doesn't hold the whole frontend
    // hostage. 500 lines is well over what's useful for debugging
    // and keeps the message-list virtual cost negligible.
    if (tab.messages.length > MAX_WS_MESSAGES) {
      tab.messages.splice(0, tab.messages.length - MAX_WS_MESSAGES);
    }
  }

  /**
   * Batched variant for high-volume traffic. The caller (typically
   * the WebSocket editor's onMessage handler, which buffers per-rAF)
   * gives us an array of frames in one call; we do ONE push and ONE
   * splice, instead of one of each per frame. With a 1000-frame burst,
   * the difference is ~1000x fewer reactivity triggers and renders.
   */
  function appendWsMessages(
    id: string,
    direction: WsMessageDirection,
    dataList: string[],
  ) {
    if (dataList.length === 0) return;
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.kind !== 'websocket') return;
    const built = dataList.map((d) => makeWsMessage(direction, d));
    tab.messages.push(...built);
    if (tab.messages.length > MAX_WS_MESSAGES) {
      tab.messages.splice(0, tab.messages.length - MAX_WS_MESSAGES);
    }
  }

  function clearWsMessages(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.kind !== 'websocket') return;
    tab.messages = [];
  }

  function openCollection(collection: Collection): CollectionTab {
    const existing = tabs.value.find((t) => t.id === collection.id);
    if (existing && existing.kind === 'collection') {
      activeId.value = existing.id;
      return existing;
    }
    const tab: CollectionTab = {
      kind: 'collection',
      id: collection.id,
      collection: clone(collection),
      dirty: false,
      pinned: false,
    };
    tabs.value.push(tab);
    activeId.value = tab.id;
    return tab;
  }

  function openCurl(command = ''): CurlTab {
    const existingCount = tabs.value.filter((t) => t.kind === 'curl').length;
    const tab: CurlTab = {
      kind: 'curl',
      id: genId(),
      title: `curl ${existingCount + 1}`,
      command,
      running: false,
      response: null,
      parseError: null,
      dirty: false,
      lastRunAt: null,
      pinned: false,
    };
    tabs.value.push(tab);
    activeId.value = tab.id;
    return tab;
  }

  function close(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = tabs.value[idx];
    // Tear down any side-effect resource the tab owns. WebSocket
    // tabs hold a live socket via webSocketRuntime; closing the tab
    // without disconnecting would leak the connection until the
    // user quits the app or the network drops it.
    if (tab.kind === 'websocket') {
      webSocketRuntime.disconnect(id);
    }
    const wasPinned = tab.pinned;
    tabs.value.splice(idx, 1);
    if (activeId.value === id) {
      activeId.value = tabs.value[Math.max(0, idx - 1)]?.id ?? null;
    }
    // Closing a pinned tab is an explicit user action — drop it from
    // the persistence record so the next launch doesn't resurrect it.
    if (wasPinned) persistPinned();
  }

  function setActive(id: string) {
    if (tabs.value.some((t) => t.id === id)) activeId.value = id;
  }

  function markDirty(id: string, dirty = true) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) tab.dirty = dirty;
  }

  function refreshRequest(id: string, updated: ApiRequest) {
    const tab = tabs.value.find((t) => t.id === id);
    // Both 'request' and 'websocket' tabs carry an ApiRequest in
    // `tab.request`. Saving from either editor lands here — without
    // the kind === 'websocket' branch, WS saves succeed on the server
    // but `dirty` stays true locally and the UI keeps showing the
    // unsaved-changes indicator.
    if (tab && (tab.kind === 'request' || tab.kind === 'websocket')) {
      tab.request = clone(updated);
      tab.dirty = false;
    }
  }

  function refreshCollection(id: string, updated: Collection) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab && tab.kind === 'collection') {
      tab.collection = clone(updated);
      tab.dirty = false;
    }
  }

  /**
   * Tear down any per-tab side-effect resources (currently just
   * WebSocket connections) before the tabs are removed. Centralised
   * so every bulk-close path uses it — leaking a connection on
   * "Close all" would have been just as bad as on the single-close
   * path.
   */
  function teardown(droppedTabs: Tab[]) {
    for (const t of droppedTabs) {
      if (t.kind === 'websocket') {
        webSocketRuntime.disconnect(t.id);
      }
    }
  }

  /**
   * Close every tab. When `force` is false (default), pinned tabs
   * are preserved — matches VSCode's "Close All Editors" UX where
   * pinned editors stay put. Pass force=true to nuke everything
   * including pinned (used by project-switch, where the project's
   * data is going away).
   */
  function closeAll(force = false) {
    if (force) {
      teardown(tabs.value);
      tabs.value = [];
      activeId.value = null;
      persistPinned();
      return;
    }
    const keep = tabs.value.filter((t) => t.pinned);
    const drop = tabs.value.filter((t) => !t.pinned);
    teardown(drop);
    tabs.value = keep;
    if (activeId.value && !keep.some((t) => t.id === activeId.value)) {
      activeId.value = keep[0]?.id ?? null;
    }
  }

  /** Close every tab except the one with `keepId` (and pinned tabs). */
  function closeOthers(keepId: string) {
    const keep = tabs.value.find((t) => t.id === keepId);
    if (!keep) {
      // Defensive: id no longer exists; behave like closeAll.
      closeAll();
      return;
    }
    const survivors = tabs.value.filter((t) => t.id === keepId || t.pinned);
    teardown(tabs.value.filter((t) => !survivors.includes(t)));
    tabs.value = survivors;
    activeId.value = keep.id;
  }

  /**
   * Close all tabs to the right of `id`, preserving `id`, everything
   * before it, and any pinned tabs in the closed range.
   */
  function closeToRight(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const candidates = tabs.value.slice(idx + 1);
    const droppedTabs = candidates.filter((t) => !t.pinned);
    if (droppedTabs.length === 0) return;
    teardown(droppedTabs);
    const droppedIds = new Set(droppedTabs.map((t) => t.id));
    tabs.value = tabs.value.filter((t) => !droppedIds.has(t.id));
    if (activeId.value && droppedIds.has(activeId.value)) {
      activeId.value = id;
    }
  }

  /** Close all tabs to the left of `id`, except pinned tabs. */
  function closeToLeft(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx <= 0) return;
    const candidates = tabs.value.slice(0, idx);
    const droppedTabs = candidates.filter((t) => !t.pinned);
    if (droppedTabs.length === 0) return;
    teardown(droppedTabs);
    const droppedIds = new Set(droppedTabs.map((t) => t.id));
    tabs.value = tabs.value.filter((t) => !droppedIds.has(t.id));
    if (activeId.value && droppedIds.has(activeId.value)) {
      activeId.value = id;
    }
  }

  // ---- Pinning ----

  /**
   * Toggle the pinned state on a tab. Persists immediately so a
   * crash before the next clean exit still restores the pin on
   * next launch.
   *
   * Pinned tabs are sorted to the front of the tab strip — matches
   * VSCode's editor behaviour and makes "the always-visible
   * fixtures" easy to find.
   */
  function setPinned(id: string, pinned: boolean): void {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    if (tab.pinned === pinned) return;
    tab.pinned = pinned;
    // Move pinned tabs to the front (stable within their group).
    tabs.value.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    persistPinned();
  }
  function togglePin(id: string): void {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    setPinned(id, !tab.pinned);
  }

  /**
   * Build the persistence payload from the current tab list. Called
   * on every pin toggle and on tab close so the localStorage record
   * always matches the live state.
   *
   * The projectId for entity-backed tabs (request / websocket /
   * collection) is captured at persist time, NOT at pin time —
   * fewer moving parts, since Pinia stores can be inspected
   * directly. We dynamically import the workspace store to avoid
   * a circular import at module-load time.
   */
  // The active project id, supplied by WorkspaceLayout whenever it
  // switches. Captured at persist time so we know which entity-backed
  // tabs should be re-opened on next boot. Curl tabs ignore this.
  let currentProjectId: string | null = null;
  function setProjectContext(projectId: string | null): void {
    currentProjectId = projectId;
  }

  function persistPinned(): void {
    const pinned = tabs.value.filter((t) => t.pinned);
    if (pinned.length === 0) {
      writePersistedPinned([]);
      return;
    }
    const persisted: PersistedPinnedTab[] = pinned.map((t) => {
      if (t.kind === 'curl') {
        return { kind: 'curl', id: t.id, command: t.command, projectId: null };
      }
      return { kind: t.kind, id: t.id, projectId: currentProjectId };
    });
    writePersistedPinned(persisted);
  }

  /**
   * Re-open any pinned tabs whose project just became active. Called
   * from WorkspaceLayout after `collections.loadForProject(...)`
   * resolves, with the matching collections + requests in scope.
   *
   * Idempotent — re-opening an already-open tab is a no-op via the
   * existing dedupe in `openRequest` / `openCollection`. Curl tabs
   * are restored only on the first call (no project tied) to avoid
   * re-spawning them on every project switch.
   */
  let curlsRestored = false;
  function restorePinned(opts: {
    projectId: string | null;
    findRequest: (id: string) => ApiRequest | null;
    findCollection: (id: string) => Collection | null;
  }): void {
    const list = readPersistedPinned();
    if (list.length === 0) return;

    for (const p of list) {
      if (p.kind === 'curl') {
        if (curlsRestored) continue;
        // Avoid duplicating an already-open curl tab with the same
        // command (e.g. user did a full close-all, restored, and
        // then this fires again — defensive).
        const exists = tabs.value.some(
          (t) => t.kind === 'curl' && t.id === p.id,
        );
        if (!exists) {
          const ct = openCurl(p.command ?? '');
          // Preserve the original id so the persistence record stays
          // stable across restarts (otherwise every restore would
          // generate a new id and the next persistPinned would lose
          // the old reference).
          ct.id = p.id;
          ct.pinned = true;
        }
        continue;
      }
      // Project-scoped tabs only restore when their project is loaded.
      if (p.projectId !== opts.projectId) continue;
      if (p.kind === 'collection') {
        const c = opts.findCollection(p.id);
        if (!c) continue;
        const ct = openCollection(c);
        ct.pinned = true;
      } else {
        // request / websocket — the same store entity backs both,
        // dispatch by request.kind happens inside openRequest.
        const r = opts.findRequest(p.id);
        if (!r) continue;
        const ct = openRequest(r);
        ct.pinned = true;
      }
    }
    if (!curlsRestored) curlsRestored = true;
    // Re-sort: any newly-opened pinned tabs should be at the front.
    tabs.value.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }

  return {
    tabs,
    activeId,
    active,
    openRequest,
    openWebSocket,
    openCollection,
    openCurl,
    close,
    setActive,
    markDirty,
    refreshRequest,
    refreshCollection,
    setWsStatus,
    appendWsMessage,
    appendWsMessages,
    clearWsMessages,
    closeAll,
    closeOthers,
    closeToRight,
    closeToLeft,
    setPinned,
    togglePin,
    setProjectContext,
    restorePinned,
  };
});
