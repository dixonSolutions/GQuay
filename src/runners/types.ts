/**
 * Execution targets — the pluggable half of the design.
 *
 * The Router is the control plane; *where* a session actually runs is a separate
 * decision. Four kinds:
 *
 *   process       on the Router host                      parks   default
 *   dispatch      a worker machine that dials out         parks   code that must not leave a network
 *   container     Docker/Podman, host or worker           parks   untrusted repos, isolation, parallelism
 *   claude_cloud  Claude Code on the web sandbox          NO      throwaway tasks, no local env needed
 *
 * `parking` is the property that actually separates them. A target that can
 * hold an `await_events` call for hours keeps one session alive across many
 * GitHub events. A cloud sandbox cannot: it is created at session start and
 * destroyed at the end, so it runs fire-and-forget — spawn per event, work,
 * push, exit — and every later comment is a fresh spawn or a `--resume`.
 */

export type TargetKind = 'process' | 'dispatch' | 'container' | 'claude_cloud';

export interface SpawnRequest {
  workItemKey: string;
  repo: string;
  /** Issue or PR number, for logging and branch naming. */
  number: number;
  model: string;
  branch: string;
  /** Absolute path on the executing host. Undefined for cloud. */
  worktree?: string;
  /** The opening prompt — assembled context for a spawn, or the comment on a resume. */
  prompt: string;
  /** Bearer for this session's MCP connection back to the Router. */
  mcpToken: string;
  /** Absolute URL of the Router's MCP endpoint, as the *executing host* sees it. */
  mcpUrl: string;
  /** GitHub App installation token, handed to the GitHub MCP server. */
  githubToken: string;
  /** Resolved comms scope grants. */
  scopes: string[];
  /**
   * Branch-scoped push proxy URL for this session's `origin` push remote.
   * Set for every target with a local checkout. The Router points the worktree
   * at it directly; a dispatch worker is told the URL and does it itself.
   */
  pushRemoteUrl?: string;
  /** Set to continue an existing transcript rather than start fresh. */
  resumeSessionId?: string;
  /** Extra environment for the runner process. */
  env?: Record<string, string>;
}

export interface RunnerHandle {
  readonly target: string;
  readonly workItemKey: string;
  /** Present for `process` and `container` targets running on this host. */
  readonly pid?: number;
  /** Present for `dispatch` — which worker holds the session. */
  readonly workerId?: string;
  /** Claude Code session id, once observed on the output stream. */
  sessionId?: string;
  /** Terminate the session. Idempotent. */
  kill(reason: string): Promise<void>;
  /** Resolves when the session exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface Capacity {
  used: number;
  max: number;
}

export interface ExecutionTarget {
  readonly name: string;
  readonly kind: TargetKind;
  /** Whether this target can hold a parked `await_events` call. */
  readonly parking: boolean;
  capacity(): Capacity;
  /** True when a session can be started right now. */
  available(): boolean;
  spawn(req: SpawnRequest): Promise<RunnerHandle>;
}

/** Emitted as the Claude Code session produces output, for the Router's log. */
export interface RunnerEvent {
  workItemKey: string;
  kind: 'session_id' | 'stdout' | 'stderr' | 'exit';
  data: string;
}
