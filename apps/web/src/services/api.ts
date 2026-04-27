/**
 * Tiny fetch wrapper for the admin API. Adds the bearer token from the
 * auth store, parses JSON, surfaces non-2xx responses as `ApiError`.
 *
 * Same-origin in production (Caddy serves /app and proxies /api to the
 * .NET server). Same-origin in dev too (Vite proxy in vite.config.ts).
 * No CORS handling needed in either case.
 */

import { useAuthStore } from '@/stores/auth';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const auth = useAuthStore();
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };
  if (auth.accessToken) headers['authorization'] = `Bearer ${auth.accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });

  if (res.status === 401) {
    // Try a refresh once. If that works, retry the original request.
    if (await auth.tryRefresh()) {
      return api(path, opts);
    }
    auth.signOut();
    throw new ApiError(401, null, 'unauthorized');
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body, `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
