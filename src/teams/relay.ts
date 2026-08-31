/**
 * Teams transport — the Power Automate Workflows webhook.
 *
 * Office 365 connectors are retired; the classic *channel → Connectors →
 * Incoming Webhook* path is gone. The current mechanism is a Workflow built on
 * the "When a Teams webhook request is received" trigger, followed by "Post card
 * in a chat or channel".
 *
 * Practical consequences this module is built around:
 *   - The trigger URL's `sig` parameter is a secret. The *whole URL* is treated
 *     as a credential: it is never logged unredacted and never handed to an
 *     agent. Hooks talk to the Hook Bus; only the Hook Bus holds this URL.
 *   - Messages post as the Flow bot. No custom name or icon, so the card's own
 *     title has to carry the identity.
 *   - 28 KB per message, enforced in cards.ts.
 *   - A Workflow is owned by a *user*, not a channel, and orphans when that
 *     person leaves. `heartbeat()` exists so that failure is noticed rather than
 *     discovered months later as "notifications quietly stopped".
 *
 * The alternative transport — the official Teams MCP server — needs delegated,
 * user-context Graph permissions. Application-only auth is not supported for
 * posting, and an unattended agent has no signed-in user. See docs/07-teams.md
 * for the three paths and why this one is the v1 choice.
 */

import { childLogger, safeUrl } from '../log.js';
import { buildCard, buildPayload, exceedsLimit } from './cards.js';
import type { CardInput, Severity } from './cards.js';

const log = childLogger('teams');

export interface TeamsRelayOptions {
  /** The Workflows trigger URL. Undefined disables Teams entirely. */
  workflowUrl?: string;
  enabled: boolean;
  /** Drop anything below this severity before it leaves the process. */
  severityFloor: Severity;
  /** Retries for transient failures. Power Automate throttles under load. */
  maxRetries?: number;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  success: 1,
  attention: 2,
  warn: 3,
  error: 4,
};

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** Workflows does not return a message id, so threading is best-effort. */
  threadRef?: string;
}

export class TeamsRelay {
  constructor(private readonly opts: TeamsRelayOptions) {}

  get configured(): boolean {
    return this.opts.enabled && Boolean(this.opts.workflowUrl);
  }

  /** Below-floor messages are dropped here, before any network call. */
  passesFloor(severity: Severity): boolean {
    return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[this.opts.severityFloor];
  }

  async post(input: CardInput): Promise<PostResult> {
    if (!this.configured) {
      log.debug({ title: input.title }, 'teams not configured — dropping card');
      return { ok: false, error: 'teams not configured' };
    }
    if (!this.passesFloor(input.severity)) {
      log.debug({ title: input.title, severity: input.severity }, 'below severity floor');
      return { ok: false, error: 'below severity floor' };
    }

    let payload = buildPayload(buildCard(input));
    if (exceedsLimit(payload)) {
      // Drop the detail block rather than the whole card — the summary and the
      // link back to GitHub are the parts that matter.
      const { detail: _detail, ...rest } = input;
      payload = buildPayload(buildCard({ ...rest, summary: `${input.summary} (detail on GitHub)` }));
      log.warn({ title: input.title }, 'card exceeded 28 KB — posted without detail');
    }

    return this.send(payload);
  }

  private async send(payload: unknown, attempt = 0): Promise<PostResult> {
    const url = this.opts.workflowUrl!;
    const maxRetries = this.opts.maxRetries ?? 3;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) return { ok: true, status: res.status };

      // 429 and 5xx are worth retrying; 4xx generally means the Workflow itself
      // is wrong (deleted, orphaned, or the sig rotated) and retrying will not
      // fix it.
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const backoff = Number(res.headers.get('retry-after') ?? 0) * 1000 || 2 ** attempt * 1000;
        await sleep(backoff);
        return this.send(payload, attempt + 1);
      }

      const body = await res.text().catch(() => '');
      log.error({ url: safeUrl(url), status: res.status, body: body.slice(0, 400) }, 'teams post failed');
      return { ok: false, status: res.status, error: body.slice(0, 400) };
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(2 ** attempt * 1000);
        return this.send(payload, attempt + 1);
      }
      const message = (err as Error).message;
      log.error({ url: safeUrl(url), err: message }, 'teams post threw');
      return { ok: false, error: message };
    }
  }

  /**
   * A daily card proving the Workflow still exists and is still owned by
   * someone. A Workflow orphaned by a departing owner fails silently, and this
   * is the only cheap way to notice.
   */
  async heartbeat(summary: string): Promise<PostResult> {
    return this.post({
      title: 'GQuay is alive',
      severity: 'info',
      summary,
      actions: [],
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
