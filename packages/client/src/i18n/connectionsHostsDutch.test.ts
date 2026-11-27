import type { HostGuest, HostGuestConfig, HostUnraidDisk } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { connectionStates, reauthText } from '../connections/form';
import { guideNetworkText } from '../guides';
import {
  BACKUP_MODES,
  backupModes,
  followWords,
  guestHints,
  guestSettingGroups,
  PHONE_GUEST_TAB_WORDS,
  phoneGuestTabWords,
  scheduleWords,
  taskWord,
} from '../hosts/guest-mobile';
import { incusScheduleLine, incusSettingGroups, thisWhombatFact } from '../hosts/incus-mobile';
import { libvirtEditSpec, libvirtValueWords } from '../hosts/libvirt-mobile';
import { manageDoneText } from '../hosts/manage';
import { actionAcceptedText, GUEST_STATE_WORDS, guestStateWords, powerActions } from '../hosts/model';
import { unraidChangeWords, unraidDiskStatus } from '../hosts/unraid';
import { diskRowFor } from '../hosts/unraid-mobile';
import { machineVerdict } from '../hosts/verdict';
import { CONNECTIONS_HOSTS_AREAS } from './messages/connectionsHosts';

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
const COUNT_HOLES = new Set(['count', 'n', 'countWord', 'shown']);

const guest = (over: Partial<HostGuest> = {}): HostGuest =>
  ({
    id: 'pve:101',
    serverId: 'pve-02',
    name: 'web',
    platform: 'pve',
    kind: 'vm',
    image: '',
    state: 'running',
    ...over,
  }) as HostGuest;

describe('connections and servers in Dutch', () => {
  it('has a Dutch word for every English one, with the same placeholders', () => {
    const prefixes = new Set<string>();
    for (const area of CONNECTIONS_HOSTS_AREAS) {
      expect(prefixes.has(area.prefix)).toBe(false);
      prefixes.add(area.prefix);
      expect(Object.keys(area.nl).sort()).toEqual(Object.keys(area.en).sort());
      for (const [key, en] of Object.entries(area.en)) {
        const nl = area.nl[key];
        if (typeof en === 'string') {
          expect(typeof nl, key).toBe('string');
          expect(nl, key).not.toBe('');
          expect(holes(nl as string), key).toEqual(holes(en));
        } else {
          expect(typeof nl, key).toBe('object');
          const plural = nl as Record<string, string>;
          expect(holes(plural.other ?? ''), key).toEqual(holes(en.other ?? ''));
          const one = holes(plural.one ?? '').filter((h) => !COUNT_HOLES.has(h));
          const enOne = holes(en.other ?? '').filter((h) => !COUNT_HOLES.has(h));
          expect(one, key).toEqual(enOne);
        }
      }
    }
  });

  it('keeps the English constants as they were', () => {
    expect(GUEST_STATE_WORDS).toEqual(guestStateWords('en'));
    expect(PHONE_GUEST_TAB_WORDS).toEqual(phoneGuestTabWords());
    expect(BACKUP_MODES).toEqual(backupModes('en'));
    expect(guestStateWords('fr-FR')).toEqual(GUEST_STATE_WORDS);
  });

  it('reads a connection and a guide in Dutch', () => {
    expect(guideNetworkText('nl')).not.toBe(guideNetworkText('en'));
    expect(reauthText('expired', 'GitHub', false, 'token', 'nl')).toContain('GitHub');
    expect(connectionStates('nl')).not.toEqual(connectionStates('en'));
  });

  it('reads a guest’s screen in Dutch', () => {
    expect(phoneGuestTabWords('nl').settings).toBe('Instellingen');
    expect(guestStateWords('nl').running).toBe('Draait');
    expect(powerActions(guest(), 'nl').map((a) => a.label)).toContain('Afsluiten');
    expect(actionAcceptedText('start', 'web', false, 'nl')).toContain('web');
    expect(actionAcceptedText('start', 'web', false, 'nl')).not.toBe(actionAcceptedText('start', 'web'));
    expect(taskWord('qmstart', 'nl')).toBe('Starten');
    expect(taskWord('Backing up instance', 'nl')).toBe('Back-up');
    expect(scheduleWords('sat 02:00', 'nl')).toBe('Elke zaterdag om 02:00');
    expect(followWords('snapshot_restore', 'web', 'daily', 'nl').done).toContain('“daily”');
    const hints = guestHints(guest({ backupJob: false }), Date.now(), {}, 'nl');
    expect(hints[0]?.action?.label).toBe('Nu back-up maken');
    const cfg = {
      kind: 'vm',
      platform: 'pve',
      values: { cores: '2', memory: '2048' },
    } as unknown as HostGuestConfig;
    const titles = guestSettingGroups(cfg, 'web', 'nl').map((g) => g.title);
    expect(titles).toContain('Schijven');
  });

  it('reads Incus, libvirt and Unraid in Dutch', () => {
    const cfg = {
      kind: 'container',
      platform: 'incus',
      values: { 'snapshots.schedule': '@daily', 'snapshots.expiry': '2w' },
    } as unknown as HostGuestConfig;
    expect(incusScheduleLine(cfg, 'nl').text).toBe('Elke dag · 2 weken bewaard');
    expect(incusSettingGroups(cfg, 'nl').map((g) => g.title)).toContain('Beveiliging');
    expect(thisWhombatFact(true, [], 'nl')?.value).toBe('Draait hier');
    expect(libvirtValueWords('boot', 'hd,cdrom', 'nl')).toBe('Schijf, daarna Cd/dvd');
    expect(libvirtEditSpec('memory', 'win11', undefined, 'nl').title).toContain('win11');
    expect(unraidChangeWords('array.start', 'BlackBox', {}, 'nl').finished).toContain('BlackBox');
    const disk = {
      name: 'disk1',
      status: 'ok',
      device: 'sdb',
      spunDown: true,
      rotational: true,
    } as HostUnraidDisk;
    expect(unraidDiskStatus(disk, 'nl').text).toBe('Normaal');
    expect(diskRowFor({ ...disk, errors: 0 } as HostUnraidDisk, 'nl').tempText).toBe('Stilgevallen');
  });

  it('says what happened and how a machine is in Dutch', () => {
    expect(manageDoneText('guest.clone', 'web', false, 'nl')).toBe('web gekloond.');
    expect(manageDoneText('guest.clone', 'web', false)).toBe('Cloned web.');
    expect(machineVerdict(guest(), [], Date.now(), 'nl').sentence).toBe('web draait goed.');
  });
});
