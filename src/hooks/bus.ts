/**
 * The GQuay Hook Bus.
 *
 * Claude Code hooks fire on the agent's own lifecycle and reach this listener
 * over loopback HTTP. It is a separate Fastify instance from the ingress for
 * one reason: hook responses are latency-sensitive because they block tool
 * calls, and a merge gate must never queue behind a GitHub webhook retry storm.
 *
 * Identity comes from the `X-GQuay-Work-Item` header, which the Router renders
 * into each session's generated `settings.json`. It is not taken from the hook
 * payload — a session cannot claim to be a different work item than the one it
 * was spawned for.
 *
 * Two response shapes matter:
 *   - `PreToolUse` returns a `permissionDecision`. Deny holds even under
 *     `bypassPermissions`, because PreToolUse fires before any permission-mode
 *     check. Hooks can tighten policy past what permissions allow and can never
 *     weaken it.
 *   - `SessionStart` returns `additionalContext`, one of the few places where
 *     hook output is injected straight into the model's context.
 */

import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { childLogger } from '../log.js';
import type { Router } from '../router/router.js';
import { decide as decideMerge } from '../router/mergeGate.js';
import { checkComms, logComms, resolveGrants } from '../mcp/comms.js';
import type { CommsAction, Urgency } from '../mcp/comms.js';
import { readLocks, describeLock, findConflicts } from '../mcp/locks.js';
import * as registry from '../state/registry.js';
import { openQuestions } from '../mcp/comms.js';
import { matchGlob } from '../runners/index.js';

const log = childLogger('hook-bus');

/** The subset of the hook payload this service reads. */
interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  message?: string;
  source?: string;
  reason?: string;
  matcher?: string;
}

export interface HookBusOptions {
  router: Router;
  token: string;
  host: string;
  port: number;
}

