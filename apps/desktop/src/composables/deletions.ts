import { useConfirm } from 'primevue/useconfirm';
import type { ApiRequest } from '@aelvory/core';
import { useCollectionsStore } from '@/stores/collections';
import { useWorkspaceStore } from '@/stores/workspace';
import { useTabsStore } from '@/stores/tabs';

export function useDeletions() {
  const collections = useCollectionsStore();
  const workspace = useWorkspaceStore();
  const tabs = useTabsStore();
  const confirm = useConfirm();

  function collectDescendantFolderIds(id: string): string[] {
    const result = [id];
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      const kids = collections.collections.filter((c) => c.parentId === current);
      for (const k of kids) {
        result.push(k.id);
        stack.push(k.id);
      }
    }
    return result;
  }

  function countDescendants(id: string) {
    const folderIds = collectDescendantFolderIds(id);
    const folders = folderIds.length - 1; // exclude self
    const requests = folderIds.reduce(
      (sum, fid) => sum + collections.requestsFor(fid).length,
      0,
    );
    return { folders, requests };
  }

  function confirmDeleteCollection(id: string, onAfter?: () => void) {
    const col = collections.findById(id);
    if (!col) return;
    const { folders, requests } = countDescendants(id);
    const extras = [];
    if (folders > 0)
      extras.push(`${folders} sub-folder${folders !== 1 ? 's' : ''}`);
    if (requests > 0)
      extras.push(`${requests} request${requests !== 1 ? 's' : ''}`);
    const extra = extras.length ? ` This will also delete ${extras.join(' and ')}.` : '';
    confirm.require({
      header: 'Delete folder',
      message: `Delete "${col.name}"?${extra} This cannot be undone.`,
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptClass: 'p-button-danger',
      accept: async () => {
        if (!workspace.currentProjectId) return;
        const folderIds = collectDescendantFolderIds(id);
        const requestIds = folderIds.flatMap((fid) =>
          collections.requestsFor(fid).map((r) => r.id),
        );
        await collections.deleteCollection(workspace.currentProjectId, id);
        for (const fid of folderIds) tabs.close(fid);
        for (const rid of requestIds) tabs.close(rid);
        onAfter?.();
      },
    });
  }

  function confirmDeleteRequest(r: ApiRequest, onAfter?: () => void) {
    confirm.require({
      header: 'Delete request',
      message: `Delete "${r.name}"? This cannot be undone.`,
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptClass: 'p-button-danger',
      accept: async () => {
        await collections.deleteRequest(r);
        tabs.close(r.id);
        onAfter?.();
      },
    });
  }

  function confirmDeleteProject(id: string, onAfter?: () => void) {
    const project = workspace.projects.find((p) => p.id === id);
    if (!project) return;
    confirm.require({
      header: 'Delete project',
      message: `Delete project "${project.name}"? All collections, folders, requests and environments inside will be gone. This cannot be undone.`,
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptClass: 'p-button-danger',
      accept: async () => {
        await workspace.deleteProject(id);
        onAfter?.();
      },
    });
  }

  return {
    confirmDeleteCollection,
    confirmDeleteRequest,
    confirmDeleteProject,
  };
}
