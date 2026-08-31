/**
 * The registry, and the linking rule that makes an issue and its PR feel like
 * one agent.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, getDb } from '../src/state/db.ts';
import * as registry from '../src/state/registry.ts';

const dir = mkdtempSync(join(tmpdir(), 'gquay-registry-'));
openDb(dir);

beforeEach(() => {
  getDb().exec('DELETE FROM work_items');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test('work item keys round-trip', () => {
  const key = registry.workItemKey({ kind: 'issue', repo: 'acme/widgets', number: 42 });
  assert.equal(key, 'issue:acme/widgets#42');
  assert.deepEqual(registry.parseWorkItemKey(key), {
    kind: 'issue',
    repo: 'acme/widgets',
    number: 42,
  });
});

test('a malformed key parses to undefined rather than a wrong item', () => {
  for (const bad of ['issue:acme#42', 'issue:acme/widgets', 'wiki:a/b#1', 'issue:a/b#x', '']) {
    assert.equal(registry.parseWorkItemKey(bad), undefined, bad);
  }
});

test('the linking rule gives one session both threads', () => {
  registry.createWorkItem({
    kind: 'issue',
    repo: 'acme/widgets',
    number: 42,
    model: 'claude-opus-5',
    target: 'local',
    branch: 'gquay/issue-42',
    grantedScopes: ['notes:post'],
  });
  registry.setSession('issue:acme/widgets#42', 'sess-abc', 1234);
  registry.update('issue:acme/widgets#42', { worktree: '/w/42', mcp_token: 'tok' });

  const pr = registry.linkPullRequest('issue:acme/widgets#42', {
    kind: 'pr',
    repo: 'acme/widgets',
    number: 87,
  });

  // Same session, same worktree, same branch, same scopes, same MCP bearer.
  assert.equal(pr?.session_id, 'sess-abc');
  assert.equal(pr?.worktree, '/w/42');
  assert.equal(pr?.branch, 'gquay/issue-42');
  assert.equal(pr?.mcp_token, 'tok');
  assert.equal(pr?.linked_key, 'issue:acme/widgets#42');

  // And the pairing is recorded in both directions, so a park on either key
  // drains both threads.
  const issue = registry.getWorkItem('issue:acme/widgets#42');
  assert.equal(issue?.linked_key, 'pr:acme/widgets#87');
  assert.deepEqual(registry.siblingKeys('issue:acme/widgets#42').sort(), [
    'issue:acme/widgets#42',
    'pr:acme/widgets#87',
  ]);
});

test('linking an unknown issue is a no-op, not a phantom row', () => {
  const pr = registry.linkPullRequest('issue:acme/widgets#999', {
    kind: 'pr',
    repo: 'acme/widgets',
    number: 1,
  });
  assert.equal(pr, undefined);
  assert.equal(registry.getWorkItem('pr:acme/widgets#1'), undefined);
});

test('idle and awaiting_input keep separate clocks', () => {
  registry.createWorkItem({
    kind: 'issue', repo: 'a/b', number: 1, model: 'm', target: 'local',
  });
  registry.setState('issue:a/b#1', 'idle');
  let item = registry.getWorkItem('issue:a/b#1')!;
  assert.ok(item.idle_since, 'idle sets its own clock');
  assert.equal(item.awaiting_since, null);

  registry.setState('issue:a/b#1', 'awaiting_input');
  item = registry.getWorkItem('issue:a/b#1')!;
  assert.equal(item.idle_since, null, 'leaving idle clears the idle clock');
  assert.ok(item.awaiting_since);

  // Returning to work clears the escalation clock and its nudge markers, so the
  // next block starts a fresh escalation rather than firing immediately.
  registry.update('issue:a/b#1', { nudged_at: '2026-01-01 00:00:00' });
  registry.setState('issue:a/b#1', 'working');
  item = registry.getWorkItem('issue:a/b#1')!;
  assert.equal(item.awaiting_since, null);
  assert.equal(item.nudged_at, null);
});

test('merge approval expires and is single-use', () => {
  registry.createWorkItem({ kind: 'pr', repo: 'a/b', number: 5, model: 'm', target: 'local' });
  assert.equal(registry.isMergeApproved('pr:a/b#5'), false);

  registry.approveMerge('pr:a/b#5', 'maintainer', 15);
  assert.equal(registry.isMergeApproved('pr:a/b#5'), true);

  registry.consumeMergeApproval('pr:a/b#5');
  assert.equal(registry.isMergeApproved('pr:a/b#5'), false, 'an approval is spent once used');

  // An expired approval is not an approval.
  registry.approveMerge('pr:a/b#5', 'maintainer', -1);
  assert.equal(registry.isMergeApproved('pr:a/b#5'), false);
});

test('unreadable granted_scopes fails closed to no grants', () => {
  registry.createWorkItem({ kind: 'issue', repo: 'a/b', number: 2, model: 'm', target: 'local' });
  registry.update('issue:a/b#2', { granted_scopes: 'not json at all' });
  const item = registry.getWorkItem('issue:a/b#2')!;
  assert.deepEqual(registry.grantedScopes(item), []);
});

test('capacity counting only sees live states', () => {
  for (const [n, state] of [[1, 'working'], [2, 'idle'], [3, 'parked'], [4, 'dead']] as const) {
    registry.createWorkItem({ kind: 'issue', repo: 'a/b', number: n, model: 'm', target: 'local' });
    registry.setState(`issue:a/b#${n}`, state);
  }
  assert.equal(registry.countActiveOnTarget('local'), 2);
  assert.equal(registry.countActiveTotal(), 2);
});
