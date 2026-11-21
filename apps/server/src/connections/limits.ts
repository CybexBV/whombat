/**
 * Limits on a connection tool's arguments (docs/decisions/one-whombat-devices.md; ONE-18): the person's bounds on the
 * values a call may send — numbers between a minimum and a maximum, in steps, or one of a few choices — keyed by a JSON
 * pointer into the arguments (`/value`, `/temperature`, `/data/brightness`). They are stored with the tool
 * (`connection_tools.limits`), set by the people who manage the connection, never by a profile or an agent, and checked
 * before the keys decide (`call.ts`, `tools.ts`): a call outside them is refused before anything is signed, with a plain
 * sentence the agent can pass on (“Room temperature is limited to 16–24 °C, so 30 °C wasn’t sent.”).
 *
 * An argument a call leaves out passes (the call doesn't change it). A number limit takes a number, or a string that is
 * one (a service may read `"30"` as 30, so it is checked as 30); anything else is refused. Pure.
 */
import { type ConnectionToolLimits, TOOL_LIMITS_ARGS_MAX, type ToolArgLimit } from '@whombat/core';
import { atPointer, tidy } from '../devices/values';

export type LimitChoice = string | number | boolean;
/** Contracts 0.80 (CT-341): `ToolArgLimit` and `ConnectionToolLimits`. */
export type ArgLimit = ToolArgLimit;
export type ToolLimits = ConnectionToolLimits;

/** How a refusal names an argument: its label and unit, and the words for a choice. */
export interface ArgWords {
  label?: string;
  unit?: string;
  choiceLabel?: (value: LimitChoice) => string | undefined;
}

export const LIMIT_POINTERS_MAX = TOOL_LIMITS_ARGS_MAX;
export const LIMIT_CHOICES_MAX = 64;

/** RFC 6901: `''` or `/`-separated tokens where `~` only appears as `~0` or `~1`. */
const POINTER = /^(\/([^~/]|~[01])*)+$/;

export function isJsonPointer(text: string): boolean {
  return text.length <= 200 && POINTER.test(text);
}

/** `/data/target_temp` → “target temp”. */
export function pointerLabel(pointer: string): string {
  const last = pointer.split('/').pop() ?? pointer;
  const words = last
    .replace(/~1/g, '/')
    .replace(/~0/g, '~')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words || 'that value';
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withUnit(n: number, unit?: string): string {
  const text = String(tidy(n)).replace('-', '−');
  if (!unit) return text;
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

function choiceText(value: LimitChoice, words: ArgWords): string {
  const label = words.choiceLabel?.(value);
  if (label) return label;
  return typeof value === 'string' ? `“${value}”` : String(value);
}

function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** “Only between 16 and 24 °C”, “Only 16 °C or more”, “Only Heating or Cooling” — the line under an action. */
export function limitText(limit: ArgLimit, words: ArgWords = {}): string | null {
  const parts: string[] = [];
  if (limit.choices?.length) parts.push(`Only ${orList(limit.choices.map((c) => choiceText(c, words)))}`);
  else if (limit.min !== undefined && limit.max !== undefined)
    parts.push(`Only between ${withUnit(limit.min)} and ${withUnit(limit.max, words.unit)}`);
  else if (limit.min !== undefined) parts.push(`Only ${withUnit(limit.min, words.unit)} or more`);
  else if (limit.max !== undefined) parts.push(`Only up to ${withUnit(limit.max, words.unit)}`);
  if (limit.step !== undefined && !limit.choices?.length)
    parts.push(`${parts.length ? 'in' : 'In'} steps of ${withUnit(limit.step, words.unit)}`);
  return parts.length ? parts.join(', ') : null;
}

function rangeText(limit: ArgLimit, unit?: string): string {
  if (limit.min !== undefined && limit.max !== undefined)
    return `limited to ${withUnit(limit.min)}–${withUnit(limit.max, unit)}`;
  if (limit.min !== undefined) return `limited to ${withUnit(limit.min, unit)} or more`;
  return `limited to ${withUnit(limit.max as number, unit)} or less`;
}

function same(a: unknown, b: LimitChoice): boolean {
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '') return Number(a) === b;
  return a === b;
}

/**
 * Why `args` fall outside `limits`, in a sentence the agent can pass on, or null when they are within them.
 * `words(pointer)` names each argument (the device's action label and unit; else the pointer's last part).
 */
export function limitsProblem(
  limits: ToolLimits | null | undefined,
  args: unknown,
  words: (pointer: string) => ArgWords = () => ({}),
): string | null {
  if (!limits) return null;
  for (const [pointer, limit] of Object.entries(limits.args)) {
    const value = atPointer(args, pointer);
    if (value === undefined) continue;
    const w = words(pointer);
    const name = capital(w.label ?? pointerLabel(pointer));
    const shown = (v: unknown) =>
      typeof v === 'number' ? withUnit(v, w.unit) : typeof v === 'string' ? `“${v.slice(0, 40)}”` : String(v);
    if (limit.choices?.length) {
      if (!limit.choices.some((c) => same(value, c)))
        return `${name} may only be ${orList(limit.choices.map((c) => choiceText(c, w)))}, so ${shown(value)} wasn’t sent.`;
      continue;
    }
    if (limit.min === undefined && limit.max === undefined && limit.step === undefined) continue;
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN;
    if (!Number.isFinite(n)) return `${name} has to be a number, so ${shown(value)} wasn’t sent.`;
    if ((limit.min !== undefined && n < limit.min) || (limit.max !== undefined && n > limit.max))
      return `${name} is ${rangeText(limit, w.unit)}, so ${withUnit(n, w.unit)} wasn’t sent.`;
    if (limit.step !== undefined && limit.step > 0) {
      const steps = (n - (limit.min ?? 0)) / limit.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-6)
        return `${name} goes in steps of ${withUnit(limit.step, w.unit)}, so ${withUnit(n, w.unit)} wasn’t sent.`;
    }
  }
  return null;
}

