<script setup lang="ts">
/**
 * WebSocket request editor. Sister of RequestEditor.vue but for
 * `kind: 'ws'` requests. Layout:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Name                                       [● Status]   │
 *   ├────────────────────────────────────────────────────────┤
 *   │ ws:// URL                          [Connect/Disconnect] │
 *   ├────────────────────────────────────────────────────────┤
 *   │ ┌──────────────────┬─────────────────────────────────┐ │
 *   │ │ Headers / Auth   │ Message log (sent + received)    │ │
 *   │ │ Subprotocols     │ ...                              │ │
 *   │ │                  │ Composer + Send                  │ │
 *   │ └──────────────────┴─────────────────────────────────┘ │
 *   └────────────────────────────────────────────────────────┘
 *
 * Headers + subprotocols are SAVED with the request (synced via
 * the same path as HTTP requests). Connection state, message log,
 * and composer text are session-only and live in the WebSocketTab
 * runtime.
 */
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Textarea from 'primevue/textarea';
import KeyValueList from '@/components/KeyValueList.vue';
import { useTabsStore, type WebSocketTab, type WsMessage } from '@/stores/tabs';
import { useCollectionsStore } from '@/stores/collections';
import { webSocketRuntime, describeCloseCode } from '@/services/websocket';
import { resolve as resolveVars } from '@/services/variables';
import { useEnvironmentsStore } from '@/stores/environments';
import type { Header } from '@aelvory/core';

const props = defineProps<{ tab: WebSocketTab }>();
const tabs = useTabsStore();
const collections = useCollectionsStore();
const environments = useEnvironmentsStore();

// Two-way binding helpers — same shape as RequestEditor's. Each
// edit marks the tab dirty so Ctrl+S is offered.
const url = computed({
  get: () => props.tab.request.url,
  set: (v: string) => {
    props.tab.request.url = v;
    tabs.markDirty(props.tab.id);
  },
});

const headers = computed({
  get: () => props.tab.request.headers,
  set: (v: Header[]) => {
    props.tab.request.headers = v;
    tabs.markDirty(props.tab.id);
  },
});

// Subprotocols are stored on the request as a comma-separated list
// in a synthetic header named "Sec-WebSocket-Protocol" — keeps the
// data model simple (no schema change) and matches the wire-name
// users already know from browser DevTools.
const subprotocols = computed({
  get: () => {
    const h = props.tab.request.headers.find(
      (x) => x.key.toLowerCase() === 'sec-websocket-protocol',
    );
    return h?.value ?? '';
  },
  set: (v: string) => {
    const list = props.tab.request.headers.filter(
      (h) => h.key.toLowerCase() !== 'sec-websocket-protocol',
    );
    if (v.trim()) {
      list.push({ key: 'Sec-WebSocket-Protocol', value: v.trim(), enabled: true });
    }
    props.tab.request.headers = list;
    tabs.markDirty(props.tab.id);
  },
});

const composer = computed({
  get: () => props.tab.composer,
  set: (v: string) => {
    props.tab.composer = v;
  },
});

const composerFormat = computed({
  get: () => props.tab.composerFormat,
  set: (v: 'text' | 'json') => {
    props.tab.composerFormat = v;
  },
});

const isConnected = computed(() => props.tab.status === 'open');
const isBusy = computed(() => props.tab.status === 'connecting' || props.tab.status === 'closing');

// --- Connection lifecycle ---

// Tracks whether the current connect attempt ever reached the
// open state. The 1006 "things to try" hint only fires when a
// connection died DURING the upgrade (open never happened) —
// dropping it on every disconnect after a long session would
// be noise.
let openedAtLeastOnce = false;

