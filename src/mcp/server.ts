/**
 * The GQuay MCP server — the Router's agent-facing side.
 *
 * It lives inside the Router process rather than beside it. The parked
 * `await_events` calls have to share the work-item registry and the webhook
 * queue with the part that receives GitHub events; running it as a separate
 * process would mean inventing an IPC layer for no gain.
 *
 * One `McpServer` instance is built per session. Identity comes from the bearer
 * token on the HTTP connection, which the Router minted at spawn and wrote into
 * that session's `mcp.json` — so a tool call cannot claim to be a different work
 * item than the connection it arrived on.
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { childLogger } from '../log.js';
import { GQUAY_INSTRUCTIONS } from './instructions.js';
import { ParkingLot } from './parking.js';
import {
  checkComms,
  logComms,
  recordQuestion,
  remainingBudget,
  hasScope,
  openQuestions,
} from './comms.js';
import type { CommsAction, Urgency } from './comms.js';
import { findConflicts, readLocks, describeLock } from './locks.js';
import { frameEvents } from './framing.js';
import {
  getWorkItem,
  grantedScopes,
  setState,
  siblingKeys,
  touch,
} from '../state/registry.js';
import type { WorkItem } from '../state/registry.js';
import type { RepoConfig } from '../router/repoConfig.js';
import type { TeamsRelay } from '../teams/relay.js';
import type { GitHubApi } from '../github/api.js';

const log = childLogger('mcp');

export interface McpDeps {
  parking: ParkingLot;
  teams: TeamsRelay;
  github: GitHubApi;
  /** Resolved per work item at spawn and cached; see router/spawn.ts. */
  repoConfigFor: (workItemKey: string) => Promise<RepoConfig>;
  /** Git common dir for a work item's worktree, for agent-locks. */
  lockDirFor: (workItemKey: string) => Promise<string | undefined>;
  defaultParkTimeoutMs: number;
  staleLockAfterMs: number;
  normaliseLockCase: boolean;
  /** Router hook — lets the Router record `awaiting_input` and start the clock. */
  onAsk: (item: WorkItem, question: string, options: string[] | undefined) => Promise<void>;
}

const MAX_PARK_SECONDS = 900;

