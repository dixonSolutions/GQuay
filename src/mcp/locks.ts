/**
 * Coordination between agents — a wrapper over agent-locks.
 *
 * Worktrees stop agents overwriting each other's files. They do nothing about
 * two agents doing *contradictory* work: one renaming a function while another
 * adds callers to it, two agents independently fixing the same bug, two PRs
 * that both restructure a module and cannot both land. That is a visibility
 * problem, and agent-locks already solves the hard part of it — work claims
 * stored as markdown under `git rev-parse --git-common-dir`/`agents-locks/`,
 * a path every worktree of a repository shares and which is structurally
 * impossible to commit, since git's index has no concept of a path under
 * `.git/`.
 *
 * GQuay adds the three things agent-locks deliberately leaves to the caller:
 *
 *   1. **Identity.** Claude Code exposes no session id to a stdio MCP server, so
 *      `agent_id` is whatever the caller supplies. The Router knows the work
 *      item before it spawns anything, so it passes it in and every lock traces
 *      back to an issue, a PR, and a Teams thread.
 *   2. **Claim at spawn, not mid-flight.** Conflicts are checked *before* a
 *      session starts, so an overlap is caught before an agent writes half a
 *      refactor.
 *   3. **Enforcement and cleanup.** agent-locks is advisory by design — right
 *      for a general tool, too loose for an unattended pipeline. The
 *      `PreToolUse` hook below turns an informational overlap report into a
 *      `permissionDecision`. And locks have no TTL, so a crashed agent holds
 *      its claim forever until the Router reaps it.
 *
 * The lock files are read directly rather than through an MCP client. Both
 * processes address the same directory, reading is the whole operation, and it
 * means the Router does not need a live agent-locks connection to answer a hook
 * in the milliseconds a `PreToolUse` has.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { childLogger } from '../log.js';

const log = childLogger('locks');

export interface AgentLock {
  file: string;
  title: string;
  /** Glob patterns this agent has claimed. */
  scope: string[];
  agentId?: string;
  parentAgentId?: string;
  status: string;
  updatedAt: number;
}

export const LOCK_DIR_NAME = 'agents-locks';

export function lockDir(gitCommonDir: string): string {
  return resolve(gitCommonDir, LOCK_DIR_NAME);
}

/**
 * Read every active claim. The parser is deliberately tolerant: agent-locks
 * writes human-readable markdown, and a format drift must degrade to "no locks
 * found" (an agent double-checks) rather than to a crash inside a PreToolUse
 * hook (every edit blocked).
 */
export function readLocks(gitCommonDir: string): AgentLock[] {
  const dir = lockDir(gitCommonDir);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (err) {
    log.warn({ dir, err: (err as Error).message }, 'lock directory unreadable');
    return [];
  }

  const locks: AgentLock[] = [];
  for (const file of entries) {
    const path = resolve(dir, file);
    try {
      const raw = readFileSync(path, 'utf8');
      const stat = statSync(path);
      const parsed = parseLock(raw);
      locks.push({
        file,
        title: parsed.title ?? file.replace(/\.md$/, ''),
        scope: parsed.scope,
        ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
        ...(parsed.parentAgentId ? { parentAgentId: parsed.parentAgentId } : {}),
        status: parsed.status ?? 'active',
        updatedAt: stat.mtimeMs,
      });
    } catch (err) {
      log.debug({ file, err: (err as Error).message }, 'skipping unparseable lock');
    }
  }
  return locks;
}

interface ParsedLock {
  title?: string;
  scope: string[];
  agentId?: string;
  parentAgentId?: string;
  status?: string;
}

/**
 * Accepts `key: value` lines and `- item` lists, with or without YAML fences,
 * and a leading `# Title` heading. Anything it does not recognise is ignored.
 */
export function parseLock(raw: string): ParsedLock {
  const out: ParsedLock = { scope: [] };
  let inScope = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '---' || trimmed.length === 0) continue;

    const heading = /^#\s+(.*)$/.exec(trimmed);
    if (heading && !out.title) {
      out.title = heading[1]!.trim();
      continue;
    }

    const listItem = /^[-*]\s+(.*)$/.exec(trimmed);
    if (inScope && listItem) {
      out.scope.push(stripQuotes(listItem[1]!));
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_ ]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) {
      inScope = false;
      continue;
    }
    const key = kv[1]!.toLowerCase().replace(/\s+/g, '_');
    const value = kv[2]!.trim();

    switch (key) {
      case 'title':
        out.title = stripQuotes(value);
        inScope = false;
        break;
      case 'agent_id':
      case 'agentid':
        out.agentId = stripQuotes(value);
        inScope = false;
        break;
      case 'parent_agent_id':
      case 'parentagentid':
        out.parentAgentId = stripQuotes(value);
        inScope = false;
        break;
      case 'status':
        out.status = stripQuotes(value).toLowerCase();
        inScope = false;
        break;
      case 'scope':
      case 'scopes':
      case 'files':
        inScope = true;
        if (value.length > 0) {
          // Inline form: `scope: ["a/**", "b/**"]` or `scope: a/**, b/**`
          const inline = value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((s) => stripQuotes(s.trim()))
            .filter((s) => s.length > 0);
          out.scope.push(...inline);
          inScope = false;
        }
        break;
      default:
        inScope = false;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '').trim();
}

