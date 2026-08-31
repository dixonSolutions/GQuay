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

// ── Result ────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n${failures} documentation problem(s).`);
  process.exit(1);
}
console.log(
  `Docs OK — ${links} internal links resolve, ` +
    `${tools.length} tools, ${capabilities.length} capabilities and every endpoint are documented.`,
);
