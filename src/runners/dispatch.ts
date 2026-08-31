/**
 * `kind: dispatch` — sessions on a worker machine that dials out to the Router.
 *
 * The Router never initiates a connection to a worker. This is the whole reason
 * the target exists: a build server inside a corporate network has no inbound
 * path from the Router's host, and nobody is going to open one. Because the
 * worker dials out, the only thing needing a public address is the Router —
 * which already has one for the GitHub webhook.
 *
 *   worker  --TLS-->  Router /gquay/worker
 *     |- hello    { token, worker_id, labels, capacity, os, shell }
 *     |- receive  { spawn work_item, model, branch, scopes, session_token }
 *     |- stream   { state, session_id, output, exit }
 *     `- proxy    { mcp }  -- the agent's MCP traffic, tunnelled home
 *
 * MCP is proxied over the control connection rather than dialled separately:
 * one outbound connection per worker, no extra firewall rule, and the parked
 * `await_events` call rides the same socket that is already being heartbeated.
 */

import { randomUUID } from 'node:crypto';
import { childLogger } from '../log.js';
import type { Capacity, ExecutionTarget, RunnerHandle, SpawnRequest } from './types.js';

const log = childLogger('runner-dispatch');

// ── Wire protocol ─────────────────────────────────────────────────────────────

export type WorkerToRouter =
  | { type: 'hello'; token: string; worker_id: string; labels: string[]; capacity: number; os: string; shell: string }
  | { type: 'state'; work_item: string; state: string; session_id?: string }
  | { type: 'output'; work_item: string; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'exit'; work_item: string; code: number | null; signal: string | null }
  | { type: 'mcp'; id: string; work_item: string; payload: unknown }
  | { type: 'pong' };

export type RouterToWorker =
  | { type: 'welcome'; heartbeat_ms: number; worker_id: string }
  | { type: 'reject'; reason: string }
  | {
      type: 'spawn';
      work_item: string;
      repo: string;
      number: number;
      model: string;
      branch: string;
      prompt: string;
      mcp_token: string;
      mcp_url: string;
      github_token: string;
      scopes: string[];
      resume_session_id?: string;
      provision?: ProvisionSpec;
    }
  | { type: 'kill'; work_item: string; reason: string }
  | { type: 'mcp_result'; id: string; payload: unknown }
  | { type: 'ping' };

export interface ProvisionSpec {
  isolation: 'worktree' | 'container' | 'none';
  mirror?: string;
  setup?: string;
  cache?: { paths: string[]; key?: string; ttl: string };
  teardown: 'on_session_end' | 'keep_warm';
}

/** Transport-agnostic handle on one connected worker. `server.ts` supplies it. */
export interface WorkerConnection {
  readonly id: string;
  readonly labels: string[];
  readonly capacity: number;
  readonly os: string;
  readonly shell: string;
  send(message: RouterToWorker): void;
  close(reason: string): void;
}

// ── Worker registry ───────────────────────────────────────────────────────────

export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerConnection>();
  /** work_item -> worker id, so a resumed session goes back to its own worktree. */
  private readonly assignment = new Map<string, string>();

  attach(conn: WorkerConnection): void {
    const existing = this.workers.get(conn.id);
    if (existing) {
      // A reconnect after a network blip. The old socket is dead by definition;
      // drop it rather than leaving two entries claiming the same capacity.
      log.warn({ workerId: conn.id }, 'worker reconnected — replacing stale connection');
      existing.close('replaced by reconnect');
    }
    this.workers.set(conn.id, conn);
    log.info({ workerId: conn.id, labels: conn.labels, capacity: conn.capacity }, 'worker attached');
  }

  detach(workerId: string): string[] {
    this.workers.delete(workerId);
    const orphaned: string[] = [];
    for (const [item, id] of this.assignment) {
      if (id === workerId) orphaned.push(item);
    }
    log.warn({ workerId, orphaned }, 'worker detached');
    return orphaned;
  }

  get(workerId: string): WorkerConnection | undefined {
    return this.workers.get(workerId);
  }

  forWorkItem(workItemKey: string): WorkerConnection | undefined {
    const id = this.assignment.get(workItemKey);
    return id ? this.workers.get(id) : undefined;
  }

  assign(workItemKey: string, workerId: string): void {
    this.assignment.set(workItemKey, workerId);
  }

  release(workItemKey: string): void {
    this.assignment.delete(workItemKey);
  }

  /** Workers advertising every required label, least-loaded first. */
  candidates(requiredLabels: string[]): WorkerConnection[] {
    const load = new Map<string, number>();
    for (const id of this.assignment.values()) load.set(id, (load.get(id) ?? 0) + 1);

    return [...this.workers.values()]
      .filter((w) => requiredLabels.every((l) => w.labels.includes(l)))
      .filter((w) => (load.get(w.id) ?? 0) < w.capacity)
      .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
  }

  count(): number {
    return this.workers.size;
  }

  activeFor(workerId: string): number {
    let n = 0;
    for (const id of this.assignment.values()) if (id === workerId) n++;
    return n;
  }

  totalActive(): number {
    return this.assignment.size;
  }

  broadcast(message: RouterToWorker): void {
    for (const w of this.workers.values()) w.send(message);
  }
}

