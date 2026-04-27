// Placeholder sandbox for pre/post/test scripts.
// The real implementation should run QuickJS via WebAssembly in a Web Worker
// (e.g. @jitl/quickjs-wasmfile-release-sync) with CPU/memory caps and an
// exposed `aelvory.{env,request,response,test}` API surface.
//
// For phase 1 we provide a no-op runner so other packages can depend on a
// stable contract.

import type { ApiRequest } from '@aelvory/core';

export interface ScriptResult {
  logs: string[];
  tests: { name: string; pass: boolean; message?: string }[];
  variables: Record<string, string>;
  error?: string;
}

export interface ScriptContext {
  request: ApiRequest;
  response?: { status: number; headers: Record<string, string>; body: string };
  variables: Record<string, string>;
}

export async function runScript(
  _source: string,
  _phase: 'pre' | 'post' | 'test',
  _ctx: ScriptContext,
): Promise<ScriptResult> {
  return { logs: [], tests: [], variables: {} };
}
