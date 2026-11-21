/**
 * From packages/protocol/src/link.ts (`@whombat/protocol`): only the price and offer constants, verbatim.
 */

/**
 * The price as people see it: one place, so the installer, the pages and the account site agree. VAT included, per
 * box; a box is paid for by the month or by the year (4.6), chosen at checkout and switched in Stripe's portal.
 */
export const LINK_PRICE_TEXT = '€2.50 a month';
export const LINK_PRICE_YEAR_TEXT = '€25 a year';
export const LINK_TRIAL_TEXT = 'First month free';
/**
 * The one offer sentence (“First month free, then €2.50 a month or €25 a year”): the installer, the box's Settings, the
 * account site and control's e-mails all show this, never their own wording. Not on the iPhone (no price there).
 */
export const LINK_OFFER_TEXT = `${LINK_TRIAL_TEXT}, then ${LINK_PRICE_TEXT} or ${LINK_PRICE_YEAR_TEXT}`;
