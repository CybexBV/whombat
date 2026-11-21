/**
 * `pnpm dev:ask "<text>"` — development only (hermes-engine.md HE-49): asks the agent in the person's own Chat on the
 * Whombat `pnpm dev` runs (same `.env`, same database), then waits for its answer and prints it. The message is committed
 * as the person through the commit pipeline, as their session would; the running server and runner take the turn from
 * there (the scripted Hermes by default). The person is the Whombat's one (one-person.md OP-S13).
 *
 * Until a browser enrols on the development box (the direct listener), this is how to see a turn answer there.
 */
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { sendMessage } from '../commands/messages';
import { loadConfig, loadDotEnv } from '../config';
import { createDb } from '../db/client';
import { accounts, burrows, conversations, messages, principals } from '../db/schema/index';
import { createServices, silentLogger } from '../services';

loadDotEnv();
const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('dev:ask is for development only');
const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: pnpm dev:ask "<what to ask>"');
  process.exit(1);
}
const WAIT_MS = Number(process.env.DEV_ASK_WAIT_MS ?? 120_000);

const { sql } = createDb(config.DATABASE_URL, { max: 2 });
const services = createServices({ config, sql, log: silentLogger });
try {
  const [burrow] = await services.db.select().from(burrows).orderBy(asc(burrows.createdAt)).limit(1);
  if (!burrow) throw new Error('This Whombat has no burrow yet: run `pnpm db:seed` (the mock world) first.');
  const [person] = await services.db
    .select({ id: principals.id, name: principals.name })
    .from(principals)
    .innerJoin(accounts, eq(accounts.id, principals.accountId))
    .where(and(eq(principals.burrowId, burrow.id), eq(principals.kind, 'person')))
    .orderBy(asc(principals.createdAt))
    .limit(1);
  if (!person) throw new Error(`${burrow.name} has no person yet.`);
  const [agent] = await services.db
    .select({ id: principals.id, name: principals.name })
    .from(principals)
    .where(and(eq(principals.burrowId, burrow.id), eq(principals.kind, 'agent')))
    .limit(1);
  if (!agent) throw new Error(`${burrow.name} has no agent.`);
  // The person's own Chat: their direct conversation with the agent that is no task's.
  const [chat] = await services.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.burrowId, burrow.id),
        eq(conversations.kind, 'dm'),
        eq(conversations.dmPersonId, person.id),
        eq(conversations.dmAgentId, agent.id),
        isNull(conversations.taskKey),
      ),
    )
    .limit(1);
  if (!chat) throw new Error(`${person.name} has no Chat with ${agent.name}.`);
  const after = services.clock();
  const sent = await services.pipeline.commit(
    sendMessage,
    { conversationId: chat.id, text },
    { burrowId: burrow.id, actorId: person.id },
  );
  if (sent.status !== 'ok') throw new Error(`The message wasn’t sent (${sent.status}).`);
  await services.background.settle();
  console.log(`${person.name} → ${agent.name}: ${text}`);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const [answer] = await services.db
      .select({ text: messages.text })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, chat.id),
          eq(messages.authorId, agent.id),
          gt(messages.createdAt, after),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1);
    if (answer) {
      console.log(`${agent.name}: ${answer.text}`);
      break;
    }
    if (Date.now() > deadline)
      throw new Error(`No answer within ${WAIT_MS / 1000} s. Is \`pnpm dev\` running (server and runner)?`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  services.typing.close();
  services.runtime.close();
  services.github.close();
  await sql.end({ timeout: 5 });
}
