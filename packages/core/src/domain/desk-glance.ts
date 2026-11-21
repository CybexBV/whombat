/**
 * The calm glance and what the person chooses it shows (3.2, CT-1620…CT-1634; Whombat docs/decisions/desk-display.md
 * DK-101…DK-125). One frame whose content changes: a top bar about the box itself, the clock with one sentence that
 * says how things are, the middle for what matters now (a question or a problem first, else up to three things going
 * on), and every server in a strip along the bottom.
 *
 * The person chooses in Settings → Screen what may show, with one choice for everything (`DeskShowLevel`): *Always*,
 * *When it matters* or *Off*. The runtime keeps the choices with the screen's settings (`DeskSettings.show`), decides
 * what shows (`DeskCalm`, the desk socket's `DeskGlance.calm`) and draws the same for Settings' preview
 * (`desk.preview`, `DeskPreview`). The shapes are here, not in the desk socket's contract, because the session's
 * preview carries them too.
 */
import { z } from 'zod';
import { displayLine as line } from './display-text.js';
import { LOOK_FIX_LABEL_MAX, LookResearchState } from './look-research.js';

/* Display text --------------------------------------------------------------------------------------------------- */

/** A brand or OS mark the screen draws (`@whombat/brand` slugs, `hostOsMark`: `proxmox`, `plex`, `linux`, …). */
const Mark = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

/**
 * A server's hosts id, as `DESK_SERVER_ID_RE` of `desk.ts` (which imports this file for the settings, so the pattern is
 * repeated here; a test keeps them equal).
 */
export const DESK_STRIP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DeskServerId = z.string().regex(DESK_STRIP_ID_RE);

/** A moment in RFC 3339 (`2026-10-27T14:30:00Z`), as the desk socket's `Rfc3339`: a pattern every language checks. */
const Timestamp = z
  .string()
  .max(40)
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/);

const Count = z.number().int().min(0).max(1_000_000);
const Pct = z.number().int().min(0).max(100);
/** An ask's number in its burrow, or the screen's own number for a question (the desk socket's `AskNumber`). */
const AskNumber = z.number().int().min(1).max(1_000_000_000);
/** A look's key, as `DeskLook.key` (`server:pve-02`, `connection:con_…`). */
const LookKey = line(120);

/* What the person chooses (DK-102…DK-108) ------------------------------------------------------------------------ */

/**
 * One choice for everything the screen can show (DK-103): `always` there all the time (pinned), `matters` only while
 * something is going on with it or wrong with it, `off` never on the screen. *Off* means off on the screen only: its
 * problems still reach the phone and Home (DK-104).
 */
export const DESK_SHOW_LEVELS = ['always', 'matters', 'off'] as const;
export const DeskShowLevel = z.enum(DESK_SHOW_LEVELS);
export type DeskShowLevel = z.infer<typeof DeskShowLevel>;

/**
 * The top bar's items the person chooses for (DK-110). Remote help and the camera aren't among them: they always show
 * while they're on, so you always know (DK-111). The lock always shows.
 */
export const DESK_BAR_ITEMS = ['network', 'internet', 'battery', 'updates'] as const;
export const DeskBarItem = z.enum(DESK_BAR_ITEMS);
export type DeskBarItem = z.infer<typeof DeskBarItem>;

export const DEFAULT_DESK_BAR: Readonly<Record<DeskBarItem, DeskShowLevel>> = {
  network: 'always',
  internet: 'always',
  battery: 'always',
  updates: 'matters',
};

export const DeskBarChoices = z.object({
  network: DeskShowLevel,
  internet: DeskShowLevel,
  battery: DeskShowLevel,
  updates: DeskShowLevel,
});
export type DeskBarChoices = z.infer<typeof DeskBarChoices>;

