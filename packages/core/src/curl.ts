import type { AuthConfig, Header, QueryParam, RequestBody } from './types';

/**
 * Append `params` (enabled rows only) to `url`'s query string.
 * Preserves any query string already in `url`, doesn't deduplicate
 * keys — duplicate keys are a legitimate pattern (e.g. `tag=foo&tag=bar`).
 *
 * Returns the original URL unchanged when there are no enabled params,
 * so calls are safe no-ops on requests without query-param config.
 */
export function applyQueryParams(url: string, params?: QueryParam[]): string {
  const enabled = (params ?? []).filter((p) => p.enabled && p.key);
  if (enabled.length === 0) return url;

  const encoded = enabled
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`)
    .join('&');

  // Place the new params after any existing query string. We do NOT
  // try to parse-and-merge because the URL may already contain values
  // that aren't strictly query-string (templated `{{vars}}`, custom
  // encodings, fragments) — appending is safer than rewriting.
  const hashIdx = url.indexOf('#');
  const base = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}${encoded}${hash}`;
}

export interface ParsedCurl {
  method: string;
  url: string;
  headers: Header[];
  body: RequestBody | null;
  auth: AuthConfig | null;
  warnings: string[];
}

/** Minimum input shape for `toCurl` — matches both `ApiRequest` and `ExecuteRequestPayload`. */
export interface ToCurlInput {
  method?: string;
  url: string;
  headers?: Header[];
  /**
   * Enabled rows are merged into the URL's query string before
   * rendering. Disabled rows and rows with no key are skipped.
   */
  queryParams?: QueryParam[];
  body?: RequestBody | null;
  auth?: AuthConfig | null;
}

export interface ToCurlOptions {
  /**
   * Break the command across lines with backslash continuations for
   * readability. Default: true. Set false for a single-line command
   * that's easier to paste into a chat or a single-line shell.
   */
  multiline?: boolean;
  /**
   * Emit `--insecure` (alias `-k`). Set true when the app is running
   * with TLS verification disabled so the curl command behaves the
   * same way on the user's machine. Default: false.
   */
  insecure?: boolean;
}

/**
 * Render a request as a `curl` command string suitable for pasting
 * into a terminal. The inverse of `parseCurl`; round-tripping through
 * both should preserve method, url, headers, raw body, and the common
 * auth shapes (basic, bearer, apikey-in-header).
 *
 * Quoting strategy: every argument is wrapped in POSIX single quotes
 * with the `'"'"'` trick for embedded apostrophes, so the output is
 * safe to paste into bash/zsh/sh regardless of what's in the URL,
 * header values, or body.
 *
 * Emission rules:
 *  - `-X` is omitted for GET (curl's default).
 *  - Disabled headers (`enabled: false`) and empty-key headers are
 *    skipped.
 *  - `auth.basic` → `-u user:pass`. `auth.bearer` → `-H
 *    'Authorization: Bearer …'` unless an Authorization header is
 *    already in `headers` (avoids double-up). `auth.apikey` with
 *    placement `header` (the default) is added as a header; query
 *    placement is left to the caller since we don't rewrite the URL
 *    here. Other auth types (oauth2, aws-sigv4, digest) need
 *    per-call computation curl can't do statically, so they're
 *    skipped silently — the resulting command will be unauthenticated.
 *  - Body: `type: 'raw'` (and the catch-all for graphql/form/
 *    multipart, which we currently store as serialized raw strings)
 *    is emitted via `--data-raw`. A `Content-Type` header is added
 *    only if the caller didn't already include one. `type: 'binary'`
 *    is dropped with a comment since we can't inline binary content.
 *  - `type: 'none'` and absent bodies → no -d/--data flag.
 */
