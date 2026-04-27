/**
 * SQL migrations. Append-only — never edit a migration that has shipped.
 * Each migration's `up` runs inside a single transaction. The migration
 * runner records applied versions in `schema_meta`.
 *
 * SQL is portable across our drivers (tauri-plugin-sql, better-sqlite3,
 * sql.js); avoid sqlite-version-specific syntax.
 */

import type { DbDriver } from './driver';

export interface Migration {
  version: number;
  description: string;
  up: (db: DbDriver) => Promise<void>;
}

const M001_INITIAL_SCHEMA: Migration = {
  version: 1,
  description: 'Initial schema — users, orgs, teams, projects, envs, vars, collections, requests, scripts',
  up: async (db) => {
    // Schema-meta first; the runner upserts the version row at the end.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    await db.execute(`
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        public_key    TEXT,
        created_at    TEXT NOT NULL
      )
    `);
    await db.execute('CREATE UNIQUE INDEX idx_users_email ON users(email)');

    await db.execute(`
      CREATE TABLE organizations (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        owner_id    TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )
    `);
    await db.execute('CREATE INDEX idx_orgs_owner ON organizations(owner_id)');

    await db.execute(`
      CREATE TABLE members (
        id               TEXT PRIMARY KEY,
        organization_id  TEXT NOT NULL,
        user_id          TEXT NOT NULL,
        role             TEXT NOT NULL,
        wrapped_dek      TEXT,
        created_at       TEXT NOT NULL,
        UNIQUE(organization_id, user_id)
      )
    `);
    await db.execute('CREATE INDEX idx_members_org ON members(organization_id)');
    await db.execute('CREATE INDEX idx_members_user ON members(user_id)');

    await db.execute(`
      CREATE TABLE teams (
        id               TEXT PRIMARY KEY,
        organization_id  TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT,
        version          INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        deleted_at       TEXT
      )
    `);
    await db.execute('CREATE INDEX idx_teams_org ON teams(organization_id)');

    await db.execute(`
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        version     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )
    `);
    await db.execute('CREATE INDEX idx_projects_team ON projects(team_id)');

    await db.execute(`
      CREATE TABLE environments (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        name        TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )
    `);
    await db.execute('CREATE INDEX idx_envs_project ON environments(project_id)');

    await db.execute(`
      CREATE TABLE variables (
        id          TEXT PRIMARY KEY,
        scope       TEXT NOT NULL,
        scope_id    TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT,
        is_secret   INTEGER NOT NULL DEFAULT 0,
        ciphertext  TEXT,
        nonce       TEXT,
        key_id      TEXT,
        version     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE(scope, scope_id, key)
      )
    `);
    await db.execute('CREATE INDEX idx_vars_scope ON variables(scope, scope_id)');

    await db.execute(`
      CREATE TABLE collections (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        parent_id   TEXT,
        name        TEXT NOT NULL,
        sort_index  INTEGER NOT NULL DEFAULT 0,
        auth        TEXT,
        version     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )
    `);
    await db.execute('CREATE INDEX idx_cols_project ON collections(project_id)');
    await db.execute('CREATE INDEX idx_cols_parent ON collections(parent_id)');
    await db.execute('CREATE INDEX idx_cols_proj_parent ON collections(project_id, parent_id)');

    await db.execute(`
      CREATE TABLE requests (
        id             TEXT PRIMARY KEY,
        collection_id  TEXT NOT NULL,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        method         TEXT NOT NULL,
        url            TEXT NOT NULL,
        headers        TEXT NOT NULL DEFAULT '[]',
        body           TEXT,
        auth           TEXT,
        sort_index     INTEGER NOT NULL DEFAULT 0,
        version        INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        deleted_at     TEXT
      )
    `);
    await db.execute('CREATE INDEX idx_reqs_collection ON requests(collection_id)');

    await db.execute(`
      CREATE TABLE scripts (
        id          TEXT PRIMARY KEY,
        request_id  TEXT NOT NULL,
        phase       TEXT NOT NULL,
        source      TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE(request_id, phase)
      )
    `);
    await db.execute('CREATE INDEX idx_scripts_req ON scripts(request_id)');
  },
};

/**
 * Phase 1 of multi-tenant: drops the Team layer locally so the schema
 * mirrors the server. SQLite makes column renames + drops cumbersome
 * (no native ALTER COLUMN), so we rebuild `projects` via a temporary
 * table:
 *   1. Add a temporary `organization_id` column to projects (nullable).
 *   2. Backfill it from teams via JOIN.
 *   3. Recreate `projects` with the new column shape.
 *   4. Copy rows over, drop the old table, drop `teams`.
 *   5. Add `restricted` to members and the new `project_members` table
 *      (mirrors the server even though Phase 1 doesn't write to it).
 *
 * `INSERT INTO new_projects SELECT ... FROM projects` is the standard
 * SQLite pattern for column-level changes; we also keep the original
 * sort_index / version / timestamp values intact.
 */
const M002_DROP_TEAMS_MULTI_TENANT: Migration = {
  version: 2,
  description: 'Drop Team layer; projects belong directly to org. Add ProjectMembers + Member.restricted.',
  up: async (db) => {
    // Idempotency check: an earlier prototype (the VSCode extension's
    // first build) shipped a consolidated post-M002 schema but stamped
    // schema_meta.version=1, leaving DBs in a "post-migration but
    // marked pre-migration" state. Re-running M002 on those DBs
    // would crash on `DROP TABLE teams`. If the schema already looks
    // post-M002, just stamp the version and return.
    const teamsTable = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='teams'",
    );
    if (teamsTable.length === 0) return;

    // Ensure FK enforcement is off during the rebuild — SQLite's
    // CREATE TABLE / INSERT / DROP dance otherwise trips the FK that
    // points projects -> teams.
    await db.execute('PRAGMA foreign_keys = OFF');
    try {
      await db.execute(`
        CREATE TABLE projects_new (
          id              TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          name            TEXT NOT NULL,
          description     TEXT,
          version         INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          deleted_at      TEXT
        )
      `);

      // Copy projects with the team's org_id substituted for the
      // project's old team_id. LEFT JOIN so a project whose team was
      // never created (shouldn't happen but defensive) still moves
      // over with a NULL org_id — we'd then need to clean that up,
      // but in practice every project has a team.
      await db.execute(`
        INSERT INTO projects_new
          (id, organization_id, name, description, version, created_at, updated_at, deleted_at)
        SELECT p.id, t.organization_id, p.name, p.description, p.version,
               p.created_at, p.updated_at, p.deleted_at
          FROM projects p
          LEFT JOIN teams t ON t.id = p.team_id
      `);

      // Drop any rows that didn't get a real org_id mapped — the
      // schema is NOT NULL so they'd block the next migration anyway.
      await db.execute('DELETE FROM projects_new WHERE organization_id IS NULL');

      await db.execute('DROP TABLE projects');
      await db.execute('ALTER TABLE projects_new RENAME TO projects');
      await db.execute('CREATE INDEX idx_projects_org ON projects(organization_id)');

      await db.execute('DROP TABLE teams');
    } finally {
      await db.execute('PRAGMA foreign_keys = ON');
    }

    // Members.restricted — defaults to 0 (false). Existing rows get
    // the default automatically.
    await db.execute(
      'ALTER TABLE members ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0',
    );

    // Per-project access grants. Mirrors the server's ProjectMembers
    // table; populated by Phase 2.
    await db.execute(`
      CREATE TABLE project_members (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        granted_by  TEXT NOT NULL,
        granted_at  TEXT NOT NULL,
        UNIQUE(project_id, user_id)
      )
    `);
    await db.execute('CREATE INDEX idx_pm_project ON project_members(project_id)');
    await db.execute('CREATE INDEX idx_pm_user ON project_members(user_id)');
  },
};

const ALL_MIGRATIONS: Migration[] = [M001_INITIAL_SCHEMA, M002_DROP_TEAMS_MULTI_TENANT];

/**
 * Apply any migrations whose version is newer than what's recorded in
 * `schema_meta.version`. Runs in a single transaction per migration.
 */
export async function applyMigrations(db: DbDriver): Promise<void> {
  // schema_meta might not exist on first boot; the first migration creates
  // it. So we read defensively.
  let current = 0;
  try {
    const rows = await db.select<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'version'",
    );
    if (rows.length > 0) current = Number(rows[0].value) || 0;
  } catch {
    current = 0;
  }

  const pending = ALL_MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const m of pending) {
    await db.transaction(async () => {
      await m.up(db);
      // First migration creates schema_meta itself, so use INSERT OR REPLACE.
      await db.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
        [String(m.version)],
      );
    });
  }
}
