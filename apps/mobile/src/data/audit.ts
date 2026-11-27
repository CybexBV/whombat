/**
 * The audit log on the phone (mobile-parity.md MQ-03): the web's Audit log (`features/audit`) in the list rows'
 * language — Everyone / People / Agents, the kind chips with their counts (Vault once the log holds a Vault event),
 * “Only Banjo ×”, the events grouped by day, and each row's signed detail (SIGNED BY … EVENT “e-9f18 · signature
 * verified”) with the button to what it was about. Core holds the rules and the words (`groupAuditByDay`, `auditPill`,
 * `auditFields`, `auditLinkLabel`); this reads a route's filters and builds the rows. Pure.
 */

import {
  AUDIT_KIND_FILTERS,
  type AuditActorFilter,
  AuditActorFilter as AuditActorFilterSchema,
  type AuditCounts,
  type AuditDisplayContext,
  type AuditEvent,
  type AuditKindFilter,
  AuditKindFilter as AuditKindFilterSchema,
  type AuditTone,
  auditActorLabels,
  auditFields,
  auditKindFilterLabels,
  auditLinkLabel,
  auditMeta,
  auditPill,
  auditTag,
  formatClock,
  type LinkRef,
  type Principal,
  type SystemKind,
  shortNameOf,
} from '@whombat/core';
import { coreTranslator } from '@whombat/core/i18n';
import { vaultAuditDetailText } from '@whombat/core/vault';
import { mobileTranslator } from '../i18n/translate';

/**
 * The tag beside one of Whombat's own signers (Whombat one-agent.md OA-17; AP-4994): an automation's, GitHub's mirror,
 * Feedback's receiver — never AGENT, which is the one agent's.
 */
export const SYSTEM_AUDIT_TAGS: Record<SystemKind, string> = {
  automation: 'AUTOMATION',
  github: 'GITHUB',
  feedback: 'FEEDBACK',
};

export interface AuditFilters {
  actor: AuditActorFilter;
  kind: AuditKindFilter;
  /** “Only Banjo”: a principal's handle. */
  who: string | undefined;
  /** The event to open (`?open=evt_…`, a receipt's link). */
  open: string | undefined;
}

const HANDLE = /^[A-Za-z0-9_.-]{1,64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A route's (or a link's) filters, whatever was typed into the URL: the defaults where it isn't one of them. */
export function auditFilters(params: Record<string, unknown> | undefined): AuditFilters {
  const actor = AuditActorFilterSchema.safeParse(params?.actor);
  const kind = AuditKindFilterSchema.safeParse(params?.kind);
  const who = typeof params?.who === 'string' && HANDLE.test(params.who) ? params.who : undefined;
  const open = typeof params?.open === 'string' && EVENT_ID.test(params.open) ? params.open : undefined;
  return {
    actor: actor.success ? actor.data : 'everyone',
    kind: kind.success ? kind.data : 'all',
    who,
    open,
  };
}

export function auditActorOptions(locale?: string): readonly { value: AuditActorFilter; label: string }[] {
  const labels = auditActorLabels(locale);
  return AuditActorFilterSchema.options.map((value) => ({ value, label: labels[value] }));
}
export const AUDIT_ACTOR_OPTIONS = auditActorOptions();

/** The kind chips: Vault only once the log holds a Vault event, or while it's chosen (the web's AP-117 rule). */
export function auditKindChips(
  kind: AuditKindFilter,
  counts: Partial<AuditCounts> | undefined,
  locale?: string,
): { value: AuditKindFilter; label: string; count: number; active: boolean }[] {
  const labels = auditKindFilterLabels(locale);
  return AUDIT_KIND_FILTERS.filter((value) => value !== 'vault' || kind === 'vault' || !!counts?.vault).map(
    (value) => ({
      value,
      label: labels[value],
      count: counts?.[value] ?? 0,
      active: kind === value,
    }),
  );
}