export function buildHookBus(opts: HookBusOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const { router } = opts;

  // ── Auth ────────────────────────────────────────────────────────────────────

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const header = req.headers['authorization'];
    if (!header || !constantTimeEquals(header, `Bearer ${opts.token}`)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  function workItemOf(req: FastifyRequest): string | undefined {
    const header = req.headers['x-gquay-work-item'];
    return typeof header === 'string' ? header : undefined;
  }

  app.get('/healthz', async () => ({ ok: true, parked: router.parking.size }));

  // ── SessionStart ────────────────────────────────────────────────────────────
  //
  // Fires on `startup` and `resume`. The response's `additionalContext` is
  // injected into the session, so this is where fresh state goes: open
  // questions, what peers claim, and the resolved config the transcript should
  // record. Note this is an `http` hook rather than `mcp_tool` — SessionStart
  // typically fires before MCP servers finish connecting.

  app.post('/hooks/session-start', async (req) => {
    const key = workItemOf(req);
    const body = req.body as HookPayload;
    if (!key) return {};

    const item = registry.getWorkItem(key);
    if (!item) return {};

    if (body.session_id) registry.setSession(key, body.session_id, item.pid ?? undefined);
    registry.setState(key, 'working');

    const lines: string[] = [];
    const questions = openQuestions(key);
    if (questions.length > 0) {
      lines.push(
        `You have ${questions.length} unanswered question(s) outstanding on this work item:`,
        ...questions.map((q) => `  - ${q.question}`),
      );
    }

    const common = await router.lockDirFor(key).catch(() => undefined);
    if (common) {
      const peers = readLocks(common)
        .filter((l) => l.status === 'active' && l.agentId !== key)
        .map(describeLock);
      if (peers.length > 0) {
        lines.push('', 'Other agents currently claim:', ...peers.map((p) => `  - ${p}`));
      }
    }

    const config = await router.repoConfigFor(key).catch(() => undefined);
    if (config) {
      lines.push(
        '',
        `Comms scopes for this session: ${registry.grantedScopes(item).join(' ') || '(none)'}.`,
        `Merge approval: ${item.merge_approved_until ? 'currently granted' : 'not granted'}.`,
      );
    }

    // Post a visible "started" comment on the thread itself. Progress has to be
    // visible in both places — Teams tells you something happened, GitHub is
    // where it happened.
    if (body.source === 'startup') {
      await router.api
        .comment(
          item.repo,
          item.number,
          `🤖 GQuay picked this up — model \`${item.model}\`, branch \`${item.branch}\`.\n\n` +
            `Reply on this thread to talk to the agent.`,
        )
        .catch(() => undefined);
    }

    log.info({ key, source: body.source, sessionId: body.session_id }, 'session start');

    return lines.length > 0
      ? {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: lines.join('\n'),
          },
        }
      : {};
  });

  // ── PostToolUse: mirror GitHub writes ───────────────────────────────────────
  //
  // Also where the linking rule lands. When the session working an issue opens
  // a PR, the new PR key is written with the same session id — one session now
  // owns both threads.

  app.post('/hooks/github-write', async (req) => {
    const key = workItemOf(req);
    const body = req.body as HookPayload;
    if (!key) return {};

    const item = registry.getWorkItem(key);
    if (!item) return {};
    const config = await router.repoConfigFor(key).catch(() => undefined);

    if (body.tool_name?.endsWith('create_pull_request')) {
      const number = extractNumber(body.tool_response);
      if (number !== undefined) {
        const pr = registry.linkPullRequest(key, { kind: 'pr', repo: item.repo, number });
        log.info({ issue: key, pr: pr?.key }, 'linking rule applied');
        if (config) {
          await router.notify(config, 'gquay.opened_pr', {
            title: `Opened PR #${number} for ${key}`,
            summary: 'The same session now owns the issue and the pull request.',
            url: `https://github.com/${item.repo}/pull/${number}`,
            severity: 'success',
          });
        }
      }
    } else if (body.tool_name?.includes('add_issue_comment') && config) {
      await router.notify(config, 'gquay.commented', {
        title: `${key} — agent commented`,
        summary: String(body.tool_input?.['body'] ?? '').slice(0, 300),
        url: `https://github.com/${item.repo}/issues/${item.number}`,
      });
    } else if (body.tool_name?.includes('merge_pull_request') && config) {
      await router.notify(config, 'gquay.merged', {
        title: `${key} merged by the agent`,
        summary: 'The merge gate allowed this — an approval was consumed.',
        severity: 'success',
      });
    }

    registry.touch(key);
    return {};
  });

  // ── PreToolUse: the merge gate (§6) ─────────────────────────────────────────

  app.post('/hooks/merge-gate', async (req) => {
    const key = workItemOf(req);
    const decision = decideMerge(key, router.config.merge.approval_phrase);
    log.warn(
      { key, decision: decision.hookSpecificOutput.permissionDecision },
      'merge gate consulted',
    );
    return decision;
  });

  // ── PreToolUse: comms scopes (§9.6) ─────────────────────────────────────────
  //
  // The scope check lives here rather than inside the comms server because
  // PreToolUse fires before any permission-mode check — the same property that
  // makes the merge gate trustworthy — and because a hook deny is visible to
  // the model as feedback, so it re-routes. A silent server-side drop teaches
  // it nothing.

  app.post('/hooks/comms-gate', async (req) => {
    const key = workItemOf(req);
    const body = req.body as HookPayload;
    if (!key) return allow('no work item bound to this session');

    const item = registry.getWorkItem(key);
    if (!item) return allow('work item not registered');

    const action = commsActionOf(body.tool_name);
    if (!action) return allow('not a comms tool');

    const config = await router.repoConfigFor(key).catch(() => undefined);
    if (!config) return deny('Configuration is unavailable, so comms are refused. Fail closed.');

    const channel = String(body.tool_input?.['channel'] ?? '');
    const urgency = (body.tool_input?.['urgency'] as Urgency) ?? 'normal';
    const mention = body.tool_input?.['mention'] as 'assignee' | 'owner' | undefined;

    const decision = checkComms(
      {
        workItemKey: key,
        channel,
        action,
        urgency,
        mentions: mention ? [mention] : [],
        hasAttachment: Boolean(body.tool_input?.['detail']),
        isEscalation: false,
      },
      registry.grantedScopes(item).length > 0 ? registry.grantedScopes(item) : resolveGrants(config),
      config,
    );

    if (!decision.allowed) {
      logComms(key, channel, action, false, decision.reason);
      return deny(decision.reason ?? 'Refused.');
    }
    return allow('within granted scopes');
  });

  // ── PreToolUse: protected paths and conflict enforcement ────────────────────

  app.post('/hooks/edit-guard', async (req) => {
    const key = workItemOf(req);
    const body = req.body as HookPayload;
    if (!key) return allow('no work item bound');

    const path = String(body.tool_input?.['file_path'] ?? '');
    if (!path) return allow('no path in tool input');

    const config = await router.repoConfigFor(key).catch(() => undefined);
    const item = registry.getWorkItem(key);

    // Repo-declared protected paths win over any lock state.
    const relative = item?.worktree && path.startsWith(item.worktree)
      ? path.slice(item.worktree.length + 1)
      : path;
    for (const pattern of config?.guardrails.protected_paths ?? []) {
      if (matchGlob(pattern, relative) || relative.startsWith(pattern.replace(/\*+$/, ''))) {
        return deny(
          `${relative} is a protected path in this repository's gquay.yml. Propose the change on ` +
            `the issue thread instead of making it.`,
        );
      }
    }

    // agent-locks is advisory by design — right for a general tool, too loose
    // for an unattended pipeline. This is the enforcement layer.
    const common = await router.lockDirFor(key).catch(() => undefined);
    if (!common) return allow('no lock directory');

    const conflicts = findConflicts(readLocks(common), relative, {
      selfAgentId: key,
      normaliseCase: router.config.coordination.normalise_case,
      staleAfterMs: router.config.coordination.stale_lock_after_hours * 3_600_000,
    });
    if (conflicts.length === 0) return allow('no conflicting claim');

    const first = conflicts[0]!;
    return deny(
      `${first.pattern} is claimed by ${first.lock.agentId ?? first.lock.title} ` +
        `(active ${Math.round(first.ageMs / 60_000)}m). Coordinate in the issue thread before editing.`,
    );
  });

  // ── Notification: the agent is blocked on a human ───────────────────────────

  app.post('/hooks/needs-input', async (req) => {
    const key = workItemOf(req);
    const body = req.body as HookPayload;
    if (!key) return {};

    const item = registry.getWorkItem(key);
    if (!item) return {};

    registry.setState(key, 'awaiting_input');
    const config = await router.repoConfigFor(key).catch(() => undefined);
    if (config) {
      await router.notify(config, 'gquay.needs_input', {
        title: `${key} is waiting on you`,
        summary: body.message ?? 'The agent asked a question and stopped.',
        severity: 'attention',
        url: `https://github.com/${item.repo}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`,
      });
    }

    // Post the question on the thread too. A Stop hook cannot collect an answer
    // — the turn is already over — so the answer has to come back in through
    // the delivery path, which means the question has to be somewhere
    // answerable.
    if (body.message) {
      await router.api
        .comment(item.repo, item.number, `❓ **The agent needs input**\n\n${body.message}`)
        .catch(() => undefined);
    }
    log.info({ key }, 'awaiting input');
    return {};
  });

  // ── Stop: turn ended ────────────────────────────────────────────────────────

  app.post('/hooks/turn-end', async (req) => {
    const key = workItemOf(req);
    if (!key) return {};
    const item = registry.getWorkItem(key);
    if (!item || item.state === 'awaiting_input') return {};
    registry.setState(key, 'idle');
    return {};
  });

  // ── StopFailure: rate limits, billing, auth ─────────────────────────────────

  app.post('/hooks/agent-error', async (req) => {
    const key = workItemOf(req);
    const body = req.body as HookPayload;
    if (!key) return {};

    const kind = body.matcher ?? body.reason ?? 'unknown';
    registry.update(key, { error: kind });
    const config = await router.repoConfigFor(key).catch(() => undefined);
    if (config) {
      await router.notify(config, 'gquay.error', {
        title: `${key}: ${kind}`,
        summary: body.message ?? 'The session stopped with an error.',
        severity: 'error',
      });
    }
    log.error({ key, kind }, 'agent error');
    return {};
  });

  // ── SessionEnd ──────────────────────────────────────────────────────────────

  app.post('/hooks/session-end', async (req) => {
    const key = workItemOf(req);
    if (!key) return {};
    const item = registry.getWorkItem(key);
    if (!item) return {};

    // A closed or merged item is done; anything else parks and keeps its
    // session id so the next comment can resume it.
    if (item.state !== 'dead') registry.setState(key, 'parked');
    router.parking.release(key, 'session ended');
    log.info({ key }, 'session ended — parked');
    return {};
  });

  // ── PreCompact: don't lose the brief ────────────────────────────────────────
  //
  // Compaction eventually destroys the oldest context, and the oldest context
  // in one of these sessions is the issue itself. Snapshotting it here and
  // re-injecting on SessionStart is what stops an agent forgetting its task.

  app.post('/hooks/pre-compact', async (req) => {
    const key = workItemOf(req);
    if (!key) return {};
    const item = registry.getWorkItem(key);
    if (!item) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext:
          `Work item brief (preserve across compaction): ${item.key} — ${item.title ?? 'untitled'}. ` +
          `Branch ${item.branch}. Repo ${item.repo}. ` +
          `You own this item until it is closed or merged.`,
      },
    };
  });

  return app;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function allow(reason: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  };
}

function deny(reason: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function commsActionOf(toolName: string | undefined): CommsAction | undefined {
  if (!toolName) return undefined;
  if (toolName.endsWith('__post')) return 'post';
  if (toolName.endsWith('__reply')) return 'reply';
  if (toolName.endsWith('__ask')) return 'ask';
  return undefined;
}

/** Pull a PR number out of a tool response without assuming its exact shape. */
function extractNumber(response: Record<string, unknown> | undefined): number | undefined {
  if (!response) return undefined;
  const direct = response['number'];
  if (typeof direct === 'number') return direct;

  // The GitHub MCP server returns its payload as text content; parse it out.
  const text = JSON.stringify(response);
  const fromJson = /"number"\s*:\s*(\d+)/.exec(text);
  if (fromJson) return Number(fromJson[1]);
  const fromUrl = /\/pull\/(\d+)/.exec(text);
  if (fromUrl) return Number(fromUrl[1]);
  return undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
