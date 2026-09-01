/**
 * Host-side configuration — `router.yml` plus Tier 1 secrets from the environment.
 *
 * This is the *host* half of the four-tier config model (docs/06-configuration.md):
 * execution targets, routing rules, ports, paths, and the secrets that bootstrap
 * everything else. It carries credentials and image names, so it is deliberately
 * NOT read from the repository — per-repo settings live in `.github/gquay.yml`
 * and are resolved at spawn time by `router/repoConfig.ts`.
 *
 * The split matters for a specific reason: a repository can be edited by anyone
 * with write access to it, and an execution target names a machine and a token.
 * Letting a repo choose its own target would let a repo choose to run on a box
 * it was never granted.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ── Schema ────────────────────────────────────────────────────────────────────

const ProvisionSchema = z.object({
  isolation: z.enum(['worktree', 'container', 'none']).default('worktree'),
  mirror: z.string().optional(),
  setup: z.string().optional(),
  cache: z
    .object({
      paths: z.array(z.string()).default([]),
      key: z.string().optional(),
      ttl: z.string().default('7d'),
    })
    .optional(),
  teardown: z.enum(['on_session_end', 'keep_warm']).default('on_session_end'),
});

const TargetSchema = z.object({
  kind: z.enum(['process', 'dispatch', 'container', 'claude_cloud']),
  workdir: z.string().optional(),
  labels: z.array(z.string()).default([]),
  shell: z.string().optional(),
  image: z.string().optional(),
  network: z.string().optional(),
  max_concurrent: z.number().int().positive().default(3),
  /** Name of the env var holding this worker's shared token (dispatch only). */
  worker_token_env: z.string().optional(),
  /** claude_cloud cannot hold a parked tool call; see docs/01-architecture.md. */
  parking: z.boolean().default(true),
  /** container only — `docker` or `podman`. */
  engine: z.string().optional(),
  /**
   * claude_cloud only. There is no documented API for launching a web session
   * from a third-party process, so the launch is delegated to this argv.
   * `{{repo}}`, `{{branch}}`, `{{model}}`, `{{work_item}}`, `{{mcp_config}}`
   * and `{{settings}}` are substituted.
   */
  launch_command: z.array(z.string()).optional(),
  provision: ProvisionSchema.optional(),
});

const RoutingRuleSchema = z.object({
  match: z
    .object({
      repo: z.string().optional(),
      label: z.string().optional(),
      owner: z.string().optional(),
    })
    .default({}),
  target: z.string(),
});

const RouterConfigSchema = z.object({
  /** Public HTTPS origin GitHub and cloud sessions reach. Used to build MCP URLs. */
  public_url: z.string().url(),
  server: z
    .object({
      /** Ingress + MCP + worker WebSocket. Put a TLS terminator in front. */
      port: z.number().int().positive().default(8080),
      host: z.string().default('0.0.0.0'),
      /** Hook Bus. Loopback only — hook responses are latency-sensitive. */
      hook_bus_port: z.number().int().positive().default(8787),
      hook_bus_host: z.string().default('127.0.0.1'),
    })
    .default({}),
  paths: z
    .object({
      data: z.string().default('./data'),
      worktrees: z.string().default('./worktrees'),
      mirrors: z.string().default('./mirrors'),
      inbox: z.string().default('./data/inbox'),
      /** Directory the runner's `.claude/` overlay is materialised into. */
      runner: z.string().default('./runner'),
    })
    .default({}),
  github: z
    .object({
      app_id: z.string().optional(),
      private_key_path: z.string().optional(),
      /** Only these owners/repos are ever acted on, regardless of installation. */
      allowed_repos: z.array(z.string()).default(['*']),
      api_base: z.string().default('https://api.github.com'),
    })
    .default({}),
  runner: z
    .object({
      default: z.string().default('local'),
      targets: z.record(TargetSchema).default({}),
      /** Path to the `claude` binary on the Router host. */
      claude_bin: z.string().default('claude'),
      /** Hard ceiling across all targets. */
      max_concurrent_total: z.number().int().positive().default(8),
    })
    .default({}),
  routing: z.array(RoutingRuleSchema).default([]),
  idle: z
    .object({
      /** Park a session that has had nothing to do for this long. */
      idle_grace_minutes: z.number().default(10),
      nudge_after_minutes: z.number().default(20),
      escalate_after_minutes: z.number().default(120),
      park_after_hours: z.number().default(24),
      /** How long `await_events` holds a call before returning "nothing arrived". */
      park_timeout_seconds: z.number().default(540),
    })
    .default({}),
  merge: z
    .object({
      approval_ttl_minutes: z.number().default(15),
      approval_phrase: z.string().default('@gquay merge'),
    })
    .default({}),
  coordination: z
    .object({
      on_conflict: z.enum(['notify', 'queue', 'read_only', 'proceed']).default('notify'),
      stale_lock_after_hours: z.number().default(6),
      /** Lowercase every scope glob — Windows dispatch workers are case-blind. */
      normalise_case: z.boolean().default(true),
    })
    .default({}),
  teams: z
    .object({
      enabled: z.boolean().default(true),
      /** Env var holding the Workflows trigger URL. The whole URL is a secret. */
      workflow_url_env: z.string().default('TEAMS_WORKFLOW_URL'),
      thread_per_work_item: z.boolean().default(true),
      /** Drop anything below this severity before it reaches Teams. */
      severity_floor: z.enum(['info', 'success', 'attention', 'warn', 'error']).default('info'),
    })
    .default({}),
});

