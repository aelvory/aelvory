<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import Message from 'primevue/message';
import ProgressBar from 'primevue/progressbar';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Select from 'primevue/select';
import { parseOpenApi, type ImportResult, type ImportedFolder } from '@/services/importOpenApi';
import { parsePostman } from '@/services/importPostman';
import { parseInsomnia } from '@/services/importInsomnia';
import { parseHar } from '@/services/importHar';
import { fetchSpec } from '@/services/fetchSpec';
import {
  importIntoProject,
  flattenRequestPaths,
  type ImportStats,
  type RequestPath,
} from '@/services/importer';
import { useWorkspaceStore } from '@/stores/workspace';
import { useCollectionsStore } from '@/stores/collections';
import { useUiStore } from '@/stores/ui';

const visible = defineModel<boolean>({ required: true });

const workspace = useWorkspaceStore();
const collections = useCollectionsStore();
const ui = useUiStore();

// --- Target / partial-import state ---

/**
 * Existing collection to import INTO. `null` means top-level
 * (historical default). Reset on every fresh open of the dialog.
 */
const intoCollectionId = ref<string | null>(null);

/**
 * Flat list of request paths from the parsed result + the user's
 * selection. `null` selection means "all" (no filtering). Switching
 * to a per-row selection populates the set from the full list, then
 * the user unchecks the unwanted ones.
 */
const selectedRequestPaths = ref<Set<string> | null>(null);

/**
 * Whether the partial-import checklist is visible. Toggled by a
 * "Select endpoints…" button so the dialog stays compact for the
 * common case (import everything).
 */
const partialSelectionOpen = ref(false);

const allRequestPaths = computed<RequestPath[]>(() =>
  parsed.value ? flattenRequestPaths(parsed.value) : [],
);

/**
 * Build the "import into" select options: a "Top level" entry plus
 * every collection in the current project, with indentation that
 * reflects the folder hierarchy so the user sees where things will land.
 */
const collectionOptions = computed(() => {
  const opts: { label: string; value: string | null }[] = [
    { label: '(Top level — new collection in project)', value: null },
  ];
  const cols = collections.collections;
  // Sort: depth-first by parent chain so children appear under their
  // parents and the list reads top-to-bottom like the actual tree.
  const byParent = new Map<string | null, typeof cols>();
  for (const c of cols) {
    const k = c.parentId ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(c);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));
  }
  function walk(parentId: string | null, depth: number) {
    for (const c of byParent.get(parentId) ?? []) {
      opts.push({
        label: `${'  '.repeat(depth)}${c.name}`,
        value: c.id,
      });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  return opts;
});

function toggleRequestPath(path: string) {
  if (!selectedRequestPaths.value) {
    // First click on a checkbox initialises the set from "all".
    selectedRequestPaths.value = new Set(
      allRequestPaths.value.map((r) => r.path),
    );
  }
  const set = new Set(selectedRequestPaths.value);
  if (set.has(path)) set.delete(path);
  else set.add(path);
  selectedRequestPaths.value = set;
}

function selectAllRequests() {
  selectedRequestPaths.value = new Set(allRequestPaths.value.map((r) => r.path));
}
function selectNoneRequests() {
  selectedRequestPaths.value = new Set();
}
function clearRequestSelection() {
  // null = "import everything", same as the dialog's initial state.
  selectedRequestPaths.value = null;
  partialSelectionOpen.value = false;
}

const selectedCount = computed(() => {
  if (selectedRequestPaths.value === null) return allRequestPaths.value.length;
  return selectedRequestPaths.value.size;
});

type ImportSource = 'openapi' | 'postman' | 'insomnia' | 'har';

// HAR-only: filter out static asset entries by default. Surfaced as
// a checkbox so users importing a full page capture can opt out.
const harApiOnly = ref(true);
const activeTab = ref<ImportSource>('openapi');
const rawText = ref('');
const parseError = ref<string | null>(null);
const importError = ref<string | null>(null);
const parsed = ref<ImportResult | null>(null);

