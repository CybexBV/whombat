/**
 * Guided setup in a person's Chat (docs/decisions/assistant-guides.md AG-01…AG-18, contracts CT-80). A guide is a
 * scripted server state machine; each step is a `guide` card the agent posts there.
 * Guide cards are server-made only: they are in `MessageCard` and `StoredCard`, never in `PostableCard`.
 *
 * Everything is plain text (never Markdown, never mentions) and bounded like the other cards. Form values never
 * appear here: they travel only in `guides.act` (`GuideActBody`), and the locked card shows a summary in
 * `answer.label` (“Client ID 1234567890ab… saved”).
 */
import { z } from 'zod';
import { ConnectionId, VaultEntryId, VaultSshServerId } from '../ids.js';
import { Timestamp, Tone } from './common.js';
import { CONNECTION_LABEL_MAX, ConnectionAccessLevel, TokenAuth } from './connections-catalog/shared.js';
import { UptimeFields } from './connections-catalog/uptime.js';
import { ConnectorProvider, ConnectorService, ReturnPath } from './connectors.js';

/* ---------------------------------------------------------------------------------------------- */
/* Topics                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The guides this release knows (AG “Topics”). `skills` (0.20, skills-library.md SL-03, AG-35…) offered the owner a
 * group of skills for their assistant; since 0.113 (CT-816; Whombat skill-store.md SST-09) every agent has every shipped
 * skill, so it is neither started nor suggested any more and stays only so its old cards still render.
 * `add_server` (0.85, CT-378; server-signin.md SI-10): the one card the Servers tool `server_add` posts, whose action
 * opens Add a server filled in; posted by the server, never started with `start_guide`. `add_connection` (Whombat
 * connect-in-chat.md): the card `connection_add` posts, whose button opens the connect form filled in. `secret` (the
 * same): the card `vault_ask` posts, a write-only form whose value goes straight to the Vault (`vaultAsk`).
 */
export const GUIDE_TOPICS = [
  'welcome',
  'email',
  'calendar',
  'files',
  'google_app',
  'repair',
  'skills',
  'add_server',
  'add_connection',
  'secret',
  'settings',
] as const;
export const KnownGuideTopic = z.enum(GUIDE_TOPICS);
export type KnownGuideTopic = z.infer<typeof KnownGuideTopic>;

/**
 * A guide's topic id. An open set (CT-80): a newer server may run guides this release doesn't know, and clients
 * render their cards generically from the blocks. `isKnownGuideTopic` narrows.
 */
export const GuideTopic = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/);
export type GuideTopic = z.infer<typeof GuideTopic>;

export function isKnownGuideTopic(topic: string): topic is KnownGuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(topic);
}

/** The topics the agent may start with `start_guide` (AG-01, AG-18). `repair` is started by the server. */
export const STARTABLE_GUIDE_TOPICS = [
  'welcome',
  'email',
  'calendar',
  'files',
  'google_app',
] as const satisfies readonly KnownGuideTopic[];
export const StartableGuideTopic = z.enum(STARTABLE_GUIDE_TOPICS);
export type StartableGuideTopic = z.infer<typeof StartableGuideTopic>;

/** The topics occasional suggestions offer, in order (AG-11); `dontAsk` names these. */
export const SUGGESTED_GUIDE_TOPICS = [
  'email',
  'calendar',
  'files',
] as const satisfies readonly KnownGuideTopic[];

/** The services a connect topic asks for first (AG “Topics”); the rest stay preticked (CN-04). */
export const GUIDE_TOPIC_SERVICES: Readonly<Partial<Record<KnownGuideTopic, readonly ConnectorService[]>>> = {
  email: ['mail'],
  calendar: ['calendar'],
  files: ['files', 'docs', 'sheets'],
};

/** The card's label row (AG-17), before the step: `SET UP · EMAIL`. Unknown topics show `GUIDE`. */
export const GUIDE_TOPIC_LABELS: Record<KnownGuideTopic, string> = {
  welcome: 'Set up',
  email: 'Set up · Email',
  calendar: 'Set up · Calendar',
  files: 'Set up · Files',
  google_app: 'Set up · Google',
  repair: 'Reconnect',
  skills: 'Skills',
  add_server: 'Servers',
  add_connection: 'Connections',
  secret: 'Vault',
  settings: 'Settings',
};

