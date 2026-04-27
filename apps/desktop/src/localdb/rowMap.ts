/**
 * Row mappers between SQLite columns (snake_case, JSON-as-text, 0/1 booleans)
 * and the camelCase TS types in `schema.ts`. Centralizing this here keeps
 * `handlers.ts` free of column-name ceremony.
 */

import type {
  LCollection,
  LEnvironment,
  LMember,
  LOrganization,
  LProject,
  LProjectMember,
  LRequest,
  LScript,
  LUser,
  LVariable,
} from './schema';

// ---------- helpers ----------

function jbool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function toJsonOrNull(v: unknown): string | null {
  if (v == null) return null;
  return JSON.stringify(v);
}

// ---------- row -> entity ----------

export function userFromRow(r: any): LUser {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    publicKey: r.public_key ?? null,
    createdAt: r.created_at,
  };
}

export function orgFromRow(r: any): LOrganization {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    ownerId: r.owner_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
  };
}

export function memberFromRow(r: any): LMember {
  return {
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    role: r.role,
    restricted: jbool(r.restricted),
    wrappedDek: r.wrapped_dek ?? null,
    createdAt: r.created_at,
  };
}

export function projectFromRow(r: any): LProject {
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    description: r.description ?? null,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
  };
}

export function projectMemberFromRow(r: any): LProjectMember {
  return {
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  };
}

export function environmentFromRow(r: any): LEnvironment {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
  };
}

export function variableFromRow(r: any): LVariable {
  return {
    id: r.id,
    scope: r.scope,
    scopeId: r.scope_id,
    key: r.key,
    value: r.value ?? null,
    isSecret: jbool(r.is_secret),
    ciphertext: r.ciphertext ?? null,
    nonce: r.nonce ?? null,
    keyId: r.key_id ?? null,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function collectionFromRow(r: any): LCollection {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id ?? null,
    name: r.name,
    sortIndex: r.sort_index,
    auth: parseJson(r.auth, null),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
  };
}

export function requestFromRow(r: any): LRequest {
  return {
    id: r.id,
    collectionId: r.collection_id,
    name: r.name,
    kind: r.kind,
    method: r.method,
    url: r.url,
    headers: parseJson<unknown[]>(r.headers, []),
    body: parseJson(r.body, null),
    auth: parseJson(r.auth, null),
    sortIndex: r.sort_index,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
  };
}

export function scriptFromRow(r: any): LScript {
  return {
    id: r.id,
    requestId: r.request_id,
    phase: r.phase,
    source: r.source,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- entity -> row params ----------

export const userParams = (u: LUser) => [
  u.id,
  u.email,
  u.displayName,
  u.publicKey,
  u.createdAt,
];

export const orgParams = (o: LOrganization) => [
  o.id,
  o.name,
  o.kind,
  o.ownerId,
  o.version,
  o.createdAt,
  o.updatedAt,
  o.deletedAt,
];

export const memberParams = (m: LMember) => [
  m.id,
  m.organizationId,
  m.userId,
  m.role,
  m.restricted ? 1 : 0,
  m.wrappedDek,
  m.createdAt,
];

export const projectParams = (p: LProject) => [
  p.id,
  p.organizationId,
  p.name,
  p.description,
  p.version,
  p.createdAt,
  p.updatedAt,
  p.deletedAt,
];

export const projectMemberParams = (pm: LProjectMember) => [
  pm.id,
  pm.projectId,
  pm.userId,
  pm.grantedBy,
  pm.grantedAt,
];

export const environmentParams = (e: LEnvironment) => [
  e.id,
  e.projectId,
  e.name,
  e.version,
  e.createdAt,
  e.updatedAt,
  e.deletedAt,
];

export const variableParams = (v: LVariable) => [
  v.id,
  v.scope,
  v.scopeId,
  v.key,
  v.value,
  v.isSecret ? 1 : 0,
  v.ciphertext,
  v.nonce,
  v.keyId,
  v.version,
  v.createdAt,
  v.updatedAt,
];

export const collectionParams = (c: LCollection) => [
  c.id,
  c.projectId,
  c.parentId,
  c.name,
  c.sortIndex,
  toJsonOrNull(c.auth),
  c.version,
  c.createdAt,
  c.updatedAt,
  c.deletedAt,
];

export const requestParams = (r: LRequest) => [
  r.id,
  r.collectionId,
  r.name,
  r.kind,
  r.method,
  r.url,
  JSON.stringify(r.headers ?? []),
  toJsonOrNull(r.body),
  toJsonOrNull(r.auth),
  r.sortIndex,
  r.version,
  r.createdAt,
  r.updatedAt,
  r.deletedAt,
];

export const scriptParams = (s: LScript) => [
  s.id,
  s.requestId,
  s.phase,
  s.source,
  s.version,
  s.createdAt,
  s.updatedAt,
];
