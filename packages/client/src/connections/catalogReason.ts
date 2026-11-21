/**
 * Why a catalog entry can't be connected on this Whombat, said before anyone starts it. The box lists the reason with
 * each entry (`CatalogEntryStatus.reason`, docs/decisions/whombat-link.md); these words match the box's own refusal
 * when a sign-in is started anyway. Pure.
 */
import type { CatalogEntryStatus } from '@whombat/core/domain';

export const CATALOG_REASON_TEXT = {
  needsSecureAddress:
    'This sign-in needs a secure address for your Whombat to come back to. Turn on Whombat Link, or Tailscale with HTTPS, first.',
  /** Where the app doesn't offer Whombat Link (the iPhone). */
  needsSecureAddressTailscale:
    'This sign-in needs a secure address for your Whombat to come back to. Turn on Tailscale with HTTPS first.',
  hostedOnly:
    'This sign-in comes back to Whombat on the web, which this Whombat doesn’t use. Set up your own app for it in Settings → Connections.',
  /** The way forward from that sentence: This Whombat → Reach, where Tailscale and Whombat Link are turned on. */
  needsSecureAddressAction: 'Get a secure address',
  /** The short note on the entry's tile or row. */
  needsSecureAddressNote: 'Needs a secure address',
  hostedOnlyNote: 'Needs your own app',
} as const;

/** The reasons that say what to do first; the others (`off`, `no_driver`, `app_not_configured`) have their own UI. */
export type AddressReason = 'needs_secure_address' | 'hosted_only';

export function addressReasonOf(status: CatalogEntryStatus | undefined): AddressReason | null {
  if (!status || status.available) return null;
  return status.reason === 'needs_secure_address' || status.reason === 'hosted_only' ? status.reason : null;
}

/** The sentence for an entry's page; `offerLink: false` leaves Whombat Link out (the iPhone). */
export function addressReasonText(reason: AddressReason, options: { offerLink?: boolean } = {}): string {
  if (reason === 'hosted_only') return CATALOG_REASON_TEXT.hostedOnly;
  return options.offerLink === false
    ? CATALOG_REASON_TEXT.needsSecureAddressTailscale
    : CATALOG_REASON_TEXT.needsSecureAddress;
}

/** The short note for an entry's tile or row. */
export function addressReasonNote(reason: AddressReason): string {
  return reason === 'hosted_only'
    ? CATALOG_REASON_TEXT.hostedOnlyNote
    : CATALOG_REASON_TEXT.needsSecureAddressNote;
}
