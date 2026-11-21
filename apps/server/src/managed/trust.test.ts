import { claimCardPassword, pairingFingerprint } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { ClaimFile } from './boot';
import { bestWayPage, claimSecretHash, normalizeClaimSecret, pairingCode } from './trust';

describe('claim codes', () => {
  it('hashes exactly like provisioning (vectors from the appliance’s provisioning claim.SecretHash, CT-29)', () => {
    const typed = 'abcd-efgh ijkl-mnop-qrst-uvwx-yz';
    expect(normalizeClaimSecret(typed)).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(claimSecretHash('dev-test-1', normalizeClaimSecret(typed))).toBe(
      'ZIqNAqFzWzSo3DtPfmQjO0Rgnhug91WdZnrASJWGn8w',
    );
    // Look-alike digits typed for letters, whitespace of any kind and dashes.
    expect(normalizeClaimSecret('a0b1c8d2 e3f4\tg5h6-i7j2k3l4m5n6o7p2qr')).toBe(
      'AOBICBD2E3F4G5H6I7J2K3L4M5N6O7P2QR',
    );
  });

  it('the card’s PAKE password is the hash claim.json already holds (CT-66)', () => {
    expect(claimCardPassword('dev-test-1', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(
      'ZIqNAqFzWzSo3DtPfmQjO0Rgnhug91WdZnrASJWGn8w',
    );
  });

  it('claim.json: a card secret hash, or null for a self-registered device (CC-10)', () => {
    const base = { v: 1, deviceId: 'dev-1', algorithm: 'sha256-b64url(whombat-claim-secret/1)' };
    expect(ClaimFile.parse({ ...base, secretHash: null }).secretHash).toBeNull();
    expect(
      ClaimFile.parse({ ...base, secretHash: 'ZIqNAqFzWzSo3DtPfmQjO0Rgnhug91WdZnrASJWGn8w' }),
    ).toBeTruthy();
    expect(ClaimFile.safeParse({ ...base, secretHash: 'short' }).success).toBe(false);
    expect(ClaimFile.safeParse({ v: 1, deviceId: 'dev-1', algorithm: base.algorithm }).success).toBe(false);
  });

  it('pairing codes look like 1234-5678', () => {
    expect(pairingCode()).toMatch(/^\d{4}-\d{4}$/);
  });

  it('the contracts’ pairing fingerprint matches the value this runtime shipped with (MR-32, CT-46)', () => {
    expect(pairingFingerprint('12D3KooWPVdVk97rgM6ywUvMqHpAvz66dZeuSuTtBwsVtCPCoAS2')).toBe('03BD-4EAE-1E70');
  });
});

describe('the page a box names for itself', () => {
  const lan = {
    way: 'lan' as const,
    socket: 'ws://192.168.1.20:4480/v1/direct',
    web: 'http://192.168.1.20:4480/',
  };
  const tailnet = {
    way: 'tailscale' as const,
    socket: 'wss://home.tail1234.ts.net:4480/v1/direct',
    web: 'https://home.tail1234.ts.net:4480/',
  };

  it('is an HTTPS one first, whatever the order of its ways', () => {
    expect(bestWayPage([lan, tailnet])).toBe(tailnet.web);
    expect(bestWayPage([lan])).toBe(lan.web);
  });

  it('is nothing when nobody can reach it: never an address of the reader’s own machine', () => {
    expect(bestWayPage([])).toBeNull();
  });
});