export function toCurl(req: ToCurlInput, opts: ToCurlOptions = {}): string {
  const multiline = opts.multiline ?? true;
  const sep = multiline ? ' \\\n  ' : ' ';
  const parts: string[] = ['curl'];

  // Method. Skip `-X` for GET since that's curl's default and a bare
  // `curl URL` reads more naturally.
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET') parts.push(`-X ${method}`);

  // URL goes immediately after the method for the same reason it
  // tends to appear there in hand-written curl: it's the subject of
  // the command and easy to spot. Enabled query params are merged
  // into the URL here so the resulting command is paste-and-run.
  parts.push(shellQuote(applyQueryParams(req.url, req.queryParams)));

  // Headers — keep author-supplied order so the output mirrors the
  // request as the user has it in the editor.
  const headers = req.headers ?? [];
  const hasHeader = (name: string) =>
    headers.some(
      (h) => h.enabled !== false && h.key.toLowerCase() === name.toLowerCase(),
    );
  for (const h of headers) {
    if (h.enabled === false) continue;
    if (!h.key) continue;
    parts.push(`-H ${shellQuote(`${h.key}: ${h.value ?? ''}`)}`);
  }

  // Auth.
  if (req.auth && req.auth.type !== 'none') {
    const c = (req.auth.config ?? {}) as Record<string, unknown>;
    switch (req.auth.type) {
      case 'basic': {
        const u = String(c.username ?? '');
        const p = String(c.password ?? '');
        parts.push(`-u ${shellQuote(`${u}:${p}`)}`);
        break;
      }
      case 'bearer': {
        if (!hasHeader('Authorization')) {
          const t = String(c.token ?? '');
          parts.push(`-H ${shellQuote(`Authorization: Bearer ${t}`)}`);
        }
        break;
      }
      case 'apikey': {
        // Default placement is header; query-string placement would
        // require rewriting `req.url` which is the caller's concern.
        const placement = String(c.in ?? c.placement ?? 'header').toLowerCase();
        const key = String(c.key ?? c.name ?? '');
        const value = String(c.value ?? '');
        if (placement === 'header' && key && !hasHeader(key)) {
          parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
        }
        break;
      }
      // oauth2 / aws-sigv4 / digest: no static curl equivalent.
    }
  }

  // Body.
  if (req.body && req.body.type !== 'none') {
    if (req.body.type === 'binary') {
      // Best-effort: we can't inline arbitrary bytes safely. Drop a
      // comment so the user knows to point at a file with @path.
      parts.push("# binary body omitted — replace with --data-binary @/path/to/file");
    } else {
      const raw = req.body.raw ?? '';
      const ct = req.body.contentType;
      if (ct && !hasHeader('Content-Type')) {
        parts.push(`-H ${shellQuote(`Content-Type: ${ct}`)}`);
      }
      parts.push(`--data-raw ${shellQuote(raw)}`);
    }
  }

  if (opts.insecure) parts.push('--insecure');

  return parts.join(sep);
}

/**
 * Wrap a string in POSIX single quotes, escaping any embedded
 * apostrophes via the standard close-quote / quoted-quote / re-open
 * trick: `it's` → `'it'"'"'s'`. Safe to paste into bash/zsh/sh.
 */
function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Parse a curl command string into our request shape.
 * Throws an Error with a descriptive message on unrecoverable parse failures.
 */
