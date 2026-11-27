/**
 * Why a catalog entry can't be connected on this Whombat, said before anyone starts it. The box lists the reason with
 * each entry (`CatalogEntryStatus.reason`, docs/decisions/whombat-link.md); these words match the box's own refusal
 * when a sign-in is started anyway. Pure.
 */
import type { CatalogEntryStatus } from '@whombat/core/domain';
import { clientTree } from '../i18n/catalog';
import { CONN_REASON_WORDS } from '../i18n/messages/connectionsHosts/connections';

/** The reasons' words, in a locale (English when none is given). */
export function catalogReasonText(locale?: string | null) {
  return { ...clientTree(locale, CONN_REASON_WORDS) };
}

export const CATALOG_REASON_TEXT = catalogReasonText('en');

/**
 * The reasons that say what to do first; the others (`off`, `no_driver`, `app_not_configured`) have their own UI. The
 * address ones send the person to a secure address or their own app; `needs_mac` to Add a server.
 */
export type AddressReason = 'needs_secure_address' | 'hosted_only' | 'needs_mac';

export function addressReasonOf(status: CatalogEntryStatus | undefined): AddressReason | null {
  if (!status || status.available) return null;
  return status.reason === 'needs_secure_address' ||
    status.reason === 'hosted_only' ||
    status.reason === 'needs_mac'
    ? status.reason
    : null;
}

/** The sentence for an entry's page; `offerLink: false` leaves Whombat Link out (the iPhone). */
export function addressReasonText(
  reason: AddressReason,
  options: { offerLink?: boolean; locale?: string | null } = {},
): string {
  const w = catalogReasonText(options.locale);
  if (reason === 'hosted_only') return w.hostedOnly;
  if (reason === 'needs_mac') return w.needsMac;
  return options.offerLink === false ? w.needsSecureAddressTailscale : w.needsSecureAddress;
}

/** The short note for an entry's tile or row. */
export function addressReasonNote(reason: AddressReason, locale?: string | null): string {
  const w = catalogReasonText(locale);
  if (reason === 'needs_mac') return w.needsMacNote;
  return reason === 'hosted_only' ? w.hostedOnlyNote : w.needsSecureAddressNote;
}
