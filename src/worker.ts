/**
 * GQuay dispatch worker.
 *
 * Runs on a machine that has something the Router's host does not: an internal
 * network, a licensed toolchain, a database with realistic data, a warm build
 * cache. It **dials out** to the Router and holds the connection open; the
 * Router never connects to it. That is the point — a corporate build server has
 * no inbound path from a home network, and nobody is opening one.
 *
 * What this gives you that a cloud sandbox cannot:
 *   - the local environment, which is the whole reason to run here;
 *   - parking, because this process can hold an `await_events` call for hours.
 *
 * What you have to build yourself, which the cloud gives you free:
 *   - isolation (a worktree per work item, or a container);
 *   - provisioning (a setup script and a dependency cache, with no 5-minute cap);
 *   - teardown, because nothing here is destroyed at session end.
 *
 * A session here is configured through exactly the same `writeSessionConfig` /
 * `claudeArgs` path the Router uses for a local process. That is not tidiness:
 * this file previously built its own `mcp.json` and argv, and in doing so left
 * out `--settings` — which silently removed *every* hook, and with them the
 * Stop-hook park, the merge gate, the issue/PR linking rule and the lock
 * release. A second copy of the spawn contract is a copy that drifts.
 *
 * The one thing that cannot be shared is where hooks point. The Hook Bus is
 * loopback-only on the Router, so `HookTunnel` runs a loopback listener here and
 * forwards each hook over the control connection.
 *
 *   gquay-worker --router wss://router.example.com --labels windows,internal-net
 */

import 'dotenv/config';

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdirSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initLogger, childLogger } from './log.js';
import { HookTunnel } from './hooks/tunnel.js';
import { writeSessionConfig, claudeArgs, baseEnv } from './runners/session.js';
import { inboxPath } from './state/inbox.js';
import type { SpawnRequest } from './runners/types.js';
import type { RouterToWorker, WorkerToRouter, ProvisionSpec } from './runners/dispatch.js';

const exec = promisify(execFile);

interface WorkerArgs {
  router: string;
  token: string;
  labels: string[];
  capacity: number;
  workdir: string;
  workerId: string;
  shell: string;
  /** Where the hook overlay template and its scripts live on this machine. */
  runnerDir: string;
}

