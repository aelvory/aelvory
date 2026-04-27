/**
 * Activity-bar sidebar status tree.
 *
 * Renders three info rows (workspace / last sync / account) in the
 * "Status" view of the Aelvory sidebar. Action buttons live in a
 * separate `viewsWelcome` view (`aelvory.actions`) above this one,
 * so they render as proper big primary/secondary buttons rather
 * than as flat tree items.
 *
 * Status data comes from the webview via the `sidebar.status` bridge
 * op (see bridge.ts) and is cached in `workspaceState` so it survives
 * between sessions and stays visible even before the webview has
 * booted on a fresh launch.
 */

import * as vscode from 'vscode';

const STATE_KEY = 'aelvory.sidebar.status';

export interface SidebarStatus {
  /** Display string like "Personal / My API". Empty = no workspace selected. */
  workspace?: string;
  /** ISO timestamp of the last successful sync. */
  lastSyncIso?: string;
  /** Signed-in user's email (or display name if email isn't available). */
  account?: string;
}

interface SidebarItem {
  id: string;
  label: string;
  description?: string;
  iconId?: string;
  commandId?: string;
}

export class AelvorySidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private readonly _onDidChange = new vscode.EventEmitter<SidebarItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Replace the cached status and refresh the view. */
  setStatus(status: SidebarStatus): void {
    void this.context.workspaceState.update(STATE_KEY, status);
    this._onDidChange.fire(undefined);
  }

  /**
   * Force a refresh — used when only the relative time string would
   * change (we don't want stale "synced 5m ago" stuck on screen all
   * day). Called from a low-frequency interval in extension.ts.
   */
  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(item: SidebarItem): vscode.TreeItem {
    const ti = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    if (item.description) ti.description = item.description;
    if (item.iconId) ti.iconPath = new vscode.ThemeIcon(item.iconId);
    if (item.commandId) {
      ti.command = {
        command: item.commandId,
        title: item.label,
      };
    }
    // contextValue lets future right-click menus distinguish status
    // rows from action rows without parsing labels.
    ti.contextValue = item.commandId ? 'action' : 'status';
    return ti;
  }

  getChildren(parent?: SidebarItem): SidebarItem[] {
    if (parent) return [];
    const status = this.context.workspaceState.get<SidebarStatus>(STATE_KEY) ?? {};
    return [
      {
        id: 'workspace',
        label: 'Workspace',
        description: status.workspace || 'not selected',
        iconId: 'briefcase',
      },
      {
        id: 'lastSync',
        label: 'Last sync',
        description: formatRelative(status.lastSyncIso) ?? 'never',
        iconId: 'sync',
      },
      {
        id: 'account',
        label: 'Account',
        description: status.account || 'signed out',
        iconId: 'account',
      },
    ];
  }
}

/**
 * Empty TreeDataProvider for the `aelvory.actions` view. The view
 * exists solely to host the `viewsWelcome` markdown content (big
 * "Open Aelvory" / "Sync now" / etc. buttons); welcome content only
 * renders when the bound view's tree is empty, hence the empty
 * provider.
 */
export class EmptyActionsProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(): vscode.TreeItem {
    throw new Error('unreachable: EmptyActionsProvider has no items');
  }
  getChildren(): never[] {
    return [];
  }
}

/**
 * Render an ISO timestamp as a short relative string ("just now",
 * "3m ago", "2h ago", "yesterday", "Mar 12"). Returns null for null/
 * unparseable input so the caller can substitute a placeholder.
 */
function formatRelative(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 30) return 'just now';
  if (sec < 90) return '1m ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  // Older than a week — show absolute date instead of "27d ago" which
  // is harder to compare against ISO timestamps in logs.
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
