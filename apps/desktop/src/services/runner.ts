import type {
  ApiRequest,
  AuthConfig,
  Collection,
  ExecuteResponse,
  Header,
  Variable,
} from '@aelvory/core';
import { isTauriEnv, isVSCodeEnv } from '@/api/mode';
import { useSettingsStore } from '@/stores/settings';
import {
  effectiveAuth,
  mergeVariables,
  resolveRequest,
  type VariableContext,
} from './variables';

export interface ExecuteContext {
  envVars: VariableContext;
  ancestorChain: Collection[];
  variablesByCollection: Record<string, Variable[]>;
}

export async function execute(
  request: ApiRequest,
  ctx: ExecuteContext,
): Promise<ExecuteResponse> {
  const ancestorVarsTopDown = ctx.ancestorChain.map(
    (c) => ctx.variablesByCollection[c.id] ?? [],
  );
  const vars = mergeVariables(ctx.envVars, ancestorVarsTopDown);

  const withInheritedAuth: ApiRequest = {
    ...request,
    auth: effectiveAuth(request, ctx.ancestorChain),
  };
  const resolved = resolveRequest(withInheritedAuth, vars);

  try {
    if (isTauriEnv()) {
      return await executeViaTauri(resolved);
    }
    if (isVSCodeEnv()) {
      // The webview can't reach arbitrary origins directly — CORS
      // blocks any API that doesn't deliberately whitelist the
      // vscode-webview origin (i.e. nearly all of them). Route
      // through the extension host's Node fetch instead, which has
      // no CORS rules and matches Tauri's plugin-http behaviour.
      const { vsHttpFetch } = await import('@/services/vscodeBridge');
      return await executeViaFetch(resolved, vsHttpFetch);
    }
    return await executeViaFetch(resolved, fetch);
  } catch (err) {
    return {
      status: 0,
      statusText: '',
      headers: [],
      requestHeaders: resolved.headers.filter((h) => h.enabled !== false),
      requestUrl: resolved.url,
      requestMethod: resolved.method,
      body: '',
      durationMs: 0,
      sizeBytes: 0,
      contentType: null,
      errorMessage: err instanceof Error ? err.message : 'unknown_error',
    };
  }
}

function buildHeadersMap(request: ApiRequest): {
  headers: Record<string, string>;
  captured: Header[];
} {
  const out: Record<string, string> = {};
  const captured: Header[] = [];
  const seenLower = new Set<string>();

  for (const h of request.headers ?? []) {
    if (!h.enabled) continue;
    if (!h.key.trim()) continue;
    out[h.key] = h.value;
    seenLower.add(h.key.toLowerCase());
    captured.push({ key: h.key, value: h.value, enabled: true });
  }

  const auth = request.auth;
  if (auth) {
    const applied = authHeader(auth);
    if (applied) {
      out[applied.key] = applied.value;
      seenLower.add(applied.key.toLowerCase());
      captured.push({ key: applied.key, value: applied.value, enabled: true });
    }
  }

  if (request.body && request.body.type !== 'none' && request.body.raw) {
    const ct = request.body.contentType ?? 'application/json';
    if (!seenLower.has('content-type')) {
      out['Content-Type'] = ct;
      seenLower.add('content-type');
      captured.push({ key: 'Content-Type', value: ct, enabled: true });
    }
  }

  // Inject default User-Agent from settings unless the request already set one.
  const settings = useSettingsStore();
  const ua = settings.userAgent?.trim();
  if (ua && !seenLower.has('user-agent')) {
    out['User-Agent'] = ua;
    seenLower.add('user-agent');
    captured.push({ key: 'User-Agent', value: ua, enabled: true });
  }

  return { headers: out, captured };
}

function authHeader(auth: AuthConfig): { key: string; value: string } | null {
  if (!auth || !auth.type || auth.type === 'none') return null;
  const cfg = auth.config ?? {};
  if (auth.type === 'bearer') {
    const token = String(cfg.token ?? '').trim();
    return token ? { key: 'Authorization', value: `Bearer ${token}` } : null;
  }
  if (auth.type === 'basic') {
    const user = String(cfg.username ?? '');
    const pass = String(cfg.password ?? '');
    const encoded = btoa(`${user}:${pass}`);
    return { key: 'Authorization', value: `Basic ${encoded}` };
  }
  if (auth.type === 'apikey') {
    const key = String(cfg.key ?? '').trim();
    const value = String(cfg.value ?? '');
    const where = String(cfg.in ?? 'header');
    if (!key || where !== 'header') return null;
    return { key, value };
  }
  return null;
}

function buildBody(request: ApiRequest): string | undefined {
  if (!request.body || request.body.type === 'none' || !request.body.raw) {
    return undefined;
  }
  return request.body.raw;
}

async function executeViaTauri(request: ApiRequest): Promise<ExecuteResponse> {
  const { headers, captured } = buildHeadersMap(request);
  const body = buildBody(request);
  const settings = useSettingsStore();

  const start = performance.now();

  // Lazy-load the plugin so the module is valid in browser contexts where
  // it's not installed / not initialized.
  const { fetch: tFetch } = await import('@tauri-apps/plugin-http');

  const method = request.method.toUpperCase();
  const init: RequestInit & {
    maxRedirections?: number;
    connectTimeout?: number;
  } = {
    method,
    headers,
    maxRedirections: 5,
    connectTimeout: Math.min(settings.timeoutMs, 600_000),
  };
  // Some HTTP methods can't carry a body per Fetch spec.
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }

  const res = await tFetch(request.url, init);
  const duration = Math.round(performance.now() - start);

  const responseBody = await res.text();
  const resHeaders: Header[] = [];
  res.headers.forEach((value, key) => {
    resHeaders.push({ key, value, enabled: true });
  });

  return {
    status: res.status,
    statusText: res.statusText ?? '',
    headers: resHeaders,
    requestHeaders: captured,
    requestUrl: request.url,
    requestMethod: method,
    body: responseBody,
    durationMs: duration,
    sizeBytes: new Blob([responseBody]).size,
    contentType: res.headers.get('content-type'),
    errorMessage: null,
  };
}

async function executeViaFetch(
  request: ApiRequest,
  // Caller supplies the fetch implementation: native `fetch` in the
  // browser dev build, `vsHttpFetch` in the VSCode extension. Same
  // signature, same Response shape — the rest of this function is
  // transport-agnostic.
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ExecuteResponse> {
  const { headers, captured } = buildHeadersMap(request);
  const body = buildBody(request);

  const start = performance.now();
  const method = request.method.toUpperCase();

  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }

  const res = await fetchFn(request.url, init);
  const duration = Math.round(performance.now() - start);

  const responseBody = await res.text();
  const resHeaders: Header[] = [];
  res.headers.forEach((value, key) => {
    resHeaders.push({ key, value, enabled: true });
  });

  return {
    status: res.status,
    statusText: res.statusText ?? '',
    headers: resHeaders,
    requestHeaders: captured,
    requestUrl: request.url,
    requestMethod: method,
    body: responseBody,
    durationMs: duration,
    sizeBytes: new Blob([responseBody]).size,
    contentType: res.headers.get('content-type'),
    errorMessage: null,
  };
}

export function statusSeverity(
  status: number,
): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  if (status === 0) return 'danger';
  if (status < 300) return 'success';
  if (status < 400) return 'info';
  if (status < 500) return 'warn';
  return 'danger';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
