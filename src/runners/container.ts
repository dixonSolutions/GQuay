/**
 * `kind: container` — a Claude Code session inside Docker/Podman.
 *
 * Same lifecycle as `process`, different blast radius. Use it for untrusted
 * repositories, for dependency isolation, or simply to run more sessions in
 * parallel than you would want sharing one host's toolchain.
 *
 * The egress allowlist is the point. A container network that reaches only the
 * Claude API, the Router, and whatever the build genuinely needs is the same
 * threat model as the cloud sandbox's domain proxy — except the policy is
 * yours. `network` names a pre-created Docker network; creating it (and its
 * firewall rules) is a deployment step, not something the Router does at spawn,
 * because a network the Router could create is a network the Router could
 * misconfigure under load.
 */

import { spawn } from 'node:child_process';
import { childLogger } from '../log.js';
import { writeSessionConfig, claudeArgs, baseEnv } from './session.js';
import { AGENT_AUTH_ENV_VARS } from '../config.js';
import type { SessionConfigOptions } from './session.js';
import { wireStreams } from './process.js';
import type { Capacity, ExecutionTarget, RunnerHandle, SpawnRequest } from './types.js';

const log = childLogger('runner-container');

export interface ContainerTargetOptions extends SessionConfigOptions {
  name: string;
  image: string;
  /** Docker network name. Omit for the default bridge (no egress restriction). */
  network?: string;
  maxConcurrent: number;
  /** `docker` or `podman`. */
  engine?: string;
  onOutput?: (workItemKey: string, stream: 'stdout' | 'stderr', line: string) => void;
  onSessionId?: (workItemKey: string, sessionId: string) => void;
  onExit?: (workItemKey: string, code: number | null, signal: string | null) => void;
}

export class ContainerTarget implements ExecutionTarget {
  readonly kind = 'container' as const;
  readonly parking = true;
  readonly name: string;

  private readonly running = new Map<string, ContainerHandle>();

  constructor(private readonly opts: ContainerTargetOptions) {
    this.name = opts.name;
  }

  capacity(): Capacity {
    return { used: this.running.size, max: this.opts.maxConcurrent };
  }

  available(): boolean {
    return this.running.size < this.opts.maxConcurrent;
  }

  async spawn(req: SpawnRequest): Promise<RunnerHandle> {
    if (!req.worktree) throw new Error(`container target ${this.name} requires a worktree`);
    const existing = this.running.get(req.workItemKey);
    if (existing) return existing;

    const paths = writeSessionConfig(req, this.opts);
    const engine = this.opts.engine ?? 'docker';
    const containerName = `gquay-${req.workItemKey.replace(/[^a-zA-Z0-9]+/g, '-')}`;

    const env = baseEnv(req);
    const envArgs = Object.keys(env).flatMap((k) => ['-e', k]);
    // `-e NAME` (no value) forwards the value from this process's environment,
    // so the auth vars must actually be present in the spawn env below.
    const authEnv = Object.fromEntries(
      AGENT_AUTH_ENV_VARS.filter((name) => process.env[name]).map((name) => [
        name,
        process.env[name] as string,
      ]),
    );

    const args = [
      'run', '--rm', '-i',
      '--name', containerName,
      // Mount the worktree read-write and the session config read-only. The
      // config carries this session's bearer tokens; nothing in the container
      // has any reason to rewrite it.
      '-v', `${req.worktree}:/work`,
      '-v', `${paths.dir}:/gquay-config:ro`,
      '-w', '/work',
      ...(this.opts.network ? ['--network', this.opts.network] : []),
      ...envArgs,
      // Forward whichever agent credential this host holds. Passing only
      // ANTHROPIC_API_KEY would silently drop a subscription token and leave the
      // container with no credential at all — the session would start, fail to
      // authenticate, and look like a model error.
      ...AGENT_AUTH_ENV_VARS.filter((name) => process.env[name]).flatMap((name) => ['-e', name]),
      this.opts.image,
      'claude',
      ...claudeArgs(req, {
        dir: '/gquay-config',
        settingsPath: '/gquay-config/settings.json',
        mcpConfigPath: '/gquay-config/mcp.json',
      }),
    ];

    const child = spawn(engine, args, {
      env: { ...process.env, ...authEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle = new ContainerHandle(this.name, req.workItemKey, containerName, engine, child, () => {
      this.running.delete(req.workItemKey);
    });
    this.running.set(req.workItemKey, handle);
    wireStreams(handle, child, req, this.opts);

    child.stdin?.write(req.prompt);
    child.stdin?.end();

    log.info({ workItem: req.workItemKey, container: containerName, image: this.opts.image }, 'container session spawned');
    return handle;
  }
}

class ContainerHandle implements RunnerHandle {
  sessionId?: string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private killed = false;

  constructor(
    readonly target: string,
    readonly workItemKey: string,
    private readonly containerName: string,
    private readonly engine: string,
    private readonly child: ReturnType<typeof spawn>,
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
    if (this.killed) return;
    this.killed = true;
    log.info({ workItem: this.workItemKey, reason }, 'stopping container');
    // `docker stop` sends SIGTERM and waits, which lets SessionEnd run. Killing
    // the local `docker run` client would orphan the container instead.
    spawn(this.engine, ['stop', '--time', '15', this.containerName], { stdio: 'ignore' });
    await Promise.race([
      this.exited,
      new Promise((r) => setTimeout(r, 20_000)),
    ]);
  }
}
