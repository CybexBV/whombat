import { describe, expect, it } from 'vitest';
import { editProps, formatProps, getProp, isOn, parseProps, setProp } from './props';

describe('property strings', () => {
  it('parses items in order with the default key for bare items', () => {
    expect(parseProps('local-zfs:vm-100-disk-0,iothread=1,size=64G', 'file')).toEqual([
      { key: 'file', value: 'local-zfs:vm-100-disk-0', bare: true },
      { key: 'iothread', value: '1' },
      { key: 'size', value: '64G' },
    ]);
    expect(parseProps('')).toEqual([]);
    // A NIC's model item carries the MAC: model=mac.
    expect(getProp(parseProps('virtio=BC:24:11:30:00:00,bridge=vmbr0'), 'virtio')).toBe('BC:24:11:30:00:00');
    // Values may contain "=" (only the first one splits) and "," (a later item without "=" continues the value).
    expect(parseProps('args=a=b')).toEqual([{ key: 'args', value: 'a=b' }]);
    expect(parseProps('type=nic,network=incusbr0,vlan.tagged=10,20')).toEqual([
      { key: 'type', value: 'nic' },
      { key: 'network', value: 'incusbr0' },
      { key: 'vlan.tagged', value: '10,20' },
    ]);
    expect(getProp(parseProps('none,media=cdrom', 'file'), 'file')).toBe('none');
  });

  it('round-trips any string unchanged (fuzzed)', () => {
    const alphabet = ['a', 'Z', '0', '=', ',', ':', ';', ' ', '/', '%', '-', '.', ''];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const s = Array.from({ length: rnd(24) }, () => alphabet[rnd(alphabet.length)]).join('');
      expect(formatProps(parseProps(s, 'file'))).toBe(s);
      // Setting a key and removing it again leaves the other items as they were.
      const items = parseProps(s, 'file');
      if (!items.some((x) => x.key === 'zz')) expect(formatProps(setProp(setProp(items, 'zz', '1'), 'zz', undefined))).toBe(s);
    }
  });

  it('edits in place, appends new keys and keeps unknown options', () => {
    const disk = 'vmdata:vm-101-disk-1,cache=writeback,discard=on,x-unknown=7,size=256G';
    expect(editProps(disk, { discard: 'ignore', ssd: '1' }, 'file')).toBe('vmdata:vm-101-disk-1,cache=writeback,discard=ignore,x-unknown=7,size=256G,ssd=1');
    expect(editProps(disk, { cache: undefined }, 'file')).toBe('vmdata:vm-101-disk-1,discard=on,x-unknown=7,size=256G');
    expect(editProps('none,media=cdrom', { file: 'local:iso/debian.iso' }, 'file')).toBe('local:iso/debian.iso,media=cdrom');
    expect(editProps('', { order: 'scsi0;net0' })).toBe('order=scsi0;net0');
    // A list value is written back whole.
    expect(editProps('type=nic,vlan.tagged=10,20,network=x', { network: 'y' })).toBe('type=nic,vlan.tagged=10,20,network=y');
    expect(editProps('type=nic,network=x', { 'vlan.tagged': '10,20' })).toBe('type=nic,network=x,vlan.tagged=10,20');
    // A repeated key keeps its first place and loses the duplicates.
    expect(formatProps(setProp(parseProps('a=1,b=2,a=3'), 'a', '9'))).toBe('a=9,b=2');
  });

  it('reads flags', () => {
    expect(isOn('1')).toBe(true);
    expect(isOn('on')).toBe(true);
    expect(isOn('0')).toBe(false);
    expect(isOn(undefined, true)).toBe(true);
    expect(isOn('', true)).toBe(true);
  });
});