export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type ExecutionTargetConfig = z.infer<typeof TargetSchema>;
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

// ── Secrets (Tier 1) ──────────────────────────────────────────────────────────

/**
 * Secrets never live in `router.yml` and never in GitHub Actions Variables.
 * They cannot come from GitHub Secrets either: the REST API lists secrets
 * without revealing values, by design, and the Router is not an Actions job.
 */
export interface Secrets {
  anthropicApiKey?: string;
  /** Long-lived OAuth token from `claude setup-token`, backed by a Claude subscription. */
  claudeCodeOAuthToken?: string;
  githubAppPrivateKey?: string;
  githubWebhookSecret: string;
  hookBusToken: string;
  teamsWorkflowUrl?: string;
  /** Keyed by env var name, e.g. GQUAY_WORKER_TOKEN_KINGSPAN → token. */
  workerTokens: Record<string, string>;
}

// ── Loading ───────────────────────────────────────────────────────────────────

export interface LoadedConfig {
  config: RouterConfig;
  secrets: Secrets;
  configPath: string;
  rootDir: string;
}

let loaded: LoadedConfig | undefined;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `Missing required secret ${name}. Copy .env.example to .env and fill it in — ` +
        `see docs/02-deployment.md.`,
    );
  }
  return v;
}

/** Resolve a possibly-relative config path against the repo/install root. */
function abs(rootDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(rootDir, p);
}

