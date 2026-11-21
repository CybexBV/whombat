/**
 * Who sits on a council (docs/decisions/council.md CNL-04, CNL-50…CNL-53), from T3 Code's `orchestrator_capabilities`.
 * Pure: T3 Code's answer and the person's choice in, the seats out.
 *
 * - T3 Code's own council (`t3CouncilSeats`), which every council sits unless the person names members for it: who sits
 *   is its council skill's, which T3 Code doesn't tell; the seats are the ones its last council sat, else Whombat's guess
 *   (`automaticSeats`), and they follow the reviewers the lead starts.
 * - Whombat's guess (`automaticSeats`): one per provider T3 Code can run now (switched on, signed in, with models),
 *   at most four, in T3 Code's order; each provider's best model — T3 Code's own council's choice where it has it, else
 *   the first it lists — at `xhigh` where it offers it, else `high`, else its default.
 * - The members the person named for one council (`pickSeats`): their words for providers, models and efforts.
 *
 * A council needs two different providers; one provider may sit twice with different models (allowed, not preferred).
 */
import {
  COUNCIL_MEMBERS_MAX,
  COUNCIL_PROVIDERS_MIN,
  type CouncilMark,
  type CouncilProviderOption,
  type CouncilSeatSetup,
  type DelegationAi,
} from '@whombat/core';
import type { CouncilSeat } from '../db/schema/councils';
import { list, rec, str } from '../things/words';

/** A provider T3 Code can run now, with its models in its order. */
export interface T3Provider {
  instanceId: string;
  name: string;
  models: {
    id: string;
    label: string | null;
    options: { id: string; values: (string | boolean)[]; default: string | boolean | null }[];
  }[];
}

/** How many seats Whombat's guess has, as many as T3 Code's council skill sits. */
export const COUNCIL_SEATS_DEFAULT = 4;

/**
 * The models T3 Code's own council sits (its skill's defaults on the build server), best first: where a provider has one of
 * these, it sits the first it has; any other provider sits the first model T3 Code lists.
 */
const PREFERRED_MODELS: Record<string, readonly string[]> = {
  codex: ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-astra'],
  claudeAgent: ['claude-opus-5-5', 'claude-fable-5-2'],
  muse: ['muse-wonder-full-1.0'],
  antigravity: ['gemini-4-neon'],
};

/**
 * The name a council started as T3 Code's own carries (`councils.setup_name`): its seats follow the reviewers its lead
 * starts, and the next one starts on the seats it sat.
 */
export const T3_COUNCIL = 'T3 Code';

/**
 * Whether an option is how hard a model thinks: Codex's `reasoningEffort`, Claude's and Muse's `effort`, Antigravity's
 * `thought_level`.
 */
export const isEffortOption = (id: string) => /effort|thought_level/i.test(id);

/** The providers T3 Code can run now: no constraint (switched off, not signed in, not installed) and some models. */
export function providersOf(body: unknown): T3Provider[] {
  return list(rec(body).providers)
    .map(rec)
    .flatMap((p): T3Provider[] => {
      const instanceId = str(p.providerInstanceId);
      if (!instanceId || instanceId.length > 40) return [];
      if (list(p.constraints).length) return [];
      const models = list(p.models)
        .map(rec)
        .flatMap((m) => {
          const id = str(m.id);
          if (!id || id.length > 80) return [];
          const options = list(m.options)
            .map(rec)
            .flatMap((o) => {
              const oid = str(o.id);
              const values = list(o.values).filter(
                (v): v is string | boolean => typeof v === 'string' || typeof v === 'boolean',
              );
              const def = o.default;
              return oid
                ? [
                    {
                      id: oid,
                      values,
                      default: typeof def === 'string' || typeof def === 'boolean' ? def : null,
                    },
                  ]
                : [];
            });
          return [{ id, label: str(m.label)?.slice(0, 60) ?? null, options }];
        });
      if (!models.length) return [];
      return [{ instanceId, name: (str(p.displayName) ?? instanceId).slice(0, 40), models }];
    });
}

/** “gpt-6.1-sol” → “GPT 6.1 Sol”; T3 Code's own label when it gives one. */
export function modelLabel(model: { id: string; label: string | null }): string {
  if (model.label) return model.label;
  const words = model.id
    .split(/[-_\s/]+/)
    .filter(Boolean)
    .map((w) => (/^(gpt|ai|llm)$/i.test(w) ? w.toUpperCase() : w[0]?.toUpperCase() + w.slice(1)));
  return words.join(' ').slice(0, 60) || model.id.slice(0, 60);
}

