import type {
  ApiRequest,
  AuthConfig,
  Collection,
  Header,
  RequestBody,
  Variable,
} from '@aelvory/core';

export type VariableContext = Record<string, string>;

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolve(input: string | undefined | null, ctx: VariableContext): string {
  if (!input) return input ?? '';
  return input.replace(TOKEN, (_match, name: string) => {
    const key = name.trim();
    return ctx[key] ?? `{{${key}}}`;
  });
}

function resolveHeaders(headers: Header[], ctx: VariableContext): Header[] {
  return headers.map((h) => ({
    key: resolve(h.key, ctx),
    value: resolve(h.value, ctx),
    enabled: h.enabled,
  }));
}

function resolveBody(body: RequestBody | null, ctx: VariableContext): RequestBody | null {
  if (!body) return null;
  return { ...body, raw: body.raw ? resolve(body.raw, ctx) : body.raw };
}

function resolveAuth(auth: AuthConfig | null, ctx: VariableContext): AuthConfig | null {
  if (!auth) return null;
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(auth.config ?? {})) {
    config[k] = typeof v === 'string' ? resolve(v, ctx) : v;
  }
  return { type: auth.type, config };
}

export function resolveRequest(req: ApiRequest, ctx: VariableContext): ApiRequest {
  return {
    ...req,
    url: resolve(req.url, ctx),
    headers: resolveHeaders(req.headers, ctx),
    body: resolveBody(req.body, ctx),
    auth: resolveAuth(req.auth, ctx),
  };
}

export function extractTokenNames(str: string): string[] {
  const names = new Set<string>();
  for (const match of str.matchAll(TOKEN)) names.add(match[1].trim());
  return [...names];
}

/**
 * Merge variables from a list of variable arrays (later wins).
 * Pre-E2EE, "secret" is a UI-masking flag only; the stored value is still
 * plaintext, so we resolve it like any other var. When E2EE arrives, callers
 * should decrypt before handing us the list (or we add a ciphertext branch).
 */
export function mergeVariables(
  envVars: VariableContext,
  ancestorVars: Variable[][],
): VariableContext {
  const out: VariableContext = { ...envVars };
  for (const list of ancestorVars) {
    for (const v of list) {
      if (v.value !== null) out[v.key] = v.value;
    }
  }
  return out;
}

/**
 * Determine which auth to apply for a request.
 *
 *   request.auth = null                  → "inherit": walk ancestor
 *                                          collections root→leaf and
 *                                          use the most specific
 *                                          non-null auth. Falls back
 *                                          to no auth if no ancestor
 *                                          defines one.
 *   request.auth = { type: 'none' }      → explicit "no auth": do NOT
 *                                          inherit from ancestors. The
 *                                          user picked this on purpose
 *                                          to override a parent's auth.
 *   request.auth = { type: 'bearer', … } → use the request's own auth
 *                                          (and any other concrete type).
 *
 * The UI in AuthPanel.vue maps the dropdown to these shapes; this is
 * the single place that decodes them.
 */
export function effectiveAuth(
  request: ApiRequest,
  ancestorChain: Collection[],
): AuthConfig | null {
  if (request.auth) return request.auth.type === 'none' ? null : request.auth;
  // null on the request → inherit. Walk ancestors root-last; pick the
  // deepest (most specific) ancestor that has a concrete auth.
  for (let i = ancestorChain.length - 1; i >= 0; i--) {
    const a = ancestorChain[i].auth;
    if (a && a.type !== 'none') return a;
  }
  return null;
}
