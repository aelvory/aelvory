/**
 * postMessage bridge between the Aelvory webview and the extension
 * host. Three families of operations cross the bridge:
 *
 *   1. DB file I/O (sql.js runs in the webview; the host owns the
 *      `aelvory.db` file on disk and reads/writes raw bytes)
 *      { op: 'db.read' }                       → { bytes: base64 | null }
 *      { op: 'db.write', bytes: base64 }       → {}
 *
 *   2. HTTP (Node's `fetch` in the host bypasses webview CORS, matching
 *      how tauri-plugin-http behaves in the desktop build)
 *      { op: 'http.fetch', url, init }
 *
 *   3. Files (vscode.window.showSaveDialog + fs.writeFile, used by
 *      backup-export — webviews can't show OS dialogs themselves)
 *      { op: 'fs.saveAs', defaultName, content, filters? }
 *
 * The webview wraps each call in a Promise keyed by a correlation id;
 * the host posts back `{ kind: 'db-reply', id, ok, result | error }`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import type { AelvorySidebarProvider, SidebarStatus } from './sidebar';

// ---- WebSocket proxy ----
//
// The webview can't reliably open WebSockets to arbitrary servers —
// many endpoints reject the `Origin: vscode-webview://...` header
// during the upgrade and the browser then surfaces an opaque 1006
// abnormal close with no actionable detail. Routing through the
// host's `ws` package presents a normal Origin (or none) and
// matches what tauri-plugin-http does in the desktop build.
//
// Each connection is identified by a `wsId` chosen by the webview
// (UUID). The webview opens, sends, and closes via request/reply
// ops; the host pushes back unsolicited `kind: 'ws-event'` messages
// for `open` / `message` / `error` / `close`.

export interface WsConnectPayload {
  op: 'ws.connect';
  wsId: string;
  url: string;
  subprotocols?: string[];
}

export interface WsSendPayload {
  op: 'ws.send';
  wsId: string;
  data: string;
}

export interface WsClosePayload {
  op: 'ws.close';
  wsId: string;
  code?: number;
  reason?: string;
}

export type WsEvent =
  | { kind: 'ws-event'; wsId: string; type: 'open' }
  | { kind: 'ws-event'; wsId: string; type: 'message'; data: string; isBinary: boolean }
  | { kind: 'ws-event'; wsId: string; type: 'error'; message: string }
  | {
      kind: 'ws-event';
      wsId: string;
      type: 'close';
      code: number;
      reason: string;
      wasClean: boolean;
    };

const wsConnections = new Map<string, WebSocket>();

// ---- Sidebar status push ----

/**
 * Fire-and-forget notification from the webview when stores change
 * (active workspace, sign-in, last sync). Host caches it and refreshes
 * the activity-bar tree so the user sees current state without
 * having to keep the panel focused.
 */
export interface SidebarStatusPayload {
  op: 'sidebar.status';
  status: SidebarStatus;
}

// ---- DB file I/O ----

export interface DbReadPayload {
  op: 'db.read';
}
export interface DbReadResult {
  /** base64-encoded SQLite bytes, or null if the DB file doesn't exist yet. */
  bytes: string | null;
}

export interface DbWritePayload {
  op: 'db.write';
  /** base64-encoded SQLite bytes. */
  bytes: string;
}

// ---- HTTP op ----

/**
 * Subset of the standard `fetch` init that crosses the postMessage
 * bridge cleanly. `body` is restricted to a string because the
 * structured-clone algorithm doesn't carry FormData / Blob /
 * ReadableStream losslessly through webview message channels.
 */
export interface HttpFetchPayload {
  op: 'http.fetch';
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Hard cap to keep a stalled server from wedging the webview. */
    timeoutMs?: number;
  };
}

export interface HttpFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /**
   * UTF-8 body. We don't try to surface binary responses across the
   * bridge — sync API, SignalR negotiate, OpenAPI fetch are all text.
   */
  body: string;
  /** Final URL after redirects. */
  url: string;
}

// ---- Files op ----

export interface FsSaveAsPayload {
  op: 'fs.saveAs';
  defaultName: string;
  content: string;
  filters?: Record<string, string[]>;
}

export interface FsSaveAsResult {
  /** Absolute path the file was written to. `null` = user cancelled. */
  path: string | null;
}

export type DriverMessage =
  | DbReadPayload
  | DbWritePayload
  | HttpFetchPayload
  | FsSaveAsPayload
  | SidebarStatusPayload
  | WsConnectPayload
  | WsSendPayload
  | WsClosePayload;

/**
 * Each handle binds the host to one DB file path, the activity-bar
 * sidebar provider, and a back-channel for unsolicited host→webview
 * notifications (used by the WebSocket proxy to forward `open` /
 * `message` / `error` / `close` events).
 */
export interface BridgeContext {
  dbPath: string;
  sidebar: AelvorySidebarProvider;
  /** Send an unsolicited event to the webview (no reply expected). */
  postEvent: (event: WsEvent) => void;
}

