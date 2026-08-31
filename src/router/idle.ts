/**
 * The idle supervisor.
 *
 * Most of the idle machinery collapses into `await_events`: the idle clock *is*
 * that call's `timeout_s`, and the `idle_ms` it returns tells the agent how long
 * it has been parked, so "nudge at T1" is something the agent does on a
 * timed-out return rather than a state the Router pushes at it.
 *
 * Two things cannot be delegated that way, and they are all this supervisor does:
 *
 *   - **The awaiting_input escalation clock**, because it has to fire whether or
 *     not the agent is parked. An agent blocked on a human is not going to nudge
 *     anyone on its own behalf.
 *   - **The park/terminate decision**, because a session idle for a day should
 *     stop costing a process.
 *
 * Note the distinction the state machine draws: `idle` means the agent has
 * nothing to do, which is normal and never escalates. `awaiting_input` means it
 * is blocked on a person, and only that one escalates.
 */

import { childLogger } from '../log.js';
import * as registry from '../state/registry.js';
import { toMillis } from '../state/db.js';
import { pruneDelivered } from '../state/events.js';
import { pruneDeliveries } from '../state/deliveries.js';
import { readLocks, findStaleLocks, lockDir } from '../mcp/locks.js';
import type { Router } from './router.js';

const log = childLogger('idle');

export interface IdleSupervisorOptions {
  router: Router;
  /** How often to sweep. A minute is plenty; these are hour-scale thresholds. */
  intervalMs?: number;
}

export class IdleSupervisor {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: IdleSupervisorOptions) {}

  start(): void {
    const every = this.opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err: Error) => log.error({ err: err.message }, 'sweep failed'));
    }, every);
    this.timer.unref?.();
    log.info({ everyMs: every }, 'idle supervisor started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(): Promise<void> {
    const { router } = this.opts;

    for (const item of registry.listWorkItems(['idle', 'awaiting_input', 'working'])) {
      const config = await router.repoConfigFor(item.key).catch(() => undefined);
      if (!config) continue;
      const t = router.idleThresholds(config);

      if (item.state === 'awaiting_input' && item.awaiting_since) {
        await this.escalate(item, t);
        continue;
      }

      if (item.state === 'idle' && item.idle_since) {
        const idleFor = Date.now() - toMillis(item.idle_since);
        // Park to free the slot. The session id is kept, so the next comment
        // resumes the transcript rather than starting over.
        if (idleFor > t.park) {
          log.info({ key: item.key, idleForMinutes: Math.round(idleFor / 60_000) }, 'parking idle session');
          await router.terminate(item.key, 'idle beyond park threshold');
          await router.notify(config, 'gquay.parked', {
            title: `${item.key} parked`,
            summary: `Idle for ${Math.round(idleFor / 3_600_000)}h. It resumes on the next comment.`,
          });
        }
      }
    }

    await this.reapStaleLocks();
    this.prune();
  }

  /**
   * Nudge, then escalate. Both are recorded on the work item so a long wait
   * produces two messages, not one every sweep.
   */
  private async escalate(
    item: registry.WorkItem,
    t: { nudge: number; escalate: number; park: number },
  ): Promise<void> {
    const { router } = this.opts;
    const waiting = Date.now() - toMillis(item.awaiting_since);
    const config = await router.repoConfigFor(item.key).catch(() => undefined);
    if (!config) return;

    const url = `https://github.com/${item.repo}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`;

    if (waiting > t.escalate && !item.escalated_at) {
      registry.update(item.key, { escalated_at: new Date().toISOString() });
      await router.notify(config, 'gquay.idle_nudge', {
        title: `${item.key} has been waiting ${Math.round(waiting / 3_600_000)}h`,
        summary: 'Nobody has answered the agent. Escalating to the assignee.',
        severity: 'warn',
        url,
      });
      log.warn({ key: item.key }, 'escalated');
      return;
    }

    if (waiting > t.nudge && !item.nudged_at) {
      registry.update(item.key, { nudged_at: new Date().toISOString() });
      await router.notify(config, 'gquay.idle_nudge', {
        title: `Still waiting on ${item.key}`,
        summary: `The agent asked a question ${Math.round(waiting / 60_000)} minutes ago.`,
        severity: 'attention',
        url,
      });
      log.info({ key: item.key }, 'nudged');
    }
  }

  /**
   * agent-locks has no TTL, so a crashed agent holds its claim forever.
   * `SessionEnd` calls `lock_finish`; this is the backstop for the sessions that
   * never got there.
   */
  private async reapStaleLocks(): Promise<void> {
    const { router } = this.opts;
    const staleAfterMs = router.config.coordination.stale_lock_after_hours * 3_600_000;
    const live = new Set(
      registry.listWorkItems(registry.LIVE_STATES).map((i) => i.key),
    );

    const seen = new Set<string>();
    for (const item of registry.listWorkItems()) {
      if (!item.worktree) continue;
      const common = await router.lockDirFor(item.key).catch(() => undefined);
      if (!common || seen.has(common)) continue;
      seen.add(common);

      const stale = findStaleLocks(readLocks(common), (id) => live.has(id), staleAfterMs);
      if (stale.length > 0) {
        log.warn(
          { dir: lockDir(common), stale: stale.map((l) => l.file) },
          'stale claims held by sessions that are no longer running',
        );
      }
    }
  }

  /** Bounded history: delivered events and webhook dedupe rows are audit noise. */
  private prune(): void {
    const events = pruneDelivered(14);
    const deliveries = pruneDeliveries(7);
    if (events + deliveries > 0) {
      log.debug({ events, deliveries }, 'pruned old rows');
    }
  }
}
