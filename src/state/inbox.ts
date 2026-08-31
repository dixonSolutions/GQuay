/**
 * The asyncRewake inbox (§3c).
 *
 * An agent parked in `await_events` is reachable through the MCP call. An agent
 * three files into a refactor is not — it is not in the call. For that case the
 * Router drops a line into a per-work-item inbox file, and a `PostToolBatch`
 * hook (`runner/hooks/check-inbox.sh`, `async: true`, `asyncRewake: true`)
 * reads it between tool calls. The hook exits 2 with the message on stderr,
 * which wakes Claude and surfaces it as a system reminder mid-task.
 *
 * A file rather than an HTTP call on purpose: the hook must be cheap and must
 * not fail the batch when the Router is briefly unavailable. Reading a file
 * that is usually empty costs nothing.
 */

import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { childLogger } from '../log.js';
import type { DeliveredEvent } from './events.js';

const log = childLogger('inbox');

/**
 * Work-item keys contain `/` and `#`, so they cannot be filenames. A short hash
 * keyed on the full key keeps it collision-free and path-traversal-proof, and
 * the readable prefix keeps `ls inbox/` diagnosable.
 */
export function inboxFileName(workItemKey: string): string {
  const hash = createHash('sha256').update(workItemKey).digest('hex').slice(0, 12);
  const slug = workItemKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `${slug}-${hash}.jsonl`;
}

export function inboxPath(inboxDir: string, workItemKey: string): string {
  return resolve(inboxDir, inboxFileName(workItemKey));
}

export function deposit(inboxDir: string, workItemKey: string, event: DeliveredEvent): void {
  mkdirSync(inboxDir, { recursive: true });
  const path = inboxPath(inboxDir, workItemKey);
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
  log.debug({ workItemKey, path }, 'inbox deposit');
}

/** Read and clear. Called by the hook helper, not by the Router itself. */
export function takeAll(inboxDir: string, workItemKey: string): DeliveredEvent[] {
  const path = inboxPath(inboxDir, workItemKey);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  writeFileSync(path, '', 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as DeliveredEvent];
      } catch {
        return [];
      }
    });
}

export function clear(inboxDir: string, workItemKey: string): void {
  const path = inboxPath(inboxDir, workItemKey);
  if (existsSync(path)) writeFileSync(path, '', 'utf8');
}