/** How the rows name people, the agent and Whombat's own signers, in the burrow's time zone (the web's context). */
export function auditContext(
  principals: readonly Principal[],
  now: Date | string,
  timeZone: string,
  locale?: string,
): AuditDisplayContext {
  const byId = new Map(principals.map((p) => [p.id, p]));
  return {
    principal: (id) => {
      const p = byId.get(id);
      if (!p) return undefined;
      // Whombat's own signers sign with keys of their own, as the agent does (SIGNED BY); their row's tag is theirs.
      return { kind: p.kind === 'person' ? 'person' : 'agent', name: p.name, shortName: shortNameOf(p) };
    },
    now,
    timeZone,
    ...(locale && { locale }),
  };
}

/** The “Only …” chip's name for a handle: a principal's short name, else the handle itself. */
export function auditWhoName(who: string | undefined, principals: readonly Principal[]): string | null {
  if (!who) return null;
  const p = principals.find((x) => x.handle === who);
  return p ? shortNameOf(p) : who;
}

export interface AuditRowModel {
  id: string;
  /** “11:20”. */
  time: string;
  actorId: string;
  name: string;
  /** “AGENT”, “PERSON”, “AUTOMATION”. */
  tag: string;
  text: string;
  /** “whombat/billing · PR #482 · e-9f31”. */
  meta: string;
  pill: { text: string; tone: AuditTone } | null;
  accessibilityLabel: string;
}

export function auditRow(
  event: AuditEvent,
  ctx: AuditDisplayContext,
  actor: Principal | undefined,
): AuditRowModel {
  const info = ctx.principal(event.actorId);
  const unknown = coreTranslator(ctx.locale).t('audit.someone');
  const name = info?.name ?? unknown;
  const tag =
    actor?.kind === 'system'
      ? actor.system === 'automation'
        ? mobileTranslator(ctx.locale).t('audit.automation')
        : SYSTEM_AUDIT_TAGS[actor.system]
      : auditTag(info ?? { kind: 'person', name: unknown, shortName: unknown }, ctx.locale);
  const pill = auditPill(event, ctx);
  // A Vault event reads which entry and what was done (vault.md VT-52); anything else the signed text.
  const text = vaultAuditDetailText(event) ?? event.text ?? '';
  const time = formatClock(event.createdAt, ctx.timeZone);
  const meta = auditMeta(event);
  return {
    id: event.id,
    time,
    actorId: event.actorId,
    name,
    tag,
    text,
    meta,
    pill,
    accessibilityLabel: [time, name, tag, text, pill?.text].filter(Boolean).join(', '),
  };
}

export interface AuditDetailModel {
  /** SIGNED BY, KEY USED, …, EVENT “e-9f18 · signature verified”. */
  fields: { label: string; value: string; tone: AuditTone }[];
  /** What the event was about, and the button's words (“Open approval #12”). */
  link: { ref: LinkRef; label: string } | null;
}

export function auditDetail(event: AuditEvent, ctx: AuditDisplayContext): AuditDetailModel {
  const pill = auditPill(event, ctx);
  const ref = event.ref;
  return {
    fields: auditFields(event, ctx),
    link: ref
      ? {
          ref,
          label: auditLinkLabel(ref, {
            approvalPending: pill?.tone === 'warn',
            ...(ctx.locale && { locale: ctx.locale }),
          }),
        }
      : null,
  };
}

/** The route params that keep a filter change (defaults left out, as the web keeps them out of its URL). */
export function auditRouteParams(f: AuditFilters): Partial<Record<keyof AuditFilters, string>> {
  return {
    ...(f.actor !== 'everyone' ? { actor: f.actor } : {}),
    ...(f.kind !== 'all' ? { kind: f.kind } : {}),
    ...(f.who ? { who: f.who } : {}),
    ...(f.open ? { open: f.open } : {}),
  };
}

export function auditText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: t('audit.auditText.title'),
    loadFailed: t('audit.auditText.loadFailed'),
    empty: t('audit.auditText.empty'),
    loadMore: t('audit.auditText.loadMore'),
    loading: t('audit.auditText.loading'),
  } as const;
}
export const AUDIT_TEXT = auditText();