// URL-import state. Used by the OpenAPI tab — Postman and Insomnia
// exports are typically downloaded from a desktop app, not served at
// a stable URL, so we don't surface a URL field for those tabs.
const specUrl = ref('');
const fetching = ref(false);
const fetchError = ref<string | null>(null);

const createEnv = ref(true);
const envName = ref('imported');

const importing = ref(false);
const progress = ref({ done: 0, total: 0 });
const stats = ref<ImportStats | null>(null);

const fileInput = ref<HTMLInputElement | null>(null);

const preview = computed(() => {
  if (!parsed.value) return null;
  const folders = countFolders(parsed.value.root);
  const requests = countRequests(parsed.value.root);
  return { folders, requests, env: parsed.value.environmentSuggestions.length };
});

function countFolders(f: ImportedFolder): number {
  return 1 + f.children.reduce((s, c) => s + countFolders(c), 0);
}
function countRequests(f: ImportedFolder): number {
  return f.requests.length + f.children.reduce((s, c) => s + countRequests(c), 0);
}

function parse() {
  parseError.value = null;
  importError.value = null;
  parsed.value = null;
  stats.value = null;
  if (!rawText.value.trim()) return;
  try {
    if (activeTab.value === 'openapi') {
      parsed.value = parseOpenApi(rawText.value);
    } else if (activeTab.value === 'postman') {
      parsed.value = parsePostman(rawText.value);
    } else if (activeTab.value === 'insomnia') {
      parsed.value = parseInsomnia(rawText.value);
    } else {
      parsed.value = parseHar(rawText.value, { apiOnly: harApiOnly.value });
    }
    if (envName.value === 'imported') {
      envName.value = `${parsed.value.collectionName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-dev`;
    }
  } catch (err) {
    parseError.value = err instanceof Error ? err.message : 'Parse failed';
  }
}

function onTabChange(v: string | number) {
  // Tabs's `value` prop is typed as string | number; we only ever set
  // string values for it, so the cast back is safe.
  activeTab.value = String(v) as ImportSource;
  // Don't carry URL state across tabs — only the OpenAPI tab uses it
  // and a stale URL in the field on a Postman/Insomnia tab would
  // confuse rather than help.
  fetchError.value = null;
  parse();
}

/**
 * Pre-fill from `ui.importPreload`. Set by callers like the VSCode
 * extension's "Open in Aelvory" command (right-click .har / .yaml /
 * .json → Open in Aelvory) which feed file content straight in.
 *
 * Watch on `visible` because the preload is set BEFORE the dialog
 * opens — by the time the user sees the dialog, importPreload is
 * already non-null. We consume-and-clear so a manual reopen via the
 * regular Import button starts blank.
 */
watch(visible, (isVisible) => {
  if (!isVisible) return;
  const preload = ui.importPreload;
  if (!preload) return;
  activeTab.value = preload.format;
  rawText.value = preload.content;
  // Clear it so the next manual open doesn't see stale data.
  ui.importPreload = null;
  parse();
});

/**
 * Fetch the spec from a URL and feed it into the OpenAPI parser.
 * Routes through tauri-plugin-http when available so common public
 * spec URLs work without CORS rejection from the browser fetch.
 */
async function loadFromUrl() {
  fetchError.value = null;
  parseError.value = null;
  if (!specUrl.value.trim()) return;
  fetching.value = true;
  try {
    const r = await fetchSpec(specUrl.value);
    rawText.value = r.text;
    parse();
  } catch (err) {
    fetchError.value = err instanceof Error ? err.message : 'Fetch failed';
  } finally {
    fetching.value = false;
  }
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    rawText.value = text;
    parse();
  });
}

