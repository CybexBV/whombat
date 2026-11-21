import { api } from '@whombat/core/contracts';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it, vi } from 'vitest';
import { createWorkFixtures } from './fixtures/work';
import { ContractError } from './http/errors';
import { fakeClient } from './test/session';
import {
  decodeForUi,
  decodeRealtimeEvent,
  isUnsupportedCard,
  NEEDS_NEWER_APP,
  UNSUPPORTED_CARD,
  unsupportedItems,
} from './tolerant';

/** What a runtime one or two releases newer might send: kinds and events this app doesn't know. */
const NEWER = { card: 'kanban', workKind: 'review_request', event: 'ledger.updated' };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Json = Record<string, unknown>;

async function fixture(path: string): Promise<Json> {
  const world = createFixtureFetch();
  return (await (await world(`http://w.test/api/v1/burrows/burrow-hq${path}`)).json()) as Json;
}

async function workOverview(): Promise<Json> {
  const res = await createWorkFixtures().handle(
    new Request('http://fixtures.local/api/v1/burrows/burrow-hq/work'),
  );
  return (await res?.json()) as Json;
}

/** Mara's Chat's messages with the first card turned into a kind only a newer runtime has. */
async function messagesWithNewerCard(): Promise<{ body: Json; index: number }> {
  const body = clone(await fixture('/conversations/cnv_dm-dusty/messages'));
  const messages = body.messages as Json[];
  const index = messages.findIndex((m) => m.card !== null);
  expect(index).toBeGreaterThanOrEqual(0);
  messages[index] = { ...messages[index], card: { kind: NEWER.card, columns: [{ title: 'To do' }] } };
  return { body, index };
}

describe('tolerant decoding: an answer from a newer runtime (AP-255)', () => {
  it('a card of a new kind becomes the placeholder; the message and the rest stay', async () => {
    const { body, index } = await messagesWithNewerCard();
    const strict = api.messages.list.response.safeParse(body);
    expect(strict.success).toBe(false);
    const r = decodeForUi(api.messages.list.response, body);
    if (!r.ok) throw r.error;
    const messages = r.data.messages;
    expect(messages).toHaveLength((body.messages as unknown[]).length);
    expect(messages[index]?.card).toEqual(UNSUPPORTED_CARD);
    expect(isUnsupportedCard(messages[index]?.card)).toBe(true);
    expect(messages[index]?.text).toBe((body.messages as Json[])[index]?.text);
    expect(r.skipped).toEqual([{ path: ['messages', index, 'card'], value: NEWER.card, action: 'nulled' }]);
  });

  it('a Work item of a new kind is left out and counted on its section; the list keeps the rest', async () => {
    const body = clone(await workOverview());
    const sections = body.sections as { items: Json[] }[];
    const s = sections.findIndex((x) => x.items.length > 0);
    const kept = sections[s]?.items.length ?? 0;
    sections[s]?.items.push({
      ...clone(sections[s]?.items[0]),
      id: 'review_request:1',
      kind: NEWER.workKind,
    });
    const r = decodeForUi(api.work.overview.response, body);
    if (!r.ok) throw r.error;
    expect(r.data.sections[s]?.items).toHaveLength(kept);
    expect(unsupportedItems(r.data.sections[s])).toBe(1);
    expect(r.data.sections.filter((_, i) => i !== s).map((x) => unsupportedItems(x))).toEqual(
      r.data.sections.slice(1).map(() => 0),
    );
    // The count survives a spread (reducers, structural sharing copy own members).
    expect(unsupportedItems({ ...r.data.sections[s] })).toBe(1);
  });

  it('an answer from an older runtime (members it doesn’t have yet) decodes with the defaults', async () => {
    const body = clone(await workOverview());
    for (const section of body.sections as { items: Json[] }[])
      for (const item of section.items) {
        // Added after the item was first shipped (refs grew with automations).
        delete (item.refs as Json).dispatchId;
      }
    const r = decodeForUi(api.work.overview.response, body);
    if (!r.ok) throw r.error;
    expect(r.skipped).toEqual([]);
    const item = r.data.sections.flatMap((x) => x.items)[0];
    expect(item?.refs.dispatchId).toBeNull();
  });

  it('what isn’t an unknown member still fails', async () => {
    const body = clone(await fixture('/agent'));
    body.agent = { ...(body.agent as Json), name: 42 };
    expect(decodeForUi(api.agent.get.response, body).ok).toBe(false);
  });
});

describe('tolerant realtime (AP-255)', () => {
  it('an event type only a newer runtime sends is skipped, not an error', () => {
    expect(decodeRealtimeEvent({ type: NEWER.event, entries: [] })).toEqual({
      kind: 'unknown',
      type: NEWER.event,
    });
    expect(decodeRealtimeEvent({ nope: true })).toEqual({ kind: 'invalid' });
  });

  it('a known event carrying a card of a new kind keeps the message, with the placeholder', async () => {
    const { body, index } = await messagesWithNewerCard();
    const message = (body.messages as Json[])[index];
    const r = decodeRealtimeEvent({ type: 'message.created', message });
    expect(r.kind).toBe('event');
    if (r.kind !== 'event' || r.event.type !== 'message.created') throw new Error('not decoded');
    expect(r.event.message.card).toEqual(UNSUPPORTED_CARD);
  });
});

describe('the typed client decodes tolerantly in production too (AP-255)', () => {
  function serving(body: unknown) {
    return async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  it('production: a newer card kind is the placeholder, unknown members are stripped, defaults filled', async () => {
    const { body, index } = await messagesWithNewerCard();
    (body.messages as Json[])[0] = { ...(body.messages as Json[])[0], somethingNew: { x: 1 } };
    const client = fakeClient(serving(body), { validateResponses: false });
    const page = await client.messages.list({
      params: { burrow: 'burrow-hq', conversationId: 'cnv_dm-dusty' },
    });
    expect(page.messages[index]?.card).toEqual(UNSUPPORTED_CARD);
    expect('somethingNew' in (page.messages[0] ?? {})).toBe(false);
  });

  it('an answer that doesn’t match at all: dev throws, production uses it as it came and says so', async () => {
    const broken = { conversations: 'nope' };
    const strict = fakeClient(serving(broken), { validateResponses: true });
    await expect(strict.conversations.list({ params: { burrow: 'burrow-hq' } })).rejects.toBeInstanceOf(
      ContractError,
    );
    const onContractDrift = vi.fn();
    const lax = fakeClient(serving(broken), { validateResponses: false, onContractDrift });
    await expect(lax.conversations.list({ params: { burrow: 'burrow-hq' } })).resolves.toEqual(broken);
    expect(onContractDrift).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: 'conversations.list' }),
    );
  });

  it('the placeholder text is the product’s', () => {
    expect(NEEDS_NEWER_APP).toBe('This needs a newer version of the app.');
  });
});