// ── Overlap ───────────────────────────────────────────────────────────────────

export interface ConflictOptions {
  /** Ignore this agent's own claims. */
  selfAgentId?: string;
  /**
   * Lowercase everything before comparing. agent-locks does not model
   * case-sensitivity — a deliberate limitation targeting Linux. On a Windows
   * dispatch worker `Src/**` and `src/foo.ts` are the same real file but
   * compare as non-overlapping, so either normalise here or keep Windows
   * workers to repos no Linux worker also touches.
   */
  normaliseCase?: boolean;
  /** Claims older than this are treated as abandoned. Locks have no TTL. */
  staleAfterMs?: number;
}

export interface Conflict {
  lock: AgentLock;
  pattern: string;
  ageMs: number;
}

/**
 * Which active claims overlap `path`.
 *
 * The overlap test is a static-prefix heuristic, biased toward false positives
 * on purpose: a false positive means an agent double-checks, a false negative
 * hides a real conflict. That bias is right here too — but it does mean
 * `on_conflict: queue` will sometimes queue work unnecessarily, which is why
 * `notify` is the recommended starting policy.
 */
export function findConflicts(
  locks: AgentLock[],
  path: string,
  opts: ConflictOptions = {},
): Conflict[] {
  const norm = (s: string): string => (opts.normaliseCase ? s.toLowerCase() : s);
  const target = norm(path.replace(/\\/g, '/'));
  const staleAfter = opts.staleAfterMs ?? Infinity;
  const conflicts: Conflict[] = [];

  for (const lock of locks) {
    if (lock.status !== 'active') continue;
    if (opts.selfAgentId && lock.agentId === opts.selfAgentId) continue;
    const ageMs = Date.now() - lock.updatedAt;
    if (ageMs > staleAfter) continue;

    for (const pattern of lock.scope) {
      if (globOverlaps(norm(pattern.replace(/\\/g, '/')), target)) {
        conflicts.push({ lock, pattern, ageMs });
        break;
      }
    }
  }
  return conflicts;
}

/**
 * Static-prefix overlap. Everything up to the first wildcard is compared
 * literally; if either side is a prefix of the other, they may touch the same
 * file. Two claims that *both* contain wildcards are treated as overlapping
 * whenever their literal prefixes are compatible, which is the false-positive
 * bias described above.
 */
export function globOverlaps(pattern: string, path: string): boolean {
  const prefix = staticPrefix(pattern);
  const pathPrefix = staticPrefix(path);

  if (prefix.length === 0) return true; // `**/*` claims everything

  if (!pattern.includes('*')) {
    // A literal claim overlaps a literal path only if one contains the other
    // (directory claim vs file inside it).
    return path === pattern || path.startsWith(`${pattern}/`) || pattern.startsWith(`${path}/`);
  }

  return pathPrefix.startsWith(prefix) || prefix.startsWith(pathPrefix);
}

function staticPrefix(glob: string): string {
  const idx = glob.search(/[*?[]/);
  const head = idx === -1 ? glob : glob.slice(0, idx);
  // Trim back to the last complete path segment so `src/oa` does not match
  // `src/oauth` by accident.
  const lastSlash = head.lastIndexOf('/');
  return idx === -1 ? head : lastSlash === -1 ? '' : head.slice(0, lastSlash + 1);
}

// ── Reaping ───────────────────────────────────────────────────────────────────

/**
 * Locks have no TTL, so a crashed agent holds its claim forever. `SessionEnd`
 * calls `lock_finish`; this is the backstop for sessions that never got there.
 * Returns the claims whose owning work item is no longer running.
 */
export function findStaleLocks(
  locks: AgentLock[],
  isRunning: (agentId: string) => boolean,
  staleAfterMs: number,
): AgentLock[] {
  return locks.filter((lock) => {
    if (lock.status !== 'active') return false;
    if (Date.now() - lock.updatedAt < staleAfterMs) return false;
    if (!lock.agentId) return true; // anonymous and old — nothing can vouch for it
    return !isRunning(lock.agentId);
  });
}

/** One-line summary of a peer's claim, for SessionStart context. */
export function describeLock(lock: AgentLock): string {
  const age = Math.round((Date.now() - lock.updatedAt) / 60_000);
  const who = lock.agentId ? ` (${lock.agentId})` : '';
  return `${lock.title}${who} claims ${lock.scope.join(', ')} — active ${age}m`;
}
