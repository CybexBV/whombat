import { describe, expect, it } from 'vitest';
import type { LinkAccount } from './control';
import { boxHasAccount, boxMenuRows, homePlanLine, homeRows, LINK_QUIET_S, linkWhombatLine } from './home';

const now = 1_790_000_000_000;
const s = now / 1000;
const box = (patch: Partial<LinkAccount['boxes'][number]> = {}): LinkAccount['boxes'][number] => ({
  device: 'dev_home',
  name: 'Home',
  state: 'on',
  since: s - 86_400,
  graceEndsAt: null,
  label: 'maple-otter-river',
  host: 'maple-otter-river.box.whombat.app',
  lastSeenAt: s - 600,
  ...patch,
});
const account = (boxes: LinkAccount['boxes']): LinkAccount => ({
  plan: {
    state: 'active',
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialAvailable: false,
    boxes: boxes.length,
    discount: { percentOff: 100, endsAt: null, code: null },
  },
  boxes,
});

describe('a Whombat’s line', () => {
  it('on and heard from lately: its address says it, and it opens', () => {
    expect(linkWhombatLine(box(), now)).toEqual({ tone: 'ok', text: null, opens: true });
  });
  it('quiet for hours says since when and still opens; never “Online”', () => {
    const line = linkWhombatLine(box({ lastSeenAt: s - LINK_QUIET_S - 3600 }), now);
    expect(line.tone).toBe('mut');
    expect(line.text).toMatch(/^Not heard from since \d+ hours ago$/);
    expect(line.opens).toBe(true);
  });
  it('getting its address, off and ended don’t open', () => {
    expect(linkWhombatLine(box({ state: 'starting', host: null }), now).opens).toBe(false);
    expect(linkWhombatLine(box({ state: 'on', host: null }), now).opens).toBe(false);
    expect(linkWhombatLine(box({ state: 'off' }), now).opens).toBe(false);
    expect(linkWhombatLine(box({ state: 'ended' }), now)).toMatchObject({ tone: 'bad', opens: false });
  });
  it('in its last week: until when where known, and it opens', () => {
    expect(linkWhombatLine(box({ state: 'grace', graceEndsAt: s + 3 * 86_400 }), now).text).toMatch(/^Ends /);
    expect(
      linkWhombatLine({ state: 'grace', host: 'a.box.whombat.app', lastSeenAt: null }, now).text,
    ).toBeNull();
  });
});

describe('the home’s rows', () => {
  it('the one opened last first, tagged only among several', () => {
    const a = account([
      box(),
      box({ device: 'dev_studio', name: 'Studio', host: 'cedar-lark-meadow.box.whombat.app' }),
    ]);
    const rows = homeRows({ account: a, lastOpened: 'dev_studio', now });
    expect(rows.map((r) => r.device)).toEqual(['dev_studio', 'dev_home']);
    expect(rows.map((r) => r.openedLast)).toEqual([true, false]);
    expect(rows[0]?.open).toEqual({ kind: 'url', url: 'https://cedar-lark-meadow.box.whombat.app/' });
    const one = homeRows({ account: account([box()]), lastOpened: 'dev_home', now });
    expect(one[0]?.openedLast).toBe(false);
  });
  it('an older organization’s Whombat opens here, once even when it is linked too, never retired', () => {
    const old = {
      device: 'dev_old',
      orgId: 'org_1',
      name: 'Workshop',
      state: 'claimed' as const,
      contentPeerId: 'peer',
      lastSeenAt: s - 30,
      revocationsPending: 0,
    };
    const rows = homeRows({
      account: account([box()]),
      hosted: [old, { ...old, device: 'dev_home' }, { ...old, device: 'dev_gone', state: 'retired' }],
      lastOpened: null,
      now,
    });
    expect(rows.map((r) => r.device)).toEqual(['dev_home', 'dev_old']);
    expect(rows[1]).toMatchObject({ open: { kind: 'here' }, text: 'Online', tone: 'ok' });
  });
  it('the plan in one line, with how many Whombats; nothing before the first', () => {
    expect(homePlanLine(account([box(), box({ device: 'b' })]))?.text).toBe(
      'Whombat Link · Free for good · 2 Whombats',
    );
    const none = account([]);
    none.plan = { ...none.plan, state: 'none', discount: null };
    expect(homePlanLine(none)).toBeNull();
  });
});

describe('the menu under a box’s name', () => {
  it('there while the box has Link', () => {
    expect(boxHasAccount('on')).toBe(true);
    expect(boxHasAccount('ended')).toBe(true);
    expect(boxHasAccount('off')).toBe(false);
    expect(boxHasAccount(null)).toBe(false);
  });
  it('the other Whombats by name, each opening at its own address while that works', () => {
    const rows = boxMenuRows(
      [
        {
          device: 'b',
          name: 'Studio',
          state: 'on',
          host: 'cedar-lark-meadow.box.whombat.app',
          lastSeenAt: null,
        },
        { device: 'c', name: 'Cabin', state: 'starting', host: null, lastSeenAt: null },
      ],
      now,
    );
    expect(rows.map((r) => r.name)).toEqual(['Cabin', 'Studio']);
    expect(rows[0]).toMatchObject({ url: null, text: 'Getting its address…', tone: 'warn' });
    expect(rows[1]).toMatchObject({
      url: 'https://cedar-lark-meadow.box.whombat.app/',
      text: 'cedar-lark-meadow.box.whombat.app',
    });
  });
});
