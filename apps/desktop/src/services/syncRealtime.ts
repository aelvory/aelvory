/**
 * Real-time sync notifications via SignalR.
 *
 * Connects to /hubs/sync, joins the user's group server-side, and invokes
 * `onChanged` whenever another device pushes for the same user. The
 * receiver runs a pull (handled by the sync store) — we don't carry
 * payloads on the channel, just a "something changed, here's the new
 * server cursor" hint.
 *
 * Lifecycle:
 *   - start() — connect (idempotent). Caller should pass a fresh token
 *     and a callback that asks the sync store to pull.
 *   - stop()  — disconnect. Call on sign-out, sync-disable, or app close.
 *   - connectionId — string once connected; null otherwise. Pass this on
 *     each push so the server can exclude us from the broadcast.
 */

import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { useSettingsStore } from '@/stores/settings';
import { isTauriEnv } from '@/runtime/environment';

const DEFAULT_BASE = 'https://eu.aelvory.com';

function hubUrl(): string {
  let base = '';
  try {
    base = useSettingsStore().effectiveSyncUrl();
  } catch {
    /* Pinia not ready — fall back below. */
  }
  if (!base) {
    base = ((import.meta.env.VITE_SYNC_URL as string | undefined) ||
      (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
      DEFAULT_BASE) as string;
  }
  return `${base.replace(/\/+$/, '')}/hubs/sync`;
}

export interface RealtimeOptions {
  /** Returns the latest access token. Called on (re)connect; refresh-aware. */
  getToken: () => string | null;
  /**
   * Called when the server signals a change to a specific organization.
   * `cursor` is that org's max Seq; receivers use it to short-circuit
   * a pull when they're already at-or-beyond.
   */
  onChanged: (organizationId: string, cursor: number) => void;
  /** Called on terminal failures so the UI can surface them. */
  onError?: (err: unknown) => void;
}

class RealtimeSync {
  private connection: HubConnection | null = null;
  private starting: Promise<void> | null = null;
  private opts: RealtimeOptions | null = null;

  /** SignalR connection id once connected; null otherwise. */
  get connectionId(): string | null {
    return this.connection?.connectionId ?? null;
  }

  get isConnected(): boolean {
    return this.connection?.state === HubConnectionState.Connected;
  }

  async start(opts: RealtimeOptions): Promise<void> {
    this.opts = opts;
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
      return;
    }
    if (this.starting) return this.starting;

    // SignalR's default flow does an HTTP POST to /negotiate before
    // upgrading to WebSocket. That POST is subject to CORS preflight,
    // which is exactly what we don't want for a cross-origin sync URL
    // from a webview that the server doesn't have on its allowlist.
    //
    // In Tauri we therefore skip negotiation and connect WebSockets
    // directly. The WebSocket handshake is a single HTTP/1.1 GET
    // upgrade — browsers don't preflight it (per WHATWG fetch spec),
    // and ASP.NET's WebSocket middleware doesn't gate the upgrade on
    // CORS by default. Net result: no CORS at all in the desktop app.
    //
    // In a real browser tab we keep the default (negotiate + auto
    // transport), because the browser will enforce its own checks
    // either way and skipping negotiate forces WebSocket-only — which
    // we don't want to lose as a fallback in dev.
    const skipNegotiation = isTauriEnv();

    const conn = new HubConnectionBuilder()
      .withUrl(hubUrl(), {
        accessTokenFactory: () => opts.getToken() ?? '',
        ...(skipNegotiation
          ? {
              skipNegotiation: true,
              transport: HttpTransportType.WebSockets,
            }
          : {}),
      })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .configureLogging(LogLevel.Warning)
      .build();

    conn.on('Changed', (organizationId: string, cursor: number) => {
      try {
        this.opts?.onChanged(organizationId, cursor);
      } catch (err) {
        this.opts?.onError?.(err);
      }
    });

    conn.onclose((err) => {
      if (err) this.opts?.onError?.(err);
    });

    this.connection = conn;
    this.starting = (async () => {
      try {
        await conn.start();
      } catch (err) {
        this.opts?.onError?.(err);
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    const c = this.connection;
    this.connection = null;
    this.opts = null;
    if (!c) return;
    try {
      await c.stop();
    } catch {
      /* ignore */
    }
  }
}

/** Single per-app instance. The app only ever syncs one user at a time. */
export const syncRealtime = new RealtimeSync();
