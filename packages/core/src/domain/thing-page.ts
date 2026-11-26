/**
 * A connection's or a device's own page (contracts 0.88.0, CT-390…CT-393; Whombat connection-pages.md CP-01…CP-20):
 * how the thing itself is running, in a server page's shape — a head with its status and facts, tabs of panels, the
 * machine it runs on and what may be done to it. Whombat shows how a service runs, not what is inside it (CP-02): Home
 * Assistant's page shows its version, integrations, log, database and backups and the machine's CPU, memory and disk,
 * never the house's lights.
 *
 * The server builds every panel with its words and figures already formatted; clients draw panels by `kind` and know
 * nothing of Home Assistant or UniFi, so a newer server can give a kind of connection its page without a client
 * release. Clients add two tabs of their own after the server's: Activity (`changes.list?thing=`) and, when
 * `settings`, Settings (the connection's sign-in, access and tools).
 *
 * Dashboards (contracts 0.89.0, CT-394…CT-398; Whombat dashboards.md DS-01…): every server, connection and device
 * shares one Summary layout — figures with a small line of the day (`ThingPageKpi.spark`/`meter`), one to three chart
 * cards per row with their figure, average and peak (`chart.figure`/`stats`/`foot`), then a main and a side column
 * that stack their own panels (`place`). One range picker drives every chart (`ThingPage.range`/`ranges`, the
 * `range` query). Clients build a server's Summary from the hosts data with the same panels.
 *
 * Service dashboards (contracts 0.121.0, CT-1000…CT-1049; Whombat service-dashboards.md SD-01…SD-70): a service's page
 * shows what is in it at a glance, what is happening now, what is wrong and a few buttons (SD-01, which replaces CP-02
 * for services with a page of their own). Pictures (`ThingImage`, loaded through `things.image` or the session's
 * `thing-image` download), buttons where the thing is (`ThingPageButton` on a cell, a list line, a panel's head, a
 * Worth a look line or the page's head, run with `things.action {action, target, value}`), the `gallery` and `controls`
 * panels, and `refreshS` for a page that shows something moving. A client leaves out what it doesn't know and draws
 * the rest (SD-11).
 *
 * Quiet notices (contracts 0.122.0, CT-1060…CT-1066; Whombat quiet-notices.md QN-01…QN-24): every Worth a look line
 * says what kind it is, which check and item it is about, what Ignore would do and whether it is quiet now
 * (`domain/quiet.ts`); `things.quiet` ignores, snoozes or takes back a line, `things.watch` and `things.setWatch` are
 * What Whombat watches on the clients' Settings tab.
 *
 * A service's settings (Whombat service-settings.md SST-01…): the `settings` panel lists the dozen settings of a service
 * that matter, each with its value in words and a switch or a sheet of choices; both run `things.action` with the
 * kind's `setting` action, the same one the assistant runs. Its answer says when the change can be put back
 * (`ThingActionResponse.undoable`). Any panel may carry `ask` (“Ask {assistant} about …” with a few questions), and a
 * service's page a one-sentence `verdict` under its name.
 *
 * Service pages in slots (Whombat docs/decisions/service-slots.md): a service's Summary is built from the same
 * slots on every screen — Worth a look as a strip on top (left out when nothing needs a look), Live (`gallery` with
 * `look: 'rows'`), Inventory (`list` with `look: 'counts'`), Shelf (`gallery` with `look: 'shelf'`), Trend (a `chart`
 * with `labels`), People (`bars` with `person`) and Machine (`bars`) — laid in rows of three columns by `span`. A
 * client that doesn't know a look draws the plain panel.
 */
import { z } from 'zod';
import { ChangeId, ConnectionId, DeviceSkillProposalId } from '../ids.js';
import { Timestamp } from './common.js';
import { HomeHref, ThingKind, ThingStatus } from './home.js';
import { HostSeriesRange } from './hosts.js';
import { ThingUptime } from './incidents.js';
import { LookResearch } from './look-research.js';
import {
  KeptQuiet,
  NoticeCheck,
  NoticeIgnore,
  NoticeNature,
  NoticeQuiet,
  NoticeSubject,
  ThingCause,
} from './quiet.js';
import { ThingLogo } from './thing-logo.js';

/** A tab's, panel's, figure's or series' key: `overview`, `integrations`, `cpu`. */
export const ThingPageKey = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export type ThingPageKey = z.infer<typeof ThingPageKey>;

export const ThingTone = z.enum(['ok', 'warn', 'bad']);
export type ThingTone = z.infer<typeof ThingTone>;

/** A run of words in a line; some strong or in the mono face (“Home Assistant **2026.10.2** · Container”). */
export const ThingTextPart = z.object({
  text: z.string().min(1).max(120),
  strong: z.boolean().optional(),
  mono: z.boolean().optional(),
});
export type ThingTextPart = z.infer<typeof ThingTextPart>;

/** One fact of the head's line, in parts. */
export const ThingLine = z.array(ThingTextPart).min(1).max(8);
export type ThingLine = z.infer<typeof ThingLine>;

/** What a button on the page does. */
export const ThingPageLink = z.discriminatedUnion('kind', [
  /** Opens the Ask pane with this question about the thing, ready to send. */
  z.object({
    kind: z.literal('ask'),
    label: z.string().min(1).max(30),
    question: z.string().min(1).max(300),
  }),
  /** Opens one of the page's tabs (`activity` and `settings` are the clients' own). */
  z.object({ kind: z.literal('tab'), label: z.string().min(1).max(30), tab: ThingPageKey }),
  /** Opens a page of the app (a server, a guest, a chat). */
  z.object({ kind: z.literal('href'), label: z.string().min(1).max(30), href: HomeHref }),
  /** Opens an outside page in a new tab (the service's own web page). */
  z.object({ kind: z.literal('url'), label: z.string().min(1).max(30), url: z.string().url().max(500) }),
]);
export type ThingPageLink = z.infer<typeof ThingPageLink>;

