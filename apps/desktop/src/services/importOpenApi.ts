import yaml from 'js-yaml';
import type { AuthConfig, Header, RequestBody } from '@aelvory/core';

export interface ImportedRequest {
  name: string;
  method: string;
  url: string;
  headers: Header[];
  body: RequestBody | null;
  auth: AuthConfig | null;
}

export interface ImportedFolder {
  name: string;
  requests: ImportedRequest[];
  children: ImportedFolder[];
}

export interface ImportResult {
  collectionName: string;
  root: ImportedFolder;
  environmentSuggestions: { key: string; value: string }[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function parseOpenApi(input: string): ImportResult {
  const spec = parseJsonOrYaml(input);

  if (!spec || typeof spec !== 'object') {
    throw new Error('Invalid spec: not an object');
  }

  const isOpenApi3 =
    typeof spec.openapi === 'string' && spec.openapi.startsWith('3');
  const isSwagger2 = spec.swagger === '2.0';

  if (!isOpenApi3 && !isSwagger2) {
    throw new Error('Unsupported spec (need OpenAPI 3.x or Swagger 2.0)');
  }

  const info = spec.info ?? {};
  const collectionName = info.title ?? 'Imported API';

  const envSuggestions: { key: string; value: string }[] = [];
  let baseUrl = '{{baseUrl}}';

  if (isOpenApi3 && Array.isArray(spec.servers) && spec.servers.length > 0) {
    envSuggestions.push({ key: 'baseUrl', value: String(spec.servers[0].url) });
  } else if (isSwagger2 && spec.host) {
    const scheme = Array.isArray(spec.schemes) && spec.schemes.length > 0
      ? spec.schemes[0]
      : 'https';
    const basePath = spec.basePath ?? '';
    envSuggestions.push({
      key: 'baseUrl',
      value: `${scheme}://${spec.host}${basePath}`,
    });
  } else {
    // No server info — fall back to literal placeholder
    envSuggestions.push({ key: 'baseUrl', value: 'https://api.example.com' });
  }

  const securitySchemes = isOpenApi3
    ? spec.components?.securitySchemes ?? {}
    : spec.securityDefinitions ?? {};

  const byTag = new Map<string, ImportedRequest[]>();
  const untagged: ImportedRequest[] = [];

  const paths = spec.paths ?? {};
  for (const pathStr of Object.keys(paths)) {
    const pathItem = paths[pathStr];
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;

      const tag = Array.isArray(op.tags) && op.tags.length > 0
        ? String(op.tags[0])
        : null;

      const req = buildRequest({
        pathStr,
        method,
        op,
        pathItem,
        isOpenApi3,
        baseUrl,
        spec,
        securitySchemes,
      });

      if (tag) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push(req);
      } else {
        untagged.push(req);
      }
    }
  }

  const root: ImportedFolder = {
    name: collectionName,
    requests: untagged,
    children: [],
  };

  for (const [tag, reqs] of byTag) {
    root.children.push({ name: tag, requests: reqs, children: [] });
  }

  return { collectionName, root, environmentSuggestions: envSuggestions };
}

// Hard caps to defeat input-size DoS. The bigger one is the input
// length itself (a 100 MB spec doesn't exist in practice — anything
// over 16 MB is almost certainly malicious or a paste accident).
// The anchor cap defeats the YAML "billion laughs" vector: a tiny
// document with nested anchor expansions can balloon to gigabytes
// when loaded. js-yaml doesn't cap expansion natively; counting raw
// `&anchor`/`*ref` markers in the input bounds the worst case.
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_YAML_ANCHORS = 64;

