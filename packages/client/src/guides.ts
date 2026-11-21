/**
 * Guide cards in the personal assistant's DM (docs/decisions/assistant-guides.md AG-02, AG-03; contracts CT-80,
 * CT-81): what web and mobile share around `guides.act` — the optimistic answer a tap shows at once, the refusals
 * and the words for them. No DOM and no React Native here.
 */
import type { GuideAnswer, GuideCard } from '@whombat/core/domain';
import { ApiError, InvalidRequestError } from './http/errors';
import { appErrorOf } from './signins/errors';

/** What `guides.act` sends: a button, a choice (single or the ticked multi) or a form. */
export interface GuideActInput {
  actionId: string;
  optionIds?: string[];
  /** Form values: only ever sent, never kept in the cache (CN-02, AG-03). */
  values?: Record<string, string>;
}

/** The label a locked card shows while the server's own answer is on its way (`answer.label`). */
export function optimisticGuideLabel(card: GuideCard, input: GuideActInput): string {
  for (const block of card.blocks) {
    if (block.type === 'choices' && block.id === input.actionId) {
      const titles = block.options.filter((o) => input.optionIds?.includes(o.id)).map((o) => o.title);
      if (titles.length) return titles.join(', ');
    }
    if (block.type === 'actions') {
      const action = block.actions.find((a) => a.id === input.actionId);
      if (action) return action.label;
    }
    if (block.type === 'form' && block.id === input.actionId) return 'Sending…';
  }
  return 'Sending…';
}

/** The card as it looks once acted on: locked, with the answer. */
export function answeredGuideCard(card: GuideCard, input: GuideActInput, at: string): GuideCard {
  const answer: GuideAnswer = {
    actionId: input.actionId,
    optionIds: input.optionIds?.length ? input.optionIds : null,
    label: optimisticGuideLabel(card, input),
    at,
  };
  return { ...card, state: 'done', answer };
}

/** Why `guides.act` refused (`error.details.code`), or `null` for a transport problem. */
export interface GuideRefusal {
  /** `guide_closed`, `not_yours`, `invalid_values`, `google_*`, or a generic code. */
  code: string;
  /** The server's words ('' for `guide_closed`, which shows no message). */
  message: string;
  /** `invalid_values`: the first problem per form field id. */
  fields?: Record<string, string>;
}

export const GUIDE_NETWORK_TEXT = 'Couldn’t reach Whombat. Nothing changed, try again.';

/** Reads a `guides.act` failure: the refusal code, the server's words and, for a form, the field errors by id. */
export function guideRefusalOf(error: unknown): GuideRefusal | null {
  // The body didn't pass the contract here (a value too long): nothing was sent.
  if (error instanceof InvalidRequestError)
    return {
      code: 'invalid_values',
      message: 'Check the fields and try again.',
      fields: firstByField(error.fields),
    };
  const e = appErrorOf(error);
  if (!(error instanceof ApiError)) {
    return e.code === 'unknown' ? null : { code: e.code, message: e.message ?? GUIDE_NETWORK_TEXT };
  }
  const message = e.message ?? error.message;
  if (e.code === 'guide_closed') return { code: 'guide_closed', message: '' };
  if (e.code === 'invalid_values' || error.code === 'validation_failed')
    return { code: 'invalid_values', message, fields: firstByField(error.fields) };
  return { code: e.code, message };
}

/** `error.fields` keyed by the form's field ids (`values.clientId` → `clientId`), first message each. */
function firstByField(fields: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, list]) => list.length > 0)
      .map(([path, list]) => [path.replace(/^(body\.)?values\./, ''), list[0] as string]),
  );
}

/** The toast for a failed act: nothing for `guide_closed` (the card just shows as it is), else the server's words. */
export function guideFailureText(error: unknown): string | null {
  const refusal = guideRefusalOf(error);
  if (!refusal) return GUIDE_NETWORK_TEXT;
  if (refusal.code === 'guide_closed') return null;
  return refusal.message;
}
