/**
 * Fetch a spec / collection from a URL. Routes through
 * tauri-plugin-http when available so the request leaves the Rust
 * side directly — no webview origin, no CORS preflight. Lets the
 * import dialog grab specs from any public Swagger / OpenAPI URL
 * (petstore.swagger.io/v2/swagger.json, etc.) without the user
 * having to download the file first.
 *
 * In a plain browser tab the fetch goes through native `fetch` and
 * is subject to CORS — most public spec hosts set permissive CORS
 * headers, but some don't. The Tauri path is always reliable.
 */
import { isTauriEnv } from '@/runtime/environment';

export interface FetchedSpec {
  text: string;
  contentType: string | null;
  /** Final URL after redirects. Useful for diagnostic display. */
  finalUrl: string;
}

/**
 * Hard cap so an unreachable URL (slow / DNS-pending / firewalled)
 * doesn't lock up the import dialog forever. 30 s is generous for
 * spec downloads, which are typically <1 MB.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function fetchSpec(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<FetchedSpec> {
  // Quick validation. Empty or scheme-less URLs would be interpreted
  // by fetch as relative to the webview origin, which is never what
  // the user wants here — fail explicitly.
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('Enter a URL');
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('URL must start with http:// or https://');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('request timed out', 'AbortError')),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const fetchFn = isTauriEnv()
      ? (await import('@tauri-apps/plugin-http')).fetch
      : window.fetch.bind(window);

    const res = await fetchFn(trimmed, {
      method: 'GET',
      // Asking for any of these maximises the chance of a server
      // returning the most-canonical form. We don't enforce them
      // at the parser side — parseOpenApi accepts JSON or YAML
      // regardless of content-type.
      headers: {
        accept: 'application/json, application/yaml, text/yaml, text/plain, */*',
      },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      // Read a small snippet of the body for the error message —
      // many APIs return useful HTML / JSON on error.
      let snippet = '';
      try {
        const body = await res.text();
        snippet = body.slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(
        `HTTP ${res.status}${snippet ? ` — ${snippet.replace(/\s+/g, ' ').trim()}` : ''}`,
      );
    }
    const text = await res.text();
    return {
      text,
      contentType: res.headers.get('content-type'),
      finalUrl: res.url || trimmed,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out — is the URL reachable?');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
