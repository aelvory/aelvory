import { tableAll, tableDelete, tableGet, tablePut } from '@/localdb/generic';
import { TABLES_WITH_DELETED_AT, type TableName } from '@/localdb/schema';
import {
  bytesFromJson,
  bytesToBase64,
  bytesToJson,
  decryptPayload,
  encryptPayload,
  bytesFromBase64,
  type DerivedKey,
} from './syncCrypto';
import {
  pullEntries,
  pushEntries,
  type SyncEntryWireDto,
  type SyncPushResponse,
  type SyncPullResponse,
} from './syncClient';

/**
 * Tables that participate in sync. Each row gets pushed to the server
 * with the organization/project it belongs to as metadata, and the
 * server scopes pull responses by the caller's membership.
 *
 * `users` is intentionally NOT here: per-device user records are
 * created locally on first launch and aligned to the server identity
 * via the rename helper at sign-in time. Syncing them across devices
 * doesn't add value and would conflict with that model.
 */
const SYNCED_TABLES: TableName[] = [
  'organizations',
  'members',
  'project_members',
  'projects',
  'environments',
  'variables',
  'collections',
  'requests',
  'scripts',
];

interface LocalRowBase {
  id: string;
  updatedAt?: string;
  deletedAt?: string | null;
  // Below: optional fields used for scope resolution. Different tables
  // expose different subsets — TS doesn't statically narrow this, so
  // resolveScope handles the per-table cases below.
  organizationId?: string;
  projectId?: string;
  collectionId?: string;
  requestId?: string;
  scope?: string;
  scopeId?: string;
}

interface ScopeIndex {
  /** projectId → orgId */
  projectOrg: Map<string, string>;
  /** collectionId → projectId */
  collectionProject: Map<string, string>;
  /** envId → projectId */
  envProject: Map<string, string>;
  /** requestId → collectionId */
  requestCollection: Map<string, string>;
}

/**
 * Pre-load the parent-relationship maps once per sync pass so we don't
 * do an N+1 lookup walking every variable's collection's project's org.
 * Cheap on local SQLite — typical user has hundreds of rows total.
 */
async function buildScopeIndex(): Promise<ScopeIndex> {
  const projects = await tableAll<{ id: string; organizationId: string }>('projects');
  const collections = await tableAll<{ id: string; projectId: string }>('collections');
  const envs = await tableAll<{ id: string; projectId: string }>('environments');
  const requests = await tableAll<{ id: string; collectionId: string }>('requests');

  return {
    projectOrg: new Map(projects.map((p) => [p.id, p.organizationId])),
    collectionProject: new Map(collections.map((c) => [c.id, c.projectId])),
    envProject: new Map(envs.map((e) => [e.id, e.projectId])),
    requestCollection: new Map(requests.map((r) => [r.id, r.collectionId])),
  };
}

/**
 * Determine which org + (optionally) project a row belongs to. Returns
 * null org-id when scope is unresolvable — caller drops those rows
 * (orphaned or mid-creation; safe to skip).
 */
