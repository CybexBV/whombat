/**
 * Whombat's settings for its assistant (Whombat docs/decisions/assistant-settings.md). Spread into `MCP_TOOLS` (`./mcp`);
 * `personal: true`: only in a turn for the person, acting for them. Every setting is one operation of the session
 * allowlist, run as the person through the same handler as their tap in the app; what the assistant may do with each
 * is the runtime's settings map (`@whombat/protocol` `ASSISTANT_SETTINGS`).
 *
 * - `settings_find`: where a setting is, what the assistant may do with it, and the input its operation takes.
 * - `settings_read`: reads one (a read operation).
 * - `settings_change`: changes one. The `settings.change` key decides (Go ahead · Ask me first · Just watch); a
 *   destructive change, and one that could cut the person off, always asks on a card.
 * - `settings_open`: a card in the thread whose button opens the page, for what the person does themselves.
 */
import { z } from 'zod';
import type { McpTool } from './mcp.js';

/** An operation's name (`host.cable.set`, `backups.create`). */
const OpName = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/)
  .describe('The setting’s op, as settings_find names it');

/** An op's input, as `settings_find` describes it; `params.burrow` is filled in for you. */
const OpInput = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'The op’s input, as settings_find’s `input` schema says. Leave out params.burrow: Whombat fills it in. Leave out for an op that takes none.',
  );

export const SETTINGS_ACCESS = ['never', 'read', 'change', 'ask'] as const;
export const SettingsAccess = z.enum(SETTINGS_ACCESS);

export const SETTINGS_FAILURES = [
  /** Not in a turn for the person. */
  'not_here',
  /** No such setting. */
  'unknown',
  /** It stays the person's: send them there (`settings_open`). */
  'never',
  /** A read, not a change (or the other way round). */
  'wrong_tool',
  /** The input doesn't fit the op (`message` says what). */
  'invalid',
  /** The op refused, in its own words (`message`). */
  'refused',
  /** This Whombat can't do it now (an update, no manager on a development box). */
  'unavailable',
] as const;
export const SettingsFailure = z.enum(SETTINGS_FAILURES);

const Failed = z.object({ status: z.literal('failed'), reason: SettingsFailure, message: z.string() });

export type SettingsFindInput = z.infer<typeof SettingsFindInput>;
export const SettingsFindInput = z.object({
  query: z
    .string()
    .trim()
    .max(120)
    .default('')
    .describe(
      'A few words of what the person wants (“wifi”, “backups”, “notifications”) or an op name. Empty: the pages and what is on each.',
    ),
});

export const SettingsEntry = z.object({
  op: z.string(),
  /** What it does (“Use Wi-Fi only or the cable again”). */
  words: z.string(),
  /** “Settings → This Whombat → Overview”. */
  where: z.string(),
  page: z.string(),
  access: SettingsAccess,
  /** JSON Schema of the op's input (`read`, `change`, `ask`); absent for `never`. */
  input: z.record(z.string(), z.unknown()).optional(),
});

export type SettingsFindOutput = z.infer<typeof SettingsFindOutput>;
export const SettingsFindOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    settings: z.array(SettingsEntry),
    /** Matches left out; ask more precisely to see them. */
    more: z.number().int().min(0),
    /** With an empty query: every page, where it is and what is on it. */
    pages: z.array(z.object({ page: z.string(), where: z.string(), about: z.string() })).optional(),
  }),
  Failed,
]);

export type SettingsReadInput = z.infer<typeof SettingsReadInput>;
export const SettingsReadInput = z.object({ op: OpName, input: OpInput });
export type SettingsReadOutput = z.infer<typeof SettingsReadOutput>;
export const SettingsReadOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    op: z.string(),
    /** The op's answer (JSON), cut short when long. */
    value: z.unknown(),
    truncated: z.boolean(),
  }),
  Failed,
]);

export type SettingsChangeInput = z.infer<typeof SettingsChangeInput>;
export const SettingsChangeInput = z.object({
  op: OpName,
  input: OpInput,
});
export type SettingsChangeOutput = z.infer<typeof SettingsChangeOutput>;
export const SettingsChangeOutput = z.discriminatedUnion('status', [
  /** Changed, as the person; `value` is the op's answer. */
  z.object({ status: z.literal('done'), op: z.string(), value: z.unknown(), truncated: z.boolean() }),
  /** A card asks the person first; you are woken with the result once they answer. Stop and wait. */
  z.object({ status: z.literal('pending_approval'), approvalId: z.string(), message: z.string() }),
  /** The person set changing settings to Just watch: tell them where it is (`settings_open`). */
  z.object({ status: z.literal('blocked'), message: z.string(), where: z.string() }),
  Failed,
]);

export type SettingsOpenInput = z.infer<typeof SettingsOpenInput>;
export const SettingsOpenInput = z.object({
  page: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .describe('The page id, as settings_find names it (`appliance.backups`)'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('One or two plain sentences on the card: what to do there (“Type the Wi-Fi password here.”)'),
});
export type SettingsOpenOutput = z.infer<typeof SettingsOpenOutput>;
export const SettingsOpenOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), messageId: z.string() }),
  Failed,
]);

export const SETTINGS_MCP_TOOLS = {
  settings_find: {
    name: 'settings_find',
    title: 'Find a setting',
    description:
      'Where one of Whombat’s settings is and what you may do with it: read, change, ask (always a card first) or never (the person’s own: say where it is). Gives each setting’s op and the input it takes. Use it before settings_read and settings_change; the whombat:settings skill has the map and the step-by-step ways.',
    input: SettingsFindInput,
    output: SettingsFindOutput,
    requiredKey: null,
    readOnly: true,
    personal: true,
  },
  settings_read: {
    name: 'settings_read',
    title: 'Read a setting',
    description:
      'Read one of Whombat’s settings or the state behind it (how the box connects, whether it is backed up, how it notifies), as the person sees it in Settings.',
    input: SettingsReadInput,
    output: SettingsReadOutput,
    requiredKey: null,
    readOnly: true,
    personal: true,
  },
  settings_change: {
    name: 'settings_change',
    title: 'Change a setting',
    description:
      'Change one of Whombat’s settings for the person, only when they asked for it, exactly as their tap in Settings would. Whether you go ahead or a card asks them first is their choice (What you may do); changes that remove something or could cut them off always ask. pending_approval: stop, you are woken with the result. Then tell them in one plain sentence what changed.',
    input: SettingsChangeInput,
    output: SettingsChangeOutput,
    // The command it runs needs `settings.change` (the server decides with it, as for every personal tool).
    requiredKey: null,
    readOnly: false,
    personal: true,
  },
  settings_open: {
    name: 'settings_open',
    title: 'Open a settings page',
    description:
      'Post a card in this thread with a button that opens a settings page, for what the person does there themselves: a password or code, a setting that stays theirs (never), or when they asked where it is.',
    input: SettingsOpenInput,
    output: SettingsOpenOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  },
} satisfies Record<string, McpTool>;
