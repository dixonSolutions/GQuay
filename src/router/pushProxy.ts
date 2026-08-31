/**
 * Branch-scoped git push proxy.
 *
 * This is the single best idea in the Claude Code cloud model, and it is worth
 * copying exactly: the agent never holds a credential that can write to `main`.
 * Combined with the merge gate and branch protection, an agent that goes wrong
 * still cannot touch the default branch — and you do not have to trust three
 * layers to each work independently.
 *
 * One correction to the obvious implementation. The design sketch describes a
 * *git credential helper* that "only mints credentials for gquay/<work-item>".
 * A credential helper cannot do that: git hands it the protocol, host and path,
 * and nothing about the refs being pushed. The credential is minted before git
 * has said what it intends to write. So branch scoping has to happen where the
 * refs are actually visible — inside the `git-receive-pack` request — which
 * means a proxy, not a helper.
 *
 * The worktree's `origin` therefore points at the Router:
 *
 *     https://<router>/git/<session-token>/<owner>/<repo>.git
 *
 * Fetches (`git-upload-pack`) pass straight through. Pushes are parsed: every
 * ref update in the pkt-line preamble must target this work item's own branch,
 * or the whole request is refused before a byte reaches GitHub.
 */

import { gunzipSync } from 'node:zlib';
import { childLogger } from '../log.js';
import { getByMcpToken } from '../state/registry.js';
import type { WorkItem } from '../state/registry.js';

const log = childLogger('push-proxy');

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

// ── pkt-line ──────────────────────────────────────────────────────────────────

/**
 * Parse the ref-update preamble of a `git-receive-pack` request.
 *
 * The wire format is a sequence of pkt-lines — four hex digits of length
 * (including the four) followed by the payload — terminated by the flush packet
 * `0000`. Everything after the flush is the packfile and is opaque here.
 *
 * Returns the updates and the offset where the packfile begins. A malformed
 * preamble returns `undefined`, which the caller treats as "refuse", never as
 * "allow": a push whose refs cannot be read is a push whose refs cannot be
 * checked.
 */
export function parseReceivePack(body: Buffer): { updates: RefUpdate[]; packOffset: number } | undefined {
  const updates: RefUpdate[] = [];
  let offset = 0;

  while (offset + 4 <= body.length) {
    const lengthHex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthHex)) return undefined;
    const length = parseInt(lengthHex, 16);

    if (length === 0) {
      // Flush packet — the preamble is over.
      return { updates, packOffset: offset + 4 };
    }
    // 1-3 are reserved signalling packets; they have no place here.
    if (length < 4 || offset + length > body.length) return undefined;

    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;

    // Capabilities are appended to the first line after a NUL.
    const line = payload.split('\0')[0]!.trim();
    if (line.length === 0) continue;

    const m = /^([0-9a-f]{40,64})\s+([0-9a-f]{40,64})\s+(\S+)$/.exec(line);
    if (!m) return undefined;
    updates.push({ oldSha: m[1]!, newSha: m[2]!, ref: m[3]! });
  }

  // Ran off the end without a flush packet.
  return undefined;
}

// ── Authorisation ─────────────────────────────────────────────────────────────

export interface PushDecision {
  allowed: boolean;
  reason?: string;
  refused?: RefUpdate[];
}

/**
 * Every ref update must target this work item's branch. Deleting that branch is
 * allowed (an agent tidying up after a merge); creating or updating anything
 * else is not.
 */
