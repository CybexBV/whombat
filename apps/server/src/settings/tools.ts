/**
 * The assistant's settings tools (docs/decisions/assistant-settings.md): `settings_find`, `settings_read`,
 * `settings_change` and `settings_open`, in a turn for the person. A setting is one operation of the session allowlist;
 * the settings map (`@whombat/protocol` `ASSISTANT_SETTINGS`) says what the assistant may do with it and where it is.
 * Reads and changes run as the person through the session dispatcher, the same path their device's request takes; a
 * change first goes through the commit pipeline with the `settings.change` key (`changeSetting`), so the person's
 * choice decides whether it goes ahead, asks on a card or is refused, and a destructive change always asks.
 */
import type {
  SettingsChangeInput,
  SettingsChangeOutput,
  SettingsFindInput,
  SettingsFindOutput,
  SettingsOpenInput,
  SettingsOpenOutput,
  SettingsReadInput,
  SettingsReadOutput,
} from '@whombat/core';
import {
  type AssistantSetting,
  assistantAccessFor,
  assistantSetting,
  createOperationAllowlist,
  type OperationSpec,
  pageWords,
  SETTINGS_PAGE_IDS,
  SETTINGS_PAGES,
  type SettingsPageId,
  settingsOps,
} from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ChangedWhileAskedError, changedWhileAskedText } from '../connections/call-target';
import type { Db } from '../db/client';
import { accounts, burrows } from '../db/schema/index';
import { postAskCard } from '../guides/ask';
import { makeCard } from '../guides/flows';
import { tServer } from '../i18n/catalog';
import type { RequestAnswer } from '../managed/dispatcher';
import { sessionDispatcherOf } from '../managed/dispatcher-ref';
import type { ToolContext } from '../mcp/tools';
import { shortName } from '../read/principals';
import { askThingAction } from '../things/actions';
import { ownTurn } from '../vault/self-serve';
import { changeSetting, runBound, thingCardWords } from './command';

type FindIn = z.output<typeof SettingsFindInput>;
type ReadIn = z.output<typeof SettingsReadInput>;
type ChangeIn = z.output<typeof SettingsChangeInput>;
type OpenIn = z.output<typeof SettingsOpenInput>;

/** What the tools answer the agent with (to the agent, never the chat). */
export const SETTINGS_TOOL_TEXT = {
  notHere: 'Only in a turn for the person: their settings are theirs.',
  unknown: (op: string) => `There is no setting ${op}. Look it up with settings_find.`,
  never: (where: string) =>
    `That one stays the person’s: they do it in ${where}. Offer them settings_open to get there.`,
  neverPart: (where: string) =>
    `That part of it stays the person’s: they change it in ${where}. Offer them settings_open to get there.`,
  notARead: (op: string) => `${op} changes something: use settings_change, only when the person asked.`,
  notAChange: (op: string) => `${op} only reads: use settings_read.`,
  unavailable: 'This Whombat can’t run its settings now (it is getting ready for an update, or has no box).',
  blocked: (where: string) =>
    `The person set changing settings to Just watch. Tell them where it is: ${where} (settings_open).`,
  unknownPage: (page: string) => `There is no page ${page}. The pages: ${SETTINGS_PAGE_IDS.join(', ')}.`,
} as const;

/** Longest op answer handed back as JSON; a longer one is cut and marked. */
export const VALUE_MAX = 12_000;
/** Most settings one find answers with; the first few carry their input schema. */
const FIND_MAX = 12;
const FIND_WITH_INPUT = 5;
/** Longest input schema shown; a larger one is left out (find the op by name to see only it). */
const SCHEMA_MAX = 6000;

const failed = (
  reason: 'not_here' | 'unknown' | 'never' | 'wrong_tool' | 'invalid' | 'refused' | 'unavailable',
  message: string,
) => ({ status: 'failed' as const, reason, message });

let allowlist: ReturnType<typeof createOperationAllowlist> | null = null;
/** The appliance's allowlist (pure; built once). */
function specOf(op: string): OperationSpec | undefined {
  allowlist ??= createOperationAllowlist();
  return allowlist.get(op);
}

