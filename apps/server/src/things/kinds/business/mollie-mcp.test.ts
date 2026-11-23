/**
 * Mollie signed in with Mollie: the page read through its MCP server's tools that only read, from answers shaped as
 * Mollie API v2's (`_embedded.payments`, `_links.next`; a settlement), which its tools pass on. Mollie publishes no
 * arguments for its tools, so the page gives what each tool's schema names: these tests use a schema with `limit` and
 * `from`, none, and one that requires more. A fake pool answers; the tool list says which tools only read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThingPagePanel } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { argsFor } from '../mcp-tools';
import { rowOf } from '../media/testing';
import { slotProblems } from '../slots';
import type { KindCtx } from '../types';
import { MOLLIE_CHECKS, MOLLIE_KIND } from './mollie';
import { MCP_PAGE, MOLLIE_TOOLS, paymentsOf } from './mollie-mcp';

type Schema = Record<string, unknown> | null;

const fake = vi.hoisted(() => ({
  calls: [] as { tool: string; args: Record<string, unknown> }[],
  tools: [] as { name: string; access: string; inputSchema: Schema }[],
  answer: (_tool: string, _args: Record<string, unknown>): unknown => ({}),
}));

vi.mock('../../../commit/scope', () => ({
  externalEffect: (_name: string, run: () => unknown) => run(),
}));
vi.mock('../../../connections/pool', () => ({
  connectionsFor: () => ({
    target: () => ({}),
    pool: {
      call: async (_target: unknown, tool: string, args: Record<string, unknown>) => {
        fake.calls.push({ tool, args });
        const json = fake.answer(tool, args) as Record<string, unknown>;
        return { text: JSON.stringify(json), structured: json, isError: false };
      },
    },
  }),
}));
vi.mock('../../../connections/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connections/store')>()),
  toolRowsOf: async () => fake.tools,
}));

const recorded = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'mollie-mcp', name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam: the key's page's tests' day.
const now = new Date('2026-10-21T15:00:00Z');

/** A schema as a server generated from Mollie's API would list it: both optional. */
const PAGED: Schema = {
  type: 'object',
  properties: { from: { type: 'string' }, limit: { type: 'integer' }, testmode: { type: 'boolean' } },
};

function answers(tool: string, args: Record<string, unknown>): unknown {
  if (tool === MOLLIE_TOOLS.payments)
    return recorded(
      args.from === 'tr_UsdPaid1'
        ? 'ListPaymentsFromGivenIDOnwards-from.json'
        : 'ListPaymentsFromGivenIDOnwards.json',
    );
  if (tool === MOLLIE_TOOLS.next) return recorded('GetNextSettlement.json');
  throw new Error(`not asked: ${tool}`);
}

const tools = (payments: Schema) => [
  { name: MOLLIE_TOOLS.payments, access: 'read', inputSchema: payments },
  { name: MOLLIE_TOOLS.next, access: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'CreatePayment', access: 'write', inputSchema: null },
];

// Each test reads a connection and a cache of its own.
let n = 0;
function ctx(): KindCtx {
  n += 1;
  return {
    services: { clock: () => now } as unknown as Services,
    row: rowOf('mollie', { id: `con_mollie_mcp_${n}`, signIn: 'mcp_oauth', fields: {}, label: 'Mollie' }),
    entry: {} as KindCtx['entry'],
    now,
    timeZone: TZ,
    machine: null,
    range: '24h',
    burrowId: 'brw_1',
    disk: { pct: [], gb: [] },
  };
}

beforeEach(() => {
  fake.calls = [];
  fake.answer = answers;
  fake.tools = tools(PAGED);
});

