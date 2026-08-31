/**
 * GitHub App authentication.
 *
 * Two token types, and the difference matters:
 *
 *   - The *app JWT* is signed locally with the App's private key (RS256, 10 min
 *     max lifetime) and only authenticates the App itself — listing
 *     installations, minting installation tokens.
 *   - An *installation token* is what actually touches a repository. It is
 *     scoped to one installation, expires in an hour, and is what the agent's
 *     GitHub MCP server is handed.
 *
 * Use an installation token, never a personal PAT: it is scoped per repo,
 * short-lived, and attributes the agent's actions to the App rather than to a
 * person. It also has a property the default Actions `GITHUB_TOKEN` lacks —
 * pushes made with it *do* trigger downstream workflows, so CI runs on the
 * agent's commits.
 *
 * Tokens are cached in memory only. They are credentials, they expire in an
 * hour, and a Router restart can afford to mint fresh ones.
 */

import { createSign } from 'node:crypto';
import { childLogger } from '../log.js';

const log = childLogger('github-app');

export interface AppAuthOptions {
  appId: string;
  privateKey: string;
  apiBase: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();
const installationByRepo = new Map<string, number>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Sign a short-lived App JWT. `iat` is backdated 60s to tolerate clock skew. */
export function appJwt(opts: AppAuthOptions): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: opts.appId }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = base64url(signer.sign(opts.privateKey));
  return `${header}.${payload}.${signature}`;
}

async function ghFetch(
  opts: AppAuthOptions,
  path: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...rest } = init;
  return fetch(`${opts.apiBase}${path}`, {
    ...rest,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'gquay-router',
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

/** Which installation covers `owner/repo`. Cached — installations rarely move. */
export async function installationIdForRepo(
  opts: AppAuthOptions,
  repo: string,
): Promise<number> {
  const cached = installationByRepo.get(repo);
  if (cached !== undefined) return cached;

  const [owner, name] = repo.split('/');
  const res = await ghFetch(opts, `/repos/${owner}/${name}/installation`, {
    token: appJwt(opts),
  });
  if (!res.ok) {
    throw new Error(
      `No GitHub App installation for ${repo} (${res.status}). ` +
        `Add the repo to the installation — that is how the pipeline expands.`,
    );
  }
  const body = (await res.json()) as { id: number };
  installationByRepo.set(repo, body.id);
  return body.id;
}

/**
 * Mint (or reuse) an installation token. Refreshed five minutes before expiry
 * so a long tool call never straddles the boundary.
 */
export async function installationToken(
  opts: AppAuthOptions,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;

  const res = await ghFetch(opts, `/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    token: appJwt(opts),
  });
  if (!res.ok) {
    throw new Error(`Could not mint installation token (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: Date.parse(body.expires_at),
  });
  log.debug({ installationId }, 'installation token minted');
  return body.token;
}

export async function tokenForRepo(opts: AppAuthOptions, repo: string): Promise<string> {
  const id = await installationIdForRepo(opts, repo);
  return installationToken(opts, id);
}

/** Drop cached tokens — used on shutdown and when the App key is rotated. */
export function clearTokenCache(): void {
  tokenCache.clear();
  installationByRepo.clear();
}
