import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IGitHubAdapter, PullRequest, ChangedFile, MergeStatus, MergeMethod, MergeResult, StatusCheck } from '../types';

type GitRemote = { name: string; fetchUrl?: string };
type GitRepository = { state: { remotes: GitRemote[] } };
type GitAPI = { repositories: GitRepository[] };
type GitExtensionExports = { getAPI(version: number): GitAPI };

export class GitHubAdapter implements IGitHubAdapter {
  private octokit: Octokit | undefined;
  private owner: string = '';
  private repo: string = '';

  private async getOctokit(): Promise<Octokit> {
    if (!this.octokit) {
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true,
      });
      this.octokit = new Octokit({ auth: session.accessToken });
    }
    return this.octokit;
  }

  async setRepository(owner: string, repo: string): Promise<void> {
    this.owner = owner;
    this.repo = repo;
    this.octokit = undefined;
  }

  private async resolveRepo(): Promise<{ owner: string; repo: string }> {
    if (this.owner && this.repo) {
      return { owner: this.owner, repo: this.repo };
    }
    // Try to detect from workspace git remote
    const remoteUrl = await this.getRemoteUrl();
    const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) {
      throw new Error('Unable to determine GitHub repository. Please open a GitHub repository in VS Code.');
    }
    this.owner = match[1];
    this.repo = match[2].replace(/\.git$/, '');
    return { owner: this.owner, repo: this.repo };
  }

  private async getRemoteUrl(): Promise<string> {
    const remoteFromGitApi = await this.getRemoteUrlFromGitApi();
    if (remoteFromGitApi) {
      return remoteFromGitApi;
    }

    const remoteFromConfig = await this.getRemoteUrlFromGitConfig();
    if (remoteFromConfig) {
      return remoteFromConfig;
    }

    throw new Error(
      'Unable to detect git remote URL. Open a local GitHub repository and ensure the "origin" remote is configured.'
    );
  }

  private async getRemoteUrlFromGitApi(): Promise<string | undefined> {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) {
      return undefined;
    }

    let gitExports: GitExtensionExports | undefined;
    try {
      gitExports = extension.isActive ? extension.exports : await extension.activate();
    } catch {
      return undefined;
    }

    if (!gitExports || typeof gitExports.getAPI !== 'function') {
      return undefined;
    }

    const repos = gitExports.getAPI(1).repositories;
    for (const repo of repos) {
      const origin = repo.state.remotes.find((remote) => remote.name === 'origin');
      if (origin?.fetchUrl) {
        return origin.fetchUrl;
      }
    }

    return undefined;
  }

  private async getRemoteUrlFromGitConfig(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
      const remote = await this.readOriginRemoteFromWorkspace(folder.uri.fsPath);
      if (remote) {
        return remote;
      }
    }
    return undefined;
  }

  private async readOriginRemoteFromWorkspace(workspacePath: string): Promise<string | undefined> {
    const gitPath = path.join(workspacePath, '.git');
    let gitStat;

    try {
      gitStat = await fs.stat(gitPath);
    } catch {
      return undefined;
    }

    let configPath: string | undefined;
    if (gitStat.isDirectory()) {
      configPath = path.join(gitPath, 'config');
    } else {
      const pointer = await fs.readFile(gitPath, 'utf8');
      const match = pointer.match(/gitdir:\s*(.+)\s*$/im);
      if (!match) {
        return undefined;
      }
      const resolvedGitDir = path.resolve(workspacePath, match[1].trim());
      configPath = path.join(resolvedGitDir, 'config');
    }

    let config: string;
    try {
      config = await fs.readFile(configPath, 'utf8');
    } catch {
      return undefined;
    }

    const originBlockMatch = config.match(/\[remote "origin"\]([\s\S]*?)(?=\r?\n\[|$)/);
    if (!originBlockMatch) {
      return undefined;
    }

    const urlMatch = originBlockMatch[1].match(/^\s*url\s*=\s*(.+)\s*$/m);
    return urlMatch ? urlMatch[1].trim() : undefined;
  }

  async listOpenPRs(): Promise<PullRequest[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = await this.resolveRepo();
    const { data } = await octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 50,
    });
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? 'unknown',
      url: pr.html_url,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      changedFilesCount: (pr as unknown as { changed_files?: number }).changed_files ?? 0,
      createdAt: pr.created_at,
    }));
  }

  async getChangedFiles(prNumber: number): Promise<ChangedFile[]> {
    const octokit = await this.getOctokit();
    const { owner, repo } = await this.resolveRepo();
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return data.map((file) => ({
      filePath: file.filename,
      status: file.status as ChangedFile['status'],
      additions: file.additions,
      deletions: file.deletions,
    }));
  }

  async getDiff(prNumber: number, filePath: string): Promise<string> {
    const octokit = await this.getOctokit();
    const { owner, repo } = await this.resolveRepo();
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    const fullDiff = data as unknown as string;
    // Extract diff for the specific file
    const fileDiffMatch = fullDiff.match(
      new RegExp(`diff --git a/${escapeRegex(filePath)}[\\s\\S]*?(?=diff --git|$)`)
    );
    return fileDiffMatch ? fileDiffMatch[0] : '';
  }

  async submitReviewComment(
    prNumber: number,
    filePath: string,
    body: string,
    line: number
  ): Promise<void> {
    const octokit = await this.getOctokit();
    const { owner, repo } = await this.resolveRepo();
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    await octokit.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      body,
      path: filePath,
      line,
      commit_id: pr.head.sha,
    });
  }

  async getMergeStatus(prNumber: number): Promise<MergeStatus> {
    const octokit = await this.getOctokit();
    const { owner, repo } = await this.resolveRepo();
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });

    // Fetch status checks for the head commit
    const statusChecks: StatusCheck[] = [];
    try {
      const { data: combinedStatus } = await octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: pr.head.sha,
      });
      for (const s of combinedStatus.statuses) {
        statusChecks.push({
          name: s.context,
          status: s.state === 'success' ? 'success' : s.state === 'failure' || s.state === 'error' ? 'failure' : 'pending',
          description: s.description ?? undefined,
        });
      }
    } catch {
      // Status checks may not be available
    }

    // Determine allowed merge methods from repo settings
    let allowedMethods: MergeMethod[] = ['merge', 'squash', 'rebase'];
    try {
      const { data: repoData } = await octokit.repos.get({ owner, repo });
      allowedMethods = [];
      if (repoData.allow_merge_commit) { allowedMethods.push('merge'); }
      if (repoData.allow_squash_merge) { allowedMethods.push('squash'); }
      if (repoData.allow_rebase_merge) { allowedMethods.push('rebase'); }
    } catch {
      // Fallback to all methods
    }

    const mergeableState = pr.mergeable_state as MergeStatus['mergeableState'] ?? 'unknown';

    return {
      mergeable: pr.mergeable ?? false,
      mergeableState,
      merged: pr.merged,
      mergedBy: pr.merged_by?.login,
      mergedAt: pr.merged_at ?? undefined,
      behindBy: 0, // GitHub REST doesn't expose this directly on PR
      aheadBy: 0,
      allowedMethods,
      statusChecks,
    };
  }

  async mergePR(
    prNumber: number,
    method: MergeMethod,
    commitTitle?: string,
    commitMessage?: string
  ): Promise<MergeResult> {
    const octokit = await this.getOctokit();
    const { owner, repo } = await this.resolveRepo();

    try {
      const mergeMethodMap: Record<MergeMethod, 'merge' | 'squash' | 'rebase'> = {
        merge: 'merge',
        squash: 'squash',
        rebase: 'rebase',
      };

      const { data } = await octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: mergeMethodMap[method],
        commit_title: commitTitle,
        commit_message: commitMessage,
      });

      return {
        success: data.merged,
        sha: data.sha,
        message: data.message,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown merge error';
      return {
        success: false,
        message,
      };
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