function resolveScope(
  table: TableName,
  row: LocalRowBase,
  idx: ScopeIndex,
): { orgId: string | null; projectId: string | null } {
  switch (table) {
    case 'organizations':
      return { orgId: row.id, projectId: null };
    case 'members':
      return { orgId: row.organizationId ?? null, projectId: null };
    case 'project_members': {
      const projectId = row.projectId ?? null;
      const orgId = projectId ? idx.projectOrg.get(projectId) ?? null : null;
      return { orgId, projectId };
    }
    case 'projects':
      return { orgId: row.organizationId ?? null, projectId: row.id };
    case 'environments':
    case 'collections': {
      const projectId = row.projectId ?? null;
      const orgId = projectId ? idx.projectOrg.get(projectId) ?? null : null;
      return { orgId, projectId };
    }
    case 'requests': {
      const collectionId = row.collectionId ?? null;
      const projectId = collectionId
        ? idx.collectionProject.get(collectionId) ?? null
        : null;
      const orgId = projectId ? idx.projectOrg.get(projectId) ?? null : null;
      return { orgId, projectId };
    }
    case 'scripts': {
      const requestId = row.requestId ?? null;
      const collectionId = requestId
        ? idx.requestCollection.get(requestId) ?? null
        : null;
      const projectId = collectionId
        ? idx.collectionProject.get(collectionId) ?? null
        : null;
      const orgId = projectId ? idx.projectOrg.get(projectId) ?? null : null;
      return { orgId, projectId };
    }
    case 'variables': {
      const scopeId = row.scopeId ?? null;
      let projectId: string | null = null;
      if (row.scope === 'environment' && scopeId) {
        projectId = idx.envProject.get(scopeId) ?? null;
      } else if (row.scope === 'collection' && scopeId) {
        projectId = idx.collectionProject.get(scopeId) ?? null;
      }
      const orgId = projectId ? idx.projectOrg.get(projectId) ?? null : null;
      return { orgId, projectId };
    }
    default:
      return { orgId: null, projectId: null };
  }
}

interface ScopedRow {
  table: TableName;
  row: LocalRowBase;
  orgId: string;
  projectId: string | null;
}

/**
 * Walk every synced table and tag each row with its scope. Returns rows
 * grouped by org so the caller can push one org at a time.
 */
async function collectScopedRows(
  sinceIsoByOrg: Record<string, string | null>,
): Promise<Map<string, ScopedRow[]>> {
  const idx = await buildScopeIndex();
  const byOrg = new Map<string, ScopedRow[]>();

  for (const table of SYNCED_TABLES) {
    const rows = await tableAll<LocalRowBase>(table);
    for (const row of rows) {
      if (!row || !row.id) continue;
      const { orgId, projectId } = resolveScope(table, row, idx);
      if (!orgId) continue; // unresolvable — skip silently
      const since = sinceIsoByOrg[orgId] ?? null;
      if (since && row.updatedAt && row.updatedAt <= since) continue;
      const bucket = byOrg.get(orgId) ?? [];
      bucket.push({ table, row, orgId, projectId });
      byOrg.set(orgId, bucket);
    }
  }

  return byOrg;
}

async function toWireEntry(
  scoped: ScopedRow,
  key: DerivedKey | null,
): Promise<SyncEntryWireDto> {
  const jsonBytes = bytesFromJson(scoped.row);
  const base = {
    organizationId: scoped.orgId,
    projectId: scoped.projectId,
    entityType: scoped.table,
    entityId: scoped.row.id,
    updatedAt: scoped.row.updatedAt ?? new Date().toISOString(),
    deletedAt: scoped.row.deletedAt ?? null,
    seq: 0,
  };
  if (key) {
    const { ciphertext, header } = await encryptPayload(jsonBytes, key);
    return {
      ...base,
      payloadFormat: 'encrypted',
      payload: await bytesToBase64(ciphertext),
      cryptoHeader: JSON.stringify(header),
    };
  }
  return {
    ...base,
    payloadFormat: 'plain',
    payload: await bytesToBase64(jsonBytes),
    cryptoHeader: null,
  };
}

