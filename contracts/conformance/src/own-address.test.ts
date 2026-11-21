/**
 * The own address (4.3; Whombat own-address.md): what needs files or Node to check. The pure checks are next to the code
 * (`packages/core/src/own-address/label.test.ts`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWN_ADDRESS_WORDS } from '@whombat/core/own-address';
import {
  BOX_ASSET_LINKS,
  BOX_PASSKEY_REGISTER_PURPOSE,
  boxPasskeyRegisterChallenge,
  boxPasskeyRegisterChallengeBase64url,
  OWN_ADDRESS_LABEL_RE,
  OWN_ADDRESS_ZONES,
  ownAddressClaimUrl,
  ownAddressHost,
  ownAddressLabelOf,
  ownAddressOrigin,
} from '@whombat/protocol';
import { describe, expect, it } from 'vitest';
import { ROOT } from './gen-cross-language.ts';

/** The repository (`ROOT` is its `contracts/`). */
const REPO = join(ROOT, '..');

const EFF = join(import.meta.dirname, 'eff_short_wordlist_2_0.txt');
const EFF_SHA256 = '22b45c52e0bd0bbf03aa522240b111eb4c7c0c1d86c4e518e1be2a7eb2a625e4';
const WORDS_FILE = join(REPO, 'packages/core/src/own-address/words.ts');
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('the own-address word list', () => {
  it('takes every word from the EFF short word list 2.0', () => {
    const source = readFileSync(EFF);
    expect(sha256(source)).toBe(EFF_SHA256);
    const eff = new Set(
      source
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line: string) => line.split('\t')[1]),
    );
    expect(eff.size).toBe(1_296);
    for (const w of OWN_ADDRESS_WORDS) expect(eff.has(w), w).toBe(true);
  });

  it('matches the hash, the count and the credit in its header', () => {
    const file = readFileSync(WORDS_FILE, 'utf8');
    const recorded = /SHA-256 of the words, each followed by a line feed: ([0-9a-f]{64})/.exec(file)?.[1];
    expect(sha256(OWN_ADDRESS_WORDS.map((w) => `${w}\n`).join(''))).toBe(recorded);
    expect(file).toContain(`${OWN_ADDRESS_WORDS.length} words`);
    expect(file).toContain(`Changed: ${1_296 - OWN_ADDRESS_WORDS.length} words removed.`);
    expect(file).toContain('CC BY 4.0');
  });

  it('fits the label shape the relay and the manager check', () => {
    for (const w of OWN_ADDRESS_WORDS) expect(OWN_ADDRESS_LABEL_RE.test(`${w}-${w}-${w}`), w).toBe(true);
  });
});

describe('own-address hosts', () => {
  it('are one label under a known zone', () => {
    expect(ownAddressHost('maple-otter-river', OWN_ADDRESS_ZONES.prod)).toBe(
      'maple-otter-river.box.whombat.app',
    );
    expect(ownAddressHost('maple-otter-river', OWN_ADDRESS_ZONES.dev)).toBe(
      'maple-otter-river.dev.whombat.app',
    );
    expect(() => ownAddressHost('maple-otter-river', 'example.com')).toThrow();
    expect(() => ownAddressHost('Maple-otter-river', OWN_ADDRESS_ZONES.prod)).toThrow();
    expect(ownAddressLabelOf('maple-otter-river.dev.whombat.app')).toBe('maple-otter-river');
    for (const host of [
      'MAPLE-otter-river.box.whombat.app',
      'www.maple-otter-river.box.whombat.app',
      'maple-otter-river.box.whombat.app.',
      'maple-otter-river.whombat.app',
      'box.whombat.app',
    ])
      expect(ownAddressLabelOf(host), host).toBeNull();
    expect(ownAddressOrigin('maple-otter-river.box.whombat.app')).toBe(
      'https://maple-otter-river.box.whombat.app',
    );
    expect(ownAddressClaimUrl('maple-otter-river.box.whombat.app', 'kxqmtr')).toBe(
      'https://maple-otter-river.box.whombat.app/c/kxqmtr',
    );
    expect(() => ownAddressClaimUrl('maple-otter-river.box.whombat.app', 'kxqmto')).toThrow();
  });

  it('serve the same asset links as the hosted app', () => {
    const hosted = JSON.parse(
      readFileSync(join(REPO, 'apps/web/public/.well-known/assetlinks.json'), 'utf8'),
    );
    expect(JSON.parse(JSON.stringify(BOX_ASSET_LINKS))).toEqual(hosted);
  });
});

describe('the box passkey registration challenge', () => {
  it('is SHA-256 of the canonical JSON of purpose, nonce, appliance and host', () => {
    const input = {
      nonce: 'ab'.repeat(32),
      appliance: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
      rpId: 'maple-otter-river.box.whombat.app',
    };
    // Members sorted by name (RFC 8785), no spaces.
    const canonical = `{"appliance":"${input.appliance}","nonce":"${input.nonce}","purpose":"${BOX_PASSKEY_REGISTER_PURPOSE}","rpId":"${input.rpId}"}`;
    expect(Buffer.from(boxPasskeyRegisterChallenge(input)).toString('hex')).toBe(sha256(canonical));
    expect(boxPasskeyRegisterChallengeBase64url(input)).toBe(
      createHash('sha256').update(canonical).digest('base64url'),
    );
    expect(() => boxPasskeyRegisterChallenge({ ...input, rpId: 'app.whombat.com' })).toThrow();
    expect(() => boxPasskeyRegisterChallenge({ ...input, nonce: 'AB'.repeat(32) })).toThrow();
  });
});