/* ---------------------------------------------------------------------------------------------- */
/* Icons and badges                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/** Fixed-colour brand marks in `@whombat/brand` (AG-16). `mail` is the generic “Other email” mark. */
export const GUIDE_BRANDS = ['google', 'microsoft', 'mail', 'claude', 'openai', 'github'] as const;
export const GuideBrand = z.enum(GUIDE_BRANDS);
export type GuideBrand = z.infer<typeof GuideBrand>;

/** The Lucide icons a guide may use (names as in lucide 0.4xx+), drawn in the text colour. */
export const GUIDE_ICONS = [
  'mail',
  'calendar',
  'folder',
  'file-text',
  'sun',
  'clock',
  'sparkles',
  'key',
  'link',
  'shield-check',
  'circle-help',
  'user-plus',
  'bell',
  'settings',
] as const;
export const GuideIconName = z.enum(GUIDE_ICONS);
export type GuideIconName = z.infer<typeof GuideIconName>;

export const GuideIcon = z.union([
  z.strictObject({ brand: GuideBrand }),
  z.strictObject({ icon: GuideIconName }),
]);
export type GuideIcon = z.infer<typeof GuideIcon>;

/** An icon slot: an icon this release doesn't know reads as none (CT-80), so a newer server never breaks a card. */
const IconSlot = GuideIcon.nullable().default(null).catch(null);

export const GuideBadge = z.object({
  /** “Coming soon”, “Recommended”. */
  label: z.string().trim().min(1).max(24),
  tone: Tone.default('neutral'),
});
export type GuideBadge = z.infer<typeof GuideBadge>;

/* ---------------------------------------------------------------------------------------------- */
/* Blocks                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** Id of an action, option or form field inside a card; also the keys of `GuideActBody.values`. */
export const GuideElementId = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
export type GuideElementId = z.infer<typeof GuideElementId>;

/** Step id inside a guide (`intro`, `provider`, `step_3`); the server's, clients only pass it through. */
export const GuideNodeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);

/** An https link out of Whombat (Google's console, help pages). Opens in a new tab. */
export const GuideUrl = z.url({ protocol: /^https$/ }).max(2048);

/** Where a link or button goes: a path on this Whombat (a settings tab) or an https page elsewhere. */
export const GuideHref = z.union([ReturnPath, GuideUrl]);
export type GuideHref = z.infer<typeof GuideHref>;

export const GUIDE_TEXT_MAX = {
  title: 120,
  body: 1200,
  label: 40,
  optionTitle: 80,
  optionDescription: 200,
  copyValue: 2048,
  statusDetail: 200,
  answer: 200,
} as const;

export const GuideOption = z.object({
  id: GuideElementId,
  title: z.string().trim().min(1).max(GUIDE_TEXT_MAX.optionTitle),
  description: z.string().trim().max(GUIDE_TEXT_MAX.optionDescription).default(''),
  icon: IconSlot,
  badge: GuideBadge.nullable().default(null),
  /** Shown at 55% with its badge; can't be chosen. */
  disabled: z.boolean().default(false),
});
export type GuideOption = z.infer<typeof GuideOption>;

/**
 * Options as tiles. `single`: tapping one acts at once (`actionId` = the block's `id`, `optionIds` = [option]).
 * `multi`: ticks, then `submitLabel` acts with the ticked options.
 */
export const GuideChoicesBlock = z.object({
  type: z.literal('choices'),
  id: GuideElementId,
  mode: z.enum(['single', 'multi']).default('single'),
  options: z.array(GuideOption).min(1).max(8),
  submitLabel: z.string().trim().min(1).max(GUIDE_TEXT_MAX.label).nullable().default(null),
});

export const GuideActionStyle = z.enum(['primary', 'secondary', 'quiet']);
export type GuideActionStyle = z.infer<typeof GuideActionStyle>;

/** A button. With `href` it is a link (the client navigates; nothing is sent to `guides.act`). */
export const GuideAction = z.object({
  id: GuideElementId,
  label: z.string().trim().min(1).max(GUIDE_TEXT_MAX.label),
  style: GuideActionStyle.default('secondary'),
  href: GuideHref.nullable().default(null),
});
export type GuideAction = z.infer<typeof GuideAction>;

export const GuideActionsBlock = z.object({
  type: z.literal('actions'),
  actions: z.array(GuideAction).min(1).max(4),
});

