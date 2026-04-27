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
      const settings = useSettingsStore();
      const { vsHttpFetch } = await import('@/services/vscodeBridge');
      // Wrap so the `insecure` setting flows into every request via
      // the bridge init. The runner's `executeViaFetch` doesn't know
      // about this transport-specific flag and just hands url+init
      // to whatever fetcher we give it.
      const fetcher = (input: string, fInit?: RequestInit) =>
        vsHttpFetch(input, { ...fInit, insecure: settings.ignoreCerts });
      return await executeViaFetch(resolved, fetcher);
    }
    return await executeViaFetch(resolved, fetch);
  } catch (err) {
    // Dump the raw thrown value to DevTools — if `describeError`
    // can't pull a useful string out, the user can right-click the
    // app, "Inspect Element", Console tab, and see the original
    // shape (object structure, stack, anything we couldn't
    // serialise into the response panel).
    console.error('[runner] request failed:', resolved.method, resolved.url, err);
    const errorMessage = describeError(err);
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
      errorMessage,
      errorHint: hintForError(errorMessage, resolved.url),
    };
  }
}

/**
 * Squeeze every drop of detail out of whatever the transport threw.
 *
 * Tauri's plugin-http on Windows is a particularly bad citizen here:
 * it rejects with plain strings ("error sending request"), with
 * objects shaped like `{ kind: 'Network', message: '…' }`, and
 * occasionally with native serde-deserialised structs that don't
 * extend Error. Falling back to `'unknown_error'` (the previous
 * default) hid all of them.
 *
 * Order of fallbacks:
 *   1. native Error → name + message + nested cause
 *   2. plain string → use directly
 *   3. object with .message / .error / .reason → use that field
 *   4. JSON.stringify as last resort
 *   5. String() coercion if even that fails
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || err.name || 'Error';
    if ('cause' in err && err.cause) {
      return `${msg} (caused by: ${describeError(err.cause)})`;
    }
    return msg;
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.reason === 'string') return o.reason;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

/**
 * Map common transport error patterns to actionable hints. Patterns
 * are loose substring matches against the lowercased error text —
 * Tauri / Node / browser wording varies, but the underlying failure
 * modes are the same. Returns null when no specific guidance applies
 * (the error itself is then the only thing the user sees).
 */
function hintForError(errorMessage: string, url: string): string | null {
  const m = errorMessage.toLowerCase();
  const isHttps = url.toLowerCase().startsWith('https://');

  // TLS / certificate problems — common on Windows when hitting
  // self-signed dev servers or APIs whose CA isn't installed
  // system-wide. We have a Settings → "Ignore SSL certificate
  // errors" toggle for this; point at it.
  if (
    m.includes('certificate') ||
    m.includes('ssl') ||
    m.includes('tls') ||
    m.includes('self-signed') ||
    m.includes('self signed') ||
    m.includes('cert verif') ||
    m.includes('untrusted') ||
    m.includes('cert chain')
  ) {
    return 'TLS / certificate problem. If the target uses a self-signed cert or a corporate CA that isn\'t in Windows\' trust store, enable Settings → "Ignore SSL certificate errors" and retry.';
  }

  // DNS failure — host not in DNS, or no network at all.
  if (
    m.includes('dns') ||
    m.includes('not known') ||
    m.includes('no such host') ||
    m.includes('name not resolved') ||
    m.includes('nodename nor servname') ||
    m.includes('resolve')
  ) {
    return 'Hostname couldn\'t be resolved. Check the URL is spelled correctly, your DNS server is reachable, and the machine has internet access.';
  }

  // Connection refused — service not running on that port.
  if (
    m.includes('connection refused') ||
    m.includes('actively refused') ||
    m.includes('connect refused')
  ) {
    return 'Connection refused. The target host is reachable but nothing is listening on that port. Confirm the server is running and the port number is correct.';
  }

  // Connection reset / aborted — service crashed mid-request, or
  // a proxy/firewall closed the connection.
  if (
    m.includes('connection reset') ||
    m.includes('connection closed') ||
    m.includes('connection aborted') ||
    m.includes('eof while reading')
  ) {
    return 'The connection was closed before a response arrived. The server may have crashed, hit a request limit, or a proxy/firewall in between dropped the connection.';
  }

  // Timeout — slow or unresponsive server.
  if (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('timed-out')
  ) {
    return 'Request timed out. Either the server is slow / unresponsive, or the configured timeout is too low for this endpoint. Check Settings → Request timeout.';
  }

  // Generic network unreachable — VPN issues, missing route, etc.
  if (
    m.includes('network is unreachable') ||
    m.includes('host is unreachable') ||
    m.includes('no route to host') ||
    m.includes('unreachable')
  ) {
    return 'Network unreachable. Check VPN status, network adapter, and that the target is on a route the machine can reach.';
  }

  // CORS — only relevant in browser dev mode (Tauri / VSCode bypass).
  if (m.includes('cors') || m.includes('cross-origin')) {
    return 'CORS error. Browser mode can\'t hit cross-origin APIs that don\'t whitelist the origin. Run inside Tauri or the VSCode extension to bypass CORS.';
  }

  // "Failed to fetch" — browser fetch's catch-all message; usually
  // CORS, mixed-content (HTTPS page hitting HTTP API), or network.
  if (m.includes('failed to fetch') || m === 'load failed') {
    if (isHttps && url.toLowerCase().includes(':80')) {
      return 'Mixed-content block. The page is HTTPS but the request URL looks plain HTTP — browsers refuse to load HTTP content from HTTPS pages.';
    }
    return 'The transport refused to send the request. Common causes: CORS (browser only), mixed content, or the network refused before TLS started.';
  }

  // Permission / forbidden — sometimes thrown by Tauri's plugin-http
  // when the request URL isn't on the allow-list (Tauri 2 capability
  // system). Rare in our build but worth flagging.
  if (m.includes('not allowed') || m.includes('forbidden by policy')) {
    return 'The HTTP plugin refused this URL. If you self-built Tauri with a restricted capabilities config, add the host to the http allow-list.';
  }

  return null;
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
    // Tauri plugin-http extension. Passes through to reqwest's
    // `danger_accept_invalid_certs` / `danger_accept_invalid_hostnames`
    // when set on the Rust side. The plugin needs the
    // `dangerous-settings` feature enabled for this to actually skip
    // validation; see apps/desktop/src-tauri/Cargo.toml.
    danger?: {
      acceptInvalidCerts?: boolean;
      acceptInvalidHostnames?: boolean;
    };
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
  if (settings.ignoreCerts) {
    init.danger = { acceptInvalidCerts: true, acceptInvalidHostnames: true };
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
