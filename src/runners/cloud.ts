/**
 * `kind: claude_cloud` — a session on the Claude Code web sandbox.
 *
 * The weakest target, and still useful: a self-contained issue on a public repo
 * when every local slot is busy.
 *
 * It cannot park. A cloud session runs in an ephemeral Anthropic-managed VM,
 * created at session start and destroyed at the end, with an environment
 * snapshot that expires after roughly a week. A tool call held open for hours
 * is not a safe bet against that lifecycle, and the sandbox cannot reach a
 * private network in any case. So this target runs **fire-and-forget**: spawn
 * per event, work, push to its branch, exit. Every subsequent comment is a
 * fresh spawn or a `--resume`, which is exactly the model §3(e) describes.
 *
 * Two consequences the Router enforces rather than hopes for:
 *   - `parking` is false, so the dispatcher never routes a long-lived
 *     conversation here and the Stop-hook park is not configured for it.
 *   - The Router's MCP endpoint must be a public HTTPS URL and must be in the
 *     session's network allowlist; the sandbox cannot reach private, internal
 *     or link-local addresses. `available()` refuses to pretend otherwise.
 *
 * There is no documented API for launching a web session from a third-party
 * process, so the launch itself is delegated to a command you configure. That
 * keeps this file honest: it orchestrates, it does not invent an endpoint.
 */

import { spawn } from 'node:child_process';
import { childLogger } from '../log.js';
import { writeSessionConfig, baseEnv } from './session.js';
import type { SessionConfigOptions } from './session.js';
import { wireStreams } from './process.js';
import type { Capacity, ExecutionTarget, RunnerHandle, SpawnRequest } from './types.js';

const log = childLogger('runner-cloud');

export interface CloudTargetOptions extends SessionConfigOptions {
  name: string;
  maxConcurrent: number;
  /**
   * argv template for launching a cloud session. `{{placeholders}}` are
   * substituted from the spawn request. Example:
   *   ["claude", "--cloud", "--repo", "{{repo}}", "--branch", "{{branch}}",
   *    "--model", "{{model}}", "--mcp-config", "{{mcp_config}}"]
   */
  launchCommand?: string[];
  /** The Router's public HTTPS origin, as the sandbox must be able to reach it. */
  publicUrl: string;
  onOutput?: (workItemKey: string, stream: 'stdout' | 'stderr', line: string) => void;
  onSessionId?: (workItemKey: string, sessionId: string) => void;
  onExit?: (workItemKey: string, code: number | null, signal: string | null) => void;
}

export class CloudTarget implements ExecutionTarget {
  readonly kind = 'claude_cloud' as const;
  /** Never true. See module header. */
  readonly parking = false;
  readonly name: string;

  private readonly running = new Map<string, CloudHandle>();

  constructor(private readonly opts: CloudTargetOptions) {
    this.name = opts.name;
  }

  capacity(): Capacity {
    return { used: this.running.size, max: this.opts.maxConcurrent };
  }

  available(): boolean {
    if (this.running.size >= this.opts.maxConcurrent) return false;
    if (!this.opts.launchCommand?.length) return false;
    return isPubliclyReachable(this.opts.publicUrl);
  }

  async spawn(req: SpawnRequest): Promise<RunnerHandle> {
    if (!this.opts.launchCommand?.length) {
      throw new Error(
        `Target "${this.name}" is kind: claude_cloud but sets no launch_command. ` +
          `There is no documented API for starting a web session from the Router, so the ` +
          `launch is delegated to a command you configure — see docs/03-execution-targets.md.`,
      );
    }
    if (!isPubliclyReachable(this.opts.publicUrl)) {
      throw new Error(
        `public_url is ${this.opts.publicUrl}, which a cloud sandbox cannot reach. ` +
          `Cloud sessions need the Router on a public HTTPS endpoint, and in the session's ` +
          `network allowlist.`,
      );
    }

    const paths = writeSessionConfig(req, this.opts);
    const argv = this.opts.launchCommand.map((part) =>
      part
        .replace(/\{\{repo\}\}/g, req.repo)
        .replace(/\{\{branch\}\}/g, req.branch)
        .replace(/\{\{model\}\}/g, req.model)
        .replace(/\{\{work_item\}\}/g, req.workItemKey)
        .replace(/\{\{mcp_config\}\}/g, paths.mcpConfigPath)
        .replace(/\{\{settings\}\}/g, paths.settingsPath),
    );

    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, {
      env: { ...process.env, ...baseEnv(req) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle = new CloudHandle(this.name, req.workItemKey, child, () => {
      this.running.delete(req.workItemKey);
    });
    this.running.set(req.workItemKey, handle);
    wireStreams(handle, child, req, this.opts);

    child.stdin?.write(req.prompt);
    child.stdin?.end();

    log.info({ workItem: req.workItemKey, mode: 'fire-and-forget' }, 'cloud session launched');
    return handle;
  }
}

class CloudHandle implements RunnerHandle {
  sessionId?: string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(
    readonly target: string,
    readonly workItemKey: string,
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
    log.info({ workItem: this.workItemKey, reason }, 'terminating cloud launcher');
    this.child.kill('SIGTERM');
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
}

/**
 * The sandbox cannot resolve private, internal, or link-local addresses. This
 * catches the common misconfiguration — a `public_url` of `localhost` or an
 * RFC1918 address — before a session is launched that can never phone home.
 */
export function isPubliclyReachable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^127\./.test(host) || host === '::1') return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}
