/**
 * `whats_protected` (docs/decisions/backup-trust.md): the What's protected page for the assistant, in the person's
 * words, so it can answer “what would I lose if pve-01 died?” and “are my backups any good?”.
 */
import {
  protectedGroupOf,
  protectedOffsiteLine,
  protectedPageWords,
  protectedRowLine,
  restoreTestLine,
  restoreTestVerdict,
  type WhatsProtectedInput,
  type WhatsProtectedOutput,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { burrowLocale } from '../i18n/locale';
import type { ToolContext } from '../mcp/tools';
import { ownTurn } from '../vault/self-serve';
import { protectedView } from './view';

const LINES_MAX = 80;

export async function whatsProtectedTool(
  ctx: ToolContext,
  input: WhatsProtectedInput,
): Promise<WhatsProtectedOutput> {
  const { services } = ctx;
  const note =
    'Three groups: copied to another machine (safe if one machine breaks), only on the same machine (lost with it), not backed up that Whombat can see. “Whombat can’t see its backups” isn’t “not backed up”. Answer in a sentence or two; offer to set up backups or restore tests only when it helps.';
  const turn = await ownTurn(services.db, ctx);
  if (!turn)
    return {
      copied: [],
      sameMachine: [],
      notBackedUp: [],
      restoreTests: [],
      unread: [],
      note: 'Only in the person’s own chat.',
    };
  const [burrow] = await services.db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, ctx.burrowId));
  const timeZone = burrow?.timeZone ?? 'UTC';
  const locale = await burrowLocale({ db: services.db });
  const view = await protectedView(services, ctx.burrowId);
  const now = services.clock();
  const want = input.thing?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const matches = (text: string) => want.every((w) => text.toLowerCase().includes(w));
  const out: WhatsProtectedOutput = {
    copied: [],
    sameMachine: [],
    notBackedUp: [],
    restoreTests: [],
    unread: view.unread,
    note,
  };
  for (const row of view.rows) {
    if (want.length && !matches(`${row.name} ${row.on ?? ''} ${row.catalogId ?? ''}`)) continue;
    const offsite = row.offsite ? ` · ${protectedOffsiteLine(row.offsite, now, timeZone, locale)}` : '';
    const line = {
      name: row.name,
      kind: row.kind,
      ...(row.on ? { on: row.on } : {}),
      line: `${protectedRowLine(row, now, timeZone, locale)}${offsite}`,
      ...(row.restoreTest ? { test: restoreTestLine(row.restoreTest, now, timeZone, locale) } : {}),
      ...(row.href ? { page: row.href } : {}),
    };
    const group = protectedGroupOf(row.state);
    const list = group === 'copied' ? out.copied : group === 'local' ? out.sameMachine : out.notBackedUp;
    if (list.length < LINES_MAX) list.push(line);
  }
  const words = protectedPageWords(locale);
  for (const s of view.restoreTests) {
    if (want.length && !matches(`${s.serverName} ${s.eligible.map((g) => g.name).join(' ')}`)) continue;
    const chosen = s.guests.length
      ? s.eligible
          .filter((g) => s.guests.includes(g.id))
          .map((g) => g.name)
          .join(', ')
      : words.testsAll;
    out.restoreTests.push({
      server: s.serverName,
      on: s.on,
      machines: chosen || words.testsAll,
      ...(s.last
        ? { last: `${s.last.guestName}: ${restoreTestVerdict(s.last, now, timeZone, locale)}` }
        : {}),
      ...(s.blocked ? { blocked: words.blocked(s.blocked) } : {}),
    });
  }
  return out;
}
