import { pickWebSocketImpl } from './bridgeWebSocket';

/**
 * WebSocket runtime — opens/closes connections and forwards events
 * out as plain callbacks so the Pinia tab store can update its
 * reactive state without ever wrapping the native WebSocket object
 * itself.
 *
 * Why the connection isn't in the tab store: Vue 3's reactivity
 * system tries to deeply proxy whatever you put in a `ref` or
 * `reactive`. Native WebSocket has internal slots that don't
 * tolerate that — proxying breaks `addEventListener`, the readyState
 * accessor, and binary frame parsing in subtle ways. So the connection
 * lives here as a Map keyed by tab id; the tab stores only serializable
 * status / messages.
 *
 * Lifetime: a connection lasts until the user clicks Disconnect, the
 * tab is closed, or the network drops it. We don't auto-reconnect —
 * a WS testing tool should be predictable about whether you're
 * actually connected.
 */

interface ActiveConnection {
  ws: WebSocket;
  /** Mirrors ws.readyState semantically — used by `status()`. */
  closing: boolean;
}

export type WsStatus = 'disconnected' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';

/**
 * Human-readable explanation for a WebSocket close code. RFC 6455
 * defines 1000-1015; 4000-4999 are application-defined; values below
 * 1000 and above 4999 are reserved.
 *
 * 1006 specifically is what the browser-native WebSocket reports
 * when the connection died before a clean close — and it covers a
 * wide range of underlying causes (TLS handshake fail, server
 * rejecting the Upgrade with a non-101 status, missing required
 * subprotocol, network drop). The browser deliberately hides which
 * one it was. The hint we surface for 1006 lists the common
 * culprits so users have something to try.
 */
export function describeCloseCode(code: number): string {
  switch (code) {
    case 1000:
      return 'normal close';
    case 1001:
      return 'going away — server is shutting down or client navigated away';
    case 1002:
      return 'protocol error';
    case 1003:
      return 'unsupported data — server received a frame type it can\'t accept';
    case 1005:
      return 'no status code received';
    case 1006:
      return 'abnormal close — the connection ended without a clean WebSocket close. ' +
        'Common causes: wrong path or scheme, server rejected the upgrade ' +
        '(e.g. needs auth or a subprotocol), TLS handshake failed, or the ' +
        'network dropped. The browser hides the real reason for security reasons.';
    case 1007:
      return 'invalid payload data — message contained data inconsistent with its type';
    case 1008:
      return 'policy violation';
    case 1009:
      return 'message too big';
    case 1010:
      return 'mandatory extension missing — client asked for an extension the server didn\'t agree to';
    case 1011:
      return 'server error — server hit an internal error closing the connection';
    case 1012:
      return 'service restarting';
    case 1013:
      return 'try again later';
    case 1014:
      return 'bad gateway';
    case 1015:
      return 'TLS handshake failure';
    default:
      if (code >= 4000 && code <= 4999) {
        return `application-defined close code ${code}`;
      }
      return `close code ${code}`;
  }
}

export interface WsHandlers {
  onOpen?: () => void;
  onMessage?: (data: string, isBinary: boolean) => void;
  onClose?: (code: number, reason: string, wasClean: boolean) => void;
  onError?: (message: string) => void;
}

export interface ConnectOptions {
  url: string;
  /** Sent in Sec-WebSocket-Protocol on the upgrade request. */
  subprotocols?: string[];
}

class WebSocketRuntime {
  private connections = new Map<string, ActiveConnection>();