async function applyIncoming(
  entry: SyncEntryWireDto,
  key: DerivedKey | null,
): Promise<'applied' | 'skipped-older' | 'skipped-unknown' | 'skipped-decrypt'> {
  if (!(SYNCED_TABLES as readonly string[]).includes(entry.entityType)) {
    return 'skipped-unknown';
  }
  const tableName = entry.entityType as TableName;
  const existing = await tableGet<LocalRowBase>(tableName, entry.entityId);

  // Local-wins / echo-skip combined into one check.
  //
  // Compares parsed millisecond timestamps, NOT raw strings. The
  // server round-trips DateTime through Postgres + System.Text.Json
  // which can normalize the wire form differently than the desktop
  // sent — trailing-zero trimming, microsecond vs millisecond
  // precision, etc. Raw `===` would treat "2026-04-26T12:00:00.123Z"
  // and "2026-04-26T12:00:00.123000Z" as different, miss the echo,
  // re-apply the row, bump dataVersion, and the workspace +
  // collections + environments stores would all refetch — every
  // local write becomes a perceptible UI flicker even on the
  // editing device.
  //
  // What we want:
  //   - existing strictly newer (by millisecond) → skip (local wins)
  //   - existing equal-by-millisecond AND deleted-state matches →
  //     skip (echo of our own push, or harmless duplicate)
  //   - existing equal-by-millisecond but tombstone state changed →
  //     apply (a delete arriving on a row we have non-deleted, or
  //     vice versa, MUST land)
  //   - existing older or absent → apply
  if (existing && existing.updatedAt) {
    const existingMs = Date.parse(existing.updatedAt);
    const entryMs = Date.parse(entry.updatedAt);
    if (Number.isFinite(existingMs) && Number.isFinite(entryMs)) {
      if (existingMs > entryMs) {
        return 'skipped-older';
      }
      if (
        existingMs === entryMs &&
        Boolean(existing.deletedAt) === Boolean(entry.deletedAt)
      ) {
        return 'skipped-older';
      }
    }
  }

  const payloadBytes = await bytesFromBase64(entry.payload);
  let rowBytes: Uint8Array;
  if (entry.payloadFormat === 'encrypted') {
    if (!key || !entry.cryptoHeader) {
      return 'skipped-decrypt';
    }
    rowBytes = await decryptPayload(payloadBytes, entry.cryptoHeader, key);
  } else {
    rowBytes = payloadBytes;
  }

  const row = bytesToJson<LocalRowBase>(rowBytes);

  // Backfill scope fields from the envelope. Two cases this catches:
  //
  // 1. Legacy payloads pushed before the multi-tenant rework. Those
  //    rows have `teamId` instead of `organizationId` (or no scope
  //    fields at all on tables that didn't carry them then). The
  //    server's migration backfilled `SyncEntries.OrganizationId`
  //    on the envelope but the JSON blobs inside are untouched.
  //    Without this, INSERT into `projects` blows up on the
  //    NOT NULL `organization_id` constraint.
  //
  // 2. Future-proofing: the envelope's scope is authoritative
  //    anyway (the server validates it on push), so any payload
  //    that disagrees can be safely overruled by the envelope.
  switch (tableName) {
    case 'projects':
      if (!row.organizationId && entry.organizationId) {
        row.organizationId = entry.organizationId;
      }
      break;
    case 'members':
      if (!row.organizationId && entry.organizationId) {
        row.organizationId = entry.organizationId;
      }
      break;
    case 'project_members':
    case 'collections':
    case 'environments':
      if (!row.projectId && entry.projectId) {
        row.projectId = entry.projectId;
      }
      break;
    default:
      // requests/scripts/variables: parent ref isn't carried in the
      // envelope (collectionId / requestId / scope+scopeId aren't
      // sync-envelope fields). If those are missing on a legacy
      // payload there's nothing we can do here — the row is a true
      // orphan and the constraint failure surfaces correctly.
      break;
  }

  // Tombstones: dispatch by table shape.
  //
  // Tables WITH a deleted_at column (orgs, projects, environments,
  // collections, requests) — upsert the row as-is. The payload
  // already carries deletedAt set, and tablePut writes it through to
  // the deleted_at column. UI queries filter `WHERE deleted_at IS
  // NULL` and stop showing it.
  //
  // Tables WITHOUT (members, project_members, variables, scripts) —
  // the local schema can't represent "soft-deleted." We hard-DELETE
  // by id. Server-side tombstones for these are emitted by the
  // admin-UI controllers (RemoveMember, Revoke grant, etc.) so the
  // legitimate-delete path is well-defined.
  if (entry.deletedAt && !TABLES_WITH_DELETED_AT.has(tableName)) {
    await tableDelete(tableName, entry.entityId);
  } else {
    await tablePut(tableName, row);
  }
  return 'applied';
}

