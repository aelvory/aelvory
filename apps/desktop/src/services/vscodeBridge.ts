/**
 * Webview-side helpers for the VSCode extension bridge.
 *
 * The webview can't make CORS-free HTTP requests itself and can't show
 * OS save dialogs, so those operations cross a `postMessage` channel
 * to the extension host where Node's `fetch` and
 * `vscode.window.showSaveDialog` handle them.
 *
 * The same correlation-id machinery as `localdb/driver.vscode.ts` is
 * reused here — one shared listener on `window.message`, one pending
 * map keyed by id. Only the message-`kind` distinguishes db replies
 * from http/fs replies (the host echoes whatever id was sent).
 */
import { isVSCodeEnv } from '@/runtime/environment';
import { getVsCodeApi } from './vscodeApi';

interface ReplyEnvelope {
  kind: 'db-reply';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

function ensureListenerInstalled() {
  // Idempotent — multiple modules may call into the bridge; we only
  // want one global listener. The flag is on `window` so HMR doesn't
  // re-install on every reload of this module.
  const w = window as unknown as { __aelvoryVsBridgeListener?: boolean };
  if (w.__aelvoryVsBridgeListener) return;
  w.__aelvoryVsBridgeListener = true;

  window.addEventListener('message', (event: MessageEvent<ReplyEnvelope>) => {
    const data = event.data;
    if (!data || data.kind !== 'db-reply') return;
    const slot = pending.get(data.id);
    if (!slot) return;
    pending.delete(data.id);
    if (data.ok) slot.resolve(data.result);
    else slot.reject(new Error(data.error ?? 'unknown bridge error'));
  });
}

function send<T>(payload: unknown): Promise<T> {
  ensureListenerInstalled();
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getVsCodeApi().postMessage({ kind: 'db', id, payload });
  });
}

// ---- HTTP transport ----

interface HttpFetchResultWire {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

/**
 * Fetch via the extension host — Node's fetch in the host has no
 * webview-CORS; matches the role tauri-plugin-http plays in the
 * desktop build. Same-shape interface so callers don't care.
 *
 * We rebuild a real `Response` on the webview side so consumers
 * (`syncClient.fetchJson`, `runner.ts`, etc.) get the same API
 * surface as native fetch — `.ok`, `.json()`, `.text()`, `.headers.get()`.
 */
/**
 * Extension to RequestInit for the VSCode bridge transport. We can't
 * widen the global RequestInit type, so callers wanting to opt in
 * cast the init object to this type. Other transports (Tauri,
 * native fetch) ignore `insecure`.
 */
export interface VsHttpFetchInit extends RequestInit {
  /** Skip TLS validation in the host. See bridge.ts for the dispatcher wiring. */
  insecure?: boolean;
}

export async function vsHttpFetch(
  url: string,
  init: VsHttpFetchInit = {},
): Promise<Response> {
  // Body needs to be string — see bridge.ts for why structured clone
  // doesn't carry FormData / Blob / streams cleanly. Today the only
  // bodies we send are JSON, which the caller has already
  // stringified. Future binary-body callers would need a base64
  // path here.
  let bodyText: string | undefined;
  if (typeof init.body === 'string') {
    bodyText = init.body;
  } else if (init.body == null) {
    bodyText = undefined;
  } else {
    throw new Error(
      'VSCode bridge fetch only supports string bodies; got ' + typeof init.body,
    );
  }

  const headers: Record<string, string> = {};
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => {
      headers[k] = v;
    });
  } else if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers) headers[String(k)] = String(v);
  } else if (init.headers && typeof init.headers === 'object') {
    for (const [k, v] of Object.entries(init.headers)) {
      headers[k] = String(v);
    }
  }

  const result = await send<HttpFetchResultWire>({
    op: 'http.fetch',
    url,
    init: {
      method: init.method ?? 'GET',
      headers,
      body: bodyText,
      // `fetchJson` already enforces a 20 s default via its own
      // AbortController, but the host has its own ceiling too —
      // belt and suspenders against a stuck Node fetch.
      timeoutMs: 20_000,
      insecure: init.insecure === true,
    },
  });

  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers: new Headers(result.headers),
  });
}

// ---- DB persistence ----

interface DbReadResult {
  /** base64-encoded SQLite bytes, or null if the DB file doesn't exist yet. */
  bytes: string | null;
}

/**
 * Read the host-owned `aelvory.db` bytes. Returns null on first run
 * (no DB file yet) so the caller can boot an empty sql.js instance.
 *
 * Bytes cross the bridge as base64 — postMessage's structured clone
 * does carry Uint8Array, but base64 keeps the wire format symmetric
 * with `vsDbWrite` and avoids any host-side TypedArray reconstruction
 * inside `webview.postMessage`.
 */
export async function vsDbRead(): Promise<Uint8Array | null> {
  const r = await send<DbReadResult>({ op: 'db.read' });
  if (!r.bytes) return null;
  // base64 → Uint8Array. The DB is typically tens to hundreds of KB
  // for normal usage; atob's string-length limits aren't a concern.
  const bin = atob(r.bytes);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Persist `bytes` as the SQLite file. The host writes atomically
 * (tmp + rename) so a crash mid-write can't corrupt the on-disk DB.
 */
export async function vsDbWrite(bytes: Uint8Array): Promise<void> {
  // Uint8Array → base64. Chunk to keep String.fromCharCode argument
  // count below the call-stack limit (~65 K args on most engines).
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  await send({ op: 'db.write', bytes: btoa(bin) });
}

// ---- Sidebar status push ----

export interface SidebarStatus {
  /** "Personal / My API" — displayed verbatim. Empty = not selected. */
  workspace?: string;
  /** ISO timestamp of the most recent successful sync. */
  lastSyncIso?: string;
  /** Email or display name of the signed-in user. Empty = signed out. */
  account?: string;
}

/**
 * Push the current workspace + sync + account state to the host so
 * the activity-bar sidebar can render it. Fire-and-forget — we don't
 * block the UI on the reply, and the host's reply is just `{}` anyway.
 *
 * Called whenever the relevant Pinia stores change; see
 * services/sidebarStatus.ts for the watcher wiring.
 */
export async function vsPushSidebarStatus(status: SidebarStatus): Promise<void> {
  if (!isVSCodeEnv()) return;
  try {
    await send({ op: 'sidebar.status', status });
  } catch {
    // Sidebar status is best-effort cosmetic; never let a postMessage
    // failure surface as a user-visible error.
  }
}

// ---- saveAs dialog ----

interface FsSaveAsResult {
  path: string | null;
}

/**
 * Show a save dialog and write `content` to the picked path. Returns
 * the absolute path written, or `null` if the user cancelled. Mirrors
 * the desktop's `saveJsonFile` shape so callers can route through
 * either implementation by environment.
 */
export async function vsSaveAs(
  defaultName: string,
  content: string,
  filters: Record<string, string[]> = { JSON: ['json'] },
): Promise<string | null> {
  const r = await send<FsSaveAsResult>({
    op: 'fs.saveAs',
    defaultName,
    content,
    filters,
  });
  return r.path;
}

/** True iff this module's bridge is the right transport for the
 *  current runtime. Cheap; safe to call repeatedly. */
export function shouldUseVsBridge(): boolean {
  return isVSCodeEnv();
}