/**
 * What a choice is about (DK-105): a server (`server:<hosts id>`), a connection or a device (`connection:<id>`,
 * `device:<id>`, Home's thing ids), a widget pinned on Home (`widget:<id>`), the assistant's work (`work`), what's
 * coming up (`coming`) or This Whombat (`box`).
 */
export const DESK_SHOW_KEY_RE =
  /^((server|connection|device|widget):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}|work|coming|box)$/;
export const DeskShowKey = z.string().regex(DESK_SHOW_KEY_RE);
export type DeskShowKey = z.infer<typeof DeskShowKey>;

/** How Settings groups the choices, in this order (DK-106). */
export const DESK_SHOW_GROUPS = ['assistant', 'connection', 'widget', 'server', 'box'] as const;
export const DeskShowGroup = z.enum(DESK_SHOW_GROUPS);
export type DeskShowGroup = z.infer<typeof DeskShowGroup>;

/** The clock on a calm glance (DK-107): big, or small. Something that needs you always makes it small. */
export const DESK_CLOCKS = ['big', 'small'] as const;
export const DeskClock = z.enum(DESK_CLOCKS);
export type DeskClock = z.infer<typeof DeskClock>;

/** At most this many choices kept, and this many servers in the strip's order. */
export const DESK_SHOW_ITEMS_MAX = 300;
export const DESK_SHOW_ORDER_MAX = 64;

/** The person's choices (DK-102). A key not in `items` has its kind's default (`deskShowDefault`). */
export const DeskShow = z.object({
  bar: DeskBarChoices.default(() => ({ ...DEFAULT_DESK_BAR })),
  items: z
    .record(DeskShowKey, DeskShowLevel)
    .refine((r) => Object.keys(r).length <= DESK_SHOW_ITEMS_MAX)
    .default(() => ({})),
  /** The servers' order in the strip (hosts ids); servers not in it come after, worst first, then by name (DK-108). */
  order: z
    .array(DeskServerId)
    .max(DESK_SHOW_ORDER_MAX)
    .default(() => []),
  clock: DeskClock.default('big'),
  /** *Welcome back* (DK-120): after 30 minutes away, the screen starts with what happened. */
  welcomeBack: z.boolean().default(true),
  /** *Done today* (DK-109): “{assistant} did 3 things today”, touch to see them. */
  doneToday: z.boolean().default(true),
});
export type DeskShow = z.infer<typeof DeskShow>;

export const DEFAULT_DESK_SHOW: DeskShow = {
  bar: { ...DEFAULT_DESK_BAR },
  items: {},
  order: [],
  clock: 'big',
  welcomeBack: true,
  doneToday: true,
};

/**
 * A choice's default (DK-105): servers *Always* (the strip shows them all, as the glance did), widgets *Off* (the home
 * tiles left the glance, DK-91), everything else *When it matters*.
 */
export function deskShowDefault(key: string): DeskShowLevel {
  if (key.startsWith('server:')) return 'always';
  if (key.startsWith('widget:')) return 'off';
  return 'matters';
}

/** The person's choice for `key`, or its default. */
export function deskShowLevel(show: Pick<DeskShow, 'items'>, key: string): DeskShowLevel {
  return show.items[key] ?? deskShowDefault(key);
}

/** A server's choice key from its hosts id. */
export function deskServerKey(id: string): DeskShowKey {
  return `server:${id}`;
}

/**
 * `desk.update`'s `show` (DK-102): any part, each as given. `items` sets the keys it names and leaves the others; a
 * `null` puts a key back to its default. `order` replaces the order.
 */
export const DeskShowPatch = z.strictObject({
  bar: z
    .strictObject({
      network: DeskShowLevel.optional(),
      internet: DeskShowLevel.optional(),
      battery: DeskShowLevel.optional(),
      updates: DeskShowLevel.optional(),
    })
    .optional(),
  items: z
    .record(DeskShowKey, DeskShowLevel.nullable())
    .refine((r) => Object.keys(r).length <= DESK_SHOW_ITEMS_MAX)
    .optional(),
  order: z.array(DeskServerId).max(DESK_SHOW_ORDER_MAX).optional(),
  clock: DeskClock.optional(),
  welcomeBack: z.boolean().optional(),
  doneToday: z.boolean().optional(),
});
export type DeskShowPatch = z.infer<typeof DeskShowPatch>;