  /**
   * Open a new connection for the given tab id. Closes any existing
   * connection for that id first so a re-connect from the UI doesn't
   * leak the previous socket.
   */
  connect(tabId: string, opts: ConnectOptions, handlers: WsHandlers): WsStatus {
    this.disconnect(tabId);

    // Pick implementation per runtime: native `WebSocket` in Tauri /
    // browser, host-bridged in VSCode (where the browser-origin WS
    // upgrade gets rejected by many real servers).
    const WSImpl = pickWebSocketImpl();
    let ws: WebSocket;
    try {
      ws = opts.subprotocols && opts.subprotocols.length
        ? new WSImpl(opts.url, opts.subprotocols)
        : new WSImpl(opts.url);
    } catch (err) {
      // Invalid URL syntax / unsupported scheme — `new WebSocket`
      // throws synchronously instead of via the error event.
      handlers.onError?.(err instanceof Error ? err.message : 'connect failed');
      return 'error';
    }

    // Receive binary frames as text where possible. Aelvory's UI
    // shows messages in a text log — binary blobs would render
    // badly. Text mode keeps strings strings; binary frames still
    // arrive as Blob and we stringify them for display.
    ws.binaryType = 'blob';

    const conn: ActiveConnection = { ws, closing: false };
    this.connections.set(tabId, conn);

    ws.addEventListener('open', () => handlers.onOpen?.());

    ws.addEventListener('message', async (event: MessageEvent) => {
      const data = event.data;
      if (typeof data === 'string') {
        handlers.onMessage?.(data, false);
      } else if (data instanceof Blob) {
        // Try to read as text — UTF-8 text frames are still common
        // even when the server sets binary opcode. If it's truly
        // binary we surface a `[binary N bytes]` placeholder.
        try {
          const text = await data.text();
          // Heuristic: if the result is full of replacement chars
          // it's not really text. Fall back to a length placeholder.
          const looksTextual = !/\uFFFD\uFFFD\uFFFD/.test(text);
          if (looksTextual) {
            handlers.onMessage?.(text, true);
          } else {
            handlers.onMessage?.(`[binary frame, ${data.size} bytes]`, true);
          }
        } catch {
          handlers.onMessage?.(`[binary frame, ${data.size} bytes]`, true);
        }
      } else if (data instanceof ArrayBuffer) {
        handlers.onMessage?.(`[binary frame, ${data.byteLength} bytes]`, true);
      } else {
        handlers.onMessage?.(String(data), false);
      }
    });

    ws.addEventListener('error', (ev: Event) => {
      // Native WebSocket's Error event is intentionally opaque (the
      // spec hides server-side reasons for security), so we usually
      // can only say "WebSocket error". Our BridgeWebSocket wrapper,
      // however, attaches the real message from Node's `ws` package
      // to the event — surface that when present so users see e.g.
      // "Unexpected server response: 401" or "ECONNREFUSED" instead
      // of a generic placeholder.
      const real = (ev as Event & { message?: string }).message;
      handlers.onError?.(real ? `WebSocket error: ${real}` : 'WebSocket error');
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      this.connections.delete(tabId);
      handlers.onClose?.(event.code, event.reason, event.wasClean);
    });

    return 'connecting';
  }

  /**
   * Send a text frame on the connection for `tabId`. Returns true
   * when the frame was queued for sending; false when there's no
   * open connection (caller should surface that to the user as
   * "not connected").
   */
  send(tabId: string, data: string): boolean {
    const conn = this.connections.get(tabId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  /** Initiate a clean close. The actual `close` event arrives async. */
  disconnect(tabId: string, code = 1000, reason = ''): void {
    const conn = this.connections.get(tabId);
    if (!conn) return;
    conn.closing = true;
    try {
      // CONNECTING / OPEN states accept close(); other states will
      // throw or no-op depending on the platform — guard so we
      // never bubble that up.
      if (
        conn.ws.readyState === WebSocket.CONNECTING ||
        conn.ws.readyState === WebSocket.OPEN
      ) {
        conn.ws.close(code, reason);
      }
    } catch {
      /* ignore */
    }
  }

  status(tabId: string): WsStatus {
    const conn = this.connections.get(tabId);
    if (!conn) return 'disconnected';
    if (conn.closing) return 'closing';
    switch (conn.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting';
      case WebSocket.OPEN:
        return 'open';
      case WebSocket.CLOSING:
        return 'closing';
      case WebSocket.CLOSED:
        return 'closed';
      default:
        return 'disconnected';
    }
  }
}

/** Per-app singleton — there's no scenario where we'd want two. */
export const webSocketRuntime = new WebSocketRuntime();
