<script setup lang="ts">
import { computed, ref } from 'vue';
import Select from 'primevue/select';
import Button from 'primevue/button';
import EnvironmentsDialog from './EnvironmentsDialog.vue';
import { useEnvironmentsStore } from '@/stores/environments';

const environments = useEnvironmentsStore();
const manageOpen = ref(false);

const options = computed(() => [
  { label: 'No environment', value: null as string | null },
  ...environments.environments.map((e) => ({ label: e.name, value: e.id })),
]);

const selected = computed({
  get: () => environments.activeEnvId,
  set: (v) => environments.setActiveEnvironment(v),
});
</script>

<template>
  <div class="env-picker-wrap">
    <Select
      v-if="environments.environments.length"
      v-model="selected"
      :options="options"
      option-label="label"
      option-value="value"
      placeholder="No environment"
      size="small"
      class="env-picker"
    />
    <Button
      icon="pi pi-sliders-h"
      text
      size="small"
      severity="secondary"
      :label="environments.environments.length ? undefined : 'Environments'"
      :title="environments.environments.length ? 'Manage environments' : undefined"
      aria-label="Manage environments"
      @click="manageOpen = true"
    />
    <EnvironmentsDialog v-model="manageOpen" />
  </div>
</template>

<style scoped>
.env-picker-wrap {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.env-picker {
  min-width: 180px;
}
</style>
