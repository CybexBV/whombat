/** Why an entry can't be connected yet, said before anyone starts it: the address reasons and Find My's Mac. */
import { describe, expect, it } from 'vitest';
import { addressReasonNote, addressReasonOf, addressReasonText, CATALOG_REASON_TEXT } from './catalogReason';

describe('catalog reasons that say what to do first', () => {
  it('reads needs_mac (Find My without a Mac) beside the address reasons', () => {
    const status = { catalogId: 'findmy', available: false, reason: 'needs_mac' as const };
    expect(addressReasonOf(status)).toBe('needs_mac');
    expect(addressReasonNote('needs_mac')).toBe(CATALOG_REASON_TEXT.needsMacNote);
    expect(addressReasonText('needs_mac')).toBe(CATALOG_REASON_TEXT.needsMac);
  });

  it('says nothing for an entry that can be connected or has its own UI', () => {
    expect(addressReasonOf({ catalogId: 'findmy', available: true, reason: null })).toBeNull();
    expect(
      addressReasonOf({ catalogId: 'dropbox', available: false, reason: 'app_not_configured' }),
    ).toBeNull();
    expect(addressReasonOf(undefined)).toBeNull();
  });
});
