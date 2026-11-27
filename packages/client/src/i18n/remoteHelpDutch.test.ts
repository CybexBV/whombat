import { describe, expect, it } from 'vitest';
import { onePasskeyText, onePasskeyWords, passkeySetupWords } from '../managed/one-passkey';
import { ownAddressDay, ownAddressRenameErrorText, ownNameLine, ownNameText } from '../managed/own-name';
import {
  type RemoteHelpVisit,
  remoteHelpCard,
  remoteHelpErrorText,
  remoteHelpText,
  remoteHelpVisitGroups,
} from '../managed/remote-help';
import { OperationError } from '../session/managed-ops';

const now = new Date('2026-11-27T12:00:00Z');

describe('remote help in Dutch', () => {
  it('words the card and its counts', () => {
    const t = remoteHelpText('nl');
    expect(t.stepCount(1)).toBe('1 stap');
    expect(t.stepCount(3)).toContain('stappen');
    expect(t.today('14:02')).toContain('Vandaag');
    const card = remoteHelpCard({
      state: {
        available: true,
        foreverAllowed: false,
        grant: { level: 'fix', until: '2026-11-28T13:00:00Z', helpCode: null },
        connected: [{ visitId: 'v1', who: 'Support' }],
      } as never,
      hasPasskey: null,
      now,
      timeZone: 'UTC',
      locale: 'nl',
    });
    expect(card.kind).toBe('on');
    if (card.kind !== 'on') return;
    expect(card.line).toContain('Aan');
    expect(card.line).toContain('morgen');
    expect(card.connected[0]?.text).toContain('verbonden');
  });

  it('words a visit’s steps and a refusal', () => {
    const visit = {
      id: 'v1',
      who: 'Support',
      level: 'look',
      startedAt: '2026-11-27T10:00:00Z',
      endedAt: null,
      truncated: false,
      transcriptBytes: 0,
      steps: [
        { kind: 'exec', at: '2026-11-27T10:01:00Z', line: 'uptime' },
        {
          kind: 'look',
          at: '2026-11-27T10:02:00Z',
          command: 'logs',
          units: ['whombat-voice.service', 'nginx.service'],
        },
      ],
    } as unknown as RemoteHelpVisit;
    const [group] = remoteHelpVisitGroups([visit], { now, timeZone: 'UTC', locale: 'nl' });
    expect(group?.when).toContain('Vandaag');
    expect(group?.steps[0]?.text).toBe('Uitgevoerd:');
    expect(group?.steps[1]?.text).toContain('voice en nginx');
    expect(remoteHelpErrorText(new Error('x'), 'nl')).toContain('Dat lukte niet');
  });
});

describe('one passkey in Dutch', () => {
  it('words the steps and the result', () => {
    expect(passkeySetupWords('create', 'nl')).toContain('wachtwoordbeheerder');
    expect(onePasskeyText('nl').removed(['Oud'])).toContain('“Oud”');
    const said = onePasskeyWords(
      {
        pending: [{ name: 'Kantoor', reason: 'offline' }],
        backupsChecked: ['a'],
        kept: [],
        retired: [],
      } as never,
      'nl',
    );
    expect(said).toContain('Nog te controleren: Kantoor');
    expect(said).toContain('online');
  });
});

describe('own name in Dutch', () => {
  it('words the check, a refusal and the day', () => {
    expect(ownNameText('nl').randomExample).toBe(ownNameText('en').randomExample);
    expect(
      ownNameLine({ kind: 'done', name: 'thuis', verdict: 'free', host: null }, 'whombat.app', 'nl')?.text,
    ).toBe('thuis.whombat.app is vrij.');
    expect(
      ownAddressRenameErrorText(new OperationError('ownAddress.rename', 400, 'rename_limit', 'x'), 'nl'),
    ).toContain('3 keer per jaar');
    expect(ownAddressDay('2026-12-23T12:00:00Z', 'UTC', 'nl')).toBe('23 december');
    expect(ownAddressDay('2026-12-23T12:00:00Z', 'UTC')).toBe('23 December');
  });
});
