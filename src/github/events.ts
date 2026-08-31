/**
 * Normalise a raw GitHub webhook payload into the shape the dispatcher routes on.
 *
 * The routing table in §2.4 keys on four things: which work item, what kind of
 * event, who the actor is, and whether the actor is a bot. Everything else in a
 * GitHub payload is context for the agent, not input to the routing decision,
 * so it is carried through opaquely rather than modelled.
 *
 * The bot guard is the one piece of this file that is not merely convenient.
 * Without it, the agent's own comment raises a webhook that delivers to the
 * agent, forever.
 */

import type { WorkItemRef } from '../state/registry.js';

export type GhEventKind =
  | 'issue.opened'
  | 'issue.labeled'
  | 'issue.closed'
  | 'issue.reopened'
  | 'issue.deleted'
  | 'issue.comment'
  | 'pr.opened'
  | 'pr.closed'
  | 'pr.merged'
  | 'pr.comment'
  | 'pr.review'
  | 'pr.review_comment'
  | 'pr.review_requested'
  | 'ci.completed'
  | 'push'
  | 'unhandled';

export interface NormalisedEvent {
  kind: GhEventKind;
  /** Which work item this is about. Undefined for repo-level events like push. */
  ref?: WorkItemRef;
  repo: string;
  actor: string;
  actorIsBot: boolean;
  /** `OWNER` | `MEMBER` | `COLLABORATOR` | `CONTRIBUTOR` | `NONE` — a hint only. */
  authorAssociation?: string;
  title?: string;
  body?: string;
  url?: string;
  labels: string[];
  assignees: string[];
  /** review events */
  reviewState?: string;
  /** review_comment events */
  path?: string;
  line?: number;
  diffHunk?: string;
  /** ci events */
  conclusion?: string;
  workflowName?: string;
  headBranch?: string;
  /** pr.closed */
  merged?: boolean;
  /** push — used to invalidate the cached .github/gquay.yml */
  changedPaths: string[];
  raw: Record<string, unknown>;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function actorOf(payload: Json): { login: string; isBot: boolean } {
  const sender = obj(payload['sender']);
  const login = str(sender?.['login']) ?? '';
  const type = str(sender?.['type']) ?? '';
  // `type: "Bot"` covers GitHub Apps; the `[bot]` suffix covers the rest.
  const isBot = type === 'Bot' || login.endsWith('[bot]');
  return { login, isBot };
}

function labelsOf(node: Json | undefined): string[] {
  const raw = node?.['labels'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    const name = str(obj(l)?.['name']);
    return name ? [name] : [];
  });
}

function assigneesOf(node: Json | undefined): string[] {
  const raw = node?.['assignees'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    const login = str(obj(a)?.['login']);
    return login ? [login] : [];
  });
}

