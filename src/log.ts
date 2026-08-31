/**
 * Structured logging (pino).
 *
 * One root logger, `childLogger(name)` per module. In development the output is
 * piped through pino-pretty; in production it stays newline-delimited JSON so
 * journald/`journalctl -u gquay` keeps it greppable.
 *
 * Redaction is not optional here. The Router handles four classes of secret —
 * the GitHub App private key, installation tokens, the Teams Workflows URL
 * (whose `sig` query parameter is the credential), and per-session MCP tokens.
 * Any of those reaching a log line is a leak, so they are redacted centrally
 * rather than at each call site.
 */

import pino from 'pino';
import type { Logger } from 'pino';

let root: Logger | undefined;

/** Paths scrubbed from every log record. See module header. */
const REDACT_PATHS = [
  'token',
  '*.token',
  'session_token',
  '*.session_token',
  'installation_token',
  '*.installation_token',
  'private_key',
  '*.private_key',
  'webhook_secret',
  '*.webhook_secret',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'teams_url',
  '*.teams_url',
];

export interface LogOptions {
  level?: string;
  pretty?: boolean;
}

/** Initialise the root logger. Safe to call once at boot; later calls are ignored. */
export function initLogger(opts: LogOptions = {}): Logger {
  if (root) return root;

  const level = opts.level ?? process.env.GQUAY_LOG_LEVEL ?? 'info';
  const pretty = opts.pretty ?? process.env.NODE_ENV === 'development';

  root = pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });

  return root;
}

/** The root logger, initialising with defaults if boot has not run yet. */
export function getLogger(): Logger {
  return root ?? initLogger();
}

/** A named child logger. Use one per module: `const log = childLogger('router')`. */
export function childLogger(name: string): Logger {
  return getLogger().child({ mod: name });
}

/**
 * Strip the `sig` parameter from a Teams Workflows URL so it can be logged.
 * The URL is a bearer credential in its entirety; this leaves enough to
 * identify *which* workflow without leaking the ability to post to it.
 */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ['sig', 'sp', 'sv']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return '[unparseable-url]';
  }
}
