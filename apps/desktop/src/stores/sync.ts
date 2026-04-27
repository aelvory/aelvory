import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  login as apiLogin,
  register as apiRegister,
  refresh as apiRefresh,
  listOrganizations,
  listOrganizationMembers,
  listOrganizationProjects,
  type ServerMemberDto,
  type ServerProjectDto,
} from '@/services/syncClient';
import { deriveKey, type DerivedKey } from '@/services/syncCrypto';
import {
  knownOrgIds,
  runPull,
  runSync,
  type PullResult,
  type SyncResult,
} from '@/services/syncEngine';
import { syncRealtime } from '@/services/syncRealtime';
import { decodeJwt } from '@/services/jwt';
import { linkLocalUserToServerId, reconcileLocalOrgsWithServer } from '@/localdb/seed';

const STORAGE_KEY = 'aelvory.sync';

/**
 * Thrown when an access-token refresh fails after a 401 — the
 * refresh token is also dead, so the user has to sign in again.
 * Distinct type so call sites can render a "Session expired"
 * message instead of "HTTP 401."
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired — sign in again to resume sync.');
    this.name = 'SessionExpiredError';
  }
}

interface PersistedSyncState {
  enabled: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  email: string | null;
  displayName: string | null;
  /**
   * Per-organization pull cursors. The server's Seq counter is per-org,
   * so each device tracks one cursor per org it syncs into.
   */
  cursorsByOrg: Record<string, number>;
  /**
   * Per-organization "last successful push" timestamp. Used to filter
   * what to push next time (only rows newer than this).
   */
  lastPushedAtByOrg: Record<string, string>;
  e2eeEnabled: boolean;
}

const DEFAULT_STATE: PersistedSyncState = {
  enabled: false,
  accessToken: null,
  refreshToken: null,
  email: null,
  displayName: null,
  cursorsByOrg: {},
  lastPushedAtByOrg: {},
  e2eeEnabled: false,
};

