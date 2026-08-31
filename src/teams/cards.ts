/**
 * Adaptive Cards for Teams.
 *
 * Adaptive Cards are the target format for the Workflows transport. MessageCard
 * still renders, but its buttons do not, and a card whose "Open issue" button is
 * invisible defeats the point — every card here links back to GitHub, because
 * GitHub is where the human answers (see docs/07-teams.md, "Do you need replies
 * from Teams?").
 *
 * The 28 KB message size limit is real and is enforced here rather than
 * discovered at the API. Agent output is truncated and the card links out; a
 * silently rejected notification is worse than a short one.
 */

export type Severity = 'info' | 'success' | 'attention' | 'warn' | 'error';

/** Adaptive Cards accept a fixed vocabulary; `warn` and `error` both map to attention. */
function cardColour(severity: Severity): string {
  switch (severity) {
    case 'success':
      return 'good';
    case 'warn':
    case 'error':
      return 'attention';
    case 'attention':
      return 'warning';
    default:
      return 'default';
  }
}

function icon(severity: Severity): string {
  return { info: 'ℹ️', success: '✅', attention: '🔔', warn: '⚠️', error: '🛑' }[severity];
}

export interface CardInput {
  title: string;
  severity: Severity;
  /** One-line summary. Always shown. */
  summary: string;
  /** Optional detail block, truncated to fit the size limit. */
  detail?: string;
  facts?: { name: string; value: string }[];
  /** Link buttons. The GitHub thread should always be one of them. */
  actions?: { title: string; url: string }[];
  /** Logins to @-mention. Requires the matching mention.* scope upstream. */
  mentions?: { login: string; displayName?: string }[];
}

export const MAX_MESSAGE_BYTES = 28 * 1024;
/** Leave room for the envelope, mentions, and actions. */
const DETAIL_BUDGET = 12 * 1024;

export function truncate(text: string, limit = DETAIL_BUDGET): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  const cut = buf.subarray(0, limit - 64).toString('utf8');
  return `${cut}\n\n… truncated — full text is on the GitHub thread.`;
}

export function buildCard(input: CardInput): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    {
      type: 'TextBlock',
      text: `${icon(input.severity)} ${input.title}`,
      weight: 'Bolder',
      size: 'Medium',
      color: cardColour(input.severity),
      wrap: true,
    },
    { type: 'TextBlock', text: input.summary, wrap: true },
  ];

  if (input.detail) {
    body.push({
      type: 'TextBlock',
      text: truncate(input.detail),
      wrap: true,
      isSubtle: true,
      fontType: 'Monospace',
    });
  }

  if (input.facts?.length) {
    body.push({ type: 'FactSet', facts: input.facts });
  }

  if (input.mentions?.length) {
    body.push({
      type: 'TextBlock',
      text: input.mentions.map((m) => `<at>${m.displayName ?? m.login}</at>`).join(' '),
      wrap: true,
    });
  }

  const card: Record<string, unknown> = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body,
    ...(input.actions?.length
      ? {
          actions: input.actions.map((a) => ({
            type: 'Action.OpenUrl',
            title: a.title,
            url: a.url,
          })),
        }
      : {}),
    ...(input.mentions?.length
      ? {
          msteams: {
            entities: input.mentions.map((m) => ({
              type: 'mention',
              text: `<at>${m.displayName ?? m.login}</at>`,
              mentioned: { id: m.login, name: m.displayName ?? m.login },
            })),
          },
        }
      : {}),
  };

  return card;
}

/** The envelope a Workflows "When a Teams webhook request is received" trigger expects. */
export function buildPayload(card: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: card,
      },
    ],
  };
}

/** True when the serialised payload would be rejected for size. */
export function exceedsLimit(payload: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_MESSAGE_BYTES;
}