export function authorisePush(updates: RefUpdate[], item: WorkItem): PushDecision {
  if (!item.branch) {
    return { allowed: false, reason: 'this work item has no branch assigned' };
  }
  const allowed = `refs/heads/${item.branch}`;
  const refused = updates.filter((u) => u.ref !== allowed);

  if (refused.length > 0) {
    return {
      allowed: false,
      refused,
      reason:
        `This session may only push to ${allowed}. Refused: ` +
        refused.map((u) => u.ref).join(', ') +
        '. Open a pull request instead of pushing to another branch.',
    };
  }
  if (updates.length === 0) {
    return { allowed: false, reason: 'no ref updates in request' };
  }
  return { allowed: true };
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

export interface ProxyRequest {
  /** Per-session token from the URL path. Identifies the work item. */
  token: string;
  repo: string;
  /** e.g. `info/refs` or `git-receive-pack`. */
  service: string;
  method: 'GET' | 'POST';
  query: string;
  headers: Record<string, string | undefined>;
  body?: Buffer;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PushProxyOptions {
  /** Mints an installation token for a repo. */
  tokenForRepo: (repo: string) => Promise<string>;
  githubBase?: string;
}

export class PushProxy {
  constructor(private readonly opts: PushProxyOptions) {}

  async handle(req: ProxyRequest): Promise<ProxyResponse> {
    const item = getByMcpToken(req.token);
    if (!item) {
      return text(401, 'Unknown or expired session token.');
    }
    if (item.repo !== req.repo) {
      // A session's token is bound to one repository. This is the check that
      // stops a compromised agent using its own valid token against a different
      // repo in the same installation.
      log.warn({ workItem: item.key, requested: req.repo }, 'cross-repo push attempt refused');
      return text(403, `This session is scoped to ${item.repo}.`);
    }

    // Push: inspect the refs before anything leaves the process.
    if (req.service === 'git-receive-pack' && req.method === 'POST') {
      const body = req.body ?? Buffer.alloc(0);
      const decoded = decodeBody(body, req.headers['content-encoding']);
      const parsed = parseReceivePack(decoded);

      if (!parsed) {
        log.warn({ workItem: item.key }, 'unparseable receive-pack request refused');
        return text(400, 'Could not read the ref updates in this push; refusing it.');
      }

      const decision = authorisePush(parsed.updates, item);
      if (!decision.allowed) {
        log.warn(
          { workItem: item.key, refused: decision.refused?.map((u) => u.ref), branch: item.branch },
          'push refused by branch scope',
        );
        return text(403, decision.reason ?? 'Push refused.');
      }
      log.info(
        { workItem: item.key, refs: parsed.updates.map((u) => u.ref) },
        'push authorised',
      );
    }

    // `info/refs?service=git-receive-pack` is the push handshake. It carries no
    // refs of its own, so it is allowed through — the actual push is checked
    // above, and refusing the handshake would only produce a worse error.
    return this.forward(req, item);
  }

  private async forward(req: ProxyRequest, item: WorkItem): Promise<ProxyResponse> {
    const token = await this.opts.tokenForRepo(item.repo);
    const base = this.opts.githubBase ?? 'https://github.com';
    const url = `${base}/${item.repo}.git/${req.service}${req.query ? `?${req.query}` : ''}`;

    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      'user-agent': req.headers['user-agent'] ?? 'git/2.0 (gquay-proxy)',
      accept: req.headers['accept'] ?? '*/*',
    };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers['content-encoding']) headers['content-encoding'] = req.headers['content-encoding'];

    const res = await fetch(url, {
      method: req.method,
      headers,
      ...(req.method === 'POST' && req.body ? { body: new Uint8Array(req.body) } : {}),
    });

    const out: Record<string, string> = {};
    for (const name of ['content-type', 'cache-control', 'content-encoding']) {
      const v = res.headers.get(name);
      if (v) out[name] = v;
    }

    return {
      status: res.status,
      headers: out,
      body: Buffer.from(await res.arrayBuffer()),
    };
  }
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  if (encoding !== 'gzip') return body;
  try {
    return gunzipSync(body);
  } catch {
    // An undecodable body cannot be inspected, so it must not be forwarded.
    // Returning the raw buffer makes parseReceivePack fail, which refuses.
    return body;
  }
}

/**
 * Errors come back as a pkt-line the git client will print, rather than a bare
 * HTTP body it would swallow. The agent sees the reason, which is the point —
 * a silent refusal teaches it nothing.
 */
function text(status: number, message: string): ProxyResponse {
  const line = `ERR ${message}`;
  const framed = `${(line.length + 5).toString(16).padStart(4, '0')}${line}\n0000`;
  return {
    status,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: Buffer.from(framed, 'utf8'),
  };
}

/** The remote URL to write into a worktree so its pushes go through the proxy. */
export function proxyRemoteUrl(publicUrl: string, sessionToken: string, repo: string): string {
  return `${publicUrl.replace(/\/$/, '')}/git/${sessionToken}/${repo}.git`;
}