type T3Model = T3Provider['models'][number];

/** A model's effort option: its id (“effort”, “reasoningEffort”), the values it takes and its default; null: none. */
function effortOption(model: T3Model): { id: string; values: string[]; default: string | null } | null {
  const option = model.options.find((o) => isEffortOption(o.id));
  if (!option) return null;
  const values = option.values.filter((v): v is string => typeof v === 'string');
  return { id: option.id, values, default: typeof option.default === 'string' ? option.default : null };
}

/**
 * A model's fast tier: Codex's `serviceTier` (`priority` is fast) or a boolean option named fast (Claude's `fastMode`),
 * the values for on and off, and whether it is on unless chosen; null: it has none.
 */
function fastOption(
  model: T3Model,
): { id: string; on: string | boolean; off: string | boolean; byDefault: boolean } | null {
  const tier = model.options.find((o) => /servicetier/i.test(o.id) && o.values.includes('priority'));
  if (tier) {
    const off = tier.values.find((v) => v !== 'priority') ?? 'default';
    return { id: tier.id, on: 'priority', off, byDefault: tier.default === 'priority' };
  }
  const flag = model.options.find((o) => /fast/i.test(o.id) && o.values.every((v) => typeof v === 'boolean'));
  return flag ? { id: flag.id, on: true, off: false, byDefault: flag.default === true } : null;
}

/** The AI a task runs with, as the card shows it, from a task's (or a delegation's) provider, model and options. */
export function delegationAiOf(row: {
  provider: string | null;
  model: string | null;
  modelLabel: string | null;
  options: { id: string; value: string | boolean }[] | null;
}): DelegationAi | null {
  if (!row.provider || !row.model) return null;
  const options = row.options ?? [];
  const effort = options.find((o) => isEffortOption(o.id))?.value;
  const tier = options.find((o) => /servicetier/i.test(o.id));
  const flag = options.find((o) => /fast/i.test(o.id) && typeof o.value === 'boolean');
  return {
    provider: row.provider.slice(0, 40),
    model: row.model.slice(0, 80),
    label: (row.modelLabel ?? modelLabel({ id: row.model, label: null })).slice(0, 60),
    effort: typeof effort === 'string' ? effort.slice(0, 20) : null,
    fast: tier ? tier.value === 'priority' : flag ? flag.value === true : null,
  };
}

/**
 * The person's choice of a task's AI on the checklist against what T3 Code runs now: the provider, model, its name and
 * the options to send (the effort and fast tier they chose; what they left to the model is left out). Null when T3 Code
 * can't run that model now, or the model doesn't take that effort.
 */
export function chosenAi(
  providers: readonly T3Provider[],
  choice: { provider: string; model: string; effort: string | null; fast: boolean | null },
): {
  provider: string;
  model: string;
  modelLabel: string;
  options: { id: string; value: string | boolean }[];
} | null {
  const p = providers.find((x) => x.instanceId === choice.provider);
  const m = p?.models.find((x) => x.id === choice.model);
  if (!p || !m) return null;
  const options: { id: string; value: string | boolean }[] = [];
  if (choice.effort !== null) {
    const effort = effortOption(m);
    if (!effort?.values.includes(choice.effort)) return null;
    options.push({ id: effort.id, value: choice.effort });
  }
  const fast = choice.fast === null ? null : fastOption(m);
  if (fast) options.push({ id: fast.id, value: choice.fast ? fast.on : fast.off });
  return { provider: p.instanceId, model: m.id, modelLabel: modelLabel(m), options };
}

/** The most thinking Whombat asks for unless told: `xhigh`, else `high`, else the model's own. */
function strongest(values: readonly string[]): string | null {
  for (const want of ['xhigh', 'high']) if (values.includes(want)) return want;
  return null;
}

/** The mark a provider shows with (CNL-44): Claude's, OpenAI's for Codex, else none (its first letter). */
export function markOf(instanceId: string, driver?: string | null): CouncilMark | null {
  const id = `${instanceId} ${driver ?? ''}`.toLowerCase();
  if (/claude/.test(id)) return 'claude';
  if (/codex|openai|gpt/.test(id)) return 'openai';
  return null;
}