async function doImport() {
  if (!parsed.value || !workspace.currentProjectId) return;
  importing.value = true;
  importError.value = null;
  progress.value = { done: 0, total: 0 };
  try {
    const res = await importIntoProject(parsed.value, {
      projectId: workspace.currentProjectId,
      intoCollectionId: intoCollectionId.value,
      includeRequestPaths:
        selectedRequestPaths.value ?? undefined,
      createEnvName:
        createEnv.value && parsed.value.environmentSuggestions.length
          ? envName.value.trim() || 'imported'
          : undefined,
      onProgress: (done, total) => {
        progress.value = { done, total };
      },
    });
    stats.value = res;
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Import failed';
  } finally {
    importing.value = false;
  }
}

function close() {
  visible.value = false;
  // Reset when closed
  rawText.value = '';
  specUrl.value = '';
  parsed.value = null;
  parseError.value = null;
  importError.value = null;
  fetchError.value = null;
  intoCollectionId.value = null;
  selectedRequestPaths.value = null;
  partialSelectionOpen.value = false;
  stats.value = null;
  progress.value = { done: 0, total: 0 };
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Import collection"
    :style="{ width: '780px', maxWidth: '95vw' }"
    @update:visible="(v) => { if (!v) close(); }"
  >
    <div class="import-body">
      <Tabs :value="activeTab" @update:value="onTabChange">
        <TabList>
          <Tab value="openapi">OpenAPI / Swagger</Tab>
          <Tab value="postman">Postman collection</Tab>
          <Tab value="insomnia">Insomnia export</Tab>
          <Tab value="har">HAR (browser capture)</Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="openapi">
            <p class="help">
              Paste an OpenAPI 3.x or Swagger 2.0 spec (JSON or YAML), upload
              a file, or fetch from a URL (e.g.
              <code>https://petstore.swagger.io/v2/swagger.json</code>).
              Operations are grouped into folders by their first tag. Servers
              become a <code v-pre>{{baseUrl}}</code> environment variable.
            </p>
          </TabPanel>
          <TabPanel value="postman">
            <p class="help">
              Paste a Postman v2.1 collection export (JSON), or upload a file.
              Folders nest the same way; collection-level variables become env
              suggestions.
            </p>
          </TabPanel>
          <TabPanel value="insomnia">
            <p class="help">
              Paste an Insomnia v4 export (JSON, "Insomnia v4" format from
              File → Export Data), or upload a file. Workspaces become
              folders, request groups nest, and environment data becomes
              env suggestions.
            </p>
          </TabPanel>
          <TabPanel value="har">
            <p class="help">
              HAR (HTTP Archive) export from your browser's DevTools →
              Network → "Save all as HAR with content". Entries are
              grouped into folders by hostname. Common bearer/basic
              auth headers are promoted to the Auth tab.
            </p>
            <div class="har-opts">
              <Checkbox v-model="harApiOnly" binary input-id="har-api-only" @change="parse" />
              <label for="har-api-only" class="env-label">
                API calls only (skip stylesheets, images, fonts, etc.)
              </label>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      <!--
        URL-fetch row. Only meaningful for the OpenAPI tab — Postman
        and Insomnia exports are produced from desktop apps and aren't
        typically hosted at stable URLs. File-upload + paste cover both
        of those.
      -->
      <div v-if="activeTab === 'openapi'" class="url-row">
        <InputText
          v-model="specUrl"
          placeholder="https://example.com/openapi.json"
          class="url-input"
          spellcheck="false"
          autocomplete="off"
          @keydown.enter.prevent="loadFromUrl"
        />
        <Button
          label="Fetch"
          icon="pi pi-cloud-download"
          size="small"
          :loading="fetching"
          :disabled="!specUrl.trim() || fetching"
          @click="loadFromUrl"
        />
      </div>

      <Message
        v-if="fetchError"
        severity="error"
        :closable="false"
        class="msg"
      >{{ fetchError }}</Message>

      <div class="upload-row">
        <Button
          icon="pi pi-upload"
          label="Upload file"
          severity="secondary"
          size="small"
          text
          @click="fileInput?.click()"
        />
        <input
          ref="fileInput"
          type="file"
          class="hidden-input"
          accept=".json,.yaml,.yml,.har,.txt,application/json,text/yaml"
          @change="onFile"
        />
      </div>

      <Textarea
        v-model="rawText"
        rows="10"
        class="raw-input"
        spellcheck="false"
        :placeholder="
          activeTab === 'openapi'
            ? 'Paste OpenAPI JSON or YAML...'
            : activeTab === 'postman'
              ? 'Paste Postman collection JSON...'
              : activeTab === 'insomnia'
                ? 'Paste Insomnia v4 export JSON...'
                : 'Paste HAR JSON (or upload .har file)...'
        "
        @input="parse"
      />

      <Message
        v-if="parseError"
        severity="error"
        :closable="false"
        class="msg"
      >{{ parseError }}</Message>

      <div v-if="preview" class="preview">
        <strong>{{ parsed?.collectionName }}</strong>
        <span class="sep">·</span>
        {{ preview.folders }} folder{{ preview.folders !== 1 ? 's' : '' }}
        <span class="sep">·</span>
        {{ preview.requests }} request{{ preview.requests !== 1 ? 's' : '' }}
        <span v-if="preview.env" class="sep">·</span>
        <span v-if="preview.env">{{ preview.env }} variable{{ preview.env !== 1 ? 's' : '' }}</span>
      </div>

      <!-- Where to put the imported tree. Default is a new top-level
           collection in the current project; user can pick any
           existing collection to nest the imported tree under. -->
      <div v-if="parsed" class="import-target">
        <label class="import-target-label">Import into</label>
        <Select
          v-model="intoCollectionId"
          :options="collectionOptions"
          option-label="label"
          option-value="value"
          class="import-target-select"
        />
      </div>

      <!-- Partial-import checklist. Hidden by default — "Select
           endpoints…" reveals it. Filter applies to the leaf
           requests; folders that end up empty after the filter
           are skipped automatically by the importer. -->
      <div v-if="parsed && allRequestPaths.length > 1" class="partial-toggle">
        <button
          v-if="!partialSelectionOpen"
          class="link-btn"
          type="button"
          @click="partialSelectionOpen = true"
        >
          <i class="pi pi-filter" />
          Select specific endpoints to import…
          ({{ allRequestPaths.length }} available)
        </button>
        <button
          v-else
          class="link-btn"
          type="button"
          @click="clearRequestSelection"
        >
          <i class="pi pi-times" />
          Import all endpoints (clear selection)
        </button>
      </div>

      <div v-if="partialSelectionOpen" class="endpoint-list-wrap">
        <div class="endpoint-list-head">
          <span>{{ selectedCount }} / {{ allRequestPaths.length }} selected</span>
          <span class="spacer" />
          <button class="link-btn" type="button" @click="selectAllRequests">All</button>
          <button class="link-btn" type="button" @click="selectNoneRequests">None</button>
        </div>
        <ul class="endpoint-list">
          <li
            v-for="r in allRequestPaths"
            :key="r.path"
            class="endpoint-row"
            :style="{ paddingLeft: 0.5 + r.depth * 1 + 'rem' }"
          >
            <Checkbox
              :model-value="selectedRequestPaths === null || selectedRequestPaths.has(r.path)"
              binary
              @update:model-value="toggleRequestPath(r.path)"
            />
            <span :class="['endpoint-method', `method-${r.method.toLowerCase()}`]">{{ r.method }}</span>
            <span class="endpoint-name">{{ r.name }}</span>
          </li>
        </ul>
      </div>

      <div v-if="parsed && parsed.environmentSuggestions.length" class="env-opt">
        <Checkbox v-model="createEnv" binary input-id="create-env-chk" />
        <label for="create-env-chk" class="env-label">
          Also create an environment from {{ parsed.environmentSuggestions.length }}
          suggested variable{{ parsed.environmentSuggestions.length !== 1 ? 's' : '' }}
        </label>
        <InputText
          v-if="createEnv"
          v-model="envName"
          size="small"
          class="env-name"
          placeholder="env name"
        />
      </div>

      <Message
        v-if="importError"
        severity="error"
        :closable="false"
        class="msg"
      >{{ importError }}</Message>

      <div v-if="importing" class="progress">
        <ProgressBar
          :value="progress.total ? Math.round((progress.done / progress.total) * 100) : 0"
        />
        <p class="progress-hint">
          Creating items… {{ progress.done }} / {{ progress.total }}
        </p>
      </div>

      <Message
        v-if="stats"
        severity="success"
        :closable="false"
        class="msg"
      >
        Imported
        {{ stats.collectionsCreated }} folder{{ stats.collectionsCreated !== 1 ? 's' : '' }},
        {{ stats.requestsCreated }} request{{ stats.requestsCreated !== 1 ? 's' : '' }}
        <span v-if="stats.envCreated">
          and an environment with {{ stats.varsCreated }} variable{{ stats.varsCreated !== 1 ? 's' : '' }}
        </span>.
      </Message>

      <Message
        v-if="!workspace.currentProjectId"
        severity="warn"
        :closable="false"
        class="msg"
      >
        Select a project before importing — the destination is needed.
      </Message>
    </div>

    <template #footer>
      <Button label="Close" text @click="close" />
      <Button
        v-if="!stats"
        label="Import"
        :disabled="!parsed || !workspace.currentProjectId || importing"
        :loading="importing"
        @click="doImport"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.import-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.help {
  font-size: 0.82rem;
  color: var(--p-text-muted-color, #6b7280);
  margin: 0.5rem 0;
}
.help code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
  font-size: 0.78rem;
}
.url-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.url-input {
  flex: 1;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.82rem;
}
.upload-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.hidden-input {
  display: none;
}
.raw-input {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.8rem;
  width: 100%;
  min-height: 180px;
  max-height: 280px;
}
.msg {
  font-size: 0.82rem;
}
.preview {
  font-size: 0.85rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-content-hover-background, #f9fafb);
  border-radius: 4px;
}
.sep {
  color: var(--p-text-muted-color, #9ca3af);
  margin: 0 0.4rem;
}
.env-opt {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0;
}
.import-target {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
}
.import-target-label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #6b7280);
  min-width: 80px;
}
.import-target-select {
  flex: 1;
  min-width: 0;
}
.partial-toggle {
  padding: 0.35rem 0;
}
.link-btn {
  background: transparent;
  border: none;
  color: var(--p-primary-color, #3b82f6);
  cursor: pointer;
  font-size: 0.82rem;
  padding: 0.2rem 0.4rem;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.link-btn:hover {
  text-decoration: underline;
}
.endpoint-list-wrap {
  border: 1px solid var(--p-content-border-color, #e5e7eb);
  border-radius: 4px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--p-content-background, transparent);
}
.endpoint-list-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #6b7280);
  position: sticky;
  top: 0;
  background: var(--p-content-hover-background, #f9fafb);
}
.endpoint-list-head .spacer { flex: 1; }
.endpoint-list {
  list-style: none;
  margin: 0;
  padding: 0.25rem 0;
}
.endpoint-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  font-size: 0.82rem;
}
.endpoint-row:hover {
  background: var(--p-content-hover-background, #f3f4f6);
}
.endpoint-method {
  font-weight: 700;
  font-size: 0.7rem;
  min-width: 3rem;
  text-transform: uppercase;
}
.endpoint-method.method-get { color: #16a34a; }
.endpoint-method.method-post { color: #ca8a04; }
.endpoint-method.method-put { color: #2563eb; }
.endpoint-method.method-patch { color: #9333ea; }
.endpoint-method.method-delete { color: #dc2626; }
.endpoint-method.method-head, .endpoint-method.method-options { color: #6b7280; }
.endpoint-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.env-label {
  font-size: 0.85rem;
  flex: 1;
}
.env-name {
  width: 180px;
}
.har-opts {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.4rem;
  font-size: 0.85rem;
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.progress-hint {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #6b7280);
  margin: 0;
}
</style>
