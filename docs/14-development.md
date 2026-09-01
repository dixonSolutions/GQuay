# Development

```bash
npm install
npm run build          # tsup → dist/
npm run dev            # nodemon + tsx, pretty logs
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # node --test via tsx
```

CI runs all five on Node 20 and 22, plus three structural checks: the hook overlay renders to valid JSON and covers the required events, the example configs parse, and the hook scripts pass `bash -n`.

Node 20 is the `engines` floor and is tested, not merely declared. That is not decoration — the original test script used a quoted glob that only newer runners expand, and CI caught it on the first push.

---

## Conventions

Inherited from AgentVoice next door, since GQuay is the same shape of service.

**ESM with `.js` import specifiers.** `import { getDb } from '../state/db.js'` even though the file is `.ts`. `moduleResolution: NodeNext` requires it.

**A file header comment on every module** explaining what it is *for* and what decision it embodies — not what the code does line by line. If a module exists because an obvious alternative was wrong, the header says which alternative and why. That is the part nobody can reconstruct from the code six months later.

**`strict` plus `noUncheckedIndexedAccess`.** Array and record access yields `T | undefined`. The non-null assertions you'll see are on values just proven present, usually by a regex match or a length check.

**`exactOptionalPropertyTypes` behaviour via spreads.** Optional fields are built with `...(x ? { k: x } : {})` rather than `k: x ?? undefined`, which keeps `undefined` out of objects that model "absent".

**Structured logging.** `childLogger('module-name')`, object first, message second: `log.info({ key, target }, 'session spawned')`. Never string-interpolate values into the message — they should be greppable fields.

---

## Where things live

| If you're changing… | Look at |
|---|---|
| what happens on a GitHub event | `src/router/router.ts` → `route()` |
| how an event reaches a live agent | `src/router/router.ts` → `deliver()`, `src/mcp/parking.ts` |
| the tools an agent can call | `src/mcp/server.ts`, `src/mcp/instructions.ts` |
| what an agent is allowed to do | `runner/settings.json` + `src/hooks/bus.ts` |
| where sessions run | `src/runners/` |
| how config resolves | `src/router/repoConfig.ts` |
| what an agent sees on spawn | `src/router/prompt.ts`, `src/mcp/framing.ts` |

---

## Adding a webhook event

1. Add it to `GhEventKind` and `normalise()` in `src/github/events.ts`. Extract only what the routing table matches on; carry the rest opaquely.
2. Add a case to `Router.route()`.
3. Add a test in `test/webhook.test.ts` — especially an "unrecognised shape degrades gracefully" case.
4. Subscribe the GitHub App to it.

`normalise()` never throws on an unfamiliar payload; it returns `kind: 'unhandled'`. A malformed event should be ignorable, not fatal.

## Adding an MCP tool

1. `server.registerTool()` in `src/mcp/server.ts`. The description is a prompt — say what the tool does *and what it does not do*. `ask` returning a ticket rather than an answer is stated in three places for exactly this reason.
2. If it needs gating, add a `PreToolUse` matcher to `runner/settings.json` and an endpoint to the Hook Bus. The gate belongs in the hook, not in the tool: `PreToolUse` fires before permission checks, and a hook deny is visible to the model as feedback.
3. Add `annotations: { readOnlyHint: true }` where true.

## Adding an execution target

1. Implement `ExecutionTarget` in `src/runners/`.
2. Add its kind to `TargetSchema` in `src/config.ts`, plus any cross-field check to `validateTargets()`.
3. Wire it into `ExecutionPlane`'s constructor.
4. Be honest about `parking`. If the target cannot hold a call for hours, say so — `claude_cloud` has `parking` forced to `false` at config load even when the YAML claims otherwise.

## Adding a config key

Decide the tier first ([06-configuration](06-configuration.md)):

