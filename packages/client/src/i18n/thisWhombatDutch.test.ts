import { describe, expect, it } from 'vitest';
import { passkeySetupText, passkeySetupView } from '../managed/passkey-setup';
import { backupSection, KIT_BACKUP_TEXT, kitBackupText } from '../managed/recovery';
import { hermesWords, thisWhombatText, whombatOverview, whombatPartLabel } from '../managed/this-whombat';

describe('This Whombat in Dutch', () => {
  it('names the parts and the agent’s part', () => {
    const T = thisWhombatText('nl');
    expect(T.parts.backups).toBe('Back-ups');
    expect(T.parts.devices).toBe('Apparaten');
    expect(whombatPartLabel('access', 'dusty', 'nl')).toContain('Dusty');
    expect(whombatPartLabel('access', 'dusty', 'nl')).toContain('Toegang');
    expect(T.actions.saveKit).toBe('Pakket maken');
    expect(T.actions.setUpPasskey).toBe(passkeySetupText('nl').finish);
  });

  it('counts in Dutch and keeps the values', () => {
    const T = thisWhombatText('nl');
    expect(T.devices(1)).toBe('1 apparaat');
    expect(T.devices(3)).toBe('3 apparaten');
    expect(T.lanClosedFor('dusty', 0)).toContain('dicht voor dusty');
    expect(T.lanClosedFor('dusty', 2)).toContain('2 lokale netwerken');
    expect(T.partNeeds('Back-ups', 2)).toContain('Back-ups, 2');
    expect(T.backupFile.making(40)).toContain('40 %');
    expect(T.backupFile.making(null)).toContain('maken');
    expect(T.confirmTitle('Pixel')).toContain('Pixel');
    expect(T.addComputerSteps).toHaveLength(3);
    expect(hermesWords('nl').unknown).toBe('Nog niet bekend');
  });

  it('builds the Overview in Dutch', () => {
    const view = whombatOverview({
      status: null,
      devices: 2,
      passkeys: passkeySetupView({
        hasPasskey: false,
        linked: false,
        allLinked: false,
        bringBack: null,
        locale: 'nl',
      }),
      access: { lan: 'open' },
      versions: { app: '3.1.0', runtime: '0.300.0' },
      agent: 'dusty',
      locale: 'nl',
    });
    expect(view.needsYou[0]?.title).toBe('Stel je passkey in');
    expect(view.glance.map((g) => g.title)).toContain('2 apparaten');
    expect(view.glance.find((g) => g.key === 'access')?.title).toContain('Dusty');
    expect(view.glance.find((g) => g.key === 'version')?.title).toBe('Over');
  });

  it('says the passkey details in Dutch', () => {
    const P = passkeySetupText('nl');
    expect(P.detailsMeta(0)).toContain('Welke passkeys');
    expect(P.detailsMeta(3)).toContain('3 passkeys');
  });

  it('keeps the recovery kit itself in English for a Dutch screen', () => {
    expect(KIT_BACKUP_TEXT).toEqual(kitBackupText('en'));
    expect(kitBackupText('nl').incomplete).not.toBe(KIT_BACKUP_TEXT.incomplete);
    expect(backupSection({ gap: 'incomplete' }).join('\n')).toContain(KIT_BACKUP_TEXT.incomplete);
  });
});