/* Pictures (0.121, CT-1000; SD-06) ---------------------------------------------------------------- */

/**
 * A picture's name on a page: opaque to clients, made and signed by the server (which connection, which path, until
 * when; Whombat SD-S03), good for 24 hours and only on its own thing's page. Clients put it in `thingImagePath` or the
 * session's `thing-image` download as it is; they never build or read one.
 */
export const ThingImageRef = z
  .string()
  .min(16)
  .max(600)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export type ThingImageRef = z.infer<typeof ThingImageRef>;

/** The box a picture keeps before it arrives: `poster` 2:3, `wide` 16:9, `square` 1:1. */
export const THING_IMAGE_SHAPES = ['poster', 'wide', 'square'] as const;
export const ThingImageShape = z.enum(THING_IMAGE_SHAPES);
export type ThingImageShape = z.infer<typeof ThingImageShape>;

/** The types `things.image` answers (sniffed from the bytes; never SVG, which can carry script). */
export const THING_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** A picture's longest side at most, in pixels: the server makes larger ones smaller (SD-06). */
export const THING_IMAGE_MAX_SIDE = 480;
/** A picture for a screen's photo view (3.7, DK-160): its long side at most this, so it fills a wall screen. */
export const THING_IMAGE_LARGE_SIDE = 1280;

/**
 * A picture on a page (CT-1000): a poster, a camera's snapshot, a photo's or a document's thumbnail. `alt` says what it
 * shows for screen readers (“Poster of Dune: Part Two”); empty when the words beside it already say it. A picture that
 * fails to load leaves its box empty; nothing else on the page breaks.
 */
export const ThingImage = z.object({
  ref: ThingImageRef,
  alt: z.string().max(120),
  /** poster 2:3, wide 16:9, square 1:1 — the box the client keeps before the picture arrives. */
  shape: ThingImageShape,
});
export type ThingImage = z.infer<typeof ThingImage>;

/* Buttons (0.121, CT-1001; SD-07) ----------------------------------------------------------------- */

/** A button's small picture; clients map each to their own icon set. One a client doesn't know: none. */
export const THING_BUTTON_ICONS = [
  'restart',
  'power',
  'play',
  'pause',
  'stop',
  'check',
  'close',
  'retry',
  'search',
  'lock',
  'unlock',
  'shield',
  'up',
  'down',
  'open',
  'clean',
  'speed',
] as const;
export const ThingButtonIcon = z.enum(THING_BUTTON_ICONS);
export type ThingButtonIcon = z.infer<typeof ThingButtonIcon>;

/** The question before a button that matters (a door, a lock, an alarm, a cover, power, anything for everyone). */
export const ThingPageConfirm = z.object({
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(300),
  /** The confirming button's words (“Unlock”, “Decline”). */
  button: z.string().min(1).max(30),
});
export type ThingPageConfirm = z.infer<typeof ThingPageConfirm>;

/** What a button sends besides its action and target: a switch's new state, a stepper's new figure, a speed. */
export const ThingButtonValue = z.union([z.string().max(100), z.number(), z.boolean()]);
export type ThingButtonValue = z.infer<typeof ThingButtonValue>;

/**
 * A button where the thing is (CT-1001): Approve on a request, Retry on a failed download, Pause on the queue, a
 * light's switch. Pressing it sends `things.action {action, target, value}` (after `confirm`, when it has one); the
 * server checks the action, target and value against what the page offers and who is asking (SD-07, SD-S04), answers
 * the toast's words, and the client reads the page again.
 */
export const ThingPageButton = z.object({
  /** The kind's action id (`approve`, `pause`, `toggle`). */
  action: ThingPageKey,
  /** What it acts on: a row, an entity, a request id. */
  target: z.string().min(1).max(200).optional(),
  value: ThingButtonValue.optional(),
  label: z.string().min(1).max(30),
  icon: ThingButtonIcon.optional(),
  /** `primary` the one button that matters most (Approve), `danger` one that stops or locks out. Absent: plain. */
  tone: z.enum(['primary', 'danger']).optional(),
  confirm: ThingPageConfirm.optional(),
  /** False with `reason` for those who may not (Look only, not theirs to manage): drawn disabled with the reason. */
  allowed: z.boolean(),
  reason: z.string().max(200).optional(),
});
export type ThingPageButton = z.infer<typeof ThingPageButton>;

/** At most this many buttons on a panel's head, a page's head or a control; three on a list line or a gallery item. */
export const THING_PANEL_BUTTONS_MAX = 4;
export const THING_ITEM_ACTIONS_MAX = 3;

/**
 * A line's, bar's or small line's colour (CT-395): clients map them to their chart tokens — blue, orange, green and
 * violet the chart colours, amber the warning colour, red the serious one, grey the muted one.
 */
export const ThingSeriesColor = z.enum(['blue', 'orange', 'green', 'violet', 'amber', 'red', 'grey']);
export type ThingSeriesColor = z.infer<typeof ThingSeriesColor>;

/** A figure in a row of figures: “DISK **30** / 40 GB · 76 % used”. */
export const ThingPageKpi = z.object({
  key: ThingPageKey,
  /** “Disk”; clients set it in the label face (upper case). */
  label: z.string().min(1).max(30),
  /** “30”, “5 %”, “Working”. */
  value: z.string().min(1).max(40),
  /** Smaller words after the value: “/ 40 GB”, “of 171”, “kW”. */
  rest: z.string().max(40).optional(),
  /** The line under it: “76 % used”, “2 not loading”. */
  sub: z.string().max(80).optional(),
  tone: ThingTone.optional(),
  /**
   * A small line of the figure over the page's range under it (CT-395), oldest first; null where nothing was read.
   * Clients draw at most one of `spark` and `meter`, `spark` first.
   */
  spark: z.array(z.number().nullable()).max(120).optional(),
  /** Or how full it is, 0…1, as a bar (guests running, a disk). */
  meter: z.number().min(0).max(1).optional(),
  /** The small line's or bar's colour; a `tone` of warn or bad wins. */
  color: ThingSeriesColor.optional(),
  /**
   * The chart panels of this page the figure opens (0.94, CT-449): their `id`s, in order. Clients draw those charts
   * only when the figure is opened, inside the figures' card, one figure at a time; a chart no figure names is a card
   * of its own.
   */
  charts: z.array(ThingPageKey).min(1).max(3).optional(),
  /** Or where the figure leads when it has no charts (0.94, CT-449): the Guests tab, a page. */
  link: ThingPageLink.optional(),
});
export type ThingPageKpi = z.infer<typeof ThingPageKpi>;

