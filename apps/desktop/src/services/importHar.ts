/**
 * HAR (HTTP Archive) importer.
 *
 * Browsers export network captures as HAR — DevTools → Network →
 * "Save all as HAR with content". The format is a flat array of
 * entries (one per request), so we have to invent some folder
 * structure ourselves; we group by URL hostname (one folder per
 * origin), which roughly maps to "the API I called from this app."
 *
 * Filtering: HAR captures every request, including page assets
 * (CSS, fonts, images, analytics beacons). Importing all of those
 * into an Aelvory workspace is noise. By default we skip entries
 * that look like static assets — controlled by `apiOnly` flag.
 */

import type { AuthConfig, Header, RequestBody } from '@aelvory/core';
import type { ImportResult, ImportedFolder, ImportedRequest } from './importOpenApi';

interface HarHeader {
  name?: string;
  value?: string;
}

interface HarPostData {
  mimeType?: string;
  text?: string;
  params?: Array<{ name?: string; value?: string }>;
}

interface HarRequest {
  method?: string;
  url?: string;
  headers?: HarHeader[];
  postData?: HarPostData;
}

interface HarEntry {
  request?: HarRequest;
  _resourceType?: string;
}

interface HarLog {
  version?: string;
  entries?: HarEntry[];
}

export interface HarOptions {
  /**
   * When true (default), skip entries that look like static assets:
   *   - resource type css / image / font / media / stylesheet /
   *     manifest / texttrack
   *   - GET requests with response/Accept of image / css / font
   * Most users want only the API calls — they're importing this
   * to convert observed traffic into a request collection, not to
   * archive every page asset.
   */
  apiOnly?: boolean;
}

export function parseHar(input: string, opts: HarOptions = {}): ImportResult {
  const apiOnly = opts.apiOnly !== false;

  let har: { log?: HarLog };
  try {
    har = JSON.parse(input.trim());
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }

  if (!har || typeof har !== 'object' || !har.log || !Array.isArray(har.log.entries)) {
    throw new Error('Not a valid HAR file (missing log.entries)');
  }

  const entries = har.log.entries;
  if (entries.length === 0) {
    throw new Error('HAR contains no entries');
  }

  // Group by hostname. Browsers usually capture multiple origins
  // (the page itself + APIs + CDNs); separating them makes the
  // imported collection navigable.
  const byHost = new Map<string, ImportedRequest[]>();
  let imported = 0;
  let skipped = 0;

  for (const entry of entries) {
    const req = entry?.request;
    if (!req || typeof req.url !== 'string') continue;
    if (apiOnly && !looksLikeApiCall(entry)) {
      skipped++;
      continue;
    }

    let host = 'unknown';
    try {
      host = new URL(req.url).hostname || host;
    } catch {
      /* keep "unknown" — relative URLs in HAR are unusual but possible */
    }

    const ir = convertRequest(req);
    const list = byHost.get(host) ?? [];
    list.push(ir);
    byHost.set(host, list);
    imported++;
  }

  if (imported === 0) {
    throw new Error(
      skipped > 0
        ? `All ${skipped} entries were filtered out as static assets. Disable "API calls only" to import everything.`
        : 'No importable entries.',
    );
  }

  // Stable folder order — alphabetical by host. Easier to find a
  // specific origin in a large capture than a random natural order.
  const collectionName = `HAR import (${imported} request${imported === 1 ? '' : 's'})`;
  const root: ImportedFolder = { name: collectionName, requests: [], children: [] };
  const sortedHosts = [...byHost.keys()].sort();
  for (const host of sortedHosts) {
    root.children.push({
      name: host,
      requests: byHost.get(host)!,
      children: [],
    });
  }

  // No env suggestions — HAR captures concrete URLs, no
  // {{baseUrl}}-style templating to extract. The user can set up
  // an environment manually if they want to parameterise.
  return { collectionName, root, environmentSuggestions: [] };
}

/**
 * Heuristic: does this entry look like a real API call vs a page
 * asset? `_resourceType` is the most reliable signal (Chrome and
 * Edge set it explicitly); we fall back to content-type sniffing
 * when it's absent (Firefox HAR exports often omit it).
 */
