/**
 * The comms channel registry, scope vocabulary, and the ceiling that enforces it.
 *
 * The agent chooses the channel. That is deliberate — a generic
 * `send_channel_message(teamId, channelId, body)` means the model juggles GUIDs,
 * can post anywhere in the tenant, and has no idea which channel is appropriate.
 * Instead each channel carries a name, a description written for the *reader's
 * obligation*, an attention cost, and a set of granted scopes. The agent picks
 * from a menu of things it can actually do.
 *
 * Scopes read like Entra/Graph scopes on purpose — `<channel>:<capability>` —
 * because that is the mental model whoever administers this already has.
 *
 * The registry is guidance. This module is the floor. Scope checks live in the
 * `PreToolUse` hook rather than inside the comms server for the same reason the
 * merge gate does: `PreToolUse` fires *before* any permission-mode check, so a
 * deny holds even under `bypassPermissions`. A hook deny is also visible to the
 * model as feedback, so it re-routes; a silent server-side drop teaches it
 * nothing.
 */

import { getDb, now } from '../state/db.js';
import { childLogger } from '../log.js';
import { parseRateLimit } from '../router/repoConfig.js';
import type { ChannelConfig, RepoConfig } from '../router/repoConfig.js';

const log = childLogger('comms');

// ── Scope vocabulary ──────────────────────────────────────────────────────────

