/**
 * Settings → Connections (sidebar-tabs.md), the same on the web and the phone: what this Whombat is signed in to, and
 * how. What needs you first, then your accounts (Google, Microsoft 365, Email, GitHub), then everything else. Two
 * connections that show the same name and place are told apart by renaming one; the list says so. Pure.
 */

export const SETTINGS_CONNECTIONS_TEXT = {
  intro: 'What this Whombat is signed in to, and how.',
  needsYou: 'NEEDS YOU',
  accounts: 'ACCOUNTS',
  apps: 'APPS AND SERVICES',
  /** Under a row whose name and place another row has too. */
  sameName: 'Same name as another connection. Rename one to tell them apart.',
} as const;

/** The pages that are someone's account rather than an app or service. */
const ACCOUNT_PAGES: ReadonlySet<string> = new Set(['google', 'microsoft', 'imap', 'github']);

/** A connection's group in the list, by its catalog entry or builtin page. */
export function settingsConnectionGroup(page: string): 'accounts' | 'apps' {
  return ACCOUNT_PAGES.has(page) ? 'accounts' : 'apps';
}

/** The keys of the rows that show the same name and place as another row: nothing tells them apart. */
export function sameNameKeys(
  rows: readonly { key: string; name: string; address: string | null }[],
): Set<string> {
  const seen = new Map<string, string[]>();
  for (const row of rows) {
    const id = `${row.name.trim().toLowerCase()}\u0000${row.address ?? ''}`;
    seen.set(id, [...(seen.get(id) ?? []), row.key]);
  }
  return new Set([...seen.values()].filter((keys) => keys.length > 1).flat());
}

/** The list's groups in order, each only when it holds a row: needs you, accounts, apps and services. */
export function settingsConnectionGroups<T extends { page: string; ok: boolean }>(
  rows: readonly T[],
): { needsYou: T[]; accounts: T[]; apps: T[] } {
  const needsYou = rows.filter((r) => !r.ok);
  const fine = rows.filter((r) => r.ok);
  return {
    needsYou,
    accounts: fine.filter((r) => settingsConnectionGroup(r.page) === 'accounts'),
    apps: fine.filter((r) => settingsConnectionGroup(r.page) === 'apps'),
  };
}
