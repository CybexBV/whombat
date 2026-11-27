import { MAIL_TEST_TEXT } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { BACKUP_FILE_TEXT, backupFileText, backupTimeLeft } from '../backup/model';
import { BLUETOOTH_TEXT, bluetoothKindText, bluetoothText } from '../host/bluetooth';
import { formatLinkSpeed, HARDWARE_TEXT, hardwareText } from '../host/hardware';
import { MAIL_TEXT, mailText } from '../host/mail';
import { HOST_CHART_WORDS, hostChartWords } from '../host/model';
import { NETWORK_TEXT, networkText, wifiPasswordProblem } from '../host/network';
import { TAILSCALE_TEXT, tailscaleText } from '../host/tailscale';
import { modelLabel } from '../managed/claim';
import { COMMUNITY_TEXT, communityText, LINK_TEXT, linkText } from '../managed/community';
import { COPY, managedCopyText } from '../managed/copy';
import { DIAGNOSTIC_SCOPE_LIST, DIAGNOSTIC_SCOPES, diagnosticScopeList } from '../managed/diagnostics';
import {
  ACCOUNT_TEXT,
  ADD_TEXT,
  accountText,
  addText,
  BOX_MENU_TEXT,
  boxMenuText,
  HOME_TEXT,
  homeText,
  SIGN_IN_NEW_TEXT,
  signInNewText,
} from '../managed/home';
import { BACKUP_PASSKEY_TEXT, backupPasskeyText } from '../managed/kit-passkey';
import { OWN_ADDRESS_TEXT, ownAddressWords } from '../managed/own-address';
import { platformName } from '../managed/pairing';
import { PASSKEY_COPY, PasskeyError, passkeyCopy, passkeyErrorText } from '../managed/passkeys';
import { SWITCHER_COPY, switcherCopy } from '../managed/switcher';
import {
  BOX_SETUP_TEXT,
  boxSetupText,
  CHANNEL_TEXT,
  channelText,
  defaultWhombatName,
  KNOWN_BOXES_TEXT,
  knownBoxesText,
  REACH_CHOICE_TEXT,
  REACH_TEXT,
  reachChoiceText,
  reachText,
} from '../managed/whombat-link';
import { HOST_MANAGED_AREAS } from './messages/hostManaged';

/** Every sample a word function is read with: strings, counts and nothing, as many as it takes. */
const SAMPLES: readonly unknown[] = ['Alpha', 0, 1, 2, 45, null];

/** What a word table says, with each function read on the samples, so two tables compare by their words. */
function said(value: unknown): unknown {
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    return SAMPLES.map((sample) => {
      try {
        return said(fn(...Array.from({ length: Math.max(1, fn.length) }, () => sample)));
      } catch {
        return '(throws)';
      }
    });
  }
  if (Array.isArray(value)) return value.map(said);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, said(v)]));
  return value;
}

const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const TABLES: [string, unknown, (locale?: string | null) => unknown][] = [
  ['BLUETOOTH_TEXT', BLUETOOTH_TEXT, bluetoothText],
  ['HARDWARE_TEXT', HARDWARE_TEXT, hardwareText],
  ['MAIL_TEXT', MAIL_TEXT, mailText],
  ['HOST_CHART_WORDS', HOST_CHART_WORDS, hostChartWords],
  ['NETWORK_TEXT', NETWORK_TEXT, networkText],
  ['TAILSCALE_TEXT', TAILSCALE_TEXT, tailscaleText],
  ['BACKUP_FILE_TEXT', BACKUP_FILE_TEXT, backupFileText],
  ['COPY', COPY, managedCopyText],
  ['COMMUNITY_TEXT', COMMUNITY_TEXT, communityText],
  ['LINK_TEXT', LINK_TEXT, linkText],
  ['HOME_TEXT', HOME_TEXT, homeText],
  ['ACCOUNT_TEXT', ACCOUNT_TEXT, accountText],
  ['SIGN_IN_NEW_TEXT', SIGN_IN_NEW_TEXT, signInNewText],
  ['ADD_TEXT', ADD_TEXT, addText],
  ['BOX_MENU_TEXT', BOX_MENU_TEXT, boxMenuText],
  ['BACKUP_PASSKEY_TEXT', BACKUP_PASSKEY_TEXT, backupPasskeyText],
  ['OWN_ADDRESS_TEXT', OWN_ADDRESS_TEXT, ownAddressWords],
  ['PASSKEY_COPY', PASSKEY_COPY, passkeyCopy],
  ['SWITCHER_COPY', SWITCHER_COPY, switcherCopy],
  ['REACH_CHOICE_TEXT', REACH_CHOICE_TEXT, reachChoiceText],
  ['REACH_TEXT', REACH_TEXT, reachText],
  ['CHANNEL_TEXT', CHANNEL_TEXT, channelText],
  ['BOX_SETUP_TEXT', BOX_SETUP_TEXT, boxSetupText],
  ['KNOWN_BOXES_TEXT', KNOWN_BOXES_TEXT, knownBoxesText],
  ['DIAGNOSTIC_SCOPE_LIST', DIAGNOSTIC_SCOPE_LIST, diagnosticScopeList],
];

