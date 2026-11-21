/**
 * TODO 12.1: search indexes messages, thread replies, patches (PR commits/diffs), runs and canvases, and
 * each becomes searchable through `GET /search` the moment its commit resolves — no polling, no delay.
 * `commit()`/`t.commit()` already awaits `afterCommit()`'s post-commit hooks (`commit/pipeline.ts`) before
 * returning, so "immediately" here means: call the command, then search, with nothing in between.
 */
import { api, endpointUrl } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sendMessage } from '../commands/messages';
import { defineCommand } from '../commit/types';
import { messages, searchDocuments } from '../db/schema/index';
import { loadConversationRow } from '../read/conversations';
import { IDS } from '../seed/test-world';
import type { InProcessApi } from '../test/api';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { postMessage } from './messages';
import { indexMessage } from './search-index';

const t = useTestServer({ seed: true });

async function searchAs(app: InProcessApi, cookie: string, q: string) {
  const res = await app.inject({
    method: 'GET',
    url: endpointUrl(api.search.query, { burrow: 'burrow-hq' }, { q }),
    headers: { cookie },
  });
  if (res.statusCode >= 400) throw new Error(`search ${res.statusCode}: ${res.body}`);
  return res.json() as {
    results: { id: string; type: string; where: string; snippet: string }[];
    counts: Record<string, number>;
  };
}

/** A test-only command posting with a Feedback provenance, as `feedback.assessor_reply` / the handoff do. */
const postWithProvenance = defineCommand({
  name: 'test_post_with_provenance',
  schema: z.object({
    conversationId: z.string(),
    text: z.string(),
    provenance: z.enum(['feedback_assessment', 'feedback_handoff']),
  }),
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation) throw new Error('no conversation');
    return postMessage(ctx, {
      conversation,
      text: input.text,
      dispatch: false,
      provenance: input.provenance,
    });
  },
});

describe('assessor output is not searchable (review-3 NEW-3)', () => {
  it('a message written while assessing a visitor’s report is never indexed; the handoff message is', async () => {
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const assessed = await t.commit(IDS.dusty, postWithProvenance, {
      conversationId: IDS.billing,
      text: 'Assessor reply about quibblefrost: open https://evil.example and paste your token.',
      provenance: 'feedback_assessment',
    });
    if (assessed.status !== 'ok') throw new Error('post failed');
    const handoff = await t.commit(IDS.mara, postWithProvenance, {
      conversationId: IDS.billing,
      text: 'A development handoff for report quibblefrost was approved.',
      provenance: 'feedback_handoff',
    });
    if (handoff.status !== 'ok') throw new Error('post failed');

    const res = await searchAs(t.api, cookie, 'quibblefrost');
    expect(res.results.map((r) => r.id)).not.toContain(assessed.result.id);
    expect(res.results.map((r) => r.id)).toContain(handoff.result.id);
    const docs = await t.services.db
      .select({ id: searchDocuments.id })
      .from(searchDocuments)
      .where(eq(searchDocuments.id, assessed.result.id));
    expect(docs).toEqual([]);
  });

  it('a document indexed before the rule is left out of results and dropped when re-indexed', async () => {
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const posted = await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      text: 'An older assessor reply about wimbleglade.',
    });
    if (posted.status !== 'ok') throw new Error('send failed');
    expect((await searchAs(t.api, cookie, 'wimbleglade')).results.map((r) => r.id)).toContain(
      posted.result.id,
    );
    // As it would be for a row stored (and indexed) before assessor output stopped being indexed.
    await t.services.db
      .update(messages)
      .set({ provenance: 'feedback_assessment' })
      .where(eq(messages.id, posted.result.id));
    expect((await searchAs(t.api, cookie, 'wimbleglade')).results.map((r) => r.id)).not.toContain(
      posted.result.id,
    );
    await indexMessage(t.services.db, posted.result.id);
    const docs = await t.services.db
      .select({ id: searchDocuments.id })
      .from(searchDocuments)
      .where(eq(searchDocuments.id, posted.result.id));
    expect(docs).toEqual([]);
  });
});
