/**
 * Git plumbing — bare mirrors and per-work-item worktrees.
 *
 * One worktree per work item is the isolation primitive: two agents never share
 * a checkout, so neither can overwrite the other's files. (It does nothing about
 * two agents doing *contradictory* work — that is a visibility problem, and
 * `mcp/locks.ts` handles it.)
 *
 * Worktrees are cut from a local bare mirror rather than cloned per session.
 * A mirror is fetched once and reused, which is faster than a clone, has no
 * clone-rate concerns, and keeps working when GitHub is briefly unreachable.
 *
 * Credentials never enter the worktree. `git.ts` fetches with a token supplied
 * per call and never writes one into `.git/config`; pushes go through the
 * branch-scoped credential helper in `router/gitCredentials.ts`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { childLogger } from './log.js';

const exec = promisify(execFile);
const log = childLogger('git');

export interface GitResult {
  stdout: string;
  stderr: string;
}

async function git(args: string[], cwd?: string, env?: Record<string, string>): Promise<GitResult> {
  const { stdout, stderr } = await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      // Never let git open an editor or a credential prompt inside a daemon.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/true',
      ...env,
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/** Filesystem-safe directory name for `owner/repo`. */
export function mirrorDirName(repo: string): string {
  return repo.replace('/', '__');
}

export function mirrorPath(mirrorsDir: string, repo: string): string {
  return resolve(mirrorsDir, `${mirrorDirName(repo)}.git`);
}

/**
 * Create the bare mirror if missing, then fetch. The token is passed in the URL
 * for this one invocation only — it is never persisted to the mirror's config,
 * so a leaked mirror directory is not a leaked credential.
 */
export async function ensureMirror(
  mirrorsDir: string,
  repo: string,
  token: string,
): Promise<string> {
  mkdirSync(mirrorsDir, { recursive: true });
  const path = mirrorPath(mirrorsDir, repo);
  const authUrl = `https://x-access-token:${token}@github.com/${repo}.git`;

  if (!existsSync(path)) {
    log.info({ repo, path }, 'creating bare mirror');
    await git(['clone', '--bare', authUrl, path]);
    // Strip the credential the clone wrote into the remote URL.
    await git(['remote', 'set-url', 'origin', `https://github.com/${repo}.git`], path);
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], path);
  }

  await git(
    ['-c', `credential.helper=!f() { echo "username=x-access-token"; echo "password=${token}"; }; f`,
     'fetch', '--prune', 'origin'],
    path,
  );
  return path;
}

export interface WorktreeSpec {
  worktreesDir: string;
  mirror: string;
  workItemKey: string;
  branch: string;
  /** Branch to cut from when `branch` does not exist yet. */
  baseBranch: string;
}

/** Directory name for a worktree — same sanitisation rule as the inbox. */
export function worktreeDirName(workItemKey: string): string {
  return workItemKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Create (or reuse) the worktree for a work item. Idempotent: a resumed session
 * finds its own checkout exactly as it left it, which is the reason the registry
 * pins a work item to one execution target for life.
 */
export async function ensureWorktree(spec: WorktreeSpec): Promise<string> {
  mkdirSync(spec.worktreesDir, { recursive: true });
  const path = resolve(spec.worktreesDir, worktreeDirName(spec.workItemKey));

  if (existsSync(resolve(path, '.git'))) {
    log.debug({ path }, 'worktree already present');
    return path;
  }

  const branchExists = await refExists(spec.mirror, `refs/heads/${spec.branch}`);
  const args = branchExists
    ? ['worktree', 'add', path, spec.branch]
    : ['worktree', 'add', '-b', spec.branch, path, spec.baseBranch];

  await git(args, spec.mirror);
  log.info({ path, branch: spec.branch, created: !branchExists }, 'worktree ready');
  return path;
}

async function refExists(mirror: string, ref: string): Promise<boolean> {
  try {
    await git(['show-ref', '--verify', '--quiet', ref], mirror);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a worktree and prune its registration. Nothing cleans this up for you —
 * a cloud sandbox is destroyed at session end, a local worktree is not, so the
 * `SessionEnd` hook and the Router's GC both call this or the disk fills.
 */
export async function removeWorktree(
  mirror: string,
  worktreesDir: string,
  workItemKey: string,
): Promise<void> {
  const path = resolve(worktreesDir, worktreeDirName(workItemKey));
  try {
    await git(['worktree', 'remove', '--force', path], mirror);
  } catch {
    // The worktree may already be gone, or the mirror may have moved. Fall back
    // to removing the directory and letting `prune` reconcile the metadata.
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  try {
    await git(['worktree', 'prune'], mirror);
  } catch {
    /* mirror gone — nothing to prune */
  }
  log.info({ workItemKey, path }, 'worktree removed');
}

/** Branch name for a work item. Matches what the push proxy will authorise. */
export function branchFor(workItemKey: string): string {
  const [kind, rest] = workItemKey.split(':');
  const number = rest?.split('#')[1] ?? '0';
  return `gquay/${kind === 'pr' ? 'pr' : 'issue'}-${number}`;
}

export async function currentBranch(worktree: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * `git rev-parse --git-common-dir` — the directory every worktree of a
 * repository shares. agent-locks roots its lock files here, which is what lets
 * sibling sessions see each other's claims without a database.
 */
export async function gitCommonDir(worktree: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(['rev-parse', '--git-common-dir'], worktree);
    return resolve(worktree, stdout.trim());
  } catch {
    return undefined;
  }
}

export async function changedFileCount(worktree: string, baseBranch: string): Promise<number> {
  try {
    const { stdout } = await git(['diff', '--name-only', `${baseBranch}...HEAD`], worktree);
    return stdout.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
