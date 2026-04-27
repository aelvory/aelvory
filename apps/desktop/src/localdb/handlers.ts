/**
 * Local API handlers — translate REST-shaped requests into SQL.
 *
 * Architectural rule: all data access in the app goes through `dispatchLocal`
 * (or its outer wrapper `api()` in `src/api/client.ts`). UI/stores never
 * touch the DB driver directly. This is the boundary that lets us swap
 * Tauri ↔ VSCode-extension-host ↔ browser.
 */

import { getDb } from './db';
import {
  newId,
  nowIso,
  type LCollection,
  type LEnvironment,
  type LMember,
  type LOrganization,
  type LProject,
  type LRequest,
  type LScript,
  type LUser,
  type LVariable,
} from './schema';
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
  requestFromRow,
  requestParams,
  scriptFromRow,
  scriptParams,
  userFromRow,
  variableFromRow,
  variableParams,
} from './rowMap';
import { ensureLocalUser, getLocalUserId } from './seed';

export class LocalApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    message?: string,
  ) {
    super(message ?? error);
  }
}

function notFound(): never {
  throw new LocalApiError(404, 'not_found');
}

function badRequest(error: string): never {
  throw new LocalApiError(400, error);
}

async function requireUserId(): Promise<string> {
  const id = getLocalUserId();
  if (id) {
    const db = await getDb();
    const rows = await db.select<{ id: string }>('SELECT id FROM users WHERE id = ?', [id]);
    if (rows.length > 0) return id;
  }
  const u = await ensureLocalUser();
  return u.id;
}

// --- Lookup helpers (return entity or undefined) ---

async function getOrg(id: string): Promise<LOrganization | undefined> {
  const db = await getDb();
  const rows = await db.select<any>('SELECT * FROM organizations WHERE id = ?', [id]);
  return rows[0] ? orgFromRow(rows[0]) : undefined;
}

async function getProject(id: string): Promise<LProject | undefined> {
  const db = await getDb();
  const rows = await db.select<any>('SELECT * FROM projects WHERE id = ?', [id]);
  return rows[0] ? projectFromRow(rows[0]) : undefined;
}

async function getEnv(id: string): Promise<LEnvironment | undefined> {
  const db = await getDb();
  const rows = await db.select<any>('SELECT * FROM environments WHERE id = ?', [id]);
  return rows[0] ? environmentFromRow(rows[0]) : undefined;
}

async function getCollection(id: string): Promise<LCollection | undefined> {
  const db = await getDb();
  const rows = await db.select<any>('SELECT * FROM collections WHERE id = ?', [id]);
  return rows[0] ? collectionFromRow(rows[0]) : undefined;
}

async function getRequest(id: string): Promise<LRequest | undefined> {
  const db = await getDb();
  const rows = await db.select<any>('SELECT * FROM requests WHERE id = ?', [id]);
  return rows[0] ? requestFromRow(rows[0]) : undefined;
}

// --- Insert/update helpers (single statement each) ---

async function insertOrg(o: LOrganization) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO organizations
       (id, name, kind, owner_id, version, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    orgParams(o),
  );
}

async function updateOrg(o: LOrganization) {
  const db = await getDb();
  await db.execute(
    `UPDATE organizations
       SET name = ?, kind = ?, owner_id = ?, version = ?,
           created_at = ?, updated_at = ?, deleted_at = ?
     WHERE id = ?`,
    [o.name, o.kind, o.ownerId, o.version, o.createdAt, o.updatedAt, o.deletedAt, o.id],
  );
}

async function insertMember(m: LMember) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO members
       (id, organization_id, user_id, role, restricted, wrapped_dek, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    memberParams(m),
  );
}

async function insertProject(p: LProject) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO projects
       (id, organization_id, name, description, version, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    projectParams(p),
  );
}

async function updateProject(p: LProject) {
  const db = await getDb();
  await db.execute(
    `UPDATE projects
       SET name = ?, description = ?, version = ?, updated_at = ?, deleted_at = ?
     WHERE id = ?`,
    [p.name, p.description, p.version, p.updatedAt, p.deletedAt, p.id],
  );
}

async function insertEnv(e: LEnvironment) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO environments
       (id, project_id, name, version, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    environmentParams(e),
  );
}

