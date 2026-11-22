/**
 * A service's declared settings (docs/decisions/service-settings.md SST-01…SST-09): the dozen that matter, each with
 * plain words, a switch or a list of choices, and how to read and write it. One `setting` action runs every change — a
 * switch, a sheet's “Change it”, the assistant's approved card and Put it back — and only says it is done once the
 * service reads back the new value (SST-02). The change it leaves can be put back (SST-03): the same action with the old
 * value, while the setting still has the value Whombat set.
 */
import type { ThingPagePanel, ThingPageTab, ThingSetting, ThingSettingChanged } from '@whombat/core';
import { and, desc, eq, gt, like } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../../connections/types';
import { changes } from '../../db/schema/index';
import { assistantCalled } from '../../home/assistant-name';
import { hasUndoer } from '../../home/registry';
import { ApiError, badRequest, conflict } from '../../lib/errors';
import { loadAgentRow } from '../../read/principals';
import type { Services } from '../../services';
import { clip, dayMonth, str } from '../words';
import { type ActCall, actAs } from './act';
import { pageButton } from './buttons';
import { cachedRead, forgetConnectionReads, KIND_DEADLINE_MS, withDeadline } from './read';
import type { KindAction, KindActionCtx, KindActionInput, KindActionWords, KindSettings } from './registry';
import type { KindCtx } from './types';

export type SettingValue = string | number | boolean;

/** The action every declared setting is changed with. */
export const SETTING_ACTION = 'setting';
/** The tab key every service's declared settings use. */
export const SERVICE_SETTINGS_TAB_KEY = 'service-settings';
/** The change kind's start: `thing.setting.<setting>`. */
export const SETTING_CHANGE_PREFIX = 'thing.setting.';
/** How long a declared change can be put back. */
export const SETTING_UNDO_MS = 7 * 86_400_000;
/** How long a service's settings read stays warm; a change forgets it at once. */
const SETTINGS_KEEP_MS = 60_000;

export interface SettingChoice {
  value: SettingValue;
  label: string;
  note?: string;
}

/** One declared setting of a service, over what its read gives (`S`). */
export interface SettingSpec<S> {
  /** Its id: the action's target (`remote_quality`). */
  id: string;
  /** Its group's id. */
  group: string;
  label: string;
  /** One plain sentence of what it does. */
  help: string;
  /** The sheet's sentence; absent: `help`. */
  sheetHelp?: string;
  kind: 'switch' | 'choice' | 'elsewhere';
  /** Its value now; undefined when the service doesn't offer it (the row is left out). */
  read: (s: S) => SettingValue | undefined;
  /** What it may be set to (`choice`). */
  choices?: (s: S) => SettingChoice[];
  /** Its value on the row: “Up to 8 Mbps”, “Required”; a switch's absent: On or Off. */
  words?: (v: SettingValue, s: S) => string;
  /** Its value in a change's old → new: “8 Mbps”; absent: `words`. */
  short?: (v: SettingValue, s: S) => string;
  /** The toast's sentence once the service took it: “Plex now allows up to 20 Mbps outside your home.” */
  sentence?: (v: SettingValue, s: S) => string;
  /** The call that sets it (none for `elsewhere`). */
  write?: (v: SettingValue, s: S) => ActCall;
  /**
   * Fresh read right before writing and again right after, when this setting can be read on its own without reading
   * unrelated sections. Absent: `DeclaredSettings.read`.
   */
  readFresh?: (services: Services, row: CatalogConnectionRow) => Promise<S>;
  /**
   * For a whole-object write, returns the fields of the written object that this setting does not mean to change.
   * After writing, `settingAction` checks that every untouched field still matches what was read before writing, and
   * reports an uncertain outcome instead of done if anything else changed.
   */
  untouched?: (s: S) => unknown;
  /** A line under the sheet's choices, from what Whombat knows. */
  hint?: (s: S) => string | undefined;
  /** Where it is changed instead (`elsewhere`, SST-05): the service's own page for it. */
  elsewhere?: (base: string) => string;
}

export interface SettingGroup {
  id: string;
  title: string;
  /** Questions for its “Ask” (SST-08). */
  ask?: string[];
}

export interface DeclaredSettings<S> {
  /** The service's name in sentences: “Plex”. */
  name: string;
  groups: readonly SettingGroup[];
  specs: readonly SettingSpec<S>[];
  /** Reads the service's settings now (never a kept read): before and after a change. */
  read: (services: Services, row: CatalogConnectionRow) => Promise<S>;
  /** Where the service's own settings live, from its base address; absent: the base address itself. */
  url?: (base: string) => string;
  /** Plain words when reading failed (such as a non-admin key); absent: the generic sentence. */
  unread?: (err: unknown) => string | undefined;
}

