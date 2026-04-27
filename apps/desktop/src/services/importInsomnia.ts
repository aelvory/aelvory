/**
 * Insomnia v4 export importer.
 *
 * Insomnia's export format is a flat array of resources (workspaces,
 * request_groups, requests, environments) with parent/child links by
 * `parentId`. We:
 *   - Pick the top-level workspace as the collection root.
 *   - Walk request_group resources to build the folder tree.
 *   - Convert each request resource to ImportedRequest.
 *   - Extract environment `data` into envSuggestions (the user can
 *     opt to materialize it as an Aelvory environment after import).
 *
 * Insomnia template syntax uses `{{ varName }}` (with spaces) AND
 * `{{varName}}` — both are common. We pass strings through unchanged
 * since Aelvory's variable-substitution layer accepts both forms.
 */

import type { AuthConfig, Header, RequestBody } from '@aelvory/core';
import type { ImportResult, ImportedFolder, ImportedRequest } from './importOpenApi';

interface InsomniaResource {
  _id: string;
  _type: string;
  parentId?: string | null;
  name?: string;
  description?: string | null;
  // request fields
  method?: string;
  url?: string;
  headers?: Array<{ name?: string; value?: string; disabled?: boolean }>;
  body?: { mimeType?: string; text?: string; params?: Array<{ name?: string; value?: string; disabled?: boolean }> };
  authentication?: Record<string, unknown>;
  // environment fields
  data?: Record<string, unknown>;
  // request_group fields → only name + parentId matter
}

export function parseInsomnia(input: string): ImportResult {
  let spec: { _type?: string; __export_format?: number; resources?: InsomniaResource[] };
  try {
    spec = JSON.parse(input.trim());
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }

  if (!spec || typeof spec !== 'object') {
    throw new Error('Not a valid Insomnia export');
  }
  // The export wrapper has _type: "export" and __export_format
  // (typically 4 for current Insomnia versions). We don't lock to a
  // specific format version — the resource shapes for v3/v4/v5 are
  // structurally compatible at the level we care about.
  if (spec._type !== 'export') {
    throw new Error('Missing top-level "_type": "export" — is this an Insomnia export?');
  }
  if (!Array.isArray(spec.resources) || spec.resources.length === 0) {
    throw new Error('No resources in the export');
  }

  // Group resources by type for fast lookups.
  const workspaces = spec.resources.filter((r) => r._type === 'workspace');
  const requestGroups = spec.resources.filter((r) => r._type === 'request_group');
  const requests = spec.resources.filter((r) => r._type === 'request');
  const environments = spec.resources.filter(
    (r) => r._type === 'environment' && r.data && typeof r.data === 'object',
  );

  // Pick a root workspace. Most exports have exactly one; if there
  // are several, use the first — the user can re-import the others
  // separately if they care about the distinction.
  const rootWorkspace = workspaces[0];
  const collectionName = rootWorkspace?.name ?? 'Imported Insomnia';

  // Build the folder tree by parentId. Parent can be a workspace or
  // another request_group. Cycles aren't legal in Insomnia exports,
  // so a single pass by depth is enough.
  const childrenByParent = new Map<string, InsomniaResource[]>();
  for (const rg of requestGroups) {
    const parentId = rg.parentId ?? '';
    const arr = childrenByParent.get(parentId) ?? [];
    arr.push(rg);
    childrenByParent.set(parentId, arr);
  }
  // Group requests by their direct parent (workspace OR request_group).
  const requestsByParent = new Map<string, InsomniaResource[]>();
  for (const r of requests) {
    const parentId = r.parentId ?? '';
    const arr = requestsByParent.get(parentId) ?? [];
    arr.push(r);
    requestsByParent.set(parentId, arr);
  }

  function buildFolder(parentId: string, name: string): ImportedFolder {
    const folder: ImportedFolder = {
      name,
      requests: (requestsByParent.get(parentId) ?? []).map(convertRequest),
      children: (childrenByParent.get(parentId) ?? []).map((rg) =>
        buildFolder(rg._id, rg.name ?? 'Folder'),
      ),
    };
    return folder;
  }

  const rootId = rootWorkspace?._id ?? '';
  const root = buildFolder(rootId, collectionName);

  // Environment extraction. Insomnia stores env as a nested object
  // `data: { key: value, nested: {...} }`. Flatten one level — the
  // common pattern is `{ baseUrl: "...", apiKey: "..." }`. Nested
  // objects (like Insomnia's "private" sub-env) are skipped; users
  // can re-export those separately.
  const envSuggestions: { key: string; value: string }[] = [];
  for (const env of environments) {
    if (!env.data) continue;
    for (const [k, v] of Object.entries(env.data)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        // Don't double-add the same key if multiple envs share names —
        // first wins (typically the "Base Environment" sub-env that
        // Insomnia creates per workspace).
        if (!envSuggestions.some((s) => s.key === k)) {
          envSuggestions.push({ key: k, value: String(v) });
        }
      }
    }
  }

  return { collectionName, root, environmentSuggestions: envSuggestions };
}