function connect() {
  if (!url.value.trim()) return;
  openedAtLeastOnce = false;

  // Resolve variables in the URL the same way HTTP requests do —
  // {{baseUrl}} → ws://api.example.com etc. Active env variables
  // are the only context layer that makes sense here; ancestor
  // collection vars don't apply since WS connections are
  // transient (not part of an HTTP request chain).
  // Trim the resolved URL — trailing whitespace from a copy/paste
  // doesn't trigger the constructor to throw but does cause the
  // server to reject the upgrade with no useful detail (we only see
  // 1006 abnormal close).
  const resolved = resolveVars(url.value, environments.activeVariables).trim();
  if (!/^wss?:\/\//i.test(resolved)) {
    tabs.appendWsMessage(props.tab.id, 'system', `Invalid URL "${resolved}" — must start with ws:// or wss://`);
    tabs.setWsStatus(props.tab.id, 'error', 'Invalid URL scheme');
    return;
  }

  const subs = subprotocols.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Reset state — fresh connect should clear stale error from a
  // previous attempt but keep the message log so the user has the
  // history. Use clearWsMessages explicitly if they want a wipe.
  tabs.setWsStatus(props.tab.id, 'connecting', '');
  tabs.appendWsMessage(props.tab.id, 'system', `Connecting to ${resolved}…`);

  // ---- High-volume ingestion ----
  //
  // A chatty server can fire dozens of frames per millisecond. If we
  // pushed each one straight into the Pinia store, every push would
  // trigger reactivity, force a re-render, and (if the user is
  // scrolled to the bottom) reflow the log container. Three pushes
  // a frame is fine; three thousand a frame freezes the UI.
  //
  // So we buffer received frames in a closure-local array and flush
  // them as one batch on the next animation frame. The store has a
  // matching `appendWsMessages` that does ONE push + ONE splice for
  // the whole batch — turning O(N) reactivity work into O(1) per
  // ~16 ms regardless of frame rate. Latency cost is sub-frame
  // (imperceptible); throughput improves linearly with batch size.
  const incomingBuffer: string[] = [];
  let flushScheduled = false;
  const flushIncoming = () => {
    flushScheduled = false;
    if (incomingBuffer.length === 0) return;
    const batch = incomingBuffer.splice(0);
    tabs.appendWsMessages(props.tab.id, 'received', batch);
  };

  webSocketRuntime.connect(
    props.tab.id,
    { url: resolved, subprotocols: subs.length ? subs : undefined },
    {
      onOpen: () => {
        openedAtLeastOnce = true;
        tabs.setWsStatus(props.tab.id, 'open', '');
        tabs.appendWsMessage(props.tab.id, 'system', 'Connected');
      },
      onMessage: (data) => {
        incomingBuffer.push(data);
        if (!flushScheduled) {
          flushScheduled = true;
          requestAnimationFrame(flushIncoming);
        }
      },
      onClose: (code, reason, wasClean) => {
        tabs.setWsStatus(props.tab.id, 'closed', null);
        // Surface what the close code actually means rather than
        // just the bare number. 1006 in particular gets a longer
        // hint because it's the catch-all for "the connection
        // failed but the browser won't tell you why" — by far the
        // most common failure mode users hit.
        const description = describeCloseCode(code);
        const reasonNote = reason ? ` "${reason}"` : '';
        const cleanNote = wasClean ? '' : ', not a clean close';
        tabs.appendWsMessage(
          props.tab.id,
          'system',
          `Closed: ${code}${reasonNote}${cleanNote}. ${description}`,
        );
        // For 1006 specifically, drop a checklist entry separately
        // — easier to scan than a single long line. Only do this
        // when the close immediately followed a connect attempt
        // that never reached the open state (no point lecturing
        // when a long-lived connection drops).
        if (code === 1006 && !openedAtLeastOnce) {
          tabs.appendWsMessage(
            props.tab.id,
            'system',
            'Things to try: ' +
              '(1) verify the URL path — many servers serve WS only at e.g. /ws or /socket; ' +
              '(2) try a subprotocol if the API documents one (e.g. graphql-ws, mqtt); ' +
              '(3) confirm the Authorization header — some servers require it before upgrade; ' +
              '(4) check the URL with the same path in `wscat` or DevTools to compare.',
          );
        }
      },
      onError: (msg) => {
        // Don't flip to 'error' if the close event is going to
        // arrive next — let the close take precedence for the
        // user-facing status. The message-log entry is enough
        // signal in the meantime.
        tabs.appendWsMessage(props.tab.id, 'system', `Error: ${msg}`);
      },
    },
  );
}

function disconnect() {
  webSocketRuntime.disconnect(props.tab.id);
}

