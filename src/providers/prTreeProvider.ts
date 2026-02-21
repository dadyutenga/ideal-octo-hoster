import * as vscode from 'vscode';
import { PullRequest, IGitHubAdapter } from '../types';

export class PRTreeItem extends vscode.TreeItem {
  constructor(
    public readonly pr: PullRequest,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(`#${pr.number}: ${pr.title}`, collapsibleState);
    this.description = `by ${pr.author} · ${pr.changedFilesCount} file(s)`;
    this.tooltip = new vscode.MarkdownString(
      `**PR #${pr.number}**: ${pr.title}\n\n` +
      `- Author: ${pr.author}\n` +
      `- Branch: \`${pr.headBranch}\` → \`${pr.baseBranch}\`\n` +
      `- Files changed: ${pr.changedFilesCount}\n` +
      `- Created: ${new Date(pr.createdAt).toLocaleDateString()}`
    );
    this.iconPath = new vscode.ThemeIcon('git-pull-request');
    this.contextValue = 'pullRequest';
    this.command = {
      command: 'prism.reviewPR',
      title: 'Review PR',
      arguments: [pr],
    };
  }
}

export class PRTreeProvider implements vscode.TreeDataProvider<PRTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PRTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private prs: PullRequest[] = [];
  private loading = false;

  constructor(private readonly github: IGitHubAdapter) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PRTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PRTreeItem): Promise<PRTreeItem[]> {
    if (element) {
      return [];
    }
    if (this.loading) {
      return [];
    }
    this.loading = true;
    try {
      this.prs = await this.github.listOpenPRs();
      return this.prs.map((pr) => new PRTreeItem(pr));
    } catch (err) {
      vscode.window.showErrorMessage(`PRism: Failed to load PRs — ${(err as Error).message}`);
      return [];
    } finally {
      this.loading = false;
    }
  }
}
