<script setup lang="ts">
import { RouterView } from 'vue-router';
import ConfirmDialog from 'primevue/confirmdialog';
import Toast from 'primevue/toast';
</script>

<template>
  <RouterView />
  <ConfirmDialog />
  <Toast position="bottom-right" />
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  background: var(--p-surface-50, #f9fafb);
}
</style>
