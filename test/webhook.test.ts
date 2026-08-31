/**
 * Ingress: signature verification, event normalisation, and the loop guard.
 *
 * The signature test matters most. It is the only thing standing between a
 * public endpoint and an agent holding a GitHub App token, and both of its
 * failure modes — HMAC over re-serialised JSON, and a variable-time compare —
 * look like working code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, readHeaders } from '../src/github/webhook.ts';
import { normalise } from '../src/github/events.ts';

const SECRET = 'test-secret';

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

test('accepts a correctly signed body', () => {
  const body = Buffer.from('{"action":"opened"}');
  assert.equal(verifySignature(body, sign(body), SECRET).valid, true);
});

test('rejects a tampered body', () => {
  const body = Buffer.from('{"action":"opened"}');
  const signature = sign(body);
  const tampered = Buffer.from('{"action":"closed"}');
  assert.equal(verifySignature(tampered, signature, SECRET).valid, false);
});

test('rejects a missing or malformed signature without throwing', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, undefined, SECRET).valid, false);
  assert.equal(verifySignature(body, 'sha1=deadbeef', SECRET).valid, false);
  // A length mismatch must not throw out of timingSafeEqual.
  assert.equal(verifySignature(body, 'sha256=short', SECRET).valid, false);
});

test('signature is byte-exact — re-serialised JSON does not verify', () => {
  const original = Buffer.from('{"a":1,   "b":2}');
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(original.toString())));
  assert.equal(verifySignature(reserialised, sign(original), SECRET).valid, false);
});

test('reads delivery headers case-insensitively', () => {
  const h = readHeaders({
    'x-github-delivery': 'abc-123',
    'x-github-event': 'issues',
    'x-hub-signature-256': 'sha256=x',
  });
  assert.equal(h.deliveryId, 'abc-123');
  assert.equal(h.event, 'issues');
});

// ── Normalisation ─────────────────────────────────────────────────────────────

const repo = { full_name: 'acme/widgets' };

test('issues.opened yields an issue work item and its labels', () => {
  const e = normalise('issues', {
    action: 'opened',
    repository: repo,
    sender: { login: 'alice', type: 'User' },
    issue: { number: 42, title: 'Broken login', body: 'It fails', html_url: 'u', labels: [{ name: 'gquay' }] },
  });
  assert.equal(e.kind, 'issue.opened');
  assert.deepEqual(e.ref, { kind: 'issue', repo: 'acme/widgets', number: 42 });
  assert.deepEqual(e.labels, ['gquay']);
  assert.equal(e.actorIsBot, false);
});

test('the bot guard catches both App senders and [bot] suffixes', () => {
  const app = normalise('issue_comment', {
    action: 'created',
    repository: repo,
    sender: { login: 'gquay', type: 'Bot' },
    issue: { number: 1 },
    comment: { body: 'done' },
  });
  assert.equal(app.actorIsBot, true);

  const suffixed = normalise('issue_comment', {
    action: 'created',
    repository: repo,
    sender: { login: 'dependabot[bot]', type: 'User' },
    issue: { number: 1 },
    comment: { body: 'bump' },
  });
  assert.equal(suffixed.actorIsBot, true);
});

test('a PR conversation comment is distinguished from an issue comment', () => {
  const onIssue = normalise('issue_comment', {
    action: 'created',
    repository: repo,
    sender: { login: 'alice', type: 'User' },
    issue: { number: 7 },
    comment: { body: 'hi', author_association: 'MEMBER' },
  });
  assert.equal(onIssue.kind, 'issue.comment');
  assert.equal(onIssue.ref?.kind, 'issue');

  // The `pull_request` key on the issue is the only thing that tells them apart.
  const onPr = normalise('issue_comment', {
    action: 'created',
    repository: repo,
    sender: { login: 'alice', type: 'User' },
    issue: { number: 7, pull_request: { url: 'x' } },
    comment: { body: 'hi' },
  });
  assert.equal(onPr.kind, 'pr.comment');
  assert.equal(onPr.ref?.kind, 'pr');
});

test('a merged pull_request.closed is distinct from an abandoned one', () => {
  const merged = normalise('pull_request', {
    action: 'closed',
    repository: repo,
    sender: { login: 'alice', type: 'User' },
    pull_request: { number: 9, merged: true, head: { ref: 'gquay/issue-1' }, base: { ref: 'main' } },
  });
  assert.equal(merged.kind, 'pr.merged');

  const abandoned = normalise('pull_request', {
    action: 'closed',
    repository: repo,
    sender: { login: 'alice', type: 'User' },
    pull_request: { number: 9, merged: false, head: { ref: 'x' }, base: { ref: 'main' } },
  });
  assert.equal(abandoned.kind, 'pr.closed');
});

test('a push reports changed paths so gquay.yml can be invalidated', () => {
  const e = normalise('push', {
    repository: repo,
    sender: { login: 'alice', type: 'User' },
    ref: 'refs/heads/main',
    commits: [{ added: ['a.ts'], modified: ['.github/gquay.yml'], removed: [] }],
  });
  assert.equal(e.kind, 'push');
  assert.ok(e.changedPaths.includes('.github/gquay.yml'));
});

test('an unrecognised event degrades to unhandled rather than throwing', () => {
  const e = normalise('gollum', { repository: repo, sender: { login: 'a', type: 'User' } });
  assert.equal(e.kind, 'unhandled');
  assert.equal(e.ref, undefined);
});