// --- Saved messages (CRUD) ---
//
// A WebSocket "request" doesn't really have an HTTP body, so we
// repurpose `request.body` to hold a small library of named messages
// the user can fire at the connection. Stored as JSON in body.raw so
// the existing sync / persistence machinery carries them without a
// schema change. Shape:
//
//   request.body = {
//     type: 'json',
//     raw: '[{"id":"…","name":"Ping","body":"{\"type\":\"ping\"}"}]',
//     contentType: 'application/json',
//   };
//
// Wrapping in an envelope (rather than a raw array string) keeps the
// door open for additional metadata later (favourites, hotkeys, etc.)
// without breaking the existing column.

interface SavedWsMessage {
  id: string;
  name: string;
  body: string;
}

function genMsgId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const savedMessages = computed<SavedWsMessage[]>({
  get: () => {
    const raw = props.tab.request.body?.raw;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (x): x is SavedWsMessage =>
          x &&
          typeof x === 'object' &&
          typeof x.id === 'string' &&
          typeof x.name === 'string' &&
          typeof x.body === 'string',
      );
    } catch {
      return [];
    }
  },
  set: (list) => {
    // Persist as a `raw` body — the union doesn't have a literal
    // 'json' variant; we use the JSON content-type to disambiguate
    // from arbitrary text bodies if any other code path inspects
    // this. The runner ignores `body` for WS requests, so this is
    // a free-real-estate slot.
    props.tab.request.body = {
      type: 'raw',
      raw: JSON.stringify(list),
      contentType: 'application/json',
    };
    tabs.markDirty(props.tab.id);
  },
});

const editingId = ref<string | null>(null);
const editingDraft = ref<{ name: string; body: string }>({ name: '', body: '' });
const creatingNew = ref(false);

function startEdit(m: SavedWsMessage) {
  editingId.value = m.id;
  editingDraft.value = { name: m.name, body: m.body };
  creatingNew.value = false;
}

function startNew() {
  creatingNew.value = true;
  editingId.value = null;
  editingDraft.value = { name: '', body: '' };
}

function cancelEdit() {
  editingId.value = null;
  creatingNew.value = false;
  editingDraft.value = { name: '', body: '' };
}

function commitEdit() {
  const name = editingDraft.value.name.trim();
  const body = editingDraft.value.body;
  if (!name) return;
  const list = savedMessages.value.slice();
  if (creatingNew.value) {
    list.push({ id: genMsgId(), name, body });
  } else if (editingId.value) {
    const i = list.findIndex((m) => m.id === editingId.value);
    if (i >= 0) list[i] = { ...list[i], name, body };
  }
  savedMessages.value = list;
  cancelEdit();
}

function deleteMessage(id: string) {
  savedMessages.value = savedMessages.value.filter((m) => m.id !== id);
}

function sendSaved(m: SavedWsMessage) {
  // Fires the saved message on the live connection — same pipeline
  // as the composer's Send button, minus the JSON re-stringify (the
  // user edited and saved the literal body they want sent, so we
  // trust it verbatim). If it's malformed JSON, the server will say
  // so via the response.
  const ok = webSocketRuntime.send(props.tab.id, m.body);
  if (!ok) {
    tabs.appendWsMessage(props.tab.id, 'system', 'Not connected — open the connection first');
    return;
  }
  tabs.appendWsMessage(props.tab.id, 'sent', m.body);
  props.tab.lastSentAt = Date.now();
}

function send() {
  const body = props.tab.composer;
  if (!body.trim()) return;

  let payload = body;
  // For JSON mode, validate before send — catching a malformed
  // JSON locally is much friendlier than the server hanging up.
  if (composerFormat.value === 'json') {
    try {
      const parsed = JSON.parse(body);
      // Re-stringify so any trailing whitespace / pretty-printed
      // formatting in the composer goes out as a compact frame.
      payload = JSON.stringify(parsed);
    } catch (err) {
      tabs.appendWsMessage(
        props.tab.id,
        'system',
        `Won't send — composer JSON is invalid: ${err instanceof Error ? err.message : 'parse failed'}`,
      );
      return;
    }
  }

  const ok = webSocketRuntime.send(props.tab.id, payload);
  if (!ok) {
    tabs.appendWsMessage(props.tab.id, 'system', 'Not connected — open the connection first');
    return;
  }
  tabs.appendWsMessage(props.tab.id, 'sent', payload);
  props.tab.lastSentAt = Date.now();
  // Don't clear composer — users frequently iterate on a
  // single message body, tweaking and re-sending. Manual clear
  // via the broom button.
}

