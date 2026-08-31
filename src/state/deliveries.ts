/**
 * Webhook delivery dedupe.
 *
 * GitHub retries deliveries, and a retry carries the same `X-GitHub-Delivery`
 * id. A UNIQUE insert on that id is therefore the entire guard: if the insert
 * conflicts, this delivery has been seen and must not be processed again.
 *
 * This is checked *before* signature-verified payload handling does anything
 * with side effects, because the expensive failure is a duplicate spawn, not a
 * duplicate log line.
 */

import { getDb } from './db.js';

export interface RecordResult {
  /** False when this delivery id has already been processed. */
  fresh: boolean;
}

export function recordDelivery(
  deliveryId: string,
  event: string,
  action: string | undefined,
  repo: string | undefined,
): RecordResult {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO deliveries (delivery_id, event, action, repo)
       VALUES (?, ?, ?, ?)`,
    )
    .run(deliveryId, event, action ?? null, repo ?? null);
  return { fresh: info.changes > 0 };
}

export function setOutcome(deliveryId: string, outcome: string): void {
  getDb().prepare('UPDATE deliveries SET outcome = ? WHERE delivery_id = ?').run(outcome, deliveryId);
}

/** Keep the dedupe window bounded; GitHub gives up retrying long before this. */
export function pruneDeliveries(days = 7): number {
  const info = getDb()
    .prepare(`DELETE FROM deliveries WHERE received_at < datetime('now', ?)`)
    .run(`-${days} days`);
  return info.changes;
}