/** Label and value rows with a copy button (the redirect URI, the app name). */
export const GuideCopyBlock = z.object({
  type: z.literal('copy'),
  rows: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        value: z.string().min(1).max(GUIDE_TEXT_MAX.copyValue),
      }),
    )
    .min(1)
    .max(8),
});

/** External links (open in a new tab). */
export const GuideLinksBlock = z.object({
  type: z.literal('links'),
  links: z
    .array(z.object({ label: z.string().trim().min(1).max(80), url: GuideUrl }))
    .min(1)
    .max(8),
});

/**
 * `secret` is a password field; `json_file` takes a dropped or picked JSON file's text (`GUIDE_VALUE_MAX`); `key_file`
 * (3.14) takes a private key pasted or picked as a file, its text kept as it is (line breaks too) and never
 * shown again once in. An app that doesn't know a kind leaves that field out (CT-80).
 */
export const GuideFieldKind = z.enum(['text', 'secret', 'json_file', 'key_file']);
export type GuideFieldKind = z.infer<typeof GuideFieldKind>;

export const GuideField = z.object({
  id: GuideElementId,
  label: z.string().trim().min(1).max(60),
  kind: GuideFieldKind,
  placeholder: z.string().trim().max(120).nullable().default(null),
  optional: z.boolean().default(false),
});
export type GuideField = z.infer<typeof GuideField>;

/** A secure form: its values go only to `guides.act` (`actionId` = the block's `id`), never into a message. */
export const GuideFormBlock = z.object({
  type: z.literal('form'),
  id: GuideElementId,
  fields: z.array(GuideField).min(1).max(6),
  submitLabel: z.string().trim().min(1).max(GUIDE_TEXT_MAX.label),
});

/**
 * “Connect Google”: the services preticked (the topic's first), and `returnTo`, the DM path with the guide marker
 * that `connections.startGoogle` gets so the result lands in the DM (AG-08). On mobile it opens the DM on the web.
 */
export const GuideConnectBlock = z.object({
  type: z.literal('connect'),
  provider: ConnectorProvider,
  services: z.array(ConnectorService).min(1).max(6),
  reconnect: z.boolean().default(false),
  returnTo: ReturnPath,
});

export const GuideStatusState = z.enum(['ok', 'warn', 'bad', 'mut']);
export type GuideStatusState = z.infer<typeof GuideStatusState>;

/** Result rows: one per service after connecting (CN-06), troubleshooting. `href`: “Turn it on”. */
export const GuideStatusBlock = z.object({
  type: z.literal('status'),
  rows: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        state: GuideStatusState,
        detail: z.string().trim().max(GUIDE_TEXT_MAX.statusDetail).nullable().default(null),
        href: GuideHref.nullable().default(null),
      }),
    )
    .min(1)
    .max(8),
});

export const GUIDE_BLOCK_TYPES = [
  'choices',
  'actions',
  'copy',
  'links',
  'form',
  'connect',
  'status',
] as const;

export const GuideBlock = z.discriminatedUnion('type', [
  GuideChoicesBlock,
  GuideActionsBlock,
  GuideCopyBlock,
  GuideLinksBlock,
  GuideFormBlock,
  GuideConnectBlock,
  GuideStatusBlock,
]);
export type GuideBlock = z.infer<typeof GuideBlock>;
export type GuideChoicesBlock = z.infer<typeof GuideChoicesBlock>;
export type GuideActionsBlock = z.infer<typeof GuideActionsBlock>;
export type GuideCopyBlock = z.infer<typeof GuideCopyBlock>;
export type GuideLinksBlock = z.infer<typeof GuideLinksBlock>;
export type GuideFormBlock = z.infer<typeof GuideFormBlock>;
export type GuideConnectBlock = z.infer<typeof GuideConnectBlock>;
export type GuideStatusBlock = z.infer<typeof GuideStatusBlock>;

/** Most blocks on one card. */
export const GUIDE_BLOCKS_MAX = 6;

/**
 * A card's blocks. A block `type` this release doesn't know is dropped on read (CT-80), so a newer server's card
 * still renders; a known type must be valid.
 */
const GuideBlocks = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter(
          (b) =>
            typeof b !== 'object' ||
            b === null ||
            (GUIDE_BLOCK_TYPES as readonly unknown[]).includes((b as { type?: unknown }).type),
        )
      : value,
  z.array(GuideBlock).max(GUIDE_BLOCKS_MAX),
);