function clearLog() {
  tabs.clearWsMessages(props.tab.id);
}

// --- Save (Ctrl+S) ---

const saving = ref(false);
async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    const updated = await collections.updateRequest(props.tab.request);
    tabs.refreshRequest(props.tab.id, updated);
  } finally {
    saving.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    void save();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && isConnected.value) {
    e.preventDefault();
    send();
  }
}

// --- Cleanup on tab close / unmount ---
//
// If the user closes the tab while connected, we tear the connection
// down so the socket isn't left dangling. The runtime no-ops if
// already closed.
onBeforeUnmount(() => {
  // Don't auto-disconnect on unmount caused by route swap — the user
  // expects the connection to live as long as the tab does. We
  // leave teardown to the explicit close-tab path; the parent
  // tabs store could call webSocketRuntime.disconnect on close
  // if we want stricter semantics later.
});

// Keep status in sync if the runtime drifts (defensive — the
// callbacks should already keep it correct).
watch(
  () => props.tab.id,
  () => {
    const real = webSocketRuntime.status(props.tab.id);
    if (real !== props.tab.status) {
      tabs.setWsStatus(props.tab.id, real);
    }
  },
  { immediate: true },
);

// --- Message log helpers ---

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// `prettify` and `preview` used to live here as per-render helpers;
// they're now pre-computed once at append time in stores/tabs.ts and
// cached on each WsMessage as `m.pretty` / `m.preview`. That moves a
// JSON.parse + JSON.stringify pair off the render hot path, which
// matters under burst traffic where every paint would otherwise
// re-format every visible message.

// --- Message collapse state ---
//
// Both received AND sent frames default to collapsed: a chatty
// server (or a re-fired saved message in a tight loop) floods the
// log with multi-line JSON blobs that make the scroll-back
// unreadable at full size. The header (chevron + arrow + timestamp
// + one-line preview) stays visible; clicking expands the full body.
// System messages stay always-expanded — they're short lifecycle
// notes ("Connecting…", "Closed: 1006…") the user wants to read
// at a glance.
const expandedMessages = ref(new Set<number>());

function toggleExpanded(m: WsMessage) {
  if (m.direction === 'system') return;
  const next = new Set(expandedMessages.value);
  if (next.has(m.id)) next.delete(m.id);
  else next.add(m.id);
  expandedMessages.value = next;
}

function isExpanded(m: WsMessage): boolean {
  if (m.direction === 'system') return true;
  return expandedMessages.value.has(m.id);
}

function isCollapsible(m: WsMessage): boolean {
  return m.direction !== 'system';
}

// --- Copy support ---
//
// Each collapsible message gets a copy-to-clipboard button. Click
// stops propagation so it doesn't also toggle the expand state.
// The icon briefly swaps to a checkmark on success so the user
// gets a visual confirmation without us pulling in a toast.
const copiedIds = ref(new Set<number>());

async function copyMessage(m: WsMessage, ev: Event) {
  ev.stopPropagation();
  try {
    await navigator.clipboard.writeText(m.data);
    const next = new Set(copiedIds.value);
    next.add(m.id);
    copiedIds.value = next;
    setTimeout(() => {
      const after = new Set(copiedIds.value);
      after.delete(m.id);
      copiedIds.value = after;
    }, 1200);
  } catch {
    // Clipboard API can reject when the document isn't focused,
    // when permissions are denied, or in some webview contexts.
    // Fall back to a system message so the user knows the click
    // registered but the copy didn't go through.
    tabs.appendWsMessage(props.tab.id, 'system', 'Copy failed — clipboard unavailable');
  }
}

</script>