/** Choices with the current value added when it is none of them (changed in the service itself). */
export function withCurrent(
  choices: SettingChoice[],
  current: SettingValue | undefined,
  label: (v: SettingValue) => string,
): SettingChoice[] {
  if (current === undefined || choices.some((c) => sameValue(c.value, current))) return choices;
  return [...choices, { value: current, label: label(current) }];
}

/** Two values are the same setting value whatever their type (Plex says `20000` or `"20000"`). */
export function sameValue(a: SettingValue, b: SettingValue): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return asBool(a) === asBool(b);
  return String(a) === String(b);
}

/** A switch's value from what was sent: a boolean, `1`/`0` or their words. */
export function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

/** The row's words for a value. */
export function valueWords<S>(spec: SettingSpec<S>, v: SettingValue, s: S): string {
  if (spec.words) return spec.words(v, s);
  if (spec.kind === 'switch') return asBool(v) ? 'On' : 'Off';
  return spec.choices?.(s).find((c) => sameValue(c.value, v))?.label ?? String(v);
}

function shortWords<S>(spec: SettingSpec<S>, v: SettingValue, s: S): string {
  return spec.short ? spec.short(v, s) : valueWords(spec, v, s);
}

function specOf<S>(d: DeclaredSettings<S>, target: string | undefined): SettingSpec<S> {
  const spec = d.specs.find((s) => s.id === target);
  if (!spec || spec.kind === 'elsewhere' || !spec.write)
    throw badRequest(`${d.name} has no such setting here.`);
  return spec;
}

/**
 * The value to set from what was sent: a switch's boolean, else one of its choices. Put it back's value comes from
 * Whombat's own recipe (`expect` is set) and is taken as it is: the setting had it before.
 */
function wanted<S>(d: DeclaredSettings<S>, spec: SettingSpec<S>, s: S, input: KindActionInput): SettingValue {
  const raw = input.value;
  if (raw === undefined) throw badRequest(`What should ${spec.label} be?`);
  if (input.expect !== undefined) return raw;
  if (spec.kind === 'switch') {
    const b = asBool(raw);
    if (b === null) throw badRequest(`${spec.label} is on or off.`);
    return b;
  }
  const choice = spec.choices?.(s).find((c) => sameValue(c.value, raw));
  if (!choice) throw badRequest(`${d.name} can’t set ${spec.label} to that from here.`);
  return choice.value;
}

/** Returns a copy of `raw` with the named keys omitted (for checking untouched fields of a whole-object write). */
export function omitFields(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const copy = structuredClone(raw);
  for (const key of keys) delete copy[key];
  return copy;
}

/** Deep structural equality for JSON values returned by a whole-object settings read. */
function sameSnapshot(a: unknown, b: unknown): boolean {
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameSnapshot(v, b[i]));
  }
  if (typeof a === 'object') {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const ka = Object.keys(ra);
    const kb = Object.keys(rb);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(rb, k) && sameSnapshot(ra[k], rb[k]));
  }
  return false;
}

async function readNow<S>(d: DeclaredSettings<S>, spec: SettingSpec<S>, ctx: KindActionCtx): Promise<S> {
  const load = spec.readFresh ?? d.read;
  try {
    return await load(ctx.services, ctx.row);
  } catch {
    throw new ApiError('unavailable', `Whombat couldn’t read ${d.name}’s settings just now.`);
  }
}

