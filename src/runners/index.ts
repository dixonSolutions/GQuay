/**
 * The execution plane — build targets from config, then pick one per work item.
 *
 * Routing rules are matched in order, first match wins, and an unmatched item
 * falls back to `runner.default`. The rules live in the Router's own config
 * rather than in `gquay.yml` because a target names a machine and a token: a
 * repository that could choose its own target could choose to run on a box it
 * was never granted.
 *
 * A work item is *pinned* to its target for life. A worktree on a Kingspan
 * worker does not exist anywhere else, so a resumed session has to go home.
 */

import { childLogger } from '../log.js';
import type { RouterConfig } from '../config.js';
import { ProcessTarget } from './process.js';
import { ContainerTarget } from './container.js';
import { DispatchTarget, WorkerRegistry } from './dispatch.js';
import { CloudTarget } from './cloud.js';
import type { SessionConfigOptions } from './session.js';
import type { ExecutionTarget, RunnerHandle } from './types.js';

const log = childLogger('runners');

export interface BuildTargetsOptions extends SessionConfigOptions {
  config: RouterConfig;
  workers: WorkerRegistry;
  onOutput?: (workItemKey: string, stream: 'stdout' | 'stderr', line: string) => void;
  onSessionId?: (workItemKey: string, sessionId: string) => void;
  onExit?: (workItemKey: string, code: number | null, signal: string | null) => void;
}

export class ExecutionPlane {
  private readonly targets = new Map<string, ExecutionTarget>();
  private readonly handles = new Map<string, RunnerHandle>();

  constructor(private readonly opts: BuildTargetsOptions) {
    for (const [name, spec] of Object.entries(opts.config.runner.targets)) {
      const shared = {
        ...opts,
        name,
        maxConcurrent: spec.max_concurrent,
      };
      switch (spec.kind) {
        case 'process':
          this.targets.set(
            name,
            new ProcessTarget({ ...shared, claudeBin: opts.config.runner.claude_bin }),
          );
          break;
        case 'container':
          this.targets.set(
            name,
            new ContainerTarget({
              ...shared,
              image: spec.image!,
              ...(spec.network ? { network: spec.network } : {}),
              ...(spec.engine ? { engine: spec.engine } : {}),
            }),
          );
          break;
        case 'dispatch':
          this.targets.set(
            name,
            new DispatchTarget({
              name,
              labels: spec.labels,
              maxConcurrent: spec.max_concurrent,
              registry: opts.workers,
              ...(spec.provision ? { provision: spec.provision } : {}),
              ...(opts.onSessionId ? { onSessionId: opts.onSessionId } : {}),
              ...(opts.onExit ? { onExit: opts.onExit } : {}),
            }),
          );
          break;
        case 'claude_cloud':
          this.targets.set(
            name,
            new CloudTarget({
              ...shared,
              publicUrl: opts.config.public_url,
              ...(spec.launch_command ? { launchCommand: spec.launch_command } : {}),
            }),
          );
          break;
      }
    }
    log.info({ targets: [...this.targets.keys()] }, 'execution plane ready');
  }

  get(name: string): ExecutionTarget | undefined {
    return this.targets.get(name);
  }

  list(): ExecutionTarget[] {
    return [...this.targets.values()];
  }

  /**
   * Choose a target for a *new* work item. `pinned` short-circuits everything:
   * a resumed item goes back to where its worktree is, or nowhere.
   */
  select(input: {
    repo: string;
    labels: string[];
    pinned?: string | null;
    preferred?: string | undefined;
  }): { target: ExecutionTarget; reason: string } {
    if (input.pinned) {
      const t = this.targets.get(input.pinned);
      if (t) return { target: t, reason: 'pinned to existing worktree' };
      log.warn({ pinned: input.pinned }, 'pinned target no longer configured — reselecting');
    }

    for (const rule of this.opts.config.routing) {
      const m = rule.match;
      if (m.repo && !matchGlob(m.repo, input.repo)) continue;
      if (m.owner && !matchGlob(m.owner, input.repo.split('/')[0] ?? '')) continue;
      if (m.label && !input.labels.includes(m.label)) continue;
      const t = this.targets.get(rule.target);
      if (t) return { target: t, reason: `routing rule ${JSON.stringify(m)}` };
    }

    // A repo may *request* a target, but only one that already exists — this is
    // a preference, not a grant.
    if (input.preferred) {
      const t = this.targets.get(input.preferred);
      if (t) return { target: t, reason: 'gquay.yml preferred_target' };
    }

    const fallback = this.targets.get(this.opts.config.runner.default)!;
    return { target: fallback, reason: 'runner.default' };
  }

  /** Global admission control, on top of each target's own cap. */
  hasGlobalCapacity(): boolean {
    let used = 0;
    for (const t of this.targets.values()) used += t.capacity().used;
    return used < this.opts.config.runner.max_concurrent_total;
  }

  track(workItemKey: string, handle: RunnerHandle): void {
    this.handles.set(workItemKey, handle);
    void handle.exited.finally(() => {
      if (this.handles.get(workItemKey) === handle) this.handles.delete(workItemKey);
    });
  }

  handleFor(workItemKey: string): RunnerHandle | undefined {
    return this.handles.get(workItemKey);
  }

  isRunning(workItemKey: string): boolean {
    return this.handles.has(workItemKey);
  }

  async kill(workItemKey: string, reason: string): Promise<void> {
    await this.handles.get(workItemKey)?.kill(reason);
  }

  async killAll(reason: string): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.kill(reason)));
  }
}

/** `kingspan/*` style matching. `*` is the only wildcard, and it spans one segment. */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp(
    `^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`,
  );
  return re.test(value);
}

export { WorkerRegistry } from './dispatch.js';
export type { ExecutionTarget, RunnerHandle, SpawnRequest } from './types.js';