- **A value a non-developer flips under pressure** → an Actions Variable, handled in `applyVariables()`. Remember there is no change webhook.
- **Anything that deserves review** → `RepoConfigSchema` and `.github/gquay.yml`.
- **Host infrastructure** → `RouterConfigSchema` and `router.example.yml`.
- **A secret** → the environment. It cannot live in GitHub: Actions secrets cannot be read back.

---

## Tests

`test/*.test.ts`, `node:test` through the `tsx` loader. 99 assertions across nine files.

They concentrate on the places where working-looking code is wrong:

| File | What it pins down |
|---|---|
| `webhook.test.ts` | HMAC over raw bytes, constant time, the bot guard, PR-vs-issue comments |
| `parking.test.ts` | the lost-wakeup race, exactly-once across two waiters, abort cleanup |
| `registry.test.ts` | the linking rule in both directions, the two clocks, single-use approval |
| `mergeGate.test.ts` | phrase anchoring, permission checks, per-PR scoping |
| `pushProxy.test.ts` | pkt-line parsing, and that every malformed case refuses |
| `comms.test.ts` | scopes, urgency floors, rate limits, midnight-wrapping quiet hours |
| `locks.test.ts` | tolerant parsing, overlap bias, case normalisation, reaping |
| `framing.test.ts` | a comment cannot close its own fence or impersonate a role marker |
| `config.test.ts` | cross-field validation, retry classification, glob matching |

**Write the test that would have caught the bug.** `signature is byte-exact — re-serialised JSON does not verify` exists because that is the mistake everyone makes with GitHub webhooks. `an event that lands before the call registers is not lost` exists because that race is invisible until production.

Tests that open a database use `mkdtempSync` and clean up in `after()`. `GQUAY_LOG_LEVEL=silent` is set by the npm script.

---

## The end-to-end test

```bash
npm run build && npm run test:e2e
```

`test/e2e/park-and-wake.mjs` is the only test that covers the whole delivery path:

```
HMAC-verified webhook -> dedupe -> routing table -> permission check
  -> event queue -> doorbell -> parked MCP call returns -> framed output
```

Every one of those is a place the loop can come apart without a unit test noticing. `parking.test.ts` exercises the ParkingLot in isolation; `webhook.test.ts` exercises signature verification in isolation. Neither would catch the two being wired together wrongly.

It is self-contained — free ports from the OS, a throwaway RSA key, a temporary `router.yml`, a mock GitHub, the Router booted from `dist/`, all cleaned up afterwards. No network, no GitHub App, no public URL. It runs in CI after the build.

```
  ✓ parked call returned
  ✓ exactly one event delivered
  ✓ the comment body survived the round trip
  ✓ the author's real permission level is attached
  ✓ framed output fences the untrusted body
  ✓ a bad signature is rejected (401)
  ✓ a replayed delivery id is deduped
  ✓ the merge gate denies without an approval

  parked call woken in 1435ms
```

It has been mutation-checked: removing `parking.notify()` from the Router makes it fail rather than pass slowly. Re-run it after any change to `parking.ts`, `server.ts`, `router.ts` or the `Stop` hook — those four are the loop.

---

## Things that will bite you

**Editing the generated `settings.json`.** It is regenerated per spawn from `runner/settings.json`. Edit the template.

**Changing a shipped migration.** Append a new one. The applied index is recorded, so an edited entry silently never runs on an existing install.

**Making a `PreToolUse` gate slow.** A hook that times out does *not* block the tool call — execution continues through the normal permission flow. Gates must fail closed and fail fast.

**Logging a token.** Four classes of secret pass through: the App private key, installation tokens, the Teams URL (whose `sig` is the credential), and per-session MCP bearers. Redaction is central in `src/log.ts`; add new paths there rather than remembering at each call site.

**Assuming an MCP server is connected at `SessionStart`.** It usually isn't. Use `http` hooks there.

**Forgetting that `mcp__server__` is an exact-string prefix.** A whole-server matcher needs `mcp__github__.*`.
