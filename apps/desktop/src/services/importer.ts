import { useCollectionsStore } from '@/stores/collections';
import { useEnvironmentsStore } from '@/stores/environments';
import type { ImportResult, ImportedFolder } from './importOpenApi';

export interface ImportOptions {
  projectId: string;
  /**
   * If set, the import is placed UNDER this existing collection
   * instead of at the project root. The imported root folder becomes
   * a child of this id.
   *
   * If `null` or undefined, the imported root becomes a top-level
   * collection in the project — the historical default.
   */
  intoCollectionId?: string | null;
  /**
   * If set, only requests whose path (slash-joined hierarchy from
   * the imported root) is in this set are imported. Empty folders
   * resulting from the filter are skipped too. When not set, the
   * full tree is imported (historical default).
   *
   * Path format: 'Folder/SubFolder/Request name'. Same shape that
   * `flattenRequestPaths` (in this module) produces from the parse.
   */
  includeRequestPaths?: Set<string>;
  createEnvName?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface ImportStats {
  collectionsCreated: number;
  requestsCreated: number;
  envCreated: boolean;
  varsCreated: number;
}

export async function importIntoProject(
  result: ImportResult,
  opts: ImportOptions,
): Promise<ImportStats> {
  const collections = useCollectionsStore();
  const environments = useEnvironmentsStore();

  const stats: ImportStats = {
    collectionsCreated: 0,
    requestsCreated: 0,
    envCreated: false,
    varsCreated: 0,
  };

  // Filter the tree down to just the user-selected paths (if any).
  // Skipping empty folders keeps the imported result tidy when the
  // user only ticked a handful of endpoints.
  const filter = opts.includeRequestPaths;
  function filterFolder(folder: ImportedFolder, prefix: string): ImportedFolder | null {
    if (!filter) return folder;
    const requests = folder.requests.filter((r) =>
      filter.has(`${prefix}${r.name}`),
    );
    const children = folder.children
      .map((c) => filterFolder(c, `${prefix}${c.name}/`))
      .filter((c): c is ImportedFolder => c !== null);
    if (requests.length === 0 && children.length === 0) return null;
    return { ...folder, requests, children };
  }
  const rootPrefix = `${result.root.name}/`;
  const filteredRoot = filterFolder(result.root, rootPrefix) ?? {
    ...result.root,
    requests: [],
    children: [],
  };

  const total = countNodes(filteredRoot);
  let done = 0;
  const step = () => {
    done++;
    opts.onProgress?.(done, total);
  };

  async function createFolder(folder: ImportedFolder, parentId: string | null) {
    const c = await collections.createCollection(
      opts.projectId,
      folder.name,
      parentId,
    );
    stats.collectionsCreated++;
    step();

    for (const req of folder.requests) {
      await collections.createRequest(c.id, {
        name: req.name,
        method: req.method,
        url: req.url,
        headers: req.headers,
        queryParams: req.queryParams,
        body: req.body,
        auth: req.auth,
      });
      stats.requestsCreated++;
      step();
    }

    for (const child of folder.children) {
      await createFolder(child, c.id);
    }
  }

  // `intoCollectionId` parents the imported root inside an existing
  // collection. `null`/undefined means top-level in the project.
  const initialParentId = opts.intoCollectionId ?? null;
  await createFolder(filteredRoot, initialParentId);

  if (opts.createEnvName && result.environmentSuggestions.length > 0) {
    const env = await environments.createEnvironment(opts.createEnvName);
    stats.envCreated = true;
    for (const s of result.environmentSuggestions) {
      await environments.upsertVariable(env.id, s.key, s.value, false);
      stats.varsCreated++;
    }
  }

  return stats;
}

function countNodes(folder: ImportedFolder): number {
  return (
    1 +
    folder.requests.length +
    folder.children.reduce((s, c) => s + countNodes(c), 0)
  );
}

/**
 * Walk the parsed import tree and return every request as
 * `{ path, method, url }` where path is the slash-joined folder
 * hierarchy ending with the request name. Used to render the
 * partial-import checklist in ImportDialog.
 */
export interface RequestPath {
  /** "RootFolder/SubFolder/Request name" — unique per import tree. */
  path: string;
  /** Just the leaf — used as the visible label in the checklist. */
  name: string;
  /** Depth from the root (used for indentation in the UI). */
  depth: number;
  method: string;
  url: string;
}

export function flattenRequestPaths(result: ImportResult): RequestPath[] {
  const out: RequestPath[] = [];
  function walk(folder: ImportedFolder, prefix: string, depth: number) {
    for (const r of folder.requests) {
      out.push({
        path: `${prefix}${r.name}`,
        name: r.name,
        depth,
        method: r.method,
        url: r.url,
      });
    }
    for (const c of folder.children) {
      walk(c, `${prefix}${c.name}/`, depth + 1);
    }
  }
  walk(result.root, `${result.root.name}/`, 0);
  return out;
}
