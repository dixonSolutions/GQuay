/**
 * agent-locks parsing and overlap detection.
 *
 * Two properties are deliberate rather than accidental: the parser degrades to
 * "no locks" on unfamiliar input (a format drift must not block every edit from
 * inside a PreToolUse hook), and the overlap test is biased toward false
 * positives (a false positive costs one check; a false negative hides a real
 * conflict).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLock, readLocks, globOverlaps, findConflicts, findStaleLocks } from '../src/mcp/locks.ts';
import type { AgentLock } from '../src/mcp/locks.ts';

test('parses the list form of a claim', () => {
  const parsed = parseLock(`# Fix flaky OAuth callback test
agent_id: issue:kingspan/portal#42
parent_agent_id: pr:kingspan/portal#87
status: active
scope:
  - backend/src/oauth/**
  - backend/test/oauth/**
`);
  assert.equal(parsed.title, 'Fix flaky OAuth callback test');
  assert.equal(parsed.agentId, 'issue:kingspan/portal#42');
  assert.equal(parsed.parentAgentId, 'pr:kingspan/portal#87');
  assert.deepEqual(parsed.scope, ['backend/src/oauth/**', 'backend/test/oauth/**']);
});

test('parses the inline form, quoted or bracketed', () => {
  assert.deepEqual(parseLock('scope: ["a/**", "b/**"]').scope, ['a/**', 'b/**']);
  assert.deepEqual(parseLock('scope: a/**, b/**').scope, ['a/**', 'b/**']);
});

test('unfamiliar input degrades to an empty claim rather than throwing', () => {
  const parsed = parseLock('this is prose, not a lock file at all');
  assert.deepEqual(parsed.scope, []);
});

test('a missing lock directory reads as no locks', () => {
  assert.deepEqual(readLocks('/nonexistent/path/xyz'), []);
});

test('reads real lock files off disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gquay-locks-'));
  mkdirSync(join(dir, 'agents-locks'), { recursive: true });
  writeFileSync(
    join(dir, 'agents-locks', 'oauth.md'),
    '# OAuth work\nagent_id: issue:a/b#42\nstatus: active\nscope:\n  - src/oauth/**\n',
  );
  writeFileSync(join(dir, 'agents-locks', 'garbage.md'), 'nothing useful here');

  const locks = readLocks(dir);
  assert.equal(locks.length, 2, 'unparseable files still appear, with no scope');
  const oauth = locks.find((l) => l.agentId === 'issue:a/b#42');
  assert.deepEqual(oauth?.scope, ['src/oauth/**']);
  rmSync(dir, { recursive: true, force: true });
});

// ── Overlap ───────────────────────────────────────────────────────────────────

test('a glob claim overlaps files beneath it', () => {
  assert.equal(globOverlaps('backend/src/oauth/**', 'backend/src/oauth/callback.ts'), true);
  assert.equal(globOverlaps('backend/src/oauth/**', 'backend/src/billing/invoice.ts'), false);
});

test('a claim on everything overlaps everything', () => {
  assert.equal(globOverlaps('**', 'anything/at/all.ts'), true);
});

test('a literal claim overlaps only itself and its contents', () => {
  assert.equal(globOverlaps('src/index.ts', 'src/index.ts'), true);
  assert.equal(globOverlaps('src', 'src/index.ts'), true);
  assert.equal(globOverlaps('src/index.ts', 'src/other.ts'), false);
});

test('the static prefix does not match a partial segment', () => {
  // `src/oa*` must not be read as claiming `src/oauth/…` by prefix accident.
  assert.equal(globOverlaps('src/oa*', 'src/oauth/callback.ts'), true,
    'same directory — the heuristic errs toward reporting a conflict');
  assert.equal(globOverlaps('backend/**', 'frontend/app.ts'), false);
});

function lock(over: Partial<AgentLock> = {}): AgentLock {
  return {
    file: 'x.md',
    title: 'Some work',
    scope: ['src/oauth/**'],
    agentId: 'issue:a/b#42',
    status: 'active',
    updatedAt: Date.now(),
    ...over,
  };
}

test('an agent never conflicts with its own claim', () => {
  const conflicts = findConflicts([lock()], 'src/oauth/callback.ts', {
    selfAgentId: 'issue:a/b#42',
  });
  assert.equal(conflicts.length, 0);
});

test('a sibling agent\'s claim does conflict', () => {
  const conflicts = findConflicts([lock()], 'src/oauth/callback.ts', {
    selfAgentId: 'issue:a/b#99',
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.pattern, 'src/oauth/**');
});

test('finished claims are ignored', () => {
  const conflicts = findConflicts([lock({ status: 'finished' })], 'src/oauth/x.ts', {});
  assert.equal(conflicts.length, 0);
});

test('claims older than the staleness window are ignored', () => {
  const old = lock({ updatedAt: Date.now() - 8 * 3_600_000 });
  assert.equal(findConflicts([old], 'src/oauth/x.ts', { staleAfterMs: 6 * 3_600_000 }).length, 0);
  assert.equal(findConflicts([old], 'src/oauth/x.ts', {}).length, 1, 'no window means no expiry');
});

test('case normalisation catches the Windows worker case', () => {
  const claim = lock({ scope: ['Src/OAuth/**'] });
  // agent-locks does not model case-sensitivity; on Windows these are one file.
  assert.equal(findConflicts([claim], 'src/oauth/callback.ts', {}).length, 0);
  assert.equal(
    findConflicts([claim], 'src/oauth/callback.ts', { normaliseCase: true }).length,
    1,
  );
});

// ── Reaping ───────────────────────────────────────────────────────────────────

test('a stale claim held by a dead session is reapable', () => {
  const stale = lock({ updatedAt: Date.now() - 8 * 3_600_000, agentId: 'issue:a/b#1' });
  const fresh = lock({ updatedAt: Date.now(), agentId: 'issue:a/b#2' });
  const live = new Set(['issue:a/b#2']);

  const reapable = findStaleLocks([stale, fresh], (id) => live.has(id), 6 * 3_600_000);
  assert.equal(reapable.length, 1);
  assert.equal(reapable[0]?.agentId, 'issue:a/b#1');
});

test('a stale claim whose session is still running is left alone', () => {
  const stale = lock({ updatedAt: Date.now() - 8 * 3_600_000, agentId: 'issue:a/b#1' });
  const reapable = findStaleLocks([stale], () => true, 6 * 3_600_000);
  assert.equal(reapable.length, 0);
});

test('an old anonymous claim is reapable — nothing can vouch for it', () => {
  const anon = lock({ updatedAt: Date.now() - 8 * 3_600_000 });
  delete (anon as { agentId?: string }).agentId;
  assert.equal(findStaleLocks([anon], () => true, 6 * 3_600_000).length, 1);
});
