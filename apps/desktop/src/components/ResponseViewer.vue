<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Tag from 'primevue/tag';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import Message from 'primevue/message';
import type { ExecuteResponse, Header } from '@aelvory/core';
import type { TestResult } from '@/services/scriptRunner';
import { statusSeverity, formatBytes, formatDuration } from '@/services/runner';
import { extractTokenNames } from '@/services/variables';
import CodeEditor, { type CodeLanguage } from './CodeEditor.vue';

const props = withDefaults(
  defineProps<{
    response: ExecuteResponse | null;
    running: boolean;
    testResults?: TestResult[];
    scriptLogs?: string[];
    scriptError?: string | null;
  }>(),
  { testResults: () => [], scriptLogs: () => [], scriptError: null },
);

const activeTab = ref('body');
const bodyView = ref<'pretty' | 'raw'>('pretty');

const bodyLanguage = computed<CodeLanguage>(() => {
  const ct = (props.response?.contentType ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml') || ct.includes('html')) return 'xml';
  return 'text';
});

const isJson = computed(() => bodyLanguage.value === 'json');

const pretty = computed(() => {
  if (!props.response) return '';
  if (!isJson.value) return props.response.body;
  try {
    return JSON.stringify(JSON.parse(props.response.body), null, 2);
  } catch {
    return props.response.body;
  }
});

const displayedBody = computed<string>(() => {
  if (!props.response) return '';
  return bodyView.value === 'pretty' ? pretty.value : props.response.body;
});

const bodyModel = computed({
  get: () => displayedBody.value,
  set: () => {
    /* readonly */
  },
});

const statusLabel = computed(() => {
  const r = props.response;
  if (!r) return '';
  if (r.status === 0) return r.errorMessage ?? 'Error';
  return `${r.status} ${r.statusText}`.trim();
});

const requestHeaders = computed<Header[]>(
  () => props.response?.requestHeaders ?? [],
);

const unresolvedVars = computed<string[]>(() => {
  const r = props.response;
  if (!r) return [];
  const names = new Set<string>();
  for (const n of extractTokenNames(r.requestUrl ?? '')) names.add(n);
  for (const h of requestHeaders.value) {
    for (const n of extractTokenNames(h.key)) names.add(n);
    for (const n of extractTokenNames(h.value)) names.add(n);
  }
  return [...names];
});

const testStats = computed(() => {
  const total = props.testResults.length;
  const pass = props.testResults.filter((t) => t.pass).length;
  return { total, pass, fail: total - pass };
});

const hasScriptOutput = computed(
  () =>
    props.testResults.length > 0 ||
    props.scriptLogs.length > 0 ||
    !!props.scriptError,
);

// When a new run arrives: if any test failed or the script errored, jump to
// the Tests panel automatically — the user almost certainly wants to see why.
// If tests ran and all passed, leave them on Body (the status-bar chip tells
// them tests succeeded).
watch(
  () => props.response,
  (r, prev) => {
    if (!r || r === prev) return;
    if (props.scriptError || testStats.value.fail > 0) {
      activeTab.value = 'scripts';
    }
  },
);

function showTests() {
  if (hasScriptOutput.value) activeTab.value = 'scripts';
}

async function copyBody() {
  if (!props.response) return;
  try {
    await navigator.clipboard.writeText(props.response.body);
  } catch {
    /* ignore */
  }
}

async function copyHeaders(headers: Header[]) {
  const text = headers.map((h) => `${h.key}: ${h.value}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="response">
    <div v-if="running && !response" class="placeholder">Running…</div>
    <div v-else-if="!response" class="placeholder">Send a request to see the response here.</div>
    <template v-else>
      <!-- When the request never completed (status 0), foreground the
           error + hint so the user has something actionable instead of
           just a status tag in the bar. The body / headers tabs below
           are empty in this case anyway. -->
      <div v-if="response.status === 0" class="error-banner">
        <div class="error-title">
          <i class="pi pi-exclamation-triangle" />
          Request failed
        </div>
        <div class="error-detail">
          {{ response.errorMessage || 'No detail surfaced. Open DevTools (right-click → Inspect → Console) for the raw error.' }}
        </div>
        <div v-if="response.errorHint" class="error-hint">
          <i class="pi pi-info-circle" />
          {{ response.errorHint }}
        </div>
      </div>
      <div class="status-bar">
        <Tag :value="statusLabel" :severity="statusSeverity(response.status)" />
        <span class="meta">
          <i class="pi pi-clock" /> {{ formatDuration(response.durationMs) }}
        </span>
        <span class="meta">
          <i class="pi pi-database" /> {{ formatBytes(response.sizeBytes) }}
        </span>
        <span v-if="response.contentType" class="meta ct">{{ response.contentType }}</span>
        <button
          v-if="testStats.total"
          class="meta test-meta"
          :class="{ fail: testStats.fail > 0 }"
          type="button"
          :title="`${testStats.pass} passed, ${testStats.fail} failed — click to view`"
          @click="showTests"
        >
          <i :class="testStats.fail > 0 ? 'pi pi-times-circle' : 'pi pi-check-circle'" />
          {{ testStats.pass }}/{{ testStats.total }} tests
        </button>
        <button
          v-else-if="scriptError"
          class="meta test-meta fail"
          type="button"
          title="Script error — click to view"
          @click="showTests"
        >
          <i class="pi pi-exclamation-triangle" /> script error
        </button>
        <div class="spacer" />
      </div>

      <Tabs v-model:value="activeTab" class="r-tabs">
        <TabList>
          <Tab value="body">Body</Tab>
          <Tab value="headers">Response ({{ response.headers.length }})</Tab>
          <Tab value="request">
            Request ({{ requestHeaders.length }})
            <i
              v-if="unresolvedVars.length"
              class="pi pi-exclamation-triangle warn-ind"
              title="Some variables were not resolved"
            />
          </Tab>
          <Tab v-if="hasScriptOutput" value="scripts">
            <span v-if="testStats.total">
              Tests ({{ testStats.pass }}/{{ testStats.total }})
            </span>
            <span v-else>Logs</span>
            <span
              v-if="testStats.fail > 0"
              class="fail-badge"
              :title="`${testStats.fail} failed`"
            >{{ testStats.fail }}</span>
            <i
              v-else-if="scriptError"
              class="pi pi-exclamation-triangle warn-ind"
              title="Script error"
            />
          </Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="body">
            <div class="body-controls">
              <Button
                :severity="bodyView === 'pretty' ? 'primary' : 'secondary'"
                :text="bodyView !== 'pretty'"
                size="small"
                label="Pretty"
                :disabled="!isJson"
                @click="bodyView = 'pretty'"
              />
              <Button
                :severity="bodyView === 'raw' ? 'primary' : 'secondary'"
                :text="bodyView !== 'raw'"
                size="small"
                label="Raw"
                @click="bodyView = 'raw'"
              />
              <div class="spacer" />
              <Button
                icon="pi pi-copy"
                text
                size="small"
                severity="secondary"
                title="Copy body"
                @click="copyBody"
              />
            </div>
            <CodeEditor
              :model-value="bodyModel"
              :language="bodyView === 'pretty' ? bodyLanguage : 'text'"
              readonly
              min-height="280px"
            />
          </TabPanel>

          <TabPanel value="headers">
            <div class="panel-controls">
              <span class="panel-subtitle">Headers received from the server</span>
              <div class="spacer" />
              <Button
                icon="pi pi-copy"
                text
                size="small"
                severity="secondary"
                title="Copy"
                @click="copyHeaders(response.headers)"
              />
            </div>
            <table v-if="response.headers.length" class="headers-table">
              <thead>
                <tr><th>Name</th><th>Value</th></tr>
              </thead>
              <tbody>
                <tr v-for="(h, i) in response.headers" :key="i">
                  <td class="hk">{{ h.key }}</td>
                  <td class="hv">{{ h.value }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">No response headers.</p>
          </TabPanel>

          <TabPanel value="request">
            <Message
              v-if="unresolvedVars.length"
              severity="warn"
              :closable="false"
              class="unresolved-msg"
            >
              <div>
                <strong>Unresolved variable{{ unresolvedVars.length > 1 ? 's' : '' }}:</strong>
                <code v-for="n in unresolvedVars" :key="n" class="varname">{{ n }}</code>
              </div>
              <div class="hint">
                Define these in the environment picker (top-right gear) or on
                a parent collection's Variables tab. Check for typos / case,
                and make sure an environment is selected.
              </div>
            </Message>

            <div class="request-summary">
              <span class="req-method">{{ response.requestMethod }}</span>
              <span class="req-url">{{ response.requestUrl }}</span>
              <div class="spacer" />
              <Button
                icon="pi pi-copy"
                text
                size="small"
                severity="secondary"
                title="Copy headers"
                @click="copyHeaders(requestHeaders)"
              />
            </div>
            <p class="muted">
              The headers below are what was actually sent — variables resolved,
              auth applied, body content-type added.
            </p>
            <table v-if="requestHeaders.length" class="headers-table">
              <thead>
                <tr><th>Name</th><th>Value</th></tr>
              </thead>
              <tbody>
                <tr v-for="(h, i) in requestHeaders" :key="i">
                  <td class="hk">{{ h.key }}</td>
                  <td class="hv">{{ h.value }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">No request headers captured.</p>
          </TabPanel>

          <TabPanel v-if="hasScriptOutput" value="scripts">
            <Message
              v-if="scriptError"
              severity="error"
              :closable="false"
              class="script-err"
            >
              Script error: {{ scriptError }}
            </Message>

            <div v-if="testResults.length" class="tests">
              <div class="tests-header">
                <span class="panel-subtitle">Tests</span>
                <span class="tests-count">
                  <span class="pass">{{ testStats.pass }} passed</span>
                  <span v-if="testStats.fail" class="fail">{{ testStats.fail }} failed</span>
                </span>
              </div>
              <ul class="test-list">
                <li
                  v-for="(t, i) in testResults"
                  :key="i"
                  :class="{ pass: t.pass, fail: !t.pass }"
                >
                  <div class="test-row">
                    <i :class="t.pass ? 'pi pi-check' : 'pi pi-times'" class="test-ic" />
                    <span class="test-name">{{ t.name }}</span>
                  </div>
                  <div v-if="!t.pass && t.message" class="test-msg">{{ t.message }}</div>
                </li>
              </ul>
            </div>

            <div v-if="scriptLogs.length" class="logs">
              <div class="logs-header">
                <span class="panel-subtitle">Script output</span>
              </div>
              <pre class="log-output">{{ scriptLogs.join('\n') }}</pre>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </template>
  </div>
</template>

<style scoped>
.response {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.placeholder {
  padding: 1rem;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.9rem;
}
.error-banner {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: rgba(220, 38, 38, 0.08);
  border-bottom: 1px solid rgba(220, 38, 38, 0.25);
  color: var(--p-text-color, inherit);
}
.error-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  font-size: 0.95rem;
  color: #dc2626;
}
.error-detail {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.85rem;
  word-break: break-word;
  white-space: pre-wrap;
}
.error-hint {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  background: var(--p-content-background, rgba(255, 255, 255, 0.5));
  border-radius: 4px;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--p-text-color, inherit);
}
.error-hint .pi {
  color: var(--p-primary-color, #3b82f6);
  margin-top: 0.15rem;
  flex-shrink: 0;
}
.status-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--p-content-border-color, #e5e7eb);
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  font-size: 0.82rem;
}
.meta {
  color: var(--p-text-muted-color, #6b7280);
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.meta.ct {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.75rem;
}
.test-meta {
  color: #16a34a;
  background: rgba(22, 163, 74, 0.1);
  border: none;
  cursor: pointer;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  font-size: 0.78rem;
  font-weight: 500;
}
.test-meta:hover {
  background: rgba(22, 163, 74, 0.18);
}
.test-meta.fail {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.1);
}
.test-meta.fail:hover {
  background: rgba(220, 38, 38, 0.18);
}
.spacer {
  flex: 1;
}
.r-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/*
 * Same flex-chain fix as RequestEditor's .ed-tabs — body / headers
 * / cookies panels in a long response would otherwise overflow the
 * SplitterPanel and the bottom of the response (and the test-results
 * footer) got clipped invisibly. min-height: 0 unblocks overflow-y
 * inside the flex column.
 */
.r-tabs :deep(.p-tabpanels) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.r-tabs :deep(.p-tabpanel) {
  height: auto;
}
.warn-ind {
  color: #ca8a04;
  margin-left: 0.35rem;
  font-size: 0.75rem;
}
.fail-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #dc2626;
  color: white;
  border-radius: 999px;
  font-size: 0.65rem;
  min-width: 1.1rem;
  height: 1.1rem;
  padding: 0 0.3rem;
  margin-left: 0.35rem;
  font-weight: 700;
}
.unresolved-msg {
  margin: 0.5rem 0;
  font-size: 0.82rem;
}
.unresolved-msg .varname {
  background: rgba(250, 204, 21, 0.15);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.8rem;
  margin: 0 0.2rem;
}
.unresolved-msg .varname::before {
  content: '{{';
  color: var(--p-text-muted-color, #9ca3af);
}
.unresolved-msg .varname::after {
  content: '}}';
  color: var(--p-text-muted-color, #9ca3af);
}
.unresolved-msg .hint {
  margin-top: 0.4rem;
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #6b7280);
}
.body-controls,
.panel-controls {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4rem 0;
}
.panel-subtitle {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.78rem;
}
.request-summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0;
  font-size: 0.82rem;
}
.req-method {
  font-weight: 700;
  font-size: 0.72rem;
  color: var(--p-primary-600, #2563eb);
  text-transform: uppercase;
}
.req-url {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.8rem;
  word-break: break-all;
  color: var(--p-text-color, #111827);
}
.muted {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.78rem;
  margin: 0.25rem 0 0.5rem;
}
.headers-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.headers-table th,
.headers-table td {
  text-align: left;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color, #e5e7eb);
  vertical-align: top;
}
.headers-table th {
  font-weight: 600;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.hk {
  font-family: 'SF Mono', Consolas, monospace;
  white-space: nowrap;
}
.hv {
  font-family: 'SF Mono', Consolas, monospace;
  word-break: break-all;
}
.script-err {
  margin: 0.5rem 0;
  font-size: 0.82rem;
}
.tests,
.logs {
  margin-top: 0.5rem;
}
.tests-header,
.logs-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0;
}
.tests-count {
  display: flex;
  gap: 0.5rem;
  font-size: 0.8rem;
}
.tests-count .pass {
  color: #16a34a;
}
.tests-count .fail {
  color: #dc2626;
}
.test-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.test-list li {
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color, #f3f4f6);
  font-size: 0.82rem;
}
.test-list li .test-row {
  display: flex;
  align-items: center;
}
.test-list li .test-ic {
  font-size: 0.7rem;
  margin-right: 0.4rem;
}
.test-list li.pass .test-ic { color: #16a34a; }
.test-list li.fail .test-ic { color: #dc2626; }
.test-list li.fail .test-name { color: #dc2626; }
.test-list li .test-msg {
  margin-left: 1.1rem;
  margin-top: 0.2rem;
  color: var(--p-text-muted-color, #6b7280);
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.75rem;
  white-space: pre-wrap;
}
.log-output {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--p-content-hover-background, #f9fafb);
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
}
</style>