describe('Mollie’s payments as its MCP server gives them', () => {
  it('reads Mollie’s list with its next page, and a plain list of payments', () => {
    const page = paymentsOf(recorded('ListPaymentsFromGivenIDOnwards.json'));
    expect(page.payments.map((p) => p.id)).toEqual(['tr_7UhSN1zuXS', 'tr_Fail0001', 'tr_Open0001']);
    expect(page.next).toBe('tr_UsdPaid1');
    expect(page.more).toBe(true);
    const embedded = recorded('ListPaymentsFromGivenIDOnwards-from.json')._embedded as {
      payments: unknown[];
    };
    const plain = paymentsOf({ payments: embedded.payments });
    expect(plain.payments.map((p) => p.id)).toEqual(['tr_UsdPaid1', 'tr_Refund01', 'tr_LastMon1']);
    expect(plain.more).toBe(false);
    expect(paymentsOf({ words: 'none' }).payments).toEqual([]);
  });

  it('gives a tool only what its schema names, and nothing when it requires more', () => {
    const want = [
      { names: ['limit'], value: 25 },
      { names: ['from', 'fromId'], value: 'tr_1' },
    ];
    expect(argsFor(PAGED, want)).toEqual({ limit: 25, from: 'tr_1' });
    expect(argsFor({ properties: { from_id: {}, page_size: {} } }, want)).toEqual({ from_id: 'tr_1' });
    expect(argsFor(null, want)).toEqual({});
    expect(argsFor({ properties: { profileId: {} }, required: ['profileId'] }, want)).toBeNull();
  });
});

describe('Mollie’s page signed in with Mollie', () => {
  it('shows the key’s page without refunds and chargebacks, read only through tools that only read', async () => {
    const view = await MOLLIE_KIND.page(ctx());
    expect(view.problem).toBeUndefined();
    expect(slotProblems(view)).toEqual([]);
    const live = view.panels.find((p) => p.id === 'payments');
    if (live?.kind !== 'list') throw new Error('no payments');
    expect(live.title).toBe('Payments today');
    expect(live.items.map((i) => i.id)).toEqual(['tr_7UhSN1zuXS', 'tr_Fail0001']);
    const month = view.panels.find((p) => p.id === 'month');
    if (month?.kind !== 'list') throw new Error('no month');
    // The same payments give the key's figures; no chargebacks line without a tool for them.
    expect(month.items.map((i) => [i.id, i.figure?.value])).toEqual([
      ['paid', '€ 1,393'],
      ['refunded', '€ 60'],
      ['payout', '€ 2,416'],
    ]);
    expect(view.panels.some((p) => p.id === 'week')).toBe(true);
    expect(view.panels.some((p) => p.id === 'refunds')).toBe(false);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    expect(fake.calls.map((c) => c.tool)).not.toContain('CreatePayment');
    expect(fake.calls.filter((c) => c.tool === MOLLIE_TOOLS.payments).map((c) => c.args)).toEqual([
      { limit: MCP_PAGE },
      { limit: MCP_PAGE },
      { limit: MCP_PAGE, from: 'tr_UsdPaid1' },
    ]);
  });

  it('asks a tool without a schema for its default page, and says “at least” past it', async () => {
    fake.tools = tools(null);
    const view = await MOLLIE_KIND.page(ctx());
    expect(fake.calls.filter((c) => c.tool === MOLLIE_TOOLS.payments).map((c) => c.args)).toEqual([{}, {}]);
    const month = view.panels.find((p) => p.id === 'month');
    if (month?.kind !== 'list') throw new Error('no month');
    expect(month.items[0]?.detail).toMatch(/^At least/);
  });

  it('gives the card its figures from the newest page, and counts chargebacks as not seen', async () => {
    const c = ctx();
    const seen = await MOLLIE_KIND.seen?.(c.services, c.row, now, TZ);
    expect(seen?.glance.facts?.map((f) => f.label)).toEqual(['Paid today', 'This month']);
    expect(seen?.skipped).toContain(MOLLIE_CHECKS.chargeback);
    expect(fake.calls).toEqual([{ tool: MOLLIE_TOOLS.payments, args: { limit: MCP_PAGE } }]);
  });

  it('says why when its payments tool requires something Whombat can’t give', async () => {
    fake.tools = tools({
      type: 'object',
      properties: { profileId: { type: 'string' } },
      required: ['profileId'],
    });
    const view = await MOLLIE_KIND.page(ctx());
    expect(view.problem).toContain('payments tool');
    expect(fake.calls).toEqual([]);
  });

  it('says it needs a key when the server offers no payments to read', async () => {
    fake.tools = fake.tools.map((t) => (t.name === MOLLIE_TOOLS.payments ? { ...t, access: 'write' } : t));
    const view = await MOLLIE_KIND.page(ctx());
    expect(view.problem).toContain('API key');
    expect(fake.calls).toEqual([]);
    const c = ctx();
    const seen = await MOLLIE_KIND.seen?.(c.services, c.row, now, TZ);
    expect(seen?.skipped).toEqual(Object.values(MOLLIE_CHECKS));
  });
});
