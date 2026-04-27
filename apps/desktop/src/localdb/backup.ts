/**
 * Backup file format (v1) — JSON with one array per logical table.
 *
 * Rows in the backup are ALWAYS in the camelCase TS shape (see schema.ts),
 * not the snake_case SQL columns. That keeps backups portable across
 * driver swaps (Tauri sqlite ↔ better-sqlite3 ↔ sql.js) and across schema
 * tweaks: when a column is renamed at the SQL level, the export shape
 * stays stable.
 */

import { getDb } from './db';
import { TABLE_NAMES, type TableName } from './schema';
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

const EXPORT_VERSION = 1;

export interface BackupFile {
  app: 'aelvory';
  version: number;
  exportedAt: string;
  tables: Record<TableName, unknown[]>;
}

const ROW_FROM: Record<TableName, (r: any) => any> = {
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

const INSERT_SQL: Record<TableName, string> = {
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

const INSERT_PARAMS: Record<TableName, (row: any) => unknown[]> = {
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

export async function exportAll(): Promise<BackupFile> {
  const db = await getDb();
  const tables = {} as Record<TableName, unknown[]>;
  for (const name of TABLE_NAMES) {
    const rows = await db.select<any>(`SELECT * FROM ${name}`);
    tables[name] = rows.map(ROW_FROM[name]);
  }
  return {
    app: 'aelvory',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

export async function exportAllAsBlob(): Promise<Blob> {
  const data = await exportAll();
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

export interface ImportOptions {
  /** If true, existing data is replaced. If false, throws when a table has rows. */
  replaceExisting: boolean;
}

export async function importAll(
  raw: string,
  opts: ImportOptions = { replaceExisting: true },
): Promise<{ tables: string[]; rowsImported: number }> {
  const parsed = JSON.parse(raw) as Partial<BackupFile>;
  if (parsed.app !== 'aelvory') {
    throw new Error('Not an Aelvory backup file (missing app marker)');
  }
  if (typeof parsed.version !== 'number') {
    throw new Error('Missing backup version');
  }
  if (parsed.version > EXPORT_VERSION) {
    throw new Error(
      `Backup is from a newer version (${parsed.version}); update the app first.`,
    );
  }
  const tables = parsed.tables;
  if (!tables || typeof tables !== 'object') {
    throw new Error('Missing tables in backup');
  }

  const db = await getDb();
  let rowsImported = 0;
  const importedTables: string[] = [];

  await db.transaction(async () => {
    if (!opts.replaceExisting) {
      for (const name of TABLE_NAMES) {
        const r = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
        if (Number(r[0]?.n ?? 0) > 0) {
          throw new Error(
            `Refusing to import: table "${name}" already has ${r[0].n} row(s).`,
          );
        }
      }
    } else {
      // Delete in reverse so children go before parents (keeps things tidy if
      // we ever turn FK ON DELETE behaviour stricter).
      for (const name of [...TABLE_NAMES].reverse()) {
        await db.execute(`DELETE FROM ${name}`);
      }
    }

    for (const name of TABLE_NAMES) {
      const rows = (tables as Record<string, unknown[]>)[name];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        await db.execute(INSERT_SQL[name], INSERT_PARAMS[name](row as any));
        rowsImported++;
      }
      importedTables.push(name);
    }
  });

  return { tables: importedTables, rowsImported };
}
