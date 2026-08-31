/**
 * Per-work-item event queue.
 *
 * Events are enqueued the moment a webhook is accepted, and drained by whichever
 * `await_events` call is parked for that work item. Enqueue-then-drain (rather
 * than handing the event straight to a waiting promise) is what makes the
 * "resolve exactly once" requirement achievable: an event that lands a
 * millisecond before the call registers is already in the table, so the call
 * drains it immediately instead of parking on an empty queue.
 *
 * Undelivered events also survive a Router restart, which matters because the
 * parked call does not.
 */

import { getDb, now } from './db.js';
import { childLogger } from '../log.js';

const log = childLogger('events');

export type EventKind = 'comment' | 'review' | 'review_comment' | 'ci' | 'control';

export interface QueuedEvent {
  id: number;
  work_item_key: string;
  kind: EventKind;
  payload: string;
  created_at: string;
  delivered_at: string | null;
}

/**
 * What an agent actually receives. Comment bodies are attacker-controlled text
 * on a public surface, so the delivered shape keeps the author, their
 * permission level, and the source URL alongside the body — the agent needs all
 * three to judge it, and `mcp/framing.ts` needs them to frame it safely.
 */
export interface DeliveredEvent {
  kind: EventKind;
  work_item: string;
  author?: string;
  author_association?: string;
  /**
   * The author's real permission level, from the GitHub API — not the
   * `author_association` in the payload, which is a weaker signal the sender
   * partly controls. The framing quotes this so the agent can weigh a request
   * against who is actually making it.
   */
  author_permission?: string;
  body?: string;
  url?: string;
  /** review events only */
  review_state?: string;
  /** review_comment events only */
  path?: string;
  line?: number;
  diff_hunk?: string;
  /** ci events only */
  conclusion?: string;
  workflow?: string;
  /** control events (Router-originated), e.g. shutdown or config change */
  control?: string;
  received_at: string;
}

export function enqueue(workItemKey: string, kind: EventKind, payload: DeliveredEvent): number {
  const info = getDb()
    .prepare('INSERT INTO events (work_item_key, kind, payload) VALUES (?, ?, ?)')
    .run(workItemKey, kind, JSON.stringify(payload));
  log.debug({ workItemKey, kind }, 'event enqueued');
  return Number(info.lastInsertRowid);
}

/**
 * Take every pending event for these keys and mark them delivered, atomically.
 * Keys is plural because an issue and its linked PR share one session — a
 * parked call must drain both threads or a PR review would sit unseen while
 * the agent waits on the issue.
 */
export function drain(keys: string[]): DeliveredEvent[] {
  if (keys.length === 0) return [];
  const db = getDb();
  const placeholders = keys.map(() => '?').join(',');

  const take = db.transaction((): QueuedEvent[] => {
    const rows = db
      .prepare(
        `SELECT * FROM events
         WHERE work_item_key IN (${placeholders}) AND delivered_at IS NULL
         ORDER BY id ASC`,
      )
      .all(...keys) as QueuedEvent[];
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      db.prepare(
        `UPDATE events SET delivered_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).run(now(), ...ids);
    }
    return rows;
  });

  const rows = take();
  return rows.map((r) => JSON.parse(r.payload) as DeliveredEvent);
}

export function pendingCount(keys: string[]): number {
  if (keys.length === 0) return 0;
  const placeholders = keys.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE work_item_key IN (${placeholders}) AND delivered_at IS NULL`,
    )
    .get(...keys) as { n: number };
  return row.n;
}

/** Housekeeping — delivered events older than `days` are audit noise. */
export function pruneDelivered(days = 14): number {
  const info = getDb()
    .prepare(`DELETE FROM events WHERE delivered_at IS NOT NULL AND delivered_at < datetime('now', ?)`)
    .run(`-${days} days`);
  return info.changes;
}
