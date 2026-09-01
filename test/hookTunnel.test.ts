/**
 * The hook tunnel — what makes hooks work on a dispatch worker at all.
 *
 * A worker previously spawned sessions with no `--settings`, so no hook ever
 * fired there: no Stop-hook park, no merge gate, no linking rule. The tunnel is
 * the piece that lets the loopback-only Hook Bus serve a session on another
 * machine, so the properties worth testing are the ones a missing tunnel would
 * quietly cost: that identity comes from the bearer rather than a header the
 * agent controls, that only the hook surface is reachable, and that a dead
 * Router fails the call rather than hanging it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { HookTunnel } from '../src/hooks/tunnel.ts';
import type { HookFrame } from '../src/hooks/tunnel.ts';

const sent: HookFrame[] = [];
const tunnel = new HookTunnel((frame) => {
  sent.push(frame);
  // Answer immediately, as the Router would.
  tunnel.settle({
    id: frame.id,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, saw: frame.work_item }),
  });
});

const origin = await tunnel.start();
tunnel.setConnected(true);

after(async () => {
  await tunnel.stop();
});

function post(path: string, token?: string, body = '{}'): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

test('a registered session reaches the bus, and the work item comes from its token', async () => {
  const token = tunnel.register('issue:acme/widgets#42');
  sent.length = 0;

  const res = await post('/hooks/session-start', token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, saw: 'issue:acme/widgets#42' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.path, '/hooks/session-start');
});

test('the X-GQuay-Work-Item header cannot override the token', async () => {
  const token = tunnel.register('issue:acme/widgets#7');
  sent.length = 0;

  // A session on a busy worker claiming to be a different one. The header is
  // simply not read — the frame carries the token's work item.
  const res = await fetch(`${origin}/hooks/merge-gate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-gquay-work-item': 'pr:acme/widgets#999',
    },
    body: '{}',
  });

  assert.equal(res.status, 200);
  assert.equal(sent[0]?.work_item, 'issue:acme/widgets#7');
});

test('an unknown or missing bearer is refused', async () => {
  assert.equal((await post('/hooks/session-start')).status, 401);
  assert.equal((await post('/hooks/session-start', 'not-a-real-token')).status, 401);
});

test('only the hook surface is forwarded', async () => {
  const token = tunnel.register('issue:acme/widgets#1');
  sent.length = 0;

  // The agent chooses the hook URL, so a tunnel that forwarded anything would
  // hand a session the Router's whole loopback API.
  for (const path of ['/gquay/status', '/hooks/../gquay/status', '/healthz']) {
    assert.equal((await post(path, token)).status, 404, path);
  }
  assert.equal(sent.length, 0);
});

test('a released session loses its credential', async () => {
  const token = tunnel.register('issue:acme/widgets#5');
  assert.equal((await post('/hooks/session-end', token)).status, 200);

  tunnel.release('issue:acme/widgets#5');
  assert.equal((await post('/hooks/session-end', token)).status, 401);
});

test('a hook raised while the connection is down fails fast', async () => {
  // A PreToolUse hook holds a tool call open. If the socket is already gone the
  // answer is never coming, so waiting out the 30s round-trip ceiling would
  // stall the agent for half a minute to learn nothing.
  const down = new HookTunnel(() => {
    assert.fail('nothing should be sent while disconnected');
  });
  const downOrigin = await down.start();
  const token = down.register('issue:acme/widgets#3');

  const started = Date.now();
  const res = await fetch(`${downOrigin}/hooks/merge-gate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{}',
  });

  assert.equal(res.status, 502);
  assert.ok(Date.now() - started < 5_000, 'refused immediately, not after the ceiling');
  await down.stop();
});

test('a connection that drops mid-hook fails what is in flight', async () => {
  let inFlight: (() => void) | undefined;
  const dropped = new HookTunnel(() => {
    // Stand in for a Router that goes away after receiving the frame.
    inFlight?.();
  });
  const droppedOrigin = await dropped.start();
  dropped.setConnected(true);
  const token = dropped.register('issue:acme/widgets#4');

  inFlight = () => dropped.setConnected(false);
  const res = await fetch(`${droppedOrigin}/hooks/merge-gate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{}',
  });

  assert.equal(res.status, 502);
  await dropped.stop();
});