/* ---------------------------------------------------------------------------------------------- */
/* The card                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** `open` takes an action; `done` (answered) and `expired` (AG-11: after 7 days) are locked. */
export const GuideState = z.enum(['open', 'done', 'expired']);
export type GuideState = z.infer<typeof GuideState>;

/**
 * How a `secret` card ended (3.14; Whombat vault-simplify.md), for the locked card and the agent:
 * - `saved`: a `login`, `token` or `basic` card's secret is in the Vault (a new entry, or the one it replaced);
 * - `signed_in`: a `server` card found the assistant's key already opens the server (no password used);
 * - `key_added`: the password, used once, put the assistant's key on the server; it signed in with the key and forgot
 *   the password (“Use the password once…”);
 * - `password_saved`: the password signs in and is kept sealed with that server (“Keep the password”);
 * - `key_imported`: the person's own private key signs in and is saved as a Server key entry (“Use my own private key”);
 * - `code_given`: a `code` card's code went to the sign-in under way, once, and was not kept;
 * - `refused`: three tries didn't sign in (`vaultRefusal` says why the last one failed);
 * - `declined`: the person chose Not now;
 * - `too_late`: a `code` came after the sign-in had stopped waiting for it, so it wasn't used.
 */
export const GUIDE_VAULT_OUTCOMES = [
  'saved',
  'signed_in',
  'key_added',
  'password_saved',
  'key_imported',
  'code_given',
  'refused',
  'declined',
  'too_late',
] as const;
export const GuideVaultOutcome = z.enum(GUIDE_VAULT_OUTCOMES);
export type GuideVaultOutcome = z.infer<typeof GuideVaultOutcome>;

/**
 * Why a `server` card's try didn't sign in (3.14), shown on its field in plain words
 * (`vaultAskErrorText`) while the card stays open, and the last one kept with `refused`:
 * - `password_wrong`: the server turned the password down;
 * - `password_login_off`: the server doesn't take passwords at all;
 * - `key_refused`: the server turned the key down (the person's own, or the assistant's after the password put it on);
 * - `passphrase_wrong`: the passphrase didn't open the pasted key;
 * - `key_invalid`: what was pasted isn't a private key Whombat can use (`VAULT_SSH_KEY_PROBLEM_TEXT` has the detail);
 * - `host_key_changed`: another server answers at that address than the one pinned there: nothing was sent;
 * - `unreachable`: nothing answered in time;
 * - `not_allowed`: the address isn't one the Vault may reach.
 */
export const GUIDE_VAULT_REFUSALS = [
  'password_wrong',
  'password_login_off',
  'key_refused',
  'passphrase_wrong',
  'key_invalid',
  'host_key_changed',
  'unreachable',
  'not_allowed',
] as const;
export const GuideVaultRefusal = z.enum(GUIDE_VAULT_REFUSALS);
export type GuideVaultRefusal = z.infer<typeof GuideVaultRefusal>;

/** What the person did, shown as a quiet row on the locked card (“You chose Google”). */
export const GuideAnswer = z.object({
  actionId: GuideElementId,
  optionIds: z.array(GuideElementId).max(8).nullable().default(null),
  /** Plain words, never a secret: “Google”, “Client ID 1234567890ab… saved”. */
  label: z.string().trim().min(1).max(GUIDE_TEXT_MAX.answer),
  at: Timestamp,
  /**
   * A `secret` card's form saved: the Vault entry it went to, so the agent can use it (never the value). A `server`
   * card's: the SSH key entry the server is on (the person's own key once imported).
   */
  vaultEntryId: VaultEntryId.optional(),
  /** A `secret` card's ending (3.14). Absent on older cards: `vaultEntryId` alone meant saved. */
  vaultOutcome: GuideVaultOutcome.optional(),
  /** With `refused`: why the last try failed. */
  vaultRefusal: GuideVaultRefusal.optional(),
  /** A `server` card that signed in: the server's name, as the assistant's commands reach it (`ssh prod-1`). */
  vaultServer: z.string().min(1).max(40).optional(),
  /** An `add_connection` card that connected on the card (`connectAsk`): the new connection, for the agent to use. */
  connectionId: ConnectionId.optional(),
});
export type GuideAnswer = z.infer<typeof GuideAnswer>;

export const GuideStep = z
  .object({ index: z.number().int().min(1).max(20), total: z.number().int().min(1).max(20) })
  .refine((s) => s.index <= s.total, 'The step is past the last one.');
export type GuideStep = z.infer<typeof GuideStep>;

