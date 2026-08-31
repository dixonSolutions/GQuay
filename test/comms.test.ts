/**
 * Comms scopes, rate limits, urgency floors and quiet hours.
 *
 * Every denial has to name a better channel. A refusal the model cannot act on
 * just becomes a retry loop.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, getDb } from '../src/state/db.ts';
import { checkComms, resolveGrants, logComms, quietHoursEnd, hasScope } from '../src/mcp/comms.ts';
import { RepoConfigSchema, parseRateLimit, parseDuration } from '../src/router/repoConfig.ts';

const dir = mkdtempSync(join(tmpdir(), 'gquay-comms-'));
openDb(dir);

const config = RepoConfigSchema.parse({
  channels: {
    activity: { name: '#gquay-activity', attention_cost: 'none', scopes: ['mirror'] },
    notes: { name: '#gquay-notes', attention_cost: 'low', scopes: ['post'], rate_limit: '2/hour' },
    decisions: {
      name: '#gquay-needs-you',
      attention_cost: 'high',
      urgency_floor: 'high',
      scopes: ['post', 'reply', 'ask', 'mention.assignee'],
      rate_limit: '6/hour',
    },
    incidents: {
      name: '#eng-alerts',
      attention_cost: 'critical',
      urgency_floor: 'critical',
      scopes: ['post', 'mention.owner', 'attach', 'override_quiet_hours'],
    },
  },
});

const grants = resolveGrants(config);

beforeEach(() => {
  getDb().exec('DELETE FROM comms_log');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function req(over: Partial<Parameters<typeof checkComms>[0]> = {}) {
  return {
    workItemKey: 'issue:a/b#1',
    channel: 'notes',
    action: 'post' as const,
    urgency: 'normal' as const,
    mentions: [] as ('assignee' | 'owner' | 'channel')[],
    hasAttachment: false,
    isEscalation: false,
    ...over,
  };
}

test('the grant set is flat and derived from the registry', () => {
  assert.ok(grants.includes('activity:mirror'));
  assert.ok(grants.includes('decisions:ask'));
  assert.ok(hasScope(grants, 'notes', 'post'));
  // Nothing anywhere gets mention.channel.
  assert.ok(!grants.some((g) => g.endsWith(':mention.channel')));
});

test('the agent cannot post to a mirror-only channel', () => {
  const d = checkComms(req({ channel: 'activity' }), grants, config);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /activity:post/);
});

test('an unknown channel names what is actually available', () => {
  const d = checkComms(req({ channel: 'random' }), grants, config);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /list_channels/);
});

test('a routine message is refused from a high-urgency channel, with a redirect', () => {
  const d = checkComms(req({ channel: 'decisions', urgency: 'normal' }), grants, config);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /#gquay-notes/, 'points at the cheapest adequate channel');
});

test('a genuinely blocking message reaches the decisions channel', () => {
  assert.equal(checkComms(req({ channel: 'decisions', urgency: 'high' }), grants, config).allowed, true);
});

test('a mention needs its own grant even when posting is allowed', () => {
  const ok = checkComms(req({ channel: 'decisions', urgency: 'high', mentions: ['assignee'] }), grants, config);
  assert.equal(ok.allowed, true);

  const refused = checkComms(req({ channel: 'decisions', urgency: 'high', mentions: ['owner'] }), grants, config);
  assert.equal(refused.allowed, false);
  assert.match(refused.reason ?? '', /mention/);
});

test('rate limits count only allowed posts, and the reason offers an alternative', () => {
  logComms('issue:a/b#1', 'notes', 'post', true);
  logComms('issue:a/b#1', 'notes', 'post', false, 'denied earlier');  // must not count
  assert.equal(checkComms(req(), grants, config).allowed, true);

  logComms('issue:a/b#1', 'notes', 'post', true);
  const d = checkComms(req(), grants, config);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /rate limited/);
});

test('attachments need the attach scope', () => {
  const d = checkComms(req({ hasAttachment: true }), grants, config);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /links, not attachments/);
});

// ── Quiet hours ───────────────────────────────────────────────────────────────

test('a window that wraps midnight is handled', () => {
  const spec = '18:00-08:00 UTC';
  // 22:00 UTC is inside the window; it should end at 08:00 the next day.
  const inside = quietHoursEnd(spec, new Date('2026-03-01T22:00:00Z'));
  assert.ok(inside);
  assert.equal(inside.toISOString(), '2026-03-02T08:00:00.000Z');

  // 12:00 UTC is outside.
  assert.equal(quietHoursEnd(spec, new Date('2026-03-01T12:00:00Z')), undefined);
});

test('a same-day window is handled too', () => {
  assert.ok(quietHoursEnd('09:00-17:00 UTC', new Date('2026-03-01T10:00:00Z')));
  assert.equal(quietHoursEnd('09:00-17:00 UTC', new Date('2026-03-01T18:00:00Z')), undefined);
});

test('a malformed quiet-hours spec never blocks a message', () => {
  assert.equal(quietHoursEnd('always', new Date()), undefined);
});

// ── Parsers ───────────────────────────────────────────────────────────────────

test('rate limit specs parse, and garbage returns undefined', () => {
  assert.deepEqual(parseRateLimit('6/hour'), { count: 6, windowMs: 3_600_000 });
  assert.deepEqual(parseRateLimit('2/min'), { count: 2, windowMs: 60_000 });
  assert.deepEqual(parseRateLimit('30/day'), { count: 30, windowMs: 86_400_000 });
  assert.equal(parseRateLimit('lots'), undefined);
  assert.equal(parseRateLimit(undefined), undefined);
});

test('durations parse, and garbage falls back rather than becoming zero', () => {
  assert.equal(parseDuration('20m'), 1_200_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('7d'), 604_800_000);
  assert.equal(parseDuration('soon', 999), 999);
});
