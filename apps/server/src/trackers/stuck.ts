/**
 * A tracker intake that can't go on by itself tells the person: more new reports than a poll reads to reach its cursor
 * (the `backlog` problem, which never clears by itself), or a poll that keeps failing for an hour. Their assistant says
 * it in their Chat and their Inbox has it (`needs_you`), once per connection and streak (the notification's key). A
 * token the tracker refuses that its check confirms isn't one of these: the connection's own repair message says that.
 */
import { and, asc, eq, gt, like, sql } from 'drizzle-orm';
import { applyContext } from '../commit/pipeline';
import { automationRuns, messages, notifications } from '../db/schema/index';
import { linkOfMessage } from '../domain/links';
import { postMessage } from '../domain/messages';
import { notify } from '../domain/notify';
import { threadPushGroup } from '../domain/push-preview';
import { thePerson } from '../domain/the-person';
import { personalPlace } from '../guides/place';
import { iso } from '../lib/time';
import { loadMessageRow } from '../read/messages';
import { toActor } from '../read/principals';
import type { Services } from '../services';

/** How long a connection's polls keep failing before the person hears it. */
export const FAILING_NOTICE_MS = 60 * 60_000;

/** What the assistant says when more new reports wait than a poll reads at once. */
export function backlogText(label: string): string {
  return `${label} has more new reports than I can read at once, so I’m not taking any of them. Pause its automation and resume it to start again from the newest report; the ones waiting now are then skipped.`;
}

/** What the person hears when the tracker no longer has a report Whombat follows (deleted there). */
export function goneText(label: string, number: number): string {
  return `Report #${number} is gone from ${label}, so I can’t follow its customer’s answers any more. If that wasn’t meant, please look in ${label}.`;
}

/**
 * What the person hears when a report came in a form this Whombat can't read: a new one isn't taken; a watched one's
 * customer answers aren't read any more.
 */
export function unreadableText(label: string, number: number | null, watched = false): string {
  const which = number === null ? 'A new report' : `Report #${number}`;
  return watched
    ? `${which} in ${label} now comes in a form I can’t read, so I can’t follow the customer’s answers there. Please look at it in ${label}.`
    : `${which} in ${label} came in a form I can’t read, so I didn’t take it. Its customer hasn’t heard from us; please answer it in ${label}.`;
}

/** Why a report's run was skipped for a run limit (its skipped run's error, on the run page). */
export const LIMITED_WORDS = {
  day: 'It used up its runs for the last 24 hours.',
  hour: 'Whombat used up its runs for the last hour.',
} as const;

/**
 * The poll's sweep behind `tellLimited` (TA-64): for each report a run limit skipped in the last day — its skipped run,
 * `limited-<day|hour>:<event>` — the person heard, else hears now (the notice's own key keeps it once). Answers how
 * many it looked at.
 */
export async function resendLimited(services: Services, pageSize = 200): Promise<number> {
  const since = new Date(services.clock().getTime() - 86_400_000);
  // The first of each connection's day (or hour): the one its notice starts with. Every page of the last day, so a
  // later window whose notice was lost isn't left behind earlier ones that were told.
  const seen = new Set<string>();
  let after: { at: Date; id: string } | null = null;
  let looked = 0;
  for (let page = 0; page < 50; page++) {
    const rows: { id: string; burrowId: string; scope: unknown; key: string; at: Date }[] = await services.db
      .select({
        id: automationRuns.id,
        burrowId: automationRuns.burrowId,
        scope: automationRuns.scope,
        key: automationRuns.triggerKey,
        at: automationRuns.createdAt,
      })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.status, 'skipped'),
          like(automationRuns.triggerKey, 'limited-%'),
          gt(automationRuns.createdAt, since),
          after
            ? sql`(${automationRuns.createdAt}, ${automationRuns.id}) > (${after.at.toISOString()}::timestamptz, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(asc(automationRuns.createdAt), asc(automationRuns.id))
      .limit(pageSize);
    for (const r of rows) {
      const scope = (r.scope ?? {}) as Record<string, unknown>;
      const limit = r.key.startsWith('limited-hour:') ? 'hour' : 'day';
      const key = limitedKey(scope, limit, r.at);
      if (seen.has(key)) continue;
      seen.add(key);
      await tellLimited(services, r.burrowId, scope, limit, r.at);
    }
    looked += rows.length;
    const last = rows.at(-1);
    if (rows.length < pageSize || !last) break;
    after = { at: last.at, id: last.id };
  }
  return looked;
}

/** A run-limit notice's key: once per connection and day (or hour) of the skip. */
function limitedKey(scope: Record<string, unknown>, limit: 'day' | 'hour', at: Date): string {
  const label = typeof scope.connection === 'string' ? scope.connection : 'the tracker';
  const when = limit === 'day' ? at.toISOString().slice(0, 10) : at.toISOString().slice(0, 13);
  return `tracker_limited:${typeof scope.connectionId === 'string' ? scope.connectionId : label}:${when}`;
}

/**
 * Reports, or customers' answers on them, that come while their automation (or this Whombat) has reached its run limit:
 * no run starts for them and they aren't taken later, so the person hears, once a day (or an hour) per connection,
 * starting with the first one.
 */
export async function tellLimited(
  services: Services,
  burrowId: string,
  scope: Record<string, unknown>,
  limit: 'day' | 'hour',
  at: Date = services.clock(),
): Promise<void> {
  const label = typeof scope.connection === 'string' ? scope.connection : 'the tracker';
  const number = typeof scope.number === 'number' ? `#${scope.number}` : 'a report';
  const first = scope.event === 'reporter_replied' ? `the customer’s answer on ${number}` : number;
  // Both limits are rolling windows (the last day, the last hour): runs come free as older ones fall out of them.
  const why =
    limit === 'day'
      ? 'its automation has used up its runs for the last 24 hours'
      : 'this Whombat has used up its runs for the last hour';
  try {
    await tellStuck(services, burrowId, {
      key: limitedKey(scope, limit, at),
      where: label,
      text: `${label} reports aren’t being taken for now, because ${why}; ${first} was the first I didn’t take. Their customers haven’t heard from us; please answer them in ${label}.`,
    });
  } catch (err) {
    services.log.warn(
      { burrowId, err: String(err).slice(0, 200) },
      'tracker: the person couldn’t be told reports weren’t taken',
    );
  }
}