/**
 * The choices after `patch` (DK-102): a key set to its default is dropped, so `items` holds only what the person
 * changed; the order without repeats. Pure: Settings shows it before the answer, the runtime keeps it.
 */
export function applyDeskShowPatch(show: DeskShow, patch: DeskShowPatch): DeskShow {
  const items: Record<string, DeskShowLevel> = { ...show.items };
  for (const [key, level] of Object.entries(patch.items ?? {})) {
    if (level === null || level === deskShowDefault(key)) delete items[key];
    else items[key] = level;
  }
  const bar = { ...show.bar };
  for (const item of DESK_BAR_ITEMS) {
    const level = patch.bar?.[item];
    if (level) bar[item] = level;
  }
  const order = patch.order ? patch.order.filter((id, i, all) => all.indexOf(id) === i) : show.order;
  return {
    bar,
    items,
    order: order.slice(0, DESK_SHOW_ORDER_MAX),
    clock: patch.clock ?? show.clock,
    welcomeBack: patch.welcomeBack ?? show.welcomeBack,
    doneToday: patch.doneToday ?? show.doneToday,
  };
}

/**
 * Something the person can choose for, as Settings lists it (`DeskScreen.showOptions`, DK-106): its key and group, its
 * name, what it shows (`line`: “Who’s watching”, “Proxmox · 16 cores”), its mark, and whether *When it matters* means
 * more than its problems (`activity`: it has something going on to show, like Plex's viewers). Servers in the strip's
 * order.
 */
export const DeskShowOption = z.object({
  key: DeskShowKey,
  group: DeskShowGroup,
  name: z.string().min(1).max(80),
  line: z.string().max(120),
  mark: Mark.optional(),
  activity: z.boolean(),
});
export type DeskShowOption = z.infer<typeof DeskShowOption>;

/* The calm glance (DK-112…DK-124) -------------------------------------------------------------------------------- */

/**
 * The sentence by the clock (DK-112): `ok` all fine (green), `busy` the assistant is working (sand), `warn` something
 * to look at (amber), `bad` something is wrong or a question waits (red). `more` the muted line under it.
 */
export const DESK_HEADLINE_TONES = ['ok', 'busy', 'warn', 'bad'] as const;
export const DeskHeadlineTone = z.enum(DESK_HEADLINE_TONES);
export type DeskHeadlineTone = z.infer<typeof DeskHeadlineTone>;
export const DeskHeadline = z.object({
  tone: DeskHeadlineTone,
  text: line(80),
  more: line(200).optional(),
});
export type DeskHeadline = z.infer<typeof DeskHeadline>;

/**
 * The one thing that takes the middle (DK-113): a question or approval (`ask`, its number) or a problem (`look`, its
 * key in `needsYou.looks`), so the screen opens the card it already has. `since` when it began, `detail` what it means
 * (“Plex, Home Assistant and 2 more run on it, so they’re down too.”), `server` a server it opens.
 */
export const DESK_HERO_KINDS = ['ask', 'look'] as const;
export const DeskHeroKind = z.enum(DESK_HERO_KINDS);
export const DESK_HERO_TONES = ['bad', 'warn'] as const;
export const DeskHeroTone = z.enum(DESK_HERO_TONES);
export const DeskHero = z.object({
  kind: DeskHeroKind,
  tone: DeskHeroTone,
  title: line(120),
  detail: line(200).optional(),
  since: Timestamp.optional(),
  ask: AskNumber.optional(),
  look: LookKey.optional(),
  server: DeskServerId.optional(),
  /**
   * A look's research (3.5; Whombat look-research.md): where the assistant is with it (`title` and `detail` are then its
   * words, or “I’m looking into it.”), and the label of the step it offers, the hero's first button (`look/fix`).
   */
  research: LookResearchState.optional(),
  fix: line(LOOK_FIX_LABEL_MAX).optional(),
});
export type DeskHero = z.infer<typeof DeskHero>;

