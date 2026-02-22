import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';
import { IGitHubAdapter, PullRequest, ChangedFile } from '../types';

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
    const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports as
      | { getAPI(version: number): { repositories: Array<{ state: { remotes: Array<{ name: string; fetchUrl?: string }> } }> } }
      | undefined;
    if (gitExtension) {
      const api = gitExtension.getAPI(1);
      const repos = api.repositories;
      if (repos.length > 0) {
        const remotes = repos[0].state.remotes;
        const origin = remotes.find((r) => r.name === 'origin');
        if (origin?.fetchUrl) {
          return origin.fetchUrl;
        }
      }
    }
    throw new Error('Unable to detect git remote URL.');
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
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