async function updateEnv(e: LEnvironment) {
  const db = await getDb();
  await db.execute(
    `UPDATE environments
       SET name = ?, version = ?, updated_at = ?, deleted_at = ?
     WHERE id = ?`,
    [e.name, e.version, e.updatedAt, e.deletedAt, e.id],
  );
}

async function upsertVariable(v: LVariable) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO variables
       (id, scope, scope_id, key, value, is_secret, ciphertext, nonce, key_id,
        version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id, key) DO UPDATE SET
        value      = excluded.value,
        is_secret  = excluded.is_secret,
        ciphertext = excluded.ciphertext,
        nonce      = excluded.nonce,
        key_id     = excluded.key_id,
        version    = excluded.version,
        updated_at = excluded.updated_at`,
    variableParams(v),
  );
}

async function insertCollection(c: LCollection) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO collections
       (id, project_id, parent_id, name, sort_index, auth, version,
        created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    collectionParams(c),
  );
}

async function updateCollection(c: LCollection) {
  const db = await getDb();
  await db.execute(
    `UPDATE collections
       SET project_id = ?, parent_id = ?, name = ?, sort_index = ?, auth = ?,
           version = ?, updated_at = ?, deleted_at = ?
     WHERE id = ?`,
    [
      c.projectId,
      c.parentId,
      c.name,
      c.sortIndex,
      c.auth == null ? null : JSON.stringify(c.auth),
      c.version,
      c.updatedAt,
      c.deletedAt,
      c.id,
    ],
  );
}

async function insertRequest(r: LRequest) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO requests
       (id, collection_id, name, kind, method, url, headers, body, auth,
        sort_index, version, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    requestParams(r),
  );
}

async function updateRequest(r: LRequest) {
  const db = await getDb();
  await db.execute(
    `UPDATE requests
       SET collection_id = ?, name = ?, method = ?, url = ?, headers = ?,
           body = ?, auth = ?, sort_index = ?, version = ?, updated_at = ?,
           deleted_at = ?
     WHERE id = ?`,
    [
      r.collectionId,
      r.name,
      r.method,
      r.url,
      JSON.stringify(r.headers ?? []),
      r.body == null ? null : JSON.stringify(r.body),
      r.auth == null ? null : JSON.stringify(r.auth),
      r.sortIndex,
      r.version,
      r.updatedAt,
      r.deletedAt,
      r.id,
    ],
  );
}

async function upsertScript(s: LScript) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO scripts
       (id, request_id, phase, source, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id, phase) DO UPDATE SET
        source     = excluded.source,
        version    = excluded.version,
        updated_at = excluded.updated_at`,
    scriptParams(s),
  );
}

// --- DTO shapers (match server JSON shape) ---

