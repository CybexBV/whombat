/**
 * Audit log read side: filters and counts (same semantics on server and client), day grouping,
 * the expanded-row fields, pills, deep-link labels and CSV export.
 */
import { z } from 'zod';
import type { AuditEvent, AuditKind } from '../domain/audit.js';
import type { LinkRef } from '../domain/links.js';
import { formatEventRef } from '../ids.js';
import {
  type DateInput,
  dayKey,
  daysAgo,
  formatClock,
  formatDate,
  formatLogDay,
  toDate,
} from '../text/time.js';
import { vaultAuditDetailText } from '../vault/copy.js';

/* ---------------------------------------------------------------------------------------------- */
/* Filters                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Segmented control: Everyone / People / Agents (URL `actor=`). */
export const AuditActorFilter = z.enum(['everyone', 'people', 'agents']);
export type AuditActorFilter = z.infer<typeof AuditActorFilter>;

export const AUDIT_ACTOR_LABELS: Record<AuditActorFilter, string> = {
  everyone: 'Everyone',
  people: 'People',
  agents: 'Agent',
};

/** Kind chips: All / Code / Asks / Keys / Vault / Messages / Blocked (URL `kind=`). */
export const AUDIT_KIND_FILTERS = ['all', 'code', 'asks', 'keys', 'vault', 'messages', 'blocked'] as const;
export const AuditKindFilter = z.enum(AUDIT_KIND_FILTERS);
export type AuditKindFilter = z.infer<typeof AuditKindFilter>;

export const AUDIT_KIND_FILTER_LABELS: Record<AuditKindFilter, string> = {
  all: 'All',
  code: 'Code',
  asks: 'Asks',
  keys: 'Keys',
  vault: 'Vault',
  messages: 'Messages',
  blocked: 'Blocked',
};

const KIND_OF_FILTER: Record<Exclude<AuditKindFilter, 'all'>, AuditKind> = {
  code: 'Code',
  asks: 'Asks',
  keys: 'Keys',
  vault: 'Vault',
  messages: 'Messages',
  blocked: 'Blocked',
};

export interface AuditFilter {
  actor: AuditActorFilter;
  kind: AuditKindFilter;
  /** "Only Banjo": principal id; matches events by or about them. */
  whoId: string | null;
}

type FilterableEvent = Pick<AuditEvent, 'actorId' | 'aboutId' | 'kind' | 'text'>;

/** Events matching actor type and "Only X" (the base the kind counts are computed over). */
export function auditBase<E extends FilterableEvent>(
  events: readonly E[],
  filter: Pick<AuditFilter, 'actor' | 'whoId'>,
  isAgent: (principalId: string) => boolean,
): E[] {
  return events.filter(
    (e) =>
      e.text !== null &&
      (filter.actor === 'everyone' || (filter.actor === 'agents') === isAgent(e.actorId)) &&
      (!filter.whoId || e.actorId === filter.whoId || e.aboutId === filter.whoId),
  );
}

export function matchesKind(event: Pick<AuditEvent, 'kind'>, kind: AuditKindFilter): boolean {
  return kind === 'all' || event.kind === KIND_OF_FILTER[kind];
}

/** Events shown for a filter. */
export function filterAuditEvents<E extends FilterableEvent>(
  events: readonly E[],
  filter: AuditFilter,
  isAgent: (principalId: string) => boolean,
): E[] {
  return auditBase(events, filter, isAgent).filter((e) => matchesKind(e, filter.kind));
}

export type AuditCounts = Record<AuditKindFilter, number>;

/** Chip counts: over the actor/who base, ignoring the kind filter (as the mock does). */
export function countAuditKinds(
  events: readonly FilterableEvent[],
  filter: Pick<AuditFilter, 'actor' | 'whoId'>,
  isAgent: (principalId: string) => boolean,
): AuditCounts {
  const base = auditBase(events, filter, isAgent);
  const counts: AuditCounts = {
    all: base.length,
    code: 0,
    asks: 0,
    keys: 0,
    vault: 0,
    messages: 0,
    blocked: 0,
  };
  for (const e of base) {
    for (const f of AUDIT_KIND_FILTERS) if (f !== 'all' && e.kind === KIND_OF_FILTER[f]) counts[f]++;
  }
  return counts;
}

/* ---------------------------------------------------------------------------------------------- */
/* Grouping                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export interface AuditDay<E> {
  key: string;
  /** "TODAY · 23 SEP" */
  label: string;
  events: E[];
}