/** One line of a chart: oldest first, one value per timestamp, null where nothing was read. */
export const ThingPageSeries = z.object({
  key: ThingPageKey,
  label: z.string().min(1).max(40),
  unit: z.string().max(16).optional(),
  values: z.array(z.number().nullable()).max(600),
  /** The right axis, for a second unit (memory in GB beside CPU in %). */
  axis: z.enum(['left', 'right']).optional(),
  /** The legend's figure: “5 %”, “3.0 GB”. */
  latest: z.string().max(40).optional(),
  /** Its colour (CT-395); absent: the clients' order (blue, orange, green, violet…). */
  color: ThingSeriesColor.optional(),
  /** A soft wash under the line (CPU, memory); bars ignore it. */
  fill: z.boolean().optional(),
});
export type ThingPageSeries = z.infer<typeof ThingPageSeries>;

export const THING_NOTICE_ICONS = [
  'disk',
  'plug',
  'log',
  'update',
  'backup',
  'network',
  'power',
  'battery',
  'database',
  'clock',
  'key',
  'device',
  'info',
  'warn',
  // 0.121 (CT-1007): downloads, cameras, doors, media, payments, security and certificates.
  'download',
  'camera',
  'door',
  'media',
  'money',
  'shield',
  'certificate',
  // Service slots: a library's kind.
  'film',
  'tv',
  'music',
  'photo',
  'video',
] as const;
export const ThingNoticeIcon = z.enum(THING_NOTICE_ICONS);
export type ThingNoticeIcon = z.infer<typeof ThingNoticeIcon>;

/**
 * One “Worth a look” line: “Disk 76 % full · Old backups on the same disk use 8.7 GB · Look into it”.
 *
 * A line says what kind it is (`nature`), which check and item it is about (`check`, `subject`), what Ignore would do
 * for the caller (`ignore`: present only for who may quiet it, and then the client draws the ⋯ menu) and whether it is
 * quiet now (`quiet`: drawn greyed at the bottom of Worth a look with Undo) (0.122, CT-1061; Whombat quiet-notices.md
 * QN-01…QN-14). Each is absent where it doesn't apply (the client then reads the kind with `noticeNature`).
 */
export const ThingPageNotice = z.object({
  id: z.string().min(1).max(120),
  tone: z.enum(['bad', 'warn', 'info']),
  icon: ThingNoticeIcon,
  title: z.string().min(1).max(120),
  detail: z.string().max(200).optional(),
  link: ThingPageLink.optional(),
  /**
   * A button on the line (0.121, CT-1012): Retry a failed request, Clear the service's warnings, Dismiss an alert, Run
   * a sanity check. Drawn after the link.
   */
  action: ThingPageButton.optional(),
  /** Problem, Only you or Heads-up (0.122, CT-1061; QN-01); absent: `noticeNature` reads it from the tone and link. */
  nature: NoticeNature.optional(),
  /** The check it comes from (0.122): `unifi.device_offline`, `conn.signin`, `machine.disk`. */
  check: NoticeCheck.optional(),
  /** The item it is about (0.122, QN-03): “Hallway AP”; absent, the thing as a whole. */
  subject: NoticeSubject.optional(),
  /** What Ignore would do (0.122, QN-10): only for who may quiet the line, and only on lines with a `check`. */
  ignore: NoticeIgnore.optional(),
  /** Quiet now (0.122, QN-14): ignored or snoozed, by whom and until when. */
  quiet: NoticeQuiet.optional(),
});
export type ThingPageNotice = z.infer<typeof ThingPageNotice>;

/** A table cell, already worded. */
export const ThingPageCell = z.object({
  text: z.string().max(200),
  /** Smaller grey words after the text (“CT 131”, “retrying”). */
  note: z.string().max(80).optional(),
  mono: z.boolean().optional(),
  tone: z.enum(['ok', 'warn', 'bad', 'muted']).optional(),
  /** A state dot before the text. */
  dot: z.enum(['ok', 'warn', 'bad', 'off']).optional(),
  /** Drawn as a small tag (`home-assistant:2026.10.2`). */
  tag: z.boolean().optional(),
  href: HomeHref.optional(),
  /**
   * An outside page the cell opens in a new tab (0.121, CT-1013): a site's own address, the service's page for the row.
   * `href` wins when both are given.
   */
  url: z.string().url().max(500).optional(),
  /** `href` drawn as a small button with `text` as its words (“Console”, “Open”) (CT-396). */
  button: z.boolean().optional(),
  /** A small bar before the text, 0…1 (a guest's CPU) (CT-396). */
  meter: z.number().min(0).max(1).optional(),
  /**
   * A brand's mark that goes with the row (`@whombat/brand`'s name: `claude`, `openai`): the screen's rows draw it before
   * the title (Fusebox's subscriptions); a client that doesn't know marks leaves it out.
   */
  mark: z
    .string()
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .optional(),
  /** A small line instead of the text (a guest's last 24 hours), oldest first (CT-396). */
  spark: z.array(z.number().nullable()).max(120).optional(),
  /**
   * A button in the cell (0.121, CT-1002): Scan on a library, Retry on a failed download. `text` is its label too; the
   * client draws the button instead of the text.
   */
  action: ThingPageButton.optional(),
});
export type ThingPageCell = z.infer<typeof ThingPageCell>;

