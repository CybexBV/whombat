import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let mara = '';

beforeAll(async () => {
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

const ask = (messageId: string, cookie = mara) =>
  t.api.inject({
    method: 'POST',
    url: `/api/v1/burrows/burrow-hq/messages/${messageId}/more`,
    headers: { cookie },
  });

async function post(authorId: string, input: Record<string, unknown>): Promise<string> {
  const res = await t.commit(authorId, sendMessage, { conversationId: IDS.billing, ...input });
  return (res as { result: { id: string } }).result.id;
}

const _expands = (messageId: string) =>
  t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.messageId, messageId), eq(dispatches.trigger, 'expand')));

describe('more detail', () => {
  it('keeps an agent’s offer and drops a person’s', async () => {
    const short = await post(IDS.dusty, { text: 'Use Typeset.', more: 'why not the other two' });
    const [row] = await t.services.db.select().from(messages).where(eq(messages.id, short));
    expect(row?.more).toEqual({ hint: 'why not the other two', requestedById: null, requestedAt: null });

    const own = await post(IDS.mara, { text: 'Thanks', more: 'nothing' });
    const [person] = await t.services.db.select().from(messages).where(eq(messages.id, own));
    expect(person?.more).toBeNull();
    expect((await ask(own)).statusCode).toBe(400);
  });
});