export function loadConfig(configPath?: string): LoadedConfig {
  const rootDir = process.env.GQUAY_ROOT ?? process.cwd();
  const path = configPath ?? process.env.GQUAY_CONFIG ?? resolve(rootDir, 'router.yml');

  if (!existsSync(path)) {
    throw new Error(
      `No router config at ${path}. Copy router.example.yml to router.yml and edit it.`,
    );
  }

  const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
  const parsed = RouterConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${path}:\n${issues}`);
  }

  const config = parsed.data;

  // Normalise every path to absolute so nothing downstream depends on cwd.
  config.paths.data = abs(rootDir, config.paths.data);
  config.paths.worktrees = abs(rootDir, config.paths.worktrees);
  config.paths.mirrors = abs(rootDir, config.paths.mirrors);
  config.paths.inbox = abs(rootDir, config.paths.inbox);
  config.paths.runner = abs(rootDir, config.paths.runner);

  validateTargets(config);

  const workerTokens: Record<string, string> = {};
  for (const [name, target] of Object.entries(config.runner.targets)) {
    if (target.kind !== 'dispatch' || !target.worker_token_env) continue;
    const token = process.env[target.worker_token_env];
    if (!token) {
      throw new Error(
        `Target "${name}" is kind: dispatch but ${target.worker_token_env} is not set. ` +
          `A dispatch worker authenticates with a shared token; without it no worker can attach.`,
      );
    }
    workerTokens[target.worker_token_env] = token;
  }

  const keyPath = config.github.private_key_path;
  const secrets: Secrets = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    githubAppPrivateKey:
      keyPath && existsSync(abs(rootDir, keyPath))
        ? readFileSync(abs(rootDir, keyPath), 'utf8')
        : process.env.GITHUB_APP_PRIVATE_KEY,
    githubWebhookSecret: requireEnv('GITHUB_WEBHOOK_SECRET'),
    hookBusToken: requireEnv('HOOK_BUS_TOKEN'),
    teamsWorkflowUrl: process.env[config.teams.workflow_url_env],
    workerTokens,
  };

  loaded = { config, secrets, configPath: path, rootDir };
  return loaded;
}

/** Cross-field checks the zod schema cannot express on its own. */
function validateTargets(config: RouterConfig): void {
  const names = Object.keys(config.runner.targets);
  if (names.length === 0) {
    throw new Error('router.yml defines no runner.targets — nothing could ever be spawned.');
  }
  if (!config.runner.targets[config.runner.default]) {
    throw new Error(
      `runner.default is "${config.runner.default}" but no such target exists. Known: ${names.join(', ')}`,
    );
  }
  for (const rule of config.routing) {
    if (!config.runner.targets[rule.target]) {
      throw new Error(
        `routing rule targets "${rule.target}", which is not defined under runner.targets.`,
      );
    }
  }
  for (const [name, t] of Object.entries(config.runner.targets)) {
    if (t.kind === 'container' && !t.image) {
      throw new Error(`Target "${name}" is kind: container but sets no image.`);
    }
    if (t.kind === 'claude_cloud' && t.parking) {
      // A cloud sandbox is destroyed at session end; a tool call parked for hours
      // is not a safe bet against that lifecycle. Correct it rather than fail.
      t.parking = false;
    }
  }
}

export function getConfig(): RouterConfig {
  if (!loaded) throw new Error('loadConfig() has not run yet');
  return loaded.config;
}

export function getSecrets(): Secrets {
  if (!loaded) throw new Error('loadConfig() has not run yet');
  return loaded.secrets;
}

export function getRootDir(): string {
  if (!loaded) throw new Error('loadConfig() has not run yet');
  return loaded.rootDir;
}

// ── Agent authentication ──────────────────────────────────────────────────────

export type AgentAuthMethod = 'api_key' | 'subscription' | 'cloud_provider' | 'none';

export interface AgentAuth {
  method: AgentAuthMethod;
  /** Set when the configuration is self-defeating rather than merely absent. */
  problem?: string;
  detail: string;
}

/**
 * Which credential the spawned `claude` sessions will actually authenticate with.
 *
 * This is Claude Code's precedence, not the API SDK's, and the two differ. Claude
 * Code resolves, first match wins:
 *
 *   1. cloud provider (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY)
 *   2. ANTHROPIC_AUTH_TOKEN      (an LLM-gateway bearer, not a subscription token)
 *   3. ANTHROPIC_API_KEY         (Console billing)
 *   4. apiKeyHelper
 *   5. CLAUDE_CODE_OAUTH_TOKEN   (`claude setup-token`, subscription-backed)
 *   6. Anthropic profile / federation
 *   7. the interactive `/login` credential
 *
 * The ordering is the trap this function exists to catch: **an API key outranks a
 * subscription token**, and under `-p` it is used whenever present without a
 * prompt. So a leftover `ANTHROPIC_API_KEY` in the Router's environment silently
 * bills every session to the Console org instead of the subscription — with no
 * error, and no way to tell from the outside except the invoice.
 */
export function resolveAgentAuth(env: NodeJS.ProcessEnv = process.env): AgentAuth {
  // A variable that is *present but empty* is falsy in JavaScript and still
  // wins its precedence slot in Claude Code — it authenticates with an empty
  // credential and fails, while the credential you actually set sits unused.
  // This is the single most confusing way to misconfigure the Router, so it is
  // detected explicitly rather than treated as absent.
  const emptyButSet = (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const).filter(
    (name) => name in env && env[name] === '',
  );
  if (emptyButSet.length > 0) {
    return {
      method: 'none',
      detail: `${emptyButSet.join(' and ')} set to an empty value`,
      problem:
        `${emptyButSet.join(' and ')} is set but empty. An empty value still wins its ` +
        `precedence slot, so sessions authenticate with an empty credential and fail — ` +
        `while whatever you actually configured is ignored. Comment the line out or ` +
        `remove it; setting it to "" is not the same as unsetting it.`,
    };
  }

  const apiKey = env['ANTHROPIC_API_KEY'];
  const oauth = env['CLAUDE_CODE_OAUTH_TOKEN'];
  const gateway = env['ANTHROPIC_AUTH_TOKEN'];
  const cloud =
    env['CLAUDE_CODE_USE_BEDROCK'] ?? env['CLAUDE_CODE_USE_VERTEX'] ?? env['CLAUDE_CODE_USE_FOUNDRY'];

  if (cloud) {
    return { method: 'cloud_provider', detail: 'a cloud provider (Bedrock/Vertex/Foundry)' };
  }

  if (gateway) {
    return {
      method: 'api_key',
      detail: 'ANTHROPIC_AUTH_TOKEN (an LLM-gateway bearer)',
      ...(oauth
        ? {
            problem:
              'Both ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are set. The gateway ' +
              'bearer outranks the subscription token, so sessions will NOT use your ' +
              'subscription. Unset ANTHROPIC_AUTH_TOKEN if that is not what you want.',
          }
        : {}),
    };
  }

  if (apiKey) {
    return {
      method: 'api_key',
      detail: 'ANTHROPIC_API_KEY (Console billing)',
      ...(oauth
        ? {
            problem:
              'Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set. The API key ' +
              'outranks the subscription token and is used unconditionally under -p, so ' +
              'every session bills to the Console org and your subscription token is ignored. ' +
              'Unset ANTHROPIC_API_KEY — an empty string still wins its slot, so it must be ' +
              'genuinely unset.',
          }
        : {}),
    };
  }

  if (oauth) {
    return { method: 'subscription', detail: 'CLAUDE_CODE_OAUTH_TOKEN (Claude subscription)' };
  }

  return {
    method: 'none',
    detail: 'nothing in the environment',
    problem:
      'No agent credential is set. Sessions will fall back to whatever interactive login ' +
      'exists on this host, which is not something a service should depend on. Set ' +
      'CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY.',
  };
}

/** Env vars a spawned session needs, so container and dispatch targets forward them. */
export const AGENT_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;