export const ThingPageColumn = z.object({
  key: ThingPageKey,
  /** May be empty for a column of buttons (0.89.0; a 0.88 client skips such a table). */
  label: z.string().max(30),
  /** Figures: the mono face, and the phone shows them on the right. */
  numeric: z.boolean().optional(),
});
export type ThingPageColumn = z.infer<typeof ThingPageColumn>;

export const ThingPageRow = z.object({
  id: z.string().min(1).max(200),
  /** By column key; a missing cell is empty. */
  cells: z.record(ThingPageKey, ThingPageCell),
});
export type ThingPageRow = z.infer<typeof ThingPageRow>;

/** A line of a list: a backup, a log entry, a reading. */
export const ThingPageItem = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(160),
  detail: z.string().max(300).optional(),
  at: Timestamp.optional(),
  tone: z.enum(['ok', 'warn', 'bad', 'info']).optional(),
  icon: ThingNoticeIcon.optional(),
  /** Short words on the right: “1.8 GB”, “×12”. */
  right: z.string().max(40).optional(),
  /** The service's own page for the line, opened in a new tab (0.121, CT-1013): an alert in Grafana, an issue. */
  url: z.string().url().max(500).optional(),
  /** A small picture before the title instead of the icon (0.121, CT-1002): a poster, a thumbnail. */
  image: ThingImage.optional(),
  /** Buttons on the line (0.121, CT-1002): Mark resolved on an issue, Done on a task. */
  actions: z.array(ThingPageButton).max(THING_ITEM_ACTIONS_MAX).optional(),
  /**
   * The line's count in a list of counts: “1,284” large on the right with “+9 this week” under it. A client
   * without counts shows `right`, so a builder gives both.
   */
  figure: z
    .object({
      value: z.string().min(1).max(20),
      note: z.string().max(40).optional(),
      tone: ThingTone.optional(),
    })
    .optional(),
});
export type ThingPageItem = z.infer<typeof ThingPageItem>;

/**
 * A line of a bar list (CT-396): a storage, a disk, a volume — its name, grey words after it, the figure on the right,
 * how full it is as a bar, and a line under it (“Full in about 5 months”).
 */
export const ThingPageBar = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(80),
  mono: z.boolean().optional(),
  /** Grey words after the label: “thin · NVMe”, “WD Red 8 TB · 36 °C”. */
  note: z.string().max(80).optional(),
  /** On the right: “660 of 930 GB”, “valid”. */
  value: z.string().max(40).optional(),
  /** How full, 0…1; null or absent: no bar (a parity disk). */
  pct: z.number().min(0).max(1).nullable().optional(),
  tone: ThingTone.optional(),
  /** The line under the bar: “Full in about 5 months”, “89 % · new files go to disks 2 and 3”. */
  sub: z.string().max(120).optional(),
  subTone: ThingTone.optional(),
  href: HomeHref.optional(),
  /** The label is a person's name: drawn with their initial before it (who watches, who asks). */
  person: z.boolean().optional(),
});
export type ThingPageBar = z.infer<typeof ThingPageBar>;

/**
 * A picture with its words in a gallery (0.121, CT-1004): a poster in Recently added, a request waiting for approval, a
 * camera's snapshot. Under the picture: the title, `sub`, a progress bar with `note` under it, and the buttons.
 */
export const ThingGalleryItem = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(120),
  /** “2024 · Asked by Anna”. */
  sub: z.string().max(120).optional(),
  /** Absent: the shape's empty box with the title's first letter (a film without a poster). */
  image: ThingImage.optional(),
  /** A small tag on the picture: “Converting”, “Offline”, “4K”. */
  badge: z.object({ text: z.string().min(1).max(30), tone: ThingTone }).optional(),
  /** How far, 0…1: a bar under the picture (a download, what is playing). */
  progress: z.number().min(0).max(1).optional(),
  /** Under the progress: “63 % · 12 min left”; in rows, its start (“38:12 of 55:00”). */
  note: z.string().max(80).optional(),
  /** In rows, the end of the progress line: “17 min left”. */
  noteEnd: z.string().max(60).optional(),
  /** The progress stands still (paused): its bar is grey. */
  paused: z.boolean().optional(),
  /**
   * Who it is about: who watches it, who asked for it. In rows, their initial and name, then `note` (“iPad”); on a
   * shelf, a small tag on the picture with their initial and `note` (“Anna asked”), else their name.
   */
  person: z.object({ name: z.string().min(1).max(60), note: z.string().max(80).optional() }).optional(),
  at: Timestamp.optional(),
  /** Drawn greyed: an offline camera. */
  muted: z.boolean().optional(),
  /** Another page of the app (SABnzbd's page for a request that downloads). */
  href: HomeHref.optional(),
  /** The service's own page for it, opened in a new tab; `href` wins when both are given. */
  url: z.string().url().max(500).optional(),
  actions: z.array(ThingPageButton).max(THING_ITEM_ACTIONS_MAX).optional(),
});
export type ThingGalleryItem = z.infer<typeof ThingGalleryItem>;

/** A control's small picture (0.121, CT-1005); clients map each to their own icon set. */
export const THING_CONTROL_ICONS = [
  'light',
  'switch',
  'fan',
  'scene',
  'script',
  'button',
  'thermostat',
  'blind',
  'lock',
  'alarm',
  'sensor',
  'camera',
  'plug',
  'door',
  'media',
  'power',
] as const;
export const ThingControlIcon = z.enum(THING_CONTROL_ICONS);
export type ThingControlIcon = z.infer<typeof ThingControlIcon>;

/**
 * A stepper (CT-1005): the figure between − and +; the client sends the new `value` with `button` (within `min`…`max`,
 * by `step`): a thermostat by half a degree. `value` is always within `min`…`max` (the server keeps it there).
 */
export const ThingControlStepper = z
  .object({
    value: z.number(),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    /** “°C”, “%”. */
    unit: z.string().max(8).optional(),
    button: ThingPageButton,
  })
  .refine((s) => s.min <= s.max && s.value >= s.min && s.value <= s.max, {
    message: 'A stepper’s value lies within min…max',
  });
