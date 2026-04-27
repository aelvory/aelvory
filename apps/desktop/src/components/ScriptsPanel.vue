<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import CodeEditor from './CodeEditor.vue';

const { t } = useI18n();

const pre = defineModel<string>('pre', { required: true });
const post = defineModel<string>('post', { required: true });

const active = ref<'pre' | 'post'>('pre');

const preSnippet = `// Pre-request: runs before the HTTP call.
// aelvory.env.set('ts', Date.now());
// aelvory.console.log('sending with token', aelvory.env.get('token'));
`;

const postSnippet = `// Tests / post-response: runs after the response arrives.
// aelvory.test('status is 200', () => {
//   aelvory.expect(aelvory.response.status).toBe(200);
// });
//
// const body = aelvory.response.json();
// aelvory.env.set('lastId', body?.id);
`;

const preHasDefault = computed(() => !pre.value?.trim());
const postHasDefault = computed(() => !post.value?.trim());

// Marker dot next to the tab label when the script body has any
// non-whitespace, non-comment-only content. Comment-only scripts are
// effectively inert at runtime, so we don't dot them — keeps the UI
// honest about which tabs actually do something at request time.
const preHasActive = computed(() => hasExecutableCode(pre.value));
const postHasActive = computed(() => hasExecutableCode(post.value));

function hasExecutableCode(src: string | undefined | null): boolean {
  if (!src) return false;
  // Strip line comments, block comments, and whitespace, then check
  // if anything's left. Doesn't handle every edge case (e.g. comments
  // inside template literals look like code) but the false-positive
  // is fine — at worst we show a dot when the body is "active".
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim();
  return stripped.length > 0;
}

function seedPre() {
  if (preHasDefault.value) pre.value = preSnippet;
}

function seedPost() {
  if (postHasDefault.value) post.value = postSnippet;
}
</script>

<template>
  <div class="scripts-panel">
    <Tabs v-model:value="active" class="scripts-tabs">
      <TabList>
        <Tab value="pre">
          {{ t('scripts.preRequest') }}
          <span v-if="preHasActive" class="active-dot" :title="t('scripts.activeIndicator')" />
        </Tab>
        <Tab value="post">
          {{ t('scripts.postResponse') }}
          <span v-if="postHasActive" class="active-dot" :title="t('scripts.activeIndicator')" />
        </Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="pre">
          <p class="help">
            Runs before the request is sent. Use <code>aelvory.env.set(k, v)</code>
            to stash values for later requests (persisted to the active
            environment), <code>aelvory.console.log(...)</code> to print.
          </p>
          <button v-if="preHasDefault" class="snippet-btn" @click="seedPre">
            Insert example
          </button>
          <CodeEditor v-model="pre" language="javascript" min-height="240px" />
        </TabPanel>
        <TabPanel value="post">
          <p class="help">
            Runs after the response. Read via <code>aelvory.response</code>,
            assert with <code>aelvory.test(name, fn)</code> +
            <code>aelvory.expect(v).toBe(x)</code>, save values with
            <code>aelvory.env.set(k, v)</code>.
          </p>
          <button v-if="postHasDefault" class="snippet-btn" @click="seedPost">
            Insert example
          </button>
          <CodeEditor v-model="post" language="javascript" min-height="240px" />
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.scripts-panel {
  padding: 0.5rem 0;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.scripts-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.active-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--p-primary-color, #3b82f6);
  margin-left: 0.4rem;
  vertical-align: middle;
}
.help {
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.8rem;
  margin: 0.4rem 0;
}
.help code {
  background: var(--p-content-hover-background, #f3f4f6);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
  font-size: 0.78rem;
}
.snippet-btn {
  background: transparent;
  border: 1px dashed var(--p-content-border-color, #d1d5db);
  color: var(--p-text-muted-color, #6b7280);
  padding: 0.25rem 0.5rem;
  border-radius: 3px;
  font-size: 0.76rem;
  cursor: pointer;
  margin-bottom: 0.5rem;
}
.snippet-btn:hover {
  background: var(--p-content-hover-background, #f3f4f6);
  color: var(--p-text-color, #111827);
}
</style>