// ── Target ────────────────────────────────────────────────────────────────────

export interface DispatchTargetOptions {
  name: string;
  labels: string[];
  maxConcurrent: number;
  registry: WorkerRegistry;
  provision?: ProvisionSpec;
  onSessionId?: (workItemKey: string, sessionId: string) => void;
  onExit?: (workItemKey: string, code: number | null, signal: string | null) => void;
}

export class DispatchTarget implements ExecutionTarget {
  readonly kind = 'dispatch' as const;
  readonly parking = true;
  readonly name: string;

  private readonly handles = new Map<string, DispatchHandle>();

  constructor(private readonly opts: DispatchTargetOptions) {
    this.name = opts.name;
  }

  capacity(): Capacity {
    return { used: this.handles.size, max: this.opts.maxConcurrent };
  }

  available(): boolean {
    return (
      this.handles.size < this.opts.maxConcurrent &&
      this.opts.registry.candidates(this.opts.labels).length > 0
    );
  }

  async spawn(req: SpawnRequest): Promise<RunnerHandle> {
    const existing = this.handles.get(req.workItemKey);
    if (existing) return existing;

    // A work item is sticky to its worker: the worktree only exists there.
    const pinned = this.opts.registry.forWorkItem(req.workItemKey);
    const worker = pinned ?? this.opts.registry.candidates(this.opts.labels)[0];
    if (!worker) {
      throw new Error(
        `No dispatch worker attached with labels [${this.opts.labels.join(', ')}]. ` +
          `Start one with \`gquay-worker --router <url> --labels ${this.opts.labels.join(',')}\`.`,
      );
    }

    this.opts.registry.assign(req.workItemKey, worker.id);
    const handle = new DispatchHandle(this.name, req.workItemKey, worker, () => {
      this.handles.delete(req.workItemKey);
      this.opts.registry.release(req.workItemKey);
    });
    this.handles.set(req.workItemKey, handle);

    worker.send({
      type: 'spawn',
      work_item: req.workItemKey,
      repo: req.repo,
      number: req.number,
      model: req.model,
      branch: req.branch,
      prompt: req.prompt,
      mcp_token: req.mcpToken,
      mcp_url: req.mcpUrl,
      github_token: req.githubToken,
      scopes: req.scopes,
      ...(req.resumeSessionId ? { resume_session_id: req.resumeSessionId } : {}),
      ...(this.opts.provision ? { provision: this.opts.provision } : {}),
    });

    log.info({ workItem: req.workItemKey, workerId: worker.id }, 'dispatched to worker');
    return handle;
  }

  /** Called by `server.ts` when a worker reports state or exit. */
  onWorkerMessage(msg: WorkerToRouter): void {
    if (msg.type === 'state' && msg.session_id) {
      const handle = this.handles.get(msg.work_item);
      if (handle) handle.sessionId = msg.session_id;
      this.opts.onSessionId?.(msg.work_item, msg.session_id);
    }
    if (msg.type === 'exit') {
      this.handles.get(msg.work_item)?.settle(msg.code, msg.signal);
      this.opts.onExit?.(msg.work_item, msg.code, msg.signal);
    }
  }

  /** A worker vanished; its sessions are gone with it. */
  onWorkerLost(orphanedItems: string[]): void {
    for (const item of orphanedItems) {
      this.handles.get(item)?.settle(null, 'WORKER_LOST');
    }
  }
}

class DispatchHandle implements RunnerHandle {
  sessionId?: string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private settleFn!: (v: { code: number | null; signal: string | null }) => void;
  private settled = false;

  constructor(
    readonly target: string,
    readonly workItemKey: string,
    private readonly worker: WorkerConnection,
    private readonly onExit: () => void,
  ) {
    this.exited = new Promise((resolve) => {
      this.settleFn = resolve;
    });
  }

  get workerId(): string {
    return this.worker.id;
  }

  settle(code: number | null, signal: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onExit();
    this.settleFn({ code, signal });
  }

  async kill(reason: string): Promise<void> {
    this.worker.send({ type: 'kill', work_item: this.workItemKey, reason });
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 20_000))]);
    this.settle(null, 'SIGTERM');
  }
}

export function newWorkerId(): string {
  return `worker-${randomUUID().slice(0, 8)}`;
}