/** What is wrong with limits a person wants to set, field by field (`args.<pointer>`), or null. */
export function limitsSetProblems(limits: ToolLimits): Record<string, string> | null {
  const problems: Record<string, string> = {};
  const entries = Object.entries(limits.args);
  if (entries.length > LIMIT_POINTERS_MAX) problems.args = `At most ${LIMIT_POINTERS_MAX} limits per tool.`;
  for (const [pointer, l] of entries) {
    const at = `args.${pointer}`;
    if (!isJsonPointer(pointer) || pointer === '') {
      problems[at] = 'Name the argument as a JSON pointer, like /value.';
      continue;
    }
    for (const n of [l.min, l.max, l.step])
      if (n !== undefined && !Number.isFinite(n)) problems[at] = 'Limits are numbers.';
    if (l.min !== undefined && l.max !== undefined && l.min > l.max)
      problems[at] = 'The lowest value is above the highest.';
    if (l.step !== undefined && !(l.step > 0)) problems[at] = 'A step is more than 0.';
    if (l.choices !== undefined) {
      if (l.choices.length === 0 || l.choices.length > LIMIT_CHOICES_MAX)
        problems[at] = `Give 1–${LIMIT_CHOICES_MAX} choices.`;
      else if (l.min !== undefined || l.max !== undefined || l.step !== undefined)
        problems[at] = 'Use choices or a range, not both.';
    }
    if (l.choices === undefined && l.min === undefined && l.max === undefined && l.step === undefined)
      problems[at] = 'This limit says nothing.';
  }
  return Object.keys(problems).length ? problems : null;
}

/** The tighter of two limits on one argument (the person's within a device's own range). */
export function narrower(a: ArgLimit | undefined, b: ArgLimit | undefined): ArgLimit | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: ArgLimit = {};
  const min = [a.min, b.min].filter((n): n is number => n !== undefined);
  const max = [a.max, b.max].filter((n): n is number => n !== undefined);
  if (min.length) out.min = Math.max(...min);
  if (max.length) out.max = Math.min(...max);
  const step = a.step ?? b.step;
  if (step !== undefined) out.step = step;
  if (a.choices && b.choices) out.choices = a.choices.filter((c) => b.choices?.some((d) => d === c));
  else if (a.choices ?? b.choices) out.choices = a.choices ?? b.choices;
  return out;
}

/** How limits read in the log: “value 16–24 · mode Heating or Cooling”. */
export function limitsSummary(limits: ToolLimits): string {
  return Object.entries(limits.args)
    .map(([pointer, l]) => `${pointerLabel(pointer)}: ${(limitText(l) ?? '').replace(/^Only /, '')}`)
    .join(' · ')
    .slice(0, 300);
}
