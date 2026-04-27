/**
 * Auto-sync scheduler. Centralises the "when does sync run" logic so the
 * store stays declarative.
 *
 * Triggers, in addition to the user's manual "Sync now" button:
 *   - Sign-in: handled inside the sync store itself (signIn/signUp).
 *   - Window focus: throttled. If the window has been hidden for long
 *     enough, a focus implies "we may have missed updates — pull."
 *   - Local write: any mutation through api()/dispatchLocal arms a
 *     debounced push (~2 s). Coalesces bursts.
 *   - Realtime: SignalR "Changed" events run pullOnly().
 *   - Sync enable/disable + sign-in/out: connect or disconnect the
 *     SignalR hub.
 *
 * Idempotent: install() can be called multiple times — only the first
 * one wires listeners. Useful in HMR scenarios.
 */

import { watch } from 'vue';
import { useSyncStore } from '@/stores/sync';
import { onLocalWrite } from '@/api/client';
import { syncRealtime } from './syncRealtime';

const FOCUS_MIN_INTERVAL_MS = 30_000; // don't pull more than once per 30s on focus
const WRITE_DEBOUNCE_MS = 2_000;

let installed = false;

export function installSyncScheduler(): void {
  if (installed) return;
  installed = true;

  const sync = useSyncStore();

  // ---- 1. Realtime: connect/disconnect on ready-state changes ----

  async function refreshRealtime() {
    if (sync.ready()) {
      await syncRealtime.start({
        getToken: () => sync.accessToken,
        onChanged: (orgId, cursor) => {
          // Already at or beyond this cursor (we caused it, or
          // received an out-of-order one) — skip the round-trip.
          if (cursor <= (sync.cursorsByOrg[orgId] ?? 0)) return;
          void sync.pullOnly(orgId);
        },
        onError: (err) => {
          console.warn('[sync] realtime error:', err);
        },
      });
    } else {
      await syncRealtime.stop();
    }
  }

  // Watch the inputs that affect ready() — Pinia exposes them as refs.
  watch(
    () => [sync.enabled, sync.accessToken, sync.e2eeEnabled, sync.derivedKey],
    () => {
      void refreshRealtime();
    },
    { immediate: true },
  );

  // ---- 2. Focus: sync every known org when window regains focus, throttled ----
  //
  // Pre-multi-tenant this used `pullOnly()` to avoid an unnecessary push
  // on every focus. With per-org cursors we'd need to fan out a pull
  // per known org anyway; `sync()` already does that AND folds in any
  // pending push. Since writes are independently debounced (~2 s) the
  // push half is almost always a no-op by the time focus fires, so the
  // extra cost is nil in practice.

  let lastFocusSyncAt = 0;
  function onFocus() {
    if (!sync.ready()) return;
    const now = Date.now();
    if (now - lastFocusSyncAt < FOCUS_MIN_INTERVAL_MS) return;
    lastFocusSyncAt = now;
    void sync.sync().catch(() => {
      /* error already in lastError */
    });
  }
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onFocus();
  });

  // ---- 3. Debounced post-write sync (push + pull) ----

  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleWriteSync() {
    if (!sync.ready()) return;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      if (!sync.ready()) return;
      void sync.sync().catch(() => {
        /* error already in lastError */
      });
    }, WRITE_DEBOUNCE_MS);
  }
  onLocalWrite(() => scheduleWriteSync());
}