export function parseCurl(raw: string): ParsedCurl {
  const input = raw.trim();
  if (!input) throw new Error('Empty input');

  const tokens = tokenize(input);
  if (tokens.length === 0) throw new Error('No tokens');

  // Drop a leading `curl` token if present.
  if (tokens[0].toLowerCase() === 'curl') tokens.shift();

  const warnings: string[] = [];
  let method = '';
  let url = '';
  const headers: Header[] = [];
  const dataParts: string[] = [];
  let dataMode: 'raw' | 'form' | 'binary' | 'urlencode' = 'form';
  let explicitContentType: string | null = null;
  let auth: AuthConfig | null = null;
  const cookies: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    switch (t) {
      case '-X':
      case '--request':
        method = (tokens[++i] ?? '').toUpperCase();
        break;

      case '-H':
      case '--header': {
        const h = tokens[++i] ?? '';
        const colon = h.indexOf(':');
        if (colon > 0) {
          const key = h.slice(0, colon).trim();
          const value = h.slice(colon + 1).trim();
          if (key.toLowerCase() === 'content-type') {
            explicitContentType = value;
          }
          headers.push({ key, value, enabled: true });
        }
        break;
      }

      case '-d':
      case '--data':
      case '--data-ascii':
      case '--data-raw':
        dataParts.push(tokens[++i] ?? '');
        if (t === '--data-raw') dataMode = 'raw';
        break;
      case '--data-binary':
        dataParts.push(tokens[++i] ?? '');
        dataMode = 'binary';
        break;
      case '--data-urlencode':
        dataParts.push(tokens[++i] ?? '');
        dataMode = 'urlencode';
        break;
      case '--json': {
        const v = tokens[++i] ?? '';
        dataParts.push(v);
        dataMode = 'raw';
        explicitContentType = 'application/json';
        if (!headers.some((h) => h.key.toLowerCase() === 'accept')) {
          headers.push({ key: 'Accept', value: 'application/json', enabled: true });
        }
        break;
      }

      case '-u':
      case '--user': {
        const creds = tokens[++i] ?? '';
        const idx = creds.indexOf(':');
        auth = {
          type: 'basic',
          config:
            idx >= 0
              ? { username: creds.slice(0, idx), password: creds.slice(idx + 1) }
              : { username: creds, password: '' },
        };
        break;
      }

      case '-b':
      case '--cookie':
        cookies.push(tokens[++i] ?? '');
        break;

      case '-A':
      case '--user-agent':
        headers.push({ key: 'User-Agent', value: tokens[++i] ?? '', enabled: true });
        break;
      case '-e':
      case '--referer':
        headers.push({ key: 'Referer', value: tokens[++i] ?? '', enabled: true });
        break;

      case '-I':
      case '--head':
        if (!method) method = 'HEAD';
        break;

      case '--url':
        url = tokens[++i] ?? '';
        break;

      // Silently ignored flags (common but not relevant to us)
      case '-L':
      case '--location':
      case '-s':
      case '--silent':
      case '-S':
      case '--show-error':
      case '-k':
      case '--insecure':
      case '-v':
      case '--verbose':
      case '-f':
      case '--fail':
      case '-i':
      case '--include':
      case '--compressed':
      case '--no-keepalive':
      case '--http1.1':
      case '--http2':
        break;

      // Flags that consume one arg we want to drop rather than misinterpret
      case '-o':
      case '--output':
      case '-O':
      case '--remote-name':
      case '-w':
      case '--write-out':
      case '-D':
      case '--dump-header':
      case '--cacert':
      case '--cert':
      case '--key':
      case '-x':
      case '--proxy':
      case '--max-time':
      case '--connect-timeout':
      case '--retry':
      case '--retry-delay':
      case '--resolve':
        i++;
        break;

      default:
        if (t.startsWith('-') && t.length > 1) {
          warnings.push(`Unknown flag: ${t}`);
        } else if (!url) {
          url = t;
        } else {
          warnings.push(`Unexpected token: ${t}`);
        }
    }
    i++;
  }

  if (!url) throw new Error('No URL found in curl command');

  // Build body if data was provided.
  let body: RequestBody | null = null;
  if (dataParts.length > 0) {
    let content: string;
    let contentType: string;
    if (dataMode === 'urlencode') {
      content = dataParts
        .map((p) => {
          const eq = p.indexOf('=');
          if (eq >= 0) {
            return `${encodeURIComponent(p.slice(0, eq))}=${encodeURIComponent(p.slice(eq + 1))}`;
          }
          return encodeURIComponent(p);
        })
        .join('&');
      contentType = explicitContentType ?? 'application/x-www-form-urlencoded';
    } else {
      content = dataParts.join(dataMode === 'form' ? '&' : '');
      const looksJson = /^\s*[{\[]/.test(content);
      contentType =
        explicitContentType ??
        (looksJson ? 'application/json' : 'application/x-www-form-urlencoded');
    }
    body = { type: 'raw', raw: content, contentType };
    if (!method) method = 'POST';
  }

  if (!method) method = 'GET';

  // Extract Authorization: Bearer / Basic into proper auth config if not set.
  const authHeaderIdx = headers.findIndex(
    (h) => h.key.toLowerCase() === 'authorization',
  );
  if (authHeaderIdx !== -1 && !auth) {
    const raw = headers[authHeaderIdx].value;
    const bearer = raw.match(/^Bearer\s+(.+)$/i);
    const basic = raw.match(/^Basic\s+(.+)$/i);
    if (bearer) {
      auth = { type: 'bearer', config: { token: bearer[1] } };
      headers.splice(authHeaderIdx, 1);
    } else if (basic) {
      try {
        const decoded = atob(basic[1]);
        const idx = decoded.indexOf(':');
        if (idx >= 0) {
          auth = {
            type: 'basic',
            config: { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) },
          };
          headers.splice(authHeaderIdx, 1);
        }
      } catch {
        /* leave header as-is */
      }
    }
  }

  // Fold cookies into a single Cookie header.
  if (cookies.length) {
    headers.push({ key: 'Cookie', value: cookies.join('; '), enabled: true });
  }

  return { method, url, headers, body, auth, warnings };
}

/**
 * Shell-style tokenizer. Handles:
 *  - single quotes (literal; cannot contain a single quote)
 *  - double quotes (with \-escaping of " and \)
 *  - backslash line continuation (\ at end of line → space)
 *  - leading `$` before a single-quoted ANSI-C string (treated as normal string)
 */
function tokenize(input: string): string[] {
  // Join continuation lines
  const s = input.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;

  while (i < n) {
    const ch = s[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Support $'...' ANSI-C style by skipping the $ prefix
    if (ch === '$' && s[i + 1] === "'") {
      i++;
      continue;
    }

    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) throw new Error('Unterminated single quote');
      tokens.push(s.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < n && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < n) {
          const next = s[j + 1];
          if (next === '"' || next === '\\' || next === '`' || next === '$') {
            buf += next;
            j += 2;
            continue;
          }
        }
        buf += s[j];
        j++;
      }
      if (j >= n) throw new Error('Unterminated double quote');
      tokens.push(buf);
      i = j + 1;
      continue;
    }

    // Bare word: read until whitespace, but handle quoted segments within
    let j = i;
    let buf = '';
    while (j < n) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === "'" || c === '"') break; // switch to quoted parsing
      if (c === '\\' && j + 1 < n) {
        buf += s[j + 1];
        j += 2;
        continue;
      }
      buf += c;
      j++;
    }
    tokens.push(buf);
    i = j;
  }

  return tokens;
}
