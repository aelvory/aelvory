<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import { isTauriEnv } from '@/runtime/environment';

const { t } = useI18n();

const visible = defineModel<boolean>({ required: true });

// Read the app version once at first open. We pull it from Tauri's
// runtime API so it reflects the bumped build number from build.mjs,
// not the static value in package.json.
const version = ref<string | null>(null);

watch(visible, async (open) => {
  if (!open || version.value !== null) return;
  if (!isTauriEnv()) {
    version.value = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev';
    return;
  }
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    version.value = await getVersion();
  } catch {
    version.value = 'unknown';
  }
});

/**
 * Open external URLs through Tauri's opener plugin in the desktop
 * build (so the OS's default browser handles it instead of trying
 * to navigate the webview itself), and fall back to a plain anchor
 * click in the VSCode webview / browser.
 */
async function openExternal(url: string) {
  if (isTauriEnv()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      /* fall through */
    }
  }
  // VSCode webview blocks `window.open`; instead, posting a `command`
  // message to the host with `vscode.open` works — but for simplicity
  // here we just create a transient anchor and click it; VSCode's
  // webview intercepts http(s) navigations and opens externally.
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Open-source projects we lean on directly. Listed by the package
 * name users would find on npm/crates/PyPI plus a one-line role
 * description and the license. Transitive deps not enumerated —
 * the full tree is in the lockfiles for anyone auditing.
 */
interface OssEntry {
  name: string;
  url: string;
  role: string;
  license: string;
}

const ossList: OssEntry[] = [
  { name: 'Vue 3', url: 'https://vuejs.org', role: 'UI framework', license: 'MIT' },
  { name: 'Pinia', url: 'https://pinia.vuejs.org', role: 'state management', license: 'MIT' },
  { name: 'PrimeVue', url: 'https://primevue.org', role: 'UI components + Aura theme', license: 'MIT' },
  { name: 'Vue Router', url: 'https://router.vuejs.org', role: 'routing', license: 'MIT' },
  { name: 'vue-i18n', url: 'https://vue-i18n.intlify.dev', role: 'localisation', license: 'MIT' },
  { name: 'CodeMirror 6', url: 'https://codemirror.net', role: 'in-app code editing', license: 'MIT' },
  { name: 'TanStack Query', url: 'https://tanstack.com/query', role: 'async state', license: 'MIT' },
  { name: 'Tauri 2', url: 'https://tauri.app', role: 'desktop shell (Rust)', license: 'MIT / Apache-2.0' },
  { name: 'sql.js', url: 'https://sql.js.org', role: 'WebAssembly SQLite (VSCode build)', license: 'MIT' },
  { name: 'ws', url: 'https://github.com/websockets/ws', role: 'WebSocket proxy (VSCode build)', license: 'MIT' },
  { name: '@noble/ciphers, @noble/hashes', url: 'https://paulmillr.com/noble/', role: 'cryptography', license: 'MIT' },
  { name: 'libsodium', url: 'https://libsodium.org', role: 'cryptography (E2EE)', license: 'ISC' },
  { name: 'better-sqlite3', url: 'https://github.com/WiseLibs/better-sqlite3', role: 'SQLite via plugin-sql (Tauri build)', license: 'MIT' },
  { name: '.NET, ASP.NET Core, EF Core', url: 'https://dot.net', role: 'sync server', license: 'MIT' },
  { name: 'PostgreSQL', url: 'https://www.postgresql.org', role: 'sync server database', license: 'PostgreSQL License' },
  { name: 'Redis', url: 'https://redis.io', role: 'sync server cache', license: 'BSD-3-Clause' },
];
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="t('about.title')"
    :style="{ width: '560px' }"
  >
    <div class="about-body">
      <h2>{{ t('app.name') }}</h2>
      <p class="tagline">{{ t('app.tagline') }}</p>

      <dl class="meta">
        <dt>{{ t('about.version') }}</dt>
        <dd>{{ version ?? '…' }}</dd>
        <dt>{{ t('about.source') }}</dt>
        <dd>
          <a href="#" @click.prevent="openExternal('https://github.com/aelvory')">github.com/aelvory</a>
        </dd>
      </dl>

      <section class="block">
        <h3>{{ t('about.creditsTitle') }}</h3>
        <p class="block-line">{{ t('about.creditsDeveloper') }}</p>
        <p class="block-line">{{ t('about.creditsCompany') }}</p>
      </section>

      <section class="block">
        <h3>{{ t('about.ossTitle') }}</h3>
        <p class="block-intro">{{ t('about.ossIntro') }}</p>
        <ul class="oss-list">
          <li v-for="o in ossList" :key="o.name">
            <a href="#" @click.prevent="openExternal(o.url)">{{ o.name }}</a>
            — <span class="oss-role">{{ o.role }}</span>
            <span class="oss-license">({{ o.license }})</span>
          </li>
        </ul>
      </section>

      <section class="block disclaimer">
        <h3>{{ t('about.disclaimerTitle') }}</h3>
        <p class="block-intro">{{ t('about.disclaimerBody') }}</p>
      </section>
    </div>

    <template #footer>
      <Button :label="t('common.close')" @click="visible = false" />
    </template>
  </Dialog>
</template>

<style scoped>
.about-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.25rem 0.25rem 0;
  max-height: 70vh;
  overflow-y: auto;
}
h2 {
  margin: 0;
  font-size: 1.25rem;
}
.tagline {
  margin: 0;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.9rem;
}
.meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 0.75rem;
  row-gap: 0.3rem;
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
}
dt {
  color: var(--p-text-muted-color, #6b7280);
}
dd {
  margin: 0;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.82rem;
}
.block {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--p-content-border-color, #e5e7eb);
}
.block h3 {
  margin: 0 0 0.4rem;
  font-size: 0.95rem;
  font-weight: 600;
}
.block-line {
  margin: 0.1rem 0;
  font-size: 0.85rem;
}
.block-intro {
  margin: 0 0 0.4rem;
  font-size: 0.82rem;
  color: var(--p-text-muted-color, #6b7280);
  line-height: 1.45;
}
.oss-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.82rem;
}
.oss-role {
  color: var(--p-text-muted-color, #6b7280);
}
.oss-license {
  margin-left: 0.25rem;
  color: var(--p-text-muted-color, #9ca3af);
  font-size: 0.78rem;
}
.disclaimer .block-intro {
  /* Disclaimers should be readable, not muted-into-irrelevance. */
  color: var(--p-text-color, inherit);
}
a {
  color: var(--p-primary-color, #3b82f6);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
</style>