function parseJsonOrYaml(input: string): any {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty input');
  if (trimmed.length > MAX_INPUT_BYTES) {
    throw new Error(
      `Input too large (${trimmed.length.toLocaleString()} chars). ` +
        `Max ${MAX_INPUT_BYTES.toLocaleString()}.`,
    );
  }
  // Try JSON first — most OpenAPI specs are JSON. JSON.parse has no
  // anchor/expansion semantics so it's safe at any size below the
  // cap above.
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid JSON: ${(err as Error).message}`);
    }
  }
  // Reject YAML inputs with a suspicious number of anchor refs
  // BEFORE handing them to js-yaml. A handful of anchors are
  // legitimate ("$ref-ish" reuse); 64+ is billion-laughs territory.
  // Counting the literal `&` / `*` markers is a cheap upper bound
  // on expansion count that doesn't depend on parser internals.
  const anchorCount =
    (trimmed.match(/(?:^|\s)&[A-Za-z0-9_-]+/g)?.length ?? 0) +
    (trimmed.match(/(?:^|\s)\*[A-Za-z0-9_-]+/g)?.length ?? 0);
  if (anchorCount > MAX_YAML_ANCHORS) {
    throw new Error(
      `Refusing to parse YAML with ${anchorCount} anchor references — ` +
        `looks like an anchor-expansion DoS payload (billion-laughs). ` +
        `If this is a legitimate spec, simplify or convert to JSON.`,
    );
  }
  try {
    // JSON_SCHEMA: only supports the types JSON has (null, bool,
    // int, float, string, array, object). Disables every !!js/*
    // tag entirely (no function/regex/undefined construction)
    // while keeping correct types for OpenAPI semantics — a spec
    // saying `required: true` should be a boolean, not the string
    // "true". js-yaml 4.x is already safe-by-default; this is
    // belt-and-suspenders against future schema drift.
    return yaml.load(trimmed, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(`Invalid YAML: ${(err as Error).message}`);
  }
}

interface BuildArgs {
  pathStr: string;
  method: string;
  op: any;
  pathItem: any;
  isOpenApi3: boolean;
  baseUrl: string;
  spec: any;
  securitySchemes: any;
}

function buildRequest(args: BuildArgs): ImportedRequest {
  const { pathStr, method, op, pathItem, isOpenApi3, baseUrl, spec, securitySchemes } = args;

  const headers: Header[] = [];
  const queryParts: string[] = [];

  const allParams = [
    ...((pathItem.parameters as any[]) ?? []),
    ...((op.parameters as any[]) ?? []),
  ];

  for (const param of allParams) {
    if (!param || typeof param !== 'object' || param.$ref) continue;
    const example =
      param.example != null
        ? String(param.example)
        : param.schema?.default != null
          ? String(param.schema.default)
          : '';
    if (param.in === 'header') {
      headers.push({
        key: String(param.name),
        value: example,
        enabled: param.required === true,
      });
    } else if (param.in === 'query') {
      queryParts.push(
        `${encodeURIComponent(String(param.name))}=${encodeURIComponent(example)}`,
      );
    }
  }

  const url = `${baseUrl}${pathStr}${queryParts.length ? '?' + queryParts.join('&') : ''}`;

  let body: RequestBody | null = null;
  if (isOpenApi3 && op.requestBody?.content) {
    const jsonCt =
      op.requestBody.content['application/json'] ??
      op.requestBody.content[Object.keys(op.requestBody.content)[0]];
    if (jsonCt) {
      const example = jsonCt.example ?? jsonCt.schema
        ? extractExample(jsonCt.schema)
        : null;
      body = {
        type: 'raw',
        raw: example != null ? JSON.stringify(example, null, 2) : '{}',
        contentType: 'application/json',
      };
    }
  } else {
    const bodyParam = allParams.find((p: any) => p?.in === 'body');
    if (bodyParam?.schema) {
      const example = extractExample(bodyParam.schema);
      body = {
        type: 'raw',
        raw: example != null ? JSON.stringify(example, null, 2) : '{}',
        contentType: 'application/json',
      };
    }
  }

  let auth: AuthConfig | null = null;
  const security = op.security ?? spec.security;
  if (Array.isArray(security) && security.length > 0 && securitySchemes) {
    const req = security[0];
    const schemeName = Object.keys(req ?? {})[0];
    const scheme = schemeName ? securitySchemes[schemeName] : null;
    if (scheme) {
      if (scheme.type === 'http' && scheme.scheme === 'bearer') {
        auth = { type: 'bearer', config: { token: '{{token}}' } };
      } else if (scheme.type === 'http' && scheme.scheme === 'basic') {
        auth = { type: 'basic', config: { username: '', password: '' } };
      } else if (scheme.type === 'apiKey') {
        auth = {
          type: 'apikey',
          config: {
            key: String(scheme.name ?? ''),
            value: '',
            in: scheme.in === 'query' ? 'query' : 'header',
          },
        };
      } else if (scheme.type === 'oauth2') {
        // Store as bearer — OAuth2 flow isn't implemented; user gets a token some way
        auth = { type: 'bearer', config: { token: '{{token}}' } };
      }
    }
  }

  const name =
    op.summary ||
    op.operationId ||
    `${method.toUpperCase()} ${pathStr}`;

  return {
    name: String(name),
    method: method.toUpperCase(),
    url,
    headers,
    body,
    auth,
  };
}

function extractExample(schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'object' || schema.properties) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      out[k] = extractExample(v, depth + 1);
    }
    return out;
  }
  if (schema.type === 'array') {
    const item = extractExample(schema.items, depth + 1);
    return item == null ? [] : [item];
  }
  if (schema.type === 'string') return '';
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  if (schema.type === 'boolean') return false;
  return null;
}