export type ThingControlStepper = z.infer<typeof ThingControlStepper>;

/**
 * One thing to operate (0.121, CT-1005): a light, a switch, a scene, a thermostat, a lock, a sensor's value or a
 * camera's snapshot. A tile with its icon, label and state words, and at most one of a switch (`toggle`), buttons and a
 * stepper — or a picture (`image`).
 */
export const ThingControl = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(60),
    icon: ThingControlIcon.optional(),
    /** “On · 80 %”, “21.5 °C”, “Locked”. */
    state: z.string().max(60).optional(),
    /** Whether it is on (lit, running, open): the tile's lit look and the switch's position. */
    on: z.boolean().optional(),
    tone: ThingTone.optional(),
    /** A switch: the client sends `value: !on`. Always with `on`. */
    toggle: ThingPageButton.optional(),
    buttons: z.array(ThingPageButton).max(THING_PANEL_BUTTONS_MAX).optional(),
    /** A stepper: the client sends the new `value` (within min…max, by step). */
    stepper: ThingControlStepper.optional(),
    image: ThingImage.optional(),
  })
  .refine((c) => c.toggle === undefined || c.on !== undefined, {
    message: 'A switch says whether it is on',
  });
export type ThingControl = z.infer<typeof ThingControl>;

/** A group of controls (CT-1005): a room or a kind (“Living room”, “Scenes”). */
export const ThingControlGroup = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(60),
  items: z.array(ThingControl).max(48),
});
export type ThingControlGroup = z.infer<typeof ThingControlGroup>;

/* A service's settings (service-settings.md SST-01…SST-09) ------------------------------------------------------- */

/** One of a setting's values in its sheet: “20 Mbps” · “1080p, high”. */
export const ThingSettingChoice = z.object({
  value: ThingButtonValue,
  label: z.string().min(1).max(60),
  note: z.string().max(80).optional(),
});
export type ThingSettingChoice = z.infer<typeof ThingSettingChoice>;

/**
 * A setting with several values (SST-09): its sheet's words and choices; Change opens it, and “Change it” sends the
 * picked choice's `value` with `button` (the kind's `setting` action and the setting as its target).
 */
export const ThingSettingChoose = z.object({
  button: ThingPageButton,
  /** The value it has now (the sheet marks it “Now”); null when it is none of the choices. */
  current: ThingButtonValue.nullable(),
  /** A sentence under the sheet's title: “The most one stream may use when someone watches away from home.” */
  help: z.string().max(200).optional(),
  /** A line under the choices, from what Whombat knows: “Your upload is about 40 Mbps, so 20 Mbps works for two…”. */
  hint: z.string().max(200).optional(),
  choices: z.array(ThingSettingChoice).min(2).max(24),
});
export type ThingSettingChoose = z.infer<typeof ThingSettingChoose>;

/**
 * The last change of a setting from Whombat (SST-03): “Dusty changed this yesterday from 4 Mbps.”, on a phone “Changed
 * by Dusty yesterday”; with `changeId` while it can be put back (`changes.undo`, “Put it back”).
 */
export const ThingSettingChanged = z.object({
  text: z.string().min(1).max(160),
  short: z.string().min(1).max(60),
  changeId: ChangeId.optional(),
});
export type ThingSettingChanged = z.infer<typeof ThingSettingChanged>;

/**
 * A service's setting (SST-01): its name, a plain sentence of what it does, its value in words (“Up to 8 Mbps”, “On”),
 * and at most one of a switch (`toggle` with `on`; the client sends `value: !on`), a sheet of choices (`choose`), or
 * where it is changed instead (`elsewhere`: “In Plex”, for updates, deleting and accounts, SST-05). Without any of them
 * it is only shown (Look only draws the switch and Change disabled with their reason).
 */
export const ThingSetting = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(60),
    help: z.string().max(200).optional(),
    value: z.string().min(1).max(60),
    on: z.boolean().optional(),
    toggle: ThingPageButton.optional(),
    choose: ThingSettingChoose.optional(),
    elsewhere: z
      .object({ label: z.string().min(1).max(30), url: z.string().url().max(500).optional() })
      .optional(),
    changed: ThingSettingChanged.optional(),
  })
  .refine((s) => s.toggle === undefined || s.on !== undefined, {
    message: 'A switch says whether it is on',
  });
export type ThingSetting = z.infer<typeof ThingSetting>;

/**
 * “Ask” on a panel's head (SST-08): opens “Ask {assistant} about {title}” with these questions as chips and “Or ask
 * something else…”; each opens the Ask pane with its question ready to send.
 */
export const ThingPanelAsk = z.object({
  questions: z.array(z.string().min(1).max(200)).min(1).max(3),
});
export type ThingPanelAsk = z.infer<typeof ThingPanelAsk>;

/** A group of the thing's tools and their tier: “Read · Allowed · 4”, “Locks and alarms · Asks you · 5”. */
export const ThingPageAccessItem = z.object({
  label: z.string().min(1).max(80),
  tier: z.enum(['allowed', 'ask', 'off', 'mixed']),
  count: z.number().int().min(0),
});
export type ThingPageAccessItem = z.infer<typeof ThingPageAccessItem>;

/**
 * How wide a panel is on the web: the whole width, or the wide (about 62 %) or narrow (about 38 %) column; a wide panel
 * and the narrow one after it share a row. Phones stack every panel. Absent is `full`.
 */
export const ThingPanelWidth = z.enum(['full', 'wide', 'narrow']);
export type ThingPanelWidth = z.infer<typeof ThingPanelWidth>;

/**
 * Where a panel sits on a wide screen (CT-394, DS-04), top to bottom: `top` the whole width (figures, a banner),
 * `chart` a row of chart cards (`span` 1–3 of three columns, a row filling up before the next starts), then two columns
 * that stack their own panels — `main` (about 65 %) and `side` (about 35 %) — and `bottom` the whole width again.
 * Absent: from `width` (`full` → `top` before any chart, `bottom` after one; a `wide` chart → `chart` span 2; other
 * `wide` → `main`; `narrow` → `side`). Phones stack every panel in the order given.
 */