function load(): PersistedSyncState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw) as Partial<PersistedSyncState> & {
      // Tolerate the pre-multi-tenant single-cursor shape; values are
      // discarded because cursor space changed (per-org now), but we
      // don't want to crash on the old stored format.
      lastPulledCursor?: number;
      lastPushedAt?: string;
    };
    return {
      ...DEFAULT_STATE,
      ...parsed,
      cursorsByOrg: parsed.cursorsByOrg ?? {},
      lastPushedAtByOrg: parsed.lastPushedAtByOrg ?? {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export const useSyncStore = defineStore('sync', () => {
  const initial = load();

  const enabled = ref(initial.enabled);
  const accessToken = ref<string | null>(initial.accessToken);
  const refreshToken = ref<string | null>(initial.refreshToken);
  const email = ref<string | null>(initial.email);
  const displayName = ref<string | null>(initial.displayName);
  const cursorsByOrg = ref<Record<string, number>>({ ...initial.cursorsByOrg });
  const lastPushedAtByOrg = ref<Record<string, string>>({ ...initial.lastPushedAtByOrg });
  const e2eeEnabled = ref<boolean>(initial.e2eeEnabled);

  // In-memory only: never persisted. User types passphrase each session
  // if E2EE is on. Losing it means losing access to server data until
  // re-entered.
  const passphrase = ref<string | null>(null);
  const derivedKey = ref<DerivedKey | null>(null);

  const syncing = ref(false);
  const lastError = ref<string | null>(null);
  /**
   * Aggregate of the most recent sync run across all orgs. App.vue's
   * conflict toast and the post-sync reload both watch this single ref.
   */
  const lastResult = ref<SyncResult | null>(null);
  const lastSyncAt = ref<string | null>(null);

  /**
   * Monotonically increasing counter, bumped whenever a sync (manual,
   * scheduled, or SignalR-realtime) actually wrote rows into the local
   * DB via `applyIncoming` — i.e. there's new data on disk that the UI
   * hasn't seen yet.
   *
   * Components that show server-synced state (workspace store, the
   * collection tree, request tabs) watch this ref and re-read their
   * data when it changes. Without it, a SignalR-driven pull updates
   * SQLite silently and the UI shows stale rows until the next page
   * reload — the "B doesn't see A's changes" pain point.
   *
   * Bumped at the call-site where `appliedLocally > 0`, AFTER the
   * cursor has been persisted, so any watcher that triggers a re-fetch
   * pulls fresh local rows (not the pre-apply snapshot).
   */
  const dataVersion = ref(0);

  const isSignedIn = computed(() => !!accessToken.value);
  const canSync = computed(
    () => enabled.value && !!accessToken.value && (!e2eeEnabled.value || !!derivedKey.value),
  );
  const needsPassphrase = computed(
    () => enabled.value && e2eeEnabled.value && !derivedKey.value,
  );

  function persist() {
    try {
      const state: PersistedSyncState = {
        enabled: enabled.value,
        accessToken: accessToken.value,
        refreshToken: refreshToken.value,
        email: email.value,
        displayName: displayName.value,
        cursorsByOrg: cursorsByOrg.value,
        lastPushedAtByOrg: lastPushedAtByOrg.value,
        e2eeEnabled: e2eeEnabled.value,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  /**
   * Pull the entity-API truth (orgs, members, projects) and write it
   * into local SQLite. Called both at sign-in (initial seed) and at
   * the start of every `sync()` (so a freshly-invited org or a freshly
   * granted project is picked up by the next "Sync now" without a
   * full sign-out/sign-in cycle).
   *
   * Returns the number of rows reconcileLocalOrgsWithServer changed —
   * sync() folds this into `appliedLocally` so the existing
   * "reload after sync if data changed" path covers entity changes
   * too. Without that, the workspace store's in-memory list wouldn't
   * notice a new org/project until the next full app start.
   *
   * Each request has a 20 s timeout (see fetchJson) so a stalled
   * server can't hang the caller indefinitely. The per-org fetches
   * run in parallel — Promise.allSettled means one slow/failing org
   * doesn't block the others.
   */
  async function refreshOrgsFromServer(
    serverUserId: string,
    accessTok: string,
  ): Promise<number> {
    const orgs = await listOrganizations(accessTok);
    const [memberResults, projectResults] = await Promise.all([
      Promise.allSettled(
        orgs.map((o) => listOrganizationMembers(accessTok, o.id)),
      ),
      Promise.allSettled(
        orgs.map((o) => listOrganizationProjects(accessTok, o.id)),
      ),
    ]);

    const membersByOrg = new Map<string, ServerMemberDto[]>();
    const projectsByOrg = new Map<string, ServerProjectDto[]>();
    memberResults.forEach((r, i) => {
      membersByOrg.set(orgs[i].id, r.status === 'fulfilled' ? r.value : []);
    });
    projectResults.forEach((r, i) => {
      // Only set when the fetch succeeded — undefined means "we
      // don't know about this org's projects right now", which the
      // reconcile helper interprets as "leave local projects alone"
      // rather than "soft-delete everything we don't see".
      if (r.status === 'fulfilled') {
        projectsByOrg.set(orgs[i].id, r.value);
      }
    });

    return reconcileLocalOrgsWithServer(
      serverUserId,
      orgs,
      membersByOrg,
      projectsByOrg,
    );
  }

  /**
   * Shared post-auth bootstrap. Links the local seed user to the canonical
   * server user id, enables sync, persists, then kicks off an initial
   * push+pull. Awaiting `linkLocalUserToServerId` matters: if the rename
   * happens after the first push, push would send rows that reference the
   * old seed id, leaking inconsistent identity onto the server.
   */
  async function finishAuth(emailVal: string, accessTok: string, fallbackName: string) {
    const claims = decodeJwt(accessTok);
    const serverUserId = typeof claims?.sub === 'string' ? claims.sub : null;
    const claimedName =
      (typeof claims?.name === 'string' && claims.name) ||
      (typeof claims?.display_name === 'string' && claims.display_name) ||
      (typeof claims?.unique_name === 'string' && claims.unique_name) ||
      fallbackName;

    if (serverUserId) {
      displayName.value = claimedName;
      try {
        await linkLocalUserToServerId(serverUserId, emailVal, claimedName);
      } catch (err) {
        lastError.value =
          err instanceof Error
            ? `local identity link failed: ${err.message}`
            : 'local identity link failed';
      }

      // Pull the server's canonical org + member + project rows and
      // reconcile local ids. Without this, the local seed personal-org
      // id (from ensureLocalUser) and any team orgs the user belongs to
      // are unknown to the desktop, and the next sync push 403s because
      // the local org id has no Member row on the server side.
      try {
        await refreshOrgsFromServer(serverUserId, accessTok);
      } catch (err) {
        lastError.value =
          err instanceof Error
            ? `org reconciliation failed: ${err.message}`
            : 'org reconciliation failed';
      }
    }

    enabled.value = true;
    persist();

    if (ready()) {
      sync()
        .then(() => {
          if (lastResult.value && lastResult.value.appliedLocally > 0) {
            setTimeout(() => window.location.reload(), 600);
          }
        })
        .catch(() => {
          /* error already captured in lastError */
        });
    }
  }

  async function signIn(emailVal: string, password: string) {
    const trimmed = emailVal.trim();
    const res = await apiLogin(trimmed, password);
    accessToken.value = res.accessToken;
    refreshToken.value = res.refreshToken;
    email.value = trimmed;
    await finishAuth(trimmed, res.accessToken, trimmed);
  }

  async function signUp(emailVal: string, password: string, name: string) {
    const trimmed = emailVal.trim();
    const fallbackName = name || 'Sync user';
    const res = await apiRegister(trimmed, password, fallbackName);
    accessToken.value = res.accessToken;
    refreshToken.value = res.refreshToken;
    email.value = trimmed;
    displayName.value = fallbackName;
    await finishAuth(trimmed, res.accessToken, fallbackName);
  }

  async function tryRefresh(): Promise<boolean> {
    if (!refreshToken.value) return false;
    try {
      const res = await apiRefresh(refreshToken.value);
      accessToken.value = res.accessToken;
      refreshToken.value = res.refreshToken;
      persist();
      return true;
    } catch {
      accessToken.value = null;
      refreshToken.value = null;
      persist();
      return false;
    }
  }

  /**
   * Wrap any token-bearing call so a single 401 triggers a refresh +
   * one retry. If the refresh token itself is dead, sign the user out
   * (so the SettingsDialog re-shows the auth form) and throw
   * <c>SessionExpiredError</c> so the caller can render a clear "sign
   * in again" message instead of a bare "HTTP 401".
   *
   * Centralised so every per-call site (syncOrg, refreshOrgsFromServer,
   * pullOnly) shares one retry semantic. The previous shape had each
   * site open-coding the same regex match and tryRefresh dance, and
   * the entity-refresh path simply forgot — surfacing as the
   * "entity refresh failed: sync HTTP 401" toast you'd hit when an
   * access token expired between sign-in and the next sync.
   */
  async function withTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof Error) || !/401|unauthorized|http 401/i.test(err.message)) {
        throw err;
      }
      const refreshed = await tryRefresh();
      if (refreshed) return await fn();
      // Refresh token is also dead — fully sign out so persisted
      // state matches reality and the auth form becomes available
      // again. Throwing a typed error lets sync() distinguish this
      // from a transport hiccup and surface the right message.
      signOut();
      throw new SessionExpiredError();
    }
  }

  function signOut() {
    accessToken.value = null;
    refreshToken.value = null;
    email.value = null;
    displayName.value = null;
    cursorsByOrg.value = {};
    lastPushedAtByOrg.value = {};
    passphrase.value = null;
    derivedKey.value = null;
    enabled.value = false;
    persist();
  }

  function setEnabled(v: boolean) {
    enabled.value = v;
    if (!v) {
      passphrase.value = null;
      derivedKey.value = null;
    }
    persist();
  }

  function setE2eeEnabled(v: boolean) {
    e2eeEnabled.value = v;
    if (!v) {
      passphrase.value = null;
      derivedKey.value = null;
    }
    persist();
  }

  async function unlockWithPassphrase(input: string): Promise<void> {
    if (!email.value) throw new Error('sign in first so we know which email to derive the key for');
    const key = await deriveKey(input, email.value);
    passphrase.value = input;
    derivedKey.value = key;
  }

  /**
   * Run sync for one organization. Returns the per-org SyncResult,
   * which the caller folds into an aggregate when running multiple
   * orgs back-to-back.
   */
  async function syncOrg(orgId: string): Promise<SyncResult> {
    const run = async (): Promise<SyncResult> =>
      runSync({
        token: accessToken.value!,
        organizationId: orgId,
        cursor: cursorsByOrg.value[orgId] ?? 0,
        lastPushedAt: lastPushedAtByOrg.value[orgId] ?? null,
        key: e2eeEnabled.value ? derivedKey.value : null,
        connectionId: syncRealtime.connectionId,
      });

    // 401 retry + sign-out on dead refresh — same semantics for
    // every authenticated call.
    const result = await withTokenRetry(run);

    cursorsByOrg.value = {
      ...cursorsByOrg.value,
      [orgId]: result.pulled.serverCursor,
    };
    lastPushedAtByOrg.value = {
      ...lastPushedAtByOrg.value,
      [orgId]: new Date().toISOString(),
    };
    return result;
  }

  /**
   * Sync every known organization. Errors on one org don't abort the
   * others — we collect into the aggregate result and surface the
   * first error in `lastError` if any.
   */
  async function sync(): Promise<void> {
    if (!accessToken.value) throw new Error('not signed in');
    if (e2eeEnabled.value && !derivedKey.value) {
      throw new Error('E2EE is on — unlock with passphrase first');
    }
    if (syncing.value) return; // reentrancy guard

    syncing.value = true;
    lastError.value = null;
    try {
      // Refresh entity-API state (orgs, members, projects) BEFORE
      // walking known orgs. Two reasons:
      //   1. A user invited to a new org since the last sync needs
      //      the local org row to exist before knownOrgIds() finds it.
      //   2. A project newly granted to a restricted Editor needs to
      //      land in the local projects table so the workspace UI
      //      shows it. /api/sync/pull never carries org/project
      //      entity rows — they're entity-table-only on the server.
      // entityChanges is folded into appliedLocally below so the
      // existing "reload after sync" path covers entity changes too.
      let entityChanges = 0;
      const claims = decodeJwt(accessToken.value);
      const serverUserId = typeof claims?.sub === 'string' ? claims.sub : null;
      if (serverUserId) {
        try {
          entityChanges = await withTokenRetry(() =>
            refreshOrgsFromServer(serverUserId, accessToken.value!),
          );
        } catch (err) {
          // Session expired — refresh token is dead, signOut() has
          // already cleared local state. Surface the friendly
          // message and bail out of the sync entirely (the per-org
          // loop below would also 401 with no token). Re-throw so
          // doSyncNow's caller renders an error toast instead of
          // the success toast it'd show on a clean return.
          if (err instanceof SessionExpiredError) {
            lastError.value = err.message;
            throw err;
          }
          // Don't abort sync just because the entity refresh failed
          // — the per-org sync below may still succeed for orgs we
          // already know about. Surface the error so the UI shows
          // it, but keep going.
          //
          // Be careful to preserve diagnostic detail: a bare
          // "entity refresh failed" with no follow-up is useless
          // when something deep in the stack is failing. Common
          // sources of empty/missing messages:
          //   - tauri-plugin-sql throws strings or {message: undefined}
          //     for some SQLite errors
          //   - HTTP rejections from the timeout AbortController
          //   - non-Error throws that happen to coerce to "[object Object]"
          // Falling back through name → stringified payload → String()
          // means we always have SOMETHING after the colon.
          console.error('[sync] entity refresh failed:', err);
          let detail: string;
          if (err instanceof Error) {
            detail = err.message || err.name || String(err);
          } else if (typeof err === 'string') {
            detail = err;
          } else if (err && typeof err === 'object') {
            detail = JSON.stringify(err) || Object.prototype.toString.call(err);
          } else {
            detail = String(err);
          }
          lastError.value = `entity refresh failed: ${detail}`;
        }
      }

      const orgs = await knownOrgIds();

      // Aggregate accumulator. Each per-org SyncResult contributes its
      // numbers; conflicts pile up into the same list. lastResult is a
      // single ref so App.vue's watcher fires once at the end.
      let aggregate: SyncResult | null = null;
      let firstError: unknown = null;

      for (const orgId of orgs) {
        try {
          const r = await syncOrg(orgId);
          if (!aggregate) {
            aggregate = r;
          } else {
            aggregate = {
              pushed: {
                accepted: aggregate.pushed.accepted + r.pushed.accepted,
                rejected: aggregate.pushed.rejected + r.pushed.rejected,
                serverCursor: Math.max(aggregate.pushed.serverCursor, r.pushed.serverCursor),
                conflicts: [...aggregate.pushed.conflicts, ...r.pushed.conflicts],
              },
              pulled: {
                entries: [...aggregate.pulled.entries, ...r.pulled.entries],
                serverCursor: Math.max(aggregate.pulled.serverCursor, r.pulled.serverCursor),
              },
              appliedLocally: aggregate.appliedLocally + r.appliedLocally,
              skippedOlder: aggregate.skippedOlder + r.skippedOlder,
            };
          }
        } catch (err) {
          if (!firstError) firstError = err;
          // Continue with other orgs — don't let one failing org stop
          // the rest from syncing.
        }
      }

      // Surface entity-refresh changes (newly-invited org appearing,
      // a granted project becoming visible) the same way sync-pulled
      // rows are surfaced — by adding to appliedLocally. App.vue
      // watches that and reloads the page when it grows, so the
      // workspace store re-bootstraps from local SQLite and the UI
      // shows the new rows. If aggregate is null (no orgs known yet
      // — this was a first sign-in pulling in B's workspace), build
      // a minimal one carrying just the entity changes.
      if (aggregate) {
        aggregate = { ...aggregate, appliedLocally: aggregate.appliedLocally + entityChanges };
      } else if (entityChanges > 0) {
        aggregate = {
          pushed: { accepted: 0, rejected: 0, serverCursor: 0, conflicts: [] },
          pulled: { entries: [], serverCursor: 0 },
          appliedLocally: entityChanges,
          skippedOlder: 0,
        };
      }

      lastResult.value = aggregate;
      lastSyncAt.value = new Date().toISOString();
      persist();

      // Bump dataVersion if anything actually landed in local SQLite.
      // Watchers re-fetch on next tick — whole-page reload not needed.
      if (aggregate && aggregate.appliedLocally > 0) {
        dataVersion.value++;
      }

      if (firstError) {
        lastError.value =
          firstError instanceof Error ? firstError.message : String(firstError);
        throw firstError;
      }
    } finally {
      syncing.value = false;
    }
  }

  /**
   * Pull-only path used by the realtime "Changed" notification, which
   * carries the org id of the change. Same gates as sync(); errors are
   * swallowed (auto-paths shouldn't surface as throws).
   */
  async function pullOnly(orgId: string): Promise<void> {
    if (!accessToken.value) return;
    if (e2eeEnabled.value && !derivedKey.value) return;
    if (syncing.value) return;

    syncing.value = true;
    lastError.value = null;
    try {
      const run = async (): Promise<PullResult> =>
        runPull({
          token: accessToken.value!,
          organizationId: orgId,
          cursor: cursorsByOrg.value[orgId] ?? 0,
          key: e2eeEnabled.value ? derivedKey.value : null,
        });

      // 401 retry; SessionExpiredError propagates if refresh fails.
      const result = await withTokenRetry(run);

      cursorsByOrg.value = {
        ...cursorsByOrg.value,
        [orgId]: result.pulled.serverCursor,
      };
      persist();

      // Real-time UX: SignalR fires `Changed`, we pull, applyIncoming
      // writes to local SQLite. Watchers on dataVersion re-fetch and
      // the UI updates without the user having to do anything.
      if (result.appliedLocally > 0) {
        dataVersion.value++;
      }
    } catch (err) {
      // Surface the friendly message for session expiry. Don't
      // re-throw — pullOnly is fire-and-forget from the SignalR
      // handler and a thrown promise here just becomes an unhandled
      // rejection. Setting lastError is enough; App.vue's watcher
      // shows the toast.
      lastError.value =
        err instanceof SessionExpiredError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
    } finally {
      syncing.value = false;
    }
  }

  function ready(): boolean {
    if (!enabled.value) return false;
    if (!accessToken.value) return false;
    if (e2eeEnabled.value && !derivedKey.value) return false;
    return true;
  }

  return {
    enabled,
    accessToken,
    refreshToken,
    email,
    displayName,
    cursorsByOrg,
    lastPushedAtByOrg,
    e2eeEnabled,
    passphrase,
    derivedKey,
    syncing,
    lastError,
    lastResult,
    lastSyncAt,
    dataVersion,
    isSignedIn,
    canSync,
    needsPassphrase,
    signIn,
    signUp,
    signOut,
    setEnabled,
    setE2eeEnabled,
    unlockWithPassphrase,
    sync,
    pullOnly,
    ready,
  };
});