export function normalise(event: string, payload: Json): NormalisedEvent {
  const repository = obj(payload['repository']);
  const repo = str(repository?.['full_name']) ?? '';
  const action = str(payload['action']) ?? '';
  const { login: actor, isBot: actorIsBot } = actorOf(payload);

  const base: NormalisedEvent = {
    kind: 'unhandled',
    repo,
    actor,
    actorIsBot,
    labels: [],
    assignees: [],
    changedPaths: [],
    raw: payload,
  };

  switch (event) {
    case 'issues': {
      const issue = obj(payload['issue']);
      const number = num(issue?.['number']);
      if (number === undefined) return base;
      const kind: GhEventKind =
        action === 'opened'
          ? 'issue.opened'
          : action === 'labeled'
            ? 'issue.labeled'
            : action === 'closed'
              ? 'issue.closed'
              : action === 'reopened'
                ? 'issue.reopened'
                : action === 'deleted'
                  ? 'issue.deleted'
                  : 'unhandled';
      return {
        ...base,
        kind,
        ref: { kind: 'issue', repo, number },
        title: str(issue?.['title']),
        body: str(issue?.['body']) ?? undefined,
        url: str(issue?.['html_url']),
        labels: labelsOf(issue),
        assignees: assigneesOf(issue),
      };
    }

    case 'issue_comment': {
      if (action !== 'created') return base;
      const issue = obj(payload['issue']);
      const comment = obj(payload['comment']);
      const number = num(issue?.['number']);
      if (number === undefined) return base;
      // GitHub delivers PR conversation comments on this same event; the
      // `pull_request` key on the issue is the only thing that tells them apart.
      const isPr = issue?.['pull_request'] !== undefined;
      return {
        ...base,
        kind: isPr ? 'pr.comment' : 'issue.comment',
        ref: { kind: isPr ? 'pr' : 'issue', repo, number },
        title: str(issue?.['title']),
        body: str(comment?.['body']) ?? undefined,
        url: str(comment?.['html_url']),
        authorAssociation: str(comment?.['author_association']),
        labels: labelsOf(issue),
        assignees: assigneesOf(issue),
      };
    }

    case 'pull_request': {
      const pr = obj(payload['pull_request']);
      const number = num(pr?.['number']);
      if (number === undefined) return base;
      const merged = pr?.['merged'] === true;
      const kind: GhEventKind =
        action === 'opened' || action === 'reopened'
          ? 'pr.opened'
          : action === 'closed'
            ? merged
              ? 'pr.merged'
              : 'pr.closed'
            : action === 'review_requested'
              ? 'pr.review_requested'
              : 'unhandled';
      return {
        ...base,
        kind,
        ref: { kind: 'pr', repo, number },
        title: str(pr?.['title']),
        body: str(pr?.['body']) ?? undefined,
        url: str(pr?.['html_url']),
        labels: labelsOf(pr),
        assignees: assigneesOf(pr),
        merged,
        headBranch: str(obj(pr?.['head'])?.['ref']),
      };
    }

    case 'pull_request_review': {
      if (action !== 'submitted') return base;
      const pr = obj(payload['pull_request']);
      const review = obj(payload['review']);
      const number = num(pr?.['number']);
      if (number === undefined) return base;
      return {
        ...base,
        kind: 'pr.review',
        ref: { kind: 'pr', repo, number },
        title: str(pr?.['title']),
        body: str(review?.['body']) ?? undefined,
        url: str(review?.['html_url']),
        reviewState: str(review?.['state']),
        authorAssociation: str(review?.['author_association']),
        labels: labelsOf(pr),
      };
    }

    case 'pull_request_review_comment': {
      if (action !== 'created') return base;
      const pr = obj(payload['pull_request']);
      const comment = obj(payload['comment']);
      const number = num(pr?.['number']);
      if (number === undefined) return base;
      return {
        ...base,
        kind: 'pr.review_comment',
        ref: { kind: 'pr', repo, number },
        title: str(pr?.['title']),
        body: str(comment?.['body']) ?? undefined,
        url: str(comment?.['html_url']),
        path: str(comment?.['path']),
        line: num(comment?.['line']),
        diffHunk: str(comment?.['diff_hunk']),
        authorAssociation: str(comment?.['author_association']),
        labels: labelsOf(pr),
      };
    }

    case 'workflow_run':
    case 'check_suite': {
      if (action !== 'completed') return base;
      const run = obj(payload['workflow_run']) ?? obj(payload['check_suite']);
      const prs = run?.['pull_requests'];
      const first = Array.isArray(prs) ? obj(prs[0]) : undefined;
      const number = num(first?.['number']);
      return {
        ...base,
        kind: 'ci.completed',
        ref: number === undefined ? undefined : { kind: 'pr', repo, number },
        conclusion: str(run?.['conclusion']),
        workflowName: str(run?.['name']),
        headBranch: str(run?.['head_branch']),
        url: str(run?.['html_url']),
      };
    }

    case 'push': {
      const commits = payload['commits'];
      const paths = Array.isArray(commits)
        ? commits.flatMap((c) => {
            const cc = obj(c);
            const all = [
              ...(Array.isArray(cc?.['added']) ? (cc['added'] as string[]) : []),
              ...(Array.isArray(cc?.['modified']) ? (cc['modified'] as string[]) : []),
              ...(Array.isArray(cc?.['removed']) ? (cc['removed'] as string[]) : []),
            ];
            return all;
          })
        : [];
      return { ...base, kind: 'push', changedPaths: paths, headBranch: str(payload['ref']) };
    }

    default:
      return base;
  }
}
