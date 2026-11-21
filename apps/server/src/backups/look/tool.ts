/**
 * `backup_bring_back` (backup-look.md): the assistant gets back something the person lost — “bring back yesterday’s chat
 * about the roof”. `find` opens the newest backup from before the person's time hint and lists what matches their words;
 * `bring` puts the things they chose on a card (`backup.lookBring` through the settings key: it always asks) and their
 * yes brings them back, as them, waking the assistant with how it went. What the agent passes on is plain words: no ids,
 * no paths.
 */
import type { BackupBringBackInput, BackupBringBackOutput } from '@whombat/core';
import { BackupCheckpointList } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { accounts, burrows } from '../../db/schema/index';
import { LIST } from '../../managed/backup-port';
import { boxBackupOf } from '../../managed/box-backup';
import type { ToolContext } from '../../mcp/tools';
import { changeSetting } from '../../settings/command';
import { ownTurn } from '../../vault/self-serve';
import { type Looker, looksFor } from './service';

type Input = z.output<typeof BackupBringBackInput>;
type Output = BackupBringBackOutput;

/** What the tool answers the agent with (to the agent, never the chat). */
export const BRING_BACK_TOOL_TEXT = {
  notHere: 'Only in a turn for the person: their backups are theirs.',
  unavailable: 'This Whombat has no backup service to bring things back from (a development box).',
  noBackup: 'There is no backup from before then.',
  notOpen: 'No backup is open for this: call find first, then bring with ids from its answer.',
  opening: (when: string) =>
    `The backup from ${when} is opening; that takes a minute or two. Tell the person you’re looking, then call find again.`,
  found: (n: number, when: string) =>
    n === 0
      ? `Nothing in the backup from ${when} matches those words. Ask the person for other words or another day.`
      : `The backup from ${when} has ${n === 1 ? 'one match' : `${n} matches`}. Tell the person what they are and ask which to bring back.`,
} as const;

/** How long `find` waits for a backup to open before answering `opening`. */
const OPEN_WAIT_MS = 50_000;
/** Most matches `find` answers with. */
const FIND_MAX = 8;

const fail = (reason: Extract<Output, { status: 'failed' }>['reason'], message: string): Output => ({
  status: 'failed',
  reason,
  message,
});

/** A time as people say it, in the person's time zone (“Tuesday 3 November, 06:00”). */
export function whenWords(at: string | Date | null, timeZone: string): string | null {
  if (!at) return null;
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

async function lookerOf(ctx: ToolContext): Promise<Looker | null> {
  const turn = await ownTurn(ctx.services.db, ctx);
  if (!turn?.person.accountId) return null;
  const [account] = await ctx.services.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, turn.person.accountId));
  const [burrow] = await ctx.services.db.select().from(burrows).where(eq(burrows.id, ctx.burrowId));
  if (!account || !burrow) return null;
  return {
    burrow,
    person: turn.person,
    email: (account.email ?? turn.person.email ?? `${turn.person.handle}@example.com`).toLowerCase(),
  };
}

export async function backupBringBackTool(ctx: ToolContext, input: Input): Promise<Output> {
  const { services } = ctx;
  const who = await lookerOf(ctx);
  if (!who) return fail('not_here', BRING_BACK_TOOL_TEXT.notHere);
  const box = boxBackupOf(services);
  if (!box) return fail('unavailable', BRING_BACK_TOOL_TEXT.unavailable);
  const looks = looksFor(services);
  const zone = who.burrow.timeZone || 'UTC';

  if (input.bring) {
    const open = looks.current(who.person);
    if (open?.state !== 'ready') return fail('not_open', BRING_BACK_TOOL_TEXT.notOpen);
    const named = await looks.named(who, open.lookId, input.bring);
    if (named.length === 0) return fail('not_open', BRING_BACK_TOOL_TEXT.notOpen);
    const items = named.map((n) => n.id);
    // The card says what comes back by name, in Whombat's words from the backup.
    const lines = named.slice(0, 6).map((n) => `Bring back “${n.title}”`.slice(0, 120));
    const res = await services.pipeline.commit(
      changeSetting,
      {
        op: 'backup.lookBring',
        input: { lookId: open.lookId, items },
        conversationId: ctx.dispatch.conversationId,
        lines,
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    if (res.status === 'pending_approval')
      return { status: 'pending_approval', approvalId: res.approvalId, message: res.message };
    if (res.status === 'blocked')
      return {
        status: 'blocked',
        message:
          'The person set changing settings to Just watch: they bring it back themselves in Settings → This Whombat → Backups.',
      };
    const done = await looks.bring(who, { lookId: open.lookId, items });
    return { status: 'done', say: done.say };
  }

  // find: the newest backup from before the person's time hint.
  let list: z.output<typeof BackupCheckpointList> | null = null;
  try {
    const res = await box.port.call('GET', '/v1/checkpoints', undefined, LIST);
    const parsed = res.status === 200 ? BackupCheckpointList.safeParse(res.body) : null;
    list = parsed?.success ? parsed.data : null;
  } catch {
    list = null;
  }
  if (!list)
    return fail('unavailable', 'The backup service isn’t answering right now. Try again in a few minutes.');
  const before = input.before ? Date.parse(input.before) : Number.POSITIVE_INFINITY;
  const checkpoint = [...list.checkpoints]
    .filter((c) => Date.parse(c.createdAt) < before)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!checkpoint) return fail('no_backup', BRING_BACK_TOOL_TEXT.noBackup);
  const when = whenWords(checkpoint.createdAt, zone) ?? 'then';
  const madeAt = new Date(checkpoint.createdAt);
  let look = await looks.open(box.port, who, checkpoint.id, async () => madeAt);
  const until = Date.now() + OPEN_WAIT_MS;
  while (look.state === 'opening' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    look = (await looks.contents(who, { lookId: look.lookId })).look;
  }
  if (look.state === 'opening') return { status: 'opening', say: BRING_BACK_TOOL_TEXT.opening(when) };
  if (look.state !== 'ready') {
    const code = look.problem?.code;
    return fail(
      code === 'not_supported' ? 'unavailable' : code === 'not_found' ? 'no_backup' : 'refused',
      look.problem?.message ?? 'The backup couldn’t be opened.',
    );
  }
  const page = await looks.contents(who, {
    lookId: look.lookId,
    category: input.category ?? 'messages',
    ...(input.find ? { query: input.find } : {}),
  });
  const items = page.items.slice(0, FIND_MAX).map((i) => ({
    id: i.id,
    title: i.title,
    when: whenWords(i.at, zone),
    about: i.detail,
    here: i.here,
  }));
  return { status: 'found', backup: when, items, say: BRING_BACK_TOOL_TEXT.found(items.length, when) };
}