/** Groups events (newest first) by calendar day in the zone. */
export function groupAuditByDay<E extends Pick<AuditEvent, 'createdAt'>>(
  events: readonly E[],
  now: DateInput,
  timeZone: string,
): AuditDay<E>[] {
  const days: AuditDay<E>[] = [];
  for (const e of events) {
    const key = dayKey(e.createdAt, timeZone);
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: formatLogDay(e.createdAt, now, timeZone), events: [] };
      days.push(day);
    }
    day.events.push(e);
  }
  return days;
}

/* ---------------------------------------------------------------------------------------------- */
/* Row display                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export interface AuditPrincipalInfo {
  kind: 'person' | 'agent';
  name: string;
  shortName: string;
}

export interface AuditDisplayContext {
  principal: (id: string) => AuditPrincipalInfo | undefined;
  now: DateInput;
  timeZone: string;
}

const UNKNOWN: AuditPrincipalInfo = { kind: 'person', name: 'Someone', shortName: 'Someone' };

/** Tag next to the name: "AGENT" for the agent, "PERSON" for people. */
export function auditTag(p: AuditPrincipalInfo): string {
  return p.kind === 'agent' ? 'AGENT' : 'PERSON';
}

/** SIGNED BY: "Banjo’s agent key · 3fa9 c1d2" / "Mara Okafor · personal key · 3fa9 c1d2". */
export function signedByText(p: AuditPrincipalInfo, fingerprint: string): string {
  return p.kind === 'agent'
    ? `${p.name}’s agent key · ${fingerprint}`
    : `${p.name} · personal key · ${fingerprint}`;
}

/** Mono line under the text: "whombat/billing · PR #482 · e-9f31". */
export function auditMeta(event: Pick<AuditEvent, 'where' | 'id'>): string {
  return event.where ? `${event.where} · ${formatEventRef(event.id)}` : formatEventRef(event.id);
}

export type AuditTone = 'ok' | 'warn' | 'bad' | 'neutral';

