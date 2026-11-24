/**
 * The 1Password sync in the Inbox (docs/decisions/onepassword-sync.md OPW-24, OPW-51, OPW-K13): “1Password says 4 items
 * are gone” with “Remove them here too” and “Keep them here” while the guard holds removals, a card titled by what went
 * wrong (“Whombat can’t reach 1Password”, …) from the second pass in a row that can't finish, a token that can only
 * read, and (off unless the person turns it on) the limit's wait. Each is read from the stored state, follows What Whombat watches for the connection (its checks), and
 * goes by itself when the state moves on.
 */
import {
  type NeedsYouItem,
  ONEPASSWORD_WORDS,
  type OnePasswordRemovalAnswer,
  onePasswordGoneTitle,
  onePasswordRemovalsBody,
  onePasswordWaitingLine,
  thingHref,
  thingId,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { burrows, catalogConnections, vaultOnePasswordState } from '../../db/schema/index';
import { registerNeedsYouSource, type SourceCtx } from '../../home/registry';
import { loadPrincipalRow } from '../../read/principals';
import { quietNow } from '../../things/quiet/defaults';
import { quietBook } from '../../things/quiet/store';
import { ONEPASSWORD_CATALOG_ID } from './store';
import { ONEPASSWORD_FAILING_AFTER, onePasswordFailingTitle, onePasswordProblemText } from './words';

type Row = typeof catalogConnections.$inferSelect;
type State = typeof vaultOnePasswordState.$inferSelect;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The items for one connection's state (pure). */
export function onePasswordItems(
  connection: Pick<Row, 'id' | 'label'>,
  state: Pick<
    State,
    'outcome' | 'problem' | 'readOnly' | 'removals' | 'nextTryAt' | 'checkedAt' | 'updatedAt' | 'failures'
  >,
  timeZone: string,
): NeedsYouItem[] {
  const ref = { kind: 'connection', id: connection.id } as const;
  const href = thingHref('connection', connection.id);
  const thing = thingId('connection', connection.id);
  const subject = { kind: 'connection' as const, id: connection.id, name: clip(connection.label, 120) };
  const at = (state.checkedAt ?? state.updatedAt).toISOString();
  const open = {
    id: 'open',
    label: 'Open 1Password',
    style: 'primary' as const,
    kind: 'open' as const,
    href,
  };
  const items: NeedsYouItem[] = [];
  const removals = state.removals;
  if (state.outcome === 'paused' && removals) {
    const answer = (a: OnePasswordRemovalAnswer) => ({ answer: a, token: removals.token });
    items.push({
      id: `onepassword:${connection.id}:removals`,
      ref,
      kind: 'connection',
      severity: 'warn',
      nature: 'you',
      title: onePasswordGoneTitle(removals.entries.length),
      body: clip(onePasswordRemovalsBody(removals.entries.map((e) => e.name)), 600),
      at: removals.since,
      subject,
      href,
      actions: [
        {
          id: 'remove',
          label: ONEPASSWORD_WORDS.removeHere,
          // Neither is the recommended one, and removing can't be undone: both alike, as on the page.
          style: 'secondary',
          kind: 'onepassword_removals',
          removals: answer('remove'),
        },
        {
          id: 'keep',
          label: ONEPASSWORD_WORDS.keepHere,
          style: 'secondary',
          kind: 'onepassword_removals',
          removals: answer('keep'),
        },
      ],
      watch: { thing, check: 'onepassword.paused', name: connection.label.slice(0, 220) },
    });
  }
  // A single pass that couldn't finish is usually a blip: the card waits for the second in a row.
  if (state.outcome === 'failing' && state.failures >= ONEPASSWORD_FAILING_AFTER)
    items.push({
      id: `onepassword:${connection.id}:failing`,
      ref,
      kind: 'connection',
      severity: 'bad',
      nature: 'problem',
      title: onePasswordFailingTitle(state.problem),
      body: clip(onePasswordProblemText(state.problem), 600),
      at,
      subject,
      href,
      actions: [open],
      watch: { thing, check: 'onepassword.unreachable', name: connection.label.slice(0, 220) },
    });
  if (state.outcome === 'waiting' && state.nextTryAt)
    items.push({
      id: `onepassword:${connection.id}:limit`,
      ref,
      kind: 'connection',
      severity: 'info',
      nature: 'fyi',
      title: 'Waiting for 1Password’s limit',
      body: onePasswordWaitingLine(state.nextTryAt.toISOString(), timeZone),
      at,
      subject,
      href,
      actions: [open],
      watch: { thing, check: 'onepassword.limit', name: connection.label.slice(0, 220) },
    });
  if (state.readOnly)
    items.push({
      id: `onepassword:${connection.id}:read-only`,
      ref,
      kind: 'connection',
      severity: 'warn',
      nature: 'you',
      title: 'Your 1Password token can only read',
      body: ONEPASSWORD_WORDS.readOnly,
      at,
      subject,
      href,
      actions: [open],
      watch: { thing, check: 'onepassword.paused', name: connection.label.slice(0, 220) },
    });
  return items;
}

/** Registers the source with Home (idempotent; at load of the connection's kind). */
export function registerOnePasswordSource(): void {
  registerNeedsYouSource('onepassword', onePasswordNeedsYou);
}

/** The source: the person's, for the burrow's 1Password connection, minus what they switched off or quieted. */
export async function onePasswordNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  // The state alone first: Home reads its connections once for all its parts, and a Whombat whose sync has nothing to
  // say (or no 1Password at all) costs it no second read of them.
  const [state] = await ctx.db
    .select()
    .from(vaultOnePasswordState)
    .where(eq(vaultOnePasswordState.burrowId, ctx.burrowId))
    .limit(1);
  if (
    !state ||
    (!state.readOnly &&
      !(state.outcome === 'failing' && state.failures >= ONEPASSWORD_FAILING_AFTER) &&
      state.outcome !== 'paused' &&
      state.outcome !== 'waiting')
  )
    return [];
  const [row] = await ctx.db
    .select({ id: catalogConnections.id, label: catalogConnections.label, timeZone: burrows.timeZone })
    .from(catalogConnections)
    .innerJoin(burrows, eq(burrows.id, catalogConnections.burrowId))
    .where(
      and(
        eq(catalogConnections.id, state.connectionId),
        eq(catalogConnections.catalogId, ONEPASSWORD_CATALOG_ID),
      ),
    );
  if (!row) return [];
  const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
  if (person?.kind !== 'person') return [];
  const items = onePasswordItems(row, state, row.timeZone || 'UTC');
  if (!items.length) return [];
  const book = ctx.reads ? await ctx.reads.quiet() : await quietBook(ctx.db, [ctx.burrowId]);
  const quiet = book.of(thingId('connection', row.id));
  return items.filter((i) => !i.watch || !quietNow(quiet, i.watch.check, '', ctx.now));
}
