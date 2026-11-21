/**
 * A T3 Code thread's last answer, whole (docs/decisions/t3code.md): T3 Code cuts a long message off at the read's
 * length, so the rest of a cut-off answer is read after it (a few reads at most) and the answer is kept as its start
 * and its end (`fitAnswer`), where the lines Whombat reads are (a score, a verdict, an item's line).
 */
import { T3_ANSWER_MAX } from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import type { Services } from '../services';
import { callT3 } from '../things/kinds/business/t3code';
import { list, rec, str } from '../things/words';
import {
  ANSWER_REST_PAGES,
  answerArgs,
  answerPartOf,
  answerRestArgs,
  fitAnswer,
  lastAnswerItemOf,
} from './threads';

/** The thread's last answer cut to `max` with its start and its end, or null. A failed read throws. */
export async function readLastAnswer(
  services: Services,
  connection: CatalogConnectionRow,
  threadId: string,
  items: number,
  max: number = T3_ANSWER_MAX,
): Promise<string | null> {
  const first = lastAnswerItemOf(
    await callT3(services, connection, 't3_thread_read', answerArgs(threadId, items, max)),
  );
  if (!first) return null;
  let { text, more } = first;
  for (let page = 0; more !== null && first.itemId && page < ANSWER_REST_PAGES; page++) {
    // A failed read of the rest fails the whole read: half an answer would miss the lines at its end.
    const body = await callT3(
      services,
      connection,
      't3_thread_read',
      answerRestArgs(threadId, first.itemId, more),
    );
    const item = list(rec(body).items)
      .map(rec)
      .find((i) => str(i.itemId) === first.itemId);
    if (!item) break;
    const rest = answerPartOf(item);
    if (!rest.text) break;
    text += rest.text;
    more = rest.more !== null && rest.more > more ? rest.more : null;
  }
  const said = text.trim();
  return said ? fitAnswer(said, max) : null;
}