export function buildMcpServer(workItemKey: string, deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'gquay', version: '0.1.0' },
    { instructions: GQUAY_INSTRUCTIONS },
  );

  const requireItem = (): WorkItem => {
    const item = getWorkItem(workItemKey);
    if (!item) throw new Error(`work item ${workItemKey} is no longer registered`);
    return item;
  };

  // ── await_events ────────────────────────────────────────────────────────────

  server.registerTool(
    'await_events',
    {
      title: 'Wait for GitHub activity',
      description:
        'Block until something happens on your work item — a comment, a review, a review ' +
        'comment, or a CI result — and return the events. Costs no tokens while parked. ' +
        'Returns `idle_ms` (how long you waited) and `timed_out` (true when nothing arrived ' +
        'before the timeout). An empty timed-out return is normal and means nobody has ' +
        'replied yet; decide for yourself whether to nudge, summarise, or wind down.',
      inputSchema: {
        timeout_s: z
          .number()
          .int()
          .min(5)
          .max(MAX_PARK_SECONDS)
          .optional()
          .describe('How long to wait. Defaults to the Router\'s configured park window.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ timeout_s }, extra) => {
      const item = requireItem();
      // Drain both threads: an issue and its linked PR share this session, so a
      // call parked on the issue must still see a review landing on the PR.
      const keys = siblingKeys(item.key);
      const timeoutMs = Math.min((timeout_s ?? 0) * 1000 || deps.defaultParkTimeoutMs, MAX_PARK_SECONDS * 1000);

      setState(item.key, 'idle');

      const progressToken = extra._meta?.progressToken;
      const result = await deps.parking.park({
        keys,
        timeoutMs,
        signal: extra.signal,
        // Both ends of an HTTP stream have idle timeouts. A periodic progress
        // notification is what stops a nine-minute park being killed as dead.
        ...(progressToken !== undefined
          ? {
              onHeartbeat: async (elapsedMs: number) => {
                await extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: Math.round(elapsedMs / 1000),
                      total: Math.round(timeoutMs / 1000),
                      message: 'parked — waiting for GitHub',
                    },
                  })
                  .catch(() => undefined);
              },
            }
          : {}),
      });

      if (result.events.length > 0) {
        setState(item.key, 'working');
      } else {
        touch(item.key);
      }

      const framed =
        result.events.length > 0
          ? frameEvents(result.events, { workItem: item.key })
          : `No events arrived in ${Math.round(result.idle_ms / 1000)}s.`;

      return {
        content: [
          { type: 'text' as const, text: framed },
          {
            type: 'text' as const,
            text: JSON.stringify({
              events: result.events,
              idle_ms: result.idle_ms,
              timed_out: result.timed_out,
            }),
          },
        ],
      };
    },
  );

  // ── list_channels ───────────────────────────────────────────────────────────

  server.registerTool(
    'list_channels',
    {
      title: 'List the Teams channels you can post to',
      description:
        'Returns only channels this session holds a scope on, each with what belongs there, ' +
        'what does not, who reads it and how fast, its attention cost, the scopes you hold, ' +
        'and how much of its rate limit is left. Choose the cheapest channel adequate to your ' +
        'message — and if none of them fits, say nothing.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const item = requireItem();
      const config = await deps.repoConfigFor(item.key);
      const granted = grantedScopes(item);

      const channels = Object.entries(config.channels)
        .filter(([key]) =>
          granted.some((g) => g.startsWith(`${key}:`) && !g.endsWith(':mirror')),
        )
        .map(([key, ch]) => ({
          key,
          name: ch.name,
          description: ch.description,
          do_not_use_for: ch.do_not_use_for,
          attention_cost: ch.attention_cost,
          urgency_floor: ch.urgency_floor,
          granted_scopes: granted
            .filter((g) => g.startsWith(`${key}:`))
            .map((g) => g.slice(key.length + 1)),
          rate_limit: ch.rate_limit ?? null,
          rate_limit_remaining: remainingBudget(key, ch.rate_limit),
          quiet_hours: ch.quiet_hours ?? null,
        }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ channels, note: 'Saying nothing is always an option.' }, null, 2),
          },
        ],
      };
    },
  );

  // ── post / reply / ask ──────────────────────────────────────────────────────

  const urgencySchema = z
    .enum(['low', 'normal', 'high', 'critical'])
    .describe('How much attention this deserves. Be honest — the channel has a floor.');

  server.registerTool(
    'post',
    {
      title: 'Start a Teams thread',
      description:
        'Post a new message to one Teams channel. Use the cheapest channel adequate to the ' +
        'message. Always link back to the GitHub thread — that is where people reply.',
      inputSchema: {
        channel: z.string().describe('Channel key from list_channels, e.g. "notes".'),
        summary: z.string().describe('One line. This is what people actually read.'),
        detail: z.string().optional().describe('Optional body. Truncated at 12 KB.'),
        urgency: urgencySchema,
        mention: z
          .enum(['assignee', 'owner'])
          .optional()
          .describe('Requires the matching mention scope on that channel.'),
      },
    },
    async (args) => runComms('post', args),
  );

  server.registerTool(
    'reply',
    {
      title: 'Reply in a Teams thread you own',
      description:
        'Add to a thread this work item already started. Prefer replying over starting a new ' +
        'thread — one root card per work item keeps the channel readable.',
      inputSchema: {
        channel: z.string(),
        body: z.string(),
        urgency: urgencySchema.optional(),
      },
    },
    async (args) =>
      runComms('reply', {
        channel: args.channel,
        summary: args.body,
        urgency: args.urgency ?? 'normal',
      }),
  );

  server.registerTool(
    'ask',
    {
      title: 'Ask a human a blocking question',
      description:
        'Posts your question to a Teams channel, marks this work item as waiting on a human, ' +
        'and returns a ticket id. **It does not return an answer.** Do not block on it. The ' +
        'answer arrives later as an event from await_events, because people reply on the ' +
        'GitHub thread. Include a recommended default so the reader can answer in one word.',
      inputSchema: {
        channel: z.string(),
        question: z.string().describe('End with a question. State your recommended default.'),
        options: z.array(z.string()).optional().describe('Discrete choices, if there are any.'),
      },
    },
    async (args) => {
      const item = requireItem();
      const decision = await guard(item, 'ask', args.channel, 'high', []);
      if (!decision.ok) return decision.result;

      const ticketId = `q-${randomUUID().slice(0, 8)}`;
      recordQuestion(ticketId, item.key, args.channel, args.question, args.options);

      const config = await deps.repoConfigFor(item.key);
      const channel = config.channels[args.channel]!;
      const posted = await deps.teams.post({
        title: `${item.key} needs a decision`,
        severity: 'attention',
        summary: args.question,
        ...(args.options?.length
          ? { detail: `Options:\n${args.options.map((o) => `  • ${o}`).join('\n')}` }
          : {}),
        facts: [
          { name: 'Work item', value: item.key },
          { name: 'Ticket', value: ticketId },
        ],
        actions: [{ title: 'Answer on GitHub', url: threadUrl(item) }],
      });

      logComms(item.key, args.channel, 'ask', true, undefined, ticketId);
      await deps.onAsk(item, args.question, args.options);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ticket_id: ticketId,
              channel: channel.name,
              posted: posted.ok,
              answer: null,
              note:
                'This returned a ticket, not an answer. Carry on with anything that does not ' +
                'depend on the answer; it will reach you through await_events.',
            }),
          },
        ],
      };
    },
  );

  // ── check_conflict ──────────────────────────────────────────────────────────

  server.registerTool(
    'check_conflict',
    {
      title: 'Check whether a path is claimed by another agent',
      description:
        'Reports active work claims from sibling agent sessions that overlap a path. The ' +
        'overlap test is biased toward false positives on purpose — a false positive costs ' +
        'you one check, a false negative hides a real conflict. Also callable as a PreToolUse ' +
        'hook, in which case its output is a permission decision.',
      inputSchema: {
        path: z.string().describe('Repository-relative path you are about to edit.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const item = requireItem();
      const common = await deps.lockDirFor(item.key);
      if (!common) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ conflicts: [], note: 'no lock directory' }) }],
        };
      }

      const conflicts = findConflicts(readLocks(common), path, {
        selfAgentId: item.key,
        normaliseCase: deps.normaliseLockCase,
        staleAfterMs: deps.staleLockAfterMs,
      });

      // Shaped as a PreToolUse decision. An `mcp_tool` hook's output is read the
      // same way command-hook stdout is, so it must be this object and not the
      // raw lock array agent-locks would return.
      if (conflicts.length > 0) {
        const first = conflicts[0]!;
        const minutes = Math.round(first.ageMs / 60_000);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason:
                    `${first.pattern} is claimed by ${first.lock.agentId ?? first.lock.title} ` +
                    `(active ${minutes}m). Coordinate in the issue thread before editing.`,
                },
                conflicts: conflicts.map((c) => ({
                  pattern: c.pattern,
                  claimed_by: c.lock.agentId ?? c.lock.title,
                  title: c.lock.title,
                  age_minutes: Math.round(c.ageMs / 60_000),
                })),
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                permissionDecisionReason: 'No sibling agent has claimed this path.',
              },
              conflicts: [],
            }),
          },
        ],
      };
    },
  );

  // ── work_item_status ────────────────────────────────────────────────────────

  server.registerTool(
    'work_item_status',
    {
      title: 'What am I working on',
      description:
        'Your work item, its linked issue or PR, your branch, your granted comms scopes, any ' +
        'unanswered questions you have asked, and what sibling agents currently claim. Useful ' +
        'after a resume, when your transcript may predate the current state.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const item = requireItem();
      const common = await deps.lockDirFor(item.key);
      const peers = common
        ? readLocks(common)
            .filter((l) => l.status === 'active' && l.agentId !== item.key)
            .map(describeLock)
        : [];

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                work_item: item.key,
                title: item.title,
                state: item.state,
                model: item.model,
                branch: item.branch,
                linked: item.linked_key,
                target: item.target,
                granted_scopes: grantedScopes(item),
                open_questions: openQuestions(item.key),
                merge_approved: Boolean(item.merge_approved_until),
                peer_claims: peers,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── shared comms path ───────────────────────────────────────────────────────

  async function guard(
    item: WorkItem,
    action: CommsAction,
    channel: string,
    urgency: Urgency,
    mentions: ('assignee' | 'owner' | 'channel')[],
  ): Promise<{ ok: true } | { ok: false; result: { content: { type: 'text'; text: string }[] } }> {
    const config = await deps.repoConfigFor(item.key);
    const decision = checkComms(
      {
        workItemKey: item.key,
        channel,
        action,
        urgency,
        mentions,
        hasAttachment: false,
        isEscalation: false,
      },
      grantedScopes(item),
      config,
    );

    if (decision.allowed) return { ok: true };

    logComms(item.key, channel, action, false, decision.reason);
    return {
      ok: false,
      result: {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ posted: false, reason: decision.reason }),
          },
        ],
      },
    };
  }

  async function runComms(
    action: CommsAction,
    args: {
      channel: string;
      summary: string;
      detail?: string;
      urgency: Urgency;
      mention?: 'assignee' | 'owner';
    },
  ): Promise<{ content: { type: 'text'; text: string }[] }> {
    const item = requireItem();
    const mentions = args.mention ? [args.mention] : [];
    const decision = await guard(item, action, args.channel, args.urgency, mentions);
    if (!decision.ok) return decision.result;

    const config = await deps.repoConfigFor(item.key);
    const channel = config.channels[args.channel]!;
    const granted = grantedScopes(item);

    const result = await deps.teams.post({
      title: `${item.key} — ${item.title ?? ''}`.trim(),
      severity: severityFor(args.urgency),
      summary: args.summary,
      ...(args.detail && hasScope(granted, args.channel, 'attach') ? { detail: args.detail } : {}),
      facts: [{ name: 'Work item', value: item.key }],
      actions: [{ title: 'Open on GitHub', url: threadUrl(item) }],
      ...(args.mention && item.owner_login
        ? { mentions: [{ login: item.owner_login }] }
        : {}),
    });

    logComms(item.key, args.channel, action, result.ok, result.error, result.threadRef);
    log.info({ workItem: item.key, channel: channel.name, action, ok: result.ok }, 'comms sent');

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            posted: result.ok,
            channel: channel.name,
            rate_limit_remaining: remainingBudget(args.channel, channel.rate_limit),
            ...(result.error ? { error: result.error } : {}),
          }),
        },
      ],
    };
  }

  return server;
}

function severityFor(urgency: Urgency): 'info' | 'attention' | 'error' {
  return urgency === 'critical' ? 'error' : urgency === 'high' ? 'attention' : 'info';
}

function threadUrl(item: WorkItem): string {
  const path = item.kind === 'pr' ? 'pull' : 'issues';
  return `https://github.com/${item.repo}/${path}/${item.number}`;
}