function toOrgDto(o: LOrganization) {
  return {
    id: o.id,
    name: o.name,
    kind: o.kind,
    ownerId: o.ownerId,
    version: o.version,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function toProjectDto(p: LProject) {
  return {
    id: p.id,
    organizationId: p.organizationId,
    name: p.name,
    description: p.description,
    version: p.version,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toEnvDto(e: LEnvironment) {
  return {
    id: e.id,
    projectId: e.projectId,
    name: e.name,
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function toVarDto(v: LVariable) {
  return {
    id: v.id,
    scope: v.scope,
    scopeId: v.scopeId,
    key: v.key,
    value: v.value,
    isSecret: v.isSecret,
    ciphertext: v.ciphertext,
    nonce: v.nonce,
    keyId: v.keyId,
    version: v.version,
  };
}

function toCollectionDto(c: LCollection) {
  return {
    id: c.id,
    projectId: c.projectId,
    parentId: c.parentId,
    name: c.name,
    sortIndex: c.sortIndex,
    auth: c.auth,
    version: c.version,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function toRequestDto(r: LRequest) {
  return {
    id: r.id,
    collectionId: r.collectionId,
    name: r.name,
    kind: r.kind,
    method: r.method,
    url: r.url,
    headers: r.headers ?? [],
    body: r.body,
    auth: r.auth,
    sortIndex: r.sortIndex,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toScriptDto(s: LScript) {
  return {
    id: s.id,
    requestId: s.requestId,
    phase: s.phase,
    source: s.source,
  };
}

function toUserDto(u: LUser) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    publicKey: u.publicKey,
  };
}

// --- Handler types ---

interface HandlerCtx {
  method: string;
  body: any;
  userId: string;
}

type Handler = (params: string[], ctx: HandlerCtx) => Promise<any>;

type MethodMap = Partial<Record<'GET' | 'POST' | 'PUT' | 'DELETE', Handler>>;

const routes: Array<[RegExp, MethodMap]> = [];

function route(pattern: RegExp, handlers: MethodMap) {
  routes.push([pattern, handlers]);
}

// --- Auth ---

route(/^\/api\/auth\/me$/, {
  GET: async (_, ctx) => {
    const db = await getDb();
    const rows = await db.select<any>('SELECT * FROM users WHERE id = ?', [ctx.userId]);
    if (rows.length === 0) notFound();
    return toUserDto(userFromRow(rows[0]));
  },
});

route(/^\/api\/auth\/login$/, {
  POST: async () => ({
    accessToken: 'local-session',
    refreshToken: 'local-session',
    expiresIn: 60 * 60 * 24 * 365,
  }),
});

route(/^\/api\/auth\/register$/, {
  POST: async () => ({
    accessToken: 'local-session',
    refreshToken: 'local-session',
    expiresIn: 60 * 60 * 24 * 365,
  }),
});

route(/^\/api\/auth\/refresh$/, {
  POST: async () => ({
    accessToken: 'local-session',
    refreshToken: 'local-session',
    expiresIn: 60 * 60 * 24 * 365,
  }),
});

route(/^\/api\/auth\/logout$/, {
  POST: async () => null,
});

// --- Organizations ---

route(/^\/api\/organizations$/, {
  GET: async () => {
    // No per-user filter on purpose. The server scopes SyncEntries by the
    // signed-in user already, so every organization that lands in the
    // local SQLite belongs to this account. Filtering by member.user_id
    // here used to make sense in the multi-tenant server model but
    // breaks cross-device sync: rows pulled from another device's first
    // push still carry that device's seed user id in the payload, and a
    // strict JOIN hides them from the new device.
    //
    // After `linkLocalUserToServerId`, all NEW writes use the canonical
    // server user id, so this filter would also lose its discriminating
    // power over time. Dropping it is the simpler + correct change.
    const db = await getDb();
    const rows = await db.select<any>(
      `SELECT * FROM organizations
        WHERE deleted_at IS NULL
        ORDER BY created_at`,
    );
    return rows.map((r) => toOrgDto(orgFromRow(r)));
  },
  POST: async (_, ctx) => {
    const now = nowIso();
    const org: LOrganization = {
      id: newId(),
      name: String(ctx.body?.name ?? 'Workspace'),
      kind: 'team',
      ownerId: ctx.userId,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const mem: LMember = {
      id: newId(),
      organizationId: org.id,
      userId: ctx.userId,
      role: 'owner',
      restricted: false,
      wrappedDek: null,
      createdAt: now,
    };
    const db = await getDb();
    await db.transaction(async () => {
      await insertOrg(org);
      await insertMember(mem);
    });
    return toOrgDto(org);
  },
});

// --- Projects ---
// Phase 1: projects belong directly to an organization (Team layer
// dropped). Routes mirror the server's new `/api/organizations/{orgId}/projects`.

route(/^\/api\/organizations\/([^/]+)\/projects$/, {
  GET: async ([orgId]) => {
    const db = await getDb();
    const rows = await db.select<any>(
      'SELECT * FROM projects WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at',
      [orgId],
    );
    return rows.map((r) => toProjectDto(projectFromRow(r)));
  },
  POST: async ([orgId], ctx) => {
    const now = nowIso();
    const project: LProject = {
      id: newId(),
      organizationId: orgId,
      name: String(ctx.body?.name ?? 'Project'),
      description: ctx.body?.description ?? null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await insertProject(project);
    return toProjectDto(project);
  },
});

route(/^\/api\/organizations\/([^/]+)\/projects\/([^/]+)$/, {
  PUT: async ([_orgId, projectId], ctx) => {
    const p = await getProject(projectId);
    if (!p || p.deletedAt) notFound();
    p.name = String(ctx.body?.name ?? p.name);
    p.description = ctx.body?.description ?? null;
    p.version++;
    p.updatedAt = nowIso();
    await updateProject(p);
    return toProjectDto(p);
  },
  DELETE: async ([_orgId, projectId]) => {
    const p = await getProject(projectId);
    if (!p || p.deletedAt) notFound();
    p.deletedAt = nowIso();
    await updateProject(p);
    return null;
  },
});

// --- Environments ---

route(/^\/api\/projects\/([^/]+)\/environments$/, {
  GET: async ([projectId]) => {
    const db = await getDb();
    const rows = await db.select<any>(
      'SELECT * FROM environments WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at',
      [projectId],
    );
    return rows.map((r) => toEnvDto(environmentFromRow(r)));
  },
  POST: async ([projectId], ctx) => {
    const now = nowIso();
    const env: LEnvironment = {
      id: newId(),
      projectId,
      name: String(ctx.body?.name ?? 'Environment'),
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await insertEnv(env);
    return toEnvDto(env);
  },
});

route(/^\/api\/projects\/([^/]+)\/environments\/([^/]+)$/, {
  PUT: async ([_projectId, envId], ctx) => {
    const e = await getEnv(envId);
    if (!e || e.deletedAt) notFound();
    e.name = String(ctx.body?.name ?? e.name);
    e.version++;
    e.updatedAt = nowIso();
    await updateEnv(e);
    return toEnvDto(e);
  },
  DELETE: async ([_projectId, envId]) => {
    const e = await getEnv(envId);
    if (!e || e.deletedAt) notFound();
    e.deletedAt = nowIso();
    await updateEnv(e);
    return null;
  },
});

route(/^\/api\/projects\/([^/]+)\/environments\/([^/]+)\/variables$/, {
  GET: async ([_projectId, envId]) => {
    const db = await getDb();
    const rows = await db.select<any>(
      "SELECT * FROM variables WHERE scope = 'environment' AND scope_id = ? ORDER BY key",
      [envId],
    );
    return rows.map((r) => toVarDto(variableFromRow(r)));
  },
  POST: async ([_projectId, envId], ctx) => {
    const key = String(ctx.body?.key ?? '').trim();
    if (!key) badRequest('missing_key');
    const db = await getDb();
    const existingRows = await db.select<any>(
      "SELECT * FROM variables WHERE scope = 'environment' AND scope_id = ? AND key = ?",
      [envId, key],
    );
    const now = nowIso();
    const existing = existingRows[0] ? variableFromRow(existingRows[0]) : null;
    const v: LVariable = existing
      ? { ...existing }
      : {
          id: newId(),
          scope: 'environment',
          scopeId: envId,
          key,
          value: null,
          isSecret: false,
          ciphertext: null,
          nonce: null,
          keyId: null,
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
    v.value = ctx.body?.value ?? null;
    v.isSecret = !!ctx.body?.isSecret;
    v.ciphertext = ctx.body?.ciphertext ?? null;
    v.nonce = ctx.body?.nonce ?? null;
    v.keyId = ctx.body?.keyId ?? null;
    v.version++;
    v.updatedAt = now;
    await upsertVariable(v);
    return toVarDto(v);
  },
});

route(/^\/api\/projects\/([^/]+)\/environments\/([^/]+)\/variables\/([^/]+)$/, {
  DELETE: async ([_p, _e, varId]) => {
    const db = await getDb();
    await db.execute('DELETE FROM variables WHERE id = ?', [varId]);
    return null;
  },
});

// --- Collections ---

route(/^\/api\/projects\/([^/]+)\/collections$/, {
  GET: async ([projectId]) => {
    const db = await getDb();
    const rows = await db.select<any>(
      'SELECT * FROM collections WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_index',
      [projectId],
    );
    return rows.map((r) => toCollectionDto(collectionFromRow(r)));
  },
  POST: async ([projectId], ctx) => {
    const parentId: string | null = ctx.body?.parentId ?? null;
    const db = await getDb();
    // Count siblings for default sort_index. SQL handles NULL natively
    // (no IndexedDB key-range trick required).
    const sortIndex =
      ctx.body?.sortIndex ??
      (
        await db.select<{ n: number }>(
          parentId === null
            ? `SELECT COUNT(*) AS n FROM collections
                 WHERE project_id = ? AND parent_id IS NULL AND deleted_at IS NULL`
            : `SELECT COUNT(*) AS n FROM collections
                 WHERE project_id = ? AND parent_id = ? AND deleted_at IS NULL`,
          parentId === null ? [projectId] : [projectId, parentId],
        )
      )[0].n;
    const now = nowIso();
    const c: LCollection = {
      id: newId(),
      projectId,
      parentId,
      name: String(ctx.body?.name ?? 'Collection'),
      sortIndex: Number(sortIndex) || 0,
      auth: ctx.body?.auth ?? null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await insertCollection(c);
    return toCollectionDto(c);
  },
});

route(/^\/api\/projects\/([^/]+)\/collections\/([^/]+)$/, {
  GET: async ([_p, colId]) => {
    const c = await getCollection(colId);
    if (!c || c.deletedAt) notFound();
    return toCollectionDto(c);
  },
  PUT: async ([_p, colId], ctx) => {
    const c = await getCollection(colId);
    if (!c || c.deletedAt) notFound();
    c.name = String(ctx.body?.name ?? c.name);
    c.auth = ctx.body?.auth ?? null;
    c.version++;
    c.updatedAt = nowIso();
    await updateCollection(c);
    return toCollectionDto(c);
  },
  DELETE: async ([_p, colId]) => {
    const c = await getCollection(colId);
    if (!c) notFound();
    c.deletedAt = nowIso();
    await updateCollection(c);
    return null;
  },
});

route(/^\/api\/projects\/([^/]+)\/collections\/([^/]+)\/move$/, {
  POST: async ([projectId, colId], ctx) => {
    const c = await getCollection(colId);
    if (!c || c.deletedAt) notFound();
    const newParentId: string | null = ctx.body?.newParentId ?? null;
    const newSortIndex: number = ctx.body?.newSortIndex ?? 0;

    if (newParentId === colId) badRequest('cannot_parent_to_self');

    if (newParentId) {
      const descendants = await collectDescendantIds(colId);
      if (descendants.has(newParentId)) badRequest('cannot_move_into_descendant');
    }

    const oldParentId = c.parentId;
    c.parentId = newParentId;
    c.version++;
    c.updatedAt = nowIso();

    const newSiblings = (await siblingsByParent(projectId, newParentId)).filter(
      (s) => s.id !== colId && !s.deletedAt,
    );
    newSiblings.sort((a, b) => a.sortIndex - b.sortIndex);
    const insertAt = Math.max(0, Math.min(newSortIndex, newSiblings.length));
    newSiblings.splice(insertAt, 0, c);
    for (let i = 0; i < newSiblings.length; i++) newSiblings[i].sortIndex = i;

    let oldSiblings: LCollection[] = [];
    if (oldParentId !== newParentId) {
      oldSiblings = (await siblingsByParent(projectId, oldParentId))
        .filter((s) => s.id !== colId && !s.deletedAt)
        .sort((a, b) => a.sortIndex - b.sortIndex);
      for (let i = 0; i < oldSiblings.length; i++) oldSiblings[i].sortIndex = i;
    }

    const db = await getDb();
    await db.transaction(async () => {
      for (const s of newSiblings) await updateCollection(s);
      for (const s of oldSiblings) await updateCollection(s);
    });

    return toCollectionDto(c);
  },
});

route(/^\/api\/projects\/([^/]+)\/collections\/([^/]+)\/variables$/, {
  GET: async ([_p, colId]) => {
    const db = await getDb();
    const rows = await db.select<any>(
      "SELECT * FROM variables WHERE scope = 'collection' AND scope_id = ? ORDER BY key",
      [colId],
    );
    return rows.map((r) => toVarDto(variableFromRow(r)));
  },
  POST: async ([_p, colId], ctx) => {
    const key = String(ctx.body?.key ?? '').trim();
    if (!key) badRequest('missing_key');
    const db = await getDb();
    const existingRows = await db.select<any>(
      "SELECT * FROM variables WHERE scope = 'collection' AND scope_id = ? AND key = ?",
      [colId, key],
    );
    const now = nowIso();
    const existing = existingRows[0] ? variableFromRow(existingRows[0]) : null;
    const v: LVariable = existing
      ? { ...existing }
      : {
          id: newId(),
          scope: 'collection',
          scopeId: colId,
          key,
          value: null,
          isSecret: false,
          ciphertext: null,
          nonce: null,
          keyId: null,
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
    v.value = ctx.body?.value ?? null;
    v.isSecret = !!ctx.body?.isSecret;
    v.ciphertext = ctx.body?.ciphertext ?? null;
    v.nonce = ctx.body?.nonce ?? null;
    v.keyId = ctx.body?.keyId ?? null;
    v.version++;
    v.updatedAt = now;
    await upsertVariable(v);
    return toVarDto(v);
  },
});

route(/^\/api\/projects\/([^/]+)\/collections\/([^/]+)\/variables\/([^/]+)$/, {
  DELETE: async ([_p, _c, varId]) => {
    const db = await getDb();
    await db.execute('DELETE FROM variables WHERE id = ?', [varId]);
    return null;
  },
});

// --- Requests ---

route(/^\/api\/collections\/([^/]+)\/requests$/, {
  GET: async ([colId]) => {
    const db = await getDb();
    const rows = await db.select<any>(
      'SELECT * FROM requests WHERE collection_id = ? AND deleted_at IS NULL ORDER BY sort_index',
      [colId],
    );
    return rows.map((r) => toRequestDto(requestFromRow(r)));
  },
  POST: async ([colId], ctx) => {
    const db = await getDb();
    let sortIndex: number;
    if (typeof ctx.body?.sortIndex === 'number') {
      sortIndex = ctx.body.sortIndex;
    } else {
      const countRows = await db.select<{ n: number }>(
        'SELECT COUNT(*) AS n FROM requests WHERE collection_id = ? AND deleted_at IS NULL',
        [colId],
      );
      sortIndex = Number(countRows[0]?.n ?? 0);
    }
    const now = nowIso();
    const r: LRequest = {
      id: newId(),
      collectionId: colId,
      name: String(ctx.body?.name ?? 'Request'),
      kind: String(ctx.body?.kind ?? 'http'),
      method: String(ctx.body?.method ?? 'GET'),
      url: String(ctx.body?.url ?? 'https://httpbin.org/get'),
      headers: ctx.body?.headers ?? [],
      body: ctx.body?.body ?? null,
      auth: ctx.body?.auth ?? null,
      sortIndex,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await insertRequest(r);
    return toRequestDto(r);
  },
});

route(/^\/api\/collections\/([^/]+)\/requests\/([^/]+)$/, {
  GET: async ([_c, reqId]) => {
    const r = await getRequest(reqId);
    if (!r || r.deletedAt) notFound();
    return toRequestDto(r);
  },
  PUT: async ([_c, reqId], ctx) => {
    const r = await getRequest(reqId);
    if (!r || r.deletedAt) notFound();
    r.name = String(ctx.body?.name ?? r.name);
    r.method = String(ctx.body?.method ?? r.method);
    r.url = String(ctx.body?.url ?? r.url);
    r.headers = ctx.body?.headers ?? [];
    r.body = ctx.body?.body ?? null;
    r.auth = ctx.body?.auth ?? null;
    r.version++;
    r.updatedAt = nowIso();
    await updateRequest(r);
    return toRequestDto(r);
  },
  DELETE: async ([_c, reqId]) => {
    const r = await getRequest(reqId);
    if (!r) notFound();
    r.deletedAt = nowIso();
    await updateRequest(r);
    return null;
  },
});

route(/^\/api\/collections\/([^/]+)\/requests\/([^/]+)\/move$/, {
  POST: async ([colId, reqId], ctx) => {
    const r = await getRequest(reqId);
    if (!r || r.deletedAt) notFound();
    const newCollectionId = String(ctx.body?.newCollectionId ?? colId);
    const newSortIndex = ctx.body?.newSortIndex ?? 0;
    const oldCollectionId = r.collectionId;

    r.collectionId = newCollectionId;
    r.version++;
    r.updatedAt = nowIso();

    const db = await getDb();
    const newSiblingsRows = await db.select<any>(
      'SELECT * FROM requests WHERE collection_id = ? AND deleted_at IS NULL',
      [newCollectionId],
    );
    const newSiblings = newSiblingsRows
      .map((row: any) => requestFromRow(row))
      .filter((s: LRequest) => s.id !== reqId)
      .sort((a: LRequest, b: LRequest) => a.sortIndex - b.sortIndex);
    const insertAt = Math.max(0, Math.min(newSortIndex, newSiblings.length));
    newSiblings.splice(insertAt, 0, r);
    for (let i = 0; i < newSiblings.length; i++) newSiblings[i].sortIndex = i;

    let oldSiblings: LRequest[] = [];
    if (oldCollectionId !== newCollectionId) {
      const oldRows = await db.select<any>(
        'SELECT * FROM requests WHERE collection_id = ? AND deleted_at IS NULL',
        [oldCollectionId],
      );
      oldSiblings = oldRows
        .map((row: any) => requestFromRow(row))
        .filter((s: LRequest) => s.id !== reqId)
        .sort((a: LRequest, b: LRequest) => a.sortIndex - b.sortIndex);
      for (let i = 0; i < oldSiblings.length; i++) oldSiblings[i].sortIndex = i;
    }

    await db.transaction(async () => {
      for (const s of newSiblings) await updateRequest(s);
      for (const s of oldSiblings) await updateRequest(s);
    });
    return toRequestDto(r);
  },
});

route(/^\/api\/collections\/([^/]+)\/requests\/([^/]+)\/duplicate$/, {
  POST: async ([_c, reqId]) => {
    const src = await getRequest(reqId);
    if (!src || src.deletedAt) notFound();
    const now = nowIso();
    const copy: LRequest = {
      ...src,
      id: newId(),
      name: `${src.name} (copy)`,
      sortIndex: src.sortIndex + 1,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await insertRequest(copy);
    return toRequestDto(copy);
  },
});

// --- Scripts ---

route(/^\/api\/collections\/([^/]+)\/requests\/([^/]+)\/scripts$/, {
  GET: async ([_c, reqId]) => {
    const db = await getDb();
    const rows = await db.select<any>(
      'SELECT * FROM scripts WHERE request_id = ?',
      [reqId],
    );
    return rows.map((r) => toScriptDto(scriptFromRow(r)));
  },
  PUT: async ([_c, reqId], ctx) => {
    const phase = String(ctx.body?.phase ?? 'pre') as 'pre' | 'post' | 'test';
    const source = String(ctx.body?.source ?? '');
    const db = await getDb();
    const existingRows = await db.select<any>(
      'SELECT * FROM scripts WHERE request_id = ? AND phase = ?',
      [reqId, phase],
    );
    const now = nowIso();
    const existing = existingRows[0] ? scriptFromRow(existingRows[0]) : null;
    const s: LScript = existing ?? {
      id: newId(),
      requestId: reqId,
      phase,
      source: '',
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    s.source = source;
    s.version++;
    s.updatedAt = now;
    await upsertScript(s);
    return toScriptDto(s);
  },
});

// --- Helpers ---

async function siblingsByParent(
  projectId: string,
  parentId: string | null,
): Promise<LCollection[]> {
  const db = await getDb();
  const rows = await db.select<any>(
    parentId === null
      ? 'SELECT * FROM collections WHERE project_id = ? AND parent_id IS NULL'
      : 'SELECT * FROM collections WHERE project_id = ? AND parent_id = ?',
    parentId === null ? [projectId] : [projectId, parentId],
  );
  return rows.map((r) => collectionFromRow(r));
}

async function collectDescendantIds(rootId: string): Promise<Set<string>> {
  const db = await getDb();
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const current = stack.pop()!;
    const rows = await db.select<{ id: string; deleted_at: string | null }>(
      'SELECT id, deleted_at FROM collections WHERE parent_id = ?',
      [current],
    );
    for (const k of rows) {
      if (!k.deleted_at && !result.has(k.id)) {
        result.add(k.id);
        stack.push(k.id);
      }
    }
  }
  return result;
}

// --- Dispatcher ---

export async function dispatchLocal<T>(
  path: string,
  method: string,
  body: unknown,
): Promise<T> {
  const userId = await requireUserId();
  const upper = method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE';
  const urlPath = path.split('?')[0];

  for (const [pattern, methods] of routes) {
    const match = urlPath.match(pattern);
    if (!match) continue;
    const handler = methods[upper];
    if (!handler) throw new LocalApiError(405, 'method_not_allowed');
    const params = match.slice(1);
    return (await handler(params, { method: upper, body, userId })) as T;
  }

  throw new LocalApiError(404, `no_local_handler: ${method} ${urlPath}`);
}