export const CAPABILITIES = [
  'mirror', // Hook Bus may post here; the agent may not
  'post', // start a new thread of its own accord
  'reply', // reply within a thread it owns
  'ask', // post a blocking question, register awaiting_input
  'read', // read the channel back (only if two-way is wired)
  'mention.assignee',
  'mention.owner',
  'mention.channel', // grant almost nowhere
  'attach', // include diffs, logs, files rather than links
  'escalate', // re-post an unanswered item after the idle threshold
  'override_quiet_hours',
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CommsAction = 'post' | 'reply' | 'ask';

export function scopeString(channel: string, capability: Capability): string {
  return `${channel}:${capability}`;
}

/** `activity:mirror` → { channel: 'activity', capability: 'mirror' } */
export function parseScope(scope: string): { channel: string; capability: string } | undefined {
  const idx = scope.indexOf(':');
  if (idx <= 0) return undefined;
  return { channel: scope.slice(0, idx), capability: scope.slice(idx + 1) };
}

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function hasScope(granted: string[], channel: string, capability: Capability): boolean {
  return granted.includes(scopeString(channel, capability));
}

/**
 * Resolve a session's flat grant set from the channel registry plus any
 * repo-level `scopes:` list. Resolution order is
 *   org defaults -> repo gquay.yml -> label overrides -> run mode,
 * and it happens once at spawn (see router/spawn.ts), so the transcript records
 * exactly what the agent was allowed to say and where.
 */
export function resolveGrants(config: RepoConfig): string[] {
  const grants = new Set<string>(config.scopes);
  for (const [key, channel] of Object.entries(config.channels)) {
    for (const cap of channel.scopes) {
      // Registry scopes are free-form strings in YAML; an unknown capability is
      // a typo, and a typo that silently becomes a grant is a security bug.
      if (!isCapability(cap)) {
        log.warn({ channel: key, cap }, 'unknown capability in channel registry — ignored');
        continue;
      }
      grants.add(scopeString(key, cap));
    }
  }
  return [...grants].sort();
}

// ── Urgency ───────────────────────────────────────────────────────────────────

export type Urgency = 'low' | 'normal' | 'high' | 'critical';

const URGENCY_ORDER: Record<Urgency, number> = { low: 0, normal: 1, high: 2, critical: 3 };

// ── The ceiling ───────────────────────────────────────────────────────────────

export interface CommsRequest {
  workItemKey: string;
  channel: string;
  action: CommsAction;
  urgency: Urgency;
  mentions: ('assignee' | 'owner' | 'channel')[];
  hasAttachment: boolean;
  /** True when the agent is re-posting an unanswered item. */
  isEscalation: boolean;
}

export interface CommsDecision {
  allowed: boolean;
  /** Names the better channel when refusing, so the model re-routes. */
  reason?: string;
  /** Set when a message is held until quiet hours end rather than refused. */
  deferUntil?: Date;
}

export function checkComms(
  req: CommsRequest,
  granted: string[],
  config: RepoConfig,
): CommsDecision {
  const channel = config.channels[req.channel];
  if (!channel) {
    const known = Object.keys(config.channels);
    return {
      allowed: false,
      reason:
        `There is no channel "${req.channel}". Call list_channels first — ` +
        (known.length ? `you have access to: ${known.join(', ')}.` : 'you have no channels granted.'),
    };
  }

  // 1. Scope
  const needed: Capability = req.action;
  if (!hasScope(granted, req.channel, needed)) {
    return {
      allowed: false,
      reason:
        `You do not hold ${scopeString(req.channel, needed)}. ` +
        suggestAlternative(req, config, granted),
    };
  }

  // 2. Mentions — each needs its own grant. `mention.channel` is granted almost
  //    nowhere, and this is the check that makes that mean something.
  for (const m of req.mentions) {
    const cap = `mention.${m}` as Capability;
    if (!hasScope(granted, req.channel, cap)) {
      return {
        allowed: false,
        reason: `You may post to #${channel.name} but not @-mention ${m} there (missing ${scopeString(req.channel, cap)}). Post without the mention.`,
      };
    }
  }

  // 3. Attachments
  if (req.hasAttachment && !hasScope(granted, req.channel, 'attach')) {
    return {
      allowed: false,
      reason: `#${channel.name} takes links, not attachments. Link to the GitHub thread instead.`,
    };
  }

  // 4. Escalation
  if (req.isEscalation && !hasScope(granted, req.channel, 'escalate')) {
    return {
      allowed: false,
      reason: `You cannot re-post unanswered items to #${channel.name}. Wait for a reply on the GitHub thread.`,
    };
  }

  // 5. Urgency floor — stops a routine note landing in an alert channel.
  if (URGENCY_ORDER[req.urgency] < URGENCY_ORDER[channel.urgency_floor]) {
    return {
      allowed: false,
      reason:
        `#${channel.name} is for ${channel.urgency_floor}-and-above messages; this one is ${req.urgency}. ` +
        suggestAlternative(req, config, granted),
    };
  }

  // 6. Rate limit
  const limit = parseRateLimit(channel.rate_limit);
  if (limit) {
    const used = countRecent(req.channel, limit.windowMs);
    if (used >= limit.count) {
      return {
        allowed: false,
        reason:
          `#${channel.name} is rate limited to ${channel.rate_limit} and you have used ${used}. ` +
          `Hold this until the window resets, or say it on the GitHub thread instead.`,
      };
    }
  }

  // 7. Quiet hours — defer rather than refuse, so nothing is silently lost.
  if (channel.quiet_hours && !hasScope(granted, req.channel, 'override_quiet_hours')) {
    const until = quietHoursEnd(channel.quiet_hours, new Date());
    if (until) {
      return {
        allowed: false,
        deferUntil: until,
        reason: `#${channel.name} is in quiet hours until ${until.toISOString()}. Held; it will post then.`,
      };
    }
  }

  return { allowed: true };
}

/** Point at the cheapest adequate channel the session can actually reach. */
function suggestAlternative(req: CommsRequest, config: RepoConfig, granted: string[]): string {
  const ranked = Object.entries(config.channels)
    .filter(([key]) => key !== req.channel && hasScope(granted, key, 'post'))
    .filter(([, ch]) => URGENCY_ORDER[req.urgency] >= URGENCY_ORDER[ch.urgency_floor])
    .sort((a, b) => attentionRank(a[1]) - attentionRank(b[1]));

  const best = ranked[0];
  if (!best) return 'Say nothing — silence is the correct default and costs you nothing.';
  return `Post it to #${best[1].name} instead.`;
}

function attentionRank(ch: ChannelConfig): number {
  return { none: 0, low: 1, high: 2, critical: 3 }[ch.attention_cost];
}

function countRecent(channel: string, windowMs: number): number {
  const since = new Date(Date.now() - windowMs).toISOString().replace('T', ' ').slice(0, 19);
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS n FROM comms_log WHERE channel = ? AND allowed = 1 AND created_at >= ?',
    )
    .get(channel, since) as { n: number };
  return row.n;
}