function looksLikeApiCall(entry: HarEntry): boolean {
  const rt = (entry._resourceType ?? '').toLowerCase();
  if (rt === 'xhr' || rt === 'fetch' || rt === 'websocket' || rt === 'eventsource') {
    return true;
  }
  // Asset-y resource types — definitely skip.
  if (['stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack', 'other'].includes(rt)) {
    return false;
  }
  // No (or unrecognised) _resourceType. Fall back to the request's
  // own Accept header — APIs usually ask for JSON/XML, asset
  // requests ask for image/* or css.
  const headers = entry.request?.headers ?? [];
  const accept = headerValue(headers, 'accept').toLowerCase();
  if (
    accept.includes('text/css') ||
    accept.includes('image/') ||
    accept.includes('font/') ||
    accept === 'audio/*' ||
    accept === 'video/*'
  ) {
    return false;
  }
  // Default to keep — better to over-include than silently lose
  // a request the user actually wanted.
  return true;
}

function headerValue(headers: HarHeader[], name: string): string {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h?.name && h.name.toLowerCase() === lower) {
      return h.value ?? '';
    }
  }
  return '';
}

function convertRequest(req: HarRequest): ImportedRequest {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = req.url ?? '';

  const headers: Header[] = [];
  if (Array.isArray(req.headers)) {
    for (const h of req.headers) {
      if (!h?.name) continue;
      // Skip pseudo-headers HTTP/2 emits (`:method`, `:authority`,
      // etc.) — they're transport metadata, not request headers,
      // and Aelvory's executor would add them itself.
      if (h.name.startsWith(':')) continue;
      headers.push({ key: h.name, value: h.value ?? '', enabled: true });
    }
  }

  return {
    name: friendlyName(method, url),
    method,
    url,
    headers,
    body: convertBody(req.postData),
    auth: extractAuthFromHeaders(headers),
  };
}

/**
 * Build a human-friendly request name from the URL path. HAR has
 * no `name` field — the user just sees `https://api.example.com/v1/users/123?expand=x`
 * which is hard to scan in a tree. We use METHOD + last meaningful
 * path segment, falling back to host on root-only URLs.
 */
function friendlyName(method: string, url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return `${method} /${last}`;
    return `${method} ${u.hostname}`;
  } catch {
    return `${method} ${url}`;
  }
}

function convertBody(post: HarPostData | undefined): RequestBody | null {
  if (!post || typeof post !== 'object') return null;
  const mime = post.mimeType ?? '';

  if (mime.includes('x-www-form-urlencoded') && Array.isArray(post.params)) {
    const parts = post.params
      .filter((p) => p && p.name)
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

  if (typeof post.text === 'string' && post.text.length > 0) {
    return {
      type: 'raw',
      raw: post.text,
      contentType: mime || 'text/plain',
    };
  }
  return null;
}

/**
 * Promote common auth headers to structured AuthConfig so the user
 * can edit them via the Auth tab afterwards instead of treating
 * them as anonymous headers.
 *
 * Mutates `headers` to drop the matched ones — keeping them in
 * both places would result in the executor sending a duplicate
 * Authorization header and the auth-tab UI showing edits that
 * don't take effect.
 */
function extractAuthFromHeaders(headers: Header[]): AuthConfig | null {
  const idx = headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
  if (idx === -1) return null;
  const raw = headers[idx].value;
  if (!raw) return null;

  if (/^bearer\s+/i.test(raw)) {
    headers.splice(idx, 1);
    return { type: 'bearer', config: { token: raw.replace(/^bearer\s+/i, '') } };
  }
  if (/^basic\s+/i.test(raw)) {
    const b64 = raw.replace(/^basic\s+/i, '');
    try {
      const decoded = atob(b64);
      const sep = decoded.indexOf(':');
      if (sep >= 0) {
        headers.splice(idx, 1);
        return {
          type: 'basic',
          config: {
            username: decoded.slice(0, sep),
            password: decoded.slice(sep + 1),
          },
        };
      }
    } catch {
      /* not valid base64 — leave as-is in headers */
    }
  }
  // Unknown scheme (Digest, custom token-types, etc.) — leave the
  // raw Authorization header in place. The user can promote it
  // manually if desired.
  return null;
}
