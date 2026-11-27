/**
 * What a backup file can hold (contracts 0.79, CT-335; Whombat backup-file.md BF-05, BF-09): ten categories with stable
 * ids, their order, labels, the starting defaults and the plain meta line under each in the download panel. Since 0.117
 * (CT-900; BF-13, BF-21) eleven: `servers`, and messages and servers on by default. Since 3.0 (CT-1512) `people` is
 * `settings`: one person, no one else's things to leave out.
 */

import { z } from 'zod';
import { Count } from '../domain/common.js';
import { coreTranslator } from '../i18n/catalog.js';
import { DOT } from '../text/format.js';

/** Category ids, in the order panels, files and summaries list them. Stable: files and defaults store them. */
export const BACKUP_CATEGORY_IDS = [
  'agents',
  'memories',
  'automations',
  'connections',
  'skills',
  'settings',
  'vault',
  'messages',
  /** 0.117 (CT-900, BF-13): the hosts service's own backup and Whombat's choices per server. */
  'servers',
  'files',
  'repositories',
] as const;
export const BackupCategoryId = z.enum(BACKUP_CATEGORY_IDS);
export type BackupCategoryId = z.infer<typeof BackupCategoryId>;

/**
 * What a burrow starts with until the person chooses “Make these the default” (BF-09): the first nine since 0.117 (CT-901,
 * BF-21; the first seven before) — messages and servers too, files and repositories stay off for their size. A Whombat
 * applies only those it offers (`backupOfferedDefaults`): servers only where it watches servers (BF-13).
 */
export const BACKUP_DEFAULT_CATEGORIES: readonly BackupCategoryId[] = Object.freeze([
  'agents',
  'memories',
  'automations',
  'connections',
  'skills',
  'settings',
  'vault',
  'messages',
  'servers',
]);

export const BACKUP_CATEGORY_LABELS: Readonly<Record<BackupCategoryId, string>> = {
  agents: 'The agent',
  memories: 'Memories',
  automations: 'Automations',
  connections: 'Connections',
  skills: 'Skills',
  settings: 'Settings',
  vault: 'Your Vault',
  messages: 'Messages',
  servers: 'Servers',
  files: 'Files',
  repositories: 'Repositories on this Whombat',
};

/** `BACKUP_CATEGORY_LABELS` in a locale. */
export function backupCategoryLabels(locale?: string | null): Readonly<Record<BackupCategoryId, string>> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(BACKUP_CATEGORY_IDS.map((id) => [id, tr.t(`backup.category.${id}`)])) as Record<
    BackupCategoryId,
    string
  >;
}

/**
 * Categories whose records carry sign-ins (secrets, tokens): a file with one of them has `includesSecrets` (BF-08). `servers` since 0.117 (BF-13): the hosts service's certificate authority.
 */
export const BACKUP_SECRET_CATEGORIES: readonly BackupCategoryId[] = Object.freeze([
  'connections',
  'vault',
  'servers',
]);

/** Categories in `BACKUP_CATEGORY_IDS` order, each once. */
export function sortBackupCategories(ids: Iterable<BackupCategoryId>): BackupCategoryId[] {
  const set = new Set(ids);
  return BACKUP_CATEGORY_IDS.filter((id) => set.has(id));
}

/** A list of categories as requests carry it: at least one, each once (sorted into order by `sortBackupCategories`). */
export const BackupCategoryList = z
  .array(BackupCategoryId)
  .min(1)
  .max(BACKUP_CATEGORY_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length, 'Each category once.');
export type BackupCategoryList = z.infer<typeof BackupCategoryList>;

/**
 * The defaults a Whombat applies (CT-901, BF-13): `defaults` (the burrow's own, or `BACKUP_DEFAULT_CATEGORIES`) without
 * the categories it doesn't offer, in order.
 */
export function backupOfferedDefaults(
  defaults: Iterable<BackupCategoryId>,
  offered: Iterable<BackupCategoryId>,
): BackupCategoryId[] {
  const can = new Set(offered);
  return sortBackupCategories([...defaults].filter((id) => can.has(id)));
}

/** Whether a set of categories holds sign-ins. */
export function backupIncludesSecrets(ids: Iterable<BackupCategoryId>): boolean {
  for (const id of ids) if (BACKUP_SECRET_CATEGORIES.includes(id)) return true;
  return false;
}

/**
 * One category as the download panel shows it (`backups.estimate`): how many things and roughly how many bytes it adds.
 * `count` is what the meta line counts (agents, memory entries, automations, connections, skills, settings, your
 * Vault entries, messages, files, repositories). `offered` (0.117, CT-901, BF-13): false for a category this Whombat can't put in a file (servers where it
 * watches no servers); the panel leaves it out and the defaults don't apply it. Absent: offered.
 */
