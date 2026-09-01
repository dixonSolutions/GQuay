/**
 * The worker-side half of the Hook Bus tunnel.
 *
 * Claude Code hooks reach the Hook Bus over loopback HTTP. That is deliberate:
 * hook responses block tool calls, and the bus is a privileged control surface —
 * the merge gate lives there. So it binds to 127.0.0.1 on the Router host and is
 * never exposed publicly.
 *
 * On a dispatch worker, loopback is not the Router. This listener closes that
 * gap: it accepts the same `/hooks/*` requests on the worker's own loopback
 * address and forwards each one over the WebSocket the worker already holds
 * open. No second firewall rule, no public hook endpoint, and the parked socket
 * is already heartbeated.
 *
 * **Identity comes from the bearer token**, exactly as it does for MCP. Each
 * session gets its own random token, and the work item is looked up from it —
 * the `X-GQuay-Work-Item` header the agent sends is ignored, so one session on
 * a busy worker cannot answer a hook as another.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { childLogger } from '../log.js';

const log = childLogger('hook-tunnel');

/** Only the hook surface is forwarded — see `handleTunnelledHook` in server.ts. */
const HOOK_PATH = /^\/hooks\/[A-Za-z0-9._-]+$/;

/**
 * Ceiling on a round trip. Every hook in the runner overlay sets its own,
 * shorter timeout (20s at most), so this only fires when the Router or the
 * socket is gone. Failing here is safe: a `PreToolUse` hook that does not
 * return renders no decision, and the overlay leaves `merge_pull_request` on
 * an `ask` permission underneath, so a dead bus degrades to "no merge" rather
 * than "free merge".
 */
const ROUND_TRIP_TIMEOUT_MS = 30_000;

export interface HookFrame {
  type: 'hook';
  id: string;
  work_item: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface HookResultFrame {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Pending {
  resolve: (result: HookResultFrame) => void;
  timer: NodeJS.Timeout;
}

export class HookTunnel {
  private server: Server | undefined;
  private port = 0;
  /**
   * Whether the control connection is up. Starts false and is flipped by the
   * worker on `welcome` / socket close. A hook raised while the socket is down
   * is refused immediately rather than waiting out the round-trip ceiling —
   * `PreToolUse` holds a tool call open, so 30s of silence is 30s of stalled
   * agent for an answer that was never coming.
   */
  private connected = false;
  /** session token -> work item. The token is the identity, not the header. */
  private readonly tokens = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly send: (frame: HookFrame) => void) {}

  /** Bind to an ephemeral loopback port. Returns the origin to put in settings.json. */
  async start(): Promise<string> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 explicitly, never 0.0.0.0: this listener speaks for every
      // session on the worker, and nothing off-box has any business reaching it.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    log.info({ port: this.port }, 'hook tunnel listening on loopback');
    return this.origin;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) this.failAll('router connection closed');
  }

  /** Mint this session's hook credential. Returns the token to put in its env. */
  register(workItemKey: string): string {
    const token = randomUUID();
    this.tokens.set(token, workItemKey);
    return token;
  }

  /** Drop a finished session's credential and fail anything still in flight. */
  release(workItemKey: string): void {
    for (const [token, key] of this.tokens) {
      if (key === workItemKey) this.tokens.delete(token);
    }
  }

  /** A `hook_result` came back from the Router. */
  settle(result: HookResultFrame): void {
    const waiter = this.pending.get(result.id);
    if (!waiter) return;
    this.pending.delete(result.id);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  /** The control connection dropped; nothing in flight can be answered. */
  failAll(reason: string): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        id,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: reason }),
      });
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    this.failAll('worker shutting down');
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';

    const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '')?.[1];
    const workItem = bearer ? this.tokens.get(bearer) : undefined;
    if (!workItem) return respond(res, 401, { error: 'unauthorized' });
    if (!HOOK_PATH.test(path)) return respond(res, 404, { error: 'not a hook path' });

    if (!this.connected) {
      log.warn({ workItem, path }, 'hook raised while the router connection is down');
      return respond(res, 502, { error: 'router connection is down' });
    }

    const body = await readBody(req).catch(() => undefined);
    if (body === undefined) return respond(res, 413, { error: 'body too large' });

    const id = randomUUID();
    const result = await new Promise<HookResultFrame>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log.warn({ workItem, path }, 'hook round trip timed out');
        resolve({
          id,
          status: 504,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'router did not answer' }),
        });
      }, ROUND_TRIP_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer });
      this.send({
        type: 'hook',
        id,
        work_item: workItem,
        method: req.method ?? 'POST',
        path,
        headers: { 'content-type': 'application/json' },
        body,
      });
    });

    res.writeHead(result.status, {
      'content-type': result.headers['content-type'] ?? 'application/json',
    });
    res.end(result.body);
  }
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Hook payloads are small; the cap stops a runaway transcript filling memory. */
async function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
