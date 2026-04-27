<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useOrgsStore } from '@/stores/orgs';

/**
 * Empty landing page for `/`. As soon as we know the user's orgs,
 * route to the first one's members page. If they have no orgs,
 * fall through to a small "create one" pitch — for now we just
 * point them at the desktop app, since that's where org creation
 * lives. (Web-side org creation can come later.)
 */

const router = useRouter();
const orgs = useOrgsStore();

/**
 * Redirect ONLY after the orgs list has finished loading from the
 * server. Without this guard, a stale `aelvory.web.currentOrg` in
 * localStorage (from a previous account, or a server-side DB reset)
 * sends us to `/orgs/<dead-orgId>/members` — which 403s because the
 * current user isn't a member of that org. `orgs.load()` reconciles
 * the stale id (drops it and picks the first valid org) — we just
 * have to wait for it.
 */
function redirectIfReady() {
  if (!orgs.loaded) return;
  if (orgs.currentOrgId) {
    router.replace({ name: 'org-members', params: { orgId: orgs.currentOrgId } });
  }
}

onMounted(redirectIfReady);
watch([() => orgs.loaded, () => orgs.currentOrgId], redirectIfReady);
</script>

<template>
  <div class="empty">
    <h2>Welcome</h2>
    <p v-if="!orgs.loaded">Loading your organizations…</p>
    <template v-else-if="orgs.orgs.length === 0">
      <p>
        You're not a member of any organization yet.
      </p>
      <p>
        Create one in the Aelvory desktop app, then come back here to
        invite teammates and manage access.
      </p>
    </template>
  </div>
</template>

<style scoped>
.empty {
  max-width: 600px;
}
.empty h2 {
  margin: 0 0 0.5rem;
}
.empty p {
  color: var(--p-text-muted-color, #6b7280);
}
</style>
