/**
 * The check Something new is open to the internet (docs/decisions/internet-exposure.md), apart from the code that
 * reads openings so the places' own kinds can list it without importing that code.
 *
 * It starts on (watch-defaults.md): a new opening is a security opening, and Whombat can say what it leads to and what
 * guards it. Only the person knows whether it's meant, so its line is theirs (`you`), not a problem to research.
 */
import { EXPOSURE_NEW_CHECK } from '@whombat/core';
import type { KindCheck } from '../things/quiet/types';

export const EXPOSURE_NEW: KindCheck = {
  check: EXPOSURE_NEW_CHECK,
  name: 'Something new is open to the internet',
  nature: 'you',
  perItem: true,
  startsOn: true,
};
