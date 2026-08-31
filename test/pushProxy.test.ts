/**
 * The branch-scoped push proxy.
 *
 * pkt-line parsing is fiddly and security-relevant: a push whose refs cannot be
 * read is a push whose refs cannot be checked, so every malformed case here must
 * end in refusal rather than a pass-through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceivePack, authorisePush, proxyRemoteUrl } from '../src/router/pushProxy.ts';
import type { WorkItem } from '../src/state/registry.ts';

/** Frame a payload as a pkt-line, the way git does on the wire. */
function pkt(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, '0') + payload;
}
const FLUSH = '0000';
const ZERO = '0'.repeat(40);
const SHA = 'a'.repeat(40);

test('parses a single ref update with capabilities', () => {
  const body = Buffer.from(
    pkt(`${ZERO} ${SHA} refs/heads/gquay/issue-42\0report-status side-band-64k`) + FLUSH + 'PACK…',
  );
  const parsed = parseReceivePack(body);
  assert.ok(parsed);
  assert.equal(parsed.updates.length, 1);
  assert.equal(parsed.updates[0]?.ref, 'refs/heads/gquay/issue-42');
  assert.equal(parsed.updates[0]?.oldSha, ZERO);
  assert.equal(parsed.updates[0]?.newSha, SHA);
});

test('parses several ref updates in one push', () => {
  const body = Buffer.from(
    pkt(`${ZERO} ${SHA} refs/heads/gquay/issue-42\0report-status`) +
      pkt(`${SHA} ${'b'.repeat(40)} refs/heads/main`) +
      FLUSH,
  );
  const parsed = parseReceivePack(body);
  assert.equal(parsed?.updates.length, 2);
  assert.equal(parsed?.updates[1]?.ref, 'refs/heads/main');
});

test('a malformed preamble is unparseable, never silently empty', () => {
  // Bad length prefix.
  assert.equal(parseReceivePack(Buffer.from('zzzz' + 'junk')), undefined);
  // Length that runs past the end of the buffer.
  assert.equal(parseReceivePack(Buffer.from('00ff' + 'short')), undefined);
  // No flush packet at all.
  assert.equal(parseReceivePack(Buffer.from(pkt(`${ZERO} ${SHA} refs/heads/x`))), undefined);
  // A line that is not a ref update.
  assert.equal(parseReceivePack(Buffer.from(pkt('this is not a ref update') + FLUSH)), undefined);
});

// ── Authorisation ─────────────────────────────────────────────────────────────

const item = { branch: 'gquay/issue-42' } as WorkItem;

test('a push to the work item\'s own branch is allowed', () => {
  const d = authorisePush([{ oldSha: ZERO, newSha: SHA, ref: 'refs/heads/gquay/issue-42' }], item);
  assert.equal(d.allowed, true);
});

test('a push to the default branch is refused', () => {
  const d = authorisePush([{ oldSha: SHA, newSha: SHA, ref: 'refs/heads/main' }], item);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /may only push to refs\/heads\/gquay\/issue-42/);
});

test('one bad ref poisons the whole push', () => {
  // Git applies updates atomically only with --atomic; refusing the request is
  // the only way to be sure `main` is not written.
  const d = authorisePush(
    [
      { oldSha: ZERO, newSha: SHA, ref: 'refs/heads/gquay/issue-42' },
      { oldSha: SHA, newSha: SHA, ref: 'refs/heads/main' },
    ],
    item,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.refused?.length, 1);
});

test('tag and other-namespace pushes are refused', () => {
  for (const ref of ['refs/tags/v1.0.0', 'refs/heads/gquay/issue-43', 'refs/notes/commits']) {
    assert.equal(authorisePush([{ oldSha: ZERO, newSha: SHA, ref }], item).allowed, false, ref);
  }
});

test('an empty update list is refused rather than treated as harmless', () => {
  assert.equal(authorisePush([], item).allowed, false);
});

test('a work item with no branch cannot push at all', () => {
  const d = authorisePush(
    [{ oldSha: ZERO, newSha: SHA, ref: 'refs/heads/anything' }],
    { branch: null } as WorkItem,
  );
  assert.equal(d.allowed, false);
});

test('the proxy remote URL carries the session token and the repo', () => {
  const url = proxyRemoteUrl('https://gquay.example.com/', 'tok-123', 'acme/widgets');
  assert.equal(url, 'https://gquay.example.com/git/tok-123/acme/widgets.git');
});
