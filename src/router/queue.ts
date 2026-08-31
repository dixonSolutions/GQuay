/**
 * Per-work-item serialisation.
 *
 * Two events arriving for the same work item at the same moment is not
 * hypothetical: a maintainer labels an issue and comments in the same breath,
 * and GitHub delivers both within milliseconds. Without serialisation both
 * handlers read "no session" and both spawn, and you get two agents and two
 * pull requests for one issue.
 *
 * A promise chain per key is enough. Work for *different* items still runs
 * concurrently — the whole design depends on that — but work for one item is
 * strictly ordered, which also means events reach an agent in the order the
 * humans wrote them.
 */

import { childLogger } from '../log.js';

const log = childLogger('queue');

export class KeyedQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly depth = new Map<string, number>();

  /** Run `task` after everything already queued for `key`. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const pending = this.depth.get(key) ?? 0;
    this.depth.set(key, pending + 1);
    if (pending > 0) log.debug({ key, pending }, 'serialising behind in-flight work');

    const previous = this.chains.get(key) ?? Promise.resolve();

    // The chain must not break on failure, or one thrown error would wedge the
    // key forever. Each link swallows its predecessor's rejection; the caller
    // still sees its own.
    const next = previous.then(task, task);
    this.chains.set(
      key,
      next.catch(() => undefined),
    );

    try {
      return await next;
    } finally {
      const remaining = (this.depth.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.depth.delete(key);
        // Only clear the chain if nothing else queued behind us in the meantime.
        if (this.chains.get(key) === next || this.depth.get(key) === undefined) {
          this.chains.delete(key);
        }
      } else {
        this.depth.set(key, remaining);
      }
    }
  }

  depthFor(key: string): number {
    return this.depth.get(key) ?? 0;
  }

  get size(): number {
    return this.chains.size;
  }
}