export interface SyncResult {
  pushed: SyncPushResponse;
  pulled: SyncPullResponse;
  appliedLocally: number;
  skippedOlder: number;
}

export interface RunSyncOptions {
  /** Bearer token for the sync server. */
  token: string;
  /** Organization to sync. Phase 1 always syncs one org per call. */
  organizationId: string;
  /** Cursor for this org's pull (server returns Seq > cursor). */
  cursor: number;
  /** ISO of the last push for this org; only newer local rows are pushed. */
  lastPushedAt: string | null;
  /** When set, payloads are encrypted/decrypted with this key. */
  key: DerivedKey | null;
  /**
   * Optional SignalR connection id. When set, the server excludes this
   * connection from the realtime "Changed" broadcast so we don't bounce
   * a redundant pull off our own push.
   */
  connectionId?: string | null;
}

export async function runSync(opts: RunSyncOptions): Promise<SyncResult> {
  // 1. Push local changes for THIS org.
  const sinceMap: Record<string, string | null> = {};
  sinceMap[opts.organizationId] = opts.lastPushedAt;
  const byOrg = await collectScopedRows(sinceMap);
  const scoped = byOrg.get(opts.organizationId) ?? [];

  const entries: SyncEntryWireDto[] = [];
  for (const s of scoped) {
    entries.push(await toWireEntry(s, opts.key));
  }

  let pushed: SyncPushResponse = {
    accepted: 0,
    rejected: 0,
    serverCursor: opts.cursor,
    conflicts: [],
  };
  if (entries.length > 0) {
    // Batched push (server caps at 1000 per call). All entries in a
    // batch belong to the same org by construction.
    const batches: SyncEntryWireDto[][] = [];
    for (let i = 0; i < entries.length; i += 500) {
      batches.push(entries.slice(i, i + 500));
    }
    for (const batch of batches) {
      const r = await pushEntries(opts.token, batch, opts.connectionId);
      pushed = {
        accepted: pushed.accepted + r.accepted,
        rejected: pushed.rejected + r.rejected,
        serverCursor: Math.max(pushed.serverCursor, r.serverCursor),
        conflicts: [...pushed.conflicts, ...r.conflicts],
      };
    }
  }

  // 2. Pull server changes for the same org.
  const pulled = await pullEntries(opts.token, opts.organizationId, opts.cursor);

  let applied = 0;
  let skippedOlder = 0;
  for (const entry of pulled.entries) {
    const outcome = await applyIncoming(entry, opts.key);
    if (outcome === 'applied') applied++;
    else if (outcome === 'skipped-older') skippedOlder++;
  }

  return { pushed, pulled, appliedLocally: applied, skippedOlder };
}

export interface RunPullOptions {
  token: string;
  organizationId: string;
  cursor: number;
  key: DerivedKey | null;
}

export interface PullResult {
  pulled: SyncPullResponse;
  appliedLocally: number;
  skippedOlder: number;
}

/**
 * Pull-only path used by the realtime "Changed" notification. No push,
 * so we never touch `lastPushedAt`.
 */
export async function runPull(opts: RunPullOptions): Promise<PullResult> {
  const pulled = await pullEntries(opts.token, opts.organizationId, opts.cursor);
  let applied = 0;
  let skippedOlder = 0;
  for (const entry of pulled.entries) {
    const outcome = await applyIncoming(entry, opts.key);
    if (outcome === 'applied') applied++;
    else if (outcome === 'skipped-older') skippedOlder++;
  }
  return { pulled, appliedLocally: applied, skippedOlder };
}

/**
 * List of orgs we have local rows for — the set the sync store iterates
 * over. Trivial today, but keeping it as a single helper centralizes the
 * "where do I look for orgs" question.
 */
export async function knownOrgIds(): Promise<string[]> {
  const orgs = await tableAll<{ id: string; deletedAt: string | null }>('organizations');
  return orgs.filter((o) => !o.deletedAt).map((o) => o.id);
}