/** A person's word for a provider (“ChatGPT”, “claude”, “Muse”) against T3 Code's instance ids and names. */
function matches(p: T3Provider, word: string): boolean {
  const w = word.trim().toLowerCase();
  const names = [p.instanceId, p.name].map((n) => n.toLowerCase());
  if (names.some((n) => n === w || n.startsWith(w) || w.startsWith(n))) return true;
  if (/chatgpt|openai|gpt/.test(w)) return /codex/.test(names.join(' '));
  return false;
}

/** A provider's best model: T3 Code's own council's choice where it has it, else the first it lists. */
function bestModel(p: T3Provider): T3Model | undefined {
  for (const id of PREFERRED_MODELS[p.instanceId] ?? []) {
    const model = p.models.find((m) => m.id === id);
    if (model) return model;
  }
  return p.models[0];
}

/**
 * A seat for a provider's model. `effort` undefined: the most thinking (`strongest`); null: the model's own default; a
 * value the model takes: that one, else the most thinking (`changed`).
 */
function seatAt(
  p: T3Provider,
  model: T3Model,
  effort?: string | null,
): { seat: CouncilSeat; changed: boolean } {
  const option = effortOption(model);
  let value: string | null = null;
  let changed = false;
  if (option) {
    if (effort === undefined) value = strongest(option.values);
    else if (effort !== null) {
      value = option.values.includes(effort) ? effort : strongest(option.values);
      changed = !option.values.includes(effort);
    }
  } else changed = !!effort;
  return {
    seat: {
      provider: p.instanceId,
      providerName: p.name,
      model: model.id,
      label: modelLabel(model),
      options: option && value ? [{ id: option.id, value }] : [],
    },
    changed,
  };
}

/**
 * The AI a person named for one task handed to T3 Code (delegate.md): their word for a provider, and a model when they
 * said one (else the provider's best), at the model's own effort. Null when T3 Code can't run it now.
 */
export function oneSeat(
  providers: readonly T3Provider[],
  provider: string,
  model?: string | undefined,
): { provider: string; model: string; label: string } | null {
  const p = providers.find((x) => matches(x, provider));
  if (!p) return null;
  const want = model?.trim().toLowerCase();
  const m = want
    ? p.models.find((x) => x.id.toLowerCase() === want || x.label?.toLowerCase() === want)
    : bestModel(p);
  return m ? { provider: p.instanceId, model: m.id, label: modelLabel(m) } : null;
}

/**
 * The lead's seat: the chat's own AI (its company, model and effort, as the person picked it for the thread or the
 * assistant's own) as T3 Code runs it. A model T3 Code lists under another name (`opus`, `claude-fable-5-2[1m]`) is
 * matched by its name; one it doesn't have gives way to the company's best. Null when T3 Code can't run that company.
 */
export function chatSeat(
  providers: readonly T3Provider[],
  runtime: { provider: string; model?: string | undefined; effort?: string | undefined },
): CouncilSeat | null {
  const p = providers.find((x) => matches(x, runtime.provider));
  if (!p) return null;
  const want = runtime.model
    ?.replace(/\[.*\]$/, '')
    .trim()
    .toLowerCase();
  const model =
    (want &&
      (p.models.find((m) => m.id.toLowerCase() === want || m.label?.toLowerCase() === want) ??
        p.models.find((m) => m.id.toLowerCase().includes(want)))) ||
    bestModel(p);
  if (!model) return null;
  const takes = effortOption(model)?.values.includes(runtime.effort ?? '');
  return seatAt(p, model, takes ? runtime.effort : undefined).seat;
}

/** A seat's provider, model and effort as Settings keeps them. */
export function seatSetupOf(seat: CouncilSeat): CouncilSeatSetup {
  const effort = seat.options.find((o) => isEffortOption(o.id))?.value;
  return { provider: seat.provider, model: seat.model, effort: typeof effort === 'string' ? effort : null };
}

/** What T3 Code can run now, for choosing seats in Settings. */
export function providerOptions(providers: readonly T3Provider[]): CouncilProviderOption[] {
  return providers.map((p) => ({
    id: p.instanceId,
    name: p.name,
    models: p.models.slice(0, 30).map((m) => {
      const option = effortOption(m);
      return {
        id: m.id,
        label: modelLabel(m),
        efforts: (option?.values ?? []).slice(0, 12),
        defaultEffort: option?.default ?? null,
        fast: fastOption(m)?.byDefault ?? null,
      };
    }),
  }));
}

export type SeatPick =
  | { ok: true; seats: CouncilSeat[]; notes: string[] }
  | { ok: false; reason: 'not_enough_providers'; message: string };

