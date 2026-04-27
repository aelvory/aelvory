<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Button from 'primevue/button';
import Message from 'primevue/message';

const auth = useAuthStore();
const router = useRouter();

const mode = ref<'login' | 'register'>('login');
const email = ref('');
const password = ref('');
const displayName = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
const retrying = ref(false);

async function submit() {
  error.value = null;
  busy.value = true;
  try {
    if (mode.value === 'login') {
      await auth.login(email.value, password.value);
    } else {
      await auth.register(email.value, password.value, displayName.value);
    }
    router.push('/');
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'unknown_error';
  } finally {
    busy.value = false;
  }
}

async function retryLocal() {
  retrying.value = true;
  try {
    const ok = await auth.ensureSession();
    if (ok) router.push('/');
  } finally {
    retrying.value = false;
  }
}

onMounted(() => {
  // If we landed here because ensureSession failed, show that error to the user.
  if (auth.bootstrapError) {
    error.value = `Couldn't reach the backend (${auth.bootstrapError}). Make sure it's running.`;
  }
});
</script>

<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="submit">
      <h1>Aelvory</h1>
      <p class="muted">
        Normally you don't need to sign in &mdash; this app runs with a local
        anonymous account by default. Use this form only to switch to a specific
        account or recover one.
      </p>

      <label>Email</label>
      <InputText v-model="email" type="email" autocomplete="email" required />

      <template v-if="mode === 'register'">
        <label>Display name</label>
        <InputText v-model="displayName" required />
      </template>

      <label>Password</label>
      <Password
        v-model="password"
        :feedback="mode === 'register'"
        toggle-mask
        :input-style="{ width: '100%' }"
        style="width: 100%"
        required
      />

      <Message v-if="error" severity="error" :closable="false" class="err">
        {{ error }}
      </Message>

      <Button
        type="submit"
        :label="mode === 'login' ? 'Sign in' : 'Register'"
        :loading="busy"
      />
      <Button
        type="button"
        text
        size="small"
        :label="mode === 'login' ? 'Need an account? Register' : 'Back to sign in'"
        @click="mode = mode === 'login' ? 'register' : 'login'"
      />
      <div class="retry">
        <Button
          type="button"
          text
          size="small"
          severity="secondary"
          icon="pi pi-refresh"
          label="Retry local auto-login"
          :loading="retrying"
          @click="retryLocal"
        />
      </div>
    </form>
  </div>
</template>

<style scoped>
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--p-content-hover-background, #f9fafb);
}
.login-card {
  width: 400px;
  background: var(--p-content-background, white);
  padding: 2rem;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.login-card h1 {
  margin: 0;
  font-size: 1.25rem;
}
.muted {
  color: var(--p-text-muted-color, #6b7280);
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  line-height: 1.4;
}
label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #6b7280);
  margin-top: 0.4rem;
}
.err {
  margin-top: 0.5rem;
}
.retry {
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--p-content-border-color, #e5e7eb);
  display: flex;
  justify-content: center;
}
</style>
