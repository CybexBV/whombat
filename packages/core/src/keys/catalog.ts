/**
 * The key catalog: every permission key that exists in Whombat, with the mock copy verbatim.
 *
 * Several mock strings are different wordings of the same permission ("Read all connected repos" /
 * "Read connected repos", "Write code" / "Change code", "Write to feat/* branches" / "Read and write
 * feat/* branches"). Each wording has its own stable id so any screen can render it verbatim; `sameAs`
 * tells the engine they are one permission. `parent` makes umbrella keys ("Deploy", "Merge", "Write code")
 * cover their specific children, and `implies` makes bundle keys ("Run tests and CI") grant several keys.
 *
 * `KEY_IDS` order is the display order of key rows (Settings → Agent, run page).
 */
import { z } from 'zod';

export const KEY_IDS = [
  'repos.read_all',
  'canvas.write',
  // Developer
  'branch.feature.readwrite',
  'branch.feature.write',
  'tests.run',
  'tests_ci.run',
  'pr.open',
  'branch.shared.push',
  // Skills library (docs/decisions/skills-library.md SL-05): a throwaway, writable folder without a repository.
  'workspace.scratch',
  // Researcher
  'messages.search',
  'repos.read',
  'web.browse',
  // The browser (docs/decisions/browser.md BT-02): pages Whombat's headless Chromium opens for the agent.
  'browser.use',
  'messages.external',
  // Reviewer
  'pr.comment',
  'pr.request_changes',
  'pr.approve',
  // Operator
  'ci.run',
  'jobs.scheduled.run',
  'pipelines.retry',
  'deploy.staging',
  'deploy.production',
  // Support
  'customers.read',
  'helpwidget.reply',
  'tickets.tag',
  'refunds.issue',
  // Tracker reports (0.69, CT-325, Whombat report-trackers.md TA-12): held only by automations (`automationsOnly`).
  'report.update',
  // Replying to a tracker report's customer (0.75, CT-331, TA-27): held only by automations.
  'report.reply',
  // Capability packs' tools, retired in 0.113 (`KeyDef.retired`): nothing uses them.
  'packs.tool.read',
  'packs.tool.write',
  // Umbrella and restricted keys (usually listed under "cannot")
  'merge',
  'merge.main',
  // Writing the default branch directly (contracts 0.34, CT-211); agents may hold it since 0.36 (CT-222, AC-41).
  'branch.main.push',
  'code.write',
  'code.change',
  'deploy',
  // Destructive commands on other machines, from the agent's commands (contracts 0.36, Whombat AC-41).
  'commands.destructive',
  'billing.write',
  // People-only burrow administration
  'agents.manage',
  'approvals.decide',
  'burrow.manage',
  // Changing Whombat's settings for the person, as their tap would (Whombat assistant-settings.md; contracts 3.15).
  'settings.change',
  // Sharing a thread of Chat by link (Whombat share-links.md): always asks.
  'share.link',
  // A person's own accounts: used only in a turn for that person (Whombat one-agent.md OA-10).
  'mail.read',
  'mail.organize',
  'mail.draft',
  'mail.send',
  'mail.delete',
  'calendar.read',
  'calendar.write',
  'calendar.invite',
  'files.read',
  'files.write',
  'files.share',
  'files.delete',
  'contacts.read',
  // Connected services (Whombat connections-catalog.md CX-20, contracts 0.48): reading and changing what a shared
  // connection, or the own connection of the person a turn is for, holds (Home Assistant, Notion, Todoist, …).
  'connections.read',
  'connections.write',
] as const;

export const KeyId = z.enum(KEY_IDS);
export type KeyId = z.infer<typeof KeyId>;

/** Grant tiers: `can` acts, `ask` needs a person to approve each time, `cannot` is blocked. */
export const Tier = z.enum(['can', 'ask', 'cannot']);
export type Tier = z.infer<typeof Tier>;

/** The highest tier an agent may ever hold for a key. `never` = people only. */
export const MaxTier = z.enum(['can', 'ask', 'never']);
export type MaxTier = z.infer<typeof MaxTier>;

export const KeyGroup = z.enum([
  'code',
  'research',
  'operations',
  'support',
  'burrow',
  'personal',
  'connections',
]);
export type KeyGroup = z.infer<typeof KeyGroup>;

/** Section headings for key groups (Settings → Agent → Keys). */
export const KEY_GROUP_LABELS: Record<KeyGroup, string> = {
  code: 'Code',
  research: 'Research',
  operations: 'Operations',
  support: 'Support',
  burrow: 'This Whombat',
  personal: 'Personal accounts',
  connections: 'Connected services',
};

