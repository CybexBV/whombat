/**
 * A page recipe: what the assistant tells Whombat to read from a Custom connection and where each value goes on its
 * page (Whombat docs/decisions/connection-looks.md). Whombat's server reads, as the connection, only what the recipe
 * names — an MCP tool the server marks read-only, or a GET path of the API — and builds the page in the slots every
 * service page shares: Live, Inventory (`counts`), Trend, a list below them, the head's facts and Worth a look's lines
 * (`warnings`). Nothing in a recipe can change anything in the service.
 *
 * A value is named by a path into the read's answer: keys and list positions joined by dots (`data.items.0.name`), `$`
 * for the whole answer. Inside `live` and `list`, an item's paths start at the item.
 */
import { z } from 'zod';

/** A recipe's own name for a read, a line or a warning: `stats`, `queue-size`. */
export const PageRecipeId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export type PageRecipeId = z.infer<typeof PageRecipeId>;

/** A path into a read's JSON answer: `data.items.0.name`, `$` for the answer itself. */
export const PagePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(\$|[^.\s][^.]*(\.[^.]+)*)$/);
export type PagePath = z.infer<typeof PagePath>;

/**
 * How a value is written: `text` as it is, `number` with thousands, `percent` (0–100, or 0–1 with `scale: 100`),
 * `bytes` (“1.8 GB”), `duration` (seconds: “2 h 5 min”), `date` (a day and time), `ago` (“5 min ago”), `count` (how many
 * items a list or object has), `yesno` (“Yes”/“No”).
 */
export const PAGE_FORMATS = [
  'text',
  'number',
  'percent',
  'bytes',
  'duration',
  'date',
  'ago',
  'count',
  'yesno',
] as const;
export const PageFormat = z.enum(PAGE_FORMATS);
export type PageFormat = z.infer<typeof PageFormat>;

/** How the value of `at` is shown. */
const shown = {
  format: PageFormat.optional(),
  /** After the number: “°C”, “W”, “jobs”. */
  unit: z.string().min(1).max(16).optional(),
  /** Multiplied first: `100` for a share 0–1 shown as a percent, `0.001` for milliseconds as seconds. */
  scale: z.number().positive().max(1e12).optional(),
};

/** A value: which read, where in its answer, and how to show it. */
export const PageValue = z.object({ read: PageRecipeId, at: PagePath, ...shown });
export type PageValue = z.infer<typeof PageValue>;

/** A value inside an item of a list (`live`, `list`): its path starts at the item. */
export const PageItemValue = z.object({ at: PagePath, ...shown });
export type PageItemValue = z.infer<typeof PageItemValue>;

/** An item's or a line's colour from a value: `bad` and `warn` list the values that make it red or amber. */
export const PageToneRule = z.object({
  at: PagePath,
  bad: z
    .array(z.union([z.string().max(80), z.number(), z.boolean()]))
    .max(12)
    .optional(),
  warn: z
    .array(z.union([z.string().max(80), z.number(), z.boolean()]))
    .max(12)
    .optional(),
});
export type PageToneRule = z.infer<typeof PageToneRule>;

/** The icons a recipe's lines may use (those the apps draw on a page's lines). */
export const PAGE_ICONS = [
  'disk',
  'network',
  'power',
  'battery',
  'database',
  'clock',
  'key',
  'device',
  'info',
  'download',
  'camera',
  'door',
  'media',
  'money',
  'shield',
  'certificate',
] as const;
export const PageIcon = z.enum(PAGE_ICONS);

/**
 * One read: an MCP tool of the connection that its server marks read-only (`tool`, with `args`), or a GET of the API's
 * `path` (with `query`). Read again after `everyS` seconds (60 when absent).
 */