/** “the setting”'s first letter small inside a sentence (“Remote access” → “remote access”). */
function lower(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/**
 * The `setting` action: reads the setting right before writing, takes only a value it offers, writes it, and reads it
 * back. Done only when the service reports the new value and (for whole-object writes) every untouched field still
 * matches what was read before writing; the change can then be put back.
 */
export function settingAction<S>(d: DeclaredSettings<S>): KindAction {
  return async (ctx, input) => {
    const spec = specOf(d, input.target);
    const load = spec.readFresh ?? d.read;
    const before = await readNow(d, spec, ctx);
    const old = spec.read(before);
    if (old === undefined) throw conflict(`${d.name} doesn’t offer ${lower(spec.label)} here.`);
    const value = wanted(d, spec, before, input);
    if (input.expect !== undefined && !sameValue(old, input.expect))
      throw conflict(`${spec.label} was changed again since, so Whombat won’t put it back.`);
    if (sameValue(old, value))
      return {
        message: `${spec.label} is already ${valueWords(spec, old, before)}.`.slice(0, 200),
        title: `${spec.label} in ${d.name}`,
        unchanged: true,
      };
    await actAs(ctx.services, ctx.row, d.name, (spec.write as NonNullable<typeof spec.write>)(value, before));
    forgetConnectionReads(ctx.services, ctx.row.id);
    const after = await load(ctx.services, ctx.row).catch(() => null);
    const now = after ? spec.read(after) : undefined;
    if (!after || now === undefined)
      return {
        message:
          `Asked ${d.name} to set ${spec.label} to ${valueWords(spec, value, before)}, but Whombat couldn’t check whether it took.`.slice(
            0,
            200,
          ),
        title: `Asked ${d.name} to set ${spec.label} to ${shortWords(spec, value, before)} (not checked)`,
        uncertain: true,
      };
    if (spec.untouched) {
      const untouchedBefore = spec.untouched(before);
      const untouchedAfter = spec.untouched(after);
      if (
        untouchedBefore === undefined ||
        untouchedAfter === undefined ||
        !sameSnapshot(untouchedBefore, untouchedAfter)
      )
        return {
          message:
            `Another setting in ${d.name} changed while Whombat updated ${spec.label}. Check ${d.name}’s settings.`.slice(
              0,
              200,
            ),
          title: `Updated ${spec.label} in ${d.name} (another setting also changed)`,
          uncertain: true,
        };
    }
    if (!sameValue(now, value)) {
      if (sameValue(now, old))
        throw new ApiError(
          'unavailable',
          `${d.name} didn’t take the change. It still says ${valueWords(spec, now, after)}.`,
        );
      return {
        message:
          `Asked ${d.name} to set ${spec.label} to ${valueWords(spec, value, after)}, but ${d.name} now says ${valueWords(spec, now, after)}.`.slice(
            0,
            200,
          ),
        title: `Asked ${d.name} to set ${spec.label} to ${shortWords(spec, value, after)} (now ${shortWords(spec, now, after)})`,
        uncertain: true,
      };
    }
    const said = spec.sentence?.(value, after) ?? `${spec.label} is now ${valueWords(spec, value, after)}.`;
    return {
      message: `${said} Checked with ${d.name}.`.slice(0, 200),
      title: `Changed ${spec.label} in ${d.name} from ${shortWords(spec, old, before)} to ${shortWords(spec, value, after)}`,
      changeKind: `setting.${spec.id}`,
      detail: shortWords(spec, old, before),
      undo: { target: spec.id, value: old, expect: value },
    };
  };
}

/** A change in the approval card's words: “Change a Plex setting”, “Quality outside your home: 8 → 20 Mbps”. */
export async function describeSetting<S>(
  d: DeclaredSettings<S>,
  ctx: KindActionCtx,
  input: KindActionInput,
): Promise<KindActionWords | null> {
  const spec = d.specs.find((s) => s.id === input.target);
  if (!spec?.write || input.value === undefined) return null;
  const s = await (spec.readFresh ?? d.read)(ctx.services, ctx.row).catch(() => null);
  if (!s) return { title: `Change a ${d.name} setting`, lines: [`${spec.label}: ${String(input.value)}`] };
  let value: SettingValue;
  try {
    value = wanted(d, spec, s, { ...input, expect: undefined });
  } catch {
    return null;
  }
  const old = spec.read(s);
  return {
    title: `Change a ${d.name} setting`,
    lines: [
      `${spec.label}: ${old !== undefined ? `${shortWords(spec, old, s)} → ` : ''}${shortWords(spec, value, s)}`.slice(
        0,
        120,
      ),
    ],
  };
}

/* Who changed it last ------------------------------------------------------------------------------------------------- */

export interface SettingChange {
  byAssistant: boolean;
  at: Date;
  /** The old value in words. */
  from: string | null;
  /** While it can be put back. */
  changeId: string | null;
}

/** The last change of each declared setting from Whombat in the last 7 days, by setting id. */
export async function settingChanges(
  services: Services,
  burrowId: string,
  connectionId: string,
  now: Date,
): Promise<Map<string, SettingChange>> {
  const rows = await services.db
    .select({
      id: changes.id,
      kind: changes.kind,
      agentId: changes.agentId,
      detail: changes.detail,
      undoKind: changes.undoKind,
      undoUntil: changes.undoUntil,
      undoneAt: changes.undoneAt,
      createdAt: changes.createdAt,
    })
    .from(changes)
    .where(
      and(
        eq(changes.burrowId, burrowId),
        eq(changes.subjectKind, 'connection'),
        eq(changes.subjectId, connectionId),
        like(changes.kind, `${SETTING_CHANGE_PREFIX}%`),
        gt(changes.createdAt, new Date(now.getTime() - SETTING_UNDO_MS)),
      ),
    )
    .orderBy(desc(changes.createdAt))
    .limit(60);
  const out = new Map<string, SettingChange>();
  for (const r of rows) {
    const id = r.kind.slice(SETTING_CHANGE_PREFIX.length);
    if (out.has(id)) continue;
    const open =
      !!r.undoKind &&
      !r.undoneAt &&
      (!r.undoUntil || r.undoUntil.getTime() > now.getTime()) &&
      hasUndoer(r.undoKind);
    out.set(id, { byAssistant: !!r.agentId, at: r.createdAt, from: r.detail, changeId: open ? r.id : null });
  }
  return out;
}

/** “today”, “yesterday”, “on 3 Nov”. */
function dayWords(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  if (day(at) === day(now)) return 'today';
  if (day(at) === day(new Date(now.getTime() - 86_400_000))) return 'yesterday';
  return `on ${dayMonth(at, timeZone)}`;
}

/** The row's “Dusty changed this yesterday from 4 Mbps.” (SST-03). */
export function changedWords(
  c: SettingChange,
  assistant: string,
  now: Date,
  timeZone: string,
): ThingSettingChanged {
  const day = dayWords(c.at, now, timeZone);
  const who = c.byAssistant ? assistant : 'You';
  return {
    text: clip(`${who} changed this ${day}${c.from ? ` from ${c.from}` : ''}.`, 160),
    short: clip(`Changed by ${c.byAssistant ? assistant : 'you'} ${day}`, 60),
    ...(c.changeId ? { changeId: c.changeId } : {}),
  };
}

/* The tab --------------------------------------------------------------------------------------------------------- */

export interface SettingsTabInput<S> {
  declared: DeclaredSettings<S>;
  settings: S;
  who: Pick<KindCtx, 'row'>;
  /** The service's own settings page (“All settings in Plex”, “In Plex”). */
  url: string;
  /** The service's base address, passed to per-row `elsewhere` builders when set. */
  baseUrl?: string;
  changed: Map<string, SettingChange>;
  assistant: string;
  now: Date;
  timeZone: string;
}

/** One setting's row. */
export function settingRow<S>(input: SettingsTabInput<S>, spec: SettingSpec<S>): ThingSetting | null {
  const { declared: d, settings: s, who } = input;
  const v = spec.read(s);
  if (v === undefined) return null;
  const change = input.changed.get(spec.id);
  const base = {
    id: spec.id,
    label: clip(spec.label, 60),
    help: clip(spec.help, 200),
    value: clip(valueWords(spec, v, s), 60),
    ...(change ? { changed: changedWords(change, input.assistant, input.now, input.timeZone) } : {}),
  };
  if (spec.kind === 'elsewhere')
    return {
      ...base,
      elsewhere: {
        label: `In ${d.name}`.slice(0, 30),
        url: spec.elsewhere ? spec.elsewhere(input.baseUrl ?? input.url) : input.url,
      },
    };
  if (spec.kind === 'switch')
    return {
      ...base,
      on: asBool(v) === true,
      toggle: pageButton(who, { action: SETTING_ACTION, target: spec.id, label: spec.label }),
    };
  const choices = (spec.choices?.(s) ?? []).slice(0, 24);
  if (choices.length < 2)
    return spec.elsewhere
      ? {
          ...base,
          elsewhere: {
            label: `In ${d.name}`.slice(0, 30),
            url: spec.elsewhere(input.baseUrl ?? input.url),
          },
        }
      : base;
  const current = choices.find((c) => sameValue(c.value, v))?.value ?? null;
  const hint = spec.hint?.(s);
  return {
    ...base,
    choose: {
      button: pageButton(who, { action: SETTING_ACTION, target: spec.id, label: 'Change' }),
      current,
      help: clip(spec.sheetHelp ?? spec.help, 200),
      ...(hint ? { hint: clip(hint, 200) } : {}),
      choices: choices.map((c) => ({
        value: typeof c.value === 'string' ? c.value.slice(0, 100) : c.value,
        label: clip(c.label, 60),
        ...(c.note ? { note: clip(c.note, 80) } : {}),
      })),
    },
  };
}

/**
 * The service's settings tab's panels: a line first, one `settings` card per group (each with its Ask), and
 * “Something else?” last.
 */
export function settingsPanels<S>(input: SettingsTabInput<S>): ThingPagePanel[] {
  const { declared: d, assistant } = input;
  const groupPanels: ThingPagePanel[] = [];
  let hasWritable = false;
  // The first half of the groups on the left, the rest on the right (the mock's two columns).
  const half = Math.ceil(d.groups.length / 2);
  d.groups.forEach((g, i) => {
    const rows = d.specs
      .filter((spec) => spec.group === g.id)
      .map((spec) => settingRow(input, spec))
      .filter((r): r is ThingSetting => r !== null);
    if (!rows.length) return;
    if (rows.some((r) => r.toggle !== undefined || r.choose !== undefined)) hasWritable = true;
    groupPanels.push({
      kind: 'settings',
      id: `settings-${g.id}`.slice(0, 40),
      place: i < half ? 'main' : 'side',
      title: clip(g.title, 60),
      rows,
      ...(g.ask?.length ? { ask: { questions: g.ask.slice(0, 3).map((q) => clip(q, 200)) } } : {}),
    });
  });
  return [
    {
      kind: 'text',
      id: 'settings-intro',
      place: 'top',
      body: hasWritable
        ? `The settings that matter most, in plain words. Change one here, or ask ${assistant} to do it for you.`
        : `The settings that matter most, in plain words. They stay in ${d.name} so nothing here can overwrite other settings there.`,
      link: { kind: 'url', label: `All settings in ${d.name}`.slice(0, 30), url: input.url },
    },
    ...groupPanels,
    {
      kind: 'text',
      id: 'settings-more',
      place: 'bottom',
      title: 'Something else?',
      body: hasWritable
        ? `${assistant} can change any other ${d.name} setting for you. It asks you first.`
        : `${assistant} can help you check or plan changes to ${d.name}’s settings.`,
      link: {
        kind: 'ask',
        label: `Ask ${assistant}`.slice(0, 30),
        question: hasWritable
          ? `I’d like to change another ${d.name} setting.`
          : `Help me with my ${d.name} settings.`,
      },
    },
  ];
}

/** A connection's base address without trailing slashes. */
function serviceBaseUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

/** The service's settings tab: its cards, or why it couldn't be read with a link to the service. */
export async function settingsTab<S>(ctx: KindCtx, declared: DeclaredSettings<S>): Promise<ThingPageTab> {
  const { services, row, now } = ctx;
  const base = serviceBaseUrl(row);
  const url = declared.url ? declared.url(base) : base;
  let readError: unknown = null;
  const [current, changed, agent] = await Promise.all([
    cachedRead<S>(
      services,
      `settings:${row.catalogId}:${row.id}`,
      row,
      () =>
        withDeadline(
          declared.read(services, row),
          KIND_DEADLINE_MS,
          `${declared.name} didn’t answer in time.`,
        ),
      SETTINGS_KEEP_MS,
    ).catch((err: unknown) => {
      readError = err;
      return null;
    }),
    settingChanges(services, ctx.burrowId, row.id, now).catch(() => new Map<string, SettingChange>()),
    loadAgentRow(services.db, ctx.burrowId).catch(() => undefined),
  ]);
  const tab = { key: SERVICE_SETTINGS_TAB_KEY, label: clip(`${declared.name} settings`, 30) };
  if (!current) {
    const body =
      declared.unread?.(readError) ??
      `Whombat couldn’t read ${declared.name}’s settings just now. Try again in a moment, or change them in ${declared.name}.`;
    return {
      ...tab,
      panels: [
        {
          kind: 'text',
          id: 'settings-unread',
          title: clip(`${declared.name} settings`, 60),
          body: clip(body, 280),
          link: { kind: 'url', label: clip(`Open ${declared.name}`, 30), url },
        },
      ],
    };
  }
  return {
    ...tab,
    panels: settingsPanels({
      declared,
      settings: current,
      who: { row },
      url,
      baseUrl: base,
      changed,
      assistant: assistantCalled(agent?.name),
      now,
      timeZone: ctx.timeZone,
    }),
  };
}

/** Bundles a service's declared settings for `KindModule.settings`. */
export function declaredSettings<S>(declared: DeclaredSettings<S>): KindSettings {
  return {
    name: declared.name,
    tab: (ctx) => settingsTab(ctx, declared),
    action: settingAction(declared),
    describe: (ctx, input) => describeSetting(declared, ctx, input),
  };
}
