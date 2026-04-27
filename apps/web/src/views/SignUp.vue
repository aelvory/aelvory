<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Message from 'primevue/message';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const email = ref('');
const name = ref('');
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function onSubmit() {
  if (busy.value) return;
  error.value = null;
  busy.value = true;
  try {
    await auth.signUp(email.value, password.value, name.value || email.value);
    router.push('/');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'sign_up_failed';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth-shell">
    <form class="auth-card" @submit.prevent="onSubmit">
      <h1 class="brand">Create account</h1>
      <p class="muted">
        Sign up to manage members and projects across your devices.
      </p>

      <label class="field-label" for="email">Email</label>
      <InputText
        id="email"
        v-model="email"
        type="email"
        autocomplete="email"
        required
      />

      <label class="field-label" for="name">Display name</label>
      <InputText id="name" v-model="name" />

      <label class="field-label" for="password">Password</label>
      <Password
        v-model="password"
        :feedback="true"
        toggle-mask
        required
        :input-style="{ width: '100%' }"
        style="width: 100%"
      />

      <Message
        v-if="error"
        severity="error"
        :closable="false"
        class="msg"
      >{{ error }}</Message>

      <Button
        type="submit"
        label="Create account"
        :loading="busy"
        class="primary-cta"
      />

      <p class="muted small">
        Already have an account?
        <RouterLink to="/signin">Sign in</RouterLink>
      </p>
    </form>
  </div>
</template>

<style scoped>
.auth-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
}
.auth-card {
  width: 100%;
  max-width: 380px;
  background: var(--p-surface-0, white);
  border: 1px solid var(--p-surface-border, #e5e7eb);
  border-radius: 8px;
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
.brand { margin: 0; font-size: 1.4rem; font-weight: 600; }
.muted {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.9rem;
}
.muted.small { font-size: 0.82rem; margin-top: 0.5rem; }
.field-label {
  font-size: 0.85rem;
  font-weight: 500;
  margin-top: 0.5rem;
}
.msg { margin-top: 0.5rem; font-size: 0.82rem; }
.primary-cta { margin-top: 0.75rem; }
a {
  color: var(--p-primary-500, #3b82f6);
  text-decoration: none;
}
a:hover { text-decoration: underline; }
</style>