export const PageRead = z
  .object({
    id: PageRecipeId,
    tool: z.string().min(1).max(128).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    path: z
      .string()
      .max(300)
      .regex(/^\/[^\s#]*$/)
      .optional(),
    query: z.record(z.string().max(60), z.string().max(300)).optional(),
    everyS: z.number().int().min(30).max(3600).optional(),
  })
  .refine((r) => (r.tool === undefined) !== (r.path === undefined), {
    message: 'A read names either a tool or a path.',
  });
export type PageRead = z.infer<typeof PageRead>;

const title = z.string().trim().min(1).max(60);
const meta = z.string().trim().min(1).max(120).optional();
const words = z.string().trim().min(1).max(160);

/** A list of things from one read: what happens now (`live`) or anything else (`list`). */
const PageItems = z.object({
  title,
  meta,
  read: PageRecipeId,
  /** The list in the answer. */
  items: PagePath,
  /** Each item's name. */
  name: PageItemValue,
  detail: PageItemValue.optional(),
  /** On the right: a figure, a state. */
  right: PageItemValue.optional(),
  tone: PageToneRule.optional(),
  icon: PageIcon.optional(),
  /** At most this many items (8 when absent). */
  limit: z.number().int().min(1).max(20).optional(),
  /** Said when the list is empty: “Nothing is downloading.” */
  empty: z.string().trim().min(1).max(120).optional(),
});
export type PageItems = z.infer<typeof PageItems>;

/** One Inventory line: its count large on the right. */
export const PageCount = z.object({
  id: PageRecipeId,
  title,
  detail: z.string().trim().min(1).max(160).optional(),
  value: PageValue,
  icon: PageIcon.optional(),
  /** Say what changed on last week under it (from Whombat's own readings): only for a number. */
  change: z.boolean().optional(),
  tone: PageToneRule.optional(),
});
export type PageCount = z.infer<typeof PageCount>;

/** A line in Worth a look while its condition holds. */
export const PageWarning = z
  .object({
    id: PageRecipeId,
    /** Whombat's words for it: “Battery low”, “Backup failed”. */
    title: words,
    detail: z.string().trim().min(1).max(200).optional(),
    value: PageValue,
    above: z.number().optional(),
    below: z.number().optional(),
    equals: z.union([z.string().max(80), z.number(), z.boolean()]).optional(),
    not: z.union([z.string().max(80), z.number(), z.boolean()]).optional(),
    /** It holds while the value is there (an error message, a list that isn't empty). */
    present: z.literal(true).optional(),
    /**
     * Down, broken, data at risk or a security opening, which Whombat watches from the start; anything else starts off
     * until the person turns it on.
     */
    important: z.boolean(),
  })
  .refine((w) => [w.above, w.below, w.equals, w.not, w.present].filter((c) => c !== undefined).length === 1, {
    message: 'A warning has one condition: above, below, equals, not or present.',
  });
export type PageWarning = z.infer<typeof PageWarning>;

export const PAGE_READS_MAX = 6;

export const ConnectionPage = z.object({
  reads: z.array(PageRead).min(1).max(PAGE_READS_MAX),
  /** What happens now: two of three columns. */
  live: PageItems.optional(),
  /** How much of each thing it holds: one of three columns. */
  counts: z.object({ title, meta, lines: z.array(PageCount).min(1).max(8) }).optional(),
  /** A bar per day of the last week from Whombat's own readings of a number: one of three columns. */
  trend: z
    .object({
      title,
      meta,
      /** The series' name: “Energy”, “Requests”. */
      label: z.string().trim().min(1).max(40),
      value: PageValue,
      /** A day's bar: the last reading, the highest, the sum or the mean of that day's readings. */
      how: z.enum(['last', 'max', 'sum', 'mean']),
      /** The figure's words after the week's value: “kWh this week”, “typical”. */
      rest: z.string().trim().min(1).max(40).optional(),
    })
    .optional(),
  /** Anything else, below the slots. */
  list: PageItems.optional(),
  /** The head's first facts: “Firmware **2.4.1**”. */
  facts: z
    .array(z.object({ label: z.string().trim().min(1).max(40), value: PageValue }))
    .max(3)
    .optional(),
  warnings: z.array(PageWarning).max(8).optional(),
});
export type ConnectionPage = z.infer<typeof ConnectionPage>;

/** Every read a recipe's parts name exists, and every id is used once. */
export function pageRecipeProblems(page: ConnectionPage): string[] {
  const out: string[] = [];
  const reads = new Set<string>();
  for (const r of page.reads) {
    if (reads.has(r.id)) out.push(`Two reads are called “${r.id}”.`);
    reads.add(r.id);
  }
  const uses: { read: string; where: string }[] = [
    ...(page.live ? [{ read: page.live.read, where: 'live' }] : []),
    ...(page.list ? [{ read: page.list.read, where: 'list' }] : []),
    ...(page.counts?.lines ?? []).map((l) => ({ read: l.value.read, where: `count “${l.id}”` })),
    ...(page.trend ? [{ read: page.trend.value.read, where: 'trend' }] : []),
    ...(page.facts ?? []).map((f) => ({ read: f.value.read, where: `fact “${f.label}”` })),
    ...(page.warnings ?? []).map((w) => ({ read: w.value.read, where: `warning “${w.id}”` })),
  ];
  for (const u of uses)
    if (!reads.has(u.read)) out.push(`The ${u.where} reads “${u.read}”, which isn’t in reads.`);
  for (const [what, ids] of [
    ['count', (page.counts?.lines ?? []).map((l) => l.id)],
    ['warning', (page.warnings ?? []).map((w) => w.id)],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) out.push(`Two ${what}s are called “${id}”.`);
      seen.add(id);
    }
  }
  if (
    !page.live &&
    !page.counts &&
    !page.trend &&
    !page.list &&
    !page.facts?.length &&
    !page.warnings?.length
  )
    out.push('The page shows nothing: give it live, counts, trend, list, facts or warnings.');
  return out;
}
