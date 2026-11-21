import { describe, expect, it } from 'vitest';
import { backupLookDoneLine } from './backup-look';

describe('the line that says how a bring-back went', () => {
  it('names one thing that came back, counts more, and says what was here already', () => {
    expect(backupLookDoneLine({ back: 1, already: 0, notBack: 0, titles: ['Roof leak'] })).toBe(
      '“Roof leak” is back.',
    );
    expect(backupLookDoneLine({ back: 3, already: 1, notBack: 0 })).toBe(
      '3 things are back. 1 was already here.',
    );
    expect(backupLookDoneLine({ back: 1, already: 2, notBack: 0 })).toBe(
      '1 thing is back. 2 were already here.',
    );
    expect(backupLookDoneLine({ back: 0, already: 1, notBack: 0 })).toContain('already here');
    expect(backupLookDoneLine({ back: 0, already: 0, notBack: 2 })).toContain('2 things couldn’t come back');
    expect(backupLookDoneLine({ back: 0, already: 0, notBack: 0 })).toBeTruthy();
  });

  it('says when a connection needs a sign-in', () => {
    expect(backupLookDoneLine({ back: 2, already: 0, notBack: 0, signIn: ['Home Assistant'] })).toContain(
      'Home Assistant needs you to sign in again',
    );
  });
});
