/**
 * The parity screens' models (mobile-parity.md MQ-02, MQ-03): Usage (the Spend report), and the
 * audit log's filters, chips, rows and signed detail — over the fixture world, with the web's words.
 */
import { usageView } from '@whombat/client';
import {
  AUDIT_CHAIN,
  enrichAuditEvent,
  mara,
  PRINCIPALS,
  SEED_NOW,
  SEED_TIME_ZONE,
  spendOverview,
} from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  auditContext,
  auditDetail,
  auditFilters,
  auditKindChips,
  auditRouteParams,
  auditRow,
  auditWhoName,
} from './audit';

const principals = PRINCIPALS as unknown as Parameters<typeof auditContext>[0];

describe('Usage (MQ-02, AP-5767; final-settings-vault-files-usage.md)', () => {
  it('reads the fixture world’s report in the shared words: cost, times worked, no people', () => {
    const view = usageView(spendOverview(), 'Neo');
    expect(view.title).toBe('Usage');
    expect(view.windows.today.coverage).toMatch(/^Cost reported for \d+ of \d+$/);
    expect(Object.keys(view)).not.toContain('people');
  });
});

describe('the audit log (MQ-03)', () => {
  const ctx = auditContext(principals, SEED_NOW, SEED_TIME_ZONE);
  const events = AUDIT_CHAIN.map((e) => enrichAuditEvent(e, new Map()));

  it('reads its filters from a link, the defaults for anything else', () => {
    expect(auditFilters(undefined)).toEqual({
      actor: 'everyone',
      kind: 'all',
      who: undefined,
      open: undefined,
    });
    expect(auditFilters({ actor: 'agents', kind: 'code', who: 'banjo', open: 'evt_9f18' })).toEqual({
      actor: 'agents',
      kind: 'code',
      who: 'banjo',
      open: 'evt_9f18',
    });
    expect(auditFilters({ actor: 'robots', kind: 'x', who: '<b>', open: 'a b' })).toEqual({
      actor: 'everyone',
      kind: 'all',
      who: undefined,
      open: undefined,
    });
    expect(auditRouteParams(auditFilters({ actor: 'people', who: 'banjo' }))).toEqual({
      actor: 'people',
      who: 'banjo',
    });
  });

  it('offers the kind chips with counts, Vault once the log has one', () => {
    const counts = { all: 9, code: 3, asks: 2, keys: 1, vault: 0, messages: 2, blocked: 1 };
    expect(auditKindChips('all', counts).map((c) => c.label)).toEqual([
      'All',
      'Code',
      'Asks',
      'Keys',
      'Messages',
      'Blocked',
    ]);
    expect(auditKindChips('vault', counts).map((c) => c.value)).toContain('vault');
    expect(auditKindChips('all', { ...counts, vault: 2 }).find((c) => c.value === 'vault')?.count).toBe(2);
    expect(auditKindChips('code', counts).find((c) => c.active)?.value).toBe('code');
  });

  it('names the actor with its tag, and opens to the signed detail with “signature verified”', () => {
    const event = events.find((e) => e.actorId !== mara.id && e.ref) ?? events[0];
    if (!event) throw new Error('fixture events');
    const row = auditRow(
      event,
      ctx,
      principals.find((p) => p.id === event.actorId),
    );
    expect(row.time).toMatch(/^\d\d:\d\d$/);
    expect(row.name.length).toBeGreaterThan(0);
    expect(row.tag).toMatch(/^[A-Z ·]+$/);
    expect(row.meta).toContain(event.id.replace(/^evt_/, 'e-'));
    const detail = auditDetail(event, ctx);
    expect(detail.fields.at(-1)).toMatchObject({ label: 'EVENT', tone: 'ok' });
    expect(detail.fields.at(-1)?.value).toMatch(/signature verified$/);
    expect(detail.link?.label.length).toBeGreaterThan(0);
    expect(auditDetail({ ...event, verified: false }, ctx).fields.at(-1)).toMatchObject({ tone: 'bad' });
  });

  it('names “Only …” by its handle', () => {
    expect(auditWhoName('dusty', principals)).toBe('Dusty');
    expect(auditWhoName('nobody', principals)).toBe('nobody');
    expect(auditWhoName(undefined, principals)).toBeNull();
  });
});
