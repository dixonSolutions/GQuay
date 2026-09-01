/**
 * Documentation checks.
 *
 * Reference documentation drifts from code silently — nothing breaks, the docs
 * just quietly become wrong, and by the time someone notices they have stopped
 * trusting all of it. These two checks are cheap and catch the drift that
 * actually happens:
 *
 *   1. Every internal link and heading anchor resolves.
 *   2. Things enumerated in code — MCP tools, hook endpoints, HTTP routes,
 *      config defaults, the capability vocabulary — appear in the document
 *      that claims to be their reference.
 *
 * It is not a proof that the prose is right. It is a guarantee that the
 * *lists* are complete, which is where reference docs rot first.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

let failures = 0;
const fail = (msg) => {
  console.log(`✗ ${msg}`);
  failures++;
};

// ── 1. Links ──────────────────────────────────────────────────────────────────

const docFiles = ['README.md', ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

function headingSlugs(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    out.add(
      m[1]
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-'),
    );
  }
  return out;
}

let links = 0;
for (const file of docFiles) {
  const markdown = readFileSync(file, 'utf8');
  for (const m of markdown.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const target = m[2];
    if (/^https?:/.test(target)) continue;
    links++;
    const [rel, anchor] = target.split('#');
    const resolved = rel ? resolve(dirname(file), rel) : resolve(file);
    if (!existsSync(resolved)) {
      fail(`${file}: link to a file that does not exist — [${m[1]}](${target})`);
      continue;
    }
    if (anchor && statSync(resolved).isFile()) {
      if (!headingSlugs(readFileSync(resolved, 'utf8')).has(anchor)) {
        fail(`${file}: anchor does not exist — [${m[1]}](${target})`);
      }
    }
  }
}

// ── 2. Enumerations ───────────────────────────────────────────────────────────

const src = (p) => readFileSync(p, 'utf8');
const doc = (p) => readFileSync(`docs/${p}`, 'utf8');

const mcpServer = src('src/mcp/server.ts');
const hookBus = src('src/hooks/bus.ts');
const httpServer = src('src/server.ts');
const comms = src('src/mcp/comms.ts');

const tools = [...mcpServer.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
const toolDoc = doc('10-mcp-tools.md');
for (const tool of tools) {
  if (!toolDoc.includes(`\`${tool}\``)) fail(`docs/10-mcp-tools.md does not document the tool "${tool}"`);
}

const apiDoc = doc('13-http-api.md');
for (const m of hookBus.matchAll(/app\.post\('(\/hooks\/[a-z-]+)'/g)) {
  if (!apiDoc.includes(m[1])) fail(`docs/13-http-api.md does not document ${m[1]}`);
}
for (const m of httpServer.matchAll(/app\.(?:get|post|all)\('(\/[^']*)'/g)) {
  const route = m[1].replace('/:token/*', '');
  if (!apiDoc.includes(route)) fail(`docs/13-http-api.md does not document ${m[1]}`);
}

const configDoc = doc('06-configuration.md');
const capabilities = [...comms.matchAll(/^  '([a-z._]+)',/gm)].map((m) => m[1]);
for (const capability of capabilities) {
  if (!configDoc.includes(capability)) {
    fail(`docs/06-configuration.md does not list the capability "${capability}"`);
  }
}

const hookDoc = doc('11-hooks.md');
for (const m of hookBus.matchAll(/app\.post\('(\/hooks\/[a-z-]+)'/g)) {
  const endpoint = m[1].split('/').pop();
  if (!hookDoc.includes(endpoint)) fail(`docs/11-hooks.md does not mention the ${endpoint} hook`);
}

// ── 3. Setup profiles ─────────────────────────────────────────────────────────
//
// The menu in setup.sh and the list in the deployment doc drift apart the first
// time someone adds a profile and updates only one of them.

const setupSh = readFileSync('setup.sh', 'utf8');
// Read the authoritative list from the dispatch `case`, not the help text —
// the help text's column alignment is not a contract.
const caseLine = /^\s*(action(?:\|\w+)+)\)/m.exec(setupSh);
const declared = caseLine ? caseLine[1].split('|') : [];
if (declared.length === 0) fail('setup.sh: could not find the profile dispatch case');
const deployDoc = readFileSync('docs/02-deployment.md', 'utf8');

for (const profile of declared) {
  if (!existsSync(`scripts/setup/${profile}.sh`) && profile !== 'doctor') {
    fail(`setup.sh offers "${profile}" but scripts/setup/${profile}.sh does not exist`);
  }
  if (!deployDoc.includes(`./setup.sh ${profile}`)) {
    fail(`setup.sh offers "${profile}" but docs/02-deployment.md does not document \`./setup.sh ${profile}\``);
  }
}

for (const file of readdirSync('scripts/setup').filter((f) => f.endsWith('.sh') && f !== 'lib.sh')) {
  const name = file.replace(/\.sh$/, '');
  if (!declared.includes(name)) {
    fail(`scripts/setup/${file} exists but setup.sh does not offer "${name}"`);
  }
}

// ── 4. Referenced files are actually in the repository ────────────────────────
//
// An unanchored .gitignore pattern once excluded examples/minimal-router/router.yml
// while leaving it present locally, so every local check passed and a fresh
// clone had a broken `./setup.sh router`. Nothing catches that except asking
// git what it actually tracks.

const tracked = new Set(
  execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean),
);

const referenced = [
  'examples/minimal-router/router.yml',
  'examples/minimal-action/claude.yml',
  'examples/minimal-action/label-to-pr.yml',
  'router.example.yml',
  '.env.example',
  'runner/settings.json',
  'gquay.service',
  'gquay-worker.service',
];

for (const file of referenced) {
  if (!existsSync(file)) fail(`${file} is referenced by the setup scripts but does not exist`);
  else if (!tracked.has(file)) fail(`${file} exists but is not tracked by git — a fresh clone will not have it`);
}

// ── Result ────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n${failures} documentation problem(s).`);
  process.exit(1);
}
console.log(
  `Docs OK — ${links} internal links resolve, ` +
    `${tools.length} tools, ${capabilities.length} capabilities, ${declared.length} setup ` +
    `profiles, ${referenced.length} referenced files tracked, and every endpoint documented.`,
);
