/**
 * GQuay Router — entry point.
 *
 * Boot sequence:
 *   1. Load .env (Tier 1 secrets — see docs/06-configuration.md)
 *   2. Load and validate router.yml
 *   3. Initialise the logger
 *   4. Open the registry and run migrations
 *   5. Reconcile: nothing survived the restart, so mark live rows accordingly
 *   6. Build the Router (execution plane, parking lot, Teams, push proxy)
 *   7. Start the public server and the loopback Hook Bus
 *   8. Start the idle supervisor
 *   9. Register graceful shutdown
 */

import 'dotenv/config';

import { loadConfig } from './config.js';
import { initLogger, getLogger } from './log.js';
import { openDb, closeDb } from './state/db.js';
import { Router } from './router/router.js';
import { IdleSupervisor } from './router/idle.js';
import { buildServer } from './server.js';
import { buildHookBus } from './hooks/bus.js';
import * as registry from './state/registry.js';
import { mkdirSync } from 'node:fs';

async function main(): Promise<void> {
  const { config, secrets, configPath } = loadConfig();

  const log = initLogger();
  log.info({ configPath, publicUrl: config.public_url }, 'GQuay Router starting');

  for (const dir of [
    config.paths.data,
    config.paths.worktrees,
    config.paths.mirrors,
    config.paths.inbox,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  openDb(config.paths.data);
  reconcile();

  const router = new Router({ config, secrets, rootDir: process.cwd() });

  const server = buildServer({
    router,
    webhookSecret: secrets.githubWebhookSecret,
    hookBusToken: secrets.hookBusToken,
    host: config.server.host,
    port: config.server.port,
  });

  const hookBus = buildHookBus({
    router,
    token: secrets.hookBusToken,
    host: config.server.hook_bus_host,
    port: config.server.hook_bus_port,
  });

  await server.listen({ host: config.server.host, port: config.server.port });
  log.info({ host: config.server.host, port: config.server.port }, 'ingress + MCP listening');

  await hookBus.listen({ host: config.server.hook_bus_host, port: config.server.hook_bus_port });
  log.info(
    { host: config.server.hook_bus_host, port: config.server.hook_bus_port },
    'hook bus listening',
  );

  const idle = new IdleSupervisor({ router });
  idle.start();

  if (router.teams.configured) {
    await router.teams.heartbeat(
      `Router up. ${Object.keys(config.runner.targets).length} execution target(s) configured.`,
    );
  } else {
    log.warn('Teams is not configured — notifications will be dropped');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    idle.stop();
    // Release parked calls first: an MCP transport with a call parked on it
    // will not close, and the process would hang waiting for it.
    await router.shutdown();
    await Promise.allSettled([server.close(), hookBus.close()]);
    closeDb();
    log.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandled rejection');
  });
}

/**
 * Nothing survives a Router restart: child processes were killed with it, and
 * dispatch workers lost their control connection. Rows still claiming to be
 * live are stale, and leaving them that way would make the dispatcher think a
 * session exists to deliver into.
 *
 * A row with a session id becomes `parked` — its transcript is intact and the
 * next comment resumes it. A row without one becomes `dead`; there is nothing
 * to resume.
 */
function reconcile(): void {
  const log = getLogger();
  let parked = 0;
  let dead = 0;

  for (const item of registry.listWorkItems(['starting', 'working', 'idle', 'awaiting_input'])) {
    if (item.session_id) {
      registry.setState(item.key, 'parked');
      parked++;
    } else {
      registry.setState(item.key, 'dead', { error: 'router restarted before a session id was seen' });
      dead++;
    }
  }
  if (parked + dead > 0) log.info({ parked, dead }, 'reconciled work items after restart');
}

main().catch((err: Error) => {
  // The logger may not exist yet, so this deliberately uses stderr directly.
  process.stderr.write(`GQuay failed to start: ${err.message}\n${err.stack ?? ''}\n`);
  process.exit(1);
});
