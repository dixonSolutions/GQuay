/**
 * The merge gate.
 *
 * Requirement: the agent can merge, but only when asked.
 *
 * Two tempting solutions are both wrong. Excluding `merge_pull_request` from
 * the GitHub MCP toolset means it can never merge, and the "when asked" path
 * dies with it. A settings-level `deny` rule fails for the same reason — a hook
 * returning `allow` cannot loosen a deny that came from settings.
 *
 * So it is a `PreToolUse` hook that consults the registry. That is the strong
 * version, because `PreToolUse` hooks fire *before* any permission-mode check:
 * a `deny` blocks the call even under `bypassPermissions` or
 * `--dangerously-skip-permissions`. Hooks can tighten policy past what
 * permissions allow; they can never weaken it. That property is what makes this
 * safe to run unattended.
 *
 * Two cautions the implementation has to respect:
 *
 *   - A hook that *times out* does not block the tool call — execution
 *     continues through the normal permission flow. So this endpoint must fail
 *     closed and fail fast, and `merge_pull_request` must also sit behind a
 *     settings-level `ask` rule, so a dead Hook Bus degrades to "no merge"
 *     rather than "free merge".
 *   - Branch protection on the default branch is the backstop. If the Hook Bus
 *     is down or misconfigured, GitHub itself still refuses. Belt and braces.
 */

import { childLogger } from '../log.js';
import {
  approveMerge,
  consumeMergeApproval,
  getWorkItem,
  isMergeApproved,
} from '../state/registry.js';
import type { GitHubApi } from '../github/api.js';

const log = childLogger('merge-gate');

/** Permission levels that may authorise a merge. */
const APPROVING_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason: string;
  };
}

export function decide(workItemKey: string | undefined, approvalPhrase: string): HookDecision {
  if (!workItemKey) {
    return deny(
      'This session is not registered against a work item, so no merge approval can exist for it.',
    );
  }

  const item = getWorkItem(workItemKey);
  if (!item) {
    return deny(`Work item ${workItemKey} is not in the registry.`);
  }

  // Approval is per-PR. An approval posted on the issue does not authorise a
  // merge of the PR, and vice versa — they are different threads with different
  // audiences, even though one session owns both.
  const prKey = item.kind === 'pr' ? item.key : item.linked_key;
  if (!prKey) {
    return deny('There is no pull request linked to this work item yet.');
  }

  if (!isMergeApproved(prKey)) {
    return deny(
      `Merge requires an explicit request. Ask on the pull request thread, and a maintainer ` +
        `with write access must reply "${approvalPhrase}".`,
    );
  }

  // Single-use: consumed the moment the call is allowed, so a retry loop cannot
  // turn one approval into several merges.
  consumeMergeApproval(prKey);
  const approver = getWorkItem(prKey)?.merge_approved_by ?? 'a maintainer';
  log.warn({ workItem: prKey, approver }, 'merge allowed — approval consumed');

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `Merge approved by @${approver}. This approval is now used up.`,
    },
  };
}

function deny(reason: string): HookDecision {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// ── Recognising an approval ───────────────────────────────────────────────────

export interface ApprovalAttempt {
  matched: boolean;
  /** Set when the phrase matched but the actor was not permitted to say it. */
  refusedReason?: string;
}

/**
 * Decide whether a comment authorises a merge.
 *
 * The permission check is the load-bearing part, and it deliberately queries
 * GitHub rather than trusting `author_association` from the payload. Untrusted
 * text must never set the merge flag: the phrase is matched by the Router
 * against the actor's *actual* permission level, never inferred by the model
 * and never taken from the event body.
 */
export async function tryApprove(
  api: GitHubApi,
  input: {
    prKey: string;
    repo: string;
    actor: string;
    body: string;
    approvalPhrase: string;
    ttlMinutes: number;
  },
): Promise<ApprovalAttempt> {
  if (!containsPhrase(input.body, input.approvalPhrase)) return { matched: false };

  const permission = await api.permissionLevel(input.repo, input.actor);
  if (!APPROVING_PERMISSIONS.has(permission)) {
    log.warn(
      { actor: input.actor, permission, prKey: input.prKey },
      'merge approval phrase from an actor without write access — ignored',
    );
    return {
      matched: true,
      refusedReason: `@${input.actor} has ${permission} access; approving a merge needs write access.`,
    };
  }

  approveMerge(input.prKey, input.actor, input.ttlMinutes);
  return { matched: true };
}

/**
 * Phrase matching, on a line of its own or at the start of one.
 *
 * Anchoring to line starts is what stops "please don't say @gquay merge until
 * CI is green" from being read as an approval. It is not a complete defence —
 * nothing textual is — which is why the permission check above, the TTL, and
 * single-use consumption all sit behind it.
 */
export function containsPhrase(body: string, phrase: string): boolean {
  const needle = phrase.trim().toLowerCase();
  return body
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .some((line) => line === needle || line.startsWith(`${needle} `) || line.startsWith(`${needle}.`));
}
