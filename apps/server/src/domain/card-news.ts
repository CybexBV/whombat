/**
 * Whether a live card has news (docs/decisions/card-moves.md): what moves a council's or a checklist's card to the end
 * of its thread. Pure, so it is tested on its own.
 */

/** What the person reads on a council's or a checklist's card: its stage, each member's or task's state, how it ended. */
function newsOf(card: unknown): string | null {
  if (!card || typeof card !== 'object') return null;
  const c = card as Record<string, unknown>;
  if (c.kind === 'council') {
    const members = Array.isArray(c.members) ? (c.members as Record<string, unknown>[]) : [];
    return JSON.stringify([
      c.stage,
      c.round,
      c.live,
      c.outcome,
      !!c.plan,
      Array.isArray(c.shots) ? c.shots.length : 0,
      members.map((m) => [m.id, m.state, m.score, m.verdict]),
    ]);
  }
  if (c.kind === 'delegation') {
    const tasks = Array.isArray(c.tasks) ? (c.tasks as Record<string, unknown>[]) : [];
    return JSON.stringify([
      c.stage,
      c.live,
      c.outcome,
      tasks.map((t) => [t.id, t.title, t.state, t.pending, t.merge, t.checks, !!t.pr]),
    ]);
  }
  return null;
}

/**
 * Whether the card changed in a way worth moving it for: a stage, a member's answer or a task's state, not what a
 * task or the builder does now (its step), a clock or the words under it.
 */
export function cardNews(before: unknown, after: unknown): boolean {
  const next = newsOf(after);
  return next !== null && next !== newsOf(before);
}
