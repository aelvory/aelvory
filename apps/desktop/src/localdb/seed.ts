import { getDb } from './db';
import { newId, nowIso, type LUser } from './schema';
import { userFromRow } from './rowMap';
import type {
  ServerMemberDto,
  ServerOrgDto,
  ServerProjectDto,
} from '@/services/syncClient';

/**
 * After a successful sync sign-in, repoint the local active user to the
 * server's canonical user id (taken from the JWT's `sub` claim).
 *
 * Why this exists: every device runs `ensureLocalUser()` on first launch
 * and creates a fresh per-device GUID for the local user + personal org
 * + member row. When two devices sign in to the same sync account and
 * pull each other's data, both copies arrive in the local SQLite — but
 * `members.user_id` references the original device's seed GUID, so
 * queries like "which orgs is the current user a member of" filter most
 * of them out. Linking the seed user to the canonical server id makes
 * all devices speak the same `user_id`, so cross-device data appears
 * naturally.
 *
 * Idempotent. Safe to call on every sign-in.
 */
export async function linkLocalUserToServerId(
  serverUserId: string,
  email: string,
  displayName: string,
): Promise<void> {
  const db = await getDb();
  const localId = getLocalUserId();
  const now = nowIso();

  // Case 1: already linked, or no local user yet. Just upsert and pin.
  if (!localId || localId === serverUserId) {
    await db.execute(
      `INSERT INTO users (id, email, display_name, public_key, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email        = excluded.email,
         display_name = excluded.display_name`,
      [serverUserId, email, displayName, null, now],
    );
    setLocalUserId(serverUserId);
    return;
  }

  // Case 2: local seed user differs from the server id. Rename the row
  // and repoint everything that references it. Inside a transaction
  // because mid-flight the unique constraints would catch us.
  await db.transaction(async () => {
    // Does a row with serverUserId already exist locally? Could happen
    // if it had been pulled down from another device on a previous,
    // unfinished sign-in.
    const existing = await db.select<{ id: string }>(
      'SELECT id FROM users WHERE id = ?',
      [serverUserId],
    );

    if (existing.length === 0) {
      // Simple rename of the local user row.
      await db.execute(
        `UPDATE users
            SET id = ?, email = ?, display_name = ?
          WHERE id = ?`,
        [serverUserId, email, displayName, localId],
      );
    } else {
      // Both rows exist locally — keep the server-id row, refresh its
      // identity columns, and drop the local seed row.
      await db.execute(
        `UPDATE users
            SET email = ?, display_name = ?
          WHERE id = ?`,
        [email, displayName, serverUserId],
      );
      await db.execute('DELETE FROM users WHERE id = ?', [localId]);
    }

    // members has UNIQUE(organization_id, user_id). If we naively UPDATE
    // user_id from localId to serverUserId, any (org, serverUserId) pair
    // that already exists in members (from sync pull) would violate that
    // constraint. Pre-delete the would-be duplicates first.
    await db.execute(
      `DELETE FROM members
        WHERE user_id = ?
          AND organization_id IN (
            SELECT organization_id FROM members WHERE user_id = ?
          )`,
      [localId, serverUserId],
    );
    await db.execute(
      'UPDATE members SET user_id = ? WHERE user_id = ?',
      [serverUserId, localId],
    );

    // organizations.owner_id has no unique constraint — straightforward
    // repoint.
    await db.execute(
      'UPDATE organizations SET owner_id = ? WHERE owner_id = ?',
      [serverUserId, localId],
    );
  });

  setLocalUserId(serverUserId);
}

const LOCAL_USER_KEY = 'aelvory.local-user-id';

export function getLocalUserId(): string | null {
  try {
    return localStorage.getItem(LOCAL_USER_KEY);
  } catch {
    return null;
  }
}

export function setLocalUserId(id: string) {
  try {
    localStorage.setItem(LOCAL_USER_KEY, id);
  } catch {
    /* ignore */
  }
}