/**
 * What a `vault_ask` card asks for (Whombat connect-in-chat.md, vault-simplify.md): the kinds `vault_save` takes
 * (`login` a website, `token` an API token, `basic` an API's username and password), and since 3.14 `server`
 * (signing in to an SSH server: a new one, or one that refused the assistant's key) and `code` (a one-time code
 * a site or server sent the person, used once and never kept).
 */
export const GUIDE_VAULT_KINDS = ['login', 'token', 'basic', 'server', 'code'] as const;
export const GuideVaultKind = z.enum(GUIDE_VAULT_KINDS);
export type GuideVaultKind = z.infer<typeof GuideVaultKind>;

/** Why a `server` card asks (3.14): a server the assistant hasn't signed in to yet, or one that refused its key. */
export const GUIDE_VAULT_SERVER_REASONS = ['new', 'key_refused'] as const;
export const GuideVaultServerReason = z.enum(GUIDE_VAULT_SERVER_REASONS);
export type GuideVaultServerReason = z.infer<typeof GuideVaultServerReason>;

/**
 * The three ways a `server` card signs in (3.14), the first chosen: `key_once` the password is used
 * once to put the assistant's key on the server and forgotten; `keep_password` the password is checked and kept sealed
 * with that server, for servers that don't take keys; `own_key` the person's own private key (pasted or picked as a
 * file, its passphrase used once) is imported as a Server key entry covering the server. The app sends the chosen one as
 * the form value `way` (`VAULT_ASK_FIELDS.way`); absent is `key_once`.
 */
export const GUIDE_VAULT_SERVER_WAYS = ['key_once', 'keep_password', 'own_key'] as const;
export const GuideVaultServerWay = z.enum(GUIDE_VAULT_SERVER_WAYS);
export type GuideVaultServerWay = z.infer<typeof GuideVaultServerWay>;

/** Tries a `server` card gives before it closes as `refused`. */
export const GUIDE_VAULT_SERVER_TRIES = 3;

/**
 * A `server` card's server (3.14): where it is, why the card asks, the server already in the Vault when it is
 * one of the key's (`serverId`; null: the card adds it, with first-contact host-key trust), and the tries had.
 * The user is `GuideVaultAsk.username`, the name the card shows `GuideVaultAsk.name`.
 */
export const GuideVaultServer = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  reason: GuideVaultServerReason.default('new'),
  serverId: VaultSshServerId.nullable().default(null),
  tries: z.number().int().min(0).max(GUIDE_VAULT_SERVER_TRIES).default(0),
});
export type GuideVaultServer = z.infer<typeof GuideVaultServer>;

/**
 * Where a `secret` card's value goes (Whombat connect-in-chat.md): a new Vault entry (`name`, `url`, the `username` when
 * known) or the person's `entryId` that gets a new secret. Written by the server when it posts the card and read back
 * from the stored card when the form is sent, so nothing a client sends can point it elsewhere. Never holds the secret.
 *
 * Since 3.14: a `server` card has `server` (where, why, tries), `username` the user it signs in as, `name` the
 * server's name or its host as the card says it, `url` null, and `entryId` the SSH key the server goes with (null: the
 * person's only key, else a new “Servers” key, as `vault_add_server` picks). A `code` card has `name` the site that sent
 * the code (github.com), `hint` where the code came from in the agent's words, and no `url`, `username` or `entryId`.
 */
export const GuideVaultAsk = z.object({
  kind: GuideVaultKind,
  name: z.string().trim().min(1).max(80),
  url: z.string().max(2048).nullable().default(null),
  username: z.string().max(200).nullable().default(null),
  /** What the agent needs it for, kept as the new entry's description. */
  description: z.string().max(500).default(''),
  entryId: VaultEntryId.nullable().default(null),
  /** A `server` card's server (3.14); absent on every other kind. */
  server: GuideVaultServer.optional(),
  /** A `code` card's line on where the code came from (“It came by text to your phone.”); absent on other kinds. */
  hint: z.string().trim().max(200).optional(),
});
export type GuideVaultAsk = z.infer<typeof GuideVaultAsk>;

/**
 * Where an `add_connection` card that connects on the card goes (Whombat connect-by-talking.md): an MCP server or API
 * the assistant set up by talking — the entry (`custom_mcp`, `custom_api`), its name, address, how it signs in (`none`,
 * or `token` with the entry's `method` and the shape the assistant chose, `auth`), a basic sign-in's username, the
 * notes kept as the connection's guide, and the level. Written by the server when it posts the card and read back from
 * the stored card when the person answers, so nothing a client sends can point it elsewhere. Never holds the secret.
 */
