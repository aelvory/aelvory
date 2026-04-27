/**
 * VSCode-bridge-backed WebSocket wrapper.
 *
 * Mirrors enough of the native `WebSocket` interface that
 * `services/websocket.ts` can use it as a drop-in replacement when
 * running inside the VSCode webview. The actual connection is opened
 * by the `ws` package in the extension host (see
 * apps/vscode-extension/src/bridge.ts) — webview-direct WebSockets
 * fail on many real APIs because servers reject the
 * `Origin: vscode-webview://...` header during the upgrade.
 *
 * Surface implemented:
 *   - readyState (CONNECTING / OPEN / CLOSING / CLOSED constants)
 *   - addEventListener('open' | 'message' | 'error' | 'close', fn)
 *   - send(text)
 *   - close(code?, reason?)
 *   - binaryType (accepted but ignored — host always coerces to text)
 *
 * NOT implemented (no current callers): removeEventListener,
 * `on{open,message,...}` property setters, dispatchEvent. Add as
 * needed; the existing webSocketRuntime only uses addEventListener.
 */

import { isVSCodeEnv } from '@/runtime/environment';
import { getVsCodeApi } from './vscodeApi';

interface WsEvent {
  kind: 'ws-event';
  wsId: string;
  type: 'open' | 'message' | 'error' | 'close';
  data?: string;
  isBinary?: boolean;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  message?: string;
}

// One global listener routes ws-event messages by id to the right
// instance. Installed lazily so the cost is only paid in builds that
// actually open a WebSocket (Tauri build never reaches this module).
const instances = new Map<string, BridgeWebSocket>();
let listenerInstalled = false;

function ensureListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (event: MessageEvent<WsEvent>) => {
    const data = event.data;
    if (!data || data.kind !== 'ws-event') return;
    const inst = instances.get(data.wsId);
    if (!inst) return;
    inst._dispatch(data);
  });
}

type Listener = (event: Event | MessageEvent | CloseEvent) => void;

export class BridgeWebSocket implements Pick<
  WebSocket,
  'url' | 'readyState' | 'send' | 'close' | 'binaryType' | 'addEventListener'
> {
  // Match WebSocket constants on the instance for ergonomic comparison
  // with `ws.readyState === ws.OPEN` from the existing runtime code.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readyState: number = BridgeWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  // Real WebSocket exposes these — leave as unused defaults so the
  // interface satisfies TypeScript's structural type for `WebSocket`.
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = '';
  // Property-style handlers — kept null and unused; we only support
  // addEventListener. Required for structural compatibility.
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;

  private readonly wsId: string;
  private readonly listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.wsId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ensureListener();
    instances.set(this.wsId, this);

    const subprotocols = Array.isArray(protocols)
      ? protocols
      : protocols
        ? [protocols]
        : undefined;

    // Fire-and-forget connect. The host posts `ws-event` messages
    // back as state changes; we don't need a reply for the connect
    // itself — `open` (or `error`/`close`) tells us what happened.
    getVsCodeApi().postMessage({
      kind: 'db',
      // The id is unused for outbound-only ops, but the host's
      // dispatcher requires it to match the envelope shape.
      id: `ws-connect-${this.wsId}`,
      payload: { op: 'ws.connect', wsId: this.wsId, url, subprotocols },
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== this.OPEN) return;
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else {
      // Aelvory's WS UI only sends text frames today. Reject binary
      // explicitly rather than silently misencode — keeps the
      // failure surface small.
      throw new Error('BridgeWebSocket.send only supports text frames');
    }
    getVsCodeApi().postMessage({
      kind: 'db',
      id: `ws-send-${this.wsId}-${Date.now()}`,
      payload: { op: 'ws.send', wsId: this.wsId, data: text },
    });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    this.readyState = this.CLOSING;
    getVsCodeApi().postMessage({
      kind: 'db',
      id: `ws-close-${this.wsId}`,
      payload: { op: 'ws.close', wsId: this.wsId, code, reason },
    });
  }

  addEventListener(type: 'open' | 'message' | 'error' | 'close', fn: Listener): void {
    this.listeners[type]?.push(fn);
  }
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', fn: Listener): void {
    const arr = this.listeners[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(): boolean {
    // Required for the EventTarget interface. We don't dispatch
    // user-supplied events through the bridge.
    return false;
  }

  /** Internal — called by the global listener when an event arrives. */
  _dispatch(evt: WsEvent): void {
    if (evt.type === 'open') {
      this.readyState = this.OPEN;
      const e = new Event('open');
      this.listeners.open.forEach((fn) => fn(e));
    } else if (evt.type === 'message') {
      // Real WebSocket gives us a MessageEvent. Construct one with
      // the text payload; `isBinary` is conveyed via the data type:
      // a Blob for binary so the existing runtime branch picks it
      // up, a string otherwise.
      const data: string | Blob = evt.isBinary
        ? new Blob([evt.data ?? ''])
        : (evt.data ?? '');
      const e = new MessageEvent('message', { data });
      this.listeners.message.forEach((fn) => fn(e));
    } else if (evt.type === 'error') {
      const e = new Event('error');
      // Stash the message on the event so callers that look for it
      // (none today, but the existing runtime might add one) can
      // find it.
      (e as Event & { message?: string }).message = evt.message;
      this.listeners.error.forEach((fn) => fn(e));
    } else if (evt.type === 'close') {
      this.readyState = this.CLOSED;
      instances.delete(this.wsId);
      const e = new CloseEvent('close', {
        code: evt.code,
        reason: evt.reason,
        wasClean: evt.wasClean,
      });
      this.listeners.close.forEach((fn) => fn(e));
    }
  }
}

/**
 * Returns the WebSocket constructor to use in the current runtime.
 * In a VSCode webview, returns the bridge wrapper; everywhere else,
 * the native `WebSocket`. The returned value is a constructor with
 * the same signature as native `WebSocket`, so callers can just do
 * `new (pickWebSocketImpl())(url, protocols)` and not branch.
 */
export function pickWebSocketImpl(): typeof WebSocket {
  if (isVSCodeEnv()) {
    return BridgeWebSocket as unknown as typeof WebSocket;
  }
  return WebSocket;
}