/**
 * Scope restrictions on a key or grant. A restricted dimension only matches requests that name a value
 * inside it (fail closed). Branch patterns are globs (`feat/*`).
 */
export const KeyScope = z.object({
  branches: z.array(z.string().min(1)).optional(),
  repos: z.array(z.string().min(1)).optional(),
  environments: z.array(z.string().min(1)).optional(),
  /** Connection ids (`con_…`; 0.69, CT-325): an automation's `report.update` (0.75: and `report.reply`) for its tracker. */
  connections: z.array(z.string().min(1)).optional(),
});
export type KeyScope = z.infer<typeof KeyScope>;

export interface KeyDef {
  id: KeyId;
  /** Mock copy, verbatim. */
  label: string;
  description: string;
  group: KeyGroup;
  agentMaxTier: MaxTier;
  /** Umbrella key this key belongs to; a grant on the umbrella covers it unless a more specific grant exists. */
  parent?: KeyId;
  /** This id is another wording of `sameAs`; the engine treats both as one permission. */
  sameAs?: KeyId;
  /** Bundle: holding this key grants each implied key at the same tier. */
  implies?: readonly KeyId[];
  /** Scope inherent to the key itself (e.g. `feat/*` branches). */
  scope?: KeyScope;
  /**
   * Only automations hold it (0.69, CT-325): no agent tool needs it, so it is never one of an agent's always-on keys,
   * switches or rows. Its `agentMaxTier` is `can` because an automation's principal decides as an agent does.
   */
  automationsOnly?: boolean;
  /**
   * Nothing uses it any more (0.113, CT-824: the pack tools' keys, Whombat skill-store.md SST-09). It stays a `KeyId` so
   * stored grants still parse, and an agent may still hold it; it is never an
   * always-on key, a switch, a row or a default, and views and prompts leave it out (`isRetiredKey`).
   */
  retired?: boolean;
}

type KeyDefBody = Omit<KeyDef, 'id'>;

