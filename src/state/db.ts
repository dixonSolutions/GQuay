/**
 * SQLite state — the work-item registry and everything hanging off it.
 *
 * Single-writer, synchronous (better-sqlite3). That is a deliberate fit for the
 * Router: webhook handling is short and bursty, and the registry is the thing
 * that decides whether an event spawns, delivers, resumes, or is dropped. An
 * async driver would buy nothing and would open a window where two deliveries
 * for the same work item both read "no session" and both spawn.
 *
 * WAL is on so the MCP server's parked-call bookkeeping and the ingress path
 * do not block each other on reads.
 */

import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { childLogger } from '../log.js';

const log = childLogger('db');

let db: Db | undefined;

// ── Migrations ────────────────────────────────────────────────────────────────
//
// Append-only. Each entry runs once, inside a transaction, and the applied
// index is recorded in `schema_migrations`. Never edit an entry that has
// shipped — add a new one.

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001-initial',
    sql: `
      CREATE TABLE work_items (
        key                  TEXT PRIMARY KEY,   -- issue:owner/repo#42
        kind                 TEXT NOT NULL,      -- issue | pr
        repo                 TEXT NOT NULL,      -- owner/repo
        number               INTEGER NOT NULL,
        session_id           TEXT,               -- Claude Code session id
        pid                  INTEGER,
        state                TEXT NOT NULL,      -- see state/registry.ts WorkItemState
        model                TEXT NOT NULL DEFAULT 'claude-opus-5',
        target               TEXT,               -- execution target name; sticky per item
        worker_id            TEXT,               -- dispatch worker holding this session
        branch               TEXT,
        worktree             TEXT,
        owner_login          TEXT,               -- human who triggered it
        linked_key           TEXT,               -- issue <-> PR pairing
        title                TEXT,
        granted_scopes       TEXT,               -- JSON array, resolved at spawn
        mcp_token            TEXT,               -- per-session bearer for /mcp
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity        TEXT,
        idle_since           TEXT,
        awaiting_since       TEXT,
        nudged_at            TEXT,
        escalated_at         TEXT,
        merge_approved_until TEXT,
        merge_approved_by    TEXT,
        notify_thread        TEXT,               -- Teams message id for threading
        error                TEXT
      );

      CREATE INDEX idx_work_items_state    ON work_items(state);
      CREATE INDEX idx_work_items_session  ON work_items(session_id);
      CREATE INDEX idx_work_items_linked   ON work_items(linked_key);
      CREATE INDEX idx_work_items_repo     ON work_items(repo, number);

      -- Webhook dedupe. GitHub retries deliveries; the delivery id is stable
      -- across retries, so a UNIQUE insert is the whole guard.
      CREATE TABLE deliveries (
        delivery_id  TEXT PRIMARY KEY,
        event        TEXT NOT NULL,
        action       TEXT,
        repo         TEXT,
        received_at  TEXT NOT NULL DEFAULT (datetime('now')),
        outcome      TEXT                        -- spawn | deliver | resume | ignore | error
      );
      CREATE INDEX idx_deliveries_received ON deliveries(received_at);

      -- Per-work-item event queue. An event is enqueued on arrival and drained
      -- by whichever await_events call is parked (or by the next spawn).
      -- Enqueue-then-drain is what stops an event that lands a millisecond
      -- before a call registers from being lost.
      CREATE TABLE events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_key TEXT NOT NULL,
        kind          TEXT NOT NULL,   -- comment | review | review_comment | ci | control
        payload       TEXT NOT NULL,   -- JSON
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at  TEXT
      );
      CREATE INDEX idx_events_pending ON events(work_item_key, delivered_at);

      -- Comms rate limiting and audit. Every post/reply/ask lands here whether
      -- it was allowed or denied, so "why did the agent go quiet" is answerable.
      CREATE TABLE comms_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_key TEXT,
        channel       TEXT NOT NULL,
        action        TEXT NOT NULL,   -- post | reply | ask
        allowed       INTEGER NOT NULL,
        reason        TEXT,
        thread_ref    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_comms_window ON comms_log(channel, created_at);

      -- Open questions raised via comms.ask. Answered through the §3 delivery
      -- path (a GitHub comment), never through a Teams reply in v1.
      CREATE TABLE questions (
        ticket_id     TEXT PRIMARY KEY,
        work_item_key TEXT NOT NULL,
        channel       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT,            -- JSON array
        asked_at      TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at   TEXT,
        answer        TEXT,
        answered_by   TEXT
      );
      CREATE INDEX idx_questions_open ON questions(work_item_key, answered_at);
    `,
  },
  {
    name: '002-config-cache',
    sql: `
      -- GitHub emits no webhook when an Actions Variable changes, so the Router
      -- polls. Cache the last good value with its ETag: a 304 costs nothing,
      -- and a parse failure can fall back to last-known-good rather than to
      -- "no restrictions" (see docs/06-configuration.md, rule 4).
      CREATE TABLE config_cache (
        scope       TEXT NOT NULL,   -- org:<org> | repo:<owner/repo>
        source      TEXT NOT NULL,   -- variables | file
        etag        TEXT,
        payload     TEXT NOT NULL,   -- JSON
        fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scope, source)
      );
    `,
  },
];

// ── Open / migrate ────────────────────────────────────────────────────────────

export function openDb(dataDir: string): Db {
  if (db) return db;

  const file = resolve(dataDir, 'gquay.db');
  mkdirSync(dirname(file), { recursive: true });

  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  log.info({ file }, 'registry open');
  return db;
}

function migrate(conn: Db): void {
  // The bookkeeping table is bootstrapped here, not in a migration — a
  // migration that created it would have to run before the table that records
  // whether it ran exists.
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    idx INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const appliedRow = conn
    .prepare('SELECT COALESCE(MAX(idx), -1) AS max_idx FROM schema_migrations')
    .get() as { max_idx: number };

  for (let i = appliedRow.max_idx + 1; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i]!;
    const run = conn.transaction(() => {
      conn.exec(m.sql);
      conn
        .prepare('INSERT OR REPLACE INTO schema_migrations (idx, name) VALUES (?, ?)')
        .run(i, m.name);
    });
    run();
    log.info({ migration: m.name }, 'migration applied');
  }
}

export function getDb(): Db {
  if (!db) throw new Error('openDb() has not run yet');
  return db;
}

export function closeDb(): void {
  if (!db) return;
  db.close();
  db = undefined;
}

/** ISO-8601 UTC, second precision — matches SQLite's `datetime('now')`. */
export function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** `now()` shifted forward by `ms`, in the same format. */
export function nowPlus(ms: number): string {
  return new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Parse a stored timestamp back to epoch millis. Returns 0 for null/garbage. */
export function toMillis(ts: string | null | undefined): number {
  if (!ts) return 0;
  const parsed = Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}