/** Why a poll failed, in the assistant's words, by the poll's problem code. */
const FAILING_WHY: Record<string, string> = {
  unreachable: 'it doesn’t answer',
  invalid_answer: 'its answers aren’t what I expect',
  refused: 'it turns my token away',
};

/** What the assistant says when a connection's polls have kept failing for an hour. */
export function failingText(label: string, code: string | null): string {
  const why = FAILING_WHY[code ?? ''] ?? 'it doesn’t answer';
  return `I haven’t been able to read new reports from ${label} for over an hour, because ${why}. They wait until it works again, and I keep trying.`;
}

/** A notice about a connection: its key (one per connection and streak), the connection's label and the words. */
export interface StuckNotice {
  key: string;
  where: string;
  text: string;
}

/** How far back a stuck notice's line counts as said already (one streak). */
const SAID_WITHIN_MS = 7 * 24 * 60 * 60_000;

/**
 * The person's assistant says `notice.text` in their Chat, and their Inbox has it (`needs_you`), once per key: the
 * person's notification with that key is the mark. `told` (said now), `already` (said before) or `nobody` (no person
 * or Chat yet: asked again next time).
 */
export async function tellStuck(
  services: Services,
  burrowId: string,
  notice: StuckNotice,
): Promise<'told' | 'already' | 'nobody'> {
  const person = await thePerson(services.db, burrowId);
  if (!person) return 'nobody';
  const [told] = await services.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.principalId, person.id), eq(notifications.dedupKey, notice.key)))
    .limit(1);
  if (told) return 'already';
  const place = await personalPlace(services.db, burrowId, person.id);
  if (!place) return 'nobody';
  // Said already, its notification lost after the line committed: the Inbox gets it, pointing at that line.
  const [said] = await services.db
    .select({ id: messages.id, threadRootId: messages.threadRootId })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, place.dm.id),
        eq(messages.authorId, place.agent.id),
        eq(messages.text, notice.text),
        gt(messages.createdAt, new Date(services.clock().getTime() - SAID_WITHIN_MS)),
      ),
    )
    .limit(1);
  if (said) {
    await notify(services, [
      {
        burrowId,
        burrowSlug: place.burrow.slug,
        principalId: person.id,
        kind: 'needs_you',
        actorId: place.agent.id,
        where: notice.where,
        text: notice.text.slice(0, 280),
        link: await linkOfMessage(services.db, place.dm, said.id, said.threadRootId),
        messageId: said.id,
        createdAt: services.clock(),
        dedupKey: notice.key,
        group: threadPushGroup(place.dm.id, said.threadRootId),
      },
    ]);
    return 'already';
  }
  await services.pipeline.transact(burrowId, async (session) => {
    const now = services.clock();
    const ctx = applyContext(session, {
      burrow: place.burrow,
      actor: toActor(place.agent),
      now,
      at: iso(now),
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });
    const posted = await postMessage(ctx, {
      conversation: place.dm,
      text: notice.text,
      mentions: [],
      dispatch: false,
      // The person hears through the notification below, once.
      notifyDmPerson: false,
    });
    ctx.after(async () => {
      const message = await loadMessageRow(services.db, posted.id);
      if (!message) return;
      await notify(services, [
        {
          burrowId,
          burrowSlug: place.burrow.slug,
          principalId: person.id,
          kind: 'needs_you',
          actorId: place.agent.id,
          where: notice.where,
          text: notice.text.slice(0, 280),
          link: await linkOfMessage(services.db, place.dm, message.id, message.threadRootId),
          messageId: message.id,
          createdAt: now,
          dedupKey: notice.key,
          group: threadPushGroup(place.dm.id, message.threadRootId),
        },
      ]);
    });
  });
  return 'told';
}