/** “Wi-Fi”, “wifi” and “wi fi” are one word to a search. */
const fold = (s: string) => s.toLowerCase().replace(/[-_.\s’']+/g, '');
const tokens = (q: string) =>
  q
    .toLowerCase()
    .split(/[\s,;]+/)
    .map(fold)
    .filter((t) => t.length >= 2);

/** The place of a setting with the assistant's name in it. */
function whereOf(
  e: AssistantSetting,
  agent: string,
  locale?: string | null,
): { page: SettingsPageId; where: string; about: string } {
  const page = (e.page ?? 'you.profile') as SettingsPageId;
  const p = pageWords(page, agent, locale);
  return { page, where: p.where, about: p.about };
}

/** Whether an `api` op takes the Whombat's slug in its params: Whombat fills it in. */
function takesBurrow(spec: OperationSpec): boolean {
  const params = spec.endpoint?.params as unknown as { shape?: Record<string, unknown> } | undefined;
  return spec.source === 'api' && !!params?.shape && 'burrow' in params.shape;
}

/**
 * The JSON Schema of an op's input as the agent fills it: `params.burrow` left out (Whombat fills it in), null when the
 * schema can't be written as JSON or is larger than `SCHEMA_MAX`.
 */
export function inputSchemaOf(spec: OperationSpec): Record<string, unknown> | null {
  let schema: Record<string, unknown>;
  try {
    schema = z.toJSONSchema(spec.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return null;
  }
  delete schema.$schema;
  const params = (schema.properties as Record<string, Record<string, unknown>> | undefined)?.params;
  if (params?.properties && typeof params.properties === 'object') {
    delete (params.properties as Record<string, unknown>).burrow;
    if (Array.isArray(params.required)) params.required = params.required.filter((r) => r !== 'burrow');
  }
  return JSON.stringify(schema).length > SCHEMA_MAX ? null : schema;
}

/** The op's input with this Whombat's slug in `params.burrow` where its endpoint takes one. */
export function withBurrow(spec: OperationSpec, input: Record<string, unknown> | undefined, slug: string) {
  const given = input ?? {};
  if (!takesBurrow(spec)) return given;
  const params = (given.params && typeof given.params === 'object' ? given.params : {}) as Record<
    string,
    unknown
  >;
  return { ...given, params: { ...params, burrow: slug } };
}

/** An op's answer for the agent: the JSON as it is, or cut at `VALUE_MAX` characters and marked. */
export function clipValue(value: unknown): { value: unknown; truncated: boolean } {
  const text = JSON.stringify(value ?? null);
  if (text.length <= VALUE_MAX) return { value: value ?? null, truncated: false };
  return { value: `${text.slice(0, VALUE_MAX)}…`, truncated: true };
}

/** A refusal of the op, in the words the agent passes on (its own message, the fields it named). */
export function refusalOf(answer: Extract<RequestAnswer, { type: 'error' }>) {
  const fields = answer.fields
    ? ` (${Object.entries(answer.fields)
        .map(([k, v]) => `${k}: ${v.join(', ')}`)
        .join('; ')})`
    : '';
  const message = `${answer.message}${fields}`.slice(0, 1000);
  if (answer.code === 'unavailable' || answer.code === 'deadline_exceeded')
    return failed('unavailable', message);
  if (answer.code === 'bad_request' || answer.code === 'validation_failed') return failed('invalid', message);
  return failed('refused', message);
}

async function slugOf(db: Db, burrowId: string): Promise<string | null> {
  const [row] = await db.select({ slug: burrows.slug }).from(burrows).where(eq(burrows.id, burrowId));
  return row?.slug ?? null;
}

async function accountOf(db: Db, accountId: string) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return row ?? null;
}

/** The turn's person, their account and the Whombat's slug; null outside a turn for the person. */
async function personOf(ctx: ToolContext) {
  const turn = await ownTurn(ctx.services.db, ctx);
  if (!turn?.person.accountId) return null;
  const [account, slug] = await Promise.all([
    accountOf(ctx.services.db, turn.person.accountId),
    slugOf(ctx.services.db, ctx.burrowId),
  ]);
  if (!account || !slug) return null;
  const locale = (account.preferences as { locale?: string | null } | null)?.locale ?? null;
  return { turn, account, slug, agent: shortName(turn.agent), locale };
}

/* settings_find ---------------------------------------------------------------------------------------------- */

/** How well a setting matches the asked words: every word counts once, matching both English and localized labels. */
function score(op: string, e: AssistantSetting, agent: string, words: readonly string[]): number {
  if (!words.length) return 0;
  const en = whereOf(e, agent, 'en');
  const nl = whereOf(e, agent, 'nl');
  const name = fold(op);
  const text = fold(`${e.words ?? ''} ${en.where} ${en.about} ${nl.where} ${nl.about}`);
  let n = 0;
  for (const w of words) {
    if (name.includes(w)) n += 3;
    else if (text.includes(w)) n += 1;
    else return 0;
  }
  return n;
}

export async function settingsFindTool(ctx: ToolContext, input: FindIn): Promise<SettingsFindOutput> {
  const who = await personOf(ctx);
  if (!who) return failed('not_here', SETTINGS_TOOL_TEXT.notHere);
  const query = input.query.trim();
  const exact = assistantSetting(query).access !== 'none' ? query : null;
  const words = tokens(query);
  const matches = exact
    ? [exact]
    : settingsOps()
        .map((op) => ({ op, n: score(op, assistantSetting(op), who.agent, words) }))
        .filter((m) => m.n > 0)
        .sort((a, b) => b.n - a.n || a.op.localeCompare(b.op))
        .map((m) => m.op);
  const settings = matches.slice(0, FIND_MAX).map((op, i) => {
    const e = assistantSetting(op);
    const place = whereOf(e, who.agent, who.locale);
    const spec = specOf(op);
    const access = e.access as 'never' | 'read' | 'change' | 'ask';
    const schema = access !== 'never' && spec && i < FIND_WITH_INPUT ? inputSchemaOf(spec) : null;
    return {
      op,
      words: e.words ?? op,
      where: place.where,
      page: place.page,
      access,
      ...(schema ? { input: schema } : {}),
    };
  });
  return {
    status: 'ok',
    settings,
    more: Math.max(0, matches.length - settings.length),
    ...(query
      ? {}
      : {
          pages: SETTINGS_PAGE_IDS.map((page) => {
            const p = pageWords(page, who.agent, who.locale);
            return { page, where: p.where, about: p.about };
          }),
        }),
  };
}

/* settings_read ---------------------------------------------------------------------------------------------- */

export async function settingsReadTool(ctx: ToolContext, input: ReadIn): Promise<SettingsReadOutput> {
  const who = await personOf(ctx);
  if (!who) return failed('not_here', SETTINGS_TOOL_TEXT.notHere);
  const e = assistantSetting(input.op);
  const spec = specOf(input.op);
  if (e.access === 'none' || !spec) return failed('unknown', SETTINGS_TOOL_TEXT.unknown(input.op));
  if (e.access === 'never')
    return failed('never', SETTINGS_TOOL_TEXT.never(whereOf(e, who.agent, who.locale).where));
  if (e.access !== 'read') return failed('wrong_tool', SETTINGS_TOOL_TEXT.notARead(input.op));
  const dispatcher = sessionDispatcherOf(ctx.services);
  if (!dispatcher) return failed('unavailable', SETTINGS_TOOL_TEXT.unavailable);
  const answer = await dispatcher.runForAssistant(
    who.account,
    ctx.agentId,
    input.op,
    withBurrow(spec, input.input, who.slug),
  );
  if (answer.type === 'error') return refusalOf(answer);
  if (answer.type === 'redacted') return { status: 'ok', op: input.op, value: null, truncated: false };
  return { status: 'ok', op: input.op, ...clipValue(answer.output) };
}

/* settings_change -------------------------------------------------------------------------------------------- */

export async function settingsChangeTool(ctx: ToolContext, input: ChangeIn): Promise<SettingsChangeOutput> {
  const who = await personOf(ctx);
  if (!who) return failed('not_here', SETTINGS_TOOL_TEXT.notHere);
  const e = assistantSetting(input.op);
  const spec = specOf(input.op);
  if (e.access === 'none' || !spec) return failed('unknown', SETTINGS_TOOL_TEXT.unknown(input.op));
  const place = whereOf(e, who.agent, who.locale);
  if (e.access === 'never') return failed('never', SETTINGS_TOOL_TEXT.never(place.where));
  if (e.access === 'read') return failed('wrong_tool', SETTINGS_TOOL_TEXT.notAChange(input.op));
  const full = withBurrow(spec, input.input, who.slug);
  // A guarded part of the input (a connection's address or access) stays the person's though the rest is a change.
  if (assistantAccessFor(input.op, full) === 'never')
    return failed('never', SETTINGS_TOOL_TEXT.neverPart(place.where));
  const dispatcher = sessionDispatcherOf(ctx.services);
  if (!dispatcher) return failed('unavailable', SETTINGS_TOOL_TEXT.unavailable);
  // Asked with an input the op refuses: say so now, before a card asks the person about something that can't run.
  const parsed = spec.input.safeParse(full);
  if (!parsed.success)
    return failed(
      'invalid',
      parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; '),
    );
  // A service's declared setting or a page action, from one read of its connection: the card says what changes in
  // Whombat's words (SST-04), read from where its yes is bound to; the change runs only while it still goes there.
  const ask = await askThingAction(ctx.services, ctx.burrowId, input.op, full);
  const { targets, changed } = ask;
  if (changed) return failed('refused', changedWhileAskedText(changed));
  let res: Awaited<ReturnType<typeof ctx.services.pipeline.commit<typeof changeSetting.schema, unknown>>>;
  try {
    res = await ctx.services.pipeline.commit(
      changeSetting,
      {
        op: input.op,
        input: full as Record<string, unknown>,
        conversationId: ctx.dispatch.conversationId,
        ...thingCardWords(ask, input.op),
        ...(Object.keys(targets).length ? { targets } : {}),
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
  } catch (err) {
    // Its connection went elsewhere after the card's words were read: no card, nothing changed.
    if (err instanceof ChangedWhileAskedError) return failed('refused', err.message);
    throw err;
  }
  if (res.status === 'pending_approval')
    return { status: 'pending_approval', approvalId: res.approvalId, message: res.message };
  if (res.status === 'blocked')
    return { status: 'blocked', message: SETTINGS_TOOL_TEXT.blocked(place.where), where: place.where };
  const answer = await runBound(ctx.services, targets, changedWhileAskedText, () =>
    dispatcher.runForAssistant(who.account, ctx.agentId, input.op, full),
  );
  if (answer.type === 'error') return refusalOf(answer);
  if (answer.type === 'redacted') return { status: 'done', op: input.op, value: null, truncated: false };
  return { status: 'done', op: input.op, ...clipValue(answer.output) };
}

/* settings_open ---------------------------------------------------------------------------------------------- */

/** The card's button: “Open Backups” (the page's last part). */
export function openLabel(where: string, locale?: string | null): string {
  const last = where.split('→').pop()?.trim() || tServer(locale, 'settings.open.settings');
  const label = tServer(locale, 'settings.open.page', { page: last });
  return label.length <= 40 ? label : tServer(locale, 'settings.open.it');
}

export async function settingsOpenTool(ctx: ToolContext, input: OpenIn): Promise<SettingsOpenOutput> {
  const who = await personOf(ctx);
  if (!who) return failed('not_here', SETTINGS_TOOL_TEXT.notHere);
  if (!Object.hasOwn(SETTINGS_PAGES, input.page))
    return failed('unknown', SETTINGS_TOOL_TEXT.unknownPage(input.page));
  const page = pageWords(input.page as SettingsPageId, who.agent, who.locale);
  const card = makeCard({
    guide: 'settings',
    node: 'open',
    title: page.where.slice(0, 120),
    body: input.text,
    blocks: [
      {
        type: 'actions',
        actions: [
          {
            id: 'open',
            label: openLabel(page.where, who.locale),
            style: 'primary',
            href: `/${page.path}`,
          },
        ],
      },
    ],
  });
  const messageId = await postAskCard(ctx, card);
  return { status: 'ok', messageId };
}

export const SETTINGS_TOOL_HANDLERS = {
  settings_find: settingsFindTool,
  settings_read: settingsReadTool,
  settings_change: settingsChangeTool,
  settings_open: settingsOpenTool,
} as const;