const DEFS: Record<KeyId, KeyDefBody> = {
  'repos.read_all': {
    label: 'Read all connected repos',
    description: 'Read every repository that is switched on for this Whombat.',
    group: 'code',
    agentMaxTier: 'can',
    sameAs: 'repos.read',
  },
  'canvas.write': {
    label: 'Write canvases',
    description: 'Create canvases and edit them like a person would.',
    group: 'research',
    agentMaxTier: 'can',
  },
  'branch.feature.readwrite': {
    label: 'Read and write feat/* branches',
    description: 'Create, commit to and push feature branches that match feat/*.',
    group: 'code',
    agentMaxTier: 'can',
    parent: 'code.write',
    scope: { branches: ['feat/*'] },
  },
  'branch.feature.write': {
    label: 'Write to feat/* branches',
    description: 'Create, commit to and push feature branches that match feat/*.',
    group: 'code',
    agentMaxTier: 'can',
    sameAs: 'branch.feature.readwrite',
  },
  'tests.run': {
    label: 'Run tests',
    description: 'Run test suites in the agent’s workspace and report the results.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'tests_ci.run': {
    label: 'Run tests and CI',
    description: 'Run test suites and trigger CI pipelines.',
    group: 'code',
    agentMaxTier: 'can',
    implies: ['tests.run', 'ci.run'],
  },
  'pr.open': {
    label: 'Open pull requests',
    description: 'Open pull requests from branches the agent can write to.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'branch.shared.push': {
    label: 'Push to shared branches',
    description: 'Push to branches other people work on (anything outside feat/* and main).',
    group: 'code',
    agentMaxTier: 'can',
    parent: 'code.write',
  },
  'messages.search': {
    label: 'Search messages, canvases and runs',
    description: 'Search everything on this Whombat it may read: branch rooms, canvases and runs.',
    group: 'research',
    agentMaxTier: 'can',
  },
  'repos.read': {
    label: 'Read connected repos',
    description: 'Read every repository that is switched on for this Whombat.',
    group: 'research',
    agentMaxTier: 'can',
  },
  'web.browse': {
    label: 'Browse the web',
    description: 'Fetch and read public web pages.',
    group: 'research',
    agentMaxTier: 'can',
  },
  'browser.use': {
    label: 'Use a web browser',
    description: 'Open pages, click, type and take screenshots in its browser.',
    group: 'research',
    agentMaxTier: 'can',
    implies: ['web.browse'],
  },
  'messages.external': {
    label: 'Message people outside your Whombat',
    description: 'Send email or messages to anyone outside this Whombat.',
    group: 'research',
    agentMaxTier: 'can',
  },
  'workspace.scratch': {
    label: 'Run tools in a scratch workspace',
    description: 'Run scripts and make files in a private, throwaway folder without a repository.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'pr.comment': {
    label: 'Comment on pull requests',
    // Since 0.41 also what `gh` writes on issues (Whombat agent-gh.md AGH-06): the label stays the mock's.
    description: 'Leave comments on pull requests and issues, and open, edit and close issues.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'pr.request_changes': {
    label: 'Request changes',
    description: 'Submit a review that requests changes on a pull request.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'pr.approve': {
    label: 'Approve pull requests',
    description: 'Submit an approving review on a pull request.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'ci.run': {
    label: 'Run CI',
    description: 'Trigger CI pipelines on branches.',
    group: 'operations',
    agentMaxTier: 'can',
  },
  'jobs.scheduled.run': {
    label: 'Run scheduled jobs',
    description: 'Run this Whombat’s scheduled jobs, such as the nightly sync.',
    group: 'operations',
    agentMaxTier: 'can',
  },
  'pipelines.retry': {
    label: 'Retry failed pipelines',
    description: 'Re-run pipelines that failed.',
    group: 'operations',
    agentMaxTier: 'can',
  },
  'deploy.staging': {
    label: 'Deploy to staging',
    description: 'Deploy a commit to the staging environment.',
    group: 'operations',
    agentMaxTier: 'can',
    parent: 'deploy',
  },
  'deploy.production': {
    label: 'Deploy to production',
    description: 'Deploy a commit to production.',
    group: 'operations',
    agentMaxTier: 'can',
    parent: 'deploy',
  },
  'customers.read': {
    label: 'Read customer accounts',
    description: 'Look up customer accounts and their history.',
    group: 'support',
    agentMaxTier: 'can',
  },
  'helpwidget.reply': {
    label: 'Reply in the help widget',
    description: 'Answer customers in the help widget.',
    group: 'support',
    agentMaxTier: 'can',
  },
  'tickets.tag': {
    label: 'Tag tickets',
    description: 'Add and remove tags on support tickets.',
    group: 'support',
    agentMaxTier: 'can',
  },
  'refunds.issue': {
    label: 'Issue refunds',
    description: 'Refund a customer payment.',
    group: 'support',
    agentMaxTier: 'can',
  },
  'report.update': {
    label: 'Update reports',
    description:
      'Write an assessment and a priority on a customer’s report in its tracker. The reporter doesn’t see them.',
    group: 'support',
    agentMaxTier: 'can',
    automationsOnly: true,
  },
  'report.reply': {
    label: 'Reply to customers',
    description:
      'Answer the customer of a report and set its status in its tracker, signed with the agent’s name. The tracker emails it to them.',
    group: 'support',
    agentMaxTier: 'can',
    automationsOnly: true,
  },
  'packs.tool.read': {
    label: 'Retired key (reading tools)',
    description: 'Nothing uses this key any more.',
    group: 'research',
    agentMaxTier: 'can',
    retired: true,
  },
  'packs.tool.write': {
    label: 'Retired key (changing tools)',
    description: 'Nothing uses this key any more.',
    group: 'operations',
    agentMaxTier: 'can',
    retired: true,
  },
  merge: {
    label: 'Merge',
    description: 'Merge pull requests.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'merge.main': {
    label: 'Merge into main',
    description: 'Merge pull requests into the default branch.',
    group: 'code',
    agentMaxTier: 'can',
    parent: 'merge',
  },
  'branch.main.push': {
    label: 'Push to main',
    description: 'Push commits straight to the default branch, without a pull request.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'code.write': {
    label: 'Write code',
    description: 'Change code in connected repositories.',
    group: 'code',
    agentMaxTier: 'can',
  },
  'code.change': {
    label: 'Change code',
    description: 'Change code in connected repositories.',
    group: 'code',
    agentMaxTier: 'can',
    sameAs: 'code.write',
  },
  deploy: {
    label: 'Deploy',
    description: 'Deploy to any environment.',
    group: 'operations',
    agentMaxTier: 'can',
  },
  'commands.destructive': {
    label: 'Destructive commands on other machines',
    description:
      'Delete files, drop databases or stop services on other machines, over SSH or Docker. Commands on your Whombat never need this key.',
    group: 'operations',
    agentMaxTier: 'can',
  },
  'billing.write': {
    label: 'Change billing data',
    description: 'Edit invoices, prices and customer billing records.',
    group: 'support',
    agentMaxTier: 'can',
  },
  'agents.manage': {
    label: 'Change the agent and its keys',
    description: 'Change the agent’s name, face, model and keys. People only.',
    group: 'burrow',
    agentMaxTier: 'never',
  },
  'approvals.decide': {
    label: 'Approve requests',
    description: 'Be the person who says yes or no to the agent’s requests. People only.',
    group: 'burrow',
    agentMaxTier: 'never',
  },
  'burrow.manage': {
    label: 'Change this Whombat’s settings',
    description: 'Rename this Whombat and connect repos. People only.',
    group: 'burrow',
    agentMaxTier: 'never',
  },
  'settings.change': {
    label: 'Change settings for you',
    description:
      'Change Whombat’s settings when you ask, like Wi-Fi, backups and the screen. Removing something always asks first.',
    group: 'burrow',
    agentMaxTier: 'can',
  },
  'share.link': {
    label: 'Share a conversation by link',
    description: 'Make a link anyone can open to read a copy of a thread. Always asks you first.',
    group: 'burrow',
    agentMaxTier: 'ask',
  },
  'mail.read': {
    label: 'Read mail',
    description: 'Search and read the email of the person the agent works for.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'mail.organize': {
    label: 'Label, archive and mark mail',
    description: 'Add and remove labels, archive and mark the person’s email read or unread.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'mail.draft': {
    label: 'Draft emails',
    description: 'Write drafts in the person’s mailbox. Drafts are not sent.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'mail.send': {
    label: 'Send emails',
    description: 'Send email as the person. Always asks the person first.',
    group: 'personal',
    agentMaxTier: 'ask',
  },
  // The person decides (Off · Ask · On on the account's page): trashed mail can be taken back out for 30 days.
  'mail.delete': {
    label: 'Move mail to the trash',
    description: 'Move the person’s email to the trash.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'calendar.read': {
    label: 'Read the calendar',
    description: 'Read the person’s calendar events.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'calendar.write': {
    label: 'Add and change events without guests',
    description: 'Create, move and delete events on the person’s calendar that have no guests.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'calendar.invite': {
    label: 'Send calendar invites',
    description:
      'Create, change or cancel events with guests, which emails them. Always asks the person first.',
    group: 'personal',
    agentMaxTier: 'ask',
  },
  'files.read': {
    label: 'Read files',
    description: 'Search and read the person’s files, documents and spreadsheets.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'files.write': {
    label: 'Create and edit files',
    description: 'Create files and edit the person’s documents and spreadsheets.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'files.share': {
    label: 'Share files',
    description: 'Share the person’s files with other people. Always asks the person first.',
    group: 'personal',
    agentMaxTier: 'ask',
  },
  // As `mail.delete`: the person may let it go ahead without asking; trashed files can be restored.
  'files.delete': {
    label: 'Move files to the trash',
    description: 'Move the person’s files to the trash.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'contacts.read': {
    label: 'Read contacts',
    description: 'Look up people in the person’s contacts.',
    group: 'personal',
    agentMaxTier: 'can',
  },
  'connections.read': {
    label: 'Read connected services',
    description:
      'Read from services connected in Settings → Connections, like Home Assistant, Notion or Todoist. Each tool’s own setting applies too.',
    group: 'connections',
    agentMaxTier: 'can',
  },
  'connections.write': {
    label: 'Change things in connected services',
    description:
      'Add, change or switch things in connected services. Some actions, like unlocking a door or deleting, always ask a person.',
    group: 'connections',
    agentMaxTier: 'can',
  },
};

