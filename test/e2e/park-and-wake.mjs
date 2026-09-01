/**
 * End-to-end: a signed GitHub webhook wakes a parked MCP call in the same session.
 *
 * This is the design's central claim, and it is the one thing the unit tests
 * cannot prove. `parking.test.ts` exercises the ParkingLot in isolation;
 * `webhook.test.ts` exercises signature verification in isolation. Neither
 * covers the path that actually matters:
 *
 *     HMAC-verified webhook -> dedupe -> routing table -> permission check
 *       -> event queue -> doorbell -> parked MCP call returns -> framed output
 *
 * Every one of those is a place the loop can break without a unit test noticing.
 *
 * Self-contained: picks free ports, generates a throwaway RSA key, writes a
 * temporary router.yml, starts a mock GitHub, boots the Router from dist/, and
 * cleans up after itself. No network, no GitHub App, no public URL.
 *
 *   npm run build && npm run test:e2e
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockGitHub } from './mock-github.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const HOOK_BUS_TOKEN = 'e2e-hook-bus-token';
const MCP_TOKEN = 'e2e-mcp-token';
const WORK_ITEM = 'issue:acme/widgets#42';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};

/** Ask the OS for a free port rather than guessing and colliding in CI. */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

const dir = mkdtempSync(join(tmpdir(), 'gquay-e2e-'));
let router;
let mock;

