/**
 * Vite config for the admin SPA.
 *
 * Production: this app is served by Caddy at /app/ (see apps/web/Caddyfile),
 * so `base: '/app/'` matches what Vue Router expects.
 *
 * Dev: Vite serves on port 5174 and proxies /api/* + /hubs/* to the
 * API server. Default proxy target is http://localhost:5000 (running
 * `dotnet run` directly on the host). Set `VITE_API_TARGET` to
 * override — the dev compose sets it to `http://server:5000` so the
 * proxy reaches the API service over the compose network instead of
 * out to the host.
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:5000';

  return {
    plugins: [vue()],
    base: '/app/',
    server: {
      // host: '0.0.0.0' so the docker port-mapping reaches us. Harmless
      // when running directly from the host.
      host: '0.0.0.0',
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/hubs': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  };
});