export const KEY_CATALOG: Readonly<Record<KeyId, KeyDef>> = Object.fromEntries(
  KEY_IDS.map((id) => [id, { id, ...DEFS[id] }]),
) as Record<KeyId, KeyDef>;

/** Catalog entries in display order. */
export const KEY_LIST: readonly KeyDef[] = KEY_IDS.map((id) => KEY_CATALOG[id]);

const ORDER: Record<string, number> = Object.fromEntries(KEY_IDS.map((id, i) => [id, i]));

const KEY_ID_SET: ReadonlySet<string> = new Set(KEY_IDS);

export function isKeyId(value: string): value is KeyId {
  return KEY_ID_SET.has(value);
}

export function getKey(id: KeyId): KeyDef {
  return KEY_CATALOG[id];
}

/** Display order index of a key. */
export function keyOrder(id: KeyId): number {
  return ORDER[id] ?? Number.MAX_SAFE_INTEGER;
}

/** Follows `sameAs` to the key that carries the permission. */
export function canonicalKey(id: KeyId): KeyId {
  let current = id;
  for (let i = 0; i < 8; i++) {
    const next = KEY_CATALOG[current].sameAs;
    if (!next) return current;
    current = next;
  }
  return current;
}

/** The key and its umbrella keys, most specific first (canonical ids). */
export function keyChain(id: KeyId): KeyId[] {
  const chain: KeyId[] = [];
  let current: KeyId | undefined = canonicalKey(id);
  while (current && !chain.includes(current)) {
    chain.push(current);
    const parent: KeyId | undefined = KEY_CATALOG[current].parent;
    current = parent ? canonicalKey(parent) : undefined;
  }
  return chain;
}

