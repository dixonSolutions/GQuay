/**
 * Webhook signature verification.
 *
 * Every delivery carries `X-Hub-Signature-256`: HMAC-SHA256 of the *raw* body
 * under the webhook secret. Two things are easy to get wrong here and both are
 * fatal:
 *
 *   1. The HMAC must be computed over the exact bytes GitHub sent. Parsing JSON
 *      and re-serialising changes whitespace and key order, and the signature
 *      will never match. `server.ts` therefore keeps the raw buffer.
 *   2. The comparison must be constant-time. A `===` on the hex digest leaks
 *      the correct signature one byte at a time to anyone willing to measure.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): VerifyResult {
  if (!signatureHeader) return { valid: false, reason: 'missing X-Hub-Signature-256' };
  if (!signatureHeader.startsWith('sha256=')) {
    return { valid: false, reason: 'unexpected signature algorithm' };
  }

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signatureHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  // Length mismatch cannot go through timingSafeEqual (it throws), but bailing
  // early would itself be a timing signal. Compare against `b` twice instead so
  // both paths do the same work.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return { valid: false, reason: 'signature length mismatch' };
  }
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'signature mismatch' };
}

/** Headers the ingress path needs, normalised to lowercase keys. */
export interface WebhookHeaders {
  deliveryId?: string;
  event?: string;
  signature?: string;
}

export function readHeaders(headers: Record<string, unknown>): WebhookHeaders {
  const get = (k: string): string | undefined => {
    const v = headers[k];
    return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : undefined;
  };
  return {
    deliveryId: get('x-github-delivery'),
    event: get('x-github-event'),
    signature: get('x-hub-signature-256'),
  };
}
