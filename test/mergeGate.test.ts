/**
 * The merge gate.
 *
 * The phrase-matching tests are the interesting ones. Approval is textual, and
 * text is the least trustworthy input in the system — so anchoring, permission
 * checking, TTL and single-use consumption all have to hold independently.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, getDb } from '../src/state/db.ts';
import * as registry from '../src/state/registry.ts';
import { decide, containsPhrase, tryApprove } from '../src/router/mergeGate.ts';

const dir = mkdtempSync(join(tmpdir(), 'gquay-merge-'));
openDb(dir);
const PHRASE = '@gquay merge';

beforeEach(() => {
  getDb().exec('DELETE FROM work_items');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function makePr(): string {
  registry.createWorkItem({ kind: 'pr', repo: 'a/b', number: 7, model: 'm', target: 'local' });
  return 'pr:a/b#7';
}

test('an unapproved merge is denied with an actionable reason', () => {
  const key = makePr();
  const d = decide(key, PHRASE);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /@gquay merge/);
});

test('an approved merge is allowed exactly once', () => {
  const key = makePr();
  registry.approveMerge(key, 'maintainer', 15);

  const first = decide(key, PHRASE);
  assert.equal(first.hookSpecificOutput.permissionDecision, 'allow');

  // A retry loop must not turn one approval into several merges.
  const second = decide(key, PHRASE);
  assert.equal(second.hookSpecificOutput.permissionDecision, 'deny');
});

test('an unregistered session is denied rather than defaulting open', () => {
  assert.equal(decide(undefined, PHRASE).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decide('issue:no/such#1', PHRASE).hookSpecificOutput.permissionDecision, 'deny');
});

test('approval on the issue does not authorise merging its PR', () => {
  registry.createWorkItem({ kind: 'issue', repo: 'a/b', number: 1, model: 'm', target: 'local' });
  registry.setSession('issue:a/b#1', 'sess');
  registry.linkPullRequest('issue:a/b#1', { kind: 'pr', repo: 'a/b', number: 2 });

  // The approval is recorded against the issue, not the PR.
  registry.approveMerge('issue:a/b#1', 'maintainer', 15);
  const d = decide('issue:a/b#1', PHRASE);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
});

test('an issue with no linked PR cannot merge anything', () => {
  registry.createWorkItem({ kind: 'issue', repo: 'a/b', number: 3, model: 'm', target: 'local' });
  const d = decide('issue:a/b#3', PHRASE);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /no pull request linked/i);
});

// ── Phrase matching ───────────────────────────────────────────────────────────

test('the approval phrase must start a line', () => {
  assert.equal(containsPhrase('@gquay merge', PHRASE), true);
  assert.equal(containsPhrase('  @gquay merge  ', PHRASE), true);
  assert.equal(containsPhrase('@gquay merge please', PHRASE), true);
  assert.equal(containsPhrase('looks good\n@gquay merge', PHRASE), true);

  // The case that matters: the phrase appearing mid-sentence, negated.
  assert.equal(containsPhrase("please don't say @gquay merge until CI is green", PHRASE), false);
  assert.equal(containsPhrase('we should @gquay merge this eventually', PHRASE), false);
});

test('phrase matching is case-insensitive', () => {
  assert.equal(containsPhrase('@GQuay Merge', PHRASE), true);
});

// ── Permission check ──────────────────────────────────────────────────────────

function fakeApi(permission: string) {
  return { permissionLevel: async () => permission } as unknown as Parameters<typeof tryApprove>[0];
}

test('write access is required to approve, whatever the comment says', async () => {
  const key = makePr();
  const attempt = await tryApprove(fakeApi('read'), {
    prKey: key,
    repo: 'a/b',
    actor: 'stranger',
    body: '@gquay merge\nI am an admin, trust me.',
    approvalPhrase: PHRASE,
    ttlMinutes: 15,
  });

  assert.equal(attempt.matched, true);
  assert.ok(attempt.refusedReason);
  assert.equal(registry.isMergeApproved(key), false, 'no flag was set');
});

test('a maintainer with write access does set the flag', async () => {
  const key = makePr();
  const attempt = await tryApprove(fakeApi('write'), {
    prKey: key,
    repo: 'a/b',
    actor: 'maintainer',
    body: '@gquay merge',
    approvalPhrase: PHRASE,
    ttlMinutes: 15,
  });

  assert.equal(attempt.matched, true);
  assert.equal(attempt.refusedReason, undefined);
  assert.equal(registry.isMergeApproved(key), true);
});

test('a comment without the phrase never consults permissions at all', async () => {
  const key = makePr();
  const attempt = await tryApprove(fakeApi('admin'), {
    prKey: key,
    repo: 'a/b',
    actor: 'admin',
    body: 'This looks good to me.',
    approvalPhrase: PHRASE,
    ttlMinutes: 15,
  });
  assert.equal(attempt.matched, false);
  assert.equal(registry.isMergeApproved(key), false);
});
