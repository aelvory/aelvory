/**
 * Direct HTTP client for the sync server. Unlike the rest of the app (which
 * dispatches through the local SQLite handler), this one actually talks
 * to a network server and carries a Bearer token.
 *
 * Transport selection:
 *   - In Tauri:   `@tauri-apps/plugin-http` (Rust-side fetch). Bypasses
 *                 the webview origin sandbox entirely — no CORS, no
 *                 preflight. This is the production path.
 *   - In browser: native `fetch`. Subject to CORS; the dev tab on
 *                 localhost:5173 only works against a server that
 *                 includes that origin in its CORS allowlist (the
 *                 Aelvory server does by default — see Program.cs).
 *
 * The base URL is resolved at call time from the settings store, so a
 * change in the Settings dialog takes effect on the next request without
 * a reload. Pinia is used lazy-style (`getActivePinia` indirection) so
 * this module doesn't pull the store into memory before Pinia is set up
 * (which would explode at module-load time during HMR).
 */
import { useSettingsStore } from '@/stores/settings';
import { isTauriEnv } from '@/runtime/environment';

const DEFAULT_BASE = 'https://eu.aelvory.com';

/**
 * Wire shape for sync entries. After Phase 1 of the multi-tenant rework,
 * every entry carries an `organizationId` (the tenant) and optionally a
 * `projectId` (null for org-level entities like Organization, Member,
 * ProjectMember). The client populates these by walking the entity
 * hierarchy when building the push batch; the server validates them
 * against the user's membership before accepting.
 */
export interface SyncEntryWireDto {
  organizationId: string;
  projectId: string | null;
  entityType: string;
  entityId: string;
  payloadFormat: 'plain' | 'encrypted';
  /** base64-encoded ciphertext or JSON bytes */
  payload: string;
  cryptoHeader: string | null;
  updatedAt: string;
  deletedAt: string | null;
  seq: number;
}

export interface SyncPushPayload {
  entries: SyncEntryWireDto[];
}

export interface SyncConflictDto {
  entityType: string;
  entityId: string;
  serverSeq: number;
  serverUpdatedAt: string;
}

export interface SyncPushResponse {
  accepted: number;
  rejected: number;
  serverCursor: number;
  conflicts: SyncConflictDto[];
}

export interface SyncPullResponse {
  entries: SyncEntryWireDto[];
  serverCursor: number;
}

export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function baseUrl(): string {
  // Pinia might not be initialized yet (e.g. very early boot, or tests).
  // Fall back to the build-time default in that case.
  try {
    const settings = useSettingsStore();
    const url = settings.effectiveSyncUrl();
    if (url) return url;
  } catch {
    /* fall through */
  }
  return ((import.meta.env.VITE_SYNC_URL as string | undefined) ||
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
    DEFAULT_BASE) as string;
}

/**
 * Pick the right transport for the current runtime. Three branches:
 *
 *  - **Tauri** → `tauri-plugin-http` runs the request in Rust,
 *    bypassing the webview origin entirely (no CORS, no preflight).
 *  - **VSCode extension** → postMessage to the extension host where
 *    Node fetch handles the request (also no CORS — host is a Node
 *    process). See `services/vscodeBridge.ts`.
 *  - **Plain browser** → native fetch. CORS applies; the dev API
 *    server allows `localhost:5173/5174` + tauri origins by default.
 *
 * Lazy-imports keep platform-specific code out of bundles where it
 * isn't needed (the Tauri build doesn't drag in the VSCode bridge,
 * and vice versa).
 */
async function transportFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (isTauriEnv()) {
    const { fetch: tFetch } = await import('@tauri-apps/plugin-http');
    return tFetch(url, init as never);
  }
  const { shouldUseVsBridge, vsHttpFetch } = await import('@/services/vscodeBridge');
  if (shouldUseVsBridge()) {
    return vsHttpFetch(url, init);
  }
  return fetch(url, init);
}