<template>
  <div class="ws-editor" @keydown="onKeydown">
    <header class="header">
      <div class="name">
        <input
          v-model="props.tab.request.name"
          class="name-input"
          @input="tabs.markDirty(props.tab.id)"
        />
        <span v-if="props.tab.dirty" class="dirty">•</span>
      </div>
      <span class="spacer" />
      <span :class="['status', `status-${props.tab.status}`]">
        <span class="dot" />
        {{ props.tab.status }}
      </span>
      <Button
        label="Save"
        icon="pi pi-save"
        size="small"
        severity="secondary"
        :loading="saving"
        :disabled="!props.tab.dirty"
        @click="save"
      />
    </header>

    <div class="url-row">
      <InputText
        v-model="url"
        class="url-input"
        placeholder="ws://localhost:3000/socket  or  wss://api.example.com/ws"
        spellcheck="false"
        autocomplete="off"
        :disabled="isConnected || isBusy"
      />
      <Button
        v-if="!isConnected"
        label="Connect"
        icon="pi pi-link"
        :loading="isBusy"
        :disabled="!url.trim()"
        @click="connect"
      />
      <Button
        v-else
        label="Disconnect"
        icon="pi pi-times"
        severity="danger"
        outlined
        @click="disconnect"
      />
    </div>

    <div class="ws-body">
      <div class="left-pane">
        <Tabs value="messages" class="ed-tabs">
          <TabList>
            <Tab value="messages">
              Messages
              <span v-if="savedMessages.length" class="badge-count">{{ savedMessages.length }}</span>
            </Tab>
            <Tab value="headers">Headers</Tab>
            <Tab value="subprotocols">Subprotocols</Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="messages">
              <p class="hint">
                A library of named messages you can fire at the
                connection. Saved with the request — sync carries
                them between machines.
              </p>
              <ul v-if="savedMessages.length" class="msg-list">
                <li
                  v-for="m in savedMessages"
                  :key="m.id"
                  class="msg-item"
                  :class="{ editing: editingId === m.id }"
                >
                  <template v-if="editingId === m.id">
                    <InputText
                      v-model="editingDraft.name"
                      placeholder="Name"
                      class="full"
                    />
                    <Textarea
                      v-model="editingDraft.body"
                      rows="3"
                      placeholder="Message body"
                      class="full"
                      spellcheck="false"
                    />
                    <div class="msg-edit-actions">
                      <Button
                        label="Save"
                        size="small"
                        :disabled="!editingDraft.name.trim()"
                        @click="commitEdit"
                      />
                      <Button
                        label="Cancel"
                        size="small"
                        text
                        severity="secondary"
                        @click="cancelEdit"
                      />
                    </div>
                  </template>
                  <template v-else>
                    <div class="msg-row-head">
                      <span class="msg-name">{{ m.name }}</span>
                      <span class="spacer" />
                      <Button
                        icon="pi pi-send"
                        size="small"
                        :title="isConnected ? 'Send' : 'Connect first'"
                        :disabled="!isConnected"
                        @click="sendSaved(m)"
                      />
                      <Button
                        icon="pi pi-pencil"
                        text
                        size="small"
                        severity="secondary"
                        title="Edit"
                        @click="startEdit(m)"
                      />
                      <Button
                        icon="pi pi-trash"
                        text
                        size="small"
                        severity="danger"
                        title="Delete"
                        @click="deleteMessage(m.id)"
                      />
                    </div>
                    <pre class="msg-preview">{{ m.body }}</pre>
                  </template>
                </li>
              </ul>
              <div v-if="creatingNew" class="msg-new">
                <InputText
                  v-model="editingDraft.name"
                  placeholder="Name (e.g. Ping)"
                  class="full"
                />
                <Textarea
                  v-model="editingDraft.body"
                  rows="3"
                  placeholder="Body — text or JSON"
                  class="full"
                  spellcheck="false"
                />
                <div class="msg-edit-actions">
                  <Button
                    label="Add"
                    size="small"
                    :disabled="!editingDraft.name.trim()"
                    @click="commitEdit"
                  />
                  <Button
                    label="Cancel"
                    size="small"
                    text
                    severity="secondary"
                    @click="cancelEdit"
                  />
                </div>
              </div>
              <Button
                v-else
                icon="pi pi-plus"
                label="New message"
                text
                size="small"
                class="msg-new-btn"
                @click="startNew"
              />
            </TabPanel>
            <TabPanel value="headers">
              <p class="hint">
                Sent on the WebSocket upgrade request. Some servers
                won't honour custom headers on a browser-originating
                WS handshake — the spec only guarantees support for
                <code>Sec-WebSocket-Protocol</code>.
              </p>
              <KeyValueList v-model="headers" />
            </TabPanel>
            <TabPanel value="subprotocols">
              <p class="hint">
                Comma-separated list sent in
                <code>Sec-WebSocket-Protocol</code>. The server picks
                one (or none) and echoes it back in the handshake.
                Common values: <code>graphql-ws</code>,
                <code>wamp</code>, <code>mqtt</code>.
              </p>
              <InputText
                v-model="subprotocols"
                class="full"
                placeholder="graphql-ws, graphql-transport-ws"
                spellcheck="false"
              />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>

      <div class="right-pane">
        <div class="log-wrap">
          <div class="log-head">
            <span class="log-title">Messages</span>
            <span class="log-count">{{ props.tab.messages.length }}</span>
            <span class="spacer" />
            <Button
              icon="pi pi-trash"
              text
              size="small"
              severity="secondary"
              :disabled="props.tab.messages.length === 0"
              aria-label="Clear log"
              @click="clearLog"
            />
          </div>
          <div class="log">
            <div v-if="props.tab.messages.length === 0" class="log-empty">
              No messages yet. Connect and send something, or wait for
              the server to push.
            </div>
            <div
              v-for="m in props.tab.messages"
              :key="m.id"
              :class="[
                'msg',
                `msg-${m.direction}`,
                {
                  collapsible: isCollapsible(m),
                  collapsed: isCollapsible(m) && !isExpanded(m),
                },
              ]"
            >
              <div
                class="msg-meta"
                :role="isCollapsible(m) ? 'button' : undefined"
                :tabindex="isCollapsible(m) ? 0 : undefined"
                @click="toggleExpanded(m)"
                @keydown.enter.prevent="toggleExpanded(m)"
                @keydown.space.prevent="toggleExpanded(m)"
              >
                <span
                  v-if="isCollapsible(m)"
                  class="msg-chevron"
                  :title="isExpanded(m) ? 'Collapse' : 'Expand'"
                >
                  <i :class="isExpanded(m) ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
                </span>
                <span class="msg-arrow" :title="m.direction">
                  <i v-if="m.direction === 'sent'" class="pi pi-arrow-up" />
                  <i v-else-if="m.direction === 'received'" class="pi pi-arrow-down" />
                  <i v-else class="pi pi-info-circle" />
                </span>
                <span class="msg-ts">{{ fmtTime(m.ts) }}</span>
                <span
                  v-if="isCollapsible(m) && !isExpanded(m)"
                  class="msg-preview-line"
                >{{ m.preview }}</span>
                <button
                  v-if="isCollapsible(m)"
                  class="msg-copy"
                  :title="copiedIds.has(m.id) ? 'Copied' : 'Copy'"
                  :aria-label="copiedIds.has(m.id) ? 'Copied' : 'Copy message'"
                  @click="copyMessage(m, $event)"
                >
                  <i :class="copiedIds.has(m.id) ? 'pi pi-check' : 'pi pi-copy'" />
                </button>
              </div>
              <pre v-if="isExpanded(m)" class="msg-body">{{ m.pretty }}</pre>
            </div>
          </div>
        </div>

        <div class="composer">
          <div class="composer-head">
            <span class="composer-title">Send a message</span>
            <span class="spacer" />
            <select v-model="composerFormat" class="format-select">
              <option value="text">text</option>
              <option value="json">json</option>
            </select>
          </div>
          <Textarea
            v-model="composer"
            rows="4"
            class="composer-input"
            spellcheck="false"
            :placeholder="composerFormat === 'json'
              ? '{ \&quot;type\&quot;: \&quot;ping\&quot; }'
              : 'message body...'"
          />
          <div class="composer-actions">
            <span class="hint-inline">
              Ctrl+Enter to send · Ctrl+S to save the connection
            </span>
            <span class="spacer" />
            <Button
              label="Send"
              icon="pi pi-send"
              size="small"
              :disabled="!isConnected || !composer.trim()"
              @click="send"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  /* Wrap status + save below the name in tight widths, same idea
     as the url-row and composer-actions — never let trailing
     buttons clip off-screen. */
  flex-wrap: wrap;
}
.name {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  flex: 1;
}
.name-input {
  border: none;
  background: transparent;
  font-size: 0.95rem;
  font-weight: 500;
  /* Was a hard 300px which kept the name field fat enough to push
     the status badge + save button out of the right edge on narrow
     panels. Cap with max-width so it shrinks when needed. */
  width: 100%;
  max-width: 300px;
  min-width: 0;
  outline: none;
}
.name-input:focus {
  border-bottom: 1px solid var(--p-primary-400, #60a5fa);
}
.dirty {
  color: var(--p-primary-500, #3b82f6);
  font-size: 1.2rem;
}
.spacer {
  flex: 1;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #6b7280);
  font-variant-numeric: tabular-nums;
}
.status .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--p-text-muted-color, #9ca3af);
}
.status-open .dot {
  background: #16a34a;
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.18);
}
.status-connecting .dot,
.status-closing .dot {
  background: #ca8a04;
}
.status-error .dot {
  background: #dc2626;
}
.url-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  /* Wrap the connect button below the URL on narrow widths
     instead of letting the URL shove it past the right edge. */
  flex-wrap: wrap;
}
.url-input {
  flex: 1;
  min-width: 0;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.85rem;
}
.ws-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: grid;
  /* `minmax(0, ...)` is critical: the default for grid tracks is
     `minmax(auto, ...)`, which means each column refuses to shrink
     below its content's intrinsic size — and the right pane (log
     rows, composer textarea) has plenty of intrinsic width. The
     consequence at narrow widths was the right column overflowing
     the panel and chopping the send button / scrollbar off-screen.
     `minmax(0, …)` lets each column shrink as needed. */
  grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
}
@media (max-width: 720px) {
  /* Stack the panes vertically when there isn't horizontal room
     for both. The left pane (Messages / Headers / Subprotocols)
     gets a bounded height so the log + composer below it stays
     reachable even on very narrow windows. */
  .ws-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(120px, 35%) minmax(0, 1fr);
  }
}
.left-pane {
  border-right: 1px solid var(--p-content-border-color, #e5e7eb);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
@media (max-width: 720px) {
  .left-pane {
    border-right: none;
    border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  }
}
.ed-tabs {
  padding: 0 0.75rem;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ed-tabs :deep(.p-tabpanels) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 0.5rem;
}
.hint {
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #6b7280);
  margin: 0.5rem 0 0.75rem;
  line-height: 1.5;
}
.hint code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.05rem 0.25rem;
  border-radius: 2px;
  font-size: 0.74rem;
}
.full {
  width: 100%;
}
.right-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* Without min-width:0, every flex child treats its intrinsic
     min-content as the floor — long URLs, monospaced log lines,
     and the textarea would push the pane wider than the grid track
     and the right edge (scrollbar, send button) ended up clipped. */
  min-width: 0;
}
.log-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
}
.log-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  font-size: 0.82rem;
}
.log-title {
  font-weight: 500;
}
.log-count {
  color: var(--p-text-muted-color, #6b7280);
  font-variant-numeric: tabular-nums;
}
.log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.4rem 0.75rem;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.78rem;
}
.log-empty {
  color: var(--p-text-muted-color, #9ca3af);
  font-style: italic;
  font-size: 0.85rem;
  padding: 1rem 0;
  text-align: center;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.3rem 0;
  border-bottom: 1px dashed var(--p-content-hover-background, #f3f4f6);
}
.msg-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.msg.collapsible .msg-meta {
  cursor: pointer;
  user-select: none;
  border-radius: 3px;
  padding: 0.1rem 0.2rem;
  margin: -0.1rem -0.2rem;
}
.msg.collapsible .msg-meta:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.msg-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  width: 12px;
  color: var(--p-text-muted-color, #9ca3af);
  flex-shrink: 0;
}
.msg-preview-line {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.76rem;
}
/* Copy button — flush right within the meta row, kept hidden until
   the row is hovered or focused so the meta line stays uncluttered
   in the common case. After a successful copy we keep the button
   visible (forced via the `pi-check` icon presence + .msg-copy:has)
   so the user sees the confirmation. */
.msg-copy {
  margin-left: auto;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0.15rem 0.35rem;
  border-radius: 3px;
  color: var(--p-text-muted-color, #9ca3af);
  font-size: 0.75rem;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.1s ease, background 0.1s ease;
  flex-shrink: 0;
}
.msg:hover .msg-copy,
.msg-copy:focus-visible,
.msg-copy:has(.pi-check) {
  opacity: 1;
}
.msg-copy:hover {
  background: var(--p-content-hover-background, #f3f4f6);
  color: var(--p-text-color, inherit);
}
.msg-copy:has(.pi-check) {
  color: #16a34a;
}
.msg-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  width: 18px;
  flex-shrink: 0;
}
.msg-sent .msg-arrow {
  color: #2563eb;
}
.msg-received .msg-arrow {
  color: #16a34a;
}
.msg-system .msg-arrow {
  color: var(--p-text-muted-color, #9ca3af);
}
.msg-ts {
  color: var(--p-text-muted-color, #9ca3af);
  font-size: 0.72rem;
  flex-shrink: 0;
  width: 86px;
}
.msg-body {
  margin: 0;
  /* Indent the body so it lines up under the timestamp column,
     leaving the chevron + arrow column flush left as a visual
     anchor. The 32px matches the chevron + arrow widths plus the
     0.4rem flex gap. */
  margin-left: 32px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 0.78rem;
  color: var(--p-text-color, #111827);
}
.msg-system .msg-body {
  color: var(--p-text-muted-color, #6b7280);
  font-style: italic;
}
.composer {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 0.75rem 0.75rem;
  gap: 0.4rem;
  min-width: 0;
}
.composer-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  /* Allow the format-select to shrink in tight quarters rather
     than pushing the header outside its column. */
  flex-wrap: wrap;
}
.composer-title {
  font-weight: 500;
}
.badge-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.2rem;
  height: 1.1rem;
  padding: 0 0.3rem;
  margin-left: 0.4rem;
  border-radius: 999px;
  font-size: 0.7rem;
  background: var(--p-content-hover-background, #e5e7eb);
  color: var(--p-text-muted-color, #6b7280);
}
.msg-list {
  list-style: none;
  padding: 0;
  margin: 0.4rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.msg-item {
  border: 1px solid var(--p-content-border-color, #e5e7eb);
  border-radius: 4px;
  padding: 0.4rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  background: var(--p-content-background, transparent);
}
.msg-item.editing {
  background: var(--p-content-hover-background, #f9fafb);
}
.msg-row-head {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.msg-name {
  font-size: 0.85rem;
  font-weight: 500;
}
.msg-preview {
  margin: 0;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.76rem;
  color: var(--p-text-muted-color, #6b7280);
  background: var(--p-content-hover-background, #f9fafb);
  padding: 0.3rem 0.4rem;
  border-radius: 3px;
  max-height: 6rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg-edit-actions {
  display: flex;
  gap: 0.4rem;
}
.msg-new {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.4rem 0.5rem;
  border: 1px dashed var(--p-content-border-color, #d1d5db);
  border-radius: 4px;
  margin-top: 0.4rem;
}
.msg-new-btn {
  justify-content: flex-start;
  margin-top: 0.4rem;
}
.format-select {
  font-size: 0.78rem;
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  border: 1px solid var(--p-content-border-color, #e5e7eb);
  /* Native <select> doesn't pick up PrimeVue tokens by itself.
     Use the form-field tokens that DO flip in dark mode (the
     same ones PrimeVue's InputText / Select use internally). */
  background: var(--p-form-field-background, white);
  color: var(--p-form-field-color, inherit);
}
.composer-input {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.82rem;
  width: 100%;
  /* Prevent native textarea sizing from forcing the parent flex
     container wider than its track — see the parent .composer
     min-width fix above for the same reason. */
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  resize: vertical;
}
.composer-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  /* Wrap the hint + spacer + send button onto a second line in
     tight quarters rather than clipping the send button off-screen. */
  flex-wrap: wrap;
}
.hint-inline {
  color: var(--p-text-muted-color, #9ca3af);
  /* When the row wraps, the spacer + send button fall to the next
     line. Letting the hint shrink (min-width 0) keeps it readable
     instead of forcing a horizontal scroll. */
  flex: 1;
  min-width: 0;
}
</style>
