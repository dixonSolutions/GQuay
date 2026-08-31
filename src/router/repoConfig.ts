/**
 * Per-repository configuration, resolved across four tiers.
 *
 *   label on item  >  repo Variable  >  repo gquay.yml  >  org Variable  >  default
 *
 * The dividing line between the file and Variables is not arbitrary. Actions
 * *Variables* are readable through the REST API; Actions *Secrets* are not, by
 * design — the list endpoint never reveals a value and only a workflow runtime
 * can decrypt one. The Router is a standalone process, not an Actions job, so
 * it can read Variables and can never read Secrets. That is the whole reason
 * Tier 1 lives in the host environment.
 *
 * Within what the Router *can* read, the split is editorial:
 *   - Variables carry small flat maps a non-developer flips under pressure.
 *     No schema validation on write, no diff, no blame, no webhook on change.
 *   - `.github/gquay.yml` carries anything that deserves review: channel
 *     descriptions, scope grants, the notification matrix. It is versioned,
 *     reviewable in a PR, and a change arrives as a `push` webhook.
 *
 * Variable JSON *overlays* file config rather than replacing it, so a malformed
 * variable degrades to file config rather than to no config. A parse failure
 * keeps last-known-good and alerts; it never fails open to "no restrictions".
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getDb, now } from '../state/db.js';
import { childLogger } from '../log.js';
import type { GitHubApi } from '../github/api.js';
import { ownerOf } from '../state/registry.js';

const log = childLogger('repo-config');

// ── Schema ────────────────────────────────────────────────────────────────────

const ChannelSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  do_not_use_for: z.string().default(''),
  attention_cost: z.enum(['none', 'low', 'high', 'critical']).default('low'),
  scopes: z.array(z.string()).default([]),
  /** e.g. "6/hour". Parsed by parseRateLimit(). */
  rate_limit: z.string().optional(),
  threading: z.enum(['per_work_item', 'flat']).default('flat'),
  /** e.g. "18:00-08:00 Australia/Sydney" */
  quiet_hours: z.string().optional(),
  /** Messages below this urgency are refused with a pointer to a cheaper channel. */
  urgency_floor: z.enum(['low', 'normal', 'high', 'critical']).default('low'),
});

const NotifySchema = z.object({
  notify: z.boolean().default(true),
  severity: z.enum(['info', 'success', 'attention', 'warn', 'error']).default('info'),
  mention: z.enum(['assignee', 'owner', 'channel']).optional(),
  /** e.g. "4/hour" — applies to agent-initiated rows only. */
  budget: z.string().optional(),
});

