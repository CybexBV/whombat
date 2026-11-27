/**
 * Audit log read side: filters and counts (same semantics on server and client), day grouping,
 * the expanded-row fields, pills, deep-link labels and CSV export.
 */
import { z } from 'zod';
import type { AuditEvent, AuditKind } from '../domain/audit.js';
import type { LinkRef } from '../domain/links.js';
import { coreTranslator } from '../i18n/catalog.js';
import { formatEventRef } from '../ids.js';
import { KEY_CATALOG, keyLabel } from '../keys/catalog.js';
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

/** `AUDIT_ACTOR_LABELS` in a locale. */
export function auditActorLabels(locale?: string | null): Record<AuditActorFilter, string> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(AuditActorFilter.options.map((a) => [a, tr.t(`audit.actor.${a}`)])) as Record<
    AuditActorFilter,
    string
  >;
}

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

/** `AUDIT_KIND_FILTER_LABELS` in a locale. */
export function auditKindFilterLabels(locale?: string | null): Record<AuditKindFilter, string> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(AUDIT_KIND_FILTERS.map((k) => [k, tr.t(`audit.kind.${k}`)])) as Record<
    AuditKindFilter,
    string
  >;
}

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
  locale?: string | null,
): AuditDay<E>[] {
  const days: AuditDay<E>[] = [];
  for (const e of events) {
    const key = dayKey(e.createdAt, timeZone);
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: formatLogDay(e.createdAt, now, timeZone, locale), events: [] };
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
  /** The reader's language for the viewer's words (English when absent); the CSV export is always English. */
  locale?: string | null;
}

const UNKNOWN: AuditPrincipalInfo = { kind: 'person', name: 'Someone', shortName: 'Someone' };

function unknownIn(locale?: string | null): AuditPrincipalInfo {
  const name = coreTranslator(locale).t('audit.someone');
  return { kind: 'person', name, shortName: name };
}

/** Tag next to the name: "AGENT" for the agent, "PERSON" for people. */
export function auditTag(p: AuditPrincipalInfo, locale?: string | null): string {
  return coreTranslator(locale).t(p.kind === 'agent' ? 'audit.tag.agent' : 'audit.tag.person');
}

/** SIGNED BY: "Banjo’s agent key · 3fa9 c1d2" / "Mara Okafor · personal key · 3fa9 c1d2". */
export function signedByText(p: AuditPrincipalInfo, fingerprint: string, locale?: string | null): string {
  return coreTranslator(locale).t(p.kind === 'agent' ? 'audit.signed.agent' : 'audit.signed.person', {
    name: p.name,
    fingerprint,
  });
}

/** Mono line under the text: "whombat/billing · PR #482 · e-9f31". */
export function auditMeta(event: Pick<AuditEvent, 'where' | 'id'>): string {
  return event.where ? `${event.where} · ${formatEventRef(event.id)}` : formatEventRef(event.id);
}

export type AuditTone = 'ok' | 'warn' | 'bad' | 'neutral';

