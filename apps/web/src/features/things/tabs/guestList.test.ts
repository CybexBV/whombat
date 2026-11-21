import type { HostGuest } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  GUEST_SORT_DEFAULT,
  guestCpu,
  guestKindShort,
  guestMemory,
  guestSubline,
  guestUp,
  nextGuestSort,
  sortGuests,
} from './guestList';

const NBSP = '\u00a0';

function guest(o: Partial<HostGuest> & { name: string }): HostGuest {
  return {
    id: `pve:${o.name}`,
    platform: 'pve',
    kind: 'container',
    image: '',
    state: 'running',
    cpuPct: 1,
    memoryUsedMb: 512,
    memoryLimitMb: 1024,
    uptimeS: 3600,
    console: { available: true, protocols: ['shell'] },
    ...o,
  } as HostGuest;
}

const names = (gs: readonly HostGuest[]) => gs.map((g) => g.name);

describe('the Guests list’s order (CN-08)', () => {
  const list = [
    guest({ name: 'kali', state: 'stopped', cpuPct: null }),
    guest({ name: 'unifi-controller', cpuPct: 3.7, memoryUsedMb: 4200, uptimeS: 86_400 * 55 }),
    guest({ name: 'AgentDock', cpuPct: 2.6, memoryUsedMb: 195, uptimeS: 86_400 * 55 }),
    guest({ name: 'arnica-prod-db-01', cpuPct: 0.5, memoryUsedMb: 2250, uptimeS: 52 * 60 }),
    guest({ name: 'win11-test', state: 'stopped', cpuPct: null }),
    guest({ name: 'ESPHome', cpuPct: 0.2, memoryUsedMb: 215, uptimeS: null }),
  ];

  it('lists running guests by name A–Z, whatever the case, and stopped ones last', () => {
    expect(names(sortGuests(list, GUEST_SORT_DEFAULT))).toEqual([
      'AgentDock',
      'arnica-prod-db-01',
      'ESPHome',
      'unifi-controller',
      'kali',
      'win11-test',
    ]);
  });

  it('sorts by a column, biggest first, and reverses on a second click; stopped stay last', () => {
    const cpu = nextGuestSort(GUEST_SORT_DEFAULT, 'cpu');
    expect(cpu).toEqual({ key: 'cpu', dir: 'desc' });
    expect(names(sortGuests(list, cpu))).toEqual([
      'unifi-controller',
      'AgentDock',
      'arnica-prod-db-01',
      'ESPHome',
      'kali',
      'win11-test',
    ]);
    const back = nextGuestSort(cpu, 'cpu');
    expect(back.dir).toBe('asc');
    expect(names(sortGuests(list, back)).slice(0, 2)).toEqual(['ESPHome', 'arnica-prod-db-01']);
    expect(names(sortGuests(list, back)).slice(-2)).toEqual(['kali', 'win11-test']);
    expect(nextGuestSort(back, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(names(sortGuests(list, { key: 'name', dir: 'desc' }))[0]).toBe('unifi-controller');
  });

  it('puts a guest without the figure after those with one', () => {
    expect(names(sortGuests(list, { key: 'up', dir: 'desc' })).slice(0, 4)).toEqual([
      'AgentDock',
      'unifi-controller',
      'arnica-prod-db-01',
      'ESPHome',
    ]);
    expect(names(sortGuests(list, { key: 'memory', dir: 'desc' }))[0]).toBe('unifi-controller');
  });
});

describe('a guest row’s words', () => {
  it('says the kind under the name, the state of a stopped one, or a waiting change', () => {
    expect(guestKindShort(guest({ name: 'a', kind: 'vm', vmid: 5911 }))).toBe('VM 5911');
    expect(guestKindShort(guest({ name: 'a', vmid: 129 }))).toBe('CT 129');
    expect(guestKindShort(guest({ name: 'a', platform: 'docker' }))).toBe('Docker');
    expect(guestKindShort(guest({ name: 'a', platform: 'incus', kind: 'vm' }))).toBe('VM');
    expect(guestSubline(guest({ name: 'kali', kind: 'vm', vmid: 201, state: 'stopped' }))).toEqual({
      text: 'VM 201 · Stopped',
      note: false,
    });
    const waiting = guestSubline(guest({ name: 'nest', kind: 'vm', vmid: 5610, pendingChanges: 1 }));
    expect(waiting.note).toBe(true);
    expect(waiting.text).toMatch(/^Restart/);
    expect(guestSubline(guest({ name: 'web', platform: 'incus', project: 'lab' })).text).toBe('CT · lab');
  });

  it('writes memory as “8.1 of 8 GB”, amber from 90 %', () => {
    expect(guestMemory(guest({ name: 'a', memoryUsedMb: 8294, memoryLimitMb: 8192 }))).toMatchObject({
      value: '8.1',
      rest: `of 8${NBSP}GB`,
      warn: true,
    });
    expect(guestMemory(guest({ name: 'a', memoryUsedMb: 195, memoryLimitMb: 1024 }))).toMatchObject({
      value: '195',
      rest: `MB of 1${NBSP}GB`,
      warn: false,
    });
    expect(guestMemory(guest({ name: 'a', memoryUsedMb: 41, memoryLimitMb: 512 }))?.rest).toBe(
      `of 512${NBSP}MB`,
    );
    expect(guestMemory(guest({ name: 'a', memoryUsedMb: 922, memoryLimitMb: 1024 }))?.warn).toBe(true);
    expect(guestMemory(guest({ name: 'a', memoryUsedMb: 921, memoryLimitMb: 1024 }))?.warn).toBe(false);
    expect(guestMemory(guest({ name: 'a', memoryUsedMb: 3072, memoryLimitMb: null }))).toMatchObject({
      value: '3',
      rest: 'GB',
      share: null,
    });
    expect(guestMemory(guest({ name: 'a', state: 'stopped' }))).toBeNull();
  });

  it('shows CPU and uptime only while it runs', () => {
    expect(guestCpu(guest({ name: 'a', cpuPct: 4.9 }))?.text).toBe(`4.9${NBSP}%`);
    expect(guestCpu(guest({ name: 'a', state: 'stopped', cpuPct: 4.9 }))).toBeNull();
    expect(guestUp(guest({ name: 'a', uptimeS: 86_400 * 55 + 30 }))).toBe(`55${NBSP}d`);
    expect(guestUp(guest({ name: 'a', uptimeS: 52 * 60 }))).toBe(`52${NBSP}min`);
    expect(guestUp(guest({ name: 'a', state: 'stopped' }))).toBe('—');
  });
});
