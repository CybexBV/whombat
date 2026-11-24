/** A connection's choices changed later: Find My's Read in the background, and its Mac from the servers. */
import { catalogEntry } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { choiceSavedText, choiceSettings } from './choices';

const findMy = catalogEntry('findmy');

describe('a connection’s choices on its page', () => {
  it('offers Find My’s background reads and its Mac among the Macs', () => {
    if (!findMy) throw new Error('no findmy entry');
    const macs = [
      { id: 'studio', name: 'Studio' },
      { id: 'mini', name: 'Mini' },
    ];
    const [mac, background] = choiceSettings(findMy, { mac: 'studio', background: '15' }, macs);
    expect(mac).toMatchObject({ field: 'mac', value: 'studio', valueLabel: 'Studio' });
    expect(mac?.options.map((o) => o.value)).toEqual(['studio', 'mini']);
    expect(background).toMatchObject({ field: 'background', value: '15', valueLabel: 'Every 15 minutes' });
    expect(background?.options[0]).toEqual({ value: 'off', label: 'Off' });
    expect(choiceSavedText(background as NonNullable<typeof background>, '60')).toBe(
      'Read in the background: Every hour.',
    );
  });

  it('leaves the Mac out until the servers are known, and keeps the default without a value', () => {
    if (!findMy) throw new Error('no findmy entry');
    const settings = choiceSettings(findMy, { mac: 'studio' }, null);
    expect(settings.map((s) => s.field)).toEqual(['background']);
    expect(settings[0]?.value).toBe('off');
  });

  it('has nothing to change for an entry without choices', () => {
    const notion = catalogEntry('notion');
    if (!notion) throw new Error('no notion entry');
    expect(choiceSettings(notion, {}, [])).toEqual([]);
  });

  it('offers only the choices that fit the others (a check-in’s lateness)', () => {
    const uptime = catalogEntry('uptime');
    if (!uptime) throw new Error('uptime');
    expect(choiceSettings(uptime, { kind: 'http' }, null).map((c) => c.field)).toEqual(['kind', 'every']);
    expect(choiceSettings(uptime, { kind: 'heartbeat' }, null).map((c) => c.field)).toEqual([
      'kind',
      'every',
      'late',
    ]);
  });
});
