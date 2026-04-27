/**
 * Generic by-table-name accessors used by the sync engine.
 *
 * The sync engine treats rows as opaque JSON blobs keyed by `(table, id)` —
 * it doesn't know the column shapes. This module gives it a stable
 * camelCase view backed by SQLite.
 *
 * Wire-format note: the camelCase row shape returned/accepted here IS the
 * sync wire format. Don't change it without bumping the sync version.
 */

import { getDb } from './db';
import {
  collectionFromRow,
  collectionParams,
  environmentFromRow,
  environmentParams,
  memberParams,
  orgFromRow,
  orgParams,
  projectFromRow,
  projectParams,
  projectMemberFromRow,
  projectMemberParams,
  requestFromRow,
  requestParams,
  scriptFromRow,
  scriptParams,
  userFromRow,
  userParams,
  variableFromRow,
  variableParams,
} from './rowMap';
import { type TableName } from './schema';

const FROM_ROW: Record<TableName, (r: any) => any> = {
  users: userFromRow,
  organizations: orgFromRow,
  members: (r) => ({
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    role: r.role,
    restricted: r.restricted === 1 || r.restricted === true,
    wrappedDek: r.wrapped_dek ?? null,
    createdAt: r.created_at,
  }),
  project_members: projectMemberFromRow,
  projects: projectFromRow,
  environments: environmentFromRow,
  variables: variableFromRow,
  collections: collectionFromRow,
  requests: requestFromRow,
  scripts: scriptFromRow,
};

const UPSERT_SQL: Record<TableName, string> = {
  users: `INSERT OR REPLACE INTO users
            (id, email, display_name, public_key, created_at)
          VALUES (?, ?, ?, ?, ?)`,
  organizations: `INSERT OR REPLACE INTO organizations
            (id, name, kind, owner_id, version, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  members: `INSERT OR REPLACE INTO members
            (id, organization_id, user_id, role, restricted, wrapped_dek, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
  project_members: `INSERT OR REPLACE INTO project_members
            (id, project_id, user_id, granted_by, granted_at)
          VALUES (?, ?, ?, ?, ?)`,
  projects: `INSERT OR REPLACE INTO projects
            (id, organization_id, name, description, version,
             created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  environments: `INSERT OR REPLACE INTO environments
            (id, project_id, name, version, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
  variables: `INSERT OR REPLACE INTO variables
            (id, scope, scope_id, key, value, is_secret, ciphertext, nonce,
             key_id, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  collections: `INSERT OR REPLACE INTO collections
            (id, project_id, parent_id, name, sort_index, auth, version,
             created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  requests: `INSERT OR REPLACE INTO requests
            (id, collection_id, name, kind, method, url, headers, body, auth,
             sort_index, version, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  scripts: `INSERT OR REPLACE INTO scripts
            (id, request_id, phase, source, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
};

const TO_PARAMS: Record<TableName, (row: any) => unknown[]> = {
  users: userParams,
  organizations: orgParams,
  members: memberParams,
  project_members: projectMemberParams,
  projects: projectParams,
  environments: environmentParams,
  variables: variableParams,
  collections: collectionParams,
  requests: requestParams,
  scripts: scriptParams,
};

/** All rows in a logical table, camelCase. */
export async function tableAll<T = any>(name: TableName): Promise<T[]> {
  const db = await getDb();
  const rows = await db.select<any>(`SELECT * FROM ${name}`);
  return rows.map(FROM_ROW[name]) as T[];
}

/** A single row by id, camelCase, or undefined. */
export async function tableGet<T = any>(name: TableName, id: string): Promise<T | undefined> {
  const db = await getDb();
  const rows = await db.select<any>(`SELECT * FROM ${name} WHERE id = ?`, [id]);
  if (rows.length === 0) return undefined;
  return FROM_ROW[name](rows[0]) as T;
}

/** Upsert a row keyed by id. Row must already be in camelCase shape. */
export async function tablePut(name: TableName, row: any): Promise<void> {
  const db = await getDb();
  await db.execute(UPSERT_SQL[name], TO_PARAMS[name](row));
}

/**
 * Hard-DELETE a row by id. Used by applyIncoming for tombstone
 * SyncEntries on tables that don't carry a <c>deleted_at</c> column
 * locally (members, project_members, variables, scripts) — soft-
 * delete isn't expressible there, so we drop the row outright.
 */
export async function tableDelete(name: TableName, id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM ${name} WHERE id = ?`, [id]);
}