function decidedAtText(at: string, ctx: AuditDisplayContext): string {
  const tr = coreTranslator(ctx.locale);
  const seconds = (toDate(ctx.now).getTime() - toDate(at).getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return tr.t('audit.when.justNow');
  const clock = formatClock(at, ctx.timeZone);
  if (daysAgo(at, ctx.now, ctx.timeZone) <= 1) return tr.t('audit.when.at', { clock });
  return tr.t('audit.when.on', { date: formatDate(at, ctx.timeZone, { now: ctx.now }, ctx.locale), clock });
}

/** A key's label as the event recorded it, in the reader's words when the key is one Whombat knows. */
function keyUsedLabel(key: { id: string; label: string }, locale?: string | null): string {
  if (coreTranslator(locale).language === 'en' || !(key.id in KEY_CATALOG)) return key.label;
  return keyLabel(key.id as keyof typeof KEY_CATALOG, locale);
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
  const tr = coreTranslator(ctx.locale);
  if (event.kind === 'Blocked') return { text: tr.t('audit.pill.blocked'), tone: 'bad' };
  const d = decisionOf(event);
  if (!d) return null;
  if (d.state === 'pending') return { text: tr.t('audit.pill.waiting'), tone: 'warn' };
  const who = (d.byId ? ctx.principal(d.byId) : undefined) ?? unknownIn(ctx.locale);
  const name = who.shortName.toLocaleUpperCase(tr.language === 'nl' ? 'nl-NL' : 'en-US');
  return d.state === 'approved'
    ? { text: tr.t('audit.pill.approved', { name }), tone: 'ok' }
    : { text: tr.t('audit.pill.declined', { name }), tone: 'bad' };
}

export interface AuditField {
  /** SIGNED BY, KEY USED, KEY IT NEEDED, ON BEHALF OF, VAULT, DECIDED, EVENT */
  label: string;
  value: string;
  tone: AuditTone;
}

/** Expanded row fields, in the mock's order. */
export function auditFields(event: AuditEvent, ctx: AuditDisplayContext): AuditField[] {
  const tr = coreTranslator(ctx.locale);
  const actor = ctx.principal(event.actorId) ?? unknownIn(ctx.locale);
  const fields: AuditField[] = [
    {
      label: tr.t('audit.field.signedBy'),
      value: signedByText(actor, event.fingerprint, ctx.locale),
      tone: 'neutral',
    },
  ];
  const blocked = event.kind === 'Blocked';
  if (event.keyUsed) {
    fields.push({
      label: tr.t(blocked ? 'audit.field.keyNeeded' : 'audit.field.keyUsed'),
      value: keyUsedLabel(event.keyUsed, ctx.locale) + (event.keyNote ? ` · ${event.keyNote}` : ''),
      tone: blocked ? 'bad' : 'neutral',
    });
  }
  if (event.onBehalfOf)
    fields.push({ label: tr.t('audit.field.onBehalfOf'), value: event.onBehalfOf, tone: 'neutral' });
  // The person sees which entry and what was done (vault.md VT-52).
  const vault = vaultAuditDetailText(event);
  if (vault) fields.push({ label: tr.t('audit.field.vault'), value: vault, tone: 'neutral' });
  const d = decisionOf(event);
  if (d) {
    if (d.state === 'pending') {
      const holding = event.keyUsed?.id.startsWith('deploy')
        ? 'audit.decided.nobodyDeploy'
        : 'audit.decided.nobody';
      fields.push({
        label: tr.t('audit.field.decided'),
        value: tr.t(holding, { name: actor.shortName }),
        tone: 'warn',
      });
    } else {
      const who = (d.byId ? ctx.principal(d.byId) : undefined) ?? unknownIn(ctx.locale);
      fields.push({
        label: tr.t('audit.field.decided'),
        value: tr.t(d.state === 'approved' ? 'audit.decided.approved' : 'audit.decided.declined', {
          name: who.name,
          when: d.at ? decidedAtText(d.at, ctx) : tr.t('audit.when.justNow'),
        }),
        tone: 'neutral',
      });
    }
  }
  fields.push({
    label: tr.t('audit.field.event'),
    value: `${formatEventRef(event.id)} · ${tr.t(event.verified ? 'audit.verified' : 'audit.notVerified')}`,
    tone: event.verified ? 'ok' : 'bad',
  });
  return fields;
}

/** Deep-link button label in the expanded row. */
export function auditLinkLabel(
  link: LinkRef,
  options: { approvalPending?: boolean; locale?: string | null } = {},
): string {
  const tr = coreTranslator(options.locale);
  switch (link.type) {
    case 'pr':
      return tr.t('audit.link.pr', { n: link.number });
    case 'run':
      return tr.t('audit.link.run');
    case 'approval':
      return tr.t(options.approvalPending ? 'audit.link.review' : 'audit.link.request');
    case 'dm':
      return tr.t(link.room === 'feedback' ? 'audit.link.feedback' : 'audit.link.chat');
    case 'chat':
      return tr.t('audit.link.chat');
    case 'canvas':
      return tr.t('audit.link.canvas');
    case 'agent':
      return tr.t('audit.link.agent');
    case 'message':
      return tr.t(link.threadRootId ? 'audit.link.thread' : 'audit.link.message');
    case 'log':
      return tr.t('audit.link.log');
    case 'search':
      return tr.t('audit.link.search');
    case 'external':
      return tr.t('audit.link.external');
    case 'plan':
      return tr.t(link.stepId ? 'audit.link.step' : 'audit.link.plan');
    case 'automation_run':
      return tr.t('audit.link.automation_run');
    case 'work':
      return tr.t('audit.link.work');
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
  // The export is a record: always in English, whatever language the viewer reads.
  const english: AuditDisplayContext = { ...ctx, locale: null };
  const rows = events.map((e) => {
    const actor = ctx.principal(e.actorId) ?? UNKNOWN;
    const decided = auditFields(e, english).find((f) => f.label === 'DECIDED')?.value ?? '';
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
