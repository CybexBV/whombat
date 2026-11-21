import { describe, expect, it } from 'vitest';
import { screenDeviceLine } from './display';

describe('the device line Settings shows for a screen', () => {
  it('turns the app’s label round', () => {
    expect(screenDeviceLine({ label: 'Safari on iPad', platform: 'web' })).toBe('iPad · Safari');
    expect(screenDeviceLine({ label: 'Chrome on Linux', platform: 'web' })).toBe('Linux · Chrome');
    expect(screenDeviceLine({ label: 'Kitchen tablet', platform: 'android' })).toBe('Kitchen tablet');
  });

  it('keeps nothing that hides or reorders what it says, since the device chose it', () => {
    const line = screenDeviceLine({ label: 'Safari‮ on iPad​\n', platform: 'web' }) ?? '';
    expect(line).not.toMatch(/[‮​\n]/);
    expect(line).toContain('iPad');
    expect(screenDeviceLine({ label: '​', platform: 'web' })).toBeNull();
  });
});