/** A smaller thing that waits on one line under the hero (DK-114): “nas · disk is 88 % full, full in about 12 days”. */
export const DeskAlso = z.object({
  tone: DeskHeroTone,
  name: line(40),
  text: line(120),
  ask: AskNumber.optional(),
  look: LookKey.optional(),
  server: DeskServerId.optional(),
});
export type DeskAlso = z.infer<typeof DeskAlso>;

/**
 * Something going on, a card in the middle (DK-115): the assistant's `work`, a connection's `activity` (Plex's
 * viewers, the download queue), a pinned `figure` (a widget, a connection's first figure) or what's `coming` up.
 * `progress` draws a bar; `pinned` it shows because the person chose *Always*.
 */
export const DESK_MOMENT_KINDS = ['work', 'activity', 'figure', 'coming'] as const;
export const DeskMomentKind = z.enum(DESK_MOMENT_KINDS);
export type DeskMomentKind = z.infer<typeof DeskMomentKind>;
export const DeskMoment = z.object({
  key: DeskShowKey,
  kind: DeskMomentKind,
  name: line(40),
  mark: Mark.optional(),
  value: line(40),
  detail: line(80).optional(),
  progress: Pct.optional(),
  pinned: z.boolean().optional(),
});
export type DeskMoment = z.infer<typeof DeskMoment>;
/** At most three things in the middle (DK-115). */
export const DESK_MOMENTS_MAX = 3;

/**
 * A server in the strip (DK-116): fine, it draws its last hour's processor line (`spark`, whole percent, oldest first);
 * not fine, it says why in a few words (`say`: “not answering”, “disk 88 %”, “updating”). `work` while the assistant's
 * work goes through it (DK-117): done, now (with `progress`), next.
 */
export const DESK_STRIP_STATES = ['ok', 'warn', 'bad', 'off'] as const;
export const DeskStripState = z.enum(DESK_STRIP_STATES);
export const DESK_STRIP_WORK = ['done', 'now', 'next'] as const;
export const DeskStripWork = z.enum(DESK_STRIP_WORK);
export const DESK_SPARK_POINTS = 30;
export const DeskStripServer = z.object({
  id: DeskServerId.optional(),
  name: line(40),
  mark: Mark,
  state: DeskStripState,
  say: line(40).optional(),
  spark: z.array(Pct).max(DESK_SPARK_POINTS).optional(),
  work: DeskStripWork.optional(),
  progress: Pct.optional(),
});
export type DeskStripServer = z.infer<typeof DeskStripServer>;
/** At most this many servers in the strip; the rest are counted (`DeskCalm.moreStrip`) and open *Servers* (DK-116). */
export const DESK_STRIP_MAX = 8;

/**
 * *Welcome back* (DK-120…DK-122): what happened while nobody was at the screen, shown once when someone comes back
 * after `DESK_WELCOME_AWAY_S` (a face, or the first touch). `id` names this one, so the screen shows it once; `awayS`
 * how long nobody was there. Rows: a question waiting (`ask`), something done (`done`), something that went wrong
 * (`down`), came back (`up`) or got worse (`look`).
 */
