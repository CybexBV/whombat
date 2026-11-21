/**
 * Proxmox property strings (ported from Rackoon's `features/guest/props.ts`; hosts/docs/MANAGE.md 2.4):
 * “local-zfs:vm-100-disk-0,iothread=1,size=64G” is an ordered list of items separated by “,”. A first item without
 * “=” is the value of the key's default sub-key (`file` for disks, `type` for display and machine, `enabled` for the
 * guest agent); a later one continues the previous value (Incus device strings: “vlan.tagged=10,20”). Edits change
 * items in place and append new ones, so options Whombat has no field for survive a round trip byte for byte. Pure.
 */

export interface PropItem {
  key: string;
  value: string;
  /** Written without “key=” (the default sub-key's value). */
  bare?: boolean;
}

/** Parse a property string; lossless: `formatProps(parseProps(s)) === s` for any `s`. */
export function parseProps(s: string, defaultKey = ''): PropItem[] {
  if (s === '') return [];
  const out: PropItem[] = [];
  for (const item of s.split(',')) {
    const i = item.indexOf('=');
    const prev = out[out.length - 1];
    if (i >= 0) out.push({ key: item.slice(0, i), value: item.slice(i + 1) });
    else if (prev) prev.value += `,${item}`;
    else out.push({ key: defaultKey, value: item, bare: true });
  }
  return out;
}

export function formatProps(items: readonly PropItem[]): string {
  return items.map((x) => (x.bare ? x.value : `${x.key}=${x.value}`)).join(',');
}

/** The value of a sub-key (the first one when it repeats). */
export function getProp(items: readonly PropItem[], key: string): string | undefined {
  return items.find((x) => x.key === key)?.value;
}

/**
 * Set a sub-key in place (appended when new; a repeated key keeps its first place); undefined removes it. Other
 * items keep their order and spelling.
 */
export function setProp(items: readonly PropItem[], key: string, value: string | undefined): PropItem[] {
  const i = items.findIndex((x) => x.key === key);
  if (value === undefined) return i < 0 ? [...items] : items.filter((x) => x.key !== key);
  if (i < 0) return [...items, { key, value }];
  return items.filter((x, j) => j === i || x.key !== key).map((x) => (x.key === key ? { ...x, value } : x));
}

/** Change sub-keys of a property string (undefined removes one). */
export function editProps(s: string, changes: Record<string, string | undefined>, defaultKey = ''): string {
  let items = parseProps(s, defaultKey);
  for (const [k, v] of Object.entries(changes)) items = setProp(items, k, v);
  return formatProps(items);
}

/** A flag's meaning (“1”, “on”, “yes”, “true”); `fallback` when it isn't set. */
export function isOn(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|on|yes|true)$/i.test(v);
}
