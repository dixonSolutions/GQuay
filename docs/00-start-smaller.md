# Start smaller

**Is the whole Router necessary to get an agent working an issue and opening a pull request?**

No. Not remotely. If that is the goal, you need none of GQuay — there is an official GitHub Action that does it in about fifteen lines of YAML, with no server, no public URL, no database and no TLS.

Start there. Use it for a couple of weeks. If you find yourself missing something specific, this document says which of GQuay's parts supplies it.

---

## The smallest thing that works

```bash
# 1. Install the Claude GitHub App
open https://github.com/apps/claude

# 2. Add a credential (subscription shown; ANTHROPIC_API_KEY also works)
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN

# 3. Drop in a workflow
cp examples/minimal-action/claude.yml .github/workflows/
git add . && git commit -m "Add Claude Code" && git push
```

Then comment `@claude implement this` on an issue.

Two ready-to-use workflows are in [`examples/minimal-action/`](../examples/minimal-action):

- **`claude.yml`** — responds to `@claude` on issues, PR comments, and newly opened issues.
- **`label-to-pr.yml`** — label an issue, get a pull request. Closer to GQuay's trigger model.

That is a real, working system. It reads the issue, writes code, runs tests, pushes a branch and opens a PR. It also already does two things GQuay reimplements: it refuses to act on users without write access, and it rejects bot actors so it cannot trigger itself in a loop.

---

## What you give up, precisely

Each row is a thing the Action genuinely cannot do, and the GQuay part that exists for it.

| You lose | Because | GQuay part |
|---|---|---|
| **Context continuity between comments** | Each event is a fresh container. Claude re-reads the thread but does not resume its own reasoning — it has forgotten the dead end it already ruled out. | the parking lot |
| **One agent owning an issue *and* its PR** | Every event is independent, so nothing connects the issue's run to the PR's run. | the linking rule |
| **A merge gate** | Nothing stops a merge except branch protection. | the `PreToolUse` gate |
| **Push scoping** | The agent's token can write to any branch the workflow's permissions allow. | the receive-pack proxy |
| **Running on your own hardware** | GitHub-hosted runners only. No internal APIs, no licensed toolchains, no warm build cache, no private network. | the dispatch target |
| **Coordination between concurrent agents** | Two labelled issues produce two runs with no knowledge of each other. | agent-locks integration |
| **Teams notification** | Results land on the issue and in the run log. | the Workflows relay |
| **Cost control on idle** | Nothing to idle — the container exits. *(This one is a gain, not a loss.)* | — |

**Read that table honestly.** For a solo developer on public repositories, most of those rows are things you will never miss. The parking mechanism is elegant, and it is worth exactly nothing if your agent finishes its work in one run.

---

## The one that actually decides it

Everything above reduces to a single question:

> **Do your issues get resolved in one pass, or do they turn into conversations?**

If someone labels an issue and the agent opens a PR that gets merged — the Action is not a compromise, it is the correct architecture. Fresh container, no state, nothing to supervise.

If instead you find yourself doing this:

```
you:    @claude implement this
claude: [opens a PR]
you:    actually the retry needs to be exponential
claude: [starts over, re-reads everything, rediscovers the constraints]
you:    and it still doesn't handle the 429 case
claude: [starts over again]
```

…then you are paying for a cold start and a re-read on every turn, and the agent keeps re-deriving conclusions it already reached. That is the problem the parked `await_events` call solves, and it is the only reason the Router exists.

---

## The middle path

If you want the Router but not the whole surface, most of GQuay is off by default. [`examples/minimal-router/router.yml`](../examples/minimal-router/router.yml) is a working configuration with Teams disabled, no comms channels, one local target and no dispatch workers.

That gets you the parked session, the linking rule and the merge gate — the three things steps 1–3 of the build order produce — with nothing else to operate.

You still need what the Action avoids: a host that stays up, a public HTTPS endpoint for the webhook, and a GitHub App you created yourself. That is the real price of the Router, and it is worth paying for conversation continuity and not much else.

---

## Suggested order

1. **The Action.** Today, in fifteen minutes. Genuinely try it.
2. **Notice what annoys you.** Cold starts? Losing the thread? Wanting it on a machine inside a network?
3. **Only then**, if the annoyance is specifically *conversation continuity*, move to the minimal Router.
4. Add Teams, dispatch workers and the comms registry when someone asks for them — not before.

Adopting step 4 before step 2 is how a project like this stalls: you spend the enthusiasm on the machinery and none on the thing the machinery was for.

---

## Can you run both?

Yes, and it is a reasonable end state. They trigger on different things:

- The Action on `@claude` mentions — quick, cheap, one-shot questions and small fixes.
- The Router on a `gquay` label — long-running work that will take several rounds of review.

Keep the trigger phrases distinct so a single event never starts both.