function parseArgs(argv: string[]): WorkerArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const router = get('--router') ?? process.env['GQUAY_ROUTER_URL'];
  const token = get('--token') ?? process.env['GQUAY_WORKER_TOKEN'];
  if (!router) throw new Error('--router <wss://host/gquay/worker> is required');
  if (!token) throw new Error('--token, or GQUAY_WORKER_TOKEN, is required');

  return {
    router: router.endsWith('/gquay/worker') ? router : `${router.replace(/\/$/, '')}/gquay/worker`,
    token,
    labels: (get('--labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    capacity: Number(get('--capacity') ?? 2),
    workdir: resolve(get('--workdir') ?? './gquay-work'),
    workerId: get('--id') ?? `${hostname()}-${process.pid}`,
    shell: get('--shell') ?? (platform() === 'win32' ? 'powershell' : 'bash'),
    // Ships with the worker install: dist/worker.js sits beside runner/.
    runnerDir: resolve(
      get('--runner-dir') ?? process.env['GQUAY_RUNNER_DIR'] ??
        resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runner'),
    ),
  };
}

const log = childLogger('worker');

class Worker {
  private ws: WebSocket | undefined;
  private readonly sessions = new Map<string, ChildProcess>();
  private readonly hooks: HookTunnel;
  private reconnectDelay = 1_000;
  private stopping = false;

  constructor(private readonly args: WorkerArgs) {
    mkdirSync(args.workdir, { recursive: true });
    for (const sub of ['mirrors', 'worktrees', 'config', 'inbox']) {
      mkdirSync(resolve(args.workdir, sub), { recursive: true });
    }
    this.hooks = new HookTunnel((frame) => this.send(frame));
  }

  /** Bring up the loopback hook listener before dialling out. */
  async start(): Promise<void> {
    await this.hooks.start();
    this.connect();
  }

  connect(): void {
    if (this.stopping) return;
    log.info({ router: this.args.router, id: this.args.workerId }, 'dialling router');

    const ws = new WebSocket(this.args.router);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 1_000;
      this.send({
        type: 'hello',
        token: this.args.token,
        worker_id: this.args.workerId,
        labels: this.args.labels,
        capacity: this.args.capacity,
        os: platform(),
        shell: this.args.shell,
      });
    });

    ws.on('message', (data: Buffer) => {
      let msg: RouterToWorker;
      try {
        msg = JSON.parse(data.toString('utf8')) as RouterToWorker;
      } catch {
        return;
      }
      void this.handle(msg);
    });

    ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'router connection closed');
      // Anything waiting on a hook round trip will never be answered now, and
      // anything raised before the reconnect cannot be either. Both fail fast
      // rather than let a blocked PreToolUse hold a tool call for 30s.
      this.hooks.setConnected(false);
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error({ err: err.message }, 'socket error');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    // Exponential backoff, capped. The Router may simply be restarting, and a
    // worker that hammers it does not help.
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 60_000);
    log.info({ delayMs: delay }, 'reconnecting');
    setTimeout(() => this.connect(), delay);
  }

  private send(msg: WorkerToRouter): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async handle(msg: RouterToWorker): Promise<void> {
    switch (msg.type) {
      case 'welcome':
        log.info({ workerId: msg.worker_id }, 'attached to router');
        // Hooks can round-trip from here on. Before this they are refused fast
        // rather than left to sit out the round-trip ceiling.
        this.hooks.setConnected(true);
        break;
      case 'reject':
        log.error({ reason: msg.reason }, 'router rejected this worker — check the token');
        this.stopping = true;
        this.ws?.close();
        process.exitCode = 1;
        break;
      case 'ping':
        this.send({ type: 'pong' });
        break;
      case 'spawn':
        await this.spawnSession(msg).catch((err: Error) => {
          log.error({ workItem: msg.work_item, err: err.message }, 'spawn failed');
          this.send({ type: 'exit', work_item: msg.work_item, code: 1, signal: null });
        });
        break;
      case 'kill': {
        const child = this.sessions.get(msg.work_item);
        if (child) {
          log.info({ workItem: msg.work_item, reason: msg.reason }, 'killing session');
          child.kill('SIGTERM');
        }
        break;
      }
      case 'hook_result':
        this.hooks.settle(msg);
        break;
      case 'inbox':
        // Mid-task delivery. The asyncRewake hook reads a file, and on this
        // target that file is here, not on the Router.
        appendFileSync(this.inboxFor(msg.work_item), `${msg.line}\n`, 'utf8');
        log.debug({ workItem: msg.work_item }, 'inbox line received');
        break;
      default:
        break;
    }
  }

  private inboxFor(workItemKey: string): string {
    return inboxPath(resolve(this.args.workdir, 'inbox'), workItemKey);
  }

  private async spawnSession(msg: Extract<RouterToWorker, { type: 'spawn' }>): Promise<void> {
    const provision = msg.provision ?? { isolation: 'worktree', teardown: 'on_session_end' };
    const worktree = await this.provision(msg, provision);

    // Mint this session's hook credential. The tunnel maps it back to the work
    // item, so identity comes from the bearer rather than from a header the
    // agent controls.
    const hookToken = this.hooks.register(msg.work_item);

    const req: SpawnRequest = {
      workItemKey: msg.work_item,
      repo: msg.repo,
      number: msg.number,
      model: msg.model,
      branch: msg.branch,
      worktree,
      prompt: msg.prompt,
      mcpToken: msg.mcp_token,
      mcpUrl: msg.mcp_url,
      githubToken: msg.github_token,
      scopes: msg.scopes,
      ...(msg.resume_session_id ? { resumeSessionId: msg.resume_session_id } : {}),
      env: {
        ...msg.env,
        // `GQUAY_INBOX_FILE` arrives naming a path on the Router's disk. The
        // hook that reads it runs here, so it has to be overridden — not merely
        // defaulted, since the incoming value would otherwise win.
        GQUAY_INBOX_FILE: this.inboxFor(msg.work_item),
        HOOK_BUS_TOKEN: hookToken,
      },
    };

    // The same writer the Router uses for a local process. `settings.json` is
    // what carries every hook; a session spawned without it has no park loop,
    // no merge gate and no linking rule.
    const paths = writeSessionConfig(req, {
      dataDir: this.args.workdir,
      runnerDir: this.args.runnerDir,
      hookBusUrl: this.hooks.origin,
      hookBusToken: hookToken,
      inboxFile: this.inboxFor(msg.work_item),
    });

    const child = spawn('claude', claudeArgs(req, paths), {
      cwd: worktree,
      env: { ...process.env, ...baseEnv(req) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.sessions.set(msg.work_item, child);
    this.send({ type: 'state', work_item: msg.work_item, state: 'starting' });

    let buffer = '';
    let sessionId: string | undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        this.send({ type: 'output', work_item: msg.work_item, stream: 'stdout', line: line.slice(0, 4000) });
        try {
          const parsed = JSON.parse(line) as { session_id?: string };
          if (parsed.session_id && parsed.session_id !== sessionId) {
            sessionId = parsed.session_id;
            this.send({ type: 'state', work_item: msg.work_item, state: 'working', session_id: sessionId });
          }
        } catch {
          /* not JSON — already forwarded above */
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) {
          this.send({ type: 'output', work_item: msg.work_item, stream: 'stderr', line: line.slice(0, 4000) });
        }
      }
    });

    child.once('exit', (code, signal) => {
      this.sessions.delete(msg.work_item);
      this.hooks.release(msg.work_item);
      this.send({ type: 'exit', work_item: msg.work_item, code, signal });
      if (provision.teardown === 'on_session_end') void this.teardown(msg.work_item, worktree);
    });

    child.stdin?.write(msg.prompt);
    child.stdin?.end();

    log.info({ workItem: msg.work_item, worktree, model: msg.model }, 'session started');
  }

  /**
   * Rebuild locally what a cloud session gets for free: a checkout, dependencies,
   * and a cache. A worktree cut from a local bare mirror is faster than a clone,
   * has no clone-rate concerns, and works when GitHub is briefly unreachable.
   */
  private async provision(
    msg: Extract<RouterToWorker, { type: 'spawn' }>,
    provision: ProvisionSpec,
  ): Promise<string> {
    if (provision.isolation === 'none') return this.args.workdir;

    const mirrorsDir = provision.mirror ?? resolve(this.args.workdir, 'mirrors');
    mkdirSync(mirrorsDir, { recursive: true });
    const mirror = resolve(mirrorsDir, `${msg.repo.replace('/', '__')}.git`);
    const authUrl = `https://x-access-token:${msg.github_token}@github.com/${msg.repo}.git`;

    if (!existsSync(mirror)) {
      await exec('git', ['clone', '--bare', authUrl, mirror]);
      // Strip the credential the clone wrote into the remote URL.
      await exec('git', ['remote', 'set-url', 'origin', `https://github.com/${msg.repo}.git`], { cwd: mirror });
      await exec('git', ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], { cwd: mirror });
    }
    await exec(
      'git',
      ['-c', `credential.helper=!f() { echo username=x-access-token; echo password=${msg.github_token}; }; f`,
       'fetch', '--prune', 'origin'],
      { cwd: mirror },
    );

    const worktree = resolve(this.args.workdir, 'worktrees', slug(msg.work_item));
    if (!existsSync(resolve(worktree, '.git'))) {
      const branchExists = await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${msg.branch}`], {
        cwd: mirror,
      })
        .then(() => true)
        .catch(() => false);

      await exec(
        'git',
        branchExists
          ? ['worktree', 'add', worktree, msg.branch]
          : ['worktree', 'add', '-b', msg.branch, worktree, 'HEAD'],
        { cwd: mirror },
      );
    }

    // Point pushes at the Router's branch-scoped proxy, so the agent here can
    // only ever write to its own branch. Worktree-local, because every worktree
    // of this mirror shares one config and each session's URL carries its own
    // token — see `pointPushRemote` in git.ts.
    if (msg.push_remote_url) {
      await exec('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: worktree });
      await exec('git', ['config', '--worktree', 'remote.origin.pushurl', msg.push_remote_url], {
        cwd: worktree,
      });
    } else {
      // Refusing is the safe default: without the proxy the only way the agent
      // could push is with a token that is not branch-scoped.
      log.warn({ workItem: msg.work_item }, 'no push proxy URL from the Router — pushes will fail');
    }

    // Per-repo setup script. No 5-minute cap here — that limit is a property of
    // the cloud sandbox, not of provisioning.
    if (provision.setup) {
      const script = resolve(worktree, provision.setup);
      if (existsSync(script)) {
        log.info({ script }, 'running setup script');
        const isPs = script.endsWith('.ps1');
        await exec(isPs ? 'powershell' : this.args.shell, isPs ? ['-File', script] : [script], {
          cwd: worktree,
          timeout: 30 * 60_000,
        }).catch((err: Error) => {
          log.error({ err: err.message }, 'setup script failed — continuing without it');
        });
      }
    }

    return worktree;
  }

  private async teardown(workItem: string, worktree: string): Promise<void> {
    try {
      await exec('git', ['worktree', 'remove', '--force', worktree], { cwd: worktree }).catch(() => {
        if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
      });
      log.info({ workItem }, 'worktree torn down');
    } catch (err) {
      log.warn({ workItem, err: (err as Error).message }, 'teardown failed');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // SIGTERM, not SIGKILL: SessionEnd releases the agent-locks claim and
    // triggers worktree GC, and that hook has to reach the Router through the
    // tunnel — so the listener stays up until the sessions are done with it.
    for (const child of this.sessions.values()) child.kill('SIGTERM');
    await this.hooks.stop();
    this.ws?.close();
  }
}

function slug(workItemKey: string): string {
  return workItemKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main(): Promise<void> {
  initLogger();
  const args = parseArgs(process.argv.slice(2));
  const worker = new Worker(args);
  await worker.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    // Give SessionEnd a chance to run before the process goes. systemd's
    // TimeoutStopSec is the outer bound; this is the inner one.
    void worker.stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
