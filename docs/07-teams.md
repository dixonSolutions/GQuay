# Teams

## The transport

Office 365 connectors are retired — the classic *channel → Connectors → Incoming Webhook* path is gone. The current mechanism is **Workflows (Power Automate)**: create a flow from the "When a Teams webhook request is received" trigger, add "Post card in a chat or channel", and copy the trigger URL.

Practical notes, all of which this implementation is built around:

- **The URL's `sig` parameter is a secret.** Treat the whole URL as a credential. It is redacted from logs, and hooks never see it — only the Hook Bus holds it.
- **Messages post as the Flow bot.** No custom name or icon, so the card's own title has to carry the identity.
- **Adaptive Cards are the target format.** MessageCard still renders but its buttons do not, and a card whose "Open issue" button is invisible defeats the point.
- **28 KB per message.** Enforced before sending; the detail block is dropped and the card links out rather than being rejected.
- **A Workflow is owned by a *user*, not a channel**, and orphans when that person leaves. Add a co-owner. GQuay posts a daily heartbeat card so a silently-dead workflow is noticed rather than discovered months later.

## The other transport: Teams MCP

Microsoft ships an official Teams MCP server — a hosted HTTP endpoint scoped to a tenant, with Graph-backed tools for teams, channels, messages and members. There are also community servers that run locally over stdio with device-code OAuth.

One constraint decides whether you can use any of them:

> **Posting Teams messages requires delegated, user-context Graph permissions.** The official server supports delegated auth only — application-only authentication is not supported, and app-only message posting on Graph is restricted to migration scenarios. Reading channel messages app-only falls under Teams protected APIs, with their own approval process.

An unattended agent has no signed-in user. So:

| Path | Works headless? | Cost |
|---|---|---|
| **Workflows webhook** | Yes | one-way only, posts as the Flow bot |
| **Teams MCP with a service-account identity** | Yes, via a dedicated licensed Entra user and a persisted refresh token | tenant admin consent, a licensed seat, token maintenance |
| **Teams MCP with a person's own identity** | No | the agent posts *as them*, which you do not want |

**Use the Workflows webhook.** Move to a service-account MCP only if you later need the agent to read replies or thread properly. In a managed tenant the admin-consent conversation is the long pole — find out early which of these it will allow.

## Locking it down on the agent side

```json
{
  "allowedHttpHookUrls": ["http://127.0.0.1:8787/hooks/*"],
  "httpHookAllowedEnvVars": ["HOOK_BUS_TOKEN"]
}
```

Hooks never talk to Teams directly — only to the Hook Bus, which holds the Workflows URL. One secret, one place, one allowlist. This also means a compromised repository cannot add a hook that exfiltrates to an external URL.

## Do you need replies from Teams?

Probably not.

Two-way means Graph change-notification subscriptions with renewal, or polling channel messages, plus the delegated-auth problem above. And you already have a perfectly good inbound channel: **GitHub comments**, which arrive as webhooks you are handling anyway.

So every card links back to the issue or PR, and you answer there. Teams tells you something needs you; GitHub is where you say it. One conversation log, one audit trail, and no auth work at all.

Add reply-reading later, once someone has actually complained about the round trip.

## The event matrix

Every notification is a row in `.github/gquay.yml`:

```yaml
teams:
  events:
    gquay.needs_input: { notify: true,  severity: attention, mention: assignee }
    issue.commented:   { notify: false }
    gquay.parked:      { notify: false }
```

Adding a notification is a config edit, not a code change. `teams.severity_floor` in `router.yml` is a second gate that drops anything below a threshold before it leaves the process — useful for turning the volume down globally without touching per-repo config.
