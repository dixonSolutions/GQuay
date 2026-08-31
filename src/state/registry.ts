/**
 * The work-item registry — which agent owns what.
 *
 * A work item is an issue or a PR, keyed `issue:owner/repo#42`. Exactly one
 * session owns it. The linking rule (§2.3) is what makes an issue and the PR
 * it produced feel like one agent: when the session working `issue:repo#42`
 * opens a PR, `pr:repo#87` is written with `linked_key = issue:repo#42` and the
 * *same* session_id, so every later comment on either thread routes to the same
 * process.
 *
 * A PR opened by a human with no linked issue gets its own fresh session.
 */

import { getDb, now, nowPlus, toMillis } from './db.js';
import { childLogger } from '../log.js';

const log = childLogger('registry');

// ── Keys ──────────────────────────────────────────────────────────────────────

export type WorkItemKind = 'issue' | 'pr';

export interface WorkItemRef {
  kind: WorkItemKind;
  repo: string; // owner/repo
  number: number;
}

export function workItemKey(ref: WorkItemRef): string {
  return `${ref.kind}:${ref.repo}#${ref.number}`;
}

const KEY_RE = /^(issue|pr):([^/\s#]+\/[^/\s#]+)#(\d+)$/;

export function parseWorkItemKey(key: string): WorkItemRef | undefined {
  const m = KEY_RE.exec(key);
  if (!m) return undefined;
  return { kind: m[1] as WorkItemKind, repo: m[2]!, number: Number(m[3]) };
}

/** The `owner` half of `owner/repo`. */
export function ownerOf(repo: string): string {
  return repo.split('/')[0] ?? '';
}

// ── State machine ─────────────────────────────────────────────────────────────
//
//   starting -> working -> idle -> parked -> (resume) -> working
//                  |
//                  +-> awaiting_input -> working
//                  +-> dead

export type WorkItemState =
  | 'starting'
  | 'working'
  | 'idle'
  | 'awaiting_input'
  | 'parked'
  | 'dead';

/** States in which a session process is expected to still exist. */
export const LIVE_STATES: WorkItemState[] = ['starting', 'working', 'idle', 'awaiting_input'];

export interface WorkItem {
  key: string;
  kind: WorkItemKind;
  repo: string;
  number: number;
  session_id: string | null;
  pid: number | null;
  state: WorkItemState;
  model: string;
  target: string | null;
  worker_id: string | null;
  branch: string | null;
  worktree: string | null;
  owner_login: string | null;
  linked_key: string | null;
  title: string | null;
  granted_scopes: string | null;
  mcp_token: string | null;
  created_at: string;
  last_activity: string | null;
  idle_since: string | null;
  awaiting_since: string | null;
  nudged_at: string | null;
  escalated_at: string | null;
  merge_approved_until: string | null;
  merge_approved_by: string | null;
  notify_thread: string | null;
  error: string | null;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getWorkItem(key: string): WorkItem | undefined {
  return getDb().prepare('SELECT * FROM work_items WHERE key = ?').get(key) as
    | WorkItem
    | undefined;
}

export function getBySessionId(sessionId: string): WorkItem | undefined {
  return getDb()
    .prepare('SELECT * FROM work_items WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(sessionId) as WorkItem | undefined;
}

export function getByMcpToken(token: string): WorkItem | undefined {
  return getDb().prepare('SELECT * FROM work_items WHERE mcp_token = ?').get(token) as
    | WorkItem
    | undefined;
}

export function listWorkItems(states?: WorkItemState[]): WorkItem[] {
  if (!states || states.length === 0) {
    return getDb().prepare('SELECT * FROM work_items ORDER BY created_at DESC').all() as WorkItem[];
  }
  const placeholders = states.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM work_items WHERE state IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...states) as WorkItem[];
}

/** Live sessions currently pinned to an execution target — for capacity checks. */
export function countActiveOnTarget(target: string): number {
  const placeholders = LIVE_STATES.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM work_items WHERE target = ? AND state IN (${placeholders})`,
    )
    .get(target, ...LIVE_STATES) as { n: number };
  return row.n;
}

export function countActiveTotal(): number {
  const placeholders = LIVE_STATES.map(() => '?').join(',');
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM work_items WHERE state IN (${placeholders})`)
    .get(...LIVE_STATES) as { n: number };
  return row.n;
}

/**
 * Resolve the work item that owns a thread. A PR routes to its linked issue's
 * session when one exists — that is the §2.3 linking rule in read form.
 */
export function resolveOwningItem(key: string): WorkItem | undefined {
  const item = getWorkItem(key);
  if (!item) return undefined;
  if (item.linked_key && item.session_id === null) {
    const linked = getWorkItem(item.linked_key);
    if (linked) return linked;
  }
  return item;
}

// ── Write ─────────────────────────────────────────────────────────────────────

export interface CreateWorkItemInput extends WorkItemRef {
  model: string;
  target: string;
  ownerLogin?: string;
  title?: string;
  branch?: string;
  linkedKey?: string;
  grantedScopes?: string[];
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const key = workItemKey(input);
  getDb()
    .prepare(
      `INSERT INTO work_items
        (key, kind, repo, number, state, model, target, owner_login, title, branch,
         linked_key, granted_scopes, last_activity)
       VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         state = 'starting', model = excluded.model, target = excluded.target,
         title = COALESCE(excluded.title, work_items.title),
         branch = COALESCE(excluded.branch, work_items.branch),
         linked_key = COALESCE(excluded.linked_key, work_items.linked_key),
         granted_scopes = excluded.granted_scopes,
         last_activity = excluded.last_activity, error = NULL`,
    )
    .run(
      key,
      input.kind,
      input.repo,
      input.number,
      input.model,
      input.target,
      input.ownerLogin ?? null,
      input.title ?? null,
      input.branch ?? null,
      input.linkedKey ?? null,
      input.grantedScopes ? JSON.stringify(input.grantedScopes) : null,
      now(),
    );
  log.info({ key, target: input.target, model: input.model }, 'work item created');
  return getWorkItem(key)!;
}

export function setState(key: string, state: WorkItemState, extra?: Partial<WorkItem>): void {
  const db = getDb();
  const patch: Record<string, unknown> = { state, last_activity: now(), ...extra };

  // The two timers of §8 are distinct: `idle` means the agent has nothing to
  // do, `awaiting_input` means it is blocked on a human. Only the second
  // escalates, so only the second's clock is started here.
  if (state === 'idle') {
    patch['idle_since'] = patch['idle_since'] ?? now();
  } else {
    patch['idle_since'] = null;
  }
  if (state === 'awaiting_input') {
    const existing = getWorkItem(key);
    patch['awaiting_since'] = existing?.awaiting_since ?? now();
  } else {
    patch['awaiting_since'] = null;
    patch['nudged_at'] = null;
    patch['escalated_at'] = null;
  }

  const cols = Object.keys(patch);
  const sql = `UPDATE work_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE key = ?`;
  db.prepare(sql).run(...cols.map((c) => patch[c] ?? null), key);
  log.debug({ key, state }, 'state');
}

export function update(key: string, patch: Partial<WorkItem>): void {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const sql = `UPDATE work_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE key = ?`;
  getDb()
    .prepare(sql)
    .run(...cols.map((c) => (patch as Record<string, unknown>)[c] ?? null), key);
}

export function touch(key: string): void {
  getDb().prepare('UPDATE work_items SET last_activity = ? WHERE key = ?').run(now(), key);
}

export function setSession(key: string, sessionId: string, pid?: number): void {
  getDb()
    .prepare('UPDATE work_items SET session_id = ?, pid = ?, last_activity = ? WHERE key = ?')
    .run(sessionId, pid ?? null, now(), key);
}

/**
 * The linking rule. Called from the PostToolUse hook on
 * `mcp__github__create_pull_request`: the new PR inherits the issue's session,
 * target, worktree, branch and scopes, so one process now owns both threads.
 */
export function linkPullRequest(issueKey: string, prRef: WorkItemRef): WorkItem | undefined {
  const issue = getWorkItem(issueKey);
  if (!issue) {
    log.warn({ issueKey }, 'link requested for unknown issue');
    return undefined;
  }
  const prKey = workItemKey(prRef);
  getDb()
    .prepare(
      `INSERT INTO work_items
         (key, kind, repo, number, session_id, pid, state, model, target, worker_id,
          branch, worktree, owner_login, linked_key, granted_scopes, mcp_token,
          notify_thread, last_activity)
       VALUES (?, 'pr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         session_id = excluded.session_id, pid = excluded.pid, state = excluded.state,
         target = excluded.target, worker_id = excluded.worker_id,
         branch = excluded.branch, worktree = excluded.worktree,
         linked_key = excluded.linked_key, granted_scopes = excluded.granted_scopes,
         mcp_token = excluded.mcp_token, notify_thread = excluded.notify_thread,
         last_activity = excluded.last_activity`,
    )
    .run(
      prKey,
      prRef.repo,
      prRef.number,
      issue.session_id,
      issue.pid,
      issue.state,
      issue.model,
      issue.target,
      issue.worker_id,
      issue.branch,
      issue.worktree,
      issue.owner_login,
      issueKey,
      issue.granted_scopes,
      issue.mcp_token,
      issue.notify_thread,
      now(),
    );
  getDb().prepare('UPDATE work_items SET linked_key = ? WHERE key = ?').run(prKey, issueKey);
  log.info({ issueKey, prKey, session: issue.session_id }, 'issue linked to PR — one session owns both');
  return getWorkItem(prKey);
}

/** Every key that shares a session with `key` — the item and its linked twin. */
export function siblingKeys(key: string): string[] {
  const item = getWorkItem(key);
  if (!item) return [key];
  return item.linked_key ? [item.key, item.linked_key] : [item.key];
}

// ── Merge gate flag (§6) ──────────────────────────────────────────────────────

/**
 * Set only by the Router, only when a human with write access posted the
 * approval phrase on this specific PR. Never inferred by the model, and never
 * settable from delivered comment text.
 */
export function approveMerge(key: string, byLogin: string, ttlMinutes: number): void {
  getDb()
    .prepare('UPDATE work_items SET merge_approved_until = ?, merge_approved_by = ? WHERE key = ?')
    .run(nowPlus(ttlMinutes * 60_000), byLogin, key);
  log.warn({ key, byLogin, ttlMinutes }, 'merge approved');
}

export function isMergeApproved(key: string): boolean {
  const item = getWorkItem(key);
  if (!item?.merge_approved_until) return false;
  return toMillis(item.merge_approved_until) > Date.now();
}

/** Approval is single-use: consume it the moment the merge tool call is allowed. */
export function consumeMergeApproval(key: string): void {
  getDb()
    .prepare('UPDATE work_items SET merge_approved_until = NULL WHERE key = ?')
    .run(key);
}

// ── Scopes ────────────────────────────────────────────────────────────────────

export function grantedScopes(item: WorkItem): string[] {
  if (!item.granted_scopes) return [];
  try {
    const parsed = JSON.parse(item.granted_scopes) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    // Fail closed: an unreadable grant set is no grants, never all grants.
    log.error({ key: item.key }, 'granted_scopes is not valid JSON — treating as empty');
    return [];
  }
}
