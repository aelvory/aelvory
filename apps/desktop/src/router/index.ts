import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
    },
  ],
});

// Guard: default to a silent local session. Only redirect to the login page if
// we truly can't establish a session (e.g. backend unreachable). Users can still
// visit /login explicitly to sign into a non-local account.
router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (to.name === 'login') {
    return auth.isAuthenticated ? { name: 'home' } : true;
  }

  if (!auth.isAuthenticated) {
    const ok = await auth.ensureSession();
    if (!ok) return { name: 'login' };
  }

  return true;
});