/**
 * Default timeout for any sync-server request. Without this, a stalled
 * server (dev compose still warming up `dotnet watch run`, broken VPN,
 * etc.) makes sign-in spin forever — finishAuth awaits these calls, so
 * the auth dialog's spinner stays up indefinitely. 20 s is generous
 * enough that a cold .NET start completes and short enough that the
 * user gets a clear error rather than a frozen UI.
 *
 * Callers can override with `timeoutMs` (e.g. push of a large batch)
 * or pass their own AbortSignal to disable the default.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

async function fetchJson<T>(
  path: string,
  opts: {
    method?: string;
    token?: string | null;
    body?: unknown;
    signal?: AbortSignal;
    extraHeaders?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<T> {
  // If the caller provides their own signal we trust them — they'll
  // tear down on their schedule. Otherwise we install a timeout.
  const ctrl = opts.signal ? null : new AbortController();
  const timer =
    ctrl && opts.timeoutMs !== 0
      ? setTimeout(
          () => ctrl.abort(new DOMException('request timed out', 'AbortError')),
          opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        )
      : null;

  let res: Response;
  try {
    res = await transportFetch(`${baseUrl()}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.extraHeaders ?? {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal ?? ctrl?.signal,
    });
  } catch (err) {
    // Distinguish timeouts from other transport errors so the toast
    // copy can be specific. AbortError surfaces both for our timeout
    // and for caller-side cancellation.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new SyncHttpError(
        0,
        null,
        `request to ${path} timed out — is the server reachable?`,
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    // Try the server's structured JSON error first (typical ASP.NET
    // shape: { type, title, status, detail, errors } or our custom
    // { error, message }). Fall back to text() so a server that
    // returned plain "Forbidden" or a stack trace still surfaces
    // something useful instead of nothing.
    let body: unknown = null;
    let bodyText: string | null = null;
    try {
      bodyText = await res.text();
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          /* not JSON — use bodyText as-is */
        }
      }
    } catch {
      /* ignore */
    }

    // Build a useful one-line message from whatever the server gave
    // us. The toast will show this directly, so it should explain
    // WHY the request failed, not just the status code.
    const method = opts.method ?? 'GET';
    const detail = extractErrorDetail(body, bodyText);
    const message = detail
      ? `sync HTTP ${res.status} on ${method} ${path}: ${detail}`
      : `sync HTTP ${res.status} on ${method} ${path}`;

    // Dump everything to DevTools so the user can right-click →
    // Inspect to see the full server response (often more than
    // fits in a toast).
    console.error('[sync] request failed:', {
      method,
      url: `${baseUrl()}${path}`,
      status: res.status,
      statusText: res.statusText,
      body,
      bodyText,
    });

    throw new SyncHttpError(res.status, body, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class SyncHttpError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Find the most useful single-line description in whatever shape
 * the server returned. Tried in priority order:
 *
 *   1. ASP.NET ProblemDetails — `{ title, detail, errors }`
 *      (most server endpoints use this for 4xx)
 *   2. Our custom shape — `{ error: string }` or `{ message: string }`
 *   3. Plain string body — `"Forbidden"` etc.
 *   4. Fall through to null, caller substitutes a generic message.
 *
 * The validation-errors map (`errors: { fieldName: [msgs] }`) is
 * flattened to "field: msg" pairs so the user sees which input
 * was rejected, not just "validation failed".
 */
function extractErrorDetail(body: unknown, text: string | null): string | null {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    // ASP.NET validation errors map
    if (o.errors && typeof o.errors === 'object') {
      const pairs: string[] = [];
      for (const [field, msgs] of Object.entries(o.errors as Record<string, unknown>)) {
        const arr = Array.isArray(msgs) ? msgs : [msgs];
        for (const m of arr) pairs.push(`${field}: ${m}`);
      }
      if (pairs.length) return pairs.join('; ');
    }
    if (typeof o.detail === 'string' && o.detail.trim()) return o.detail;
    if (typeof o.title === 'string' && o.title.trim()) return o.title;
    if (typeof o.error === 'string' && o.error.trim()) return o.error;
    if (typeof o.message === 'string' && o.message.trim()) return o.message;
  }
  if (typeof body === 'string' && body.trim()) return body;
  if (text && text.trim() && text.length < 200) return text.trim();
  return null;
}

export async function login(
  email: string,
  password: string,
): Promise<AuthTokenResponse> {
  return fetchJson<AuthTokenResponse>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
}

export async function register(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthTokenResponse> {
  return fetchJson<AuthTokenResponse>('/api/auth/register', {
    method: 'POST',
    body: { email, password, displayName },
  });
}

export async function refresh(
  refreshToken: string,
): Promise<AuthTokenResponse> {
  return fetchJson<AuthTokenResponse>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });
}

export async function pushEntries(
  token: string,
  entries: SyncEntryWireDto[],
  /**
   * SignalR connection id of this client. The server uses it to exclude us
   * from the `Changed` broadcast — otherwise we'd bounce a redundant pull
   * off our own push.
   */
  connectionId?: string | null,
): Promise<SyncPushResponse> {
  return fetchJson<SyncPushResponse>('/api/sync/push', {
    method: 'POST',
    token,
    body: { entries },
    extraHeaders: connectionId ? { 'x-sync-connection-id': connectionId } : undefined,
  });
}

export async function pullEntries(
  token: string,
  organizationId: string,
  since: number,
): Promise<SyncPullResponse> {
  const params = new URLSearchParams({ orgId: organizationId, since: String(since) });
  return fetchJson<SyncPullResponse>(`/api/sync/pull?${params}`, {
    method: 'GET',
    token,
  });
}

/**
 * Wire DTO for the entity-layer org list. Distinct from a SyncEntry —
 * `/api/organizations` returns the canonical Organizations table rows
 * directly (the source of truth for org metadata + membership), and
 * those rows are NEVER pushed through the sync pipeline. The desktop
 * needs them at sign-in to reconcile its local org ids with the
 * server's, otherwise sync pushes 403 because they reference an
 * organization the server has never seen.
 */
export interface ServerOrgDto {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  ownerId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServerMemberDto {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'editor';
  restricted: boolean;
  wrappedDek: string | null;
}

export async function listOrganizations(token: string): Promise<ServerOrgDto[]> {
  return fetchJson<ServerOrgDto[]>('/api/organizations', { token });
}

export async function listOrganizationMembers(
  token: string,
  organizationId: string,
): Promise<ServerMemberDto[]> {
  return fetchJson<ServerMemberDto[]>(
    `/api/organizations/${organizationId}/members`,
    { token },
  );
}

/**
 * Wire DTO for the entity-layer project list. Like orgs and members,
 * projects are stored in the canonical `Projects` table on the server
 * and never travel through `/api/sync/{push,pull}` — only the
 * collections / requests / environments / etc. inside them do. So a
 * desktop client can't discover an org's projects (or new ones added
 * after sign-in) via sync; it has to fetch them from the entity API
 * and reconcile locally.
 *
 * The server's list endpoint (ProjectsController.List) already filters
 * by access for restricted Editors — they only get back the projects
 * they have explicit grants on. So this list IS authoritative for
 * "which projects should this user see locally".
 */
export interface ServerProjectDto {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listOrganizationProjects(
  token: string,
  organizationId: string,
): Promise<ServerProjectDto[]> {
  return fetchJson<ServerProjectDto[]>(
    `/api/organizations/${organizationId}/projects`,
    { token },
  );
}
