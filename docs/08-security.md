# Security

## Prompt injection is the headline risk

Issue bodies and PR comments are attacker-controlled text on a public or semi-public surface, and they flow straight into an agent that holds a GitHub App token.

The mitigations, in order of importance:

**1. Only act on events from users with write access.** Everything else is logged and dropped, before the text reaches a model at all. `Router.actorMayAct()` queries the GitHub API — not the `author_association` field in the payload, which is a weaker signal the sender partly controls.

**2. Untrusted text never sets the merge flag.** The approval phrase is matched by the Router against the actor's real permission level. The model never infers approval, and the flag is not reachable from anything an agent can call.

**3. Framing states facts, it does not issue commands.** Delivered text is wrapped with the author, their permission level, and the source URL, then fenced. The wrapper reads as a description of provenance rather than an override, because text framed as an out-of-band system command can trip Claude's own prompt-injection defences.

The framing guarantees one narrow thing absolutely: a comment cannot close its own container and appear to be speaking as the Router. A zero-width space is inserted before any line-initial fence marker or `Human:`/`Assistant:`/`System:` role marker. Nothing else is mangled — distorting the text would make the agent worse at its actual job.

The framing also only promises what it can deliver: it refers to "a person with write access" when it knows the permission level, and to "that person" when it does not.

**4. Least-privilege toolsets.** `GITHUB_TOOLSETS` and `--exclude-tools` limit what exists at all, which is a stronger control than any prompt. Do not enable `code_security` or `projects` unless you use them.

**5. Separate the runner host from anything holding production secrets.**

---

## The branch-scoped push proxy

The single best idea in the cloud model, and worth copying exactly: the agent never holds a credential that can write to `main`.

### One correction to the obvious implementation

The design sketch describes a *git credential helper* that "only mints credentials for `gquay/<work-item>`". **A credential helper cannot do that.** Git hands it the protocol, host and path, and nothing about the refs being pushed — the credential is minted before git has said what it intends to write.

So branch scoping has to happen where the refs are actually visible: inside the `git-receive-pack` request. That means a proxy, not a helper.

A worktree's push URL points at the Router:

```
https://<router>/git/<session-token>/<owner>/<repo>.git
```

Fetches pass straight through. Pushes are parsed — the pkt-line preamble carries `<old-sha> <new-sha> <ref>` lines — and every ref update must target this work item's own branch, or the request is refused before a byte reaches GitHub.

Three properties matter:

- **A push whose refs cannot be read is refused.** A malformed or undecodable preamble is not forwarded. Unparseable means uncheckable.
- **One bad ref poisons the whole push.** Git only applies updates atomically with `--atomic`, so refusing the request is the only way to be sure `main` is untouched.
- **The session token is bound to one repository.** A valid token used against a different repo in the same installation is refused and logged.

Errors come back as a pkt-line the git client prints, so the agent sees *why* it was refused. A silent refusal teaches it nothing.

Combined with the merge gate and branch protection, an agent that goes wrong cannot touch the default branch — and you do not have to trust all three layers to each work.

---

## The guards, and their order

Every event passes through these before anything is spawned:

```
1. HMAC signature over the raw bytes           (invalid → 401, nothing else runs)
2. Delivery-id dedupe                          (replay → 200, no side effects)
3. allowed_repos perimeter                     (outside → dropped)
4. Bot-actor loop guard                        (agent's own comment → dropped)
5. GQUAY_ENABLED                               (kill switch, at receipt not at spawn)
6. Trigger label                               (absent → dropped)
7. Actor write access, from the GitHub API     (absent → dropped + audit log)
```

And every tool call the agent makes passes through:

```
PreToolUse merge gate      before any permission-mode check
PreToolUse comms ceiling   scope, mentions, urgency floor, rate limit, quiet hours
PreToolUse edit guard      repo protected_paths, then sibling agents' claims
```

`PreToolUse` denials hold under `bypassPermissions`. That is the property the whole unattended posture rests on.

## Webhook verification

The HMAC is computed over the *exact bytes* GitHub sent. Parsing JSON and re-serialising changes whitespace and key order and the signature will never match, so the ingress keeps the raw buffer alongside the parsed body. There is a test for exactly this.

The comparison is constant-time, including the length-mismatch path — bailing early on a length difference is itself a timing signal.

## Secrets in logs

Four classes of secret pass through this process: the App private key, installation tokens, the Teams Workflows URL, and per-session MCP bearers. They are redacted centrally in `src/log.ts` rather than at each call site, and `safeUrl()` strips the `sig` parameter so a Teams URL can be logged identifiably without being usable.

`gquay show` never prints a work item's MCP token.

## Worth considering on managed infrastructure

`allowManagedHooksOnly` blocks user, project and plugin hooks in favour of admin-controlled ones. Heavy-handed for a prototype, right for production on infrastructure someone else administers.

## Auth choice

A Max-plan OAuth token works for personal automation. This pipeline routes *other people's* requests through one person's seat and runs on shared infrastructure — the case that calls for an API key or a Team plan. Use a Console API key with its own billing and spend controls, and settle it before building.
