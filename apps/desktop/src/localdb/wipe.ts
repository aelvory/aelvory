/**
 * Hard reset of local user data — drops every row from every table
 * tracked in `TABLE_NAMES`. The schema itself stays in place
 * (`schema_meta` is intentionally NOT in TABLE_NAMES), so migrations
 * don't re-run on the next boot.
 *
 * Use case: switching the desktop app between servers / accounts on
 * the same machine, where stale local rows reference identities the
 * new server doesn't recognise. After a wipe, `ensureLocalUser` (run
 * automatically on next boot) seeds a fresh local user, and signing
 * in to the new server links that to the right server identity via
 * `linkLocalUserToServerId`.
 *
 * The function deliberately doesn't touch localStorage — that's the
 * caller's job. UI state (collapse, language, settings) and sync
 * tokens live there and need separate handling depending on how
 * thorough the reset should be.
 */
import { getDb } from './db';
import { TABLE_NAMES } from './schema';

export async function wipeAllLocalData(): Promise<void> {
  const db = await getDb();
  // Auto-commit per DELETE rather than wrapping in one transaction.
  // A long-held writer lock contends with any in-flight write from
  // sync (Changed-triggered pull, debounced post-write sync, etc.) —
  // and a wipe is intentionally destructive enough that a partial
  // wipe-then-error is recoverable (just retry). The reload after the
  // wipe means even an interrupted run lands on a clean boot.
  //
  // Reverse-order delete keeps things tidy if we ever add ON DELETE
  // RESTRICT, even though SQLite is happy without it today.
  for (const name of [...TABLE_NAMES].reverse()) {
    await db.execute(`DELETE FROM ${name}`);
  }
}

/**
 * Convenience: also clear every `aelvory.*` localStorage key. Combined
 * with `wipeAllLocalData()` this is "reset everything on this device,
 * back to first-launch state."
 */
export function wipeAelvoryLocalStorage(): void {
  if (typeof localStorage === 'undefined') return;
  // Take a snapshot of the keys first — removeItem during iteration
  // would shift indices.
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('aelvory.')) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
}

/**
 * Drop the legacy Dexie/IndexedDB database (`aelvory`) if it still
 * exists. Pre-SQLite builds stored everything there; the boot-time
 * Dexie→SQLite migration has since been removed, so the data is dead
 * weight on disk. We still delete it during a wipe so users who
 * upgraded through the migration get the bytes back, and so the
 * "reset everything" promise actually means everything.
 *
 * Resolves once the delete completes, errors, or is blocked. Blocked
 * is rare (would need another tab on the same origin holding it open);
 * we don't surface it because there's nothing useful the caller could
 * do with the signal. A 1.5s timeout caps the wait so a stuck handle
 * never blocks the wipe flow.
 */
export function wipeLegacyIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const req = indexedDB.deleteDatabase('aelvory');
      req.onsuccess = finish;
      req.onerror = finish;
      req.onblocked = finish;
    } catch {
      finish();
    }
    // Hard cap so we never block a wipe on a stuck IndexedDB handle.
    setTimeout(finish, 1500);
  });
}