export const ThingPanelPlace = z.enum(['top', 'chart', 'main', 'side', 'bottom']);
export type ThingPanelPlace = z.infer<typeof ThingPanelPlace>;

const panel = {
  id: ThingPageKey,
  width: ThingPanelWidth.optional(),
  place: ThingPanelPlace.optional(),
  /** A chart card's (or a `chart`-placed panel's) share of the row: 1–3 of three columns; absent 1. */
  span: z.number().int().min(1).max(3).optional(),
  /** Its “Ask” with a few questions about it (SST-08); clients without it leave it out. */
  ask: ThingPanelAsk.optional(),
};
const title = z.string().min(1).max(60);
const meta = z.string().max(120).optional();
/**
 * Buttons on a panel's head (0.121, CT-1003), after its title: Pause and Pause 30 min on a download queue, Search for
 * missing, Update lists. Tables, lists, bar lists, galleries and controls have them.
 */
const buttons = z.array(ThingPageButton).max(THING_PANEL_BUTTONS_MAX).optional();

export const ThingPagePanel = z.discriminatedUnion('kind', [
  /** A row of figures (the server page's KPIs). */
  z.object({ kind: z.literal('kpis'), ...panel, items: z.array(ThingPageKpi).min(1).max(6) }),
  /**
   * Lines over time (the page's range), with a dashed line where it gets serious. A chart card (CT-395): its figure
   * (“18 %” · “of 16 threads”), one or two lines on the right (“Avg **14.2 %**”, “Peak **63 %** Sun 03:10”), the chart,
   * and up to four small facts under it (“User 11.4 %”). `style: 'bars'` stacks the series as bars per timestamp
   * (errors per hour). `forecast` draws where the last value is heading (“full ~18 Dec”).
   */
  z.object({
    kind: z.literal('chart'),
    ...panel,
    title,
    meta,
    timestamps: z.array(Timestamp).max(600),
    series: z.array(ThingPageSeries).min(1).max(6),
    line: z.object({ value: z.number(), label: z.string().max(40).optional() }).optional(),
    figure: z
      .object({
        value: z.string().min(1).max(40),
        rest: z.string().max(60).optional(),
        tone: ThingTone.optional(),
      })
      .optional(),
    stats: z.array(ThingLine).max(2).optional(),
    foot: z
      .array(
        z.object({
          label: z.string().min(1).max(30),
          value: z.string().min(1).max(40),
          tone: ThingTone.optional(),
        }),
      )
      .max(4)
      .optional(),
    style: z.enum(['line', 'bars']).optional(),
    /** The left axis: fixed ends (0…100 for a percentage) and the unit on its ticks (“%”, “GB”, “°C”). */
    axis: z
      .object({ min: z.number().optional(), max: z.number().optional(), unit: z.string().max(12).optional() })
      .optional(),
    forecast: z.object({ at: Timestamp, value: z.number(), label: z.string().min(1).max(40) }).optional(),
    /**
     * The words under each timestamp instead of times: “Thu”, “Fri”, … “Today” under a week's bars. As many as
     * `timestamps`; the chart then keeps out of the page's range.
     */
    labels: z.array(z.string().min(1).max(12)).max(31).optional(),
  }),
  /**
   * “Worth a look”: what is wrong first, each with its way out. Clients show the first five and fold the rest behind
   * “Show N more” (DS-05).
   */
  z.object({
    kind: z.literal('notices'),
    ...panel,
    title,
    items: z.array(ThingPageNotice).max(30),
    /** Shown when there is nothing: “Nothing needs a look.” */
    empty: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal('table'),
    ...panel,
    title,
    meta,
    link: ThingPageLink.optional(),
    buttons,
    columns: z.array(ThingPageColumn).min(1).max(8),
    rows: z.array(ThingPageRow).max(300),
    empty: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal('list'),
    ...panel,
    title,
    meta,
    link: ThingPageLink.optional(),
    buttons,
    items: z.array(ThingPageItem).max(100),
    empty: z.string().max(120).optional(),
    /** `counts`: each line's `figure` large on the right, a phone shows the lines as tiles two by two. */
    look: z.enum(['counts']).optional(),
  }),
  /** Things and how full each is (CT-396): storages, disks, volumes; `columns` 1–3 side by side on a wide screen. */
  z.object({
    kind: z.literal('bars'),
    ...panel,
    title,
    meta,
    link: ThingPageLink.optional(),
    buttons,
    items: z.array(ThingPageBar).max(40),
    columns: z.number().int().min(1).max(3).optional(),
    empty: z.string().max(120).optional(),
  }),
  /**
   * Pictures in a grid or a row (0.121, CT-1004): posters 2:3 in rows (Recently added, requests waiting for approval),
   * wide snapshots 16:9 (cameras), square thumbnails (photos, documents). Every item's picture keeps `shape`'s box.
   */
  z.object({
    kind: z.literal('gallery'),
    ...panel,
    title,
    meta,
    link: ThingPageLink.optional(),
    buttons,
    shape: ThingImageShape,
    items: z.array(ThingGalleryItem).max(48),
    /** How many there are when `items` holds only the first of them (a queue of 35 shows 20). */
    total: z.number().int().min(0).optional(),
    empty: z.string().max(120).optional(),
    /**
     * How the pictures sit: `rows` one line each with a small picture and a wide progress bar (what
     * plays now, what downloads); `shelf` one row that fills the width with as many as fit (a phone swipes it).
     * Absent: a grid.
     */
    look: z.enum(['rows', 'shelf']).optional(),
  }),
  /**
   * Things to operate (0.121, CT-1005): switches, buttons and steppers grouped by room or kind (Home Assistant's
   * favourites). `hint` is a line under the title (“Pin favourites on Home Assistant’s Home dashboard to choose what
   * shows here.”).
   */
  z.object({
    kind: z.literal('controls'),
    ...panel,
    title,
    meta,
    hint: z.string().max(200).optional(),
    buttons,
    groups: z.array(ThingControlGroup).max(16),
    empty: z.string().max(120).optional(),
  }),
  /**
   * A service's settings (SST-01): a card per group (“Watching away from home”), each row a setting with its switch or
   * Change. `hint` is a line under the title.
   */
  z.object({
    kind: z.literal('settings'),
    ...panel,
    title,
    meta,
    hint: z.string().max(200).optional(),
    rows: z.array(ThingSetting).max(16),
    empty: z.string().max(120).optional(),
  }),
  /** Label and value pairs (“Installation · Container”, “Database · MariaDB 10.11”). */
  z.object({
    kind: z.literal('facts'),
    ...panel,
    title,
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(40),
          value: z.string().max(200),
          mono: z.boolean().optional(),
        }),
      )
      .max(24),
  }),
  /** A few plain sentences (a device being learned). */
  z.object({
    kind: z.literal('text'),
    ...panel,
    title: title.optional(),
    body: z.string().min(1).max(1000),
    link: ThingPageLink.optional(),
  }),
  /** What Whombat may do with it, from its tools' tiers; clients link “Change” to Settings when there is one. */
  z.object({
    kind: z.literal('access'),
    ...panel,
    title,
    items: z.array(ThingPageAccessItem).max(8),
    /** Look only (CS-10): every change is refused, whatever the tiers say. */
    lookOnly: z.boolean(),
  }),
  /** What Whombat changed here: clients read `changes.list?thing=<id>` and draw its rows (“Changes here”), Undo included. */
  z.object({ kind: z.literal('changes'), ...panel, title, limit: z.number().int().min(1).max(20) }),
  /**
   * The caller's widgets kept on this page (`widgets.list?thing=<id>`), and chips that ask Whombat for one (“Cost this
   * month”), each opening the Ask pane with “Keep … on this page.”.
   */
  z.object({
    kind: z.literal('widgets'),
    ...panel,
    title,
    suggestions: z.array(z.string().min(1).max(60)).max(6),
  }),
]);
export type ThingPagePanel = z.infer<typeof ThingPagePanel>;