export function remainingBudget(channel: string, spec: string | undefined): number | null {
  const limit = parseRateLimit(spec);
  if (!limit) return null;
  return Math.max(0, limit.count - countRecent(channel, limit.windowMs));
}

/** Every attempt is logged, allowed or not — "why did the agent go quiet" must be answerable. */
export function logComms(
  workItemKey: string | null,
  channel: string,
  action: CommsAction,
  allowed: boolean,
  reason?: string,
  threadRef?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO comms_log (work_item_key, channel, action, allowed, reason, thread_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(workItemKey, channel, action, allowed ? 1 : 0, reason ?? null, threadRef ?? null, now());
  if (!allowed) log.info({ workItemKey, channel, action, reason }, 'comms denied');
}

// ── Quiet hours ───────────────────────────────────────────────────────────────

/**
 * Parse `"18:00-08:00 Australia/Sydney"` and, if `at` falls inside the window,
 * return when it ends. Returns undefined when the window is not active.
 *
 * Windows that wrap midnight are the normal case here, so the comparison is
 * written to handle start > end rather than assuming a same-day range.
 */
export function quietHoursEnd(spec: string, at: Date): Date | undefined {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?:\s+(\S+))?$/.exec(spec.trim());
  if (!m) return undefined;

  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  const tz = m[5];

  const local = tz ? zonedParts(at, tz) : { hour: at.getHours(), minute: at.getMinutes() };
  const nowMin = local.hour * 60 + local.minute;

  const wraps = startMin > endMin;
  const inside = wraps ? nowMin >= startMin || nowMin < endMin : nowMin >= startMin && nowMin < endMin;
  if (!inside) return undefined;

  const minutesUntilEnd = nowMin < endMin ? endMin - nowMin : 24 * 60 - nowMin + endMin;
  return new Date(at.getTime() + minutesUntilEnd * 60_000);
}

function zonedParts(at: Date, timeZone: string): { hour: number; minute: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return { hour, minute };
  } catch {
    // An unknown zone must not silently become "quiet hours never apply".
    log.warn({ timeZone }, 'unknown time zone in quiet_hours — falling back to server local time');
    return { hour: at.getHours(), minute: at.getMinutes() };
  }
}

// ── Open questions ────────────────────────────────────────────────────────────

/**
 * `ask` is asynchronous. It posts the question, flips the work item to
 * `awaiting_input`, starts the idle clock, and returns a ticket — not a reply.
 * If the model believes `ask` returns an answer it will block on it and burn a
 * turn finding out otherwise, which is why the tool description says so in as
 * many words.
 */
export function recordQuestion(
  ticketId: string,
  workItemKey: string,
  channel: string,
  question: string,
  options?: string[],
): void {
  getDb()
    .prepare(
      `INSERT INTO questions (ticket_id, work_item_key, channel, question, options)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ticketId, workItemKey, channel, question, options ? JSON.stringify(options) : null);
}

export function answerQuestion(workItemKey: string, answer: string, by: string): number {
  const info = getDb()
    .prepare(
      `UPDATE questions SET answered_at = ?, answer = ?, answered_by = ?
       WHERE work_item_key = ? AND answered_at IS NULL`,
    )
    .run(now(), answer, by, workItemKey);
  return info.changes;
}

export function openQuestions(workItemKey: string): { ticket_id: string; question: string }[] {
  return getDb()
    .prepare(
      'SELECT ticket_id, question FROM questions WHERE work_item_key = ? AND answered_at IS NULL',
    )
    .all(workItemKey) as { ticket_id: string; question: string }[];
}