function convertRequest(r: InsomniaResource): ImportedRequest {
  const headers: Header[] = [];
  if (Array.isArray(r.headers)) {
    for (const h of r.headers) {
      if (h && typeof h.name === 'string' && h.name) {
        headers.push({
          key: h.name,
          value: h.value ?? '',
          enabled: !h.disabled,
        });
      }
    }
  }

  return {
    name: r.name ?? 'Request',
    method: (r.method ?? 'GET').toUpperCase(),
    url: r.url ?? '',
    headers,
    body: convertBody(r.body),
    auth: convertAuth(r.authentication),
  };
}

function convertBody(body: InsomniaResource['body']): RequestBody | null {
  if (!body || typeof body !== 'object') return null;
  const mimeType = body.mimeType ?? '';

  // Form-urlencoded — Insomnia uses params[].
  if (mimeType === 'application/x-www-form-urlencoded' && Array.isArray(body.params)) {
    const parts = body.params
      .filter((p) => p && !p.disabled && p.name)
      .map(
        (p) =>
          `${encodeURIComponent(p.name ?? '')}=${encodeURIComponent(p.value ?? '')}`,
      );
    return {
      type: 'form',
      raw: parts.join('&'),
      contentType: 'application/x-www-form-urlencoded',
    };
  }

  // Raw bodies (JSON, XML, plaintext, etc.) — Insomnia stores in
  // `text`. Pass mimeType through unchanged.
  if (typeof body.text === 'string') {
    return {
      type: 'raw',
      raw: body.text,
      contentType: mimeType || 'text/plain',
    };
  }

  // Multipart, GraphQL etc. — not yet mapped. Fall through with
  // null rather than guess; user can re-add manually.
  return null;
}

function convertAuth(auth: Record<string, unknown> | undefined): AuthConfig | null {
  if (!auth || typeof auth !== 'object') return null;
  const type = typeof auth.type === 'string' ? auth.type : null;
  if (!type) return null;
  if (auth.disabled === true) return null;

  const str = (key: string): string => {
    const v = auth[key];
    return typeof v === 'string' ? v : '';
  };

  if (type === 'bearer') {
    return { type: 'bearer', config: { token: str('token') } };
  }
  if (type === 'basic') {
    return {
      type: 'basic',
      config: { username: str('username'), password: str('password') },
    };
  }
  if (type === 'apikey') {
    // Insomnia's apikey auth has `key`, `value`, and `addTo` ("header"
    // | "queryParams"). Aelvory's `in` field uses "header" / "query"
    // — translate so the import lands in the right place.
    const addTo = str('addTo');
    const where = addTo === 'queryParams' ? 'query' : 'header';
    return {
      type: 'apikey',
      config: { key: str('key'), value: str('value'), in: where },
    };
  }
  return null;
}
