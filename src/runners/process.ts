/**
 * `kind: process` — a Claude Code session as a child process on the Router host.
 *
 * The default target. One OS process per work item, supervised by the Router:
 * the same isolation an agent-team teammate would give, with a lifecycle we
 * control and unambiguous liveness. (Teams roughly double token use versus
 * subagents and have known trouble telling idle-but-alive from dead, which
 * causes leads to spawn duplicates — see docs/01-architecture.md.)
 *
 * The session id is lifted off the `stream-json` output rather than guessed.
 * Everything downstream — resume, the registry, `--resume` on a parked item —
 * depends on capturing it, so a session whose id never appears is treated as
 * failed rather than left half-registered.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { childLogger } from '../log.js';
import { writeSessionConfig, claudeArgs, baseEnv } from './session.js';
import type { SessionConfigOptions } from './session.js';
import type { Capacity, ExecutionTarget, RunnerHandle, SpawnRequest } from './types.js';

const log = childLogger('runner-process');

export interface ProcessTargetOptions extends SessionConfigOptions {
  name: string;
  claudeBin: string;
  maxConcurrent: number;
  /** Called for every line of session output — the Router logs and mirrors it. */
  onOutput?: (workItemKey: string, stream: 'stdout' | 'stderr', line: string) => void;
  /** Called the first time a session id is observed. */
  onSessionId?: (workItemKey: string, sessionId: string) => void;
  onExit?: (workItemKey: string, code: number | null, signal: string | null) => void;
}

export class ProcessTarget implements ExecutionTarget {
  readonly kind = 'process' as const;
  readonly parking = true;
  readonly name: string;

  private readonly running = new Map<string, ProcessHandle>();

  constructor(private readonly opts: ProcessTargetOptions) {
    this.name = opts.name;
  }

  capacity(): Capacity {
    return { used: this.running.size, max: this.opts.maxConcurrent };
  }

  available(): boolean {
    return this.running.size < this.opts.maxConcurrent;
  }

  async spawn(req: SpawnRequest): Promise<RunnerHandle> {
    if (!req.worktree) {
      throw new Error(`process target ${this.name} requires a worktree`);
    }
    const existing = this.running.get(req.workItemKey);
    if (existing) {
      // Serialisation upstream should make this unreachable; if it happens,
      // reusing the live session is strictly better than racing a second one.
      log.warn({ workItem: req.workItemKey }, 'spawn requested for a running session — reusing');
      return existing;
    }

    const paths = writeSessionConfig(req, this.opts);
    const args = claudeArgs(req, paths);

    const child = spawn(this.opts.claudeBin, args, {
      cwd: req.worktree,
      env: { ...process.env, ...baseEnv(req) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const handle = new ProcessHandle(this.name, req.workItemKey, child, () => {
      this.running.delete(req.workItemKey);
    });

    this.running.set(req.workItemKey, handle);
    wireStreams(handle, child, req, this.opts);

    // The prompt goes in on stdin so an issue body full of backticks, newlines
    // and quotes never has to survive an argv round trip.
    child.stdin?.write(req.prompt);
    child.stdin?.end();

    log.info(
      { workItem: req.workItemKey, pid: child.pid, model: req.model, resume: !!req.resumeSessionId },
      'session spawned',
    );
    return handle;
  }

  handleFor(workItemKey: string): RunnerHandle | undefined {
    return this.running.get(workItemKey);
  }

  async killAll(reason: string): Promise<void> {
    await Promise.all([...this.running.values()].map((h) => h.kill(reason)));
  }
}

class ProcessHandle implements RunnerHandle {
  sessionId?: string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private killed = false;

  constructor(
    readonly target: string,
    readonly workItemKey: string,
    private readonly child: ChildProcess,
    onExit: () => void,
  ) {
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        onExit();
        resolve({ code, signal });
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async kill(reason: string): Promise<void> {
    if (this.killed || this.child.exitCode !== null) return;
    this.killed = true;
    log.info({ workItem: this.workItemKey, reason }, 'terminating session');
    this.child.kill('SIGTERM');

    // Give the session a moment to run its SessionEnd hook — that hook releases
    // the agent-locks claim and triggers worktree GC, so losing it leaks state.
    const graceful = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    if (!graceful) {
      log.warn({ workItem: this.workItemKey }, 'session did not exit on SIGTERM — SIGKILL');
      this.child.kill('SIGKILL');
    }
  }
}

/**
 * Read the `stream-json` output. Every line is a JSON object; the ones that
 * matter carry `session_id`. Non-JSON lines are passed through rather than
 * dropped, because that is where a crash message lands.
 */
export function wireStreams(
  handle: RunnerHandle & { sessionId?: string },
  child: ChildProcess,
  req: SpawnRequest,
  opts: Pick<ProcessTargetOptions, 'onOutput' | 'onSessionId' | 'onExit'>,
): void {
  let buffer = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      opts.onOutput?.(req.workItemKey, 'stdout', line);
      const id = extractSessionId(line);
      if (id && handle.sessionId !== id) {
        handle.sessionId = id;
        opts.onSessionId?.(req.workItemKey, id);
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length > 0) opts.onOutput?.(req.workItemKey, 'stderr', line);
    }
  });

  child.once('exit', (code, signal) => {
    opts.onExit?.(req.workItemKey, code, signal);
  });
}

export function extractSessionId(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { session_id?: unknown };
    return typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
  } catch {
    return undefined;
  }
}