export const RepoConfigSchema = z.object({
  enabled: z.boolean().default(true),
  trigger_label: z.string().default('gquay'),
  model: z
    .object({
      default: z.string().default('claude-opus-5'),
      /** Keyed `label:<name>` → model id. */
      overrides: z.record(z.string()).default({}),
    })
    .default({}),
  /** Base scope grants before label overrides. See docs/05-comms.md. */
  scopes: z.array(z.string()).default([]),
  channels: z.record(ChannelSchema).default({}),
  teams: z
    .object({
      thread_per_work_item: z.boolean().default(true),
      events: z.record(NotifySchema).default({}),
    })
    .default({}),
  coordination: z
    .object({
      on_conflict: z.enum(['notify', 'queue', 'read_only', 'proceed']).default('notify'),
      scope_source: z.enum(['labels', 'paths_in_issue', 'agent_declares']).default('labels'),
      stale_lock_after: z.string().default('6h'),
    })
    .default({}),
  idle: z
    .object({
      nudge_after: z.string().default('20m'),
      escalate_after: z.string().default('2h'),
      park_after: z.string().default('24h'),
      idle_grace: z.string().default('10m'),
    })
    .default({}),
  /** Prepended to every session's opening prompt. Repo-specific house rules. */
  preamble: z.string().default(''),
  guardrails: z
    .object({
      /** Paths the agent must never edit, regardless of lock state. */
      protected_paths: z.array(z.string()).default([]),
      /** Require the merge gate even for maintainers. Always true in practice. */
      merge_requires_approval: z.boolean().default(true),
      max_files_changed: z.number().int().positive().optional(),
    })
    .default({}),
  routing: z
    .object({
      /** Repo may *request* a target; the Router only honours it if it exists. */
      preferred_target: z.string().optional(),
    })
    .default({}),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelSchema>;
export type NotifyRule = z.infer<typeof NotifySchema>;

/** Built-in defaults — the floor of the precedence chain. */
export const DEFAULT_REPO_CONFIG: RepoConfig = RepoConfigSchema.parse({});

// ── Duration / rate parsing ───────────────────────────────────────────────────

/** "20m" | "2h" | "24h" | "7d" | "90s" → milliseconds. */
export function parseDuration(spec: string, fallbackMs = 0): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(spec.trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

export interface RateLimit {
  count: number;
  windowMs: number;
}

/** "6/hour" | "4/hr" | "30/day" | "2/min" → { count, windowMs }. */
export function parseRateLimit(spec: string | undefined): RateLimit | undefined {
  if (!spec) return undefined;
  const m = /^(\d+)\s*\/\s*(min|minute|hr|hour|day)$/i.exec(spec.trim());
  if (!m) return undefined;
  const unit = m[2]!.toLowerCase();
  const windowMs = unit.startsWith('min') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
  return { count: Number(m[1]), windowMs };
}

// ── Fetch + merge ─────────────────────────────────────────────────────────────

interface CacheRow {
  etag: string | null;
  payload: string;
  fetched_at: string;
}

function readCache(scope: string, source: string): CacheRow | undefined {
  return getDb()
    .prepare('SELECT etag, payload, fetched_at FROM config_cache WHERE scope = ? AND source = ?')
    .get(scope, source) as CacheRow | undefined;
}

function writeCache(scope: string, source: string, payload: unknown, etag?: string): void {
  getDb()
    .prepare(
      `INSERT INTO config_cache (scope, source, etag, payload, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, source) DO UPDATE SET
         etag = excluded.etag, payload = excluded.payload, fetched_at = excluded.fetched_at`,
    )
    .run(scope, source, etag ?? null, JSON.stringify(payload), now());
}

/** Drop the cached file config for a repo — called on a `push` webhook. */
export function invalidateFileConfig(repo: string): void {
  getDb().prepare('DELETE FROM config_cache WHERE scope = ? AND source = ?').run(`repo:${repo}`, 'file');
  log.info({ repo }, 'gquay.yml cache invalidated by push');
}

/**
 * Parse a Variable's JSON payload. Every rule from docs/06-configuration.md is
 * enforced here: version the payload, validate on read, keep last-known-good,
 * and never fail open.
 */
function parseVariableJson<T>(
  name: string,
  raw: string | undefined,
  onError: (msg: string) => void,
): T | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { v?: number } & T;
    if (parsed.v !== 1) {
      onError(`${name}: unsupported payload version ${String(parsed.v)} — expected 1. Ignoring.`);
      return undefined;
    }
    return parsed;
  } catch (err) {
    onError(`${name}: not valid JSON (${(err as Error).message}). Keeping previous value.`);
    return undefined;
  }
}

export interface ResolveOptions {
  repo: string;
  /** Labels on the specific issue or PR — Tier 4. */
  labels?: string[];
  /** Emitted when a Variable is malformed; wired to the incidents channel. */
  onConfigError?: (msg: string) => void;
}

export interface ResolvedRepoConfig {
  config: RepoConfig;
  /** Which tiers actually contributed, for the SessionStart audit line. */
  sources: string[];
}

export async function resolveRepoConfig(
  api: GitHubApi,
  opts: ResolveOptions,
): Promise<ResolvedRepoConfig> {
  const { repo } = opts;
  const org = ownerOf(repo);
  const sources: string[] = ['default'];
  const onError =
    opts.onConfigError ??
    ((msg: string) => log.error({ repo, msg }, 'config error'));

  // Tier: org Variables
  const orgCache = readCache(`org:${org}`, 'variables');
  const orgRes = await api.orgVariables(repo, org, orgCache?.etag ?? undefined).catch(() => ({
    notModified: false as const,
    vars: undefined,
    etag: undefined,
  }));
  let orgVars: Record<string, string> = {};
  if (orgRes.notModified && orgCache) {
    orgVars = JSON.parse(orgCache.payload) as Record<string, string>;
    sources.push('org-variables(cached)');
  } else if (orgRes.vars) {
    orgVars = orgRes.vars;
    writeCache(`org:${org}`, 'variables', orgVars, orgRes.etag);
    sources.push('org-variables');
  } else if (orgCache) {
    orgVars = JSON.parse(orgCache.payload) as Record<string, string>;
    sources.push('org-variables(stale)');
  }

  // Tier: repo .github/gquay.yml
  let fileConfig: Partial<RepoConfig> = {};
  const fileCache = readCache(`repo:${repo}`, 'file');
  if (fileCache) {
    fileConfig = JSON.parse(fileCache.payload) as Partial<RepoConfig>;
    sources.push('gquay.yml(cached)');
  } else {
    const raw = await api.getFile(repo, '.github/gquay.yml').catch(() => undefined);
    if (raw) {
      try {
        const parsed = RepoConfigSchema.deepPartial().parse(parseYaml(raw) ?? {});
        fileConfig = parsed as Partial<RepoConfig>;
        writeCache(`repo:${repo}`, 'file', fileConfig);
        sources.push('gquay.yml');
      } catch (err) {
        onError(`.github/gquay.yml is invalid: ${(err as Error).message}. Using defaults.`);
      }
    }
  }

  // Tier: repo Variables
  const repoCache = readCache(`repo:${repo}`, 'variables');
  const repoRes = await api.repoVariables(repo, repoCache?.etag ?? undefined).catch(() => ({
    notModified: false as const,
    vars: undefined,
    etag: undefined,
  }));
  let repoVars: Record<string, string> = {};
  if (repoRes.notModified && repoCache) {
    repoVars = JSON.parse(repoCache.payload) as Record<string, string>;
    sources.push('repo-variables(cached)');
  } else if (repoRes.vars) {
    repoVars = repoRes.vars;
    writeCache(`repo:${repo}`, 'variables', repoVars, repoRes.etag);
    sources.push('repo-variables');
  } else if (repoCache) {
    repoVars = JSON.parse(repoCache.payload) as Record<string, string>;
    sources.push('repo-variables(stale)');
  }

  // Merge: defaults <- org vars <- file <- repo vars <- labels
  const merged: RepoConfig = structuredClone(DEFAULT_REPO_CONFIG);
  applyVariables(merged, orgVars, onError);
  deepMerge(merged, fileConfig);
  applyVariables(merged, repoVars, onError);
  if (opts.labels?.length) {
    applyLabels(merged, opts.labels);
    sources.push('labels');
  }

  return { config: merged, sources };
}

/** Flat operational knobs, plus the small JSON overlays. */
function applyVariables(
  target: RepoConfig,
  vars: Record<string, string>,
  onError: (msg: string) => void,
): void {
  if (vars['GQUAY_ENABLED'] !== undefined) {
    target.enabled = vars['GQUAY_ENABLED'].toLowerCase() !== 'false';
  }
  if (vars['GQUAY_TRIGGER_LABEL']) target.trigger_label = vars['GQUAY_TRIGGER_LABEL'];
  if (vars['GQUAY_DEFAULT_MODEL']) target.model.default = vars['GQUAY_DEFAULT_MODEL'];
  if (vars['GQUAY_IDLE_NUDGE_MINUTES']) target.idle.nudge_after = `${vars['GQUAY_IDLE_NUDGE_MINUTES']}m`;
  if (vars['GQUAY_IDLE_PARK_HOURS']) target.idle.park_after = `${vars['GQUAY_IDLE_PARK_HOURS']}h`;

  // GQUAY_MODEL_MAP — {"v":1,"default":"claude-opus-5","label:model-sonnet":"claude-sonnet-5"}
  const modelMap = parseVariableJson<Record<string, string>>(
    'GQUAY_MODEL_MAP',
    vars['GQUAY_MODEL_MAP'],
    onError,
  );
  if (modelMap) {
    for (const [k, v] of Object.entries(modelMap)) {
      if (k === 'v') continue;
      if (k === 'default') target.model.default = v;
      else target.model.overrides[k] = v;
    }
  }

  // GQUAY_SCOPE_OVERRIDES — {"v":1,"notes":[],"decisions":["post","ask"]}
  // A malformed payload must never become unlimited scopes, which is why this
  // goes through parseVariableJson and simply does nothing on failure.
  const scopeOverrides = parseVariableJson<Record<string, string[]>>(
    'GQUAY_SCOPE_OVERRIDES',
    vars['GQUAY_SCOPE_OVERRIDES'],
    onError,
  );
  if (scopeOverrides) {
    for (const [channel, scopes] of Object.entries(scopeOverrides)) {
      if (channel === 'v' || !Array.isArray(scopes)) continue;
      const existing = target.channels[channel];
      if (existing) existing.scopes = scopes;
    }
  }

  // GQUAY_QUIET_HOURS — {"v":1,"tz":"Australia/Sydney","window":"18:00-08:00","exempt":["incidents"]}
  const quiet = parseVariableJson<{ tz: string; window: string; exempt?: string[] }>(
    'GQUAY_QUIET_HOURS',
    vars['GQUAY_QUIET_HOURS'],
    onError,
  );
  if (quiet?.window && quiet.tz) {
    const exempt = new Set(quiet.exempt ?? []);
    for (const [key, ch] of Object.entries(target.channels)) {
      if (!exempt.has(key)) ch.quiet_hours = `${quiet.window} ${quiet.tz}`;
    }
  }
}

/** Tier 4 — labels on the item itself. The cheapest possible interface. */
function applyLabels(target: RepoConfig, labels: string[]): void {
  for (const label of labels) {
    const override = target.model.overrides[`label:${label}`];
    if (override) target.model.default = override;

    // Conventional `model:<alias>` shorthand, resolved against the same map.
    const aliasMatch = /^model:(.+)$/.exec(label);
    if (aliasMatch) {
      const alias = aliasMatch[1]!;
      target.model.default = target.model.overrides[`label:model-${alias}`] ?? aliasModel(alias);
    }

    if (label === 'gquay:no-teams') {
      for (const rule of Object.values(target.teams.events)) rule.notify = false;
    }
    if (label === 'gquay:quiet') {
      // Strip post/ask everywhere but notes — the agent can still record
      // observations, but it cannot demand attention.
      for (const [key, ch] of Object.entries(target.channels)) {
        if (key !== 'notes') ch.scopes = ch.scopes.filter((s) => s !== 'post' && s !== 'ask');
      }
    }
    if (label === 'gquay:read-only') {
      for (const [key, ch] of Object.entries(target.channels)) {
        ch.scopes = key === 'notes' ? ch.scopes.filter((s) => s === 'post') : [];
      }
    }
    if (label === 'priority:high') {
      target.idle.nudge_after = '5m';
      target.idle.escalate_after = '30m';
    }
  }
}

function aliasModel(alias: string): string {
  switch (alias) {
    case 'opus':
      return 'claude-opus-5';
    case 'sonnet':
      return 'claude-sonnet-5';
    case 'haiku':
      return 'claude-haiku-4-5-20251001';
    default:
      return alias;
  }
}

/** Recursive merge — objects merge, arrays and scalars replace. */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const existing = target[k];
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      existing && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}
