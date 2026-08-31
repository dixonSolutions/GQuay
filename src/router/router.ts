/**
 * The GQuay Router — the control plane.
 *
 * It receives GitHub webhooks, owns the work-item registry, and decides for
 * every event whether to spawn a session, deliver into a live one, resume a
 * parked one, terminate, or drop it. The MCP server is its agent-facing side
 * and shares this process; the Hook Bus is a separate listener that calls back
 * into these same methods.
 *
 * The routing table (§2.4 of the design) is implemented in `handleEvent`. Two
 * of its rows are not conveniences:
 *
 *   - **The bot-actor guard.** Without it the agent's own comment raises a
 *     webhook that delivers to the agent, forever.
 *   - **The write-access guard.** Issue bodies and comments are
 *     attacker-controlled text flowing into an agent that holds a GitHub App
 *     token. Only actors with write access are acted on; everything else is
 *     logged and dropped.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { childLogger } from '../log.js';
import type { RouterConfig, Secrets } from '../config.js';
import { GitHubApi } from '../github/api.js';
import type { AppAuthOptions } from '../github/app.js';
import type { NormalisedEvent } from '../github/events.js';
import { ExecutionPlane, WorkerRegistry } from '../runners/index.js';
import { DispatchTarget } from '../runners/dispatch.js';
import type { WorkerToRouter } from '../runners/dispatch.js';
import { ParkingLot } from '../mcp/parking.js';
import type { McpDeps } from '../mcp/server.js';
import { TeamsRelay } from '../teams/relay.js';
import type { Severity } from '../teams/cards.js';
import { PushProxy, proxyRemoteUrl } from './pushProxy.js';
import { KeyedQueue } from './queue.js';
import { buildSpawnPrompt, buildResumePrompt } from './prompt.js';
import { resolveRepoConfig, invalidateFileConfig, parseDuration } from './repoConfig.js';
import type { RepoConfig } from './repoConfig.js';
import { tryApprove } from './mergeGate.js';
import { resolveGrants } from '../mcp/comms.js';
import { frameEvents } from '../mcp/framing.js';
import { readLocks, findConflicts, describeLock } from '../mcp/locks.js';
import { ensureMirror, ensureWorktree, removeWorktree, branchFor, gitCommonDir, mirrorPath } from '../git.js';
import * as registry from '../state/registry.js';
import type { WorkItem, WorkItemRef } from '../state/registry.js';
import { enqueue } from '../state/events.js';
import type { DeliveredEvent, EventKind } from '../state/events.js';
import { deposit, inboxPath } from '../state/inbox.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const log = childLogger('router');

/** Permission levels the Router will act on at all. */
const ACTING_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

export type Outcome = 'spawn' | 'deliver' | 'resume' | 'terminate' | 'ignore' | 'error';

export interface RouterOptions {
  config: RouterConfig;
  secrets: Secrets;
  rootDir: string;
}

export class Router {
  readonly api: GitHubApi;
  readonly parking = new ParkingLot();
  readonly workers = new WorkerRegistry();
  readonly teams: TeamsRelay;
  readonly plane: ExecutionPlane;
  readonly pushProxy: PushProxy;

  private readonly queue = new KeyedQueue();
  private readonly repoConfigCache = new Map<string, RepoConfig>();
  private readonly appAuth: AppAuthOptions;

  constructor(private readonly opts: RouterOptions) {
    const { config, secrets } = opts;

    this.appAuth = {
      appId: config.github.app_id ?? '',
      privateKey: secrets.githubAppPrivateKey ?? '',
      apiBase: config.github.api_base,
    };
    this.api = new GitHubApi(this.appAuth);

    this.teams = new TeamsRelay({
      enabled: config.teams.enabled,
      ...(secrets.teamsWorkflowUrl ? { workflowUrl: secrets.teamsWorkflowUrl } : {}),
      severityFloor: config.teams.severity_floor,
    });

    this.pushProxy = new PushProxy({
      tokenForRepo: (repo) => this.tokenFor(repo),
    });

    this.plane = new ExecutionPlane({
      config,
      workers: this.workers,
      dataDir: config.paths.data,
      runnerDir: config.paths.runner,
      hookBusUrl: `http://${config.server.hook_bus_host}:${config.server.hook_bus_port}`,
      hookBusToken: secrets.hookBusToken,
      inboxFile: config.paths.inbox,
      onSessionId: (key, sessionId) => {
        registry.setSession(key, sessionId, this.plane.handleFor(key)?.pid);
        log.info({ workItem: key, sessionId }, 'session id captured');
      },
      onExit: (key, code, signal) => {
        void this.onSessionExit(key, code, signal);
      },
      onOutput: (key, stream, line) => {
        if (stream === 'stderr') log.warn({ workItem: key, line: line.slice(0, 500) }, 'agent stderr');
        else log.trace({ workItem: key, line: line.slice(0, 500) }, 'agent stdout');
      },
    });
  }

