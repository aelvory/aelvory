import type { ApiRequest, ExecuteResponse } from '@aelvory/core';

export interface TestResult {
  name: string;
  pass: boolean;
  message?: string;
}

export interface EnvUpdate {
  key: string;
  value: string;
}

export interface ScriptRunResult {
  logs: string[];
  tests: TestResult[];
  envUpdates: EnvUpdate[];
  error: string | null;
}

interface PreContext {
  request: ApiRequest;
  env: Record<string, string>;
}

interface PostContext {
  request: ApiRequest;
  response: ExecuteResponse;
  env: Record<string, string>;
}

export function runPreScript(source: string, ctx: PreContext): ScriptRunResult {
  return run(source, ctx, 'pre');
}

export function runPostScript(source: string, ctx: PostContext): ScriptRunResult {
  return run(source, ctx, 'post');
}

function run(
  source: string,
  ctx: PreContext | PostContext,
  phase: 'pre' | 'post',
): ScriptRunResult {
  const result: ScriptRunResult = {
    logs: [],
    tests: [],
    envUpdates: [],
    error: null,
  };

  if (!source.trim()) return result;

  const api = createApi(ctx, phase, result);

  try {
    // User code runs as the body of a function taking `aelvory` as its only
    // parameter. Not a secure sandbox — the function has access to window, fetch,
    // etc. — but acceptable for a single-user dev tool. Future: QuickJS-wasm worker.
    const fn = new Function('aelvory', source);
    fn(api);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

function createApi(
  ctx: PreContext | PostContext,
  phase: 'pre' | 'post',
  result: ScriptRunResult,
) {
  const envMap: Record<string, string> = { ...ctx.env };
  const response = phase === 'post' ? (ctx as PostContext).response : null;

  return {
    request: Object.freeze({ ...ctx.request }),
    response: response ? buildResponseFacade(response) : undefined,
    env: {
      get: (key: string): string | undefined => envMap[key],
      set: (key: string, value: unknown) => {
        const v = value == null ? '' : String(value);
        envMap[key] = v;
        result.envUpdates.push({ key, value: v });
      },
      has: (key: string): boolean => key in envMap,
      all: (): Record<string, string> => ({ ...envMap }),
    },
    console: {
      log: (...args: unknown[]) => {
        result.logs.push(args.map(formatArg).join(' '));
      },
      error: (...args: unknown[]) => {
        result.logs.push('[error] ' + args.map(formatArg).join(' '));
      },
      warn: (...args: unknown[]) => {
        result.logs.push('[warn] ' + args.map(formatArg).join(' '));
      },
    },
    test: (name: string, fn: () => unknown) => {
      try {
        fn();
        result.tests.push({ name, pass: true });
      } catch (err) {
        result.tests.push({
          name,
          pass: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    expect: buildExpect,
    utils: {
      base64: {
        encode: (s: string) => btoa(s),
        decode: (s: string) => atob(s),
      },
      now: () => Date.now(),
      uuid: () =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  };
}

function buildResponseFacade(response: ExecuteResponse) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
    durationMs: response.durationMs,
    sizeBytes: response.sizeBytes,
    contentType: response.contentType ?? null,
    json: (): unknown => {
      try {
        return JSON.parse(response.body);
      } catch {
        return null;
      }
    },
    text: () => response.body,
    header: (name: string): string | undefined => {
      const lower = name.toLowerCase();
      const h = response.headers.find((x) => x.key.toLowerCase() === lower);
      return h?.value;
    },
  };
}

function buildExpect(actual: unknown) {
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  return {
    toBe: (expected: unknown) => {
      if (actual !== expected) {
        fail(`expected ${formatArg(actual)} to be ${formatArg(expected)}`);
      }
    },
    toEqual: (expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(`expected ${formatArg(actual)} to deep-equal ${formatArg(expected)}`);
      }
    },
    toContain: (expected: unknown) => {
      if (
        actual == null ||
        (typeof actual === 'string'
          ? !actual.includes(String(expected))
          : Array.isArray(actual)
            ? !actual.includes(expected)
            : true)
      ) {
        fail(`expected ${formatArg(actual)} to contain ${formatArg(expected)}`);
      }
    },
    toBeDefined: () => {
      if (actual === undefined) fail(`expected value to be defined`);
    },
    toBeNull: () => {
      if (actual !== null) fail(`expected ${formatArg(actual)} to be null`);
    },
    toBeTruthy: () => {
      if (!actual) fail(`expected ${formatArg(actual)} to be truthy`);
    },
    toBeFalsy: () => {
      if (actual) fail(`expected ${formatArg(actual)} to be falsy`);
    },
    toHaveProperty: (prop: string) => {
      if (!actual || typeof actual !== 'object' || !(prop in actual)) {
        fail(`expected to have property "${prop}"`);
      }
    },
    toMatch: (re: RegExp | string) => {
      const str = String(actual);
      const pattern = re instanceof RegExp ? re : new RegExp(re);
      if (!pattern.test(str)) {
        fail(`expected "${str}" to match ${pattern}`);
      }
    },
  };
}

function formatArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