/** The end of every pick: two different providers at least, else why not. */
function enough(
  providers: readonly T3Provider[],
  seats: CouncilSeat[],
  notes: string[],
  missing: string[],
): SeatPick {
  if (seats.length >= 2 && new Set(seats.map((s) => s.provider)).size >= COUNCIL_PROVIDERS_MIN)
    // Who was asked for and can't sit is said too.
    return {
      ok: true,
      seats,
      notes: [...missing.map((m) => `T3 Code can’t run ${m} now, so the council goes without it.`), ...notes],
    };
  const can = providers.map((p) => p.name);
  const message = missing.length
    ? `T3 Code can’t run ${missing.join(' or ')} now. It can run ${can.length ? can.join(', ') : 'nothing'}; a council needs two different ones.`
    : can.length >= 2
      ? 'A council needs AIs from two different companies.'
      : can.length
        ? `A council needs two different AI providers, and T3 Code can only run ${can.join(', ')} now. Sign in to another one in T3 Code first.`
        : 'T3 Code can’t run any AI provider now. Sign in to two of them in T3 Code first.';
  return { ok: false, reason: 'not_enough_providers', message };
}

const sameSeat = (a: CouncilSeat, b: CouncilSeat) => a.provider === b.provider && a.model === b.model;

/** Whombat's own seats: one per provider T3 Code can run, at most `COUNCIL_SEATS_DEFAULT`. */
export function automaticSeats(providers: readonly T3Provider[]): SeatPick {
  const seats: CouncilSeat[] = [];
  for (const p of providers) {
    if (seats.length >= COUNCIL_SEATS_DEFAULT) break;
    const model = bestModel(p);
    if (model) seats.push(seatAt(p, model).seat);
  }
  return enough(providers, seats, [], []);
}

/**
 * The members the person named for this council: their words for each provider (“ChatGPT”, “claude”), a model and an
 * effort when they said one. A provider named again sits its next model.
 */
export function pickSeats(
  providers: readonly T3Provider[],
  asked: readonly { provider: string; model?: string | undefined; effort?: string | undefined }[],
): SeatPick {
  const seats: CouncilSeat[] = [];
  const notes: string[] = [];
  const missing: string[] = [];
  for (const a of asked.slice(0, COUNCIL_MEMBERS_MAX)) {
    const p = providers.find((x) => matches(x, a.provider));
    const want = a.model?.trim().toLowerCase();
    const model = !p
      ? undefined
      : want
        ? p.models.find((m) => m.id.toLowerCase() === want || m.label?.toLowerCase() === want)
        : // Named again without a model: its next model, not the same one twice.
          [bestModel(p), ...p.models].find(
            (m) => m && !seats.some((x) => x.provider === p.instanceId && x.model === m.id),
          );
    if (!p || !model) {
      missing.push(a.model ? `${a.provider} (${a.model})` : a.provider);
      continue;
    }
    const { seat, changed } = seatAt(p, model, a.effort);
    if (changed) notes.push(`${seat.label} can’t think at “${a.effort}”, so it thinks as hard as it can.`);
    if (!seats.some((x) => sameSeat(x, seat))) seats.push(seat);
  }
  return enough(providers, seats, notes, missing);
}

/** A reviewer T3 Code's last council sat: its company, model and options, in its seat's order. */
export interface SatSeat {
  provider: string;
  model: string;
  options: readonly { id: string; value: string | boolean }[];
}

/**
 * T3 Code's own council as Whombat expects it: the seats its last council sat, each as T3 Code runs it now (a model
 * it no longer has, or a company it can't run, is left out), else Whombat's guess when they aren't two companies. Its
 * lead sits its council skill's members either way, and the seats follow them.
 */
export function t3CouncilSeats(providers: readonly T3Provider[], sat: readonly SatSeat[]): SeatPick {
  const seats: CouncilSeat[] = [];
  for (const s of sat.slice(0, COUNCIL_MEMBERS_MAX)) {
    const p = providers.find((x) => x.instanceId === s.provider);
    const model = p?.models.find((m) => m.id === s.model);
    if (!p || !model) continue;
    const effort = s.options.find((o) => isEffortOption(o.id))?.value;
    const { seat } = seatAt(p, model, typeof effort === 'string' ? effort : undefined);
    if (!seats.some((x) => sameSeat(x, seat))) seats.push(seat);
  }
  if (seats.length >= 2 && new Set(seats.map((s) => s.provider)).size >= COUNCIL_PROVIDERS_MIN)
    return { ok: true, seats, notes: [] };
  return automaticSeats(providers);
}
