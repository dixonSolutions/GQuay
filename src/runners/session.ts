/**
 * Materialise a session's Claude Code configuration.
 *
 * Each session gets its own directory holding a `settings.json` (hooks) and an
 * `.mcp.json` (server registrations), generated from templates in `runner/`.
 * Generating rather than sharing matters for one reason: the MCP bearer and the
 * GitHub installation token are *per session*, and a shared config file would
 * mean one leaked worktree exposes every session's credentials.
 *
 * The generated files live under the Router's data directory with 0600
 * permissions, never inside the worktree — the worktree is a git checkout the
 * agent can `git add -A` at any moment.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { childLogger } from '../log.js';
import type { SpawnRequest } from './types.js';

const log = childLogger('session-config');

export interface SessionPaths {
  dir: string;
  settingsPath: string;
  mcpConfigPath: string;
}

export interface SessionConfigOptions {
  dataDir: string;
  runnerDir: string;
  /** Loopback Hook Bus origin as the *executing host* sees it. */
  hookBusUrl: string;
  hookBusToken: string;
  /** Where the agent's inbox file lives, for the asyncRewake hook. */
  inboxFile: string;
  /** Docker image for the GitHub MCP server. */
  githubMcpImage?: string;
  /** Toolsets enabled on the GitHub MCP server — a real security control. */
  githubToolsets?: string;
}

function slug(workItemKey: string): string {
  return workItemKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function writeSessionConfig(
  req: SpawnRequest,
  opts: SessionConfigOptions,
): SessionPaths {
  const dir = resolve(opts.dataDir, 'sessions', slug(req.workItemKey));
  mkdirSync(dir, { recursive: true });

  // ── settings.json (hooks) ───────────────────────────────────────────────────
  const templatePath = resolve(opts.runnerDir, 'settings.json');
  if (!existsSync(templatePath)) {
    throw new Error(
      `No hook template at ${templatePath}. The runner overlay is what makes the ` +
        `Stop-hook park and the merge gate work — GQuay is not safe to run without it.`,
    );
  }
  const rendered = renderTemplate(readFileSync(templatePath, 'utf8'), {
    HOOK_BUS_URL: opts.hookBusUrl,
    WORK_ITEM_KEY: req.workItemKey,
    INBOX_FILE: req.env?.['GQUAY_INBOX_FILE'] ?? opts.inboxFile,
    PARK_TIMEOUT_S: String(req.env?.['GQUAY_PARK_TIMEOUT_S'] ?? 540),
    MODEL: req.model,
    RUNNER_DIR: opts.runnerDir,
  });

  const settingsPath = resolve(dir, 'settings.json');
  writeFileSync(settingsPath, rendered, { mode: 0o600 });
  chmodSync(settingsPath, 0o600);

  // ── .mcp.json (server registrations) ────────────────────────────────────────
  //
  // Two servers. `github` is the official server, run in Docker with an
  // installation token and a deliberately narrow toolset — `--exclude-tools`
  // and GITHUB_TOOLSETS limit what exists at all, which is a stronger control
  // than any prompt. `gquay` is the Router's own agent-facing side, reached
  // over Streamable HTTP with this session's bearer.
  const mcpConfig = {
    mcpServers: {
      github: {
        command: 'docker',
        args: [
          'run', '-i', '--rm',
          '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN',
          '-e', 'GITHUB_TOOLSETS',
          opts.githubMcpImage ?? 'ghcr.io/github/github-mcp-server',
        ],
        env: {
          GITHUB_TOOLSETS: opts.githubToolsets ?? 'repos,issues,pull_requests,actions',
          GITHUB_PERSONAL_ACCESS_TOKEN: req.githubToken,
        },
      },
      gquay: {
        type: 'http',
        url: req.mcpUrl,
        headers: { Authorization: `Bearer ${req.mcpToken}` },
      },
      'agent-locks': {
        command: 'npx',
        args: ['-y', 'agent-locks'],
        env: { AGENT_LOCKS_AGENT_ID: req.workItemKey },
      },
    },
  };

  const mcpConfigPath = resolve(dir, 'mcp.json');
  writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 });
  chmodSync(mcpConfigPath, 0o600);

  log.debug({ workItem: req.workItemKey, dir }, 'session config written');
  return { dir, settingsPath, mcpConfigPath };
}

/** `${NAME}` substitution. Values are JSON-escaped so a path with a quote is safe. */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_]+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    // The template is JSON; embed the value without its surrounding quotes so
    // it drops into an existing "..." position correctly.
    return JSON.stringify(value).slice(1, -1);
  });
}

/** Build the CLI argv for a Claude Code session. Shared by process and container. */
export function claudeArgs(req: SpawnRequest, paths: SessionPaths): string[] {
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', req.model,
    '--mcp-config', paths.mcpConfigPath,
    '--settings', paths.settingsPath,
    // Hooks tighten policy past what permissions allow and can never weaken it,
    // so the merge gate holds regardless of this mode. See docs/04-merge-gate.md.
    '--permission-mode', 'acceptEdits',
  ];
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  return args;
}

/** Environment every runner kind sets, whatever host it runs on. */
export function baseEnv(req: SpawnRequest): Record<string, string> {
  return {
    GQUAY_WORK_ITEM: req.workItemKey,
    GQUAY_REPO: req.repo,
    GQUAY_BRANCH: req.branch,
    GQUAY_SCOPES: req.scopes.join(' '),
    GITHUB_PERSONAL_ACCESS_TOKEN: req.githubToken,
    ...req.env,
  };
}
