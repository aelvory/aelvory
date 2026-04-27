import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
} from 'vue-router';
import { useAuthStore } from '@/stores/auth';

/**
 * Routes are split into "guest" (signin / signup) and "authed"
 * (everything under AdminLayout). The global beforeEach guard
 * redirects between them so a fresh load always lands somewhere
 * sensible.
 *
 * `base: '/app/'` matches Caddy's `handle_path /app/*` routing in
 * production and `vite.config.ts`'s base in dev — see vite.config.ts.
 */
const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    {
      path: '/signin',
      name: 'signin',
      component: () => import('@/views/SignIn.vue'),
      meta: { guest: true },
    },
    {
      path: '/signup',
      name: 'signup',
      component: () => import('@/views/SignUp.vue'),
      meta: { guest: true },
    },
    {
      path: '/',
      component: () => import('@/layouts/AdminLayout.vue'),
      children: [
        // Landing under the layout — the layout itself redirects to the
        // first org's members page once orgs are loaded. See AdminLayout.
        {
          path: '',
          name: 'home',
          component: () => import('@/views/Home.vue'),
        },
        {
          path: 'orgs/:orgId/members',
          name: 'org-members',
          component: () => import('@/views/OrgMembers.vue'),
          props: true,
        },
        {
          path: 'orgs/:orgId/projects',
          name: 'org-projects',
          component: () => import('@/views/OrgProjects.vue'),
          props: true,
        },
        {
          path: 'orgs/:orgId/projects/:projectId/members',
          name: 'project-members',
          component: () => import('@/views/ProjectMembers.vue'),
          props: true,
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

router.beforeEach((to: RouteLocationNormalized) => {
  const auth = useAuthStore();
  const isGuest = to.matched.some((r) => r.meta.guest === true);

  if (!auth.isAuthenticated && !isGuest) {
    return { name: 'signin', query: { next: to.fullPath } };
  }
  if (auth.isAuthenticated && isGuest) {
    return { path: '/' };
  }
  return true;
});

export { router };