export const BackupCategoryEstimate = z.object({
  id: BackupCategoryId,
  count: Count,
  bytes: Count,
  offered: z.boolean().default(true),
});
export type BackupCategoryEstimate = z.infer<typeof BackupCategoryEstimate>;
export type BackupCategoryFacts = z.input<typeof BackupCategoryEstimate>;

const n = (v: number) => v.toLocaleString('en-US');
const count = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/**
 * The plain line under a category in the download panel (BF-05): “Its name, face, model and keys”, “9 automations ·
 * come back switched off”, “Your 8 entries”.
 */
export function backupCategoryMeta(facts: BackupCategoryFacts, locale?: string | null): string {
  const tr = coreTranslator(locale);
  if (tr.language !== 'en') {
    const id = facts.id;
    if (id === 'settings') return tr.t('backup.meta.settings');
    if (facts.count === 0) return tr.t(`backup.meta.${id}.none`);
    if (id === 'agents' || id === 'memories') return tr.t(`backup.meta.${id}`);
    return tr.tp(`backup.meta.${id}`, facts.count, { count: facts.count.toLocaleString('nl-NL') });
  }
  const c = facts.count;
  switch (facts.id) {
    case 'agents':
      return c === 0 ? 'Nothing set up yet' : 'Its name, face, model and keys';
    case 'memories':
      return c === 0 ? 'Nothing remembered yet' : 'What the agent remembers about you, and its notes';
    case 'automations':
      if (c === 0) return 'No automations yet';
      return c === 1
        ? `1 automation ${DOT} comes back switched off`
        : `${n(c)} automations ${DOT} come back switched off`;
    case 'connections':
      if (c === 0) return 'No connections yet';
      return c === 1 ? '1 connection, with its sign-in' : `${n(c)} connections, with their sign-ins`;
    case 'skills':
      if (c === 0) return 'No skills yet';
      return c === 1 ? '1 skill and whether it is on' : `${n(c)} skills and which are on`;
    case 'settings':
      return 'Your settings, repositories and pinned widgets';
    case 'vault':
      return c === 0 ? 'Nothing in it yet' : `Your ${count(c, 'entry', 'entries')}`;
    case 'messages':
      if (c === 0) return 'No messages yet';
      return c === 1 ? '1 message' : `${n(c)} messages in chats and threads`;
    case 'servers':
      if (c === 0) return 'No servers yet';
      return c === 1
        ? '1 server, what Whombat may do on it and its history'
        : `${n(c)} servers, what Whombat may do on them and their history`;
    case 'files':
      if (c === 0) return 'No files yet';
      return c === 1 ? '1 file you or the agent saved' : `${n(c)} files you and the agent saved`;
    case 'repositories':
      if (c === 0) return 'No repositories on this Whombat';
      return c === 1 ? '1 repository, with all its history' : `${n(c)} repositories, with all their history`;
  }
}

const NBSP = ' ';
const trim1 = (v: number) => {
  const s = (Math.round(v * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/**
 * A size in the backup panels (decimal units, as the mock): “4 KB”, “640 KB”, “1.1 MB”, “120 MB”, “1.4 GB”. Kilobytes
 * are whole (at least 1 for anything above 0), megabytes and gigabytes get one decimal below 10. A no-break space
 * joins number and unit (as `formatBytes`).
 */
export function formatBackupSize(bytes: number, locale?: string | null): string {
  const size = formatBackupSizeEn(bytes);
  // Dutch writes the decimal with a comma: “1,1 MB”.
  return coreTranslator(locale).language === 'nl' ? size.replace('.', ',') : size;
}

function formatBackupSizeEn(bytes: number): string {
  const b = Math.max(0, Math.round(bytes));
  if (b === 0) return `0${NBSP}KB`;
  if (b < 999_500) return `${Math.max(1, Math.round(b / 1_000))}${NBSP}KB`;
  if (b < 9_950_000) return `${trim1(b / 1_000_000)}${NBSP}MB`;
  if (b < 999_500_000) return `${Math.round(b / 1_000_000)}${NBSP}MB`;
  if (b < 9_950_000_000) return `${trim1(b / 1_000_000_000)}${NBSP}GB`;
  if (b < 999_500_000_000) return `${Math.round(b / 1_000_000_000)}${NBSP}GB`;
  return `${trim1(b / 1_000_000_000_000)}${NBSP}TB`;
}
