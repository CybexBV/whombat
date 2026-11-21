import { describe, expect, it } from 'vitest';
import { discussOpener } from './discuss';

describe('what the assistant says to start talking an Inbox item over (IBX-07)', () => {
  it('says the item, named by its thing, then asks what the person wants', () => {
    const text = discussOpener({
      title: 'Disk 1 is 89 % full',
      body: 'It grows about 2 GB a day',
      subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
    });
    expect(text).toContain('pve-02: Disk 1 is 89 % full.');
    expect(text).toContain('2 GB a day.');
    expect(text).toContain('?');
  });

  it('uses what the assistant found once it found something', () => {
    const text = discussOpener({
      title: 'Home Assistant isn’t answering',
      body: '',
      subject: { kind: 'connection', id: 'con_ha', name: 'Home Assistant' },
      research: {
        key: 'connection:con_ha',
        state: 'found',
        at: '2026-11-03T08:00:00.000Z',
        title: 'Zigbee stopped',
        summary: 'The stick dropped out.',
      },
    });
    expect(text).toContain('Zigbee stopped');
    expect(text).toContain('The stick dropped out.');
  });
});