export async function handleDriverMessage(
  ctx: BridgeContext,
  msg: DriverMessage,
): Promise<unknown> {
  switch (msg.op) {
    case 'db.read': {
      try {
        const bytes = await fs.promises.readFile(ctx.dbPath);
        const out: DbReadResult = { bytes: bytes.toString('base64') };
        return out;
      } catch (err) {
        // ENOENT is the common case on first run — return null so
        // the caller boots an empty sql.js DB. Anything else is a
        // real I/O error and we re-throw so the webview surfaces it.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          const out: DbReadResult = { bytes: null };
          return out;
        }
        throw err;
      }
    }

    case 'db.write': {
      // Atomic write: stage to a sibling tmp file then rename. fs.rename
      // on the same filesystem is atomic on Linux/macOS, and on Windows
      // (NTFS) for most cases; the worst case (rename fails after tmp
      // exists) leaves the tmp behind but the original DB intact.
      const buf = Buffer.from(msg.bytes, 'base64');
      const tmpPath = ctx.dbPath + '.tmp';
      await fs.promises.mkdir(path.dirname(ctx.dbPath), { recursive: true });
      await fs.promises.writeFile(tmpPath, buf);
      await fs.promises.rename(tmpPath, ctx.dbPath);
      return {};
    }

    case 'http.fetch': {
      const init = msg.init ?? {};
      const ctrl = new AbortController();
      const timer = init.timeoutMs
        ? setTimeout(() => ctrl.abort(), init.timeoutMs)
        : null;
      try {
        const res = await fetch(msg.url, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal: ctrl.signal,
          // Node's undici fetch follows redirects by default — the
          // final URL ends up in res.url. No CORS in the host.
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const body = await res.text();
        const out: HttpFetchResult = {
          status: res.status,
          statusText: res.statusText,
          headers,
          body,
          url: res.url || msg.url,
        };
        return out;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    case 'sidebar.status': {
      ctx.sidebar.setStatus(msg.status);
      return {};
    }

    case 'ws.connect': {
      // Replace any existing connection under this wsId — matches the
      // webview-side WebSocketRuntime.connect behaviour where a new
      // connect for the same tab id closes the previous socket.
      const existing = wsConnections.get(msg.wsId);
      if (existing) {
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
      let ws: WebSocket;
      try {
        ws =
          msg.subprotocols && msg.subprotocols.length
            ? new WebSocket(msg.url, msg.subprotocols)
            : new WebSocket(msg.url);
      } catch (err) {
        // Invalid URL / scheme — surface as an error event so the
        // webview shows it like any other connection failure.
        ctx.postEvent({
          kind: 'ws-event',
          wsId: msg.wsId,
          type: 'error',
          message: err instanceof Error ? err.message : 'connect failed',
        });
        return {};
      }
      wsConnections.set(msg.wsId, ws);

      ws.on('open', () =>
        ctx.postEvent({ kind: 'ws-event', wsId: msg.wsId, type: 'open' }),
      );
      ws.on('message', (data, isBinary) => {
        // `ws` gives us a Buffer (or array of buffers for fragmented
        // messages). Coerce to string — for truly binary frames the
        // result is gibberish, so we surface a length placeholder
        // instead, matching the webview's existing display.
        let text: string;
        if (isBinary) {
          const buf = Array.isArray(data)
            ? Buffer.concat(data as Buffer[])
            : (data as Buffer);
          text = `[binary frame, ${buf.length} bytes]`;
        } else {
          text = data.toString();
        }
        ctx.postEvent({
          kind: 'ws-event',
          wsId: msg.wsId,
          type: 'message',
          data: text,
          isBinary,
        });
      });
      ws.on('error', (err) =>
        ctx.postEvent({
          kind: 'ws-event',
          wsId: msg.wsId,
          type: 'error',
          message: err.message,
        }),
      );
      ws.on('close', (code, reason) => {
        wsConnections.delete(msg.wsId);
        ctx.postEvent({
          kind: 'ws-event',
          wsId: msg.wsId,
          type: 'close',
          code,
          reason: reason.toString(),
          // `ws` exposes only code+reason; we infer wasClean from
          // the code (1000 = normal close).
          wasClean: code === 1000,
        });
      });
      return {};
    }

    case 'ws.send': {
      const ws = wsConnections.get(msg.wsId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Mirror the webview's old behaviour: silently no-op when
        // not open. The UI already shows the connection status.
        return {};
      }
      ws.send(msg.data);
      return {};
    }

    case 'ws.close': {
      const ws = wsConnections.get(msg.wsId);
      if (!ws) return {};
      try {
        if (
          ws.readyState === WebSocket.CONNECTING ||
          ws.readyState === WebSocket.OPEN
        ) {
          ws.close(msg.code ?? 1000, msg.reason ?? '');
        }
      } catch {
        /* ignore — ws emits the close event regardless */
      }
      return {};
    }

    case 'fs.saveAs': {
      // VSCode's save dialog. Returns a Uri or undefined (cancel).
      // We always pass an absolute path through fs.writeFile so the
      // webview just sees "saved at this path" or "cancelled."
      const filters = msg.filters ?? { JSON: ['json'] };
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(msg.defaultName),
        filters,
      });
      if (!uri) {
        const out: FsSaveAsResult = { path: null };
        return out;
      }
      await fs.promises.writeFile(uri.fsPath, msg.content, 'utf8');
      const out: FsSaveAsResult = { path: uri.fsPath };
      return out;
    }

    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unknown driver op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
