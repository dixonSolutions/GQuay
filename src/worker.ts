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
 *   gquay-worker --router wss://router.example.com --labels windows,internal-net
 */

import 'dotenv/config';

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initLogger, childLogger } from './log.js';
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
  };
}

const log = childLogger('worker');

class Worker {
  private ws: WebSocket | undefined;
  private readonly sessions = new Map<string, ChildProcess>();
  private reconnectDelay = 1_000;
  private stopping = false;

  constructor(private readonly args: WorkerArgs) {
    mkdirSync(args.workdir, { recursive: true });
    mkdirSync(resolve(args.workdir, 'mirrors'), { recursive: true });
    mkdirSync(resolve(args.workdir, 'worktrees'), { recursive: true });
    mkdirSync(resolve(args.workdir, 'config'), { recursive: true });
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
      default:
        break;
    }
  }

  private async spawnSession(msg: Extract<RouterToWorker, { type: 'spawn' }>): Promise<void> {
    const provision = msg.provision ?? { isolation: 'worktree', teardown: 'on_session_end' };
    const worktree = await this.provision(msg, provision);

    // The session config is written locally, not shipped from the Router: the
    // MCP bearer and the GitHub token are per session, and a config file shared
    // across sessions would mean one leaked worktree exposes all of them.
    const configDir = resolve(this.args.workdir, 'config', slug(msg.work_item));
    mkdirSync(configDir, { recursive: true });

    const mcpConfig = {
      mcpServers: {
        github: {
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', '-e', 'GITHUB_TOOLSETS',
                 'ghcr.io/github/github-mcp-server'],
          env: {
            GITHUB_TOOLSETS: 'repos,issues,pull_requests,actions',
            GITHUB_PERSONAL_ACCESS_TOKEN: msg.github_token,
          },
        },
        gquay: {
          type: 'http',
          url: msg.mcp_url,
          headers: { Authorization: `Bearer ${msg.mcp_token}` },
        },
        'agent-locks': {
          command: 'npx',
          args: ['-y', 'agent-locks'],
          env: { AGENT_LOCKS_AGENT_ID: msg.work_item },
        },
      },
    };
    const mcpPath = resolve(configDir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', msg.model,
      '--mcp-config', mcpPath,
      '--permission-mode', 'acceptEdits',
    ];
    if (msg.resume_session_id) args.push('--resume', msg.resume_session_id);

    const child = spawn('claude', args, {
      cwd: worktree,
      env: {
        ...process.env,
        GQUAY_WORK_ITEM: msg.work_item,
        GQUAY_REPO: msg.repo,
        GQUAY_BRANCH: msg.branch,
        GQUAY_SCOPES: msg.scopes.join(' '),
        GITHUB_PERSONAL_ACCESS_TOKEN: msg.github_token,
      },
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

  stop(): void {
    this.stopping = true;
    for (const child of this.sessions.values()) child.kill('SIGTERM');
    this.ws?.close();
  }
}

function slug(workItemKey: string): string {
  return workItemKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function main(): void {
  initLogger();
  const args = parseArgs(process.argv.slice(2));
  const worker = new Worker(args);
  worker.connect();

  process.on('SIGINT', () => {
    worker.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    worker.stop();
    process.exit(0);
  });
}

main();