export const ThingPageTab = z.object({
  key: ThingPageKey,
  label: z.string().min(1).max(30),
  /** A count after the label (“Integrations 171”). */
  count: z.number().int().min(0).optional(),
  panels: z.array(ThingPagePanel).max(24),
  /**
   * The server a tab is about, by its id in the hosts fleet, when the apps draw the tab themselves from that server's
   * own operations instead of panels (Find My's tab names its Mac). Absent: the tab is its panels.
   */
  server: z.string().min(1).max(200).optional(),
});
export type ThingPageTab = z.infer<typeof ThingPageTab>;

/** The clients' own tabs after the server's (CP-05): `settings` is drawn as “Connection” (service-settings.md SST-06). */
export const THING_PAGE_CLIENT_TABS = ['activity', 'settings'] as const;

/** The machine a connection runs on: a server Whombat watches, or one of its guests (CP-08). */
export const ThingRunsOn = z.object({
  serverId: z.string().min(1).max(100),
  guestId: z.string().min(1).max(200).nullable(),
  /** “pve-02 · CT 131”, “pve-02”. */
  name: z.string().min(1).max(120),
  /** The server's or the guest's page. */
  href: HomeHref,
  /** `address`: Whombat found it by the connection's address; `chosen`: a person picked it. */
  how: z.enum(['address', 'chosen']),
});
export type ThingRunsOn = z.infer<typeof ThingRunsOn>;

/** A button in the head that changes the thing itself (Restart), always asked first. */
export const ThingPageAction = z.object({
  id: ThingPageKey,
  label: z.string().min(1).max(30),
  icon: z.enum(['restart', 'power']),
  confirm: ThingPageConfirm,
  /** False with `reason` when the caller may not (Look only, not theirs to manage). */
  allowed: z.boolean(),
  reason: z.string().max(200).optional(),
});
export type ThingPageAction = z.infer<typeof ThingPageAction>;

