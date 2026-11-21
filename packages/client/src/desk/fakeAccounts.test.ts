/** The fake world's accounts (3.7, DK-159): *Your accounts* and each widget's view are ones the contract takes. */
import { DeskCatalog, DeskWidgetView } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { catalogSections } from './catalog';
import { FAKE_ACCOUNT_GROUPS, FAKE_GITHUB, FAKE_GOOGLE } from './fakeAccounts';
import { fakeCatalog, fakeViews } from './fakeScreens';
import { defaultFakeDeskWorld } from './fakeWorld';

describe('the fake world’s accounts', () => {
  it('lists them under Your accounts, after the things and before Home’s widgets', () => {
    const catalog = DeskCatalog.parse(fakeCatalog(defaultFakeDeskWorld()));
    const keys = catalog.groups.map((g) => g.key);
    expect(keys.indexOf(FAKE_GOOGLE)).toBeLessThan(keys.indexOf('widgets'));
    expect(keys.indexOf(FAKE_GOOGLE)).toBeGreaterThan(keys.indexOf('connection:con_plex'));
    const accounts = catalogSections(catalog).find((s) => s.kind === 'accounts');
    expect(accounts?.groups.map((g) => g.key)).toEqual(FAKE_ACCOUNT_GROUPS.map((g) => g.key));
    expect(fakeCatalog(defaultFakeDeskWorld(), FAKE_GITHUB).groups.map((g) => g.key)).toEqual([FAKE_GITHUB]);
  });

  it('draws every account widget it offers', () => {
    const specs = FAKE_ACCOUNT_GROUPS.flatMap((g) =>
      g.items.map((i, n) => ({ id: `w_${g.key.slice(8)}_${n}`, type: i.type, ref: i.ref, opts: i.opts })),
    );
    const views = fakeViews(defaultFakeDeskWorld(), specs);
    expect(views).toHaveLength(specs.length);
    for (const v of views) {
      expect(DeskWidgetView.safeParse(v).success, v.id).toBe(true);
      expect(v.problem, v.id).toBeUndefined();
    }
  });
});