const MAX_RANK: Record<MaxTier, number> = { never: 0, ask: 1, can: 2 };

/** The strictest `agentMaxTier` along the key's wording, canonical key and umbrella chain. */
export function agentMaxTier(id: KeyId): MaxTier {
  let result: MaxTier = KEY_CATALOG[id].agentMaxTier;
  for (const k of keyChain(id)) {
    const t = KEY_CATALOG[k].agentMaxTier;
    if (MAX_RANK[t] < MAX_RANK[result]) result = t;
  }
  return result;
}

/** Keys nothing uses any more (`KeyDef.retired`, CT-824): `packs.tool.read`, `packs.tool.write`. */
export const RETIRED_KEYS: readonly KeyId[] = KEY_IDS.filter((id) => !!KEY_CATALOG[id].retired);

/** Whether nothing uses a key any more (CT-824): views and prompts leave it out. */
export function isRetiredKey(id: KeyId): boolean {
  return !!KEY_CATALOG[id].retired;
}

/** Keys only automations hold (`KeyDef.automationsOnly`): `report.update` (0.69, CT-325), `report.reply` (0.75, CT-331). */
export const AUTOMATION_ONLY_KEYS: readonly KeyId[] = KEY_IDS.filter((id) => KEY_CATALOG[id].automationsOnly);

/** Keys an agent can never hold at `can` or `ask`. */
export const PEOPLE_ONLY_KEYS: readonly KeyId[] = KEY_IDS.filter((id) => agentMaxTier(id) === 'never');
/** Keys an agent can hold at most at `ask`. */
export const ALWAYS_ASKS_KEYS: readonly KeyId[] = KEY_IDS.filter((id) => agentMaxTier(id) === 'ask');

/**
 * Note shown on locked rows (Settings → Agent → Keys): "people only" / "always asks a person". Since 0.34 (CT-211) no
 * risk row is capped: Merge and Deploy are three-state rows (`KeyOption.defaultTier`).
 */
export function lockedNote(id: KeyId): string | null {
  const max = agentMaxTier(id);
  if (max === 'never') return 'people only';
  if (max === 'ask') return 'always asks a person';
  return null;
}

/* Bundles (`implies`): a key that brings others in, e.g. “Use a web browser” brings “Browse the web” --------- */

/** The keys a key brings in through its bundle (`implies`), as canonical ids. */
export function keysImpliedBy(id: KeyId): KeyId[] {
  return (KEY_CATALOG[canonicalKey(id)]?.implies ?? []).map(canonicalKey);
}

/** Which of `onKeys` brings `keyId` in through a bundle, or null (so a row can read “included with …”). */
export function impliedBy(keyId: KeyId, onKeys: readonly KeyId[]): KeyId | null {
  const target = canonicalKey(keyId);
  for (const on of onKeys) {
    if (canonicalKey(on) === target) continue;
    if (keysImpliedBy(on).includes(target)) return on;
  }
  return null;
}

/** The short name of a bundle key for its “included with …” notes (“the browser”), else its lowercased label. */
const BUNDLE_SHORT: Partial<Record<KeyId, string>> = { 'browser.use': 'the browser' };
function bundleShort(id: KeyId): string {
  return BUNDLE_SHORT[canonicalKey(id)] ?? keyLabel(canonicalKey(id)).toLowerCase();
}

/** A locked Keys row that a bundle brings in: “included with the browser”. */
export function includedNote(bundleKey: KeyId): string {
  return `included with ${bundleShort(bundleKey)}`;
}

/** A profile row that a bundle brings in: “with the browser” (shown after the implied key's label). */
export function impliedWithNote(bundleKey: KeyId): string {
  return `with ${bundleShort(bundleKey)}`;
}

/** "#a", "#a and #b", "#a, #b and #c". */
export function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Label of a key as shown on screen. */
export function keyLabel(id: KeyId): string {
  return KEY_CATALOG[id].label;
}
