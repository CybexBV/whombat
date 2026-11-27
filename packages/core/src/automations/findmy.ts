/**
 * Arriving and leaving automations on a Find My connection (docs/implementation/macos/findmy-connection.md): what a
 * signed `findmy.place_changed` tells triggers, whether it fires one, and the trigger in plain words. Pure; the server,
 * the web and the phone share it.
 */
import type { FindMyTrigger } from '../domain/automation.js';
import { type FindMyPlaceChanged, findMyPlaceKey } from '../domain/hosts-findmy.js';
import { coreTranslator } from '../i18n/catalog.js';

/** Who a Find My trigger is about in its words when it doesn't name them (“When someone arrives at Home”). */
export const UNKNOWN_FIND_MY_PERSON = 'someone';

/** A `findmy.place_changed` event as triggers read it: whose place on which connection, before and now. */
export interface FindMyTriggerFacts {
  kind: 'findmy';
  connectionId: string;
  /** Find My's stable id for the person (`HostFindMyPerson.id`). */
  person: string;
  /** The place's words before and now; null: Find My had no place for them. */
  from: string | null;
  to: string | null;
}

/** What a signed `findmy.place_changed` (its payload) tells triggers. */
export function findMyTriggerFacts(event: FindMyPlaceChanged): FindMyTriggerFacts {
  return {
    kind: 'findmy',
    connectionId: event.connectionId,
    person: event.person,
    from: event.from,
    to: event.to,
  };
}

/**
 * Whether a change of place fires the trigger: the same connection and person, and the place (without case or spaces)
 * is where they are now and weren't (`arrives`), or where they were and now aren't, being somewhere else (`leaves`).
 * Someone Find My has no place for now neither arrives nor leaves.
 */
export function findMyTriggerMatches(trigger: FindMyTrigger, facts: FindMyTriggerFacts): boolean {
  if (facts.connectionId !== trigger.connectionId || facts.person !== trigger.person) return false;
  if (facts.to === null) return false;
  const place = findMyPlaceKey(trigger.place);
  const from = facts.from === null ? null : findMyPlaceKey(facts.from);
  const to = findMyPlaceKey(facts.to);
  if (from === to) return false;
  return trigger.change === 'arrives' ? to === place : from === place;
}

/**
 * “When Mara Visser arrives at Home”, “When Mara Visser leaves Work”: the trigger in a few words, for rows, plan cards
 * and automation pages, as a mail trigger's.
 */
export function findMyWhenText(
  trigger: Pick<FindMyTrigger, 'name' | 'change' | 'place'>,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const who = trigger.name ?? tr.t('findMyWhen.someone');
  return tr.t(trigger.change === 'arrives' ? 'findMyWhen.arrives' : 'findMyWhen.leaves', {
    who,
    place: trigger.place,
  });
}

/** Which Find My connection it listens to, under the plan card's line (“On Find My · Studio”); null when unknown. */
export function findMyTriggerDetail(connection?: string, locale?: string | null): string | null {
  return connection ? coreTranslator(locale).t('findMyWhen.detail', { connection }) : null;
}