export const GuideConnectAsk = z.object({
  catalogId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  label: z.string().trim().min(1).max(CONNECTION_LABEL_MAX),
  url: z.string().min(1).max(2048),
  signIn: z.enum(['none', 'token']),
  method: z.number().int().min(0).max(3).default(0),
  auth: TokenAuth.optional(),
  username: z.string().max(200).nullable().default(null),
  notes: z.string().max(1500).default(''),
  /** A Website or address card keeps the settings the person is asked to approve. */
  uptime: UptimeFields.optional(),
  access: ConnectionAccessLevel,
});
export type GuideConnectAsk = z.infer<typeof GuideConnectAsk>;

/** One step of a guide, posted by the agent in the person's Chat (AG-02). Stored as it is. */
export const GuideCard = z.object({
  kind: z.literal('guide'),
  guide: GuideTopic,
  node: GuideNodeId,
  /** “Step 2 of 6” in the label row. */
  step: GuideStep.nullable().default(null),
  title: z.string().trim().min(1).max(GUIDE_TEXT_MAX.title),
  /** Plain text; short paragraphs separated by a blank line. */
  body: z.string().trim().max(GUIDE_TEXT_MAX.body).default(''),
  blocks: GuideBlocks,
  state: GuideState,
  answer: GuideAnswer.nullable().default(null),
  /** A `secret` card's destination (connect-in-chat.md); absent on every other card. */
  vaultAsk: GuideVaultAsk.optional(),
  /** An `add_connection` card that connects on the card (connect-by-talking.md); absent on the form-link cards. */
  connectAsk: GuideConnectAsk.optional(),
  /**
   * A standing card states something already done (a setting as set) and keeps its buttons as controls for later:
   * it is `open`, so they still work, but it waits for nobody, so its thread can be settled and it never expires.
   * Absent means false.
   */
  standing: z.boolean().optional(),
});
export type GuideCard = z.infer<typeof GuideCard>;

/** The label row: `SET UP · EMAIL · STEP 2 OF 6`; `GUIDE` for a topic this release doesn't know. */
export function guideCardLabel(card: Pick<GuideCard, 'guide' | 'step'>): string {
  const topic = isKnownGuideTopic(card.guide) ? GUIDE_TOPIC_LABELS[card.guide] : 'Guide';
  const step = card.step ? ` · Step ${card.step.index} of ${card.step.total}` : '';
  return `${topic}${step}`.toUpperCase();
}

/**
 * How the runner shows a guide card in history (AG-18): `[guide: Connect your email; you chose Google]`; a `secret`
 * card's saved form names the Vault entry it went to (`; Vault entry vlt_…`), never the value, and since 3.14 how it
 * ended (`; outcome key_added; server prod-1`, `; outcome refused (password_wrong)`); a connect card that connected
 * names the connection (`; connection con_…`).
 */
export function guideCardText(card: Pick<GuideCard, 'title' | 'answer'>): string {
  if (!card.answer) return `[guide: ${card.title}]`;
  const { vaultEntryId, vaultOutcome, vaultRefusal, vaultServer, connectionId } = card.answer;
  const entry = vaultEntryId ? `; Vault entry ${vaultEntryId}` : '';
  const outcome = vaultOutcome ? `; outcome ${vaultOutcome}${vaultRefusal ? ` (${vaultRefusal})` : ''}` : '';
  const server = vaultServer ? `; server ${vaultServer}` : '';
  const connection = connectionId ? `; connection ${connectionId}` : '';
  return `[guide: ${card.title}; you chose ${card.answer.label}${entry}${outcome}${server}${connection}]`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Preferences (AG-12)                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** Most topics in `dontAsk`. */
export const DONT_ASK_MAX = 16;

/** `Preferences.assistant`: occasional suggestions on or off, and the topics never to suggest again. */
export const AssistantPreferences = z.object({
  suggestions: z.boolean().default(true),
  dontAsk: z.array(GuideTopic).max(DONT_ASK_MAX).default([]),
});
export type AssistantPreferences = z.infer<typeof AssistantPreferences>;

export const DEFAULT_ASSISTANT_PREFERENCES: AssistantPreferences = { suggestions: true, dontAsk: [] };
