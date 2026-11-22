/**
 * Settings saved in a row are one change (docs/decisions/home-redesign.md HR-06): the title from the fields, and two
 * saves' Undo recipes and details as one that goes back to how it was before the first.
 */
import { describe, expect, it } from 'vitest';
import { mergedFields } from '../home/registry';
import {
  mergeConfigUndo,
  mergeDetailLines,
  mergeSettingsUndo,
  serverSettingsFields,
  settingsMerge,
  settingsTitle,
} from './merge';

describe('settings titles', () => {
  it('names the fields Whombat knows', () => {
    expect(settingsTitle(['name', 'description'], 'pve-01')).toBe('Changed the name and notes of pve-01');
    expect(settingsTitle(['location'], 'pve-01')).toBe('Changed the location of pve-01');
    expect(settingsTitle(['memory', 'cores', 'onboot'], 'web on pve-02')).toContain('memory, cores and');
  });

  it('counts fields it can’t name, or too many to name', () => {
    expect(settingsTitle(['net0', 'name', 'scsi1', 'tags'], 'pve-01')).toBe('Changed 4 settings of pve-01');
    expect(settingsTitle(['net0'], 'web on pve-02')).toBe('Changed a setting of web on pve-02');
    expect(settingsTitle(['name', 'description', 'memory', 'cores'], 'x')).toBe('Changed 4 settings of x');
  });

  it('says a server’s switches as what Whombat may do', () => {
    const fields = serverSettingsFields({ remoteControl: { console: true, power: false } });
    expect(fields).toEqual(['switch.console', 'switch.power']);
    expect(settingsTitle(fields, 'pve-01')).toBe('Changed what Whombat may do on pve-01');
    expect(settingsTitle(['location', ...fields], 'pve-01')).toMatch(
      /^Changed the location of pve-01 and what/,
    );
  });

  it('keeps every field once, in the order first changed', () => {
    expect(mergedFields(['location', 'switch.console'], ['switch.console', 'group'])).toEqual([
      'location',
      'switch.console',
      'group',
    ]);
  });
});

describe('merged Undo', () => {
  it('server settings go back to before the first save', () => {
    const merged = mergeSettingsUndo(
      { serverId: 'pve-01', patch: { location: 'attic', remoteControl: { console: false } } },
      {
        serverId: 'pve-01',
        patch: { location: 'cellar', group: 'lab', remoteControl: { console: true, power: true } },
      },
    );
    expect(merged).toEqual({
      serverId: 'pve-01',
      patch: { location: 'attic', group: 'lab', remoteControl: { console: false, power: true } },
    });
  });

  it('a guest’s configuration keeps the first old value and expects the last new one', () => {
    const merged = mergeConfigUndo(
      {
        serverId: 's',
        guestId: '101',
        guestName: 'web',
        set: { name: 'web' },
        delete: ['tags'],
        expect: { name: 'web2', tags: 'a' },
      },
      {
        serverId: 's',
        guestId: '101',
        guestName: 'web3',
        set: { name: 'web2', description: 'old' },
        delete: ['tags', 'onboot'],
        expect: { name: 'web3', description: 'new', tags: 'b', onboot: '1' },
      },
    );
    expect(merged.set).toEqual({ name: 'web', description: 'old' });
    expect(merged.delete).toEqual(['tags', 'onboot']);
    expect(merged.expect).toEqual({ name: 'web3', tags: 'b', description: 'new', onboot: '1' });
    expect(merged.guestName).toBe('web3');
  });

  it('a guest’s merged configuration goes back only where the first save went', () => {
    const save = (destination?: string) => ({
      serverId: 's',
      guestId: '101',
      guestName: 'web',
      set: { name: 'web' },
      delete: [],
      expect: { name: 'web2' },
      ...(destination ? { destination } : {}),
    });
    expect(mergeConfigUndo(save('a'), save('b')).destination).toBe('a');
    expect(mergeConfigUndo(save(), save('b')).destination).toBe('b');
    expect(mergeConfigUndo(save(), save())).not.toHaveProperty('destination');
  });

  it('the details show each key once, from the first old value to the last new one', () => {
    expect(mergeDetailLines('name: web → web2', 'name: web2 → web3\nmemory: 1024 → 2048')).toBe(
      'name: web → web3\nmemory: 1024 → 2048',
    );
    expect(mergeDetailLines(null, null)).toBeNull();
  });

  it('merges per server or guest and kind', () => {
    const server = settingsMerge({
      op: 'server_settings',
      serverId: 'pve-01',
      fields: ['group'],
      target: 'pve-01',
    });
    const guest = settingsMerge({
      op: 'guest_config',
      serverId: 'pve-01',
      guestId: '101',
      fields: ['name'],
      target: 'web on pve-01',
    });
    expect(server.key).not.toBe(guest.key);
    expect(guest.key).toContain('101');
    expect(guest.title(['name', 'description'])).toBe('Changed the name and notes of web on pve-01');
  });
});
