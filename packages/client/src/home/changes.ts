/**
 * Done recently (mock 1; one-whombat.md ONE-08; app one-whombat-shell.md AP-1269): what Whombat changed, newest first,
 * with **Undo** while the change can be undone, **Review** where there is something to look at instead (the change's
 * `link`: the chat it was made in, else the thing's page, Whombat HR-08), and “Undone” once it was. A thing page's
 * “Changes here” also lists people's own edits and says whose they are (HR-05). Pure; web and phone share it.
 */
import type { ChangeEntry } from '@whombat/core';
import { chatHref } from '@whombat/core';
import type { UndoChangeResponse } from '@whombat/core/contracts';
import { interpolate } from '@whombat/core/i18n';
import { toDate } from '@whombat/core/text';
import { clientTree } from '../i18n/catalog';
import { HOME_AREA_WORDS } from '../i18n/messages/chatWork/home';
import { doneWhen } from './time';

const words = (locale?: string | null) => clientTree(locale, HOME_AREA_WORDS).changes;

export type DoneAction = 'undo' | 'review' | null;

export interface DoneRow {
  id: string;
  title: string;
  detail: string | null;
  when: string;
  /** Undo (the change can still be undone), Review (a place to look), or nothing. */
  action: DoneAction;
  undone: boolean;
  href: string | null;
  /**
   * Who made it when it wasn't an agent (Whombat HR-05; app home-redesign.md AP-2213): “You”, or the person's name.
   * Null for the assistant's own changes, which are most of them.
   */
  by: string | null;
  /**
   * The agent was asked to put it back (contracts 0.91 `requested`, CT-406; app home-redesign.md AP-2217): “Asked Neo
   * to undo this”, a link to the chat where it answers; Undo is not offered meanwhile. Null otherwise.
   */
  requested: { text: string; href: string | null } | null;
  change: ChangeEntry;
}

/**
 * How long a row shows that the agent was asked to undo a change: the server refuses a second Undo for 10 minutes
 * (“I’m already undoing this.”, Whombat HR-03); after that Undo is offered again. Undone ends it at once.
 */
export const UNDO_REQUEST_HOLD_MS = 10 * 60_000;

/** An Undo asked of the agent: the chat it was asked in (`conversationId`), and when (ms). */
export interface UndoRequest {
  conversationId: string | null;
  at: number;
}

/** The viewer's Undo requests by change id (kept by the app for the session; the server's change doesn't say). */
export type UndoRequests = Readonly<Record<string, UndoRequest>>;

export interface DoneRowsOptions {
  locale?: string | null | undefined;
  /** The viewer's principal id: their own changes say “You”. */
  viewerId?: string | null | undefined;
  /** Undo requests still being answered (`useUndoRequests`). */
  requests?: UndoRequests | undefined;
  /** The assistant's name, for “Asked Neo to undo this”. */
  assistantName?: string | null | undefined;
  /** The page these rows are on (a thing's Activity): a change that links to it gets no Review (AP-4573). */
  here?: string | null | undefined;
}

/** The words of an Undo request on its row: “Asked Neo to undo this”. */
export function undoRequestedText(assistantName?: string | null, locale?: string | null): string {
  const w = words(locale);
  return interpolate(w.asked, { assistant: assistantName?.trim() || w.yourAgent });
}

/** The request for a change while it still holds: not undone yet, asked less than `UNDO_REQUEST_HOLD_MS` ago. */
export function openUndoRequest(
  change: Pick<ChangeEntry, 'id' | 'undo'>,
  requests: UndoRequests | undefined,
  now: Date | number,
): UndoRequest | null {
  const request = requests?.[change.id];
  if (!request || change.undo.state === 'undone') return null;
  return toDate(now).getTime() - request.at < UNDO_REQUEST_HOLD_MS ? request : null;
}

/** What pressing Undo did, as the apps say it: done, waiting for an approval, or asked of the agent in a chat. */
export type UndoOutcome =
  | { kind: 'undone'; message: string }
  | { kind: 'asked'; message: string; approvalNumber: number | null }
  | { kind: 'requested'; message: string; href: string | null };

/**
 * Undo's answer in words (contracts 0.91 `UndoChangeResponse.state`): “Undone.”; “Undoing this needs an approval
 * first.” with the approval; or, for a change an agent reported (HR-03), “Asked Neo to undo this.” with its chat —
 * not an error, and not undone yet: the agent puts it back and says so there.
 */
export function undoOutcome(
  result: Pick<UndoChangeResponse, 'state' | 'approvalNumber' | 'conversationId'>,
  assistantName?: string | null,
  locale?: string | null,
): UndoOutcome {
  const w = words(locale);
  switch (result.state) {
    case 'undone':
      return { kind: 'undone', message: w.undone };
    case 'asked':
      return {
        kind: 'asked',
        message: w.needsApproval,
        approvalNumber: result.approvalNumber ?? null,
      };
    case 'requested':
      return {
        kind: 'requested',
        message: `${undoRequestedText(assistantName, locale)}.`,
        href: result.conversationId ? chatHref(result.conversationId) : null,
      };
  }
}

/** “You” for the viewer's own change, a person's name for someone else's, null for an agent's. */
export function changeBy(
  actor: Pick<ChangeEntry['actor'], 'kind' | 'id' | 'name'>,
  viewerId?: string | null,
  locale?: string | null,
): string | null {
  if (actor.kind !== 'person') return null;
  return viewerId && actor.id === viewerId ? words(locale).you : actor.name;
}

/** Whether Undo is still offered: available, and its window (`until`) not over. */
export function canUndo(change: Pick<ChangeEntry, 'undo'>, now: Date | number): boolean {
  if (change.undo.state !== 'available') return false;
  return !change.undo.until || toDate(change.undo.until).getTime() > toDate(now).getTime();
}

export function doneRows(
  changes: readonly ChangeEntry[],
  now: Date | number,
  timeZone: string,
  options: DoneRowsOptions = {},
): DoneRow[] {
  return changes.map((c) => {
    const request = openUndoRequest(c, options.requests, now);
    const undo = !request && canUndo(c, now);
    return {
      id: c.id,
      title: c.title,
      detail: c.detail ?? null,
      when: doneWhen(c.at, now, timeZone, options.locale),
      action: undo
        ? 'undo'
        : c.undo.state === 'undone' || request
          ? null
          : c.link && c.link !== options.here
            ? 'review'
            : null,
      undone: c.undo.state === 'undone',
      href: c.link ?? null,
      by: changeBy(c.actor, options.viewerId, options.locale),
      requested: request
        ? {
            text: undoRequestedText(options.assistantName, options.locale),
            href: request.conversationId ? chatHref(request.conversationId) : (c.link ?? null),
          }
        : null,
      change: c,
    };
  });
}

/** A change replaced by the server's answer (Undo), in a list that has it. */
export function withChange<T extends { id: string }>(list: readonly T[], change: T): T[] {
  return list.map((c) => (c.id === change.id ? change : c));
}
