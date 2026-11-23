/**
 * A message's card as the user turn shows it: what the card says in a few words (a plan's title, a run's number and
 * status, an approval's number and state, a digest's sections …), so the agent reads the room as people see it. A
 * guided setup's card reads as what it asked and what the person chose (assistant-guides.md AG-18). A Whombat Feedback
 * report card is never shown this way (`reportCardNote`, FB-F3-12). A schedule card says when and how it stands, never
 * what the agent wrote for it (`scheduleCardText`, resourceful-agents.md RA-30). A deploy card says what went where and how
 * it ended (`deployCardText`), a followed server task what it does and how it ended (`taskCardText`), a Find My watch
 * whom it watches and how it stands (`findMyWatchCardText`, findmy-watch.md).
 */
import {
  deployCardText,
  findMyWatchCardText,
  guideCardText,
  type Message,
  scheduleCardText,
  taskCardText,
} from '@whombat/core/domain';

export function cardNote(message: Pick<Message, 'card'>, timeZone = 'UTC'): string | null {
  const card = message.card;
  if (!card) return null;
  switch (card.kind) {
    case 'plan':
      return `[plan card: ${card.plan.title}]`;
    case 'run':
      return `[run card: Run #${card.run.number} · ${card.run.title} · ${card.run.status}]`;
    case 'approval':
      return `[approval card #${card.approval.number}: ${card.approval.title} · ${card.approval.state}]`;
    case 'review':
      return `[review card: ${card.file}${card.line ? `:${card.line}` : ''} · ${card.comments.map((c) => `${c.n}. ${c.text}`).join(' ')}]`;
    case 'research':
      return `[research card: ${card.topic} · ${card.rows.map((r) => `${r.name} (${r.verdict})`).join(', ')}]`;
    case 'pill':
      return `[status: ${card.text}]`;
    case 'answer':
      return `[answer with ${card.receipts.length} receipts]`;
    case 'guide':
      return guideCardText(card);
    case 'schedule':
      // “[schedule: Every 30 minutes; active]”, the contracts' own text (RA-30).
      return scheduleCardText(card, timeZone);
    case 'deploy':
      // “[deploy: api to production, succeeded]” (contracts CT-297, Whombat RF-02).
      return deployCardText(card);
    case 'task':
      // “[task: Installing 3 updates on shale, ok — shale is up to date…]” (contracts CT-880, Whombat TF-10).
      return taskCardText(card);
    case 'findmy_watch':
      // “[watch: Noor Visser leaves Keizersgracht; watching]”, with its id so the agent can cancel it when asked.
      return `${findMyWatchCardText(card)} (watchId ${card.watchId})`;
    case 'digest':
      return `[digest card: ${[card.title, card.summary].filter(Boolean).join(' · ')} · ${card.sections
        .map(
          (sec) =>
            `${sec.label}: ${sec.items.map((i) => [i.title, i.source && `from ${i.source}`, i.time].filter(Boolean).join(' ')).join('; ')}`,
        )
        .join(' | ')}]`;
    default:
      return `[${(card as { kind: string }).kind} card]`;
  }
}
