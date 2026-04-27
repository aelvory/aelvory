import { useCollectionsStore } from '@/stores/collections';
import { useEnvironmentsStore } from '@/stores/environments';
import type { ImportResult, ImportedFolder } from './importOpenApi';

export interface ImportOptions {
  projectId: string;
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

  const total = countNodes(result.root);
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

  await createFolder(result.root, null);

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