export function clearLocalUserId() {
  try {
    localStorage.removeItem(LOCAL_USER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Reconcile local org rows with the server's truth. Called at sign-in
 * right after `linkLocalUserToServerId`, so the local user_id column
 * already points at the server-canonical user id.
 *
 * Why this exists: organizations + members are stored as real entities
 * on the server (Organizations / Members tables) and NEVER traverse the
 * sync layer. They're created at registration / via the admin UI, not
 * as `SyncEntry` rows. So a fresh sign-in on a wiped device:
 *   - has a freshly-seeded local org id (from `ensureLocalUser`) the
 *     server has no record of → push 403,
 *   - has no local rows for any team org the user belongs to → those
 *     orgs are invisible until something seeds them,
 *   - and `/api/sync/pull` won't fix either of these (no entry to
 *     pull).
 *
 * What this does:
 *   1. Renames the local seed personal org to match the server's
 *      personal org id, so any data the user typed in pre-sign-in
 *      lands in the canonical workspace. Cascades to projects.
 *   2. Upserts every server org + every member of every server org
 *      with the server's canonical ids. Sync push is now happy
 *      (member row exists for {orgId, userId}) and admin-UI-only
 *      data is visible locally.
 *
 * Idempotent. Caller passes the lists fetched via
 * `listOrganizations` / `listOrganizationMembers`.
 */
export async function reconcileLocalOrgsWithServer(
  serverUserId: string,
  serverOrgs: ServerOrgDto[],
  membersByOrg: Map<string, ServerMemberDto[]>,
  projectsByOrg: Map<string, ServerProjectDto[]> = new Map(),
): Promise<number> {
  const db = await getDb();
  let changes = 0;

  // Find the local seed personal org (the one ensureLocalUser created
  // before sign-in). After linkLocalUserToServerId, owner_id already
  // matches serverUserId — that's how we identify it.
  const localPersonals = await db.select<{ id: string }>(
    `SELECT id FROM organizations
       WHERE owner_id = ?
         AND kind = 'personal'
         AND deleted_at IS NULL`,
    [serverUserId],
  );
  const localPersonalId = localPersonals[0]?.id ?? null;
  const serverPersonal = serverOrgs.find(
    (o) => o.kind === 'personal' && o.ownerId === serverUserId,
  );

  // Auto-commit each statement instead of one big transaction.
  //
  // tauri-plugin-sql is backed by sqlx::Pool<Sqlite>: each `execute`
  // call acquires a connection from the pool and may land on a
  // different connection than the previous one. A multi-statement
  // BEGIN/…/COMMIT splits across connections, so the BEGIN holds a
  // writer lock on connection A while subsequent INSERTs hit
  // connection B which immediately competes with A — and busy_timeout
  // doesn't help because there's no point in time when A is willing
  // to release. End result: SQLITE_BUSY (code 5) "database is locked"
  // mid-reconciliation, the same shape we hit during the wipe.
  //
  // Auto-commit is safe here because the operations are idempotent
  // upserts driven by the server's truth — a partial run leaves the
  // local DB in some intermediate state, and the next sync converges
  // it back to the server's truth without any "unwinding" needed.
  // The only piece that genuinely needs atomicity is the personal-org
  // rename + cascade (so we can't end up with projects pointing at a
  // half-renamed org); we mitigate that by making each statement
  // self-contained: a project whose org_id is updated mid-flight is
  // fine because the upsert loop below will overwrite it again.
  {
    // (1) Rename local personal org id → server personal org id.
    if (
      localPersonalId &&
      serverPersonal &&
      localPersonalId !== serverPersonal.id
    ) {
      const collision = await db.select<{ id: string }>(
        'SELECT id FROM organizations WHERE id = ?',
        [serverPersonal.id],
      );
      if (collision.length === 0) {
        await db.execute('UPDATE organizations SET id = ? WHERE id = ?', [
          serverPersonal.id,
          localPersonalId,
        ]);
      } else {
        // Server-id row already present (half-completed prior sign-in).
        // Drop the seed; the canonical row stays.
        await db.execute('DELETE FROM organizations WHERE id = ?', [
          localPersonalId,
        ]);
      }
      // Cascade FK-like references — SQLite ON UPDATE CASCADE isn't on
      // these columns, so we do it by hand.
      await db.execute(
        'UPDATE projects SET organization_id = ? WHERE organization_id = ?',
        [serverPersonal.id, localPersonalId],
      );
      // Drop local seed members of the old org id — the canonical
      // rows are about to be upserted with their server ids, and
      // unique(organization_id, user_id) would clash otherwise.
      await db.execute('DELETE FROM members WHERE organization_id = ?', [
        localPersonalId,
      ]);
    }

    // (2) Upsert every server org + its members with canonical ids.
    for (const o of serverOrgs) {
      // Detect "is this row new or different" by checking version.
      // Version is monotonically server-incremented on update so it's
      // the cheapest delta signal. Used only to count `changes` for
      // the reload heuristic — actual upsert is unconditional.
      const before = await db.select<{ version: number }>(
        'SELECT version FROM organizations WHERE id = ?',
        [o.id],
      );
      if (before.length === 0 || before[0].version !== o.version) changes++;

      await db.execute(
        `INSERT INTO organizations
           (id, name, kind, owner_id, version, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           owner_id = excluded.owner_id,
           version = excluded.version,
           updated_at = excluded.updated_at`,
        [o.id, o.name, o.kind, o.ownerId, o.version, o.createdAt, o.updatedAt, null],
      );

      // Upsert projects the entity API knows about. We do NOT
      // soft-delete projects that the entity list doesn't contain —
      // that was the v1 of this code and it deleted real data.
      //
      // Reason: projects can be created via two independent paths
      // and the server doesn't reconcile them:
      //   1. Admin UI → POST /api/organizations/{id}/projects
      //                 → row in the `Projects` entity table.
      //   2. Desktop  → local SQLite insert → pushed as a
      //                 SyncEntry(EntityType="projects").
      //                 The SyncEntry is the canonical store; the
      //                 entity table is NEVER touched.
      //
      // So `listOrganizationProjects` only ever returns projects
      // created via path 1. A user who creates projects on the
      // desktop and shares with another user has those projects
      // arrive as SyncEntries on the receiver — applyIncoming
      // upserts them into the receiver's `projects` table directly.
      // If we soft-deleted "anything not in the entity list", we'd
      // wipe every desktop-pushed project on every sync — which is
      // exactly what the user reported ("project completely gone
      // after clicking Sync").
      //
      // Trade-off: a real revocation (admin removed a project from
      // the entity table, or restricted-editor's grant was revoked)
      // leaves a stale local row. That's recoverable by the user
      // (Reset local data, or wait for a server-side
      // tombstone-via-sync feature). Stale rows are far less
      // destructive than vanishing rows.
      const projects = projectsByOrg.get(o.id);
      if (projects) {
        for (const p of projects) {
          const beforeP = await db.select<{ version: number }>(
            'SELECT version FROM projects WHERE id = ?',
            [p.id],
          );
          if (beforeP.length === 0 || beforeP[0].version !== p.version) changes++;
          await db.execute(
            `INSERT INTO projects
               (id, organization_id, name, description, version,
                created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               organization_id = excluded.organization_id,
               name            = excluded.name,
               description     = excluded.description,
               version         = excluded.version,
               updated_at      = excluded.updated_at,
               deleted_at      = NULL`,
            [
              p.id,
              p.organizationId,
              p.name,
              p.description,
              p.version,
              p.createdAt,
              p.updatedAt,
            ],
          );
        }
      }

      const members = membersByOrg.get(o.id) ?? [];
      for (const m of members) {
        // upsert by member id; if a row with this (org, user) already
        // exists with a different id we'd violate the unique
        // constraint — pre-clean by user/org pair.
        await db.execute(
          `DELETE FROM members
             WHERE organization_id = ? AND user_id = ? AND id <> ?`,
          [o.id, m.userId, m.id],
        );
        await db.execute(
          `INSERT INTO members
             (id, organization_id, user_id, role, restricted, wrapped_dek, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             organization_id = excluded.organization_id,
             user_id         = excluded.user_id,
             role            = excluded.role,
             restricted      = excluded.restricted,
             wrapped_dek     = excluded.wrapped_dek`,
          [
            m.id,
            o.id,
            m.userId,
            m.role,
            m.restricted ? 1 : 0,
            m.wrappedDek,
            // Server doesn't expose member CreatedAt; use the org
            // updatedAt as a stable-ish placeholder so the column is
            // never null.
            o.updatedAt,
          ],
        );
        // Make sure a users row exists for every member we just
        // wrote — the workspace UI joins on it for display name/email.
        // The local-user row for serverUserId is handled by
        // linkLocalUserToServerId; this fills in everyone else.
        if (m.userId !== serverUserId) {
          await db.execute(
            `INSERT INTO users (id, email, display_name, public_key, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               email        = excluded.email,
               display_name = excluded.display_name`,
            [m.userId, m.email, m.displayName, null, o.updatedAt],
          );
        }
      }
    }
  }
  return changes;
}

/**
 * Returns the local user, creating one (plus a personal workspace) if none
 * exists. Idempotent.
 */
export async function ensureLocalUser(): Promise<LUser> {
  const db = await getDb();

  const existingId = getLocalUserId();
  if (existingId) {
    const rows = await db.select<any>('SELECT * FROM users WHERE id = ?', [existingId]);
    if (rows.length > 0) return userFromRow(rows[0]);
    // ID in localStorage but record missing — re-seed.
  }

  const id = newId();
  const now = nowIso();
  const orgId = newId();
  const memberId = newId();

  await db.transaction(async () => {
    await db.execute(
      `INSERT INTO users (id, email, display_name, public_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, `local-${id.slice(0, 8)}@aelvory.local`, 'Local user', null, now],
    );
    await db.execute(
      `INSERT INTO organizations
         (id, name, kind, owner_id, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, 'My workspace', 'personal', id, 0, now, now, null],
    );
    await db.execute(
      `INSERT INTO members
         (id, organization_id, user_id, role, restricted, wrapped_dek, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [memberId, orgId, id, 'owner', 0, null, now],
    );
  });

  setLocalUserId(id);

  return {
    id,
    email: `local-${id.slice(0, 8)}@aelvory.local`,
    displayName: 'Local user',
    publicKey: null,
    createdAt: now,
  };
}
