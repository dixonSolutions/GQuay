# Comms

## Why not hand the agent a raw Teams MCP

A generic `send_channel_message(teamId, channelId, body)` means the model juggles GUIDs, can discover and post to any channel in the tenant, and has no idea which one is appropriate.

Instead GQuay exposes a **channel registry**: each channel has a name, a description, an attention cost, and a set of granted scopes. The agent picks the channel; the registry gives it enough to pick well, and the `PreToolUse` hook is a hard floor under the choice.

## The scope vocabulary

Scopes read like Entra/Graph scopes deliberately — `<channel>:<capability>` — because that is the mental model whoever administers this already has.

| Capability | Grants |
|---|---|
| `mirror` | the Hook Bus may post here; **the agent may not** |
| `post` | start a new thread of its own accord |
| `reply` | reply within a thread it owns |
| `ask` | post a blocking question and register `awaiting_input` |
| `read` | read the channel back (only if two-way is wired) |
| `mention.assignee` | @-mention the issue/PR assignee |
| `mention.owner` | @-mention the GQuay owner |
| `mention.channel` | @-mention everyone — grant this almost nowhere |
| `attach` | include diffs, logs or files rather than links |
| `escalate` | re-post an unanswered item after the idle threshold |
| `override_quiet_hours` | post outside the channel's quiet window |

A session's grant set is a flat list, resolved once at spawn and logged as `SessionStart` context, so the transcript records exactly what the agent was allowed to say and where:

```
activity:mirror
decisions:post decisions:reply decisions:ask decisions:mention.assignee decisions:escalate
incidents:post incidents:mention.owner incidents:override_quiet_hours incidents:attach
notes:post
```

Note what is missing. Nothing has `mention.channel`. `notes` cannot `ask` — questions belong where someone is watching. `activity` has only `mirror`, so the agent cannot post there at all even though its own lifecycle fills it. An unknown capability in the YAML is a typo, and is dropped with a warning rather than granted.

## Writing a channel description

The description is a prompt, not documentation. Four things, in this order:

1. **What belongs here** — the class of message, concretely.
2. **Who reads it and how fast** — this is what sets the model's threshold.
3. **What response is expected** — none / a decision / immediate action.
4. **What does *not* belong here**, naming the better channel.

The common failure is describing the *source*: "messages from the GitHub agent" tells the model nothing, because every channel matches. Describe the **reader's obligation**. `attention_cost` gives a cheap comparator when two channels both fit — prefer the cheapest adequate one, same as a person would.

See `.github/gquay.yml` in this repository for four worked examples.

## The tool surface

```
list_channels()                                        → channels you can reach, with scopes and budget
post(channel, summary, detail?, urgency, mention?)     → { posted, rate_limit_remaining }
reply(channel, body, urgency?)                         → { posted }
ask(channel, question, options?)                       → { ticket_id, answer: null }
```

`list_channels` returns only channels the session holds a scope on, with `granted_scopes` and `rate_limit_remaining`. The agent chooses from a menu of things it can actually do, rather than discovering its limits by being denied.

**`ask` is asynchronous.** It posts the question, flips the work item to `awaiting_input`, starts the idle clock, and returns a ticket — not a reply. If the model believes `ask` returns an answer it will block on it and burn a turn finding out otherwise, so the tool description says so in as many words and the return payload repeats it.

## The selection contract

This lives in the MCP server's `instructions`, not in a CLAUDE.md — the contract has to travel with the tools.

> Call `list_channels` and choose the cheapest channel adequate to the message. Ask in order: *Is the pipeline or main branch broken?* → incidents. *Is someone blocked on a decision only a human can make?* → decisions. *Would a colleague want to know this but not act on it?* → notes. *None of the above?* → **say nothing.** Silence is the correct default and costs you nothing.

That last clause matters more than the rest. Without an explicit "no channel" option the model treats channel selection as mandatory and finds something to say every time.

Worked examples:

| Situation | Channel | Why |
|---|---|---|
| Opened a PR for #42 | *(none)* | the agent has no `activity` scope; the Hook Bus already mirrors it |
| Two valid schema migrations, needs a call | `decisions` | blocked, specific, one-word answer possible |
| Noticed an unrelated null-deref while reading | `notes` | worth knowing, nobody must act |
| Third rate-limit hit in ten minutes | `incidents` | work cannot continue and waiting will not fix it |
| Tests failing on its own branch | *(none)* | that is the agent's job to fix, not to report |

## The ceiling

`PreToolUse` on `mcp__gquay__(post|reply|ask)`, in this order:

```
deny if the required scope is not granted
deny if a mention is requested without the matching mention.* scope
deny if an attachment is included without attach
deny if re-posting without escalate
deny if urgency < the channel's urgency_floor
deny if the channel's rate limit is spent
defer if inside quiet hours and override_quiet_hours is not granted
```

Every denial names a better channel — "this isn't blocking; post it to #gquay-notes instead" — so the model re-routes rather than giving up.

The check lives in the hook rather than inside the comms server for two reasons. `PreToolUse` fires before any permission-mode check, so a deny holds even under `bypassPermissions` — the same property that makes the merge gate trustworthy. And a hook deny is visible to the model as feedback, whereas a silent server-side drop teaches it nothing.

Every attempt, allowed or denied, is written to `comms_log`, so "why did the agent go quiet" is answerable.

## Naming

Name channels by **the decision they demand**, not by the system that fills them. `#gquay-needs-you` gets read; `#gquay-bot` gets muted in a week. GQuay appears only as a namespace — the words that earn the channel its attention are *needs-you*.

One owner, one purpose per channel. A channel carrying both routine mirrors and blocking questions trains people to skim, and then the blocking questions get missed. Keeping the channel people must watch separate from the channel nobody has to is what stops the whole integration being switched off.
