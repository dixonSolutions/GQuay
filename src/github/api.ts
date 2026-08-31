/**
 * Thin GitHub REST client.
 *
 * Deliberately small. The *agent* talks to GitHub through the GitHub MCP
 * server; this client exists only for the things the Router itself must do
 * before or without a session: check an actor's permission level, assemble
 * spawn context, read `.github/gquay.yml`, read Actions Variables, and post the
 * occasional Router-authored comment.
 */

import type { AppAuthOptions } from './app.js';
import { tokenForRepo } from './app.js';
import { childLogger } from '../log.js';

const log = childLogger('github-api');

export class GitHubApi {
  constructor(private readonly opts: AppAuthOptions) {}

  private async request<T>(
    repo: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ ok: boolean; status: number; body: T | undefined; etag?: string }> {
    const token = await tokenForRepo(this.opts, repo);
    const res = await fetch(`${this.opts.apiBase}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'gquay-router',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    // 304 is a success for the ETag-conditional reads in router/repoConfig.ts.
    if (res.status === 304) return { ok: true, status: 304, body: undefined };
    if (!res.ok) {
      log.warn({ path, status: res.status }, 'github api error');
      return { ok: false, status: res.status, body: undefined };
    }
    const etag = res.headers.get('etag') ?? undefined;
    if (res.status === 204) return { ok: true, status: 204, body: undefined, etag };
    return { ok: true, status: res.status, body: (await res.json()) as T, etag };
  }

  // ── Permissions ─────────────────────────────────────────────────────────────

  /**
   * An actor's permission level on a repo: admin | maintain | write | triage |
   * read | none. This is security-critical — §11 rule 1 says only actors with
   * write access are acted on at all, and rule 2 says merge approval is matched
   * against this, never inferred from comment text.
   */
  async permissionLevel(repo: string, login: string): Promise<string> {
    const [owner, name] = repo.split('/');
    const res = await this.request<{ permission: string }>(
      repo,
      `/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    if (!res.ok || !res.body) return 'none';
    return res.body.permission ?? 'none';
  }

  // ── Reads used to assemble spawn context ────────────────────────────────────

  async getIssue(repo: string, number: number): Promise<IssuePayload | undefined> {
    const [owner, name] = repo.split('/');
    const res = await this.request<IssuePayload>(repo, `/repos/${owner}/${name}/issues/${number}`);
    return res.body;
  }

  async listIssueComments(repo: string, number: number): Promise<CommentPayload[]> {
    const [owner, name] = repo.split('/');
    const res = await this.request<CommentPayload[]>(
      repo,
      `/repos/${owner}/${name}/issues/${number}/comments?per_page=100`,
    );
    return res.body ?? [];
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestPayload | undefined> {
    const [owner, name] = repo.split('/');
    const res = await this.request<PullRequestPayload>(repo, `/repos/${owner}/${name}/pulls/${number}`);
    return res.body;
  }

  async getFile(repo: string, path: string, ref?: string): Promise<string | undefined> {
    const [owner, name] = repo.split('/');
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const res = await this.request<{ content?: string; encoding?: string }>(
      repo,
      `/repos/${owner}/${name}/contents/${path}${q}`,
    );
    if (!res.body?.content) return undefined;
    return Buffer.from(res.body.content, 'base64').toString('utf8');
  }

  async defaultBranch(repo: string): Promise<string> {
    const [owner, name] = repo.split('/');
    const res = await this.request<{ default_branch: string }>(repo, `/repos/${owner}/${name}`);
    return res.body?.default_branch ?? 'main';
  }

  async cloneUrl(repo: string): Promise<string> {
    return `https://github.com/${repo}.git`;
  }

  // ── Actions Variables (Tier 2 config) ───────────────────────────────────────

  /**
   * Variables are readable through the API; *secrets* are not, by design — the
   * list endpoint never reveals a value and only a workflow runtime can decrypt
   * one. Since the Router is a standalone process and not an Actions job, this
   * asymmetry is what forces the four-tier split in docs/06-configuration.md.
   */
  async repoVariables(
    repo: string,
    etag?: string,
  ): Promise<{ vars?: Record<string, string>; etag?: string; notModified: boolean }> {
    const [owner, name] = repo.split('/');
    const res = await this.request<{ variables: { name: string; value: string }[] }>(
      repo,
      `/repos/${owner}/${name}/actions/variables?per_page=100`,
      etag ? { headers: { 'if-none-match': etag } } : {},
    );
    if (res.status === 304) return { notModified: true };
    if (!res.ok || !res.body) return { notModified: false };
    return {
      vars: Object.fromEntries(res.body.variables.map((v) => [v.name, v.value])),
      etag: res.etag,
      notModified: false,
    };
  }

  async orgVariables(
    repoForAuth: string,
    org: string,
    etag?: string,
  ): Promise<{ vars?: Record<string, string>; etag?: string; notModified: boolean }> {
    const res = await this.request<{ variables: { name: string; value: string }[] }>(
      repoForAuth,
      `/orgs/${org}/actions/variables?per_page=100`,
      etag ? { headers: { 'if-none-match': etag } } : {},
    );
    if (res.status === 304) return { notModified: true };
    if (!res.ok || !res.body) return { notModified: false };
    return {
      vars: Object.fromEntries(res.body.variables.map((v) => [v.name, v.value])),
      etag: res.etag,
      notModified: false,
    };
  }

  // ── Writes the Router makes on its own behalf ───────────────────────────────

  async comment(repo: string, issueNumber: number, body: string): Promise<number | undefined> {
    const [owner, name] = repo.split('/');
    const res = await this.request<{ id: number }>(
      repo,
      `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
    return res.body?.id;
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    const [owner, name] = repo.split('/');
    await this.request(repo, `/repos/${owner}/${name}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    });
  }

  /**
   * Fire a `workflow_dispatch` at a workflow gated by a GitHub Environment with
   * required reviewers — the alternative merge-approval path in §10. The human
   * approves in GitHub's native UI and the approval audit trail comes for free.
   */
  async dispatchWorkflow(
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<boolean> {
    const [owner, name] = repo.split('/');
    const res = await this.request(
      repo,
      `/repos/${owner}/${name}/actions/workflows/${workflowFile}/dispatches`,
      { method: 'POST', body: JSON.stringify({ ref, inputs }) },
    );
    return res.ok;
  }
}

// ── Payload shapes (only the fields the Router reads) ─────────────────────────

export interface IssuePayload {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: { name: string }[];
  user: { login: string; type: string } | null;
  assignee: { login: string } | null;
  assignees: { login: string }[];
  pull_request?: unknown;
}

export interface CommentPayload {
  id: number;
  body: string;
  html_url: string;
  user: { login: string; type: string } | null;
  author_association: string;
  created_at: string;
}

export interface PullRequestPayload {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  merged: boolean;
  draft: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string; type: string } | null;
  labels: { name: string }[];
}
