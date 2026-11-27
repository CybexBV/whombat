import { describe, expect, it } from 'vitest';
import {
  inspectVaultSshPrivateKey,
  parseVaultUrl,
  VAULT_ASK_TEXT,
  VAULT_FAILURE_TEXT,
  VAULT_KEYS_COPY,
  VAULT_NETWORK_PROBLEM_TEXT,
  VAULT_SSH_COPY,
  VAULT_SSH_FIELD_TEXT,
  VAULT_SSH_KEY_PROBLEM_TEXT,
  VAULT_SSH_KEY_TYPE_LABELS,
  VAULT_SSH_PRODUCTION_COPY,
  VAULT_URL_PROBLEM_TEXT,
  type VaultSshServer,
  type VaultUse,
  vaultAskCard,
  vaultAskErrorText,
  vaultAskLockedLabel,
  vaultAskText,
  vaultAskTitle,
  vaultKeyServersText,
  vaultKeysCopy,
  vaultNetworkProblem,
  vaultNetworkProblemText,
  vaultRotateNotice,
  vaultSshAddressProblem,
  vaultSshCheckSummary,
  vaultSshCopy,
  vaultSshFieldText,
  vaultSshKeyProblemText,
  vaultSshKeyTypeLabels,
  vaultSshProductionCopy,
  vaultSshServerCheckLine,
  vaultSshServerNameProblem,
  vaultSshTrustCopy,
  vaultSshTrustQuestion,
  vaultTurnUseWhat,
  vaultUrlProblemText,
  vaultUseRow,
} from '../vault/index.js';

const NOW = '2026-11-27T10:00:00Z';
const TZ = 'Europe/Amsterdam';

const server = (check: Partial<VaultSshServer['check']>): Pick<VaultSshServer, 'check'> => ({
  check: {
    status: 'reached',
    summary: 'Signed in as deploy',
    outcome: 'reached',
    checkedAt: '2026-11-27T09:57:00Z',
    ...check,
  } as VaultSshServer['check'],
});

describe('vault word tables in a locale', () => {
  it('keeps every English constant equal to its function in English', () => {
    expect(VAULT_KEYS_COPY).toEqual(vaultKeysCopy('en'));
    expect(VAULT_SSH_COPY).toEqual(vaultSshCopy('en'));
    expect(VAULT_SSH_KEY_TYPE_LABELS).toEqual(vaultSshKeyTypeLabels('en'));
    expect(VAULT_SSH_PRODUCTION_COPY).toEqual(vaultSshProductionCopy('en'));
    expect(VAULT_SSH_FIELD_TEXT).toEqual(vaultSshFieldText());
    expect(VAULT_SSH_KEY_PROBLEM_TEXT).toEqual(vaultSshKeyProblemText(null));
    expect(VAULT_NETWORK_PROBLEM_TEXT).toEqual(vaultNetworkProblemText('en'));
    expect(VAULT_URL_PROBLEM_TEXT).toEqual(vaultUrlProblemText('en'));
    expect(VAULT_ASK_TEXT.save).toBe(vaultAskText('en').save);
    expect(VAULT_ASK_TEXT.ways.key_once('Dusty')).toBe(vaultAskText().ways.key_once('Dusty'));
  });

  it('keeps the English that is filled in', () => {
    expect(VAULT_SSH_FIELD_TEXT.name).toContain('1–40 letters');
    expect(VAULT_NETWORK_PROBLEM_TEXT.ports).toContain('1–16 different ports');
    expect(VAULT_ASK_TEXT.tooManyTries).toMatch(/^That didn’t work \d+ times/);
    expect(vaultSshCheckSummary('timeout')).toBe(VAULT_FAILURE_TEXT.timeout);
    expect(vaultSshCheckSummary('rejected')).toBe(VAULT_FAILURE_TEXT.rejected);
  });

  it('words the tables in Dutch', () => {
    expect(vaultKeysCopy('nl').envName).toBe('OMGEVINGSVARIABELE');
    expect(vaultSshCopy('nl').trust).toBe('Ja, vertrouwen');
    expect(vaultSshCopy('nl').addServer).toBe('Server toevoegen');
    expect(vaultSshProductionCopy('nl-NL').badge).toBe('PRODUCTIE');
    expect(vaultSshKeyTypeLabels('nl').ed25519).toBe('ED25519');
    expect(vaultSshFieldText('nl').name).toContain('1–40');
    expect(vaultSshKeyProblemText('nl').public_key).toContain('openbare sleutel');
    expect(vaultNetworkProblemText('nl').ports).toContain('1–16');
    expect(vaultUrlProblemText('nl').scheme).toContain('https://');
    expect(vaultAskText('nl').ways.key_once('Dusty')).toContain('sleutel van Dusty');
    expect(vaultAskText('nl').tooManyTries).toContain('kaart is gesloten');
  });

  it('gives problems in Dutch only when asked', () => {
    expect(vaultSshServerNameProblem('bad name', 'nl')).toContain('Gebruik 1–40');
    expect(vaultSshServerNameProblem('bad name')).toBe(VAULT_SSH_FIELD_TEXT.name);
    expect(vaultSshAddressProblem('root@web1', 'nl')).toContain('username');
    expect(vaultNetworkProblem('8.8.8.0/24', [80], 'nl')?.message).toContain('openbaar netwerk');
    expect(vaultNetworkProblem('8.8.8.0/24', [80])?.message).toBe(VAULT_NETWORK_PROBLEM_TEXT.public);
    const url = parseVaultUrl('ftp://example.com', 'nl');
    expect(url.ok ? null : url.message).toContain('https://');
    const key = inspectVaultSshPrivateKey('', 'nl');
    expect(key.ok ? null : key.message).toBe('Plak de privésleutel.');
  });
});

