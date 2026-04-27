#!/usr/bin/env node
/**
 * Wraps `tauri build` with an automatic build-number bump derived from
 * the git commit count.
 *
 * Why: each MSI / NSIS installer needs a unique version so installers
 * recognise themselves on upgrade and a future auto-updater can tell
 * newer from older. Bumping by hand is tedious; deriving from a
 * monotonic source (commit count) is reproducible per commit.
 *
 * Format: `<major>.<minor>.<patch>+<commitCount>` — semver
 * build-metadata. Tauri converts this to a 4-segment Windows
 * ProductVersion (e.g. `0.0.1.156`) on bundling.
 *
 * The bumped version is written to `tauri.conf.json` only for this
 * build, then restored in `finally` (even on build failure) so the
 * working tree stays clean. The `package.json` and `Cargo.toml`
 * versions are NOT touched — they remain the human-managed semver.
 *
 * Usage:
 *   pnpm --filter @aelvory/desktop build:release -- --bundles msi nsis
 *   pnpm --filter @aelvory/desktop build:release --bundles msi nsis
 *
 * The trailing args are passed straight through to `tauri build`.
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const confPath = join(desktopRoot, 'src-tauri', 'tauri.conf.json');

function git(args) {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf8',
      cwd: desktopRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const originalConf = readFileSync(confPath, 'utf8');
const conf = JSON.parse(originalConf);
const baseVersion = String(conf.version ?? '0.0.0');

const commitCount = Number(git('rev-list --count HEAD')) || 0;
const shortSha = git('rev-parse --short HEAD');
const isDirty = !!git('status --porcelain');

// Build-metadata suffix is fine for semver and Tauri converts it for MSI.
// We deliberately don't include a `.dirty` flag inside the version
// (it'd confuse semver parsers); the warning below is enough.
const buildVersion = `${baseVersion}+${commitCount}`;

console.log(`[build] base version  : ${baseVersion}`);
console.log(`[build] build version : ${buildVersion}${shortSha ? `  (sha: ${shortSha})` : ''}`);
if (isDirty) {
  console.log(`[build] WARNING       : working tree is dirty — this build is not reproducible from ${shortSha ?? 'HEAD'}`);
}

writeFileSync(
  confPath,
  JSON.stringify({ ...conf, version: buildVersion }, null, 2) + '\n',
  'utf8',
);

const args = process.argv.slice(2);
let exitCode = 0;
try {
  const r = spawnSync('pnpm', ['exec', 'tauri', 'build', ...args], {
    stdio: 'inherit',
    cwd: desktopRoot,
    shell: process.platform === 'win32',
  });
  exitCode = r.status ?? 1;
} finally {
  writeFileSync(confPath, originalConf, 'utf8');
  console.log(`[build] restored ${confPath} to base ${baseVersion}`);
}

process.exit(exitCode);
