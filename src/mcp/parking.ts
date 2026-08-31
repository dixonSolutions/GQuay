/**
 * The parking lot — where `await_events` calls wait.
 *
 * This is the mechanism the whole design turns on. Claude Code hooks fire on
 * *its* lifecycle; nothing external can raise one directly, so a GitHub webhook
 * cannot "fire a hook". But an MCP tool call is itself a lifecycle point, and an
 * MCP server is a long-lived process that can simply not return from a call
 * until something happens. The agent calls `gquay__await_events`, the server
 * parks it here, and when the webhook arrives the call returns with the comment
 * as its result — same session, same context window, no restart, and
 * `PostToolUse` fires on the way out.
 *
 * The limit that survives is narrower and more useful than "you cannot reach a
 * live session":
 *
 *   An agent is reachable at the points where it yields to a tool, not at
 *   arbitrary instants.
 *
 * Three implementation details carry real weight:
 *
 *  1. **Resolve exactly once.** Events are queued in SQLite and *drained* by the
 *     returning call, never handed directly to a waiting promise. An event that
 *     lands a millisecond before the call registers is already in the table, so
 *     the call drains it instead of parking on an empty queue.
 *
 *  2. **Keep the transport alive.** Client and server both have idle timeouts.
 *     Progress notifications go out on a heartbeat, and `timeout_s` is bounded
 *     so the hook re-fires rather than relying on one socket surviving hours.
 *
 *  3. **Return the idle duration.** `idle_ms` lets the agent decide whether to
 *     nudge, summarise, or wind down, instead of the Router pushing that
 *     decision in.
 */

import { childLogger } from '../log.js';
import { drain, pendingCount } from '../state/events.js';
import type { DeliveredEvent } from '../state/events.js';

const log = childLogger('parking');

export interface ParkResult {
  events: DeliveredEvent[];
  /** Milliseconds this call spent parked. Zero when events were already queued. */
  idle_ms: number;
  /** True when the call returned empty because `timeout_s` elapsed. */
  timed_out: boolean;
}

interface Waiter {
  /** Every key this call is watching — an item and its linked twin. */
  keys: string[];
  settle: (result: ParkResult) => void;
  parkedAt: number;
  timer: NodeJS.Timeout;
  heartbeat: NodeJS.Timeout | undefined;
  settled: boolean;
}

export interface ParkOptions {
  /** Keys to watch. An issue and its linked PR share a session, so both. */
  keys: string[];
  timeoutMs: number;
  /** Aborts when the client disconnects or cancels the tool call. */
  signal?: AbortSignal;
  /** Emits an MCP progress notification. Keeps the HTTP stream from idling out. */
  onHeartbeat?: (elapsedMs: number) => void | Promise<void>;
  heartbeatMs?: number;
}

export class ParkingLot {
  private readonly waiters = new Set<Waiter>();

  /** How many calls are currently parked. Surfaced on /gquay/status. */
  get size(): number {
    return this.waiters.size;
  }

  /** Keys with at least one call parked on them. */
  parkedKeys(): string[] {
    const keys = new Set<string>();
    for (const w of this.waiters) for (const k of w.keys) keys.add(k);
    return [...keys];
  }

  async park(opts: ParkOptions): Promise<ParkResult> {
    // Drain first. This is detail (1) above — without it an event that arrives
    // between the webhook handler's enqueue and this call's registration would
    // sit in the queue until the *next* event woke someone up.
    const immediate = drain(opts.keys);
    if (immediate.length > 0) {
      return { events: immediate, idle_ms: 0, timed_out: false };
    }

    return new Promise<ParkResult>((resolve) => {
      const parkedAt = Date.now();
      const waiter: Waiter = {
        keys: opts.keys,
        parkedAt,
        settled: false,
        heartbeat: undefined,
        timer: setTimeout(() => {
          this.settle(waiter, { events: [], idle_ms: Date.now() - parkedAt, timed_out: true });
        }, opts.timeoutMs),
        settle: resolve,
      };

      if (opts.onHeartbeat) {
        const every = opts.heartbeatMs ?? 25_000;
        waiter.heartbeat = setInterval(() => {
          void opts.onHeartbeat?.(Date.now() - parkedAt);
        }, every);
        // Heartbeats must not hold the process open on shutdown.
        waiter.heartbeat.unref?.();
      }

      // A cancelled tool call — client disconnect, session kill — returns empty
      // rather than leaking a waiter and its timers.
      opts.signal?.addEventListener(
        'abort',
        () => {
          this.settle(waiter, { events: [], idle_ms: Date.now() - parkedAt, timed_out: false });
        },
        { once: true },
      );

      this.waiters.add(waiter);
      log.debug({ keys: opts.keys, timeoutMs: opts.timeoutMs }, 'call parked');
    });
  }

  /**
   * An event arrived for `key`. Wake every call watching it. Called by the
   * dispatcher after the event is committed to the queue, never before — the
   * queue is the source of truth and this is only the doorbell.
   */
  notify(key: string): number {
    let woken = 0;
    for (const waiter of [...this.waiters]) {
      if (!waiter.keys.includes(key)) continue;
      const events = drain(waiter.keys);
      if (events.length === 0) continue; // another waiter got there first
      this.settle(waiter, { events, idle_ms: Date.now() - waiter.parkedAt, timed_out: false });
      woken++;
    }
    if (woken === 0 && pendingCount([key]) > 0) {
      log.debug({ key }, 'event queued with nobody parked — drained on next park or spawn');
    }
    return woken;
  }

  /** Release every parked call — shutdown, or a session being terminated. */
  releaseAll(reason: string): void {
    log.info({ reason, parked: this.waiters.size }, 'releasing parked calls');
    for (const waiter of [...this.waiters]) {
      this.settle(waiter, {
        events: [],
        idle_ms: Date.now() - waiter.parkedAt,
        timed_out: false,
      });
    }
  }

  /** Release calls parked on a specific work item. */
  release(key: string, reason: string): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.keys.includes(key)) continue;
      log.debug({ key, reason }, 'releasing parked call');
      this.settle(waiter, {
        events: drain(waiter.keys),
        idle_ms: Date.now() - waiter.parkedAt,
        timed_out: false,
      });
    }
  }

  private settle(waiter: Waiter, result: ParkResult): void {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    if (waiter.heartbeat) clearInterval(waiter.heartbeat);
    this.waiters.delete(waiter);
    waiter.settle(result);
  }
}
