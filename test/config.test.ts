/**
 * Configuration: the host schema, its cross-field checks, and the Variable
 * overlay rules.
 *
 * Rule 4 of the Variables contract — "never fail open to no restrictions" — is
 * the one worth testing hardest. A malformed GQUAY_SCOPE_OVERRIDES must not
 * become unlimited scopes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { RepoConfigSchema, DEFAULT_REPO_CONFIG } from '../src/router/repoConfig.ts';
import { matchGlob } from '../src/runners/index.ts';
import { isPubliclyReachable } from '../src/runners/cloud.ts';

function withConfig(yaml: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gquay-config-'));
  const path = join(dir, 'router.yml');
  writeFileSync(path, yaml);
  const saved = { ...process.env };
  process.env['GITHUB_WEBHOOK_SECRET'] = 'x';
  process.env['HOOK_BUS_TOKEN'] = 'y';
  try {
    fn(path);
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const MINIMAL = `
public_url: https://gquay.example.com
runner:
  default: local
  targets:
    local:
      kind: process
      max_concurrent: 2
`;

test('a minimal config loads and paths become absolute', () => {
  withConfig(MINIMAL, (path) => {
    const { config } = loadConfig(path);
    assert.equal(config.public_url, 'https://gquay.example.com');
    assert.ok(config.paths.data.startsWith('/'), 'paths are resolved off cwd at load time');
    assert.equal(config.runner.targets['local']?.max_concurrent, 2);
  });
});

test('a routing rule pointing at an undefined target is rejected at load', () => {
  withConfig(
    `${MINIMAL}\nrouting:\n  - match: {}\n    target: nowhere\n`,
    (path) => {
      assert.throws(() => loadConfig(path), /not defined under runner\.targets/);
    },
  );
});

test('a default target that does not exist is rejected at load', () => {
  withConfig(
    `public_url: https://x.example.com\nrunner:\n  default: missing\n  targets:\n    local:\n      kind: process\n`,
    (path) => {
      assert.throws(() => loadConfig(path), /no such target exists/);
    },
  );
});

test('a container target with no image is rejected', () => {
  withConfig(
    `public_url: https://x.example.com\nrunner:\n  default: box\n  targets:\n    box:\n      kind: container\n`,
    (path) => {
      assert.throws(() => loadConfig(path), /sets no image/);
    },
  );
});

test('a dispatch target with no worker token is rejected', () => {
  withConfig(
    `public_url: https://x.example.com\nrunner:\n  default: w\n  targets:\n    w:\n      kind: dispatch\n      worker_token_env: GQUAY_TEST_TOKEN_UNSET\n`,
    (path) => {
      assert.throws(() => loadConfig(path), /without it no worker can attach/);
    },
  );
});

test('a cloud target claiming it can park is corrected, not accepted', () => {
  withConfig(
    `public_url: https://x.example.com\nrunner:\n  default: c\n  targets:\n    c:\n      kind: claude_cloud\n      parking: true\n`,
    (path) => {
      const { config } = loadConfig(path);
      assert.equal(config.runner.targets['c']?.parking, false);
    },
  );
});

test('a missing config file explains what to copy', () => {
  assert.throws(() => loadConfig('/nonexistent/router.yml'), /router\.example\.yml/);
});

// ── Repo config ───────────────────────────────────────────────────────────────

test('the shipped .github/gquay.yml validates against the schema', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const raw = parse(readFileSync('.github/gquay.yml', 'utf8'));
  const result = RepoConfigSchema.deepPartial().safeParse(raw);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues ?? [], null, 2));
});

test('repo config defaults are safe on their own', () => {
  assert.equal(DEFAULT_REPO_CONFIG.enabled, true);
  assert.equal(DEFAULT_REPO_CONFIG.trigger_label, 'gquay');
  assert.equal(DEFAULT_REPO_CONFIG.guardrails.merge_requires_approval, true);
  assert.deepEqual(DEFAULT_REPO_CONFIG.channels, {}, 'no channel is granted by default');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

test('repo glob matching spans one path segment', () => {
  assert.equal(matchGlob('kingspan/*', 'kingspan/portal'), true);
  assert.equal(matchGlob('kingspan/*', 'other/portal'), false);
  assert.equal(matchGlob('*', 'anything/at-all'), true);
  // A single `*` must not cross a slash, or `kingspan/*` would match nested paths.
  assert.equal(matchGlob('kingspan/*', 'kingspan/group/portal'), false);
});

test('public reachability rejects everything a cloud sandbox cannot resolve', () => {
  assert.equal(isPubliclyReachable('https://gquay.example.com'), true);
  for (const bad of [
    'http://gquay.example.com',        // not HTTPS
    'https://localhost:8080',
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://192.168.1.10',
    'https://172.16.4.2',
    'https://169.254.169.254',         // link-local metadata
    'https://router.internal',
    'not a url',
  ]) {
    assert.equal(isPubliclyReachable(bad), false, bad);
  }
});

// ── Retry classification ──────────────────────────────────────────────────────

test('permanent routing failures are not retried, transient ones are', async () => {
  const { isTransient } = await import('../src/router/router.ts');

  // Retrying these just burns the same slot or re-hits the same policy.
  for (const message of [
    'no capacity',
    'queued behind conflicting claim: src/** is claimed',
    'target local has no free capacity',
    'unknown work item issue:a/b#1',
    'could not set the branch-scoped push remote: permission denied',
  ]) {
    assert.equal(isTransient(new Error(message)), false, message);
  }

  // These are exactly the ones that would otherwise silently drop a real
  // comment, because the ingress already returned 202 and GitHub will not retry.
  for (const message of [
    'fetch failed',
    'Could not mint installation token (502): bad gateway',
    'ETIMEDOUT',
    'something nobody anticipated',
  ]) {
    assert.equal(isTransient(new Error(message)), true, message);
  }
});

// ── Agent credential resolution ───────────────────────────────────────────────

test('a subscription token alone resolves to the subscription', async () => {
  const { resolveAgentAuth } = await import('../src/config.ts');
  const auth = resolveAgentAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as NodeJS.ProcessEnv);
  assert.equal(auth.method, 'subscription');
  assert.equal(auth.problem, undefined);
});

test('an API key alongside a subscription token is flagged, not silently accepted', async () => {
  const { resolveAgentAuth } = await import('../src/config.ts');
  // This is the trap: Claude Code ranks ANTHROPIC_API_KEY above
  // CLAUDE_CODE_OAUTH_TOKEN and uses it unconditionally under -p, so the
  // subscription token is ignored and every session bills to the Console org.
  const auth = resolveAgentAuth({
    ANTHROPIC_API_KEY: 'sk-ant-x',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
  } as NodeJS.ProcessEnv);
  assert.equal(auth.method, 'api_key', 'the key wins, matching Claude Code precedence');
  assert.match(auth.problem ?? '', /outranks the subscription token/);
});

test('a gateway bearer outranks both, and says so', async () => {
  const { resolveAgentAuth } = await import('../src/config.ts');
  const auth = resolveAgentAuth({
    ANTHROPIC_AUTH_TOKEN: 'bearer',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
  } as NodeJS.ProcessEnv);
  assert.equal(auth.method, 'api_key');
  assert.match(auth.problem ?? '', /gateway bearer outranks/);
});

test('a cloud provider selection wins over everything', async () => {
  const { resolveAgentAuth } = await import('../src/config.ts');
  const auth = resolveAgentAuth({
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: 'sk-ant-x',
  } as NodeJS.ProcessEnv);
  assert.equal(auth.method, 'cloud_provider');
});

test('no credential at all is a blocking problem, not a warning', async () => {
  const { resolveAgentAuth } = await import('../src/config.ts');
  const auth = resolveAgentAuth({} as NodeJS.ProcessEnv);
  assert.equal(auth.method, 'none');
  assert.match(auth.problem ?? '', /No agent credential/);
});

test('every agent credential var is forwarded to container targets', async () => {
  const { AGENT_AUTH_ENV_VARS } = await import('../src/config.ts');
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(
      (AGENT_AUTH_ENV_VARS as readonly string[]).includes(name),
      `${name} must reach the container, or a session starts with no credential`,
    );
  }
});

test('the minimal example router.yml loads through the real schema', () => {
  // docs/00-start-smaller.md points people at this file as a working starting
  // point. If it stops validating, that advice silently becomes wrong.
  const saved = { ...process.env };
  process.env['GITHUB_WEBHOOK_SECRET'] = 'x';
  process.env['HOOK_BUS_TOKEN'] = 'y';
  try {
    const { config } = loadConfig('examples/minimal-router/router.yml');
    assert.equal(config.teams.enabled, false, 'Teams stays off in the minimal profile');
    assert.equal(config.runner.max_concurrent_total, 1);
    assert.deepEqual(Object.keys(config.runner.targets), ['local']);
    // The merge gate must survive every attempt to simplify — adding it later
    // means auditing what the agent already merged.
    assert.equal(config.merge.approval_phrase, '@gquay merge');
  } finally {
    process.env = saved;
  }
});