export const DESK_DIGEST_ICONS = ['ask', 'done', 'down', 'up', 'look'] as const;
export const DeskDigestIcon = z.enum(DESK_DIGEST_ICONS);
export const DeskDigestItem = z.object({
  icon: DeskDigestIcon,
  text: line(120),
  at: Timestamp.optional(),
  ask: AskNumber.optional(),
  look: LookKey.optional(),
  server: DeskServerId.optional(),
});
export type DeskDigestItem = z.infer<typeof DeskDigestItem>;
export const DESK_DIGEST_ITEMS = 5;
export const DeskDigest = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  awayS: z.number().int().min(0).max(31_536_000),
  items: z.array(DeskDigestItem).min(1).max(DESK_DIGEST_ITEMS),
});
export type DeskDigest = z.infer<typeof DeskDigest>;
/** Away at least this long before *Welcome back* (DK-120). */
export const DESK_WELCOME_AWAY_S = 1_800;
/** *Welcome back* goes back to the glance after this long, or on a touch (DK-121). */
export const DESK_WELCOME_SHOW_S = 60;

/** Whombat updating itself (DK-118): the top bar's *Updating* while the manager installs or restarts into a release. */
export const DESK_UPDATE_STATES = ['downloading', 'installing', 'restarting'] as const;
export const DeskUpdateState = z.enum(DESK_UPDATE_STATES);

/** Settings' *Try it on the screen* (DK-124): the scenario the screen shows for a minute. */
export const DESK_PREVIEW_SCENARIOS = ['now', 'wrong', 'busy'] as const;
export const DeskPreviewScenario = z.enum(DESK_PREVIEW_SCENARIOS);
export type DeskPreviewScenario = z.infer<typeof DeskPreviewScenario>;
/** How long *Try it on the screen* shows the preview (DK-124). */
export const DESK_TRY_S = 60;

/**
 * The calm glance (DK-101): the desk socket's `DeskGlance.calm` and the session's preview (`DeskPreview.calm`). A
 * screen that knows it draws this frame; an older one ignores it and draws the glance it knows.
 *
 * - `headline` the sentence by the clock; `clock` big or small (small whenever `hero` is there, DK-107).
 * - `hero` the one thing in the middle, `also` up to two more on a line each and `moreNeeds` how many beyond those
 *   (DK-113, DK-114). With a hero there are no `moments`.
 * - `moments` up to three things going on (DK-115).
 * - `strip` the servers, `moreStrip` how many more (DK-116).
 * - `bar` the person's top bar choices (DK-110); the screen knows the network, the battery and the lock itself.
 * - `doneCount` “{assistant} did {n} things today”, while *Done today* is on and the count isn't 0 (DK-109).
 * - `digest` *Welcome back*, once, when someone comes back (DK-120).
 * - `update` Whombat updating itself (DK-118).
 * - `sample` until when this is Settings' *Try it on the screen* rather than what's true (DK-124).
 */
export const DeskCalm = z.object({
  headline: DeskHeadline,
  clock: DeskClock,
  hero: DeskHero.optional(),
  also: z.array(DeskAlso).max(2),
  moreNeeds: Count,
  moments: z.array(DeskMoment).max(DESK_MOMENTS_MAX),
  strip: z.array(DeskStripServer).max(DESK_STRIP_MAX),
  moreStrip: Count,
  bar: DeskBarChoices,
  doneCount: Count.optional(),
  digest: DeskDigest.optional(),
  update: DeskUpdateState.optional(),
  sample: z.object({ scenario: DeskPreviewScenario, until: Timestamp }).optional(),
});
export type DeskCalm = z.infer<typeof DeskCalm>;

/**
 * Settings' preview (`desk.preview`, DK-123): the calm glance as the screen would draw it with the given choices, for
 * `scenario` — `now` what's true, `wrong` the first server in the strip down, `busy` the assistant at work through the
 * strip — and the name the top bar shows. Unlocked, as the person sees it at the screen.
 */
export const DeskPreview = z.object({
  name: z.string().min(1).max(40),
  calm: DeskCalm,
});
export type DeskPreview = z.infer<typeof DeskPreview>;

/** A Whombat's name as the screen's top bar shows it (DK-119), from the app (`desk.setName`). */
export const DeskWhombatName = line(40);
