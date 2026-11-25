import { describe, expect, it } from 'vitest';
import { phoneDeviceWords, phoneLanguage, teamReportTone } from './teamReports';

describe('what the phone sends with a report', () => {
  it('names the device and its system in a few words', () => {
    expect(phoneDeviceWords({ modelName: 'Pixel 9', osName: 'Android', osVersion: '16' }, 'android')).toBe(
      'Pixel 9 · Android 16',
    );
    expect(phoneDeviceWords({ modelName: 'iPhone 16 Pro', osName: 'iOS', osVersion: '26.1' }, 'ios')).toBe(
      'iPhone 16 Pro · iOS 26.1',
    );
    expect(phoneDeviceWords({ modelName: null, osName: null, osVersion: '26.1' }, 'ios')).toBe('iOS 26.1');
    expect(phoneDeviceWords({}, 'android')).toBe('Android');
    expect(phoneDeviceWords({ modelName: '  Galaxy\nZ Fold8 ' }, 'android')).toBe('Galaxy Z Fold8 · Android');
  });

  it('reads the language, and nothing when it can’t', () => {
    expect(phoneLanguage(() => 'en-GB')).toBe('en-GB');
    expect(phoneLanguage(() => '')).toBeNull();
    expect(
      phoneLanguage(() => {
        throw new Error('no Intl');
      }),
    ).toBeNull();
  });
});

describe('a status’s tone', () => {
  it('warns when the team asks, is good when a fix is there', () => {
    expect(teamReportTone('needs_information')).toBe('warn');
    expect(teamReportTone('available')).toBe('ok');
    expect(teamReportTone('investigating')).toBe('neutral');
  });
});
