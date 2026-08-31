/**
 * The parking lot — the mechanism the whole design turns on.
 *
 * The race in the third test is the one that actually bites: an event that
 * arrives between a webhook handler's enqueue and the tool call's registration
 * would be lost if the call parked on an empty promise instead of draining the
 * queue first.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, getDb } from '../src/state/db.ts';
import { enqueue, drain, pendingCount } from '../src/state/events.ts';
import { ParkingLot } from '../src/mcp/parking.ts';
import type { DeliveredEvent } from '../src/state/events.ts';

const dir = mkdtempSync(join(tmpdir(), 'gquay-park-'));
openDb(dir);

beforeEach(() => {
  getDb().exec('DELETE FROM events');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function ev(key: string, body: string): DeliveredEvent {
  return { kind: 'comment', work_item: key, body, received_at: new Date().toISOString() };
}

test('a queued event returns immediately without parking', async () => {
  const lot = new ParkingLot();
  enqueue('issue:a/b#1', 'comment', ev('issue:a/b#1', 'already here'));

  const result = await lot.park({ keys: ['issue:a/b#1'], timeoutMs: 5_000 });
  assert.equal(result.events.length, 1);
  assert.equal(result.idle_ms, 0);
  assert.equal(result.timed_out, false);
});

test('a parked call resolves when an event is notified', async () => {
  const lot = new ParkingLot();
  const parked = lot.park({ keys: ['issue:a/b#2'], timeoutMs: 5_000 });

  setTimeout(() => {
    enqueue('issue:a/b#2', 'comment', ev('issue:a/b#2', 'late arrival'));
    lot.notify('issue:a/b#2');
  }, 20);

  const result = await parked;
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.body, 'late arrival');
  assert.ok(result.idle_ms >= 0);
});

test('an event that lands before the call registers is not lost', async () => {
  const lot = new ParkingLot();
  // Enqueue and notify with nobody parked — the classic lost-wakeup race.
  enqueue('issue:a/b#3', 'comment', ev('issue:a/b#3', 'raced'));
  assert.equal(lot.notify('issue:a/b#3'), 0);

  // The call must still find it, because the queue is the source of truth and
  // notify() is only the doorbell.
  const result = await lot.park({ keys: ['issue:a/b#3'], timeoutMs: 1_000 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.body, 'raced');
});

test('an event is delivered exactly once across two parked calls', async () => {
  const lot = new ParkingLot();
  const a = lot.park({ keys: ['issue:a/b#4'], timeoutMs: 2_000 });
  const b = lot.park({ keys: ['issue:a/b#4'], timeoutMs: 2_000 });

  enqueue('issue:a/b#4', 'comment', ev('issue:a/b#4', 'only once'));
  lot.notify('issue:a/b#4');

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.events.length + rb.events.length, 1);
});

test('a park times out and reports how long it waited', async () => {
  const lot = new ParkingLot();
  const result = await lot.park({ keys: ['issue:a/b#5'], timeoutMs: 60 });
  assert.equal(result.timed_out, true);
  assert.equal(result.events.length, 0);
  assert.ok(result.idle_ms >= 50, `idle_ms was ${result.idle_ms}`);
});

test('a call drains both an issue and its linked PR', async () => {
  const lot = new ParkingLot();
  const parked = lot.park({ keys: ['issue:a/b#6', 'pr:a/b#7'], timeoutMs: 2_000 });

  // A review lands on the PR while the agent waits on the issue. One session
  // owns both, so the call must see it.
  enqueue('pr:a/b#7', 'review', { ...ev('pr:a/b#7', 'LGTM'), kind: 'review' });
  lot.notify('pr:a/b#7');

  const result = await parked;
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.kind, 'review');
});

test('an aborted tool call releases its waiter instead of leaking it', async () => {
  const lot = new ParkingLot();
  const controller = new AbortController();
  const parked = lot.park({
    keys: ['issue:a/b#8'],
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  assert.equal(lot.size, 1);

  controller.abort();
  const result = await parked;
  assert.equal(result.events.length, 0);
  assert.equal(lot.size, 0);
});

test('releaseAll settles every parked call on shutdown', async () => {
  const lot = new ParkingLot();
  const calls = [
    lot.park({ keys: ['issue:a/b#9'], timeoutMs: 60_000 }),
    lot.park({ keys: ['issue:a/b#10'], timeoutMs: 60_000 }),
  ];
  assert.equal(lot.size, 2);

  lot.releaseAll('test shutdown');
  const results = await Promise.all(calls);
  assert.equal(results.length, 2);
  assert.equal(lot.size, 0);
});

test('drain marks events delivered so they are not replayed', () => {
  enqueue('issue:a/b#11', 'comment', ev('issue:a/b#11', 'once'));
  assert.equal(pendingCount(['issue:a/b#11']), 1);
  assert.equal(drain(['issue:a/b#11']).length, 1);
  assert.equal(pendingCount(['issue:a/b#11']), 0);
  assert.equal(drain(['issue:a/b#11']).length, 0);
});