describe('vault lines in a locale', () => {
  it('writes a server’s check line in Dutch, rewording Whombat’s own summaries', () => {
    expect(vaultSshServerCheckLine(server({}), NOW, TZ, 'nl')).toContain('Ingelogd als deploy');
    expect(vaultSshServerCheckLine(server({}), NOW, TZ, 'nl')).toMatch(/^Gecontroleerd /);
    expect(vaultSshServerCheckLine(server({}), NOW, TZ)).toMatch(/^Checked .* · Signed in as deploy$/);
    const timedOut = server({ status: 'failing', outcome: 'timeout', summary: VAULT_FAILURE_TEXT.timeout });
    expect(vaultSshServerCheckLine(timedOut, NOW, TZ, 'nl')).toContain('seconden');
    expect(vaultSshServerCheckLine(server({ checkedAt: null }), NOW, TZ, 'nl')).toBe(
      'Nog niet gecontroleerd',
    );
  });

  it('asks the trust question in Dutch', () => {
    const s = { name: 'web-1', host: 'web1.example.com', port: 2222 };
    expect(vaultSshTrustQuestion(s, false, 'nl')).toBe('Is web-1 de server op web1.example.com:2222?');
    expect(vaultSshTrustQuestion(s, false)).toBe('Is web-1 the server at web1.example.com:2222?');
    const copy = vaultSshTrustCopy({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' }, 'nl');
    expect(copy.action).toBe('Ja, vertrouwen');
    expect(copy.text).toContain('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub op de server.');
  });

  it('names a key’s servers and the rotate notice in Dutch', () => {
    expect(vaultKeyServersText(null, [], 'nl')).toBe('Alle servers');
    expect(vaultKeyServersText(['gone'], [], 'nl')).toBe('Geen servers');
    expect(vaultKeyServersText(['gone'], [])).toBe('No servers');
    const notice = vaultRotateNotice({ agentName: 'Banjo', entryName: 'Cloudflare', kind: 'ssh' }, 'nl');
    expect(notice.text).toContain('“Cloudflare”');
    expect(notice.text).toContain('nieuwe sleutel');
    expect(notice.action).toBe('Nieuwe sleutel maken');
    expect(vaultRotateNotice({ agentName: 'Banjo', entryName: 'X', kind: 'http' }).text).toContain(
      'may have kept a copy',
    );
  });

  it('shows a stored use in Dutch but keeps what it stores English', () => {
    const what = vaultTurnUseWhat('login', 'Dusty');
    expect(what).toBe('in Dusty’s browser for this turn');
    const use = { agentId: 'a', what, at: '2026-11-27T09:00:00Z', outcome: 'done' } as VaultUse;
    const ctx = { names: () => ({ shortName: 'Dusty' }), now: NOW, timeZone: TZ };
    expect(vaultUseRow(use, { ...ctx, locale: 'nl' }).what).toBe('in de browser van Dusty voor deze beurt');
    expect(vaultUseRow(use, ctx).what).toBe(what);
    expect(vaultUseRow({ ...use, what: 'HassTurnOn' }, { ...ctx, locale: 'nl' }).what).toBe('HassTurnOn');
  });

  it('builds the ask card and its lines in Dutch', () => {
    expect(vaultAskTitle('Dusty', { kind: 'server', name: 'prod-1' }, 'nl')).toBe(
      'Dusty moet inloggen op prod-1',
    );
    expect(vaultAskTitle('Dusty', { kind: 'token', name: 'GitHub' })).toBe(
      'Dusty needs a sign-in key for GitHub',
    );
    expect(vaultAskErrorText('key_refused', 'prod-1', 'nl')).toBe('prod-1 weigerde die sleutel.');
    expect(vaultAskLockedLabel('key_added', { name: 'prod-1' }, 'nl')).toContain('sleutel toegevoegd');
    expect(vaultAskLockedLabel('declined', { name: 'x' }, 'nl')).toBe('Niet nu');
    expect(vaultAskLockedLabel('saved', { name: 'UniFi' })).toBe('Saved to your Vault · UniFi');
    const card = vaultAskCard(
      'Dusty',
      { kind: 'basic', name: 'UniFi' } as Parameters<typeof vaultAskCard>[1],
      null,
      'nl',
    );
    expect(card.title).toContain('wachtwoord');
    expect(JSON.stringify(card.blocks)).toContain('Opslaan');
    expect(JSON.stringify(card.blocks)).toContain('Niet nu');
  });
});
