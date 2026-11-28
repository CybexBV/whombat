/**
 * `service_test`, the assistant's look at whether a service really works (docs/decisions/service-works.md): the test's
 * last results, or a run now. It runs when the person asks whether something works, when the assistant looks into a
 * failed test, and after it restarted or fixed something, to see that the fix worked.
 */
import { hasServiceTest, type McpToolOutput, SERVICE_TEST_CHECK, thingId } from '@whombat/core';
import { connectionByHandle } from '../connections/context';
import { turnPerson } from '../domain/turn-person';
import { forbidden, notFound } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { outsidersTurn } from '../runtime/person';
import { findThing } from '../things/page';
import { displayName } from '../things/part-of';
import { checkWatched } from '../things/quiet/defaults';
import { thingQuiet } from '../things/quiet/store';
import { clip } from '../things/words';
import { runWords } from './rules';
import { runServiceTest } from './run';
import { recentRuns } from './store';
import { SERVICE_TESTS, type TestFetch } from './tests';

/** How many runs the assistant reads: enough to see when it started failing. */
const RUNS_SHOWN = 8;

export async function serviceTestTool(
  ctx: ToolContext,
  input: { thing: string; run?: boolean },
  fetch?: TestFetch,
): Promise<McpToolOutput<'service_test'>> {
  if (outsidersTurn(ctx.dispatch))
    throw forbidden('This work came from outside, so it can’t see how things are here.');
  const { services, burrowId } = ctx;
  const person = await turnPerson(services.db, { burrowId, agentId: ctx.agentId });
  if (!person) throw notFound('Person');
  const given = input.thing.trim();
  const value = given.includes(':')
    ? given
    : await connectionByHandle(services.db, ctx.agentId, ctx.dispatch, given).then((found) =>
        found ? thingId('connection', found.row.id) : null,
      );
  if (!value) throw notFound('Thing');
  const viewer = { accountId: person.accountId ?? '', burrowId, principal: person };
  const target = await findThing(services, viewer, value);
  if (target.kind !== 'connection') throw notFound('Thing');
  const row = target.row;
  const name = clip(displayName(row), 80);
  const kind = row.catalogId;
  if (!hasServiceTest(kind))
    return {
      status: 'ok',
      name,
      watched: false,
      runs: [],
      note: 'Whombat has no test for this kind of service yet. Its page shows whether it answers.',
    };
  const quiet = await thingQuiet(services.db, row.burrowId, thingId('connection', row.id));
  if (input.run) await runServiceTest(services, row, { by: 'assistant', ...(fetch ? { fetch } : {}) });
  const runs = await recentRuns(services.db, row.id, RUNS_SHOWN);
  const watched = checkWatched(quiet, SERVICE_TEST_CHECK);
  return {
    status: 'ok',
    name,
    test: SERVICE_TESTS[kind].name,
    watched,
    runs: runs.map((r) => ({
      at: r.at.toISOString(),
      outcome: r.outcome,
      words: runWords(kind, name, r),
      ms: r.ms,
      by: r.by,
    })),
    ...(runs.length
      ? {}
      : { note: 'It hasn’t run yet. Run it with run: true; the person turns on Watch it on its page.' }),
  };
}
