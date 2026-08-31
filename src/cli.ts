/**
 * `gquay` — the admin CLI.
 *
 * Everything here talks to a *running* Router over its status/refresh endpoints,
 * or reads the registry directly. It deliberately cannot spawn a session on its
 * own: a work item exists because a GitHub event created it, and a second way to
 * create one would be a second source of truth.
 *
 *   gquay status                 what is running, parked, and waiting
 *   gquay doctor                 check config, secrets, and reachability
 *   gquay items [--state=idle]   list work items
 *   gquay terminate <key>        stop a session and release its worktree
 *   gquay refresh                drop cached repo config (Variables have no webhook)
 */

import 'dotenv/config';

import { loadConfig } from './config.js';
import { initLogger } from './log.js';
import { openDb, closeDb } from './state/db.js';
import * as registry from './state/registry.js';
import { isPubliclyReachable } from './runners/cloud.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `gquay — GitHub-driven Claude Code agent system

Usage:
  gquay status                  Overview from the running Router
  gquay doctor                  Validate configuration and secrets
  gquay items [--state=<s>]     List work items
  gquay show <key>              Everything known about one work item
  gquay terminate <key>         Stop a session and release its worktree
  gquay refresh                 Drop cached repo config

Work item keys look like  issue:owner/repo#42  or  pr:owner/repo#87
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  initLogger({ level: 'warn' });

  switch (command) {
    case 'status':
      await status();
      break;
    case 'doctor':
      doctor();
      break;
    case 'items':
      items(rest);
      break;
    case 'show':
      show(rest[0]);
      break;
    case 'terminate':
      await terminate(rest[0]);
      break;
    case 'refresh':
      await refresh();
      break;
    default:
      process.stdout.write(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

/** Ask the running Router, rather than inferring from the database. */
async function status(): Promise<void> {
  const { config, secrets } = loadConfig();
  const url = `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}/gquay/status`;

  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${secrets.hookBusToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      process.stdout.write(`Router responded ${res.status}. Is it running?\n`);
      process.exitCode = 1;
      return;
    }
    const body = (await res.json()) as Record<string, unknown>;
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } catch (err) {
    process.stdout.write(
      `Could not reach the Router at ${url}: ${(err as Error).message}\n` +
        `Start it with \`npm start\`, or \`systemctl status gquay\`.\n`,
    );
    process.exitCode = 1;
  }
}

/**
 * The checks worth running before the first webhook rather than after it. Each
 * one corresponds to a failure that is otherwise silent for hours.
 */
function doctor(): void {
  const problems: string[] = [];
  const notes: string[] = [];

  let config;
  try {
    ({ config } = loadConfig());
  } catch (err) {
    process.stdout.write(`✗ Configuration: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const { secrets, rootDir } = loadConfig();
  process.stdout.write('✓ router.yml parses and every target is well-formed\n');

  // GitHub App
  if (!config.github.app_id) problems.push('github.app_id is not set — no repository can be reached');
  if (!secrets.githubAppPrivateKey) {
    problems.push(
      'No App private key. Set github.private_key_path in router.yml, or GITHUB_APP_PRIVATE_KEY.',
    );
  } else {
    process.stdout.write('✓ GitHub App private key loaded\n');
  }

  // Public reachability — the webhook and cloud sessions both depend on it.
  if (!isPubliclyReachable(config.public_url)) {
    notes.push(
      `public_url is ${config.public_url}. GitHub can only deliver webhooks to a public HTTPS ` +
        `endpoint, and a cloud session cannot reach a private address at all.`,
    );
  } else {
    process.stdout.write(`✓ public_url ${config.public_url} looks externally reachable\n`);
  }

  // The runner overlay is what makes the park loop and the merge gate exist.
  const settings = resolve(config.paths.runner, 'settings.json');
  if (!existsSync(settings)) {
    problems.push(
      `No hook template at ${settings}. Without it there is no Stop-hook park and no merge ` +
        `gate — GQuay is not safe to run.`,
    );
  } else {
    process.stdout.write('✓ runner hook overlay present\n');
  }

  // Teams
  if (config.teams.enabled && !secrets.teamsWorkflowUrl) {
    notes.push(
      `Teams is enabled but ${config.teams.workflow_url_env} is unset. Notifications will be ` +
        `dropped silently.`,
    );
  } else if (config.teams.enabled) {
    process.stdout.write('✓ Teams Workflows URL configured\n');
  }

  // Dispatch workers
  for (const [name, target] of Object.entries(config.runner.targets)) {
    if (target.kind !== 'dispatch') continue;
    if (!target.worker_token_env || !secrets.workerTokens[target.worker_token_env]) {
      problems.push(`Target "${name}" has no worker token; no worker can ever attach to it.`);
    }
    if (target.kind === 'dispatch' && target.labels.length === 0) {
      notes.push(`Target "${name}" advertises no labels, so any worker can serve it.`);
    }
  }

  if (config.runner.targets[config.runner.default]?.kind === 'claude_cloud') {
    notes.push(
      'The default target is claude_cloud, which cannot park. Every event will spawn a fresh ' +
        'session — workable, but it is the weakest mode.',
    );
  }

  void rootDir;

  for (const note of notes) process.stdout.write(`! ${note}\n`);
  for (const problem of problems) process.stdout.write(`✗ ${problem}\n`);

  if (problems.length === 0) {
    process.stdout.write(`\nNo blocking problems${notes.length ? `, ${notes.length} note(s)` : ''}.\n`);
  } else {
    process.exitCode = 1;
  }
}

function items(args: string[]): void {
  const { config } = loadConfig();
  openDb(config.paths.data);

  const stateArg = args.find((a) => a.startsWith('--state='))?.split('=')[1];
  const list = stateArg
    ? registry.listWorkItems([stateArg as registry.WorkItemState])
    : registry.listWorkItems();

  if (list.length === 0) {
    process.stdout.write('No work items.\n');
  } else {
    const width = Math.max(...list.map((i) => i.key.length));
    for (const item of list) {
      process.stdout.write(
        `${item.key.padEnd(width)}  ${item.state.padEnd(14)} ${(item.target ?? '-').padEnd(12)} ` +
          `${item.model.padEnd(22)} ${item.branch ?? ''}\n`,
      );
    }
  }
  closeDb();
}

function show(key: string | undefined): void {
  if (!key) {
    process.stdout.write('Usage: gquay show <work-item-key>\n');
    process.exitCode = 1;
    return;
  }
  const { config } = loadConfig();
  openDb(config.paths.data);
  const item = registry.getWorkItem(key);
  if (!item) {
    process.stdout.write(`No such work item: ${key}\n`);
    process.exitCode = 1;
  } else {
    // The MCP bearer is a live credential; never print it.
    const { mcp_token: _mcpToken, ...safe } = item;
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  }
  closeDb();
}

async function terminate(key: string | undefined): Promise<void> {
  if (!key) {
    process.stdout.write('Usage: gquay terminate <work-item-key>\n');
    process.exitCode = 1;
    return;
  }
  // Terminating means killing a live process, which only the Router can do.
  const { config, secrets } = loadConfig();
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  const res = await fetch(`http://${host}:${config.server.hook_bus_port}/hooks/session-end`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secrets.hookBusToken}`,
      'content-type': 'application/json',
      'x-gquay-work-item': key,
    },
    body: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'terminated from the CLI' }),
  }).catch((err: Error) => {
    process.stdout.write(`Could not reach the Router: ${err.message}\n`);
    return undefined;
  });

  process.stdout.write(res?.ok ? `${key} terminated.\n` : `Termination request failed.\n`);
  if (!res?.ok) process.exitCode = 1;
}

async function refresh(): Promise<void> {
  const { config, secrets } = loadConfig();
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  const res = await fetch(`http://${host}:${config.server.port}/gquay/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secrets.hookBusToken}` },
  }).catch(() => undefined);
  process.stdout.write(res?.ok ? 'Config cache cleared.\n' : 'Refresh failed.\n');
  if (!res?.ok) process.exitCode = 1;
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
