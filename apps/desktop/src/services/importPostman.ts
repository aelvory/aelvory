import type { AuthConfig, Header, RequestBody } from '@aelvory/core';
import type { ImportResult, ImportedFolder, ImportedRequest } from './importOpenApi';

export function parsePostman(input: string): ImportResult {
  let spec: any;
  try {
    spec = JSON.parse(input.trim());
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }

  if (!spec || typeof spec !== 'object') {
    throw new Error('Not a valid Postman collection');
  }

  const info = spec.info;
  if (!info || typeof info !== 'object') {
    throw new Error('Missing info block — is this a Postman v2.1 export?');
  }
  if (typeof info.schema === 'string' && !info.schema.includes('/v2')) {
    throw new Error('Only Postman v2.x schemas are supported');
  }

  const collectionName = info.name ?? 'Imported Collection';

  const envSuggestions: { key: string; value: string }[] = [];
  if (Array.isArray(spec.variable)) {
    for (const v of spec.variable) {
      if (v && typeof v.key === 'string' && v.value != null) {
        envSuggestions.push({ key: v.key, value: String(v.value) });
      }
    }
  }

  const root: ImportedFolder = {
    name: collectionName,
    requests: [],
    children: [],
  };

  if (Array.isArray(spec.item)) {
    for (const item of spec.item) buildFolder(item, root);
  }

  return { collectionName, root, environmentSuggestions: envSuggestions };
}

function buildFolder(item: any, parent: ImportedFolder) {
  if (!item || typeof item !== 'object') return;
  if (Array.isArray(item.item)) {
    const folder: ImportedFolder = {
      name: String(item.name ?? 'Folder'),
      requests: [],
      children: [],
    };
    for (const child of item.item) buildFolder(child, folder);
    parent.children.push(folder);
  } else if (item.request) {
    parent.requests.push(convertRequest(item));
  }
}

function convertRequest(item: any): ImportedRequest {
  const req = item.request;
  const method =
    typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';

  let url = '';
  if (typeof req.url === 'string') {
    url = req.url;
  } else if (req.url && typeof req.url === 'object') {
    url = req.url.raw ?? reconstructUrl(req.url);
  }
  // Postman {{var}} matches our syntax — no transform needed

  const headers: Header[] = [];
  if (Array.isArray(req.header)) {
    for (const h of req.header) {
      if (h && typeof h.key === 'string' && h.key) {
        headers.push({
          key: h.key,
          value: h.value ?? '',
          enabled: !h.disabled,
        });
      }
    }
  }

  const body = convertBody(req.body);
  const auth = convertAuth(req.auth);

  return {
    name: String(item.name ?? 'Request'),
    method,
    url,
    headers,
    body,
    auth,
  };
}

function reconstructUrl(url: any): string {
  const protocol = url.protocol ? `${url.protocol}://` : '';
  const host = Array.isArray(url.host) ? url.host.join('.') : '';
  const port = url.port ? `:${url.port}` : '';
  const path = Array.isArray(url.path) ? '/' + url.path.join('/') : '';
  let qs = '';
  if (Array.isArray(url.query) && url.query.length > 0) {
    const parts = url.query
      .filter((q: any) => q && !q.disabled && q.key)
      .map(
        (q: any) =>
          `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? '')}`,
      );
    if (parts.length) qs = '?' + parts.join('&');
  }
  return `${protocol}${host}${port}${path}${qs}`;
}

function convertBody(body: any): RequestBody | null {
  if (!body || typeof body !== 'object') return null;
  const mode = body.mode;
  if (mode === 'raw') {
    const lang = body.options?.raw?.language ?? 'text';
    const contentType =
      lang === 'json'
        ? 'application/json'
        : lang === 'xml'
          ? 'application/xml'
          : 'text/plain';
    return {
      type: 'raw',
      raw: String(body.raw ?? ''),
      contentType,
    };
  }
  if (mode === 'urlencoded') {
    const parts = (Array.isArray(body.urlencoded) ? body.urlencoded : [])
      .filter((p: any) => p && !p.disabled && p.key)
      .map(
        (p: any) =>
          `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`,
      );
    return {
      type: 'form',
      raw: parts.join('&'),
      contentType: 'application/x-www-form-urlencoded',
    };
  }
  return null;
}

function convertAuth(auth: any): AuthConfig | null {
  if (!auth || typeof auth !== 'object' || typeof auth.type !== 'string') return null;
  const type = auth.type;
  const read = (arr: any, key: string): string => {
    if (!Array.isArray(arr)) return '';
    const found = arr.find((e: any) => e?.key === key);
    return found?.value != null ? String(found.value) : '';
  };
  if (type === 'bearer') {
    return { type: 'bearer', config: { token: read(auth.bearer, 'token') } };
  }
  if (type === 'basic') {
    return {
      type: 'basic',
      config: {
        username: read(auth.basic, 'username'),
        password: read(auth.basic, 'password'),
      },
    };
  }
  if (type === 'apikey') {
    return {
      type: 'apikey',
      config: {
        key: read(auth.apikey, 'key'),
        value: read(auth.apikey, 'value'),
        in: read(auth.apikey, 'in') || 'header',
      },
    };
  }
  return null;
}
