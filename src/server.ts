/**
 * The public-facing server: GitHub ingress, the MCP endpoint, the dispatch
 * worker socket, and the branch-scoped git push proxy.
 *
 * Put a TLS terminator in front of this. It needs inbound 443 for the webhook
 * and outbound to the Claude API, GitHub, and Teams — that is the whole network
 * requirement, and it is why a long-running host is assumed. GitHub Actions
 * cannot host any of it: a workflow run is a fresh container per event with no
 * live process to park a tool call in.
 *
 * Route groups:
 *   POST /gquay/webhook        GitHub deliveries (HMAC verified, deduped)
 *   ALL  /mcp                  MCP Streamable HTTP — where await_events parks
 *   GET  /gquay/worker         dispatch worker WebSocket (workers dial out)
 *   ALL  /git/:token/...       branch-scoped push proxy
 *   GET  /healthz              unauthenticated liveness
 *   GET  /gquay/status         authenticated overview
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { childLogger } from './log.js';
import type { Router } from './router/router.js';
import { verifySignature, readHeaders } from './github/webhook.js';
import { normalise } from './github/events.js';
import { recordDelivery, setOutcome } from './state/deliveries.js';
import { buildMcpServer } from './mcp/server.js';
import * as registry from './state/registry.js';
import { newWorkerId } from './runners/dispatch.js';
import type { RouterToWorker, WorkerToRouter, WorkerConnection } from './runners/dispatch.js';

const log = childLogger('server');

export interface ServerOptions {
  router: Router;
  webhookSecret: string;
  hookBusToken: string;
  host: string;
  port: number;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  workItemKey: string;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  const { router } = opts;
  const mcpSessions = new Map<string, McpSession>();

  // ── Body parsing ────────────────────────────────────────────────────────────
  //
  // The webhook HMAC is computed over the exact bytes GitHub sent. Parsing JSON
  // and re-serialising changes whitespace and key order, and the signature will
  // never match — so the raw buffer is kept alongside the parsed body.

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // git smart-HTTP bodies are binary and must reach the proxy untouched.
  for (const type of [
    'application/x-git-receive-pack-request',
    'application/x-git-upload-pack-request',
    'application/octet-stream',
  ]) {
    app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }

  void app.register(fastifyWebsocket);

  // ── Health and status ───────────────────────────────────────────────────────

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/gquay/status', async (req, reply) => {
    if (!authorised(req.headers['authorization'], opts.hookBusToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return {
      parked_calls: router.parking.size,
      parked_keys: router.parking.parkedKeys(),
      workers: router.workers.count(),
      targets: router.plane.list().map((t) => ({
        name: t.name,
        kind: t.kind,
        parking: t.parking,
        ...t.capacity(),
      })),
      work_items: registry.listWorkItems().map((w) => ({
        key: w.key,
        state: w.state,
        model: w.model,
        target: w.target,
        branch: w.branch,
        linked: w.linked_key,
        last_activity: w.last_activity,
      })),
    };
  });

  // ── GitHub ingress ──────────────────────────────────────────────────────────

  app.post('/gquay/webhook', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const headers = readHeaders(req.headers as Record<string, unknown>);

    const verified = verifySignature(raw, headers.signature, opts.webhookSecret);
    if (!verified.valid) {
      log.warn({ reason: verified.reason, delivery: headers.deliveryId }, 'webhook rejected');
      return reply.code(401).send({ error: 'invalid signature' });
    }
    if (!headers.deliveryId || !headers.event) {
      return reply.code(400).send({ error: 'missing delivery headers' });
    }

    const payload = (req.body ?? {}) as Record<string, unknown>;
    const event = normalise(headers.event, payload);

    // Dedupe before anything with side effects. GitHub retries, and a retry
    // carries the same delivery id — the expensive failure is a duplicate
    // spawn, not a duplicate log line.
    const { fresh } = recordDelivery(
      headers.deliveryId,
      headers.event,
      String(payload['action'] ?? ''),
      event.repo,
    );
    if (!fresh) {
      log.debug({ delivery: headers.deliveryId }, 'duplicate delivery ignored');
      return reply.code(200).send({ ok: true, deduped: true });
    }

    // Acknowledge immediately. GitHub's delivery timeout is short and spawning
    // a session is not; anything slow happens after the 200.
    void reply.code(202).send({ ok: true });

    try {
      const outcome = await router.handleEvent(event);
      setOutcome(headers.deliveryId, outcome);
      log.info(
        { delivery: headers.deliveryId, kind: event.kind, repo: event.repo, outcome },
        'webhook handled',
      );
    } catch (err) {
      setOutcome(headers.deliveryId, 'error');
      log.error(
        { delivery: headers.deliveryId, kind: event.kind, err: (err as Error).message },
        'webhook handling failed',
      );
    }
    return reply;
  });

  /** Actions Variables emit no webhook when they change, so allow a manual poke. */
  app.post('/gquay/refresh', async (req, reply) => {
    if (!authorised(req.headers['authorization'], opts.hookBusToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    router.invalidateConfigCache();
    return { ok: true };
  });

  // ── MCP ─────────────────────────────────────────────────────────────────────
  //
  // Identity is the bearer token, minted at spawn and written into that
  // session's mcp.json. A tool call therefore cannot claim to be a different
  // work item than the connection it arrived on.

  app.all('/mcp', async (req, reply) => {
    const token = bearer(req.headers['authorization']);
    if (!token) return reply.code(401).send({ error: 'missing bearer token' });

    const item = registry.getByMcpToken(token);
    if (!item) return reply.code(401).send({ error: 'unknown session token' });

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;

    let session = sessionId ? mcpSessions.get(sessionId) : undefined;

    if (!session) {
      if (req.method !== 'POST') {
        return reply.code(400).send({ error: 'no such MCP session' });
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          mcpSessions.set(id, { transport, server, workItemKey: item.key });
          log.info({ mcpSession: id, workItem: item.key }, 'MCP session opened');
        },
      });
      const server = buildMcpServer(item.key, router.mcpDeps());
      transport.onclose = () => {
        if (transport.sessionId) mcpSessions.delete(transport.sessionId);
        log.info({ workItem: item.key }, 'MCP session closed');
      };
      await server.connect(transport);
      session = { transport, server, workItemKey: item.key };
    } else if (session.workItemKey !== item.key) {
      // The session id and the bearer disagree. That should be impossible;
      // refuse rather than serve the wrong work item's tools.
      log.error(
        { mcpSession: sessionId, expected: session.workItemKey, got: item.key },
        'MCP session/token mismatch',
      );
      return reply.code(403).send({ error: 'session does not belong to this token' });
    }

    // Hand the raw streams to the transport; it owns the response from here,
    // including the long-lived stream a parked await_events depends on.
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
    return reply;
  });

  // ── Dispatch workers ────────────────────────────────────────────────────────
  //
  // The worker dials out and holds the connection open. The Router never
  // initiates a connection to a worker — that is what makes this usable from
  // inside a network with no inbound path.

  app.get('/gquay/worker', { websocket: true }, (socket) => {
    let workerId: string | undefined;
    let authenticated = false;

    const heartbeat = setInterval(() => {
      if (authenticated) send(socket, { type: 'ping' });
    }, 30_000);

    socket.on('message', (data: Buffer) => {
      let msg: WorkerToRouter;
      try {
        msg = JSON.parse(data.toString('utf8')) as WorkerToRouter;
      } catch {
        socket.close(1003, 'malformed frame');
        return;
      }

      if (!authenticated) {
        if (msg.type !== 'hello') {
          socket.close(1008, 'expected hello');
          return;
        }
        const target = router.targetForWorkerToken(msg.token);
        if (!target) {
          log.warn({ advertised: msg.labels }, 'worker presented an unknown token');
          send(socket, { type: 'reject', reason: 'unknown worker token' });
          socket.close(1008, 'unauthorized');
          return;
        }

        workerId = msg.worker_id || newWorkerId();
        authenticated = true;

        const conn: WorkerConnection = {
          id: workerId,
          labels: msg.labels,
          capacity: msg.capacity,
          os: msg.os,
          shell: msg.shell,
          send: (m) => send(socket, m),
          close: (reason) => socket.close(1000, reason.slice(0, 100)),
        };
        router.workers.attach(conn);
        send(socket, { type: 'welcome', heartbeat_ms: 30_000, worker_id: workerId });
        return;
      }

      router.onWorkerMessage(msg);
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      if (workerId) {
        const orphaned = router.workers.detach(workerId);
        router.onWorkerLost(orphaned);
      }
    });
  });

  // ── git push proxy ──────────────────────────────────────────────────────────

  app.all('/git/:token/*', async (req, reply) => {
    const params = req.params as { token: string; '*': string };
    // Path is `<owner>/<repo>.git/<service...>`
    const rest = params['*'] ?? '';
    const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/(.+)$/.exec(rest);
    if (!m) return reply.code(404).send('not a git path');

    const repo = `${m[1]}/${m[2]}`;
    const service = m[3]!;
    const query = (req.raw.url ?? '').split('?')[1] ?? '';

    const result = await router.pushProxy.handle({
      token: params.token,
      repo,
      service,
      method: req.method === 'POST' ? 'POST' : 'GET',
      query,
      headers: req.headers as Record<string, string | undefined>,
      ...(Buffer.isBuffer(req.body) ? { body: req.body } : {}),
    });

    for (const [k, v] of Object.entries(result.headers)) void reply.header(k, v);
    return reply.code(result.status).send(result.body);
  });

  // Close MCP transports on shutdown so parked calls do not hang the process.
  app.addHook('onClose', async () => {
    for (const session of mcpSessions.values()) {
      await session.transport.close().catch(() => undefined);
    }
    mcpSessions.clear();
  });

  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket: { send: (data: string) => void }, message: RouterToWorker): void {
  socket.send(JSON.stringify(message));
}

function bearer(header: unknown): string | undefined {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

function authorised(header: unknown, token: string): boolean {
  return bearer(header) === token;
}