  /** Host configuration. Read-only to everything outside the Router. */
  get config(): RouterConfig {
    return this.opts.config;
  }

  // ── Auth helpers ────────────────────────────────────────────────────────────

  private async tokenFor(repo: string): Promise<string> {
    const { tokenForRepo } = await import('../github/app.js');
    return tokenForRepo(this.appAuth, repo);
  }

  /** `allowed_repos` is the hard perimeter, checked before anything else. */
  private repoAllowed(repo: string): boolean {
    const patterns = this.opts.config.github.allowed_repos;
    if (patterns.includes('*')) return true;
    return patterns.some((p) => {
      const re = new RegExp(
        `^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`,
      );
      return re.test(repo);
    });
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  async repoConfigFor(workItemKey: string): Promise<RepoConfig> {
    const cached = this.repoConfigCache.get(workItemKey);
    if (cached) return cached;
    const item = registry.getWorkItem(workItemKey);
    if (!item) throw new Error(`unknown work item ${workItemKey}`);
    const { config } = await resolveRepoConfig(this.api, { repo: item.repo });
    this.repoConfigCache.set(workItemKey, config);
    return config;
  }

  /** Drop every cached repo config. Variables emit no change webhook. */
  invalidateConfigCache(): void {
    this.repoConfigCache.clear();
    log.info('repo config cache cleared');
  }

  /** Dependency bundle handed to each per-session MCP server. */
  mcpDeps(): McpDeps {
    return {
      parking: this.parking,
      teams: this.teams,
      github: this.api,
      repoConfigFor: (key) => this.repoConfigFor(key),
      lockDirFor: (key) => this.lockDirFor(key),
      defaultParkTimeoutMs: this.opts.config.idle.park_timeout_seconds * 1000,
      staleLockAfterMs: this.opts.config.coordination.stale_lock_after_hours * 3_600_000,
      normaliseLockCase: this.opts.config.coordination.normalise_case,
      onAsk: async (item, question) => {
        // `ask` is asynchronous: it starts the awaiting_input clock and returns
        // a ticket. The answer comes back through the delivery path, because
        // people answer on GitHub.
        registry.setState(item.key, 'awaiting_input');
        await this.api
          .comment(item.repo, item.number, `❓ **The agent needs a decision**\n\n${question}`)
          .catch(() => undefined);
      },
    };
  }

  // ── Dispatch workers ────────────────────────────────────────────────────────

  /**
   * Which dispatch target a presented worker token belongs to. Tokens are read
   * from the environment at boot (never from `router.yml`), so a worker proving
   * possession of one is proving it was provisioned by whoever runs the host.
   */
  targetForWorkerToken(token: string): string | undefined {
    for (const [name, spec] of Object.entries(this.opts.config.runner.targets)) {
      if (spec.kind !== 'dispatch' || !spec.worker_token_env) continue;
      const expected = this.opts.secrets.workerTokens[spec.worker_token_env];
      if (expected && constantTimeEquals(token, expected)) return name;
    }
    return undefined;
  }

  onWorkerMessage(msg: WorkerToRouter): void {
    for (const target of this.plane.list()) {
      if (target instanceof DispatchTarget) target.onWorkerMessage(msg);
    }
    if (msg.type === 'state' && msg.session_id) {
      registry.setSession(msg.work_item, msg.session_id);
    }
    if (msg.type === 'output' && msg.stream === 'stderr') {
      log.warn({ workItem: msg.work_item, line: msg.line.slice(0, 500) }, 'worker stderr');
    }
  }

  onWorkerLost(orphaned: string[]): void {
    for (const target of this.plane.list()) {
      if (target instanceof DispatchTarget) target.onWorkerLost(orphaned);
    }
    for (const key of orphaned) {
      // The worktree lives on that worker and nowhere else, so the item stays
      // pinned to it and is resumed when the worker comes back.
      registry.setState(key, 'dead', { error: 'dispatch worker disconnected' });
      this.parking.release(key, 'worker lost');
    }
  }

  async lockDirFor(workItemKey: string): Promise<string | undefined> {
    const item = registry.getWorkItem(workItemKey);
    if (!item?.worktree) return undefined;
    return gitCommonDir(item.worktree);
  }

  // ── The routing table (§2.4) ────────────────────────────────────────────────

  async handleEvent(event: NormalisedEvent): Promise<Outcome> {
    if (!event.repo || !this.repoAllowed(event.repo)) {
      log.debug({ repo: event.repo }, 'repo outside allowed_repos — ignored');
      return 'ignore';
    }

    // Loop guard. Not optional: the agent's own comment would otherwise deliver
    // to the agent, forever.
    if (event.actorIsBot) {
      log.debug({ actor: event.actor, kind: event.kind }, 'bot actor — ignored');
      return 'ignore';
    }

    // A push to the default branch may have changed .github/gquay.yml. There is
    // no webhook for a *Variable* change, but there is one for a file change.
    if (event.kind === 'push') {
      if (event.changedPaths.some((p) => p === '.github/gquay.yml')) {
        invalidateFileConfig(event.repo);
        this.repoConfigCache.clear();
      }
      return 'ignore';
    }

    if (!event.ref) return 'ignore';
    const key = registry.workItemKey(event.ref);

    // Everything past here mutates a specific work item, so it is serialised.
    return this.queue.run(key, () => this.routeWithRetry(key, event));
  }

  /**
   * Route with a bounded retry.
   *
   * The ingress acknowledges a delivery with 202 before routing, because
   * GitHub's delivery timeout is short and spawning a session is not. That
   * trade has a consequence: GitHub will never retry this delivery, so a
   * transient failure here — the API rate-limiting the permission check, a
   * momentary DNS blip, the App token endpoint being slow — would silently
   * drop a real comment.
   *
   * So transient failures are retried in-process with backoff, and only a
   * permanent failure gives up. The distinction matters: retrying a
   * `no capacity` error just burns the same slot again, while retrying a
   * timed-out permission check usually succeeds.
   */
  private async routeWithRetry(key: string, event: NormalisedEvent): Promise<Outcome> {
    const delays = [2_000, 10_000, 30_000];

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.route(key, event);
      } catch (err) {
        const error = err as Error;
        if (!isTransient(error) || attempt >= delays.length) {
          log.error(
            { key, kind: event.kind, attempt, err: error.message },
            'giving up on event',
          );
          await this.alertDroppedEvent(event, error);
          return 'error';
        }
        log.warn(
          { key, kind: event.kind, attempt, delayMs: delays[attempt], err: error.message },
          'transient failure routing event — retrying',
        );
        await sleep(delays[attempt]!);
      }
    }
  }

  /**
   * A dropped event is invisible to the person who wrote the comment, so it has
   * to be visible somewhere else. This posts to the incidents-severity channel
   * and, when the repo is reachable at all, back on the thread itself.
   */
  private async alertDroppedEvent(event: NormalisedEvent, error: Error): Promise<void> {
    await this.teams
      .post({
        title: `GQuay dropped an event on ${event.repo}`,
        severity: 'error',
        summary:
          `A ${event.kind} from @${event.actor} could not be routed and has been given up on.`,
        detail: error.message,
        ...(event.url ? { actions: [{ title: 'Open on GitHub', url: event.url }] } : {}),
      })
      .catch(() => undefined);
  }

  private async route(key: string, event: NormalisedEvent): Promise<Outcome> {
    const { config: repoConfig } = await resolveRepoConfig(this.api, {
      repo: event.repo,
      labels: event.labels,
      onConfigError: (msg) => void this.alertConfigError(event.repo, msg),
    });

    // Checked at event receipt, not only at spawn, so flipping GQUAY_ENABLED
    // stops new work immediately while letting running sessions finish.
    if (!repoConfig.enabled) {
      log.info({ repo: event.repo }, 'GQUAY_ENABLED is false — event dropped');
      return 'ignore';
    }

    const existing = registry.getWorkItem(key);

    switch (event.kind) {
      // ── Terminal events ─────────────────────────────────────────────────────
      case 'issue.closed':
      case 'issue.deleted':
        if (!existing) return 'ignore';
        await this.terminate(key, event.kind === 'issue.deleted' ? 'issue deleted' : 'issue closed');
        await this.notify(repoConfig, event.kind === 'issue.deleted' ? 'issue.deleted' : 'issue.closed', {
          title: `${key} closed`,
          summary: `Session released.`,
          url: event.url,
        });
        return 'terminate';

      case 'pr.closed':
        if (!existing) return 'ignore';
        await this.terminate(key, 'pull request closed unmerged');
        await this.notify(repoConfig, 'pr.closed_unmerged', {
          title: `${key} closed without merging`,
          summary: 'Session released; branch left in place.',
          url: event.url,
        });
        return 'terminate';

      case 'pr.merged':
        await this.notify(repoConfig, 'pr.merged', {
          title: `${key} merged`,
          summary: `Merged by @${event.actor}.`,
          url: event.url,
        });
        if (existing) await this.terminate(key, 'pull request merged');
        return 'terminate';

      // ── Triggers that can start work ────────────────────────────────────────
      case 'issue.opened':
      case 'issue.labeled': {
        if (!event.labels.includes(repoConfig.trigger_label)) {
          log.debug({ key, label: repoConfig.trigger_label }, 'trigger label absent — ignored');
          return 'ignore';
        }
        if (!(await this.actorMayAct(event))) return 'ignore';
        if (existing && this.plane.isRunning(key)) {
          log.debug({ key }, 'already running');
          return 'ignore';
        }
        await this.spawn(event.ref!, event, repoConfig);
        return 'spawn';
      }

      case 'pr.opened': {
        // A PR opened by a human with no linked issue gets its own fresh
        // session, owned by that PR key.
        if (existing?.linked_key) return 'ignore';
        if (!event.labels.includes(repoConfig.trigger_label)) return 'ignore';
        if (!(await this.actorMayAct(event))) return 'ignore';
        await this.spawn(event.ref!, event, repoConfig);
        return 'spawn';
      }

      // ── Conversation ────────────────────────────────────────────────────────
      case 'issue.comment':
      case 'pr.comment':
      case 'pr.review':
      case 'pr.review_comment':
      case 'pr.review_requested': {
        const permission = await this.actorMayAct(event);
        if (!permission) return 'ignore';

        // Merge approval is matched here — by the Router, against the actor's
        // real permission level — and never inferred from the model's reading
        // of the text.
        if (event.body && (event.kind === 'pr.comment' || event.kind === 'pr.review')) {
          const attempt = await tryApprove(this.api, {
            prKey: key,
            repo: event.repo,
            actor: event.actor,
            body: event.body,
            approvalPhrase: this.opts.config.merge.approval_phrase,
            ttlMinutes: this.opts.config.merge.approval_ttl_minutes,
          });
          if (attempt.matched && !attempt.refusedReason) {
            await this.notify(repoConfig, 'gquay.merge_requested', {
              title: `Merge approved on ${key}`,
              summary: `@${event.actor} approved a merge. Valid for ${this.opts.config.merge.approval_ttl_minutes} minutes.`,
              url: event.url,
            });
          } else if (attempt.refusedReason) {
            await this.api.comment(event.repo, event.ref!.number, attempt.refusedReason);
          }
        }

        if (!existing) {
          // A comment on an item GQuay has never seen. Only start work if the
          // trigger label is present — otherwise this is a human conversation.
          if (!event.labels.includes(repoConfig.trigger_label)) return 'ignore';
          await this.spawn(event.ref!, event, repoConfig);
          return 'spawn';
        }

        return this.deliver(existing, event, repoConfig, permission);
      }

      case 'ci.completed': {
        if (!existing) return 'ignore';
        if (event.conclusion && event.conclusion !== 'success') {
          await this.notify(repoConfig, 'ci.failed', {
            title: `CI ${event.conclusion} on ${key}`,
            summary: `${event.workflowName ?? 'workflow'} finished ${event.conclusion}.`,
            url: event.url,
          });
        }
        return this.deliver(existing, event, repoConfig);
      }

      default:
        return 'ignore';
    }
  }

  /**
   * §11 rule 1 — only actors with write access are acted on.
   *
   * The permission level is returned, not just the verdict: the framing quotes
   * it to the agent so a request can be weighed against who is actually making
   * it, and re-querying it later would be a second round trip for a fact this
   * call already established.
   */
  private async actorMayAct(event: NormalisedEvent): Promise<string | undefined> {
    if (!event.actor) return undefined;
    const permission = await this.api.permissionLevel(event.repo, event.actor);
    if (ACTING_PERMISSIONS.has(permission)) return permission;
    log.warn(
      { actor: event.actor, permission, repo: event.repo, kind: event.kind },
      'event from actor without write access — dropped',
    );
    return undefined;
  }

  // ── Delivery (§3) ───────────────────────────────────────────────────────────

  /**
   * Get an event into the session that owns this work item.
   *
   * Three paths, in order of fidelity: the parked `await_events` call (same
   * context window, no restart), the asyncRewake inbox (agent is mid-task and
   * not in the call), and `--resume` (nothing is running).
   */
  private async deliver(
    item: WorkItem,
    event: NormalisedEvent,
    repoConfig: RepoConfig,
    actorPermission?: string,
  ): Promise<Outcome> {
    // An issue and its PR share a session; deliver to whichever key owns it.
    const owner = item.linked_key ? (registry.getWorkItem(item.linked_key) ?? item) : item;
    const target = owner.session_id ? owner : item;

    const delivered = toDeliveredEvent(item.key, event, actorPermission);
    enqueue(item.key, delivered.kind, delivered);

    const running = this.plane.isRunning(target.key);
    const woken = this.parking.notify(item.key);

    if (woken > 0) {
      log.info({ workItem: item.key }, 'delivered into parked session');
      registry.setState(target.key, 'working');
      return 'deliver';
    }

    if (running) {
      // Working, not parked — reachable only between tool calls. The inbox file
      // is read by the asyncRewake hook, which exits 2 and surfaces this as a
      // system reminder mid-task.
      deposit(this.opts.config.paths.inbox, item.key, delivered);
      log.info({ workItem: item.key }, 'deposited to inbox for asyncRewake');
      return 'deliver';
    }

    // Nothing running. Resume if we have a transcript, spawn otherwise.
    if (target.session_id) {
      await this.resume(target, delivered, repoConfig);
      return 'resume';
    }
    await this.spawn({ kind: item.kind, repo: item.repo, number: item.number }, event, repoConfig);
    return 'spawn';
  }

  // ── Spawn (§3e) ─────────────────────────────────────────────────────────────

  async spawn(ref: WorkItemRef, event: NormalisedEvent, repoConfig: RepoConfig): Promise<WorkItem> {
    const key = registry.workItemKey(ref);
    const { config } = this.opts;

    if (!this.plane.hasGlobalCapacity()) {
      log.warn({ key }, 'at global concurrency limit — deferring');
      await this.notify(repoConfig, 'gquay.error', {
        title: `${key} deferred`,
        summary: `All ${config.runner.max_concurrent_total} session slots are busy.`,
        severity: 'warn',
      });
      throw new Error('no capacity');
    }

    const existing = registry.getWorkItem(key);
    const labels = event.labels;
    const readOnly = labels.includes('gquay:read-only');

    const { target, reason } = this.plane.select({
      repo: ref.repo,
      labels,
      pinned: existing?.target ?? null,
      preferred: repoConfig.routing.preferred_target,
    });
    if (!target.available()) {
      throw new Error(`target ${target.name} has no free capacity`);
    }

    const model = repoConfig.model.default;
    const branch = existing?.branch ?? branchFor(key);
    const scopes = resolveGrants(repoConfig);
    const mcpToken = randomUUID();

    registry.createWorkItem({
      ...ref,
      model,
      target: target.name,
      ...(event.actor ? { ownerLogin: event.actor } : {}),
      ...(event.title ? { title: event.title } : {}),
      branch,
      grantedScopes: scopes,
    });
    registry.update(key, { mcp_token: mcpToken });
    this.repoConfigCache.set(key, repoConfig);

    const githubToken = await this.tokenFor(ref.repo);

    // Cloud sessions have no local checkout; every other target does.
    let worktree: string | undefined;
    let peerClaims: string[] = [];
    let conflictWarning: string | undefined;

    if (target.kind !== 'claude_cloud') {
      const mirror = await ensureMirror(config.paths.mirrors, ref.repo, githubToken);
      const baseBranch = await this.api.defaultBranch(ref.repo);
      worktree = await ensureWorktree({
        worktreesDir: config.paths.worktrees,
        mirror,
        workItemKey: key,
        branch,
        baseBranch,
      });
      registry.update(key, { worktree });

      // Point origin at the branch-scoped push proxy. The agent never holds a
      // credential that can write to the default branch.
      await this.pointOriginAtProxy(worktree, ref.repo, mcpToken);

      // Admission control: check conflicts *before* the session starts, so an
      // overlap is caught before an agent writes half a refactor.
      const common = await gitCommonDir(worktree);
      if (common) {
        const locks = readLocks(common).filter((l) => l.agentId !== key);
        peerClaims = locks.filter((l) => l.status === 'active').map(describeLock);
        const overlapping = findConflicts(locks, guessScope(labels, ref), {
          selfAgentId: key,
          normaliseCase: config.coordination.normalise_case,
          staleAfterMs: config.coordination.stale_lock_after_hours * 3_600_000,
        });
        if (overlapping.length > 0) {
          const policy = repoConfig.coordination.on_conflict;
          conflictWarning =
            `${overlapping.map((c) => c.pattern).join(', ')} is already claimed by ` +
            `${overlapping.map((c) => c.lock.agentId ?? c.lock.title).join(', ')}.`;
          if (policy === 'queue') {
            log.warn({ key, conflictWarning }, 'conflicting claim — queued');
            throw new Error(`queued behind conflicting claim: ${conflictWarning}`);
          }
          if (policy === 'notify') {
            await this.notify(repoConfig, 'gquay.needs_input', {
              title: `${key} overlaps live work`,
              summary: conflictWarning,
              severity: 'attention',
              url: event.url,
            });
          }
        }
      }
    }

    // Assemble the full picture. This is the expensive part of a spawn and the
    // reason a resume is cheaper — the transcript already holds it.
    const issue = ref.kind === 'issue' ? await this.api.getIssue(ref.repo, ref.number) : undefined;
    const pr = ref.kind === 'pr' ? await this.api.getPullRequest(ref.repo, ref.number) : undefined;
    const comments = await this.api.listIssueComments(ref.repo, ref.number);
    const { sources } = await resolveRepoConfig(this.api, { repo: ref.repo, labels });

    const prompt = buildSpawnPrompt({
      workItemKey: key,
      repo: ref.repo,
      branch,
      ...(issue ? { issue } : {}),
      ...(pr ? { pr } : {}),
      comments,
      labels,
      peerClaims,
      config: repoConfig,
      configSources: sources,
      grantedScopes: scopes,
      readOnly,
      ...(conflictWarning ? { conflictWarning } : {}),
    });

    const handle = await target.spawn({
      workItemKey: key,
      repo: ref.repo,
      number: ref.number,
      model,
      branch,
      ...(worktree ? { worktree } : {}),
      prompt,
      mcpToken,
      mcpUrl: `${config.public_url.replace(/\/$/, '')}/mcp`,
      githubToken,
      scopes,
      env: {
        GQUAY_INBOX_FILE: inboxPath(config.paths.inbox, key),
        GQUAY_PARK_TIMEOUT_S: String(config.idle.park_timeout_seconds),
      },
    });

    this.plane.track(key, handle);
    registry.setState(key, 'working', { pid: handle.pid ?? null, worker_id: handle.workerId ?? null });

    log.info({ key, target: target.name, reason, model, branch }, 'session spawned');
    await this.notify(repoConfig, 'gquay.started', {
      title: `Picked up ${key}`,
      summary: `Model ${model}, branch \`${branch}\`, target ${target.name}.`,
      url: event.url,
    });

    return registry.getWorkItem(key)!;
  }

  // ── Resume (§3e) ────────────────────────────────────────────────────────────

  async resume(item: WorkItem, event: DeliveredEvent, repoConfig: RepoConfig): Promise<void> {
    if (!item.session_id) throw new Error(`cannot resume ${item.key} — no session id`);

    const target = this.plane.get(item.target ?? '') ?? this.plane.select({ repo: item.repo, labels: [] }).target;
    const githubToken = await this.tokenFor(item.repo);
    const mcpToken = item.mcp_token ?? randomUUID();
    if (!item.mcp_token) registry.update(item.key, { mcp_token: mcpToken });

    const prompt = buildResumePrompt(frameEvents([event], { workItem: item.key }));

    const handle = await target.spawn({
      workItemKey: item.key,
      repo: item.repo,
      number: item.number,
      model: item.model,
      branch: item.branch ?? branchFor(item.key),
      ...(item.worktree ? { worktree: item.worktree } : {}),
      prompt,
      mcpToken,
      mcpUrl: `${this.opts.config.public_url.replace(/\/$/, '')}/mcp`,
      githubToken,
      scopes: registry.grantedScopes(item),
      resumeSessionId: item.session_id,
      env: {
        GQUAY_INBOX_FILE: inboxPath(this.opts.config.paths.inbox, item.key),
        GQUAY_PARK_TIMEOUT_S: String(this.opts.config.idle.park_timeout_seconds),
      },
    });

    this.plane.track(item.key, handle);
    registry.setState(item.key, 'working', { pid: handle.pid ?? null });
    log.info({ key: item.key, sessionId: item.session_id }, 'session resumed');
    void repoConfig;
  }

  // ── Termination ─────────────────────────────────────────────────────────────

  async terminate(key: string, reason: string): Promise<void> {
    const item = registry.getWorkItem(key);
    this.parking.release(key, reason);
    await this.plane.kill(key, reason);
    registry.setState(key, 'dead', { error: reason });
    this.repoConfigCache.delete(key);

    // Release the worktree. Nothing cleans this up for you.
    if (item?.worktree) {
      const mirror = mirrorPath(this.opts.config.paths.mirrors, item.repo);
      await removeWorktree(mirror, this.opts.config.paths.worktrees, key).catch((err: Error) => {
        log.warn({ key, err: err.message }, 'worktree cleanup failed');
      });
    }
    log.info({ key, reason }, 'work item terminated');
  }

  private async onSessionExit(key: string, code: number | null, signal: string | null): Promise<void> {
    const item = registry.getWorkItem(key);
    if (!item) return;
    if (item.state === 'dead') return;

    const clean = code === 0;
    registry.setState(key, clean ? 'parked' : 'dead', {
      ...(clean ? {} : { error: `exit code ${code ?? 'null'} signal ${signal ?? 'none'}` }),
    });
    this.parking.release(key, 'session exited');
    log.info({ key, code, signal, clean }, 'session exited');

    if (!clean) {
      const repoConfig = await this.repoConfigFor(key).catch(() => undefined);
      if (repoConfig) {
        await this.notify(repoConfig, 'gquay.error', {
          title: `${key} exited unexpectedly`,
          summary: `Exit code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}.`,
          severity: 'error',
        });
      }
    }
  }

  // ── Teams ───────────────────────────────────────────────────────────────────

  /**
   * Every notification is a row in the repo's event matrix. Adding one is a
   * config edit, not a code change — which is the point of the matrix.
   */
  async notify(
    repoConfig: RepoConfig,
    eventName: string,
    card: { title: string; summary: string; detail?: string; url?: string; severity?: Severity },
  ): Promise<void> {
    const rule = repoConfig.teams.events[eventName];
    if (rule && !rule.notify) return;

    await this.teams.post({
      title: card.title,
      severity: card.severity ?? rule?.severity ?? 'info',
      summary: card.summary,
      ...(card.detail ? { detail: card.detail } : {}),
      ...(card.url ? { actions: [{ title: 'Open on GitHub', url: card.url }] } : {}),
    });
  }

  private async alertConfigError(repo: string, message: string): Promise<void> {
    log.error({ repo, message }, 'configuration error');
    await this.teams.post({
      title: `GQuay config problem in ${repo}`,
      severity: 'warn',
      summary: message,
    });
  }

  // ── Git remote ──────────────────────────────────────────────────────────────

  private async pointOriginAtProxy(worktree: string, repo: string, token: string): Promise<void> {
    const url = proxyRemoteUrl(this.opts.config.public_url, token, repo);
    try {
      await exec('git', ['remote', 'set-url', '--push', 'origin', url], { cwd: worktree });
      log.debug({ worktree, repo }, 'push remote pointed at branch-scoped proxy');
    } catch (err) {
      // A worktree whose push URL is wrong is a worktree that can push to main.
      // Better to fail the spawn than to run without the guard.
      throw new Error(`could not set the branch-scoped push remote: ${(err as Error).message}`);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Idle thresholds resolved from the repo config, in milliseconds. */
  idleThresholds(repoConfig: RepoConfig): {
    grace: number;
    nudge: number;
    escalate: number;
    park: number;
  } {
    return {
      grace: parseDuration(repoConfig.idle.idle_grace, this.opts.config.idle.idle_grace_minutes * 60_000),
      nudge: parseDuration(repoConfig.idle.nudge_after, this.opts.config.idle.nudge_after_minutes * 60_000),
      escalate: parseDuration(
        repoConfig.idle.escalate_after,
        this.opts.config.idle.escalate_after_minutes * 60_000,
      ),
      park: parseDuration(repoConfig.idle.park_after, this.opts.config.idle.park_after_hours * 3_600_000),
    };
  }

  async shutdown(): Promise<void> {
    this.parking.releaseAll('router shutting down');
    await this.plane.killAll('router shutting down');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDeliveredEvent(
  workItemKey: string,
  event: NormalisedEvent,
  actorPermission?: string,
): DeliveredEvent {
  const kind: EventKind =
    event.kind === 'pr.review'
      ? 'review'
      : event.kind === 'pr.review_comment'
        ? 'review_comment'
        : event.kind === 'ci.completed'
          ? 'ci'
          : 'comment';

  return {
    kind,
    work_item: workItemKey,
    ...(event.actor ? { author: event.actor } : {}),
    ...(event.authorAssociation ? { author_association: event.authorAssociation } : {}),
    ...(actorPermission ? { author_permission: actorPermission } : {}),
    ...(event.body ? { body: event.body } : {}),
    ...(event.url ? { url: event.url } : {}),
    ...(event.reviewState ? { review_state: event.reviewState } : {}),
    ...(event.path ? { path: event.path } : {}),
    ...(event.line !== undefined ? { line: event.line } : {}),
    ...(event.diffHunk ? { diff_hunk: event.diffHunk } : {}),
    ...(event.conclusion ? { conclusion: event.conclusion } : {}),
    ...(event.workflowName ? { workflow: event.workflowName } : {}),
    received_at: new Date().toISOString(),
  };
}

/**
 * A best-effort scope for the pre-spawn conflict check. `scope_source: labels`
 * is the default because it needs no cooperation from the issue author; the
 * other modes in the design (paths in the issue body, agent declares) trade
 * that for precision.
 */
function guessScope(labels: string[], ref: WorkItemRef): string {
  const area = labels.find((l) => l.startsWith('area:'));
  if (area) return `${area.slice('area:'.length)}/**`;
  return `${ref.repo.split('/')[1] ?? ''}/**`;
}

/** Constant-time comparison for worker tokens. */
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Which failures are worth retrying.
 *
 * Deliberately a denylist of *permanent* conditions rather than an allowlist of
 * transient ones: an unrecognised error is more likely to be a network hiccup
 * than a policy decision, and retrying a policy decision three times is
 * cheap while dropping a real comment is not.
 */
export function isTransient(err: Error): boolean {
  const message = err.message.toLowerCase();
  const permanent = [
    'no capacity',
    'queued behind conflicting claim',
    'has no free capacity',
    'no such work item',
    'unknown work item',
    'is not in the registry',
    'requires a worktree',
    'sets no launch_command',
    'branch-scoped push remote',
  ];
  return !permanent.some((p) => message.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
