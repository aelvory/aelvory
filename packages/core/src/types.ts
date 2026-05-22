export type UUID = string;

export type OrganizationKind = 'personal' | 'team';
/**
 * Roles a user can hold inside an organization. Phase 1 dropped the
 * 'viewer' role — see Entities/Organization.cs on the server for the
 * rationale (project-level restriction supersedes a global read-only
 * tier).
 */
export type MemberRole = 'owner' | 'admin' | 'editor';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type RequestKind = 'http' | 'ws' | 'sse' | 'graphql';
export type ScriptPhase = 'pre' | 'post' | 'test';
export type VariableScope =
  | 'global'
  | 'organization'
  | 'team'
  | 'project'
  | 'environment'
  | 'request'
  | 'collection';

export interface EntityBase {
  id: UUID;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt?: string | null;
}

export interface User extends EntityBase {
  email: string;
  displayName: string;
  publicKey?: string;
}

export interface Organization extends EntityBase {
  name: string;
  kind: OrganizationKind;
  ownerId: UUID;
}

export interface Member {
  id: UUID;
  organizationId: UUID;
  userId: UUID;
  role: MemberRole;
  /**
   * Phase 1 added this column (default false). When true, the user
   * only sees projects listed in `ProjectMember` rows; when false,
   * they see every project in the org. Owners and admins are
   * implicitly unrestricted regardless.
   */
  restricted?: boolean;
  wrappedDek?: string;
}

export interface ProjectMember {
  id: UUID;
  projectId: UUID;
  userId: UUID;
  grantedBy: UUID;
  grantedAt: string;
}

/**
 * Phase 1 of the multi-tenant rework dropped the Team layer; Project
 * is now a direct child of Organization. The legacy Team type is kept
 * as a deprecated alias only because some external tooling may still
 * import it — new code should not reference it.
 *
 * @deprecated Removed from the data model in Phase 1.
 */
export interface Team extends EntityBase {
  organizationId: UUID;
  name: string;
  description?: string;
}

export interface Project extends EntityBase {
  organizationId: UUID;
  name: string;
  description?: string;
}

export interface ApiEnvironment extends EntityBase {
  projectId: UUID;
  name: string;
}

export interface Variable {
  id: UUID;
  scope: VariableScope;
  scopeId: UUID;
  key: string;
  value: string | null;
  isSecret: boolean;
  ciphertext?: string;
  nonce?: string;
  keyId?: UUID;
  version: number;
}

export interface Collection extends EntityBase {
  projectId: UUID;
  parentId: UUID | null;
  name: string;
  sortIndex: number;
  auth?: AuthConfig | null;
}

export interface Header {
  key: string;
  value: string;
  enabled: boolean;
}

/**
 * A single URL query-string parameter. Shares the toggleable
 * `enabled` semantic with Header, plus an optional `presets` list:
 * when set, the editor renders the value cell as a dropdown of those
 * choices instead of a free-text input. The point of presets is
 * letting a user define the allowed values once (e.g. an enum-like
 * server parameter) and just pick from them on subsequent runs.
 */
export interface QueryParam {
  key: string;
  value: string;
  enabled: boolean;
  /**
   * Allowed values for this param. When non-empty, the value cell in
   * the editor renders as a Select; the user can still type a free
   * value via the "custom" option. Edit/add/remove happens inline in
   * the editor row's "manage presets" popover.
   */
  presets?: string[];
  /** Optional plain-text description shown as a placeholder/tooltip. */
  description?: string;
}

export interface RequestBody {
  type: 'none' | 'form' | 'multipart' | 'raw' | 'binary' | 'graphql';
  raw?: string;
  contentType?: string;
}

export interface AuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'apikey' | 'oauth2' | 'aws-sigv4' | 'digest';
  config: Record<string, unknown>;
}

export interface ApiRequest extends EntityBase {
  collectionId: UUID;
  name: string;
  kind: RequestKind;
  method: HttpMethod | string;
  url: string;
  headers: Header[];
  /**
   * Toggleable query-string params merged into the URL at send time
   * (see `applyQueryParams` in the runner). Disabled rows are
   * skipped. Optional for backwards compatibility — pre-feature
   * rows that come back from disk without this field default to [].
   */
  queryParams?: QueryParam[];
  body: RequestBody | null;
  auth: AuthConfig | null;
  sortIndex: number;
}

export interface Script {
  id: UUID;
  requestId: UUID;
  phase: ScriptPhase;
  source: string;
}

export interface ActivityLog {
  id: UUID;
  actorId: UUID;
  organizationId: UUID;
  entityType: string;
  entityId: UUID;
  action: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

// Runner

export interface ExecuteRequestPayload {
  method: string;
  url: string;
  headers?: Header[];
  body?: RequestBody | null;
  auth?: AuthConfig | null;
  timeoutMs?: number;
}

export interface ExecuteResponse {
  status: number;
  statusText: string;
  headers: Header[];
  requestHeaders: Header[];
  requestUrl: string;
  requestMethod: string;
  body: string;
  durationMs: number;
  sizeBytes: number;
  contentType?: string | null;
  /**
   * Raw error string surfaced from the underlying transport (Tauri's
   * plugin-http, the VSCode bridge's Node fetch, or browser fetch).
   * Set whenever `status === 0` (request never completed). For
   * transports that don't throw rich Error objects — Tauri plugin-http
   * notably rejects with plain strings or objects on Windows — we
   * stringify whatever was thrown.
   */
  errorMessage?: string | null;
  /**
   * Optional human-readable hint about what likely went wrong, paired
   * with `errorMessage` for actionability. Generated by pattern-matching
   * known transport errors (cert validation, DNS failure, connection
   * refused, etc.) — null when no specific hint applies.
   */
  errorHint?: string | null;
}