function decidedAtText(at: string, ctx: AuditDisplayContext): string {
  const seconds = (toDate(ctx.now).getTime() - toDate(at).getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return 'just now';
  const clock = formatClock(at, ctx.timeZone);
  if (daysAgo(at, ctx.now, ctx.timeZone) <= 1) return `at ${clock}`;
  return `on ${formatDate(at, ctx.timeZone, { now: ctx.now })} at ${clock}`;
}

/**
 * The decision an event shows: the live approval for the `approval.requested` event that created it,
 * else a decision recorded in the envelope (imported history). Null for everything else.
 */
function decisionOf(
  event: AuditEvent,
): { state: 'pending' | 'approved' | 'declined'; byId: string | null; at: string | null } | null {
  if (event.approval && event.type === 'approval.requested') {
    return { state: event.approval.state, byId: event.approval.decidedById, at: event.approval.decidedAt };
  }
  if (event.decided) return { state: event.decided.decision, byId: event.decided.byId, at: event.decided.at };
  return null;
}

/** Status pill: BLOCKED / WAITING ON A PERSON / APPROVED BY MARA / DECLINED BY MARA, or null. */
export function auditPill(
  event: AuditEvent,
  ctx: AuditDisplayContext,
): { text: string; tone: AuditTone } | null {
  if (event.kind === 'Blocked') return { text: 'BLOCKED', tone: 'bad' };
  const d = decisionOf(event);
  if (!d) return null;
  if (d.state === 'pending') return { text: 'WAITING ON A PERSON', tone: 'warn' };
  const who = (d.byId ? ctx.principal(d.byId) : undefined) ?? UNKNOWN;
  return d.state === 'approved'
    ? { text: `APPROVED BY ${who.shortName.toUpperCase()}`, tone: 'ok' }
    : { text: `DECLINED BY ${who.shortName.toUpperCase()}`, tone: 'bad' };
}

export interface AuditField {
  /** SIGNED BY, KEY USED, KEY IT NEEDED, ON BEHALF OF, VAULT, DECIDED, EVENT */
  label: string;
  value: string;
  tone: AuditTone;
}

/** Expanded row fields, in the mock's order. */
export function auditFields(event: AuditEvent, ctx: AuditDisplayContext): AuditField[] {
  const actor = ctx.principal(event.actorId) ?? UNKNOWN;
  const fields: AuditField[] = [
    { label: 'SIGNED BY', value: signedByText(actor, event.fingerprint), tone: 'neutral' },
  ];
  const blocked = event.kind === 'Blocked';
  if (event.keyUsed) {
    fields.push({
      label: blocked ? 'KEY IT NEEDED' : 'KEY USED',
      value: event.keyUsed.label + (event.keyNote ? ` · ${event.keyNote}` : ''),
      tone: blocked ? 'bad' : 'neutral',
    });
  }
  if (event.onBehalfOf) fields.push({ label: 'ON BEHALF OF', value: event.onBehalfOf, tone: 'neutral' });
  // The person sees which entry and what was done (vault.md VT-52).
  const vault = vaultAuditDetailText(event);
  if (vault) fields.push({ label: 'VAULT', value: vault, tone: 'neutral' });
  const d = decisionOf(event);
  if (d) {
    if (d.state === 'pending') {
      const holding = event.keyUsed?.id.startsWith('deploy') ? 'is holding the deploy' : 'is waiting';
      fields.push({ label: 'DECIDED', value: `Nobody yet. ${actor.shortName} ${holding}.`, tone: 'warn' });
    } else {
      const who = (d.byId ? ctx.principal(d.byId) : undefined) ?? UNKNOWN;
      fields.push({
        label: 'DECIDED',
        value: `${who.name} ${d.state} ${d.at ? decidedAtText(d.at, ctx) : 'just now'}`,
        tone: 'neutral',
      });
    }
  }
  fields.push({
    label: 'EVENT',
    value: `${formatEventRef(event.id)} · ${event.verified ? 'signature verified' : 'signature does not verify'}`,
    tone: event.verified ? 'ok' : 'bad',
  });
  return fields;
}

/** Deep-link button label in the expanded row. */
export function auditLinkLabel(link: LinkRef, options: { approvalPending?: boolean } = {}): string {
  switch (link.type) {
    case 'pr':
      return `Open PR #${link.number}`;
    case 'run':
      return 'Open run';
    case 'approval':
      return options.approvalPending ? 'Review the request' : 'Open the request';
    case 'dm':
      return link.room === 'feedback' ? 'Open Feedback' : 'Open the chat';
    case 'chat':
      return 'Open the chat';
    case 'canvas':
      return 'Open canvas';
    case 'agent':
      return 'Open the agent’s settings';
    case 'message':
      return link.threadRootId ? 'Open thread' : 'Open message';
    case 'log':
      return 'Open in log';
    case 'search':
      return 'Open search';
    case 'external':
      return 'Open link';
    case 'plan':
      return link.stepId ? 'Open step' : 'Open plan';
    case 'automation_run':
      return 'Open automation run';
    case 'work':
      return 'Open Work';
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* CSV                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

export const AUDIT_CSV_COLUMNS = [
  'event',
  'time',
  'actor',
  'actor_type',
  'kind',
  'type',
  'text',
  'where',
  'key',
  'key_note',
  'on_behalf_of',
  'decided',
  'fingerprint',
  'verified',
  'seq',
  'hash',
  'signature',
  /** The owner's Vault detail (“Used “Home Assistant” · HassTurnOn · done”), empty on every other row (0.14). */
  'vault',
] as const;

/** RFC 4180 field quoting; also neutralises spreadsheet formulas (=, +, -, @ at the start). */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  return `${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** CSV export of the current filter (header row + one row per event). */
export function auditCsv(events: readonly AuditEvent[], ctx: AuditDisplayContext): string {
  const rows = events.map((e) => {
    const actor = ctx.principal(e.actorId) ?? UNKNOWN;
    const decided = auditFields(e, ctx).find((f) => f.label === 'DECIDED')?.value ?? '';
    return [
      formatEventRef(e.id),
      e.createdAt,
      actor.name,
      actor.kind,
      e.kind,
      e.type,
      e.text,
      e.where,
      e.keyUsed?.label,
      e.keyNote,
      e.onBehalfOf,
      decided,
      e.fingerprint,
      e.verified,
      e.seq,
      e.hash,
      e.sig,
      vaultAuditDetailText(e),
    ];
  });
  return toCsv([[...AUDIT_CSV_COLUMNS], ...rows]);
}

/** Download file name: `burrow-hq-audit-2026-09-23.csv`. */
export function auditCsvFileName(burrowSlug: string, now: DateInput, timeZone: string): string {
  return `${burrowSlug}-audit-${dayKey(now, timeZone)}.csv`;
}
