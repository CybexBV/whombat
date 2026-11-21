import { describe, expect, it } from 'vitest';
import { DeskPreview, DeskScreen } from './contract';
import { createFakeDesk, fakeDeskApi } from './fake';

const viewer = { personId: 'prn_john0001', name: 'John Doe' };
const paired = () =>
  createFakeDesk({
    now: () => Date.parse('2026-10-27T14:34:00Z'),
    initial: {
      paired: {
        personId: viewer.personId,
        name: viewer.name,
        pairedAt: '2026-10-20T12:00:00Z',
        pin: '246810',
      },
      settings: DeskScreen.shape.settings.parse({}),
    },
  });

describe('the fake desk’s Settings → Screen (3.2)', () => {
  it('lists what can show, servers in the strip’s order', async () => {
    const api = fakeDeskApi(paired(), viewer);
    await api.update({ show: { order: ['nas'] } });
    const screen = await api.get();
    const servers = screen.showOptions?.filter((o) => o.group === 'server').map((o) => o.name);
    expect(servers?.[0]).toBe('nas');
    expect(screen.showOptions?.some((o) => o.key === 'work')).toBe(true);
  });

  it('previews with unsaved choices and names the top bar', async () => {
    const api = fakeDeskApi(paired(), viewer);
    const before = DeskPreview.parse(await api.preview({ scenario: 'now' }));
    expect(before.name).toBe('Lumio BV');
    expect(before.calm.strip.some((s) => s.name === 'pi-hole')).toBe(true);
    const unsaved = await api.preview({
      scenario: 'wrong',
      show: DeskScreen.shape.settings.parse({ show: { items: { 'server:pi-hole': 'off' } } }).show,
    });
    expect(unsaved.calm.strip.some((s) => s.name === 'pi-hole')).toBe(false);
    expect(unsaved.calm.hero?.server).toBe('pve-01');
    // A down server the assistant looked into, with the step it offers (AP-5907).
    expect(DeskPreview.parse(unsaved).calm.hero).toMatchObject({ research: 'found', fix: 'Restart pve-01' });
    await api.setName('Home');
    expect((await api.get()).whombatName).toBe('Home');
    expect((await api.preview({ scenario: 'now' })).name).toBe('Home');
    expect((await api.tryOnScreen({ scenario: 'busy' })).until).toBe('2026-10-27T14:35:00Z');
  });

  it('answers as a runtime before 3.2 without a world', async () => {
    const api = fakeDeskApi(createFakeDesk({ world: null }), viewer);
    expect((await api.get()).showOptions).toBeUndefined();
    await expect(api.preview({ scenario: 'now' })).rejects.toThrow();
  });
});
