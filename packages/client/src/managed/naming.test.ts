/** Naming a Whombat (whombat-switcher.md AP-3086, AP-3087): what control takes, how a refusal reads. */
import { describe, expect, it } from 'vitest';
import { ControlError } from './control';
import { COPY } from './copy';
import { renameErrorText, WHOMBAT_NAME_MAX, whombatNameError } from './naming';

describe('naming a Whombat', () => {
  it('takes 1–80 characters once trimmed', () => {
    const t = COPY.appliances.nameErrors;
    expect(whombatNameError('  Office  ')).toBeNull();
    expect(whombatNameError('   ')).toBe(t.empty);
    expect(whombatNameError('x'.repeat(WHOMBAT_NAME_MAX))).toBeNull();
    expect(whombatNameError(` ${'x'.repeat(WHOMBAT_NAME_MAX)} `)).toBeNull();
    expect(whombatNameError('x'.repeat(WHOMBAT_NAME_MAX + 1))).toBe(t.long);
  });

  it('words control’s refusals', () => {
    const t = COPY.appliances.nameErrors;
    expect(renameErrorText(new ControlError('forbidden', 'no'))).toBe(t.failed);
    expect(renameErrorText(new ControlError('not_found', 'no'))).toBe(t.missing);
    expect(renameErrorText(new ControlError('unavailable', 'no'))).toBe(t.failed);
    expect(renameErrorText(new Error('offline'))).toBe(t.failed);
  });
});
