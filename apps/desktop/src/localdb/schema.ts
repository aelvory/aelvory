/**
 * Canonical TypeScript types for the local store.
 *
 * Rows are stored in SQLite under snake_case columns; the JS layer always
 * works with camelCase fields. The mappers in `rowMap.ts` translate at the
 * driver boundary so handlers can stay clean.
 *
 * `localDb` (Dexie) used to live here; it has been removed in favour of
 * `getDb()` in `db.ts`. The pre-SQLite IndexedDB store is no longer
 * read on boot — see `wipeLegacyIndexedDb` in `wipe.ts` for cleanup.
 */

export interface LUser {
  id: string;
  email: string;
  displayName: string;
  publicKey: string | null;
  createdAt: string;
}

export interface LOrganization {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  ownerId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LMember {
  id: string;
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'editor';
  /**
   * When true, this member only has access to projects listed in
   * `project_members`. False (default) = sees every project in the org.
   * Phase 2 enforces this; Phase 1 just carries the column.
   */
  restricted: boolean;
  wrappedDek: string | null;
  createdAt: string;
}

/**
 * Project belongs directly to an Organization (the Team layer was
 * dropped in M002). Local-first store mirrors the server schema 1:1
 * so sync stays straightforward.
 */
export interface LProject {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Per-project access grant. Empty in Phase 1 (Phase 2 will populate
 * from the upcoming web admin UI). Schema is here so the row mappers
 * + sync engine know about it.
 */
export interface LProjectMember {
  id: string;
  projectId: string;
  userId: string;
  grantedBy: string;
  grantedAt: string;
}

export interface LEnvironment {
  id: string;
  projectId: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LVariable {
  id: string;
  scope: string;
  scopeId: string;
  key: string;
  value: string | null;
  isSecret: boolean;
  ciphertext: string | null;
  nonce: string | null;
  keyId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LCollection {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  sortIndex: number;
  auth: unknown | null; // serialized AuthConfig
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LRequest {
  id: string;
  collectionId: string;
  name: string;
  kind: string;
  method: string;
  url: string;
  headers: unknown[];
  body: unknown | null;
  auth: unknown | null;
  sortIndex: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LScript {
  id: string;
  requestId: string;
  phase: 'pre' | 'post' | 'test';
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The canonical list of synced/exported tables, in insertion order
 * (parents before children, although the SQL upserts don't actually require
 * this — it's friendlier on restore inspection).
 */
export const TABLE_NAMES = [
  'users',
  'organizations',
  'members',
  'project_members',
  'projects',
  'environments',
  'variables',
  'collections',
  'requests',
  'scripts',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

/**
 * Tables whose schema has a <c>deleted_at</c> column. A tombstone
 * SyncEntry arriving for a row in one of these tables is applied as
 * an upsert (which sets deleted_at) — the row stays on disk but is
 * filtered out of every UI query (`WHERE deleted_at IS NULL`).
 *
 * Tables NOT in this set (members, project_members, variables,
 * scripts, users) get a hard <c>DELETE FROM ... WHERE id = ?</c> on
 * tombstone arrival. They're pure access/lookup rows, not "documents
 * that get edited and then deleted" — there's nothing to soft-keep.
 *
 * Used by syncEngine.applyIncoming to dispatch tombstones to the
 * right SQL.
 */
export const TABLES_WITH_DELETED_AT: ReadonlySet<TableName> = new Set<TableName>([
  'organizations',
  'projects',
  'environments',
  'collections',
  'requests',
]);