/** A connection's or device's page (`things.page`). */
export const ThingPage = z.object({
  /** The thingId: `connection:con_…`, `device:con_…`, `device:dvp_…`. */
  id: z.string().min(3).max(220),
  kind: ThingKind,
  /** The connection behind it (a switched-on device has one too). */
  connectionId: ConnectionId.optional(),
  /** A device still being learned: its proposal. */
  proposalId: DeviceSkillProposalId.optional(),
  catalogId: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,30}$/)
    .optional(),
  name: z.string().min(1).max(120),
  /** As `ThingSummary.icon`. */
  icon: z.string().min(1).max(40),
  /** As `ThingSummary.logo`. */
  logo: ThingLogo.optional(),
  status: ThingStatus,
  /** The badge's words: “Running fine”, “Needs a look”, “1 access point offline”, “Learning”. */
  badge: z.string().min(1).max(60),
  /**
   * One or two plain sentences under the name (SST-10): “Plex is fine: 2 people are watching and every library is up to
   * date.” Absent: the badge alone says how it is.
   */
  verdict: z.string().min(1).max(200).optional(),
  /** The facts under the name, in order: “Home Assistant **2026.10.2** · Container”, “Restarted **23 h** ago”. */
  facts: z.array(ThingLine).max(6),
  /** Its address in the mono pill (`10.100.0.5:8123`), or the account it is signed in as. */
  address: z.string().max(200).optional(),
  /** “Open Home Assistant”: the service's own web page. */
  open: z.object({ label: z.string().min(1).max(40), url: z.string().url().max(500) }).optional(),
  runsOn: ThingRunsOn.nullable(),
  /** It has a Settings tab (catalog connections; devices show their actions' tiers there). */
  settings: z.boolean(),
  /** The server's tabs, Overview first. */
  tabs: z.array(ThingPageTab).min(1).max(8),
  actions: z.array(ThingPageAction).max(4),
  /**
   * Buttons in the head beside `actions` (0.121, CT-1014): Check for updates, Arm and Disarm. Unlike an action, one
   * needn't be confirmed (it may still carry its own `confirm`); it runs `things.action` like every button.
   */
  buttons: z.array(ThingPageButton).max(THING_PANEL_BUTTONS_MAX).optional(),
  /** When the figures were read; null when nothing could be read yet. */
  readAt: Timestamp.nullable(),
  /** Why the figures couldn't be read this time, in plain words; the page still shows what it has. */
  problem: z.string().max(200).optional(),
  /** The server it is part of (a Proxmox or Unraid connection to a server Whombat watches; CP-10). */
  partOf: z.string().min(3).max(220).optional(),
  /** The range the charts and small lines cover (CT-397); absent: the last 24 hours. */
  range: HostSeriesRange.optional(),
  /** The ranges it can show, shortest first; the range picker offers them. Absent or one: no picker. */
  ranges: z.array(HostSeriesRange).max(6).optional(),
  /**
   * A live page asks again this often while open (and shown), in seconds (CT-397; 0.121, CT-1010): 5 while something
   * downloads or plays, 10 for controls and camera snapshots, absent 60 (SD-09). A button's answer with `refresh` reads
   * it again at once.
   */
  refreshS: z.number().int().min(5).max(3600).optional(),
  /**
   * What the assistant found out about what needs a look here (3.5; Whombat look-research.md): its words at the top of
   * the page, with the step it offers and *Ask {assistant}* (the thread). Absent: nothing needs a look, or it hasn't
   * looked (an older Whombat).
   */
  research: LookResearch.optional(),
  /**
   * Its week in one line (session minor 9): “Up 99.6 % this week · down 3 times, 41 min”.
   * The same words are one of `facts`, so an older app shows them too. Absent: Whombat has nothing to tell yet.
   */
  uptime: ThingUptime.optional(),
  /**
   * Kept quiet until a time: the page draws its words under the head with End
   * now when `canEnd`. Worth a look also carries the words as a heads-up for an app that doesn't draw this.
   */
  keptQuiet: KeptQuiet.optional(),
  /** Down because of something else: the badge says it (“Not answering while pve-02 is down”). */
  causedBy: ThingCause.optional(),
});
export type ThingPage = z.infer<typeof ThingPage>;

/** `things.page`'s query (CT-397): the range to show; one the page doesn't offer gives its default. */
export const ThingPageQuery = z.object({ range: HostSeriesRange.optional() });
export type ThingPageQuery = z.infer<typeof ThingPageQuery>;

/**
 * Where a panel sits on a wide screen (CT-394): its `place`, else from `width` and whether a chart came before it.
 * Pure, for both clients and the server's tests.
 */
export function thingPanelPlace(p: ThingPagePanel, afterChart: boolean): ThingPanelPlace {
  if (p.place) return p.place;
  const width = p.width ?? 'full';
  if (width === 'full') return afterChart ? 'bottom' : 'top';
  if (width === 'narrow') return 'side';
  return p.kind === 'chart' ? 'chart' : 'main';
}

/** A chart-placed panel's columns, 1–3: its `span`, else 2 for a `wide` panel without a place, else 1. */
export function thingPanelSpan(p: ThingPagePanel): 1 | 2 | 3 {
  if (p.span) return p.span as 1 | 2 | 3;
  return !p.place && p.width === 'wide' ? 2 : 1;
}

/**
 * Which charts a figure opens when its own key names none (connections-page.md CN-06): Hetzner's traffic opens the
 * network and the disks' traffic, Home Assistant's integrations the log's errors (when no Log errors figure has them).
 */
const FIGURE_CHARTS: Record<string, readonly string[]> = {
  traffic: ['network', 'disk-io'],
  integrations: ['errors'],
};

/**
 * The charts a Summary's figures open (connections-page.md CN-05, CN-06; contracts 0.94 CT-449), first come first
 * served: the chart with the figure's own key, else the ones `FIGURE_CHARTS` names, else the one chart that draws a
 * line with the figure's key (a device's reading). A figure without a chart whose key is one of the page's `tabs` leads
 * there. Clients draw those charts only inside the figures' card; a chart no figure names stays a card. Pure: the server lays
 * out every page with it, and the apps' fixture pages too, so they look as a real Whombat's do.
 */
export function openThingFigures(
  panels: readonly ThingPagePanel[],
  tabs: readonly string[] = [],
): ThingPagePanel[] {
  const charts = panels.filter((p): p is Extract<ThingPagePanel, { kind: 'chart' }> => p.kind === 'chart');
  const free = new Set(charts.map((c) => c.id));
  const take = (ids: readonly string[]) => {
    const got = ids.filter((id) => free.has(id)).slice(0, 3);
    for (const id of got) free.delete(id);
    return got;
  };
  const opens = new Map<string, string[]>();
  const figures = panels.flatMap((p) => (p.kind === 'kpis' ? p.items : []));
  for (const k of figures) {
    const own = take([k.key]);
    if (own.length) opens.set(k.key, own);
  }
  for (const k of figures) {
    if (opens.has(k.key)) continue;
    const named = take(FIGURE_CHARTS[k.key] ?? []);
    if (named.length) opens.set(k.key, named);
  }
  for (const k of figures) {
    if (opens.has(k.key)) continue;
    const drawn = take(
      charts
        .filter((c) => c.series.some((s) => s.key === k.key))
        .map((c) => c.id)
        .slice(0, 1),
    );
    if (drawn.length) opens.set(k.key, drawn);
  }
  return panels.map((p) => {
    if (p.kind !== 'kpis') return p;
    const items = p.items.map((k): ThingPageKpi => {
      const ids = opens.get(k.key);
      if (ids) return { ...k, charts: ids };
      if (!k.link && tabs.includes(k.key)) return { ...k, link: { kind: 'tab', label: k.label, tab: k.key } };
      return k;
    });
    return { ...p, items };
  });
}
