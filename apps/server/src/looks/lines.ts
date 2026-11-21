/**
 * The lines one research covers (docs/decisions/handle-it.md): a thing's problems and only-you lines as Whombat words
 * them, kept on its research row. The assistant looks into all of them in one turn; a line that isn't among them is
 * a new problem, one that went isn't. Pure.
 */
import { isCareCheck, LOOK_LINES_MAX } from '@whombat/core';
import type { LookLineRow } from '../db/schema/index';

export type LookLine = LookLineRow;

/** A line as a research keeps it, from a server's or a thing's line; none for a heads-up. */
export function lookLine(l: {
  check?: string | null;
  subject?: { id: string } | null;
  title: string;
  nature: 'problem' | 'you' | 'fyi';
}): LookLine | null {
  if (l.nature === 'fyi') return null;
  const title = l.title.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!title) return null;
  return { check: l.check ?? null, subject: l.subject?.id ?? '', title, nature: l.nature };
}

/** The lines of a thing as a research keeps them: one each, at most `LOOK_LINES_MAX`. */
export function lookLines(
  lines: readonly Parameters<typeof lookLine>[0][],
  max: number = LOOK_LINES_MAX,
): LookLine[] {
  const out: LookLine[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const line = lookLine(l);
    if (!line) continue;
    const key = lineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** One key per line: its check and item (a line without a check by its words). */
export function lineKey(l: Pick<LookLine, 'check' | 'subject' | 'title'>): string {
  return l.check ? `${l.check}|${l.subject}` : `?|${l.title}`;
}

/**
 * Whether a look's lines are all among those a research covers (`covered`): a line it didn't look into is a new
 * problem; one that went isn't. Unknown (true) when either side doesn't know its lines.
 */
export function linesCovered(covered: readonly LookLine[], now: readonly LookLine[]): boolean {
  if (!covered.length || !now.length) return true;
  const keys = new Set(covered.map(lineKey));
  return now.every((l) => keys.has(lineKey(l)));
}

/** A look as the care rules weigh it: how bad (2: to look at), its line and every line of the thing. */
interface CareWeighed {
  rank: number;
  check: string | null;
  lines: readonly Pick<LookLine, 'check'>[];
}

/**
 * Whether every line of a look is one a server's care plan answers (missing backups, snapshots, waiting updates;
 * care-plan.md): while its care plan waits, such a look is the plan's, not a new research's.
 */
export function onlyCareLines(look: CareWeighed): boolean {
  if (look.rank !== 2) return false;
  const checks = look.lines.length ? look.lines.map((l) => l.check) : [look.check];
  return checks.every((check) => isCareCheck(check));
}

/** Whether a look's lines include one a care plan answers: its research is offered the care plan's steps. */
export function hasCareLines(look: Pick<CareWeighed, 'check' | 'lines'>): boolean {
  return look.lines.length ? look.lines.some((l) => isCareCheck(l.check)) : isCareCheck(look.check);
}