describe('This Whombat and the managed journeys in Dutch', () => {
  it('keeps each English table what its function says in English', () => {
    for (const [name, table, words] of TABLES) expect(said(table), name).toEqual(said(words('en')));
  });

  it('says each table in Dutch, and in English for a language it doesn’t have', () => {
    for (const [name, table, words] of TABLES) {
      expect(said(words('nl')), name).not.toEqual(said(table));
      expect(said(words('fr')), name).toEqual(said(table));
    }
  });

  it('keeps the contracts’ English where the tables repeat them', () => {
    expect(MAIL_TEXT.tests).toEqual(MAIL_TEST_TEXT);
    for (const s of DIAGNOSTIC_SCOPE_LIST) expect(s.description).toBe(DIAGNOSTIC_SCOPES[s.scope]);
    for (const s of diagnosticScopeList('nl')) expect(s.description).not.toBe(DIAGNOSTIC_SCOPES[s.scope]);
  });

  it('reads the setup at a Whombat’s own address in Dutch', () => {
    const t = ownAddressWords('nl');
    expect(t.stepLabel(0, 3)).toBe('STAP 1 VAN 3');
    expect(t.link.linked('jij@example.com')).toBe('Gekoppeld aan jij@example.com.');
    expect(t.settings.busy(null)).not.toBe(OWN_ADDRESS_TEXT.settings.busy(null));
    expect(t.settings.retryOn('3 dec', '14:00')).toBe('op 3 dec om 14:00');
    expect(communityText('nl').stepLabel(1)).toBe('STAP 2 VAN 3');
  });

  it('turns passkey failures into Dutch', () => {
    expect(passkeyErrorText(new PasskeyError('limit'), 'nl')).toContain('Instellingen → Apparaten');
    expect(passkeyErrorText(new PasskeyError('limit'))).toBe(PASSKEY_COPY.errors.limit);
    expect(passkeyCopy('nl').opening(null)).toBe('Je Whombat openen…');
    expect(backupPasskeyText('nl').upgradeAction).toBe('Instellen afronden');
  });

  it('reads the host sections’ functions in Dutch', () => {
    expect(bluetoothKindText('keyboard', 'nl')).not.toBe(bluetoothKindText('keyboard'));
    expect(formatLinkSpeed(2500, 'nl')).toContain('2,5');
    expect(wifiPasswordProblem('short', 'nl')).not.toBe(wifiPasswordProblem('short'));
    expect(backupTimeLeft('2026-11-27T12:00:00Z', Date.parse('2026-11-27T10:00:00Z'), 'nl')).not.toBe(
      backupTimeLeft('2026-11-27T12:00:00Z', Date.parse('2026-11-27T10:00:00Z')),
    );
    expect(platformName('ios', 'nl')).not.toBe(platformName('web', 'nl'));
    expect(modelLabel('self-installed', 'nl')).not.toBe(modelLabel('self-installed'));
    expect(defaultWhombatName('Noor Bakker', 'nl')).toBe('Whombat van Noor');
  });
});

describe('the host and managed words in the catalog', () => {
  it('give each area its own prefix under hostManaged', () => {
    const prefixes = HOST_MANAGED_AREAS.map((a) => a.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(p.startsWith('hostManaged.')).toBe(true);
  });

  it('have the same keys, holes and plural shape in English and Dutch', () => {
    for (const area of HOST_MANAGED_AREAS) {
      expect(Object.keys(area.nl).sort(), area.prefix).toEqual(Object.keys(area.en).sort());
      for (const [key, en] of Object.entries(area.en)) {
        const nl = area.nl[key];
        expect(typeof nl, key).toBe(typeof en);
        const leaves = (v: unknown): string[] =>
          typeof v === 'string' ? [v] : Object.values(v as Record<string, string>);
        const enHoles = [...new Set(leaves(en).flatMap(holes))].sort();
        const nlHoles = [...new Set(leaves(nl).flatMap(holes))].sort();
        expect(nlHoles, key).toEqual(enHoles);
      }
    }
  });
});
