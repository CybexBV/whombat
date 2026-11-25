import type { Approval } from '@whombat/core';
import { deployApproval, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { approvalScreen } from './approval';
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

describe('the assistant’s draft report on its approval screen', () => {
  const draftCard = (over: Partial<Approval> = {}): Approval =>
    deployApproval({
      keyId: 'messages.external',
      action: {
        type: 'custom',
        params: {
          name: 'report_to_whombat_team',
          keyId: 'messages.external',
          data: { draftId: 'trd_AAAAAAAAAAAAAAAAAAAAAA' },
        },
      },
      title: 'Report a problem to the Whombat Team',
      question: 'Send this to the Whombat Team?',
      target: 'Whombat Team',
      conditions: [
        { id: 'person', kind: 'person_approves', label: 'A person says yes', met: false, approverIds: [] },
      ] as Approval['conditions'],
      ...over,
    });

  it('goes now or not at all, even where a later time is offered, and Edit opens its draft', () => {
    const model = approvalScreen(draftCard(), worldContext(), undefined, SEED_NOW.toISOString());
    expect(model.footer).toMatchObject({
      kind: 'answers',
      answers: [
        { id: 'now', label: 'Yes, do it' },
        { id: 'no', label: 'No' },
      ],
    });
    expect(model.facts?.tonight).toBeNull();
    expect(model.editDraft).toBe('trd_AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('offers no Edit once answered', () => {
    const decided = draftCard({ state: 'declined', decidedAt: SEED_NOW.toISOString() });
    expect(approvalScreen(decided, worldContext()).editDraft).toBeNull();
  });
});
