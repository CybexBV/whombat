// Property strings (docs/MANAGE.md 2.4): "local-zfs:vm-100-disk-0,
// iothread=1,size=64G" is an ordered list of items separated by ","; a
// first item without "=" is the value of the key's default sub-key (`file`
// for disks), a later one continues the previous value (Incus device
// strings: "type=nic,vlan.tagged=10,20" has vlan.tagged = "10,20"). Edits
// change items in place and append new ones, so options Rackoon does not
// know survive a round trip unchanged.

export interface PropItem {
  key: string;
  value: string;
  /** Written without "key=" (the default sub-key's value). */
  bare?: boolean;
}

/**
 * Parse a property string: a first item without "=" gets `defaultKey`,
 * later ones continue the previous value. Lossless:
 * formatProps(parseProps(s)) === s.
 */
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

export function formatProps(items: PropItem[]): string {
  return items.map((x) => (x.bare ? x.value : `${x.key}=${x.value}`)).join(',');
}

/** The value of a sub-key (the first one when it repeats), or undefined. */
export function getProp(items: PropItem[], key: string): string | undefined {
  return items.find((x) => x.key === key)?.value;
}

/**
 * Set a sub-key in place (appended when new; a repeated key keeps its
 * first place); undefined removes it. Other items keep their order and
 * spelling.
 */
export function setProp(items: PropItem[], key: string, value: string | undefined): PropItem[] {
  const i = items.findIndex((x) => x.key === key);
  if (value === undefined) return i < 0 ? items : items.filter((x) => x.key !== key);
  if (i < 0) return [...items, { key, value }];
  return items.filter((x, j) => j === i || x.key !== key).map((x) => (x.key === key ? { ...x, value } : x));
}

/** Change sub-keys of a property string (undefined removes one). */
export function editProps(s: string, changes: Record<string, string | undefined>, defaultKey = ''): string {
  let items = parseProps(s, defaultKey);
  for (const [k, v] of Object.entries(changes)) items = setProp(items, k, v);
  return formatProps(items);
}

/** The boolean meaning of a flag value ("1", "on", "yes", "true"). */
export function isOn(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|on|yes|true)$/i.test(v);
}