try {
  const [apiPort, routerPort, hookPort] = await Promise.all([freePort(), freePort(), freePort()]);

  console.log('\nGQuay end-to-end: webhook wakes a parked MCP call\n');

  // ── Fixture ─────────────────────────────────────────────────────────────────
  execFileSync('openssl', ['genrsa', '-out', join(dir, 'app.pem'), '2048'], { stdio: 'ignore' });

  writeFileSync(
    join(dir, 'router.yml'),
    `public_url: https://gquay.example.com
server:
  port: ${routerPort}
  host: 127.0.0.1
  hook_bus_port: ${hookPort}
  hook_bus_host: 127.0.0.1
paths:
  data: ./data
  worktrees: ./worktrees
  mirrors: ./mirrors
  inbox: ./data/inbox
  runner: ${join(ROOT, 'runner')}
github:
  app_id: "123456"
  private_key_path: ./app.pem
  allowed_repos: ["acme/*"]
  api_base: http://127.0.0.1:${apiPort}
runner:
  default: local
  targets:
    local:
      kind: process
      max_concurrent: 1
teams:
  enabled: false
`,
  );

  mock = await startMockGitHub(apiPort);
  check('mock GitHub listening', true);

  router = spawn('node', [join(ROOT, 'dist/index.js')], {
    cwd: dir,
    env: {
      ...process.env,
      GQUAY_ROOT: dir,
      GQUAY_CONFIG: join(dir, 'router.yml'),
      GQUAY_LOG_LEVEL: 'silent',
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      HOOK_BUS_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fake-token',
      ANTHROPIC_API_KEY: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let routerErr = '';
  router.stderr.on('data', (c) => (routerErr += c.toString()));

  const up = await waitForHealth(`http://127.0.0.1:${routerPort}/healthz`);
  check('Router booted', up, routerErr.slice(0, 300));
  if (!up) throw new Error('Router did not become healthy');

  // Register a work item as though a previous spawn had created it. Spawning a
  // real `claude` process is out of scope here — the loop under test is the
  // delivery path, not the agent.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(join(dir, 'data/gquay.db'));
  db.prepare(
    `INSERT OR REPLACE INTO work_items
       (key, kind, repo, number, state, model, target, branch, mcp_token, granted_scopes, title, session_id)
     VALUES (?, 'issue', 'acme/widgets', 42, 'working', 'claude-opus-5', 'local',
             'gquay/issue-42', ?, '["notes:post"]', 'Broken login', 'sess-e2e')`,
  ).run(WORK_ITEM, MCP_TOKEN);
  db.close();

  // ── Connect as an agent would ───────────────────────────────────────────────
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${routerPort}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } },
  );
  const client = new Client({ name: 'gquay-e2e', version: '1.0.0' });
  await client.connect(transport);
  check('MCP session established', true);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    'all seven tools exposed',
    tools.length === 7,
    `got ${tools.length}: ${tools.join(', ')}`,
  );

  const status = JSON.parse(
    (await client.callTool({ name: 'work_item_status', arguments: {} })).content[0].text,
  );
  check('bearer resolves to the right work item', status.work_item === WORK_ITEM, status.work_item);

  // ── The claim under test ────────────────────────────────────────────────────
  const started = Date.now();
  const parked = client.callTool({ name: 'await_events', arguments: { timeout_s: 30 } });

  // Give the call a moment to actually register as parked, then deliver a real
  // signed webhook through the real ingress.
  await sleep(1200);

  const body = JSON.stringify({
    action: 'created',
    repository: { full_name: 'acme/widgets' },
    sender: { login: 'alice', type: 'User' },
    issue: { number: 42, title: 'Broken login', labels: [{ name: 'gquay' }] },
    comment: {
      body: 'Please also cover the refresh-token path.',
      html_url: 'https://github.com/acme/widgets/issues/42#issuecomment-9',
      author_association: 'MEMBER',
    },
  });
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;

  const delivery = await fetch(`http://127.0.0.1:${routerPort}/gquay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issue_comment',
      'x-github-delivery': `e2e-${Date.now()}`,
      'x-hub-signature-256': signature,
    },
    body,
  });
  check('webhook accepted (202)', delivery.status === 202, `got ${delivery.status}`);

  const result = await parked;
  const elapsed = Date.now() - started;
  const payload = JSON.parse(result.content[1].text);
  const framed = result.content[0].text;

  check('parked call returned', !payload.timed_out, 'it timed out instead of being woken');
  check('exactly one event delivered', payload.events.length === 1, `got ${payload.events.length}`);
  check(
    'the comment body survived the round trip',
    payload.events[0]?.body === 'Please also cover the refresh-token path.',
  );
  check('the author is carried', payload.events[0]?.author === 'alice');
  check(
    "the author's real permission level is attached",
    payload.events[0]?.author_permission === 'write',
    'the framing promises a permission level it must actually have',
  );
  check('framed output states provenance', /permission level on the repository is: write/.test(framed));
  check('framed output fences the untrusted body', framed.includes('~~~~'));
  check('woke in under 10s', elapsed < 10_000, `${elapsed}ms`);

  // ── Guards still hold on the same live server ───────────────────────────────
  const badSig = await fetch(`http://127.0.0.1:${routerPort}/gquay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'e2e-bad',
      'x-hub-signature-256': 'sha256=deadbeef',
    },
    body,
  });
  check('a bad signature is rejected (401)', badSig.status === 401, `got ${badSig.status}`);

  const replay = await fetch(`http://127.0.0.1:${routerPort}/gquay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'e2e-replay',
      'x-hub-signature-256': signature,
    },
    body,
  });
  const replayAgain = await fetch(`http://127.0.0.1:${routerPort}/gquay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'e2e-replay',
      'x-hub-signature-256': signature,
    },
    body,
  });
  check(
    'a replayed delivery id is deduped',
    replay.status === 202 && replayAgain.status === 200,
    `${replay.status} then ${replayAgain.status}`,
  );

  const mergeGate = await fetch(`http://127.0.0.1:${hookPort}/hooks/merge-gate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${HOOK_BUS_TOKEN}`,
      'content-type': 'application/json',
      'x-gquay-work-item': WORK_ITEM,
    },
    body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
  });
  const decision = await mergeGate.json();
  check(
    'the merge gate denies without an approval',
    decision.hookSpecificOutput?.permissionDecision === 'deny',
  );

  const noAuth = await fetch(`http://127.0.0.1:${hookPort}/hooks/merge-gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('the hook bus rejects an unauthenticated call (401)', noAuth.status === 401);

  await client.close();
  console.log(`\n  parked call woken in ${elapsed}ms\n`);
} finally {
  if (router) router.kill('SIGTERM');
  if (mock) mock.close();
  await sleep(500);
  if (router) router.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('End-to-end OK.\n');
