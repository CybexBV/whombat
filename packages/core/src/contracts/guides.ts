/**
 * Acting on a guide card (docs/decisions/assistant-guides.md AG-03, contracts CT-80). One route for every guide:
 * the card names the action, the server's guide decides what follows. Only the DM's owner may act, and only on an
 * `open` card; in one commit the card is locked (`state: done`, `answer`), `message.updated` goes out and the next
 * step is posted as the agent. Form `values` go only here: never into a message, a log or an event.
 */
import { z } from 'zod';
import { GuideElementId } from '../domain/guides.js';
import { MessageId } from '../ids.js';
import { VAULT_SSH_PRIVATE_KEY_MAX } from '../vault/schemas.js';
import { BurrowParam, endpoint } from './endpoint.js';
import { type ErrorCode, OkResponse } from './errors.js';

/**
 * Longest form value: a pasted secret, a dropped Google client JSON file (a few hundred bytes in practice) or, since 3.14
 * (3.14), a private key from a `server` card (`VAULT_SSH_PRIVATE_KEY_MAX`: an RSA key with a passphrase is ~3.5 kB).
 */
export const GUIDE_VALUE_MAX = VAULT_SSH_PRIVATE_KEY_MAX;
/** Most values in one submit (a form has at most 6 fields). */
export const GUIDE_VALUES_MAX = 6;

export const GuideActBody = z.object({
  /** A button's `id`, or a `choices` / `form` block's `id`. */
  actionId: GuideElementId,
  /** The chosen options of a `choices` block (one for `single`). */
  optionIds: z.array(GuideElementId).min(1).max(8).optional(),
  /** A `form` block's values by field id (as typed; not trimmed). Omitted optional fields may be left out. */
  values: z
    .record(GuideElementId, z.string().max(GUIDE_VALUE_MAX))
    .refine((v) => Object.keys(v).length <= GUIDE_VALUES_MAX, `At most ${GUIDE_VALUES_MAX} values.`)
    .optional(),
});
export type GuideActBody = z.infer<typeof GuideActBody>;

/**
 * Why `guides.act` refused, in `error.details.code` over REST and over the session alike (CT-21). The set is open;
 * each code rides on the generic `ErrorCode` in `GUIDE_ERROR_STATUS`.
 */
export const GUIDE_ERROR_CODES = [
  /** The card is `done` or `expired` (another tab or the phone answered first): show the locked card. */
  'guide_closed',
  /** The caller isn't the owner of the DM the card is in. */
  'not_yours',
  /** A form value is missing or wrong; `error.fields` is keyed by field id (`values.clientId`). */
  'invalid_values',
  /** Saving the Google client needs an admin of this Whombat (the app guide's form, AG-06). */
  'google_admin_only',
  /** The Google client is set in this Whombat's config, so it can't be saved here. */
  'google_app_in_config',
  /** Google connect is off on this Whombat (`WHOMBAT_GOOGLE=off`, or the managed policy). */
  'google_unavailable',
] as const;
export const GuideErrorCode = z.enum(GUIDE_ERROR_CODES);
export type GuideErrorCode = z.infer<typeof GuideErrorCode>;

export const GUIDE_ERROR_STATUS: Record<GuideErrorCode, ErrorCode> = {
  guide_closed: 'conflict',
  not_yours: 'forbidden',
  invalid_values: 'validation_failed',
  google_admin_only: 'forbidden',
  google_app_in_config: 'conflict',
  google_unavailable: 'not_allowed',
};

const BM = z.object({ burrow: BurrowParam, messageId: MessageId });

export const guideEndpoints = {
  act: endpoint({
    id: 'guides.act',
    method: 'POST',
    path: '/burrows/:burrow/messages/:messageId/guide',
    summary:
      'Act on a guide card in the caller’s personal DM: a button, a choice or a form. Locks the card, then the ' +
      'guide posts its next step. Refusals carry `details.code` (`GuideErrorCode`); form values are never stored, ' +
      'logged or published, so it is a secret op.',
    params: BM,
    body: GuideActBody,
    response: OkResponse,
  }),
};
