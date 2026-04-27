#!/usr/bin/env node
/**
 * Bundle the extension host with esbuild.
 *
 * The host code is small (file I/O proxy + webview wiring) and has
 * no native dependencies — sql.js runs in the webview, not here. So
 * this is a vanilla esbuild config: TypeScript in, single CommonJS
 * file out, vscode kept external.
 *
 * Usage:
 *   node esbuild.mjs               # production build
 *   node esbuild.mjs --watch       # rebuild on every change
 */
import { build, context as esbuildContext } from 'esbuild';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const root = resolve(import.meta.dirname);

const buildOptions = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  bundle: true,
  outfile: resolve(root, 'out/extension.js'),
  // `vscode` is provided by the extension host at runtime; bundling
  // it would either fail to resolve or duplicate the host module.
  external: ['vscode'],
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

// Wipe stale artefacts (e.g. an old `tsc` build, the previous
// better-sqlite3 native binding) so the produced .vsix doesn't
// carry orphaned files.
const outDir = resolve(root, 'out');
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

if (watch) {
  const ctx = await esbuildContext(buildOptions);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await build(buildOptions);
}
