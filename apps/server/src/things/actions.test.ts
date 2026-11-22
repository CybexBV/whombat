/**
 * A page's buttons (service-dashboards.md SD-07, SD-08, SD-S04): the central checks before a kind's action runs — an
 * action its kind offers, a person, not on Look only — and the change each leaves; the page's
 * refresh (SD-09).
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors';
import type { PrincipalRow } from '../read/principals';
import { actionChangeKind, actionFor } from './actions';
import { pageButton } from './kinds/buttons';
import { HOME_ASSISTANT_KIND } from './kinds/first';
import { ADGUARD_KIND, PIHOLE_KIND } from './kinds/home/dns';
import { RADARR_KIND, SONARR_KIND } from './kinds/media/arr';
import { PLEX_KIND } from './kinds/media/plex';
import { SETTING_ACTION } from './kinds/settings';
import { IMMICH_KIND } from './kinds/storage/immich';
import { refreshOf } from './page';

const row = {
  catalogId: 'homeassistant',
  access: 'manage' as const,
  label: 'Home Assistant',
  fields: {},
};
const person = { kind: 'person', id: 'prn_1' } as unknown as PrincipalRow;
const viewer = { principal: person };

function refused(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('not refused');
}

describe('actionFor (SD-S04)', () => {
  it('gives the person the kind’s own action and its declared settings action', () => {
    expect(actionFor(row, viewer, 'restart')).toBe(HOME_ASSISTANT_KIND.actions?.restart);
    for (const [catalogId, kind] of [
      ['plex', PLEX_KIND],
      ['adguard', ADGUARD_KIND],
      ['pihole', PIHOLE_KIND],
      ['sonarr', SONARR_KIND],
      ['radarr', RADARR_KIND],
      ['immich', IMMICH_KIND],
    ] as const) {
      expect(actionFor({ ...row, catalogId }, viewer, SETTING_ACTION)).toBe(kind.settings?.action);
    }
  });

  it('refuses an action the kind doesn’t offer, a name an object has anyway, and a kind without buttons', () => {
    expect(refused(() => actionFor(row, viewer, 'reboot')).code).toBe('bad_request');
    expect(refused(() => actionFor(row, viewer, 'constructor')).code).toBe('bad_request');
    expect(refused(() => actionFor(row, viewer, 'hasOwnProperty')).code).toBe('bad_request');
    expect(refused(() => actionFor({ ...row, catalogId: 'notion' }, viewer, 'restart')).code).toBe(
      'bad_request',
    );
  });

  it('refuses agents and Look only, in that order', () => {
    const agent = { ...viewer, principal: { kind: 'agent', id: 'prn_2' } as unknown as PrincipalRow };
    expect(refused(() => actionFor(row, agent, 'restart')).code).toBe('forbidden');
    const lookOnly = refused(() => actionFor({ ...row, access: 'read' }, viewer, 'restart'));
    expect(lookOnly.code).toBe('forbidden');
    expect(lookOnly.message).toContain('Look only');
    expect(lookOnly.message).toContain('Home Assistant');
  });
});

describe('what a button leaves (SD-08)', () => {
  it('records an everyday switch apart from a change a person would want to find', () => {
    expect(actionChangeKind('restart', false)).toBe('thing.restart');
    expect(actionChangeKind('toggle', true)).toBe('thing.control.toggle');
  });
});

describe('refreshOf (SD-09)', () => {
  it('asks again as the kind says, sooner while a newer reading comes, never under 5 seconds', () => {
    expect(refreshOf({})).toBe(60);
    expect(refreshOf({ refreshS: 10 })).toBe(10);
    expect(refreshOf({ refreshS: 2 })).toBe(5);
    expect(refreshOf({ refreshS: 10, refreshing: true })).toBe(5);
    expect(refreshOf({ refreshing: true })).toBe(5);
  });
});

describe('pageButton (CT-1001)', () => {
  const ctx = { row: { ...row, access: 'manage' as const } } as Parameters<typeof pageButton>[0];

  it('is allowed, and disabled with the reason on Look only', () => {
    const spec = { action: 'approve', target: 'req-12', label: 'Approve', tone: 'primary' as const };
    expect(pageButton(ctx, spec)).toMatchObject({ action: 'approve', target: 'req-12', allowed: true });
    expect(pageButton(ctx, spec).reason).toBeUndefined();
    const lookOnly = pageButton({ ...ctx, row: { ...ctx.row, access: 'read' } }, spec);
    expect(lookOnly.allowed).toBe(false);
    expect(lookOnly.reason).toContain('Look only');
    expect(pageButton(ctx, { ...spec, label: 'x'.repeat(40) }).label).toHaveLength(30);
  });
});
