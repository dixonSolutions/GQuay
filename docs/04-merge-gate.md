# The merge gate

**Requirement:** the agent can merge, but only when asked.

## Two wrong solutions

**Excluding `merge_pull_request` from the GitHub MCP toolset.** Then it can never merge, and the "when asked" path dies with it.

**A settings-level `deny` rule.** Same outcome, for a subtler reason: a hook returning `allow` cannot loosen a deny that came from settings. Policy only tightens.

## The solution

A `PreToolUse` hook on `mcp__github__merge_pull_request` that consults the registry (`src/router/mergeGate.ts`, endpoint `/hooks/merge-gate`).

It returns `deny` with an actionable reason unless `merge_approved_until > now()` for that PR, in which case it returns `allow`.

This is the strong version because **`PreToolUse` hooks fire before any permission-mode check**. A deny blocks the call even under `bypassPermissions` or `--dangerously-skip-permissions`. Hooks can tighten policy past what permissions allow; they can never weaken it. That property is what makes GQuay safe to run unattended.

## How approval is granted

Only by the Router. Only when a human with write access posts the approval phrase on that specific PR. Never inferred by the model, and never settable from delivered comment text.

Four independent things have to hold:

1. **The phrase matches**, anchored to the start of a line. This is what stops *"please don't say @gquay merge until CI is green"* being read as approval. It is not a complete defence — nothing textual is — which is why the other three exist.
2. **The actor has write access**, checked against the GitHub API at the moment of approval. Not `author_association` from the payload, which is a weaker signal the sender partly controls.
3. **The approval has not expired.** Default TTL 15 minutes.
4. **The approval has not been used.** It is consumed the instant the tool call is allowed, so a retry loop cannot turn one approval into several merges.

Approval is also **per-PR**. An approval posted on the issue does not authorise merging its pull request, even though one session owns both — they are different threads with different audiences.

## How it fails

Two cautions, both handled in `runner/settings.json`.

**A hook that times out does not block the tool call.** Execution continues through the normal permission flow. So the gate endpoint fails closed and fails fast, *and* `merge_pull_request` sits behind a settings-level `ask` rule as a floor. A dead Hook Bus degrades to "no merge", not "free merge".

**An unreachable endpoint is a non-blocking error** and execution continues — same mitigation.

Underneath both: branch protection on the default branch requiring an approving review. If the Hook Bus is down *and* the permission floor is misconfigured, GitHub still refuses.

## The alternative worth considering

Instead of parsing an approval phrase, have the agent *request* a merge and let the Router fire a `workflow_dispatch` against a **GitHub Environment with required reviewers**. The human approves in GitHub's native UI, the workflow performs the merge, and you inherit the approval audit trail for free.

More moving parts, much better provenance. Worth it if this ends up under change control. `GitHubApi.dispatchWorkflow` is there for it.

## Applying the pattern elsewhere

The same shape works for `issue_write` with `state: closed`. Deletions are worth gating harder — GitHub issue deletion is not recoverable.
